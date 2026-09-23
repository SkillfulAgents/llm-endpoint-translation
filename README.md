# llm-endpoint-translation

Pure, dependency-free translation between the **Anthropic Messages API** and the **OpenAI Responses API** (both directions), and from Messages to **OpenAI-compatible Chat Completions** upstreams: requests, JSON replies, SSE streams, and errors. No server, no keys, no network — bring your own transport.

| Direction | Request | Reply | Stream | Error |
| --- | --- | --- | --- | --- |
| Messages client → Responses upstream | `messagesRequestToResponses` | `responsesResponseToMessages` | `responsesStreamToMessagesStream` | `responsesErrorToMessagesError` |
| Responses client → Messages upstream | `responsesRequestToMessages` | `messagesResponseToResponses` | `messagesStreamToResponsesStream` | `messagesErrorToResponsesError` |
| Messages client → Chat Completions upstream | `messagesRequestToChatCompletions` | `chatCompletionsResponseToMessages` | `chatCompletionsStreamToMessagesStream` | `responsesErrorToMessagesError` (same OpenAI error envelope) |

Streams are Web Streams (`ReadableStream<Uint8Array>` of SSE bytes in, SSE bytes out) and work on Node 20+, Deno, Bun, and edge runtimes.
## Install

Not published to the npm registry. Each [GitHub Release](https://github.com/SkillfulAgents/llm-endpoint-translation/releases) ships a package tarball; depend on its URL (pnpm and npm pin its integrity hash in the lockfile):

```sh
pnpm add https://github.com/SkillfulAgents/llm-endpoint-translation/releases/download/v0.1.0/llm-endpoint-translation-0.1.0.tgz
```

To upgrade, point the URL at the new release and reinstall.

```ts
import { messagesRequestToResponses, responsesStreamToMessagesStream } from "llm-endpoint-translation";

const { body } = messagesRequestToResponses(anthropicRequest);
const upstream = await fetch("https://api.openai.com/v1/responses", {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
  body: JSON.stringify({ ...body, stream: true }),
});
return new Response(responsesStreamToMessagesStream(upstream.body!), {
  headers: { "content-type": "text/event-stream" },
});
```

Unsupported input (e.g. stateful `previous_response_id`) throws `TranslationError` with an OpenAI-style `code`.

## Compatibility

What translates, what doesn't, and what a host must handle itself: [`docs/compatibility.md`](docs/compatibility.md).

## Testing

CI is the core of this repo. Every push runs, on Node 20/22/24:

- **Spec conformance** — every Responses-shaped output and every Chat Completions request is validated with ajv against the official [openai-openapi](https://github.com/openai/openai-openapi) spec, pinned in `test/fixtures/external/openai-openapi` (refresh with `npm run spec:sync`).
- **Official SDK consumers** — `@anthropic-ai/sdk` and `openai` consume our streams and error bodies through a custom `fetch`; their accumulated result must equal our JSON translation.
- **Recorded fixtures** — real provider recordings from the [Vercel AI SDK](https://github.com/vercel/ai) (Apache-2.0, pinned) with golden outputs under `test/fixtures/golden`.
- **Chunk-split invariance** — every stream yields identical output for any byte split, CRLF, and split multi-byte UTF-8.
- **Coverage thresholds, lint, and a package smoke test** (pack → install tarball → import).

A weekly `upstream-drift` workflow re-runs conformance against OpenAI's latest spec and the latest SDKs.

```sh
npm ci
npm run check          # typecheck + lint + tests with coverage + package smoke
npx vitest run -u      # regenerate goldens after an intended output change; review the diff
```

## License

MIT. Vendored test fixtures keep their upstream licenses; see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
