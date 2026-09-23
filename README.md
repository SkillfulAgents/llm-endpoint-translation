# llm-endpoint-translation

Lets an app that speaks one LLM API talk to a model that speaks another. The main use: run Claude Code, the Claude Agent SDK, or `@anthropic-ai/sdk` against OpenAI, xAI, Fireworks, or any OpenAI-compatible model.

It translates requests, JSON replies, SSE streams, and errors. It has no dependencies and does no networking: you make the upstream call, the library converts what goes in and what comes out. Works on Node 20+, Deno, Bun, and edge runtimes.

## Supported conversions

| Conversion | Your client speaks | The model speaks | Functions |
| --- | --- | --- | --- |
| [Messages → Responses](#messages--responses) | Anthropic Messages | OpenAI Responses (`/v1/responses`) | `messagesRequestToResponses`, `responsesResponseToMessages`, `responsesStreamToMessagesStream`, `responsesErrorToMessagesError` |
| [Messages → Chat Completions](#messages--chat-completions) | Anthropic Messages | OpenAI Chat Completions (`/v1/chat/completions`) | `messagesRequestToChatCompletions`, `chatCompletionsResponseToMessages`, `chatCompletionsStreamToMessagesStream`, `responsesErrorToMessagesError` |
| [Responses → Messages](#responses--messages) | OpenAI Responses | Anthropic Messages | `responsesRequestToMessages`, `messagesResponseToResponses`, `messagesStreamToResponsesStream`, `messagesErrorToResponsesError` |

Each conversion has four functions: request, JSON reply, stream, and error. Streams are `ReadableStream<Uint8Array>` of SSE bytes, in and out.

## Messages → Responses

An Anthropic client (Claude Code, the Claude Agent SDK, `@anthropic-ai/sdk`) talking to an OpenAI Responses model such as OpenAI GPT or xAI Grok.

### Supported

- **Text, JSON replies, and SSE streams.**
- **System prompt.** `system` becomes `instructions`. System-role messages inside `messages[]` stay system messages.
- **Claude Code mid-turn messages.** A `<system-reminder>` inside a tool result is resent as a real user message, since other models ignore text inside tool output.
- **Tools.** Tool calls and results become `function_call` / `function_call_output`, with functions sent as `strict: false`. Parallel tool calls work.
- **`tool_choice`.** `auto` → `auto`, `any` → `required`, `none` → `none`, `tool` → that function. `disable_parallel_tool_use` becomes `parallel_tool_calls: false` (only when tools are sent).
- **Failed tool results** (`is_error: true`) get an `Error: ` prefix, unless the text already starts with `Error` or `<tool_use_error>`.
- **Long tool names.** Names over 64 characters are shortened to a stable hashed name everywhere; pass `toolNames` to get the originals back.
- **Images.** Base64 becomes a data URL; URLs pass through. `mapImageSource` can drop images. Images in tool results move to a follow-up user message, because tool output can't hold images.
- **Documents.** Base64 → `input_file` with `file_data`, URL → `input_file` with `file_url`, text → text. In tool results they go inside `function_call_output.output`.
- **Structured output.** `output_config.format` (JSON schema) becomes `text.format`.
- **Reasoning effort.** `output_config.effort` goes through the effort mapper into `reasoning.effort`, with `summary: "auto"`. Without it, `thinking.budget_tokens` picks `high` (4096 or more), `medium` (2048 or more), or `low`.
- **Reasoning output** streams as `thinking` blocks, with summary parts separated by a blank line.
- **Reasoning across turns.** With `reasoningReplayScope`, the encrypted reasoning rides in the thinking `signature` and is replayed only under the same scope. Reasoning from another scope, or with nothing after it, is dropped, so switching model or account mid-conversation keeps the text and tool history.
- **Token limit.** `max_tokens` becomes `max_output_tokens`.
- **Usage.** Input, output, and cached input tokens (as `cache_read_input_tokens`).
- **Stop reasons.** `tool_use`, `end_turn`, `incomplete` → `max_tokens`, and refusals → `refusal` (refusal text becomes normal text).
- **Service tier.** `serviceTier` out; `onServiceTier` and `usage.speed` report what was served.
- **HTTP errors.** The OpenAI error body becomes an Anthropic error body with a matching type, so SDKs raise the right error class.
- **Errors inside the stream** become a Messages `error` event. Claude Code shows the upstream message without retrying.
- **Broken streams.** A stream that ends without finishing, or stalls for `idleTimeoutMs`, ends with a retryable `overloaded_error`, never a fake clean end. A dropped connection makes the output stream error. Cancelling the output stream cancels the upstream read.

### Dropped or degraded

If you depend on one of these, reject the request or send it to a real Anthropic backend.

- `temperature`, `top_p`, and `stop_sequences` are dropped, because reasoning models reject them.
- **Web search** is mapped to OpenAI's hosted `web_search`. Results are folded into the text, with no result blocks or citations.
- **Web fetch** is dropped. Use `hasWebFetchTool(body)` to reject it up front.
- **Code execution** is dropped. Other Anthropic-defined tools without `input_schema` are sent as functions with an empty schema.
- **Prompt caching** (`cache_control`) markers are dropped. OpenAI caches on its own and reports hits as `cache_read_input_tokens`; `cache_creation_input_tokens` is always 0.
- **Deferred tools** (`defer_loading`, tool search) are ignored; every tool is sent up front.
- **Forcing a tool** that isn't a function, or isn't in the list, leaves `tool_choice` out.
- **Search results, citations, and Files API documents** (`source.type: "file"`) are dropped from user turns. Search results inside tool results are sent as JSON text.
- **`redacted_thinking` and Claude-signed thinking** in history are dropped.
- **Effort levels** are mapped per model; reasoning depth is not guaranteed to match.
- **Fast mode** is only available as `service_tier` (`flex` / `priority`).
- **1M context beta, `context_management`, `anthropic-beta` headers** are not translated; the model's own context window applies.
- **Replies:** `stop_sequence` is always `null`. Any `incomplete`, including content filtering, reports `max_tokens`.
- **`metadata.user_id`** is dropped.

### Tested

- **Unit tests** for every item above.
- **OpenAI spec:** every translated request is validated against the official `CreateResponse` schema.
- **Official SDK:** `@anthropic-ai/sdk` consumes the translated streams and error bodies; its result must match our JSON translation.
- **Recorded traffic:** real OpenAI and xAI recordings (text, reasoning with encrypted replay over four turns, web search, errors), with golden outputs.
- **Chunk-split invariance:** the same output however the stream bytes are split.
- **Live, through [`bench/`](bench/README.md):** a real Claude Code tool loop against OpenAI `gpt-5.4-mini` and `gpt-5.4`. Covers text and streams, system prompts, tool calls, effort, reasoning replay, token limits, HTTP and in-stream errors, truncated and dropped streams, cancellation, and switching models mid-conversation.
- **Not verified live:** structured output, effort mapping, documents, refusals, `tool_choice: none`, `parallel_tool_calls: false`, shortened tool names, reasoning replay across accounts of the same vendor, and whether the model stops generating after a cancel.

## Messages → Chat Completions

An Anthropic client talking to any OpenAI-compatible Chat Completions model (OpenAI, Fireworks, DeepSeek, Groq, Mistral, Moonshot, and so on).

### Supported

- **Text, JSON replies, and SSE streams.**
- **System prompt.** `system` becomes a leading `system` message. System-role messages inside `messages[]` stay system messages.
- **Claude Code mid-turn messages** are resent as real user messages, as in Messages → Responses.
- **Tools.** Tool calls and results become `tool_calls` and `tool` messages. Parallel tool calls work, including vendors that omit the per-call `index`. The first call streams live and later calls follow it, so only one block is open at a time.
- **`tool_choice`, `disable_parallel_tool_use`, failed tool results, and long tool names** behave as in Messages → Responses.
- **Sampling.** `temperature` and `top_p` pass through. `stop_sequences` becomes `stop`.
- **Images.** Base64 becomes a data URL; URLs pass through. Images in tool results move to a follow-up user message.
- **Documents.** Base64 → a `file` part, text → text. In tool results they move to a follow-up user message.
- **Structured output.** `output_config.format` becomes `response_format`.
- **Reasoning effort** passes through as `reasoning_effort`, with the same `budget_tokens` fallback. `mapReasoningEffort` can rename or omit it.
- **Reasoning output.** `reasoning_content` becomes `thinking` blocks.
- **Token limit.** `max_tokens`, or `max_completion_tokens` via `tokenLimitField`.
- **Usage.** Input, output, and cached input tokens. Streaming requests ask for usage with `stream_options.include_usage`.
- **Stop reasons.** `tool_calls` → `tool_use`, `length` → `max_tokens`, `content_filter` or a refusal → `refusal`, anything else → `end_turn`.
- **HTTP errors** convert as in Messages → Responses (the error body has the same shape).
- **Errors inside the stream** become a Messages `error` event. Claude Code treats it as a server error, retries, then shows a generic message.
- **Broken streams** end with a retryable `overloaded_error`, as in Messages → Responses. Two exceptions end normally: a stream that sent a `finish_reason` but no final usage chunk (reported with zero usage), and a stall after the `finish_reason`.

### Dropped or degraded

- **Document URLs** become a text note, because Chat `file` parts can't take a URL.
- **Reasoning across turns** is never replayed; prior thinking is dropped from history. Switching model mid-conversation keeps text and tool history.
- **Web search** is dropped.
- **Service tier / fast mode** is not available.
- **Effort levels** pass through as-is and the vendor decides.
- **Content-filter stops** map to `refusal`.
- Web fetch, code execution, prompt caching, deferred tools, search results, citations, Files API documents, `redacted_thinking`, the 1M context beta, `stop_sequence` in replies, and `metadata.user_id` are handled the same way as in Messages → Responses.

### Tested

- **Unit tests** for every item above.
- **OpenAI spec:** every translated request is validated against the official `CreateChatCompletionRequest` schema, with both token-limit fields.
- **Official SDK:** `@anthropic-ai/sdk` consumes the translated streams; its result must match our JSON translation.
- **Recorded traffic:** real OpenAI, DeepSeek, Groq, Mistral, and Moonshot recordings (text, reasoning, tool calls, tool calls with and without `index`, usage quirks, errors), with golden outputs.
- **Chunk-split invariance.**
- **Live, through [`bench/`](bench/README.md):** a real Claude Code tool loop against OpenAI `gpt-4.1-mini` and Fireworks `glm-5p3-flash` / `kimi-k3`, covering the same scenarios as Messages → Responses.
- **Not verified live:** stop sequences, effort mapping, documents, and whether each vendor accepts `file` parts.

## Responses → Messages

An OpenAI Responses client (for example the `openai` SDK) talking to an Anthropic Messages model.

### Supported

- **Text, JSON replies, and SSE streams.**
- **Prompts.** `input` as a string or a list of items. `instructions` and system/developer messages become `system`.
- **Tools.** Function tools, `function_call`, and `function_call_output`. `web_search` becomes Anthropic's web search tool, and its calls come back as `web_search_call` items.
- **`tool_choice`.** `auto`, `required` → `any`, `none`, and a named function. `parallel_tool_calls: false` becomes `disable_parallel_tool_use`.
- **Images** as data URLs or https URLs.
- **Structured output.** `text.format` (JSON schema) becomes `output_config.format`.
- **Reasoning.** `reasoning.effort` becomes `output_config.effort`; `none` and `minimal` turn thinking off. Thinking comes back as `reasoning` items, with the signature in `encrypted_content`, so a client that sends the item back gets the exact thinking replayed. `redacted_thinking` round-trips the same way.
- **Sampling and limits.** `temperature` and `top_p` pass through. `max_output_tokens` becomes `max_tokens` (default 8192, because Messages requires it).
- **Usage and service tier.** `input_tokens` includes cache reads and writes; `cached_tokens` and `cache_write_tokens` are reported. Anthropic's `speed` becomes `service_tier` (`fast` → `priority`, `slow` → `flex`).
- **Stop reasons.** `max_tokens` → `incomplete`; refusals become a `refusal` content part.
- **Errors.** Anthropic error bodies become OpenAI error bodies. An error inside the stream becomes `response.failed`.
- **Broken streams.** A stream that ends without finishing becomes `response.failed`. Cancelling the output stream cancels the upstream read.

### Rejected or degraded

Unsupported input throws `TranslationError` with `code` set to `unsupported_parameter` or `invalid_request_error`; return it to the client as a 400.

- **Rejected:** `previous_response_id`, `conversation`, and `prompt` (nothing is stored), `background` mode, `text.format` types other than JSON schema, `input_image` by `file_id`, and any other input item, content part, or tool type.
- **Reasoning items** from another source (without a signature this library emitted) are dropped.
- **The reply doesn't echo the request.** `instructions`, `tools`, `temperature`, and similar fields in the returned Response are defaults, because the reply translator never sees the request.
- **Error codes:** Anthropic rate limits become `rate_limit_exceeded`; every other error type becomes `server_error`. `reasoning_tokens` is always 0.
- **No idle timeout:** a stalled Messages stream is not ended by the library.

### Tested

- **Unit tests** for every item above.
- **OpenAI spec:** every translated reply, stream event, and error is validated against the official `Response`, `ResponseStreamEvent`, and `ErrorResponse` schemas.
- **Official SDK:** the `openai` SDK consumes the translated streams and error bodies.
- **Recorded traffic:** real Anthropic recordings (text, thinking, structured output, tool calls, refusals, web search), with golden outputs.
- **Chunk-split invariance.**
- **Not verified live:** this direction has no live test against a real Anthropic model.

## Install

Not on the npm registry. Install the tarball from a [GitHub Release](https://github.com/SkillfulAgents/llm-endpoint-translation/releases); pnpm and npm pin its integrity hash in the lockfile.

```sh
pnpm add https://github.com/SkillfulAgents/llm-endpoint-translation/releases/download/v0.1.1/llm-endpoint-translation-0.1.1.tgz
```

To upgrade, change the URL to the new release and reinstall.

## Quick start

A handler that accepts an Anthropic Messages request and answers it with an OpenAI Responses model:

```ts
import {
  messagesRequestToResponses,
  responsesErrorToMessagesError,
  responsesResponseToMessages,
  responsesStreamToMessagesStream,
  toolNameRestoreMap,
} from "llm-endpoint-translation";

export async function handleMessages(request: Record<string, unknown>): Promise<Response> {
  const { body } = messagesRequestToResponses(request);
  // OpenAI caps tool names at 64 chars; this maps shortened names back for the client.
  const toolNames = toolNameRestoreMap(request);

  const upstream = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!upstream.ok) {
    const error = responsesErrorToMessagesError(await upstream.json(), upstream.status);
    return Response.json(error, { status: upstream.status });
  }
  if (request.stream === true) {
    return new Response(responsesStreamToMessagesStream(upstream.body!, { toolNames }), {
      headers: { "content-type": "text/event-stream" },
    });
  }
  return Response.json(responsesResponseToMessages(await upstream.json(), { toolNames }));
}
```

For a Chat Completions model, swap in the `chatCompletions*` functions. `messagesRequestToChatCompletions` returns the body directly instead of `{ body }`.

Working examples with the real `@anthropic-ai/sdk` and `openai` clients, for all three conversions, are in [`test/conformance/sdk-usage.test.ts`](test/conformance/sdk-usage.test.ts).

## What your proxy must handle

The library only converts data. Whoever runs it owns these:

- **Abort both sides.** When the client disconnects, abort the upstream request. When the output stream errors, close the client connection, or the client waits forever (found by `bench/faults.sh`).
- **Per-provider settings.** Effort mapping, which token-limit field to send, per-model output caps, and removing token-limit fields for providers that reject them (as Codex-style upstreams do). Claude Code asks for up to 128k output tokens; `gpt-4.1-mini` rejects anything above 32,768.
- **The reasoning replay scope.** Use one scope per upstream account and model (see `reasoningReplayScope` below). In `bench/switch.sh`, OpenAI accepted reasoning from `gpt-5.4-mini` replayed to `gpt-5.4` on the same account; replay across accounts is untested, and the scope prevents it.

## Runtime load

Measured 2026-09-23 in image `superagent-agent-container-base:0.5.30` (Node 22.23.2, 4 CPUs). The library ran in its own Node process in that image, not inside the agent server. Scripts and the rest of the bench are in [`bench/README.md`](bench/README.md).

No runtime dependencies. Built `dist/*.js` is 103 KB (22 KB gzipped). Installing the v0.1.0 release tarball adds 113 KB to the image; the installed package is 249 KB on disk.

**Idle** (fresh Node process, RSS after GC, median of 3):

| | RSS | Heap | Import time |
| --- | --- | --- | --- |
| Node + `http` server | 52.6 MB | 5.9 MB | – |
| + library imported | 53.2 MB | 6.3 MB | 14 ms |

The library adds 0.6 MB RSS at idle. Idle CPU was the same with and without it.

**Concurrent streams.** Each stream replays about 900 events (a ~600-word answer plus a tool call) for 30 s. `passthrough` is the same proxy with no translation.

| Streams | Backend | Peak RSS | Peak heap | Proxy CPU (% of one core) |
| --- | --- | --- | --- | --- |
| 10 | passthrough | 91.7 MB | 12.1 MB | 9.9 |
| 10 | responses | 87.8 MB | 14.9 MB | 12.1 |
| 10 | chat | 94.1 MB | 13.4 MB | 11.1 |
| 50 | passthrough | 112.2 MB | 23.5 MB | 17.2 |
| 50 | responses | 122.1 MB | 26.5 MB | 19.2 |
| 50 | chat | 118.7 MB | 26.2 MB | 18.8 |

All 360 streams completed, and throughput matched across backends. At 50 streams, translation adds about 2 CPU percentage points and 6–10 MB peak RSS over passthrough. The ~30 MB jump from idle on the first request is Node's `fetch` warming up; passthrough shows it too.

## Options

All options are optional.

**Messages → Responses request (`messagesRequestToResponses`)**

| Option | What it does |
| --- | --- |
| `mapReasoningEffort` | Maps Anthropic thinking/effort to the model's effort vocabulary. Build one with `createEffortMapper` (for example xAI has no `none`). |
| `serviceTier` | Sends `flex` or `priority` as `service_tier`. |
| `mapImageSource` | Return `{ reason }` to drop an image and put the reason in its place as text. |
| `reasoningReplayScope` | Asks for encrypted reasoning and replays it on later turns under the same scope. |
| `replayPriorReasoning` | `false` collects fresh reasoning but skips replaying history. |

**Messages → Chat Completions request (`messagesRequestToChatCompletions`)**

| Option | What it does |
| --- | --- |
| `mapReasoningEffort` | Returns the `reasoning_effort` to send, or `undefined` to omit it. |
| `disabledReasoningEffort` | Value sent for `thinking: disabled`. Default `none`. |
| `tokenLimitField` | `max_tokens` (default) or `max_completion_tokens` (required by OpenAI's GPT-5 chat models). |

**Replies and streams (both Messages → conversions)**

| Option | What it does |
| --- | --- |
| `toolNames` | Pass `toolNameRestoreMap(request)` so shortened tool names come back as the originals. |
| `model` | Model name to report to the client instead of the upstream's (for example a dated snapshot). |
| `reasoningReplayScope` | Responses only. Signs thinking blocks so the next request can replay them. |
| `idleTimeoutMs` | Streams only. Ends a stalled stream with a retryable error. Default 5 minutes. |
| `onAbnormalEnd` | Streams only. Called with `"stalled"` or `"truncated"`. |
| `onServiceTier` | Responses stream only. Called with each `service_tier` the upstream reports; the last one is the tier actually served. |

**Responses → Messages stream (`messagesStreamToResponsesStream`)**: `model` is reported when the upstream's `message_start` carries none.

## Development

```sh
npm ci
npm run check          # typecheck + lint + tests with coverage + package smoke test
npx vitest run -u      # regenerate golden outputs after an intended change; review the diff
```

CI runs `npm run check` on Node 20, 22, and 24. The OpenAI spec is pinned in `test/fixtures/external/openai-openapi` (refresh with `npm run spec:sync`); recorded traffic comes from the [Vercel AI SDK](https://github.com/vercel/ai) test fixtures (Apache-2.0, pinned), with golden outputs in `test/fixtures/golden`. A weekly `upstream-drift` workflow re-runs conformance against OpenAI's latest spec and the latest SDKs.

## License

MIT. Vendored test fixtures keep their upstream licenses; see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
