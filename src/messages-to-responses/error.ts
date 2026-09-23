// OpenAI Responses error envelope → Anthropic Messages error envelope.

type Json = Record<string, unknown>;

// Anthropic's documented status → error.type table; clients branch on both.
const TYPE_BY_STATUS: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  402: "billing_error",
  403: "permission_error",
  404: "not_found_error",
  409: "conflict_error",
  413: "request_too_large",
  429: "rate_limit_error",
  500: "api_error",
  504: "timeout_error",
  529: "overloaded_error",
};

const ANTHROPIC_TYPES = new Set(Object.values(TYPE_BY_STATUS));

function typeFor(status: number | undefined, openaiType: unknown): string {
  if (status !== undefined) {
    const mapped = TYPE_BY_STATUS[status];
    if (mapped) return mapped;
    if (status >= 400 && status < 500) return "invalid_request_error";
    if (status >= 500) return "api_error";
  }
  if (typeof openaiType === "string" && ANTHROPIC_TYPES.has(openaiType)) return openaiType;
  return "api_error";
}

/**
 * `status` is the upstream HTTP status. It decides `error.type` because Anthropic
 * clients retry by status/type, and vendor type strings differ (OpenAI's 429 `insufficient_quota`).
 */
export function responsesErrorToMessagesError(body: unknown, status?: number): Json {
  const error =
    typeof body === "object" && body !== null ? ((body as Json).error as Json | undefined) : undefined;
  const message =
    typeof error?.message === "string" && error.message ? error.message : "Upstream error";
  return { type: "error", error: { type: typeFor(status, error?.type), message } };
}
