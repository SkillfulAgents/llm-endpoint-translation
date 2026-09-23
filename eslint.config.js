import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "coverage/", "test/fixtures/external/", "test/fixtures/golden/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "no-empty": ["error", { allowEmptyCatch: false }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    files: ["scripts/**/*.mjs", "bench/**/*.mjs"],
    languageOptions: {
      globals: Object.fromEntries(
        [
          "console", "process", "fetch", "URL", "Buffer", "Response", "AbortController", "TextDecoder",
          "setTimeout", "setInterval", "clearInterval",
        ].map((name) => [name, "readonly"]),
      ),
    },
  },
);
