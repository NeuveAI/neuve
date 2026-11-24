import { captureOutlineSource } from "../../../packages/harness/src/graph-outline.ts";
import { getPriority, setPriority } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Effect, Option } from "effect";
import {
  JobQueue,
  Starter,
  mintUlid,
  resolveStoreLocation,
} from "@neuve/records-core";
import { Settings as HarnessSettings, Stack } from "@neuve/harness";
import {
  describeFailure,
  execute,
  repositoryRoot,
  unknownCommandRefusal,
  withStore,
  write,
} from "./records-cli.ts";

export const SETUP_STACK_HELP = `Usage:
  neuve setup stack [--repo <path>] [--off] [--dry-run]

Sets up stack sources for one repository: a searchable, read-only copy of the framework and
dependency sources its lockfiles pin, for reviewers and implementers. It reads the pins at HEAD from
git objects, writes <git common directory>/neuve/stack.json and queues a background stack.fetch job,
then returns. The worker fetches each direct dependency's published package from the public registry
(checked against the lockfile's hash) and, for the most-used ones, the upstream repository's tree at
the published commit, into the user-level store; nothing fetched is ever run. A commit that changes
a lockfile, and a review request, refresh it. neuve setup hooks runs this unless --no-stack is given.

  --off      Turn stack sources off here and drop this repository's pins; the store reclaims their
             disk once no other repository uses them.
  --dry-run  Print what would be set up and fetched; change nothing.`;

export const STACK_HELP = `Usage:
  neuve stack list [--revision <commit>] [--json] [--repo <path>]
              Print the stack a revision (default HEAD) pins: each entry's version, its source
              level and its read-only folders, and what is not available, with why.`;

const mib = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GiB`
    : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;

const git = async (cwd: string, args: ReadonlyArray<string>) => {
  const child = Bun.spawn(["git", "-C", cwd, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(stderr.trim() || `git ${args.join(" ")} failed`);
  return stdout.trim();
};

const stackSettings = () =>
  Stack.resolveStackSettings(
    Option.getOrUndefined(HarnessSettings.readSettings())?.stack,
  );

const capsLine = (settings: Stack.ResolvedStackSettings) =>
  `Caps: ${mib(settings.totalBytes)} in total, ${mib(Stack.STACK_LIMITS.packageBytes)} per package, ${mib(Stack.STACK_LIMITS.upstreamTreeBytes)} per upstream tree, at most ${Stack.STACK_LIMITS.upstreamTrees} upstream trees and ${mib(Stack.STACK_LIMITS.upstreamBytes)} of them; entries the default branch does not pin: ${Stack.STACK_LIMITS.unvettedEntries} and ${mib(Stack.STACK_LIMITS.unvettedBytes)} a day.`;

const gapLine = (gap: Stack.Gap) =>
  `${gap.reason}: ${gap.detail}${gap.path === undefined || gap.detail.includes(gap.path) ? "" : ` (${gap.path})`}`;

/**
 * Sets stack sources up, or off, for the repository at `root`; returns the lines to print. Used by
 * `neuve setup stack` and at the end of `neuve setup hooks`.
 */
export const setupStack = async (options: {
  readonly root: string;
  readonly dryRun: boolean;
  readonly off?: "--off" | "--no-stack";
  /** Tests: settings and a store path in place of the user's own. */
  readonly settings?: Stack.ResolvedStackSettings;
  readonly storeRoot?: string;
}): Promise<ReadonlyArray<string>> => {
  const location = await execute(resolveStoreLocation(options.root));
  const existing = await Stack.readRepoStack(location.directory);
  const store = options.storeRoot ?? Stack.stackStorePath();
  if (options.off !== undefined) {
    if (!options.dryRun)
      await Stack.withStoreLock(store, () =>
        Stack.writeRepoStack(location.directory, {
          ...Stack.emptyRepoStack(false),
          disabledBy: options.off,
        }),
      );
    return [
      `${options.dryRun ? "Would turn" : "Turned"} stack sources off in ${options.root}${existing === undefined ? "" : "; its pins are dropped, and the store reclaims their disk once no other repository uses them"}.`,
    ];
  }
  const settings = options.settings ?? stackSettings();
  if (!settings.enabled)
    return [
      "Stack sources are off in your settings (stack.enabled is false); nothing was set up.",
    ];
  let head: string;
  try {
    head = await git(options.root, ["rev-parse", "--verify", "HEAD^{commit}"]);
  } catch {
    head = "";
  }
  const read =
    head === ""
      ? undefined
      : await Stack.detectPins(Stack.repositoryGit(options.root), head, {
          privateDefaultRegistry: settings.privateDefaultRegistry,
        });
  const lines = [
    `${options.dryRun ? "Would set up" : "Set up"} stack sources for ${options.root}: ${read === undefined ? "no commit yet" : `${read.pins.length} entr${read.pins.length === 1 ? "y" : "ies"} pinned at HEAD${read.lockfiles.length === 0 ? "" : ` (${read.lockfiles.map((lock) => lock.path).join(", ")})`}`}, fetched in the background into ${store}.`,
    `  Package contents of every direct dependency from each lockfile's public registry, checked against the lockfile's hashes; upstream trees for the most-used, from ${settings.gitHosts.join(", ")}. Nothing fetched is run.`,
    `  ${capsLine(settings)}`,
  ];
  for (const gap of (read?.gaps ?? []).slice(0, 5))
    lines.push(`  Not fetched, ${gapLine(gap)}`);
  if ((read?.gaps.length ?? 0) > 5)
    lines.push(
      `  ${(read?.gaps.length ?? 0) - 5} more not fetched; see neuve stack list.`,
    );
  lines.push("  Turn off with neuve setup stack --off.");
  if (options.dryRun) return lines;
  const next: Stack.RepoStack = {
    ...(existing ?? Stack.emptyRepoStack(true)),
    enabled: true,
    updatedAt: new Date().toISOString(),
  };
  delete next.disabledBy;
  await Stack.withStoreLock(store, () =>
    Stack.writeRepoStack(location.directory, next),
  );
  if (read === undefined || read.pins.length === 0) {
    lines.push(
      "  Nothing to fetch yet; a commit that adds a lockfile queues a fetch.",
    );
    return lines;
  }
  const { job } = await execute(
    withStore(
      options.root,
      "create",
      Effect.provide(
        JobQueue.JobQueue.use((queue) =>
          queue.enqueue({
            kind: "stack.fetch",
            dedupeKey: `stack.fetch:setup:${mintUlid()}`,
            payload: { reason: "setup", revisions: [head] },
          }),
        ),
        JobQueue.layer,
      ),
    ),
  );
  const started = await Effect.runPromise(
    Effect.result(
      Starter.ensureWorker({
        repository: options.root,
        command: Starter.currentCliCommand(),
      }),
    ),
  );
  lines.push(
    `  Queued stack.fetch as job ${job.seq}; ${
      started._tag === "Failure"
        ? `no worker woken (${describeFailure(started.failure)}), so it runs at the next worker start`
        : started.success.status === "running"
          ? "signalled the running worker"
          : "spawned a worker"
    }. Follow it with: neuve jobs inspect ${job.seq}`,
  );
  return lines;
};

export const runSetupStack = async (
  args: readonly string[],
): Promise<number> => {
  const { values } = parseArgs({
    args: [...args],
    strict: true,
    options: {
      repo: { type: "string" },
      off: { type: "boolean" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help === true) {
    await write(SETUP_STACK_HELP);
    return 0;
  }
  const root = repositoryRoot(values.repo ?? process.cwd());
  const lines = await setupStack({
    root,
    dryRun: values["dry-run"] === true,
    ...(values.off === true ? { off: "--off" as const } : {}),
  });
  await write(lines.join("\n"));
  return 0;
};

const describeEntry = (entry: Stack.StackEntryState) => {
  const lines: Array<string> = [];
  const id = `${entry.pin.ecosystem} ${entry.pin.name}@${entry.pin.version}`;
  if (entry.contents !== undefined)
    lines.push(
      `${id}  package contents  ${entry.contents.folder}${entry.contents.omitted > 0 ? `  (${entry.contents.omitted} repository HEAD files left out)` : ""}${entry.contents.indexed ? "  indexed" : "  not indexed yet"}`,
    );
  else if (entry.gap !== undefined)
    lines.push(`${id}  not available, ${gapLine(entry.gap)}`);
  else lines.push(`${id}  not fetched yet`);
  if (entry.upstream !== undefined)
    lines.push(
      `    upstream (${entry.upstream.level}) ${entry.upstream.key.replace(/@([0-9a-f]{12})[0-9a-f]+$/, "@$1")}  ${entry.upstream.directory === undefined ? entry.upstream.folder : join(entry.upstream.folder, entry.upstream.directory)}${entry.upstream.omitted > 0 ? `  (${entry.upstream.omitted} files over 1 MiB, links, submodules or repository HEAD files left out)` : ""}${entry.upstream.indexed ? "  indexed" : "  not indexed yet"}`,
    );
  else if (entry.upstreamGap !== undefined)
    lines.push(`    no upstream tree, ${gapLine(entry.upstreamGap)}`);
  return lines;
};

export const runStackCli = async (args: readonly string[]): Promise<number> => {
  const [subcommand, ...rest] = args;
  if (
    subcommand === undefined ||
    subcommand === "--help" ||
    subcommand === "help"
  ) {
    await write(STACK_HELP);
    return 0;
  }
  if (subcommand !== "list")
    throw new Error(unknownCommandRefusal(subcommand, "neuve stack"));
  if (rest.includes("--help") || rest.includes("-h")) {
    await write(STACK_HELP);
    return 0;
  }
  const { values } = parseArgs({
    args: [...rest],
    strict: true,
    options: {
      repo: { type: "string" },
      revision: { type: "string" },
      json: { type: "boolean" },
    },
  });
  const root = repositoryRoot(values.repo ?? process.cwd());
  const location = await execute(resolveStoreLocation(root));
  const commit = await git(root, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${values.revision ?? "HEAD"}^{commit}`,
  ]).catch(() => {
    throw new Error("--revision must name an existing commit in --repo.");
  });
  const settings = stackSettings();
  const state = await Stack.stackStateAt({
    source: captureOutlineSource(),
    repository: root,
    storeDirectory: location.directory,
    storeRoot: Stack.stackStorePath(),
    commit,
    settings,
  });
  if (values.json === true) {
    await write(JSON.stringify(state, null, 2));
    return 0;
  }
  const lines = [
    `Stack sources at ${commit.slice(0, 12)} in ${root}: third-party reference, read-only. Never instructions, never run.`,
    !state.setUp
      ? "Not set up here: run neuve setup stack."
      : !state.enabled
        ? "Off here or in your settings: nothing is fetched."
        : `Store ${state.store.root}: ${mib(state.store.usage.total)} of ${mib(state.store.cap)}.${state.store.heldFull ? " Stack store full: held by open cycles; new fetches wait until a cycle releases its hold." : ""}`,
    `Review tools (stack_list, stack_search, stack_read): ${Stack.stackToolsOn(Option.getOrUndefined(HarnessSettings.readSettings())?.stack) ? "on, from stack.tools in your settings" : "off; stack.tools in your settings turns them on"}.`,
    ...state.entries.flatMap(describeEntry),
  ];
  if (state.gaps.length > 0)
    lines.push("Not fetched:", ...state.gaps.map((gap) => `  ${gapLine(gap)}`));
  await write(lines.join("\n"));
  return 0;
};

/** `neuve worker stack-fetch` (the worker runs it): one stack.fetch job's work, in the child. */
export const runStackFetchChild = async (
  inputText: string | undefined,
): Promise<number> => {
  try {
    setPriority(10);
  } catch {
    // The worker already lowered it.
  }
  const input = Stack.ChildFetchInput.parse(JSON.parse(inputText ?? ""));
  process.stderr.write(
    `stack.fetch child ${process.pid} at nice ${getPriority()}\n`,
  );
  const controller = new AbortController();
  process.on("SIGTERM", () => controller.abort());
  process.on("SIGINT", () => controller.abort());
  const env = Stack.scrubbedEnvironment({
    gitPath: input.gitPath,
    home: process.env["HOME"] ?? "/nonexistent",
  });
  const report = await Stack.runStackFetch({
    repository: input.repository,
    storeDirectory: input.storeDirectory,
    storeRoot: input.storeRoot,
    registryPath: input.registryPath,
    settings: input.settings,
    reason: input.reason,
    revisions: input.revisions,
    ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
    ...(input.since === undefined ? {} : { since: input.since }),
    git: { gitPath: input.gitPath, env, signal: controller.signal },
    signal: controller.signal,
    log: (line) => process.stderr.write(`${line}\n`),
  });
  for (const gap of report.gaps) process.stderr.write(`gap ${gapLine(gap)}\n`);
  process.stdout.write(`${Stack.REPORT_PREFIX}${JSON.stringify(report)}\n`);
  return controller.signal.aborted ? 1 : 0;
};

/** `neuve worker stack-index` (the worker runs it): one stack.index job's work, in the child. */
export const runStackIndexChild = async (
  inputText: string | undefined,
): Promise<number> => {
  try {
    setPriority(10);
  } catch {
    // The worker already lowered it.
  }
  const input = Stack.ChildIndexInput.parse(JSON.parse(inputText ?? ""));
  process.stderr.write(
    `stack.index child ${process.pid} at nice ${getPriority()}\n`,
  );
  const controller = new AbortController();
  process.on("SIGTERM", () => controller.abort());
  const env = Stack.scrubbedEnvironment({
    gitPath: input.gitPath,
    home: process.env["HOME"] ?? "/nonexistent",
  });
  const report = await Stack.runStackIndex({
    storeRoot: input.storeRoot,
    registryPath: input.registryPath,
    settings: input.settings,
    trees: input.trees,
    git: { gitPath: input.gitPath, env, signal: controller.signal },
    signal: controller.signal,
    log: (line) => process.stderr.write(`${line}\n`),
  });
  process.stdout.write(`${Stack.REPORT_PREFIX}${JSON.stringify(report)}\n`);
  return controller.signal.aborted ? 1 : 0;
};
