// Why (NEU-148): units change record shape (`unit.recorded@3`, `assessment.recorded@4`,
// `packet.published@2`). A reader that meets a kind it was not written for drops the unit's lines or
// its assessment without a word, and every measure that counts only judged lines then passes: a
// run of a newer shape would score as "nothing assessed". The guard must refuse each such case, and
// must not refuse today's shapes (an unassessed unit included), or every existing eval stops. Every
// path that turns a stored run into units goes through it; the enumeration below fails when one
// does not, the paths with no rule-3 reader must still refuse the sections shape, and the source
// check fails when any reader reaches a packet's batches other than through the guard.
import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  packetTarget,
  runTarget,
} from "../src/harness-compare/full-test/key-transfer.ts";
import {
  freezeEvalSet,
  harnessRule,
  loadEvalSet,
  noiseFloor,
  ownerRunUnits,
  recompute,
  recordedUnits,
  writeEvalSet,
  type LoadedCase,
} from "../src/harness-compare/full-test/lanes-eval.ts";
import { deskCalls, shownRun } from "../src/harness-compare/full-test/lanes.ts";
import {
  readReplayRun,
  replayCalls,
} from "../src/harness-compare/full-test/lanes-replay.ts";
import {
  caughtDefect,
  hunkViews,
  packetBatches,
  packetUnits,
  READ_KINDS,
  readablePacket,
  READS_SECTIONS,
  readShownFile,
  unreadableParts,
  UnreadableRun,
  type PacketLite,
  type StoredRun,
} from "../src/harness-compare/full-test/packets.ts";
import { runState } from "../src/harness-compare/full-test/parity.ts";
import { pairRuns } from "../src/harness-compare/full-test/titles-compare.ts";
import type { PlantedRecord } from "../src/harness-compare/full-test/planted-light.ts";
import { replayRuns } from "../src/harness-compare/full-test/replay-runs.ts";
import {
  positionEffect,
  scorePlant,
} from "../src/harness-compare/full-test/unit-review-score.ts";

const assessed = {
  lane: "agentic",
  quadrant: "low-easy",
  complexity: { level: "low", factors: [] },
  easeOfValidation: {
    level: "easy",
    requirements: [{ cites: [], coverage: "missing", requirement: "r" }],
  },
  movement: [],
  gaps: [],
  rationale: "r",
};

/** One unit of today's shapes: `unit.recorded@2`, `assessment.recorded@3`, a comment, a disposition, a reference. */
const unit = (id: string, overrides: Record<string, unknown> = {}) => ({
  unitId: id,
  local: `b1.${id}`,
  recorded: {
    kind: "unit.recorded@2",
    payload: {
      title: id,
      ownedRanges: [
        { kind: "lines", path: "a.ts", side: "new", startLine: 1, endLine: 2 },
      ],
    },
  },
  assessment: {
    id: `a-${id}`,
    kind: "assessment.recorded@3",
    payload: assessed,
  },
  content: {},
  references: [
    {
      id: `r-${id}`,
      kind: "context.referenced@2",
      payload: { provenance: { kind: "git" } },
    },
  ],
  comments: [
    { id: `c-${id}`, kind: "comment.recorded@2", payload: { body: "b" } },
  ],
  disposition: {
    id: `d-${id}`,
    kind: "disposition.recorded@2",
    payload: { verdict: "approve", restsOn: [], proof: [] },
  },
  ...overrides,
});

const packetOf = (
  units: ReadonlyArray<unknown>,
  extra: Record<string, unknown> = {},
) =>
  ({
    complete: true,
    gaps: [],
    undecoded: [],
    batches: [{ batchId: "B1", recorded: { kind: "batch.recorded@1" }, units }],
    ...extra,
  }) as unknown as PacketLite;

/** A unit of the new shape, as a producer passing `unit.recorded@3` through would show it. */
const newShape = () =>
  packetOf([
    unit("u1", {
      recorded: { kind: "unit.recorded@3", payload: { title: "u1" } },
    }),
  ]);

/** A unit of a kind no path reads, not even the sections shape's readers. */
const unreadShape = () =>
  packetOf([
    unit("u1", {
      recorded: {
        kind: "unit.recorded@9",
        payload: { title: "u1", ownedRanges: [] },
      },
    }),
  ]);

test("the guard reads today's shapes: every kind it states, an unassessed unit, carried records and content that did not decode", () => {
  const today = packetOf(
    [
      unit("u1"),
      // No assessment at all: unassessed, counted apart as now.
      unit("u2", { assessment: undefined, disposition: undefined }),
      unit("u3", {
        assessment: {
          id: "a3",
          kind: "assessment.recorded@2",
          payload: { ...assessed, laneRule: 2 },
        },
        comments: [{ id: "c3", kind: "comment.carried@1", payload: {} }],
        disposition: { id: "d3", kind: "disposition.carried@1", payload: {} },
      }),
    ],
    {
      undecoded: [
        { what: "facts of b1.u2", part: "facts", unit: "b1.u2" },
        { what: "assembled batch of b1", part: "assembled-batch" },
      ],
    },
  );
  expect(unreadableParts(today)).toEqual([]);
  expect(readablePacket(today, "case c")).toBe(today);
  expect(unreadableParts(null)).toEqual([]);
  expect(unreadableParts(undefined)).toEqual([]);
  // Today's packet shows no kind; where it does, the one it is written for reads.
  expect(
    unreadableParts({ ...today, kind: "packet.published@1" } as PacketLite),
  ).toEqual([]);
  expect(READ_KINDS.assessment).toEqual([
    "assessment.recorded@2",
    "assessment.recorded@3",
  ]);
  // The unassessed unit keeps no lane and is not refused.
  expect(recordedUnits(today).map((entry) => entry.recorded === null)).toEqual([
    false,
    true,
    false,
  ]);
});

test("the guard refuses each kind it has no reader for and each shape that would drop a unit silently, naming the case, unit and kind", () => {
  const refused = (packet: PacketLite, pattern: RegExp) => {
    expect(unreadableParts(packet).some((p) => pattern.test(p))).toBe(true);
    expect(() => readablePacket(packet, "case github:x/y:1")).toThrow(
      UnreadableRun,
    );
    expect(() => readablePacket(packet, "case github:x/y:1")).toThrow(
      /^case github:x\/y:1 cannot be read by the eval: /,
    );
  };
  refused(newShape(), /unit u1 \(b1\.u1\)'s record is unit\.recorded@3/);
  refused(
    packetOf([
      unit("u1", {
        assessment: {
          id: "a",
          kind: "assessment.recorded@4",
          payload: { lane: "human-required", laneRule: 3, sections: {} },
        },
      }),
    ]),
    /unit u1 \(b1\.u1\)'s assessment is assessment\.recorded@4/,
  );
  refused(
    packetOf([
      unit("u1", {
        comments: [{ id: "c9", kind: "comment.recorded@3", payload: {} }],
      }),
    ]),
    /comment c9 is comment\.recorded@3/,
  );
  refused(
    packetOf([
      unit("u1", {
        disposition: { id: "d", kind: "disposition.recorded@3", payload: {} },
      }),
    ]),
    /disposition is disposition\.recorded@3/,
  );
  refused(
    packetOf([
      unit("u1", {
        references: [{ id: "r9", kind: "context.referenced@3", payload: {} }],
      }),
    ]),
    /reference r9 is context\.referenced@3/,
  );
  // A lane rule the eval cannot recompute, under a kind it otherwise reads.
  refused(
    packetOf([
      unit("u1", {
        assessment: {
          id: "a",
          kind: "assessment.recorded@3",
          payload: { ...assessed, laneRule: 3 },
        },
      }),
    ]),
    /declares lane rule 3/,
  );
  // An assessment with no lane would read as unassessed.
  refused(
    packetOf([
      unit("u1", {
        assessment: {
          id: "a",
          kind: "assessment.recorded@3",
          payload: { sections: {} },
        },
      }),
    ]),
    /holds no lane the eval knows/,
  );
  // A unit with no record, or a record with no ranges, would own no lines.
  refused(
    packetOf([unit("u1", { recorded: undefined })]),
    /unit u1 \(b1\.u1\) has no unit record/,
  );
  refused(
    packetOf([
      unit("u1", {
        recorded: { kind: "unit.recorded@2", payload: { title: "t" } },
      }),
    ]),
    /holds no owned ranges/,
  );
  // A record with no kind cannot be told from a newer one.
  refused(
    packetOf([
      unit("u1", { recorded: { payload: { title: "t", ownedRanges: [] } } }),
    ]),
    /is a record with no kind/,
  );
  // Undecoded parts that hold units or assessments, or the manifest that lists them.
  for (const part of ["unit", "assessment", "sections", "manifest"])
    refused(
      packetOf([unit("u1")], {
        undecoded: [{ what: `${part} of b1.u1`, part, unit: "b1.u1" }],
      }),
      new RegExp(`could not decode ${part} of b1\\.u1 \\(${part}`),
    );
  // The batch and the packet, where the kind is shown.
  refused(
    packetOf([unit("u1")], {
      batches: [
        {
          batchId: "B1",
          recorded: { kind: "batch.recorded@2" },
          units: [unit("u1")],
        },
      ],
    }),
    /batch B1 is batch\.recorded@2/,
  );
  refused(
    packetOf([unit("u1")], { kind: "packet.published@2" }),
    /the packet is packet\.published@2/,
  );
  // Several problems: the first is named, the rest counted.
  expect(() =>
    readablePacket(
      packetOf([
        unit("u1", { recorded: undefined }),
        unit("u2", { recorded: undefined }),
      ]),
      "case c",
    ),
  ).toThrow(/\(and 1 more\)\.$/);
});

test("a known assessment that does not read as the lane rule's input is refused, not read as unassessed", () => {
  const packet = packetOf([
    unit("u1", {
      assessment: {
        id: "a",
        kind: "assessment.recorded@3",
        payload: { ...assessed, quadrant: "sideways" },
      },
    }),
  ]);
  expect(unreadableParts(packet)).toEqual([]);
  expect(() =>
    recordedUnits(packet, [], undefined, 1, "older", "case c"),
  ).toThrow(
    /^case c cannot be read by the eval: unit u1's assessment does not read as the lane rule's input \(quadrant/,
  );
});

const planted = (): PlantedRecord =>
  ({
    version: 1,
    caseId: "planted:1",
    variant: 1,
    lines: [{ path: "a.ts", side: "new", startLine: 1, endLine: 1 }],
    lineKeys: ["a.ts:new:1"],
    mentions: ["x"],
  }) as unknown as PlantedRecord;

const caseRecord = (number: number) => ({
  version: 1,
  caseId: `github:example/repo:${number}`,
  source: "t3code",
  provider: "github",
  number,
  title: "t",
  url: "https://example.test/pr/1",
  author: "a",
  createdAt: "2026-01-01T00:00:00Z",
  outcome: "merged",
  family: `f${number}`,
  split: "development",
  era: "2026",
  control: null,
  selection: { score: 1, reasons: [] },
  firstRevision: null,
  later: null,
  size: null,
  capture: { at: "2026-01-01T00:00:00Z", files: [] },
  clone: null,
  checks: null,
  unavailable: null,
});

/** A research tree of one case whose pinned run is `pinned` and whose `run/next/show.json` is `next`. */
const tree = (pinned: PacketLite, next: PacketLite) => {
  const root = mkdtempSync(join(tmpdir(), "run-shape-"));
  const dir = join(root, "cases", "t3code", "1");
  mkdirSync(join(dir, "labels"), { recursive: true });
  mkdirSync(join(dir, "run", "next"), { recursive: true });
  writeFileSync(join(dir, "case.json"), JSON.stringify(caseRecord(1)));
  writeFileSync(
    join(dir, "labels", "line-evidence.json"),
    JSON.stringify({
      version: 2,
      caseId: "github:example/repo:1",
      source: "t3code",
      era: "2026",
      split: "development",
      family: "f1",
      control: null,
      range: "aaaaaaa1..bbbbbbbb",
      runId: "01RUN",
      labelling: { passes: 2, rule: "majority", kappa: 0.8 },
      lines: {},
      disputed: 0,
    }),
  );
  writeFileSync(
    join(dir, "run", "show.json"),
    JSON.stringify({ packet: pinned }),
  );
  writeFileSync(
    join(dir, "run", "next", "show.json"),
    JSON.stringify({ packet: next }),
  );
  writeFileSync(
    join(root, "batch.json"),
    JSON.stringify({ cases: [{ source: "t3code", number: 1 }] }),
  );
  return { root, dir };
};

test("every path that turns a stored run into units refuses a run of a shape it cannot read", () => {
  const bad = unreadShape();
  const good = packetOf([unit("u1")]);
  const { root, dir } = tree(good, bad);
  const badFile = join(dir, "run", "next", "show.json");
  const set = writeEvalSet(
    freezeEvalSet({
      laneRule: 1,
      name: "t",
      batch: join(root, "batch.json"),
      cases: join(root, "cases"),
    }),
    join(root, "sets"),
  );
  const loaded = loadEvalSet(set);
  const entry = loaded.cases[0]!;
  const badCase: LoadedCase = { ...entry, packet: bad };
  const records = [
    {
      unit: "u1",
      pack: "p",
      packSize: 1,
      position: 1,
      outcome: "ok",
      rawVerdict: null,
    },
  ];
  // A new reader of stored runs belongs in this list.
  const entries: ReadonlyArray<readonly [string, () => unknown]> = [
    [
      "lanes.ts deskCalls (desk rounds, --against, adjudicate)",
      () => deskCalls({ packet: bad }, {}, "r"),
    ],
    [
      "lanes.ts shownRun (every desk, owner and title read)",
      () => shownRun(badFile, undefined, []),
    ],
    ["lanes-replay.ts replayCalls", () => replayCalls({ packet: bad }, "r")],
    [
      "lanes-replay.ts readReplayRun",
      () => readReplayRun({ packet: badFile }, root),
    ],
    ["lanes-eval.ts recordedUnits", () => recordedUnits(bad)],
    [
      "lanes-eval.ts recompute (identity, floor, candidates, misses)",
      () => recompute(badCase, harnessRule),
    ],
    [
      "lanes-eval.ts ownerRunUnits (the owner's guard)",
      () =>
        ownerRunUnits({ packet: bad }, "run", "r", harnessRule, {
          repository: root,
          candidate: false,
        }),
    ],
    [
      "lanes-eval.ts loadEvalSet with a recompose's run (compare-runs)",
      () => loadEvalSet(set, { run: "next", laneRule: 1 }),
    ],
    [
      "lanes-eval.ts loadEvalSet under a run root (compare-runs --*-root)",
      () =>
        loadEvalSet(set, {
          run: "next",
          runRoot: join(root, "cases"),
          laneRule: 1,
        }),
    ],
    ["key-transfer.ts packetTarget", () => packetTarget(bad)],
    [
      "key-transfer.ts runTarget (key-transfer --run, --run-root)",
      () => runTarget("next", join(root, "cases"))(entry),
    ],
    [
      "unit-review-score.ts scorePlant (planted-light score)",
      () =>
        scorePlant(
          planted(),
          { packet: bad, manifest: null } as StoredRun,
          records,
        ),
    ],
    [
      "unit-review-score.ts positionEffect, the run at k",
      () =>
        positionEffect([
          {
            caseId: "c",
            base: { packet: good, records },
            next: { packet: bad, records },
          },
        ]),
    ],
    [
      "unit-review-score.ts positionEffect, the base run",
      () =>
        positionEffect([
          {
            caseId: "c",
            base: { packet: bad, records },
            next: { packet: good, records },
          },
        ]),
    ],
    [
      "packets.ts readShownFile (cli: planted-light runs, --floor-run, --against-packet)",
      () => readShownFile(badFile),
    ],
    [
      "replay-runs.ts replayRuns (titles and digests)",
      () => replayRuns({ cases: join(root, "cases"), run: "next" }),
    ],
  ];
  try {
    // Today's shape reads on every path that takes the good run.
    expect(deskCalls({ packet: good }, {}, "r")).toHaveLength(1);
    expect(packetTarget(good)).toHaveLength(1);
    expect(recompute(entry, harnessRule).calls).toHaveLength(1);
    for (const [name, read] of entries) {
      let thrown: unknown;
      try {
        read();
      } catch (error) {
        thrown = error;
      }
      expect({ name, refused: thrown instanceof UnreadableRun }).toEqual({
        name,
        refused: true,
      });
      expect({
        name,
        message: String((thrown as Error).message),
      }).toMatchObject({
        name,
        message: expect.stringContaining("unit.recorded@9"),
      });
    }
    // A set never pins a run its readers would refuse.
    writeFileSync(
      join(dir, "run", "show.json"),
      JSON.stringify({ packet: bad }),
    );
    expect(() =>
      freezeEvalSet({
        laneRule: 1,
        name: "u",
        batch: join(root, "batch.json"),
        cases: join(root, "cases"),
      }),
    ).toThrow(/^case github:example\/repo:1 \(.*\) cannot be read by the eval/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every path with no rule-3 reader refuses the sections shape; every path with one reads it", () => {
  // The packet's kind alone marks the sections shape: `packet.published@2`.
  const sections = packetOf([unit("u1")], { kind: "packet.published@2" });
  const root = mkdtempSync(join(tmpdir(), "run-shape-sections-"));
  try {
    const file = join(root, "show.json");
    writeFileSync(file, JSON.stringify({ packet: sections }));
    const dir = join(root, "cases", "t3code", "1");
    mkdirSync(join(dir, "run"), { recursive: true });
    writeFileSync(join(dir, "case.json"), JSON.stringify(caseRecord(1)));
    writeFileSync(
      join(dir, "run", "show.json"),
      JSON.stringify({ packet: sections }),
    );
    const today: ReadonlyArray<readonly [string, () => unknown]> = [
      [
        "packets.ts packetUnits, named nothing (measures, sheet, briefings, later fixes, pr-replay)",
        () => packetUnits(sections),
      ],
      [
        "packets.ts packetBatches, named nothing (the sheet's batch digests)",
        () => packetBatches(sections),
      ],
      [
        "packets.ts hunkViews (the full test's agreement)",
        () =>
          hunkViews({
            packet: sections,
            manifest: { hunks: [] },
          } as unknown as StoredRun),
      ],
      [
        "packets.ts caughtDefect, named nothing (the full test's known cases)",
        () =>
          caughtDefect(
            { packet: sections, manifest: null } as unknown as StoredRun,
            [],
          ),
      ],
      [
        "lanes.ts shownRun, named nothing (titles, digests)",
        () => shownRun(file, undefined, []),
      ],
      [
        "replay-runs.ts replayRuns (titles and digests)",
        () => replayRuns({ cases: join(root, "cases") }),
      ],
      [
        "titles-compare.ts pairRuns (titles-compare, digests-compare)",
        () =>
          pairRuns(
            [{ caseId: "c", source: "t3code", shown: { packet: sections } }],
            [{ caseId: "c", source: "t3code", shown: { packet: sections } }],
          ),
      ],
      ["full-test/parity.ts runState", () => runState(dir, "first")],
    ];
    for (const [name, read] of today) {
      let thrown: unknown;
      try {
        read();
      } catch (error) {
        thrown = error;
      }
      expect({ name, refused: thrown instanceof UnreadableRun }).toEqual({
        name,
        refused: true,
      });
    }
    const reading: ReadonlyArray<readonly [string, () => unknown]> = [
      ["lanes.ts deskCalls", () => deskCalls({ packet: sections }, {}, "r")],
      [
        "lanes.ts shownRun with the sections reads",
        () => shownRun(file, undefined, [], READS_SECTIONS),
      ],
      [
        "lanes-replay.ts replayCalls",
        () => replayCalls({ packet: sections }, "r"),
      ],
      [
        "lanes-replay.ts readReplayRun",
        () => readReplayRun({ packet: file }, root),
      ],
      ["key-transfer.ts packetTarget", () => packetTarget(sections)],
      [
        "packets.ts readShownFile with the sections reads (cli)",
        () => readShownFile(file, file, READS_SECTIONS),
      ],
    ];
    for (const [name, read] of reading)
      expect({
        name,
        read: (() => {
          try {
            read();
            return true;
          } catch {
            return false;
          }
        })(),
      }).toEqual({ name, read: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a set refuses to pin a floor or consistency run its readers would refuse, and a floor run's refusal names the floor run", () => {
  const good = packetOf([unit("u1")]);
  const { root, dir } = tree(good, good);
  try {
    const unparsed = packetOf([
      unit("u1", {
        assessment: {
          id: "a",
          kind: "assessment.recorded@3",
          payload: { ...assessed, quadrant: "sideways" },
        },
      }),
    ]);
    mkdirSync(join(dir, "run", "floor"), { recursive: true });
    writeFileSync(
      join(dir, "run", "floor", "show.json"),
      JSON.stringify({ packet: unparsed }),
    );
    for (const which of ["floorRun", "consistencyRun"] as const)
      expect(() =>
        freezeEvalSet({
          laneRule: 1,
          name: "t",
          batch: join(root, "batch.json"),
          cases: join(root, "cases"),
          [which]: "floor",
        }),
      ).toThrow(
        /run\/floor\/show\.json cannot be read by the eval: unit u1's assessment does not read/,
      );
    // The same run given as the floor at read time is named as the floor run.
    const loaded = loadEvalSet(
      writeEvalSet(
        freezeEvalSet({
          laneRule: 1,
          name: "t",
          batch: join(root, "batch.json"),
          cases: join(root, "cases"),
        }),
        join(root, "sets"),
      ),
    );
    const range = loaded.cases[0]!.meta.range;
    expect(() => noiseFloor(loaded, [{ range, packet: unparsed }])).toThrow(
      /^case github:example\/repo:1's floor run cannot be read by the eval/,
    );
    expect(() =>
      noiseFloor(loaded, [
        { range, packet: unparsed, label: "the file k1-again/show.json" },
      ]),
    ).toThrow(/^the file k1-again\/show\.json cannot be read by the eval/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no reader reaches a packet's batches except through the guard", () => {
  // Outside packets.ts, nothing under harness-compare/ or pr-replay/ touches a packet's batches
  // directly: units come from `packetUnits`, batches from `packetBatches`, both guarded. Inside
  // packets.ts, only the guard itself (with its packet-level sections check) and `packetBatches` do. A new direct read fails here, and
  // the fix is to read through the guard.
  const src = join(import.meta.dir, "../src");
  const files = [
    ...new Bun.Glob("harness-compare/**/*.ts").scanSync(src),
    ...new Bun.Glob("pr-replay/**/*.ts").scanSync(src),
  ];
  const direct =
    /\bpacket\??\.batches\b|\[\s*["']batches["']\s*\]|\bbatches\s*[,}][^;=]*\}\s*=\s*[\w.?]*packet\b/;
  const outside = files
    .filter((file) => file !== "harness-compare/full-test/packets.ts")
    .flatMap((file) =>
      readFileSync(join(src, file), "utf8")
        .split("\n")
        .flatMap((line, index) =>
          direct.test(line) ? [`${file}:${index + 1}`] : [],
        ),
    );
  expect(outside).toEqual([]);
  const packets = readFileSync(
    join(src, "harness-compare/full-test/packets.ts"),
    "utf8",
  );
  const owners = [...packets.matchAll(/\.batches\b/g)].map((match) => {
    const before = packets.slice(0, match.index);
    const declared = [...before.matchAll(/^(?:export )?const (\w+) =/gm)].at(
      -1,
    );
    return declared?.[1];
  });
  expect([...new Set(owners)].sort()).toEqual([
    "isSectionsShape",
    "packetBatches",
    "packetSectionProblems",
    "unreadableParts",
  ]);
});
