import { Cycles, Starter, type StoreLocation } from "@neuve/records-core";
import { GitOid } from "@neuve/records-schema";
import { Effect } from "effect";
import { isSqlError } from "effect/sql/SqlError";
import { describeFailure } from "./records-cli.ts";

export type QueryBranch = Pick<
  Parameters<typeof Cycles.openOrJoinCycle>[0],
  "branch" | "branchTipOid"
>;

export const readQueryBranch = (
  repository: string,
  branch?: string,
): QueryBranch | { reason: string } => {
  const prefix = "refs/heads/";
  let ref = branch === undefined ? undefined : prefix + branch;
  if (ref === undefined) {
    const result = Bun.spawnSync(
      ["git", "-C", repository, "symbolic-ref", "--quiet", "HEAD"],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
    );
    ref = result.stdout.toString().trim();
    if (!result.success || !ref.startsWith(prefix))
      return { reason: "HEAD is detached, so pass --branch <name>" };
  }

  // Capture the checked-out or named branch's tip at the read, before any Records transaction.
  const result = Bun.spawnSync(
    ["git", "-C", repository, "show-ref", "--verify", "--hash", ref],
    { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
  );
  const tip = GitOid.safeParse(result.stdout.toString().trim());
  if (!result.success || !tip.success) {
    if (branch !== undefined)
      throw new Error(
        `--branch names no local branch ${JSON.stringify(branch)} in --repo.`,
      );
    return { reason: "the checked-out branch has no readable tip" };
  }
  return { branch: ref.slice(prefix.length), branchTipOid: tip.data };
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
