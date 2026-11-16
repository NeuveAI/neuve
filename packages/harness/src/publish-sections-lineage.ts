import { Effect, Option } from "effect";
import { Blobs, Log, UnitRanges } from "@neuve/records-core";
import {
  PacketManifest,
  safeRead,
  type Lane,
  type OwnedRange,
  type RecordEvent,
} from "@neuve/records-schema";
import { gitMeasured } from "./git.ts";

/**
 * Lineage for the new publisher (records design, section 2): the earlier units a packet holds, and
 * how a new unit relates to them, section by section ("the same review" is `Lineage.earlierReview`
 * in records-core, asked with `gitIsAncestor`). Comparing is a pure function of two unit sets, so it replays identically; which packets
 * are compared is fixed in the review's first publication plan.
 */

type Of<K extends RecordEvent["kind"]> = Extract<RecordEvent, { kind: K }>;

/**
 * `git merge-base --is-ancestor` in `repository`, as `Lineage.earlierReview` asks it: a git that
 * cannot answer (no such commit, no repository) answers no, so lineage says less, never more.
 */
export const gitIsAncestor =
  (repository: string) => (ancestor: string, descendant: string) =>
    Effect.map(
      Effect.result(
        gitMeasured(repository, [
          "merge-base",
          "--is-ancestor",
          ancestor,
          descendant,
        ]),
      ),
      (result) => result._tag === "Success",
    );

/** One section of an earlier unit, as lineage compares it. */
export interface ComparedSection {
  readonly key: string;
  readonly path: string;
  readonly kind: string;
  readonly name: string | null;
  readonly start: number;
  /** Its span's lines and the side they are on; null when it has no span. */
  readonly where: {
    readonly startLine: number;
    readonly endLine: number;
  } | null;
  readonly side: string | undefined;
  readonly ranges: ReadonlyArray<UnitRanges.UnitRange>;
}

/** An earlier unit: its sections when it is a version 3 unit, and its ranges always. */
export interface EarlierUnit {
  readonly unitId: string;
  readonly cycleId: string;
  /** The review that published it: its sequence's run key, else its run. */
  readonly review: string;
  /** The head its packet reviewed. */
  readonly head: string;
  readonly lane: Lane | null;
  readonly sections: ReadonlyArray<ComparedSection> | undefined;
  readonly ranges: ReadonlyArray<UnitRanges.UnitRange>;
}

/**
 * A packet event and its manifest, read from the manifest's blob: undefined when the event is not a
 * packet, or its manifest is not a blob, is pruned or missing, or does not decode.
 */
export const packetManifest = (packetId: string) =>
  Effect.gen(function* () {
    const held = yield* Log.get(packetId);
    if (Option.isNone(held)) return undefined;
    const packet = held.value.event;
    if (
      packet.kind !== "packet.published@1" &&
      packet.kind !== "packet.published@2"
    )
      return undefined;
    const ref = packet.refs[0].ref;
    if (!ref.startsWith("blob:")) return undefined;
    const blobs = yield* Blobs.BlobStore;
    const read = yield* Effect.result(blobs.get(ref.slice("blob:".length)));
    if (read._tag === "Failure" || read.success._tag === "Pruned")
      return undefined;
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(read.success.bytes));
    } catch {
      return undefined;
    }
    const manifest = safeRead(PacketManifest, json);
    return manifest.success ? { packet, manifest: manifest.data } : undefined;
  });

/**
 * The units a packet's manifest names, each with its newest recording and assessment among the
 * events the manifest names, read through `UnitRanges.unitRanges`: a version 3 unit gives its
 * sections, a version 1 or 2 unit its ranges only. A unit whose recording cannot be read is left
 * out, and so is every unit of a manifest that cannot be read: lineage then says less, never more.
 */
export const earlierUnits = (packetId: string) =>
  Effect.gen(function* () {
    const read = yield* packetManifest(packetId);
    if (read === undefined) return [];
    const { packet, manifest } = read;
    const cycleId = packet.attribution.cycleId;
    const units: Array<EarlierUnit> = [];
    for (const batch of manifest.batches) {
      const events: Array<RecordEvent> = [];
      const seen = new Set<string>();
      for (const named of [
        ...batch.events,
        ...batch.units.flatMap((unit) => unit.events ?? []),
      ]) {
        if (typeof named.id !== "string" || seen.has(named.id)) continue;
        seen.add(named.id);
        const event = yield* Log.get(named.id);
        if (Option.isSome(event)) events.push(event.value.event);
      }
      for (const unit of batch.units) {
        const on = events.filter(
          (e) =>
            (e.attribution as { unitIds?: ReadonlyArray<string> } | undefined)
              ?.unitIds?.[0] === unit.unitId,
        );
        const newest = <E extends RecordEvent>(list: ReadonlyArray<E>) =>
          list.reduce<E | undefined>(
            (best, e) => (best === undefined || e.id > best.id ? e : best),
            undefined,
          );
        const recording = newest(on.filter(UnitRanges.isUnitEvent));
        if (recording === undefined) continue;
        const assessment = newest(
          on.filter(
            (
              e,
            ): e is Of<
              | "assessment.recorded@1"
              | "assessment.recorded@2"
              | "assessment.recorded@3"
              | "assessment.recorded@4"
            > => e.kind.startsWith("assessment.recorded@"),
          ),
        );
        const ranges = yield* UnitRanges.unitRanges(recording);
        if (ranges._tag !== "Ranges") continue;
        units.push({
          unitId: unit.unitId,
          cycleId,
          review:
            manifest.sequence?.runKey ??
            manifest.run?.runKey ??
            packet.attribution.runId,
          head: packet.attribution.range.headOid,
          lane: assessment?.payload.lane ?? null,
          sections:
            recording.kind === "unit.recorded@3"
              ? (ranges.sections ?? []).map((section) => ({
                  key: section.key,
                  path: section.parts.path,
                  kind: section.parts.kind,
                  name: section.parts.name,
                  start: section.where?.startLine ?? Number.MAX_SAFE_INTEGER,
                  where:
                    section.where === null
                      ? null
                      : {
                          startLine: section.where.startLine,
                          endLine: section.where.endLine,
                        },
                  side:
                    typeof section.parts.side === "string"
                      ? section.parts.side
                      : undefined,
                  ranges: section.ownedRanges.map((range) =>
                    range.kind === "lines"
                      ? {
                          kind: "lines" as const,
                          path: range.path,
                          side: range.side,
                          startLine: range.startLine,
                          endLine: range.endLine,
                        }
                      : {
                          kind: "whole-nontext" as const,
                          path: range.path,
                          side: range.side,
                        },
                  ),
                }))
              : undefined,
          ranges: ranges.ranges,
        });
      }
    }
    return units;
  });

/** A section of a unit about to be published. */
export interface NewSection {
  readonly key: string;
  readonly kind: string;
  readonly name: string | null;
  readonly start: number;
  readonly ranges: ReadonlyArray<OwnedRange>;
}

export interface NewUnit {
  /** The unit's key; lineage is returned by it. */
  readonly key: string;
  readonly path: string;
  readonly sections: ReadonlyArray<NewSection>;
}

/** One entry of `lineage.recorded@1`'s `from`. */
export interface LineageFrom {
  readonly unitId: string;
  readonly cycleId: string;
  readonly relation: "unchanged" | "changed";
  readonly unchanged: number;
  readonly changed: number;
  readonly lane: Lane | null;
}

const overlaps = (a: UnitRanges.UnitRange, b: UnitRanges.UnitRange) =>
  a.path === b.path &&
  (a.side === undefined || b.side === undefined || a.side === b.side) &&
  (a.kind === "whole-nontext" ||
    b.kind === "whole-nontext" ||
    (a.startLine <= b.endLine && b.startLine <= a.endLine));

const byPlace = (
  a: { readonly start: number; readonly key: string },
  b: { readonly start: number; readonly key: string },
) => a.start - b.start || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * How each new unit relates to the earlier units of one packet, file by file. A new section is
 * unchanged in an earlier unit that holds its key; else it is changed in the earlier unit whose
 * section of the same kind and name stands at the same place among that file's repeats (file order,
 * by `where`, among the sections no key matched); and, inside one cycle, changed in every earlier
 * unit whose owned lines it overlaps (another cut of the same lines). A relation is `unchanged`
 * only when every section of the new unit is unchanged in that one earlier unit. Every earlier unit
 * related, those sharing most sections first; the writer names at most 64 and says when it cuts.
 */
export const compareUnits = (
  units: ReadonlyArray<NewUnit>,
  earlier: ReadonlyArray<EarlierUnit>,
  sameCycle: boolean,
) => {
  // Per new unit, per earlier unit: the sections unchanged there and those changed.
  const relations = new Map<
    string,
    Map<string, { unchanged: Set<string>; changed: Set<string> }>
  >();
  const relate = (
    unitKey: string,
    earlierId: string,
    section: string,
    how: "unchanged" | "changed",
  ) => {
    const byEarlier = relations.get(unitKey) ?? new Map();
    relations.set(unitKey, byEarlier);
    const entry = byEarlier.get(earlierId) ?? {
      unchanged: new Set<string>(),
      changed: new Set<string>(),
    };
    byEarlier.set(earlierId, entry);
    entry[how].add(section);
  };
  for (const path of new Set(units.map((unit) => unit.path))) {
    const fresh = units
      .filter((unit) => unit.path === path)
      .flatMap((unit) =>
        unit.sections.map((section) => ({ ...section, unit: unit.key })),
      );
    const old = earlier.flatMap((unit) =>
      (unit.sections ?? [])
        .filter((section) => section.path === path)
        .map((section) => ({ ...section, unit: unit.unitId })),
    );
    const matchedOld = new Set<number>();
    const unmatched: typeof fresh = [];
    for (const section of fresh) {
      const at = old.findIndex(
        (o, i) => !matchedOld.has(i) && o.key === section.key,
      );
      if (at < 0) {
        unmatched.push(section);
        continue;
      }
      matchedOld.add(at);
      relate(section.unit, old[at]!.unit, section.key, "unchanged");
    }
    const groups = new Map<string, { fresh: typeof fresh; old: typeof old }>();
    const groupOf = (kind: string, name: string | null) => {
      const id = JSON.stringify([kind, name]);
      const group = groups.get(id) ?? { fresh: [], old: [] };
      groups.set(id, group);
      return group;
    };
    for (const section of unmatched)
      groupOf(section.kind, section.name).fresh.push(section);
    for (const [i, section] of old.entries())
      if (!matchedOld.has(i))
        groupOf(section.kind, section.name).old.push(section);
    for (const group of groups.values()) {
      group.fresh.sort(byPlace);
      group.old.sort(byPlace);
      for (const [i, section] of group.fresh.entries()) {
        const counterpart = group.old[i];
        if (counterpart !== undefined)
          relate(section.unit, counterpart.unit, section.key, "changed");
      }
    }
    if (sameCycle)
      for (const section of fresh)
        for (const unit of earlier)
          if (
            unit.ranges.some((range) =>
              section.ranges.some((own) => overlaps(own, range)),
            )
          ) {
            const known = relations.get(section.unit)?.get(unit.unitId);
            if (known?.unchanged.has(section.key) !== true)
              relate(section.unit, unit.unitId, section.key, "changed");
          }
  }
  const byId = new Map(earlier.map((unit) => [unit.unitId, unit]));
  const result = new Map<string, ReadonlyArray<LineageFrom>>();
  for (const unit of units) {
    const byEarlier = relations.get(unit.key);
    if (byEarlier === undefined) continue;
    const from = [...byEarlier].map(([unitId, entry]): LineageFrom => {
      const changed = [...entry.changed].filter(
        (key) => !entry.unchanged.has(key),
      ).length;
      const unchanged = entry.unchanged.size;
      return {
        unitId,
        cycleId: byId.get(unitId)!.cycleId,
        relation:
          changed === 0 && unchanged === unit.sections.length
            ? "unchanged"
            : "changed",
        unchanged,
        changed,
        lane: byId.get(unitId)!.lane,
      };
    });
    from.sort(
      (a, b) =>
        b.unchanged + b.changed - (a.unchanged + a.changed) ||
        (a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0),
    );
    result.set(unit.key, from);
  }
  return result;
};
