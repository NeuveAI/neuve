// Substitute only the code computation. Keep the production prepare-code dispatch and Graph cancellation.
import { mock } from "bun:test";
import { Effect } from "effect";
import { prepareGraphSnapshot } from "@neuve/graph-client";
import * as harness from "@neuve/harness";
const [repository, revision, executable, cacheDirectory, child] =
  Bun.argv.slice(2);
if (!repository || !revision || !executable || !cacheDirectory)
  throw new Error("Missing preparation fixture arguments");
mock.module("@neuve/harness", () => ({
  ...harness,
  CommitPrepare: {
    ...harness.CommitPrepare,
    requirePreparationPriority: () => {},
    prepareCode: () =>
      child === "failure-chain"
        ? Effect.fail(
            new Error("outer failure", {
              cause: new Error("middle\nline", {
                cause: new Error("root\nline"),
              }),
            }),
          )
        : prepareGraphSnapshot(
            { repository, revision, executable },
            { cacheDirectory },
          ),
    // As `graph-search.ts` does: shared between its askers, so detached from this caller.
    prepareCommit: () =>
      Effect.andThen(
        Effect.sync(() => {
          void Effect.runPromise(
            prepareGraphSnapshot(
              { repository, revision, executable },
              { cacheDirectory },
            ),
          );
        }),
        Effect.never,
      ),
  },
}));
const { runWorkerCli } = await import("../../src/worker-cli.ts");
process.exitCode = await runWorkerCli([
  ...(child === "prepare-commit"
    ? ["prepare-commit", "--oid", revision, "--tree", revision]
    : [
        "prepare-code",
        "--store",
        `${cacheDirectory}/store/records.sqlite`,
        "--input",
        "{}",
      ]),
  "--repo",
  repository,
]);
