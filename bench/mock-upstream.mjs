// Replays bench/captures/*.sse one SSE event every EVENT_DELAY_MS, like a live model streaming tokens.
// Routes: POST /responses, /chat/completions, /messages. Env: MOCK_PORT, EVENT_DELAY_MS.

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const CAPTURES = join(import.meta.dirname, "captures");
const DELAY_MS = Number(process.env.EVENT_DELAY_MS ?? 15);

function events(name) {
  return readFileSync(join(CAPTURES, `${name}.sse`), "utf8")
    .split(/\n\n/)
    .filter((e) => e.trim())
    .map((e) => Buffer.from(e + "\n\n"));
}

const ROUTES = {
  "/responses": events("responses"),
  "/chat/completions": events("chat"),
  "/messages": events("anthropic"),
};

createServer(async (req, res) => {
  for await (const _ of req);
  const replay = ROUTES[(req.url ?? "").split("?")[0].replace(/^\/v1/, "")];
  if (!replay) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  let closed = false;
  res.on("close", () => (closed = true));
  for (const event of replay) {
    if (closed) return;
    res.write(event);
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
  }
  res.end();
}).listen(Number(process.env.MOCK_PORT ?? 8790), () => {
  console.error(`[mock] replaying ${Object.keys(ROUTES).join(", ")} at ${DELAY_MS}ms/event`);
});
