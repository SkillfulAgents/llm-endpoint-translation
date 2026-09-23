import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { messagesError } from "../../test/schemas/messages.js";
import { responsesErrorToMessagesError } from "./error.js";

const openaiError = (type: string, message = "boom") => ({
  error: { message, type, param: null, code: type },
});

describe("responsesErrorToMessagesError", () => {
  it.each([
    [400, "invalid_request_error"],
    [401, "authentication_error"],
    [402, "billing_error"],
    [403, "permission_error"],
    [404, "not_found_error"],
    [409, "conflict_error"],
    [413, "request_too_large"],
    [429, "rate_limit_error"],
    [500, "api_error"],
    [504, "timeout_error"],
    [529, "overloaded_error"],
  ])("maps HTTP %i to Anthropic %s", (status, type) => {
    const out = responsesErrorToMessagesError(openaiError("whatever"), status);
    expect(out).toEqual({ type: "error", error: { type, message: "boom" } });
    messagesError.parse(out);
  });

  it("maps undocumented 4xx to invalid_request_error and undocumented 5xx to api_error", () => {
    expect(responsesErrorToMessagesError(openaiError("x"), 422)).toMatchObject({
      error: { type: "invalid_request_error" },
    });
    expect(responsesErrorToMessagesError(openaiError("x"), 503)).toMatchObject({
      error: { type: "api_error" },
    });
  });

  it("lets the HTTP status win over the vendor type (OpenAI 429 insufficient_quota)", () => {
    expect(responsesErrorToMessagesError(openaiError("insufficient_quota"), 429)).toMatchObject({
      error: { type: "rate_limit_error" },
    });
  });

  it("without a status, keeps a vendor type Anthropic also uses and falls back to api_error otherwise", () => {
    expect(responsesErrorToMessagesError(openaiError("invalid_request_error"))).toMatchObject({
      error: { type: "invalid_request_error" },
    });
    expect(responsesErrorToMessagesError(openaiError("server_error"))).toMatchObject({
      error: { type: "api_error" },
    });
  });

  it.each([null, "plain text", 42, {}, { error: "string" }, { error: { message: "" } }])(
    "produces a valid envelope for a malformed body %j",
    (body) => {
      const out = responsesErrorToMessagesError(body, 502);
      expect(out).toEqual({ type: "error", error: { type: "api_error", message: "Upstream error" } });
      messagesError.parse(out);
    },
  );

  it("translates the recorded OpenAI insufficient_quota error", () => {
    const body = JSON.parse(
      readFileSync(join(import.meta.dirname, "../../test/fixtures/external/vercel-ai/openai/openai-error.1.json"), "utf8"),
    );
    const out = responsesErrorToMessagesError(body, 429);
    messagesError.parse(out);
    expect(out).toEqual({
      type: "error",
      error: { type: "rate_limit_error", message: body.error.message },
    });
  });
});
