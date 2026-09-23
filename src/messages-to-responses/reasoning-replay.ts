// Responses reasoning survives `store: false` only if the client replays the
// vendor's `encrypted_content`. Anthropic clients persist and replay thinking
// blocks verbatim, so the blob rides in the block's `signature`.
const PREFIX = "rsp1:";

export type ReasoningReplay = {
  /** `<upstream>/<canonical model>` — never replay a blob to a different vendor/model. */
  scope: string;
  id: string;
  encryptedContent: string;
};

export function reasoningReplayScope(upstream: string, model: string): string {
  return `${upstream}/${model}`;
}

// Ids and scopes are `[A-Za-z0-9._/-]`, so ":" is a safe separator; the
// encrypted blob is base64 and taken verbatim as the remainder.
export function encodeReasoningSignature(replay: ReasoningReplay): string {
  return `${PREFIX}${replay.scope}:${replay.id}:${replay.encryptedContent}`;
}

export function decodeReasoningSignature(signature: unknown): ReasoningReplay | null {
  if (typeof signature !== "string" || !signature.startsWith(PREFIX)) return null;
  const rest = signature.slice(PREFIX.length);
  const scopeEnd = rest.indexOf(":");
  if (scopeEnd <= 0) return null;
  const idEnd = rest.indexOf(":", scopeEnd + 1);
  if (idEnd <= scopeEnd + 1) return null;
  const encryptedContent = rest.slice(idEnd + 1);
  if (!encryptedContent) return null;
  return {
    scope: rest.slice(0, scopeEnd),
    id: rest.slice(scopeEnd + 1, idEnd),
    encryptedContent,
  };
}

/** True for signatures minted by this codec (never a valid Claude signature). */
export function isReasoningReplaySignature(signature: unknown): boolean {
  return typeof signature === "string" && signature.startsWith(PREFIX);
}
