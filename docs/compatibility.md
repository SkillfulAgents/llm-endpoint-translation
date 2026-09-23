# Compatibility

What an Anthropic Messages client (Claude Code, the Claude Agent SDK, `@anthropic-ai/sdk`) gets when its traffic is translated to an OpenAI Responses or Chat Completions upstream. The reverse direction (Responses client → Messages upstream) is not covered here.

Evidence column:

- **U**: unit, conformance, or recorded-fixture tests in this repo.
- **L**: live Claude Code tool loop inside the agent container image, through `bench/` (`claude-loop.sh`, `faults.sh`, `switch.sh`), against OpenAI `gpt-5.4-mini` / `gpt-5.4` (Responses) and `gpt-4.1-mini` (Chat Completions). Results in [`bench/README.md`](../bench/README.md).
- **S**: live Platform proxy on staging after the migration to this library (2026-09-23): GPT-5.5 and Grok-4.5 on Responses, GLM-5.3-Flash on Fireworks Chat Completions, plus the official `@anthropic-ai/sdk`.

## Matrix

| Feature | Responses | Chat Completions | Evidence |
| --- | --- | --- | --- |
| Text, JSON and SSE | Supported | Supported | U, L, S |
| System prompt | `system` → `instructions`. System-role messages inside `messages[]` become system input items. | `system` → leading `system` message. Same handling for system-role messages. | U, L |
| Mid-turn user steers (Claude Code `<system-reminder>` in tool results) | Re-surfaced as user input items | Re-surfaced as user messages | U |
| Tool calls and results | `function_call` / `function_call_output`; functions sent with `strict: false` | `tool_calls` / `tool` messages | U, L, S |
| Parallel tool calls | Supported | Supported, including vendors that omit the per-call `index` (told apart by position) | U, S |
| `tool_choice` | `auto` → `auto`, `any` → `required`, `tool` → forced function. Forcing a non-function or unknown tool is omitted. | Same | U |
| Images in user turns | Base64 → data URL, URL passed through. Optional `mapImageSource` filter can drop images with a note. | Base64 → data URL, URL passed through. No filter hook. | U, S |
| Images in tool results | Moved to a follow-up user message (tool output is text-only) | Same | U |
| Structured output (`output_config.format` JSON schema) | `text.format` | `response_format` | U |
| Reasoning effort | `reasoning.effort` through a per-model mapper (`mapReasoningEffort`); `summary: "auto"` | `reasoning_effort` passed through; `mapReasoningEffort` can rename or omit it | U, L |
| Reasoning output | Summaries stream as `thinking` blocks | `reasoning_content` streams as `thinking` blocks | U; S (Responses) |
| Reasoning replay across turns | With `reasoningReplayScope`, encrypted reasoning rides in the thinking `signature` and is replayed only under the same scope. Blobs from another scope, and orphans with no following item, are dropped. | Never replayed; prior thinking is dropped from history | U, L; S (Responses) |
| Sampling (`temperature`, `top_p`) | Dropped (reasoning models reject them) | Passed through | U |
| `stop_sequences` | Dropped | Sent as `stop` | U |
| Output token limit | `max_tokens` → `max_output_tokens` | `max_tokens`, or `max_completion_tokens` via `tokenLimitField` | U, L |
| Usage | Input, output, and cached input tokens (as `cache_read_input_tokens`) | Same; streaming requests ask for usage with `stream_options.include_usage` | U |
| Stop reasons | `tool_use`, `end_turn`; `incomplete` → `max_tokens` | `tool_calls` → `tool_use`, `length` → `max_tokens`, anything else → `end_turn` | U |
| Upstream HTTP errors | OpenAI error envelope → Anthropic error envelope with a matching type | Same | U, L, S |
| In-stream error event | `error` / `response.failed` → Messages `error` event. Claude Code shows the upstream message and does not retry. | Error chunk → Messages `error` event. Claude Code treats it as a server error, retries, then shows a generic message. | U, L |
| Truncated stream (EOF without a terminal event) | Retryable `overloaded_error`, never a fabricated `end_turn` | Same. A missing trailing usage chunk after a `finish_reason` still ends normally, with zero usage. | U, L |
| Upstream connection drop | Output stream errors. The host must abort the client connection. | Same | U, L |
| Stalled stream | Idle timeout (default 5 min) → retryable `overloaded_error` | **No idle timeout.** The host must enforce one. | U |
| Cancellation | Cancelling the output stream cancels the upstream reader. The host must also abort its upstream request. | Same | U, L |
| Model or connection switch mid-conversation | Text and tool history carry over. Reasoning from another scope is skipped. | Text and tool history carry over. Thinking is dropped. | L |
| Service tier | `serviceTier` option out, `onServiceTier` callback and `usage.speed` echo back | Not supported | U |

## Integration contract for hosts

The codecs are pure: no network, no timers except the Responses idle timeout, no credentials. Whoever runs them (the Platform proxy, an embedded proxy) owns:

- **Aborting both sides.** On client disconnect, abort the upstream request. On an output-stream error, destroy the client connection; otherwise the client waits forever. Found by `bench/faults.sh` against the bench proxy.
- **A stall timeout for Chat Completions streams.**
- **Per-provider request options**: effort mapping, token-limit field, per-model output caps (Claude Code asks for up to 128k output tokens; `gpt-4.1-mini` rejects anything above 32,768), and Codex-style removal of token-limit fields.
- **Choosing the replay scope.** Use one scope per connection (account) and model. In `bench/switch.sh`, OpenAI accepted a `gpt-5.4-mini` blob replayed to `gpt-5.4` within the same account. Replay across accounts has not been tested; the scope prevents it.

## Unavailable or not equivalent

These Anthropic features have no translation. The codec does not claim an equivalent: each one is dropped or degraded as described, so callers that depend on them must reject the request or route to a native Anthropic backend.

| Feature | Responses | Chat Completions |
| --- | --- | --- |
| Native web search (`web_search` server tool) | Mapped to OpenAI's hosted `web_search`. Results are folded into the model's text; no `web_search_tool_result` blocks or citations. | Dropped |
| Native web fetch (`web_fetch`) | Dropped. `hasWebFetchTool(body)` lets callers reject it up front. | Dropped |
| Code execution server tool | **Not recognized**: sent as a client function named `code_execution` with an empty schema | Dropped |
| Other Anthropic-defined tool types without `input_schema` | Sent as functions with an empty schema | Same |
| Prompt caching (`cache_control`) | Markers dropped. OpenAI caches automatically, reported as `cache_read_input_tokens`; `cache_creation_input_tokens` is always 0. | Same |
| Deferred tools (`defer_loading`, tool search) | Ignored: every tool is sent up front | Same |
| Documents and PDFs (`document` blocks), search results, citations | Dropped from user turns. Inside tool results they are serialized as JSON text. | Same |
| `redacted_thinking` and Claude-signed thinking in history | Dropped | Dropped |
| Effort levels | Mapped per model by the caller's mapper (for example xAI has no `none`); no guarantee of equal reasoning depth | Passed through; the vendor decides |
| Fast mode / speed | Only as OpenAI `service_tier` (`flex` / `priority`) | Not available |
| Extended context (1M beta), `context_management`, `anthropic-beta` headers | Not translated; the upstream model's own context window applies | Same |
| `stop_sequence` in replies | Always `null` | Always `null` |
| `metadata.user_id` | Dropped | Dropped |
| Upstream refusals | Responses `refusal` content parts are not mapped to text | Not handled specially |
| Content-filter stops | `incomplete` for any reason, including content filtering, reports `max_tokens` | `content_filter` reports `end_turn` |

## Not verified

- Fireworks Chat Completions through Claude Code in the container (Platform staging covers Fireworks through `@anthropic-ai/sdk`).
- Replaying encrypted reasoning across different accounts of the same vendor.
- That an upstream stops generating after a cancel. The bench proxy does abort its upstream request.
- Structured output, stop sequences, and effort mapping against live upstreams (unit-tested only).
- The codecs embedded in the agent server process. The bench runs them in a separate Node process in the same image.
