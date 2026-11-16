// Inspect the actual --store worker path before it can run any jobs or probes.
import { spyOn } from "bun:test";
import { existsSync } from "node:fs";
import { Effect } from "effect";
import { Worker } from "@neuve/records-core";
import { AccountName } from "@neuve/runtime";
import {
  defaultClaudeWorkingFolder,
  processRuntimes,
} from "@neuve/harness/runtimes";
import { runWorkerCli } from "../../src/worker-cli.ts";

const store = process.argv[2];
if (!store) throw new Error("A scratch store is required");
spyOn(Worker, "run").mockImplementation(() =>
  Effect.gen(function* () {
    const registry = yield* Effect.promise(processRuntimes);
    const capabilities = yield* registry
      .capabilities(AccountName.parse("claude"))
      .pipe(Effect.orDie);
    console.log(
      JSON.stringify({
        ownsLoop: capabilities.ownsLoop,
        internalRetries: capabilities.internalRetries,
        folder: existsSync(defaultClaudeWorkingFolder()),
      }),
    );
    return { reason: "idle" } as const;
  }),
);
await runWorkerCli(["run", "--store", store, "--idle-seconds", "1"]);
