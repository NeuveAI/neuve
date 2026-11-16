import { makeOutputDirectory } from "./sources.ts";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { wilson } from "./audit.ts";
import { firstAndLaterDiffs } from "./concerns.ts";
import { shuffled, type BlindItem } from "./matching.ts";
import {
  Confirmation,
  beforeLabellingDigest,
  MESSAGE_LIMIT,
  NEARBY_LINES,
  concernStandings,
  laterChangeOf,
  matchedCases,
  labellingDigest,
  matchingDigest,
  opaqueId,
  ownersOf,
  readMatching,
  substantiveOf,
  threadTexts,
  writeJson,
  type ConcernStanding,
  type ShownRun,
} from "./parity.ts";
import { rubricChunks } from "../harness-compare/full-test/title-rubric.ts";
import { treatmentWrite } from "./sources.ts";

/**
 * The pair confirmation (10.141, the overseer's call of 27 October): the blind matcher pairs a
 * reviewer's concern with a Neuve item when two of its three passes do, and a concern only one pass
 * paired, or none, can still be raised by a note or a checkpoint the matcher passed over. Every
 * concern the matcher left unmatched goes to a blind judge with Neuve's candidate items, and the judge
 * names the one that raises it. Matched concerns are untouched; a split pair counts only when the
 * judge confirms it.
 *
 * - The judge sees the concern, what later changed in its file and the candidates, never the run, the
 *   arm, the build or the matcher's call.
 * - Candidates are every Neuve item on the concern's file and side, nearest first, and the items of the
 *   units that own its line (the window: at fifteen lines, 9 of the full set's 73 matches stood
 *   outside it, against 2 with the whole file, both in another file).
 * - One decoy stands among them: a real Neuve item of another case of the same source, from the same
 *   run's items where it has one (so its wording is the run's), of a kind drawn from the candidates',
 *   never from the concern's own file nor worded as a candidate is, placed on the concern's file near
 *   its line. A decoy the judge names is a false confirmation; their rate, with its interval, says how
 *   far a confirmation can be trusted.
 * - Each build has a folder of its own, and an item's ID names its seed and everything the judge is
 *   shown, so an answer is only ever read through the key of the build it was made on. A pass names
 *   one label or fails; a case matched again after the build is not written.
 * - A concern is caught by a comment only when a majority of passes names the same comment, and by
 *   any item when a majority names the same item, or when the passes agree it is raised but name
 *   different items; those disagreements are kept.
 *
 * The confirmed figure is the one that decides between arms, each scored by matcher and confirmation
 * from one pinned clone; the matcher's own figure is shown beside it, never mixed with it across arms.
 */

/** Every candidate fits up to this many; beyond it the farthest are dropped and counted. */
export const CONFIRM_MAX_CANDIDATES = 60;
/** Concerns per judge call: each carries up to sixty candidates. */
const CHUNK = 5;

/** One concern and Neuve's candidate items, as the blind judge sees them. */
export const ConfirmItem = z.strictObject({
  id: z.string().regex(/^p[0-9a-f]{12}$/),
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
export type ConfirmItem = z.infer<typeof ConfirmItem>;

/** One vote: a candidate's label (A to Z, then Z1, Z2, ...), "none" or "unsure". */
const VOTE = String.raw`(?:[A-Z]|Z[1-9][0-9]*|none|unsure)`;

/**
 * A pass's answer: one candidate's label, "none" or "unsure". Anything else fails the pass, which then
 * runs again, so a pass casts one vote. A label the item lacks counts as no vote.
 */
export const ConfirmAnswer = z.strictObject({
  id: z.string().regex(/^p[0-9a-f]{12}$/),
  candidate: z.string().regex(new RegExp(`^${VOTE}$`)),
  reason: z.string(),
});

/** A decided answer keeps each pass's vote, in pass order, "-" for a pass that did not run: three. */
export const ConfirmDecided = z.strictObject({
  version: z.literal(1),
  promptDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  answers: z.array(
    ConfirmAnswer.extend({
      votes: z
        .string()
        .regex(new RegExp(`^(?:${VOTE}|-)(?: (?:${VOTE}|-)){2}$`)),
    }),
  ),
});

export const CONFIRM_QUESTIONS = [
  "candidate: the label of the CANDIDATE that raises the CONCERN: the same problem in the same code, in any words, as a question, or on a nearby line. A candidate about other code, or a different problem on the same line, does not. Where several raise it, the one that raises it most directly; none when no candidate raises it (or unsure)",
] as const;

/** What a candidate's label stands for, in the key only. */
export type KeyedCandidate =
  | {
      readonly decoy: false;
      readonly item: string;
      readonly group: string;
      readonly ref: string;
      /** Lines from the concern on its file and side; null on another file or side. */
      readonly distance: number | null;
    }
  | {
      readonly decoy: true;
      /** The case and item the decoy's text was drawn from, and its pool. */
      readonly from: string;
      readonly ref: string;
      readonly group: string;
      readonly pool: string | null;
    };

/** A decoy drawn for a concern: another case's Neuve item, its text placed near the concern. */
export interface Decoy {
  readonly caseId: string;
  readonly item: BlindItem;
  /** The pool it was drawn from: the run's own items or the first runs'. */
  readonly pool?: string;
}

const normalized = (text: string) =>
  text.toLowerCase().replace(/\s+/g, " ").trim();

const labelAt = (index: number) =>
  index < 26 ? String.fromCharCode(65 + index) : `Z${index - 25}`;

/**
 * An unmatched concern as the judge's item, and its key. Candidates: the items its one pass paired with
 * it (a split), always; then Neuve's items on its file and side, nearest first; then the items of the
 * units that own its line; up to CONFIRM_MAX_CANDIDATES. The decoy stands on the concern's file and
 * side within NEARBY_LINES of it. All are shuffled and labelled A, B, ... from the seed.
 */
export const confirmItem = (
  caseId: string,
  run: string | null,
  standing: ConcernStanding,
  inputs: {
    readonly items: ReadonlyArray<BlindItem>;
    readonly owners: ReadonlyArray<string>;
    readonly thread: ReadonlyArray<string>;
    readonly diffs: ReadonlyArray<{ name: string; text: string }>;
    readonly seed: number;
    /** Decoys to draw from, in order: the first on another file whose text no candidate's matches. */
    readonly decoys: ReadonlyArray<Decoy>;
  },
) => {
  const at = standing.reviewer[0]!;
  const side = at.side ?? "new";
  const distance = (item: BlindItem) =>
    item.path === at.path && (item.side ?? "new") === side
      ? Math.abs(item.line - at.line)
      : null;
  const neuve = inputs.items.filter((item) => item.source === "neuve");
  const window = [
    ...new Map(
      [
        ...standing.splitWith,
        ...neuve
          .filter((item) => distance(item) !== null)
          .sort((x, y) => distance(x)! - distance(y)!),
        ...neuve.filter((item) =>
          inputs.owners.includes(item.ref.split("#")[0]!),
        ),
      ].map((item) => [item.id, item]),
    ).values(),
  ];
  const kept = window.slice(
    0,
    Math.max(CONFIRM_MAX_CANDIDATES, standing.splitWith.length),
  );
  // A decoy from the concern's own file, or worded as a candidate is, could truly raise it: never one.
  const shownTexts = new Set(kept.map((item) => normalized(item.text)));
  const decoy =
    inputs.decoys.find(
      (one) =>
        one.item.path !== at.path && !shownTexts.has(normalized(one.item.text)),
    ) ?? null;
  // The decoy's line, from the seed: within NEARBY_LINES of the concern, never above the file's first.
  const offset =
    shuffled(
      Array.from({ length: 2 * NEARBY_LINES + 1 }, (_, at) => at),
      inputs.seed + 1,
    )[0]! - NEARBY_LINES;
  const shown: Array<{
    keyed: KeyedCandidate;
    path: string;
    side: "new" | "old";
    line: number;
    text: string;
  }> = [
    ...kept.map((item) => ({
      keyed: {
        decoy: false as const,
        item: item.id,
        group: item.group,
        ref: item.ref,
        distance: distance(item),
      },
      path: item.path,
      side: item.side ?? "new",
      line: item.line,
      text: item.text,
    })),
    ...(decoy === null
      ? []
      : [
          {
            keyed: {
              decoy: true as const,
              from: decoy.caseId,
              ref: decoy.item.ref,
              group: decoy.item.group,
              pool: decoy.pool ?? null,
            },
            path: at.path,
            side,
            line: Math.max(1, at.line + offset),
            text: decoy.item.text,
          },
        ]),
  ];
  const labelled = shuffled(shown, inputs.seed).map((one, index) => ({
    ...one,
    label: labelAt(index),
  }));
  const shownItem = {
    concern: {
      path: at.path,
      side,
      line: at.line,
      thread: inputs.thread.map((text) => text.slice(0, MESSAGE_LIMIT)),
    },
    laterChange: laterChangeOf(inputs.diffs, at.path),
    candidates: labelled.map(({ label, path, side, line, text }) => ({
      label,
      path,
      side,
      line,
      text,
    })),
  };
  // The ID names what the judge is shown, labels included, and the seed: an answer kept from another
  // build of the concern can never be read through this one's key.
  const id = opaqueId(
    "p",
    `${caseId}|${run ?? ""}|${standing.ref}|${inputs.seed}|${JSON.stringify(shownItem)}`,
  );
  return {
    item: ConfirmItem.parse({ id, ...shownItem }),
    key: {
      id,
      caseId,
      ref: standing.ref,
      standing: standing.standing as "split" | "missed",
      /** Window items dropped past the cap, farthest first. */
      capped: window.length - kept.length,
      candidates: Object.fromEntries(
        labelled.map(({ label, keyed }) => [label, keyed]),
      ) as Record<string, KeyedCandidate>,
    },
  };
};

export type ConfirmKey = ReturnType<typeof confirmItem>["key"];

/**
 * A concern's confirmation from its decided answer: the item a majority named (a comment or another
 * item), or, when at least two passes named real items but not the same one, caught by any item with
 * the disagreement kept. A decoy a majority named is a false confirmation and catches nothing.
 */
export const confirmationOf = (
  key: ConfirmKey,
  answer: { candidate: string; votes: string } | undefined,
) => {
  const vote = (label: string) => {
    if (label === "-") return null;
    if (label === "none" || label === "unsure") return label;
    const keyed = key.candidates[label];
    if (keyed === undefined) return "unknown" as const;
    return keyed.decoy
      ? ("decoy" as const)
      : { group: keyed.group, ref: keyed.ref };
  };
  const votes = (answer?.votes ?? "")
    .split(" ")
    .filter((label) => label !== "")
    .map(vote)
    .filter((one) => one !== null);
  const named =
    answer === undefined ? undefined : key.candidates[answer.candidate];
  const real = votes.filter((one) => typeof one === "object");
  const by =
    named !== undefined && !named.decoy
      ? { group: named.group, ref: named.ref, distance: named.distance }
      : null;
  return {
    ref: key.ref,
    standing: key.standing,
    caught:
      by !== null
        ? by.group === "comment"
          ? ("comment" as const)
          : ("item" as const)
        : real.length >= 2
          ? ("item" as const)
          : null,
    agreed: by !== null,
    by: by === null ? null : { group: by.group, ref: by.ref },
    /** Lines from the concern of the item a majority named; null on another file or side. */
    distance: by?.distance ?? null,
    decoyNamed: named?.decoy === true,
    hasDecoy: Object.values(key.candidates).some((one) => one.decoy),
    votes,
  };
};

/**
 * The confirmation's reading: concerns caught by a comment and by any item, the disagreements, the
 * decoys' false-confirmation rate (decoys a majority named, of concerns shown one) with its Wilson
 * interval, and each pass's decoy votes. `stop` is set when the rate passes 1 in 10, the overseer's
 * bar for any full-set run. The window's reach: confirmed items beyond NEARBY_LINES or on another file,
 * concerns whose candidates were capped, and the build's matched concerns whose pairs all stand
 * outside the window.
 */
export const confirmReport = (
  keys: ReadonlyArray<ConfirmKey>,
  answers: ReadonlyArray<{ id: string; candidate: string; votes: string }>,
  matchedOutsideWindow: number,
) => {
  const byId = new Map(answers.map((answer) => [answer.id, answer]));
  const decided = keys.filter((key) => byId.has(key.id));
  const rows = decided.map((key) => ({
    caseId: key.caseId,
    ...confirmationOf(key, byId.get(key.id)),
  }));
  const withDecoy = rows.filter((row) => row.hasDecoy);
  const decoyNamed = withDecoy.filter((row) => row.decoyNamed).length;
  const votes = rows.flatMap((row) =>
    row.hasDecoy ? row.votes.filter((one) => one !== "unknown") : [],
  );
  const decoyVotes = votes.filter((one) => one === "decoy").length;
  const rate = withDecoy.length === 0 ? null : decoyNamed / withDecoy.length;
  const count = (test: (row: (typeof rows)[number]) => boolean) =>
    rows.filter(test).length;
  return {
    concerns: keys.length,
    decided: decided.length,
    caught: {
      comment: count((row) => row.caught === "comment"),
      any: count((row) => row.caught !== null),
      byStanding: Object.fromEntries(
        (["split", "missed"] as const).map((standing) => [
          standing,
          {
            concerns: count((row) => row.standing === standing),
            comment: count(
              (row) => row.standing === standing && row.caught === "comment",
            ),
            any: count(
              (row) => row.standing === standing && row.caught !== null,
            ),
          },
        ]),
      ),
      byGroup: rows.reduce<Record<string, number>>((out, row) => {
        if (row.by !== null) out[row.by.group] = (out[row.by.group] ?? 0) + 1;
        return out;
      }, {}),
    },
    disagreements: rows
      .filter((row) => row.caught !== null && !row.agreed)
      .map((row) => ({
        caseId: row.caseId,
        ref: row.ref,
        votes: row.votes,
      })),
    decoys: {
      shown: withDecoy.length,
      named: decoyNamed,
      rate,
      interval: wilson(decoyNamed, withDecoy.length),
      passVotes: { cast: votes.length, onDecoy: decoyVotes },
      stop: rate !== null && rate > 0.1,
    },
    window: {
      confirmedBeyondNearby: count(
        (row) =>
          row.by !== null &&
          (row.distance === null || row.distance > NEARBY_LINES),
      ),
      confirmedOnAnotherFile: count(
        (row) => row.by !== null && row.distance === null,
      ),
      capped: keys.filter((key) => key.capped > 0).length,
      matchedOutsideWindow,
    },
  };
};

/** A matched case's run as the confirmation reads it, loaded or, in tests, given. */
export interface ConfirmCase {
  readonly caseId: string;
  readonly source: string;
  /** The run's labels folder, where its matching is and its confirmation goes. */
  readonly labels: string;
  /** The digest of the run's matching when the case was read (matchingDigest). */
  readonly matching: string;
  /** The case's concern labels folder, and its labelling's digest when read (labellingDigest). */
  readonly caseLabels: string;
  readonly labelling: string;
  readonly key: {
    readonly seed: number;
    readonly items: ReadonlyArray<BlindItem>;
  };
  readonly passes: Parameters<typeof concernStandings>[1];
  readonly substantive: ReadonlySet<string>;
  readonly packet: ShownRun["packet"];
  readonly threads: ReadonlyMap<string, ReadonlyArray<string>>;
  readonly diffs: ReadonlyArray<{ name: string; text: string }>;
}

/** Each source's Neuve items, by case, for decoys. */
export const decoyPool = (
  cases: ReadonlyArray<Pick<ConfirmCase, "caseId" | "source" | "key">>,
) => {
  const pool = new Map<string, Array<Decoy>>();
  for (const one of cases)
    pool.set(one.source, [
      ...(pool.get(one.source) ?? []),
      ...one.key.items
        .filter((item) => item.source === "neuve")
        .map((item) => ({ caseId: one.caseId, item })),
    ]);
  return pool;
};

/**
 * Every unmatched concern of the cases as an item and its key, and the window's reach. Each concern's
 * decoy is drawn from other cases of its source, pool by pool (the run's own items, then the first
 * runs'), the kind drawn from its candidates' first, then any kind, in an order from the seed; the
 * key names the pool it came from.
 */
export const confirmBuilt = (
  cases: ReadonlyArray<ConfirmCase>,
  pools: ReadonlyArray<{
    name: string;
    pool: ReadonlyMap<string, ReadonlyArray<Decoy>>;
  }>,
  seed: number,
  run: string | null,
) => {
  let matchedOutsideWindow = 0;
  const built = cases.flatMap((one) => {
    const standings = concernStandings(one.key, one.passes, one.substantive);
    return standings.flatMap((standing, index) => {
      const at = standing.reviewer[0]!;
      const side = at.side ?? "new";
      const owners = ownersOf(one.packet, {
        path: at.path,
        side,
        line: at.line,
      });
      const inWindow = (item: BlindItem) =>
        (item.path === at.path && (item.side ?? "new") === side) ||
        owners.includes(item.ref.split("#")[0]!);
      if (standing.standing === "matched") {
        // The window's reach: a matched concern whose every pair stands where no candidate is drawn.
        if (standing.matchedWith.every((item) => !inWindow(item)))
          matchedOutsideWindow++;
        return [];
      }
      const itemSeed = (seed ^ one.key.seed ^ (index * 0x9e3779b1)) >>> 0;
      // The decoy's kind follows a candidate's, drawn from the seed, so decoys mirror what is shown.
      const groups = one.key.items
        .filter((item) => item.source === "neuve" && inWindow(item))
        .map((item) => item.group);
      const group = shuffled(
        groups.length > 0 ? groups : ["comment"],
        itemSeed,
      )[0]!;
      const decoys = pools.flatMap(({ name, pool }) => {
        const ordered = shuffled(
          (pool.get(one.source) ?? []).filter(
            (decoy) => decoy.caseId !== one.caseId,
          ),
          itemSeed,
        ).map((decoy) => ({ ...decoy, pool: name }));
        return [
          ...ordered.filter((decoy) => decoy.item.group === group),
          ...ordered.filter((decoy) => decoy.item.group !== group),
        ];
      });
      const confirmed = confirmItem(one.caseId, run, standing, {
        items: one.key.items,
        owners,
        thread: one.threads.get(standing.ref) ?? [at.text],
        diffs: one.diffs,
        seed: itemSeed,
        decoys,
      });
      const drawn = Object.values(confirmed.key.candidates).find(
        (candidate) => candidate.decoy,
      );
      return [
        {
          labels: one.labels,
          item: confirmed.item,
          key: {
            ...confirmed.key,
            decoyPool: drawn?.decoy === true ? drawn.pool : null,
          },
        },
      ];
    });
  });
  return { built, matchedOutsideWindow };
};

/** A case's run as the confirmation reads it from the research volume. */
const loadCase = (
  one: ReturnType<typeof matchedCases>[number],
): ConfirmCase => {
  const { key, passes } = readMatching(one.labels);
  return {
    caseId: one.record.caseId,
    source: one.record.source,
    labels: one.labels,
    matching: matchingDigest(one.labels),
    caseLabels: one.caseLabels,
    labelling: labellingDigest(one.caseLabels),
    key,
    passes,
    substantive: substantiveOf(one.caseLabels),
    packet: (JSON.parse(readFileSync(one.show, "utf8")) as ShownRun).packet,
    threads: threadTexts(one.record),
    diffs: firstAndLaterDiffs(one.record),
  };
};

/**
 * The confirmation's items and key into `<folder>`, which must be new or empty: a build never shares a
 * folder, so no kept pass or decision of another build is read. Every matched case of the run (its
 * first, or `run`), each unmatched substantive concern with its candidates and a decoy, drawn from the
 * run's own items and, for a source the run has no other case of, from the first runs'. The key holds
 * the labels folder and the matching and labelling digests of each case it covers, including those
 * with nothing unmatched, so settling writes every case's confirmation, and never over a matching or
 * a concern labelling that changed.
 */
export const buildConfirm = (folder: string, seed: number, run?: string) => {
  if (existsSync(folder) && readdirSync(folder).length > 0)
    throw new Error(
      `${folder} is not empty: a confirmation is built into a folder of its own`,
    );
  const cases = matchedCases(run).map(loadCase);
  const pools = [
    {
      name: run === undefined ? "first runs" : "this run",
      pool: decoyPool(cases),
    },
    ...(run === undefined
      ? []
      : [
          {
            name: "first runs",
            pool: decoyPool(
              matchedCases().map((one) => ({
                caseId: one.record.caseId,
                source: one.record.source,
                key: readMatching(one.caseLabels).key,
              })),
            ),
          },
        ]),
  ];
  const { built, matchedOutsideWindow } = confirmBuilt(
    cases,
    pools,
    seed,
    run ?? null,
  );
  const items = shuffled(
    built.map((one) => one.item),
    seed,
  );
  makeOutputDirectory(treatmentWrite(folder), { recursive: true });
  writeJson(join(folder, "items.json"), {
    version: 1,
    questions: [...CONFIRM_QUESTIONS],
    chunks: rubricChunks(items, CHUNK),
  });
  writeJson(join(folder, "key.json"), {
    version: 1,
    seed,
    run: run ?? null,
    cases: cases.map((one) => ({
      caseId: one.caseId,
      labels: one.labels,
      matching: one.matching,
      caseLabels: one.caseLabels,
      labelling: one.labelling,
    })),
    matchedOutsideWindow,
    keys: built.map((one) => ({ ...one.key, labels: one.labels })),
  });
  return {
    cases: cases.length,
    concerns: built.length,
    decoys: built.filter((one) => one.key.decoyPool !== null).length,
    decoysFromFirstRuns:
      run === undefined
        ? 0
        : built.filter((one) => one.key.decoyPool === "first runs").length,
    capped: built.filter((one) => one.key.capped > 0).length,
    matchedOutsideWindow,
  };
};

/**
 * Reads the decided answers against the key: writes report.json, and, once every concern is decided,
 * each covered case's confirmation.json in its run's labels folder. A partial decision (a calibration
 * on the first chunks) reports and writes nothing per case.
 */
export const settleConfirm = (folder: string) => {
  const key = JSON.parse(readFileSync(join(folder, "key.json"), "utf8")) as {
    run: string | null;
    cases: Array<{
      caseId: string;
      labels: string;
      matching: string;
      caseLabels: string;
      labelling: string;
    }>;
    matchedOutsideWindow: number;
    keys: Array<ConfirmKey & { labels: string }>;
  };
  if (key.cases.some((one) => typeof one.labelling !== "string"))
    throw beforeLabellingDigest(join(folder, "key.json"));
  const decided = ConfirmDecided.parse(
    JSON.parse(readFileSync(join(folder, "decided.json"), "utf8")),
  );
  const report = confirmReport(
    key.keys,
    decided.answers,
    key.matchedOutsideWindow,
  );
  const complete = report.decided === report.concerns;
  // A case re-matched or relabelled since the build is never written: its confirmation would credit
  // the old pairs, or concerns the labels no longer hold.
  const stale: Array<string> = [];
  if (complete && decided.promptDigest !== undefined) {
    const byId = new Map(decided.answers.map((answer) => [answer.id, answer]));
    for (const one of key.cases) {
      if (!existsSync(one.labels)) continue;
      if (
        matchingDigest(one.labels) !== one.matching ||
        labellingDigest(one.caseLabels) !== one.labelling
      ) {
        stale.push(one.caseId);
        continue;
      }
      const file: Confirmation = Confirmation.parse({
        version: 1,
        promptDigest: decided.promptDigest,
        matching: one.matching,
        labelling: one.labelling,
        run: key.run,
        concerns: key.keys
          .filter((row) => row.labels === one.labels)
          .map((row) => {
            const { ref, standing, caught, agreed, by, votes } = confirmationOf(
              row,
              byId.get(row.id),
            );
            return { ref, standing, caught, agreed, by, votes };
          }),
      });
      writeJson(join(treatmentWrite(one.labels), "confirmation.json"), file);
    }
  }
  writeJson(join(folder, "report.json"), {
    ...report,
    complete,
    promptDigest: decided.promptDigest ?? null,
    staleCases: stale,
  });
  return { ...report, complete, staleCases: stale };
};
