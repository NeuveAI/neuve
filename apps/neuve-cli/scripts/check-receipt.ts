import { rm, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  checkoutState,
  receiptDirectory,
  writeReceipt,
} from "../src/install-source.ts";

/**
 * The receipt `bun run check` leaves for `bun run install:cli` (12.24). `start` runs before the
 * phases and notes the commit when the tree is clean; `finish` runs only after every phase passed,
 * and writes the receipt when the tree is still clean at that same commit. It never fails the check.
 * `NEUVE_CHECK_RECEIPTS` names another folder to write to, for tests; an install to the shared copy
 * reads only the repository's own.
 */
const WORKSPACE_ROOT = resolve(import.meta.dir, "../../..");

const started = (directory: string, commit: string) =>
  join(directory, `${commit}.started`);

const say = (line: string) => Bun.write(Bun.stderr, `neuve check: ${line}\n`);

const main = async () => {
  const step = Bun.argv[2];
  if (step !== "start" && step !== "finish")
    throw new Error("Usage: check-receipt.ts start|finish");
  const state = await checkoutState(WORKSPACE_ROOT);
  if (state.head === null || state.commonDirectory === null)
    return say("not a git checkout; no receipt");
  const directory =
    process.env["NEUVE_CHECK_RECEIPTS"] ||
    receiptDirectory(state.commonDirectory);
  const marker = started(directory, state.head);
  if (step === "start") {
    if (!state.clean) {
      await rm(marker, { force: true });
      return say(
        "the tree has local changes, so this run leaves no receipt for `bun run install:cli`",
      );
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(marker, `${new Date().toISOString()}\n`, { mode: 0o600 });
    return;
  }
  const began = await Bun.file(marker).exists();
  await rm(marker, { force: true });
  if (!began || !state.clean)
    return say(
      `no receipt: ${!state.clean ? "the tree has local changes" : `the check did not start clean at ${state.head.slice(0, 10)}`}`,
    );
  const path = await writeReceipt(directory, {
    version: 1,
    commit: state.head,
    branch: state.branch,
    at: new Date().toISOString(),
  });
  await say(
    `every phase passed on ${state.head.slice(0, 10)}; receipt ${path}`,
  );
};

try {
  await main();
} catch (error) {
  await say(
    `no receipt: ${error instanceof Error ? error.message : String(error)}`,
  );
}
