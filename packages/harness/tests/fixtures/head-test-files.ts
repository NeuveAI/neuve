import { Effect } from "effect";
import { lsTree } from "../../src/git-objects.ts";
import { testFilesOf } from "../../src/pi/stages/reading-task.ts";

type Args = Parameters<typeof testFilesOf>;

/**
 * The head's files by test status exactly as a reading's evidence decision reads them
 * (`testFilesOf`, `pi/stages/reading-task.ts`), outside a run: the decision's context is used only
 * for the repository and the run ID its in-process memory is scoped by, and its runner only runs the
 * effect (the tree and declarations reads need no service). A new run ID each call, so nothing is
 * remembered across calls.
 */
export const headTestFilesOf = async (repository: string, head: string) => {
  const headTree = Bun.spawnSync(
    ["git", "-C", repository, "rev-parse", `${head}^{tree}`],
    { stdout: "pipe", stderr: "pipe" },
  )
    .stdout.toString()
    .trim();
  const entries = await Effect.runPromise(lsTree(repository, headTree));
  const ctx = {
    repository,
    runId: `head-test-files-${crypto.randomUUID()}`,
  } as unknown as Args[0];
  const run: Args[1] = (effect, signal) =>
    Effect.runPromise(effect as Effect.Effect<never>, { signal });
  const manifest = {
    range: { headOid: head, headTree },
  } as unknown as Args[2];
  return { entries, files: await testFilesOf(ctx, run, manifest, entries) };
};
