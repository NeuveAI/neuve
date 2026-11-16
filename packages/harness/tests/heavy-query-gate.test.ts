// Starts use the real worker gate even when no chunk encoding warmed the query process.
import { expect, test } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { Effect } from "effect";
import {
  JobQueue,
  Computations,
  Worker,
  storeLocationIn,
} from "@neuve/records-core";
import { hybridWorkers, closeHybridWorkers } from "../src/hybrid-models.ts";
import { prepareBase } from "../src/graph-search.ts";
import { runIn, value } from "./pi/capture/fixture.ts";

for (const kind of ["query", "graph"] as const)
  test(`${kind} launches only after the real review gate opens`, async () => {
    const root = mkdtempSync(join(tmpdir(), "heavy-query-gate-"));
    const location = storeLocationIn(join(root, "store"));
    const marker = join(root, "spawned");
    const executable = join(root, "fake-process");
    writeFileSync(
      executable,
      `#!/bin/sh\necho started >> '${marker}'\nexit 1\n`,
    );
    chmodSync(executable, 0o755);
    const worker = join(root, "worker.py");
    writeFileSync(worker, "pass\n");
    const sha = createHash("sha256").update(readFileSync(worker)).digest("hex");
    const e0 = {
      python: executable,
      snapshot: root,
      worker,
      vectorStore: root,
    };
    const graph = { executable, workDirectory: join(root, "graph") };
    const repo = join(root, "repo");
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], {
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
        },
      });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    git("init", "-q", repo);
    git(
      "-C",
      repo,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.test",
      "commit",
      "--allow-empty",
      "-qm",
      "first",
    );
    const oid = git("-C", repo, "rev-parse", "HEAD");
    let duringReview = false;
    try {
      const exit = value(
        await runIn(location)(
          Effect.gen(function* () {
            const queue = yield* JobQueue.JobQueue;
            yield* queue.enqueue({ kind: "review.run", dedupeKey: "r" });
            yield* queue.enqueue({
              kind: "commit.hybrid",
              dedupeKey: "h",
              payload: {
                oid,
                tree: git("-C", repo, "rev-parse", "HEAD^{tree}"),
                parents: [],
              },
            });
            return yield* Worker.run({
              location,
              idleTimeout: "100 millis",
              pollInterval: "10 millis",
              handlers: {
                "review.run": () =>
                  Effect.gen(function* () {
                    yield* Effect.sleep("700 millis");
                    duringReview =
                      existsSync(marker) ||
                      (kind === "graph" &&
                        existsSync(join(graph.workDirectory, "clones")));
                  }),
                "commit.hybrid": () =>
                  Effect.gen(function* () {
                    yield* Effect.sleep("100 millis");
                    if (kind === "query") {
                      const workers = yield* hybridWorkers({
                        runtime: {
                          prepare: true,
                          device: "cpu",
                          models: 2,
                          e0,
                          graph,
                          limits: { minFreeDiskBytes: 0, maxSwapUsedBytes: 0 },
                          reranker: {
                            snapshot: root,
                            worker,
                            workerSha256: sha,
                          },
                        },
                        e0,
                      });
                      if (workers.encodeQuery === undefined)
                        return yield* Effect.die("missing query port");
                      yield* Effect.promise(() => workers.encodeQuery!("x"));
                    } else {
                      yield* prepareBase(
                        repo,
                        oid,
                        graph,
                        "0".repeat(64),
                        () => false,
                      ).pipe(Effect.catch(() => Effect.void));
                    }
                  }),
              },
            });
          }).pipe(
            Effect.provide(JobQueue.layer),
            Effect.provide(Computations.layer),
          ),
        ),
      );
      expect(exit.reason).toBe("idle");
      expect(duringReview).toBe(false);
      expect(existsSync(marker)).toBe(true);
    } finally {
      await Effect.runPromise(closeHybridWorkers);
      rmSync(root, { recursive: true, force: true });
    }
  }, 15000);
