import { appendFileSync, chmodSync, mkdirSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_ACCOUNTS,
  type AccountName,
  AccountDirectory,
  AccountStore,
  RuntimeRegistry,
  RuntimeUnavailable,
  inMemoryAccountDirectoryLayer,
  runtimeRegistryLayerEffect,
  type RuntimeRegistryShape,
  type RuntimeShape,
} from "@neuve/runtime";
import { claudeRuntime, type ClaudeRuntimeConfig } from "@neuve/runtime-claude";
import {
  codexRuntime,
  type CodexRuntimeConfig,
  type LogEntry,
} from "@neuve/runtime-codex";
export {
  findCodexProgram,
  PROGRAM as CODEX_PROGRAM,
} from "@neuve/runtime-codex";
import { Context, Effect, Layer, ManagedRuntime, Scope } from "effect";
import type { ReadinessStatuses } from "./route-provider.ts";
import {
  piStatusRuntime,
  type PiStatusRuntimeOptions,
} from "./pi/status-runtime.ts";

/**
 * The stable folder Neuve owns for Claude Code sessions: one folder, so every continuation
 * identity resumes in the same working directory. It holds no credential and no source.
 */
export const defaultClaudeWorkingFolder = (home = homedir()) =>
  join(home, "Library", "Application Support", "Neuve", "claude-code", "work");

export interface HarnessRuntimesOptions<E, R> extends PiStatusRuntimeOptions {
  readonly accountDirectory?: Layer.Layer<AccountDirectory, E, R>;
  /** The Claude Code runtime's configuration; `false` leaves it unregistered. */
  readonly claude?: ClaudeRuntimeConfig | false;
  /**
   * The Codex runtime's configuration; absent or `false` leaves it unregistered, so a process or
   * test that does not ask for it never starts a program named `codex`.
   */
  readonly codex?: CodexRuntimeConfig | false;
}

/** The Codex runtime as the worker, the workspace and `neuve auth` register it for a home. */
export const codexRuntimeOptions = (home = homedir()): CodexRuntimeConfig => ({
  home,
  programPath: (name) => AccountStore.programPath(home, name),
});

/**
 * Where a runtime's protocol log goes for one channel: `<folder>/<account>-protocol.jsonl`, owner
 * only, beside the channel's other state, so it is removed with the channel. Each session's lines
 * carry the session's own label, so chats running at once stay apart in the one file. The runtime
 * redacts every line before it reaches here. A session reports its first failed write, not each.
 */
export const protocolLogs =
  (folder: string, report: (path: string, error: unknown) => void) =>
  (account: AccountName): ((entry: LogEntry) => void) => {
    const path = join(folder, `${account}-protocol.jsonl`);
    const session = randomUUID().slice(0, 8);
    let reported = false;
    return (entry) => {
      try {
        mkdirSync(folder, { recursive: true, mode: 0o700 });
        appendFileSync(path, `${JSON.stringify({ session, ...entry })}\n`, {
          mode: 0o600,
        });
      } catch (error) {
        if (!reported) report(path, error);
        reported = true;
      }
    };
  };

/** Creates the folder, or tightens an existing one, to owner-only access; false when it can't. */
const privateFolder = (folder: string) => {
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    if ((statSync(folder).mode & 0o777) !== 0o700) chmodSync(folder, 0o700);
    return (statSync(folder).mode & 0o777) === 0o700;
  } catch {
    return false;
  }
};

/**
 * Claude Code without a usable working folder: capabilities, continuation and sign-out still come
 * from the runtime, while sessions fail and probes report the runtime unavailable, so one bad folder
 * never takes pi's accounts down with it.
 */
const withoutWorkingFolder = (runtime: RuntimeShape): RuntimeShape => ({
  ...runtime,
  openSession: (account) =>
    Effect.fail(
      new RuntimeUnavailable({ account: account.name, reason: "start-failed" }),
    ),
  probe: () =>
    Effect.sync(() => ({
      signIn: { state: "runtime-unavailable", reason: "start-failed" },
      limits: [],
      checkedAt: new Date().toISOString(),
    })),
});

/**
 * The one place runtimes are registered. Building the Claude Code runtime starts no child and sends
 * no model request. Its first probe or session shares one attempt to make its working folder private.
 */
export function harnessRuntimes<E = never, R = never>(
  options: HarnessRuntimesOptions<E, R> = {},
) {
  const claude =
    options.claude === false
      ? undefined
      : (options.claude ?? { cwd: defaultClaudeWorkingFolder() });
  return runtimeRegistryLayerEffect(
    Effect.gen(function* () {
      const pi = piStatusRuntime(options);
      const codex =
        options.codex === undefined || options.codex === false
          ? []
          : [yield* codexRuntime(options.codex)];
      if (claude === undefined) return [pi, ...codex];
      const runtime = yield* claudeRuntime(claude);
      const ready = yield* Effect.cachedWithTTL(
        Effect.yieldNow.pipe(
          Effect.map(() =>
            privateFolder(claude.cwd) ? runtime : withoutWorkingFolder(runtime),
          ),
        ),
        (exit) =>
          exit._tag === "Success" && exit.value === runtime ? Infinity : 0,
      );
      return [
        pi,
        ...codex,
        {
          ...runtime,
          openSession: (account, policy, start) =>
            Effect.flatMap(ready, (runtime) =>
              runtime.openSession(account, policy, start),
            ),
          probe: (account) =>
            Effect.flatMap(ready, (runtime) => runtime.probe(account)),
        } satisfies RuntimeShape,
      ];
    }),
  ).pipe(
    Layer.provide(
      options.accountDirectory ??
        inMemoryAccountDirectoryLayer(DEFAULT_ACCOUNTS),
    ),
  );
}

/**
 * The worker configures its directory before any attempt resolves a runtime. Claude Code stays
 * out of the registry unless `claude` is given (`workerRuntimeOptions` gives it), so an
 * unconfigured process or test never creates a folder in the real home.
 */
export type ProcessRuntimeOptions = HarnessRuntimesOptions<never, never> & {
  /** The home readiness reads account statuses from; the real home when absent. */
  readonly home?: string;
};

/** The review worker keeps the accounts store and its directory in the registry's scope. */
export function workerRuntimeOptions(home = homedir()) {
  return {
    claude: { cwd: defaultClaudeWorkingFolder(home) },
    codex: codexRuntimeOptions(home) as CodexRuntimeConfig | false,
    accountDirectory: Layer.effect(
      AccountDirectory,
      AccountStore.retryingDirectory(home),
    ),
  } satisfies ProcessRuntimeOptions;
}

let processOptions: ProcessRuntimeOptions = {};
let processRegistry: Promise<RuntimeRegistryShape> | undefined;

export function configureProcessRuntimes(options: ProcessRuntimeOptions): void {
  if (processRegistry !== undefined)
    throw new Error("Process runtimes have already been created");
  processOptions = options;
}

/** One registry and its layer scope live for the worker process, across attempts. */
export function processRuntimes(): Promise<RuntimeRegistryShape> {
  if (processRegistry === undefined) {
    const runtime = ManagedRuntime.make(
      harnessRuntimes({
        ...processOptions,
        claude: processOptions.claude ?? false,
        codex: processOptions.codex ?? false,
      }),
    );
    processRegistry = runtime
      .runPromise(RuntimeRegistry)
      .catch(async (error) => {
        await runtime.dispose();
        processRegistry = undefined;
        throw error;
      });
  }
  return processRegistry;
}

class ProcessStatuses extends Context.Service<
  ProcessStatuses,
  ReadinessStatuses
>()("@neuve/harness/ProcessStatuses") {}
let processStatuses: Promise<ReadinessStatuses> | undefined;

/** Lazy, process-scoped subscriptions share the accounts service's own check and snapshot. */
export function processReadinessStatuses(): Effect.Effect<
  ReadinessStatuses,
  AccountStore.StoreError
> {
  return Effect.tryPromise({
    try: () => {
      if (processStatuses === undefined) {
        const runtime = ManagedRuntime.make(
          Layer.effect(
            ProcessStatuses,
            Effect.gen(function* () {
              const registry = yield* Effect.promise(processRuntimes);
              const service = yield* AccountStore.makeStatuses(
                processOptions.home ?? homedir(),
                registry,
              );
              return { service, scope: yield* Scope.Scope };
            }),
          ),
        );
        processStatuses = runtime
          .runPromise(ProcessStatuses)
          .catch(async (error) => {
            await runtime.dispose();
            processStatuses = undefined;
            throw error;
          });
      }
      return processStatuses;
    },
    // A folder refusal keeps its typed problem, so readiness names the folder in ruling 46's words.
    catch: (error) =>
      error instanceof AccountStore.StoreError && error.refusal !== undefined
        ? error
        : new AccountStore.StoreError({
            message: "The account status service could not start.",
          }),
  });
}
