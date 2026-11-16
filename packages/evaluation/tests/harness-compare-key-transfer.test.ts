// Why (NEU-148): the key transfer decides what of the lanes answer key needs relabelling for the
// unit review step. A changed line read under the wrong key reads as owned by no unit, which looks
// like labels to redo when nothing moved; units must also join and split as the harness's own
// proximity rule does, or the one/several counts describe a shape that never runs.
import { expect, test } from "bun:test";
import {
  hunkLineKeys,
  labelledRanges,
  land,
  proximityTarget,
} from "../src/harness-compare/full-test/key-transfer.ts";

const hunk = (id: string, start: number, body: ReadonlyArray<string>) => ({
  hunkId: id,
  kind: "text",
  path: "a.ts",
  oldPath: "a.ts",
  newPath: "a.ts",
  oldStart: start,
  newStart: start,
  added: body.filter((row) => row.startsWith("+")).length,
  deleted: body.filter((row) => row.startsWith("-")).length,
  text: [`@@ -${start} +${start} @@`, ...body].join("\n"),
});

test("a hunk's changed lines take the keys an owner of them writes, and units join as the proximity rule does", () => {
  const first = hunk("h1", 10, [" keep", "-old", "+new", "+more", " keep"]);
  expect(hunkLineKeys(first)).toEqual([
    "a.ts:old:11",
    "a.ts:new:11",
    "a.ts:new:12",
  ]);
  // Within 20 unchanged lines the next hunk joins; past them it starts a unit of its own.
  const near = hunk("h2", 30, ["+near"]);
  const far = hunk("h3", 80, ["+far"]);
  const units = proximityTarget("b", [first, near, far]);
  expect(units.map((u) => [...u.lines])).toEqual([
    ["a.ts:old:11", "a.ts:new:11", "a.ts:new:12", "a.ts:new:30"],
    ["a.ts:new:80"],
  ]);
  // Consecutive lines of one class are one labelled range, landing in one, several or no unit.
  const ranges = labelledRanges({
    "a.ts:new:11": { class: "needs-person" },
    "a.ts:new:12": { class: "needs-person" },
    "a.ts:new:30": { class: "discussed" },
    "a.ts:new:50": { class: "discussed" },
  });
  expect(ranges.map((r) => r.lines)).toEqual([
    ["a.ts:new:30"],
    ["a.ts:new:50"],
    ["a.ts:new:11", "a.ts:new:12"],
  ]);
  expect(land(["a.ts:new:11", "a.ts:new:80"], units).landing).toBe("several");
  expect(land(["a.ts:new:50"], units)).toMatchObject({
    landing: "none",
    unowned: 1,
  });
});
