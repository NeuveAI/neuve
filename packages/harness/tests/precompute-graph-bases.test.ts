// Why: hookless jobs have no commit event. Graph retention must use their payloads,
// including ranges, and forget finished preparation after the retention period.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  JobQueue,
  Store,
  storeLocationIn,
  mintUlid,
} from "@neuve/records-core";
import { graphBases } from "../src/graph-declare.ts";
const root = mkdtempSync(join(tmpdir(), "hookless-graph-bases-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const repo = join(root, "repo");
Bun.spawnSync(["git", "init", "-q", "-b", "feature", repo]);
const git = (...args: string[]) => {
  const r = Bun.spawnSync([
    "git",
    "-c",
    "core.hooksPath=/dev/null",
    "-C",
    repo,
    ...args,
  ]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString().trim();
};
const commits = Array.from({ length: 4 }, (_, n) => {
  writeFileSync(join(repo, "file.ts"), `export const n = ${n};\n`);
  git("add", ".");
  git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.test",
    "commit",
    "-qm",
    `fixture ${n}`,
  );
  return git("rev-parse", "HEAD");
});

test("hookless commit, range and discovery jobs retain their bases until they expire", async () => {
  const location = storeLocationIn(join(root, "store"));
  const [first, second, third, head] = commits;
  if (!first || !second || !third || !head)
    throw new Error("Missing fixture commits");
  const result = await Effect.runPromise(
    Effect.andThen(
      Store.prepareForWrite,
      Effect.gen(function* () {
        const queue = yield* JobQueue.JobQueue;
        const sql = yield* SqlClient;
        yield* queue.enqueue({
          kind: "commit.prepare@2",
          dedupeKey: "commit",
          payload: {
            kind: "commit",
            commit: {
              oid: second,
              tree: git("rev-parse", `${second}^{tree}`),
              parents: [first],
            },
          },
        });
        yield* queue.enqueue({
          kind: "commit.prepare@2",
          dedupeKey: "range",
          payload: { kind: "range", range: { baseOid: second, headOid: head } },
        });
        yield* queue.enqueue({
          kind: "commit.prepare@2",
          dedupeKey: "gone",
          payload: {
            kind: "commit",
            commit: {
              oid: head,
              tree: git("rev-parse", `${head}^{tree}`),
              parents: ["f".repeat(40)],
            },
          },
        });
        const eventId = mintUlid();
        yield* sql`INSERT INTO events (id, kind, idempotency_key, fingerprint, actor_id, occurred_at, recorded_at, envelope)
      VALUES (${eventId}, 'review.requested@1', ${eventId}, 'fixture', 'fixture', '2026-11-01', '2026-11-01', ${JSON.stringify({ attribution: { range: { baseOid: third, headOid: head } } })})`;
        yield* queue.enqueue({
          kind: "commit.prepare@2",
          dedupeKey: "discover",
          eventId,
        });
        const pending = yield* graphBases(repo);
        yield* sql`UPDATE jobs SET state = 'completed', finished_at = ${new Date().toISOString()}`;
        const recent = yield* graphBases(repo);
        yield* sql`UPDATE jobs SET finished_at = '2000-01-01T00:00:00.000Z'`;
        return { pending, recent, expired: yield* graphBases(repo) };
      }),
    ).pipe(
      Effect.provide(JobQueue.layer),
      Effect.provide(Store.layer(location, { create: true })),
      Effect.provide(BunFileSystem.layer),
    ),
  );
  expect(result.pending).toEqual([first, second, third].sort());
  expect(result.recent).toEqual(result.pending);
  expect(result.expired).toEqual([]);
});
