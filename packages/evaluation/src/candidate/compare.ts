import type { SessionDumpReader } from "./capture.ts";
import { resolve } from "node:path";
import {
  floorOf,
  OUTSIDE_AIM_KINDS,
  parityComparison,
  readParityFloor,
  readParityPairs,
  readRun,
  refuseUnconfirmed,
  type ParityEntry,
  type ParityFailure,
} from "../harness-compare/full-test/parity.ts";
import { quantile } from "../retrieval-bench/score/stats.ts";
import { researchRoot, treatmentRoot } from "../pr-replay/sources.ts";
import {
  verifyManifest,
  type EffortComparison,
  type Manifest,
  type ManifestCase,
  type ManifestRun,
} from "./manifest.ts";

/**
 * A fresh candidate against its baseline, the replay's first runs (NEU-58), on the same sample, by the
 * existing parity method (full-test/parity.ts): its pairing, floor, guards and per-source and per-kind
 * rows, unchanged. Around it, what that method leaves out of its pairs is counted here: every sample
 * case stays in the denominator, a failed, partial, unscorable or capture-incomplete run counts its
 * concerns as lost, never as caught or as a quiet review, and concerns whose labels are unavailable are
 * kept apart from concerns missed. Tokens are reported per arm and beside the repeats' own spread. No
 * new score, price or threshold is added; what may be a regression is listed for the owner.
 */

const round = (value: number) => Math.round(value * 1_000) / 1_000;
const inAim = (kind: string) => !OUTSIDE_AIM_KINDS.includes(kind);

const runOf = (entry: ManifestCase, run: string) => {
  const found = entry.runs.find((r) => r.run === run);
  if (found === undefined)
    throw new Error(`${entry.caseId}: the manifest holds no ${run} run`);
  return found;
};

type Outcome = "caught" | "missed" | "lost" | "notInMix";
type Tally = Record<Outcome, number>;
const tally = (): Tally => ({ caught: 0, missed: 0, lost: 0, notInMix: 0 });

/** Quantiles of per-case ratios, or null with none. */
const spread = (ratios: ReadonlyArray<number>) => {
  if (ratios.length === 0) return null;
  const sorted = [...ratios].sort((a, b) => a - b);
  return {
    cases: sorted.length,
    min: round(sorted[0]!),
    median: round(quantile(sorted, 0.5)),
    max: round(sorted.at(-1)!),
  };
};

const tokenTotals = (runs: ReadonlyArray<ManifestRun>) => {
  const usable = runs.filter((r) => r.tokens !== null);
  const sum = (pick: (r: ManifestRun) => number) =>
    usable.reduce((total, r) => total + pick(r), 0);
  const median = (pick: (r: ManifestRun) => number) =>
    usable.length === 0
      ? null
      : quantile(
          usable.map(pick).sort((a, b) => a - b),
          0.5,
        );
  return {
    runs: usable.length,
    input: sum((r) => r.tokens!.input),
    output: sum((r) => r.tokens!.output),
    cacheRead: sum((r) => r.tokens!.cacheRead),
    modelCalls: sum((r) => r.modelCalls ?? 0),
    medianInput: median((r) => r.tokens!.input),
    medianOutput: median((r) => r.tokens!.output),
  };
};

/** Each pair's per-case ratios of read tokens (input and cache reads) and output, both runs completed. */
const tokenRatios = (
  pairs: ReadonlyArray<readonly [ManifestRun, ManifestRun]>,
) => {
  const both = pairs.filter(
    ([a, b]) =>
      a.execution.state === "completed" &&
      b.execution.state === "completed" &&
      a.tokens !== null &&
      b.tokens !== null &&
      a.tokens.input + a.tokens.cacheRead > 0 &&
      a.tokens.output > 0,
  );
  return {
    read: spread(
      both.map(
        ([a, b]) =>
          (b.tokens!.input + b.tokens!.cacheRead) /
          (a.tokens!.input + a.tokens!.cacheRead),
      ),
    ),
    output: spread(both.map(([a, b]) => b.tokens!.output / a.tokens!.output)),
  };
};

const identityOf = (runs: ReadonlyArray<ManifestRun>) => {
  const builds = new Map<string, { build: unknown; cases: number }>();
  for (const run of runs) {
    const build =
      run.build === null
        ? null
        : {
            commit: run.build.commit,
            productCommit: run.build.productCommit,
            graph: run.build.graph,
            imageId: run.build.imageId,
            deadlineS: run.build.deadlineS,
            settings: run.build.settings,
            declared: run.build.declared,
            differences: run.build.differences,
          };
    const key = JSON.stringify(build);
    builds.set(key, { build, cases: (builds.get(key)?.cases ?? 0) + 1 });
  }
  const routes = new Map<string, number>();
  for (const run of runs) {
    const key = JSON.stringify(run.route);
    routes.set(key, (routes.get(key) ?? 0) + 1);
  }
  return {
    builds: [...builds.values()],
    routes: [...routes].map(([route, cases]) => ({
      route: JSON.parse(route) as unknown,
      cases,
    })),
  };
};

export interface ManifestIdentity {
  readonly path: string;
  readonly sha256: string;
}

export const compareCandidate = async (
  baseline: Manifest,
  candidate: Manifest,
  all: ReadonlyArray<ParityEntry>,
  identity: {
    readonly baseline: ManifestIdentity;
    readonly candidate: ManifestIdentity;
  },
  reader?: SessionDumpReader | string,
  effortComparison?: EffortComparison,
) => {
  if (baseline.role !== "baseline" || baseline.sample === null)
    throw new Error("--baseline is no baseline manifest of a sample");
  if (baseline.floor === null)
    throw new Error("the baseline manifest names no floor");
  if (candidate.role !== "candidate" || candidate.sample === null)
    throw new Error("--candidate is no candidate manifest of a sample");
  if (candidate.effortComparison !== effortComparison)
    throw new Error(
      `--effort-comparison ${String(effortComparison)} does not match the candidate manifest's ${String(candidate.effortComparison)}; collect and compare with the same explicit effort`,
    );
  if (candidate.sample.sha256 !== baseline.sample.sha256)
    throw new Error("the two manifests are of different samples");
  const research = resolve(researchRoot());
  for (const manifest of [baseline, candidate])
    if (manifest.researchRoot !== research)
      throw new Error(
        `a manifest of ${manifest.researchRoot} is read against ${research}`,
      );
  if (candidate.treatmentRoot !== treatmentRoot())
    throw new Error(
      `the candidate manifest's treatment ${String(candidate.treatmentRoot)} is not NEUVE_TREATMENT_ROOT ${treatmentRoot()}`,
    );
  const [run] = candidate.runs;
  if (run === undefined || candidate.runs.length !== 1)
    throw new Error("the candidate manifest holds more than one run");
  // Pinned: both manifests' files hashed again before anything is read.
  const drift = [
    ...(await verifyManifest(baseline, reader)).map(
      (line) => `baseline: ${line}`,
    ),
    ...(await verifyManifest(candidate, reader)).map(
      (line) => `candidate: ${line}`,
    ),
  ];
  if (drift.length > 0)
    throw new Error(
      `${drift.length} file(s) differ from the manifests; nothing compared:\n${drift.join("\n")}`,
    );
  const byCandidate = new Map(candidate.cases.map((c) => [c.caseId, c]));
  if (
    candidate.cases.length !== baseline.cases.length ||
    baseline.cases.some((c) => !byCandidate.has(c.caseId))
  )
    throw new Error("the two manifests hold different cases");
  const byId = new Map(all.map((entry) => [entry.record.caseId, entry]));
  const controls = new Set(
    baseline.cases.filter((c) => c.control).map((c) => c.caseId),
  );
  const rows = baseline.cases.map((base) => ({
    base,
    first: runOf(base, "first"),
    next: runOf(byCandidate.get(base.caseId)!, run),
  }));
  // A run either arm may not score is a failed case on its arm, listed with its blockers, as the
  // parity method lists a timed-out one; only the rest are paired.
  const failed: Array<ParityFailure> = [];
  const mix = (caseId: string) =>
    readRun(byId.get(caseId)!.directory, "first")?.concerns.filter((c) =>
      inAim(c.kind),
    ).length ?? null;
  for (const { base, first, next } of rows)
    for (const side of [first, next])
      if (side.blockers.length > 0)
        failed.push({
          caseId: base.caseId,
          source: base.source,
          run: side.run,
          why: side.blockers.join("; "),
          control: base.control,
          concerns: mix(base.caseId),
        });
  const pairable = rows.filter(
    ({ first, next }) =>
      first.blockers.length === 0 && next.blockers.length === 0,
  );
  // Every scorable run must be matched, paired or not: an unmatched one would read as concerns
  // missing from its mix, which is a label not yet made, never a miss.
  const unlabelled = rows.flatMap(({ base, first, next }) =>
    [first, next]
      .filter((side) => side.blockers.length === 0 && !side.labels.matched)
      .map((side) => `- ${base.caseId} (${side.run})`),
  );
  if (unlabelled.length > 0)
    throw new Error(
      `${unlabelled.length} scorable run(s) are not matched yet; match (and confirm) them before comparing:\n${unlabelled.join("\n")}`,
    );
  const cases = readParityPairs(
    byId,
    pairable.map(({ base }) => base.caseId),
    controls,
    "first",
    run,
    true,
    failed,
  );
  const floorFailed: Array<ParityFailure> = [];
  const floorCases = readParityFloor(
    all.filter((entry) =>
      baseline.floorUniverse?.some(
        (pinned) =>
          pinned.caseId === entry.record.caseId &&
          pinned.directory === entry.directory &&
          pinned.source === entry.source,
      ),
    ),
    baseline.floor.join(","),
    floorFailed,
  );
  refuseUnconfirmed([
    { cases, base: "baseline", next: "candidate" },
    ...(floorCases === null
      ? []
      : [{ cases: floorCases.cases, base: "floor", next: "floor" }]),
  ]);
  const parity = parityComparison(cases, floorOf(floorCases), failed);

  // Every sample concern case in the denominator: each concern of the first run's mix, by arm.
  const paired = new Map(cases.map((entry) => [entry.caseId, entry]));
  const bySource = new Map<string, { baseline: Tally; candidate: Tally }>();
  const byKind = new Map<string, { baseline: Tally; candidate: Tally }>();
  const total = { baseline: tally(), candidate: tally() };
  const unknownMix: Array<string> = [];
  const flips: Array<{
    caseId: string;
    source: string;
    ref: string;
    kind: string;
    baseline: boolean;
    candidate: boolean;
  }> = [];
  for (const { base, first, next } of rows) {
    if (base.control) continue;
    const directory = byId.get(base.caseId)!.directory;
    const concerns = readRun(directory, "first")?.concerns.filter((c) =>
      inAim(c.kind),
    );
    if (concerns === undefined) {
      unknownMix.push(base.caseId);
      continue;
    }
    const nextRun =
      next.blockers.length === 0 && next.labels.matched
        ? readRun(directory, run)
        : null;
    const nextByRef = new Map(
      (nextRun?.concerns ?? []).map((concern) => [concern.ref, concern]),
    );
    for (const concern of concerns) {
      const baseOutcome: Outcome =
        first.blockers.length > 0
          ? "lost"
          : concern.caught
            ? "caught"
            : "missed";
      const other = nextByRef.get(concern.ref);
      const nextOutcome: Outcome =
        next.blockers.length > 0
          ? "lost"
          : other === undefined
            ? "notInMix"
            : other.caught
              ? "caught"
              : "missed";
      for (const [map, key] of [
        [bySource, base.source],
        [byKind, concern.kind],
      ] as const) {
        const held = map.get(key) ?? { baseline: tally(), candidate: tally() };
        held.baseline[baseOutcome]++;
        held.candidate[nextOutcome]++;
        map.set(key, held);
      }
      total.baseline[baseOutcome]++;
      total.candidate[nextOutcome]++;
      if (
        paired.has(base.caseId) &&
        other !== undefined &&
        other.caught !== concern.caught
      )
        flips.push({
          caseId: base.caseId,
          source: base.source,
          ref: concern.ref,
          kind: concern.kind,
          baseline: concern.caught,
          candidate: other.caught,
        });
    }
  }
  const sorted = <T>(map: Map<string, T>) =>
    Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : 1)));

  // Tokens per arm over the cases both arms may score, including a declared effort comparison,
  // and the repeats' own spread beside them. Other policy differences remain blocked.
  const scorableBoth = pairable;
  const floorPairs = baseline.floor.map((pair) => {
    const [a, b] = pair.split(":") as [string, string];
    return {
      pair,
      ratios: tokenRatios(
        baseline.cases.flatMap((c) => {
          const x = c.runs.find((r) => r.run === a);
          const y = c.runs.find((r) => r.run === b);
          return x === undefined || y === undefined ? [] : [[x, y] as const];
        }),
      ),
    };
  });
  const dumpTokens = rows.flatMap(({ next }) =>
    next.capture !== null && "tokens" in next.capture
      ? [next.capture.tokens]
      : [],
  );

  // The capture: each read's status, its gaps by kind, and what each execution gap means here.
  const captureStatus: Record<string, number> = {};
  const gaps: Record<string, { kind: string; meaning: string; cases: number }> =
    {};
  for (const { next } of rows) {
    const status = next.capture?.status ?? "none";
    captureStatus[status] = (captureStatus[status] ?? 0) + 1;
    if (next.capture !== null && "gaps" in next.capture)
      for (const gap of next.capture.gaps) {
        const meaning =
          gap.kind === "capture" ? "capture incomplete" : "execution open";
        const held = gaps[gap.code] ?? { kind: gap.kind, meaning, cases: 0 };
        held.cases++;
        gaps[gap.code] = held;
      }
  }

  const unavailable = new Map<
    string,
    { threads: number; unlabelled: number }
  >();
  for (const { base } of rows) {
    const held = unavailable.get(base.source) ?? { threads: 0, unlabelled: 0 };
    held.threads += base.threads.rows;
    held.unlabelled += base.threads.unlabelled;
    unavailable.set(base.source, held);
  }

  const evidence: Array<string> = [];
  const lostHere = rows.filter(
    ({ first, next }) =>
      first.blockers.length === 0 && next.blockers.length > 0,
  );
  for (const { base, next } of lostHere)
    evidence.push(
      `${base.caseId}: the baseline completed, the candidate may not be scored (${next.blockers.join("; ")})`,
    );
  const down = flips.filter((flip) => flip.baseline && !flip.candidate);
  if (down.length > 0)
    evidence.push(
      `${down.length} paired concern(s) the baseline caught and the candidate missed (${flips.length - down.length} the other way): ${down
        .map((flip) => `${flip.caseId} ${flip.ref} (${flip.kind})`)
        .join(", ")}`,
    );
  for (const [group, row] of Object.entries(parity.bySource))
    if (row.falls) evidence.push(`source ${group} falls beyond its bar`);
  for (const [group, row] of Object.entries(parity.byKind))
    if (row.falls) evidence.push(`kind ${group} falls beyond its bar`);
  for (const [name, guard] of Object.entries(parity.guards))
    if (guard.rises) evidence.push(`guard ${name} rises`);
  if (parity.unpaired > 0)
    evidence.push(`${parity.unpaired} concern(s) are in one arm's mix only`);
  if (total.candidate.notInMix > 0)
    evidence.push(
      `${total.candidate.notInMix} concern(s) of the baseline's mix are absent from the candidate's`,
    );
  for (const [code, gap] of Object.entries(gaps))
    evidence.push(
      `${gap.cases} candidate capture(s) disclose ${code} (${gap.meaning})`,
    );
  if (unknownMix.length > 0)
    evidence.push(
      `${unknownMix.length} case(s) have no matched first run: ${unknownMix.join(", ")}`,
    );

  return {
    kind: "neuve.candidate-comparison",
    version: 1,
    run,
    ...(effortComparison === undefined
      ? {}
      : {
          effortComparison,
          efforts: {
            baseline: [
              ...new Set(
                rows.flatMap(({ first }) =>
                  first.route === null ? [] : [first.route.effort],
                ),
              ),
            ].sort(),
            candidate: [
              ...new Set(
                rows.flatMap(({ next }) =>
                  next.route === null ? [] : [next.route.effort],
                ),
              ),
            ].sort(),
          },
        }),
    manifests: identity,
    sample: { path: baseline.sample.path, sha256: baseline.sample.sha256 },
    floor: baseline.floor,
    cases: rows.length,
    identity: {
      baseline: identityOf(rows.map(({ first }) => first)),
      candidate: identityOf(rows.map(({ next }) => next)),
    },
    execution: {
      baseline: baseline.counts["first"],
      candidate: candidate.counts[run],
    },
    capture: { status: captureStatus, gaps },
    denominator: {
      note: "Every sample concern case; a run that may not be scored counts its concerns lost. Controls are left out, as the parity method leaves them out of caught.",
      total,
      bySource: sorted(bySource),
      byKind: sorted(byKind),
      unknownMix,
    },
    unavailableLabels: {
      note: "Reviewer threads with no majority label: outside every count, never read as missed.",
      bySource: sorted(unavailable),
    },
    flips,
    tokens: {
      note: "Receipt totals over the cases both arms may score; the floor's spread is the same ratio between repeat runs of one build, both completed. No price.",
      baseline: tokenTotals(scorableBoth.map(({ first }) => first)),
      candidate: tokenTotals(scorableBoth.map(({ next }) => next)),
      ratios: tokenRatios(
        scorableBoth.map(({ first, next }) => [first, next] as const),
      ),
      floor: floorPairs,
      candidateDump: {
        runs: dumpTokens.length,
        input: dumpTokens.reduce((sum, t) => sum + t.input, 0),
        output: dumpTokens.reduce((sum, t) => sum + t.output, 0),
        cacheRead: dumpTokens.reduce((sum, t) => sum + t.cacheRead, 0),
      },
    },
    parity,
    floorFailed,
    unresolved: evidence,
    notes: [
      "This report claims no acceptance: parity's verdict is the climb's existing reading, and the owner's full run decides.",
      "Labels were read here as analysis only; no label reaches a review machine or a reviewer's prompt.",
    ],
  };
};

export type CandidateComparison = Awaited<ReturnType<typeof compareCandidate>>;

const outcomeRow = (name: string, row: { baseline: Tally; candidate: Tally }) =>
  `| ${name} | ${row.baseline.caught} | ${row.baseline.missed} | ${row.baseline.lost} | ${row.candidate.caught} | ${row.candidate.missed} | ${row.candidate.lost} | ${row.candidate.notInMix} |`;

/** The report as a page: the same figures as compare.json, nothing added. */
export const reportMarkdown = (report: CandidateComparison) => {
  const efforts = report.efforts;
  const baseline =
    efforts === undefined
      ? "Baseline"
      : `Baseline (${efforts.baseline.join(", ") || "unknown"} effort)`;
  const candidate =
    efforts === undefined
      ? "Candidate"
      : `Candidate (${efforts.candidate.join(", ") || "unknown"} effort)`;
  const header = `| Group | ${baseline} caught | ${baseline} missed | ${baseline} lost | ${candidate} caught | ${candidate} missed | ${candidate} lost | ${candidate} not in mix |\n| --- | --- | --- | --- | --- | --- | --- | --- |`;
  const caught = report.parity.caught as {
    baseline?: unknown;
    candidate?: unknown;
    delta?: unknown;
    interval?: unknown;
    bar?: unknown;
  };
  return [
    efforts === undefined
      ? `# ${report.run} against the replay's first runs`
      : `# ${report.run}, declared ${report.effortComparison} effort, against the replay's first runs (${efforts.baseline.join(", ") || "unknown"} effort)`,
    "",
    `Sample ${report.sample.path} (sha256 ${report.sample.sha256}), ${report.cases} cases. Floor ${report.floor.join(", ")}.`,
    `Baseline manifest ${report.manifests.baseline.path} (sha256 ${report.manifests.baseline.sha256}). Candidate manifest ${report.manifests.candidate.path} (sha256 ${report.manifests.candidate.sha256}).`,
    "",
    "## Execution",
    "",
    "```json",
    JSON.stringify(report.execution, null, 2),
    "```",
    "",
    "## Capture",
    "",
    "```json",
    JSON.stringify(report.capture, null, 2),
    "```",
    "",
    "## Every concern case in the denominator",
    "",
    header,
    outcomeRow("All", report.denominator.total),
    ...Object.entries(report.denominator.bySource).map(([name, row]) =>
      outcomeRow(`source ${name}`, row),
    ),
    ...Object.entries(report.denominator.byKind).map(([name, row]) =>
      outcomeRow(`kind ${name}`, row),
    ),
    "",
    "## The parity method's paired comparison",
    "",
    `Caught: baseline ${String(caught.baseline)}, candidate ${String(caught.candidate)}, delta ${String(caught.delta)}, interval ${JSON.stringify(caught.interval)}, bar ${String(caught.bar)}. Verdict (the climb's existing reading): ${JSON.stringify(report.parity.verdict)}.`,
    "",
    efforts === undefined
      ? "## Tokens"
      : `## Tokens: ${baseline}; ${candidate}`,
    "",
    "```json",
    JSON.stringify(report.tokens, null, 2),
    "```",
    "",
    "## Unresolved evidence",
    "",
    ...(report.unresolved.length === 0
      ? ["None listed."]
      : report.unresolved.map((line) => `- ${line}`)),
    "",
    ...report.notes.map((note) => `${note}`),
    "",
  ].join("\n");
};
