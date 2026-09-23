import { describe, expect, it } from "vitest";

import {
  readAnthropicJsonSchemaFormat,
  toResponsesTextFormat,
} from "./structured-output.js";

const SCHEMA = {
  type: "object",
  properties: { action: { type: "string" }, text: { type: "string" } },
  required: ["action", "text"],
  additionalProperties: false,
};

describe("readAnthropicJsonSchemaFormat", () => {
  it("reads a V2V-style json_schema and marks it strict", () => {
    expect(
      readAnthropicJsonSchemaFormat({
        output_config: { format: { type: "json_schema", schema: SCHEMA } },
      }),
    ).toEqual({ name: "response", schema: SCHEMA, strict: true });
  });

  it("keeps a supplied name and sanitizes illegal characters", () => {
    expect(
      readAnthropicJsonSchemaFormat({
        output_config: {
          format: { type: "json_schema", name: "Live request!", schema: SCHEMA },
        },
      })?.name,
    ).toBe("Live_request");
  });

  it("is not strict when additionalProperties is not false", () => {
    expect(
      readAnthropicJsonSchemaFormat({
        output_config: {
          format: {
            type: "json_schema",
            schema: { type: "object", properties: { text: { type: "string" } } },
          },
        },
      })?.strict,
    ).toBe(false);
  });

  it.each([
    {},
    { output_config: { effort: "high" } },
    { output_config: { format: { type: "json_object" } } },
    { output_config: { format: { type: "json_schema" } } },
    { output_config: { format: { type: "json_schema", schema: [] } } },
  ])("returns undefined for %j", (body) => {
    expect(readAnthropicJsonSchemaFormat(body)).toBeUndefined();
  });
});

describe("toResponsesTextFormat", () => {
  const format = { name: "response", schema: SCHEMA, strict: true };

  it("builds Responses text.format", () => {
    expect(toResponsesTextFormat(format)).toEqual({
      format: { type: "json_schema", name: "response", schema: SCHEMA, strict: true },
    });
  });
});
