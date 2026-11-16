import { safeRead } from "@neuve/records-schema";
import { realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { Cause, Clock, Context, Data, Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { z } from "zod";
import {
  ComputationRow,
  TokenUsage,
  type TokenUsage as TokenUsageType,
} from "@neuve/records-schema";
import {
  BlobStore,
  type BlobCorrupt,
  type BlobMissing,
  type BlobWriteFailed,
  type BlobPruned,
} from "./blobs.ts";
import { canonicalJson, sha256Hex } from "./canonical.ts";
import { CorruptRecord } from "./errors.ts";
import {
  AFTER_STORE_LIMIT,
  type DeclaredKind,
  type EvictReport,
  type InvalidKindDeclaration,
  type KindDeclaration,
  type KindNotRecomputable,
  declareKind,
  evict,
  evictedMeanwhile,
  kinds,
  recomputableKind,
} from "./evictable.ts";
import {
  SharedWork,
  type PublishedSharedOutcome,
  KeyHeld,
} from "./shared-work.ts";
import {
  sharedWorkEffect,
  type SharedWorkError,
} from "./shared-work-effect.ts";
import { sharedWorkSocket, sharedWorkOwnership } from "./shared-work-socket.ts";
import { mintUlid } from "./ids.ts";
import { assertCompatible, type StoreError } from "./store.ts";

/**
 * Raised only in an emergency that must invalidate every stored computation at once (D10). Ordinary
 * changes raise one operation's `opVersion` instead.
 */
export const COMPUTATION_EPOCH = 1;

/**
 * The model route a computation ran on (proposal §3: provider, model ID, reasoning setting). A run
 * that asks for reasoning summaries names that too, so its stages key apart from a measured run's;
 * every other route leaves it out, and its keys are unchanged.
 */
const ModelRoute = z.strictObject({
  provider: z.string().min(1).max(64),
  model: z.string().min(1).max(128),
  reasoning: z.string().min(1).max(64).optional(),
  reasoningSummary: z.string().min(1).max(64).optional(),
});

/**
 * What identifies a computation (D9). `inputs` holds content identities only: commit and blob OIDs,
 * upstream computation keys (`computation:<key>`), blob hashes (`blob:<hash>`) and scope-source
 * hashes; never timestamps, run or cycle IDs, actors or absolute paths, so the same work is found
 * again across runs and cycles.
 */
export const ComputationSpec = z.strictObject({
  op: z
    .string()
    .regex(/^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*$/, "Expected an operation name")
    .max(128),
  opVersion: z.int().min(1),
  inputs: z.json(),
  config: z.json().optional(),
  route: ModelRoute.optional(),
});
export type ComputationSpec = z.infer<typeof ComputationSpec>;

/** A key and the canonical JSON it hashes (RFC 8785, so locale and key order never change a key). */
export const computationKey = (spec: ComputationSpec) => {
  const material = canonicalJson({
    epoch: COMPUTATION_EPOCH,
    op: spec.op,
    opVersion: spec.opVersion,
    inputs: spec.inputs,
    config: spec.config ?? null,
    route: spec.route ?? null,
  });
  return { key: sha256Hex(material), material };
};

/** The computation spec failed its schema. */
export class InvalidComputation extends Data.TaggedError("InvalidComputation")<{
  readonly message: string;
}> {}

/** The computation already has an output: it is never computed again (5.4). */
export class ComputationExists extends Data.TaggedError("ComputationExists")<{
  readonly key: string;
}> {}

/** The attempt is no longer running, so its outcome was already recorded. */
export class AttemptNotRunning extends Data.TaggedError("AttemptNotRunning")<{
  readonly attemptId: string;
  readonly outcome: string;
}> {}

/** The subscribed attempt failed. Its immutable recorded cause survives later retries. */
export class SharedAttemptFailed extends Data.TaggedError(
  "SharedAttemptFailed",
)<{
  readonly key: string;
  readonly attemptId: string;
  readonly tag: string;
  readonly message: string;
}> {}

export interface Attempt {
  readonly attemptId: string;
  readonly key: string;
  readonly n: number;
  readonly op: string;
  readonly opVersion: number;
  readonly material: string;
}

export interface Output {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}

/** What an attempt reports besides its output: model usage counts toward cost even when it fails (2.5). */
export interface AttemptReport {
  readonly usage?: TokenUsageType | undefined;
  readonly model?: string | undefined;
}

export interface FailureReport extends AttemptReport {
  readonly tag: string;
  readonly message: string;
  /** A raw capture of the failure, such as a model's error body, stored first as a `raw-capture` blob. */
  readonly causeBlob?: string | undefined;
}

export type Computation = ComputationRow;

/** How `run` got its output: computed now, found stored, or shared with a concurrent request. */
export interface RunResult {
  readonly status: "computed" | "reused" | "shared";
  readonly computation: Computation;
  readonly output: Uint8Array;
}

type OutputError = BlobMissing | BlobCorrupt;
type PublicationError =
  | StoreError
  | InvalidComputation
  | AttemptNotRunning
  | BlobWriteFailed
  | BlobPruned
  | OutputError;

/**
 * The computation store (5.3, 5.4, D9 to D13). Lookup is per computation, so a run whose inputs
 * partly changed reuses every computation that still matches and computes only the rest. Each
 * attempt is recorded; only the first successful one binds the output, permanently. A failed or
 * interrupted attempt stays with its cause and usage. Concurrent callers subscribe to the common
 * store/key claim. Recovery abandons only attempts whose ownership is known to have ended.
 */
export class ComputationStore extends Context.Service<
  ComputationStore,
  {
    readonly lookup: (
      key: string,
    ) => Effect.Effect<Option.Option<Computation>, StoreError>;
    /** One compatibility check, with bounded queries for the requested immutable keys. */
    readonly lookupMany: (
      keys: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyMap<string, Computation>, StoreError>;
    readonly start: (
      spec: ComputationSpec,
    ) => Effect.Effect<
      Attempt,
      StoreError | InvalidComputation | ComputationExists
    >;
    /**
     * Stores the output as a durable blob and binds it unless an earlier success already did. Never
     * call it inside a caller's transaction: for a declared kind it then evicts, and removes files
     * after its own commits, which a caller's rollback would not bring back.
     */
    readonly succeed: (
      attempt: Attempt,
      output: Output,
      report?: AttemptReport,
    ) => Effect.Effect<
      { readonly computation: Computation; readonly bound: boolean },
      StoreError | AttemptNotRunning | BlobWriteFailed | BlobPruned
    >;
    readonly fail: (
      attempt: Attempt,
      failure: FailureReport,
    ) => Effect.Effect<void, StoreError | AttemptNotRunning>;
    /** Looks the computation up first and runs `compute` only on a miss (5.4). */
    readonly run: <E, R>(
      spec: ComputationSpec,
      compute: Effect.Effect<Output & AttemptReport, E, R>,
    ) => Effect.Effect<
      RunResult,
      | E
      | StoreError
      | InvalidComputation
      | AttemptNotRunning
      | BlobWriteFailed
      | BlobPruned
      | OutputError
      | SharedAttemptFailed
      | KeyHeld
      | SharedWorkError,
      R
    >;
    /** After host re-declaration: abandon ended claims, preserving live and unknown ownership. */
    readonly recoverAbandoned: Effect.Effect<
      ReadonlyArray<{ readonly attemptId: string; readonly key: string }>,
      StoreError
    >;
    /**
     * Declares a kind recomputable with a byte cap for its outputs, as its producer does when it
     * starts (design `records-evictable-outputs`). Idempotent; a new cap is an update. Making a kind
     * recomputable is refused when a model produced one of its stored outputs or an event names one.
     */
    readonly declareKind: (declaration: {
      readonly op: string;
      readonly capBytes: number;
    }) => Effect.Effect<
      DeclaredKind,
      StoreError | InvalidKindDeclaration | KindNotRecomputable
    >;
    /** Every kind declaration, for stats. */
    readonly kinds: Effect.Effect<ReadonlyArray<KindDeclaration>, StoreError>;
    /**
     * Evicts the kind's oldest stored outputs while its bytes exceed its cap, never one stored in
     * the last 15 minutes. A kind not declared recomputable is left as it is. Never call it inside
     * a caller's transaction: it removes files after its own commits, which a caller's rollback
     * would not bring back.
     */
    readonly evict: (request: {
      readonly op: string;
      /** At most this many outputs; unbounded when absent, as the daily job runs it. */
      readonly limit?: number;
    }) => Effect.Effect<EvictReport, StoreError>;
    /**
     * Whether a computation read before its output was evicted meanwhile, so a missing output blob
     * is a miss. False for any kind not declared recomputable.
     */
    readonly evictedMeanwhile: (
      computation: Computation,
    ) => Effect.Effect<boolean, StoreError>;
  }
>()("@neuve/records-core/ComputationStore") {}

const decodeComputation = (row: unknown) => {
  const parsed = safeRead(ComputationRow, row);
  return parsed.success
    ? Effect.succeed(parsed.data)
    : Effect.fail(
        new CorruptRecord({ message: `computation: ${parsed.error.message}` }),
      );
};

const describeCause = <E>(cause: Cause.Cause<E>) => {
  if (Cause.hasInterruptsOnly(cause))
    return { tag: "Interrupted", message: "the attempt was interrupted" };
  const error = Cause.findErrorOption(cause);
  const value = Option.isSome(error) ? error.value : Cause.squash(cause);
  if (typeof value === "object" && value !== null && "_tag" in value) {
    const message = (value as { message?: unknown }).message;
    return {
      tag: String((value as { _tag: unknown })._tag),
      message: typeof message === "string" ? message : "",
    };
  }
  if (value instanceof Error)
    return {
      tag: Option.isSome(error) ? value.name : "Defect",
      message: value.message,
    };
  return { tag: "Defect", message: String(value) };
};

/** Completed computations whose named inputs match any filter. Failed attempts are not outputs. */
export const matchingInputs = (
  filters: ReadonlyArray<{
    readonly op: string;
    readonly inputs: Readonly<Record<string, string>>;
  }>,
) =>
  Effect.gen(function* () {
    if (filters.length === 0) return [];
    const sql = yield* SqlClient;
    const where = filters.map((filter) =>
      sql.and([
        sql`op = ${filter.op}`,
        ...Object.entries(filter.inputs).map(
          ([name, value]) =>
            sql`json_extract(material, ${`$.inputs.${JSON.stringify(name)}`}) = ${value}`,
        ),
      ]),
    );
    const rows = yield* sql<{
      key: string;
      material: string;
    }>`SELECT key, material FROM computations WHERE ${sql.or(where)} ORDER BY key`;
    return yield* Effect.forEach(rows, (row) =>
      Effect.try({
        try: () => ({
          key: row.key,
          inputs: z.object({ inputs: z.json() }).parse(JSON.parse(row.material))
            .inputs,
        }),
        catch: (error) =>
          new CorruptRecord({
            message: `computation inputs: ${String(error)}`,
          }),
      }),
    );
  });

const computationWork = new SharedWork<RunResult, SharedAttemptFailed>();

export const layer = Layer.effect(
  ComputationStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const blobs = yield* BlobStore;
    const [main] = yield* sql<{
      file: string;
    }>`SELECT file FROM pragma_database_list WHERE name = 'main'`;
    if (!main?.file)
      return yield* new CorruptRecord({
        message: "computation store has no database file",
      });
    const store = yield* Effect.promise(() =>
      realpath(dirname(dirname(main.file))),
    );
    const transport = sharedWorkSocket();
    // Resource lifetime only: ownership and keyed sharing remain exclusively in SharedWork.
    const executions = new Set<Promise<void>>();
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await Promise.all(executions);
      }),
    );
    const retainExecution = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        const ended = Promise.withResolvers<void>();
        executions.add(ended.promise);
        return effect.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              executions.delete(ended.promise);
              ended.resolve();
            }),
          ),
        );
      });
    const write = <A, E>(program: Effect.Effect<A, E>) =>
      sql.withTransaction(Effect.andThen(assertCompatible, program));
    const nowIso = Effect.map(Clock.currentTimeMillis, (millis) =>
      new Date(millis).toISOString(),
    );

    const select = (key: string) =>
      Effect.gen(function* () {
        const [row] =
          yield* sql`SELECT key, op, op_version, material, output_hash, attempt_id,
          completed_at FROM computations WHERE key = ${key}`;
        if (row === undefined) return Option.none<Computation>();
        return Option.some(yield* decodeComputation(row));
      });

    const lookup = (key: string) =>
      Effect.andThen(assertCompatible, select(key));

    const lookupMany = (keys: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const found = new Map<string, Computation>();
        if (keys.length === 0) return found;
        yield* assertCompatible;
        const unique = [...new Set(keys)];
        for (let offset = 0; offset < unique.length; offset += 500) {
          const rows =
            yield* sql`SELECT key, op, op_version, material, output_hash,
            attempt_id, completed_at FROM computations
            WHERE ${sql.in("key", unique.slice(offset, offset + 500))}`;
          for (const row of rows) {
            const computation = yield* decodeComputation(row);
            found.set(computation.key, computation);
          }
        }
        return found;
      });

    const parseSpec = (spec: unknown) => {
      const parsed = ComputationSpec.safeParse(spec);
      return parsed.success
        ? Effect.succeed(parsed.data)
        : Effect.fail(
            new InvalidComputation({ message: z.prettifyError(parsed.error) }),
          );
    };

    const start = (input: ComputationSpec) =>
      Effect.gen(function* () {
        const spec = yield* parseSpec(input);
        const { key, material } = computationKey(spec);
        const at = yield* nowIso;
        return yield* write(
          Effect.gen(function* () {
            if (Option.isSome(yield* select(key)))
              return yield* new ComputationExists({ key });
            const [last] = yield* sql<{
              n: number | null;
            }>`SELECT max(n) AS n FROM computation_attempts WHERE key = ${key}`;
            const attempt: Attempt = {
              attemptId: mintUlid(),
              key,
              n: (last?.n ?? 0) + 1,
              op: spec.op,
              opVersion: spec.opVersion,
              material,
            };
            yield* sql`INSERT INTO computation_attempts ${sql.insert({
              attempt_id: attempt.attemptId,
              key,
              n: attempt.n,
              op: spec.op,
              started_at: at,
              outcome: "running",
            })}`;
            return attempt;
          }),
        );
      });

    const runningAttempt = (attemptId: string) =>
      Effect.gen(function* () {
        const [row] = yield* sql<{
          outcome: string;
        }>`SELECT outcome FROM computation_attempts WHERE attempt_id = ${attemptId}`;
        if (row === undefined)
          return yield* new CorruptRecord({
            message: `attempt ${attemptId} missing`,
          });
        if (row.outcome !== "running")
          return yield* new AttemptNotRunning({
            attemptId,
            outcome: row.outcome,
          });
      });

    const usageJson = (usage: TokenUsageType | undefined) =>
      usage === undefined ? null : canonicalJson(TokenUsage.parse(usage));

    const bind = (
      attempt: Attempt,
      output: Output,
      report: AttemptReport = {},
    ) =>
      Effect.gen(function* () {
        return yield* write(
          Effect.gen(function* () {
            yield* runningAttempt(attempt.attemptId);
            // The blob and the binding acknowledge one success, in one commit. The attempt's
            // start was committed separately, so a crash still leaves an abandoned attempt.
            const stored = yield* blobs.put({
              bytes: output.bytes,
              mediaType: output.mediaType,
              retention: "durable",
            });
            const at = yield* nowIso;
            const held = yield* select(attempt.key);
            const computation = Option.isSome(held)
              ? held.value
              : yield* decodeComputation({
                  key: attempt.key,
                  op: attempt.op,
                  opVersion: attempt.opVersion,
                  material: attempt.material,
                  outputHash: stored.blob.hash,
                  attemptId: attempt.attemptId,
                  completedAt: at,
                });
            if (Option.isNone(held))
              yield* sql`INSERT INTO computations ${sql.insert({
                key: attempt.key,
                op: attempt.op,
                op_version: attempt.opVersion,
                material: attempt.material,
                output_hash: stored.blob.hash,
                attempt_id: attempt.attemptId,
                completed_at: at,
              })}`;
            yield* sql`UPDATE computation_attempts SET outcome = 'succeeded', ended_at = ${at},
              output_hash = ${stored.blob.hash}, usage = ${usageJson(report.usage)},
              model = ${report.model ?? null} WHERE attempt_id = ${attempt.attemptId}`;
            return { computation, bound: Option.isNone(held) };
          }),
        );
      });

    /**
     * After an output of a declared kind is stored, outside the binding transaction: the kind is
     * brought back under its cap. Best effort: a failure is logged and never fails the computation.
     */
    const afterStored = (op: string) =>
      Effect.gen(function* () {
        if (Option.isNone(yield* recomputableKind(op))) return;
        yield* evict(op, { limit: AFTER_STORE_LIMIT });
      }).pipe(
        Effect.provideService(BlobStore, blobs),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning(
                `records: evicting ${op} after a store did not finish: ${Cause.pretty(cause).split("\n")[0]}`,
              ),
        ),
      );

    const succeed = (
      attempt: Attempt,
      output: Output,
      report: AttemptReport = {},
    ) =>
      Effect.tap(bind(attempt, output, report), ({ bound }) =>
        bound ? afterStored(attempt.op) : Effect.void,
      );

    const fail = (attempt: Attempt, failure: FailureReport) =>
      Effect.gen(function* () {
        const at = yield* nowIso;
        yield* write(
          Effect.gen(function* () {
            yield* runningAttempt(attempt.attemptId);
            yield* sql`UPDATE computation_attempts SET outcome = 'failed', ended_at = ${at},
              error_tag = ${failure.tag}, error_message = ${failure.message},
              cause_blob = ${failure.causeBlob ?? null}, usage = ${usageJson(failure.usage)},
              model = ${failure.model ?? null} WHERE attempt_id = ${attempt.attemptId}`;
          }),
        );
      });

    const readOutput = (computation: Computation) =>
      Effect.gen(function* () {
        const read = yield* blobs.get(computation.outputHash);
        if (read._tag === "Pruned")
          return yield* new CorruptRecord({
            message: `computation ${computation.key}: its durable output ${computation.outputHash} was pruned`,
          });
        return read.bytes;
      });

    /**
     * The output of a computation read before it, or none when an eviction took it meanwhile: for a
     * kind declared recomputable, a missing blob is re-checked against the row, and a row that is
     * gone is a miss. For any other kind a missing or corrupt blob stays the error it is.
     */
    const outputOrEvicted = (computation: Computation) =>
      readOutput(computation).pipe(
        Effect.map(Option.some),
        Effect.catchTags({
          BlobMissing: (error) => missOr(computation, error),
          BlobCorrupt: (error) => missOr(computation, error),
        }),
      );
    const missOr = <E>(computation: Computation, error: E) =>
      Effect.flatMap(evictedMeanwhile(computation), (evicted) =>
        evicted
          ? Effect.succeed(Option.none<Uint8Array>())
          : Effect.fail(error),
      );

    const stored = (
      key: string,
      status: RunResult["status"],
    ): Effect.Effect<
      Option.Option<RunResult>,
      StoreError | OutputError,
      SqlClient
    > =>
      Effect.gen(function* () {
        const held = yield* lookup(key);
        if (Option.isNone(held)) return Option.none<RunResult>();
        const output = yield* outputOrEvicted(held.value);
        if (Option.isNone(output)) return Option.none<RunResult>();
        const result: RunResult = {
          status,
          computation: held.value,
          output: output.value,
        };
        return Option.some(result);
      });

    const abandon = (key: string) =>
      write(
        Effect.gen(function* () {
          const at = yield* nowIso;
          yield* sql`UPDATE computation_attempts SET outcome = 'abandoned', ended_at = ${at},
        error_tag = 'Abandoned', error_message = 'ownership ended before publication'
        WHERE key = ${key} AND outcome = 'running'`;
        }),
      );

    const readPublication = (key: string, publication?: string) =>
      Effect.gen(function* () {
        if (publication === undefined) {
          const found = yield* stored(key, "shared");
          return Option.isSome(found)
            ? ({
                publication: found.value.computation.attemptId,
                outcome: { kind: "succeeded", value: found.value },
              } satisfies PublishedSharedOutcome<
                RunResult,
                SharedAttemptFailed
              >)
            : undefined;
        }
        const [attempt] = yield* sql<{
          outcome: string;
          errorTag: string | null;
          errorMessage: string | null;
        }>`SELECT outcome, error_tag, error_message FROM computation_attempts WHERE attempt_id = ${publication} AND key = ${key}`;
        if (attempt?.outcome === "failed")
          return {
            publication,
            outcome: {
              kind: "failed",
              error: new SharedAttemptFailed({
                key,
                attemptId: publication,
                tag: attempt.errorTag ?? "Failure",
                message: attempt.errorMessage ?? "",
              }),
            },
          } satisfies PublishedSharedOutcome<RunResult, SharedAttemptFailed>;
        if (attempt?.outcome !== "succeeded") return undefined;
        const found = yield* stored(key, "shared");
        return Option.isSome(found)
          ? ({
              publication,
              outcome: { kind: "succeeded", value: found.value },
            } satisfies PublishedSharedOutcome<RunResult, SharedAttemptFailed>)
          : undefined;
      });

    const run = <E, R>(
      input: ComputationSpec,
      compute: Effect.Effect<Output & AttemptReport, E, R>,
    ) =>
      Effect.gen(function* () {
        const spec = yield* parseSpec(input);
        const { key } = computationKey(spec);
        const hit = yield* stored(key, "reused");
        if (Option.isSome(hit)) return hit.value;
        const context = yield* Effect.context<SqlClient>();
        let ownedExecution = false;
        // Set when this caller's attempt bound the output, so the kind's cap is checked after.
        let storedHere = false;
        let original: Cause.Cause<E> | undefined;
        let publicationFailure: Cause.Cause<PublicationError> | undefined;
        const publish = <A, F extends PublicationError>(
          effect: Effect.Effect<A, F, SqlClient>,
        ) =>
          effect.pipe(
            Effect.catchCause((cause) => {
              publicationFailure = cause;
              return Effect.die(Cause.squash(cause));
            }),
          );
        const result = yield* sharedWorkEffect(computationWork, {
          scope: store,
          key,
          crossProcess: {
            store,
            transport,
            read: (publication) =>
              Effect.runPromiseWith(context)(readPublication(key, publication)),
          },
          onEvent: (event) => {
            if (event.floor)
              Effect.runSyncWith(context)(
                Effect.andThen(
                  Effect.annotateCurrentSpan({
                    "shared_work.may_have_duplicated": true,
                  }),
                  Effect.logDebug("computation may have been duplicated", {
                    key,
                    floor: event.floor,
                  }),
                ),
              );
          },
          onTakeover: () => Effect.runPromiseWith(context)(abandon(key)),
          run: () =>
            retainExecution(
              Effect.uninterruptibleMask((restore) =>
                Effect.gen(function* () {
                  ownedExecution = true;
                  const started = yield* Effect.result(start(spec));
                  if (started._tag === "Failure") {
                    // Keep the durable race path for a publication made at the disclosed floor.
                    if (started.failure._tag === "ComputationExists") {
                      const found = Option.getOrThrow(
                        yield* stored(key, "reused").pipe(Effect.orDie),
                      );
                      return {
                        publication: found.computation.attemptId,
                        outcome: { kind: "succeeded", value: found },
                      } satisfies PublishedSharedOutcome<
                        RunResult,
                        SharedAttemptFailed
                      >;
                    }
                    publicationFailure = Cause.fail(started.failure);
                    return yield* Effect.die(started.failure);
                  }
                  const attempt = started.success;
                  const exit = yield* Effect.exit(restore(compute));
                  if (exit._tag === "Failure") {
                    original = exit.cause;
                    const failure = describeCause(exit.cause);
                    yield* publish(fail(attempt, failure));
                    return {
                      publication: attempt.attemptId,
                      outcome: {
                        kind: "failed",
                        error: new SharedAttemptFailed({
                          key,
                          attemptId: attempt.attemptId,
                          ...failure,
                        }),
                      },
                    } satisfies PublishedSharedOutcome<
                      RunResult,
                      SharedAttemptFailed
                    >;
                  }
                  // If publication fails, close the claim without done. A waiter takes over.
                  const output = exit.value;
                  const { computation, bound } = yield* publish(
                    bind(attempt, output, output),
                  );
                  storedHere = bound;
                  return {
                    publication: attempt.attemptId,
                    outcome: {
                      kind: "succeeded",
                      value: {
                        status: "computed",
                        computation,
                        output: bound
                          ? output.bytes
                          : yield* readOutput(computation).pipe(Effect.orDie),
                      },
                    },
                  } satisfies PublishedSharedOutcome<
                    RunResult,
                    SharedAttemptFailed
                  >;
                }),
              ),
            ),
        }).pipe(
          Effect.catchTag(
            "SharedWorkError",
            (
              error,
            ): Effect.Effect<never, PublicationError | SharedWorkError> =>
              publicationFailure
                ? Effect.failCause(publicationFailure)
                : Effect.fail(error),
          ),
          Effect.catchTag(
            "SharedAttemptFailed",
            (failure): Effect.Effect<never, E | SharedAttemptFailed> =>
              original ? Effect.failCause(original) : Effect.fail(failure),
          ),
        );
        // After waiters were told: a declared kind is brought back under its cap.
        if (storedHere) yield* afterStored(spec.op);
        return {
          ...result.value,
          status: ownedExecution ? result.value.status : "shared",
        } satisfies RunResult;
      });

    const recoverAbandoned = Effect.gen(function* () {
      const rows = yield* sql<{
        attemptId: string;
        key: string;
      }>`SELECT attempt_id, key FROM computation_attempts WHERE outcome = 'running' ORDER BY attempt_id`;
      const abandoned: Array<{ attemptId: string; key: string }> = [];
      for (const row of rows) {
        // Inspection waits for re-declaration. At the floor, leaving a running row blocks no start.
        const ownership = yield* Effect.promise(() =>
          sharedWorkOwnership(store, row.key),
        );
        if (ownership !== "ended") continue;
        yield* write(
          Effect.gen(function* () {
            const at = yield* nowIso;
            const updated =
              yield* sql`UPDATE computation_attempts SET outcome = 'abandoned', ended_at = ${at},
            error_tag = 'Abandoned', error_message = 'ownership ended before recovery'
            WHERE attempt_id = ${row.attemptId} AND outcome = 'running' RETURNING attempt_id`;
            if (updated.length) abandoned.push(row);
          }),
        );
      }
      return abandoned;
    });

    const provided = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.provideService(effect, SqlClient, sql);
    return ComputationStore.of({
      lookup: (key) => provided(lookup(key)),
      lookupMany: (keys) => provided(lookupMany(keys)),
      start: (spec) => provided(start(spec)),
      succeed: (attempt, output, report) =>
        provided(succeed(attempt, output, report)),
      fail: (attempt, failure) => provided(fail(attempt, failure)),
      run: (spec, compute) => provided(run(spec, compute)),
      recoverAbandoned: provided(recoverAbandoned),
      declareKind: (declaration) => provided(declareKind(declaration)),
      kinds: provided(kinds),
      evict: ({ op, limit }) =>
        provided(
          Effect.provideService(
            evict(op, limit === undefined ? {} : { limit }),
            BlobStore,
            blobs,
          ),
        ),
      evictedMeanwhile: (computation) =>
        provided(evictedMeanwhile(computation)),
    });
  }),
);
