# llm-endpoint-translation

Lets an app that speaks one LLM API talk to a model that speaks another. The main use: run Claude Code, the Claude Agent SDK, or `@anthropic-ai/sdk` against OpenAI, xAI, Fireworks, or any OpenAI-compatible model.

It translates requests, JSON replies, SSE streams, and errors. It has no dependencies and does no networking: you make the upstream call, the library converts what goes in and what comes out. Works on Node 20+, Deno, Bun, and edge runtimes.

## Pick your direction

| Your client speaks | The model speaks | Use |
| --- | --- | --- |
| Anthropic Messages | OpenAI Responses (`/v1/responses`) | `messagesRequestToResponses`, `responsesResponseToMessages`, `responsesStreamToMessagesStream`, `responsesErrorToMessagesError` |
| Anthropic Messages | OpenAI Chat Completions (`/v1/chat/completions`) | `messagesRequestToChatCompletions`, `chatCompletionsResponseToMessages`, `chatCompletionsStreamToMessagesStream`, `responsesErrorToMessagesError` |
| OpenAI Responses | Anthropic Messages | `responsesRequestToMessages`, `messagesResponseToResponses`, `messagesStreamToResponsesStream`, `messagesErrorToResponsesError` |

Each row has four functions: request, JSON reply, stream, and error. Streams are `ReadableStream<Uint8Array>` of SSE bytes, in and out.

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

For the reverse direction, `responsesRequestToMessages` throws `TranslationError` on input it can't express (for example `previous_response_id`). Return it to the client as a 400 with `err.code` as the error type.

Working examples with the real `@anthropic-ai/sdk` and `openai` clients are in [`test/conformance/sdk-usage.test.ts`](test/conformance/sdk-usage.test.ts).

## What your proxy must handle

The library only converts data. Whoever runs it owns these:

- **Abort both sides.** When the client disconnects, abort the upstream request. When the output stream errors, close the client connection, or the client waits forever (found by `bench/faults.sh`).
- **Per-provider settings.** Effort mapping, which token-limit field to send, per-model output caps, and removing token-limit fields for providers that reject them (as Codex-style upstreams do). Claude Code asks for up to 128k output tokens; `gpt-4.1-mini` rejects anything above 32,768.
- **The reasoning replay scope.** Use one scope per upstream account and model (see `reasoningReplayScope` below). In `bench/switch.sh`, OpenAI accepted reasoning from `gpt-5.4-mini` replayed to `gpt-5.4` on the same account; replay across accounts is untested, and the scope prevents it.

## Options

All options are optional.

**Request (`messagesRequestToResponses`)**

| Option | What it does |
| --- | --- |
| `mapReasoningEffort` | Maps Anthropic thinking/effort to the model's effort vocabulary. Build one with `createEffortMapper` (for example xAI has no `none`). |
| `serviceTier` | Sends `flex` or `priority` as `service_tier`. |
| `mapImageSource` | Return `{ reason }` to drop an image and put the reason in its place as text. |
| `reasoningReplayScope` | Asks for encrypted reasoning and replays it on later turns under the same scope. |
| `replayPriorReasoning` | `false` collects fresh reasoning but skips replaying history. |

**Request (`messagesRequestToChatCompletions`)**

| Option | What it does |
| --- | --- |
| `mapReasoningEffort` | Returns the `reasoning_effort` to send, or `undefined` to omit it. |
| `disabledReasoningEffort` | Value sent for `thinking: disabled`. Default `none`. |
| `tokenLimitField` | `max_tokens` (default) or `max_completion_tokens` (required by OpenAI's GPT-5 chat models). |

**Replies and streams**

| Option | What it does |
| --- | --- |
| `toolNames` | Pass `toolNameRestoreMap(request)` so shortened tool names come back as the originals. |
| `model` | Model name to report to the client instead of the upstream's (for example a dated snapshot). |
| `reasoningReplayScope` | Responses only. Signs thinking blocks so the next request can replay them. |
| `idleTimeoutMs` | Streams only. Ends a stalled stream with a retryable error. Default 5 minutes. |
| `onAbnormalEnd` | Streams only. Called with `"stalled"` or `"truncated"`. |
| `onServiceTier` | Responses stream only. Called with each `service_tier` the upstream reports; the last one is the tier actually served. |

## Compatibility

What an Anthropic client gets when its traffic goes to an OpenAI Responses or Chat Completions model. "Chat:" marks where Chat Completions differs; otherwise both behave the same. The reverse direction is not covered here.

### Messages and prompts

- Text, JSON replies, and SSE streams.
- `system` becomes `instructions` (Chat: a leading `system` message). System-role messages inside `messages[]` are kept as system messages.
- Claude Code's mid-turn user messages (a `<system-reminder>` inside a tool result) are resent as real user messages, since other models ignore text inside tool output.
- `temperature` and `top_p` are dropped, because reasoning models reject them. Chat: passed through.
- `stop_sequences` are dropped. Chat: sent as `stop`.
- `max_tokens` becomes `max_output_tokens`. Chat: `max_tokens`, or `max_completion_tokens` via `tokenLimitField`.
- Structured output (`output_config.format` with a JSON schema) becomes `text.format`. Chat: `response_format`.

### Tools

- Tool calls and results become `function_call` / `function_call_output`, with functions sent as `strict: false`. Chat: `tool_calls` and `tool` messages.
- Parallel tool calls work, including vendors that omit the per-call `index`. Chat: the first call streams live and later calls follow it, so only one block is open at a time.
- `tool_choice`: `auto` → `auto`, `any` → `required`, `none` → `none`, `tool` → that function. Forcing a tool that isn't a function, or isn't in the list, is left out.
- `disable_parallel_tool_use` becomes `parallel_tool_calls: false` (only when tools are sent).
- A failed tool result (`is_error: true`) gets an `Error: ` prefix, unless its text already starts with `Error` or `<tool_use_error>`.
- Tool names over 64 characters are shortened to a stable hashed name everywhere. Pass `toolNames` to get the originals back.

### Images and documents

- Images: base64 becomes a data URL; URLs pass through. Responses only: `mapImageSource` can drop images.
- Images in tool results move to a follow-up user message, because tool output can't hold images.
- Documents: base64 → `input_file` with `file_data`, URL → `input_file` with `file_url`, text → text. In tool results they go inside `function_call_output.output`.
- Chat documents: base64 → a `file` part, URL → a text note (Chat `file` parts can't take a URL), text → text. In tool results they move to a follow-up user message.

### Reasoning

- Effort: `output_config.effort` goes through the effort mapper into `reasoning.effort`, with `summary: "auto"`. Without it, `thinking.budget_tokens` picks `high` (4096 or more), `medium` (2048 or more), or `low`. Chat: passed through as `reasoning_effort`, with the same budget fallback.
- Reasoning output streams as `thinking` blocks, with summary parts separated by a blank line. Chat: `reasoning_content` becomes `thinking`.
- Replay across turns: with `reasoningReplayScope`, the encrypted reasoning rides in the thinking `signature` and is replayed only under the same scope. Reasoning from another scope, or with nothing after it, is dropped. Chat: never replayed.

### Replies, usage, and stop reasons

- Usage reports input, output, and cached input tokens (as `cache_read_input_tokens`). Chat: streaming requests ask for usage with `stream_options.include_usage`.
- Stop reasons: `tool_use`, `end_turn`, `max_tokens` (Responses `incomplete`), and `refusal`. Chat: `tool_calls` → `tool_use`, `length` → `max_tokens`, `content_filter` or a refusal → `refusal`, anything else → `end_turn`.
- Refusals from the model become text with `stop_reason: "refusal"`.
- Service tier: `serviceTier` out, `onServiceTier` and `usage.speed` back. Chat: not supported.

### Errors and broken streams

- HTTP errors: the OpenAI error body becomes an Anthropic error body with a matching type, so SDKs raise the right error class.
- An error inside the stream becomes a Messages `error` event. Claude Code shows the upstream message without retrying. Chat: Claude Code retries, then shows a generic message.
- A stream that ends without finishing becomes a retryable `overloaded_error`, never a fake clean end. Chat: a stream that sent a `finish_reason` but no final usage chunk still ends normally, with zero usage.
- A stalled stream ends after `idleTimeoutMs` with a retryable `overloaded_error`. Chat: a stall after the `finish_reason` ends normally.
- If the upstream connection drops, the output stream errors; your proxy must close the client connection.
- Cancelling the output stream cancels the upstream read; your proxy must also abort the upstream request.
- Switching model or account mid-conversation keeps text and tool history. Reasoning from another scope is skipped (Chat: thinking is dropped).

### Not supported

These Anthropic features are dropped or reduced. If you depend on one, reject the request or send it to a real Anthropic backend.

- **Web search.** Mapped to OpenAI's hosted `web_search`; results are folded into the text, with no result blocks or citations. Chat: dropped.
- **Web fetch.** Dropped. Use `hasWebFetchTool(body)` to reject it up front.
- **Code execution.** Dropped.
- **Other Anthropic-defined tools without `input_schema`.** Sent as functions with an empty schema.
- **Prompt caching (`cache_control`).** Markers dropped. OpenAI caches on its own and reports it as `cache_read_input_tokens`; `cache_creation_input_tokens` is always 0.
- **Deferred tools (`defer_loading`, tool search).** Ignored; every tool is sent up front.
- **Search results, citations, and Files API documents (`source.type: "file"`).** Dropped from user turns. Search results inside tool results are sent as JSON text.
- **`redacted_thinking` and Claude-signed thinking in history.** Dropped.
- **Effort levels.** Mapped per model; reasoning depth is not guaranteed to match. Chat: passed through and the vendor decides.
- **Fast mode.** Only as `service_tier` (`flex` / `priority`). Chat: not available.
- **1M context beta, `context_management`, `anthropic-beta` headers.** Not translated; the model's own context window applies.
- **`stop_sequence` in replies.** Always `null`.
- **`metadata.user_id`.** Dropped.
- **Content-filter stops.** Responses reports any `incomplete` as `max_tokens`, including content filtering. Chat: mapped to `refusal`.

### How this is verified

Everything above is covered by unit, spec-conformance, or recorded-fixture tests. On top of that:

- **Live, through [`bench/`](bench/README.md)**: a real Claude Code tool loop in the agent container, against OpenAI `gpt-5.4-mini` / `gpt-5.4` (Responses), and OpenAI `gpt-4.1-mini` plus Fireworks `glm-5p3-flash` / `kimi-k3` (Chat). Covers text and streams, system prompts, tool calls, effort, reasoning replay, token limits, HTTP and in-stream errors, truncated and dropped streams, cancellation, and switching models mid-conversation.
- **Live, on the Platform staging proxy (2026-09-23)**: GPT-5.5 and Grok-4.5 on Responses, GLM-5.3-Flash on Fireworks Chat, and the official `@anthropic-ai/sdk`. Covers text and streams, tool calls, parallel tool calls, user images, HTTP errors, and reasoning output and replay on Responses.

Not verified:

- Structured output, stop sequences, and effort mapping against live models.
- Documents, refusals, `tool_choice: none`, `parallel_tool_calls: false`, and shortened tool names against live models. Whether each Chat vendor accepts `file` parts.
- Replaying encrypted reasoning across different accounts of the same vendor.
- That the model stops generating after a cancel. The bench proxy does abort its upstream request.
- Running the library inside the agent server process. The bench runs it in a separate Node process in the same image.

## Development

```sh
npm ci
npm run check          # typecheck + lint + tests with coverage + package smoke test
npx vitest run -u      # regenerate golden outputs after an intended change; review the diff
```

CI runs `npm run check` on Node 20, 22, and 24:

- **Spec conformance.** Every Responses-shaped output and every Chat Completions request is validated against the official [openai-openapi](https://github.com/openai/openai-openapi) spec, pinned in `test/fixtures/external/openai-openapi` (refresh with `npm run spec:sync`).
- **Official SDKs.** `@anthropic-ai/sdk` and `openai` consume our streams and error bodies; their result must match our JSON translation.
- **Recorded fixtures.** Real provider recordings from the [Vercel AI SDK](https://github.com/vercel/ai) (Apache-2.0, pinned), with golden outputs in `test/fixtures/golden`.
- **Chunk-split invariance.** Every stream gives the same output however the bytes are split, including CRLF and split multi-byte characters.
- **Coverage thresholds, lint, and a package smoke test** (pack, install the tarball, import).

A weekly `upstream-drift` workflow re-runs conformance against OpenAI's latest spec and the latest SDKs.

## License

MIT. Vendored test fixtures keep their upstream licenses; see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
