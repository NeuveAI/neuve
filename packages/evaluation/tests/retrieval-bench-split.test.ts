import { expect, test } from "bun:test";
import {
  SPLITS,
  parseSplit,
  splitCases,
} from "../src/retrieval-bench/split.ts";

// The split module is the one mapping from `--split` to the manifest split and the folder every
// split's files use (arms, queries, labelling). A wrong folder or a loose filter would silently
// read one split's pools or logs as the other's, so the mapping and refusals are pinned here.

test("each split names its manifest split and its folder", () => {
  expect(parseSplit(undefined)).toEqual({ name: "dev", folder: "dev" });
  expect(parseSplit("dev")).toBe(SPLITS.dev);
  expect(parseSplit("held-out")).toEqual({
    name: "held-out",
    folder: "heldout",
  });
});

test("an unknown or folder-spelled split is refused", () => {
  expect(() => parseSplit("heldout")).toThrow(
    "--split must be dev or held-out, not heldout",
  );
  expect(() => parseSplit("toString")).toThrow(/not toString/);
});

test("splitCases keeps only the split's cases, in order", () => {
  const cases = [
    { id: "a", split: "dev" },
    { id: "b", split: "held-out" },
    { id: "c", split: "dev" },
  ];
  expect(splitCases(cases, SPLITS.dev).map((entry) => entry.id)).toEqual([
    "a",
    "c",
  ]);
  expect(
    splitCases(cases, SPLITS["held-out"]).map((entry) => entry.id),
  ).toEqual(["b"]);
});
