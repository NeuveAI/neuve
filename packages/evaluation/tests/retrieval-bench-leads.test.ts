import { expect, test } from "bun:test";
import { graphHunks, type LeadHunk } from "../src/retrieval-bench/leads.ts";

// Why this test exists: the leads graph stage asks Graph under the benchmark's own store keys. A
// picked hunk's Graph state (its stored answer, or its recorded failure such as h-f0c6cf43db12's) is
// frozen in pools/dev; if the stage asked it again and the engine answered, the next dev `pools` run
// would silently rewrite pools/dev. Nothing else would notice, so picked hunks must never be asked.

const lead = (id: string, picked: boolean) =>
  ({ hunk: { id }, picked }) as unknown as LeadHunk;

test("the graph stage never asks a picked hunk", () => {
  const hunks = [lead("h-a", false), lead("h-b", true), lead("h-c", false)];
  expect(graphHunks(hunks, []).map((item) => item.hunk.id)).toEqual([
    "h-a",
    "h-c",
  ]);
});

test("--only cannot bring a picked hunk back", () => {
  const hunks = [lead("h-a", false), lead("h-b", true)];
  expect(graphHunks(hunks, ["h-b", "h-a"]).map((item) => item.hunk.id)).toEqual(
    ["h-a"],
  );
  expect(graphHunks(hunks, ["h-b"])).toEqual([]);
});
