import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Deferred, Effect, Exit, Fiber, Scope, Stream } from "effect";
import { AccountStore, RuntimeUnavailable } from "@neuve/runtime";
import { admitReview } from "../src/handler.ts";
import { readHeldReviews } from "../src/held-reviews.ts";
import { fakeRuntime, route } from "./pi/stages/contract-fixture.ts";
import {
  configured,
  queuedClaudeReview,
} from "./fixtures/readiness-recovery.ts";

// Why: a saved observation from another worker must not prevent a capable worker admitting the job.
test("admission recovers a cached unavailable status through one shared account check", async () => {
  const home = mkdtempSync(join(tmpdir(), "neuve-readiness-recovery-"));
  const { run, job } = await queuedClaudeReview("cached-unavailable");
  const fake = fakeRuntime([]);
  const entered = Deferred.makeUnsafe<void>();
  const release = Deferred.makeUnsafe<void>();
  let probes = 0;
  const available = {
    ...fake.registry,
    accountEvents: Stream.empty,
    capabilities: () => fake.registry.capabilities(route.account.name),
    probe: () =>
      Effect.gen(function* () {
        probes++;
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(release);
        return {
          name: configured.account.name,
          kind: configured.account.kind,
          signIn: { state: "signed-in" as const },
          limits: [],
          checkedAt: "2099-01-01T00:00:00Z",
        };
      }),
  };
  const unavailable = {
    ...available,
    probe: () =>
      Effect.fail(
        new RuntimeUnavailable({
          account: configured.account.name,
          reason: "not-registered",
        }),
      ),
  };
  try {
    const old = await Effect.runPromise(
      AccountStore.makeStatuses(home, unavailable).pipe(
        Effect.provideService(Scope.Scope, run.scope),
      ),
    );
    expect(
      (await Effect.runPromise(old.check(configured.account.name))).signIn,
    ).toEqual({ state: "runtime-unavailable", reason: "not-registered" });
    const service = await Effect.runPromise(
      AccountStore.makeStatuses(home, available).pipe(
        Effect.provideService(Scope.Scope, run.scope),
      ),
    );
    const admit = () =>
      Effect.runPromise(
        admitReview(
          run.ctx.location,
          available,
          Effect.succeed({ service, scope: run.scope }),
        )(job).pipe(Effect.provide(run.ctx.records)),
      );
    expect(await admit()).toBe(false);
    expect(readHeldReviews(run.ctx.location)).toMatchObject([
      {
        seq: job.seq,
        credential:
          "Account claude hasn't been checked yet; waiting for its shared account check",
      },
    ]);
    await Effect.runPromise(Deferred.await(entered));
    expect(await admit()).toBe(false);
    expect(probes).toBe(1);
    const joined = await Effect.runPromise(
      service
        .check(configured.account.name)
        .pipe(Effect.forkIn(run.scope, { startImmediately: true })),
    );
    await Effect.runPromise(Deferred.succeed(release, undefined));
    expect((await Effect.runPromise(Fiber.join(joined))).signIn).toEqual({
      state: "signed-in",
    });
    expect(await admit()).toBe(true);
    expect(readHeldReviews(run.ctx.location)).toEqual([]);
    expect(probes).toBe(1);
    expect(fake.probes()).toBe(0);
    expect(fake.opens()).toBe(0);
  } finally {
    await Effect.runPromise(Scope.close(run.scope, Exit.void));
    rmSync(home, { recursive: true, force: true });
  }
});

// Why: initialization reads before readiness can read, and its rejection must also hold admission.
test("a malformed first status snapshot holds admission in an isolated HOME", () => {
  const home = mkdtempSync(join(tmpdir(), "neuve-readiness-init-"));
  try {
    const child = Bun.spawnSync(
      [
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "../../../scripts/test-budget.ts"),
        fileURLToPath(
          new URL("./fixtures/status-initialization.ts", import.meta.url),
        ),
      ],
      {
        env: {
          HOME: home,
          NEUVE_READINESS_TEST_HOME: home,
          XDG_CONFIG_HOME: home,
          TMPDIR: home,
          BUN_TMPDIR: home,
          NEUVE_MODE: "check",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15_000,
      },
    );
    if (child.exitCode !== 0)
      throw new Error(child.stderr.toString() + child.stdout.toString());
    expect(child.exitCode).toBe(0);
    expect(child.stderr.toString()).toContain("1 pass");
    expect(child.stderr.toString()).toContain("0 fail");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
