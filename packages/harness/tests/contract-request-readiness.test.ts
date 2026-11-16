// Why: admission must refuse the wrong provider loop before work is queued, and subscription
// readiness must use the runtime's sign-in observation instead of direct credential access.
import { expect, spyOn, test } from "bun:test";
import { Cause, Effect, Exit, Scope } from "effect";
import { RuntimeUnavailable } from "@neuve/runtime";
import { Log, mintUlid, storeLocationIn } from "@neuve/records-core";
import { defaultConfig, PIPELINE_VERSION } from "../src/config.ts";
import { prepareReviewConfig, requestReview } from "../src/request.ts";
import { admitReview } from "../src/handler.ts";
import { readHeldReviews } from "../src/held-reviews.ts";
import * as provider from "../src/route-provider.ts";
import { OPUS_ROUTE } from "../src/route.ts";
import { fakeRuntime, route } from "./pi/stages/contract-fixture.ts";
import { world } from "./pi/stages/fixture.ts";
import { reviewRepository } from "./fixtures/review-repository.ts";

for (const configured of [route, OPUS_ROUTE]) {
  test(`freezing ${configured.provider} refuses a mismatched runtime`, async () => {
    const fake = fakeRuntime([]);
    const capabilities = fake.registry.capabilities(route.account.name);
    const registry = {
      ...fake.registry,
      capabilities: () =>
        Effect.map(capabilities, (caps) => ({
          ...caps,
          ownsLoop: configured.provider !== "claude",
        })),
    };
    const exit = await Effect.runPromiseExit(
      prepareReviewConfig({
        location: storeLocationIn("/unused"),
        search: {},
        stack: undefined,
        route: configured,
        runtimes: registry,
      }),
    );
    expect(
      Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined,
    ).toMatchObject({
      _tag: "RouteRuntimeMismatch",
      account: configured.account?.name,
      provider: configured.provider,
      retryable: false,
    });
    expect(fake.opens()).toBe(0);
    expect(fake.probes()).toBe(0);
  });
}

test("a matching Claude route freezes with its account", async () => {
  const fake = fakeRuntime([]);
  const config = await Effect.runPromise(
    prepareReviewConfig({
      location: storeLocationIn("/unused"),
      search: {},
      stack: undefined,
      route,
      runtimes: fake.registry,
    }),
  );
  expect(config.route).toEqual(route);
  expect(fake.opens()).toBe(0);
});

// Why: desk and light CLI callers freeze routes without loading process runtimes.
for (const configured of [route, OPUS_ROUTE]) {
  test(`freezing ${configured.provider} without a registry keeps its schema-validated account`, async () => {
    const config = await Effect.runPromise(
      prepareReviewConfig({
        location: storeLocationIn("/unused"),
        search: {},
        stack: undefined,
        route: configured,
      }),
    );
    expect(config.route).toEqual(configured);
  });
}

test("Claude admission reads snapshots and holds with the Neuve login command", async () => {
  const run = await world("contract-readiness");
  const fake = fakeRuntime([]);
  let snapshot: import("@neuve/runtime/status").AccountStatus = {
    name: route.account.name,
    kind: route.account.kind,
    signIn: {
      state: "not-signed-in",
      hint: { kind: "settings", entry: "accounts" },
    },
    limits: [],
    checkedAt: new Date().toISOString(),
  };
  const statuses = {
    read: Effect.sync(() => [snapshot]),
    check: () =>
      Effect.die(new Error("A saved status must never trigger a check")),
  };
  const direct = spyOn(provider, "credentialPresent").mockImplementation(() => {
    throw new Error("subscription admission touched direct credentials");
  });
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
              config: defaultConfig(undefined, route),
            },
          },
        },
      ]).pipe(Effect.provide(run.ctx.records)),
    );
    const { JobQueue } = await import("@neuve/records-core");
    const queue = await Effect.runPromise(
      JobQueue.JobQueue.pipe(
        Effect.provide(JobQueue.layer),
        Effect.provide(run.ctx.records),
      ),
    );
    const jobs = await Effect.runPromise(
      queue.list({ states: ["waiting"], limit: 10 }),
    );
    const job = jobs.find((job) => job.eventId === request);
    if (job === undefined) throw new Error("The request did not enqueue a job");
    const admit = () =>
      Effect.runPromise(
        admitReview(
          run.ctx.location,
          fake.registry,
          Effect.succeed({ service: statuses, scope: run.scope }),
        )(job).pipe(Effect.provide(run.ctx.records)),
      );

    expect(await admit()).toBe(false);
    expect(readHeldReviews(run.ctx.location)).toMatchObject([
      {
        seq: job.seq,
        provider: "claude",
        credential: expect.stringContaining(
          "run `neuve auth login fake-claude`",
        ),
      },
    ]);
    expect(fake.probes()).toBe(0);
    snapshot = {
      ...snapshot,
      signIn: { state: "signed-in" },
      limits: [{ window: "five-hour", status: "rejected" }],
    };
    expect(await admit()).toBe(true);
    expect(fake.probes()).toBe(0);
    expect(readHeldReviews(run.ctx.location)).toEqual([]);
    // A different worker can lack Claude Code even though the shared account snapshot is signed in.
    for (const reason of ["not-registered", "not-installed"] as const) {
      fake.capabilityError(
        new RuntimeUnavailable({ account: route.account.name, reason }),
      );
      expect(await admit()).toBe(false);
      expect(readHeldReviews(run.ctx.location)).toMatchObject([
        {
          seq: job.seq,
          credential:
            reason === "not-installed"
              ? "Claude Code is not installed for account fake-claude; install Claude Code, then run `neuve auth status fake-claude --check`"
              : "This worker doesn't have usable Claude Code for account fake-claude (not-registered); the job waits for a worker that does",
        },
      ]);
    }
    expect(fake.probes()).toBe(0);
    expect(direct).not.toHaveBeenCalled();
  } finally {
    direct.mockRestore();
    await Effect.runPromise(Scope.close(run.scope, Exit.succeed(undefined)));
  }
});

// Why: a caller can supply an already prepared config, which must receive the same
// provider/runtime check before requestReview appends or joins any Records work.
test("an already frozen request refuses a mismatched provider before writing", async () => {
  const run = await world("contract-frozen-request");
  reviewRepository(run.ctx.repository);
  const fake = fakeRuntime([]);
  const capabilities = fake.registry.capabilities(route.account.name);
  const registry = { ...fake.registry, capabilities: () => capabilities };
  try {
    const exit = await Effect.runPromiseExit(
      requestReview({
        location: run.ctx.location,
        repository: run.ctx.repository,
        range: "HEAD^..HEAD",
        requester: { _tag: "Unresolved" },
        frozenConfig: defaultConfig(undefined, OPUS_ROUTE),
        runtimes: registry,
      }).pipe(Effect.provide(run.ctx.records)),
    );
    expect(
      Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined,
    ).toMatchObject({
      _tag: "RouteRuntimeMismatch",
      provider: "anthropic",
      retryable: false,
    });
    expect(
      await Effect.runPromise(
        Log.history({ kind: "review.requested@1" }).pipe(
          Effect.provide(run.ctx.records),
        ),
      ),
    ).toEqual([]);
  } finally {
    await Effect.runPromise(Scope.close(run.scope, Exit.succeed(undefined)));
  }
});
