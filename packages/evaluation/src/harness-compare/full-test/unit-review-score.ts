import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  caughtDefect,
  ownedLineKeys,
  packetUnits,
  READS_SECTIONS,
  type Lane,
  type PacketLite,
  type PacketUnitLite,
  type SidedRange,
  type StoredRun,
} from "./packets.ts";
import type { PlantedRecord } from "./planted-light.ts";

/**
 * Scoring the unit review step at a forced pack size (12.34; NEU-148): set B's planted problems, and
 * the position-in-pack effect on any case, against the same cases at one unit per call.
 *
 * Both read the step's own record of each unit it reviewed, one entry per unit:
 * `{unit, pack, packSize, position, outcome, rawVerdict}`. The step writes it; this reads it from the
 * run's `show.json` (`unitReview`) or, beside it, `unit-review.json`. `unit` is the packet unit's id
 * or its local name. Nothing here runs a review.
 */

export const UnitReviewRecord = z.strictObject({
  unit: z.string().min(1),
  pack: z.string().min(1),
  packSize: z.int().min(1),
  position: z.int().min(1),
  /** The call's outcome for the unit: ok, or why the unit fell back. */
  outcome: z.string().min(1),
  /** The step's verdict before Link reconciles it; null when the call gave none. */
  rawVerdict: z.enum(["approve", "request-changes"]).nullable(),
});
export type UnitReviewRecord = z.infer<typeof UnitReviewRecord>;

/** A run's unit review records: `show.json`'s `unitReview`, else `unit-review.json` beside it; none is an error. */
export const unitReviewRecords = (
  showFile: string,
  shown: { readonly unitReview?: unknown },
): Array<UnitReviewRecord> => {
  const beside = join(showFile, "..", "unit-review.json");
  const raw =
    shown.unitReview ??
    (existsSync(beside) ? JSON.parse(readFileSync(beside, "utf8")) : undefined);
  if (raw === undefined)
    throw new Error(
      `${showFile} has no unit review records (unitReview, or unit-review.json beside it)`,
    );
  return z.array(UnitReviewRecord).parse(raw);
};

const recordOf = (
  records: ReadonlyArray<UnitReviewRecord>,
  unit: PacketUnitLite,
) =>
  records.find((r) => r.unit === unit.unitId || r.unit === unit.local) ?? null;

const laneOf = (unit: PacketUnitLite): Lane | null =>
  unit.assessment?.payload.lane ?? null;

/**
 * What the unit says was checked. The step's "what was checked" line is read here, at
 * `content.checked` (text, or `{text}`): the one place to point at wherever the step publishes it.
 */
export const checkedText = (unit: PacketUnitLite): string => {
  const checked = (unit.content as { checked?: unknown }).checked;
  if (typeof checked === "string") return checked;
  if (
    typeof checked === "object" &&
    checked !== null &&
    typeof (checked as { text?: unknown }).text === "string"
  )
    return (checked as { text: string }).text;
  return "";
};

/** A quarter of a pack: 1 for its first quarter up to 4 for its last. */
export const quarterOf = (position: number, packSize: number) =>
  Math.min(4, Math.max(1, Math.ceil((position / packSize) * 4)));

/**
 * One planted variant in one run. Caught when a request for changes rests on a defect at the planted
 * lines (packets.ts `caughtDefect`, by anchor or evidence), or when a unit owning them goes to a person
 * (human-suggested or human-required) and its what-was-checked names the plant. A unit with no
 * assessment never catches.
 */
export const scorePlant = (
  planted: PlantedRecord,
  shown: StoredRun,
  records: ReadonlyArray<UnitReviewRecord>,
) => {
  const keys = new Set(planted.lineKeys);
  // Ownership, lane, verdict and findings only, so the sections shape reads too.
  const reads = READS_SECTIONS;
  const owning = packetUnits(shown.packet, {
    where: `planted:${planted.variant} (${planted.caseId})`,
    reads,
  })
    .map(({ unit }) => unit)
    .filter((unit) => [...ownedLineKeys(unit)].some((k) => keys.has(k)));
  const byRequest = caughtDefect(
    shown,
    planted.lines as ReadonlyArray<SidedRange>,
    reads,
  );
  const mentions = planted.mentions.map((m) => m.toLowerCase());
  const named = owning.filter((unit) => {
    const lane = laneOf(unit);
    const text = checkedText(unit).toLowerCase();
    return (
      (lane === "human-suggested" || lane === "human-required") &&
      mentions.some((m) => m !== "" && text.includes(m))
    );
  });
  const reviewed = owning.map((unit) => ({
    unit: unit.unitId,
    lane: laneOf(unit),
    record: recordOf(records, unit),
  }));
  return {
    variant: planted.variant,
    caseId: planted.caseId,
    problem: planted.problem,
    style: planted.style,
    aimedBucket: planted.bucket,
    caught: byRequest.caught || named.length > 0,
    how: byRequest.caught
      ? "request for changes"
      : named.length > 0
        ? "a person's lane, named"
        : null,
    owningUnits: owning.length,
    unassessed: owning.filter((unit) => laneOf(unit) === null).length,
    units: reviewed,
    /** Where the plant's unit sat in its pack, by the step's record (its first owning unit). */
    position: reviewed.find((r) => r.record !== null)?.record ?? null,
  };
};

/** Set B in one run: every variant's result, and the catch per problem, per aimed bucket and per quarter of a pack. */
export const scorePlanted = (
  results: ReadonlyArray<ReturnType<typeof scorePlant>>,
) => {
  const group = (by: (r: (typeof results)[number]) => string | null) => {
    const out: Record<string, { variants: number; caught: number }> = {};
    for (const r of results) {
      const key = by(r);
      if (key === null) continue;
      const g = (out[key] ??= { variants: 0, caught: 0 });
      g.variants++;
      if (r.caught) g.caught++;
    }
    return out;
  };
  return {
    variants: results.length,
    caught: results.filter((r) => r.caught).length,
    // The 12.33 guard: every planted problem caught, at every pack size.
    guardHolds: results.every((r) => r.caught),
    byProblem: group((r) => r.problem),
    byAimedBucket: group((r) => r.aimedBucket),
    byQuarter: group((r) =>
      r.position === null
        ? null
        : `quarter ${quarterOf(r.position.position, r.position.packSize)}`,
    ),
    misses: results
      .filter((r) => !r.caught)
      .map((r) => ({
        variant: r.variant,
        problem: r.problem,
        style: r.style,
        unassessed: r.unassessed,
        rawVerdicts: r.units.map((u) => u.record?.rawVerdict ?? null),
        lanes: r.units.map((u) => u.lane),
      })),
  };
};

/** A unit's identity across runs of one case: the changed lines it owns (unit ids differ per run). */
const signature = (unit: PacketUnitLite) =>
  [...ownedLineKeys(unit)].sort().join(" ");

/**
 * The position effect: each unit of a run at pack size k against the same unit (same owned lines) in
 * the run at one unit per call, by the quarter of its pack it sat in. A verdict or lane that differs is
 * a flip; a request for changes the one-unit run did not make is a new request, counted apart when the
 * unit holds no labelled line that needs or drew a person (`labelled`, from the replay key); a unit the
 * step failed on is counted by its outcome. Compare each quarter's flips with the one-unit run's own
 * two-run flip rate (the noise bar).
 */
export const positionEffect = (
  pairs: ReadonlyArray<{
    readonly caseId: string;
    readonly base: {
      readonly packet: PacketLite | null;
      readonly records: ReadonlyArray<UnitReviewRecord>;
    };
    readonly next: {
      readonly packet: PacketLite | null;
      readonly records: ReadonlyArray<UnitReviewRecord>;
    };
    /** Line keys of the case labelled needs-person or discussed; absent, new requests are not split. */
    readonly labelled?: ReadonlySet<string> | undefined;
  }>,
) => {
  const quarters: Record<
    string,
    {
      units: number;
      verdictFlips: number;
      laneFlips: number;
      newRequests: number;
      newRequestsOnUnlabelled: number;
      notOk: number;
    }
  > = {};
  let unmatched = 0;
  for (const pair of pairs) {
    const base = new Map(
      packetUnits(pair.base.packet, {
        where: `case ${pair.caseId}'s base run`,
        reads: READS_SECTIONS,
      }).map(({ unit }) => [signature(unit), unit]),
    );
    for (const { unit } of packetUnits(pair.next.packet, {
      where: `case ${pair.caseId}'s run`,
      reads: READS_SECTIONS,
    })) {
      const record = recordOf(pair.next.records, unit);
      const before = base.get(signature(unit));
      if (record === null || before === undefined) {
        unmatched++;
        continue;
      }
      const was = recordOf(pair.base.records, before);
      const q = (quarters[
        `quarter ${quarterOf(record.position, record.packSize)}`
      ] ??= {
        units: 0,
        verdictFlips: 0,
        laneFlips: 0,
        newRequests: 0,
        newRequestsOnUnlabelled: 0,
        notOk: 0,
      });
      q.units++;
      if (record.outcome !== "ok") q.notOk++;
      if ((was?.rawVerdict ?? null) !== record.rawVerdict) q.verdictFlips++;
      if (laneOf(before) !== laneOf(unit)) q.laneFlips++;
      if (
        record.rawVerdict === "request-changes" &&
        was?.rawVerdict !== "request-changes"
      ) {
        q.newRequests++;
        if (
          pair.labelled !== undefined &&
          ![...ownedLineKeys(unit)].some((k) => pair.labelled!.has(k))
        )
          q.newRequestsOnUnlabelled++;
      }
    }
  }
  return { cases: pairs.length, unmatched, quarters };
};
