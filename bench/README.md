# Agent-container spike

Checks that the codecs run inside the agent container's Node runtime with a real Claude Code tool loop, and measures what they cost. Not part of CI or the published package.

| Script | What it does |
| --- | --- |
| `proxy.mjs` | Messages in → Responses / Chat Completions upstream → Messages out (`BACKEND=responses\|chat\|passthrough`). `GET /__stats` reports memory/CPU. |
| `claude-loop.sh` | Real Claude Code (Bash → Read → answer) through the proxy, inside the agent container image. Needs `UPSTREAM_API_KEY`. |
| `capture.mjs` | Records one real OpenAI stream per wire (same prompt) into `captures/` (gitignored). Needs `UPSTREAM_API_KEY`. |
| `mock-upstream.mjs` | Replays the captures one SSE event every 15 ms, like a live model. `MOCK_FAULT=truncate\|drop\|error` breaks the stream halfway. |
| `load.mjs`, `idle.mjs`, `run.sh` | Concurrent-stream load and idle footprint; `run.sh` runs both in the image and writes `results/` (gitignored). |
| `faults.sh` | Claude Code against mock faults (truncate, dropped connection, in-stream error), plus live cancel and live upstream error when `UPSTREAM_API_KEY` is set. |
| `switch.sh` | One Claude Code conversation resumed across Responses → Chat Completions → another model → back. Needs `UPSTREAM_API_KEY`. |
| `image-size.sh` | Image size delta from installing a release tarball into the agent image. |

```sh
npm run build
UPSTREAM_API_KEY=... node bench/capture.mjs
bench/run.sh
UPSTREAM_API_KEY=... bench/claude-loop.sh responses gpt-5.4-mini
UPSTREAM_API_KEY=... CHAT_OMIT_REASONING_EFFORT=1 bench/claude-loop.sh chat gpt-4.1-mini
UPSTREAM_API_KEY=... bench/faults.sh responses gpt-5.4-mini
UPSTREAM_API_KEY=... CHAT_OMIT_REASONING_EFFORT=1 bench/faults.sh chat gpt-4.1-mini
UPSTREAM_API_KEY=... bench/switch.sh gpt-5.4-mini gpt-5.4 gpt-4.1-mini
bench/image-size.sh
```

## Results (2026-09-23)

Image `superagent-agent-container-base:0.5.30`: Node 22.23.2, Claude Code 2.1.280, 4 CPUs.

**Dependencies and size:** no runtime dependencies. The built `dist/*.js` is 103 KB (22 KB gzipped). Installing the v0.1.0 release tarball into the image adds 113 KB to the image (`image-size.sh`); the installed package is 249 KB on disk.

**Idle footprint** (fresh Node process, RSS after GC, median of 3):

| | RSS | Heap | Import time |
| --- | --- | --- | --- |
| Node + `http` server | 52.6 MB | 5.9 MB | – |
| + library imported | 53.2 MB | 6.3 MB | 14 ms |

So the library adds 0.6 MB RSS at idle. Idle CPU was the same with and without it.

**Concurrent streams.** Each stream replays about 900 events (a ~600-word answer plus a tool call) for 30 s; `passthrough` is the same proxy with no translation.

| Streams | Backend | Peak RSS | Peak heap | Proxy CPU (% of one core) |
| --- | --- | --- | --- | --- |
| 10 | passthrough | 91.7 MB | 12.1 MB | 9.9 |
| 10 | responses | 87.8 MB | 14.9 MB | 12.1 |
| 10 | chat | 94.1 MB | 13.4 MB | 11.1 |
| 50 | passthrough | 112.2 MB | 23.5 MB | 17.2 |
| 50 | responses | 122.1 MB | 26.5 MB | 19.2 |
| 50 | chat | 118.7 MB | 26.2 MB | 18.8 |

All 360 streams completed, and throughput matched across backends. At 50 streams, translation adds about 2 CPU percentage points and 6–10 MB peak RSS over passthrough. The ~30 MB jump from idle on the first request is Node's `fetch` warming up; passthrough shows it too.

**Live Claude Code tool loop** (`claude-loop.sh`):

| Backend | Upstream and model | Result |
| --- | --- | --- |
| Responses | OpenAI `gpt-5.4-mini` | Bash → Read → answer, 3 streamed turns |
| Chat Completions | OpenAI `gpt-4.1-mini`, `mapReasoningEffort: () => undefined` | Bash → Read → correct answer, 3 streamed turns |
| Chat Completions | Fireworks `glm-5p3-flash`, default options | Bash → Read → correct answer, 3 streamed turns |
| Chat Completions | Fireworks `kimi-k3`, default options | Bash → Read → correct answer, 3 streamed turns |

These also worked against the real Responses upstream:
- **Cancellation:** killing Claude mid-stream aborted the upstream request.
- **Error propagation:** upstream 400 messages reached Claude Code intact.
- **Isolation:** three concurrent sessions each got their own correct tool result.

**Faults** (`faults.sh`, `CLAUDE_CODE_MAX_RETRIES=1`):

| Case | Responses | Chat Completions |
| --- | --- | --- |
| Clean EOF halfway (mock) | Retried, then `Server error mid-response` | Same |
| Connection dropped halfway (mock) | Retried, then `502 terminated` | Same |
| In-stream error event (mock) | Upstream message shown, no retry | Retried, then generic `Server error mid-response` |
| Kill Claude mid-stream (live) | Upstream request aborted after 83 deltas | Aborted after 66 deltas (OpenAI) and 64 deltas (Fireworks `glm-5p3-flash`) |
| Upstream 404 unknown model (live) | Claude Code reports a model error | Same, on OpenAI and Fireworks |

The dropped-connection case first hung Claude Code until timeout: the codecs error the output stream on an upstream read failure, and the bench proxy did not destroy the client connection. The proxy now does; any host must do the same.

**Switching within one conversation** (`switch.sh`, each step resumes the same Claude Code session):

| Step | Backend and model | Reasoning replayed | Result |
| --- | --- | --- | --- |
| 1 | Responses `gpt-5.4-mini` (scope A) | 1 per follow-up request | Bash → Read → token |
| 2 | Chat Completions `gpt-4.1-mini` | Thinking dropped | Correct token, no tools |
| 3 | Responses `gpt-5.4` (scope B) | 0 from scope A, then its own | Bash → byte count and token |
| 4 | Responses `gpt-5.4` with scope A (control) | 1 blob from `gpt-5.4-mini` | Accepted by OpenAI, correct token |
| 5 | Responses `gpt-5.4-mini` (scope A) | 2 | Correct token |

Text and tool history survive every hop, and scope isolation works as designed. Step 4 shows OpenAI accepts another model's reasoning within the same account, so the scope matters for cross-account replay, which this run could not test (one key).

Full feature matrix and unavailable features: [Compatibility in the README](../README.md#compatibility).

## Compatibility findings

- **The Chat Completions request builder is tuned for Fireworks.** It always sends `reasoning_effort` and uses `max_tokens`. Other providers need the `mapReasoningEffort` / `tokenLimitField` options (OpenAI GPT-5 chat needs `max_completion_tokens`; non-reasoning models reject `reasoning_effort`).
- **OpenAI agent traffic belongs on Responses.** GPT-5 models on OpenAI's `/v1/chat/completions` refuse function tools with reasoning on.
- **Adapters must cap `max_tokens` per model.** Claude Code asks for 128,000 output tokens, and `gpt-4.1-mini` rejects anything above 32,768.

## Not verified

- Memory with the proxy embedded in the agent server process. The runs above use a separate Node process in the same image.
- That the upstream stops generating after a cancel. The proxy does abort its upstream request.
- Reasoning replay across different accounts.
