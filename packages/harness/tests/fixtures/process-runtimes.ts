import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  Blobs,
  Computations,
  Store,
  mintUlid,
  storeLocationIn,
} from "@neuve/records-core";
import {
  AccountDirectory,
  AccountName,
  DEFAULT_ACCOUNTS,
  inMemoryAccountDirectory,
} from "@neuve/runtime";
import { Effect, Layer, Scope, Exit } from "effect";
import { join } from "node:path";
import { defaultConfig } from "../../src/config.ts";
import { openAttempt } from "../../src/pi/attempt.ts";
import { SourceOwnership } from "../../src/pi/source-ownership.ts";
import {
  configureProcessRuntimes,
  processRuntimes,
} from "../../src/runtimes.ts";
import { ensureRunFolder, runFolder } from "../../src/run-folder.ts";
import { openRunLog } from "../../src/run-log.ts";

/** Two real attempt opens and closes in one isolated worker, with no tasks or network. */
export async function exerciseProcessRuntimes(root: string) {
  let builds = 0;
  configureProcessRuntimes({
    keyPresence: async () => "present",
    accountDirectory: Layer.sync(AccountDirectory, () => {
      builds++;
      return inMemoryAccountDirectory(DEFAULT_ACCOUNTS);
    }),
  });
  const location = storeLocationIn(join(root, "attempt-store"));
  const scope = await Effect.runPromise(Scope.make());
  const records = await Effect.runPromise(
    Layer.buildWithScope(
      Computations.layer.pipe(
        Layer.provideMerge(Blobs.layer(location)),
        Layer.provideMerge(Store.layer(location, { create: true })),
        Layer.provideMerge(BunFileSystem.layer),
      ),
      scope,
    ),
  );
  const run = <A, E>(
    work: Effect.Effect<
      A,
      E,
      | Computations.ComputationStore
      | Blobs.BlobStore
      | import("effect/FileSystem").FileSystem
      | import("effect/sql/SqlClient").SqlClient
    >,
  ) => Effect.runPromise(Effect.provide(work, records));
  try {
    await run(Store.prepareForWrite);
    let before;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const runId = mintUlid();
      const range = {
        baseRef: "main",
        baseOid: "a".repeat(40),
        headOid: "b".repeat(40),
      };
      await run(
        ensureRunFolder(location, {
          runId,
          runKey: "f".repeat(64),
          pipelineVersion: 1,
          jobSeq: attempt,
          range,
        }),
      );
      const ownership = SourceOwnership.acquire(runFolder(location, runId));
      try {
        const opened = await openAttempt({
          ctx: {
            location,
            repository: root,
            runId,
            runKey: "f".repeat(64),
            range,
            cycleId: mintUlid(),
            config: defaultConfig(),
            log: openRunLog(location, runId),
            startedAt: Date.now(),
            reconciliationId: mintUlid(),
            records,
          },
          generation: 1,
          ownership,
          claim: {
            jobSeq: attempt,
            attempt,
            claimedAt: new Date().toISOString(),
          },
          integrations: { status: "absent", path: "synthetic" },
          clients: {
            integrations: { status: "absent", path: "synthetic" },
            get: () => Effect.die("unused"),
          },
          runSlot: (work, signal) => Effect.runPromise(work, { signal }),
          budget: {
            admit: async () => {
              throw new Error("No requests permitted");
            },
            throttle: async () => {},
            capacity: async () => ({}),
            observe: async () => ({}),
          },
        });
        await opened.host.close("ended", context);
        const registry = await processRuntimes();
        if (before !== undefined && before !== registry)
          throw new Error("Attempt registry changed");
        before = registry;
        await Effect.runPromise(
          registry.capabilities(AccountName.parse("anthropic")),
        );
      } finally {
        ownership.release();
      }
    }
    let rejected = false;
    try {
      configureProcessRuntimes({});
    } catch {
      rejected = true;
    }
    return { builds, attempts: 2, rejected };
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)));
  }
}
