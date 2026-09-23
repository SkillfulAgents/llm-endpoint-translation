import { describe, expect, it } from "vitest";

import { messagesRequests } from "../../test/fixtures/requests/messages-requests.js";
import { createEffortMapper } from "../shared/effort.js";
import { messagesRequestToChatCompletions } from "./request.js";

const base = { model: "m", max_tokens: 256, messages: [{ role: "user", content: "hi" }] };

describe("messagesRequestToChatCompletions provider options", () => {
  it.each(Object.entries(messagesRequests))("defaults are byte-identical to no options: %s", (_name, request) => {
    const none = messagesRequestToChatCompletions(request);
    expect(JSON.stringify(messagesRequestToChatCompletions(request, {}))).toBe(JSON.stringify(none));
    expect(JSON.stringify(messagesRequestToChatCompletions(request, { tokenLimitField: "max_tokens" }))).toBe(
      JSON.stringify(none),
    );
  });

  it("writes the token limit as max_completion_tokens when asked", () => {
    const out = messagesRequestToChatCompletions(base, { tokenLimitField: "max_completion_tokens" });
    expect(out.max_completion_tokens).toBe(256);
    expect(out).not.toHaveProperty("max_tokens");
  });

  it("omits reasoning_effort when the mapper returns undefined, even for disabled thinking and explicit effort", () => {
    const omit = () => undefined;
    expect(
      messagesRequestToChatCompletions({ ...base, thinking: { type: "disabled" } }, { mapReasoningEffort: omit }),
    ).not.toHaveProperty("reasoning_effort");
    expect(
      messagesRequestToChatCompletions({ ...base, output_config: { effort: "high" } }, { mapReasoningEffort: omit }),
    ).not.toHaveProperty("reasoning_effort");
  });

  it("lets mapReasoningEffort win over disabledReasoningEffort", () => {
    const out = messagesRequestToChatCompletions(
      { ...base, thinking: { type: "disabled" } },
      { disabledReasoningEffort: "low", mapReasoningEffort: () => "minimal" },
    );
    expect(out.reasoning_effort).toBe("minimal");
  });

  it("accepts the shared EffortMapper, so a provider can clamp effort the same way as on Responses", () => {
    const mapReasoningEffort = createEffortMapper({ disabledEffort: "low", maxEffort: "high" });
    expect(
      messagesRequestToChatCompletions({ ...base, output_config: { effort: "max" } }, { mapReasoningEffort })
        .reasoning_effort,
    ).toBe("high");
    expect(
      messagesRequestToChatCompletions({ ...base, thinking: { type: "disabled" } }, { mapReasoningEffort })
        .reasoning_effort,
    ).toBe("low");
  });

  it("keeps the default effort pass-through when no mapper is given", () => {
    expect(
      messagesRequestToChatCompletions({ ...base, output_config: { effort: "max" } }).reasoning_effort,
    ).toBe("max");
    expect(messagesRequestToChatCompletions({ ...base, thinking: { type: "disabled" } }).reasoning_effort).toBe("none");
  });
});
