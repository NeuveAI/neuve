import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { FULL_TEST_RESULTS } from "./config.ts";
import {
  isSectionsShape,
  ownedLineKeys,
  packetUnits,
  readableRun,
  READS_SECTIONS,
  READS_TODAY,
  type Lane,
  type Reads,
  type PacketLite,
} from "./packets.ts";
import { agreement, cohensKappa, type Rated } from "./stats.ts";
import { describeTitles, titleCheck, type ShownTitles } from "./titles.ts";
import {
  checkReplayRanges,
  readEvidence,
  readReplayRun,
  readAfterMerge,
  replayCalls,
  replayMeasures,
  type ReplayCall,
} from "./lanes-replay.ts";

/**
 * The lanes climb's measure (10.109): the owner's lane for a unit, against the harness's, per unit
 * and per changed line. Units change shape between rounds, so the answer key is kept per line: each
 * changed line takes the lane the owner gave the unit that owned it, keyed by the reviewed range, so a
 * later round over the same range is judged line by line against every earlier answer.
 *
 * - The guard: no line the owner placed human-required sits in a lower lane. A round that drops one
 *   does not count.
 * - Agreement: per unit with the owner's answers on this round, and per line against the carried key.
 * - The share sent to a person: the human-required share of the harness's units and changed lines.
 *
 * Inputs are what Neuve already records: the run's packet (`neuve review show --run <id> --json`) and
 * the owner's desk feedback (`neuve records feedback --cycle <id>`), or the end-to-end check's sheet
 * and its answers for the baseline. Nothing here runs a review or writes to a store.
 */

export const LANES = [
  "static-automation",
  "agentic",
  "human-suggested",
  "human-required",
] as const satisfies ReadonlyArray<Lane>;

/** One unit as the measure sees it: the harness's lane, the owner's, and the lines it owned. */
export interface LaneCall {
  readonly unit: string;
  readonly title: string;
  readonly range: string;
  readonly harness: Lane | null;
  readonly owner: Lane | null;
  readonly lines: ReadonlyArray<string>;
}

/** The per-line answer key a round leaves for later rounds: `<range>|<path>:<side>:<line>` → lane. */
export type LineKey = Readonly<Record<string, Lane>>;

const isLane = (value: unknown): value is Lane =>
  typeof value === "string" && (LANES as ReadonlyArray<string>).includes(value);

const lineKey = (range: string, line: string) => `${range}|${line}`;

/**
 * One name for a reviewed range wherever it comes from: the sheet's case ID (\`repo:78c53866..a22445b9\`)
 * and a run's receipt (two full commit IDs) both become the first 8 hex digits of each end, so a
 * later round over the same range meets every earlier answer.
 */
export const rangeIdentity = (text: string) => {
  const match = /([0-9a-f]{7,64})\.\.([0-9a-f]{7,64})/i.exec(text);
  return match === null
    ? text
    : `${match[1]!.slice(0, 8).toLowerCase()}..${match[2]!.slice(0, 8).toLowerCase()}`;
};

/** An answer's lane: the final one where the owner corrected it, else the first. */
const answeredLane = (entry: {
  readonly first?: { readonly lane?: unknown } | null;
  readonly final?: { readonly lane?: unknown } | null;
}): Lane | null =>
  isLane(entry.final?.lane)
    ? entry.final.lane
    : isLane(entry.first?.lane)
      ? entry.first.lane
      : null;

/** The desk round: every unit of the packet, with the owner's lane where the feedback answers it. */
export const deskCalls = (
  shown: { readonly packet: PacketLite | null },
  feedback: { readonly answers?: Readonly<Record<string, unknown>> },
  range: string,
): Array<LaneCall> => {
  const owner = new Map<string, Lane | null>();
  for (const value of Object.values(feedback.answers ?? {})) {
    const entry = value as {
      kind?: string;
      unitId?: string;
      first?: { lane?: unknown };
      final?: { lane?: unknown };
    };
    if (entry.kind === "unit" && typeof entry.unitId === "string")
      owner.set(entry.unitId, answeredLane(entry));
  }
  // The desk round reads a unit's lane and owned lines only, so it reads the sections shape too.
  return packetUnits(shown.packet, {
    where: `the run of ${range}`,
    reads: READS_SECTIONS,
  }).map(({ unit }) => ({
    unit: unit.unitId,
    title: unit.recorded?.payload.title ?? unit.unitId,
    range,
    harness: unit.assessment?.payload.lane ?? null,
    owner: owner.get(unit.unitId) ?? null,
    lines: [...ownedLineKeys(unit)],
  }));
};

/** A sheet's owned-lines entry, "path (side) start-end" (the side marks a new or old file too), as line keys. */
export const sheetLines = (entry: string): Array<string> => {
  const match = /^(.*) \((new|old|deleted)\) (\d+)(?:-(\d+))?$/.exec(
    entry.trim(),
  );
  if (match === null) return [];
  const side = match[2] === "old" || match[2] === "deleted" ? "old" : "new";
  const start = Number(match[3]);
  const end = Number(match[4] ?? match[3]);
  return Array.from(
    { length: Math.max(0, end - start + 1) },
    (_, i) => `${match[1]}:${side}:${start + i}`,
  );
};

/** The baseline: the end-to-end check's sheet units with the owner's sheet answers. */
export const sheetCalls = (
  sheet: {
    readonly items: ReadonlyArray<{
      readonly id: string;
      readonly kind: string;
      readonly caseId?: string;
      readonly unitId?: string;
      readonly question?: {
        readonly title: string;
        /** As the sheet prints them: "path (new) 1-751", or "path (old) 12". */
        readonly ownedLines: ReadonlyArray<string>;
      };
      readonly reveal?: { readonly lane: unknown };
    }>;
  },
  answers: { readonly answers: Readonly<Record<string, unknown>> },
): Array<LaneCall> =>
  sheet.items
    .filter((item) => item.kind === "unit" || item.kind === "phase-a-unit")
    .map((item) => {
      const answer = answers.answers[item.id] as
        Parameters<typeof answeredLane>[0] | undefined;
      return {
        unit: item.unitId ?? item.id,
        title: item.question?.title ?? item.id,
        range: rangeIdentity(item.caseId ?? ""),
        harness: isLane(item.reveal?.lane) ? item.reveal.lane : null,
        owner: answer === undefined ? null : answeredLane(answer),
        lines: (item.question?.ownedLines ?? []).flatMap(sheetLines),
      };
    });

const share = (part: number, whole: number) =>
  whole === 0 ? null : Math.round((part / whole) * 1_000) / 1_000;

/** A unit the owner placed human-required, with its lines: what the guard judges a round by. */
export interface OwnerUnit {
  readonly range: string;
  readonly unit: string;
  readonly title: string;
  readonly lines: ReadonlyArray<string>;
}

/** A round's measures over its calls, against the key earlier rounds left for the same ranges. */
export const laneMeasures = (
  calls: ReadonlyArray<LaneCall>,
  carried: LineKey = {},
  earlierUnits: ReadonlyArray<OwnerUnit> = [],
) => {
  const answered = calls.filter(
    (call) => call.owner !== null && call.harness !== null,
  );
  const pairs: Array<Rated> = answered.map((call) => ({
    family: call.range,
    caseId: call.range,
    x: call.owner!,
    y: call.harness!,
  }));
  const confusion: Record<string, Record<string, number>> = {};
  for (const call of answered) {
    const row = (confusion[`owner ${call.owner}`] ??= {});
    row[`harness ${call.harness}`] = (row[`harness ${call.harness}`] ?? 0) + 1;
  }
  // This round's own answers, then the earlier key, line by line.
  const harnessLine = new Map<string, Lane>();
  for (const call of calls)
    if (call.harness !== null)
      for (const line of call.lines)
        harnessLine.set(lineKey(call.range, line), call.harness);
  // This round's own answers; the round is judged on them over the earlier ones, and stores only
  // its own, since later rounds read every earlier round file.
  const own: Record<string, Lane> = {};
  for (const call of answered)
    for (const line of call.lines) own[lineKey(call.range, line)] = call.owner!;
  const key: Record<string, Lane> = { ...carried, ...own };
  const judged = Object.entries(key).filter(([line]) => harnessLine.has(line));
  const missedLines = judged.filter(
    ([line, lane]) =>
      lane === "human-required" && harnessLine.get(line) !== "human-required",
  );
  // Key lines the owner sends to a person that only unassessed units own: the guard cannot judge
  // them, and the packet shows such a unit as human-suggested (a fixed-shape fallback). Reported.
  const unassessedHeld = new Set(
    calls
      .filter((call) => call.harness === null)
      .flatMap((call) => call.lines.map((line) => lineKey(call.range, line))),
  );
  const unassessedLines = Object.entries(key).filter(
    ([line, lane]) =>
      lane === "human-required" &&
      !harnessLine.has(line) &&
      unassessedHeld.has(line),
  ).length;
  // The guard, per owner unit (10.123): a unit's lane follows what its change needs now, not the
  // owner's lane for a wider unit it was split from. So a unit the owner sends to a person breaks
  // the guard only when none of its lines still reach a person ("lower"); when some do and the rest
  // were split off lower ("split"), the units holding those lines go to the owner's judgement.
  const holderOf = new Map<string, LaneCall>();
  for (const call of calls)
    for (const line of call.lines)
      holderOf.set(lineKey(call.range, line), call);
  const ownerUnits = new Map<string, OwnerUnit>();
  for (const unit of [
    ...earlierUnits,
    ...answered
      .filter((call) => call.owner === "human-required")
      .map((call) => ({
        range: call.range,
        unit: call.unit,
        title: call.title,
        lines: call.lines,
      })),
  ])
    ownerUnits.set(`${unit.range}|${unit.unit}`, unit);
  const lower: Array<{ unit: string; title: string; lines: number }> = [];
  const split: Array<{
    unit: string;
    title: string;
    keptLines: number;
    lowerLines: number;
    units: Array<{
      unit: string;
      title: string;
      harness: Lane | null;
      lines: number;
    }>;
  }> = [];
  for (const unit of ownerUnits.values()) {
    // Only lines the key still sends to a person (a later adjudication may have cleared some).
    const lines = unit.lines
      .map((line) => lineKey(unit.range, line))
      .filter(
        (line) => key[line] === "human-required" && harnessLine.has(line),
      );
    const low = lines.filter(
      (line) => harnessLine.get(line) !== "human-required",
    );
    if (low.length === 0) continue;
    if (low.length === lines.length) {
      lower.push({ unit: unit.unit, title: unit.title, lines: low.length });
      continue;
    }
    const holders = new Map<
      string,
      { unit: string; title: string; harness: Lane | null; lines: number }
    >();
    for (const line of low) {
      const holder = holderOf.get(line)!;
      const held = holders.get(holder.unit) ?? {
        unit: holder.unit,
        title: holder.title,
        harness: holder.harness,
        lines: 0,
      };
      held.lines++;
      holders.set(holder.unit, held);
    }
    split.push({
      unit: unit.unit,
      title: unit.title,
      keptLines: lines.length - low.length,
      lowerLines: low.length,
      units: [...holders.values()],
    });
  }
  const allLines = [...harnessLine.values()];
  return {
    units: calls.length,
    answered: answered.length,
    guard: {
      holds: lower.length === 0,
      lower,
      split,
      /** Every key line the owner sends to a person that sits lower, lower and split together. */
      missedLines: missedLines.length,
      /** Key lines the owner sends to a person held only by units with no assessment: not judged. */
      unassessedLines,
    },
    unitAgreement:
      answered.length === 0 ? null : agreement(pairs, { resamples: 1_000 }),
    lineAgreement: {
      judged: judged.length,
      agree: judged.filter(([line, lane]) => harnessLine.get(line) === lane)
        .length,
      share: share(
        judged.filter(([line, lane]) => harnessLine.get(line) === lane).length,
        judged.length,
      ),
    },
    sentToPerson: {
      units: share(
        calls.filter((call) => call.harness === "human-required").length,
        calls.length,
      ),
      lines: share(
        allLines.filter((lane) => lane === "human-required").length,
        allLines.length,
      ),
      ownerUnits: share(
        answered.filter((call) => call.owner === "human-required").length,
        answered.length,
      ),
    },
    confusion,
    key: own,
  };
};

/**
 * Two runs of one range, line by line, with no owner answer: the noise floor 10.109's saturation
 * rule is judged against. Units differ between runs, so lanes are compared on the lines both own.
 */
export const runAgreement = (
  a: ReadonlyArray<LaneCall>,
  b: ReadonlyArray<LaneCall>,
) => {
  const lanesOf = (calls: ReadonlyArray<LaneCall>) => {
    const lanes = new Map<string, Lane>();
    for (const call of calls)
      if (call.harness !== null)
        for (const line of call.lines)
          lanes.set(lineKey(call.range, line), call.harness);
    return lanes;
  };
  const left = lanesOf(a);
  const right = lanesOf(b);
  const pairs: Array<Rated> = [...left].flatMap(([line, lane]) => {
    const other = right.get(line);
    const range = line.split("|")[0]!;
    return other === undefined
      ? []
      : [{ family: range, caseId: range, x: lane, y: other }];
  });
  const stat = cohensKappa(pairs);
  const humanShare = (lanes: ReadonlyMap<string, Lane>) =>
    share(
      [...lanes.values()].filter((lane) => lane === "human-required").length,
      lanes.size,
    );
  return {
    lines: pairs.length,
    onlyFirst: [...left.keys()].filter((line) => !right.has(line)).length,
    onlySecond: [...right.keys()].filter((line) => !left.has(line)).length,
    agreement:
      stat.observed === null ? null : Math.round(stat.observed * 1_000) / 1_000,
    kappa: stat.kappa === null ? null : Math.round(stat.kappa * 1_000) / 1_000,
    units: { first: a.length, second: b.length },
    sentToPerson: { first: humanShare(left), second: humanShare(right) },
  };
};

export const LANES_RESULTS = join(FULL_TEST_RESULTS, "lanes");

/** Every earlier round's owner units placed human-required, from the answered units it recorded. */
export const carriedOwnerUnits = (
  except?: string,
  directory: string = LANES_RESULTS,
): Array<OwnerUnit> => {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json") && name !== `${except}.json`)
    .flatMap((name) => {
      const round = JSON.parse(readFileSync(join(directory, name), "utf8")) as {
        calls?: ReadonlyArray<LaneCall>;
      };
      return (round.calls ?? [])
        .filter((call) => call.owner === "human-required")
        .map((call) => ({
          range: call.range,
          unit: call.unit,
          title: call.title,
          lines: call.lines,
        }));
    });
};

/** Every earlier round's key, merged in file order (a later answer for a line wins). */
export const carriedKey = (
  except?: string,
  directory: string = LANES_RESULTS,
): LineKey => {
  if (!existsSync(directory)) return {};
  const merged: Record<string, Lane> = {};
  const rounds = readdirSync(directory)
    .filter((name) => name.endsWith(".json") && name !== `${except}.json`)
    .map((name) => ({
      name,
      ...(JSON.parse(readFileSync(join(directory, name), "utf8")) as {
        key?: LineKey;
        writtenAt?: string;
      }),
    }))
    // Oldest first, so a later answer for a line wins; a file without a time (the first rounds)
    // comes before any with one, then by name.
    .sort(
      (a, b) =>
        (a.writtenAt ?? "").localeCompare(b.writtenAt ?? "") ||
        a.name.localeCompare(b.name),
    );
  for (const round of rounds) Object.assign(merged, round.key ?? {});
  return merged;
};

const neuve = (args: ReadonlyArray<string>) =>
  execFileSync("neuve", [...args], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });

/** A replay run to read: a research run in its case clone (under the research HOME), or its packet file. */
export type ReplaySource =
  | { readonly packet: string }
  | {
      readonly run: string;
      readonly repository: string;
      readonly home?: string | undefined;
    };

type Shown = ShownTitles & {
  runId?: string;
  packet: PacketLite | null;
  cycleId?: string;
  range?: { baseOid?: string; headOid?: string };
};

/**
 * A run's `review show --json`, from a file or the installed `neuve`, through the guard: today's
 * kinds unless the caller reads the sections shape (`READS_SECTIONS`: the desk round, the owner's
 * guard, adjudication).
 */
export const shownRun = (
  packet: string | undefined,
  run: string | undefined,
  repo: ReadonlyArray<string>,
  reads: Reads = READS_TODAY,
): Shown =>
  readableRun(
    JSON.parse(
      packet !== undefined
        ? readFileSync(packet, "utf8")
        : neuve(["review", "show", "--run", run!, "--json", ...repo]),
    ) as Shown,
    packet !== undefined ? packet : `run ${run}`,
    reads,
  );

const rangeOf = (shown: Shown, fallback: string) =>
  shown.range?.baseOid !== undefined && shown.range.headOid !== undefined
    ? rangeIdentity(`${shown.range.baseOid}..${shown.range.headOid}`)
    : fallback;

/**
 * One round, one command: reads the run's packet and the owner's desk feedback (or the files given),
 * scores it against every earlier round's key and writes `lanes/<round>.json`. Read-only on the store.
 */
export const laneRound = (options: {
  readonly round: string;
  /** A second run of the same range (a run ID, or its `review show --json` file), for the noise floor. */
  readonly against?: string | undefined;
  readonly againstPacket?: string | undefined;
  /** The repository the second run's store belongs to (a scratch clone), when it is not --repo's. */
  readonly againstRepository?: string | undefined;
  readonly repository?: string | undefined;
  readonly run?: string | undefined;
  readonly cycle?: string | undefined;
  readonly packet?: string | undefined;
  readonly feedback?: string | undefined;
  readonly baseline?: boolean | undefined;
  /**
   * The replay key beside the owner's (10.124–10.128): evidence files, the replay runs measured
   * against them (research runs in their case clones, or their packet files), optionally a second
   * run of each case for the floor, and whether to measure the held-out split.
   */
  readonly replay?:
    | {
        readonly evidence: ReadonlyArray<string>;
        /** The cases' after-merge records, so fixes and reverts are told apart. */
        readonly afterMerge?: ReadonlyArray<string> | undefined;
        readonly runs: ReadonlyArray<ReplaySource>;
        readonly against?: ReadonlyArray<ReplaySource> | undefined;
        readonly heldOut?: boolean | undefined;
      }
    | undefined;
}) => {
  const repo = ["--repo", options.repository ?? "."];
  let calls: Array<LaneCall>;
  let source: Record<string, unknown>;
  const shownRuns: Array<Shown> = [];
  if (
    options.baseline !== true &&
    options.packet === undefined &&
    options.run === undefined &&
    options.replay !== undefined
  ) {
    // A round of the replay key alone: no owner answers are read.
    calls = [];
    source = { kind: "replay-only" };
  } else if (options.baseline === true) {
    const sheet = JSON.parse(
      readFileSync(join(FULL_TEST_RESULTS, "sheet.json"), "utf8"),
    );
    const answers = JSON.parse(
      readFileSync(join(FULL_TEST_RESULTS, "sheet-answers.json"), "utf8"),
    );
    calls = sheetCalls(sheet, answers);
    source = {
      kind: "sheet",
      sheet: "sheet.json",
      answers: "sheet-answers.json",
    };
  } else {
    if (options.packet === undefined && options.run === undefined)
      throw new Error(
        "lanes needs --run <id>[,<id>…] (or --packet <file>), or --baseline",
      );
    // Several reviews, one per cycle, can make one round: the owner annotates units across them,
    // and each run's lines are keyed by its own range.
    const list = (text: string | undefined) =>
      (text ?? "").split(",").filter((entry) => entry !== "");
    const runs: Array<{ run?: string; packet?: string }> =
      options.packet !== undefined
        ? list(options.packet).map((packet) => ({ packet }))
        : list(options.run).map((run) => ({ run }));
    if (
      runs.length > 1 &&
      (options.cycle !== undefined || options.feedback !== undefined)
    )
      throw new Error(
        "--cycle and --feedback name one review; with several runs each run's own cycle is read",
      );
    if (runs.length === 0) throw new Error("lanes --run names no run");
    calls = [];
    const reviews: Array<Record<string, unknown>> = [];
    for (const { run, packet } of runs) {
      const shown = shownRun(packet, run, repo, READS_SECTIONS);
      shownRuns.push(shown);
      const cycle = options.cycle ?? shown.cycleId;
      if (options.feedback === undefined && cycle === undefined)
        throw new Error(
          "lanes needs --cycle <id> when the run's output names no cycle",
        );
      const feedback = JSON.parse(
        options.feedback !== undefined
          ? readFileSync(options.feedback, "utf8")
          : neuve(["records", "feedback", "--cycle", cycle!, ...repo]),
      );
      const range = rangeOf(shown, cycle ?? "unknown-range");
      // Two runs of one range would overwrite each other's lines; --against compares those.
      if (reviews.some((review) => review.range === range))
        throw new Error(
          `two runs of ${range} in one round; compare them with --against instead`,
        );
      calls.push(...deskCalls(shown, feedback, range));
      reviews.push({
        run: run ?? shown.runId ?? null,
        cycle: cycle ?? null,
        range,
      });
    }
    source =
      reviews.length === 1
        ? { kind: "desk", ...reviews[0]! }
        : { kind: "desk", reviews, range: null };
  }
  const measures = laneMeasures(
    calls,
    carriedKey(options.round),
    carriedOwnerUnits(options.round),
  );
  // The noise floor: second runs of the same ranges, each range once, compared line by line.
  const againsts = [
    ...(options.againstPacket ?? "")
      .split(",")
      .filter(Boolean)
      .map((packet) => ({ packet, run: undefined })),
    ...(options.against ?? "")
      .split(",")
      .filter(Boolean)
      .map((run) => ({ packet: undefined, run })),
  ];
  if (againsts.length > 0 && options.baseline === true)
    throw new Error(
      "--against compares two runs of one range; the sheet's baseline is a sample, not a run",
    );
  const seconds = againsts.map(({ packet, run }) =>
    shownRun(
      packet,
      run,
      ["--repo", options.againstRepository ?? options.repository ?? "."],
      READS_SECTIONS,
    ),
  );
  const firstRanges = [...new Set(calls.map((call) => call.range))].sort();
  const secondRanges = seconds.map((shown) => rangeOf(shown, "unknown-range"));
  if (
    seconds.length > 0 &&
    (new Set(secondRanges).size !== secondRanges.length ||
      [...secondRanges].sort().join() !== firstRanges.join())
  )
    throw new Error(
      `--against names runs of ${secondRanges.join(", ")}, not one each of this round's ${firstRanges.join(", ")}`,
    );
  const secondCalls = seconds.flatMap((shown, index) =>
    deskCalls(shown, {}, secondRanges[index]!),
  );
  const floor =
    seconds.length === 0
      ? null
      : {
          runs: seconds.map(
            (shown, index) => againsts[index]!.run ?? shown.runId ?? null,
          ),
          ...runAgreement(calls, secondCalls),
          // Kept so the floor can be recomputed from this file alone.
          secondCalls,
        };
  // The replay key, beside the owner's and never pooled with it (10.124–10.128).
  const replay =
    options.replay === undefined
      ? null
      : (() => {
          const { files, evidence } = readEvidence(options.replay.evidence);
          const afterMerge =
            options.replay.afterMerge === undefined
              ? undefined
              : readAfterMerge(options.replay.afterMerge);
          const known = new Set(evidence.map((record) => record.range));
          const read = (sources: ReadonlyArray<ReplaySource>) =>
            sources.map((replaySource) => {
              const shown = readReplayRun(
                replaySource,
                options.repository ?? ".",
              );
              const range = rangeOf(shown, "unknown-range");
              if (!known.has(range))
                throw new Error(
                  `replay run ${shown.runId ?? "?"} is of ${range}, which no evidence file names`,
                );
              return {
                runId: shown.runId ?? null,
                range,
                calls: replayCalls(shown, range),
              };
            });
          const first = read(options.replay.runs);
          const firstCalls: Array<ReplayCall> = first.flatMap(
            (run) => run.calls,
          );
          const measured = {
            heldOut: options.replay.heldOut,
            afterMerge: afterMerge?.kinds,
          };
          const againstRuns =
            options.replay.against === undefined
              ? []
              : read(options.replay.against);
          checkReplayRanges(
            first.map((run) => run.range),
            againstRuns.map((run) => run.range),
          );
          const againstCalls = againstRuns.flatMap((run) => run.calls);
          const asLane = (calls: ReadonlyArray<ReplayCall>): Array<LaneCall> =>
            calls.map((call) => ({ ...call, owner: null }));
          return {
            files,
            // Without them, fixes and reverts after merge are one origin, and the headline keeps both.
            afterMergeFiles: afterMerge?.files ?? null,
            runs: first.map(({ runId, range }) => ({ runId, range })),
            byEra: replayMeasures(firstCalls, evidence, measured),
            floor:
              againstRuns.length === 0
                ? null
                : {
                    runs: againstRuns.map(({ runId, range }) => ({
                      runId,
                      range,
                    })),
                    ...runAgreement(asLane(firstCalls), asLane(againstCalls)),
                    byEra: replayMeasures(againstCalls, evidence, measured),
                  },
          };
        })();
  // Titles ride along as their own check (owner, 25 October); they never enter the lane measure.
  // The title check reads the units a run assembled, which a sections-shape run does not show: it
  // does not apply there, and the round says so rather than reporting no units.
  const titlesNotApplied = shownRuns.some((shown) =>
    isSectionsShape(shown.packet),
  )
    ? "The title check does not apply to the sections shape: its runs show no assembled units."
    : null;
  const titles =
    shownRuns.length === 0 || titlesNotApplied !== null
      ? null
      : titleCheck(shownRuns);
  const result = {
    round: options.round,
    // Later rounds' answers win on a shared line; rounds are ordered by this, not by name.
    writtenAt: new Date().toISOString(),
    source,
    ...measures,
    floor,
    titles,
    ...(titlesNotApplied === null ? {} : { titlesNotApplied }),
    replay,
    calls,
  };
  mkdirSync(LANES_RESULTS, { recursive: true });
  writeFileSync(
    join(LANES_RESULTS, `${options.round}.json`),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  return result;
};

/**
 * An owner's adjudication given outside the desk (in chat, relayed and recorded as a decision): the
 * lanes the owner gave named units of a run, written as a dated round file of its own, so its lines
 * join the key every later round is judged by, and a line the owner cleared is not flagged again.
 */
export const adjudicationRound = (options: {
  readonly round: string;
  readonly runs: ReadonlyArray<string>;
  readonly lanes: ReadonlyMap<string, Lane>;
  readonly decision: string;
  readonly date: string;
  readonly repository?: string | undefined;
}) => {
  if (existsSync(join(LANES_RESULTS, `${options.round}.json`)))
    throw new Error(
      `lanes/${options.round}.json exists; an adjudication never overwrites a round`,
    );
  if (options.lanes.size === 0)
    throw new Error("adjudicate --units names no unit");
  if (options.runs.length === 0)
    throw new Error("adjudicate --run names no run");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(options.date))
    throw new Error(`adjudicate --date takes yyyy-mm-dd, got ${options.date}`);
  const repo = ["--repo", options.repository ?? "."];
  const key: Record<string, Lane> = {};
  const found: Array<LaneCall> = [];
  for (const run of options.runs) {
    const shown = shownRun(undefined, run, repo, READS_SECTIONS);
    const range = rangeOf(shown, "unknown-range");
    for (const call of deskCalls(shown, {}, range)) {
      const lane = options.lanes.get(call.unit);
      if (lane === undefined) continue;
      for (const line of call.lines) key[lineKey(range, line)] = lane;
      // As an answered unit, so the guard carries an owner's human-required unit like a desk answer.
      found.push({ ...call, owner: lane });
    }
  }
  const missing = [...options.lanes.keys()].filter(
    (unit) => !found.some((entry) => entry.unit === unit),
  );
  if (missing.length > 0)
    throw new Error(
      `no unit ${missing.join(", ")} in runs ${options.runs.join(", ")}`,
    );
  const result = {
    round: options.round,
    writtenAt: new Date().toISOString(),
    source: {
      kind: "owner-adjudication",
      via: "chat, relayed by the overseer",
      decision: options.decision,
      date: options.date,
    },
    calls: found,
    key,
  };
  mkdirSync(LANES_RESULTS, { recursive: true });
  writeFileSync(
    join(LANES_RESULTS, `${options.round}.json`),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  return result;
};

/** The title check alone over runs' packets (read-only), written as `lanes/titles-<name>.json`. */
export const titleRound = (options: {
  readonly name: string;
  readonly runs: ReadonlyArray<string>;
  readonly repository?: string | undefined;
}) => {
  if (options.runs.length === 0) throw new Error("titles --run names no run");
  const repo = ["--repo", options.repository ?? "."];
  const check = titleCheck(
    options.runs.map((run) => shownRun(undefined, run, repo)),
  );
  mkdirSync(LANES_RESULTS, { recursive: true });
  writeFileSync(
    join(LANES_RESULTS, `titles-${options.name}.json`),
    `${JSON.stringify({ name: options.name, runs: options.runs, ...check }, null, 2)}\n`,
  );
  return check;
};

/** The round in a few plain lines, for the catalog and the owner. */
export const describeRound = (result: ReturnType<typeof laneRound>) => {
  const pct = (value: number | null) =>
    value === null ? "n/a" : `${Math.round(value * 100)}%`;
  const unit = result.unitAgreement;
  // A round of the replay key alone reads no owner answer: it reports the replay key only.
  if (result.source["kind"] === "replay-only" && result.replay !== null)
    return [
      `Round ${result.round}: the replay key alone.`,
      ...describeReplay(result.replay, pct),
    ].join("\n");
  return [
    `Round ${result.round}: ${result.answered} of ${result.units} units answered.`,
    result.guard.holds
      ? "Guard holds: no unit the owner sends to a person landed wholly lower."
      : `Guard broken: ${result.guard.lower.length} unit(s) the owner sends to a person landed wholly lower (${result.guard.lower.map((m) => `"${m.title}", ${m.lines} line(s)`).join("; ")}).`,
    ...(result.guard.unassessedLines === 0
      ? []
      : [
          `Not judged: ${result.guard.unassessedLines} line(s) the owner sends to a person sit in units with no assessment.`,
        ]),
    ...(result.guard.split.length === 0
      ? []
      : [
          `For the owner's judgement (split, 10.123): ${result.guard.split.map((m) => `"${m.title}" keeps ${m.keptLines} line(s) with a person and has ${m.lowerLines} lower, in ${m.units.map((u) => `"${u.title}" (${u.harness}, ${u.lines})`).join(", ")}`).join("; ")}.`,
        ]),
    `Lane agreement per unit: ${pct(unit?.agreement ?? null)}${unit === null ? "" : ` (95% ${pct(unit.agreementCi95[0])}-${pct(unit.agreementCi95[1])}, kappa ${unit.kappa === null ? "n/a" : unit.kappa.toFixed(2)})`}; per line: ${pct(result.lineAgreement.share)} of ${result.lineAgreement.judged} judged lines.`,
    `Sent to a person: ${pct(result.sentToPerson.units)} of units, ${pct(result.sentToPerson.lines)} of changed lines; the owner sent ${pct(result.sentToPerson.ownerUnits)} of the units answered.`,
    ...(result.titles === null ? [] : [describeTitles(result.titles)]),
    ...(result.titlesNotApplied === undefined ? [] : [result.titlesNotApplied]),
    ...(result.floor === null
      ? []
      : [
          `Between the two runs (${result.floor.runs.length} range${result.floor.runs.length === 1 ? "" : "s"}): ${pct(result.floor.agreement)} of ${result.floor.lines} shared lines in the same lane (kappa ${result.floor.kappa === null ? "n/a" : result.floor.kappa.toFixed(2)}); ${result.floor.units.first} and ${result.floor.units.second} units; sent to a person ${pct(result.floor.sentToPerson.first)} and ${pct(result.floor.sentToPerson.second)} of lines.`,
        ]),
    ...(result.replay === null ? [] : describeReplay(result.replay, pct)),
  ].join("\n");
};

/** The replay key in plain lines, era by era and split by split, after the owner's measures. */
export const describeReplay = (
  replay: NonNullable<ReturnType<typeof laneRound>["replay"]>,
  pct: (value: number | null) => string,
) => [
  `Replay key (never pooled with the owner's; ${replay.runs.length} run(s)):`,
  ...Object.entries(replay.byEra).flatMap(([era, splits]) =>
    Object.entries(splits).map(([split, m]) =>
      [
        `  ${era}, ${split} (${m.cases} case(s)): needs-a-person lines in human-required ${pct(m.escalationRecall.required)} of ${m.escalationRecall.needsPerson} (human-suggested or higher ${pct(m.escalationRecall.suggestedOrHigher)}); per unit ${pct(m.escalationRecall.units.required)} of ${m.escalationRecall.units.units} (human-suggested or higher ${pct(m.escalationRecall.units.suggestedOrHigher)}); per case ${pct(m.escalationRecall.cases.required)} of ${m.escalationRecall.cases.cases} (human-suggested or higher ${pct(m.escalationRecall.cases.suggestedOrHigher)}); ${m.escalationRecall.revertsApart ? "reverts reported apart, not counted here" : `${m.escalationRecall.byOrigin["after-merge"]?.lines ?? 0} after-merge line(s) of unknown kind are counted here and may include reverts (give --replay-aftermerge for every case)`}.`,
        `    by origin: ${
          Object.entries(m.escalationRecall.byOrigin)
            .map(
              ([origin, r]) =>
                `${origin} ${pct(r.required)} of ${r.lines} lines, ${pct(r.units.required)} of ${r.units.units} units, ${r.cases.cases} case(s)${origin === "revert" ? " (the history signal)" : ""}`,
            )
            .join("; ") || "none"
        }.`,
        `    human-required units whose labelled lines an agent or automation could take ${m.overEscalation.units.units} of ${m.overEscalation.units.of} (labelled share ${pct(m.overEscalation.units.labelledShare)}${m.overEscalation.units.withReverts === 0 ? "" : `; ${m.overEscalation.units.withReverts} also hold revert lines`}); agent-catchable and mechanical lines in human-required ${pct(m.overEscalation.required)} of ${m.overEscalation.lines}; controls' units sent to a person: ${
          Object.entries(m.controls)
            .map(
              ([kind, c]) =>
                `${kind} ${pct(c.required)} of ${c.units} (human-suggested or higher ${pct(c.suggestedOrHigher)})`,
            )
            .join("; ") || "none"
        }.`,
        `    lines in their lane ${pct(m.lineAgreement.share)} of ${m.lineAgreement.judged}${m.lineAgreement.reverts.judged === 0 ? "" : ` (revert lines apart: ${pct(m.lineAgreement.reverts.share)} of ${m.lineAgreement.reverts.judged} in their lane)`}; ${m.coverage.judged} of ${m.coverage.owned} owned lines labelled, ${m.coverage.disputed} held back with no majority.`,
      ].join("\n"),
    ),
  ),
  ...(replay.floor === null
    ? []
    : [
        `  Between two replay runs: ${pct(replay.floor.agreement)} of ${replay.floor.lines} shared lines in the same lane (kappa ${replay.floor.kappa === null ? "n/a" : replay.floor.kappa.toFixed(2)}).`,
      ]),
];
