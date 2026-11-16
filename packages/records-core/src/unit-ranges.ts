import { Effect } from "effect";
import {
  OwnedRange as OwnedRangeSchema,
  UnitSectionsRead,
  safeRead,
  type OwnedRange,
  type RecordEvent,
} from "@neuve/records-schema";
import { BlobStore } from "./blobs.ts";

/**
 * A unit's owned ranges whatever version recorded it: the one definition every reader of a unit's
 * lines uses (the read model, checkpoints, people's line comments). Version 1 carries its ranges
 * without a side, version 2 in its payload, version 3 in its `sections` blob. A blob that is
 * missing, pruned, corrupt or does not decode is an outcome the caller discloses, never a throw and
 * never an empty list that reads as a unit owning nothing.
 */

type Of<K extends RecordEvent["kind"]> = Extract<RecordEvent, { kind: K }>;

/** A recorded unit of any version. */
export type UnitEvent = Of<
  "unit.recorded@1" | "unit.recorded@2" | "unit.recorded@3"
>;

export const isUnitEvent = (event: RecordEvent): event is UnitEvent =>
  event.kind === "unit.recorded@1" ||
  event.kind === "unit.recorded@2" ||
  event.kind === "unit.recorded@3";

/** An owned range; a version 1 unit's ranges carry no side, and match either. */
export type UnitRange =
  | OwnedRange
  | {
      readonly kind: "lines";
      readonly side: undefined;
      readonly path: string;
      readonly startLine: number;
      readonly endLine: number;
    };

/** Why a version 3 unit's sections blob could not be read. */
export type UnreadableReason =
  "missing" | "pruned" | "corrupt" | "not-json" | "undecodable";

export type UnitRanges =
  | {
      readonly _tag: "Ranges";
      readonly ranges: ReadonlyArray<UnitRange>;
      /** A version 3 unit's sections as its blob holds them, read loosely. */
      readonly sections?: UnitSectionsRead["sections"] | undefined;
      /**
       * Where a version 3 unit's blob and payload disagree, or its blob repeats a section key, in
       * a few words each, for the caller to disclose. The ranges are still every range the blob
       * holds. Absent when they agree.
       */
      readonly issues?: ReadonlyArray<string> | undefined;
    }
  | {
      readonly _tag: "Unreadable";
      readonly reason: UnreadableReason;
      /** `blob:<hash>`. */
      readonly ref: string;
      /** What went wrong, in a few words; decoder text for `undecodable`. */
      readonly issue: string;
    };

/** Path, side and start line, so a version 3 unit's sections flatten to one stable list. */
const byPlace = (a: OwnedRange, b: OwnedRange) =>
  a.path < b.path
    ? -1
    : a.path > b.path
      ? 1
      : a.side !== b.side
        ? a.side === "old"
          ? -1
          : 1
        : (a.kind === "lines" ? a.startLine : 0) -
          (b.kind === "lines" ? b.startLine : 0);

const firstIssue = (
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>,
) => {
  const issue = issues[0];
  return issue === undefined
    ? "does not decode"
    : `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}${issues.length > 1 ? ` (and ${issues.length - 1} more)` : ""}`;
};

/** A recorded unit's owned ranges in `OwnedRange` form; version 3 reads its sections blob. */
export const unitRanges = (event: UnitEvent) =>
  Effect.gen(function* () {
    switch (event.kind) {
      case "unit.recorded@1":
        return {
          _tag: "Ranges",
          ranges: event.payload.ownedRanges.map((range) => ({
            kind: "lines" as const,
            side: undefined,
            ...range,
          })),
        } satisfies UnitRanges as UnitRanges;
      case "unit.recorded@2":
        return {
          _tag: "Ranges",
          ranges: event.payload.ownedRanges,
        } satisfies UnitRanges as UnitRanges;
      case "unit.recorded@3": {
        const ref = event.refs[0].ref;
        const unreadable = (reason: UnreadableReason, issue: string) =>
          ({ _tag: "Unreadable", reason, ref, issue }) satisfies UnitRanges;
        const blobs = yield* BlobStore;
        const read = yield* blobs.get(ref.slice("blob:".length)).pipe(
          Effect.map((read) => ({ read })),
          Effect.catchTags({
            BlobMissing: () =>
              Effect.succeed(
                unreadable("missing", "the sections blob is not in this store"),
              ),
            BlobCorrupt: (error) =>
              Effect.succeed(
                unreadable(
                  "corrupt",
                  `the sections blob is corrupt (${error.message})`,
                ),
              ),
          }),
        );
        if ("_tag" in read) return read as UnitRanges;
        if (read.read._tag === "Pruned")
          return unreadable("pruned", "the sections blob was pruned");
        let json: unknown;
        try {
          json = JSON.parse(new TextDecoder().decode(read.read.bytes));
        } catch (error) {
          return unreadable(
            "not-json",
            `the sections blob is not JSON (${error instanceof Error ? error.message : String(error)})`,
          );
        }
        const parsed = safeRead(UnitSectionsRead, json);
        if (!parsed.success)
          return unreadable("undecodable", firstIssue(parsed.error.issues));
        // Each range in today's form, checked as an owned range is: a range whose end precedes its
        // start makes the blob unreadable, never a silently wrong range.
        const ranges: Array<OwnedRange> = [];
        for (const [s, section] of parsed.data.sections.entries())
          for (const [r, range] of section.ownedRanges.entries()) {
            const owned = OwnedRangeSchema.safeParse(
              range.kind === "lines"
                ? {
                    kind: "lines",
                    path: range.path,
                    side: range.side,
                    startLine: range.startLine,
                    endLine: range.endLine,
                  }
                : {
                    kind: "whole-nontext",
                    path: range.path,
                    side: range.side,
                  },
            );
            if (!owned.success)
              return unreadable(
                "undecodable",
                `sections.${s}.ownedRanges.${r}: ${firstIssue(owned.error.issues)}`,
              );
            ranges.push(owned.data);
          }
        ranges.sort(byPlace);
        const issues: Array<string> = [];
        const seen = new Set<string>();
        const repeated = new Set<string>();
        for (const section of parsed.data.sections)
          (seen.has(section.key) ? repeated : seen).add(section.key);
        if (repeated.size > 0)
          issues.push(
            `the sections blob repeats ${repeated.size} section ${repeated.size === 1 ? "key" : "keys"}`,
          );
        const lines = ranges.reduce(
          (n, range) =>
            range.kind === "lines"
              ? n + range.endLine - range.startLine + 1
              : n,
          0,
        );
        const said = event.payload;
        if (said.sections.count !== parsed.data.sections.length)
          issues.push(
            `the unit counts ${said.sections.count} sections; its blob holds ${parsed.data.sections.length}`,
          );
        if (said.ranges.count !== ranges.length)
          issues.push(
            `the unit counts ${said.ranges.count} ranges; its blob holds ${ranges.length}`,
          );
        if (said.ranges.lines !== lines)
          issues.push(
            `the unit counts ${said.ranges.lines} lines; its blob's ranges cover ${lines}`,
          );
        return {
          _tag: "Ranges",
          ranges,
          sections: parsed.data.sections,
          ...(issues.length === 0 ? {} : { issues }),
        } satisfies UnitRanges as UnitRanges;
      }
    }
  });
