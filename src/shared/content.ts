const ANTHROPIC_TELEMETRY_PREFIX_RE = /^(?:x-anthropic-[a-z-]+:[^\n]*\n+)+/i;

export function stripAnthropicTelemetryPrefix(text: string): string {
  return text.replace(ANTHROPIC_TELEMETRY_PREFIX_RE, "");
}

export function systemToText(system: unknown): string {
  if (!system) return "";
  if (typeof system === "string") return stripAnthropicTelemetryPrefix(system);
  if (!Array.isArray(system)) return "";
  const parts: string[] = [];
  for (const block of system as Array<Record<string, unknown>>) {
    if (block && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return stripAnthropicTelemetryPrefix(parts.join("\n\n"));
}

/** Message `content` (string or text blocks) → joined trimmed text. */
export function messageContentToText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return (content as Array<Record<string, unknown>>)
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("\n\n")
    .trim();
}

// Matches the Claude Code CLI's mid-turn steer wrapper verbatim.
const MID_TURN_STEER_RE =
  /\n*<system-reminder>\s*(The user sent a new message while you were working:[\s\S]*?)<\/system-reminder>\n*/g;

const STEER_PREFIX = "The user sent a new message while you were working:";

// The CLI's explainer about tool-result placement is stale (and confusing)
// once the steer is re-surfaced as a real user item, so drop it.
const STEER_PLACEMENT_EXPLAINER_RE =
  /This is how Claude Code surfaces messages[\s\S]*?rather than as a separate conversation turn\.\s*/;

/**
 * Claude Code delivers mid-turn user messages as a <system-reminder> appended
 * to tool_result text. Claude is trained on that convention; other models
 * treat tool output as data and skip it — extract each steer so codecs can
 * re-surface it as real user input.
 */
export function extractMidTurnSteers(text: string): {
  cleaned: string;
  steers: string[];
} {
  const steers: string[] = [];
  const cleaned = text.replace(MID_TURN_STEER_RE, (_match, inner: string) => {
    steers.push(inner.replace(STEER_PLACEMENT_EXPLAINER_RE, "").trim());
    return "\n";
  });
  return { cleaned: steers.length > 0 ? cleaned.trimEnd() : text, steers };
}

/**
 * Split a system-role message that carries the CLI's mid-turn steer marker
 * into reminder blocks (stay system) and the steer itself (becomes user
 * input). Returns null when the text is a plain system note.
 */
export function splitSteerSystemText(
  text: string,
): { reminders: string; steer: string } | null {
  if (!text.startsWith(STEER_PREFIX)) return null;
  const reminders: string[] = [];
  const steer = text
    .replace(
      /(?:<system-reminder>[\s\S]*?<\/system-reminder>|<total_tokens>[\s\S]*?<\/total_tokens>)\n*/g,
      (block) => {
        reminders.push(block.trim());
        return "";
      },
    )
    .replace(STEER_PLACEMENT_EXPLAINER_RE, "")
    .trim();
  return { reminders: reminders.join("\n\n"), steer };
}

/** Anthropic image `source` → a URL string (base64 → data URL, or passthrough url). */
export function anthropicImageToUrl(source: unknown): string | null {
  if (!source || typeof source !== "object") return null;
  const s = source as Record<string, unknown>;
  if (s.type === "base64") {
    const mediaType = typeof s.media_type === "string" ? s.media_type : "image/jpeg";
    const data = typeof s.data === "string" ? s.data : "";
    return data ? `data:${mediaType};base64,${data}` : null;
  }
  if (s.type === "url") {
    return typeof s.url === "string" ? s.url : null;
  }
  return null;
}

/** An Anthropic `document` block, reduced to what an OpenAI upstream can carry. */
export type AnthropicDocument =
  | { kind: "file"; filename: string; dataUrl: string }
  | { kind: "url"; url: string }
  | { kind: "text"; text: string };

const DEFAULT_DOCUMENT_FILENAME = "document.pdf";

/** `null` for sources with no portable form (e.g. Anthropic Files API `file_id`). */
export function anthropicDocument(block: Record<string, unknown>): AnthropicDocument | null {
  const source = block.source as Record<string, unknown> | undefined;
  if (!source || typeof source !== "object") return null;
  if (source.type === "base64" && typeof source.data === "string" && source.data) {
    const mediaType = typeof source.media_type === "string" ? source.media_type : "application/pdf";
    const filename = typeof block.title === "string" && block.title ? block.title : DEFAULT_DOCUMENT_FILENAME;
    return { kind: "file", filename, dataUrl: `data:${mediaType};base64,${source.data}` };
  }
  if (source.type === "url" && typeof source.url === "string" && source.url) {
    return { kind: "url", url: source.url };
  }
  if (source.type === "text" && typeof source.data === "string") {
    return { kind: "text", text: source.data };
  }
  if (source.type === "content") {
    const text = messageContentToText(source.content);
    return text ? { kind: "text", text } : null;
  }
  return null;
}

/** Return value from `mapImageSource` — omit the image and surface `reason` as text. */
export type ImageOmit = { reason: string; mediaType?: string };

export type ToolResultParts = {
  text: string;
  imageUrls: string[];
  omittedNotes: string[];
  documents: Array<Exclude<AnthropicDocument, { kind: "text" }>>;
};

/**
 * Split a tool_result `content` so images and documents travel as real parts, never
 * as JSON-stringified base64 in the text output (the model would "read" nothing).
 */
export function splitToolResultContent(
  content: unknown,
  mapImageSource?: (source: unknown) => ImageOmit | null,
): ToolResultParts {
  const parts: ToolResultParts = { text: "", imageUrls: [], omittedNotes: [], documents: [] };
  if (typeof content === "string") return { ...parts, text: content };
  if (!Array.isArray(content)) {
    return { ...parts, text: content == null ? "" : JSON.stringify(content) };
  }
  const textParts: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    } else if (block.type === "image") {
      const omitted = mapImageSource?.(block.source) ?? null;
      if (omitted) {
        parts.omittedNotes.push(omitted.reason);
        continue;
      }
      const url = anthropicImageToUrl(block.source);
      if (url) parts.imageUrls.push(url);
    } else if (block.type === "document") {
      const doc = anthropicDocument(block);
      if (doc?.kind === "text") textParts.push(doc.text);
      else if (doc) parts.documents.push(doc);
    } else {
      textParts.push(JSON.stringify(block));
    }
  }
  return { ...parts, text: textParts.join("\n\n") };
}
