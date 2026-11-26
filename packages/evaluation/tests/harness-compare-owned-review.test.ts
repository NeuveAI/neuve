// Evaluation integrity needs tests: incomplete evidence must not become measured recall/savings,
// and semantic concern identity must not be inferred from overlapping anchors. The publications,
// capture marks and expected judgments below are synthetic test data, not benchmark gold or proof.
import { afterAll, afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CaptureRead } from "../src/candidate/capture.ts";
import ORIGINAL_HOOKS from "../../../validation/cases/owned-review/original-hook-ordering.json";
import { canonical } from "../src/harness-compare/full-test/finders-gate.ts";
import {
  answerKeyDigest,
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
// Adapter fixtures must not depend on historical objects in the developer checkout: CI is
// shallow. One isolated synthetic commit supplies actual Git bytes, not benchmark gold.
const syntheticRepository = mkdtempSync(join(tmpdir(), "owned-review-source-"));
const git = (...args: string[]) => {
  const result = spawnSync("git", ["-C", syntheticRepository, ...args], {
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error(`synthetic Git fixture failed: ${result.stderr}`);
  return result.stdout.trim();
};
git("init", "-q");
mkdirSync(join(syntheticRepository, "packages/harness/src"), {
  recursive: true,
});
const source = Array.from(
  { length: 480 },
  (_, i) => `// synthetic source row ${i + 1}`,
).join("\n");
writeFileSync(join(syntheticRepository, path), source);
git("add", "--", path);
git(
  "-c",
  "user.name=Synthetic fixture",
  "-c",
  "user.email=fixture@example.invalid",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.hooksPath=/dev/null",
  "commit",
  "-qm",
  "Synthetic adapter source",
);
const revision = git("rev-parse", "HEAD");
const synthetic: StudyCase = {
  id: "synthetic-adapter",
  family: "synthetic-adapter",
  base: revision,
  head: revision,
  sources: [{ revision, path, sha256: hash(source) }],
  placements: ["single-assignment"],
  adjudication: {
    status: "pending",
    reason: "Synthetic fixture, never benchmark gold",
  },
};
afterAll(() => rmSync(syntheticRepository, { recursive: true, force: true }));
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
    ...structuredClone(synthetic),
    adjudication: {
      status: "frozen",
      basis: caseBasis(synthetic),
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
    answerKey: answerKeyDigest(kase)!,
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
      repository: syntheticRepository,
      folder,
      kase,
      judgments,
      capture: capture(runId),
      ...changes,
    });
  };
  return { read, save, folder, kase, judgments, shown, exported, rows };
};

test("candidate pins stay pending; absent historical objects fail closed without requiring a full checkout", () => {
  expect(candidates.length).toBe(2);
  for (const c of candidates) {
    const problems = sourceProblems(repository, c);
    // Validate available history, but a shallow checkout cannot establish historical source.
    if (problems.length > 0)
      expect(
        problems.some((p) => p.startsWith("source commit unavailable:")),
      ).toBe(true);
    expect(c.adjudication.status).toBe("pending");
    // This isolated repository deliberately has none of the historical candidate objects.
    expect(sourceProblems(syntheticRepository, c)).toContain(
      `source commit unavailable: ${c.head}`,
    );
  }
  const f = fixture();
  const score = f.read({ kase: original });
  expect(
    score.blockers.some((b) => b.startsWith("source commit unavailable:")),
  ).toBe(true);
  expect(score.quality).toBeNull();
  expect(score.blockers.some((b) => b.includes("pending"))).toBe(true);
  const comparison = compareOwnedReviews(score, score, "production");
  expect(comparison.conclusion).toBe("not established");
  expect(Object.values(comparison.differences).every((v) => v === null)).toBe(
    true,
  );
});

test("original agent-hook ordering fixture preserves four immutable reports and keeps the readiness report separate", () => {
  expect(hash(canonical(ORIGINAL_HOOKS))).toBe(
    "2aa3d6b6ef9610fd70d2b942c3eec9192ea20208b2257b79c011fe58b3d80400",
  );
  expect(ORIGINAL_HOOKS.range).toEqual({
    base: "b80e11ae8edb232304f0ae6f2010df6e3331c210",
    head: "8275d2875c6f91cdf04baa91ce9e3dc1149af216",
  });
  const reportHashes = new Map([
    [
      "01M7ZWKSDD003B43VK1GB47A8G",
      "092c3f1ab6e37e9f548d34f5ff99eb78b38daee8dea371e5984d1ac61f6b4a5c",
    ],
    [
      "01M7ZWKSDD003AJ1X0R7D69EEJ",
      "bcfc32f79e7b22fa0c1877d30d250ed00678753da3a132d225461a4b9907ecb4",
    ],
    [
      "01M7ZWKSDD003DH7Y2XVFZ7CPJ",
      "8c7494bfaecc1327a34c30a84da9dcb0f1453ee614b6f20bca5d9e033aa7058a",
    ],
    [
      "01M7ZWKSDD003331XX5MR7N1HS",
      "a1d91e6eff4d69915a9de1ba25c25bb2a65ff9d2dccbf99f7646a384cec9fd3b",
    ],
  ]);
  expect(ORIGINAL_HOOKS.reports).toHaveLength(4);
  expect(ORIGINAL_HOOKS.reports.map((r) => r.record.event.id)).toEqual([
    ...reportHashes.keys(),
  ]);
  for (const report of ORIGINAL_HOOKS.reports) {
    const event = report.record.event;
    expect(hash(canonical(report.record))).toBe(reportHashes.get(event.id)!);
    expect(event.kind).toBe("comment.recorded@3");
    expect(event.attribution.cycleId).toBe(ORIGINAL_HOOKS.cycle);
    expect(event.payload.section).toBe(ORIGINAL_HOOKS.section);
    expect(event.payload.anchor.path).toBe(
      "apps/neuve-cli/src/capture/setup-hooks.ts",
    );
    expect(report.publisherActor).toBe(event.actor);
    // Supporting source computations do not identify an original reviewer or another vote.
    expect(report.originalProducer.status).toBe("unknown");
    expect(report.sourceComputationRefs).toEqual([
      ...new Set(event.payload.finding.evidence.map((e) => e.ref)),
    ]);
  }
  const other = ORIGINAL_HOOKS.contrastingReport;
  expect(other.record.event.id).toBe("01M7ZWKSDD003EV7Z8DP9T1G67");
  expect(hash(canonical(other.record))).toBe(
    "2d917ec087d48f0be4a229991a3b4865404979ce1f7648d0e4a733f537a87cec",
  );
  expect(other.record.event.payload.section).not.toBe(ORIGINAL_HOOKS.section);
  expect(other.record.event.payload.anchor).toMatchObject({
    startLine: 919,
    endLine: 934,
  });
  expect(ORIGINAL_HOOKS.evaluation.status).toBe("pending");
});

test("frozen original source excerpts remain checkable without historical objects; availability is separate from gold", () => {
  const kase: StudyCase = {
    id: "original-agent-hook-ordering",
    family: "original-agent-hook-ordering",
    ...ORIGINAL_HOOKS.range,
    sources: ORIGINAL_HOOKS.sources.map(({ revision, path, sha256 }) => ({
      revision,
      path,
      sha256,
    })),
    placements: ["single-assignment"],
    adjudication: {
      status: "pending",
      reason: "Historical reports are not independently adjudicated gold",
    },
  };
  const problems = sourceProblems(repository, kase);
  for (const source of ORIGINAL_HOOKS.sources) {
    const actual = spawnSync("git", [
      "-C",
      repository,
      "show",
      `${source.revision}:${source.path}`,
    ]);
    for (const excerpt of source.excerpts) {
      expect(hash(excerpt.text)).toBe(excerpt.sha256);
      expect(excerpt.text.split("\n").length - 1).toBe(
        excerpt.endLine - excerpt.startLine + 1,
      );
      if (actual.status === 0)
        expect(
          actual.stdout
            .toString()
            .split(/(?<=\n)/)
            .slice(excerpt.startLine - 1, excerpt.endLine)
            .join(""),
        ).toBe(excerpt.text);
    }
    if (actual.status === 0) {
      expect(hash(actual.stdout)).toBe(source.sha256);
      const blob = spawnSync(
        "git",
        ["-C", repository, "rev-parse", `${source.revision}:${source.path}`],
        { encoding: "utf8" },
      );
      expect(blob.status).toBe(0);
      expect(blob.stdout.trim()).toBe(source.blob);
    } else
      expect(problems).toContain(
        `source commit unavailable: ${source.revision}`,
      );
  }
  // No fabricated replacement commit or safety skip: an absent original cannot be scored.
  expect(sourceProblems(syntheticRepository, kase)).toContain(
    `source commit unavailable: ${kase.head}`,
  );
  const unavailable = fixture().read({ kase });
  expect(unavailable.quality).toBeNull();
  expect(
    unavailable.blockers.some((b) =>
      b.startsWith("source commit unavailable:"),
    ),
  ).toBe(true);
  expect(unavailable.blockers.some((b) => b.includes("pending"))).toBe(true);
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

test("missing or invalid request timestamps cannot establish that expected judgments predate a run", () => {
  for (const timestamp of [
    undefined,
    null,
    "",
    "not-a-date",
    "2026-99-99T00:00:00.000Z",
  ]) {
    const f = fixture("treatment");
    f.rows[0]!.enqueuedAt = timestamp;
    const score = f.read();
    expect(score.blockers).toContain(
      "missing or invalid expected-results/run-request timestamp",
    );
    expect(score.quality).toBeNull();
    const comparison = compareOwnedReviews(
      fixture().read(),
      score,
      "production",
    );
    expect(Object.values(comparison.differences).every((v) => v === null)).toBe(
      true,
    );
  }
  const invalidGold = fixture();
  if (invalidGold.kase.adjudication.status === "frozen")
    invalidGold.kase.adjudication.at = "not-a-date";
  expect(() => invalidGold.read()).toThrow();
});

test("delivery judgments bind the entire frozen answer key, not just reviewed source", () => {
  const f = fixture();
  if (f.kase.adjudication.status !== "frozen")
    throw new Error("synthetic frozen fixture required");
  f.kase.adjudication.concerns.push({
    id: "extra-required",
    kind: "defect",
    failurePath: "different expected denominator",
    primary: [anchor],
    context: [],
  });
  const score = f.read();
  expect(score.basis).toBe(caseBasis(synthetic));
  expect(score.blockers).toContain(
    "delivery judgments do not bind this frozen answer key",
  );
  expect(score.quality).toBeNull();

  // Reasoning, attribution and adjudication provenance are frozen too, even with the same ids.
  for (const change of ["failure-path", "primary", "record"] as const) {
    const changed = fixture();
    if (changed.kase.adjudication.status !== "frozen")
      throw new Error("synthetic frozen fixture required");
    if (change === "failure-path")
      changed.kase.adjudication.concerns[0]!.failurePath =
        "another failure path";
    else if (change === "primary")
      changed.kase.adjudication.concerns[0]!.primary = [
        { ...anchor, startLine: 480, endLine: 480 },
      ];
    else changed.kase.adjudication.record = "another source-only adjudication";
    expect(changed.read().quality).toBeNull();
  }
});

test("valid runs of the same source but different frozen answer keys cannot pair in either comparison", () => {
  const baseline = fixture().read();
  const f = fixture("treatment");
  if (f.kase.adjudication.status !== "frozen")
    throw new Error("synthetic frozen fixture required");
  f.kase.adjudication.concerns.push({
    id: "extra-required",
    kind: "defect",
    failurePath: "different expected denominator",
    primary: [anchor],
    context: [],
  });
  // Independently labelled against the changed key: individually valid, not paired evidence.
  f.judgments.answerKey = answerKeyDigest(f.kase)!;
  const treatment = f.read();
  expect(baseline.blockers).toEqual([]);
  expect(treatment.blockers).toEqual([]);
  expect(baseline.quality?.missed).toHaveLength(1);
  expect(treatment.quality?.missed).toHaveLength(2);
  expect(baseline.answerKey).not.toBe(treatment.answerKey);
  for (const mode of ["production", "matched-total-cost"] as const) {
    const comparison = compareOwnedReviews(baseline, treatment, mode);
    expect(comparison.blockers).toContain(
      "missing or different frozen answer keys",
    );
    expect(Object.values(comparison.differences).every((v) => v === null)).toBe(
      true,
    );
    expect(comparison.completeScore).toBe(false);
  }
  expect(
    compareOwnedReviews(
      { ...baseline, answerKey: null },
      baseline,
      "production",
    ).blockers,
  ).toContain("missing or different frozen answer keys");
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
