import { Clock, Effect, Layer } from "effect";
import type { FileSystem } from "effect/FileSystem";
import type { SqlError } from "effect/sql/SqlError";
import { SqlClient } from "effect/sql/SqlClient";
import {
  Blobs,
  ByteStorage,
  Computations,
  canonicalJson,
  mintUlid,
  type StoreLocation,
} from "../src/index.ts";
import { runOn } from "./support.ts";

/** A kind the tests declare recomputable, and one they never declare. */
export const OP = "test.recomputable";
export const OTHER = "test.durable";

/** Just over the inline limit, so each output is a file blob. */
export const FILE_SIZE = Blobs.INLINE_MAX_BYTES + 1_000;

export const MINUTE = 60_000;

export const bytesOf = (label: string, size = FILE_SIZE) =>
  new TextEncoder().encode(label.padEnd(size, "."));

export const specOf = (op: string, label: string) => ({
  op,
  opVersion: 1,
  inputs: { label },
});

export const outputOf = (label: string, size = FILE_SIZE) =>
  Effect.succeed({ bytes: bytesOf(label, size), mediaType: "text/plain" });

export const storesOn = (
  blobs: Layer.Layer<Blobs.BlobStore, unknown, SqlClient | FileSystem>,
) => Computations.layer.pipe(Layer.provideMerge(blobs));

export type Stores =
  Computations.ComputationStore | Blobs.BlobStore | SqlClient | FileSystem;

export const withStores = <A, E>(
  location: StoreLocation,
  program: Effect.Effect<A, E, Stores>,
  blobs: Layer.Layer<
    Blobs.BlobStore,
    unknown,
    SqlClient | FileSystem
  > = Blobs.layer(location),
) => runOn(location, Effect.provide(program, storesOn(blobs)));

/** Runs `effect` on a clock `ms` ahead of the real one (behind when negative); sleeps are real. */
export const shifted =
  (ms: number) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.clockWith((real) =>
      Effect.provideService(effect, Clock.Clock, {
        currentTimeMillisUnsafe: () => real.currentTimeMillisUnsafe() + ms,
        currentTimeMillis: Effect.sync(
          () => real.currentTimeMillisUnsafe() + ms,
        ),
        currentTimeNanosUnsafe: () =>
          real.currentTimeNanosUnsafe() + BigInt(ms) * 1_000_000n,
        currentTimeNanos: Effect.sync(
          () => real.currentTimeNanosUnsafe() + BigInt(ms) * 1_000_000n,
        ),
        monotonicTimeNanosUnsafe: () => real.monotonicTimeNanosUnsafe(),
        monotonicTimeNanos: real.monotonicTimeNanos,
        sleep: (duration) => real.sleep(duration),
      }),
    );

/** Byte storage whose deletes fail, as a process stopped after an eviction's commit leaves it. */
export const deletesStopped = (location: StoreLocation) =>
  Blobs.layerOnStorage(location).pipe(
    Layer.provide(
      Layer.effect(
        ByteStorage.ByteStorage,
        Effect.gen(function* () {
          const local = yield* ByteStorage.ByteStorage;
          return ByteStorage.ByteStorage.of({
            ...local,
            delete: (hash) =>
              Effect.fail(
                new ByteStorage.ByteStorageFailed({
                  hash,
                  operation: "delete",
                  message: "the process stopped",
                  cause: null,
                }),
              ),
          });
        }),
      ).pipe(Layer.provide(ByteStorage.localFileSystem(location))),
    ),
  );

/** Appends a raw event row whose `refs` name `ref`, as an event that cites an output does. */
export const eventNaming = (ref: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const id = mintUlid();
    yield* sql`INSERT INTO events ${sql.insert({
      id,
      kind: "test.cited@1",
      idempotency_key: `cited:${id}`,
      fingerprint: id,
      actor_id: "actor",
      occurred_at: "2026-11-13T10:00:00.000Z",
      recorded_at: "2026-11-13T10:00:00.000Z",
      envelope: canonicalJson({ id, refs: [{ ref, role: "cited" }] }),
    })}`;
  });

const errorText = (error: SqlError) => {
  const reason = error.reason as { message?: unknown; cause?: unknown };
  return `${error.message} ${String(reason.message ?? "")} ${String(reason.cause ?? "")}`;
};

/**
 * A raw statement's outcome: `done`, or the store's refusal as the trigger words it. Any other
 * failure is the test's own and is raised.
 */
export const attempt = (
  statement: string,
  params: ReadonlyArray<unknown> = [],
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    return yield* sql.unsafe(statement, params as never).pipe(
      Effect.as("done"),
      Effect.catchTag("SqlError", (error) => {
        const text = errorText(error);
        const refusal =
          /(not evictable: [^.;\n]*|blobs keep their row[^.;\n]*)/.exec(
            text,
          )?.[1];
        return refusal === undefined
          ? Effect.fail(error)
          : Effect.succeed(refusal.trim());
      }),
    );
  });

export const count = (statement: string, params: ReadonlyArray<unknown> = []) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const [row] = yield* sql.unsafe<{ n: number }>(statement, params as never);
    return row?.n ?? 0;
  });
