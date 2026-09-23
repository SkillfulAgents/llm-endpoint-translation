// Messages thinking blocks ⇄ Responses reasoning items. The signature rides
// `encrypted_content` so a client replaying the item gets byte-exact thinking back.

const THINKING_PREFIX = "th:";
const REDACTED_PREFIX = "rt:";

type Block = Record<string, unknown>;

export function thinkingToReasoningItem(block: Block, id: string): Block | null {
  if (block.type === "thinking") {
    const text = typeof block.thinking === "string" ? block.thinking : "";
    const signature = typeof block.signature === "string" ? block.signature : "";
    return {
      type: "reasoning",
      id,
      summary: text ? [{ type: "summary_text", text }] : [],
      ...(signature ? { encrypted_content: `${THINKING_PREFIX}${signature}` } : {}),
    };
  }
  if (block.type === "redacted_thinking" && typeof block.data === "string") {
    return {
      type: "reasoning",
      id,
      summary: [],
      encrypted_content: `${REDACTED_PREFIX}${block.data}`,
    };
  }
  return null;
}

export function decodeReasoningItemSignature(item: Block): Block | null {
  const encrypted = item.encrypted_content;
  if (typeof encrypted !== "string") return null;
  if (encrypted.startsWith(REDACTED_PREFIX)) {
    return { type: "redacted_thinking", data: encrypted.slice(REDACTED_PREFIX.length) };
  }
  if (encrypted.startsWith(THINKING_PREFIX)) {
    const summary = Array.isArray(item.summary) ? item.summary : [];
    const thinking = summary
      .map((part) =>
        typeof part === "object" && part !== null && typeof (part as Block).text === "string"
          ? ((part as Block).text as string)
          : "",
      )
      .join("");
    return { type: "thinking", thinking, signature: encrypted.slice(THINKING_PREFIX.length) };
  }
  return null;
}
