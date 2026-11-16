import { captureOutlineSource } from "../../src/graph-outline.ts";
import { hunkLeads } from "../../src/leads.ts";
import { bm25Retriever } from "../../src/retriever.ts";
import { appendFileSync } from "node:fs";
import { z } from "zod";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Cause, Effect, Exit, Layer, Logger, References } from "effect";
import {
  Blobs,
  Computations,
  Store,
  resolveStoreLocation,
} from "@neuve/records-core";
import { InsideSharedWorkGrant } from "@neuve/records-core/shared-work-effect";
import { cpuKeyedPool } from "../../src/budget/cpu.ts";
import { prepareCommit } from "../../src/commit-prepare.ts";
import { queryVector, BENCH_E0_IDENTITY } from "../../src/e0.ts";
import { diffTrees, lsTree } from "../../src/git-objects.ts";
import { sharedTreeIndex } from "../../src/lookups.ts";
import {
  rangeManifest,
  defaultManifestSettings,
  fileHunks,
} from "../../src/manifest.ts";
import { indexOf } from "../../src/retrievers.ts";
import { blobChunks } from "../../src/search-index.ts";

const config = z
  .object({
    repository: z.string(),
    executions: z.string(),
    operation: z.enum([
      "chunks",
      "index",
      "lookup",
      "hunks",
      "leads",
      "e0",
      "preparation",
      "direct-leads",
    ]),
    holdOp: z.string().optional(),
    inside: z.boolean().default(false),
  })
  .parse(JSON.parse(process.env.NEUVE_SHARED_TEST ?? "{}"));
const emit = (event: string, fields: object = {}) =>
  console.info(JSON.stringify({ event, ...fields }));
const release = Promise.withResolvers<void>();
void (async () => {
  for await (const _ of Bun.stdin.stream()) {
    release.resolve();
    break;
  }
})();
const git = (...args: string[]) => {
  const result = Bun.spawnSync(["git", "-C", config.repository, ...args]);
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};
const head = git("rev-parse", "HEAD");
const base = git("rev-parse", "HEAD^");
const tree = git("rev-parse", "HEAD^{tree}");
const location = await Effect.runPromise(
  resolveStoreLocation(config.repository),
);
const program = Effect.gen(function* () {
  const store = yield* Computations.ComputationStore;
  const operation = Effect.gen(function* () {
    switch (config.operation) {
      case "chunks": {
        const entries = yield* lsTree(config.repository, tree);
        const result = yield* blobChunks(
          config.repository,
          entries,
          captureOutlineSource(),
        );
        emit("result", { count: result.chunks.size });
        return;
      }
      case "index":
      case "lookup": {
        const result = yield* (
          config.operation === "index" ? indexOf : sharedTreeIndex
        )(config.repository, tree, captureOutlineSource());
        emit("result", { count: result.index.chunks.length });
        return;
      }
      case "hunks":
      case "leads": {
        const result = yield* rangeManifest(
          config.repository,
          { baseOid: base, headOid: head },
          defaultManifestSettings(1_000_000),
          captureOutlineSource(),
        );
        emit("result", { count: result.value.hunks.length });
        return;
      }
      case "direct-leads": {
        const hunks = yield* fileHunks(
          config.repository,
          yield* diffTrees(config.repository, base, head),
          captureOutlineSource(),
        );
        const baseTree = git("rev-parse", "HEAD^^{tree}");
        const { index } = yield* indexOf(
          config.repository,
          baseTree,
          captureOutlineSource(),
        );
        const hunk = hunks[0];
        if (!hunk) return yield* Effect.die("fixture hunk missing");
        yield* hunkLeads(hunk, bm25Retriever(config.repository, index));
        emit("result", { count: 1 });
        return;
      }
      case "preparation": {
        const result = yield* prepareCommit(
          { repository: config.repository },
          { oid: head, tree, parents: [base] },
        );
        emit("result", { count: result.hunks });
        return;
      }
      case "e0": {
        yield* cpuKeyedPool("precompute.leads", 2, () =>
          queryVector(
            {
              id: "e0",
              model: {
                hfId: "google/embeddinggemma-2",
                revision: BENCH_E0_IDENTITY.revision,
                weightsSha256: BENCH_E0_IDENTITY.weights["model.safetensors"],
                recipe: "fixture",
              },
              documents: {
                contract: "bench.encode-chunk@1",
                device: "cpu",
                dtype: "float32",
              },
              queries: {
                encoder: "semantic-client-base",
                workerSha256: "a".repeat(64),
                device: "cpu",
                dtype: "float32",
              },
            },
            {
              python: "unused",
              snapshot: "unused",
              worker: "unused",
              vectorStore: location.directory,
            },
            "fixture query",
            async () => ({ kind: "refusal", reason: "fixture E0 refusal" }),
          ),
        );
        emit("result");
        return;
      }
    }
  });
  return yield* operation.pipe(
    Effect.provideService(Computations.ComputationStore, {
      ...store,
      run: (spec, compute) =>
        store.run(
          spec,
          spec.op === config.holdOp
            ? Effect.andThen(
                Effect.promise(async () => {
                  appendFileSync(
                    config.executions,
                    `${Computations.computationKey(spec).key}\n`,
                  );
                  emit("run");
                  await release.promise;
                }),
                compute,
              )
            : compute,
        ),
    }),
  );
});
const role = z.object({
  type: z.literal("shared-work.role"),
  role: z.string(),
});
const logger = Logger.make(({ message }) => {
  for (const item of [message].flat()) {
    const parsed = role.safeParse(item);
    if (parsed.success) emit("role", parsed.data);
  }
});
const exit = await Effect.runPromiseExit(
  program.pipe(
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
  const parsed = z
    .object({
      _tag: z.string().optional(),
      message: z.string().optional(),
      tag: z.string().optional(),
    })
    .safeParse(Cause.squash(exit.cause));
  emit(
    "failed",
    parsed.success
      ? parsed.data
      : { message: String(Cause.squash(exit.cause)) },
  );
}
process.exit(0);
