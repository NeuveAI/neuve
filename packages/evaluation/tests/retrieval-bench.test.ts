import { expect, test } from "bun:test";
import { chunkFile } from "../../harness/src/chunker.ts";
import {
  parseHunks,
  realShare,
  selectHunks,
} from "../src/retrieval-bench/hunks.ts";

// Why: a chunker that drops, duplicates or oversizes lines silently lowers every arm's coverage of
// gold regions, and nothing downstream would notice. This pins contiguous, non-overlapping chunks
// of at most 4 KiB that cover every non-blank line, through descent into an oversized class and the
// window fallback inside an oversized function with no statement list.
test("chunks cover every non-blank line exactly once and stay within 4 KiB", () => {
  const method = (index: number) =>
    `  /** Method ${index}. */\n  method${index}(value: number) {\n${"    value += 1;\n".repeat(12)}    return value;\n  }\n`;
  const source = [
    "// header comment",
    'import { a } from "a";',
    'import { b } from "b";',
    "",
    "/** A small constant. */",
    "export const small = 1;",
    "",
    `export class Big {\n${Array.from({ length: 40 }, (_, index) => method(index)).join("\n")}}`,
    "",
    `export const text = \`\n${"a line of template text that never parses into statements\n".repeat(120)}\`;`,
    "// trailing comment",
    "",
  ].join("\n");
  const markdown = `# Title\n\nIntro\n\n## Part\n\n\`\`\`ts\n# not a heading\n\`\`\`\n\n### Deeper\n\ntext\n`;
  for (const [path, text, capability] of [
    ["src/big.ts", source, "utf8-line-window-4k-v2"],
    ["docs/plan.md", markdown, "markdown-sections"],
  ] as const) {
    const chunked = chunkFile(path, text, { kind: "unavailable" });
    expect(chunked.capability).toBe(capability);
    const lines = text.split("\n");
    const seen = new Array<number>(lines.length + 1).fill(0);
    for (const chunk of chunked.chunks) {
      expect(
        Buffer.byteLength(
          text
            .split(/(?<=\n)/)
            .slice(chunk.startLine - 1, chunk.endLine)
            .join(""),
        ),
      ).toBeLessThanOrEqual(4096);
      for (let line = chunk.startLine; line <= chunk.endLine; line++)
        seen[line] = (seen[line] ?? 0) + 1;
    }
    lines.forEach((line, index) => {
      if (line.trim() !== "")
        expect(`${path}:${index + 1}:${seen[index + 1]}`).toBe(
          `${path}:${index + 1}:1`,
        );
    });
    expect(Math.max(...seen)).toBe(1);
  }
  const markdownSections = chunkFile("docs/plan.md", markdown, {
    kind: "unavailable",
  }).chunks.map((chunk) => chunk.symbol);
  expect(markdownSections).toEqual(["Title", "Part", "Deeper"]);
});

// Why: the hunk counts and the 9.17 share formula feed every hunk's measured allowance; a parse that
// loses a rename or miscounts lines shifts shares silently.
test("hunks keep renames, spread across files, and get the 9.17 real share with the 9.23 minimum", () => {
  const diff = [
    "diff --git a/src/old.ts b/src/new.ts",
    "similarity index 90%",
    "rename from src/old.ts",
    "rename to src/new.ts",
    "--- a/src/old.ts",
    "+++ b/src/new.ts",
    "@@ -1,3 +1,4 @@",
    " keep",
    "-gone",
    "+came",
    "+also",
    " keep",
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -10 +10 @@ export const a",
    "-x",
    "+y",
    "@@ -40,2 +40,0 @@",
    "-p",
    "-q",
    "diff --git a/src/b.ts b/src/b.ts",
    "deleted file mode 100644",
    "--- a/src/b.ts",
    "+++ /dev/null",
    "@@ -1,5 +0,0 @@",
    ...Array.from({ length: 5 }, () => "-line"),
  ].join("\n");
  const hunks = parseHunks(diff);
  expect(
    hunks.map((hunk) => [hunk.oldPath, hunk.path, hunk.added, hunk.deleted]),
  ).toEqual([
    ["src/old.ts", "src/new.ts", 2, 1],
    ["src/a.ts", "src/a.ts", 1, 1],
    ["src/a.ts", "src/a.ts", 0, 2],
    ["src/b.ts", "src/b.ts", 0, 5],
  ]);
  // One hunk per file first (largest file first, its largest hunk first), then round-robin.
  expect(
    selectHunks(hunks).map((hunk) => `${hunk.path}:${hunk.oldStart}`),
  ).toEqual(["src/a.ts:10", "src/a.ts:40", "src/b.ts:1", "src/new.ts:1"]);
  expect(realShare(10, 200)).toEqual({ opus: 25_000, sol: 11_875 });
  // 9.23: the 4,000-token minimum applies after the 9.17 share.
  expect(realShare(1, 1000)).toEqual({ opus: 4_000, sol: 4_000 });
});
