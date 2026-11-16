import { makeOutputDirectory } from "./sources.ts";
import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  ownedLineKeys,
  packetUnits,
  type PacketLite,
  type PacketUnitLite,
} from "../harness-compare/full-test/packets.ts";
import { wilsonRate } from "./audit.ts";
import { BlindPass, shuffled, type BlindItem } from "./matching.ts";
import { firstAndLaterDiffs } from "./concerns.ts";
import { labelOf, type ConcernRow } from "./evidence.ts";
import { readCase } from "./prepare.ts";
import { rubricChunks } from "../harness-compare/full-test/title-rubric.ts";
import {
  caseDirectory,
  researchRoot,
  runPaths,
  treating,
  writeOutput,
  type SourceName,
} from "./sources.ts";
import { caseThreads } from "./threads.ts";

/**
 * Parity with a great human reviewer (10.141): before any miss is analysed, a blind check of the
 * matching itself, both ways ((b)), and then a sort of each real miss by its cause ((c)).
 *
 * (b) Each of the reviewers' substantive concerns stands in the blind matching as matched (a Neuve item
 * paired with it by two of the three passes), split (paired by one pass only) or missed (by none). A
 * stratified sample of each goes to a blind judge with the concern, what later changed in its file, and
 * Neuve's candidate items: for a split or missed concern, every Neuve item on its file near its line and
 * the items of the unit that owns it; for a matched one, the items it was paired with. The judge never
 * learns what the matcher decided. A missed or split concern the judge finds raised is a scoring gap,
 * not a miss; a matched one it finds not raised is a false match. Both shares come with intervals, and
 * the catch rate they imply beside the matcher's.
 *
 * (c) For each concern that stays missed, the run's own record says whether a unit owned its lines,
 * which agents read them (run_reads.py, from the archived store's captures), what evidence covered them,
 * and whether the run was cut off before reaching them; a blind judge sorts the cause, per concern.
 */

export type MatchStanding = "matched" | "split" | "missed";

export interface ConcernStanding {
  /** The review thread: the concern's id. */
  readonly ref: string;
  readonly standing: MatchStanding;
  /** The reviewers' items of this concern in the matching key (its first-revision comments). */
  readonly reviewer: ReadonlyArray<BlindItem>;
  /** Neuve's items two passes paired with it, and those only one pass did. */
  readonly matchedWith: ReadonlyArray<BlindItem>;
  readonly splitWith: ReadonlyArray<BlindItem>;
}

/**
 * Each substantive concern's standing, as mergeBlind counts pairs: a reviewer and a Neuve item are
 * paired when two of the three passes name them the same problem, in either direction.
 */
export const concernStandings = (
  key: { readonly items: ReadonlyArray<BlindItem> },
  passes: ReadonlyArray<BlindPass | null>,
  substantive: ReadonlySet<string>,
): Array<ConcernStanding> => {
  const byId = new Map(key.items.map((item) => [item.id, item]));
  const votes = new Map<string, number>();
  for (const pass of passes) {
    const named = new Set<string>();
    for (const item of pass?.comments ?? [])
      for (const other of item.sameAs) {
        const x = byId.get(item.id);
        const y = byId.get(other);
        if (x === undefined || y === undefined || x.source === y.source)
          continue;
        const [reviewer, neuve] = x.source === "reviewer" ? [x, y] : [y, x];
        named.add(`${reviewer.id}|${neuve.id}`);
      }
    for (const pair of named) votes.set(pair, (votes.get(pair) ?? 0) + 1);
  }
  const refs = [
    ...new Set(
      key.items
        .filter(
          (item) => item.source === "reviewer" && substantive.has(item.ref),
        )
        .map((item) => item.ref),
    ),
  ];
  return refs.map((ref) => {
    const reviewer = key.items.filter(
      (item) => item.source === "reviewer" && item.ref === ref,
    );
    const ids = new Set(reviewer.map((item) => item.id));
    const paired = (enough: (count: number) => boolean) => [
      ...new Map(
        [...votes]
          .filter(
            ([pair, count]) => ids.has(pair.split("|")[0]!) && enough(count),
          )
          .map(([pair]) => byId.get(pair.split("|")[1]!)!)
          .map((item) => [item.id, item]),
      ).values(),
    ];
    const matchedWith = paired((count) => count >= 2);
    const splitWith =
      matchedWith.length > 0 ? [] : paired((count) => count === 1);
    return {
      ref,
      reviewer,
      matchedWith,
      splitWith,
      standing:
        matchedWith.length > 0
          ? "matched"
          : splitWith.length > 0
            ? "split"
            : "missed",
    };
  });
};

/**
 * A stratified sample: for each standing, its quota drawn one stratum at a time (source and era), in an
 * order from the seed, so no source or era fills a quota while another has rows left.
 */
export const stratifiedSample = <
  T extends { readonly standing: MatchStanding; readonly stratum: string },
>(
  rows: ReadonlyArray<T>,
  quotas: Readonly<Record<MatchStanding, number>>,
  seed: number,
) =>
  (Object.keys(quotas) as Array<MatchStanding>).flatMap((standing, at) => {
    const strata = new Map<string, Array<T>>();
    for (const row of rows.filter((one) => one.standing === standing))
      strata.set(row.stratum, [...(strata.get(row.stratum) ?? []), row]);
    const queues = shuffled([...strata.keys()].sort(), seed + at).map((name) =>
      shuffled(strata.get(name)!, seed + at),
    );
    const picked: Array<T> = [];
    while (picked.length < quotas[standing] && queues.some((q) => q.length > 0))
      for (const queue of queues)
        if (queue.length > 0 && picked.length < quotas[standing])
          picked.push(queue.shift()!);
    return picked;
  });

const Answer = z.enum(["yes", "no", "unsure"]);

/** One concern and Neuve's candidate items, as the blind judge sees them: nothing names the matcher's call. */
export const MatchCheckItem = z.strictObject({
  id: z.string().regex(/^m[0-9a-f]{12}$/),
  concern: z.strictObject({
    path: z.string(),
    side: z.enum(["new", "old"]),
    line: z.int(),
    /** The review thread's messages, in order. */
    thread: z.array(z.string()),
  }),
  /** What changed in the concern's file after the first revision. */
  laterChange: z.string(),
  candidates: z.array(
    z.strictObject({
      label: z.string(),
      path: z.string(),
      side: z.enum(["new", "old"]),
      line: z.int(),
      text: z.string(),
    }),
  ),
});
export type MatchCheckItem = z.infer<typeof MatchCheckItem>;

export const MatchCheckAnswer = z.strictObject({
  id: z.string().regex(/^m[0-9a-f]{12}$/),
  raised: Answer,
  form: z.enum([
    "same-words",
    "other-words",
    "question",
    "nearby-line",
    "none",
    "unsure",
  ]),
  reason: z.string(),
});

export const MatchCheckDecided = z.strictObject({
  version: z.literal(1),
  promptDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  answers: z.array(MatchCheckAnswer),
});

export const MATCH_CHECK_QUESTIONS = [
  "raised: does any CANDIDATE raise the CONCERN: the same problem in the same code, in any words, as a question, or on a nearby line? A candidate about other code, or a different problem on the same line, does not. (yes, no or unsure)",
  "form: the closest form among the candidates that raise it: same-words (states the problem much as the concern does), other-words, question (asks about it), nearby-line (raises it on a line near the concern's); none when no candidate raises it (or unsure)",
] as const;

/** Neuve's items within this many lines of a concern, on its file and side, are its candidates. */
export const NEARBY_LINES = 15;
const MAX_CANDIDATES = 25;
const LATER_CHANGE_LIMIT = 6_000;
export const MESSAGE_LIMIT = 800;

export const opaqueId = (prefix: string, text: string) =>
  `${prefix}${createHash("sha256").update(text).digest("hex").slice(0, 12)}`;

const unitOf = (item: BlindItem) => item.ref.split("#")[0]!;

/** The diff hunks of later revisions that touch a file, clipped. */
export const laterChangeOf = (
  diffs: ReadonlyArray<{ name: string; text: string }>,
  path: string,
) => {
  const parts = diffs.slice(1).flatMap((diff) =>
    diff.text
      .split(/^(?=diff --git )/m)
      .filter((chunk) =>
        chunk
          .split("\n", 1)[0]!
          .split(" ")
          .some((word) => word === `a/${path}` || word === `b/${path}`),
      )
      .map((chunk) => `${diff.name}\n${chunk}`),
  );
  const text = parts.join("\n");
  return text.length > LATER_CHANGE_LIMIT
    ? `${text.slice(0, LATER_CHANGE_LIMIT)}\n[clipped: ${text.length - LATER_CHANGE_LIMIT} more characters]`
    : text === ""
      ? "(no later revision changed this file)"
      : text;
};

/**
 * A sampled concern as the judge's item, and its key. A matched concern's candidates are the items it
 * was paired with; a split one's are the item its one pass paired with it, always, then Neuve's items
 * near its line, nearest first, and the items of the units that own its line; a missed one's the same
 * without a pair. Candidates are shuffled and labelled A, B, ... from the seed. The key keeps the
 * concern's stratum, for weighting, and, for a matched concern, whether its pairs all stand outside
 * the window a missed concern's candidates are drawn from.
 */
export const matchCheckItem = (
  caseId: string,
  standing: ConcernStanding,
  inputs: {
    readonly items: ReadonlyArray<BlindItem>;
    readonly owners: ReadonlyArray<string>;
    readonly thread: ReadonlyArray<string>;
    readonly diffs: ReadonlyArray<{ name: string; text: string }>;
    readonly seed: number;
    readonly stratum: string;
  },
) => {
  const at = standing.reviewer[0]!;
  const side = at.side ?? "new";
  const near = (item: BlindItem) =>
    item.path === at.path && (item.side ?? "new") === side
      ? Math.abs(item.line - at.line)
      : Number.POSITIVE_INFINITY;
  const neuve = inputs.items.filter((item) => item.source === "neuve");
  const inWindow = (item: BlindItem) =>
    near(item) <= NEARBY_LINES || inputs.owners.includes(unitOf(item));
  const chosen =
    standing.standing === "matched"
      ? standing.matchedWith
      : [
          ...new Map(
            [
              ...standing.splitWith,
              ...neuve
                .filter((item) => near(item) <= NEARBY_LINES)
                .sort((x, y) => near(x) - near(y)),
              ...neuve.filter((item) => inputs.owners.includes(unitOf(item))),
            ].map((item) => [item.id, item]),
          ).values(),
        ].slice(0, Math.max(MAX_CANDIDATES, standing.splitWith.length));
  const labelled = shuffled(chosen, inputs.seed).map((item, index) => ({
    label: index < 26 ? String.fromCharCode(65 + index) : `Z${index - 25}`,
    item,
  }));
  const id = opaqueId("m", `${caseId}|${standing.ref}`);
  return {
    item: MatchCheckItem.parse({
      id,
      concern: {
        path: at.path,
        side,
        line: at.line,
        thread: inputs.thread.map((text) => text.slice(0, MESSAGE_LIMIT)),
      },
      laterChange: laterChangeOf(inputs.diffs, at.path),
      candidates: labelled.map(({ label, item }) => ({
        label,
        path: item.path,
        side: item.side ?? "new",
        line: item.line,
        text: item.text,
      })),
    }),
    key: {
      id,
      caseId,
      ref: standing.ref,
      standing: standing.standing,
      stratum: inputs.stratum,
      outsideWindow:
        standing.standing === "matched" &&
        standing.matchedWith.every((item) => !inWindow(item)),
      candidates: Object.fromEntries(
        labelled.map(({ label, item }) => [label, item.id]),
      ),
    },
  };
};

/** The units that own a line, by their packet-local id (b1.u3), which Neuve's item refs begin with. */
export const ownersOf = (
  packet: PacketLite | null,
  at: {
    readonly path: string;
    readonly side: "new" | "old";
    readonly line: number;
  },
) =>
  packetUnits(packet)
    .filter(({ unit }) =>
      ownedLineKeys(unit).has(`${at.path}:${at.side}:${at.line}`),
    )
    .map(({ unit }) => unit.local ?? unit.unitId);

/**
 * A share read back through a stratified sample's design, as the label audit reads accuracy
 * (audit.ts's weightedAccuracy): each stratum's share (hits over judged) counts by its share of the
 * population, never by its share of the sample. Only strata with judged items enter; `coverage` is
 * their share of the population. The interval is Wilson's at Kish's effective n, 1 / sum(w^2 / n),
 * widened by the uncovered share, which could hold anything.
 */
export const weightedShare = (
  cells: ReadonlyArray<{ size: number; judged: number; hits: number }>,
) => {
  const population = cells.reduce((sum, cell) => sum + cell.size, 0);
  const covered = cells.filter((cell) => cell.judged > 0);
  const coveredSize = covered.reduce((sum, cell) => sum + cell.size, 0);
  const judged = covered.reduce((sum, cell) => sum + cell.judged, 0);
  if (coveredSize === 0)
    return { share: null, effectiveN: 0, coverage: 0, interval: null, judged };
  let share = 0;
  let design = 0;
  for (const cell of covered) {
    const weight = cell.size / coveredSize;
    share += (weight * cell.hits) / cell.judged;
    design += (weight * weight) / cell.judged;
  }
  const effectiveN = Math.min(judged, 1 / design);
  const coverage = coveredSize / population;
  const inner = wilsonRate(share, effectiveN)!;
  return {
    share,
    effectiveN,
    coverage,
    interval: [
      inner[0] * coverage,
      inner[1] * coverage + (1 - coverage),
    ] as const,
    judged,
  };
};

/**
 * The check's reading. For each standing: the full set's concerns, the sample's yes, no and unsure,
 * and the share raised, weighted back to the population by stratum (source and era). A missed or split
 * concern raised is a scoring gap; a matched one not raised is a false match (precision is the share
 * raised). The catch rate they imply puts each standing's weighted share on its full-set count, beside
 * the matcher's own. The missed share is a lower bound: a missed concern's candidates are drawn from a
 * window, and `matchedOutsideWindow` counts the sampled matched concerns whose pairs all stand outside
 * it, which a missed concern's judge could never have been shown.
 */
export const matchCheckReport = (
  population: Readonly<Record<MatchStanding, Readonly<Record<string, number>>>>,
  keys: ReadonlyArray<{
    readonly id: string;
    readonly standing: MatchStanding;
    readonly stratum: string;
    readonly outsideWindow?: boolean;
  }>,
  answers: ReadonlyArray<z.infer<typeof MatchCheckAnswer>>,
) => {
  const byId = new Map(answers.map((answer) => [answer.id, answer]));
  const standings = Object.keys(population) as Array<MatchStanding>;
  const concernsOf = (standing: MatchStanding) =>
    Object.values(population[standing]).reduce((sum, count) => sum + count, 0);
  const rows = Object.fromEntries(
    standings.map((standing) => {
      const mine = keys.filter((key) => key.standing === standing);
      const answer = (id: string) => byId.get(id)?.raised;
      const count = (value: string) =>
        mine.filter((key) => answer(key.id) === value).length;
      const raised = weightedShare(
        Object.entries(population[standing]).map(([stratum, size]) => {
          const cell = mine.filter((key) => key.stratum === stratum);
          const hits = cell.filter((key) => answer(key.id) === "yes").length;
          const judged =
            hits + cell.filter((key) => answer(key.id) === "no").length;
          return { size, judged, hits };
        }),
      );
      return [
        standing,
        {
          concerns: concernsOf(standing),
          sampled: mine.length,
          yes: count("yes"),
          no: count("no"),
          unsure: mine.length - count("yes") - count("no"),
          raised,
          forms: Object.fromEntries(
            ["same-words", "other-words", "question", "nearby-line"].map(
              (form) => [
                form,
                mine.filter(
                  (key) =>
                    answer(key.id) === "yes" && byId.get(key.id)?.form === form,
                ).length,
              ],
            ),
          ),
        },
      ];
    }),
  ) as Record<
    MatchStanding,
    {
      concerns: number;
      sampled: number;
      yes: number;
      no: number;
      unsure: number;
      raised: ReturnType<typeof weightedShare>;
      forms: Record<string, number>;
    }
  >;
  const total = standings.reduce(
    (sum, standing) => sum + concernsOf(standing),
    0,
  );
  // A standing with no concerns in the full set adds nothing; one with concerns and no judged share
  // leaves the rate unknown rather than guessed.
  const counted = standings.filter((standing) => concernsOf(standing) > 0);
  const implied =
    total === 0 ||
    counted.some((standing) => rows[standing].raised.share === null)
      ? null
      : counted.reduce(
          (sum, standing) =>
            sum + concernsOf(standing) * rows[standing].raised.share!,
          0,
        ) / total;
  const partial = counted.filter(
    (standing) => rows[standing].raised.coverage < 1,
  );
  return {
    standings: rows,
    /** Missed or split concerns the judge finds raised: scoring gaps, not misses (a lower bound). */
    scoringGaps: { missed: rows.missed.raised, split: rows.split.raised },
    /** Matched concerns the judge finds raised: precision. */
    precision: rows.matched.raised,
    matchedOutsideWindow: keys.filter(
      (key) => key.standing === "matched" && key.outsideWindow === true,
    ).length,
    caughtByMatcher: total === 0 ? null : concernsOf("matched") / total,
    caughtImplied: implied,
    /** Where the sample left strata unjudged: the implied rate extends the judged strata's shares to them. */
    impliedNote:
      implied === null || partial.length === 0
        ? null
        : `The implied rate extends the judged strata's share to strata the sample left unjudged, for ${partial.join(", ")}; their intervals span those strata.`,
  };
};

// (c) The miss-cause sort.

/** What run_reads.py writes beside a run's store archive: each call with the first line of its result. */
export const RunReads = z.object({
  version: z.literal(2),
  captures: z.record(z.string(), z.number()),
  missingCaptures: z.array(z.string()),
  unreadableCaptures: z.array(z.string()),
  calls: z.array(
    z.object({
      agent: z.string(),
      tool: z.string(),
      params: z.record(z.string(), z.unknown()),
      served: z.string().nullable(),
      failed: z.boolean().nullable(),
    }),
  ),
});
export type RunReads = z.infer<typeof RunReads>;

/** The parts of a stored run (show.json) the miss facts read. */
export interface ShownRun {
  readonly packet: PacketLite | null;
  readonly gaps?: ReadonlyArray<{
    readonly kind?: string;
    readonly detail?: string;
  }>;
  readonly timeout?: {
    readonly reached?: boolean;
    readonly published?: ReadonlyArray<string>;
  } | null;
  readonly ledgers?: ReadonlyArray<{
    readonly entries?: ReadonlyArray<{
      readonly source?: {
        readonly path?: string;
        readonly startLine?: number;
        readonly endLine?: number;
      };
    }>;
  }>;
}

/** The gaps that say a unit's work was cut short before its lines were reviewed: no review, no assessment. */
export const CUT_GAPS = new Set(["review-missing", "not-assessed", "assemble"]);
/**
 * The gap that says only part of a unit's assessment is shown: a display cap, not a cut-off (the
 * overseer's call, 27 October). Reported as its own sub-cause, so it is not read as the review-time
 * climb's.
 */
export const SHOWN_CAP_GAP = "assessment-cut";

/** A revision as a side of the change: the head is the new side, the base the old. */
const sideOfRev = (rev: string) =>
  rev === "head" ? "new" : rev === "base" ? "old" : null;

export interface ServedRange {
  readonly path: string;
  readonly side: "new" | "old";
  readonly start: number;
  readonly end: number;
}

/**
 * The lines a call was served, from the first line of its result: a read's
 * `<handle> <path>@<rev> lines <s>-<e> of <n>` (what was returned, which can be less than was asked,
 * and names the path a handle read stood for), or a hunk's `<id> <path> @@ -<a>,<b> +<c>,<d> +<added>
 * -<deleted> ...` (both its sides; the harness's hunkLine, with no closing @@). Nothing for a failed call, a call with no result, or anything else: an outline or a
 * search shows no line of the file.
 */
export const servedRanges = (
  call: RunReads["calls"][number],
): Array<ServedRange> => {
  if (call.failed !== false || call.served === null) return [];
  if (call.tool === "read") {
    const found = /^\S+ (.+)@(\S+) lines (\d+)-(\d+) of \d+/.exec(call.served);
    const side = found === null ? null : sideOfRev(found[2]!);
    return found === null || side === null
      ? []
      : [
          {
            path: found[1]!,
            side,
            start: Number(found[3]),
            end: Number(found[4]),
          },
        ];
  }
  if (call.tool === "hunk") {
    const found =
      /^\S+ (.+?) @@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))?(?=\s|$)/.exec(
        call.served,
      );
    if (found === null) return [];
    const range = (
      side: "old" | "new",
      start: string,
      lines: string | undefined,
    ) => {
      const count = lines === undefined ? 1 : Number(lines);
      return count === 0
        ? []
        : [
            {
              path: found[1]!,
              side,
              start: Number(start),
              end: Number(start) + count - 1,
            },
          ];
    };
    return [
      ...range("old", found[2]!, found[3]),
      ...range("new", found[4]!, found[5]),
    ];
  }
  return [];
};

/** The file a call worked on, as its result names it, else as it asked; null for one on no file. */
const servedPath = (call: RunReads["calls"][number]) => {
  const named =
    call.served === null
      ? null
      : (/^\S+ (.+)@\S+ lines /.exec(call.served)?.[1] ??
        /^\S+ (.+?) @@ /.exec(call.served)?.[1] ??
        /^(.+)@\S+: /.exec(call.served)?.[1] ??
        null);
  const asked = call.params["path"];
  return named ?? (typeof asked === "string" ? asked : null);
};

/**
 * What the run's own record says about a concern's lines: the units that owned them, the agents that
 * were served them (a read or a hunk whose result covers the line on its side), the calls on the file,
 * the evidence that cites them, whether the run was cut off before reaching them (the deadline stopped
 * an owner's review before it was published, or a gap says an owner went unreviewed or unassessed),
 * and whether only part of an owner's assessment was shown (a display cap). Reads are null, not none,
 * when the run's reads are unknown: no reads.json, or captures it could not find or read.
 */
export const missFacts = (
  run: ShownRun,
  reads: RunReads | null,
  at: {
    readonly path: string;
    readonly side: "new" | "old";
    readonly line: number;
  },
) => {
  const owners = packetUnits(run.packet).filter(({ unit }) =>
    ownedLineKeys(unit).has(`${at.path}:${at.side}:${at.line}`),
  );
  const ownerLocals = owners.map(({ unit }) => unit.local ?? unit.unitId);
  const readsKnown =
    reads !== null &&
    reads.missingCaptures.length + reads.unreadableCaptures.length === 0;
  const calls = readsKnown ? reads.calls : [];
  const servedIt = calls.filter((call) =>
    servedRanges(call).some(
      (range) =>
        range.path === at.path &&
        range.side === at.side &&
        range.start <= at.line &&
        at.line <= range.end,
    ),
  );
  const evidence = (run.ledgers ?? [])
    .flatMap((ledger) => ledger.entries ?? [])
    .filter(
      (entry) =>
        entry.source?.path === at.path &&
        (entry.source.startLine ?? 0) <= at.line &&
        at.line <= (entry.source.endLine ?? 0),
    ).length;
  // A gap names its unit as "in <path> (line <n>)" or "(lines <n>-<m>)", by the unit's first line.
  const named = new RegExp(
    `(?:^|\\s)in ${at.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(lines? (\\d+)(?:-\\d+)?\\)`,
  );
  const namesAnOwner = (detail: string) => {
    const found = named.exec(detail);
    return (
      found !== null &&
      owners.some(({ unit }) =>
        ["new", "old"].some((side) =>
          ownedLineKeys(unit).has(`${at.path}:${side}:${found[1]}`),
        ),
      )
    );
  };
  const gapsOn = (kinds: (kind: string) => boolean) =>
    (run.gaps ?? [])
      .filter((gap) => kinds(gap.kind ?? "") && namesAnOwner(gap.detail ?? ""))
      .map((gap) => `${gap.kind}: ${(gap.detail ?? "").slice(0, 200)}`);
  const cutBy = [
    ...(run.timeout?.reached === true
      ? ownerLocals
          .filter(
            (name) =>
              !(run.timeout?.published ?? []).includes(`dispose.${name}`),
          )
          .map((name) => `the deadline stopped ${name}'s review`)
      : []),
    ...gapsOn((kind) => CUT_GAPS.has(kind)),
  ];
  const shownCap = gapsOn((kind) => kind === SHOWN_CAP_GAP);
  return {
    owned: ownerLocals,
    readsKnown,
    readBy: readsKnown
      ? [...new Set(servedIt.map((call) => call.agent))]
      : null,
    reads: readsKnown ? servedIt.length : null,
    fileCalls: readsKnown
      ? calls.filter((call) => servedPath(call) === at.path).length
      : null,
    evidence,
    cutOff: cutBy.length > 0,
    cutBy,
    shownCap,
    owners: owners.map(({ unit }) => unit),
  };
};

export const MissCauseItem = z.strictObject({
  id: z.string().regex(/^c[0-9a-f]{12}$/),
  concern: z.strictObject({
    path: z.string(),
    side: z.enum(["new", "old"]),
    line: z.int(),
    thread: z.array(z.string()),
  }),
  laterChange: z.string(),
  /** The run's record of these lines, as facts; the reads are null when the record of them is unknown. */
  run: z.strictObject({
    ownedByUnit: z.boolean(),
    readsKnown: z.boolean(),
    readByAgents: z.array(z.string()).nullable(),
    readsOfTheLines: z.int().nullable(),
    callsOnTheFile: z.int().nullable(),
    evidenceCitingTheLines: z.int(),
    cutOff: z.array(z.string()),
    shownCap: z.array(z.string()),
    scopeGaps: z.array(z.string()),
  }),
  /** What Neuve said on each unit that owns the lines: its verdict and items. */
  units: z.array(
    z.strictObject({
      verdict: z.string().nullable(),
      items: z.array(z.string()),
    }),
  ),
});
export type MissCauseItem = z.infer<typeof MissCauseItem>;

export const MissCauseAnswer = z.strictObject({
  id: z.string().regex(/^c[0-9a-f]{12}$/),
  cause: z.enum([
    "not-looked",
    "looked-judged-fine",
    "raised-uncounted",
    "outside-view",
    "unsure",
  ]),
  reason: z.string(),
});

export const MissCauseDecided = z.strictObject({
  version: z.literal(1),
  promptDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  answers: z.array(MissCauseAnswer),
});

export const MISS_CAUSE_QUESTIONS = [
  "cause: why the review did not raise the CONCERN. not-looked: the run was never served these lines or lacked the context it needed for them; looked-judged-fine: it was served them, and its units' verdicts or items treat the code as fine; raised-uncounted: something in the units' items does raise the concern, in a form or place a scorer could miss; outside-view: raising it needs something the run could not see, such as the project's plans, another repository, a discussion outside the change, or behaviour only running it shows (or unsure)",
] as const;

/** A missed concern as the cause judge's item, and its key (the concern's id, for reading a change against). */
export const missCauseItem = (
  caseId: string,
  ref: string,
  at: {
    readonly path: string;
    readonly side: "new" | "old";
    readonly line: number;
  },
  inputs: {
    readonly run: ShownRun;
    readonly reads: RunReads | null;
    readonly thread: ReadonlyArray<string>;
    readonly diffs: ReadonlyArray<{ name: string; text: string }>;
    readonly items: ReadonlyArray<BlindItem>;
  },
) => {
  const facts = missFacts(inputs.run, inputs.reads, at);
  const id = opaqueId("c", `${caseId}|${ref}`);
  // An item counts for every unit it stands for: its own and those whose identical items it folds.
  const unitsOfItem = (item: BlindItem) =>
    [item.ref, ...item.repeats].map((one) => one.split("#")[0]!);
  return {
    item: MissCauseItem.parse({
      id,
      concern: {
        ...at,
        thread: inputs.thread.map((text) => text.slice(0, MESSAGE_LIMIT)),
      },
      laterChange: laterChangeOf(inputs.diffs, at.path),
      run: {
        ownedByUnit: facts.owned.length > 0,
        readsKnown: facts.readsKnown,
        readByAgents: facts.readBy,
        readsOfTheLines: facts.reads,
        callsOnTheFile: facts.fileCalls,
        evidenceCitingTheLines: facts.evidence,
        cutOff: facts.cutBy,
        shownCap: facts.shownCap,
        scopeGaps: (inputs.run.gaps ?? [])
          .filter((gap) => gap.kind === "scope")
          .map((gap) => gap.detail ?? ""),
      },
      units: facts.owners.map((owner) => {
        const name = owner.local ?? owner.unitId;
        const verdict =
          owner.disposition?.payload.verdict ??
          owner.content.guided?.suggestion?.verdict ??
          null;
        return {
          verdict: verdict === null ? null : String(verdict),
          items: inputs.items
            .filter(
              (item) =>
                item.source === "neuve" && unitsOfItem(item).includes(name),
            )
            .map((item) => item.text)
            .slice(0, MAX_CANDIDATES),
        };
      }),
    }),
    key: {
      id,
      caseId,
      concernId: ref,
      cutOff: facts.cutOff,
      shownCap: facts.shownCap.length > 0,
      readsKnown: facts.readsKnown,
    },
  };
};

/**
 * The sort's reading, per concern and in total. "not-looked" is split three ways: cut off before
 * reaching the lines (the deadline, or no review or assessment: the review-time climb's), a shown cap
 * (only part of the assessment shown), and the rest (the harness's judgement of where to look). A
 * concern whose run's reads are unknown is counted apart, never in the totals.
 */
export const missCauseReport = (
  keys: ReadonlyArray<{
    readonly id: string;
    readonly caseId: string;
    readonly concernId: string;
    readonly cutOff: boolean;
    readonly shownCap: boolean;
    readonly readsKnown: boolean;
  }>,
  answers: ReadonlyArray<z.infer<typeof MissCauseAnswer>>,
) => {
  const byId = new Map(answers.map((answer) => [answer.id, answer]));
  const perConcern = keys.map((key) => {
    const cause = byId.get(key.id)?.cause ?? "unsure";
    return {
      caseId: key.caseId,
      concernId: key.concernId,
      readsKnown: key.readsKnown,
      cause:
        cause !== "not-looked"
          ? cause
          : key.cutOff
            ? "not-looked: cut off"
            : key.shownCap
              ? "not-looked: shown cap"
              : cause,
      reason: byId.get(key.id)?.reason ?? "",
    };
  });
  const tally = (rows: ReadonlyArray<{ cause: string }>) => {
    const out: Record<string, number> = {};
    for (const row of rows) out[row.cause] = (out[row.cause] ?? 0) + 1;
    return out;
  };
  const known = perConcern.filter((row) => row.readsKnown);
  return {
    concerns: known.length,
    totals: tally(known),
    readsUnknown: {
      concerns: perConcern.length - known.length,
      totals: tally(perConcern.filter((row) => !row.readsKnown)),
    },
    perConcern,
  };
};

/** A case's matching key and passes, read from its labels folder. */
export const readMatching = (labels: string) => {
  const key = JSON.parse(
    readFileSync(join(labels, "matching-key.json"), "utf8"),
  ) as {
    seed: number;
    items: Array<BlindItem>;
  };
  const pass = (name: "a" | "b" | "c") => {
    const path = join(labels, "matching", `pass-${name}`, "output.json");
    if (!existsSync(path)) return null;
    const parsed = BlindPass.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : null;
  };
  return { key, passes: [pass("a"), pass("b"), pass("c")] };
};

// Building and reading each sort over the research volume.

/** The check's quotas (the overseer's, 27 October): misses and splits for recall, matches for precision. */
export const MATCH_CHECK_QUOTAS: Readonly<Record<MatchStanding, number>> = {
  missed: 60,
  split: 40,
  matched: 30,
};

/**
 * Every case outside the held-out split whose run is matched: its first run, or with `run` the run in
 * run/<run>/ (runPaths). `labels` holds the run's matching, `caseLabels` the case's concern labels.
 */
export const matchedCases = (run?: string) =>
  readdirSync(join(researchRoot(), "cases")).flatMap((source) =>
    readdirSync(join(researchRoot(), "cases", source)).flatMap((number) => {
      const directory = caseDirectory(source as SourceName, Number(number));
      const paths = runPaths(source as SourceName, Number(number), run);
      if (
        !existsSync(join(paths.labels, "matching.json")) ||
        !existsSync(paths.show)
      )
        return [];
      const record = readCase(source as SourceName, Number(number));
      if (record.split === "held-out") return [];
      return [{ record, directory, ...paths }];
    }),
  );

/**
 * A case's pair confirmation for one run (confirm.ts), in the run's labels folder: each concern the
 * matcher left unmatched, whether a Neuve item is confirmed to raise it, and each pass's vote. `caught`
 * is "comment" when a majority named the same comment, "item" when a majority named the same other
 * item or the passes agree it is raised but name different items (`agreed` false), else null.
 */
export const Confirmation = z.strictObject({
  version: z.literal(1),
  promptDigest: z.string().regex(/^[0-9a-f]{64}$/),
  /** The digest of the matching it confirmed (matchingDigest): a re-match leaves it stale. */
  matching: z.string().regex(/^[0-9a-f]{64}$/),
  /** The digest of the case's concern labels it read (labellingDigest): a relabel leaves it stale. */
  labelling: z.string().regex(/^[0-9a-f]{64}$/),
  run: z.string().nullable(),
  concerns: z.array(
    z.strictObject({
      ref: z.string(),
      standing: z.enum(["split", "missed"]),
      caught: z.enum(["comment", "item"]).nullable(),
      agreed: z.boolean(),
      by: z.strictObject({ group: z.string(), ref: z.string() }).nullable(),
      votes: z.array(
        z.union([
          z.strictObject({ group: z.string(), ref: z.string() }),
          z.enum(["decoy", "none", "unsure", "unknown"]),
        ]),
      ),
    }),
  ),
});
export type Confirmation = z.infer<typeof Confirmation>;

/** A run's matching as it stands: its key and its settled matching, which a re-match both rewrite. */
export const matchingDigest = (labels: string) =>
  createHash("sha256")
    .update(readFileSync(join(labels, "matching-key.json")))
    .update("\0")
    .update(readFileSync(join(labels, "matching.json")))
    .digest("hex");

/** A case's concern labelling as it stands: its concerns.jsonl, which labelling the case again rewrites. */
export const labellingDigest = (caseLabels: string) =>
  createHash("sha256")
    .update(readFileSync(join(caseLabels, "concerns.jsonl")))
    .digest("hex");

/**
 * The concerns a run's confirmation found raised, for the miss sort: refused when the run has no
 * confirmation, or one of a matching or a concern labelling that has since changed.
 */
export const confirmedRefs = (
  caseId: string,
  labels: string,
  caseLabels: string,
) => {
  const path = join(labels, "confirmation.json");
  if (!existsSync(path))
    throw new Error(
      `${caseId}: its unmatched concerns are not confirmed yet (${path})`,
    );
  const held = JSON.parse(readFileSync(path, "utf8")) as Record<
    string,
    unknown
  >;
  if (typeof held["labelling"] !== "string") throw beforeLabellingDigest(path);
  const confirmation = Confirmation.parse(held);
  if (confirmation.matching !== matchingDigest(labels))
    throw new Error(
      `${caseId}: its confirmation is of an earlier matching: confirm it again (${path})`,
    );
  if (confirmation.labelling !== labellingDigest(caseLabels))
    throw new Error(
      `${caseId}: its confirmation is of an earlier concern labelling: confirm it again (${path})`,
    );
  return new Set(
    confirmation.concerns.flatMap((row) =>
      row.caught === null ? [] : [row.ref],
    ),
  );
};

export const substantiveOf = (labels: string) =>
  new Set(
    readFileSync(join(labels, "concerns.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as ConcernRow)
      .filter((row) => labelOf(row)?.substantive === true)
      .map((row) => row.id),
  );

export const threadTexts = (record: ReturnType<typeof readCase>) =>
  new Map(
    caseThreads(record).threads.map((thread) => [
      thread.id,
      thread.messages.map((message) => message.text),
    ]),
  );

/** Writes a file whole or not at all: to a name beside it, then renamed over it. */
export const writeJson = (path: string, value: unknown) => {
  if (treating())
    return writeOutput(path, `${JSON.stringify(value, null, 1)}\n`);
  const partial = `${path}.partial-${process.pid}`;
  writeFileSync(partial, `${JSON.stringify(value, null, 1)}\n`);
  renameSync(partial, path);
};

/** A file written before its schema named the labelling it read: refused with what to do. */
export const beforeLabellingDigest = (path: string) =>
  new Error(
    `${path} was built before the labelling digest: build it again (confirm it again for a confirmation)`,
  );

/**
 * (b)'s items and key into `<folder>`: every matched case's standings, the stratified sample (source and
 * era), and each sampled concern as an item. The key holds the full set's counts, so the report can put
 * the sample's shares on them.
 */
export const buildMatchCheck = (folder: string, seed: number) => {
  const cases = matchedCases();
  const rows = cases.flatMap(({ record, labels, caseLabels, directory }) => {
    const { key, passes } = readMatching(labels);
    return concernStandings(key, passes, substantiveOf(caseLabels)).map(
      (standing) => ({
        ...standing,
        stratum: `${record.source}|${record.era}`,
        record,
        directory,
        key,
      }),
    );
  });
  // The full set by standing and stratum: the weights the sample's shares are read back with.
  const population: Record<MatchStanding, Record<string, number>> = {
    matched: {},
    split: {},
    missed: {},
  };
  for (const row of rows)
    population[row.standing][row.stratum] =
      (population[row.standing][row.stratum] ?? 0) + 1;
  const sample = stratifiedSample(rows, MATCH_CHECK_QUOTAS, seed);
  const built = sample.map((row) => {
    const shown = JSON.parse(
      readFileSync(join(row.directory, "run", "show.json"), "utf8"),
    ) as ShownRun;
    const at = row.reviewer[0]!;
    return matchCheckItem(row.record.caseId, row, {
      items: row.key.items,
      owners: ownersOf(shown.packet, {
        path: at.path,
        side: at.side ?? "new",
        line: at.line,
      }),
      thread: threadTexts(row.record).get(row.ref) ?? [at.text],
      diffs: firstAndLaterDiffs(row.record),
      seed: seed ^ row.key.seed,
      stratum: row.stratum,
    });
  });
  const items = shuffled(
    built.map((one) => one.item),
    seed,
  );
  makeOutputDirectory(folder, { recursive: true });
  writeJson(join(folder, "items.json"), {
    version: 1,
    questions: [...MATCH_CHECK_QUESTIONS],
    chunks: rubricChunks(items, 10),
  });
  writeJson(join(folder, "key.json"), {
    seed,
    population,
    cases: cases.length,
    keys: built.map((one) => one.key),
  });
  const count = (standing: MatchStanding) =>
    Object.values(population[standing]).reduce((sum, one) => sum + one, 0);
  return {
    cases: cases.length,
    concerns: {
      matched: count("matched"),
      split: count("split"),
      missed: count("missed"),
    },
    sampled: built.length,
  };
};

export const reportMatchCheck = (folder: string) => {
  const key = JSON.parse(readFileSync(join(folder, "key.json"), "utf8")) as {
    population: Record<MatchStanding, Record<string, number> | number>;
    keys: Array<{
      id: string;
      standing: MatchStanding;
      stratum: string;
      outsideWindow?: boolean;
    }>;
  };
  // A key written before the sample kept its strata cannot be weighted: refused, never read as zero.
  const population = key.population;
  if (
    Object.values(population).some(
      (counts) => typeof counts !== "object" || counts === null,
    ) ||
    key.keys.some((one) => typeof one.stratum !== "string")
  )
    throw new Error(
      `${folder}/key.json was written before the sample kept its strata: build the check again`,
    );
  const decided = MatchCheckDecided.parse(
    JSON.parse(readFileSync(join(folder, "decided.json"), "utf8")),
  );
  const report = matchCheckReport(
    population as Record<MatchStanding, Record<string, number>>,
    key.keys,
    decided.answers,
  );
  writeJson(join(folder, "report.json"), {
    ...report,
    promptDigest: decided.promptDigest ?? null,
  });
  return report;
};

/**
 * (c)'s items and key into `<folder>`: every missed or split concern of the matched cases that the pair
 * confirmation (confirm.ts) did not find raised: a confirmed concern is a scoring gap, not a miss, so
 * a case with unmatched concerns and no confirmation of its run is refused. Each case's run needs its
 * reads.json beside its store archive (run_reads.py); a case without one is built with no reads and
 * flagged in the key.
 */
export const buildMissCause = (folder: string) => {
  const built = matchedCases().flatMap(
    ({ record, labels, caseLabels, directory }) => {
      const { key, passes } = readMatching(labels);
      const unmatched = concernStandings(
        key,
        passes,
        substantiveOf(caseLabels),
      ).filter((row) => row.standing !== "matched");
      if (unmatched.length === 0) return [];
      const caught = confirmedRefs(record.caseId, labels, caseLabels);
      const misses = unmatched.filter((row) => !caught.has(row.ref));
      if (misses.length === 0) return [];
      const shown = JSON.parse(
        readFileSync(join(directory, "run", "show.json"), "utf8"),
      ) as ShownRun;
      // The run's folder (show.from names it; a case without one, a local pilot run, has none).
      const from = join(directory, "run", "show.from");
      const folderOfRun = existsSync(from)
        ? readFileSync(from, "utf8").split(" ")[0]!
        : "cloud";
      const readsPath = join(directory, "run", folderOfRun, "reads.json");
      const reads = existsSync(readsPath)
        ? RunReads.parse(JSON.parse(readFileSync(readsPath, "utf8")))
        : null;
      const threads = threadTexts(record);
      const diffs = firstAndLaterDiffs(record);
      return misses.map((row) => {
        const at = row.reviewer[0]!;
        return missCauseItem(
          record.caseId,
          row.ref,
          { path: at.path, side: at.side ?? "new", line: at.line },
          {
            run: shown,
            reads,
            thread: threads.get(row.ref) ?? [at.text],
            diffs,
            items: key.items,
          },
        );
      });
    },
  );
  makeOutputDirectory(folder, { recursive: true });
  writeJson(join(folder, "items.json"), {
    version: 1,
    questions: [...MISS_CAUSE_QUESTIONS],
    chunks: rubricChunks(
      built.map((one) => one.item),
      10,
    ),
  });
  writeJson(join(folder, "key.json"), { keys: built.map((one) => one.key) });
  return {
    concerns: built.length,
    cutOff: built.filter((one) => one.key.cutOff).length,
    shownCap: built.filter((one) => one.key.shownCap).length,
    readsUnknown: built.filter((one) => !one.key.readsKnown).length,
  };
};

export const reportMissCause = (folder: string) => {
  const key = JSON.parse(readFileSync(join(folder, "key.json"), "utf8")) as {
    keys: Array<{
      id: string;
      caseId: string;
      concernId: string;
      cutOff: boolean;
      shownCap: boolean;
      readsKnown: boolean;
    }>;
  };
  const decided = MissCauseDecided.parse(
    JSON.parse(readFileSync(join(folder, "decided.json"), "utf8")),
  );
  const report = missCauseReport(key.keys, decided.answers);
  writeJson(join(folder, "report.json"), {
    ...report,
    promptDigest: decided.promptDigest ?? null,
  });
  return report;
};
