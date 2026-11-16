import { createHash } from "node:crypto";
import type { CheckedItem } from "./validate.ts";
import type {
  AdditionGrading,
  Grade,
  HunkPool,
  LabelItem,
  QueueEntry,
} from "./schema.ts";

/**
 * Labeller additions (9.16), the owner's adjudication queue and the resolved gold.
 *
 * An addition enters the gold only when the other family's grader finds it valid and at least
 * useful. The queue follows the light package of decision 9.36: on held-out, every disagreement
 * involving "necessary", 25% of agreed necessary items, addition conflicts involving "necessary",
 * 2 sampled agreed-irrelevant items per hunk and 1 sampled agreed-misleading item per hunk where any
 * exist; on development, only disagreements involving "necessary" (an addition whose grader and
 * labeller disagree about "necessary" counts as one). Every other disagreement takes the lower grade.
 */

export interface QueuePolicy {
  readonly name: string;
  /** Shares in [0, 1] of the eligible items, drawn per item. */
  readonly necessaryDisagreements: number;
  readonly agreedNecessary: number;
  readonly necessaryAdditionConflicts: number;
  /** Fixed counts per hunk, the lowest draws among the eligible items. */
  readonly bothIrrelevantPerHunk: number;
  readonly agreedMisleadingPerHunk: number;
}

export const HELD_OUT_POLICY: QueuePolicy = {
  name: "held-out light package (9.36)",
  necessaryDisagreements: 1,
  agreedNecessary: 0.25,
  necessaryAdditionConflicts: 1,
  bothIrrelevantPerHunk: 2,
  agreedMisleadingPerHunk: 1,
};
/**
 * The council set (9.53): the items the council adjudicates in place of the owner, on any split.
 * The same shares and counts as the held-out light package.
 */
export const COUNCIL_POLICY: QueuePolicy = {
  ...HELD_OUT_POLICY,
  name: "council set (9.53): necessary splits and addition conflicts, 25% agreed necessary, 2 agreed irrelevant and 1 agreed misleading per hunk",
};
export const DEV_POLICY: QueuePolicy = {
  name: "development light package (9.36)",
  necessaryDisagreements: 1,
  agreedNecessary: 0,
  necessaryAdditionConflicts: 1,
  bothIrrelevantPerHunk: 0,
  agreedMisleadingPerHunk: 0,
};

/**
 * The queue policy for a split. `--policy council` selects the council set (9.53) on any split;
 * held-out always takes it, since 9.58 labels held-out with the same pipeline and council as the
 * development gold. The older held-out light package (9.36) is never a held-out queue.
 */
export const queuePolicyFor = (
  split: "dev" | "held-out",
  requested: string | undefined,
): QueuePolicy =>
  requested === "council" || split === "held-out" ? COUNCIL_POLICY : DEV_POLICY;

/**
 * The lower-grade rule (9.36) on the relevance scale of the proposal (necessary 2, useful 1, other
 * 0): disagreements resolve to the lower relevance. Misleading is a wrong attribution, not a
 * relevance level, so it stands only when every grader says so; any other split at relevance 0
 * resolves to irrelevant.
 */
const RELEVANCE: Record<Grade, number> = {
  necessary: 2,
  useful: 1,
  misleading: 0,
  irrelevant: 0,
};
export const lowerGrade = (grades: ReadonlyArray<Grade>): Grade => {
  if (grades.every((grade) => grade === grades[0])) return grades[0]!;
  const lowest = Math.min(...grades.map((grade) => RELEVANCE[grade]));
  return lowest === 2 ? "necessary" : lowest === 1 ? "useful" : "irrelevant";
};
export const LOWER_GRADE_RULE =
  "relevance necessary 2, useful 1, misleading and irrelevant 0; a disagreement takes the lower relevance; misleading stands only when all agree, otherwise 0 resolves to irrelevant";

export const QUEUE_SEED = "neuve-m4-b3-adjudication-v1";

/** A deterministic draw in [0, 1) per key, so samples are reproducible and independent of order. */
export const draw = (seed: string, key: string) =>
  Number.parseInt(
    createHash("sha256")
      .update(`${seed}\u0000${key}`)
      .digest("hex")
      .slice(0, 12),
    16,
  ) /
  2 ** 48;

export interface Addition {
  readonly id: string;
  readonly by: string;
  readonly item: LabelItem;
  readonly availability: CheckedItem["availability"];
  /** Additions from the other labeller that point at the same place (overlapping span or commit). */
  readonly matchedBy: ReadonlyArray<string>;
}

export const regionText = (item: LabelItem) => {
  const region = item.region;
  if (region.source === "commit") return `commit ${region.commit}`;
  const lines =
    region.startLine === null
      ? ""
      : `:${region.startLine}-${region.endLine ?? region.startLine}`;
  return `${region.source === "range-doc" ? "range doc " : region.source === "range-change" ? "range change " : ""}${region.path}${lines}`;
};

const samePlace = (a: LabelItem, b: LabelItem) => {
  if (a.region.source !== b.region.source) return false;
  if (a.region.source === "commit")
    return (
      a.region.commit !== null &&
      b.region.commit !== null &&
      (a.region.commit.startsWith(b.region.commit) ||
        b.region.commit.startsWith(a.region.commit))
    );
  if (a.region.path !== b.region.path) return false;
  if (a.region.startLine === null || b.region.startLine === null) return true;
  return (
    a.region.startLine <= (b.region.endLine ?? b.region.startLine) &&
    b.region.startLine <= (a.region.endLine ?? a.region.startLine)
  );
};

/** Each labeller's additions with ids `<labeller>-a<n>` and cross-labeller matches. */
export const collectAdditions = (
  checked: ReadonlyMap<string, ReadonlyArray<CheckedItem>>,
) => {
  const out: Array<Addition> = [];
  for (const [by, items] of checked) {
    let n = 0;
    for (const entry of items) {
      if (!entry.item.added) continue;
      // Numbered over every added item, so ids keep the output's order when a region is dropped.
      n++;
      if (entry.dropped) continue;
      if (entry.problems.length > 0)
        throw new Error(
          `${by} addition ${entry.index} is invalid (${entry.problems.join("; ")}); refuse the output instead of dropping it`,
        );
      const matchedBy = [...checked.entries()]
        .filter(([other]) => other !== by)
        .filter(([, others]) =>
          others.some(
            (o) => o.item.added && !o.dropped && samePlace(o.item, entry.item),
          ),
        )
        .map(([other]) => other);
      out.push({
        id: `${by}-a${n}`,
        by,
        item: entry.item,
        availability: entry.availability,
        matchedBy,
      });
    }
  }
  return out;
};

export interface GoldAddition {
  readonly addition: Addition;
  readonly grader: string;
  readonly graderGrade: Grade;
  readonly valid: boolean;
  readonly entersGold: boolean;
  /**
   * Gold that a pass 1 retriever should have found: base regions outside the range's changes, and
   * earlier commits (scored from pass 2, M6). Same-batch regions, the range's own commits, in-range
   * documents and hindsight stay in the gold with their status but are never retrieval targets.
   */
  readonly retrievalTarget: boolean;
  readonly conflict: boolean;
}

export const RETRIEVAL_TARGETS: ReadonlySet<string> = new Set([
  "base-committed",
  "base-partly-same-batch",
  "commit-earlier",
]);

/** 9.16: valid and at least useful by the grader enters the gold; any grade difference is a conflict. */
export const judgeAdditions = (
  additions: ReadonlyArray<Addition>,
  gradings: ReadonlyMap<
    string,
    { readonly grader: string; readonly grading: AdditionGrading }
  >,
): Array<GoldAddition> =>
  additions.map((addition) => {
    const held = gradings.get(addition.by);
    const grade = held?.grading.grades.find(
      (g) => g.additionId === addition.id,
    );
    const graderGrade = grade?.grade ?? "irrelevant";
    const valid = grade?.valid ?? false;
    const entersGold =
      grade !== undefined &&
      valid &&
      (graderGrade === "necessary" || graderGrade === "useful");
    return {
      addition,
      grader: held?.grader ?? "none",
      graderGrade,
      valid,
      entersGold,
      retrievalTarget:
        entersGold && RETRIEVAL_TARGETS.has(addition.availability),
      conflict:
        grade === undefined || !valid || graderGrade !== addition.item.grade,
    };
  });

export interface QueueInputs {
  readonly split: "dev" | "held-out";
  readonly pool: HunkPool;
  readonly grades: ReadonlyMap<string, ReadonlyMap<string, Grade>>;
  readonly additions: ReadonlyArray<GoldAddition>;
  readonly policy: QueuePolicy;
  readonly seed?: string;
}

const candidateRegion = (candidate: HunkPool["candidates"][number]) =>
  candidate.type === "commit"
    ? `commit ${candidate.commit}`
    : `${candidate.path}:${candidate.startLine}-${candidate.endLine}`;

/** Every candidate's grade from every labeller; a missing grade is an error, never skipped. */
export const candidateLabels = (
  pool: HunkPool,
  grades: ReadonlyMap<string, ReadonlyMap<string, Grade>>,
) => {
  const labellers = [...grades.keys()].sort();
  return pool.candidates.map((candidate) => {
    const labels: Record<string, Grade> = {};
    for (const labeller of labellers) {
      const grade = grades.get(labeller)?.get(candidate.id);
      if (grade === undefined)
        throw new Error(
          `${pool.caseId}/${pool.hunkId}/${candidate.id} lacks a grade from ${labeller}`,
        );
      labels[labeller] = grade;
    }
    return { candidate, labels, values: Object.values(labels) };
  });
};

export const buildQueue = (inputs: QueueInputs): Array<QueueEntry> => {
  const seed = inputs.seed ?? QUEUE_SEED;
  const { pool, policy } = inputs;
  const out: Array<QueueEntry> = [];
  const entry = (
    key: string,
    reason: QueueEntry["reason"],
    candidateId: string | null,
    region: string,
    labels: Record<string, Grade>,
    addition: QueueEntry["addition"],
  ): QueueEntry => ({
    key,
    split: inputs.split,
    caseId: pool.caseId,
    hunkId: pool.hunkId,
    reason,
    candidateId,
    region,
    labels,
    addition,
    ownerGrade: null,
    ownerNote: null,
  });
  const keyOf = (id: string) => `${pool.caseId}/${pool.hunkId}/${id}`;
  const rows = candidateLabels(pool, inputs.grades);
  const bothIrrelevant: typeof rows = [];
  const bothMisleading: typeof rows = [];
  for (const row of rows) {
    const key = keyOf(row.candidate.id);
    const agreed = row.values.every((value) => value === row.values[0]);
    if (!agreed) {
      if (
        row.values.includes("necessary") &&
        draw(seed, key) < policy.necessaryDisagreements
      )
        out.push(
          entry(
            key,
            "disagreement",
            row.candidate.id,
            candidateRegion(row.candidate),
            row.labels,
            null,
          ),
        );
      continue;
    }
    if (
      row.values[0] === "necessary" &&
      draw(seed, key) < policy.agreedNecessary
    )
      out.push(
        entry(
          key,
          "necessary",
          row.candidate.id,
          candidateRegion(row.candidate),
          row.labels,
          null,
        ),
      );
    if (row.values[0] === "irrelevant") bothIrrelevant.push(row);
    if (row.values[0] === "misleading") bothMisleading.push(row);
  }
  const lowest = (list: typeof rows, count: number) =>
    [...list]
      .sort(
        (a, b) =>
          draw(seed, keyOf(a.candidate.id)) - draw(seed, keyOf(b.candidate.id)),
      )
      .slice(0, count);
  for (const row of lowest(bothIrrelevant, policy.bothIrrelevantPerHunk))
    out.push(
      entry(
        keyOf(row.candidate.id),
        "both-irrelevant-sample",
        row.candidate.id,
        candidateRegion(row.candidate),
        row.labels,
        null,
      ),
    );
  for (const row of lowest(bothMisleading, policy.agreedMisleadingPerHunk))
    out.push(
      entry(
        keyOf(row.candidate.id),
        "agreed-misleading-sample",
        row.candidate.id,
        candidateRegion(row.candidate),
        row.labels,
        null,
      ),
    );
  for (const judged of inputs.additions) {
    const key = keyOf(judged.addition.id);
    const involvesNecessary =
      judged.addition.item.grade === "necessary" ||
      judged.graderGrade === "necessary";
    if (
      !judged.conflict ||
      !involvesNecessary ||
      draw(seed, key) >= policy.necessaryAdditionConflicts
    )
      continue;
    out.push(
      entry(
        key,
        "addition-conflict",
        null,
        regionText(judged.addition.item),
        { [judged.addition.by]: judged.addition.item.grade },
        {
          by: judged.addition.by,
          grader: judged.grader,
          graderGrade: judged.graderGrade,
          valid: judged.valid,
        },
      ),
    );
  }
  return out;
};

/** One resolved gold item: a pooled candidate or an addition that entered the gold. */
export interface GoldItem {
  readonly id: string;
  readonly source: "pool" | "addition";
  readonly region: string;
  readonly kind: string;
  readonly labels: Readonly<Record<string, Grade>>;
  readonly grade: Grade;
  /** agreed, lower-grade (9.36) or owner (queued; the grade is the provisional lower grade). */
  readonly status:
    | "agreed"
    | "lower-grade"
    | "owner"
    | "owner-decided"
    | "council-decided"
    | "council-tie-rule";
  /** The owner's verdict, when one was imported for this item. */
  readonly owner?: OwnerDecision;
  /** Retrieval status: committed, same-batch, in-range document, earlier or later commit. */
  readonly availability: string;
  readonly retrievalTarget: boolean;
}

export interface OwnerDecision {
  /** The final grade, which the gold takes. */
  readonly grade: Grade;
  readonly note: string | null;
  readonly decidedBy: string;
  readonly decidedAt: string;
  /** Decide-then-reveal (9.38): the blind grade given before the labellers were revealed. */
  readonly firstGrade?: Grade;
  readonly firstAt?: string;
  readonly batch?: string;
  /** Set when the council (9.53) decided: the round reached and every round's votes. */
  readonly council?: {
    /** 9.56: the re-run also tied, so the grade is the lower relevance of the final votes. */
    readonly tieRule?: boolean;
    readonly round: number;
    readonly votes: ReadonlyArray<{
      readonly round: number;
      readonly votes: Readonly<Record<string, string>>;
    }>;
  };
}

/**
 * The hunk's gold with the 9.36 resolution: owner-queued items keep a provisional lower grade until
 * the owner's verdict (keyed by queue key) replaces it.
 */
export const resolveGold = (
  pool: HunkPool,
  grades: ReadonlyMap<string, ReadonlyMap<string, Grade>>,
  additions: ReadonlyArray<GoldAddition>,
  queued: ReadonlySet<string>,
  decided: ReadonlyMap<string, OwnerDecision> = new Map(),
): Array<GoldItem> => {
  const items: Array<GoldItem> = [];
  for (const row of candidateLabels(pool, grades)) {
    const key = `${pool.caseId}/${pool.hunkId}/${row.candidate.id}`;
    const agreed = row.values.every((value) => value === row.values[0]);
    const availability =
      row.candidate.type === "commit"
        ? `commit-${row.candidate.historyTiming}`
        : `base-${row.candidate.rangeStatus}`;
    const verdict = decided.get(key);
    items.push({
      id: row.candidate.id,
      source: "pool",
      region: candidateRegion(row.candidate),
      kind: row.candidate.kind,
      labels: row.labels,
      grade: verdict?.grade ?? lowerGrade(row.values),
      ...(verdict === undefined ? {} : { owner: verdict }),
      status:
        verdict !== undefined
          ? verdict.council !== undefined
            ? verdict.council.tieRule === true
              ? "council-tie-rule"
              : "council-decided"
            : "owner-decided"
          : agreed
            ? queued.has(key)
              ? "owner"
              : "agreed"
            : queued.has(key)
              ? "owner"
              : "lower-grade",
      availability,
      retrievalTarget: RETRIEVAL_TARGETS.has(availability),
    });
  }
  for (const judged of additions) {
    const key = `${pool.caseId}/${pool.hunkId}/${judged.addition.id}`;
    const verdict = decided.get(key);
    // Validity is the grader's call and no adjudicator is asked about it, so an invalid addition
    // stays out of the gold whatever grade a council or owner gave it.
    if (!judged.valid) continue;
    const grade =
      verdict?.grade ??
      lowerGrade([judged.addition.item.grade, judged.graderGrade]);
    const owner = queued.has(key);
    if (
      verdict === undefined &&
      !owner &&
      grade !== "necessary" &&
      grade !== "useful"
    )
      continue;
    items.push({
      id: judged.addition.id,
      source: "addition",
      region: regionText(judged.addition.item),
      kind: judged.addition.item.kind,
      labels: {
        [judged.addition.by]: judged.addition.item.grade,
        [`${judged.grader} (grader)`]: judged.graderGrade,
      },
      grade,
      ...(verdict === undefined ? {} : { owner: verdict }),
      status:
        verdict !== undefined
          ? verdict.council !== undefined
            ? verdict.council.tieRule === true
              ? "council-tie-rule"
              : "council-decided"
            : "owner-decided"
          : owner
            ? "owner"
            : judged.conflict
              ? "lower-grade"
              : "agreed",
      availability: judged.addition.availability,
      retrievalTarget: RETRIEVAL_TARGETS.has(judged.addition.availability),
    });
  }
  return items;
};
