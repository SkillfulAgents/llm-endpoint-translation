import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const EXTERNAL = join(import.meta.dirname, "fixtures/external");
const GOLDEN = join(import.meta.dirname, "fixtures/golden");

const sources = readdirSync(EXTERNAL).filter((name) => statSync(join(EXTERNAL, name)).isDirectory());

describe("third-party fixtures keep their provenance", () => {
  it("has at least one vendored source", () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it.each(sources)("%s ships its upstream LICENSE", (source) => {
    const license = join(EXTERNAL, source, "LICENSE");
    expect(existsSync(license)).toBe(true);
    expect(readFileSync(license, "utf8")).toMatch(/Apache License|MIT License/);
  });

  it.each(sources)("%s pins an upstream commit", (source) => {
    const dir = join(EXTERNAL, source);
    const readme = join(dir, "README.md");
    const pinned = existsSync(readme)
      ? readFileSync(readme, "utf8")
      : JSON.stringify(JSON.parse(readFileSync(join(dir, "responses-schemas.json"), "utf8")).source);
    expect(pinned).toMatch(/\b[0-9a-f]{40}\b/);
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
