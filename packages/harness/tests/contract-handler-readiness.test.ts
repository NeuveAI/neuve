// Why: the runtime can disappear after admission. Exercise the real handler and openAttempt
// so the startup failure remains a hold, with no provider setup or failed-run cleanup.
import { expect, spyOn, test } from "bun:test";
import { Cause, Effect, Exit, Option, Scope } from "effect";
import { JobQueue, Log } from "@neuve/records-core";
import { RuntimeUnavailable } from "@neuve/runtime";
import { PIPELINE_VERSION, defaultConfig } from "../src/config.ts";
import { reviewRunHandler } from "../src/handler.ts";
import { openRunLog } from "../src/run-log.ts";
import * as runtimes from "../src/runtimes.ts";
import * as integrations from "../src/integrations.ts";
import * as admission from "../src/pi/providers/route-admission.ts";
import { fakeRuntime, route } from "./pi/stages/contract-fixture.ts";
import { world } from "./pi/stages/fixture.ts";
import { reviewRepository } from "./fixtures/review-repository.ts";

for (const point of ["capabilities", "continuation"] as const) {
  test(`Claude runtime lost at ${point} holds at run start`, async () => {
    const run = await world(`contract-start-${point}`);
    const repository = run.ctx.repository;
    const git = reviewRepository(repository);
    const fake = fakeRuntime([]);
    const unavailable = new RuntimeUnavailable({
      account: route.account.name,
      reason: "not-installed",
    });
    if (point === "capabilities") fake.capabilityError(unavailable);
    const registry =
      point === "continuation"
        ? { ...fake.registry, continuation: () => Effect.fail(unavailable) }
        : fake.registry;
    const registrySpy = spyOn(runtimes, "processRuntimes").mockResolvedValue(
      registry,
    );
    const integrationSpy = spyOn(
      integrations,
      "readIntegrations",
    ).mockReturnValue({ status: "absent", path: "(fixture)" });
    const providerSpy = spyOn(
      admission,
      "providerAccountKey",
    ).mockImplementation(() => {
      throw new Error("No direct provider setup on a Claude startup hold");
    });
    try {
      await Effect.runPromise(
        Log.append([
          {
            id: run.ctx.runId,
            kind: "review.requested@1",
            idempotencyKey: `review.requested:${run.ctx.runId}`,
            actor: "a".repeat(64),
            occurredAt: new Date().toISOString(),
            attribution: {
              cycleId: run.ctx.cycleId,
              range: {
                baseRef: "HEAD^",
                baseOid: git("rev-parse", "HEAD^"),
                headOid: git("rev-parse", "HEAD"),
              },
            },
            payload: {
              runKey: run.ctx.runKey,
              generation: 0,
              pipeline: {
                version: PIPELINE_VERSION,
                config: defaultConfig(undefined, route),
              },
            },
          },
        ]).pipe(Effect.provide(run.ctx.records)),
      );
      const exit = await Effect.runPromise(
        Effect.gen(function* () {
          const queue = yield* JobQueue.JobQueue;
          const job = Option.getOrThrow(
            yield* queue.take(["review.run", "review.run@2"]),
          );
          return yield* Effect.exit(
            reviewRunHandler({ location: run.ctx.location, repository })(job),
          );
        }).pipe(
          Effect.provide(JobQueue.layer),
          Effect.provide(run.ctx.records),
        ),
      );
      expect(
        Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined,
      ).toMatchObject({
        _tag: "JobHeld",
        hold: true,
        message:
          "Claude Code is not installed for account fake-claude; install Claude Code, then run `neuve auth status fake-claude --check`",
      });
      const log = openRunLog(run.ctx.location, run.ctx.runId).read();
      expect(
        log.filter((record) => record.type === "run.attempt-failed"),
      ).toMatchObject([{ held: true, final: false }]);
      expect(log.some((record) => record.type === "run.failed")).toBe(false);
      expect(fake.probes()).toBe(0);
      expect(fake.opens()).toBe(0);
      expect(providerSpy).not.toHaveBeenCalled();
    } finally {
      registrySpy.mockRestore();
      integrationSpy.mockRestore();
      providerSpy.mockRestore();
      await Effect.runPromise(Scope.close(run.scope, Exit.void));
    }
  });
}
