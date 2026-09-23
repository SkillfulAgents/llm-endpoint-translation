import { describe, expect, it } from "vitest";

import {
  decodeReasoningSignature,
  encodeReasoningSignature,
  isReasoningReplaySignature,
  reasoningReplayScope,
} from "./reasoning-replay.js";

describe("reasoning replay signature", () => {
  const replay = {
    scope: reasoningReplayScope("openai-responses", "gpt-6-astra"),
    id: "rs_0123abc",
    encryptedContent: "gAAAA+/=base64:with:colons==",
  };

  it("round-trips scope, id and the verbatim encrypted blob", () => {
    expect(decodeReasoningSignature(encodeReasoningSignature(replay))).toEqual(replay);
  });

  it("is recognizable as a replay signature, unlike a Claude signature", () => {
    expect(isReasoningReplaySignature(encodeReasoningSignature(replay))).toBe(true);
    expect(isReasoningReplaySignature("ErUBCkYIBRgCIkD...")).toBe(false);
    expect(isReasoningReplaySignature("")).toBe(false);
    expect(isReasoningReplaySignature(undefined)).toBe(false);
  });

  it("rejects non-strings, foreign signatures and truncated payloads", () => {
    expect(decodeReasoningSignature(undefined)).toBeNull();
    expect(decodeReasoningSignature("ErUBCkYIBRgCIkD")).toBeNull();
    expect(decodeReasoningSignature("rsp1:")).toBeNull();
    expect(decodeReasoningSignature("rsp1:scope-only")).toBeNull();
    expect(decodeReasoningSignature("rsp1:openai-responses/gpt-6-astra:rs_1:")).toBeNull();
    expect(decodeReasoningSignature("rsp1:openai-responses/gpt-6-astra::blob")).toBeNull();
  });
});
