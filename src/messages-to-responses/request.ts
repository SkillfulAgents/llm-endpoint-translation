// Anthropic Messages request → OpenAI Responses request (`/v1/responses`).
// Responses accepts reasoning together with function tools, unlike Chat Completions.

import {
  anthropicImageToUrl,
  extractMidTurnSteers,
  messageContentToText,
  splitSteerSystemText,
  systemToText,
} from "../shared/content.js";
import { defaultEffortMapper, type EffortMapper } from "../shared/effort.js";
import {
  readAnthropicJsonSchemaFormat,
  toResponsesTextFormat,
} from "../shared/structured-output.js";
import { decodeReasoningSignature } from "./reasoning-replay.js";

export type ServiceTier = "flex" | "priority";

/** Return value from `mapImageSource` — omit the image and surface `reason` as text. */
export type ImageOmit = { reason: string; mediaType?: string };

export type ResponsesRequestOptions = {
  /** Per-model effort vocabulary; defaults to `defaultEffortMapper`. */
  mapReasoningEffort?: EffortMapper;
  /** Processing tier for the outbound request; omitted = vendor default. */
  serviceTier?: ServiceTier;
  /**
   * When set, filter Anthropic image sources before building `input_image`.
   * Return an omit reason to drop the image (and insert that text); `null` = pass.
   */
  mapImageSource?: (source: unknown) => ImageOmit | null;
  /**
   * When set, request `reasoning.encrypted_content` and sign thinking blocks
   * under this scope. Prior thinking is replayed unless `replayPriorReasoning`
   * is false.
   */
  reasoningReplayScope?: string;
  /** Default true when a scope is set. False = collect a fresh blob, skip history. */
  replayPriorReasoning?: boolean;
};

export type ResponsesRequestResult = {
  body: Record<string, unknown>;
  /** Prior reasoning items replayed into `input` (0 when replay is off). */
  replayedReasoning: number;
};

export function messagesRequestToResponses(
  body: Record<string, unknown>,
  options?: ResponsesRequestOptions,
): ResponsesRequestResult {
  const out: Record<string, unknown> = { store: false };

  if (typeof body.model === "string") out.model = body.model;
  if (typeof body.stream === "boolean") out.stream = body.stream;
  if (typeof body.max_tokens === "number") {
    out.max_output_tokens = body.max_tokens;
  }
  // Intentionally drop temperature/top_p: GPT-5/o-series reasoning models
  // reject sampling params on /v1/responses (400). Anthropic clients that set
  // them would otherwise break.

  const instructions = systemToText(body.system);
  if (instructions) out.instructions = instructions;

  const converted = convertMessagesToInput(body, options);
  out.input = converted.input;

  const tools = convertTools(body.tools);
  if (tools.length > 0) out.tools = tools;

  const functionNames = new Set(
    tools
      .filter((t) => t.type === "function" && typeof t.name === "string")
      .map((t) => t.name as string),
  );
  const toolChoice = convertToolChoice(body.tool_choice, functionNames);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;

  // Responses accepts reasoning + tools together (the whole reason this codec
  // exists). `summary: "auto"` lets the model surface reasoning summaries.
  // Callers override the mapper per model (xAI has no `none`).
  const mapEffort = options?.mapReasoningEffort ?? defaultEffortMapper;
  const reasoningEffort = mapEffort(body);
  if (reasoningEffort) {
    out.reasoning = { effort: reasoningEffort, summary: "auto" };
  }
  // Vendor default reasoning is still on when effort is omitted (Grok
  // defaults high). `store: false` discards that reasoning unless we ask
  // for the encrypted blob on every scoped request, not only explicit effort.
  if (options?.reasoningReplayScope) {
    out.include = ["reasoning.encrypted_content"];
  }

  if (options?.serviceTier) out.service_tier = options.serviceTier;

  const jsonSchema = readAnthropicJsonSchemaFormat(body);
  if (jsonSchema) out.text = toResponsesTextFormat(jsonSchema);

  return { body: out, replayedReasoning: converted.replayedReasoning };
}

/**
 * Anthropic messages → Responses `input[]`. Tool calls and tool results are
 * top-level items (`function_call` / `function_call_output`), not nested in a
 * message, matching the Responses contract.
 */
function convertMessagesToInput(
  body: Record<string, unknown>,
  options?: ResponsesRequestOptions,
): { input: Array<Record<string, unknown>>; replayedReasoning: number } {
  const input: Array<Record<string, unknown>> = [];
  const messages = Array.isArray(body.messages) ? body.messages : [];
  let replayedReasoning = 0;

  for (const raw of messages as Array<Record<string, unknown>>) {
    if (!raw || typeof raw !== "object") continue;
    const role = raw.role;
    // Claude Code sends non-Anthropic models contextual notes (agent/skill
    // listings, mid-turn steers) as system-role messages inside messages[].
    // Dropping them loses real user input — translate instead.
    if (role === "system") {
      pushSystemMessage(input, raw.content);
      continue;
    }
    if (role !== "user" && role !== "assistant") continue;
    const content = raw.content;

    if (typeof content === "string") {
      input.push({
        role,
        content: [{ type: textPartType(role), text: content }],
      });
      continue;
    }
    if (!Array.isArray(content)) continue;

    if (role === "user") {
      pushUserBlocks(input, content as Array<Record<string, unknown>>, options);
    } else {
      replayedReasoning += pushAssistantBlocks(
        input,
        content as Array<Record<string, unknown>>,
        options?.replayPriorReasoning === false
          ? undefined
          : options?.reasoningReplayScope,
      );
    }
  }

  return { input, replayedReasoning };
}

function textPartType(role: "user" | "assistant"): string {
  return role === "user" ? "input_text" : "output_text";
}

function pushSystemMessage(
  input: Array<Record<string, unknown>>,
  content: unknown,
): void {
  const text = messageContentToText(content);
  if (!text) return;

  // A mid-turn steer is really user input; models skip it as a system note.
  // Split off appended reminder blocks (wrapped or bare token budget) so the
  // steer surfaces as a clean user item, most recent in the input.
  const split = splitSteerSystemText(text);
  if (!split) {
    input.push({ role: "system", content: [{ type: "input_text", text }] });
    return;
  }
  if (split.reminders) {
    input.push({
      role: "system",
      content: [{ type: "input_text", text: split.reminders }],
    });
  }
  if (split.steer) {
    input.push({
      role: "user",
      content: [{ type: "input_text", text: split.steer }],
    });
  }
}

function pushUserBlocks(
  input: Array<Record<string, unknown>>,
  blocks: Array<Record<string, unknown>>,
  options?: ResponsesRequestOptions,
): void {
  // Direct user content (text + images) is collected into one user message,
  // preserving block order so interleaved text/images read correctly.
  const userParts: Array<Record<string, unknown>> = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      userParts.push({ type: "input_text", text: block.text });
      continue;
    }
    if (block.type === "image") {
      pushResolvedImage(userParts, block.source, options?.mapImageSource);
      continue;
    }
    if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      const { text, imageUrls, omittedNotes } = splitToolResultContent(
        block.content,
        options?.mapImageSource,
      );
      const { cleaned, steers } = extractMidTurnSteers(text);
      input.push({
        type: "function_call_output",
        call_id: block.tool_use_id,
        output: cleaned,
      });
      // Claude Code delivers mid-turn user messages as a <system-reminder>
      // appended to the tool result. Claude is trained on that convention;
      // Responses-API models treat function output as data and skip it, so
      // re-surface each steer as a real user input item (same pattern as the
      // image follow-up below).
      for (const steer of steers) {
        input.push({
          role: "user",
          content: [{ type: "input_text", text: steer }],
        });
      }
      // Responses `function_call_output.output` is a string and can't carry
      // images, so surface any tool-result images as a follow-up user message
      // the model can actually see (else GPT only gets the text and "reads"
      // nothing). Mirrors litellm's chat-adapter handling (PR #25476).
      if (imageUrls.length > 0 || omittedNotes.length > 0) {
        input.push({
          role: "user",
          content: [
            { type: "input_text", text: `[image output from tool ${block.tool_use_id}]` },
            ...omittedNotes.map((reason) => ({
              type: "input_text",
              text: reason,
            })),
            ...imageUrls.map((url) => ({
              type: "input_image",
              image_url: url,
              detail: "high",
            })),
          ],
        });
      }
    }
  }
  if (userParts.length > 0) {
    input.push({ role: "user", content: userParts });
  }
}

function pushResolvedImage(
  parts: Array<Record<string, unknown>>,
  source: unknown,
  mapImageSource?: (source: unknown) => ImageOmit | null,
): void {
  const omitted = mapImageSource?.(source) ?? null;
  if (omitted) {
    parts.push({ type: "input_text", text: omitted.reason });
    return;
  }
  const url = anthropicImageToUrl(source);
  if (url) parts.push({ type: "input_image", image_url: url, detail: "high" });
}

/**
 * Items are emitted in block order because the Responses API pairs a replayed
 * `reasoning` item with the item that immediately follows it. A reasoning
 * block with nothing after it is dropped: the vendor 400s on an orphan
 * ("provided without its required following item"). Returns the count of
 * reasoning items replayed.
 */
function pushAssistantBlocks(
  input: Array<Record<string, unknown>>,
  blocks: Array<Record<string, unknown>>,
  reasoningReplayScope?: string,
): number {
  let replayed = 0;
  let textParts: string[] = [];
  const flushText = (): void => {
    if (textParts.length === 0) return;
    input.push({
      role: "assistant",
      content: [{ type: "output_text", text: textParts.join("\n\n") }],
    });
    textParts = [];
  };
  const seenReasoningIds = new Set<string>();

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
      continue;
    }
    if (block.type === "tool_use" && typeof block.id === "string") {
      flushText();
      const name = typeof block.name === "string" ? block.name : "";
      input.push({
        type: "function_call",
        call_id: block.id,
        name,
        arguments: JSON.stringify(block.input ?? {}),
      });
      continue;
    }
    if (block.type === "thinking" && reasoningReplayScope) {
      const replay = decodeReasoningSignature(block.signature);
      if (!replay || replay.scope !== reasoningReplayScope) continue;
      if (seenReasoningIds.has(replay.id)) continue;
      if (!hasFollowingItem(blocks, i)) continue;
      flushText();
      seenReasoningIds.add(replay.id);
      const summary = typeof block.thinking === "string" ? block.thinking : "";
      input.push({
        type: "reasoning",
        id: replay.id,
        encrypted_content: replay.encryptedContent,
        summary: summary ? [{ type: "summary_text", text: summary }] : [],
      });
      replayed++;
    }
  }
  flushText();
  return replayed;
}

function hasFollowingItem(
  blocks: Array<Record<string, unknown>>,
  from: number,
): boolean {
  for (let j = from + 1; j < blocks.length; j++) {
    const next = blocks[j];
    if (!next || typeof next !== "object") continue;
    if (next.type === "text" && typeof next.text === "string") return true;
    if (next.type === "tool_use" && typeof next.id === "string") return true;
  }
  return false;
}

/**
 * Split an Anthropic tool_result `content` into the text that goes in the
 * function_call_output and any image data URLs (surfaced separately as a
 * follow-up user message — see pushUserBlocks). Images must NOT be
 * JSON-stringified into the text output: GPT would receive the base64 as a
 * literal string and "read" nothing.
 */
function splitToolResultContent(
  content: unknown,
  mapImageSource?: (source: unknown) => ImageOmit | null,
): {
  text: string;
  imageUrls: string[];
  omittedNotes: string[];
} {
  if (typeof content === "string") {
    return { text: content, imageUrls: [], omittedNotes: [] };
  }
  if (!Array.isArray(content)) {
    return {
      text: content == null ? "" : JSON.stringify(content),
      imageUrls: [],
      omittedNotes: [],
    };
  }
  const textParts: string[] = [];
  const imageUrls: string[] = [];
  const omittedNotes: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    } else if (block.type === "image") {
      const omitted = mapImageSource?.(block.source) ?? null;
      if (omitted) {
        omittedNotes.push(omitted.reason);
        continue;
      }
      const url = anthropicImageToUrl(block.source);
      if (url) imageUrls.push(url);
    } else {
      textParts.push(JSON.stringify(block));
    }
  }
  return { text: textParts.join("\n\n"), imageUrls, omittedNotes };
}

/**
 * Anthropic tools → Responses tools. Function tools are flat
 * (`{ type:"function", name, description, parameters, strict }`). The Anthropic
 * server `web_search` tool maps to the built-in `{ type:"web_search" }`.
 * `web_fetch` and `code_execution` have no Responses equivalent — skip them (callers can reject web_fetch via `hasWebFetchTool`).
 */
function convertTools(tools: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(tools)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const tool of tools as Array<Record<string, unknown>>) {
    if (!tool || typeof tool !== "object") continue;
    const type = typeof tool.type === "string" ? tool.type : "";
    const name = typeof tool.name === "string" ? tool.name : "";
    if (type.startsWith("web_search") || name === "web_search") {
      out.push({ type: "web_search" });
      continue;
    }
    // No Responses equivalent for these server tools; do not mis-map them to client functions.
    if (type.startsWith("web_fetch") || name === "web_fetch" || type.startsWith("code_execution")) {
      continue;
    }
    if (!name) continue;
    const fn: Record<string, unknown> = { type: "function", name };
    if (typeof tool.description === "string") fn.description = tool.description;
    fn.parameters =
      tool.input_schema && typeof tool.input_schema === "object"
        ? tool.input_schema
        : { type: "object", properties: {} };
    // Explicit `strict: false`, not omitted: on the Responses API an omitted
    // `strict` makes the model fill unused optional params with ""/[] instead of
    // omitting them (breaks XOR params like browser_run command/args). `false`
    // restores Chat-Completions-style omission. See vercel/ai#11869, #12200.
    fn.strict = false;
    out.push(fn);
  }
  return out;
}

/** True when the body asks for the native web_fetch server tool. */
export function hasWebFetchTool(body: Record<string, unknown>): boolean {
  if (!Array.isArray(body.tools)) return false;
  return (body.tools as Array<Record<string, unknown>>).some((tool) => {
    if (!tool || typeof tool !== "object") return false;
    const type = typeof tool.type === "string" ? tool.type : "";
    const name = typeof tool.name === "string" ? tool.name : "";
    return type.startsWith("web_fetch") || name === "web_fetch";
  });
}

/**
 * Anthropic tool_choice → Responses tool_choice.
 * Anthropic: `{ type: "auto" | "any" | "tool", name? }`
 * Responses: bare string `"auto" | "required"` for the simple modes;
 * `{ type: "function", name }` only to force a specific function. The
 * Responses API rejects `{ type: "auto" }` — `type` there names a hosted
 * tool (web_search_preview, …), not a choice mode.
 *
 * Forcing a specific tool only works for FUNCTION tools. If the forced name is
 * a built-in (e.g. the web_search tool we mapped to `{type:"web_search"}`) or
 * isn't present, we omit tool_choice (OpenAI 400s on a function name not in
 * `tools`) and let the model choose.
 */
function convertToolChoice(
  choice: unknown,
  functionNames: Set<string>,
): unknown {
  if (!choice || typeof choice !== "object") return undefined;
  const c = choice as { type?: unknown; name?: unknown };
  if (c.type === "auto") return "auto";
  if (c.type === "any") {
    return functionNames.size > 0 ? "required" : undefined;
  }
  if (c.type === "tool" && typeof c.name === "string" && functionNames.has(c.name)) {
    return { type: "function", name: c.name };
  }
  return undefined;
}
