#!/usr/bin/env node
// Packs the library, installs the tarball into a clean project, and exercises it as a consumer would.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), "llm-endpoint-translation-smoke-"));
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "inherit"] }).toString();

try {
  const [{ filename, files }] = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", work], root));
  const shipped = files.map((f) => f.path);
  const leaked = shipped.filter((p) => /(^|\/)(test|scripts|src)\/|\.test\.|fixtures/.test(p));
  if (leaked.length) throw new Error(`tarball ships non-runtime files: ${leaked.join(", ")}`);
  if (!shipped.includes("dist/index.js") || !shipped.includes("dist/index.d.ts")) {
    throw new Error(`tarball is missing dist/index.js or dist/index.d.ts: ${shipped.join(", ")}`);
  }

  writeFileSync(join(work, "package.json"), JSON.stringify({ name: "smoke", private: true, type: "module" }));
  run("npm", ["install", "--no-audit", "--no-fund", join(work, filename)], work);
  writeFileSync(
    join(work, "smoke.mjs"),
    `
import * as lib from "llm-endpoint-translation";
const required = [
  "messagesRequestToResponses", "responsesResponseToMessages", "responsesStreamToMessagesStream",
  "responsesErrorToMessagesError", "responsesRequestToMessages", "messagesResponseToResponses",
  "messagesStreamToResponsesStream", "messagesErrorToResponsesError", "TranslationError",
  "messagesRequestToChatCompletions", "chatCompletionsResponseToMessages", "chatCompletionsStreamToMessagesStream",
];
const missing = required.filter((name) => typeof lib[name] !== "function");
if (missing.length) throw new Error("missing exports: " + missing.join(", "));
const { body } = lib.messagesRequestToResponses({ model: "m", max_tokens: 64, messages: [{ role: "user", content: "hi" }] });
if (body.input[0].content[0].text !== "hi") throw new Error("request translation broken: " + JSON.stringify(body));
const back = lib.responsesRequestToMessages({ model: "m", input: "hi" });
if (back.messages[0].role !== "user") throw new Error("inbound translation broken: " + JSON.stringify(back));
console.log("smoke ok:", Object.keys(lib).length, "exports");
`,
  );
  process.stdout.write(run("node", ["smoke.mjs"], work));
} finally {
  rmSync(work, { recursive: true, force: true });
}
