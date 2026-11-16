// Why: lightweight coverage and enriched manifests must begin with identical text and non-text identities.
import { expect, test } from "bun:test";
import { hunkContentKey, rawHunks } from "../src/hunks.ts";
import type { DiffFile } from "../src/git-objects.ts";

test("raw hunk construction preserves text, binary and mode-only changes", () => {
  const base: DiffFile = {
    status: "modified",
    oldPath: "a.ts",
    newPath: "a.ts",
    oldMode: "100644",
    newMode: "100644",
    oldOid: "a".repeat(40),
    newOid: "b".repeat(40),
    binary: false,
    hunks: [],
  };
  const records = rawHunks([
    {
      ...base,
      hunks: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          text: "@@ -1 +1 @@\n-old\n+new\n",
          added: 1,
          deleted: 1,
        },
      ],
    },
    { ...base, oldPath: "b.bin", newPath: "b.bin", binary: true },
    { ...base, newMode: "100755" },
  ]);
  expect(records.map((record) => record.hunkId)).toEqual([
    "hef9ffa5ceaa861c",
    "h38009b91ed6147d",
    "h5385ca96ccd9f32",
  ]);
  expect(
    records.map((record) => [
      record.kind,
      record.path,
      record.oldStart,
      record.newStart,
      record.added,
      record.deleted,
      record.enclosing,
      record.query,
    ]),
  ).toEqual([
    ["text", "a.ts", 1, 1, 1, 1, null, null],
    ["binary", "b.bin", 0, 0, 0, 0, null, null],
    ["metadata", "a.ts", 0, 0, 0, 0, null, null],
  ]);
});

// Why: range-local IDs must stay stable for Records while coordinate shifts can reuse content.
test("content keys ignore coordinate and function headers but keep path and all context", () => {
  const text = "@@ -10,3 +10,4 @@ function oldName()\n ctx\n+added\n ctx\n";
  const original = { path: "source", text };
  expect(hunkContentKey(original)).toBe(
    hunkContentKey({
      path: "source",
      text: text.replace(
        "@@ -10,3 +10,4 @@ function oldName()",
        "@@ -30,3 +30,4 @@ function newName()",
      ),
    }),
  );
  expect(hunkContentKey(original)).not.toBe(
    hunkContentKey({ ...original, path: "other" }),
  );
  expect(hunkContentKey(original)).not.toBe(
    hunkContentKey({
      ...original,
      text: text.replace(" ctx", " changed context"),
    }),
  );
  expect(hunkContentKey(original)).not.toBe(
    hunkContentKey({ ...original, text: text.replace("+added", "+different") }),
  );
});

// Why: an older manifest without a stored contentKey must still distinguish non-text bytes.
test("binary fallback content identities bind blob objects", () => {
  const binary = {
    path: "asset",
    text: "Binary differs",
    kind: "binary" as const,
    oldOid: "a".repeat(40),
    newOid: "b".repeat(40),
  };
  expect(hunkContentKey(binary)).not.toBe(
    hunkContentKey({ ...binary, newOid: "c".repeat(40) }),
  );
});
