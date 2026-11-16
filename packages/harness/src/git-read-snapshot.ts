import { Context, Effect, Metric, Option } from "effect";
import {
  GitReadSession,
  type GitReadCounter,
} from "@neuve/graph-client/git-read-session";
import { GitFailed } from "./git.ts";

/** Only review attempts provide this reference. Worker scopes do not imply a snapshot. */
export const GitReadSnapshot = Context.Reference<Option.Option<GitReadSession>>(
  "@neuve/harness/GitReadSnapshot",
  { defaultValue: () => Option.none() },
);

const counterNames = {
  requests: "requests",
  hits: "hits",
  uniqueObjectsRead: "unique_objects_read",
  repeatReads: "repeat_reads",
  unretained: "unretained",
  oversized: "oversized",
  nativeFallback: "native_fallback",
  foreignRepository: "foreign_repository",
  sourceRestarts: "source_restarts",
  peakRetainedBytes: "peak_retained_bytes",
} satisfies Record<GitReadCounter, string>;
const counters = new Map(
  Object.entries(counterNames).map(([kind, name]) => [
    kind,
    Metric.counter(`harness.git.snapshot.${name}`, { incremental: true }),
  ]),
);

/** Acquire outside the stage context capture; release before the attempt metrics are written. */
export const withGitReadSnapshot =
  (repository: string, prefixFullBytes: number) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      for (const counter of counters.values()) counter.updateUnsafe(0, context);
      return yield* Effect.acquireUseRelease(
        Effect.tryPromise({
          try: () =>
            GitReadSession.open(repository, {
              prefixFullBytes,
              count: (kind, value) =>
                counters.get(kind)?.updateUnsafe(value, context),
            }),
          catch: () =>
            new GitFailed({
              args: [],
              exitCode: -1,
              message: "Git repository unavailable",
            }),
        }),
        (snapshot) =>
          Effect.provideService(effect, GitReadSnapshot, Option.some(snapshot)),
        (snapshot) => Effect.promise(() => snapshot.close()),
      );
    });
