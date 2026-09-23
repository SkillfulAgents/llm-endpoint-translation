# Vercel AI SDK recorded fixtures

Recorded vendor API traffic copied unmodified from [vercel/ai](https://github.com/vercel/ai)
at commit `2fa5b6d30fc72587ad22542aee1e3dda4028a4eb`, Copyright 2023 Vercel, Inc., licensed under
the Apache License, Version 2.0. `LICENSE` is the upstream notice verbatim; `LICENSE-APACHE-2.0` is
the full license text. Every file is byte-identical to upstream (no modifications), and upstream
ships no `NOTICE` file.

| Directory | Source path | Wire |
|---|---|---|
| `openai/` | `packages/openai/src/responses/__fixtures__/` | OpenAI Responses |
| `xai/` | `packages/xai/src/responses/__fixtures__/` | xAI Responses |
| `anthropic/` | `packages/anthropic/src/__fixtures__/` | Anthropic Messages |
| `chat-completions/openai/` | `packages/openai/src/chat/__fixtures__/` | OpenAI Chat Completions |
| `chat-completions/deepseek/` | `packages/deepseek/src/chat/__fixtures__/` | DeepSeek Chat Completions |
| `chat-completions/groq/` | `packages/groq/src/__fixtures__/` | Groq Chat Completions |
| `chat-completions/moonshotai/` | `packages/moonshotai/src/__fixtures__/` | Moonshot AI Chat Completions |
| `chat-completions/mistral/` | `packages/mistral/src/__fixtures__/` | Mistral Chat Completions |
| `chat-completions/openai-compatible/` | `packages/openai-compatible/src/chat/__fixtures__/` | OpenAI-compatible Chat Completions |

`*.chunks.txt` holds one SSE event payload (the `data:` JSON) per line. `*.json` holds a
non-streaming response body, or an error envelope for `*-error.*`.
