export { TranslationError, type TranslationErrorCode } from "./errors.js";

export {
  clampEffort,
  createEffortMapper,
  defaultEffortMapper,
  effortFromThinkingBudget,
  isThinkingDisabled,
  readAnthropicEffort,
  type EffortCeiling,
  type EffortMapper,
  type EffortMapperOptions,
  type ReasoningEffort,
} from "./shared/effort.js";
export { shortenToolName, toolNameRestoreMap } from "./shared/tool-names.js";

// Messages -> Responses: an Anthropic client talking to a Responses upstream.
export {
  hasWebFetchTool,
  messagesRequestToResponses,
  type ImageOmit,
  type ResponsesRequestOptions,
  type ResponsesRequestResult,
  type ServiceTier,
} from "./messages-to-responses/request.js";
export {
  responsesResponseToMessages,
  type ResponsesResponseOptions,
} from "./messages-to-responses/response.js";
export {
  RESPONSES_STREAM_IDLE_TIMEOUT_MS,
  responsesStreamToMessagesStream,
  type ResponsesStreamOptions,
} from "./messages-to-responses/stream.js";
export { responsesErrorToMessagesError } from "./messages-to-responses/error.js";
export {
  extractResponsesUsage,
  servedSpeedEcho,
  type AnthropicUsage,
} from "./messages-to-responses/usage.js";
export {
  decodeReasoningSignature,
  encodeReasoningSignature,
  isReasoningReplaySignature,
  reasoningReplayScope,
  type ReasoningReplay,
} from "./messages-to-responses/reasoning-replay.js";

// Responses -> Messages: a Responses client talking to a Messages upstream.
export {
  DEFAULT_MAX_OUTPUT_TOKENS,
  responsesRequestToMessages,
  type MessagesRequestOptions,
} from "./responses-to-messages/request.js";
export {
  messagesErrorToResponsesError,
  messagesResponseToResponses,
  toResponsesUsage,
} from "./responses-to-messages/response.js";
export {
  messagesStreamToResponsesStream,
  type MessagesStreamOptions,
} from "./responses-to-messages/stream.js";

// Messages -> Chat Completions: an Anthropic client talking to a Chat Completions upstream.
export {
  mapChatReasoningEffort,
  messagesRequestToChatCompletions,
  type ChatCompletionsRequestOptions,
} from "./messages-to-chat/request.js";
export {
  chatCompletionsResponseToMessages,
  extractChatCompletionsUsage,
  type ChatCompletionsResponseOptions,
} from "./messages-to-chat/response.js";
export {
  CHAT_COMPLETIONS_STREAM_IDLE_TIMEOUT_MS,
  chatCompletionsStreamToMessagesStream,
  type ChatCompletionsStreamOptions,
} from "./messages-to-chat/stream.js";
