import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { Effect, Exit, Scope } from "effect";
import { JobQueue, Log, mintUlid } from "@neuve/records-core";
import { AccountName, AccountStore } from "@neuve/runtime";
import { defaultConfig, PIPELINE_VERSION } from "../../src/config.ts";
import { admitReview } from "../../src/handler.ts";
import { readHeldReviews } from "../../src/held-reviews.ts";
import { fakeRuntime, route } from "../pi/stages/contract-fixture.ts";
import { world } from "../pi/stages/fixture.ts";

export const configured = {
  ...route,
  account: { ...route.account, name: AccountName.parse("claude") },
};

export async function queuedClaudeReview(label: string) {
  const run = await world(label);
  try {
    const request = mintUlid();
    await Effect.runPromise(
      Log.append([
        {
          id: request,
          kind: "review.requested@1",
          idempotencyKey: `review.requested:${request}`,
          actor: "a".repeat(64),
          occurredAt: new Date().toISOString(),
          attribution: { cycleId: run.ctx.cycleId, range: run.ctx.range },
          payload: {
            runKey: run.ctx.runKey,
            generation: 0,
            pipeline: {
              version: PIPELINE_VERSION,
              config: defaultConfig(undefined, configured),
            },
          },
        },
      ]).pipe(Effect.provide(run.ctx.records)),
    );
    const jobs = await Effect.runPromise(
      Effect.flatMap(JobQueue.JobQueue, (queue) =>
        queue.list({ states: ["waiting"], limit: 10 }),
      ).pipe(Effect.provide(JobQueue.layer), Effect.provide(run.ctx.records)),
    );
    const job = jobs.find((job) => job.eventId === request);
    if (job === undefined) throw new Error("The request did not enqueue a job");
    return { run, job };
  } catch (error) {
    await Effect.runPromise(Scope.close(run.scope, Exit.void));
    throw error;
  }
}

/** Runs in an isolated HOME so the default process service sees only the malformed fixture. */
export async function unreadableFirstSnapshot() {
  if (process.env.NEUVE_READINESS_TEST_HOME !== homedir())
    throw new Error("This fixture requires an isolated HOME");
  const path = AccountStore.statusesPath(homedir());
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, "broken json", { mode: 0o600 });
  const { run, job } = await queuedClaudeReview("status-initialization");
  const fake = fakeRuntime([]);
  try {
    const ready = await Effect.runPromise(
      admitReview(run.ctx.location, {
        ...fake.registry,
        capabilities: () => fake.registry.capabilities(route.account.name),
      })(job).pipe(Effect.provide(run.ctx.records)),
    );
    return {
      ready,
      held: readHeldReviews(run.ctx.location).map(
        ({ provider, credential }) => ({
          provider,
          credential,
        }),
      ),
      probes: fake.probes(),
      opens: fake.opens(),
    };
  } finally {
    await Effect.runPromise(Scope.close(run.scope, Exit.void));
  }
}
