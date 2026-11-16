// Why: the store's one Graph cache is bounded (10.115) and keeps only what is declared or recently
// used, and `cache declare` replaces the whole declared set, so the worker's declaration must name
// every base still needed (the merge base of each review waiting, delayed or running, each active
// branch's merge base, the first parent of each commit preparation pending or ended today) and none
// that ended or went stale. A base left out is evicted under pressure and prepared again by the next
// review; one kept for nothing holds the store's room. Graph refuses a declaration naming a commit
// it cannot find, and a failed look must be tried again soon, not after the next change to Records.
// This runs against the real engine's `cache declare`, where it is built (`bun run build:graph`).
import { afterAll, expect, test } from "bun:test";
import { graphTestPrerequisite } from "../../../scripts/graph-test-prerequisite.ts";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer, Option } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { Store, storeLocationIn } from "@neuve/records-core";
import {
  DECLARE_INTERVAL_MS,
  graphBases,
  graphBasesTurn,
} from "../src/graph-declare.ts";
import { Settings } from "../src/settings.ts";

const engine = resolve(
  import.meta.dir,
  "../../../apps/neuve-graph/entire-graph",
);
const directory = mkdtempSync(join(tmpdir(), "harness-graph-declare-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
/** An engine built before Graph's bounded store has no `cache` command. */
const declares =
  existsSync(engine) &&
  Bun.spawnSync([
    engine,
    "cache",
    "usage",
    "--cache-dir",
    join(directory, "probe"),
  ]).exitCode === 0;
const repository = join(directory, "repo");
const origin = join(directory, "origin.git");

const quiet = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
const git = (...args: Array<string>) => {
  const result = Bun.spawnSync(["git", "-C", repository, ...args], {
    env: quiet,
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};
const commit = (file: string, date?: string) => {
  writeFileSync(join(repository, file), `${file}\n`);
  git("add", "-A");
  const result = Bun.spawnSync(
    [
      "git",
      "-C",
      repository,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.test",
      "commit",
      "-q",
      "-m",
      file,
    ],
    {
      env: {
        ...quiet,
        ...(date === undefined
          ? {}
          : { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date }),
      },
    },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return git("rev-parse", "HEAD");
};

const graphPrerequisite = graphTestPrerequisite({
  available: declares,
  message:
    "Graph engine is missing or stale: apps/neuve-graph/entire-graph must support `cache usage`. Run `bun run build:graph` from the workspace root.",
});

test.skipIf(graphPrerequisite.skip)(
  "the worker declares the bases still needed, none that ended, and looks again after a failure",
  async () => {
    graphPrerequisite.require();
    Bun.spawnSync(["git", "init", "-q", "-b", "main", repository]);
    Bun.spawnSync(["git", "init", "-q", "--bare", origin]);
    const c1 = commit("one");
    const c2 = commit("two");
    git("remote", "add", "origin", origin);
    git("push", "-q", "-u", "origin", "main");
    // main is ahead of its upstream: its own base is origin's main, c2.
    const c3 = commit("three");
    const c4 = commit("four");
    const c5 = commit("five");
    const c6 = commit("six");
    const c7 = commit("seven");
    git("checkout", "-q", "-b", "feature", c1);
    const f1 = commit("feature");
    // A branch with no commit in the last 14 days is not active.
    git("checkout", "-q", "-b", "stale", c6);
    commit("stale", "2020-01-01T00:00:00Z");
    git("checkout", "-q", "main");
    const location = storeLocationIn(join(repository, ".git"));
    const day = 24 * 60 * 60_000;
    const now = Date.now();
    const insert = (
      seq: number,
      kind: string,
      state: string,
      envelope: object,
      finishedAt?: number,
    ) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const at = new Date(now).toISOString();
        yield* sql`INSERT INTO events (id, kind, idempotency_key, fingerprint, actor_id, occurred_at, recorded_at, envelope)
          VALUES (${`event-${seq}`}, ${kind === "review.run" ? "review.requested@1" : "commit.recorded@1"}, ${`key-${seq}`}, ${"f"}, ${"actor"}, ${at}, ${at}, ${JSON.stringify(envelope)})`;
        yield* sql`INSERT INTO jobs (kind, dedupe_key, event_id, state, finished_at)
          VALUES (${kind}, ${`${kind}:${seq}`}, ${`event-${seq}`}, ${state}, ${finishedAt === undefined ? null : new Date(finishedAt).toISOString()})`;
      });
    const range = (baseOid: string, headOid: string) => ({
      attribution: { range: { baseRef: "main", baseOid, headOid } },
    });
    const prepared = (oid: string, parent: string) => ({
      payload: { oid, parents: [parent] },
    });
    const graphSettings = Option.some(
      Settings.parse({
        version: 1,
        search: { graph: { executable: engine }, leads: "graph" },
      }),
    );
    let reads = 0;
    let failing = false;
    const settings = () => {
      reads++;
      if (failing) throw new Error("settings unreadable");
      return graphSettings;
    };
    const declaredFile = join(
      location.directory,
      "graph/cache/cache-store/declared-v1.json",
    );
    // c2 is main's own base, against its upstream.
    const expected = [c1, c2, c3, c4, c5, f1].sort();
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(now);
        yield* Store.prepareForWrite;
        // Waiting, delayed and running reviews keep their bases (c3, c4, c5); one that ended
        // does not (c6).
        yield* insert(1, "review.run", "waiting", range(c3, c7));
        yield* insert(2, "review.run", "delayed", range(c4, c7));
        yield* insert(3, "review.run", "active", range(c5, c7));
        yield* insert(4, "review.run", "completed", range(c6, c7), now);
        // A preparation that ended today keeps its parent (f1, which nothing else keeps); one that
        // ended three days ago does not (c6), nor one whose parent the repository does not have.
        yield* insert(5, "commit.prepare", "completed", prepared(c3, f1), now);
        yield* insert(
          6,
          "commit.prepare",
          "completed",
          prepared(c7, c6),
          now - 3 * day,
        );
        yield* insert(
          7,
          "commit.prepare",
          "waiting",
          prepared(c7, "a".repeat(40)),
        );
        // c1 is the feature branch's merge base; the stale branch's (c6) is not looked at.
        expect(yield* graphBases(repository)).toEqual(expected);

        // Without a Graph engine in the settings, nothing is declared.
        yield* graphBasesTurn(location, repository, () => Option.none());
        expect(existsSync(declaredFile)).toBe(false);

        const turn = graphBasesTurn(location, repository, settings);
        // A look that fails is tried again at the next interval, with Records unchanged.
        failing = true;
        yield* Effect.flip(turn);
        failing = false;
        yield* TestClock.setTime(now + DECLARE_INTERVAL_MS / 2);
        yield* turn;
        expect(reads).toBe(1);
        yield* TestClock.setTime(now + DECLARE_INTERVAL_MS);
        yield* turn;
        expect(reads).toBe(2);
        // With Records unchanged within the refresh period, a later turn looks at nothing.
        yield* TestClock.setTime(now + 2 * DECLARE_INTERVAL_MS);
        yield* turn;
        expect(reads).toBe(2);
      }).pipe(
        Effect.provide(
          Layer.merge(
            Store.layer(location, { create: true }),
            TestClock.layer(),
          ),
        ),
        Effect.provide(BunFileSystem.layer),
      ),
    );
    // Graph's own record of what it keeps (its declared set, by Graph's file name).
    const declared = JSON.parse(await Bun.file(declaredFile).text()) as {
      commits: Array<string>;
    };
    expect(declared.commits.sort()).toEqual(expected);
  },
);
