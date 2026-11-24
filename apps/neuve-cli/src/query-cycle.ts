import { Cycles, Starter, type StoreLocation } from "@neuve/records-core";
import { Effect } from "effect";

export type QueryBranch = Pick<
  Parameters<typeof Cycles.openOrJoinCycle>[0],
  "branch" | "branchTipOid"
>;

export const readQueryBranch = (
  repository: string,
  branch?: string,
): QueryBranch | { reason: string; cause?: string } => {
  const prefix = "refs/heads/";
  let ref = branch === undefined ? undefined : prefix + branch;
  if (ref === undefined) {
    const result = Bun.spawnSync(
      ["git", "-C", repository, "symbolic-ref", "--quiet", "HEAD"],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    if (!result.success && result.exitCode !== 1)
      return {
        reason: "the checked-out branch could not be read",
        cause:
          result.stderr.toString().trim() ||
          `git symbolic-ref exited with code ${result.exitCode}`,
      };
    ref = result.stdout.toString().trim();
    if (!result.success || !ref.startsWith(prefix))
      return { reason: "HEAD is detached" };
  }

  // Capture the checked-out or named branch's tip at the read, before any Records transaction.
  const result = Bun.spawnSync(
    ["git", "-C", repository, "show-ref", "--verify", "--hash", ref],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  if (!result.success) {
    if (branch !== undefined)
      throw new Error("--branch must name an existing local branch in --repo.");
    return {
      reason: "the checked-out branch has no readable tip",
      cause:
        result.stderr.toString().trim() ||
        `git show-ref exited with code ${result.exitCode}`,
    };
  }
  return {
    branch: ref.slice(prefix.length),
    branchTipOid: result.stdout.toString().trim(),
  };
};

export const warnQueryCycle = (reason: string) =>
  Bun.write(
    Bun.stderr,
    `neuve: Query did not join a review cycle (${reason === "HEAD is detached" ? "HEAD is detached, so pass --branch <name>" : reason}).\n`,
  ).catch(() => undefined);

export const openQueryCycle = (
  repository: string,
  location: StoreLocation,
  payload: Parameters<typeof Cycles.openOrJoinCycle>[0],
  actor: string,
  onFailure: (error: unknown) => void,
  selectScope?: Parameters<typeof Cycles.openOrJoinCycle<never, never>>[2],
) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(
      Cycles.openOrJoinCycle(payload, actor, selectScope),
    );
    if (result._tag === "Failure") {
      onFailure(result.failure);
      return undefined;
    }
    if (result.success.opened && process.env.NEUVE_TEST_PROCESS !== "1")
      yield* Effect.ignore(
        Starter.ensureWorkerAt(location, {
          repository,
          command: Starter.currentCliCommand(),
        }),
      );
    return result.success;
  });
