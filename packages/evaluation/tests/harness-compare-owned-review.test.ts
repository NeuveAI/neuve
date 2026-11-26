// Evaluation integrity needs tests: incomplete evidence must not become measured recall/savings,
// and semantic concern identity must not be inferred from overlapping anchors. The publications,
// capture marks and expected judgments below are synthetic test data, not benchmark gold or proof.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CaptureRead } from "../src/candidate/capture.ts";
import { canonical } from "../src/harness-compare/full-test/finders-gate.ts";
import {
  caseBasis,
  compareOwnedReviews,
  hash,
  readOwnedReview,
  sourceProblems,
  StudyCase,
  type DeliveryJudgments,
} from "../src/harness-compare/full-test/owned-review.ts";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const candidatePath = join(
  repository,
  "validation/cases/owned-review/candidates.json",
);
const candidates = (
  JSON.parse(readFileSync(candidatePath, "utf8")) as { cases: unknown[] }
).cases.map((c) => StudyCase.parse(c));
const original = candidates[0]!;
const path = "packages/harness/src/request.ts";
const anchor = { path, side: "new" as const, startLine: 479, endLine: 479 };
const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0))
    rmSync(folder, { force: true, recursive: true });
});

const capture = (runId: string): CaptureRead => ({
  status: "complete",
  runId,
  redaction: "portable",
  runStatus: "completed",
  stages: [{ stage: "review", status: "completed" }],
  gaps: [],
  tokens: {
    input: 100,
    cacheRead: 20,
    cacheWrite: 5,
    output: 10,
    totalTokens: 135,
  },
  scan: { policy: "capture-scan-v1", rawCapture: "a".repeat(64) },
  mark: {
    kind: "capture.marked@1",
    id: "01M5V9FNPH0GA6XREDPJR5KWC8",
    actor: "c".repeat(64),
    occurredAt: "2026-11-26T00:00:00.000Z",
    idempotencyKey: "synthetic-mark",
    payload: {
      rawCapture: "a".repeat(64),
      detectorVersion: "capture-scan-v1",
      outcome: "clean",
      record: "b".repeat(64),
    },
  },
});
const fixture = (runId = "baseline") => {
  const folder = mkdtempSync(join(tmpdir(), "owned-review-"));
  folders.push(folder);
  const kase: StudyCase = {
    ...structuredClone(original),
    adjudication: {
      status: "frozen",
      basis: caseBasis(original),
      at: "2026-11-25T00:00:00.000Z",
      sourceOnly: true,
      adjudicators: ["synthetic-independent-judge"],
      record: "synthetic expected judgments",
      concerns: [
        {
          id: "failure",
          kind: "defect",
          failurePath: "synthetic failure path",
          primary: [anchor],
          context: [],
        },
        {
          id: "distinct-same-line",
          kind: "requirement-failure",
          failurePath: "synthetic distinct requirement failure",
          primary: [anchor],
          context: [],
        },
        {
          id: "miss",
          kind: "defect",
          failurePath: "synthetic missed failure",
          primary: [{ ...anchor, startLine: 480, endLine: 480 }],
          context: [],
        },
      ],
    },
  };
  const comment = (id: string) => ({
    id,
    kind: "comment.recorded@2",
    payload: {
      body: `synthetic ${id}`,
      anchor,
      finding: { kind: "defect", about: "code", evidence: [] },
    },
  });
  const comments = [
    comment("one"),
    comment("repeat"),
    comment("distinct"),
    comment("false-positive"),
  ];
  const unit = {
    unitId: "unit",
    recorded: {
      kind: "unit.recorded@2",
      payload: {
        title: "synthetic",
        ownedRanges: [{ kind: "lines", ...anchor }],
      },
    },
    content: {},
    references: [],
    comments,
    disposition: {
      kind: "disposition.recorded@2",
      id: "disposition",
      payload: {
        verdict: "request-changes",
        restsOn: ["one", "missing-comment"],
        proof: [],
      },
    },
  };
  const shown = {
    runId,
    outcome: "completed",
    packet: {
      kind: "packet.published@1",
      complete: true,
      gaps: [],
      batches: [
        {
          batchId: "batch",
          recorded: { kind: "batch.recorded@1" },
          units: [unit],
        },
      ],
    },
    manifest: { hunks: [] },
  };
  const exported = {
    finished: true,
    runId,
    case: { base: kase.base, head: kase.head },
    exit: 0,
    wallS: 60,
    build: { commit: "d".repeat(40) },
    secondsToFirstBatch: 25,
    timingsComparable: true,
    settings: { pipeline: "synthetic" },
    env: {},
  };
  const rows: Array<Record<string, unknown>> = [
    { type: "run.started", enqueuedAt: "2026-11-26T00:00:00.000Z" },
    {
      type: "reading.section",
      decision: "decision",
      section: "section",
      path,
      owned: [`${path}:new:479`],
      group: "group",
      state: "settled",
      lane: null,
      verdict: "request-changes",
      cause: null,
      claims: [],
    },
    { type: "readings.decision", key: "decision", sections: 1, settled: 1 },
  ];
  const judgments: DeliveryJudgments = {
    runId,
    basis: caseBasis(kase),
    armBlind: true,
    adjudicators: ["synthetic-output-judge"],
    record: "synthetic delivery judgments",
    comments: comments.map((c, i) => ({
      id: c.id,
      hash: hash(canonical(c)),
      label: i === 3 ? "unsupported" : "expected",
      concern: i === 3 ? null : i === 2 ? "distinct-same-line" : "failure",
    })),
  };
  const save = () => {
    writeFileSync(join(folder, "show.json"), JSON.stringify(shown));
    writeFileSync(join(folder, "export.json"), JSON.stringify(exported));
    writeFileSync(
      join(folder, "readings.jsonl"),
      rows.map((r) => JSON.stringify(r)).join("\n"),
    );
  };
  save();
  const read = (
    changes: Partial<Parameters<typeof readOwnedReview>[0]> = {},
  ) => {
    save();
    return readOwnedReview({
      repository,
      folder,
      kase,
      judgments,
      capture: capture(runId),
      ...changes,
    });
  };
  return { read, save, folder, kase, judgments, shown, exported, rows };
};

test("candidate ranges pin actual bug-present source, stay pending, and do not depend on private archives", () => {
  expect(candidates.length).toBe(2);
  for (const c of candidates) {
    expect(sourceProblems(repository, c)).toEqual([]);
    expect(c.adjudication.status).toBe("pending");
  }
  const f = fixture();
  const score = f.read({ kase: original });
  expect(score.quality).toBeNull();
  expect(score.blockers.some((b) => b.includes("pending"))).toBe(true);
  const comparison = compareOwnedReviews(score, score, "production");
  expect(comparison.conclusion).toBe("not established");
  expect(Object.values(comparison.differences).every((v) => v === null)).toBe(
    true,
  );
});

test("retained publications and independent semantic labels preserve distinct same-line defects, duplicates, FP and individual misses", () => {
  const score = fixture().read();
  expect(score.blockers).toEqual([]);
  expect(score.quality).toMatchObject({
    distinctExpected: 2,
    duplicates: 1,
    falsePositives: 1,
    missed: [
      { id: "miss", kind: "defect", failurePath: "synthetic missed failure" },
    ],
    wrongAttribution: [],
    missingAttribution: [],
    wrongUnit: [],
  });
  expect(score.metrics.input).toBe(125);
  expect(score.metrics.output).toBe(10);
  expect(score.metrics.invalidRestsOn).toEqual([
    { unit: "unit", comment: "missing-comment" },
  ]);
  expect(score.metrics.verifyInput).toBeNull();
  expect(score.metrics.unreviewedRangeRows).toBeNull();
});

test("unknown or incomplete capture blocks all quality and cost comparisons despite published comments", () => {
  for (const unavailable of [
    { status: "missing", why: "archive unavailable" },
    { status: "refused", why: "no wire evidence" },
    {
      ...capture("treatment"),
      status: "incomplete",
      gaps: [{ code: "interruption", kind: "capture", count: 1 }],
    },
  ] as CaptureRead[]) {
    const treatment = fixture("treatment").read({ capture: unavailable });
    const comparison = compareOwnedReviews(
      fixture().read(),
      treatment,
      "production",
    );
    expect(treatment.quality).toBeNull();
    expect(comparison.blockers.length).toBeGreaterThan(0);
    expect(comparison.conclusion).toBe("not established");
    expect(Object.values(comparison.differences).every((v) => v === null)).toBe(
      true,
    );
  }
});

test("pending or changed semantic labels cannot be inferred from matching anchors", () => {
  const f = fixture();
  expect(f.read({ judgments: null }).quality).toBeNull();
  f.judgments.comments[0]!.hash = "f".repeat(64);
  expect(f.read().quality).toBeNull();
});

test("changed source, late expected judgments and different run/range identities cannot score", () => {
  const f = fixture();
  f.kase.sources[0]!.sha256 = "0".repeat(64);
  expect(
    f.read().blockers.some((b) => b.includes("source unavailable or changed")),
  ).toBe(true);
  const late = fixture();
  if (late.kase.adjudication.status === "frozen")
    late.kase.adjudication.at = "2026-11-27T00:00:00.000Z";
  expect(late.read().quality).toBeNull();
  const wrongRun = fixture();
  wrongRun.shown.runId = "another";
  expect(wrongRun.read().quality).toBeNull();
  const wrongRange = fixture();
  wrongRange.exported.case.head = "e".repeat(40);
  expect(wrongRange.read().quality).toBeNull();
});

test("cutoff or unreadable publications are not successful empty reviews, and unjudged owned rows stay explicit", () => {
  const f = fixture();
  f.shown.outcome = "cutoff";
  expect(f.read().quality).toBeNull();
  f.shown.outcome = "completed";
  f.shown.packet.batches[0]!.units[0]!.recorded.kind = "unit.recorded@99";
  expect(f.read().quality).toBeNull();
  const unjudged = fixture();
  unjudged.rows[1]!.cause = "failed";
  const score = unjudged.read();
  expect(score.metrics.unjudgedOwnedRows).toEqual([`${path}:new:479`]);
  expect(score.metrics.unreviewedRangeRows).toBeNull();
});

test("wrong and missing primary attribution stay separate from semantic matches", () => {
  const f = fixture();
  const comments = f.shown.packet.batches[0]!.units[0]!.comments;
  comments[0]!.payload.anchor = { ...anchor, startLine: 800, endLine: 800 };
  Reflect.deleteProperty(comments[1]!.payload, "anchor");
  for (const judgment of f.judgments.comments)
    judgment.hash = hash(
      canonical(comments.find((c) => c.id === judgment.id)!),
    );
  const score = f.read();
  expect(score.quality).toMatchObject({
    distinctExpected: 2,
    wrongAttribution: ["one"],
    missingAttribution: ["repeat"],
    wrongUnit: ["one"],
  });
  expect(score.completeScore).toBe(false);
});

test("production and exact matched-total-token comparisons stay separate; neither asserts equivalent recall or savings", () => {
  const baseline = fixture().read();
  const treatment = fixture("treatment").read();
  const production = compareOwnedReviews(baseline, treatment, "production");
  const matched = compareOwnedReviews(
    baseline,
    treatment,
    "matched-total-cost",
  );
  expect(production.blockers).toEqual([]);
  expect(matched.blockers).toEqual([]);
  expect(production.differences.input).toBe(0);
  expect(production.conclusion).toBe("not established");
  expect(matched.openGates.length).toBeGreaterThan(0);
  const cheaperCapture = capture("cheaper");
  if ("tokens" in cheaperCapture) cheaperCapture.tokens.input = 40;
  const cheaper = fixture("cheaper").read({ capture: cheaperCapture });
  expect(
    compareOwnedReviews(baseline, cheaper, "matched-total-cost").blockers.some(
      (b) => b.includes("not exactly matched"),
    ),
  ).toBe(true);
  const comparison = compareOwnedReviews(baseline, cheaper, "production");
  expect(comparison.differences.input).toBe(-60);
  expect(comparison.conclusion).toBe("not established");
});
