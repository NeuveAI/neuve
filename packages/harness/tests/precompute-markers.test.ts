// Why: an unclean exit or reused PID must not leave preparation yielding indefinitely.
import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serialize } from "node:v8";
import { Effect } from "effect";
import { storeLocationIn } from "@neuve/records-core";
import { IndexSnapshot } from "../src/index-snapshot.ts";
import {
  codeProcessStart,
  codeCheckpoint,
  codeOwnerAlive,
  CodeWork,
  REVIEW_MARKER_MAX_MS,
  reviewPrecomputeActive,
  withCodeWork,
} from "../src/code-work.ts";
const root = mkdtempSync(join(tmpdir(), "review-markers-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const location = storeLocationIn(root),
  directory = join(location.directory, "code-work", "reviews");
mkdirSync(directory, { recursive: true });
const put = (name: string, overrides: object = {}) =>
  writeFileSync(
    join(directory, name),
    JSON.stringify({
      pid: process.pid,
      start: codeProcessStart(process.pid),
      createdAt: Date.now() - 100,
      expiresAt: Date.now() + 1000,
      ...overrides,
    }),
  );
test("live process markers expire and a reused PID cannot hold preparation", () => {
  put("expired", {
    createdAt: Date.now() - REVIEW_MARKER_MAX_MS - 1000,
    expiresAt: Date.now() - 1,
  });
  if (codeProcessStart(process.pid) !== null)
    put("reused", { start: "a different process start" });
  put("unbounded", { expiresAt: Date.now() + REVIEW_MARKER_MAX_MS + 10000 });
  expect(reviewPrecomputeActive(location.directory)).toBe(false);
  expect(readdirSync(directory)).toEqual([]);
  put("live");
  expect(reviewPrecomputeActive(location.directory)).toBe(true);
  rmSync(join(directory, "live"));
});
test("the review's own deadline bounds its marker even while the PID stays alive", async () => {
  await Effect.runPromise(
    withCodeWork(
      location,
      false,
      Effect.gen(function* () {
        expect(reviewPrecomputeActive(location.directory)).toBe(true);
        yield* Effect.sleep(80);
        expect(reviewPrecomputeActive(location.directory)).toBe(false);
      }),
      Date.now() + 50,
    ),
  );
  expect(readdirSync(directory)).toEqual([]);
});

// A sandbox can deny ps to the writer while a later reader can identify the process.
test("an unknown process start remains live when identification later succeeds", () => {
  put("unknown", { start: null });
  expect(reviewPrecomputeActive(location.directory)).toBe(true);
  expect(readdirSync(directory)).toContain("unknown");
  rmSync(join(directory, "unknown"));
});

test("live newer actor and review markers retain their snapshots", async () => {
  const { existsSync, readFileSync } = await import("node:fs");
  const actors = join(location.directory, "code-work", "actors");
  const indexes = join(location.directory, "code-work", "indexes");
  mkdirSync(actors, { recursive: true });
  mkdirSync(indexes, { recursive: true });
  const marker = {
    pid: process.pid,
    start: null,
    createdAt: Date.now() - 100,
    expiresAt: Date.now() + 60_000,
    future: true,
  };
  const actor = join(actors, "newer");
  const review = join(directory, "newer");
  const snapshot = join(indexes, "newer.index");
  writeFileSync(actor, JSON.stringify(marker));
  writeFileSync(review, JSON.stringify(marker));
  writeFileSync(snapshot, "newer snapshot");
  try {
    expect(reviewPrecomputeActive(location.directory)).toBe(true);
    await Effect.runPromise(withCodeWork(location, true, Effect.void));
    expect(existsSync(actor)).toBe(true);
    expect(existsSync(review)).toBe(true);
    expect(readFileSync(snapshot, "utf8")).toBe("newer snapshot");
  } finally {
    rmSync(actor, { force: true });
    rmSync(review, { force: true });
    rmSync(snapshot, { force: true });
  }
});

test("last-actor cleanup leaves an unrecognised index snapshot and file for the newer reader", async () => {
  const { existsSync } = await import("node:fs");
  const indexes = join(location.directory, "code-work", "indexes");
  mkdirSync(indexes, { recursive: true });
  const snapshot = join(indexes, "newer.index");
  const file = join(indexes, "newer.tmp");
  writeFileSync(snapshot, "newer snapshot format");
  writeFileSync(file, "newer temporary format");
  try {
    await Effect.runPromise(withCodeWork(location, true, Effect.void));
    expect(existsSync(snapshot)).toBe(true);
    expect(existsSync(file)).toBe(true);
  } finally {
    rmSync(snapshot, { force: true });
    rmSync(file, { force: true });
  }
});

// A retained expired actor file must not claim ownership of this build's disposable snapshots.
test("an expired compatible actor retains its bytes while last-actor cleanup releases known snapshots", async () => {
  const actors = join(location.directory, "code-work", "actors");
  const indexes = join(location.directory, "code-work", "indexes");
  mkdirSync(actors, { recursive: true });
  mkdirSync(indexes, { recursive: true });
  const actor = join(actors, "expired-newer");
  const snapshot = join(indexes, "known.index");
  const text = JSON.stringify({
    pid: process.pid,
    start: null,
    createdAt: 0,
    expiresAt: 1,
    future: true,
  });
  writeFileSync(actor, text);
  writeFileSync(
    snapshot,
    serialize(
      IndexSnapshot.parse({
        tree: "tree",
        chunks: [],
        byId: new Map(),
        byPath: new Map(),
        lengths: new Uint32Array(),
        averageLength: 0,
        postings: new Map(),
        identifierFrequency: new Map(),
        specificThreshold: 0,
        declarations: {
          byPath: new Map(),
          readers: [],
          gaps: [],
          undecided: new Map(),
          asked: new Set(),
        },
        partial: new Set(),
        excluded: {},
        files: 0,
        blobsComputed: 0,
        blobsReused: 0,
        chunksComputed: 0,
        chunksReused: 0,
        buildMs: 0,
      }),
    ),
  );
  try {
    await Effect.runPromise(withCodeWork(location, true, Effect.void));
    expect(readFileSync(actor, "utf8")).toBe(text);
    expect(existsSync(snapshot)).toBe(false);
  } finally {
    rmSync(actor, { force: true });
    rmSync(snapshot, { force: true });
  }
});

// Preservation cannot turn a known dead, expired or reused owner into a blocking review.
test("compatible dead and expired markers keep their bytes without blocking codeCheckpoint", async () => {
  expect(codeOwnerAlive(2147483647)).toBe(false);
  for (const stale of [
    { pid: 2147483647 },
    { expiresAt: Date.now() - 1 },
    ...(codeProcessStart(process.pid) === null
      ? []
      : [{ start: "different process" }]),
  ]) {
    put("stale-newer", { ...stale, future: true });
    const path = join(directory, "stale-newer");
    const before = readFileSync(path, "utf8");
    try {
      expect(reviewPrecomputeActive(location.directory)).toBe(false);
      await Effect.runPromise(
        codeCheckpoint.pipe(
          Effect.provideService(CodeWork, {
            directory: location.directory,
            background: true,
          }),
          Effect.timeout(100),
        ),
      );
      expect(readFileSync(path, "utf8")).toBe(before);
    } finally {
      rmSync(path, { force: true });
    }
  }
  put("live-newer", { future: true });
  try {
    expect(reviewPrecomputeActive(location.directory)).toBe(true);
    const outcome = await Effect.runPromiseExit(
      codeCheckpoint.pipe(
        Effect.provideService(CodeWork, {
          directory: location.directory,
          background: true,
        }),
        Effect.timeout(50),
      ),
    );
    expect(outcome._tag).toBe("Failure");
    expect(existsSync(join(directory, "live-newer"))).toBe(true);
  } finally {
    rmSync(join(directory, "live-newer"), { force: true });
  }
});
