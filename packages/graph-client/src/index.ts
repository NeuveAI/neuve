import { SharedWork } from "@neuve/records-core/shared-work";
import { budgetDirectory } from "@neuve/records-core/budget-directory";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createReadStream, realpathSync } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  stat,
  utimes,
} from "node:fs/promises";
import { setPriority, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { kill as signalProcess } from "node:process";
import { setImmediate } from "node:timers/promises";
import { Data, Effect, Schema } from "effect";
import {
  GraphSymbolsError,
  readSymbolBatches,
  validateSymbolPaths,
  type GraphSymbolsInput,
  type GraphSymbolsObservation,
} from "./symbols.ts";
export {
  GraphSymbolsError,
  graphReadsPath,
  graphRefusesSourcePath,
  isGraphCallable,
  SYMBOL_BATCH_BYTES,
  SYMBOL_BATCH_FILES,
  SYMBOL_FILE_TOKENS_BYTES,
  SYMBOL_TOKENS_BATCH_BYTES,
} from "./symbols.ts";
export {
  GRAPH_IMPORT_BINDINGS_FEATURE,
  GRAPH_INDENTATION_SIGNIFICANT_FEATURE,
  GRAPH_LEAF_FLAGS,
  GRAPH_TOKEN_DIRECTIVES_FEATURE,
  GRAPH_TOKENS_FEATURE,
  TOKENS_OUTPUT_LIMIT,
  graphGapAfterLast,
  graphGapBefore,
  graphImportStatementsAt,
  graphLeafAncestors,
  graphLeafFlags,
  graphLeafOpens,
  graphLeafPosition,
  graphLeafType,
  graphLeavesTouchingLines,
} from "./tokens.ts";
export type {
  GraphFileImports,
  GraphFileTokens,
  GraphGap,
  GraphImportBinding,
  GraphImportStatement,
  GraphLeafFlags,
  GraphLeafRow,
  GraphTokenCoverage,
  GraphTokensUnavailableReason,
} from "./tokens.ts";
import {
  CompactSnapshotDecoder,
  GRAPH_CALL_SITE_LINES,
  GRAPH_COMPACT_SNAPSHOT,
  GRAPH_EXACT_COMMIT_STREAMS,
  GRAPH_IMPORT_TARGETS,
  GraphSnapshotError,
  SNAPSHOT_RECORD_LINE_BYTES,
  SNAPSHOT_SUMMARY_LINE_BYTES,
  summaryLinePrefix,
  type GraphSnapshotSink,
} from "./snapshot.ts";
export {
  GraphSnapshotError,
  GRAPH_CALL_SITE_LINES,
  GRAPH_COMPACT_SNAPSHOT,
  GRAPH_EXACT_COMMIT_STREAMS,
  GRAPH_GO_BUILD_EXCLUDED,
  GRAPH_IMPORT_TARGETS,
  GRAPH_SUBMODULE_NOT_READ,
} from "./snapshot.ts";
export type { GraphSnapshotSink } from "./snapshot.ts";
export {
  GRAPH_CALL_SITE_KINDS,
  GraphImportTarget,
  GraphLocationSchema,
  GraphSnapshotCoverage,
  GraphSnapshotEvidence,
  GraphSnapshotFile,
  GraphSnapshotRelation,
  GraphSnapshotSymbol,
} from "./domain.ts";
export type {
  GraphSymbolsInput,
  GraphSymbolsObservation,
  GraphFileObservation,
  GraphFileSymbol,
  GraphOutlineNode,
} from "./symbols.ts";

import {
  GitReadRefusal,
  preflightLocalGitRead,
  qualifyLocalGitRead,
  runQualifiedGit,
  gitReadText,
  recheckLocalGitRead,
  prepareLocalGitRead,
  type GitReadPolicy,
} from "./git-read-qualification.ts";
export {
  GitReadRefusal,
  GitReadNonBlobEntry,
  preflightLocalGitRead,
  qualifyLocalGitRead,
  runQualifiedGit,
  gitReadText,
  recheckLocalGitRead,
  readQualifiedGitBlob,
  assessLocalGitEnvironment,
  prepareLocalGitRead,
  describeGitReadAssessment,
  requireOfflineGitRead,
  OFFLINE_GIT_FIX,
} from "./git-read-qualification.ts";
export type {
  GitReadAssessment,
  GitReadPolicy,
  PhysicalGitScope,
  GitReadPreflight,
  QualifiedGitRead,
  GitReadRun,
  GitReadReceipt,
  GitReadObservation,
  RecognizedNonBlobGitEntry,
} from "./git-read-qualification.ts";
export {
  resolveQualifiedCommitSourceView,
  createQualifiedCommitSourceEntryResolver,
  enumerateQualifiedCommitTree,
  describeQualifiedCommitSource,
  readQualifiedCommitSource,
} from "./semantic-source-read.ts";
export type {
  CommitSourceEntry,
  CommitSourceInventory,
  CommitSourceMetadata,
} from "./semantic-source-read.ts";

import type {
  FullRevision,
  GraphCapabilities,
  GraphCacheObservation,
  GraphCacheDeclaration,
  GraphProfile,
  GraphPreparedRead,
  GraphPreparationRequest,
  GraphPreparationPlan,
  GraphGenerationPreparation,
  GraphReadQualification,
  GraphCapabilityLimitation,
  GraphCommandReceipt,
  GraphCommandStage,
  GraphCommandUsage,
  GraphEndpoint,
  GraphEvidence,
  GraphFrontierSummary,
  GraphInspection,
  GraphInspectionEvidence,
  GraphInspectionEvent,
  GraphInspectionRun,
  GraphInspectionRequest,
  GraphLocation,
  GraphLocationNormalization,
  GraphOutcome,
  GraphProviderObservation,
  GraphSnapshotCoverage,
  GraphSnapshotPreparation,
  SourceRange,
  GraphPreparedFailureReason,
  GraphQueryObservation,
  GraphRelationObservation,
  GraphRelationshipObservation,
  GraphRelationshipRequest,
  GraphRelationshipOutcome,
  RepositoryPath,
  SourcePath,
} from "./domain.ts";
import {
  PreparedReceiptError,
  type PreparedQualification,
  fullRevision,
  parseCapabilities,
  parseFeatureLanguages,
  parseJson,
  parseNeighbors,
  parseQuery,
  parseRefresh,
  parseVersion,
  parsePreparation,
  parsePreparationAvailability,
  parsePreparationWork,
  parseSnapshotPreparation,
  parseCacheDeclaration,
} from "./parse.ts";

export type {
  FullRevision,
  GraphCapabilities,
  GraphCacheObservation,
  GraphCacheDeclaration,
  GraphStoreUsage,
  GraphCapabilityLimitation,
  GraphCommandReceipt,
  GraphCommandStage,
  GraphCommandUsage,
  GraphContainedCallable,
  GraphDiagnostic,
  GraphEndpoint,
  GraphEvidence,
  GraphFrontierCount,
  GraphFrontierEndpoint,
  GraphFrontierSummary,
  GraphFocus,
  GraphInspection,
  GraphInspectionEvidence,
  GraphInspectionEvent,
  GraphInspectionIdentity,
  GraphInspectionRequest,
  GraphInspectionRun,
  GraphLocation,
  GraphLocationNormalization,
  GraphProviderObservation,
  GraphSnapshotPreparation,
  GraphOutcome,
  GraphPreparedFailureReason,
  GraphQueryBudget,
  GraphQueryObservation,
  GraphSearchStats,
  GraphServiceMode,
  GraphServiceStats,
  GraphProfile,
  GraphPreparedRead,
  GraphPreparationRequest,
  GraphPreparationPlan,
  GraphGenerationPreparation,
  GraphSyntaxGenerationSelection,
  GraphReadQualification,
  GraphQueryResult,
  GraphQueryResultWithContainedCallables,
  GraphRelationObservation,
  GraphRelationshipObservation,
  GraphRelationshipRequest,
  GraphRelationshipOutcome,
  GraphSectionError,
  GraphSymbolSelector,
  GraphTemporaryViewRegistration,
  RepositoryPath,
  SourcePath,
  SourceRange,
} from "./domain.ts";

type Recorder = Readonly<{
  evidence: GraphInspectionEvidence;
  failures: unknown[];
  signal?: AbortSignal;
  cacheDirectory: string;
  preparedOnly: boolean;
  profile: GraphProfile;
  preparedQualification?: PreparedQualification;
  environment?: Readonly<Record<string, string>>;
  gitPolicy?: GitReadPolicy;
  preparedState: { observed?: GraphPreparedRead };
  /** When this inspection's wait for the shared service ends (`serviceDeadlineMs`), epoch ms. */
  serviceDeadlineAt?: number;
  /** The queue class an inspection asked for; only an inspection's recorder carries one. */
  serviceClass?: "interactive" | "background";
}>;

const readQualification = (
  value: GraphReadQualification,
): GraphReadQualification =>
  value.preparedRead === undefined
    ? {}
    : { profile: value.profile, preparedRead: value.preparedRead };

type InternalCommandReceipt = GraphCommandReceipt &
  Readonly<{ stdoutBytes: Uint8Array }>;

const recordFailure = (recorder: Recorder, action: () => void): void => {
  try {
    action();
  } catch (error) {
    recorder.failures.push(error);
  }
};

const emitEvent = async (
  run: GraphInspectionRun,
  event: GraphInspectionEvent,
): Promise<void> => {
  if (run.signal?.aborted) {
    throw new DOMException("Graph inspection aborted.", "AbortError");
  }
  if (run.signal === undefined) {
    await run.emit(event);
    return;
  }
  const signal = run.signal;
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const abort = (): void =>
      rejectPromise(
        new DOMException("Graph inspection aborted.", "AbortError"),
      );
    signal.addEventListener("abort", abort, { once: true });
    void run
      .emit(event)
      .then(resolvePromise, rejectPromise)
      .finally(() => {
        signal.removeEventListener("abort", abort);
      });
  });
};

/**
 * How long a cancelled command's process group gets to exit on SIGTERM before it is SIGKILLed.
 * The engine answers SIGTERM by stopping its Git children and exiting, well within this.
 */
const COMMAND_KILL_GRACE_MS = 2_000;

/** Commands running now. Each leads its own group, so this process's exit alone would not end them. */
const runningCommands = new Set<ReturnType<typeof Bun.spawn>>();

/**
 * Work shared between callers runs detached from each of them, so cancelling a caller does not reach
 * it, and a process stopping that way would leave its engine running with no owner.
 */
const stopWithThisProcess = (child: ReturnType<typeof Bun.spawn>): void => {
  runningCommands.add(child);
  void child.exited.finally(() => {
    // An engine that died mid-scan leaves its Git children in this group, with no one to stop them.
    terminateCommand(child);
    // Tracked until the escalation has run, as this process may exit before its timer fires.
    setTimeout(
      () => runningCommands.delete(child),
      COMMAND_KILL_GRACE_MS,
    ).unref();
  });
};
process.on("exit", () => {
  const signalled = (group: number, signal: NodeJS.Signals | 0) => {
    try {
      process.kill(group, signal);
      return true;
    } catch {
      return false;
    }
  };
  let groups = [...runningCommands]
    .map((running) => -running.pid)
    .filter((group) => signalled(group, "SIGTERM"));
  // No timer outlives this process, so a group that ignores SIGTERM is waited for here.
  const deadline = Date.now() + COMMAND_KILL_GRACE_MS;
  while (groups.length > 0 && Date.now() < deadline) {
    Bun.sleepSync(10);
    groups = groups.filter((group) => signalled(group, 0));
  }
  for (const group of groups) signalled(group, "SIGKILL");
});

/**
 * Stops a cancelled command and everything it started. Each command runs as the leader of its own
 * process group, and the engine keeps its Git children in that group, so signalling the group
 * reaches a long `git grep` that signalling the engine's pid alone would orphan (it kept scanning
 * for minutes after a timed-out inspection). SIGTERM first, then SIGKILL after the grace, which
 * also covers an engine that was itself SIGKILLed. Where groups are unavailable it falls back to
 * the single process.
 */
const terminateCommand = (child: ReturnType<typeof Bun.spawn>): void => {
  const group = -child.pid;
  const signalGroup = (signal: NodeJS.Signals | 0): boolean => {
    try {
      signalProcess(group, signal);
      return true;
    } catch {
      return false;
    }
  };
  if (!signalGroup("SIGTERM")) {
    child.kill();
    return;
  }
  const escalation = setTimeout(
    () => signalGroup("SIGKILL"),
    COMMAND_KILL_GRACE_MS,
  );
  void child.exited.then(() => {
    // Nothing left in the group: no escalation needed.
    if (!signalGroup(0)) clearTimeout(escalation);
  });
};

/**
 * For a process told to stop. Its shutdown can outlast the time it is given, and the SIGKILL that
 * then ends it runs no exit hook, so its commands are stopped when the signal arrives.
 */
export const stopRunningCommands = (): void => {
  for (const running of runningCommands) terminateCommand(running);
};

/**
 * A finished command's wall time and CPU. Bun's resource usage comes from the wait for the child,
 * so it holds the children the engine waited on; its times are microseconds, as bigints at run time
 * whatever the declared type says.
 */
const commandUsage = (
  child: ReturnType<typeof Bun.spawn>,
  stage: GraphCommandStage,
  started: number,
  aborted: boolean,
): GraphCommandUsage => {
  const cpu = child.resourceUsage()?.cpuTime;
  return {
    stage,
    wallMs: performance.now() - started,
    cpu:
      cpu === undefined
        ? null
        : {
            userMs: Number(cpu.user) / 1_000,
            systemMs: Number(cpu.system) / 1_000,
          },
    aborted,
  };
};

/** The engine's thread cap (6.10's polite CPU), one value for every Neuve process. */
export const GRAPH_ENGINE_GO_MAX_PROCS = 2;

/** Where the engine finds git: the usual system and package-manager folders, in every process. */
const ENGINE_PATH = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

/** A call's own queue settings: this boundary sets them per call, never the process. */
const CALL_SETTINGS = new Set([
  "ENTIRE_GRAPH_CLASS",
  "ENTIRE_GRAPH_DEADLINE_MS",
]);

let fixedEngineEnvironment: Readonly<Record<string, string>> | undefined;

/**
 * The part of the engine's environment that is the same in every Neuve process (worker, commit
 * hook, `neuve query`), taken once per process. The shared Graph service is keyed by the engine's
 * whole environment, so anything that differed between processes (a hook's PATH, a caller's
 * TMPDIR, an inherited GOMAXPROCS) would start a service per process, and the Go settings would
 * silently be the first starter's. It holds only what the engine needs:
 * - the operator's own `ENTIRE_*` settings;
 * - PATH, to find git, fixed: the usual folders, else the folder of the git this process finds;
 * - HOME and XDG_CONFIG_HOME, for git's global configuration;
 * - TMPDIR, fixed: the system's temporary folder (on macOS the user's own; the service's socket
 *   is in a private per-user folder of Graph's choosing either way);
 * - one locale per platform, which the engine's regular expressions and git grep both read;
 * - the Go runtime's settings: the polite thread cap, the others unset.
 */
const engineBaseEnvironment = (): Readonly<Record<string, string>> => {
  if (fixedEngineEnvironment !== undefined) return fixedEngineEnvironment;
  const inherited = globalThis.process.env;
  const darwin = globalThis.process.platform === "darwin";
  const found = Bun.which("git", { PATH: ENGINE_PATH.join(":") });
  const own = Bun.which("git");
  const path =
    found !== null || own === null
      ? ENGINE_PATH
      : [dirname(realpathSync(own)), ...ENGINE_PATH];
  const temporary = darwin
    ? Bun.spawnSync(["/usr/bin/getconf", "DARWIN_USER_TEMP_DIR"], {
        stdout: "pipe",
        stderr: "ignore",
      })
        .stdout.toString()
        .trim()
    : "";
  fixedEngineEnvironment = {
    ...Object.fromEntries(
      Object.entries(inherited).filter(
        (entry): entry is [string, string] =>
          entry[0].startsWith("ENTIRE_") &&
          !CALL_SETTINGS.has(entry[0]) &&
          entry[1] !== undefined,
      ),
    ),
    PATH: path.join(":"),
    ...(inherited["HOME"] === undefined ? {} : { HOME: inherited["HOME"] }),
    ...(inherited["XDG_CONFIG_HOME"] === undefined
      ? {}
      : { XDG_CONFIG_HOME: inherited["XDG_CONFIG_HOME"] }),
    TMPDIR: temporary === "" ? "/tmp" : temporary.replace(/\/$/, ""),
    LANG: darwin ? "en_US.UTF-8" : "C.UTF-8",
    LC_ALL: darwin ? "en_US.UTF-8" : "C.UTF-8",
    GOMAXPROCS: String(GRAPH_ENGINE_GO_MAX_PROCS),
  };
  return fixedEngineEnvironment;
};

/**
 * An engine command's environment: the fixed part, the git settings this boundary chose on
 * purpose (a qualified read's), and the service mode — the caller's, else the operator's
 * `ENTIRE_GRAPH_SERVICE` (a kill switch or diagnosis), else `auto`.
 */
const engineEnvironment = (recorder: Recorder): Record<string, string> => {
  const threads = recorder.evidence.cpuThreads;
  if (
    threads !== undefined &&
    (!Number.isSafeInteger(threads) || threads < 1 || threads > 1024)
  )
    throw new Error("cpuThreads must be an integer between 1 and 1024");
  const service =
    recorder.evidence.service ??
    globalThis.process.env["ENTIRE_GRAPH_SERVICE"] ??
    "auto";
  // The queue's class and the caller's deadline are the call's own, never the service's identity,
  // and mean something only while the service setting is on.
  const queued = service === "auto" || service === "require";
  return {
    ...engineBaseEnvironment(),
    ...(recorder.environment?.PATH === undefined
      ? {}
      : { PATH: [recorder.environment.PATH, ...ENGINE_PATH].join(":") }),
    ...(threads === undefined
      ? {}
      : {
          GOMAXPROCS: String(threads),
          ENTIRE_GRAPH_GREP_CPU: String(threads),
          ENTIRE_GRAPH_GREP_THREADS: "1",
        }),
    ...Object.fromEntries(
      Object.entries(recorder.environment ?? {}).filter(([name]) =>
        name.startsWith("GIT_"),
      ),
    ),
    ENTIRE_GRAPH_SERVICE: service,
    ENTIRE_GRAPH_LIFELINE_FD: "0",
    ...(queued && recorder.serviceClass !== undefined
      ? { ENTIRE_GRAPH_CLASS: recorder.serviceClass }
      : {}),
    ...(queued && recorder.serviceDeadlineAt !== undefined
      ? {
          ENTIRE_GRAPH_DEADLINE_MS: String(
            Math.max(1, Math.ceil(recorder.serviceDeadlineAt - Date.now())),
          ),
        }
      : {}),
  };
};

/**
 * Starts one command as its own process group, with the lifeline on stdin for the engine, the fixed
 * engine environment, the caller's spawn hook unless `viaSpawnHook` is false, and the caller's
 * scheduling priority. An abort of `signal` stops the group; `release` removes that listener.
 */
const startCommand = async (
  argv: readonly string[],
  cwd: string,
  recorder: Recorder,
  signal: AbortSignal | undefined,
  viaSpawnHook: boolean,
): Promise<
  Readonly<{
    process: Bun.Subprocess<"ignore" | "pipe", "pipe", "pipe">;
    release: () => void;
  }>
> => {
  if (signal?.aborted) {
    throw new DOMException("Graph inspection aborted.", "AbortError");
  }
  let abort: (() => void) | undefined;
  const isGit = basename(argv[0] ?? "") === "git";
  const launch = () => {
    if (signal?.aborted)
      throw new DOMException("Graph inspection aborted.", "AbortError");
    const child = Bun.spawn([...argv], {
      cwd,
      // Kept open, unwritten and referenced by the tracked child. The OS closes it even on SIGKILL.
      stdin: isGit ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
      // Its own process group, so cancellation can stop the command's children with it.
      detached: true,
      env: isGit
        ? { ...(recorder.environment ?? globalThis.process.env) }
        : engineEnvironment(recorder),
    });
    stopWithThisProcess(child);
    abort = () => terminateCommand(child);
    signal?.addEventListener("abort", abort, { once: true });
    return child;
  };
  const process =
    !viaSpawnHook || recorder.evidence.spawnProcess === undefined
      ? launch()
      : await recorder.evidence
          .spawnProcess(launch, signal)
          .catch((error: unknown) => {
            if (signal?.aborted)
              throw new DOMException("Graph inspection aborted.", "AbortError");
            throw error;
          });
  if (recorder.evidence.niceness !== undefined)
    try {
      setPriority(process.pid, recorder.evidence.niceness);
    } catch {
      // A process that already exited, or a priority the system refuses: the command still runs.
    }
  return {
    process,
    release: () => {
      if (abort !== undefined) signal?.removeEventListener("abort", abort);
    },
  };
};

const command = async (
  argv: readonly string[],
  cwd: string,
  stage: GraphCommandStage,
  recorder: Recorder,
  options: Readonly<{
    omitRecordedStdout?: boolean;
    ignoreAbort?: boolean;
    maxOutputBytes?: number;
  }> = {},
): Promise<InternalCommandReceipt> => {
  if (argv[0] === "git" && argv[1] !== "init") {
    const at = argv.indexOf("-C");
    const policy =
      recorder.gitPolicy ??
      (await prepareLocalGitRead(at === -1 ? cwd : (argv[at + 1] ?? cwd)));
    argv = [policy.executable, ...policy.commandPrefix, ...argv.slice(1)];
    recorder = { ...recorder, environment: policy.environment };
  }
  const signal = options.ignoreAbort ? undefined : recorder.signal;
  const { process, release } = await startCommand(
    argv,
    cwd,
    recorder,
    signal,
    !options.ignoreAbort,
  );
  const started = performance.now();
  let stdoutBuffer: ArrayBuffer;
  let stderr: string;
  let exitCode: number;
  const readOutput = async (stream: ReadableStream<Uint8Array>) => {
    if (options.maxOutputBytes === undefined)
      return new Response(stream).arrayBuffer();
    const parts: Uint8Array[] = [];
    let size = 0;
    for await (const part of stream) {
      size += part.byteLength;
      if (size > options.maxOutputBytes) {
        terminateCommand(process);
        throw new GraphSymbolsError({
          reason: "invalid-output",
          message: "Graph command exceeded its output byte bound.",
        });
      }
      parts.push(part);
    }
    return new Uint8Array(Buffer.concat(parts)).buffer;
  };
  try {
    [stdoutBuffer, stderr, exitCode] = await Promise.all([
      readOutput(process.stdout),
      readOutput(process.stderr).then((bytes) =>
        new TextDecoder().decode(bytes),
      ),
      process.exited,
    ]);
  } catch (error) {
    terminateCommand(process);
    await process.exited;
    throw error;
  } finally {
    release();
    if (recorder.evidence.onCommandUsage !== undefined) {
      const usage = commandUsage(
        process,
        stage,
        started,
        signal?.aborted === true,
      );
      recordFailure(recorder, () => recorder.evidence.onCommandUsage?.(usage));
    }
  }
  if (signal?.aborted) {
    throw new DOMException("Graph inspection aborted.", "AbortError");
  }
  const stdoutBytes = new Uint8Array(stdoutBuffer);
  const stdout = new TextDecoder().decode(stdoutBytes);
  const receipt = { stage, argv, cwd, stdout, stderr, exitCode, stdoutBytes };
  if (recorder.evidence.onCommand !== undefined) {
    const recordedReceipt: GraphCommandReceipt = options.omitRecordedStdout
      ? {
          stage,
          argv,
          cwd,
          stdout: `<source bytes omitted; length=${stdoutBytes.byteLength}>`,
          stderr,
          exitCode,
        }
      : receipt;
    recordFailure(recorder, () =>
      recorder.evidence.onCommand?.(recordedReceipt),
    );
  }
  return receipt;
};

/** How much of a streamed command's stderr is kept: its end, where the engine's error is. */
const STREAM_STDERR_TAIL_BYTES = 64 * 1024;
/** Lines a streamed command hands over between two yields to the event loop. */
const STREAM_YIELD_LINES = 128;

const concatenated = (parts: readonly Uint8Array[]): Uint8Array =>
  parts.length === 1 && parts[0] !== undefined
    ? parts[0]
    : new Uint8Array(Buffer.concat(parts));

/**
 * Runs one command and hands its stdout to `onLine` line by line as it arrives, never holding the
 * whole output: at most one line in progress (`SNAPSHOT_RECORD_LINE_BYTES`, or the summary's larger
 * allowance) and the end of stderr. It yields to the event loop every `STREAM_YIELD_LINES` lines,
 * and the pipe's own backpressure holds the engine while `onLine` works. A throw from `onLine`, or
 * an abort, stops the process group before this rejects. The exit code is the caller's to judge.
 */
const streamCommand = async (
  argv: readonly string[],
  cwd: string,
  stage: GraphCommandStage,
  recorder: Recorder,
  onLine: (line: string) => void,
): Promise<Readonly<{ exitCode: number; stderr: string; bytes: number }>> => {
  const signal = recorder.signal;
  const { process, release } = await startCommand(
    argv,
    cwd,
    recorder,
    signal,
    true,
  );
  const started = performance.now();
  const text = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  const readLines = async (stream: ReadableStream<Uint8Array>) => {
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    let lines = 0;
    const emit = (line: Uint8Array) => {
      const end =
        line.byteLength > 0 && line[line.byteLength - 1] === 13
          ? line.byteLength - 1
          : line.byteLength;
      onLine(text.decode(line.subarray(0, end)));
    };
    const bound = (size: number, head: Uint8Array | undefined) => {
      if (
        size > SNAPSHOT_RECORD_LINE_BYTES &&
        (size > SNAPSHOT_SUMMARY_LINE_BYTES ||
          head === undefined ||
          !summaryLinePrefix(head))
      )
        throw new GraphSnapshotError({
          reason: "invalid-output",
          message: "Graph output line exceeds its byte bound.",
        });
    };
    for await (const chunk of stream) {
      bytes += chunk.byteLength;
      let start = 0;
      for (
        let end = chunk.indexOf(10, start);
        end !== -1;
        end = chunk.indexOf(10, start)
      ) {
        const piece = chunk.subarray(start, end);
        bound(pendingBytes + piece.byteLength, pending[0] ?? piece);
        emit(pendingBytes === 0 ? piece : concatenated([...pending, piece]));
        pending = [];
        pendingBytes = 0;
        start = end + 1;
        if (++lines % STREAM_YIELD_LINES === 0) {
          await setImmediate();
          signal?.throwIfAborted();
        }
      }
      if (start < chunk.byteLength) {
        // Copied: the rest of this chunk outlives it.
        const rest = chunk.slice(start);
        bound(pendingBytes + rest.byteLength, pending[0] ?? rest);
        pending.push(rest);
        pendingBytes += rest.byteLength;
      }
    }
    signal?.throwIfAborted();
    // A last line with no line ending is still a line.
    if (pendingBytes > 0) emit(concatenated(pending));
  };
  const readTail = async (stream: ReadableStream<Uint8Array>) => {
    const parts: Uint8Array[] = [];
    let size = 0;
    for await (const part of stream) {
      parts.push(part);
      size += part.byteLength;
      while (size - (parts[0]?.byteLength ?? 0) >= STREAM_STDERR_TAIL_BYTES) {
        size -= parts.shift()?.byteLength ?? 0;
      }
    }
    return new TextDecoder().decode(concatenated(parts));
  };
  let stderr = "";
  let exitCode = -1;
  try {
    [, stderr, exitCode] = await Promise.all([
      readLines(process.stdout),
      readTail(process.stderr),
      process.exited,
    ]);
  } catch (error) {
    terminateCommand(process);
    await process.exited;
    throw error;
  } finally {
    release();
    if (recorder.evidence.onCommandUsage !== undefined) {
      const usage = commandUsage(
        process,
        stage,
        started,
        signal?.aborted === true,
      );
      recordFailure(recorder, () => recorder.evidence.onCommandUsage?.(usage));
    }
    if (recorder.evidence.onCommand !== undefined) {
      const receipt: GraphCommandReceipt = {
        stage,
        argv,
        cwd,
        stdout: `<streamed output omitted; length=${bytes}>`,
        stderr,
        exitCode,
      };
      recordFailure(recorder, () => recorder.evidence.onCommand?.(receipt));
    }
  }
  if (signal?.aborted) {
    throw new DOMException("Graph inspection aborted.", "AbortError");
  }
  return { exitCode, stderr, bytes };
};

const successfulOutput = (
  receipt: GraphCommandReceipt,
  label: string,
): string => {
  if (receipt.exitCode !== 0) {
    const lastLine = receipt.stderr
      .trimEnd()
      .split(/\r?\n/)
      .at(-1)
      ?.slice(-1024);
    throw new Error(
      `${label} exited with ${receipt.exitCode}.${lastLine ? ` ${lastLine}` : ""}`,
    );
  }
  return receipt.stdout;
};

const successfulText = (receipt: GraphCommandReceipt, label: string): string =>
  successfulOutput(receipt, label).trim();

const executableDigest = async (path: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
};

/**
 * Engine files already hashed in this process, by what identifies their bytes: device, inode,
 * size and change time (which any write or mode change moves, and which no caller can set back).
 */
const hashedFiles = new Map<string, string>();
const digestWork = new SharedWork<string>();

const fileIdentity = async (path: string) => {
  const info = await stat(path, { bigint: true });
  return `${path}\0${info.dev}\0${info.ino}\0${info.size}\0${info.ctimeNs}\0${info.mtimeNs}`;
};

/** `executableDigest`, taken once per unchanged file in this process. */
const rememberedDigest = async (path: string): Promise<string> => {
  const before = await fileIdentity(path);
  const known = hashedFiles.get(before);
  if (known !== undefined) return known;
  const result = await digestWork.run({
    scope: "executable-digest",
    key: before,
    run: async () => {
      const known = hashedFiles.get(before);
      if (known !== undefined) return { kind: "succeeded", value: known };
      const digest = await executableDigest(path);
      // A file that changed while it was hashed is not remembered.
      if ((await fileIdentity(path)) === before)
        hashedFiles.set(before, digest);
      return { kind: "succeeded", value: digest };
    },
  });
  if (result.outcome.kind === "failed") throw result.outcome.error;
  return result.outcome.value;
};

/** An engine build's version and capabilities, by its SHA-256, for `reuseIdentity`. */
type ProviderFacts = {
  readonly version: ReturnType<typeof parseVersion>;
  readonly capabilities: ReturnType<typeof parseCapabilities>;
  readonly featureLanguages: ReturnType<typeof parseFeatureLanguages>;
};
const providerFacts = new Map<string, ProviderFacts>();
const providerFactsWork = new SharedWork<ProviderFacts>();

/** The store's Graph folder under a git common directory, shared by every worktree of it. */
const storeGraphCacheIn = async (
  gitCommonDirectory: string,
): Promise<string> => {
  const store = join(gitCommonDirectory, "neuve");
  // The store is owner-only (records-core's STORE_DIRECTORY_MODE), so Graph makes it so when first.
  await mkdir(store, { mode: 0o700 }).catch((error: unknown) => {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
      throw error;
  });
  return join(store, "graph", "cache");
};

/**
 * The default Graph cache, the store's Graph folder (`<git common directory>/neuve/graph/cache`,
 * where the harness keeps its own), never a path inside a working tree.
 */
const defaultCacheDirectory = async (
  repository: string,
  environment: Readonly<Record<string, string | undefined>>,
): Promise<string> => {
  const child = Bun.spawn(
    ["git", "-C", repository, "rev-parse", "--git-common-dir"],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: environment,
    },
  );
  const [stdout, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  const common = stdout.trim();
  if (exitCode !== 0 || common === "")
    throw new Error(
      `Neuve Graph cache unavailable: ${repository} has no git common directory.`,
    );
  return storeGraphCacheIn(
    isAbsolute(common) ? common : resolve(repository, common),
  );
};

/** How old an engine copy's modification time may get before the next check touches it. */
const ENGINE_COPY_TOUCH_MS = 60 * 60_000;

/** Marks the copy used for the store when due; false when there is no copy (evicted, or never made). */
const touchCopy = async (path: string): Promise<boolean> => {
  try {
    const info = await stat(path);
    if (Date.now() - info.mtimeMs >= ENGINE_COPY_TOUCH_MS) {
      const now = new Date();
      await utimes(path, now, now);
    }
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
};

/**
 * The engine's private copy for inspections: `<cacheDirectory>/executables/<sha256>/<name>`,
 * owner-only and read-only, made once per engine build by copying to a temporary name and renaming
 * it into place, so concurrent inspections never see a partial copy. A copy whose bytes no longer
 * match its name is replaced, and a missing one (the store evicts other builds' copies) made again.
 * Returns the copy and the digest of its bytes, taken from the copy itself just before its use.
 * A copy is touched before it is checked once its modification time is `ENGINE_COPY_TOUCH_MS` old:
 * the bounded store keeps a copy used or modified in the last day, and Graph names its service
 * without the modification time. Touching first means the check sees the file as it runs, and
 * with `remember` (`rememberedDigest`) a touch costs one hash of the copy, no more often.
 */
const stableExecutableCopy = async (
  configured: string,
  cacheDirectory: string,
  remember: boolean,
): Promise<Readonly<{ executable: string; sha256: string }>> => {
  const digestOf = remember ? rememberedDigest : executableDigest;
  const sha256 = await digestOf(configured);
  const directory = join(cacheDirectory, "executables", sha256);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Whoever could write these folders could swap the engine between its hash and its run.
  const user = globalThis.process.getuid?.();
  for (const folder of [dirname(directory), directory]) {
    const info = await lstat(folder);
    if (
      !info.isDirectory() ||
      (user !== undefined && info.uid !== user) ||
      (info.mode & 0o077) !== 0
    ) {
      throw new Error(
        `Neuve Graph executable folder ${folder} is not private to this user.`,
      );
    }
  }
  // By its resolved path: the service is keyed by the engine's path, so one folder reached through
  // a symlink and directly must still name one engine (Graph resolves its own path too).
  const executable = join(await realpath(directory), basename(configured));
  const present = (await touchCopy(executable))
    ? await digestOf(executable).catch(() => undefined)
    : undefined;
  if (present === sha256) return { executable, sha256 };
  // A name of its own, so concurrent first copies never write or rename each other's.
  const partial = `${executable}.${randomUUID()}.partial`;
  await copyFile(configured, partial);
  await chmod(partial, 0o500);
  const copied = await executableDigest(partial);
  if (copied !== sha256) {
    await rm(partial, { force: true });
    throw new Error("Neuve Graph executable changed while it was copied.");
  }
  await rename(partial, executable);
  return { executable, sha256 };
};

const preparationFailures = [
  "unsupported-preparation",
  "invalid-target",
  "invalid-expected-generation",
  "source-unavailable",
  "policy-unavailable",
  "artifact-unavailable",
  "generation-mismatch",
  "invalid-generation",
  "preparation-failed",
  "source-changed",
  "incomplete-extraction",
  "publication-unconfirmed",
  "publication-failed",
  "cancelled",
] as const;

export class GraphPreparationError extends Data.TaggedError(
  "GraphPreparationError",
)<{
  readonly reason:
    | (typeof preparationFailures)[number]
    | "input"
    | "unsupported-provider"
    | "command"
    | "invalid-receipt"
    | "observer"
    | "cleanup";
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Preparation and cache declaration are background work no caller waits on, so they take no
 * queue class or service deadline: only an inspection's recorder carries either, so these run in
 * the engine's background class with no deadline whatever object their options come from.
 */
export type GraphPreparationRun = Omit<
  GraphInspectionEvidence,
  "serviceClass" | "serviceDeadlineMs"
> &
  Readonly<{
    signal?: AbortSignal;
    cacheDirectory?: string;
    onGitObservation?: (
      observation: import("./git-read-qualification.ts").GitReadObservation,
    ) => void;
  }>;

const PreparationInput = Schema.Struct({
  executable: Schema.NonEmptyString.check(Schema.isPattern(/^[^\0]+$/)),
  repository: Schema.NonEmptyString.check(Schema.isPattern(/^[^\0]+$/)),
  revision: Schema.String.check(
    Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  ),
  expectedGeneration: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  ),
});

const preparationBoundary = async (
  input: GraphPreparationRequest & Readonly<{ expectedGeneration?: string }>,
  run: GraphPreparationRun,
  signal: AbortSignal,
  operation: "plan" | "prepare",
): Promise<GraphPreparationPlan | GraphGenerationPreparation> => {
  let request: typeof PreparationInput.Type;
  try {
    request = Schema.decodeUnknownSync(PreparationInput, {
      onExcessProperty: "error",
    })(input);
    if (operation === "prepare" && request.expectedGeneration === undefined)
      throw new Error("Expected generation required.");
  } catch (cause) {
    throw new GraphPreparationError({
      reason: "input",
      message:
        "Preparation requires an exact commit and valid generation selection.",
      cause,
    });
  }
  const repository = (await realpath(request.repository)) as RepositoryPath;
  const gitEvidence = {
    signal,
    ...(run.onGitObservation === undefined
      ? {}
      : { onObservation: run.onGitObservation }),
    onCommand: (
      receipt: import("./git-read-qualification.ts").GitReadReceipt,
    ) => {
      const operation = receipt.command;
      const stage: GraphCommandStage =
        operation.kind === "version"
          ? "version"
          : operation.kind === "exact-commit" ||
              operation.kind === "resolve-head"
            ? "git_revision"
            : operation.kind === "exact-tree"
              ? "git_tree"
              : operation.kind === "owner" &&
                  operation.field === "--git-common-dir"
                ? "git_common_directory"
                : "git_scope";
      run.onCommand?.({ ...receipt, stage });
    },
  };
  let qualifiedGit: import("./git-read-qualification.ts").QualifiedGitRead;
  try {
    qualifiedGit = await qualifyLocalGitRead(
      await preflightLocalGitRead({ repository, signal }),
      gitEvidence,
    );
  } catch (cause) {
    throw new GraphPreparationError({
      reason:
        cause instanceof GitReadRefusal && cause.reason === "cancelled"
          ? "cancelled"
          : cause instanceof GitReadRefusal && cause.reason === "observer"
            ? "observer"
            : "source-unavailable",
      message:
        cause instanceof GitReadRefusal
          ? `Local Git preparation qualification refused. ${cause.detail}`
          : "Local Git preparation qualification refused.",
      cause,
    });
  }
  const recorder: Recorder = {
    evidence: run,
    failures: [],
    signal,
    cacheDirectory: resolve(
      run.cacheDirectory ??
        (await storeGraphCacheIn(qualifiedGit.scope.gitCommonDirectory)),
    ),
    preparedOnly: false,
    profile: "syntax-only",
    preparedState: {},
    environment: { ...qualifiedGit.environment },
  };
  const git = async (
    command: import("./git-read-qualification.ts").GitReadCommand,
  ) => gitReadText(await runQualifiedGit(qualifiedGit, command, gitEvidence));
  const revision = fullRevision(
    await git({ kind: "exact-commit", oid: request.revision }),
    "preparation revision",
  );
  if (revision !== request.revision)
    throw new GraphPreparationError({
      reason: "input",
      message: "Preparation revision resolution mismatch.",
    });
  const tree = fullRevision(
    await git({ kind: "exact-tree", oid: revision }),
    "preparation tree",
  );
  const commonDirectory = qualifiedGit.scope.gitCommonDirectory;
  const scope = (await git({ kind: "owner", field: "--show-prefix" })).replace(
    /\/$/,
    "",
  );
  const configured = request.executable.includes("/")
    ? resolve(repository, request.executable)
    : Bun.which(request.executable);
  if (configured === null)
    throw new GraphPreparationError({
      reason: "command",
      message: "Graph preparation executable unavailable.",
    });
  // The build's one copy, not a temporary one: the shared service runs the index in its
  // preparation lane, and is one per executable path.
  const { executable, sha256 } = await stableExecutableCopy(
    configured,
    recorder.cacheDirectory,
    run.reuseIdentity === true,
  );
  const version = parseVersion(
    await graphCommand(
      executable,
      ["version", "--json"],
      repository,
      "version",
      recorder,
      "Graph preparation version",
    ),
  );
  if (version.buildIdentity !== null && version.buildIdentity !== sha256)
    throw new GraphPreparationError({
      reason: "invalid-receipt",
      message: "Graph preparation executable identity mismatch.",
    });
  const capabilities = parseCapabilities(
    await graphCommand(
      executable,
      ["capabilities", "--json"],
      repository,
      "capabilities",
      recorder,
      "Graph preparation capabilities",
    ),
  );
  if (
    capabilities.optionalLocalOnlyFeatures.incremental_preparation_plan !== true
  )
    throw new GraphPreparationError({
      reason: "unsupported-provider",
      message: "Graph provider does not declare incremental preparation plans.",
    });
  if (recorder.failures.length !== 0)
    throw new GraphPreparationError({
      reason: "observer",
      message: "Graph preparation evidence recording failed before dispatch.",
      cause: new AggregateError(recorder.failures),
    });
  await recheckLocalGitRead(qualifiedGit, gitEvidence);
  const receipt = await command(
    [
      executable,
      "index",
      "--repo",
      repository,
      "--incremental",
      "--commit",
      revision,
      "--profile",
      "syntax-only",
      "--format",
      "json",
      "--cache-dir",
      recorder.cacheDirectory,
      ...(operation === "plan" ? ["--plan"] : []),
      ...(request.expectedGeneration === undefined
        ? []
        : ["--expected-generation", request.expectedGeneration]),
    ],
    repository,
    "index",
    recorder,
  );
  if (receipt.exitCode !== 0) {
    const reason =
      preparationFailures.find(
        (value) =>
          receipt.stderr.trim() ===
          `incremental preparation unavailable: ${value}`,
      ) ?? "command";
    throw new GraphPreparationError({
      reason,
      message: `Graph preparation refused (${reason}).`,
    });
  }
  await recheckLocalGitRead(qualifiedGit, gitEvidence);
  let result: GraphPreparationPlan | GraphGenerationPreparation;
  try {
    const parsed = parsePreparation(
      parseJson(receipt.stdout, "Graph preparation"),
      {
        repository,
        revision,
        tree,
        version: version.version,
        qualification: { commonDirectory, scope, producerBuildId: sha256 },
        ...(request.expectedGeneration === undefined
          ? {}
          : { generation: request.expectedGeneration }),
      },
    );
    const common = {
      provider: {
        name: version.provider,
        version: version.version,
        identityRevision: version.identityRevision,
        executable: {
          sha256,
          buildIdentity:
            version.buildIdentity === null
              ? ("unreported" as const)
              : ("verified" as const),
        },
        capabilities,
      },
      source: { repository, revision, tree },
      profile: "syntax-only" as const,
      selection: parsed.selection,
      ...(parsed.service === undefined ? {} : { service: parsed.service }),
    };
    result =
      operation === "plan"
        ? {
            ...common,
            availability: parsePreparationAvailability(parsed.root),
          }
        : {
            ...common,
            ...parsePreparationWork(parsed.root, parsed.selection),
          };
  } catch (cause) {
    throw new GraphPreparationError({
      reason: "invalid-receipt",
      message: "Graph preparation receipt failed qualification.",
      cause,
    });
  }
  if ((await executableDigest(executable)) !== sha256)
    throw new GraphPreparationError({
      reason: "invalid-receipt",
      message: "Frozen Graph preparation executable changed during invocation.",
    });
  if (recorder.failures.length !== 0)
    throw new GraphPreparationError({
      reason: "observer",
      message: "Graph preparation evidence recording failed.",
      cause: new AggregateError(recorder.failures),
    });
  return result;
};

const preparationEffect = (
  request: GraphPreparationRequest & Readonly<{ expectedGeneration?: string }>,
  run: GraphPreparationRun,
  operation: "plan" | "prepare",
) =>
  Effect.tryPromise({
    try: (signal) =>
      preparationBoundary(
        request,
        run,
        run.signal === undefined
          ? signal
          : AbortSignal.any([signal, run.signal]),
        operation,
      ),
    catch: (cause) =>
      cause instanceof GraphPreparationError
        ? cause
        : new GraphPreparationError({
            reason:
              (cause instanceof DOMException && cause.name === "AbortError") ||
              (cause instanceof GitReadRefusal && cause.reason === "cancelled")
                ? "cancelled"
                : cause instanceof GitReadRefusal &&
                    cause.reason === "source-moved"
                  ? "source-changed"
                  : cause instanceof GitReadRefusal &&
                      cause.reason === "observer"
                    ? "observer"
                    : "command",
            message: "Graph preparation did not complete.",
            cause,
          }),
  });

export const planGraphPreparation = (
  request: GraphPreparationRequest & Readonly<{ expectedGeneration?: string }>,
  run: GraphPreparationRun = {},
) =>
  preparationEffect(request, run, "plan").pipe(
    Effect.flatMap((value) =>
      "availability" in value
        ? Effect.succeed(value)
        : Effect.fail(
            new GraphPreparationError({
              reason: "invalid-receipt",
              message: "Graph plan omitted availability.",
            }),
          ),
    ),
  );

export const prepareGraphGeneration = (
  request: GraphPreparationRequest & Readonly<{ expectedGeneration: string }>,
  run: GraphPreparationRun = {},
) =>
  preparationEffect(request, run, "prepare").pipe(
    Effect.flatMap((value) =>
      "work" in value
        ? Effect.succeed(value)
        : Effect.fail(
            new GraphPreparationError({
              reason: "invalid-receipt",
              message: "Graph preparation omitted work.",
            }),
          ),
    ),
  );

type FrozenExecutable = Readonly<{
  executable: string;
  provider: GraphProviderObservation;
  /** `feature_languages`, outside the published provider. */
  featureLanguages: Readonly<Record<string, readonly string[]>>;
  digest: () => Promise<string>;
}>;

/**
 * Copies the executable and observes its provider through the copy: into `place.temporary`, or,
 * for a command the shared Graph service may run (`place.stable`, a cache folder), its one private
 * copy for the build (`stableExecutableCopy`), since the service is one per executable path.
 */
const freezeExecutable = async (
  configuredPath: string,
  cwd: string,
  place: Readonly<
    { temporary: string } | { stable: string; remember: boolean }
  >,
  recorder: Recorder,
  reuseIdentity = false,
): Promise<FrozenExecutable> => {
  const configured = configuredPath.includes("/")
    ? resolve(cwd, configuredPath)
    : Bun.which(configuredPath);
  if (configured === null)
    throw new GraphPreparationError({
      reason: "command",
      message: "Graph executable unavailable.",
    });
  let executable: string;
  let sha256: string;
  if ("stable" in place)
    ({ executable, sha256 } = await stableExecutableCopy(
      configured,
      place.stable,
      place.remember,
    ));
  else {
    executable = join(place.temporary, basename(configured));
    await copyFile(configured, executable);
    await chmod(executable, 0o500);
    sha256 = await executableDigest(executable);
  }
  return qualifyExecutable(
    { executable, sha256 },
    cwd,
    recorder,
    reuseIdentity,
  );
};

/** Qualifies an already verified copy without repeating executable I/O. */
const qualifyExecutable = async (
  { executable, sha256 }: Readonly<{ executable: string; sha256: string }>,
  cwd: string,
  recorder: Recorder,
  reuseIdentity: boolean,
): Promise<FrozenExecutable> => {
  const knownProvider = reuseIdentity ? providerFacts.get(sha256) : undefined;
  const version =
    knownProvider?.version ??
    parseVersion(
      await graphCommand(
        executable,
        ["version", "--json"],
        cwd,
        "version",
        recorder,
        "Graph version",
      ),
    );
  if (version.buildIdentity !== null && version.buildIdentity !== sha256)
    throw new GraphPreparationError({
      reason: "invalid-receipt",
      message: "Graph executable identity mismatch.",
    });
  const declared =
    knownProvider === undefined
      ? await graphCommand(
          executable,
          ["capabilities", "--json"],
          cwd,
          "capabilities",
          recorder,
          "Graph capabilities",
        )
      : undefined;
  const capabilities =
    knownProvider?.capabilities ?? parseCapabilities(declared);
  const featureLanguages =
    knownProvider?.featureLanguages ?? parseFeatureLanguages(declared);
  if (reuseIdentity)
    providerFacts.set(sha256, { version, capabilities, featureLanguages });
  return {
    executable,
    featureLanguages,
    provider: {
      name: version.provider,
      version: version.version,
      identityRevision: version.identityRevision,
      executable: {
        sha256,
        buildIdentity:
          version.buildIdentity === null ? "unreported" : "verified",
      },
      capabilities,
    },
    digest: () => executableDigest(executable),
  };
};

const boundaryError = (cause: unknown, message: string) =>
  cause instanceof GraphPreparationError
    ? cause
    : new GraphPreparationError({
        reason:
          cause instanceof DOMException && cause.name === "AbortError"
            ? "cancelled"
            : "command",
        message,
        cause,
      });

/** Reads file structure through the same frozen engine and process controls as inspections. */
export const readGraphSymbols = async (
  input: GraphSymbolsInput,
  evidence: GraphInspectionEvidence = {},
): Promise<GraphSymbolsObservation> => {
  validateSymbolPaths(input.files);
  const deadlineMs = input.deadlineMs ?? 120_000;
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0)
    throw new GraphSymbolsError({
      reason: "input",
      message: "Invalid symbols deadline.",
    });
  const deadline = AbortSignal.timeout(deadlineMs);
  const signal = AbortSignal.any([
    deadline,
    ...(input.signal ? [input.signal] : []),
  ]);
  let temporaryRoot: string | undefined;
  try {
    signal.throwIfAborted();
    const configured = input.executable.includes("/")
      ? resolve(input.executable)
      : Bun.which(input.executable);
    if (configured === null || !(await Bun.file(configured).exists()))
      throw new GraphSymbolsError({
        reason: "executable-unavailable",
        message: "Graph executable unavailable.",
      });
    temporaryRoot = await mkdtemp(
      join(resolve(input.temporaryParent), "neuve-graph-symbols-engine-"),
    );
    const recorder: Recorder = {
      evidence: {
        ...evidence,
        // Each batch consumes one of the caller's existing CPU permits.
        cpuThreads: 1,
        niceness: evidence.niceness ?? 10,
        service: "off",
      },
      failures: [],
      signal,
      cacheDirectory: temporaryRoot,
      preparedOnly: false,
      profile: "syntax-only",
      preparedState: {},
      environment: {
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
    };
    // Executable I/O belongs to preparation, outside the caller's CPU grant and inside its claim.
    const copy = await stableExecutableCopy(
      configured,
      resolve(
        input.cacheDirectory ?? join(budgetDirectory(), "graph", "cache"),
      ),
      false,
    );
    signal.throwIfAborted();
    const execute = input.execute ?? ((run) => run(input.concurrency ?? 1));
    const { frozen, result } = await execute(async (concurrency) => {
      signal.throwIfAborted();
      const frozen = await qualifyExecutable(
        copy,
        process.cwd(),
        recorder,
        true,
      );
      const result = await readSymbolBatches(
        { ...input, signal, concurrency },
        {
          provider: frozen.provider,
          featureLanguages: frozen.featureLanguages,
          init: async (repo, batchSignal) => {
            successfulText(
              await command(
                ["git", "init", "--quiet", repo],
                repo,
                "symbols_init",
                { ...recorder, signal: batchSignal },
              ),
              "Symbols repository initialization",
            );
          },
          run: async (repo, outlines, batchSignal, tokens) =>
            successfulOutput(
              await command(
                [
                  frozen.executable,
                  "symbols",
                  "--repo",
                  repo,
                  "--worktree",
                  "--format",
                  "ndjson",
                  "--profile",
                  "syntax-only",
                  ...(outlines ? ["--outline"] : []),
                  ...(tokens ? ["--tokens"] : []),
                ],
                repo,
                "symbols",
                { ...recorder, signal: batchSignal },
                { maxOutputBytes: 64 * 1024 * 1024 },
              ),
              "Graph symbols",
            ),
        },
      );
      return { frozen, result };
    }, signal);
    if ((await frozen.digest()) !== frozen.provider.executable.sha256)
      throw new GraphSymbolsError({
        reason: "invalid-output",
        message: "Graph executable changed during symbols read.",
      });
    if (recorder.failures.length)
      throw new AggregateError(
        recorder.failures,
        "Symbols evidence recording failed.",
      );
    return result;
  } catch (cause) {
    if (input.signal?.aborted)
      throw new GraphSymbolsError({
        reason: "cancelled",
        message: "Graph symbols cancelled.",
        cause,
      });
    if (deadline.aborted)
      throw new GraphSymbolsError({
        reason: "deadline",
        message: "Graph symbols deadline exceeded.",
        cause,
      });
    if (cause instanceof GraphSymbolsError) throw cause;
    throw new GraphSymbolsError({
      reason:
        cause instanceof GraphPreparationError &&
        cause.reason === "invalid-receipt"
          ? "invalid-output"
          : "command",
      message: "Graph symbols did not complete.",
      cause,
    });
  } finally {
    if (temporaryRoot !== undefined)
      await rm(temporaryRoot, { recursive: true, force: true });
  }
};

/** How long one snapshot read may run when the caller sets no deadline. The engine has no bound. */
export const GRAPH_SNAPSHOT_DEADLINE_MS = 300_000;

export type GraphSnapshotRequest = Readonly<{
  /** The repository; the engine reads the commit's tree from its object store, never a checkout. */
  repository: string;
  /** The exact commit, a full lowercase object name. */
  revision: FullRevision | string;
  profile: "full";
  executable: string;
  signal?: AbortSignal;
  /** Defaults to `GRAPH_SNAPSHOT_DEADLINE_MS`. */
  deadlineMs?: number;
  /** The engine copy's store; defaults to graph/cache under the budget directory, as symbols reads. */
  cacheDirectory?: string;
  /** Spawn, command and usage hooks and the priority, as the other readers take them. */
  evidence?: Omit<
    GraphInspectionEvidence,
    "service" | "serviceClass" | "serviceDeadlineMs" | "reuseIdentity"
  >;
}>;

/**
 * Reads the whole graph of one commit: `snapshot --repo <repository> --commit <revision> --format
 * compact-ndjson --profile full --no-cache`, through a frozen copy of the engine qualified as every
 * other read is, in its own process group and the fixed engine environment. The engine's own
 * records cache is off: its key does not hold the engine's build, and the caller keys what it keeps
 * by that build.
 *
 * Records reach `sink` as they are read, so the caller keeps only what it needs; stdout is never
 * held whole. The promise resolves with the coverage only once the summary validated and the
 * engine exited 0. If it rejects, records may already have been delivered: the caller must discard
 * everything it gathered from them. A refusal is a `GraphSnapshotError`; its `reason` says whether
 * the engine is missing or lacks the exact-commit capability (`executable-unavailable`,
 * `unsupported-provider`), the stream was cut off (`incomplete`) or wrong (`invalid-output`), the
 * engine failed (`command`), or the read was stopped (`cancelled`, `deadline`).
 */
export const readGraphSnapshot = async (
  request: GraphSnapshotRequest,
  sink: GraphSnapshotSink,
): Promise<GraphSnapshotCoverage> => {
  const deadlineMs = request.deadlineMs ?? GRAPH_SNAPSHOT_DEADLINE_MS;
  if (
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(request.revision) ||
    request.profile !== "full" ||
    !Number.isFinite(deadlineMs) ||
    deadlineMs <= 0 ||
    request.repository.trim() === "" ||
    request.repository.includes("\0") ||
    request.executable.trim() === "" ||
    request.executable.includes("\0")
  )
    throw new GraphSnapshotError({
      reason: "input",
      message:
        "A snapshot read needs an exact lowercase commit, the full profile, a repository, an executable and a positive deadline.",
    });
  const deadline = AbortSignal.timeout(deadlineMs);
  const signal = AbortSignal.any([
    deadline,
    ...(request.signal ? [request.signal] : []),
  ]);
  try {
    signal.throwIfAborted();
    const configured = request.executable.includes("/")
      ? resolve(request.executable)
      : Bun.which(request.executable);
    if (configured === null || !(await Bun.file(configured).exists()))
      throw new GraphSnapshotError({
        reason: "executable-unavailable",
        message: "Graph executable unavailable.",
      });
    let repository: string;
    try {
      repository = await realpath(request.repository);
    } catch (cause) {
      throw new GraphSnapshotError({
        reason: "input",
        message: "Snapshot repository unavailable.",
        cause,
      });
    }
    const evidence = request.evidence ?? {};
    const recorder: Recorder = {
      evidence: {
        ...evidence,
        niceness: evidence.niceness ?? 10,
        // Bulk streams always run in the engine's own process.
        service: "off",
      },
      failures: [],
      signal,
      cacheDirectory: resolve(
        request.cacheDirectory ?? join(budgetDirectory(), "graph", "cache"),
      ),
      preparedOnly: false,
      profile: "full",
      preparedState: {},
    };
    const copy = await stableExecutableCopy(
      configured,
      recorder.cacheDirectory,
      true,
    );
    signal.throwIfAborted();
    const frozen = await qualifyExecutable(copy, repository, recorder, true);
    const features = frozen.provider.capabilities.optionalLocalOnlyFeatures;
    if (
      features[GRAPH_EXACT_COMMIT_STREAMS] !== true ||
      features[GRAPH_COMPACT_SNAPSHOT] !== true
    )
      throw new GraphSnapshotError({
        reason: "unsupported-provider",
        message:
          "Graph provider does not declare exact-commit compact snapshots.",
      });
    const decoder = new CompactSnapshotDecoder(
      {
        provider: frozen.provider,
        revision: request.revision,
        profile: "full",
        repository,
        importTargetLanguages:
          features[GRAPH_IMPORT_TARGETS] === true
            ? (frozen.featureLanguages[GRAPH_IMPORT_TARGETS] ?? [])
            : null,
        // From the frozen copy that writes this snapshot, as the import targets are: never a
        // separate capabilities read.
        callSiteLineLanguages:
          features[GRAPH_CALL_SITE_LINES] === true
            ? (frozen.featureLanguages[GRAPH_CALL_SITE_LINES] ?? [])
            : null,
      },
      sink,
    );
    const receipt = await streamCommand(
      [
        frozen.executable,
        "snapshot",
        "--repo",
        repository,
        "--commit",
        request.revision,
        "--format",
        "compact-ndjson",
        "--profile",
        "full",
        "--no-cache",
      ],
      repository,
      "snapshot",
      recorder,
      (line) => decoder.line(line),
    );
    if (receipt.exitCode !== 0) {
      const last = receipt.stderr.trimEnd().split(/\r?\n/).at(-1)?.slice(-1024);
      throw new GraphSnapshotError({
        reason: "command",
        message: `Graph snapshot exited with ${receipt.exitCode}.${last ? ` ${last}` : ""}`,
      });
    }
    const coverage = decoder.finish();
    if ((await frozen.digest()) !== frozen.provider.executable.sha256)
      throw new GraphSnapshotError({
        reason: "invalid-output",
        message: "Graph executable changed during the snapshot read.",
      });
    if (recorder.failures.length)
      throw new AggregateError(
        recorder.failures,
        "Snapshot evidence recording failed.",
      );
    return coverage;
  } catch (cause) {
    if (request.signal?.aborted)
      throw new GraphSnapshotError({
        reason: "cancelled",
        message: "Graph snapshot read cancelled.",
        cause,
      });
    if (deadline.aborted)
      throw new GraphSnapshotError({
        reason: "deadline",
        message: "Graph snapshot read deadline exceeded.",
        cause,
      });
    if (cause instanceof GraphSnapshotError) throw cause;
    throw new GraphSnapshotError({
      reason:
        cause instanceof GraphPreparationError &&
        cause.reason === "invalid-receipt"
          ? "invalid-output"
          : "command",
      message: "Graph snapshot read did not complete.",
      cause,
    });
  }
};

/**
 * Observes an executable's provider identity (version, identity revision, executable SHA-256
 * checked against any reported build identity, capabilities) through a frozen copy, without
 * reading any repository.
 */
export const observeGraphProvider = (
  input: Readonly<{ executable: string }>,
  run: Omit<GraphInspectionEvidence, "serviceClass" | "serviceDeadlineMs"> = {},
) =>
  Effect.tryPromise({
    try: async (signal): Promise<GraphProviderObservation> => {
      const temporaryRoot = await mkdtemp(
        join(resolve(run.temporaryParent ?? tmpdir()), "neuve-graph-provider-"),
      );
      try {
        const recorder: Recorder = {
          evidence: run,
          failures: [],
          signal,
          cacheDirectory: temporaryRoot,
          preparedOnly: false,
          profile: "full",
          preparedState: {},
        };
        const frozen = await freezeExecutable(
          input.executable,
          process.cwd(),
          { temporary: temporaryRoot },
          recorder,
          run.reuseIdentity === true,
        );
        if (recorder.failures.length !== 0)
          throw new GraphPreparationError({
            reason: "observer",
            message: "Graph provider evidence recording failed.",
            cause: new AggregateError(recorder.failures),
          });
        return frozen.provider;
      } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    },
    catch: (cause) =>
      boundaryError(cause, "Graph provider observation did not complete."),
  });

/**
 * Prepares a complete full-profile committed-tree snapshot of `revision` in `cacheDirectory`, so
 * `cache: "prepared"` inspections with `profile: "full"` can read that commit exactly. The engine
 * indexes HEAD, so the repository's HEAD must already resolve to `revision`; otherwise the request
 * is refused. The index receipt's provenance (repository, commit, tree), provider, version, profile
 * and cache state are validated, and the frozen executable must be unchanged afterwards.
 */
export const prepareGraphSnapshot = (
  request: GraphPreparationRequest,
  run: GraphPreparationRun = {},
) =>
  Effect.tryPromise({
    try: async (signal): Promise<GraphSnapshotPreparation> => {
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(request.revision))
        throw new GraphPreparationError({
          reason: "input",
          message:
            "Snapshot preparation requires an exact lowercase commit OID.",
        });
      const repository = resolve(request.repository) as RepositoryPath;
      const gitPolicy = await prepareLocalGitRead(repository);
      const recorder: Recorder = {
        gitPolicy,
        environment: gitPolicy.environment,
        evidence: run,
        failures: [],
        signal,
        cacheDirectory: resolve(
          run.cacheDirectory ??
            (await defaultCacheDirectory(repository, process.env)),
        ),
        preparedOnly: false,
        profile: "full",
        preparedState: {},
      };
      const git = async (
        args: readonly string[],
        stage: GraphCommandStage,
        label: string,
      ) =>
        successfulText(
          await command(
            ["git", "-C", repository, ...args],
            repository,
            stage,
            recorder,
          ),
          label,
        );
      const revision = fullRevision(
        await git(
          ["rev-parse", "--verify", `${request.revision}^{commit}`],
          "git_revision",
          "Git revision resolution",
        ),
        "snapshot revision",
      );
      const head = fullRevision(
        await git(
          ["rev-parse", "--verify", "HEAD^{commit}"],
          "git_revision",
          "Git HEAD resolution",
        ),
        "snapshot HEAD",
      );
      if (revision !== request.revision || head !== revision)
        throw new GraphPreparationError({
          reason: "invalid-target",
          message:
            "Snapshot preparation requires HEAD to be the requested commit.",
        });
      const tree = fullRevision(
        await git(
          ["rev-parse", "--verify", `${revision}^{tree}`],
          "git_tree",
          "Git tree resolution",
        ),
        "snapshot tree",
      );
      // The build's one copy, not a temporary one: the shared service runs the index in its
      // preparation lane, and is one per executable path.
      const frozen = await freezeExecutable(
        request.executable,
        repository,
        {
          stable: recorder.cacheDirectory,
          remember: run.reuseIdentity === true,
        },
        recorder,
      );
      if (
        !(frozen.provider.capabilities.relationSupportByProfile["full"] ?? [])
          .length
      )
        throw new GraphPreparationError({
          reason: "unsupported-provider",
          message: "Graph provider does not declare a full profile.",
        });
      const receipt = await graphCommand(
        frozen.executable,
        [
          "index",
          "--repo",
          repository,
          "--head",
          "--profile",
          "full",
          "--format",
          "json",
        ],
        repository,
        "index",
        recorder,
        "Graph snapshot preparation",
      );
      let parsed: ReturnType<typeof parseSnapshotPreparation>;
      try {
        parsed = parseSnapshotPreparation(
          receipt,
          repository,
          revision,
          tree,
          frozen.provider.version,
        );
      } catch (cause) {
        throw new GraphPreparationError({
          reason: "invalid-receipt",
          message: "Graph snapshot receipt failed qualification.",
          cause,
        });
      }
      const after = fullRevision(
        await git(
          ["rev-parse", "--verify", "HEAD^{commit}"],
          "git_revision",
          "Git HEAD resolution",
        ),
        "snapshot HEAD after preparation",
      );
      if (after !== revision)
        throw new GraphPreparationError({
          reason: "source-changed",
          message: "HEAD moved during snapshot preparation.",
        });
      if ((await frozen.digest()) !== frozen.provider.executable.sha256)
        throw new GraphPreparationError({
          reason: "invalid-receipt",
          message: "Frozen Graph executable changed during preparation.",
        });
      if (recorder.failures.length !== 0)
        throw new GraphPreparationError({
          reason: "observer",
          message: "Graph snapshot evidence recording failed.",
          cause: new AggregateError(recorder.failures),
        });
      return {
        provider: frozen.provider,
        source: { repository, revision, tree },
        profile: "full",
        cache: parsed.cache,
        ...(parsed.store === undefined ? {} : { store: parsed.store }),
        ...(parsed.service === undefined ? {} : { service: parsed.service }),
        counts: parsed.counts,
      };
    },
    catch: (cause) =>
      boundaryError(cause, "Graph snapshot preparation did not complete."),
  });

/**
 * Replaces the bounded Graph store's declared bases for its cache folder with `commits` (an empty
 * list declares none): the store never evicts what was prepared at them, or at another commit of
 * the same tree, whatever their last use. Each call names the complete set. It runs the engine's
 * one copy for its build, so the store counts that copy as used.
 */
export const declareGraphCache = (
  request: Readonly<{
    executable: string;
    repository: string;
    commits: readonly string[];
  }>,
  run: GraphPreparationRun = {},
) =>
  Effect.tryPromise({
    try: async (signal): Promise<GraphCacheDeclaration> => {
      if (
        !request.commits.every((commit) =>
          /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit),
        )
      )
        throw new GraphPreparationError({
          reason: "input",
          message: "Cache declaration requires exact lowercase commit OIDs.",
        });
      const repository = resolve(request.repository);
      const recorder: Recorder = {
        evidence: run,
        failures: [],
        signal,
        cacheDirectory: resolve(
          run.cacheDirectory ??
            (await defaultCacheDirectory(repository, process.env)),
        ),
        preparedOnly: false,
        profile: "full",
        preparedState: {},
      };
      const configured = request.executable.includes("/")
        ? resolve(repository, request.executable)
        : Bun.which(request.executable);
      if (configured === null)
        throw new Error("Neuve Graph executable could not be resolved.");
      const { executable } = await stableExecutableCopy(
        configured,
        recorder.cacheDirectory,
        run.reuseIdentity === true,
      );
      const commits = [...new Set(request.commits)];
      const receipt = await command(
        [
          executable,
          "cache",
          "declare",
          "--cache-dir",
          recorder.cacheDirectory,
          "--repo",
          repository,
          ...commits.flatMap((commit) => ["--commit", commit]),
          "--format",
          "json",
        ],
        repository,
        "cache_declare",
        recorder,
      );
      if (recorder.failures.length !== 0)
        throw new GraphPreparationError({
          reason: "observer",
          message: "Graph cache declaration evidence recording failed.",
          cause: new AggregateError(recorder.failures),
        });
      const label = "Neuve Graph cache declaration";
      try {
        return parseCacheDeclaration(
          parseJson(successfulText(receipt, label), label),
          commits,
        );
      } catch (cause) {
        throw new GraphPreparationError({
          reason: "invalid-receipt",
          message: "Graph cache declaration receipt failed qualification.",
          cause,
        });
      }
    },
    catch: (cause) =>
      boundaryError(cause, "Graph cache declaration did not complete."),
  });

const positiveInteger = (value: number, label: string): void => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
};

const validateRequest = (request: GraphInspectionRequest): void => {
  if (
    request.profile !== undefined &&
    request.profile !== "full" &&
    request.profile !== "syntax-only"
  )
    throw new Error("profile must be full or syntax-only.");
  if (request.profile === "syntax-only" && request.cache !== "prepared")
    throw new Error("syntax-only requires exact prepared reads.");
  if (
    request.cache === "prepared" &&
    !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(request.revision)
  )
    throw new Error("Prepared reads require an exact full commit OID.");
  if (
    request.cache !== undefined &&
    request.cache !== "reuse" &&
    request.cache !== "refresh" &&
    request.cache !== "prepared"
  ) {
    throw new Error("cache must be reuse, refresh or prepared.");
  }
  for (const [label, value] of [
    ["executable", request.executable],
    ["repository", request.repository],
    ["revision", request.revision],
    ["question", request.question],
  ] as const) {
    if (value.trim().length === 0 || value.includes("\0")) {
      throw new Error(`${label} must be non-empty and contain no NUL byte.`);
    }
  }
  positiveInteger(request.limits.topK, "limits.topK");
  positiveInteger(request.limits.maxContextBytes, "limits.maxContextBytes");
  const ids = new Set<string>();
  for (const relationship of request.relationships) {
    if (relationship.id.trim().length === 0 || ids.has(relationship.id)) {
      throw new Error(
        `relationship id ${JSON.stringify(relationship.id)} must be non-empty and unique.`,
      );
    }
    ids.add(relationship.id);
    if (relationship.focus.name.trim().length === 0) {
      throw new Error(
        `relationship ${relationship.id} focus.name must be non-empty.`,
      );
    }
    if (
      relationship.focus.path !== undefined &&
      (relationship.focus.path.startsWith("/") ||
        relationship.focus.path.includes("\\") ||
        relationship.focus.path.includes("\0") ||
        relationship.focus.path
          .split("/")
          .some((part) => part.length === 0 || part === "." || part === ".."))
    ) {
      throw new Error(
        `relationship ${relationship.id} focus.path must be repository-relative.`,
      );
    }
    if (relationship.focus.line !== undefined) {
      if (relationship.focus.path === undefined) {
        throw new Error(
          `relationship ${relationship.id} focus.line requires focus.path.`,
        );
      }
      positiveInteger(
        relationship.focus.line,
        `relationship ${relationship.id} focus.line`,
      );
    }
    for (const [label, value] of [
      ["symbolKind", relationship.focus.symbolKind],
      ["qualifiedName", relationship.focus.qualifiedName],
    ] as const) {
      if (value !== undefined && value.trim().length === 0) {
        throw new Error(
          `relationship ${relationship.id} focus.${label} must be non-empty when present.`,
        );
      }
    }
    if (
      (relationship.focus.symbolKind === undefined) !==
      (relationship.focus.qualifiedName === undefined)
    ) {
      throw new Error(
        `relationship ${relationship.id} focus.symbolKind and focus.qualifiedName must appear together.`,
      );
    }
    if (relationship.relation.trim().length === 0) {
      throw new Error(
        `relationship ${relationship.id} relation must be non-empty.`,
      );
    }
    if (
      relationship.selection !== "exact" &&
      relationship.selection !== "family"
    ) {
      throw new Error(
        `relationship ${relationship.id} selection must be exact or family.`,
      );
    }
    const requestedSummary: unknown = relationship.summary;
    if (requestedSummary !== undefined && requestedSummary !== "frontier") {
      throw new Error(
        `relationship ${relationship.id} summary must be frontier when present.`,
      );
    }
    positiveInteger(
      relationship.limit,
      `relationship ${relationship.id} limit`,
    );
  }
};

/** The engine's exit when the caller's deadline passed while it waited for the shared service. */
const EXIT_SERVICE_DEADLINE = 75;

/** A read whose caller's deadline passed while it waited for the shared service; it runs on there. */
class ServiceDeadlineError extends Error {
  constructor() {
    super(
      "The Graph service did not answer within the caller's deadline; it keeps working on the read.",
    );
    this.name = "ServiceDeadlineError";
  }
}

class PreparedReadError extends Error {
  constructor(readonly reason: GraphPreparedFailureReason) {
    super(`Prepared snapshot unavailable (${reason}).`);
    this.name = "PreparedReadError";
  }
}

const preparedFailureReasons = [
  "incompatible-read-options",
  "source-unavailable",
  "policy-unavailable",
  "artifact-unavailable",
  "missing",
  "invalid-artifact",
  "incompatible-artifact",
  "revision-not-prepared",
  "source-changed-during-read",
] as const satisfies readonly GraphPreparedFailureReason[];

const requirePreparedSupport = (
  recorder: Recorder,
  capabilities: GraphCapabilities,
): void => {
  if (
    recorder.preparedOnly &&
    (capabilities.optionalLocalOnlyFeatures.prepared_snapshot_query !== true ||
      capabilities.optionalLocalOnlyFeatures.exact_commit_prepared_read !==
        true)
  )
    throw new PreparedReadError("unsupported-provider");
};

const confirmPreparedRead = (
  recorder: Recorder,
  cache: GraphCacheObservation,
  receipt?: GraphPreparedRead,
): void => {
  if (
    recorder.preparedOnly &&
    (cache.analysisScope !== "complete-prepared" || cache.status !== "hit")
  )
    throw new PreparedReadError("unconfirmed-prepared-read");
  if (recorder.preparedOnly) {
    if (receipt === undefined)
      throw new PreparedReadError("unconfirmed-prepared-read");
    const previous = recorder.preparedState.observed;
    if (previous !== undefined && !isDeepStrictEqual(previous, receipt))
      throw new PreparedReadError("incompatible-artifact");
    recorder.preparedState.observed = receipt;
  }
};

const graphCommand = async (
  executable: string,
  args: readonly string[],
  cwd: string,
  stage: GraphCommandStage,
  recorder: Recorder,
  label: string,
): Promise<unknown> => {
  if (recorder.preparedOnly && args[0] === "index")
    throw new PreparedReadError("incompatible-read-options");
  const receipt = await command(
    [
      executable,
      ...args,
      ...(["index", "query", "neighbors"].includes(args[0] ?? "")
        ? ["--cache-dir", recorder.cacheDirectory]
        : []),
      ...(recorder.preparedOnly &&
      ["query", "neighbors"].includes(args[0] ?? "")
        ? ["--prepared-only"]
        : []),
    ],
    cwd,
    stage,
    recorder,
  );
  // By the exit code alone: the engine prints nothing on stdout and one line on stderr.
  if (
    receipt.exitCode === EXIT_SERVICE_DEADLINE &&
    ["query", "search", "neighbors"].includes(args[0] ?? "")
  )
    throw new ServiceDeadlineError();
  if (recorder.preparedOnly && receipt.exitCode !== 0) {
    const reason = preparedFailureReasons.find(
      (value) =>
        receipt.stderr.trim() === `prepared snapshot unavailable: ${value}`,
    );
    if (reason !== undefined) throw new PreparedReadError(reason);
  }
  return parseJson(successfulText(receipt, label), label);
};

const neighborArgs = (
  view: string,
  request: GraphRelationshipRequest,
  symbol: string,
  includeSelector: boolean,
  includeSummary: boolean,
  profile: GraphProfile,
  revision: FullRevision,
  prepared: boolean,
): readonly string[] => [
  "neighbors",
  "--repo",
  view,
  ...(prepared ? ["--commit", revision] : ["--head"]),
  "--profile",
  profile,
  "--format",
  "json",
  "--symbol",
  symbol,
  ...(includeSelector && request.focus.path !== undefined
    ? ["--file", request.focus.path]
    : []),
  ...(includeSelector && request.focus.line !== undefined
    ? ["--line", String(request.focus.line)]
    : []),
  ...(includeSelector && request.focus.symbolKind !== undefined
    ? ["--kind", request.focus.symbolKind]
    : []),
  "--relation",
  request.relation,
  "--selection",
  request.selection,
  "--direction",
  request.direction,
  "--depth",
  "1",
  "--limit",
  String(request.limit),
  ...(includeSummary ? ["--summary", "frontier"] : []),
];

const locationPath = (location: GraphLocation): SourcePath | undefined =>
  location.kind === "absent" ? undefined : location.path;

const locationContainsLine = (
  location: GraphLocation,
  line: number,
): boolean =>
  location.kind === "point"
    ? location.line === line
    : location.kind === "range"
      ? location.startLine <= line && line <= location.endLine
      : false;

const matchesSelector = (
  relationship: GraphRelationshipRequest,
  match: ReturnType<typeof parseNeighbors>["matches"][number],
): boolean =>
  match.symbol.name === relationship.focus.name &&
  (relationship.focus.path === undefined ||
    locationPath(match.symbol.location) === relationship.focus.path) &&
  (relationship.focus.line === undefined ||
    locationContainsLine(match.symbol.location, relationship.focus.line)) &&
  (relationship.focus.symbolKind === undefined ||
    match.symbol.symbolKind === relationship.focus.symbolKind) &&
  (relationship.focus.qualifiedName === undefined ||
    match.symbol.qualifiedName === relationship.focus.qualifiedName);

const unique = <Value>(values: readonly Value[]): readonly Value[] => {
  const seen = new Set<string>();
  return values.filter((value) => {
    const identity = JSON.stringify(value);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
};

const languageLimitations = (
  capabilities: GraphCapabilities,
  language: string | undefined | null,
  subject: GraphCapabilityLimitation["subject"],
  relation?: string,
): readonly GraphCapabilityLimitation[] => {
  if (language === undefined || language === null) {
    return [{ kind: "unclassified_language", subject }];
  }
  if (!capabilities.supportedLanguages.includes(language)) {
    return [{ kind: "undeclared_language", subject, language }];
  }
  if (subject === "query_result") return [];
  const limitations: GraphCapabilityLimitation[] = [];
  if (!capabilities.semanticLanguages.includes(language)) {
    limitations.push({ kind: "non_semantic_language", subject, language });
  }
  if (
    relation !== undefined &&
    !(capabilities.relationSupportByLanguage[language] ?? []).includes(relation)
  ) {
    limitations.push({
      kind: "unsupported_relation_for_language",
      subject,
      language,
      relation,
    });
  }
  return limitations;
};

type Qualifier = Readonly<{
  location: (
    location: GraphLocation,
    label: string,
    owner: "query" | `relationship:${string}`,
  ) => Promise<void>;
  /**
   * Qualifies a query result range. A range ending exactly one line past the file's last line is
   * returned clamped, with that file's line count; anything else out of range is refused.
   */
  resultRange: (
    location: SourceRange,
    label: string,
  ) => Promise<Readonly<{ endLine: number }> | undefined>;
}>;

const lineCount = (source: Uint8Array): number => {
  if (source.byteLength === 0) return 0;
  let lines = 0;
  for (const byte of source) if (byte === 0x0a) lines += 1;
  return lines + (source.at(-1) === 0x0a ? 0 : 1);
};

const createQualifier = (
  repository: string,
  revision: FullRevision,
  cwd: string,
  recorder: Recorder,
): Qualifier => {
  const cache = new Map<SourcePath, Promise<Readonly<{ lines: number }>>>();
  const metadata = (
    path: SourcePath,
    owner: "query" | `relationship:${string}`,
  ): Promise<Readonly<{ lines: number }>> => {
    const existing = cache.get(path);
    if (existing !== undefined) return existing;
    const pending = (async () => {
      const listing = await command(
        [
          "git",
          "--literal-pathspecs",
          "-C",
          repository,
          "ls-tree",
          "-z",
          revision,
          "--",
          path,
        ],
        cwd,
        `${owner}:source:${path}:metadata`,
        recorder,
      );
      successfulOutput(listing, `Git source metadata ${path}`);
      const records = listing.stdout.split("\0");
      if (records.length !== 2 || records[1] !== "") {
        throw new Error(`${path} did not resolve to exactly one Git object.`);
      }
      const record = records[0] ?? "";
      const separator = record.indexOf("\t");
      const [mode, type, oid] = record.slice(0, separator).split(" ");
      const observedPath =
        separator < 0 ? undefined : record.slice(separator + 1);
      if (
        (mode !== "100644" && mode !== "100755") ||
        type !== "blob" ||
        oid === undefined ||
        observedPath !== path
      ) {
        throw new Error(`${path} is not a regular source blob at ${revision}.`);
      }
      const content = await command(
        ["git", "-C", repository, "cat-file", "blob", oid],
        cwd,
        `${owner}:source:${path}:content`,
        recorder,
        { omitRecordedStdout: true },
      );
      successfulOutput(content, `Git source content ${path}`);
      return { lines: lineCount(content.stdoutBytes) };
    })();
    cache.set(path, pending);
    return pending;
  };
  return {
    location: async (location, label, owner) => {
      if (location.kind === "absent") return;
      const blob = await metadata(location.path, owner);
      const lastLine =
        location.kind === "path"
          ? undefined
          : location.kind === "point"
            ? location.line
            : location.endLine;
      if (lastLine !== undefined && lastLine > blob.lines) {
        throw new Error(
          `${label} line ${lastLine} exceeds ${location.path}'s ${blob.lines} lines at ${revision}.`,
        );
      }
    },
    resultRange: async (location, label) => {
      const blob = await metadata(location.path, "query");
      if (
        location.endLine === blob.lines + 1 &&
        location.startLine <= blob.lines
      )
        return { endLine: blob.lines };
      if (location.endLine > blob.lines) {
        throw new Error(
          `${label} line ${location.endLine} exceeds ${location.path}'s ${blob.lines} lines at ${revision}.`,
        );
      }
      return undefined;
    },
  };
};

const qualifyEndpoint = async (
  qualifier: Qualifier,
  endpoint: GraphEndpoint,
  label: string,
  owner: `relationship:${string}`,
): Promise<void> => qualifier.location(endpoint.location, label, owner);

const qualifyEvidence = async (
  qualifier: Qualifier,
  evidence: GraphEvidence,
  label: string,
  owner: `relationship:${string}`,
): Promise<void> => qualifier.location(evidence.location, label, owner);

const qualifyRelation = async (
  qualifier: Qualifier,
  relation: GraphRelationObservation,
  label: string,
  owner: `relationship:${string}`,
): Promise<void> => {
  await qualifyEndpoint(qualifier, relation.from, `${label}.from`, owner);
  await qualifyEndpoint(qualifier, relation.to, `${label}.to`, owner);
  for (const [index, evidence] of relation.evidence.entries()) {
    await qualifyEvidence(
      qualifier,
      evidence,
      `${label}.evidence[${index}]`,
      owner,
    );
  }
};

const queryLimitations = (
  query: GraphQueryObservation,
  capabilities: GraphCapabilities,
): readonly GraphCapabilityLimitation[] =>
  unique(
    query.results.flatMap((result) => {
      const contained =
        result.containedCallables.kind === "unavailable"
          ? []
          : result.containedCallables.items;
      return [result, ...contained].flatMap(({ language }) =>
        languageLimitations(capabilities, language, "query_result"),
      );
    }),
  );

const relationshipLimitations = (
  relationship: GraphRelationshipObservation,
  capabilities: GraphCapabilities,
  requestedRelation: string,
): readonly GraphCapabilityLimitation[] => {
  const endpoints = relationship.observations.flatMap(
    ({ from, to, relation }) => [
      { endpoint: from, subject: "relationship_focus" as const, relation },
      { endpoint: to, subject: "relationship_endpoint" as const, relation },
    ],
  );
  if (relationship.focus.kind === "resolved") {
    endpoints.push({
      endpoint: relationship.focus.symbol,
      subject: "relationship_focus",
      relation: requestedRelation,
    });
  }
  return unique(
    endpoints.flatMap(({ endpoint, subject, relation }) =>
      languageLimitations(capabilities, endpoint.language, subject, relation),
    ),
  );
};

const unresolvedFrontier = (
  request: GraphRelationshipRequest,
):
  | Readonly<{ summary?: never }>
  | Readonly<{
      summary: Readonly<{ kind: "unresolved_focus" }>;
    }> =>
  request.summary === "frontier"
    ? { summary: { kind: "unresolved_focus" } }
    : {};

const validateObservedFrontier = (
  summary: GraphFrontierSummary,
  focus: GraphEndpoint,
  observations: readonly GraphRelationObservation[],
): Extract<GraphFrontierSummary, Readonly<{ kind: "observed" }>> => {
  if (summary.kind !== "observed") {
    throw new Error(
      "Neuve Graph stable relationship summary must have an observed focus.",
    );
  }
  if (summary.direct.emittedEdges !== observations.length) {
    throw new Error(
      "Neuve Graph relationship summary emitted count does not match retained observations.",
    );
  }
  const endpoints = new Map<string, GraphEndpoint>();
  for (const observation of observations) {
    const adjacent =
      observation.direction === "out" ? observation.to : observation.from;
    endpoints.set(adjacent.id, adjacent);
  }
  const expectedIds = [...endpoints.keys()].sort();
  const observedIds = summary.frontier.map(({ endpointId }) => endpointId);
  if (
    expectedIds.length !== observedIds.length ||
    expectedIds.some((id, index) => id !== observedIds[index])
  ) {
    throw new Error(
      "Neuve Graph relationship summary frontier does not match retained endpoints.",
    );
  }
  for (const entry of summary.frontier) {
    const endpoint = endpoints.get(entry.endpointId);
    if (endpoint === undefined) {
      throw new Error(
        "Neuve Graph relationship summary references an unknown endpoint.",
      );
    }
    if (entry.kind === "indexed" && endpoint.external) {
      throw new Error(
        "Neuve Graph relationship summary indexed an external endpoint.",
      );
    }
    if (
      entry.kind === "unavailable" &&
      (entry.reason === "external_endpoint") !== endpoint.external
    ) {
      throw new Error(
        "Neuve Graph relationship summary external classification does not match its endpoint.",
      );
    }
  }
  if (focus.external) {
    throw new Error(
      "Neuve Graph relationship summary focus must remain an internal symbol.",
    );
  }
  return summary;
};

const inspectRelationship = async (
  request: GraphRelationshipRequest,
  input: Readonly<{
    executable: string;
    view: string;
    revision: FullRevision;
    tree: FullRevision;
    cwd: string;
    recorder: Recorder;
    qualifier: Qualifier;
    capabilities: GraphCapabilities;
  }>,
): Promise<GraphRelationshipObservation> => {
  requirePreparedSupport(input.recorder, input.capabilities);
  const qualificationOwner: `relationship:${string}` = `relationship:${request.id}`;
  if (
    !input.capabilities.supportedRelationTypes.includes(request.relation) ||
    !(
      input.capabilities.relationSupportByProfile[input.recorder.profile] ?? []
    ).includes(request.relation)
  ) {
    throw new Error(
      `Neuve Graph does not declare ${request.relation} support in the requested profile.`,
    );
  }
  const expectedRelation = {
    relation: request.relation,
    selection: request.selection,
    selectedRelations:
      request.selection === "exact"
        ? [request.relation]
        : (input.capabilities.relationFamilies[request.relation] ?? []),
    direction: request.direction,
  };
  if (
    expectedRelation.selectedRelations.length === 0 ||
    expectedRelation.selectedRelations.some(
      (relation) =>
        !(
          input.capabilities.relationSupportByProfile[input.recorder.profile] ??
          []
        ).includes(relation),
    )
  )
    throw new Error(
      "Neuve Graph does not declare every selected relation in the requested profile.",
    );
  const resolution = parseNeighbors(
    await graphCommand(
      input.executable,
      neighborArgs(
        input.view,
        request,
        request.focus.name,
        true,
        false,
        input.recorder.profile,
        input.revision,
        input.recorder.preparedOnly,
      ),
      input.cwd,
      `relationship:${request.id}:resolution`,
      input.recorder,
      `Neuve Graph relationship ${request.id} resolution`,
    ),
    input.view,
    input.revision,
    input.tree,
    {
      ...expectedRelation,
      query: request.focus.name,
      ...(request.focus.path === undefined ? {} : { file: request.focus.path }),
      ...(request.focus.line === undefined ? {} : { line: request.focus.line }),
    },
    input.recorder.profile,
    input.recorder.preparedQualification,
  );
  confirmPreparedRead(
    input.recorder,
    resolution.cache,
    resolution.preparedRead,
  );
  for (const [index, match] of resolution.matches.entries()) {
    await qualifyEndpoint(
      input.qualifier,
      match.symbol,
      `relationship ${request.id} resolution match ${index}`,
      qualificationOwner,
    );
  }
  const candidates = resolution.matches.filter((match) =>
    matchesSelector(request, match),
  );
  if (candidates.length === 0) {
    const result: GraphRelationshipObservation = {
      cache: resolution.cache,
      ...(resolution.service === undefined
        ? {}
        : { service: resolution.service }),
      ...readQualification(resolution),
      selection: request.selection,
      selectedRelations: expectedRelation.selectedRelations,
      focus: { kind: "not_found" },
      observations: [],
      truncated: resolution.truncated,
      focusMatchesTruncated: resolution.focusMatchesTruncated,
      warnings: resolution.warnings,
      partialFailures: resolution.partialFailures,
      limitations: [],
      ...unresolvedFrontier(request),
    };
    return {
      ...result,
      limitations: relationshipLimitations(
        result,
        input.capabilities,
        request.relation,
      ),
    };
  }
  if (
    candidates.length !== 1 ||
    resolution.focusMatchesTruncated ||
    resolution.disambiguationRequired
  ) {
    const result: GraphRelationshipObservation = {
      cache: resolution.cache,
      ...(resolution.service === undefined
        ? {}
        : { service: resolution.service }),
      ...readQualification(resolution),
      selection: request.selection,
      selectedRelations: expectedRelation.selectedRelations,
      focus: {
        kind: "ambiguous",
        matches: candidates.map(({ symbol }) => symbol),
        matchesTruncated: resolution.focusMatchesTruncated,
      },
      observations: [],
      truncated: resolution.truncated,
      focusMatchesTruncated: resolution.focusMatchesTruncated,
      warnings: resolution.warnings,
      partialFailures: resolution.partialFailures,
      limitations: [],
      ...unresolvedFrontier(request),
    };
    return {
      ...result,
      limitations: relationshipLimitations(
        result,
        input.capabilities,
        request.relation,
      ),
    };
  }
  const candidate = candidates[0];
  if (candidate === undefined)
    throw new Error("Unique focus candidate disappeared.");
  const frontierSupported =
    input.capabilities.optionalLocalOnlyFeatures.neighbor_frontier_summary ===
    true;
  const requestFrontier = request.summary === "frontier";
  const observed = parseNeighbors(
    await graphCommand(
      input.executable,
      neighborArgs(
        input.view,
        request,
        candidate.symbol.id,
        false,
        requestFrontier && frontierSupported,
        input.recorder.profile,
        input.revision,
        input.recorder.preparedOnly,
      ),
      input.cwd,
      `relationship:${request.id}:observation`,
      input.recorder,
      `Neuve Graph relationship ${request.id} observations`,
    ),
    input.view,
    input.revision,
    input.tree,
    {
      ...expectedRelation,
      query: candidate.symbol.id,
      ...(requestFrontier && frontierSupported
        ? { summary: "frontier" as const }
        : {}),
    },
    input.recorder.profile,
    input.recorder.preparedQualification,
  );
  confirmPreparedRead(input.recorder, observed.cache, observed.preparedRead);
  const selected = observed.matches.filter(
    ({ symbol }) => symbol.id === candidate.symbol.id,
  );
  if (selected.length !== 1) {
    throw new Error(
      `Neuve Graph relationship ${request.id} stable symbol id resolved ${selected.length} times.`,
    );
  }
  const selectedMatch = selected[0];
  if (selectedMatch === undefined)
    throw new Error("Resolved focus disappeared.");
  await qualifyEndpoint(
    input.qualifier,
    selectedMatch.symbol,
    `relationship ${request.id} focus`,
    qualificationOwner,
  );
  for (const [index, observation] of selectedMatch.observations.entries()) {
    await qualifyRelation(
      input.qualifier,
      observation,
      `relationship ${request.id} observation ${index}`,
      qualificationOwner,
    );
  }
  const summaryExtension:
    | Readonly<{ summary?: never }>
    | Readonly<{ summary: GraphFrontierSummary }> = !requestFrontier
    ? {}
    : !frontierSupported
      ? { summary: { kind: "unavailable", reason: "unsupported_provider" } }
      : observed.summary === undefined
        ? (() => {
            throw new Error(
              "Neuve Graph relationship summary disappeared after parsing.",
            );
          })()
        : {
            summary: validateObservedFrontier(
              observed.summary,
              selectedMatch.symbol,
              selectedMatch.observations,
            ),
          };
  const result: GraphRelationshipObservation = {
    cache: observed.cache,
    ...(observed.service === undefined ? {} : { service: observed.service }),
    ...readQualification(observed),
    selection: request.selection,
    selectedRelations: expectedRelation.selectedRelations,
    focus: { kind: "resolved", symbol: selectedMatch.symbol },
    observations: selectedMatch.observations,
    truncated: resolution.truncated || observed.truncated,
    focusMatchesTruncated:
      resolution.focusMatchesTruncated || observed.focusMatchesTruncated,
    warnings: unique([...resolution.warnings, ...observed.warnings]),
    partialFailures: unique([
      ...resolution.partialFailures,
      ...observed.partialFailures,
    ]),
    limitations: [],
    ...summaryExtension,
  };
  return {
    ...result,
    limitations: relationshipLimitations(
      result,
      input.capabilities,
      request.relation,
    ),
  };
};

const outcome = async <Value>(
  action: () => Promise<Value>,
  publicMessage: string,
): Promise<GraphOutcome<Value>> => {
  try {
    return { kind: "success", value: await action() };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    return {
      kind: "error",
      error:
        error instanceof ServiceDeadlineError
          ? { message: error.message, serviceDeadline: true }
          : error instanceof PreparedReadError
            ? { message: error.message, preparedFailure: error.reason }
            : error instanceof PreparedReceiptError
              ? {
                  message: "Prepared receipt qualification failed.",
                  preparedFailure: "incompatible-artifact",
                }
              : { message: publicMessage },
    };
  }
};

const cleanupView = async (
  repository: string,
  view: string,
  temporaryRoot: string,
  cwd: string,
  recorder: Recorder,
  removalFailureIsError = true,
): Promise<void> => {
  const failures: unknown[] = [];
  let recoveryRequired = false;
  try {
    const removal = await command(
      ["git", "-C", repository, "worktree", "remove", "--force", view],
      cwd,
      "worktree_remove",
      recorder,
      { ignoreAbort: true },
    );
    if (removal.exitCode !== 0) {
      recoveryRequired = true;
      if (removalFailureIsError) {
        try {
          successfulText(removal, "Git isolated view removal");
        } catch (error) {
          failures.push(error);
        }
      }
    }
  } catch (error) {
    recoveryRequired = true;
    if (removalFailureIsError) failures.push(error);
  }
  if (recoveryRequired) {
    try {
      await rm(view, { recursive: true, force: true });
    } catch (error) {
      failures.push(error);
    }
    try {
      successfulText(
        await command(
          ["git", "-C", repository, "worktree", "prune"],
          cwd,
          "worktree_prune",
          recorder,
          { ignoreAbort: true },
        ),
        "Git worktree cleanup recovery",
      );
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await rm(temporaryRoot, { recursive: true, force: true });
  } catch (error) {
    failures.push(error);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Isolated-view cleanup failed.");
  }
};

const runInspection = async (
  request: GraphInspectionRequest,
  run: GraphInspectionRun,
): Promise<void> => {
  // The wait for the service runs from here, so the inspection's own setup counts against it.
  const started = Date.now();
  try {
    request = structuredClone(request);
  } catch {
    throw new Error("Inspection requests must contain cloneable data.");
  }
  validateRequest(request);
  if (
    run.serviceDeadlineMs !== undefined &&
    !(Number.isFinite(run.serviceDeadlineMs) && run.serviceDeadlineMs > 0)
  )
    throw new Error(
      "serviceDeadlineMs must be a positive number of milliseconds.",
    );
  const parallel = run.experimentalScheduling === "parallel";
  const controller = parallel ? new AbortController() : undefined;
  const signal =
    controller === undefined
      ? run.signal
      : run.signal === undefined
        ? controller.signal
        : AbortSignal.any([run.signal, controller.signal]);
  const gitPolicy = await prepareLocalGitRead(resolve(request.repository));
  const environment = gitPolicy.environment;
  let recorder: Recorder = {
    gitPolicy,
    evidence: run,
    failures: [],
    cacheDirectory: resolve(
      run.cacheDirectory ??
        (await defaultCacheDirectory(
          resolve(request.repository),
          environment ?? process.env,
        )),
    ),
    preparedOnly: request.cache === "prepared",
    profile: request.profile ?? "full",
    preparedState: {},
    ...(run.serviceDeadlineMs === undefined
      ? {}
      : { serviceDeadlineAt: started + run.serviceDeadlineMs }),
    ...(run.serviceClass === undefined
      ? {}
      : { serviceClass: run.serviceClass }),
    ...(environment === undefined ? {} : { environment }),
    ...(signal === undefined ? {} : { signal }),
  };
  const operationRecorders: Recorder[] = [];
  const operationRecorder = (): Recorder => {
    if (!parallel) return recorder;
    const owned = { ...recorder, failures: [] };
    operationRecorders.push(owned);
    return owned;
  };
  const repository = resolve(request.repository) as RepositoryPath;
  const cwd = repository;
  const resolvedRevision = fullRevision(
    successfulText(
      await command(
        [
          "git",
          "-C",
          repository,
          "rev-parse",
          "--verify",
          `${request.revision}^{commit}`,
        ],
        cwd,
        "git_revision",
        recorder,
      ),
      "Git revision resolution",
    ),
    "resolved revision",
  );
  const resolvedTree = fullRevision(
    successfulText(
      await command(
        [
          "git",
          "-C",
          repository,
          "rev-parse",
          "--verify",
          `${resolvedRevision}^{tree}`,
        ],
        cwd,
        "git_tree",
        recorder,
      ),
      "Git tree resolution",
    ),
    "resolved tree",
  );
  const temporaryParent = resolve(run.temporaryParent ?? tmpdir());
  const temporaryRoot = await mkdtemp(
    join(temporaryParent, "neuve-graph-client-"),
  );
  const view = recorder.preparedOnly
    ? repository
    : join(temporaryRoot, "source", basename(repository));
  if (!recorder.preparedOnly && run.onTemporaryView !== undefined) {
    recordFailure(recorder, () => run.onTemporaryView?.({ path: view }));
  }
  let viewAdded = false;
  let worktreeAddAttempted = false;
  let operationError: unknown;
  let pendingRelationship:
    | Promise<
        | Readonly<{ kind: "fulfilled"; outcome: GraphRelationshipOutcome }>
        | Readonly<{ kind: "rejected"; error: unknown }>
      >
    | undefined;
  let completion:
    Extract<GraphInspectionEvent, { kind: "complete" }> | undefined;
  try {
    const configuredExecutable = request.executable.includes("/")
      ? resolve(cwd, request.executable)
      : Bun.which(request.executable);
    if (configuredExecutable === null) {
      throw new Error("Neuve Graph executable could not be resolved.");
    }
    // The engine runs from a private, read-only copy whose bytes are hashed before it runs, so the
    // identity reported is the one that ran. The copy lives at one place per engine build, under
    // the cache directory, so every inspection runs the same executable path: the shared Graph
    // service is one per executable path (architecture record 0013), and a fresh copy per
    // inspection would start a service per search.
    const digestOf =
      run.reuseIdentity === true ? rememberedDigest : executableDigest;
    const { executable, sha256: executableSha256 } = await stableExecutableCopy(
      configuredExecutable,
      recorder.cacheDirectory,
      run.reuseIdentity === true,
    );
    const digest = async (): Promise<string> => digestOf(executable);
    if (!recorder.preparedOnly) {
      worktreeAddAttempted = true;
      successfulText(
        await command(
          [
            "git",
            "-C",
            repository,
            "worktree",
            "add",
            "--quiet",
            "--detach",
            view,
            resolvedRevision,
          ],
          cwd,
          "worktree_add",
          recorder,
        ),
        "Git isolated view creation",
      );
      viewAdded = true;
    }
    if (recorder.preparedOnly) {
      const common = successfulText(
        await command(
          [
            "git",
            "-C",
            repository,
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
          ],
          cwd,
          "git_common_directory",
          recorder,
        ),
        "Git owner qualification",
      );
      const prefix = successfulOutput(
        await command(
          ["git", "-C", repository, "rev-parse", "--show-prefix"],
          cwd,
          "git_scope",
          recorder,
        ),
        "Git scan scope qualification",
      )
        .replace(/\n$/, "")
        .replace(/\/$/, "");
      recorder = {
        ...recorder,
        preparedQualification: {
          commonDirectory: await realpath(common),
          scope: prefix,
          producerBuildId: executableSha256,
        },
      };
    }
    const checkBuildIdentity = (version: ProviderFacts["version"]) => {
      if (
        version.buildIdentity !== null &&
        version.buildIdentity !== executableSha256
      ) {
        throw new Error(
          "Neuve Graph build identity does not match the frozen executable.",
        );
      }
    };
    const readFacts = async (
      factsRecorder: Recorder,
    ): Promise<ProviderFacts> => {
      const version = parseVersion(
        await graphCommand(
          executable,
          ["version", "--json"],
          cwd,
          "version",
          factsRecorder,
          "Neuve Graph version",
        ),
      );
      checkBuildIdentity(version);
      const declared = await graphCommand(
        executable,
        ["capabilities", "--json"],
        cwd,
        "capabilities",
        factsRecorder,
        "Neuve Graph capabilities",
      );
      return {
        version,
        capabilities: parseCapabilities(declared),
        featureLanguages: parseFeatureLanguages(declared),
      };
    };
    const facts = await (async () => {
      if (run.reuseIdentity !== true) return readFacts(recorder);
      const known = providerFacts.get(executableSha256);
      if (known !== undefined) return known;
      const result = await providerFactsWork.run({
        scope: "provider-facts",
        key: executableSha256,
        ...(recorder.signal ? { signal: recorder.signal } : {}),
        run: async (signal) => {
          const value =
            providerFacts.get(executableSha256) ??
            (await readFacts({ ...recorder, signal }));
          providerFacts.set(executableSha256, value);
          return { kind: "succeeded", value };
        },
      });
      if (result.outcome.kind === "failed") throw result.outcome.error;
      // Only the holder records executed commands; joiners match completed-cache hits.
      return result.outcome.value;
    })();
    checkBuildIdentity(facts.version);
    const { version, capabilities } = facts;
    if (request.cache === "refresh") {
      parseRefresh(
        await graphCommand(
          executable,
          [
            "index",
            "--repo",
            view,
            ...(recorder.preparedOnly
              ? ["--commit", resolvedRevision]
              : ["--head"]),
            "--profile",
            recorder.profile,
            "--format",
            "json",
            "--force",
          ],
          cwd,
          "index",
          recorder,
          "Neuve Graph cache refresh",
        ),
        view,
        resolvedRevision,
        resolvedTree,
        version.version,
      );
    }
    const qualifier = createQualifier(
      repository,
      resolvedRevision,
      cwd,
      recorder,
    );
    const identity: GraphInspectionEvent["identity"] = {
      provider: {
        name: version.provider,
        version: version.version,
        identityRevision: version.identityRevision,
        executable: {
          sha256: executableSha256,
          buildIdentity:
            version.buildIdentity === null ? "unreported" : "verified",
        },
        capabilities,
      },
      source: { repository, revision: resolvedRevision },
    };
    const relationshipOutcome = async (
      relationship: GraphRelationshipRequest,
    ): Promise<GraphRelationshipOutcome> => {
      if (
        !capabilities.relationSelectionModes.includes(relationship.selection)
      ) {
        return {
          kind: "unavailable",
          reason: "unsupported_selection",
          selection: relationship.selection,
          relation: relationship.relation,
        };
      }
      const ownedRecorder = operationRecorder();
      return outcome(
        () =>
          inspectRelationship(relationship, {
            executable,
            view,
            revision: resolvedRevision,
            tree: resolvedTree,
            cwd,
            recorder: ownedRecorder,
            qualifier: parallel
              ? createQualifier(
                  repository,
                  resolvedRevision,
                  cwd,
                  ownedRecorder,
                )
              : qualifier,
            capabilities,
          }),
        "Neuve Graph relationship observation unavailable.",
      );
    };
    const firstRelationship = request.relationships[0];
    if (parallel && firstRelationship !== undefined) {
      pendingRelationship = relationshipOutcome(firstRelationship).then(
        (value) => ({ kind: "fulfilled", outcome: value }),
        (error: unknown) => ({ kind: "rejected", error }),
      );
    }
    const queryRecorder = operationRecorder();
    const queryQualifier = parallel
      ? createQualifier(repository, resolvedRevision, cwd, queryRecorder)
      : qualifier;
    let sequence = 1;
    const query = await outcome(async () => {
      requirePreparedSupport(queryRecorder, capabilities);
      const parsed = parseQuery(
        await graphCommand(
          executable,
          [
            "query",
            "--repo",
            view,
            ...(recorder.preparedOnly
              ? ["--commit", resolvedRevision]
              : ["--head"]),
            "--profile",
            recorder.profile,
            "--format",
            "json",
            "--top-k",
            String(request.limits.topK),
            "--max-context-bytes",
            String(request.limits.maxContextBytes),
            "--query",
            request.question,
          ],
          cwd,
          "query",
          queryRecorder,
          "Neuve Graph query",
        ),
        view,
        resolvedRevision,
        resolvedTree,
        request.question,
        request.limits,
        recorder.profile,
        recorder.preparedQualification,
      );
      confirmPreparedRead(queryRecorder, parsed.cache, parsed.preparedRead);
      const normalizations: GraphLocationNormalization[] = [];
      const results = [];
      for (const [index, result] of parsed.results.entries()) {
        const clamped = await queryQualifier.resultRange(
          result.source,
          `query result ${index}`,
        );
        if (clamped === undefined) {
          results.push(result);
          continue;
        }
        normalizations.push({
          kind: "end-line-past-eof",
          resultIndex: index,
          path: result.source.path,
          reportedEndLine: result.source.endLine,
          endLine: clamped.endLine,
        });
        results.push({
          ...result,
          source: { ...result.source, endLine: clamped.endLine },
        });
      }
      const normalized = {
        ...parsed,
        results,
        ...(normalizations.length === 0 ? {} : { normalizations }),
      };
      return {
        ...normalized,
        limitations: queryLimitations(normalized, capabilities),
      };
    }, "Neuve Graph query observation unavailable.");
    await emitEvent(run, {
      kind: "retrieval",
      sequence,
      identity,
      outcome: query,
    });
    for (const relationship of request.relationships) {
      let observed: GraphRelationshipOutcome;
      if (pendingRelationship !== undefined) {
        const settled = await pendingRelationship;
        pendingRelationship = undefined;
        if (settled.kind === "rejected") throw settled.error;
        observed = settled.outcome;
      } else {
        observed = await relationshipOutcome(relationship);
      }
      sequence += 1;
      await emitEvent(run, {
        kind: "relationship",
        sequence,
        identity,
        requestId: relationship.id,
        outcome: observed,
      });
    }
    sequence += 1;
    if ((await digest()) !== executableSha256) {
      throw new Error(
        "Neuve Graph frozen executable changed during the inspection.",
      );
    }
    completion = {
      kind: "complete",
      sequence,
      identity,
      relationshipCount: request.relationships.length,
    };
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    controller?.abort();
    await pendingRelationship;
    let cleanupError: unknown;
    try {
      if (worktreeAddAttempted) {
        await cleanupView(
          repository,
          view,
          temporaryRoot,
          cwd,
          recorder,
          viewAdded,
        );
      } else {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    } catch (error) {
      cleanupError = error;
    }
    const secondary = [
      ...recorder.failures,
      ...operationRecorders.flatMap((owned) => owned.failures),
      ...(cleanupError === undefined ? [] : [cleanupError]),
    ];
    if (secondary.length > 0) {
      throw new AggregateError(
        [
          ...(operationError === undefined ? [] : [operationError]),
          ...secondary,
        ],
        "Graph inspection evidence recording or cleanup failed.",
      );
    }
  }
  if (completion === undefined) {
    throw new Error("Graph inspection finished without completion state.");
  }
  await emitEvent(run, completion);
};

export const runGraphInspection = (
  request: GraphInspectionRequest,
  run: GraphInspectionRun,
): Promise<void> => runInspection(request, run);

export const inspectGraph = async (
  request: GraphInspectionRequest,
  // The cache the inspection's commands use, as `runGraphInspection` takes it; unset, the store's.
  evidence: GraphInspectionEvidence &
    Pick<GraphInspectionRun, "cacheDirectory"> = {},
): Promise<GraphInspection> => {
  let identity: GraphInspectionEvent["identity"] | undefined;
  let query: GraphInspection["query"] | undefined;
  const relationships: GraphInspection["relationships"][number][] = [];
  await runGraphInspection(request, {
    ...evidence,
    emit: async (event) => {
      identity = event.identity;
      if (event.kind === "retrieval") {
        query = event.outcome;
      } else if (event.kind === "relationship") {
        relationships.push({
          requestId: event.requestId,
          outcome: event.outcome,
        });
      }
    },
  });
  if (identity === undefined || query === undefined) {
    throw new Error("Graph inspection completed without retrieval.");
  }
  return {
    provider: identity.provider,
    source: identity.source,
    query,
    relationships,
  };
};
