# Vercel AI SDK recorded fixtures

Recorded vendor API traffic copied unmodified from [vercel/ai](https://github.com/vercel/ai)
at commit `2fa5b6d30fc72587ad22542aee1e3dda4028a4eb`, licensed under Apache-2.0 (see `LICENSE`).

| Directory | Source path | Wire |
|---|---|---|
| `openai/` | `packages/openai/src/responses/__fixtures__/` | OpenAI Responses |
| `xai/` | `packages/xai/src/responses/__fixtures__/` | xAI Responses |
| `anthropic/` | `packages/anthropic/src/__fixtures__/` | Anthropic Messages |

`*.chunks.txt` holds one SSE event payload (the `data:` JSON) per line. `*.json` holds a
non-streaming response body, or an error envelope for `*-error.*`.
