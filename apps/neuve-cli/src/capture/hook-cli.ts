import { appendFile } from "node:fs/promises";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Cause, Effect, Exit } from "effect";
import type { FileSystem } from "effect/FileSystem";
import type { RecordEvent } from "@neuve/records-schema";
import {
  Spool,
  Starter,
  resolveStoreLocation,
  type StoreLocation,
} from "@neuve/records-core/capture";
import {
  AGENT_HARNESSES,
  AGENT_HOOK_EVENTS,
  HookPayload,
  captureAgentHook,
  type AgentHarness,
  type AgentHookEvent,
} from "./agent-hooks.ts";
import { captureConfigPath, hookLogPath, readCaptureConfig } from "./config.ts";
import { holdWorkerStart } from "../version-skew.ts";
import {
  TRAILER_HOOK,
  addSessionTrailer,
  capturePostCommit,
  capturePostRewrite,
} from "./git-hooks.ts";

const includes = <T extends string>(
  list: ReadonlyArray<T>,
  value: string,
): value is T => (list as ReadonlyArray<string>).includes(value);

/** Spools each event in order, then wakes or starts the worker (D19). Never opens SQLite (D18). */
const spoolAll = (
  repository: string,
  location: StoreLocation,
  command: ReadonlyArray<string>,
  events: ReadonlyArray<RecordEvent>,
) =>
  Effect.gen(function* () {
    if (events.length === 0) return;
    for (const event of events)
      yield* Spool.writeSpoolLine(location.spool, event);
    // A worker this binary would start refuses the store (version-skew.ts): log it, and keep the spool.
    if (holdWorkerStart(location, command, Starter.workerLogPath(location)))
      return;
    yield* Effect.ignore(Starter.ensureWorker({ repository, command }));
  });

const logFailure = async (
  location: StoreLocation | undefined,
  hook: string,
  message: string,
) => {
  if (location === undefined) return;
  await appendFile(
    hookLogPath(location),
    `${new Date().toISOString()} ${hook} ${message.replaceAll("\n", " ")}\n`,
  ).catch(() => undefined);
};

/**
 * `neuve hook <harness> <event> [git arguments]`: the entry point every installed hook calls. It
 * captures into the spool only, returns quickly, prints nothing (Claude Code adds some hooks' output
 * to the agent's context) and always exits 0, so an agent or a commit is never blocked; failures go
 * to `<store>/hooks.log`. It does nothing in a repository without `<store>/capture.json`.
 */
export const runHook = async (
  args: ReadonlyArray<string>,
  input?: string,
): Promise<number> => {
  const [harness = "", event = "", ...rest] = args;
  const hook = `${harness} ${event}`;
  let location: StoreLocation | undefined;
  try {
    let repository = process.cwd();
    let program: Effect.Effect<ReadonlyArray<RecordEvent>, unknown, FileSystem>;
    let payload: HookPayload | undefined;
    if (harness !== "git") {
      if (
        !includes(AGENT_HARNESSES, harness) ||
        !includes(AGENT_HOOK_EVENTS, event)
      )
        return 0;
      const parsed = HookPayload.safeParse(
        JSON.parse(input ?? (await Bun.stdin.text())),
      );
      if (!parsed.success) return 0;
      payload = parsed.data;
      repository = payload.cwd ?? repository;
    }
    const located = await Effect.runPromiseExit(
      resolveStoreLocation(repository),
    );
    if (Exit.isFailure(located)) return 0;
    location = located.value;
    const config = await readCaptureConfig(location);
    if (config === undefined) {
      // No file is no capture; one that can't be read is a failure, said in the hooks' log.
      if (await Bun.file(captureConfigPath(location)).exists())
        await logFailure(
          location,
          hook,
          `${captureConfigPath(location)} can't be read; neuve setup hooks writes it again`,
        );
      return 0;
    }
    const at = location;

    if (harness === "git") {
      switch (event) {
        case "post-commit":
          program = capturePostCommit(repository, at);
          break;
        case "post-rewrite":
          program = capturePostRewrite(
            repository,
            at,
            rest[0],
            input ?? (await Bun.stdin.text()),
          );
          break;
        case TRAILER_HOOK:
          if (!config.sessionTrailer) return 0;
          program = addSessionTrailer(repository, at, rest[0]).pipe(
            Effect.as([]),
          );
          break;
        default:
          return 0;
      }
    } else {
      if (!config.agents.includes(harness as AgentHarness)) return 0;
      program = captureAgentHook(event as AgentHookEvent, {
        location: at,
        harness: harness as AgentHarness,
        payload: payload!,
      });
    }
    const exit = await Effect.runPromiseExit(
      Effect.flatMap(program, (events) =>
        spoolAll(repository, at, config.command, events),
      ).pipe(Effect.provide(BunFileSystem.layer)),
    );
    if (Exit.isFailure(exit))
      await logFailure(location, hook, Cause.pretty(exit.cause));
  } catch (error) {
    await logFailure(
      location,
      hook,
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
  }
  return 0;
};
