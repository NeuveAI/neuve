// Why: prove Git capture, worker publication and the review's actual Precompute boundary agree.
import { afterAll, expect, test } from "bun:test";
import { z } from "zod";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Context, Effect, Exit, Layer, Option, Scope } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  Blobs,
  Computations,
  Ingest,
  JobQueue,
  Log,
  Store,
  mintUlid,
  resolveStoreLocation,
} from "@neuve/records-core";
import { capturePostRewrite } from "../src/capture/git-hooks.ts";
import {
  commitPrepareHandler,
  prepareCommitManifest,
  prepareCommit,
} from "../../../packages/harness/src/commit-prepare.ts";
import {
  prepareReviewConfig,
  settingsRoute,
} from "../../../packages/harness/src/request.ts";
import { defaultConfig } from "../../../packages/harness/src/config.ts";
import { captureOutlineSource } from "../../../packages/harness/src/graph-outline.ts";
import {
  McpClients,
  mcpClientsLayer,
} from "../../../packages/harness/src/mcp-client.ts";
import { precomputeStage } from "../../../packages/harness/src/pipeline.ts";
import { PreparationPayload } from "@neuve/records-schema";
import { readData } from "@neuve/records-core";
import { DEFAULT_RETRIEVER } from "../../../packages/harness/src/retriever.ts";
import type { RunLogRecord } from "../../../packages/harness/src/run-log.ts";

const root = mkdtempSync(join(tmpdir(), "commit-precompute-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const implementation = resolve(import.meta.dir, "../../..");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const git = (repository: string, ...args: string[]) => {
  const child = Bun.spawnSync(["git", "-C", repository, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-11-17T12:00:00Z",
      GIT_COMMITTER_DATE: "2026-11-17T12:00:00Z",
    },
  });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
  return child.stdout.toString().trim();
};
const setup = async (name: string) => {
  const repository = join(root, name);
  git(root, "init", "-q", repository);
  git(repository, "config", "user.name", "Fixture");
  git(repository, "config", "user.email", "fixture@example.test");
  git(repository, "config", "core.hooksPath", join(repository, ".git/hooks"));
  const commit = (args: string[] = []) => {
    git(repository, "add", ".");
    git(repository, "commit", "-qm", "fixture", ...args);
    return git(repository, "rev-parse", "HEAD");
  };
  const sample = (value: number) => {
    for (let index = 0; index < 8; index++)
      writeFileSync(
        join(repository, `file-${index}.ts`),
        Array.from(
          { length: 40 },
          (_, line) => `export const count${line} = ${value};\n`,
        ).join(""),
      );
  };
  sample(1);
  const baseOid = commit();
  const location = await Effect.runPromise(resolveStoreLocation(repository));
  mkdirSync(location.directory, { recursive: true });
  writeFileSync(
    join(location.directory, "capture.json"),
    JSON.stringify({
      version: 1,
      command: ["/usr/bin/true"],
      hookCommand: [process.execPath],
      gitHooks: ["post-commit", "post-rewrite"],
      agents: [],
      sessionTrailer: false,
    }),
  );
  writeFileSync(
    join(repository, ".git/hooks/post-commit"),
    `#!/bin/sh\nexec ${quote(process.execPath)} --no-env-file ${quote(join(implementation, "apps/neuve-cli/src/hook-main.ts"))} git post-commit\n`,
    { mode: 0o755 },
  );
  sample(2);
  const headOid = commit();
  // The hook spools without opening the database or doing preparation.
  expect(existsSync(location.database)).toBe(false);
  const scope = await Effect.runPromise(Scope.make());
  const records = await Effect.runPromise(
    Layer.buildWithScope(
      Layer.mergeAll(
        JobQueue.layer,
        Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
      ).pipe(
        Layer.provideMerge(Store.layer(location, { create: true })),
        Layer.provideMerge(BunFileSystem.layer),
      ),
      scope,
    ),
  );
  const run = <A, E>(
    work: Effect.Effect<
      A,
      E,
      typeof records extends Context.Context<infer R> ? R : never
    >,
  ) => Effect.runPromise(work.pipe(Effect.provide(records)));
  await run(Store.prepareForWrite);
  const input = {
    oid: headOid,
    tree: git(repository, "rev-parse", `${headOid}^{tree}`),
    parents: [baseOid],
  };
  const handler = commitPrepareHandler({
    repository,
    location,
    command: [
      process.execPath,
      "--no-env-file",
      join(implementation, "apps/neuve-cli/src/cli.ts"),
    ],
  });
  const drain = (children = false) =>
    run(
      Effect.gen(function* () {
        const queue = yield* JobQueue.JobQueue;
        let count = 0;
        for (;;) {
          const job = yield* queue.take(["commit.prepare", "commit.prepare@2"]);
          if (Option.isNone(job)) break;
          if (children) yield* handler(job.value);
          else {
            const event =
              job.value.eventId === null
                ? undefined
                : Option.getOrUndefined(yield* Log.get(job.value.eventId))
                    ?.event;
            if (event?.kind === "commit.rewritten@1") yield* handler(job.value);
            else {
              const input =
                event?.kind === "commit.recorded@1"
                  ? event.payload
                  : readData(PreparationPayload, job.value.payload);
              const commit =
                "oid" in input
                  ? input
                  : input.kind === "commit"
                    ? input.commit
                    : undefined;
              if (commit === undefined)
                throw new Error("Expected a commit job");
              yield* prepareCommit(
                { repository, retriever: DEFAULT_RETRIEVER },
                commit,
              );
            }
          }
          yield* queue.complete(job.value.seq, job.value.attempts);
          count++;
        }
        return count;
      }),
    );
  const integrations = { status: "absent", path: "(none)" } as const;
  const clients = Context.get(
    await Effect.runPromise(
      Layer.buildWithScope(mcpClientsLayer(integrations), scope),
    ),
    McpClients,
  );
  const review = async (head = headOid, ordinary = false, base = baseOid) => {
    const config = ordinary
      ? await run(prepareReviewConfig({ location, route: settingsRoute() }))
      : defaultConfig();
    const log: RunLogRecord[] = [];
    const started = performance.now();
    const stage = await precomputeStage(
      {
        repository,
        location,
        records,
        runId: mintUlid(),
        runKey: "f".repeat(64),
        cycleId: mintUlid(),
        reconciliationId: mintUlid(),
        startedAt: Date.now(),
        range: { baseRef: "main", baseOid: base, headOid: head },
        config,
        log: {
          path: "(memory)",
          write: (record) => {
            log.push(record);
          },
          read: () => log,
        },
      },
      { integrations, clients },
    ).pipe(Effect.provide(records), Effect.runPromise);
    return { stage, log, ms: performance.now() - started };
  };
  const attempts = () =>
    run(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        return yield* sql<{
          op: string;
          n: number;
        }>`SELECT op, count(*) AS n FROM computation_attempts GROUP BY op ORDER BY op`;
      }),
    );
  const close = () => Effect.runPromise(Scope.close(scope, Exit.void));
  return {
    repository,
    location,
    run,
    input,
    baseOid,
    headOid,
    sample,
    commit,
    drain,
    review,
    attempts,
    close,
  };
};

test("a real post-commit hook enqueues one job and preparation output is reused by review", async () => {
  const cold = await setup("cold");
  const prepared = await setup("prepared");
  try {
    expect(prepared.headOid).toBe(cold.headOid);
    const baseline = await cold.review();
    expect(
      baseline.log.find((r) => r.type === "precompute.manifest")?.status,
    ).toBe("computed");
    const report = await prepared.run(Ingest.ingestSpool(prepared.location));
    expect(report.rejected).toEqual([]);
    const jobs = await prepared.run(
      Effect.flatMap(JobQueue.JobQueue, (queue) =>
        queue.list({ states: ["waiting"], limit: 100 }),
      ),
    );
    expect(
      jobs
        .filter((job) => job.kind === "commit.prepare")
        .map((job) => job.dedupeKey),
    ).toEqual([`commit.prepare:${prepared.headOid}`]);
    expect(await prepared.drain()).toBe(1);
    const before = await prepared.attempts();
    const warmed = await prepared.review();
    expect(
      warmed.log.find((r) => r.type === "precompute.manifest")?.status,
    ).toBe("reused");
    expect(warmed.stage.status).toBe("computed");
    expect(
      (await prepared.attempts()).filter(
        (row) =>
          row.op === "harness.range-manifest" ||
          row.op === "harness.file-hunks",
      ),
    ).toEqual(
      before.filter(
        (row) =>
          row.op === "harness.range-manifest" ||
          row.op === "harness.file-hunks",
      ),
    );
    const storage = await prepared.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        return yield* sql<{
          size: number;
        }>`SELECT blobs.size FROM computations JOIN blobs ON blobs.hash = computations.output_hash WHERE computations.op = 'harness.range-manifest'`;
      }),
    );
    const measurement = {
      files: 8,
      headOid: prepared.headOid,
      manifestBytes: storage[0]?.size,
      workerBodyInProcess: true,
      coldMs: baseline.ms,
      preparedMs: warmed.ms,
      savedMs: baseline.ms - warmed.ms,
      manifestStatus: "reused",
    };
    if (process.env.NEUVE_PRECOMPUTE_MEASUREMENT)
      writeFileSync(
        process.env.NEUVE_PRECOMPUTE_MEASUREMENT,
        JSON.stringify(measurement, null, 2),
      );
  } finally {
    await cold.close();
    await prepared.close();
  }
}, 120_000);

test("concurrent triggers and subscribers produce one manifest attempt, and repeated or empty work adds none", async () => {
  const fixture = await setup("concurrent");
  try {
    await fixture.run(Ingest.ingestSpool(fixture.location));
    const event = await fixture.run(
      Effect.map(
        Log.history({ kind: "commit.recorded@1", limit: 100 }),
        (rows) => rows[0]!.event,
      ),
    );
    await Promise.all(
      Array.from({ length: 4 }, () => fixture.run(Log.append([event]))),
    );
    const results = await fixture.run(
      Effect.all(
        Array.from({ length: 4 }, () =>
          prepareCommitManifest(
            fixture.repository,
            fixture.input,
            captureOutlineSource(),
          ),
        ),
        { concurrency: "unbounded" },
      ),
    );
    expect(results.every(Option.isSome)).toBe(true);
    expect(
      new Set(results.map((result) => Option.getOrThrow(result).key)).size,
    ).toBe(1);
    expect(
      (await fixture.attempts()).find(
        (row) => row.op === "harness.range-manifest",
      )?.n,
    ).toBe(1);
    const before = await fixture.attempts();
    await fixture.run(
      prepareCommitManifest(
        fixture.repository,
        fixture.input,
        captureOutlineSource(),
      ),
    );
    const empty = fixture.commit(["--allow-empty"]);
    const noWork = await fixture.run(
      prepareCommitManifest(
        fixture.repository,
        { oid: empty, parents: [fixture.headOid], tree: fixture.input.tree },
        captureOutlineSource(),
      ),
    );
    expect(Option.isNone(noWork)).toBe(true);
    const rootCommit = await fixture.run(
      prepareCommitManifest(
        fixture.repository,
        {
          oid: fixture.baseOid,
          tree: git(
            fixture.repository,
            "rev-parse",
            `${fixture.baseOid}^{tree}`,
          ),
          parents: [],
        },
        captureOutlineSource(),
      ),
    );
    expect(Option.isNone(rootCommit)).toBe(true);
    expect(await fixture.attempts()).toEqual(before);
    const queue = await fixture.run(
      Effect.flatMap(JobQueue.JobQueue, (queue) =>
        queue.list({ states: ["waiting"], limit: 100 }),
      ),
    );
    expect(queue.filter((job) => job.kind === "commit.prepare")).toHaveLength(
      1,
    );
  } finally {
    await fixture.close();
  }
}, 120_000);

test.each(["amend", "rebase"])(
  "%s capture discovers replacements without post-commit and review uses the new manifest",
  async (rewrite) => {
    const fixture = await setup(`rewrite-${rewrite}`);
    try {
      await fixture.run(Ingest.ingestSpool(fixture.location));
      await fixture.drain();
      const old = await fixture.review();
      const oldKey = old.log.find((r) => r.type === "precompute.manifest")?.key;
      // Some rewrite paths do not call post-commit. Exercise that path explicitly.
      git(fixture.repository, "config", "core.hooksPath", "/dev/null");
      let replacement: string;
      let reviewBase = fixture.baseOid;
      if (rewrite === "amend") {
        fixture.sample(3);
        replacement = fixture.commit(["--amend"]);
      } else {
        git(
          fixture.repository,
          "checkout",
          "-qb",
          "rewritten-base",
          fixture.baseOid,
        );
        writeFileSync(
          join(fixture.repository, "base-context.md"),
          "New base context.\n",
        );
        reviewBase = fixture.commit();
        git(fixture.repository, "checkout", "-q", "--detach", fixture.headOid);
        git(
          fixture.repository,
          "rebase",
          "--onto",
          reviewBase,
          fixture.baseOid,
        );
        replacement = git(fixture.repository, "rev-parse", "HEAD");
      }
      const events = await fixture.run(
        capturePostRewrite(
          fixture.repository,
          fixture.location,
          rewrite,
          `${fixture.headOid} ${replacement}\n`,
          () => undefined,
          {},
        ),
      );
      await fixture.run(Log.append(events));
      expect(await fixture.drain()).toBe(2);
      const next = await fixture.review(replacement, false, reviewBase);
      const manifest = next.log.find((r) => r.type === "precompute.manifest");
      expect(manifest?.status).toBe("reused");
      expect(manifest?.key).not.toBe(oldKey);
      const value = await fixture.run(
        Effect.gen(function* () {
          const store = yield* Computations.ComputationStore;
          const saved = Option.getOrThrow(
            yield* store.lookup(String(manifest?.key)),
          );
          const blobs = yield* Blobs.BlobStore;
          return yield* blobs.get(saved.outputHash);
        }),
      );
      if (value._tag !== "Present")
        throw new Error("Manifest bytes were pruned");
      expect(new TextDecoder().decode(value.bytes)).toContain(
        `+export const count0 = ${rewrite === "amend" ? 3 : 2};`,
      );
    } finally {
      await fixture.close();
    }
  },
  120_000,
);

// Match the existing priority tests: restricted systems cannot run the worker's nice-19 child.
const priorityProbe = Bun.spawnSync([
  "/usr/bin/nice",
  "-n",
  "10",
  process.execPath,
  "-e",
  'import {getPriority} from "node:os"; process.stdout.write(String(getPriority()));',
]);
const canLowerPriority =
  priorityProbe.exitCode === 0 && Number(priorityProbe.stdout.toString()) >= 10;
test.skipIf(!canLowerPriority)(
  "the hook job publishes from the real worker child before review",
  async () => {
    const fixture = await setup("worker-child");
    try {
      await fixture.run(Ingest.ingestSpool(fixture.location));
      expect(await fixture.drain(true)).toBe(1);
      expect(
        (await fixture.review(undefined, true)).log.find(
          (r) => r.type === "precompute.manifest",
        )?.status,
      ).toBe("reused");
    } finally {
      await fixture.close();
    }
  },
  120_000,
);

test("preparation resolves the same local settings as an ordinary review", async () => {
  const fixture = await setup("ordinary-review");
  try {
    const manifest = await fixture.run(
      prepareCommitManifest(
        fixture.repository,
        fixture.input,
        captureOutlineSource(),
        fixture.location.directory,
      ),
    );
    expect(Option.isSome(manifest)).toBe(true);
    const review = await fixture.review(undefined, true);
    const recorded = review.log.find((r) => r.type === "precompute.manifest");
    expect(recorded?.status).toBe("reused");
    expect(recorded?.key).toBe(Option.getOrThrow(manifest).key);
  } finally {
    await fixture.close();
  }
}, 120_000);

// Separate OS processes must receive the same publication through the existing budget host.
test("concurrent processes subscribe to one manifest computation", async () => {
  const fixture = await setup("processes");
  const directory = join(root, "claims");
  mkdirSync(directory, { mode: 0o700 });
  const { hostBudget } =
    await import("../../../packages/harness/src/budget/local.ts");
  const host = await hostBudget({ directory, threads: 2, fixed: 4 });
  if (!host) {
    await fixture.close();
    throw new Error("Budget host was not elected");
  }
  await host.claims.ready;
  try {
    const results = await Promise.all(
      Array.from({ length: 3 }, async () => {
        const child = Bun.spawn(
          [
            process.execPath,
            "--no-env-file",
            join(import.meta.dir, "fixtures/commit-manifest.ts"),
            fixture.repository,
            dirname(fixture.location.directory),
            JSON.stringify({ kind: "commit", commit: fixture.input }),
          ],
          {
            env: { ...process.env, NEUVE_BUDGET_DIRECTORY: directory },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [stdout, stderr, code] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(code, stderr).toBe(0);
        expect(stderr).not.toContain('"type":"shared-work.floor"');
        const line = stdout
          .split("\n")
          .find((line) => line.startsWith("manifest-result "));
        return readData(
          z.strictObject({
            key: z.string(),
            status: z.enum(["computed", "reused", "shared"]),
          }),
          JSON.parse((line ?? "").slice("manifest-result ".length)),
        );
      }),
    );
    expect(new Set(results.map((result) => result.key)).size).toBe(1);
    expect(
      results.filter((result) => result.status === "computed"),
    ).toHaveLength(1);
    expect(
      (await fixture.attempts()).find(
        (row) => row.op === "harness.range-manifest",
      )?.n,
    ).toBe(1);
  } finally {
    await host.close();
    await fixture.close();
  }
}, 120_000);
