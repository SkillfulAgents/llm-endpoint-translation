# Compatibility

What an Anthropic Messages client (Claude Code, the Claude Agent SDK, `@anthropic-ai/sdk`) gets when its traffic is translated to an OpenAI Responses or Chat Completions upstream. The reverse direction (Responses client → Messages upstream) is not covered here.

Evidence column:

- **U**: unit, conformance, or recorded-fixture tests in this repo.
- **L**: live Claude Code tool loop inside the agent container image, through `bench/` (`claude-loop.sh`, `faults.sh`, `switch.sh`), against OpenAI `gpt-5.4-mini` / `gpt-5.4` (Responses), and OpenAI `gpt-4.1-mini` plus Fireworks `glm-5p3-flash` / `kimi-k3` (Chat Completions). Results in [`bench/README.md`](../bench/README.md).
- **S**: live Platform proxy on staging after the migration to this library (2026-09-23): GPT-5.5 and Grok-4.5 on Responses, GLM-5.3-Flash on Fireworks Chat Completions, plus the official `@anthropic-ai/sdk`.

## Matrix

| Feature | Responses | Chat Completions | Evidence |
| --- | --- | --- | --- |
| Text, JSON and SSE | Supported | Supported | U, L, S |
| System prompt | `system` → `instructions`. System-role messages inside `messages[]` become system input items. | `system` → leading `system` message. Same handling for system-role messages. | U, L |
| Mid-turn user steers (Claude Code `<system-reminder>` in tool results) | Re-surfaced as user input items | Re-surfaced as user messages | U |
| Tool calls and results | `function_call` / `function_call_output`; functions sent with `strict: false` | `tool_calls` / `tool` messages | U, L, S |
| Parallel tool calls | Supported | Supported, including vendors that omit the per-call `index` (told apart by position) | U, S |
| `tool_choice` | `auto` → `auto`, `any` → `required`, `none` → `none`, `tool` → forced function. Forcing a non-function or unknown tool is omitted. | Same | U |
| Tool names over 64 characters | Shortened to a stable 64-character hashed name in `tools`, history, and `tool_choice`. Pass `toolNameRestoreMap(request)` as the reply/stream `toolNames` option to get the original names back. | Same | U |
| Images in user turns | Base64 → data URL, URL passed through. Optional `mapImageSource` filter can drop images with a note. | Base64 → data URL, URL passed through. No filter hook. | U, S |
| Images in tool results | Moved to a follow-up user message | Same | U |
| Documents (`document` blocks) | Base64 → `input_file` with `file_data`, URL → `input_file` with `file_url`, text → `input_text`. In tool results they become `input_file` parts of `function_call_output.output`. | Base64 → `file` part, URL → a text note (Chat `file` parts cannot take a URL), text → text. In tool results they move to a follow-up user message. | U |
| Structured output (`output_config.format` JSON schema) | `text.format` | `response_format` | U |
| Reasoning effort | `reasoning.effort` through a per-model mapper (`mapReasoningEffort`); `summary: "auto"`. Without `output_config.effort`, `thinking.budget_tokens` maps to `high` (≥ 4096), `medium` (≥ 2048), or `low`. | `reasoning_effort` passed through, with the same `budget_tokens` fallback; `mapReasoningEffort` can rename or omit it | U, L |
| Reasoning output | Summaries stream as `thinking` blocks; summary parts are separated by a blank line, as in the JSON reply | `reasoning_content` streams as `thinking` blocks | U; S (Responses) |
| Reasoning replay across turns | With `reasoningReplayScope`, encrypted reasoning rides in the thinking `signature` and is replayed only under the same scope. Blobs from another scope, and orphans with no following item, are dropped. | Never replayed; prior thinking is dropped from history | U, L; S (Responses) |
| Sampling (`temperature`, `top_p`) | Dropped (reasoning models reject them) | Passed through | U |
| `stop_sequences` | Dropped | Sent as `stop` | U |
| Output token limit | `max_tokens` → `max_output_tokens` | `max_tokens`, or `max_completion_tokens` via `tokenLimitField` | U, L |
| Usage | Input, output, and cached input tokens (as `cache_read_input_tokens`) | Same; streaming requests ask for usage with `stream_options.include_usage` | U |
| Stop reasons | `tool_use`, `end_turn`; `incomplete` → `max_tokens`; a refusal → `refusal` | `tool_calls` → `tool_use`, `length` → `max_tokens`, `content_filter` or a refusal → `refusal`, anything else → `end_turn` | U |
| Upstream refusals | `refusal` content parts and `response.refusal.delta` become text with `stop_reason: "refusal"` | `message.refusal` / `delta.refusal` become text with `stop_reason: "refusal"` | U |
| Upstream HTTP errors | OpenAI error envelope → Anthropic error envelope with a matching type | Same | U, L, S |
| In-stream error event | `error` / `response.failed` → Messages `error` event. Claude Code shows the upstream message and does not retry. | Error chunk → Messages `error` event. Claude Code treats it as a server error, retries, then shows a generic message. | U, L |
| Truncated stream (EOF without a terminal event) | Retryable `overloaded_error`, never a fabricated `end_turn`; `onAbnormalEnd("truncated")` | Same. A missing trailing usage chunk after a `finish_reason` still ends normally, with zero usage. | U, L |
| Upstream connection drop | Output stream errors. The host must abort the client connection. | Same | U, L |
| Stalled stream | Idle timeout (`idleTimeoutMs`, default 5 min) → retryable `overloaded_error`; `onAbnormalEnd("stalled")` | Same. A stall after a `finish_reason` ends normally. | U |
| Cancellation | Cancelling the output stream cancels the upstream reader. The host must also abort its upstream request. | Same | U, L |
| Model or connection switch mid-conversation | Text and tool history carry over. Reasoning from another scope is skipped. | Text and tool history carry over. Thinking is dropped. | L |
| Service tier | `serviceTier` option out, `onServiceTier` callback and `usage.speed` echo back | Not supported | U |

## Integration contract for hosts

The codecs are pure: no network, no timers except the stream idle timeout, no credentials. Whoever runs them (the Platform proxy, an embedded proxy) owns:

- **Aborting both sides.** On client disconnect, abort the upstream request. On an output-stream error, destroy the client connection; otherwise the client waits forever. Found by `bench/faults.sh` against the bench proxy.
- **Per-provider request options**: effort mapping, token-limit field, per-model output caps (Claude Code asks for up to 128k output tokens; `gpt-4.1-mini` rejects anything above 32,768), and Codex-style removal of token-limit fields.
- **Choosing the replay scope.** Use one scope per connection (account) and model. In `bench/switch.sh`, OpenAI accepted a `gpt-5.4-mini` blob replayed to `gpt-5.4` within the same account. Replay across accounts has not been tested; the scope prevents it.

## Unavailable or not equivalent

These Anthropic features have no translation. The codec does not claim an equivalent: each one is dropped or degraded as described, so callers that depend on them must reject the request or route to a native Anthropic backend.

| Feature | Responses | Chat Completions |
| --- | --- | --- |
| Native web search (`web_search` server tool) | Mapped to OpenAI's hosted `web_search`. Results are folded into the model's text; no `web_search_tool_result` blocks or citations. | Dropped |
| Native web fetch (`web_fetch`) | Dropped. `hasWebFetchTool(body)` lets callers reject it up front. | Dropped |
| Code execution server tool | Dropped | Dropped |
| Other Anthropic-defined tool types without `input_schema` | Sent as functions with an empty schema | Same |
| Prompt caching (`cache_control`) | Markers dropped. OpenAI caches automatically, reported as `cache_read_input_tokens`; `cache_creation_input_tokens` is always 0. | Same |
| Deferred tools (`defer_loading`, tool search) | Ignored: every tool is sent up front | Same |
| Search results, citations, Files API documents (`source.type: "file"`) | Dropped from user turns. Search results inside tool results are serialized as JSON text. | Same |
| `redacted_thinking` and Claude-signed thinking in history | Dropped | Dropped |
| Effort levels | Mapped per model by the caller's mapper (for example xAI has no `none`); no guarantee of equal reasoning depth | Passed through; the vendor decides |
| Fast mode / speed | Only as OpenAI `service_tier` (`flex` / `priority`) | Not available |
| Extended context (1M beta), `context_management`, `anthropic-beta` headers | Not translated; the upstream model's own context window applies | Same |
| `stop_sequence` in replies | Always `null` | Always `null` |
| `metadata.user_id` | Dropped | Dropped |
| Content-filter stops | `incomplete` for any reason, including content filtering, reports `max_tokens` | Mapped to `refusal` |

## Not verified

- Replaying encrypted reasoning across different accounts of the same vendor.
- That an upstream stops generating after a cancel. The bench proxy does abort its upstream request.
- Structured output, stop sequences, and effort mapping against live upstreams (unit-tested only).
- Documents, refusals, `tool_choice: none`, and shortened tool names against live upstreams (unit-tested and spec-validated only). Whether each Chat Completions vendor accepts `file` parts is untested.
- The codecs embedded in the agent server process. The bench runs them in a separate Node process in the same image.
