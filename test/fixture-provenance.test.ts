import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const EXTERNAL = join(import.meta.dirname, "fixtures/external");
const GOLDEN = join(import.meta.dirname, "fixtures/golden");

const sources = readdirSync(EXTERNAL).filter((name) => statSync(join(EXTERNAL, name)).isDirectory());
const read = (...parts: string[]) => readFileSync(join(...parts), "utf8");

describe("third-party fixtures stay license-compliant", () => {
  it("has at least one vendored source", () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it.each(sources)("%s ships its upstream LICENSE", (source) => {
    expect(read(EXTERNAL, source, "LICENSE")).toMatch(/Apache License|MIT License/);
  });

  // Apache-2.0 §4(a): recipients get a copy of the License itself, not just the short header.
  it.each(sources)("%s includes the full Apache-2.0 text when Apache-licensed", (source) => {
    if (!read(EXTERNAL, source, "LICENSE").includes("Apache License")) return;
    const full = readdirSync(join(EXTERNAL, source)).some((file) =>
      read(EXTERNAL, source, file).includes("TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION"),
    );
    expect(full).toBe(true);
  });

  it.each(sources)("%s README pins the upstream commit and states whether files were modified", (source) => {
    const readme = read(EXTERNAL, source, "README.md");
    expect(readme).toMatch(/\b[0-9a-f]{40}\b/);
    expect(readme).toMatch(/unmodified|byte-identical|Modified/i);
  });

  it.each(sources)("%s is listed in THIRD_PARTY_NOTICES.md with the same commit", (source) => {
    const notices = read(ROOT, "THIRD_PARTY_NOTICES.md");
    const sha = read(EXTERNAL, source, "README.md").match(/\b[0-9a-f]{40}\b/)![0];
    expect(notices).toContain(`test/fixtures/external/${source}/`);
    expect(notices).toContain(sha);
  });

  it("the vendored OpenAI spec slice matches the commit its README names", () => {
    const readmeSha = read(EXTERNAL, "openai-openapi", "README.md").match(/\b[0-9a-f]{40}\b/)![0];
    const specSha = JSON.parse(read(EXTERNAL, "openai-openapi", "responses-schemas.json")).source.sha;
    expect(specSha).toBe(readmeSha);
  });
});

describe("golden files have a live test", () => {
  const goldens = readdirSync(GOLDEN, { recursive: true, encoding: "utf8" }).filter((path) =>
    /\.(messages|responses)\.(sse|json)$/.test(path),
  );

  // A golden whose source fixture was removed would silently stop being checked.
  it.each(goldens)("%s has a source fixture", (golden) => {
    const base = golden.replace(/\.(messages|responses)\.(sse|json)$/, "").replace(/\.turn\d+$/, "");
    const source = join(EXTERNAL, base);
    expect(existsSync(`${source}.chunks.txt`) || existsSync(`${source}.json`)).toBe(true);
  });
});
