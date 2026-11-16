import { getPriority, setPriority } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer } from "effect";
import { Blobs, Computations } from "@neuve/records-core";
import {
  CommitHybrid as HarnessCommitHybrid,
  HybridModels as HarnessHybridModels,
} from "@neuve/harness";
import { execute, withStore, write } from "./records-cli.ts";

const HELP = `Usage:
  neuve hybrid prepare --rev <revision> [--repo <path>]
              Hybrid leads' first pass (10.117): encode, on this machine, every chunk of the
              revision's tree that has no stored vector, into the repository's Records store,
              so commit-time hybrid leads can start from it. Runs at nice 10 and resumes where a
              stopped pass left off. It is heavy (minutes to hours): run it only in a measured
              slot. Needs search.hybrid in your Neuve settings. Its spans and
              metrics go to <store>/hybrid-logs/.`;

/** `neuve hybrid prepare --rev <rev>`: the first pass over a tree's chunks. */
export const runHybridCli = async (
  args: ReadonlyArray<string>,
): Promise<number> => {
  const [command, ...rest] = args;
  if (command !== "prepare") {
    await write(HELP);
    return command === undefined || command === "--help" ? 0 : 2;
  }
  const { values } = parseArgs({
    args: [...rest],
    strict: true,
    options: { rev: { type: "string" }, repo: { type: "string" } },
  });
  if (values.rev === undefined)
    throw new Error("neuve hybrid prepare needs --rev <revision>");
  const revision = values.rev;
  const repository = resolve(values.repo ?? process.cwd());
  try {
    setPriority(10);
  } catch {
    // A sandbox may refuse; the model processes lower their own priority.
  }
  const report = await execute(
    withStore(repository, "write", (location) =>
      Effect.gen(function* () {
        const setup = yield* HarnessCommitHybrid.hybridSetup(
          location.directory,
        );
        if (setup.kind !== "ready")
          return yield* Effect.fail(
            new Error(`hybrid leads are not set up here: ${setup.reason}`),
          );
        const log = HarnessCommitHybrid.openHybridLog(
          location.directory,
          `prepare-${new Date().toISOString().replaceAll(":", "-")}`,
        );
        const workers = yield* HarnessHybridModels.hybridWorkers({
          runtime: setup.runtime,
          e0: setup.e0,
        });
        const started = Date.now();
        const result = yield* HarnessCommitHybrid.withHybridLog(
          log,
          HarnessCommitHybrid.prepareTreeVectors(
            repository,
            revision,
            workers.encoder,
            (done, total) =>
              Effect.promise(() =>
                write(
                  `encoded ${done} of ${total} missing chunk(s) (${Math.round((Date.now() - started) / 1000)} s)`,
                ),
              ),
          ),
        );
        log.write({ type: "hybrid.first-pass", ...result });
        return { result, log: log.path, nice: getPriority() };
      }).pipe(
        Effect.ensuring(HarnessHybridModels.closeHybridWorkers),
        Effect.provide(
          Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
        ),
      ),
    ).pipe(Effect.provide(BunFileSystem.layer)),
  );
  const { result } = report;
  await write(
    `Tree ${result.tree.slice(0, 12)}: ${result.chunks} chunks; ${result.encoded} encoded now, ${result.refused} refused (over the model's 8,192 tokens), ${result.unreadable} unreadable; ${result.after.withVectors} with vectors, ${result.after.missing} still missing. Log: ${report.log} (nice ${report.nice}).`,
  );
  return result.after.missing === 0 ? 0 : 1;
};
