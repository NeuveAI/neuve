import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import {
  ownedLineKeys,
  packetUnits,
  readableRun,
  READS_SECTIONS,
  type Lane,
  type PacketLite,
} from "./packets.ts";
import {
  AFTER_MERGE_PREFIX,
  REPLAY_EVIDENCE_VERSION,
  ReplayLineEvidence,
  type EvidenceClass,
} from "./replay-evidence.ts";
import { agreement, type Rated } from "./stats.ts";
import { AfterMergeRecord } from "../../pr-replay/aftermerge.ts";

/**
 * The replay key (10.124–10.128): the lanes climb's second answer key, from replayed pull requests
 * whose later history shows which changed lines needed a person. It is read beside the owner's key
 * and never pooled with it: it never enters the owner's key, the guard, `carriedKey` or
 * `carriedOwnerUnits`. Its measures are reported per era and per split, never across eras, and the
 * held-out split only when asked for.
 *
 * The evidence records are `replay-evidence.ts`'s, the one schema authority. A line with no
 * evidence, or one held back because a thread on it has no majority class (10.135), is absent:
 * silence is never judged against. `coverage.disputed` counts the held-back lines.
 */

/**
 * What each evidence class means as a lane: decided (10.128), and kept in this one table so a later
 * ruling changes one place. A line with no evidence has no label.
 */
export const REPLAY_LANES: Readonly<Record<EvidenceClass, Lane>> = {
  "needs-person": "human-required",
  discussed: "human-suggested",
  "agent-catchable": "agentic",
  mechanical: "static-automation",
};

/** Classes from the least to the most demanding, for a unit that holds lines of several. */
const CLASS_ORDER: ReadonlyArray<EvidenceClass> = [
  "mechanical",
  "agent-catchable",
  "discussed",
  "needs-person",
];
const LANE_ORDER: ReadonlyArray<Lane> = [
  "static-automation",
  "agentic",
  "human-suggested",
  "human-required",
];

/** One unit of a replay run, as the measure reads it: its range, lane and owned line keys. */
export interface ReplayCall {
  readonly unit: string;
  readonly title: string;
  readonly range: string;
  readonly harness: Lane | null;
  readonly lines: ReadonlyArray<string>;
}

/** Evidence files read and checked against the schema, with what the round records of them. */
export const readEvidence = (paths: ReadonlyArray<string>) => {
  const files: Array<{ path: string; sha256: string }> = [];
  const evidence: Array<ReplayLineEvidence> = [];
  for (const path of paths) {
    const bytes = readFileSync(path);
    files.push({
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    for (const record of Array.isArray(parsed) ? parsed : [parsed]) {
      // A file of another version, or a broken one, names itself: there may be hundreds.
      const checked = ReplayLineEvidence.safeParse(record);
      if (!checked.success)
        throw new Error(
          `${path}: not replay line evidence v${REPLAY_EVIDENCE_VERSION}: ${checked.error.message.slice(0, 500)}`,
        );
      evidence.push(checked.data);
    }
  }
  const ranges = evidence.map((record) => record.range);
  const repeated = ranges.filter(
    (range, index) => ranges.indexOf(range) !== index,
  );
  if (repeated.length > 0)
    throw new Error(
      `evidence names ${[...new Set(repeated)].join(", ")} more than once`,
    );
  return { files, evidence };
};

/** A commit's kind after merge, as the replay thread's majority judged it (null: none). */
type CommitKind = AfterMergeRecord["commits"][number]["kind"];

/** What each commit after merge was, per case: the replay thread's records, read with its schema. */
export type AfterMergeKinds = ReadonlyMap<
  string,
  ReadonlyMap<string, CommitKind>
>;

/** After-merge records read and checked against their schema, hashed, and never two for a case. */
export const readAfterMerge = (paths: ReadonlyArray<string>) => {
  const files: Array<{ path: string; sha256: string }> = [];
  const kinds = new Map<string, Map<string, CommitKind>>();
  for (const path of paths) {
    const bytes = readFileSync(path);
    files.push({
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    for (const record of Array.isArray(parsed) ? parsed : [parsed]) {
      const checked = AfterMergeRecord.safeParse(record);
      if (!checked.success)
        throw new Error(
          `${path}: not an after-merge record: ${checked.error.message.slice(0, 500)}`,
        );
      if (kinds.has(checked.data.caseId))
        throw new Error(
          `after-merge records name ${checked.data.caseId} more than once`,
        );
      kinds.set(
        checked.data.caseId,
        new Map(checked.data.commits.map((c) => [c.commit, c.kind])),
      );
    }
  }
  return { files, kinds };
};

/**
 * What a needs-a-person line's evidence comes from. `thread`: a person's concern at review, which
 * the lanes climb can act on at the first revision; `fix`: a fix after merge of the lines it touched;
 * `revert`: a revert, which undoes the whole change and so marks every line, reported apart as the
 * history signal (10.123) and never in the headline; `after-merge`: a commit after merge whose kind
 * no record gives; `unattributed`: no concern named.
 */
export type EvidenceOrigin =
  "thread" | "fix" | "revert" | "after-merge" | "unattributed";

export const originOf = (
  record: Pick<ReplayLineEvidence, "caseId">,
  concerns: ReadonlyArray<string>,
  afterMerge: AfterMergeKinds | undefined,
): EvidenceOrigin => {
  if (concerns.length === 0) return "unattributed";
  // A line a person raised at review is the thread's, whatever happened after merge.
  if (concerns.some((concern) => !concern.startsWith(AFTER_MERGE_PREFIX)))
    return "thread";
  const kinds = afterMerge?.get(record.caseId);
  const of = concerns.map((concern) =>
    kinds?.get(concern.slice(AFTER_MERGE_PREFIX.length)),
  );
  return of.includes("fix")
    ? "fix"
    : of.includes("revert")
      ? "revert"
      : "after-merge";
};

/** The replay key: every labelled line as `<range>|<line>`, mapped to its lane. */
export const replayKey = (
  evidence: ReadonlyArray<ReplayLineEvidence>,
  mapping: Readonly<Record<EvidenceClass, Lane>> = REPLAY_LANES,
): Record<string, Lane> =>
  Object.fromEntries(
    evidence.flatMap((record) =>
      Object.entries(record.lines).map(
        ([line, entry]) =>
          [`${record.range}|${line}`, mapping[entry.class]] as const,
      ),
    ),
  );

const share = (part: number, whole: number) =>
  whole === 0 ? null : Math.round((part / whole) * 1_000) / 1_000;

const atLeast = (lane: Lane | null | undefined, floor: Lane) =>
  lane !== null &&
  lane !== undefined &&
  LANE_ORDER.indexOf(lane) >= LANE_ORDER.indexOf(floor);

/** The measures over one group of cases (one era and split): the replay key's counterpart of a round. */
const groupMeasures = (
  calls: ReadonlyArray<ReplayCall>,
  cases: ReadonlyArray<ReplayLineEvidence>,
  mapping: Readonly<Record<EvidenceClass, Lane>>,
  afterMerge: AfterMergeKinds | undefined,
) => {
  const ranges = new Set(cases.map((record) => record.range));
  // A unit the harness never assessed has no lane to judge: it is counted apart, never as lower.
  const inCases = calls.filter((call) => ranges.has(call.range));
  const owned = inCases.filter((call) => call.harness !== null);
  const unassessed = inCases.length - owned.length;
  const unassessedLines = new Set(
    inCases
      .filter((call) => call.harness === null)
      .flatMap((call) => call.lines.map((line) => `${call.range}|${line}`)),
  );
  const laneOf = new Map<string, ReplayCall>();
  for (const call of owned)
    for (const line of call.lines) laneOf.set(`${call.range}|${line}`, call);
  const labelled = cases.flatMap((record) =>
    Object.entries(record.lines)
      .map(([line, entry]) => ({
        key: `${record.range}|${line}`,
        entry,
        record,
      }))
      .filter(({ key }) => laneOf.has(key)),
  );
  const ofClass = (...classes: ReadonlyArray<EvidenceClass>) =>
    labelled.filter(({ entry }) => classes.includes(entry.class));
  // Escalation recall: the replay counterpart of the guard, reported and never gating (10.128).
  // Its headline leaves out reverts, which mark a whole change; they are reported apart.
  const needing = ofClass("needs-person").map((line) => ({
    ...line,
    origin: originOf(line.record, line.entry.concerns, afterMerge),
  }));
  const needs = needing.filter(({ origin }) => origin !== "revert");
  const recall = (lines: typeof needing) => {
    const kept = (floor: Lane) => (key: string) =>
      atLeast(laneOf.get(key)!.harness, floor);
    // Per unit and per case beside lines, so a few large cases cannot carry the figure.
    const grouped = (by: (line: (typeof needing)[number]) => string) => {
      const groups = new Map<string, Array<string>>();
      for (const line of lines)
        groups.set(by(line), [...(groups.get(by(line)) ?? []), line.key]);
      return [...groups.values()];
    };
    const units = grouped(
      ({ key }) => `${laneOf.get(key)!.range}|${laneOf.get(key)!.unit}`,
    );
    const ofCases = grouped(({ record }) => record.range);
    const mean = (values: ReadonlyArray<number>) =>
      values.length === 0
        ? null
        : Math.round(
            (values.reduce((sum, value) => sum + value, 0) / values.length) *
              1_000,
          ) / 1_000;
    return {
      lines: lines.length,
      required: share(
        lines.filter(({ key }) => kept("human-required")(key)).length,
        lines.length,
      ),
      suggestedOrHigher: share(
        lines.filter(({ key }) => kept("human-suggested")(key)).length,
        lines.length,
      ),
      units: {
        units: units.length,
        required: share(
          units.filter(([key]) => kept("human-required")(key!)).length,
          units.length,
        ),
        suggestedOrHigher: share(
          units.filter(([key]) => kept("human-suggested")(key!)).length,
          units.length,
        ),
        // The counts behind both shares, so cases can be summed and resampled.
        kept: {
          required: units.filter(([key]) => kept("human-required")(key!))
            .length,
          suggestedOrHigher: units.filter(([key]) =>
            kept("human-suggested")(key!),
          ).length,
        },
      },
      // Each case's own share, averaged over the cases.
      cases: {
        cases: ofCases.length,
        required: mean(
          ofCases.map(
            (keys) => keys.filter(kept("human-required")).length / keys.length,
          ),
        ),
        suggestedOrHigher: mean(
          ofCases.map(
            (keys) => keys.filter(kept("human-suggested")).length / keys.length,
          ),
        ),
      },
    };
  };
  const byOrigin = Object.fromEntries(
    (["thread", "fix", "revert", "after-merge", "unattributed"] as const)
      .map(
        (origin) =>
          [
            origin,
            recall(needing.filter((line) => line.origin === origin)),
          ] as const,
      )
      .filter(([, measured]) => measured.lines > 0),
  );
  const headline = recall(needs);
  const lower = needs.filter(
    ({ key }) => laneOf.get(key)!.harness !== "human-required",
  );
  const byUnit = new Map<
    string,
    {
      unit: string;
      title: string;
      harness: Lane | null;
      lines: number;
      concerns: Set<string>;
    }
  >();
  for (const { key, entry } of lower) {
    const call = laneOf.get(key)!;
    const held = byUnit.get(call.unit) ?? {
      unit: call.unit,
      title: call.title,
      harness: call.harness,
      lines: 0,
      concerns: new Set<string>(),
    };
    held.lines++;
    entry.concerns.forEach((concern) => held.concerns.add(concern));
    byUnit.set(call.unit, held);
  }
  const easy = ofClass("agent-catchable", "mechanical");
  // Agreement leaves revert lines out as recall does (10.123): a revert marks a whole change, so
  // its lines are a row of their own, and a unit never takes its class from them.
  const reverted = new Set(
    needing.filter(({ origin }) => origin === "revert").map(({ key }) => key),
  );
  const judged = labelled.filter(({ key }) => !reverted.has(key));
  const inLane = ({ key, entry }: (typeof labelled)[number]) =>
    laneOf.get(key)!.harness === mapping[entry.class];
  const agree = judged.filter(inLane);
  const revertLines = labelled.filter(({ key }) => reverted.has(key));
  /** A unit's labelled classes, without revert lines. */
  const classesOf = (call: ReplayCall) => {
    const record = cases.find((c) => c.range === call.range);
    return call.lines.flatMap((line) => {
      const entry = record?.lines[line];
      return entry === undefined || reverted.has(`${call.range}|${line}`)
        ? []
        : [entry.class];
    });
  };
  // A unit takes the most demanding class among its labelled lines.
  const pairs: Array<Rated> = owned.flatMap((call) => {
    const classes = classesOf(call);
    if (classes.length === 0 || call.harness === null) return [];
    const top = classes.reduce((a, b) =>
      CLASS_ORDER.indexOf(b) > CLASS_ORDER.indexOf(a) ? b : a,
    );
    const record = cases.find((c) => c.range === call.range)!;
    return [
      {
        family: record.family,
        caseId: record.caseId,
        x: mapping[top],
        y: call.harness,
      },
    ];
  });
  // Over-escalation per unit: a human-required unit whose labelled lines are all ones an agent or
  // automation could take, with how much of the unit is labelled at all (silence is not a label).
  const requiredLabelled = owned
    .filter((call) => call.harness === "human-required")
    .map((call) => ({ call, classes: classesOf(call) }))
    .filter(({ classes }) => classes.length > 0);
  const overUnits = requiredLabelled.filter(({ classes }) =>
    classes.every((c) => c === "agent-catchable" || c === "mechanical"),
  );
  // Each control kind's units sent to a person (10.128's controls measure over-escalation).
  const controls = Object.fromEntries(
    [...new Set(cases.flatMap((c) => (c.control === null ? [] : [c.control])))]
      .sort()
      .map((kind) => {
        const ranges = new Set(
          cases.filter((c) => c.control === kind).map((c) => c.range),
        );
        const units = owned.filter((call) => ranges.has(call.range));
        return [
          kind,
          {
            cases: ranges.size,
            units: units.length,
            required: share(
              units.filter((call) => call.harness === "human-required").length,
              units.length,
            ),
            suggestedOrHigher: share(
              units.filter((call) => atLeast(call.harness, "human-suggested"))
                .length,
              units.length,
            ),
          },
        ];
      }),
  );
  const quiet = new Set(
    cases.filter((c) => c.control === "quiet").map((c) => c.range),
  );
  const quietCalls = owned.filter((call) => quiet.has(call.range));
  const quietLines = quietCalls.flatMap((call) =>
    call.lines.map(() => call.harness),
  );
  const ownedLines = owned.reduce((sum, call) => sum + call.lines.length, 0);
  return {
    cases: cases.length,
    escalationRecall: {
      needsPerson: needs.length,
      required: share(needs.length - lower.length, needs.length),
      suggestedOrHigher: share(
        needs.filter(({ key }) =>
          atLeast(laneOf.get(key)!.harness, "human-suggested"),
        ).length,
        needs.length,
      ),
      lower: [...byUnit.values()].map((held) => ({
        ...held,
        concerns: [...held.concerns].sort(),
      })),
      units: headline.units,
      cases: headline.cases,
      byOrigin,
      // Reverts are apart only when every after-merge line's kind is known: a line of unknown kind
      // (no record for its case, or none given) stays in the headline and may be a revert.
      revertsApart: !("after-merge" in byOrigin),
    },
    overEscalation: {
      lines: easy.length,
      required: share(
        easy.filter(({ key }) => laneOf.get(key)!.harness === "human-required")
          .length,
        easy.length,
      ),
      units: {
        units: overUnits.length,
        // Those that also hold revert lines: the history signal beside the headline (10.123).
        withReverts: overUnits.filter(({ call }) =>
          call.lines.some((line) => reverted.has(`${call.range}|${line}`)),
        ).length,
        of: requiredLabelled.length,
        share: share(overUnits.length, requiredLabelled.length),
        labelledShare:
          overUnits.length === 0
            ? null
            : Math.round(
                (overUnits.reduce(
                  (sum, { call, classes }) =>
                    sum + classes.length / call.lines.length,
                  0,
                ) /
                  overUnits.length) *
                  1_000,
              ) / 1_000,
      },
    },
    lineAgreement: {
      judged: judged.length,
      agree: agree.length,
      share: share(agree.length, judged.length),
      byClass: Object.fromEntries(
        CLASS_ORDER.map((evidenceClass) => {
          const of = judged.filter(
            ({ entry }) => entry.class === evidenceClass,
          );
          const ok = of.filter(inLane);
          return [
            evidenceClass,
            {
              judged: of.length,
              agree: ok.length,
              share: share(ok.length, of.length),
            },
          ];
        }),
      ),
      // The history signal's own row: revert lines in human-required.
      reverts: {
        judged: revertLines.length,
        agree: revertLines.filter(inLane).length,
        share: share(revertLines.filter(inLane).length, revertLines.length),
      },
    },
    unitAgreement:
      pairs.length === 0 ? null : agreement(pairs, { resamples: 1_000 }),
    quietControls: {
      units: share(
        quietCalls.filter((call) => call.harness === "human-required").length,
        quietCalls.length,
      ),
      lines: share(
        quietLines.filter((lane) => lane === "human-required").length,
        quietLines.length,
      ),
    },
    controls,
    coverage: {
      judged: labelled.length,
      owned: ownedLines,
      disputed: cases.reduce((sum, record) => sum + record.disputed, 0),
      unassessedUnits: unassessed,
      // Needs-a-person lines only units with no assessment own: no measure judges them, while the
      // packet shows such a unit to a person as human-suggested (a fixed-shape fallback).
      unassessedNeedsPerson: cases.reduce(
        (sum, record) =>
          sum +
          Object.entries(record.lines).filter(
            ([line, entry]) =>
              entry.class === "needs-person" &&
              !laneOf.has(`${record.range}|${line}`) &&
              unassessedLines.has(`${record.range}|${line}`),
          ).length,
        0,
      ),
    },
  };
};

/**
 * The replay key's measures per era and per split, never pooled. A run's units are matched to
 * evidence by range; held-out cases are measured only when `heldOut` asks for them.
 */
export const replayMeasures = (
  calls: ReadonlyArray<ReplayCall>,
  evidence: ReadonlyArray<ReplayLineEvidence>,
  options: {
    readonly mapping?: Readonly<Record<EvidenceClass, Lane>> | undefined;
    readonly heldOut?: boolean | undefined;
    /** What each commit after merge was, so fixes and reverts are told apart. */
    readonly afterMerge?: AfterMergeKinds | undefined;
  } = {},
) => {
  const mapping = options.mapping ?? REPLAY_LANES;
  const byEra: Record<
    string,
    Record<string, ReturnType<typeof groupMeasures>>
  > = {};
  for (const record of evidence) {
    if (record.split === "held-out" && options.heldOut !== true) continue;
    (byEra[record.era] ??= {})[record.split] = groupMeasures(
      calls,
      evidence.filter((r) => r.era === record.era && r.split === record.split),
      mapping,
      options.afterMerge,
    );
  }
  return byEra;
};

/**
 * The replay runs of one round are one run per case: two runs of a case would mix their lanes line
 * by line, so they are refused, and the floor's second runs must be of exactly the same cases, each
 * once (as the owner's floor requires).
 */
export const checkReplayRanges = (
  first: ReadonlyArray<string>,
  against: ReadonlyArray<string>,
) => {
  const repeated = (ranges: ReadonlyArray<string>) => [
    ...new Set(
      ranges.filter((range, index) => ranges.indexOf(range) !== index),
    ),
  ];
  if (repeated(first).length > 0)
    throw new Error(
      `two replay runs of ${repeated(first).join(", ")} in one round; give the second to --replay-against`,
    );
  if (against.length === 0) return;
  if (
    repeated(against).length > 0 ||
    [...against].sort().join() !== [...first].sort().join()
  )
    throw new Error(
      `--replay-against names runs of ${against.join(", ")}, not one each of this round's ${first.join(", ")}`,
    );
};

/** A replay run's units, read from its packet: no owner answers, its own range. */
export const replayCalls = (
  shown: { readonly packet: PacketLite | null },
  range: string,
): Array<ReplayCall> =>
  // A unit's lane and owned lines only, so the sections shape reads too.
  packetUnits(shown.packet, {
    where: `the replay run of ${range}`,
    reads: READS_SECTIONS,
  }).map(({ unit }) => ({
    unit: unit.unitId,
    title: unit.recorded?.payload.title ?? unit.unitId,
    range,
    harness: unit.assessment?.payload.lane ?? null,
    lines: [...ownedLineKeys(unit)],
  }));

/** A repository's git common directory, resolved: shared by its main checkout and every worktree. */
const commonDirectory = (repository: string) =>
  realpathSync(
    execFileSync(
      "git",
      [
        "-C",
        repository,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ],
      { encoding: "utf8" },
    ).trim(),
  );

/**
 * Refuses a case clone that is the owner's repository: its main checkout or any linked worktree of
 * it, which share its git common directory and so its Records store. A research run is read only
 * from its own case clone (10.125), never the owner's store.
 */
export const assertNotOwnerRepository = (
  caseClone: string,
  ownerRepository: string,
) => {
  if (caseClone.trim() === "")
    throw new Error("a replay run names no case clone");
  if (commonDirectory(caseClone) === commonDirectory(ownerRepository))
    throw new Error(
      `${caseClone} shares the owner's repository (${commonDirectory(ownerRepository)}); a replay run is read only from its own case clone`,
    );
};

/**
 * A research run's `review show --json`, read from its case clone under the research HOME, never the
 * owner's store; or a file the replay thread wrote of it.
 */
export const readReplayRun = (
  source:
    | { readonly packet: string }
    | {
        readonly run: string;
        readonly repository: string;
        readonly home?: string | undefined;
      },
  ownerRepository: string,
) => {
  if (!("packet" in source))
    assertNotOwnerRepository(source.repository, ownerRepository);
  // Through the eval's guard (packets.ts `readableRun`), named by its file or its run and clone.
  return readableRun(
    JSON.parse(
      "packet" in source
        ? readFileSync(source.packet, "utf8")
        : execFileSync(
            "neuve",
            [
              "review",
              "show",
              "--run",
              source.run,
              "--json",
              "--repo",
              source.repository,
            ],
            {
              encoding: "utf8",
              maxBuffer: 512 * 1024 * 1024,
              env:
                source.home === undefined
                  ? process.env
                  : { ...process.env, HOME: source.home },
            },
          ),
    ) as {
      packet: PacketLite | null;
      runId?: string;
      range?: { baseOid?: string; headOid?: string };
    },
    "packet" in source
      ? source.packet
      : `replay run ${source.run} in ${source.repository}`,
    READS_SECTIONS,
  );
};
