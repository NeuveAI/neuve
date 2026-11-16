import { CpuWork } from "../../src/budget/cpu.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { Effect } from "effect";
import {
  JobQueue,
  Computations,
  Worker,
  storeLocationIn,
} from "@neuve/records-core";
import { commitHybridHandler } from "../../src/commit-hybrid.ts";
import { graphSearchesInFlight } from "../../src/graph-search.ts";
import { runIn, value } from "../pi/capture/fixture.ts";
const input = z
  .strictObject({
    root: z.string(),
    repo: z.string(),
    oid: z.string(),
    parent: z.string(),
    tree: z.string(),
    marker: z.string(),
  })
  .parse(JSON.parse(process.argv[2] ?? "{}"));
const location = storeLocationIn(join(input.root, "store"));
let cpuPriority: string | undefined;
let duringReview = false,
  setups = 0,
  modelCalls = 0;
const exit = value(
  await runIn(location)(
    Effect.gen(function* () {
      const queue = yield* JobQueue.JobQueue;
      yield* queue.enqueue({ kind: "review.run", dedupeKey: "review" });
      yield* queue.enqueue({
        kind: "commit.hybrid",
        dedupeKey: "hybrid",
        payload: { oid: input.oid, tree: input.tree, parents: [input.parent] },
      });
      const result = yield* Worker.run({
        location,
        idleTimeout: "100 millis",
        pollInterval: "10 millis",
        handlers: {
          "review.run": () =>
            Effect.gen(function* () {
              yield* Effect.sleep("700 millis");
              duringReview =
                existsSync(input.marker) ||
                existsSync(join(location.directory, "graph", "clones"));
            }),
          "commit.hybrid": commitHybridHandler({
            repository: input.repo,
            storeDirectory: location.directory,
            workers: () => {
              setups++;
              return Effect.gen(function* () {
                const cpu = yield* Effect.serviceOption(CpuWork);
                cpuPriority =
                  cpu._tag === "Some" ? cpu.value.priority.class : undefined;
                return {
                  encoder: {
                    device: "cpu",
                    workerSha256: "a".repeat(64),
                    encode: () => {
                      modelCalls++;
                      return Effect.die("empty tree must not encode");
                    },
                  },
                  reranker: {
                    device: "cpu",
                    workerSha256: "b".repeat(64),
                    score: () => {
                      modelCalls++;
                      return Effect.die("empty diff must not rerank");
                    },
                  },
                };
              });
            },
          }),
        },
      });
      for (let n = 0; (yield* graphSearchesInFlight) > 0 && n < 200; n++)
        yield* Effect.sleep("25 millis");
      return result;
    }).pipe(Effect.provide(JobQueue.layer), Effect.provide(Computations.layer)),
  ),
);
const reports = readFileSync(
  join(location.directory, "hybrid-logs", `commit-${input.oid}.jsonl`),
  "utf8",
)
  .trim()
  .split("\n")
  .map((line) =>
    z
      .object({ type: z.string(), status: z.string().optional() })
      .passthrough()
      .parse(JSON.parse(line)),
  );
console.log(
  "GATE_RESULT " +
    JSON.stringify({
      exit: exit.reason,
      duringReview,
      setups,
      modelCalls,
      cpuPriority,
      indexed: existsSync(input.marker),
      report: reports.find((row) => row.type === "hybrid.report")?.status,
    }),
);
