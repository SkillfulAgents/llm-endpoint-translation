// OpenAI caps function names at 64 chars; longer Anthropic names get a stable hashed short form.
const MAX_TOOL_NAME_LENGTH = 64;
const HASH_SUFFIX_LENGTH = 9;

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Deterministic, so history `tool_use` names and `tools[]` shorten identically. */
export function shortenToolName(name: string): string {
  if (name.length <= MAX_TOOL_NAME_LENGTH) return name;
  return `${name.slice(0, MAX_TOOL_NAME_LENGTH - HASH_SUFFIX_LENGTH)}_${fnv1a(name)}`;
}

/** Shortened → original names for an Anthropic request's `tools`; pass it as the reply's `toolNames`. */
export function toolNameRestoreMap(body: Record<string, unknown>): Record<string, string> {
  const map: Record<string, string> = {};
  if (!Array.isArray(body.tools)) return map;
  for (const tool of body.tools as Array<Record<string, unknown>>) {
    const name = tool && typeof tool.name === "string" ? tool.name : "";
    const short = shortenToolName(name);
    if (short !== name) map[short] = name;
  }
  return map;
}

export function restoreToolName(name: string, toolNames?: Record<string, string>): string {
  return toolNames && Object.hasOwn(toolNames, name) ? toolNames[name] : name;
}
