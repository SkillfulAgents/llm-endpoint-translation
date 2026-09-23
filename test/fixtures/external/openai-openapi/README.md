# OpenAI OpenAPI spec (Responses slice)

Derived from `openapi.json` in [openai/openai-openapi](https://github.com/openai/openai-openapi) at commit
`fda2733d54c35878cee469d2a7c5cfafb22914f5`, Copyright (c) OpenAI, MIT License (see `LICENSE`).

**Modified** by `scripts/sync-openai-spec.mjs`; not a verbatim copy:

- Only `components.schemas` reachable from `Response`, `CreateResponse`, `ResponseStreamEvent`, `ErrorResponse` are kept.
- OpenAPI `nullable: true` is rewritten to JSON Schema (`type: [T, "null"]` or `anyOf` with `null`).
- `oneOf` is rewritten to `anyOf` (the spec's unions overlap).
- `example` / `examples` keywords are dropped.

Used only by the conformance tests; not shipped in the package.
