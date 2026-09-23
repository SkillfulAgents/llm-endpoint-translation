// Spike proxy: Anthropic Messages in, OpenAI Responses or Chat Completions upstream, Messages out.
// Config (env): BACKEND=responses|chat|passthrough, UPSTREAM_BASE_URL, UPSTREAM_API_KEY, UPSTREAM_MODEL, PROXY_PORT,
// CHAT_TOKEN_LIMIT_FIELD (e.g. max_completion_tokens), CHAT_OMIT_REASONING_EFFORT=1,
// REPLAY_SCOPE (Responses only: sign and replay encrypted reasoning under this connection scope).

import { createServer } from "node:http";
import { Readable } from "node:stream";

import {
  chatCompletionsResponseToMessages,
  chatCompletionsStreamToMessagesStream,
  messagesRequestToChatCompletions,
  messagesRequestToResponses,
  responsesErrorToMessagesError,
  responsesResponseToMessages,
  responsesStreamToMessagesStream,
} from "../dist/index.js";

const reasoningReplayScope = process.env.REPLAY_SCOPE || undefined;

const BACKENDS = {
  // Baseline: same HTTP path with no translation, to isolate codec cost.
  passthrough: {
    path: "/messages",
    request: (body) => ({ body }),
    reply: (json) => json,
    stream: (input) => input,
  },
  responses: {
    path: "/responses",
    request: (body) => messagesRequestToResponses(body, { reasoningReplayScope }),
    reply: (json, model) => responsesResponseToMessages(json, { model, reasoningReplayScope }),
    stream: (input, model) => responsesStreamToMessagesStream(input, { model, reasoningReplayScope }),
  },
  chat: {
    path: "/chat/completions",
    // Provider adapter options: OpenAI GPT-5 chat needs max_completion_tokens; non-reasoning models reject reasoning_effort.
    request: (body) => ({
      body: messagesRequestToChatCompletions(body, {
        tokenLimitField: process.env.CHAT_TOKEN_LIMIT_FIELD || undefined,
        ...(process.env.CHAT_OMIT_REASONING_EFFORT === "1" ? { mapReasoningEffort: () => undefined } : {}),
      }),
    }),
    reply: (json, model) => chatCompletionsResponseToMessages(json, { model }),
    stream: (input, model) => chatCompletionsStreamToMessagesStream(input, { model }),
  },
};

const config = {
  backend: BACKENDS[process.env.BACKEND ?? "responses"],
  baseUrl: (process.env.UPSTREAM_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, ""),
  apiKey: process.env.UPSTREAM_API_KEY ?? "",
  model: process.env.UPSTREAM_MODEL,
  port: Number(process.env.PROXY_PORT ?? 8787),
  log: process.env.PROXY_LOG !== "0",
};
if (!config.backend) throw new Error(`BACKEND must be one of ${Object.keys(BACKENDS).join(", ")}`);
if (!config.model) throw new Error("UPSTREAM_MODEL is required");

const stats = { requests: 0, streams: 0, active: 0, aborted: 0, upstreamErrors: 0 };

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function handleMessages(req, res) {
  const started = Date.now();
  const body = await readJson(req);
  const clientModel = typeof body.model === "string" ? body.model : "unknown";
  const { body: upstreamBody, replayedReasoning } = config.backend.request({ ...body, model: config.model });
  const historyThinking = (body.messages ?? []).flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b?.type === "thinking").length;

  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) {
      stats.aborted++;
      abort.abort();
    }
  });

  const upstream = await fetch(config.baseUrl + config.backend.path, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify(upstreamBody),
    signal: abort.signal,
  });

  if (!upstream.ok) {
    stats.upstreamErrors++;
    const text = await upstream.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { error: { message: text.slice(0, 500) } };
    }
    if (config.log) console.error(`[proxy] upstream ${upstream.status}: ${text.slice(0, 300)}`);
    sendJson(res, upstream.status, responsesErrorToMessagesError(json, upstream.status));
    return;
  }

  if (body.stream === true) {
    stats.streams++;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const translated = config.backend.stream(upstream.body, clientModel);
    await new Promise((resolve) => {
      // The codecs error the stream on an upstream read failure; the client must see a broken connection.
      const onError = (err) => {
        res.destroy(err);
        resolve();
      };
      Readable.fromWeb(translated).on("error", onError).pipe(res).on("finish", resolve).on("close", resolve);
    });
  } else {
    sendJson(res, 200, config.backend.reply(await upstream.json(), clientModel));
  }
  if (config.log) {
    const replay = replayedReasoning === undefined ? "" : ` history_thinking=${historyThinking} replayed=${replayedReasoning}`;
    console.error(`[proxy] ${clientModel} stream=${body.stream === true}${replay} ${Date.now() - started}ms`);
  }
}

const server = createServer(async (req, res) => {
  const path = (req.url ?? "").split("?")[0];
  if (req.method === "GET" && path === "/__stats") {
    sendJson(res, 200, { ...stats, memory: process.memoryUsage(), cpu: process.cpuUsage(), uptime: process.uptime() });
    return;
  }
  if (req.method !== "POST" || path !== "/v1/messages") {
    sendJson(res, 404, { type: "error", error: { type: "not_found_error", message: `No route ${req.method} ${path}` } });
    return;
  }
  stats.requests++;
  stats.active++;
  try {
    await handleMessages(req, res);
  } catch (err) {
    if (err?.name !== "AbortError") {
      console.error("[proxy] request failed:", err);
      if (!res.headersSent) sendJson(res, 502, { type: "error", error: { type: "api_error", message: String(err?.message ?? err) } });
      else res.destroy(err);
    }
  } finally {
    stats.active--;
  }
});

server.listen(config.port, () => {
  console.error(`[proxy] ${process.env.BACKEND ?? "responses"} -> ${config.baseUrl} model=${config.model} on :${config.port}`);
});
