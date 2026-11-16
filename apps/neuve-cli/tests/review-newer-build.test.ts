// Why (8.19): `neuve review` from main on a range a newer build reviewed under its own job kind
// (`review.run@3`) must say what is true. After that run failed or ended with gaps it queues the
// next generation as main's own job; while the newer build's job waits it says that build runs it;
// once that build's run completed the review it says the range was already reviewed. Scratch
// repository, scratch HOME and no model credentials, so no worker starts.
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer } from "effect";
import { Config } from "@neuve/harness";
import {
  Blobs,
  Computations,
  Store,
  resolveStoreLocation,
} from "@neuve/records-core";
import { markSetUp } from "./fixtures/set-up.ts";

const CLI = resolve(import.meta.dir, "../src/cli.ts");

const directories: Array<string> = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

const scratch = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "neuve-newer-")));
  directories.push(root);
  const repo = join(root, "repo");
  const home = join(root, "home");
  await mkdir(home);
  Bun.spawnSync(["git", "init", "-q", repo]);
  for (const [key, value] of [
    ["user.email", "dev@example.com"],
    ["user.name", "Dev"],
  ])
    Bun.spawnSync(["git", "-C", repo, "config", key!, value!]);
  for (const text of ["a\n", "b\n"]) {
    await writeFile(join(repo, "a"), text);
    Bun.spawnSync(["git", "-C", repo, "add", "a"]);
    Bun.spawnSync(["git", "-C", repo, "commit", "-qm", text.trim()]);
  }
  // `neuve review` refuses a repository until setup has run there.
  await markSetUp(repo);
  const location = await Effect.runPromise(resolveStoreLocation(repo));
  return { repo, home, location };
};

const review = (home: string, repo: string) => {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
  };
  for (const name of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "NEUVE_OPENAI_TOKEN_COMMAND",
  ])
    delete env[name];
  const result = Bun.spawnSync(
    [
      process.execPath,
      CLI,
      "review",
      "HEAD~1..HEAD",
      "--detach",
      "--repo",
      repo,
    ],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};

/** The first request's job handed to the newer build, in `state`. */
const handOver = (database: string, state: string) => {
  const db = new Database(database);
  try {
    db.run(
      `UPDATE jobs SET kind = 'review.run@3', state = '${state}', attempts = 1 WHERE kind = 'review.run@2'`,
    );
    return db
      .query<{ envelope: string }, []>(
        "SELECT envelope FROM events WHERE kind = 'review.requested@1'",
      )
      .get()!;
  } finally {
    db.close();
  }
};

const reviewJobs = (database: string) => {
  const db = new Database(database);
  try {
    return db
      .query<{ jobSeq: number; kind: string; key: string }, []>(
        "SELECT job_seq AS jobSeq, kind, dedupe_key AS key FROM jobs WHERE dedupe_key LIKE 'review.run:%' ORDER BY job_seq",
      )
      .all()
      .map((row) => [row.kind, row.key.split(":").at(-1)]);
  } finally {
    db.close();
  }
};

test("after the newer build's run failed or ended with gaps, main's review queues the next generation", async () => {
  for (const state of ["failed", "completed"]) {
    const { repo, home, location } = await scratch();
    expect(review(home, repo).code).toBe(0);
    handOver(location.database, state);
    const again = review(home, repo);
    expect({ state, code: again.code }).toEqual({ state, code: 0 });
    expect(again.stdout).toContain("review.run (waiting)");
    expect(again.stdout).toContain("generation 1.");
    expect(reviewJobs(location.database)).toEqual([
      ["review.run@3", "0"],
      ["review.run@2", "1"],
    ]);
  }
}, 120_000);

test("main's review joins the newer build's job only while it waits, or once its run completed", async () => {
  const waiting = await scratch();
  expect(review(waiting.home, waiting.repo).code).toBe(0);
  handOver(waiting.location.database, "waiting");
  const joined = review(waiting.home, waiting.repo);
  expect(joined.code).toBe(0);
  expect(joined.stdout).toContain(
    "review.run@3 (waiting) is a newer build's, and that build's worker runs it",
  );
  expect(reviewJobs(waiting.location.database)).toEqual([
    ["review.run@3", "0"],
  ]);

  const completed = await scratch();
  expect(review(completed.home, completed.repo).code).toBe(0);
  const { envelope } = handOver(completed.location.database, "completed");
  const event = JSON.parse(envelope) as {
    id: string;
    attribution: { range: Parameters<typeof Config.runSpec>[0] };
    payload: { pipeline: { config: Parameters<typeof Config.runSpec>[1] } };
  };
  // The newer build's run stored its completion as a worker does.
  await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* Computations.ComputationStore;
      yield* store.run(
        Config.runSpec(event.attribution.range, event.payload.pipeline.config),
        Effect.succeed({
          bytes: new TextEncoder().encode(
            JSON.stringify({ runId: event.id, generation: 0, jobSeq: 1 }),
          ),
          mediaType: "application/json",
        }),
      );
    }).pipe(
      Effect.provide(
        Computations.layer.pipe(
          Layer.provideMerge(Blobs.layer(completed.location)),
        ),
      ),
      Effect.provide(Store.layer(completed.location, { create: false })),
      Effect.provide(BunFileSystem.layer),
    ),
  );
  const reviewed = review(completed.home, completed.repo);
  expect(reviewed.code).toBe(0);
  expect(reviewed.stdout).toContain(
    "review.run@3 (completed) is a newer build's, which already reviewed this range and configuration",
  );
  expect(reviewJobs(completed.location.database)).toEqual([
    ["review.run@3", "0"],
  ]);
}, 120_000);

// The CLI must keep JSON stdout usable when a newer worker adds receipt fields.
test("review show reads a newer stored receipt and discloses compatibility once on stderr", async () => {
  const { Receipt } = await import("@neuve/harness");
  const { canonicalJson, mintUlid } = await import("@neuve/records-core");
  const { fingerprintOf } =
    await import("../../../packages/records-core/src/codec.ts");
  const { repo, home, location } = await scratch();
  await Effect.runPromise(
    Store.prepareForWrite.pipe(
      Effect.provide(Store.layer(location, { create: true })),
      Effect.provide(BunFileSystem.layer),
    ),
  );
  const runId = mintUlid();
  const receipt = Receipt.buildReceipt({
    runId,
    runKey: "f".repeat(64),
    generation: 0,
    jobSeq: 1,
    range: {
      baseRef: "main",
      baseOid: "a".repeat(40),
      headOid: "b".repeat(40),
    },
    cycleId: mintUlid(),
    config: Config.defaultConfig(),
    enqueuedAt: "2026-11-01T00:00:00.000Z",
    startedAt: Date.parse("2026-11-01T00:00:01.000Z"),
    endedAt: Date.parse("2026-11-01T00:00:02.000Z"),
    stages: [],
    records: [],
  });
  const { type: _type, runId: _run, cycleId, range, ...payload } = receipt;
  const event = {
    id: mintUlid(),
    kind: "run.completed@1",
    idempotencyKey: `cli-newer:${runId}`,
    actor: "a".repeat(64),
    occurredAt: "2026-11-01T00:00:02.000Z",
    attribution: { runId, cycleId, range, stage: "publish" },
    payload: { ...payload, route: { ...payload.route, futureConcurrency: 8 } },
    futureEnvelope: true,
  };
  const envelope = canonicalJson(event);
  const db = new Database(location.database);
  try {
    db.run(
      "INSERT INTO events(id,kind,idempotency_key,fingerprint,actor_id,occurred_at,recorded_at,envelope) VALUES(?,?,?,?,?,?,?,?)",
      [
        event.id,
        event.kind,
        event.idempotencyKey,
        fingerprintOf(event),
        event.actor,
        event.occurredAt,
        event.occurredAt,
        envelope,
      ],
    );
    const result = Bun.spawnSync(
      [
        process.execPath,
        "--no-env-file",
        CLI,
        "review",
        "show",
        "--run",
        runId,
        "--json",
        "--repo",
        repo,
      ],
      { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" },
    );
    expect(result.exitCode).toBe(0);
    const output = JSON.parse(result.stdout.toString());
    expect(output.runId).toBe(runId);
    expect(output.route).toEqual(receipt.route);
    const notices = result.stderr
      .toString()
      .split("\n")
      .filter((line) => line.includes("compatibility mode"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("payload.route.futureConcurrency");
    expect(
      db
        .query<{ envelope: string }, [string]>(
          "SELECT envelope FROM events WHERE id=?",
        )
        .get(event.id)?.envelope,
    ).toBe(envelope);
  } finally {
    db.close();
  }
}, 60_000);
