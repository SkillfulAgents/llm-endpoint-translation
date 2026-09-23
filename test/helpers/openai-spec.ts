import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";

const SPEC_ID = "https://openai-openapi.local/spec.json";

type Schema = Record<string, unknown>;

const vendored = JSON.parse(
  readFileSync(join(import.meta.dirname, "../fixtures/external/openai-openapi/schemas.json"), "utf8"),
) as { source: { sha: string }; schemas: Record<string, Schema> };

export const openaiSpecSha = vendored.source.sha;

// Known spec-vs-live-API gap, kept explicit: the API takes assistant history as `output_text` parts
// without id/status (and rejects `input_text` there); the spec only allows a full OutputMessage.
const assistantHistoryMessage = {
  type: "object",
  properties: {
    type: { enum: ["message"] },
    role: { enum: ["assistant"] },
    content: {
      type: "array",
      items: {
        type: "object",
        properties: { type: { enum: ["output_text"] }, text: { type: "string" } },
        required: ["type", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["role", "content"],
  additionalProperties: false,
};
(vendored.schemas.InputItem.anyOf as unknown[]).push(assistantHistoryMessage);

const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
ajv.addSchema({ $id: SPEC_ID, components: { schemas: vendored.schemas } });

const cache = new Map<string, ValidateFunction>();

function validator(name: string): ValidateFunction {
  let fn = cache.get(name);
  if (!fn) {
    if (!vendored.schemas[name]) throw new Error(`openai-openapi has no schema ${name}`);
    fn = ajv.compile({ $ref: `${SPEC_ID}#/components/schemas/${name}` });
    cache.set(name, fn);
  }
  return fn;
}

// ResponseStreamEvent is a 50-way union; validate against the member its `type` selects for readable errors.
const streamEventSchemaByType = new Map<string, string>(
  ((vendored.schemas.ResponseStreamEvent.anyOf ?? []) as Schema[]).flatMap((member) => {
    const name = String(member.$ref).split("/").pop()!;
    const type = (vendored.schemas[name].properties as Record<string, Schema> | undefined)?.type;
    return ((type?.enum ?? []) as string[]).map((value) => [value, name] as [string, string]);
  }),
);

function describeErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .slice(0, 12)
    .map((e) => `${e.instancePath || "/"} ${e.message} ${JSON.stringify(e.params)}`)
    .join("\n");
}

export type OpenAISchemaName =
  | "Response"
  | "CreateResponse"
  | "ResponseStreamEvent"
  | "ErrorResponse"
  | "CreateChatCompletionRequest";

/** Throws with the spec's own error paths when `value` doesn't conform. */
export function assertOpenAISchema(name: OpenAISchemaName, value: unknown): void {
  let target: string = name;
  if (name === "ResponseStreamEvent") {
    const type = String((value as Schema | null)?.type);
    const member = streamEventSchemaByType.get(type);
    if (!member) throw new Error(`openai-openapi@${openaiSpecSha.slice(0, 7)} has no stream event type ${type}`);
    target = member;
  }
  const fn = validator(target);
  if (!fn(value)) {
    throw new Error(
      `does not conform to openai-openapi@${openaiSpecSha.slice(0, 7)} ${target}:\n${describeErrors(fn.errors)}\nvalue: ${JSON.stringify(value).slice(0, 400)}`,
    );
  }
}
