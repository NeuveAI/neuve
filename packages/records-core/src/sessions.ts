import { preserveUnknown, safeRead } from "@neuve/records-schema";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { join } from "node:path";
import { Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import { z } from "zod";
import { withFileLock } from "./file-lock.ts";
import { sha256Hex } from "./canonical.ts";
import { identityOf, sameProcess, snapshotProcesses } from "./ancestry.ts";
import { ACE_CHANNEL_HARNESS, agentFingerprint } from "./identity.ts";
import {
  resolveStoreLocation,
  STORE_DIRECTORY_MODE,
  type StoreLocation,
} from "./location.ts";

/**
 * Live agent sessions, as small files under `<store>/sessions/`, the way entire-cli keeps session
 * state in the git common directory. Hooks read and write them without opening SQLite (D18). They hold
 * only what capture needs between hooks: the session's actor, the agent process that owns it (for
 * ancestry matching, D23) and the open turn's key. They are not records: the durable facts are the
 * spooled events, and a session's files are removed when it ends.
 */
const ProcessIdentity = z.strictObject({
  pid: z.int().min(1),
  start: z.string().min(1),
  host: z.string().min(1),
});

export const SessionState = z.strictObject({
  version: z.literal(1),
  harness: z.string().min(1),
  sessionId: z.string().min(1),
  actorId: z.string().regex(/^[0-9a-f]{64}$/),
  owner: ProcessIdentity.optional(),
  turnKey: z.string().min(1).optional(),
});

export const SubagentState = z.strictObject({
  version: z.literal(1),
  subagentId: z.string().min(1),
  actorId: z.string().regex(/^[0-9a-f]{64}$/),
  turnKey: z.string().min(1).optional(),
});

export type SessionState = z.infer<typeof SessionState>;
export type SubagentState = z.infer<typeof SubagentState>;

export const sessionsDirectory = (location: StoreLocation) =>
  join(location.directory, "sessions");

const key = (value: string) => sha256Hex(value).slice(0, 24);

const sessionDirectory = (
  location: StoreLocation,
  harness: string,
  sessionId: string,
) => join(sessionsDirectory(location), `${harness}.${key(sessionId)}`);

const SESSION_FILE = "session.json";
const subagentFile = (subagentId: string) => `subagent.${key(subagentId)}.json`;

/** A missing or unreadable state file reads as absent: capture state is advisory, never required. */
const readJson = <T extends z.ZodType>(schema: T, path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const text = yield* fs.readFileString(path);
    const parsed = safeRead(schema, JSON.parse(text), { source: path });
    return parsed.success ? (parsed.data as z.infer<T>) : undefined;
  }).pipe(Effect.catchCause(() => Effect.succeed(undefined)));

/** All writers and removal share a session lock outside the directory being removed. */
const withSessionLock = <A, E>(
  directory: string,
  work: Effect.Effect<A, E, FileSystem>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    return yield* Effect.tryPromise((signal) =>
      withFileLock(
        `${directory}.lock`,
        () =>
          Effect.runPromise(work.pipe(Effect.provideService(FileSystem, fs)), {
            signal,
          }),
        120_000,
        signal,
      ),
    );
  });

/** Whole-file replacement by rename; read, preservation and publication stay under the lock. */
const writeJson = <T>(
  schema: z.ZodType<T>,
  directory: string,
  name: string,
  value: unknown,
) =>
  withSessionLock(
    directory,
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      yield* fs.makeDirectory(directory, {
        recursive: true,
        mode: STORE_DIRECTORY_MODE,
      });
      const path = join(directory, name);
      let input: unknown = schema.parse(value);
      if (yield* fs.exists(path)) {
        const text = yield* fs.readFileString(path);
        input = yield* Effect.try(() =>
          preserveUnknown(schema, JSON.parse(text), input, { source: path }),
        );
      }
      const temporary = join(directory, `.${name}.${process.pid}.tmp`);
      yield* fs
        .writeFileString(temporary, `${JSON.stringify(input)}\n`)
        .pipe(
          Effect.andThen(fs.rename(temporary, path)),
          Effect.ensuring(Effect.ignore(fs.remove(temporary, { force: true }))),
        );
    }),
  );

export const readSession = (
  location: StoreLocation,
  harness: string,
  sessionId: string,
) =>
  readJson(
    SessionState,
    join(sessionDirectory(location, harness, sessionId), SESSION_FILE),
  );

export const writeSession = (location: StoreLocation, state: SessionState) =>
  writeJson(
    SessionState,
    sessionDirectory(location, state.harness, state.sessionId),
    SESSION_FILE,
    state,
  );

export const readSubagent = (
  location: StoreLocation,
  harness: string,
  sessionId: string,
  subagentId: string,
) =>
  readJson(
    SubagentState,
    join(
      sessionDirectory(location, harness, sessionId),
      subagentFile(subagentId),
    ),
  );

/** Each subagent has its own file, so parallel subagents of one session never overwrite each other. */
export const writeSubagent = (
  location: StoreLocation,
  harness: string,
  sessionId: string,
  state: SubagentState,
) =>
  writeJson(
    SubagentState,
    sessionDirectory(location, harness, sessionId),
    subagentFile(state.subagentId),
    state,
  );

export const removeSession = (
  location: StoreLocation,
  harness: string,
  sessionId: string,
  owner?: NonNullable<SessionState["owner"]>,
) =>
  withSessionLock(
    sessionDirectory(location, harness, sessionId),
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      const directory = sessionDirectory(location, harness, sessionId);
      if (owner !== undefined) {
        const live = yield* readSession(location, harness, sessionId);
        if (!live?.owner || !sameProcess(live.owner, owner)) return;
      }
      if (yield* fs.exists(directory)) {
        for (const name of yield* fs.readDirectory(directory)) {
          const schema: z.ZodType | undefined =
            name === SESSION_FILE
              ? SessionState
              : name.startsWith("subagent.") && name.endsWith(".json")
                ? SubagentState
                : undefined;
          if (schema === undefined) return;
          const text = yield* fs.readFileString(join(directory, name));
          const read = yield* Effect.try(() =>
            safeRead(schema, JSON.parse(text), {
              source: join(directory, name),
            }),
          ).pipe(Effect.orElseSucceed(() => undefined));
          if (!read?.success || read.droppedKeys.length > 0) return;
        }
      }
      yield* fs.remove(directory, {
        recursive: true,
        force: true,
      });
    }),
  );

export const openAceChannelSession = (project: string, sessionId: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const location = yield* resolveStoreLocation(project).pipe(
        Effect.orElseSucceed(() => undefined),
      );
      const fs = yield* FileSystem;
      if (location === undefined || !(yield* fs.exists(location.database)))
        return;
      const row = snapshotProcesses()?.get(process.pid);
      if (row === undefined)
        throw new Error("Cannot identify the channel worker process");
      const owner = identityOf(row);
      const harness = ACE_CHANNEL_HARNESS;
      yield* writeSession(location, {
        version: 1,
        harness,
        sessionId,
        actorId: agentFingerprint({ harness, sessionId }),
        owner,
      });
      return () =>
        Effect.runPromise(
          removeSession(location, harness, sessionId, owner).pipe(
            Effect.provide(BunFileSystem.layer),
          ),
        );
    }).pipe(Effect.provide(BunFileSystem.layer)),
  );

/** Every live session recorded in this store. */
export const listSessions = (location: StoreLocation) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem;
    const names = yield* fs
      .readDirectory(sessionsDirectory(location))
      .pipe(Effect.catchCause(() => Effect.succeed([] as Array<string>)));
    const states = yield* Effect.forEach(
      names.filter((name) => !name.endsWith(".lock")),
      (name) =>
        readJson(
          SessionState,
          join(sessionsDirectory(location), name, SESSION_FILE),
        ),
    );
    return states.filter((state) => state !== undefined);
  });
