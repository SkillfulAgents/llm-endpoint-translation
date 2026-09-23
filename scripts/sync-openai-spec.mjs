#!/usr/bin/env node
// Vendors the Responses and Chat Completions slice of OpenAI's official OpenAPI spec for conformance tests.
// Usage: node scripts/sync-openai-spec.mjs [ref]   (default: the pinned sha; "main" for drift checks)

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "openai/openai-openapi";
const ROOTS = [
  "Response",
  "CreateResponse",
  "ResponseStreamEvent",
  "ErrorResponse",
  "CreateChatCompletionRequest",
];
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../test/fixtures/external/openai-openapi");
const OUT = join(OUT_DIR, "schemas.json");

async function get(url) {
  const res = await fetch(url, { headers: { "user-agent": "llm-endpoint-translation-spec-sync" } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res;
}

function pinnedSha() {
  try {
    return JSON.parse(readFileSync(OUT, "utf8")).source.sha;
  } catch {
    return "main";
  }
}

async function resolveSha(ref) {
  if (/^[0-9a-f]{40}$/.test(ref)) return ref;
  const body = await (await get(`https://api.github.com/repos/${REPO}/commits/${ref}`)).json();
  return body.sha;
}

// OpenAPI's `nullable` is not JSON Schema; rewrite it so ajv accepts null where the spec does.
// The spec's `oneOf` unions overlap (e.g. EasyInputMessage vs InputMessage); SDKs treat them as anyOf.
function normalize(node) {
  if (Array.isArray(node)) return node.map(normalize);
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "nullable" || key === "example" || key === "examples") continue;
    out[key === "oneOf" ? "anyOf" : key] = normalize(value);
  }
  if (node.nullable !== true) return out;
  if (typeof out.type === "string") return { ...out, type: [out.type, "null"] };
  return { anyOf: [out, { type: "null" }] };
}

function collect(schemas) {
  const keep = new Set();
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    const ref = typeof node.$ref === "string" ? node.$ref.match(/^#\/components\/schemas\/(.+)$/) : null;
    if (ref && !keep.has(ref[1])) {
      if (!schemas[ref[1]]) throw new Error(`dangling $ref ${node.$ref}`);
      keep.add(ref[1]);
      visit(schemas[ref[1]]);
    }
    Object.values(node).forEach(visit);
  };
  ROOTS.forEach((name) => visit({ $ref: `#/components/schemas/${name}` }));
  return Object.fromEntries([...keep].sort().map((name) => [name, normalize(schemas[name])]));
}

const sha = await resolveSha(process.argv[2] ?? pinnedSha());
const spec = await (await get(`https://raw.githubusercontent.com/${REPO}/${sha}/openapi.json`)).json();
const license = await (await get(`https://raw.githubusercontent.com/${REPO}/${sha}/LICENSE`)).text();
const schemas = collect(spec.components.schemas);

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  OUT,
  JSON.stringify({ source: { repo: REPO, sha, openapi: spec.openapi, roots: ROOTS }, schemas }, null, 1) + "\n",
);
writeFileSync(join(OUT_DIR, "LICENSE"), license);
writeFileSync(
  join(OUT_DIR, "README.md"),
  `# OpenAI OpenAPI spec (Responses and Chat Completions slice)

Derived from \`openapi.json\` in [${REPO}](https://github.com/${REPO}) at commit
\`${sha}\`, Copyright (c) OpenAI, MIT License (see \`LICENSE\`).

**Modified** by \`scripts/sync-openai-spec.mjs\`; not a verbatim copy:

- Only \`components.schemas\` reachable from ${ROOTS.map((r) => `\`${r}\``).join(", ")} are kept.
- OpenAPI \`nullable: true\` is rewritten to JSON Schema (\`type: [T, "null"]\` or \`anyOf\` with \`null\`).
- \`oneOf\` is rewritten to \`anyOf\` (the spec's unions overlap).
- \`example\` / \`examples\` keywords are dropped.

Used only by the conformance tests; not shipped in the package.
`,
);
console.log(`openai-openapi@${sha}: ${Object.keys(schemas).length} schemas -> ${OUT}`);
