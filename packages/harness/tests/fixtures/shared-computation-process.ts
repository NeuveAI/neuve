import { appendFileSync } from "node:fs";
import { z } from "zod";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Exit, Cause, Layer, Logger, References } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { SqlError, UnknownError } from "effect/sql/SqlError";
import {
  Blobs,
  Computations,
  Store,
  resolveStoreLocation,
} from "@neuve/records-core";
import { InsideSharedWorkGrant } from "@neuve/records-core/shared-work-effect";
import { prepareCommit } from "../../src/commit-prepare.ts";
import { cpuKeyedPool } from "../../src/budget/cpu.ts";
import { graphClone, prepareBase } from "../../src/graph-search.ts";

const config = z
  .object({
    repository: z.string(),
    spec: Computations.ComputationSpec.optional(),
    commit: z
      .object({
        oid: z.string(),
        tree: z.string(),
        parents: z.array(z.string()),
      })
      .optional(),
    executions: z.string(),
    mode: z.enum(["compute", "clone", "recover", "prepare"]).default("compute"),
    failed: z.boolean().default(false),
    pause: z.boolean().default(true),
    inside: z.boolean().default(false),
    keyedPool: z.boolean().default(false),
    prepareClone: z.boolean().default(false),
    breakCommit: z.boolean().default(false),
    beforeCommit: z.boolean().default(false),
    work: z.string().default(""),
  })
  .parse(JSON.parse(process.env.NEUVE_SHARED_TEST ?? "{}"));
const emit = (event: string, fields: object = {}) =>
  console.info(JSON.stringify({ event, ...fields }));
const gates = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
const gate = (name: string) => {
  let held = gates.get(name);
  if (!held) {
    held = Promise.withResolvers<void>();
    gates.set(name, held);
  }
  return held.promise;
};
void (async () => {
  let buffer = "";
  for await (const chunk of Bun.stdin.stream()) {
    buffer += new TextDecoder().decode(chunk);
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const name = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!gates.has(name)) gates.set(name, Promise.withResolvers<void>());
      gates.get(name)?.resolve();
    }
  }
})();
const role = z.object({
  type: z.literal("shared-work.role"),
  role: z.string(),
  floor: z.string().optional(),
});
const logger = Logger.make(({ message }) => {
  for (const item of [message].flat()) {
    const event = role.safeParse(item);
    if (event.success) emit("role", event.data);
  }
});
const spec = config.spec ?? {
  op: "test.shared-p5",
  opVersion: 1,
  inputs: { value: "one" },
};
const location = await Effect.runPromise(
  resolveStoreLocation(config.repository),
);
const program = Effect.gen(function* () {
  const store = yield* Computations.ComputationStore;
  const sql = yield* SqlClient;
  if (config.mode === "recover") {
    emit("recovering");
    const rows = yield* store.recoverAbandoned;
    emit("recovered", { count: rows.length });
    return;
  }
  if (config.mode === "prepare") {
    if (!config.commit) return yield* Effect.die("fixture commit missing");
    const result = yield* prepareCommit(
      { repository: config.repository },
      config.commit,
    );
    emit("skipped", { count: result.hunks });
    return;
  }
  if (config.mode === "clone") {
    const runtime = { executable: "unused", workDirectory: config.work };
    const work = config.prepareClone
      ? Effect.map(
          prepareBase(
            config.repository,
            "a".repeat(40),
            runtime,
            "b".repeat(64),
          ),
          (result) => result.clone,
        )
      : graphClone(config.repository, runtime);
    const clone = yield* config.keyedPool
      ? cpuKeyedPool("precompute.graph-and-keyword", 2, () => work)
      : work;
    emit("result", { value: clone });
    return;
  }
  if (config.beforeCommit) {
    // Instrument the driver's real connection; the transaction still owns BEGIN/COMMIT/ROLLBACK.
    yield* Effect.scoped(
      Effect.map(sql.reserve, (connection) => {
        let publication = false;
        const execute = connection.execute.bind(connection);
        const control = connection.executeUnprepared.bind(connection);
        const instrumentation: Pick<
          typeof connection,
          "execute" | "executeUnprepared"
        > = {
          execute: (statement, params, transform) =>
            execute(statement, params, transform).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  if (
                    /UPDATE computation_attempts SET outcome = '(succeeded|failed)'/.test(
                      statement,
                    )
                  )
                    publication = true;
                }),
              ),
            ),
          executeUnprepared: (statement, params, transform) =>
            statement === "COMMIT" && publication
              ? Effect.gen(function* () {
                  emit("commit-boundary");
                  yield* Effect.promise(() => gate("commit"));
                  if (config.breakCommit)
                    return yield* Effect.fail(
                      new SqlError({
                        reason: new UnknownError({
                          cause: new Error("publication COMMIT rejected"),
                          message: "publication COMMIT rejected",
                        }),
                      }),
                    );
                  return yield* control(statement, params, transform);
                })
              : control(statement, params, transform),
        };
        Object.defineProperties(connection, {
          execute: { value: instrumentation.execute },
          executeUnprepared: { value: instrumentation.executeUnprepared },
        });
      }),
    );
  }
  const result = yield* store.run(
    spec,
    Effect.gen(function* () {
      appendFileSync(config.executions, "run\n");
      emit("run");
      if (config.pause) yield* Effect.promise(() => gate("run"));
      if (config.failed)
        return yield* Effect.fail({
          _tag: "FixtureFailed",
          message: "recorded fixture cause",
        });
      return {
        bytes: new TextEncoder().encode("stored fixture value"),
        mediaType: "text/plain",
      };
    }),
  );
  emit("result", {
    value: new TextDecoder().decode(result.output),
    status: result.status,
  });
});
const exit = await Effect.runPromise(
  Effect.exit(program).pipe(
    Effect.provideService(InsideSharedWorkGrant, config.inside),
    Effect.provide(
      Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
    ),
    Effect.provide(Store.layer(location, { create: false })),
    Effect.provide(BunFileSystem.layer),
    Effect.provide(Logger.layer([logger])),
    Effect.provideService(References.MinimumLogLevel, "Debug"),
  ),
);
if (Exit.isFailure(exit)) {
  const cause = Cause.squash(exit.cause);
  const error = z
    .object({
      _tag: z.string(),
      tag: z.string().optional(),
      message: z.string().optional(),
      attemptId: z.string().optional(),
    })
    .safeParse(cause);
  emit("failed", error.success ? error.data : { tag: "Defect" });
}
process.exit(0);
