import { describe, it } from "vitest";

import {
  messagesErrorToResponsesError,
  messagesRequestToChatCompletions,
  messagesRequestToResponses,
  messagesResponseToResponses,
  messagesStreamToResponsesStream,
} from "../../src";
import { messagesErrors, messagesReplies, messagesStreams } from "../fixtures/messages-corpus";
import { messagesRequests } from "../fixtures/requests/messages-requests";
import { assertOpenAISchema } from "../helpers/openai-spec";
import { readSse, streamFromPayloads } from "../helpers/sse";

describe("Messages request → CreateResponse conforms to the OpenAI spec", () => {
  it.each(Object.entries(messagesRequests))("%s", (_name, request) => {
    assertOpenAISchema("CreateResponse", messagesRequestToResponses(request).body);
  });
});

describe("Messages reply → Response conforms to the OpenAI spec", () => {
  it.each(messagesReplies)("$name", ({ body }) => {
    assertOpenAISchema("Response", messagesResponseToResponses(body));
  });
});

describe("Messages stream → ResponseStreamEvent conforms to the OpenAI spec", () => {
  it.each(messagesStreams)("$name", async ({ events }) => {
    const frames = await readSse(messagesStreamToResponsesStream(streamFromPayloads(events, 61)));
    for (const frame of frames) assertOpenAISchema("ResponseStreamEvent", frame.data);
  });
});

describe("Messages error → ErrorResponse conforms to the OpenAI spec", () => {
  it.each(messagesErrors)("$name", ({ body }) => {
    assertOpenAISchema("ErrorResponse", messagesErrorToResponsesError(body));
  });
});

describe("Messages request → CreateChatCompletionRequest conforms to the OpenAI spec", () => {
  it.each(Object.entries(messagesRequests))("%s", (_name, request) => {
    assertOpenAISchema("CreateChatCompletionRequest", messagesRequestToChatCompletions(request));
  });

  it.each(Object.entries(messagesRequests))("%s (max_completion_tokens, no reasoning_effort)", (_name, request) => {
    assertOpenAISchema(
      "CreateChatCompletionRequest",
      messagesRequestToChatCompletions(request, {
        tokenLimitField: "max_completion_tokens",
        mapReasoningEffort: () => undefined,
      }),
    );
  });
});
