// OpenAI Responses request → Anthropic Messages request.

import { TranslationError } from "../errors.js";
import { decodeReasoningItemSignature } from "./reasoning.js";

// Messages requires max_tokens; Responses makes it optional.
export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

type Block = Record<string, unknown>;
type Message = { role: "user" | "assistant"; content: Block[] };

// Translation is stateless: nothing that needs a stored response or conversation.
const STATEFUL_FIELDS = ["previous_response_id", "conversation", "prompt"] as const;

export function responsesRequestToMessages(
  body: Record<string, unknown>,
): Record<string, unknown> {
  for (const field of STATEFUL_FIELDS) {
    if (body[field] !== undefined && body[field] !== null) {
      throw unsupported(`'${field}' is not supported: this gateway does not store responses`);
    }
  }
  if (body.background === true) {
    throw unsupported("'background' mode is not supported");
  }

  const out: Record<string, unknown> = {};
  if (typeof body.model === "string") out.model = body.model;
  out.max_tokens =
    typeof body.max_output_tokens === "number" ? body.max_output_tokens : DEFAULT_MAX_OUTPUT_TOKENS;
  if (typeof body.stream === "boolean") out.stream = body.stream;
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;

  const systemParts: string[] = [];
  if (typeof body.instructions === "string" && body.instructions) {
    systemParts.push(body.instructions);
  }
  out.messages = convertInput(body.input, systemParts);
  if (systemParts.length > 0) out.system = systemParts.join("\n\n");

  const tools = convertTools(body.tools);
  if (tools.length > 0) out.tools = tools;
  const toolChoice = convertToolChoice(body.tool_choice, body.parallel_tool_calls);
  if (toolChoice) out.tool_choice = toolChoice;

  const outputConfig: Record<string, unknown> = {};
  const reasoning = asRecord(body.reasoning);
  const effort = reasoning?.effort;
  if (effort === "none" || effort === "minimal") {
    out.thinking = { type: "disabled" };
  } else if (typeof effort === "string") {
    outputConfig.effort = effort;
  }
  const format = asRecord(asRecord(body.text)?.format);
  if (format?.type === "json_schema") {
    outputConfig.format = { type: "json_schema", name: format.name, schema: format.schema };
  } else if (format && format.type !== "text") {
    throw unsupported(`text.format type '${String(format.type)}' is not supported`);
  }
  if (Object.keys(outputConfig).length > 0) out.output_config = outputConfig;

  return out;
}

function convertInput(input: unknown, systemParts: string[]): Message[] {
  if (typeof input === "string") {
    return [{ role: "user", content: [{ type: "text", text: input }] }];
  }
  if (!Array.isArray(input)) {
    throw new TranslationError("invalid_request_error", "'input' must be a string or an array");
  }

  const messages: Message[] = [];
  const push = (role: Message["role"], blocks: Block[]) => {
    if (blocks.length === 0) return;
    const last = messages[messages.length - 1];
    // Messages alternates roles; Responses lists tool calls/results as sibling items.
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };

  for (const raw of input) {
    const item = asRecord(raw);
    if (!item) continue;
    const type = item.type ?? (item.role !== undefined ? "message" : undefined);

    if (type === "message") {
      const role = item.role;
      if (role === "system" || role === "developer") {
        const text = contentToText(item.content);
        if (text) systemParts.push(text);
      } else if (role === "user" || role === "assistant") {
        push(role, contentToBlocks(item.content));
      } else {
        throw new TranslationError("invalid_request_error", `Unsupported message role: ${String(role)}`);
      }
    } else if (type === "function_call") {
      push("assistant", [
        {
          type: "tool_use",
          id: String(item.call_id ?? ""),
          name: String(item.name ?? ""),
          input: parseArguments(item.arguments),
        },
      ]);
    } else if (type === "function_call_output") {
      push("user", [
        {
          type: "tool_result",
          tool_use_id: String(item.call_id ?? ""),
          content: typeof item.output === "string" ? item.output : contentToText(item.output),
        },
      ]);
    } else if (type === "reasoning") {
      // Replayable only when it round-trips a thinking signature this library emitted.
      const block = decodeReasoningItemSignature(item);
      if (block) push("assistant", [block]);
    } else {
      throw unsupported(`input item type '${String(type)}' is not supported`);
    }
  }
  return messages;
}

function contentToBlocks(content: unknown): Block[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks: Block[] = [];
  for (const raw of content) {
    const part = asRecord(raw);
    if (!part) continue;
    if (
      (part.type === "input_text" || part.type === "output_text" || part.type === "text") &&
      typeof part.text === "string"
    ) {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "refusal" && typeof part.refusal === "string") {
      blocks.push({ type: "text", text: part.refusal });
    } else if (part.type === "input_image") {
      blocks.push(imageBlock(part));
    } else {
      throw unsupported(`content part type '${String(part.type)}' is not supported`);
    }
  }
  return blocks;
}

const DATA_URL = /^data:([^;,]+);base64,(.*)$/s;

function imageBlock(part: Record<string, unknown>): Block {
  const url = typeof part.image_url === "string" ? part.image_url : "";
  const data = DATA_URL.exec(url);
  if (data) {
    return { type: "image", source: { type: "base64", media_type: data[1], data: data[2] } };
  }
  if (/^https?:\/\//i.test(url)) {
    return { type: "image", source: { type: "url", url } };
  }
  throw unsupported("input_image requires an image_url (data: or https: URL); file_id is not supported");
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((raw) => {
      const part = asRecord(raw);
      return part && typeof part.text === "string" ? part.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function convertTools(tools: unknown): Block[] {
  if (!Array.isArray(tools)) return [];
  return tools.map((raw) => {
    const tool = asRecord(raw);
    if (tool?.type === "function" && typeof tool.name === "string") {
      return {
        name: tool.name,
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        input_schema: asRecord(tool.parameters) ?? { type: "object", properties: {} },
      };
    }
    if (tool?.type === "web_search" || tool?.type === "web_search_preview") {
      return { type: "web_search_20250305", name: "web_search" };
    }
    throw unsupported(`tool type '${String(tool?.type)}' is not supported`);
  });
}

function convertToolChoice(choice: unknown, parallel: unknown): Block | undefined {
  const disableParallel = parallel === false ? { disable_parallel_tool_use: true } : {};
  if (choice === undefined || choice === null) {
    return parallel === false ? { type: "auto", ...disableParallel } : undefined;
  }
  if (choice === "auto") return { type: "auto", ...disableParallel };
  if (choice === "required") return { type: "any", ...disableParallel };
  if (choice === "none") return { type: "none" };
  const named = asRecord(choice);
  if (named?.type === "function" && typeof named.name === "string") {
    return { type: "tool", name: named.name, ...disableParallel };
  }
  throw unsupported("tool_choice must be 'auto', 'required', 'none', or a function reference");
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== "string" || !value) return {};
  try {
    return JSON.parse(value);
  } catch {
    throw new TranslationError("invalid_request_error", "function_call.arguments is not valid JSON");
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function unsupported(message: string): TranslationError {
  return new TranslationError("unsupported_parameter", message);
}
