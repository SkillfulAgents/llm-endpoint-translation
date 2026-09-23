# Agent-container spike

Checks that the codecs run inside the agent container's Node runtime with a real Claude Code tool loop, and measures what they cost. Not part of CI or the published package.

| Script | What it does |
| --- | --- |
| `proxy.mjs` | Messages in → Responses / Chat Completions upstream → Messages out (`BACKEND=responses\|chat\|passthrough`). `GET /__stats` reports memory/CPU. |
| `claude-loop.sh` | Real Claude Code (Bash → Read → answer) through the proxy, inside the agent container image. Needs `UPSTREAM_API_KEY`. |
| `capture.mjs` | Records one real OpenAI stream per wire (same prompt) into `captures/` (gitignored). Needs `UPSTREAM_API_KEY`. |
| `mock-upstream.mjs` | Replays the captures one SSE event every 15 ms, like a live model. |
| `load.mjs`, `idle.mjs`, `run.sh` | Concurrent-stream load and idle footprint; `run.sh` runs both in the image and writes `results/` (gitignored). |

```sh
npm run build
UPSTREAM_API_KEY=... node bench/capture.mjs
bench/run.sh
UPSTREAM_API_KEY=... bench/claude-loop.sh responses gpt-5.4-mini
UPSTREAM_API_KEY=... CHAT_OMIT_REASONING_EFFORT=1 bench/claude-loop.sh chat gpt-4.1-mini
```

## Results (2026-09-23)

Image `superagent-agent-container-base:0.5.30`: Node 22.23.2, Claude Code 2.1.280, 4 CPUs.

**Dependencies and size:** no runtime dependencies. The built `dist/*.js` is 103 KB (22 KB gzipped).

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

**Live Claude Code tool loop** (`claude-loop.sh`, real OpenAI upstream):

| Backend | Model | Result |
| --- | --- | --- |
| Responses | `gpt-5.4-mini` | Bash → Read → answer, 3 streamed turns |
| Chat Completions | `gpt-4.1-mini`, `mapReasoningEffort: () => undefined` | Bash → Read → correct answer, 3 streamed turns |

These also worked against the real Responses upstream:
- **Cancellation:** killing Claude mid-stream aborted the upstream request.
- **Error propagation:** upstream 400 messages reached Claude Code intact.
- **Isolation:** three concurrent sessions each got their own correct tool result.

## Compatibility findings

- **The Chat Completions request builder is tuned for Fireworks.** It always sends `reasoning_effort` and uses `max_tokens`. Other providers need the `mapReasoningEffort` / `tokenLimitField` options (OpenAI GPT-5 chat needs `max_completion_tokens`; non-reasoning models reject `reasoning_effort`).
- **OpenAI agent traffic belongs on Responses.** GPT-5 models on OpenAI's `/v1/chat/completions` refuse function tools with reasoning on.
- **Adapters must cap `max_tokens` per model.** Claude Code asks for 128,000 output tokens, and `gpt-4.1-mini` rejects anything above 32,768.

## Not verified

- Fireworks as the Chat Completions backend (needs a key).
- Memory with the proxy embedded in the agent server process. The runs above use a separate Node process in the same image.
- That the upstream stops generating after a cancel. The proxy does abort its upstream request.
- Connection/model switching within a conversation.
