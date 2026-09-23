/** Anthropic `output_config.format` json_schema → vendor structured-output fields. */

const DEFAULT_SCHEMA_NAME = "response";
const SCHEMA_NAME_RE = /[^a-zA-Z0-9_-]+/g;

export type JsonSchemaFormat = {
  name: string;
  schema: Record<string, unknown>;
  strict: boolean;
};

export function readAnthropicJsonSchemaFormat(
  body: Record<string, unknown>,
): JsonSchemaFormat | undefined {
  const outputConfig = body.output_config;
  if (!isPlainObject(outputConfig)) return undefined;
  const format = outputConfig.format;
  if (!isPlainObject(format) || format.type !== "json_schema") return undefined;
  if (!isPlainObject(format.schema)) return undefined;
  return {
    name: schemaName(format.name),
    schema: format.schema,
    strict: format.schema.additionalProperties === false,
  };
}

/** OpenAI / xAI Responses: `text.format`. */
export function toResponsesTextFormat(
  format: JsonSchemaFormat,
): Record<string, unknown> {
  return {
    format: {
      type: "json_schema",
      name: format.name,
      schema: format.schema,
      strict: format.strict,
    },
  };
}

/** OpenAI-compat Chat Completions: `response_format`. */
export function toChatResponseFormat(
  format: JsonSchemaFormat,
): Record<string, unknown> {
  return {
    type: "json_schema",
    json_schema: {
      name: format.name,
      strict: format.strict,
      schema: format.schema,
    },
  };
}

function schemaName(raw: unknown): string {
  if (typeof raw !== "string") return DEFAULT_SCHEMA_NAME;
  const cleaned = raw.replace(SCHEMA_NAME_RE, "_").replace(/^_+|_+$/g, "").slice(0, 64);
  return cleaned || DEFAULT_SCHEMA_NAME;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
