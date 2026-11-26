import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { captureBlockers, type CaptureRead } from "../../candidate/capture.ts";
import {
  canonical,
  LineRange,
  overlaps,
  reviewNotComplete,
} from "./finders-gate.ts";
import {
  packetUnits,
  ownedLineKeys,
  rangeLineKeys,
  readShownFile,
  READS_SECTIONS,
  type StoredRun,
} from "./packets.ts";
import {
  configOf,
  ownedRange,
  probeCounts,
  readProbeFolder,
} from "./readings-gate.ts";

/**
 * Offline companion to the existing capture/packet/readings readers, not a review runner.
 * Expected concerns are frozen from source before either arm runs. A separate arm-blind
 * judgment maps delivered comments to those concerns; overlap never determines identity.
 * Pending labels, missing captures and incomplete runs cannot become quiet successful reviews.
 */
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Commit = z.string().regex(/^[a-f0-9]{40}$/);
const Named = z.string().min(1);
export const StudyCase = z.strictObject({
  id: Named,
  family: Named,
  base: Commit,
  head: Commit,
  sources: z
    .array(z.strictObject({ revision: Commit, path: Named, sha256: Hash }))
    .min(1),
  /** Evaluation placement variants, never new source revisions or product unit identities. */
  placements: z
    .array(z.enum(["single-assignment", "cross-assignment", "cross-batch"]))
    .min(1),
  adjudication: z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("pending"), reason: Named }),
    z.strictObject({
      status: z.literal("frozen"),
      basis: Hash,
      at: z.iso.datetime(),
      sourceOnly: z.literal(true),
      adjudicators: z.array(Named).min(1),
      record: Named,
      concerns: z
        .array(
          z.strictObject({
            id: Named,
            kind: z.enum(["defect", "requirement-failure"]),
            failurePath: Named,
            primary: z.array(LineRange).min(1),
            context: z.array(LineRange),
          }),
        )
        .min(1),
    }),
  ]),
});
export type StudyCase = z.infer<typeof StudyCase>;
export const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export const caseBasis = (kase: Pick<StudyCase, "base" | "head" | "sources">) =>
  hash(canonical({ base: kase.base, head: kase.head, sources: kase.sources }));

/** Checks actual Git objects; a fix hash or an absent private archive cannot stand in for source. */
export const sourceProblems = (
  repository: string,
  kase: StudyCase,
): string[] => {
  const problems: string[] = [];
  for (const revision of [kase.base, kase.head]) {
    const result = spawnSync("git", [
      "-C",
      repository,
      "cat-file",
      "-e",
      `${revision}^{commit}`,
    ]);
    if (result.status !== 0)
      problems.push(`source commit unavailable: ${revision}`);
  }
  for (const source of kase.sources) {
    if (source.revision !== kase.base && source.revision !== kase.head) {
      problems.push(`source is not at the case's base or head: ${source.path}`);
      continue;
    }
    const result = spawnSync(
      "git",
      ["-C", repository, "show", `${source.revision}:${source.path}`],
      { maxBuffer: 8 * 1024 * 1024 },
    );
    if (result.status !== 0 || hash(result.stdout) !== source.sha256)
      problems.push(
        `source unavailable or changed: ${source.path}@${source.revision}`,
      );
  }
  return problems;
};

/** Labels are evaluator attestations, not proof that a human/model really stayed blind. */
export const DeliveryJudgments = z.strictObject({
  runId: Named,
  basis: Hash,
  armBlind: z.literal(true),
  adjudicators: z.array(Named).min(1),
  record: Named,
  comments: z.array(
    z.strictObject({
      id: Named,
      hash: Hash,
      label: z.enum(["expected", "additional-supported", "unsupported"]),
      /** Independent semantic identity. Additional supported concerns have their own keys. */
      concern: Named.nullable(),
    }),
  ),
});
export type DeliveryJudgments = z.infer<typeof DeliveryJudgments>;
const unique = (values: ReadonlyArray<string>) =>
  new Set(values).size === values.length;

/**
 * Reads the real export.json, show.json and retained reading rows through their existing guards.
 * CaptureRead must come from readCandidateCapture, preserving its scan and execution refusals.
 * No model, review, provider, credential or private-archive discovery is performed here.
 */
export const readOwnedReview = (input: {
  repository: string;
  folder: string;
  kase: StudyCase;
  capture: CaptureRead;
  judgments: DeliveryJudgments | null;
}) => {
  const kase = StudyCase.parse(input.kase);
  const judgments =
    input.judgments === null ? null : DeliveryJudgments.parse(input.judgments);
  const blockers = sourceProblems(input.repository, kase);
  const basis = caseBasis(kase);
  const gold = kase.adjudication;
  if (gold.status === "pending")
    blockers.push(`expected results pending: ${gold.reason}`);
  else {
    if (gold.basis !== basis)
      blockers.push("expected results do not bind this source");
    if (!unique(gold.concerns.map((c) => c.id)))
      blockers.push("duplicate expected concern identity");
  }
  blockers.push(...captureBlockers(input.capture));
  let run: StoredRun | null = null;
  let probe: ReturnType<typeof readProbeFolder> | null = null;
  try {
    probe = readProbeFolder(input.folder, kase);
    if (probe.exported === null) blockers.push("no finished export");
    else blockers.push(...reviewNotComplete(probe.exported));
    if (probe.rows === null)
      blockers.push(probe.why ?? "no retained reading rows");
    const path = join(input.folder, "show.json");
    if (!existsSync(path)) blockers.push("no retained publication");
    else run = readShownFile<StoredRun>(path, path, READS_SECTIONS);
  } catch (error) {
    blockers.push(
      `unreadable retained run: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (run?.outcome !== "completed" || run.packet?.complete !== true)
    blockers.push("retained publication is not a complete review");
  if (
    run?.runId === undefined ||
    ("runId" in input.capture && input.capture.runId !== run.runId)
  )
    blockers.push("capture/publication run identity does not match");
  if (probe?.exported?.runId !== run?.runId)
    blockers.push("export/publication run identity does not match");
  const requestedAt = probe?.rows?.requestedAt;
  if (
    gold.status === "frozen" &&
    (!requestedAt || Date.parse(gold.at) >= Date.parse(requestedAt))
  )
    blockers.push("expected results were not frozen before the run request");

  const units =
    run === null ? [] : packetUnits(run.packet, { reads: READS_SECTIONS });
  const comments = units.flatMap(({ batchId, unit }) =>
    unit.comments.map((comment) => ({ batchId, unit, comment })),
  );
  if (!unique(comments.map(({ comment }) => comment.id)))
    blockers.push("duplicate published comment identity");
  if (judgments === null)
    blockers.push("delivered concerns not independently judged");
  else {
    if (judgments.basis !== basis || judgments.runId !== run?.runId)
      blockers.push("delivery judgments name another source or run");
    if (!unique(judgments.comments.map((c) => c.id)))
      blockers.push("duplicate delivery judgment");
    for (const { comment } of comments) {
      const label = judgments.comments.find((c) => c.id === comment.id);
      if (!label || label.hash !== hash(canonical(comment)))
        blockers.push(`unjudged or changed comment: ${comment.id}`);
    }
    for (const label of judgments.comments) {
      if (!comments.some(({ comment }) => comment.id === label.id))
        blockers.push(`judgment names absent comment: ${label.id}`);
      if ((label.label === "unsupported") !== (label.concern === null))
        blockers.push(`invalid concern identity: ${label.id}`);
      if (
        label.label === "expected" &&
        gold.status === "frozen" &&
        !gold.concerns.some((c) => c.id === label.concern)
      )
        blockers.push(`unknown expected concern: ${label.id}`);
      if (
        label.label === "additional-supported" &&
        gold.status === "frozen" &&
        gold.concerns.some((c) => c.id === label.concern)
      )
        blockers.push(`expected concern labelled additional: ${label.id}`);
    }
  }
  const rows = probe?.rows;
  const counts = rows ? probeCounts(rows) : null;
  const known = (
    value: { total: number; unknown: number } | null | undefined,
  ) => (value && value.unknown === 0 ? value.total : null);
  const verify = counts?.calls["verify-claim"];
  const completeClaimCost =
    verify && !verify.leftOut && counts?.verifyNotAttributable.calls === 0;
  // Only owned rows can be counted here. Missing primary assignments require the new planner's
  // retained full-range accounting; assigned rows alone are never called full-range coverage.
  const unjudgedOwned = new Set<string>();
  for (const row of rows?.sections ?? []) {
    if (row.state === "settled" && row.cause === null) continue;
    if (row.excluded || row.cause === "excluded") continue;
    for (const owned of row.owned) {
      const range = ownedRange(owned);
      if (range)
        for (const key of rangeLineKeys([{ kind: "lines", ...range }]))
          unjudgedOwned.add(key);
    }
  }
  const invalidRestsOn = units.flatMap(({ unit }) =>
    (unit.disposition?.payload.restsOn ?? [])
      .filter(
        (id) =>
          !unit.comments.some(
            (c) => c.id === id && c.payload.finding?.kind === "defect",
          ),
      )
      .map((id) => ({ unit: unit.unitId, comment: id })),
  );
  const metrics = {
    // Capture totals count all stages, retries and interrupted work, not just successful reviews.
    input:
      "tokens" in input.capture
        ? input.capture.tokens.input +
          input.capture.tokens.cacheRead +
          input.capture.tokens.cacheWrite
        : null,
    output: "tokens" in input.capture ? input.capture.tokens.output : null,
    // These are only Lane-review claim checks. The old finders' Verify cost is not
    // included by probeCounts, so never present this subset as total verification cost.
    reviewClaimVerifyInput: completeClaimCost
      ? sumKnown([
          known(verify.tokens.input),
          known(verify.tokens.cached),
          known(verify.tokens.cacheWrite),
        ])
      : null,
    reviewClaimVerifyOutput: completeClaimCost
      ? known(verify.tokens.output)
      : null,
    verifyInput: null,
    verifyOutput: null,
    secondsToFirstSettledBatch: counts?.secondsToFirstSettledBatch ?? null,
    secondsToFirstBatch: probe?.exported?.secondsToFirstBatch ?? null,
    secondsToCompletion: probe?.exported?.wallS ?? null,
    timingsComparable: probe?.exported?.timingsComparable === true,
    unjudgedOwnedRows: rows ? [...unjudgedOwned].sort() : null,
    invalidRestsOn,
    unreviewedRangeRows: null,
    repeatedReading: null,
    claimToCommentLinks: null,
    notMeasured: [
      "total verification cost: probeCounts covers Lane-review claim checks, not the old finders' Verify calls",
      "unreviewed range rows: retained full-range assignment accounting not yet adapted",
      "repeated reading: retained lookup inputs not yet adapted; shared context is not automatically waste",
      "claim-to-comment support and original producer: reading rows omit published comment IDs",
      "late observations and actual cross-assignment/batch placement: retained routing/publication contract not yet adapted",
    ],
  };
  const quality =
    blockers.length > 0 || gold.status !== "frozen" || judgments === null
      ? null
      : (() => {
          const expected = judgments.comments.filter(
            (c) => c.label === "expected",
          );
          const supported = judgments.comments.filter(
            (c) => c.label !== "unsupported",
          );
          const caught = new Set(expected.map((c) => c.concern!));
          return {
            distinctExpected: caught.size,
            distinctAdditional: new Set(
              supported
                .filter((c) => c.label === "additional-supported")
                .map((c) => c.concern),
            ).size,
            duplicates:
              supported.length -
              new Set(supported.map((c) => `${c.label}:${c.concern}`)).size,
            falsePositives: judgments.comments.filter(
              (c) => c.label === "unsupported",
            ).length,
            missed: gold.concerns
              .filter((c) => !caught.has(c.id))
              .map((c) => ({
                id: c.id,
                kind: c.kind,
                failurePath: c.failurePath,
                primary: c.primary,
              })),
            wrongAttribution: expected
              .filter((c) => {
                const anchor = comments.find(
                  ({ comment }) => comment.id === c.id,
                )!.comment.payload.anchor;
                return (
                  anchor !== undefined &&
                  !gold.concerns
                    .find((g) => g.id === c.concern)!
                    .primary.some((range) => overlaps(anchor, range))
                );
              })
              .map((c) => c.id),
            missingAttribution: expected
              .filter(
                (c) =>
                  comments.find(({ comment }) => comment.id === c.id)!.comment
                    .payload.anchor === undefined,
              )
              .map((c) => c.id),
            // Reported separately: publication is not the same as a valid decision-support link.
            wrongUnit: expected
              .filter((c) => {
                const published = comments.find(
                  ({ comment }) => comment.id === c.id,
                )!;
                const anchor = published.comment.payload.anchor;
                if (!anchor) return false;
                const owned = ownedLineKeys(published.unit);
                return !owned.has(
                  `${anchor.path}:${anchor.side}:${anchor.startLine}`,
                );
              })
              .map((c) => c.id),
          };
        })();
  return {
    caseId: kase.id,
    family: kase.family,
    basis,
    runId: run?.runId ?? null,
    build: probe?.exported?.build.commit ?? null,
    config: probe?.exported ? configOf(probe.exported) : null,
    blockers: [...new Set(blockers)],
    completeScore: false as const,
    quality,
    metrics,
  };
};

const sumKnown = (values: ReadonlyArray<number | null>): number | null =>
  values.some((v) => v === null)
    ? null
    : values.reduce<number>((s, v) => s + v!, 0);
export type OwnedReviewScore = ReturnType<typeof readOwnedReview>;

/** Numeric comparison only, never equivalent recall, an automatic saving claim or approval. */
export const compareOwnedReviews = (
  baseline: OwnedReviewScore,
  treatment: OwnedReviewScore,
  mode: "production" | "matched-total-cost",
) => {
  const blockers = [
    ...baseline.blockers.map((b) => `baseline: ${b}`),
    ...treatment.blockers.map((b) => `treatment: ${b}`),
  ];
  if (
    baseline.basis !== treatment.basis ||
    baseline.caseId !== treatment.caseId
  )
    blockers.push("unpaired source cases");
  if (baseline.runId === treatment.runId)
    blockers.push("the arms are the same run");
  if (
    !baseline.build ||
    !treatment.build ||
    !baseline.config ||
    !treatment.config
  )
    blockers.push("unknown build or configuration");
  const total = (s: OwnedReviewScore) =>
    sumKnown([s.metrics.input, s.metrics.output]);
  if (
    mode === "matched-total-cost" &&
    (total(baseline) === null || total(baseline) !== total(treatment))
  )
    blockers.push(
      "total input/output token costs are not exactly matched; no pre-registered tolerance is supplied",
    );
  const delta = (a: number | null, b: number | null) =>
    blockers.length > 0 || a === null || b === null ? null : b - a;
  return {
    mode,
    blockers,
    completeScore: false as const,
    conclusion: "not established" as const,
    // Even good pairs need independent recall/cost analysis, boundary evidence and the full set.
    openGates: [
      ...new Set([
        ...baseline.metrics.notMeasured,
        ...treatment.metrics.notMeasured,
      ]),
    ],
    perCase: { baseline: baseline.quality, treatment: treatment.quality },
    differences: {
      input: delta(baseline.metrics.input, treatment.metrics.input),
      output: delta(baseline.metrics.output, treatment.metrics.output),
      firstBatch:
        baseline.metrics.timingsComparable &&
        treatment.metrics.timingsComparable
          ? delta(
              baseline.metrics.secondsToFirstBatch,
              treatment.metrics.secondsToFirstBatch,
            )
          : null,
      completion:
        baseline.metrics.timingsComparable &&
        treatment.metrics.timingsComparable
          ? delta(
              baseline.metrics.secondsToCompletion,
              treatment.metrics.secondsToCompletion,
            )
          : null,
    },
  };
};
