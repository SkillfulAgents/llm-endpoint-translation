# Third-party notices

The library code in `src/` is MIT (see `LICENSE`) and has no runtime dependencies. The published
package contains only `dist/`, so none of the material below is redistributed with it.

The repository vendors the following third-party material for tests only:

| Path | Source | License | Modified |
| --- | --- | --- | --- |
| `test/fixtures/external/vercel-ai/` | [vercel/ai](https://github.com/vercel/ai) @ `2fa5b6d30fc72587ad22542aee1e3dda4028a4eb`, Copyright 2023 Vercel, Inc. | Apache-2.0 (`LICENSE`, full text in `LICENSE-APACHE-2.0`) | No, byte-identical |
| `test/fixtures/external/openai-openapi/` | [openai/openai-openapi](https://github.com/openai/openai-openapi) @ `fda2733d54c35878cee469d2a7c5cfafb22914f5`, Copyright (c) OpenAI | MIT (`LICENSE`) | Yes, pruned and normalized; see its `README.md` |

Each directory carries its upstream license and a README with the exact provenance.
