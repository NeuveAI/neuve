// Why (NEU-148, readers round 14, the owner's ruling of 13 November): a batch is decided only when
// nothing later can change it, and that is read from one status of how each finder, and its
// Verify, ended. These pin that status where it is set (`finderEndOf`), where a missing result gets
// one (`finderResults`), where the settle point reads it (`findersHold`), what a person and the
// receipt are told, and that the test hold, which changes only timing, is in no key while every
// stub setting that can change an answer still is.
import { expect, test } from "bun:test";
import { Computations } from "@neuve/records-core";
import { RunReceipt } from "@neuve/records-schema";
import { defaultConfig, keyedStub, runSpec } from "../src/config.ts";
import { FINDERS } from "../src/find.ts";
import { agentStageSpec, type StageRecord } from "../src/pipeline.ts";
import {
  finderEnds,
  finderResults,
  findersUnfinishedGap,
  type LensEnd,
} from "../src/pi/review-task.ts";
import {
  FINDER_STATUSES,
  finderEndOf,
  type FinderResult,
  type FinderStatus,
} from "../src/pi/stages/finder-task.ts";
import { findersHeldBy, findersHold } from "../src/readings/batches.ts";
import {
  buildReceipt,
  findersEndedLine,
  formatReceipt,
} from "../src/receipt.ts";

const record = (
  status: StageRecord["status"],
  stage: StageRecord["stage"] = "find",
): StageRecord => ({ stage, agent: `${stage}.x`, status, wallMs: 1 });
const allCompleted = (): Array<LensEnd> =>
  FINDERS.map((lens) => ({ lens, find: "completed", verify: "completed" }));

// Reason: the status is set where the finder ends, from its steps' own records: a stage record's
// every status maps to one end, an interruption is the cut-off or a stop as the finder says, and a
// final claim whose Verify never started is `skipped`.
test("a finder's end is read from its Find's record and each final claim's Verify", () => {
  expect(
    (["computed", "reused", "stub", "interrupted", "skipped"] as const).map(
      (status) => finderEndOf(record(status), [], "cutoff").find,
    ),
  ).toEqual(["completed", "completed", "completed", "cutoff", "skipped"]);
  expect(finderEndOf(record("interrupted"), [], "stopped")).toEqual({
    find: "stopped",
    verify: "completed",
  });
  // No Find record: the finder ended with none, as its stop says.
  expect(finderEndOf(undefined, [], "cutoff").find).toBe("cutoff");
  // The Verifies taken together: the worst of them; a claim never checked is skipped.
  expect(
    finderEndOf(
      record("computed"),
      [record("computed", "verify"), undefined],
      "cutoff",
    ).verify,
  ).toBe("skipped");
  expect(
    finderEndOf(
      record("computed"),
      [undefined, record("interrupted", "verify"), record("reused", "verify")],
      "stopped",
    ).verify,
  ).toBe("stopped");
});

// Reason: `finderResults` never turns a missing result silently into an empty one taken for a
// completed search: the review's entry says how the finder ended (failed, or cut off or stopped as
// its checkpoint says), and a result of an earlier build with no status gets one from its records.
test("a finder with no result gets the review's entry with its end, never completed", () => {
  const finders = FINDERS.map((lens, at) => ({ lens, task: at as never }));
  const older = {
    lens: "tests",
    findKey: "k",
    findings: [],
    stages: [
      { stage: "find", agent: "find.tests", status: "computed", wallMs: 1 },
      {
        stage: "verify",
        agent: "verify.tests.abcdefgh",
        status: "interrupted",
        wallMs: 1,
      },
    ],
  } as unknown as FinderResult;
  const results = finderResults(
    finders,
    [
      undefined,
      { status: "aborted", reason: "cutoff" },
      { status: "failed", error: { message: "it broke" } },
      { status: "completed", result: older },
    ],
    "cutoff",
  );
  expect(results.map((r) => r.end)).toEqual([
    { find: "cutoff", verify: "cutoff" },
    { find: "cutoff", verify: "cutoff" },
    { find: "failed", verify: "failed" },
    { find: "completed", verify: "cutoff" },
  ]);
  expect(results[0]!.findings).toEqual([]);
  // A lens the front task never started is skipped.
  const skipped: Array<LensEnd> = FINDERS.slice(1).map((lens) => ({
    lens,
    find: "skipped",
    verify: "skipped",
  }));
  expect(finderEnds(results.slice(0, 1))).toEqual([
    { lens: "scope-fit", find: "cutoff", verify: "cutoff" },
    ...skipped,
  ]);
});

// Reason: the settle point, each status in turn, for the Find and for the Verify: completed lets
// the batches settle; every other status holds them as not reached, unless the run can have no
// successor; and the plain words a person reads come only then, never with a status name.
test("each status at the settle point: only completed lets a batch settle, unless the run is final", () => {
  for (const status of FINDER_STATUSES)
    for (const step of ["find", "verify"] as const) {
      const ended = allCompleted().map((e, at) =>
        at === 1 ? { ...e, [step]: status } : e,
      );
      // The exact words: the cut-off is named only when it is the cause.
      expect({ status, step, held: findersHold(ended, false) }).toEqual({
        status,
        step,
        held:
          status === "completed"
            ? undefined
            : status === "cutoff"
              ? "The finders did not finish before the review's cut-off, so this batch is still being judged."
              : "The finders did not finish, so this batch is not decided yet; the next run continues.",
      });
      expect(findersHold(ended, true)).toBeUndefined();
      const gap = findersUnfinishedGap(ended, true);
      expect({ status, step, gap: gap.length }).toEqual({
        status,
        step,
        gap: status === "completed" ? 0 : 1,
      });
      expect(findersUnfinishedGap(ended, false)).toEqual([]);
    }
  // A failed or stopped finder beside a cut one: the cause is not only the cut-off.
  const mixed = (other: FinderStatus) =>
    allCompleted().map((e, at) =>
      at === 0
        ? { ...e, find: "cutoff" as FinderStatus }
        : at === 2
          ? { ...e, verify: other }
          : e,
    );
  for (const other of ["failed", "stopped"] as const) {
    expect(findersHeldBy(mixed(other))).toBe("other");
    expect(findersHold(mixed(other), false)).toBe(
      "The finders did not finish, so this batch is not decided yet; the next run continues.",
    );
  }
  expect(findersHeldBy(mixed("cutoff"))).toBe("cutoff");
  // Round 33 (C2/C3): a finder cut before a final claim's Verify started ends `{find: cutoff,
  // verify: skipped}`. Its Verify never started for the same cause, so the cut-off is named.
  const cutBeforeVerify = allCompleted().map((e, at) =>
    at === 1
      ? {
          ...e,
          find: "cutoff" as FinderStatus,
          verify: "skipped" as FinderStatus,
        }
      : e,
  );
  expect(findersHeldBy(cutBeforeVerify)).toBe("cutoff");
  expect(findersHold(cutBeforeVerify, false)).toBe(
    "The finders did not finish before the review's cut-off, so this batch is still being judged.",
  );
  // A Verify skipped after a Find that completed is still another cause.
  expect(
    findersHeldBy(
      allCompleted().map((e, at) =>
        at === 1 ? { ...e, verify: "skipped" as FinderStatus } : e,
      ),
    ),
  ).toBe("other");
  expect(findersHeldBy(allCompleted())).toBeUndefined();
  const [plain] = findersUnfinishedGap(
    allCompleted().map((e) => ({ ...e, find: "cutoff" as FinderStatus })),
    true,
  );
  expect(plain).toEqual({
    key: "run:finders-unfinished",
    kind: "finders-unfinished",
    detail:
      "The finders did not finish before this review ended, so its findings are incomplete: a change shown with no finding may still have one.",
  });
  // Plain words: no status name reaches a person.
  for (const status of FINDER_STATUSES)
    expect(plain!.detail).not.toContain(status);
});

// Reason: the receipt shows each finder's status, every status by its name, and whether a
// follow-on runs it again, and the receipt still parses as Records holds it.
test("the receipt shows each finder's status", () => {
  const finders = [
    { lens: "scope-fit", find: "completed", verify: "completed", again: false },
    { lens: "correctness", find: "cutoff", verify: "skipped", again: true },
    { lens: "risky-edges", find: "stopped", verify: "failed", again: true },
    { lens: "tests", find: "skipped", verify: "skipped", again: true },
  ];
  const records = [{ type: "finders.ended", finders }];
  const line =
    "Finders: scope-fit: find completed, Verify completed; correctness: find cut at the cut-off, Verify skipped (a follow-on runs it again); risky-edges: find stopped, Verify failed (a follow-on runs it again); tests: find skipped, Verify skipped (a follow-on runs it again).";
  expect(findersEndedLine(records)).toBe(line);
  const receipt = buildReceipt({
    runId: "01KA0000000000000000000000",
    runKey: "f".repeat(64),
    generation: 0,
    jobSeq: 1,
    range: {
      baseRef: "main",
      baseOid: "b".repeat(40),
      headOid: "a".repeat(40),
    },
    cycleId: "01KA0000000000000000000001",
    config: defaultConfig(),
    enqueuedAt: new Date(1_000).toISOString(),
    startedAt: 2_000,
    endedAt: 3_000,
    stages: [],
    records,
  });
  expect(receipt.disclosures).toContain(line);
  const {
    type: _type,
    runId: _runId,
    range: _range,
    cycleId: _cycleId,
    ...stored
  } = receipt;
  expect(RunReceipt.safeParse(stored).success).toBe(true);
  expect(formatReceipt(receipt)).toContain(`  ${line}`);
  // A run that reached no Link wrote no row: no line.
  expect(findersEndedLine([])).toBeUndefined();
});

// Reason (fix 3): the test hold changes only when a stage starts or commits, so a held run and its
// release are one review: the run key and every agent step's key are equal with and without it.
// A turn limit changes answers, and `measure` is kept as it was, so each still keys apart; no stub
// setting stubs a model answer today, so the turn limit is the answer-changing case.
test("the hold is in no key; a turn limit and the other stub settings still are", () => {
  const range = {
    baseRef: "main",
    baseOid: "1".repeat(40),
    headOid: "2".repeat(40),
  };
  const hold = { stage: "find" as const, seconds: 560 };
  const runKey = (stub?: Parameters<typeof defaultConfig>[0]) =>
    Computations.computationKey(runSpec(range, defaultConfig(stub))).key;
  const stepKey = (stub?: Parameters<typeof defaultConfig>[0]) =>
    Computations.computationKey(
      agentStageSpec(
        defaultConfig(stub),
        { stage: "find", turnLimit: 12, agent: "find.tests" },
        { op: "harness.find", opVersion: 5, inputs: { lens: "tests" } },
      ),
    ).key;
  for (const key of [runKey, stepKey]) {
    expect(key({ hold })).toBe(key());
    expect(key({ hold: { ...hold, at: "before-commit" } })).toBe(key());
    expect(key({ hold, turnLimit: 3 })).toBe(key({ turnLimit: 3 }));
    expect(key({ turnLimit: 3 })).not.toBe(key());
    expect(key({ measure: true })).not.toBe(key());
  }
  expect(keyedStub(undefined)).toBeNull();
  expect(keyedStub({ hold })).toBeNull();
  expect(keyedStub({ hold, turnLimit: 3 })).toEqual({ turnLimit: 3 });
});
