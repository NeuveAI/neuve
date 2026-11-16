import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Reason: the recorder's metadata and exclusive-write imports must not permit credential content reads.
test("credential boundary: production sources never read folders or call endpoints", () => {
  const root = join(import.meta.dir, "../src");
  const forbidden =
    /readFile|readdir|opendir|Bun\.file|node:fs|fs\/promises|\bFileSystem\b|\.credentials|projects\/|settings\.json|fetch\s*\(/;
  for (const entry of readdirSync(root, {
    recursive: true,
    encoding: "utf8",
  })) {
    if (entry.endsWith(".ts")) {
      const source = readFileSync(join(root, entry), "utf8");
      // The fixture writer may inspect destination metadata and write exclusively; content reads stay forbidden.
      const checked =
        entry === "smoke-fixture-recorder.ts"
          ? source.replace(
              'from "node:fs/promises"',
              'from "fixture-destination"',
            )
          : source;
      expect(checked).not.toMatch(forbidden);
      if (entry === "smoke-fixture-recorder.ts")
        expect(
          source.match(/import \{[^}]+\} from "node:fs\/promises";/)?.[0],
        ).toBe(
          'import { constants, open, lstat, unlink } from "node:fs/promises";',
        );
    }
  }
});

test("SDK boundary: only the production layer imports Agent SDK runtime values", () => {
  const root = join(import.meta.dir, "../src");
  for (const entry of readdirSync(root, { encoding: "utf8" })) {
    if (!entry.endsWith(".ts") || entry === "production.ts") continue;
    const source = readFileSync(join(root, entry), "utf8");
    expect(
      source.replace(
        /import type[\s\S]*?from\s+["']@anthropic-ai\/claude-agent-sdk["'];/g,
        "",
      ),
    ).not.toMatch(/from\s+["']@anthropic-ai\/claude-agent-sdk["']/);
  }
});
