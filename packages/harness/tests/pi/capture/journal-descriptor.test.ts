// Why: a session holds events.jsonl open instead of opening it per line (0.9-1.9 ms a line on a busy
// disk). These pin what holding it must not change. Every ending lets the file go, as this process's
// own open descriptors show. A crash still keeps every line before it, and a reopen still cuts a torn
// tail. A removed or moved file still fails loudly where a write by path did, and the tool processes
// a worker starts never inherit the descriptor.
import { afterAll, expect, test } from "bun:test";
import {
  fstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Effect } from "effect";
import { storeLocationIn } from "@neuve/records-core";
import {
  captureFolder,
  ensureRunFolder,
  exportOnClose,
  piDatabase,
  runFolder,
} from "../../../src/run-folder.ts";
import { SourceOwnership } from "../../../src/pi/source-ownership.ts";
import {
  exportingStorage,
  openNativeStorage,
} from "../../../src/pi/storage.ts";
import {
  IDLE_RELEASE_MS,
  JOURNAL_FILE,
  openCaptureJournal,
  readCaptureJournal,
} from "../../../src/pi/capture/journal.ts";
import {
  DEFAULT_LIMITS,
  type CaptureEvent,
} from "../../../src/pi/capture/types.ts";
import { runIn, value } from "./fixture.ts";

const directory = mkdtempSync(join(tmpdir(), "harness-journal-descriptor-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

const START: CaptureEvent = {
  type: "run.start",
  scope: { runId: "R" },
  runKind: "scored",
  sourceRevision: "abc123",
  route: "chatgpt",
  pricing: "subscription",
};
const END: CaptureEvent = {
  type: "run.end",
  scope: { runId: "R" },
  status: "completed",
};
const HASH = "a".repeat(64);
const certificate = (callId: string) => ({
  type: "credential.inspection" as const,
  scope: { runId: "R" },
  callId,
  version: 2 as const,
  sourceHash: HASH,
  sourceHashes: [HASH, HASH],
  safe: true,
});

type FileId = { readonly dev: number; readonly ino: number };
const fileOf = (folder: string): FileId => {
  const { dev, ino } = statSync(join(folder, JOURNAL_FILE));
  return { dev, ino };
};
/** This process's open descriptors on the file, read from /dev/fd. */
const holders = (file: FileId) =>
  readdirSync("/dev/fd").filter((name) => {
    try {
      const { dev, ino } = fstatSync(Number(name));
      return dev === file.dev && ino === file.ino;
    } catch {
      return false;
    }
  }).length;
const thrown = (run: () => unknown) => {
  try {
    run();
    return "kept";
  } catch (error) {
    return error;
  }
};
const lastEvent = (folder: string) => {
  const read = readCaptureJournal(folder);
  if (read._tag !== "Read") throw new Error(`journal is ${read._tag}`);
  return read.lines.at(-1)?.event.type;
};
const waitFor = async (check: () => boolean, ms: number) => {
  const until = Date.now() + ms;
  while (!check() && Date.now() < until) await Bun.sleep(50);
  return check();
};

test("every ending in the process lets the file go: close, a refused event, a refused write, certification and its failed last write", async () => {
  const closed = join(directory, "closed");
  const journal = openCaptureJournal(closed, "R");
  journal.capture(START);
  const file = fileOf(closed);
  expect(holders(file)).toBe(1);
  journal.close();
  expect(holders(file)).toBe(0);
  expect(lastEvent(closed)).toBe("journal.close");

  const invalid = join(directory, "invalid");
  const refusing = openCaptureJournal(invalid, "R");
  refusing.capture(START);
  expect(
    thrown(() => refusing.capture({ ...END, scope: { runId: "OTHER" } })),
  ).toMatchObject({ kind: "invalid" });
  expect(holders(fileOf(invalid))).toBe(0);

  // The journal's byte limit refuses the append itself, as a full disk would.
  const full = join(directory, "full");
  const small = openCaptureJournal(full, "R", {
    limits: { ...DEFAULT_LIMITS, objectBytes: 512 },
  });
  small.capture(START);
  expect(
    thrown(() =>
      small.capture({
        type: "model.request",
        scope: { runId: "R" },
        callId: "c1",
        route: "chatgpt",
        provider: "openai",
        model: "fixture",
        credentialCoverage: "none",
        headerNames: [],
        body: { status: "sent", json: { input: "x".repeat(600) } },
      }),
    ),
  ).toMatchObject({ kind: "io", event: "model.request" });
  expect(holders(fileOf(full))).toBe(0);
  expect(thrown(() => small.close())).toMatchObject({ kind: "io" });

  const certified = join(directory, "certified");
  const certifying = openCaptureJournal(certified, "R");
  certifying.capture(START);
  await certifying.certifyAll(
    2,
    async () => [certificate("c1"), certificate("c2")],
    async () => {},
  );
  expect(holders(fileOf(certified))).toBe(0);
  expect(lastEvent(certified)).toBe("journal.close");

  // The last write of a certification fails at the limit part-way through its rows: it used to leave
  // the session open (and now its descriptor). It fails the session, so it is never marked whole.
  const cut = join(directory, "cut");
  const cutting = openCaptureJournal(cut, "R", {
    limits: { ...DEFAULT_LIMITS, objectBytes: 1_024 },
  });
  cutting.capture(START);
  const failure = await cutting
    .certifyAll(
      3,
      async () => [certificate("c1"), certificate("c2"), certificate("c3")],
      async () => {},
    )
    .then(
      () => "kept",
      (error: unknown) => error,
    );
  expect(failure).toMatchObject({
    _tag: "CaptureFailed",
    kind: "io",
    event: "credential.inspection",
  });
  expect(holders(fileOf(cut))).toBe(0);
  expect(lastEvent(cut)).toBe("credential.inspection");
  expect(thrown(() => cutting.close())).toMatchObject({ kind: "io" });
  expect(lastEvent(cut)).toBe("credential.inspection");
});

test("an interrupted certification lets the file go and leaves the session open, as before, for its caller", async () => {
  const folder = join(directory, "interrupted");
  const journal = openCaptureJournal(folder, "R");
  journal.capture(START);
  const file = fileOf(folder);
  const interruption = new Error("the export was interrupted");
  const failure = await journal
    .certifyAll(
      1,
      async () => [certificate("c1")],
      async () => {
        throw interruption;
      },
    )
    .then(
      () => "kept",
      (error: unknown) => error,
    );
  expect(failure).toBe(interruption);
  expect(holders(file)).toBe(0);
  journal.capture(END);
  expect(holders(file)).toBe(1);
  journal.close();
  expect(holders(file)).toBe(0);
  expect(lastEvent(folder)).toBe("journal.close");
});

// A claim whose cleanup never reaches the journal (a worker stopped while its close failed), or any
// caller that drops a session, must not hold the file for the life of the worker process.
test("a session its caller abandons lets the file go once quiet, and its next line opens the same file again", async () => {
  const folder = join(directory, "abandoned");
  const journal = openCaptureJournal(folder, "R");
  journal.capture(START);
  const file = fileOf(folder);
  expect(holders(file)).toBe(1);
  expect(await waitFor(() => holders(file) === 0, IDLE_RELEASE_MS * 3)).toBe(
    true,
  );
  journal.capture(END);
  expect(holders(file)).toBe(1);
  journal.close();
  expect(holders(file)).toBe(0);
  const read = readCaptureJournal(folder);
  expect(read._tag === "Read" && read.lines.map((line) => line.seq)).toEqual([
    1, 2, 3, 4,
  ]);
}, 15_000);

// The worker's stop interrupts the claim, whose release closes the pi harness "interrupted"; the
// raw storage's close runs the capture hook, which ends the journal's session first.
test("a worker stop, a real pi harness closed interrupted at its storage boundary, lets the file go", async () => {
  const location = storeLocationIn(join(directory, "store"));
  const run = async <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    value(await runIn(location)(effect));
  const runId = "stopped";
  await run(
    ensureRunFolder(location, {
      runId,
      runKey: runId,
      pipelineVersion: 1,
      jobSeq: 1,
      range: {
        baseRef: "main",
        baseOid: "a".repeat(40),
        headOid: "b".repeat(40),
      },
    }),
  );
  const owner = SourceOwnership.acquire(runFolder(location, runId));
  try {
    const storage = await owner.openNative(
      piDatabase(location, runId),
      openNativeStorage,
    );
    const journal = openCaptureJournal(captureFolder(location, runId), runId);
    journal.capture({ ...START, scope: { runId } });
    const file = fileOf(captureFolder(location, runId));
    const hook = exportOnClose({ location, runId, journal });
    const barrier = exportingStorage(storage, {
      mode: () => "interrupted",
      onClose: (close) => run(hook({ runId, ...close })),
    });
    const harness = await Harness.open(
      barrier.storage,
      { models: createModels(), registry: createRegistry() },
      context,
    );
    expect(holders(file)).toBe(1);
    await harness.close(context);
    await barrier.closed(context);
    expect(holders(file)).toBe(0);
    expect(lastEvent(captureFolder(location, runId))).toBe("journal.close");
  } finally {
    owner.release();
  }
});

test("a removed run folder fails the next capture loudly, as a write by path did, and lets the file go", () => {
  const folder = join(directory, "removed");
  const journal = openCaptureJournal(folder, "R");
  journal.capture(START);
  const file = fileOf(folder);
  rmSync(folder, { recursive: true, force: true });
  expect(thrown(() => journal.capture(END))).toMatchObject({
    _tag: "CaptureFailed",
    kind: "io",
    event: "run.end",
    detail: `${JOURNAL_FILE} was removed while its session was open`,
  });
  expect(holders(file)).toBe(0);
  expect(thrown(() => journal.close())).toMatchObject({ kind: "io" });
});

test("a session whose folder moved is never marked whole, in either place", () => {
  const folder = join(directory, "moving");
  const moved = join(directory, "moved");
  const journal = openCaptureJournal(folder, "R");
  journal.capture(START);
  const file = fileOf(folder);
  renameSync(folder, moved);
  expect(thrown(() => journal.close())).toMatchObject({
    kind: "io",
    event: "journal.close",
  });
  expect(holders(file)).toBe(0);
  expect(lastEvent(moved)).toBe("run.start");
});

test("tool processes the worker starts do not inherit the open journal", () => {
  const folder = join(directory, "inherited");
  const journal = openCaptureJournal(folder, "R");
  journal.capture(START);
  const file = fileOf(folder);
  expect(holders(file)).toBe(1);
  const probe = `
    const { readdirSync, fstatSync } = require("node:fs");
    const [dev, ino] = [Number(process.env.DEV), Number(process.env.INO)];
    console.log(readdirSync("/dev/fd").filter((name) => {
      try { const s = fstatSync(Number(name)); return s.dev === dev && s.ino === ino; } catch { return false; }
    }).length);`;
  const env = { ...process.env, DEV: String(file.dev), INO: String(file.ino) };
  const viaBun = Bun.spawnSync([process.execPath, "-e", probe], { env });
  const viaNode = spawnSync(process.execPath, ["-e", probe], { env });
  expect(viaBun.stdout.toString().trim()).toBe("0");
  expect(viaNode.stdout.toString().trim()).toBe("0");
  journal.close();
});

test("a process killed mid-stream keeps every complete line, and the reopen cuts a torn tail and continues", async () => {
  const folder = join(directory, "killed");
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "journal-child.ts"),
      "stream",
      folder,
    ],
    { stdout: "ignore", stderr: "inherit" },
  );
  const path = join(folder, JOURNAL_FILE);
  const grown = await waitFor(() => {
    try {
      return statSync(path).size > 4 * 1024 * 1024;
    } catch {
      return false;
    }
  }, 60_000);
  child.kill("SIGKILL");
  await child.exited;
  expect(grown).toBe(true);
  expect(child.signalCode).toBe("SIGKILL");
  const killed = readCaptureJournal(folder);
  if (killed._tag !== "Read") throw new Error(`journal is ${killed._tag}`);
  expect(killed.lines.length).toBeGreaterThan(1_000);
  expect(killed.lines.map((line) => line.seq)).toEqual(
    killed.lines.map((_, index) => index + 1),
  );
  const bytes = readFileSync(path);
  const torn = bytes.at(-1) === 0x0a ? 0 : 1;
  expect(killed.tornLines).toBe(torn);
  expect(killed.lines.at(-1)?.event.type).not.toBe("journal.close");

  const reopened = openCaptureJournal(folder, "R");
  reopened.capture(END);
  reopened.close();
  const read = readCaptureJournal(folder);
  if (read._tag !== "Read") throw new Error(`journal is ${read._tag}`);
  expect(read.tornLines).toBe(torn);
  expect(
    readdirSync(folder).filter((name) => name.startsWith("torn-")).length,
  ).toBe(torn);
  expect(read.lines.slice(0, killed.lines.length)).toEqual([...killed.lines]);
  expect(
    read.lines.slice(killed.lines.length).map((line) => line.event.type),
  ).toEqual(["journal.open", "run.end", "journal.close"]);
  console.info(
    JSON.stringify({
      event: "journal.killed",
      lines: killed.lines.length,
      bytes: bytes.byteLength,
      torn,
    }),
  );
}, 120_000);
