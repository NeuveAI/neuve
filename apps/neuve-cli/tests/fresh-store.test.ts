// Why: two foreground CLI requests must survive a closed-store read overlapping real worker startup.
import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  utimesSync,
} from "node:fs";
import { createServer, type Socket } from "node:net";
import { Database } from "bun:sqlite";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { z } from "zod";
import {
  Worker,
  resolveStoreLocation,
  type StoreLocation,
} from "@neuve/records-core";

import { workerSuite } from "../../../packages/records-core/tests/worker-suite.ts";
import { markSetUp } from "./fixtures/set-up.ts";

const closeMailboxes = new Set<() => void>();
afterEach(() => {
  for (const close of closeMailboxes) close();
  closeMailboxes.clear();
});
const workers = workerSuite();
const WireMessage = z.object({
  event: z.string(),
  detail: z.string().optional(),
  pid: z.number().int().positive().optional(),
});
type Message = z.infer<typeof WireMessage> & { socket?: Socket };
const fixture = resolve(import.meta.dir, "fixtures/fresh-store-review.ts");
const mailbox = () => {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let closed = false;
  closeMailboxes.add(() => {
    closed = true;
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  });
  const seen: Message[] = [];
  const waiters: Array<{ event: string; resolve: (message: Message) => void }> =
    [];
  const queued: Message[] = [];
  return {
    seen,
    push(message: Message) {
      if (closed) return;
      seen.push(message);
      if (process.env.FRESH_STORE_DEBUG)
        console.error(
          "F1 event",
          message.event,
          message.pid ?? message.detail ?? "",
        );
      const index = waiters.findIndex(
        (waiter) => waiter.event === message.event,
      );
      if (index < 0) queued.push(message);
      else waiters.splice(index, 1)[0]!.resolve(message);
    },
    next(event: string) {
      // A cancelled scenario may resume during worker teardown. Leave its waits inert.
      if (closed) return new Promise<Message>(() => {});
      const index = queued.findIndex((message) => message.event === event);
      if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]!);
      return new Promise<Message>((resolve, reject) => {
        const timer = setTimeout(() => {
          timers.delete(timer);
          reject(
            new Error(
              `missing ${event}; saw ${seen.map((message) => `${message.event}:${message.detail ?? ""}`).join(", ")}`,
            ),
          );
        }, 6000);
        timers.add(timer);
        waiters.push({
          event,
          resolve: (message) => {
            clearTimeout(timer);
            timers.delete(timer);
            resolve(message);
          },
        });
      });
    },
  };
};
// A settled timestamp makes the immutable-read barrier independent of the current wall-clock second.
const closeWithoutWal = (path: string) => {
  const database = new DatabaseSync(path);
  database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  database.close();
  utimesSync(path, 1, 1);
  expect(existsSync(`${path}-wal`)).toBe(false);
};
const scenario = async (
  failure: boolean,
  detach = false,
  prebindPeer?: "writer" | "review-admission" | "legacy",
) => {
  const owner = await workers.start();
  const root = mkdtempSync(join(tmpdir(), "fresh-review-"));
  const settings = join(root, "settings.json");
  writeFileSync(settings, JSON.stringify({ version: 1 }));
  const repo = join(root, "repo");
  const control = `/tmp/fresh-${process.pid}-${Math.random().toString(16).slice(2)}.sock`;
  const workerEvents = mailbox();
  const sockets = new Set<Socket>();
  let connections = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString();
      if (!buffer.includes("\n")) return;
      const message = WireMessage.parse(JSON.parse(buffer.trim()));
      if (
        message.event === "connected" &&
        (prebindPeer !== undefined ||
          ++connections > 1 ||
          !("withStartup" in Worker))
      )
        socket.end("go\n");
      workerEvents.push({ ...message, socket });
      buffer = "";
    });
  });
  const children: Array<ReturnType<typeof Bun.spawn>> = [];
  const output: Array<Promise<string>> = [];
  let location: StoreLocation | undefined;
  let peerWriter: Database | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(control, resolve));
    const git = (...args: string[]) => {
      const result = Bun.spawnSync([
        "git",
        "-c",
        "core.hooksPath=/dev/null",
        "-C",
        repo,
        ...args,
      ]);
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    const init = Bun.spawnSync(["git", "init", "-q", repo]);
    expect(init.exitCode).toBe(0);
    // Reviews refuse a repository until `neuve setup` has run there.
    await markSetUp(repo);
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.com");
    writeFileSync(join(repo, "file.txt"), "before\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    writeFileSync(join(repo, "file.txt"), "after\n");
    git("add", ".");
    git("commit", "-qm", "head");
    const head = git("rev-parse", "HEAD");
    const range = `${base}..${head}`;
    let peerRange = range;
    if (prebindPeer === "review-admission") {
      writeFileSync(join(repo, "file.txt"), "peer admission\n");
      git("add", ".");
      git("commit", "-qm", "peer");
      peerRange = `${head}..${git("rev-parse", "HEAD")}`;
    }
    location = await Effect.runPromise(resolveStoreLocation(repo));
    const start = (
      role: string,
      requestedRange = range,
      admissionRead = false,
    ) => {
      const events = mailbox();
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          fixture,
          repo,
          requestedRange,
          role,
          detach ? "detach" : "foreground",
        ],
        {
          detached: true,
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            ...owner.env,
            ANTHROPIC_API_KEY: "fixture-never-used",
            FRESH_STORE_CONTROL: control,
            FRESH_STORE_SETTINGS: settings,
            FRESH_STORE_READ_AT_ADMISSION: admissionRead ? "1" : "0",
          },
          ipc(message) {
            const event = WireMessage.parse(message);
            events.push(event);
          },
        },
      );
      owner.child(child.pid);
      children.push(child);
      output.push(
        Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]).then((text) => text.join("\n")),
      );
      return {
        child,
        events,
        go() {
          child.stdin.write("g");
          child.stdin.flush();
        },
      };
    };
    const a = start(prebindPeer ? "reader" : "writer");
    await a.events.next("admission");
    const b = detach || prebindPeer ? undefined : start("reader", range, true);
    if (b) await b.events.next("admission");
    // A node:sqlite close checkpoints and removes WAL on every supported SQLite library.
    closeWithoutWal(location.database);
    a.go();
    const first = await workerEvents.next("boot");
    if (detach) {
      expect((await a.events.next("returned")).detail).toBe("0");
      expect(
        workerEvents.seen.some((message) => message.event === "opened"),
      ).toBe(false);
      return;
    }
    await a.events.next("follow");
    if (prebindPeer) {
      closeWithoutWal(location.database);
      if (prebindPeer === "review-admission") {
        const peer = start("writer", peerRange);
        await peer.events.next("admission");
      } else {
        peerWriter = new Database(location.database);
        peerWriter.exec("CREATE TABLE prebind_peer (id INTEGER)");
      }
      const path = await Effect.runPromise(Worker.socketPathFor(location));
      expect(existsSync(path)).toBe(false);
      a.go();
      // Follow awaits its admission's child even while a peer changes the closed store.
      first.socket!.end("go\n");
      const opened = await workerEvents.next("opened");
      if (prebindPeer === "legacy") {
        peerWriter!.exec(
          "INSERT INTO worker_state VALUES (1, 42, 'legacy.sock', 'then', 'then', 'legacy')",
        );
        opened.socket!.end("go\n");
        expect((await a.events.next("failed")).detail).toContain(
          Worker.olderWorkerMessage(location.directory),
        );
        expect(
          a.events.seen.some((message) => message.event === "subscribed"),
        ).toBe(false);
      } else {
        opened.socket!.end("go\n");
        await a.events.next("subscribed");
        await a.events.next("finished");
      }
      expect(await a.child.exited).toBe(0);
      expect(
        a.events.seen.filter((message) => message.event === "spawned"),
      ).toHaveLength(1);
      expect(
        workerEvents.seen.filter((message) => message.event === "boot"),
      ).toHaveLength(1);
      const check = new DatabaseSync(location.database, { readOnly: true });
      try {
        expect(check.prepare("PRAGMA integrity_check").get()).toEqual({
          integrity_check: "ok",
        });
      } finally {
        check.close();
      }
      return;
    }
    closeWithoutWal(location.database);
    b!.go();
    await b!.events.next("reading");
    first.socket!.end("go\n");
    const opened = await workerEvents.next("opened");
    const path = await Effect.runPromise(Worker.socketPathFor(location));
    // The lifetime claim is already held while acceptance is blocked.
    const { claimWorkerLock } =
      await import("../../../packages/records-core/src/worker-socket.ts");
    const contender = await Effect.runPromise(
      claimWorkerLock(
        (await Effect.runPromise(Worker.workerPathsFor(location))).lock,
      ),
    );
    const lifetimeHeld = contender === undefined;
    contender?.close();
    a.go();
    b!.go();
    if ("withStartup" in Worker) {
      await b!.events.next("acceptance-wait");
      (await workerEvents.next("connected")).socket!.end("go\n");
    }
    expect(
      [...a.events.seen, ...b!.events.seen].some(
        (message) => message.event === "subscribed",
      ),
    ).toBe(false);
    opened.socket!.end(failure ? "fail\n" : "go\n");
    if (failure) {
      // The first review gets its own child's failure; the uncertain admission's child fails too.
      (await workerEvents.next("boot")).socket!.end("fail\n");
      // A failed first start still takes today's follow fallback, whose child fails as well.
      await b!.events.next("follow");
      b!.go();
      (await workerEvents.next("boot")).socket!.end("fail\n");
      for (const events of [a.events, b!.events])
        expect((await events.next("failed")).detail).toContain(
          "WorkerSpawnFailed",
        );
      expect(
        [...a.events.seen, ...b!.events.seen].some(
          (message) => message.event === "subscribed",
        ),
      ).toBe(false);
    } else {
      await b!.events.next("follow");
      b!.go();
      await Promise.all([
        a.events.next("subscribed"),
        b!.events.next("subscribed"),
      ]);
      await Promise.all([
        a.events.next("finished"),
        b!.events.next("finished"),
      ]);
      const status = await Effect.runPromise(
        Worker.reachWorker(path, "status"),
      );
      expect(status._tag).toBe("Answered");
      if (status._tag === "Answered")
        expect(JSON.parse(status.reply).pid).toBe(first.pid);
      const accepted = new DatabaseSync(location.database, { readOnly: true });
      try {
        expect(
          accepted
            .prepare("SELECT count(*) AS n FROM worker_state WHERE id=1")
            .get(),
        ).toEqual({ n: 1 });
        expect(
          accepted
            .prepare("SELECT count(*) AS n FROM worker_lock_claim WHERE id=1")
            .get(),
        ).toEqual({ n: 1 });
        expect(
          accepted
            .prepare("SELECT count(*) AS n FROM jobs WHERE kind='review.run@2'")
            .get(),
        ).toEqual({ n: 1 });
      } finally {
        accepted.close();
      }
    }
    expect(lifetimeHeld).toBe(true);
    expect(
      a.events.seen.filter((message) => message.event === "spawned"),
    ).toHaveLength(1);
    expect(
      workerEvents.seen.filter((message) => message.event === "boot"),
    ).toHaveLength(failure ? 3 : 1);
    for (const child of children) expect(await child.exited).toBe(0);
  } finally {
    await owner.close();
    for (const child of children) {
      child.kill();
      if (typeof child.stdin !== "number") child.stdin?.end();
    }
    await Promise.all(children.map((child) => child.exited));
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all(output);
    const workerLog = location && join(location.directory, "worker.log");
    if (process.env.FRESH_STORE_DEBUG && workerLog && existsSync(workerLog))
      console.error("F1 worker log", readFileSync(workerLog, "utf8"));
    peerWriter?.close();
    rmSync(root, { recursive: true, force: true });
    rmSync(control, { force: true });
  }
};
test(
  "F1: two real foreground reviews await one acceptance across a changed admission read",
  () => scenario(false),
  // Starts real foreground reviews and workers through admission and acceptance, then cleans up.
  15_000,
);
test(
  "F1: failed startup closes both foreground waiters without successful readiness",
  () => scenario(true),
  // Starts and fails real workers for both foreground waiters, then cleans up.
  15_000,
);
test(
  "F1: detached review returns while its spawned worker has not opened Records",
  () => scenario(false, true),
  // Starts a real detached review and cleans up its paused worker.
  15_000,
);

// Why: follow reuses its admission's start while a peer changes the store before bind.
for (const peer of ["writer", "review-admission", "legacy"] as const)
  test(
    `Q1: pre-bind foreground follows its own spawn with peer ${peer}`,
    () => scenario(false, false, peer),
    // Starts real reviews and workers around a pre-bind peer, then cleans up.
    15_000,
  );
