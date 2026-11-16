import { Data, Effect, Exit, Option } from "effect";
import { cpuJob } from "./budget/cpu.ts";
import { mergeBase } from "./git-objects.ts";
import { resolveCommit, type GitFailed } from "./git.ts";
import type { OutlineSource } from "./graph-outline.ts";
import { relationsComputation, relationsGapOf } from "./relations-index.ts";

/**
 * Both sides of a range stored before a review (`neuve relations prepare <base>..<head>`, NEU-148).
 * A review's readings decide their evidence at their start from what is stored (`storedRelations`),
 * and only commit preparation (a commit made here, still a branch tip) or the review's own
 * relations task, which ends after the readings decided, stores a side. So the first review of any
 * other range reads none; this stores them first.
 *
 * - **The sides.** Head is the head commit; the base is the MERGE BASE of base and head, as a review
 *   takes it (`frontManifest`'s `mergeBase`, the commit the review's relations task reads for the
 *   base side), not the base given.
 * - **One run per key** (record 0016). Each side is `relationsComputation`, the same computation and
 *   key as a review's (`relationsSpec`), head first, then the base: a run another caller has in
 *   flight under the key is joined (`joined`), an index stored is read (`already-stored`), and only
 *   otherwise is it read here (`read`), through the store's private Graph clone. Never a second run,
 *   a poll or a lock.
 * - **Where it runs.** The engine runs in Graph's slot past the machine's CPU budget
 *   (`relationsComputation`'s engine run, as for the review's task and commit preparation), at the
 *   class of work a person waits on (`interactive`), the class the review's relations task reads
 *   at. It takes no code-work marker: a relations read uses no index snapshot, and a marker would
 *   pause commit preparation for the whole read.
 * - **Stopping.** It waits for both sides, bounded only by `timeoutMs` when given. A side the bound
 *   or an interruption ends is withdrawn: its subscription ends, so a read no other caller
 *   subscribed to stops, and one another caller subscribed to keeps running for that caller.
 * - **Never source text.** A failed side says its tag (`relationsGapOf`), never the failure's text.
 */

/** How one side ended. */
export type PreparedSideOutcome =
  "read" | "already-stored" | "joined" | "failed";

export type PreparedSide = Readonly<{
  side: "head" | "base";
  commit: string;
  outcome: PreparedSideOutcome;
  /** A failed side's tag (`RelationsReadFailed`'s reason, `graph-unavailable`, `timeout`); else null. */
  tag: string | null;
  wallMs: number;
  /** The stored index's bytes, for a side stored at the end; else null. */
  bytes: number | null;
}>;

export type PreparedRange = Readonly<{
  range: RelationsRange;
  sides: Readonly<{ head: PreparedSide; base: PreparedSide }>;
}>;

/**
 * The command cannot start: the range does not resolve to two commits with a merge base (`range`),
 * or there is no Graph engine (`no-engine`). Nothing was read.
 */
export class RelationsPrepareRefused extends Data.TaggedError(
  "RelationsPrepareRefused",
)<{ readonly reason: "range" | "no-engine"; readonly message: string }> {}

/** The tag of a side the bound ended. */
export const PREPARE_TIMEOUT = "timeout";

/** Whether a side's index is stored at the end. */
export const preparedStored = (side: PreparedSide) => side.outcome !== "failed";

const outcomeOf = (status: "computed" | "reused" | "shared") =>
  status === "computed"
    ? ("read" as const)
    : status === "reused"
      ? ("already-stored" as const)
      : ("joined" as const);

/** A range resolved as a review takes it: both commits, and the base side's commit. */
export type RelationsRange = Readonly<{
  /** The given base and head, resolved to commits. */
  base: string;
  head: string;
  /** The base side's commit: the merge base of `base` and `head`. */
  mergeBase: string;
}>;

/**
 * Resolves the range's revisions to commits and the base side to their merge base, as a review does
 * (`frontManifest`). A revision that is not a commit, or two commits with no merge base, is
 * `RelationsPrepareRefused` (`range`), with Git's first line, never more.
 */
export const resolveRelationsRange = (
  input: Readonly<{ repository: string; base: string; head: string }>,
) =>
  Effect.gen(function* () {
    const refused = (what: string) => (cause: GitFailed) =>
      new RelationsPrepareRefused({
        reason: "range",
        message: `${what}${cause.message.trim() === "" ? "." : `: ${cause.message.trim().split("\n")[0]}`}`,
      });
    const base = yield* resolveCommit(input.repository, input.base).pipe(
      Effect.mapError(refused(`${input.base} is not a commit`)),
    );
    const head = yield* resolveCommit(input.repository, input.head).pipe(
      Effect.mapError(refused(`${input.head} is not a commit`)),
    );
    const merge = yield* mergeBase(input.repository, base, head).pipe(
      Effect.mapError(
        refused(`${input.base} and ${input.head} have no merge base`),
      ),
    );
    const range: RelationsRange = { base, head, mergeBase: merge };
    return range;
  });

/**
 * Stores both sides of a resolved range (`resolveRelationsRange`), head first; never fails once it
 * starts: a side that could not be stored is `failed` with its tag. No engine is
 * `RelationsPrepareRefused` (`no-engine`) before anything is read.
 */
export const prepareRangeRelations = (
  input: Readonly<{
    repository: string;
    /** The store's Graph folder, `<store>/graph` (`relationsGraphDirectory`). */
    graphDirectory: string;
    range: RelationsRange;
    source: OutlineSource;
    /** The bound for both sides together; none when absent. */
    timeoutMs?: number;
    /** Called as each side ends, head first. */
    onSide?: (side: PreparedSide) => Effect.Effect<void>;
  }>,
) =>
  Effect.gen(function* () {
    const { repository, range, source } = input;
    if (!("sha256" in source.key))
      return yield* new RelationsPrepareRefused({
        reason: "no-engine",
        message: `No Graph engine at ${source.executable}.`,
      });
    const started = performance.now();
    const prepareSide = (side: "head" | "base", commit: string) =>
      Effect.gen(function* () {
        const begun = performance.now();
        const left =
          input.timeoutMs === undefined
            ? undefined
            : input.timeoutMs - (begun - started);
        const ended = (
          fields: Pick<PreparedSide, "outcome" | "tag" | "bytes">,
        ): PreparedSide => ({
          side,
          commit,
          ...fields,
          wallMs: Math.round(performance.now() - begun),
        });
        const timedOut = () =>
          ended({ outcome: "failed", tag: PREPARE_TIMEOUT, bytes: null });
        // Bounded, the read is interrupted when the bound ends: its subscription is withdrawn.
        const read = Effect.exit(
          relationsComputation(
            repository,
            commit,
            source,
            input.graphDirectory,
          ),
        );
        const exit =
          left === undefined
            ? Option.some(yield* read)
            : left <= 0
              ? Option.none()
              : yield* Effect.timeoutOption(read, left);
        let result: PreparedSide;
        if (Option.isNone(exit)) result = timedOut();
        else if (Exit.isSuccess(exit.value))
          result = ended({
            outcome: outcomeOf(exit.value.value.read.status),
            tag: null,
            bytes: exit.value.value.read.bytes,
          });
        else {
          const gap = relationsGapOf(exit.value.cause);
          result = ended({
            outcome: "failed",
            tag:
              gap.gap === "graph-unavailable"
                ? "graph-unavailable"
                : (gap.tag ?? "failed"),
            bytes: null,
          });
        }
        if (input.onSide !== undefined) yield* input.onSide(result);
        return result;
      });
    const head = yield* prepareSide("head", range.head);
    const base = yield* prepareSide("base", range.mergeBase);
    const prepared: PreparedRange = { range, sides: { head, base } };
    return prepared;
  }).pipe((work) =>
    cpuJob({ class: "interactive", position: "new", stage: 0 }, work),
  );
