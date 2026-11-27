import type { ManifestHunk } from "../manifest.ts";
import { readingName } from "../pi/stages/reading-task.ts";
import {
  SettledBatch as PublisherBatch,
  batchHandle,
  batchKeyOf,
  checkBatch,
} from "../publish-sections-input.ts";
import type { ReadingPlan } from "./plan.ts";
import { briefingLayout } from "./briefing.ts";
import {
  batchGroups,
  ownedRangesOf,
  type BatchRecord,
  type DecidedSection,
  type MapGroup,
  type SettledBatch,
  type SettledOutput,
} from "./settled.ts";

/**
 * The readings' side of per-batch publication (NEU-148, WP8): which batches a review has, which
 * reading tasks each one waits on, and one batch as the publisher (`publishSettled`) takes it, or
 * why it is not settled. Pure: the port methods (`readings/collect.ts`, `batches` and `settle`) read
 * the stored outputs and hand them here. Nothing here decides a lane, a verdict or a disposition:
 * `settledBatches` already did, by the code rule every review uses.
 */

/** One batch of the review, as its waiter knows it. */
export interface ReviewBatch {
  /** `batchKeyOf` of its files: the publisher's batch key. */
  readonly key: string;
  /** Its group: a Map group's ID, or the generated batch's. */
  readonly mapGroup: string;
  /**
   * The names of the reading tasks of every reading group that holds a section of any of the
   * batch's files, in the plan's group order, Assess, Lane review, then the group's briefing (round
   * 27). A file read in two groups waits for both, so its proofs, claims and briefings are all in
   * when it settles.
   */
  readonly readings: ReadonlyArray<string>;
}

/**
 * The review's batches in its batch order (the Map's order, the generated batch last), only those
 * that can be published: a group with at least one section that owns changed lines, as
 * `settledBatches` counts them in its totals. A section no Map group holds is in no batch (a run
 * gap); a generated batch reads nothing and waits on no reading.
 */
export const reviewBatches = (input: {
  readonly plan: ReadingPlan;
  readonly hunks: ReadonlyMap<string, ManifestHunk>;
  readonly groups: ReadonlyArray<MapGroup>;
  readonly sections: ReadonlyArray<DecidedSection>;
}): Array<ReviewBatch> => {
  const pathOf = new Map(
    input.plan.sections.map((section) => [section.key, section.path]),
  );
  const out: Array<ReviewBatch> = [];
  const layout = briefingLayout(input.plan, input.groups);
  for (const group of batchGroups(input.groups, input.sections)) {
    const members = input.sections.filter(
      (s) =>
        s.mapGroup === group.id &&
        ownedRangesOf(s.section, input.hunks).length > 0,
    );
    if (members.length === 0) continue;
    const paths = new Set(members.map((m) => m.section.path));
    const readings = input.plan.groups
      .filter((reading) =>
        reading.keys.some((key) => paths.has(pathOf.get(key) ?? "")),
      )
      .flatMap((reading) =>
        (["assess", "lane-review", "brief"] as const).map((kind) =>
          readingName(kind, reading.id),
        ),
      );
    // A digest shared with other groups is its owner's digest task's: only this batch waits on it.
    const owner = layout.digests.get(group.id);
    if (owner?.kind === "call" && owner.groups.length > 1)
      readings.push(readingName("digest", owner.group));
    out.push({
      key: batchKeyOf(group.files.map((file) => file.path)),
      mapGroup: group.id,
      readings,
    });
  }
  return out;
};

/** Why a batch is not handed to the publisher, as the review reads it (`kind` only). */
export interface NotSettled {
  readonly settled: false;
  readonly gap: {
    readonly key: string;
    /**
     * `not-reached`: a reading or check of the batch was not reached, or has not ended (a follow-on
     * run can read it); `quota`: a provider quota refusal (pending, no follow-on); `refused`: the
     * batch fails a check the publisher makes, or is no batch of the review (a defect, pending).
     */
    readonly kind: "not-reached" | "quota" | "refused";
    readonly detail: string;
  };
}

export type SettleResult =
  { readonly settled: true; readonly batch: PublisherBatch } | NotSettled;

const notSettled = (
  kind: NotSettled["gap"]["kind"],
  key: string,
  detail: string,
): NotSettled => ({
  settled: false,
  gap: { key: `batch-${kind}:${batchHandle(key)}`, kind, detail },
});

/**
 * The old packet's line, and a dropped plan's `collect` disclosure, when a review with the readings
 * on had no reading judge its sections and no batch said so.
 */
export const NO_READINGS = {
  kind: "section-readings",
  detail:
    "Section readings: none ran in this review, so no section was judged by a reading.",
};

/** Why the readings' plan was dropped: it failed, or it was cut at its cut-off (not reached). */
export type PlanDrop = "failed" | "not-reached";
/**
 * The run's one gap when the readings' plan was dropped (`collect.ts`, `storeDroppedPlan`), in the
 * plan's own end words: it failed, or it did not finish before its cut-off. A plan cut off holds its
 * sections for the next run, as a reading not reached does, and says so while they wait; only once
 * a run settles them (no successor) does it say a person decides each one.
 */
export const droppedPlanGap = (why: PlanDrop, settled = true) => ({
  key: "section-readings-dropped",
  kind: "section-readings",
  detail: `Section readings: the plan for reading the changed sections ${
    why === "failed" ? "failed" : "did not finish before its cut-off"
  }, so ${
    why === "not-reached" && !settled
      ? "its sections wait for the next run"
      : "no reading judged them and a person decides each one"
  }.`,
});

/**
 * The publisher's value for a readers' batch: the batch without `withheld` (the comments left out,
 * which its `comments-withheld` gap already discloses, and which the publisher's schema does not
 * take), checked by the publisher's own schema and checks. Undefined fields are left out, as the
 * stored decision holds them, so the same batch is the same value on every call.
 */
export const publisherBatch = (
  batch: SettledBatch,
): { readonly batch: PublisherBatch } | { readonly refused: string } => {
  const { withheld: _withheld, ...rest } = batch;
  const parsed = PublisherBatch.safeParse(JSON.parse(JSON.stringify(rest)));
  if (!parsed.success)
    return {
      refused: `${parsed.error.issues[0]?.path.join(".") ?? ""}: ${parsed.error.issues[0]?.message ?? parsed.error.message}`,
    };
  const refusal = checkBatch(parsed.data);
  return refusal === undefined
    ? { batch: parsed.data }
    : { refused: `${refusal.check}: ${refusal.cause}` };
};

/**
 * One batch of a decided review, settled or not. `ended` lists the batch's reading tasks the caller
 * gave, each with whether it has ended: one not ended leaves the batch not reached, never decided
 * (a reading the caller did not give at all is the collector's failed reading, as `collect` decides
 * it). Otherwise the batch's record from `settledBatches` decides: waiting on a refused reading is a
 * quota refusal; waiting on one not reached is not reached. A batch its readings settled is still
 * pending while a reading was not reached. Failing a publisher check leaves the batch pending. A settled, ready batch is handed over only if the
 * publisher's schema and checks also take it.
 */
export const settleBatch = (input: {
  readonly key: string;
  readonly batches: ReadonlyArray<ReviewBatch>;
  readonly ended: ReadonlyArray<{
    readonly name: string;
    readonly ended: boolean;
  }>;
  readonly settled: Pick<SettledOutput, "batches" | "records">;
  readonly sections: ReadonlyArray<DecidedSection>;
  /** The run can have no successor. */
  readonly final: boolean;
}): SettleResult => {
  const batch = input.batches.find((b) => b.key === input.key);
  if (batch === undefined)
    return notSettled(
      "refused",
      input.key,
      "This batch is not one of the review's batches, so it was not published.",
    );
  const open = input.ended.filter(
    (reading) => batch.readings.includes(reading.name) && !reading.ended,
  ).length;
  if (open > 0)
    return notSettled(
      "not-reached",
      input.key,
      `${open} ${open === 1 ? "reading" : "readings"} of this batch had not ended, so it is still being judged.`,
    );
  let at = 0;
  let record: BatchRecord | undefined;
  let ready: SettledBatch | undefined;
  for (const held of input.settled.records) {
    if (held.mapGroup === batch.mapGroup) {
      record = held;
      if (held.ready) ready = input.settled.batches[at];
      break;
    }
    if (held.ready) at++;
  }
  if (record === undefined)
    return notSettled(
      "refused",
      input.key,
      "This batch has no record in the review's decision, so it was not published.",
    );
  if (!record.settled) {
    const waiting = input.sections.flatMap((s) =>
      s.mapGroup === batch.mapGroup &&
      s.decision !== null &&
      !s.decision.settled
        ? [s.decision.waiting.cause]
        : [],
    );
    const refused = waiting.filter((cause) => cause === "refused").length;
    return refused > 0
      ? notSettled(
          "quota",
          input.key,
          `${refused} ${refused === 1 ? "change" : "changes"} of this batch could not be read: the provider refused the request, so the batch is still being judged.`,
        )
      : notSettled(
          "not-reached",
          input.key,
          `${waiting.length} ${waiting.length === 1 ? "change" : "changes"} of this batch ${waiting.length === 1 ? "was" : "were"} not reached before the review's cut-off, so the batch is still being judged.`,
        );
  }
  // A briefing cut at the cut-off holds its batch as not reached while a follow-on is left, which
  // writes only what is missing; a final run publishes it with code's text and the `briefing-cut`
  // gap (round 27).
  if (record.briefing?.state === "cut" && !input.final)
    return notSettled(
      "not-reached",
      input.key,
      "This batch's written briefing was not reached before the review's cut-off, so it is still being prepared.",
    );
  if (ready === undefined)
    return notSettled(
      "refused",
      input.key,
      `This batch failed ${record.problems.length} of the checks made before publishing, so it was not published.`,
    );
  const handed = publisherBatch(ready);
  return "batch" in handed
    ? { settled: true, batch: handed.batch }
    : notSettled(
        "refused",
        input.key,
        "This batch failed a check made before publishing, so it was not published.",
      );
};
