// A rename is atomic for readers, but every writer must serialize its read-merge-publish too.
import type { Subprocess } from "bun";
import { afterAll, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Registry, Sessions, storeLocationIn } from "../src/index.ts";
import { withFileLock } from "../src/file-lock.ts";

const root = mkdtempSync(join(tmpdir(), "file-publication-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const run = <A, E>(program: Effect.Effect<A, E, FileSystem>) =>
  Effect.runPromise(program.pipe(Effect.provide(BunFileSystem.layer)));
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const state = {
  version: 1 as const,
  harness: "fixture",
  sessionId: "one",
  actorId: "a".repeat(64),
  turnKey: "old",
};

const fixture = async (
  kind: "registry" | "session" | "subagent",
  name: string,
) => {
  const location = storeLocationIn(join(root, name));
  if (kind === "registry") {
    const path = join(root, `${name}.json`);
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        repositories: [{ store: "one", repository: "one" }],
        future: { revision: 1 },
      }),
    );
    return {
      path,
      lock: `${path}.lock`,
      update: Registry.registerRepository(location, "two", path),
      check: () =>
        expect(read(path).repositories).toEqual([
          { store: "one", repository: "one" },
          { store: location.directory, repository: "two" },
        ]),
    };
  }
  await run(Sessions.writeSession(location, state));
  if (kind === "subagent")
    await run(
      Sessions.writeSubagent(location, state.harness, state.sessionId, {
        version: 1,
        subagentId: "child",
        actorId: state.actorId,
        turnKey: "old",
      }),
    );
  const directory = join(
    Sessions.sessionsDirectory(location),
    readdirSync(Sessions.sessionsDirectory(location)).find(
      (name) => !name.endsWith(".lock"),
    )!,
  );
  const path = join(
    directory,
    kind === "session"
      ? "session.json"
      : readdirSync(directory).find((name) => name.startsWith("subagent."))!,
  );
  writeFileSync(
    path,
    JSON.stringify({ ...read(path), future: { revision: 1 } }),
  );
  const update =
    kind === "session"
      ? Sessions.writeSession(location, { ...state, turnKey: "new" })
      : Sessions.writeSubagent(location, state.harness, state.sessionId, {
          version: 1,
          subagentId: "child",
          actorId: state.actorId,
          turnKey: "new",
        });
  return {
    path,
    lock: `${directory}.lock`,
    update,
    check: () => expect(read(path).turnKey).toBe("new"),
  };
};

for (const kind of ["registry", "session", "subagent"] as const) {
  test(`${kind}: a newer writer arriving at the older rename waits, retaining revision 2 and the older change`, async () => {
    const f = await fixture(kind, `${kind}-publish`);
    let child: Subprocess<"ignore", "pipe", "inherit"> | undefined;
    try {
      await run(
        Effect.gen(function* () {
          const fs = yield* FileSystem;
          let publications = 0;
          yield* f.update.pipe(
            Effect.provideService(FileSystem, {
              ...fs,
              rename: (from, to) =>
                Effect.gen(function* () {
                  if (to === f.path) {
                    publications++;
                    expect(existsSync(f.lock)).toBe(true);
                    child = Bun.spawn(
                      [
                        process.execPath,
                        "--no-env-file",
                        join(import.meta.dir, "fixtures/newer-file-writer.ts"),
                        f.path,
                        f.lock,
                      ],
                      { stdin: "ignore", stdout: "pipe", stderr: "inherit" },
                    );
                    const reader = child.stdout.getReader();
                    const waiting = yield* Effect.promise(() => reader.read());
                    reader.releaseLock();
                    expect(new TextDecoder().decode(waiting.value)).toBe(
                      "waiting\n",
                    );
                  }
                  return yield* fs.rename(from, to);
                }),
            }),
          );
          expect(publications).toBe(1);
        }),
      );
      expect(child).toBeDefined();
      expect(await child!.exited).toBe(0);
      expect(read(f.path).future).toEqual({ revision: 2 });
      f.check();
      expect(existsSync(f.lock)).toBe(false);
    } finally {
      if (child) {
        if (child.exitCode === null) child.kill();
        await child.exited;
      }
    }
  });

  test(`${kind}: an older writer queued behind a newer publication reads revision 2 before merging`, async () => {
    const f = await fixture(kind, `${kind}-wait`);
    let older: Promise<unknown> | undefined;
    await withFileLock(f.lock, async () => {
      older = run(f.update);
      // The lock is held before the older writer starts. Publication finishes before releasing it.
      writeFileSync(
        f.path,
        JSON.stringify({ ...read(f.path), future: { revision: 2 } }),
      );
    });
    await older;
    expect(read(f.path).future).toEqual({ revision: 2 });
    f.check();
  });
}

test("session removal waits for the same writer lock and retains a newly published unknown field", async () => {
  const location = storeLocationIn(join(root, "remove"));
  await run(Sessions.writeSession(location, state));
  const directory = join(
    Sessions.sessionsDirectory(location),
    readdirSync(Sessions.sessionsDirectory(location))[0]!,
  );
  const path = join(directory, "session.json");
  let removal: Promise<unknown> | undefined;
  await withFileLock(`${directory}.lock`, async () => {
    removal = run(
      Sessions.removeSession(location, state.harness, state.sessionId),
    );
    writeFileSync(path, JSON.stringify({ ...state, future: { revision: 2 } }));
  });
  await removal;
  expect(read(path).future).toEqual({ revision: 2 });
  expect(await run(Sessions.listSessions(location))).toHaveLength(1);
});

for (const kind of ["registry", "session"] as const) {
  test(`${kind}: a failed publication releases the lock and keeps the original file for a retry`, async () => {
    const f = await fixture(kind, `${kind}-failure`);
    const before = readFileSync(f.path, "utf8");
    const outcome = await run(
      Effect.gen(function* () {
        const fs = yield* FileSystem;
        return yield* Effect.result(
          f.update.pipe(
            Effect.provideService(FileSystem, {
              ...fs,
              rename: () =>
                Effect.die(new Error("fixture publication failure")),
            }),
          ),
        );
      }),
    );
    expect(outcome._tag).toBe("Failure");
    expect(readFileSync(f.path, "utf8")).toBe(before);
    expect(existsSync(f.lock)).toBe(false);
    expect(
      readdirSync(join(f.path, "..")).some((name) => name.endsWith(".tmp")),
    ).toBe(false);
    await run(f.update);
    f.check();
  });
}
