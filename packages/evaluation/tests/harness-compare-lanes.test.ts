// Why (10.109): the lanes climb counts a round only while its guard holds: no line the owner sends to
// a person may land lower. Units change shape between rounds, so the guard and agreement are kept per
// changed line across rounds; a mistake in that carry would let a round pass that dropped a line the
// owner escalated, or score agreement on lines nobody judged.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  carriedKey,
  carriedOwnerUnits,
  laneMeasures,
  rangeIdentity,
  runAgreement,
  sheetLines,
  type LaneCall,
} from "../src/harness-compare/full-test/lanes.ts";

const call = (
  unit: string,
  harness: LaneCall["harness"],
  owner: LaneCall["owner"],
  lines: Array<string>,
): LaneCall => ({
  unit,
  title: `title ${unit}`,
  range: "a..b",
  harness,
  owner,
  lines,
});

test("the guard breaks only when a unit the owner sends to a person lands wholly lower; a split goes to the owner (10.123)", () => {
  const first = laneMeasures([
    call("u1", "human-required", "human-required", [
      "a.ts:new:1",
      "a.ts:new:2",
    ]),
    call("u2", "human-required", "agentic", ["a.ts:new:3"]),
    call("u3", "agentic", null, ["b.ts:new:1"]),
  ]);
  expect(first.guard.holds).toBe(true);
  expect(first.answered).toBe(2);
  expect(first.unitAgreement?.agreement).toBe(0.5);
  expect(first.lineAgreement).toEqual({ judged: 3, agree: 2, share: 0.667 });
  expect(first.sentToPerson).toEqual({
    units: 0.667,
    lines: 0.75,
    ownerUnits: 0.5,
  });
  // A later round splits u1: one of its lines still reaches a person, the other was split off
  // lower. Per 10.123 that is for the owner's judgement, not a broken guard.
  const earlier = [
    {
      range: "a..b",
      unit: "u1",
      title: "title u1",
      lines: ["a.ts:new:1", "a.ts:new:2"],
    },
  ];
  const later = laneMeasures(
    [
      call("v1", "human-suggested", null, ["a.ts:new:1"]),
      call("v2", "human-required", null, ["a.ts:new:2"]),
      call("v3", "agentic", "agentic", ["a.ts:new:3"]),
    ],
    first.key,
    earlier,
  );
  expect(later.guard).toEqual({
    holds: true,
    lower: [],
    split: [
      {
        unit: "u1",
        title: "title u1",
        keptLines: 1,
        lowerLines: 1,
        units: [
          {
            unit: "v1",
            title: "title v1",
            harness: "human-suggested",
            lines: 1,
          },
        ],
      },
    ],
    missedLines: 1,
    unassessedLines: 0,
  });
  expect(later.lineAgreement).toEqual({ judged: 3, agree: 2, share: 0.667 });
  // None of u1's lines reach a person: a true miss, and the guard breaks.
  const lowerAll = laneMeasures(
    [call("x1", "agentic", null, ["a.ts:new:1", "a.ts:new:2"])],
    first.key,
    earlier,
  );
  expect(lowerAll.guard).toMatchObject({
    holds: false,
    lower: [{ unit: "u1", title: "title u1", lines: 2 }],
    split: [],
  });
  // A line a later adjudication cleared is no longer the owner's to send to a person.
  const cleared = laneMeasures(
    [call("x1", "agentic", null, ["a.ts:new:1", "a.ts:new:2"])],
    {
      ...first.key,
      "a..b|a.ts:new:1": "agentic",
      "a..b|a.ts:new:2": "agentic",
    },
    earlier,
  );
  expect(cleared.guard.holds).toBe(true);
  // A unit answered this round, placed wholly lower, breaks it too.
  const unit = laneMeasures([
    call("w1", "agentic", "human-required", ["c.ts:new:1"]),
  ]);
  expect(unit.guard.lower).toEqual([
    { unit: "w1", title: "title w1", lines: 1 },
  ]);
});

test("the sheet's owned-lines text reads as line keys on its side", () => {
  expect(sheetLines("packages/db/src/schema.ts (new) 4268-4271")).toEqual([
    "packages/db/src/schema.ts:new:4268",
    "packages/db/src/schema.ts:new:4269",
    "packages/db/src/schema.ts:new:4270",
    "packages/db/src/schema.ts:new:4271",
  ]);
  expect(sheetLines("a b.ts (old) 12")).toEqual(["a b.ts:old:12"]);
  expect(sheetLines("no lines here")).toEqual([]);
});

test("a range is named the same from the sheet and from a run's receipt, so the key carries between them", () => {
  expect(rangeIdentity("neuve_effect:78c53866..a22445b9")).toBe(
    rangeIdentity(
      "78c53866aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa..a22445b9bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ),
  );
  expect(rangeIdentity("no range")).toBe("no range");
});

test("two runs of a range are compared line by line, whatever units each made", () => {
  const first = [
    call("u1", "human-required", null, ["a.ts:new:1", "a.ts:new:2"]),
    call("u2", "agentic", null, ["a.ts:new:3", "a.ts:new:4"]),
  ];
  // The second run grouped differently and owns one line the first did not.
  const second = [
    call("v1", "human-required", null, ["a.ts:new:1"]),
    call("v2", "human-required", null, ["a.ts:new:2", "a.ts:new:3"]),
    call("v3", "agentic", null, ["a.ts:new:4", "a.ts:new:5"]),
  ];
  expect(runAgreement(first, second)).toMatchObject({
    lines: 4,
    onlyFirst: 0,
    onlySecond: 1,
    agreement: 0.75,
    units: { first: 2, second: 3 },
    sentToPerson: { first: 0.5, second: 0.6 },
  });
});

test("answers from several reviews make one round, each line keyed by its own range", () => {
  const other = (
    unit: string,
    lane: LaneCall["harness"],
    owner: LaneCall["owner"],
  ) => ({
    ...call(unit, lane, owner, ["a.ts:new:1"]),
    range: "c..d",
  });
  const round = laneMeasures([
    call("u1", "human-required", "human-required", ["a.ts:new:1"]),
    other("w1", "agentic", "human-required"),
  ]);
  // The same path and line in two ranges are two lines, and the second breaks the guard alone.
  expect(Object.keys(round.key).sort()).toEqual([
    "a..b|a.ts:new:1",
    "c..d|a.ts:new:1",
  ]);
  expect(round.guard).toMatchObject({ holds: false, missedLines: 1 });
  expect(round.answered).toBe(2);
});

test("a later round's answer for a line wins, by when it was written, not by its name", () => {
  const dir = mkdtempSync(join(tmpdir(), "lanes-key-"));
  try {
    const write = (name: string, writtenAt: string | undefined, lane: string) =>
      writeFileSync(
        join(dir, `${name}.json`),
        JSON.stringify({
          ...(writtenAt === undefined ? {} : { writtenAt }),
          key: { "a..b|a.ts:new:1": lane },
        }),
      );
    write("baseline", undefined, "agentic");
    write("r10", "2026-10-27T00:00:00.000Z", "human-required");
    write("r2", "2026-10-26T00:00:00.000Z", "human-suggested");
    expect(carriedKey(undefined, dir)).toEqual({
      "a..b|a.ts:new:1": "human-required",
    });
    // A round is never judged against its own earlier file.
    expect(carriedKey("r10", dir)).toEqual({
      "a..b|a.ts:new:1": "human-suggested",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a human-required lane the owner gave outside the desk is guarded like a desk answer", () => {
  const dir = mkdtempSync(join(tmpdir(), "lanes-owner-"));
  try {
    // An adjudication file as `adjudicate` writes it: the unit as an answered call, and its key.
    writeFileSync(
      join(dir, "owner-2026-10-26.json"),
      JSON.stringify({
        writtenAt: "2026-10-26T00:00:00.000Z",
        calls: [
          call("z1", "agentic", "human-required", ["d.ts:new:1", "d.ts:new:2"]),
        ],
        key: {
          "a..b|d.ts:new:1": "human-required",
          "a..b|d.ts:new:2": "human-required",
        },
      }),
    );
    const round = laneMeasures(
      [call("y1", "agentic", null, ["d.ts:new:1", "d.ts:new:2"])],
      carriedKey(undefined, dir),
      carriedOwnerUnits(undefined, dir),
    );
    expect(round.guard).toMatchObject({
      holds: false,
      lower: [{ unit: "z1", title: "title z1", lines: 2 }],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
