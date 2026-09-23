// Anthropic Messages request → OpenAI Chat Completions request.

import {
  anthropicImageToUrl,
  extractMidTurnSteers,
  messageContentToText,
  splitSteerSystemText,
  systemToText,
} from "../shared/content.js";
import { readAnthropicJsonSchemaFormat, toChatResponseFormat } from "../shared/structured-output.js";

const CHAT_EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);

export type ChatCompletionsRequestOptions = {
  /** `reasoning_effort` sent for `thinking: disabled`; default `none`. */
  disabledReasoningEffort?: string;
};

/**
 * Anthropic thinking/effort → Chat Completions `reasoning_effort`. Disabled
 * thinking wins and maps to `disabledReasoningEffort`; effort passes through
 * unchanged (the vendor does its own per-model collapsing). Unknown values
 * are dropped so the upstream default applies.
 */
export function mapChatReasoningEffort(
  body: Record<string, unknown>,
  options: ChatCompletionsRequestOptions = {},
): string | undefined {
  const thinking = body.thinking as { type?: unknown } | undefined;
  if (thinking?.type === "disabled") {
    return options.disabledReasoningEffort ?? "none";
  }
  const outputConfig = body.output_config as { effort?: unknown } | undefined;
  const effort = outputConfig?.effort;
  return typeof effort === "string" && CHAT_EFFORT_LEVELS.has(effort)
    ? effort
    : undefined;
}

export function messagesRequestToChatCompletions(
  body: Record<string, unknown>,
  options: ChatCompletionsRequestOptions = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof body.model === "string") out.model = body.model;
  if (typeof body.max_tokens === "number") out.max_tokens = body.max_tokens;
  if (typeof body.stream === "boolean") out.stream = body.stream;
  // Chat Completions only reports usage on the terminal chunk when asked.
  if (body.stream === true) out.stream_options = { include_usage: true };
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
    out.stop = body.stop_sequences;
  }
  const reasoningEffort = mapChatReasoningEffort(body, options);
  if (reasoningEffort) out.reasoning_effort = reasoningEffort;
  // Reasoning the model emits comes back as `reasoning_content`.

  out.messages = convertMessages(body);

  const tools = convertTools(body.tools);
  if (tools.length > 0) out.tools = tools;
  const toolChoice = convertToolChoice(body.tool_choice, tools);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;

  const jsonSchema = readAnthropicJsonSchemaFormat(body);
  if (jsonSchema) out.response_format = toChatResponseFormat(jsonSchema);

  return out;
}

function convertMessages(
  body: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const system = systemToText(body.system);
  if (system) out.push({ role: "system", content: system });

  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of messages as Array<Record<string, unknown>>) {
    if (!raw || typeof raw !== "object") continue;
    const role = raw.role;
    if (role === "system") {
      pushSystemMessage(out, raw.content);
      continue;
    }
    if (role !== "user" && role !== "assistant") continue;
    const content = raw.content;
    if (typeof content === "string") {
      out.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    if (role === "user") {
      pushUserBlocks(out, content as Array<Record<string, unknown>>);
    } else {
      pushAssistantBlocks(out, content as Array<Record<string, unknown>>);
    }
  }
  return out;
}

function pushSystemMessage(
  out: Array<Record<string, unknown>>,
  content: unknown,
): void {
  const text = messageContentToText(content);
  if (!text) return;
  // A mid-turn steer is really user input; models skip it as a system note.
  const split = splitSteerSystemText(text);
  if (!split) {
    out.push({ role: "system", content: text });
    return;
  }
  if (split.reminders) out.push({ role: "system", content: split.reminders });
  if (split.steer) out.push({ role: "user", content: split.steer });
}

function pushUserBlocks(
  out: Array<Record<string, unknown>>,
  blocks: Array<Record<string, unknown>>,
): void {
  // tool_result blocks become `tool` role messages (must directly follow the
  // assistant tool_calls turn); plain text/images collect into a user message.
  const userParts: Array<Record<string, unknown>> = [];
  const followUps: Array<Record<string, unknown>> = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      userParts.push({ type: "text", text: block.text });
      continue;
    }
    if (block.type === "image") {
      const url = anthropicImageToUrl(block.source);
      if (url) userParts.push({ type: "image_url", image_url: { url } });
      continue;
    }
    if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      const { text, imageUrls } = splitToolResultContent(block.content);
      const { cleaned, steers } = extractMidTurnSteers(text);
      out.push({
        role: "tool",
        tool_call_id: block.tool_use_id,
        content: cleaned,
      });
      // Mid-turn user messages ride inside tool results as <system-reminder>
      // for Claude; other models treat tool output as data — re-surface them.
      for (const steer of steers) followUps.push({ role: "user", content: steer });
      // `tool` content is a string and can't carry images — surface them as a
      // follow-up user message the model can actually see.
      if (imageUrls.length > 0) {
        followUps.push({
          role: "user",
          content: [
            { type: "text", text: `[image output from tool ${block.tool_use_id}]` },
            ...imageUrls.map((url) => ({ type: "image_url", image_url: { url } })),
          ],
        });
      }
    }
  }
  out.push(...followUps);
  if (userParts.length > 0) {
    const onlyText = userParts.every((p) => p.type === "text");
    out.push({
      role: "user",
      content: onlyText
        ? userParts.map((p) => p.text as string).join("\n\n")
        : userParts,
    });
  }
}

function pushAssistantBlocks(
  out: Array<Record<string, unknown>>,
  blocks: Array<Record<string, unknown>>,
): void {
  const textParts: string[] = [];
  const toolCalls: Array<Record<string, unknown>> = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    // thinking blocks are never replayed: vendors reject or misparse foreign
    // reasoning in history (e.g. Fireworks 400s on thinking_blocks).
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
      continue;
    }
    if (block.type === "tool_use" && typeof block.id === "string") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: typeof block.name === "string" ? block.name : "",
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }
  if (textParts.length === 0 && toolCalls.length === 0) return;
  const msg: Record<string, unknown> = { role: "assistant" };
  msg.content = textParts.length > 0 ? textParts.join("\n\n") : null;
  if (toolCalls.length > 0) msg.tool_calls = toolCalls;
  out.push(msg);
}

function splitToolResultContent(content: unknown): {
  text: string;
  imageUrls: string[];
} {
  if (typeof content === "string") return { text: content, imageUrls: [] };
  if (!Array.isArray(content)) {
    return { text: content == null ? "" : JSON.stringify(content), imageUrls: [] };
  }
  const textParts: string[] = [];
  const imageUrls: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    } else if (block.type === "image") {
      const url = anthropicImageToUrl(block.source);
      if (url) imageUrls.push(url);
    } else {
      textParts.push(JSON.stringify(block));
    }
  }
  return { text: textParts.join("\n\n"), imageUrls };
}

/** Anthropic tools → Chat Completions function tools. Server tools are skipped. */
function convertTools(tools: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(tools)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const tool of tools as Array<Record<string, unknown>>) {
    if (!tool || typeof tool !== "object") continue;
    const type = typeof tool.type === "string" ? tool.type : "";
    const name = typeof tool.name === "string" ? tool.name : "";
    if (
      type.startsWith("web_search") ||
      type.startsWith("web_fetch") ||
      type.startsWith("code_execution")
    ) {
      continue;
    }
    if (!name) continue;
    out.push({
      type: "function",
      function: {
        name,
        description: typeof tool.description === "string" ? tool.description : "",
        parameters:
          tool.input_schema && typeof tool.input_schema === "object"
            ? tool.input_schema
            : { type: "object", properties: {} },
      },
    });
  }
  return out;
}

function convertToolChoice(
  choice: unknown,
  tools: Array<Record<string, unknown>>,
): unknown {
  if (!choice || typeof choice !== "object") return undefined;
  const c = choice as { type?: unknown; name?: unknown };
  if (c.type === "auto") return "auto";
  if (c.type === "any") return tools.length > 0 ? "required" : undefined;
  if (
    c.type === "tool" &&
    typeof c.name === "string" &&
    tools.some((t) => (t.function as Record<string, unknown>)?.name === c.name)
  ) {
    return { type: "function", function: { name: c.name } };
  }
  return undefined;
}
