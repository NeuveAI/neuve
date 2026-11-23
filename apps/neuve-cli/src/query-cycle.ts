import { Cycles, Starter, type StoreLocation } from "@neuve/records-core";
import { Effect } from "effect";
import { isSqlError } from "effect/sql/SqlError";
import { describeFailure } from "./records-cli.ts";

export const readQueryBranch = (repository: string, branch?: string) => {
  const result = Bun.spawnSync(
    branch === undefined
      ? ["git", "-C", repository, "symbolic-ref", "--quiet", "HEAD"]
      : [
          "git",
          "-C",
          repository,
          "show-ref",
          "--verify",
          "--quiet",
          `refs/heads/${branch}`,
        ],
    { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
  );
  if (branch !== undefined) {
    if (!result.success)
      throw new Error(
        `--branch names no local branch ${JSON.stringify(branch)} in --repo.`,
      );
    return branch;
  }
  const ref = result.stdout.toString().trim();
  return result.success && ref.startsWith("refs/heads/")
    ? ref.slice("refs/heads/".length)
    : undefined;
};

export const warnQueryCycle = (reason: string) =>
  Bun.write(
    Bun.stderr,
    `neuve: Query did not join a review cycle (${reason
      .replace(/[\r\n]+/g, " ")
      .trim()
      .replace(/\.$/, "")}).\n`,
  ).catch(() => undefined);

export const openQueryCycle = (
  repository: string,
  location: StoreLocation,
  payload: Parameters<typeof Cycles.openOrJoinCycle>[0],
  actor: string,
  onFailure: (reason: string) => void,
) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(Cycles.openOrJoinCycle(payload, actor));
    if (result._tag === "Failure") {
      const error = result.failure;
      onFailure(
        isSqlError(error) && error.reason._tag === "LockTimeoutError"
          ? "Records store is locked"
          : describeFailure(error),
      );
      return undefined;
    }
    const { cycleId, opened } = result.success;
    if (opened && process.env.NEUVE_TEST_PROCESS !== "1")
      yield* Effect.ignore(
        Starter.ensureWorkerAt(location, {
          repository,
          command: Starter.currentCliCommand(),
        }),
      );
    return cycleId;
  });
