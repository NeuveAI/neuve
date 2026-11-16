import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { storeLocationIn } from "../src/location.ts";
import {
  holderGone,
  privateSocketDirectory,
  reachStoreWorker,
  workerPathsFor,
} from "../src/worker-socket.ts";

// Why: status must report no worker before a repository has ever created its Records directory.
test("ownership inspection of an uncreated worker directory is read-only", async () => {
  const root = mkdtempSync(join(tmpdir(), "worker-ownership-"));
  try {
    const directory = join(root, "absent");
    expect(
      await Effect.runPromise(
        holderGone(storeLocationIn(directory), { _tag: "Absent" }),
      ),
    ).toBe(true);
    expect(existsSync(directory)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Why: every process of the user must name one socket per store, whatever spelling of the repository
// path it holds, and two repositories must never share one. The socket must sit outside the store,
// where Neuve Graph's walk refuses sockets, and fit macOS's 104-byte Unix socket limit.
test("the socket lives outside the store, one per store, and fits for a deep path", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "worker-path-")));
  try {
    const first = join(root, "first", ".git");
    const second = join(root, "second", ".git");
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    symlinkSync(join(root, "first"), join(root, "alias"));
    const paths = (common: string) =>
      Effect.runPromise(workerPathsFor(storeLocationIn(common)));
    const one = await paths(first);
    expect(await paths(join(root, "alias", ".git"))).toEqual({
      ...one,
      legacy: join(root, "alias", ".git", "neuve", "worker.sock"),
      lock: `${join(root, "alias", ".git", "neuve", "worker.sock")}.sqlite`,
    });
    expect((await paths(second)).socket).not.toBe(one.socket);
    const uid = process.getuid?.() ?? 0;
    expect(one.socket).toMatch(
      new RegExp(`^/tmp/neuve-${uid}/[0-9a-f]{32}\\.sock$`),
    );
    expect(one.legacy).toBe(join(first, "neuve", "worker.sock"));
    // The lifetime lock stays where every earlier build takes it.
    expect(one.lock).toBe(`${one.legacy}.sqlite`);

    const deep = join(root, "d".repeat(200), ".git");
    const far = await paths(deep);
    expect(Buffer.byteLength(far.socket)).toBeLessThanOrEqual(103);
    expect(far.legacy).toBeUndefined();
    expect(far.lock).toBe(`${far.socket}.sqlite`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Why: /tmp is shared by every user. A directory there that another user made, or that others can
// enter, or a link, would let someone else stand in for the worker, so each refuses with a sentence
// that says what to do, and Neuve never changes its mode or owner.
test("the socket directory must be a private directory of this user", () => {
  const root = mkdtempSync(join(tmpdir(), "worker-home-"));
  const uid = process.getuid?.() ?? 0;
  const directory = join(root, `neuve-${uid}`);
  try {
    expect(privateSocketDirectory(root)).toBe(directory);
    expect(lstatSync(directory).mode & 0o777).toBe(0o700);

    chmodSync(directory, 0o755);
    expect(() => privateSocketDirectory(root)).toThrow(
      `others can access it (mode 755). Run chmod 700 ${directory}`,
    );
    expect(lstatSync(directory).mode & 0o777).toBe(0o755);
    rmSync(directory, { recursive: true });

    const target = join(root, "elsewhere");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, directory);
    expect(() => privateSocketDirectory(root)).toThrow(
      `it is a symbolic link, which Neuve does not follow. Remove the link (rm ${directory})`,
    );
    rmSync(directory);

    writeFileSync(directory, "");
    expect(() => privateSocketDirectory(root)).toThrow("it is not a directory");
    rmSync(directory);

    // A directory of another user: this process stands in as uid + 1.
    mkdirSync(join(root, `neuve-${uid + 1}`), { mode: 0o700 });
    const getuid = process.getuid;
    process.getuid = () => uid + 1;
    try {
      expect(() => privateSocketDirectory(root)).toThrow(
        `it belongs to uid ${uid}, not to you (uid ${uid + 1}). Have its owner or an administrator remove it`,
      );
    } finally {
      if (getuid !== undefined) process.getuid = getuid;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Why: a worker of an older build listens on the store's legacy socket; every reader must still find
// it there, and must find the current socket first.
test("discovery reaches a worker on the legacy socket when none answers outside the store", async () => {
  const root = mkdtempSync(join(tmpdir(), "worker-find-"));
  const location = storeLocationIn(root);
  const listeners: Array<{ stop: (force?: boolean) => void }> = [];
  const listen = (path: string, reply: string) => {
    const listener = Bun.listen({
      unix: path,
      socket: { data: (socket) => void socket.write(`${reply}\n`) },
    });
    listeners.push(listener);
    return listener;
  };
  try {
    mkdirSync(location.directory, { recursive: true });
    const paths = await Effect.runPromise(workerPathsFor(location));
    const reach = () =>
      Effect.runPromise(reachStoreWorker(location, "status", "500 millis"));
    expect(await reach()).toEqual({
      socket: paths.socket,
      reach: { _tag: "Absent" },
    });
    const legacy = paths.legacy!;
    listen(legacy, "older");
    expect(await reach()).toEqual({
      socket: legacy,
      reach: { _tag: "Answered", reply: "older" },
    });
    listen(paths.socket, "current");
    expect(await reach()).toEqual({
      socket: paths.socket,
      reach: { _tag: "Answered", reply: "current" },
    });
  } finally {
    for (const listener of listeners) listener.stop(true);
    const paths = await Effect.runPromise(workerPathsFor(location));
    rmSync(paths.socket, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
