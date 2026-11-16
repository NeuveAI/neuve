// Why: a refused record must retain its identity across every directory boundary without probes or sends.
import { expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Cause, Effect, Exit, Option, Scope } from "effect";
import { JOB_POLICIES, JobQueue, Worker } from "@neuve/records-core";
import {
  AccountName,
  AccountNeedsNewerBuild,
  runtimeErrorToFailure,
} from "@neuve/runtime";
import {
  AccountStore,
  RuntimeRegistry,
  fakeRuntime,
  provideRegistry,
  recordFile,
  scratch,
} from "../../runtime/tests/store/fixtures.ts";
import { routeReadiness } from "../src/route-provider.ts";
import { runtimeFailurePolicy } from "../src/pi/failure-policy.ts";
import { fixture as chat, until } from "./chat-runtime/fixture.ts";
import {
  route,
  fakeRuntime as contractRuntime,
} from "./pi/stages/contract-fixture.ts";
import { terminalText } from "../src/chat-runtime/failure.ts";
import { writeJson } from "../../runtime/src/store/files.ts";
import { admitReview, reviewRunHandler } from "../src/handler.ts";
import { requestReview } from "../src/request.ts";
import { readHeldReviews } from "../src/held-reviews.ts";
import { openRunLog } from "../src/run-log.ts";
import { runFolder } from "../src/run-folder.ts";
import * as runtimes from "../src/runtimes.ts";
import * as integrations from "../src/integrations.ts";
import * as settings from "../src/settings.ts";
import { world } from "./pi/stages/fixture.ts";
import { reviewRepository } from "./fixtures/review-repository.ts";

const providerFailures = [
  {
    _tag: "TurnFailed",
    account: route.account.name,
    reason: "provider-failed",
  },
  {
    _tag: "TurnFailed",
    account: route.account.name,
    reason: "provider-unavailable",
  },
  {
    _tag: "RuntimeUnavailable",
    account: route.account.name,
    reason: "start-failed",
  },
] as const;
const statusScenarios = [
  {
    statusKind: "refused",
    failure: {
      _tag: "SignInRequired",
      account: route.account.name,
      hint: { kind: "settings", entry: "accounts" },
    },
  },
  ...providerFailures.flatMap((failure) => [
    { statusKind: "refused", failure },
    { statusKind: "unreadable", failure },
    { statusKind: "readable", failure },
  ]),
] as const;

// Why: refused or unreadable status must preserve holds past the attempt limit; readable status keeps provider policy.
for (const { statusKind, failure } of statusScenarios) {
  const refuse = statusKind !== "readable";
  const holdMessage =
    statusKind === "unreadable"
      ? "Neuve could not read account status."
      : "Account fake-claude needs a newer Neuve.";
  const readinessMessage =
    statusKind === "unreadable"
      ? "Account fake-claude couldn't be checked; run `neuve auth status fake-claude --check`"
      : holdMessage;
  test(`${statusKind} status with ${failure._tag}/${"reason" in failure ? failure.reason : "sign-in"} through handler and queue`, async () => {
    const temp = scratch();
    const run = await world(
      `status-${statusKind}-${failure._tag}-${"reason" in failure ? failure.reason : "sign-in"}`,
    );
    const repository = run.ctx.repository;
    reviewRepository(repository);
    const store = await Effect.runPromise(
      AccountStore.make(temp.home).pipe(
        Effect.provideService(Scope.Scope, run.scope),
      ),
    );
    const account = await Effect.runPromise(
      store.add("claude", route.account.name),
    );
    const statusPath = AccountStore.statusesPath(temp.home);
    const snapshot = {
      name: account.name,
      kind: account.kind,
      identity: AccountStore.readAccounts(temp.home).find(
        (entry) => entry.account.name === account.name,
      )?.folderId,
      signIn: { state: "signed-in" },
      limits: [],
      checkedAt: "2026-11-11T00:00:00Z",
    };
    writeJson(temp.home, statusPath, { version: 1, accounts: [snapshot] });
    let refusedBytes: string | undefined;
    let checks = 0;
    const fake = contractRuntime(
      [
        async () => {
          if (refuse)
            writeJson(temp.home, statusPath, {
              version: statusKind === "unreadable" ? 2 : 1,
              accounts: [{ ...snapshot, signIn: { state: "future-state" } }],
            });
          refusedBytes = readFileSync(statusPath, "utf8");
          return {
            status: "failed",
            disposition: "broken",
            failure,
          };
        },
      ],
      false,
    );
    const service = await Effect.runPromise(
      AccountStore.makeStatuses(temp.home, fake.registry).pipe(
        Effect.provideService(Scope.Scope, run.scope),
      ),
    );
    const statuses = Effect.succeed({
      scope: run.scope,
      service: {
        read: service.read,
        check: () => {
          checks++;
          return Effect.die("A refused status must never be checked");
        },
      },
    });
    const registrySpy = spyOn(runtimes, "processRuntimes").mockResolvedValue(
      fake.registry,
    );
    const statusesSpy = spyOn(
      runtimes,
      "processReadinessStatuses",
    ).mockReturnValue(statuses);
    const settingsSpy = spyOn(settings, "readSettings").mockReturnValue(
      Option.none(),
    );
    const integrationSpy = spyOn(
      integrations,
      "readIntegrations",
    ).mockReturnValue({ status: "absent", path: "(fixture)" });
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* requestReview({
            location: run.ctx.location,
            repository,
            range: "HEAD^..HEAD",
            requester: { _tag: "Unresolved" },
            route,
            runtimes: fake.registry,
            search: {},
            stack: undefined,
          });
          const queue = yield* JobQueue.JobQueue;
          let job = Option.getOrThrow(yield* queue.take(["review.run@2"]));
          expect(
            yield* admitReview(run.ctx.location, fake.registry, statuses)(job),
          ).toBe(true);
          for (
            let claim = 0;
            claim <= (refuse ? JOB_POLICIES["review.run"].maxAttempts : 0);
            claim++
          ) {
            const exit = yield* Effect.exit(
              reviewRunHandler({ location: run.ctx.location, repository })(job),
            );
            if (!refuse) {
              if (Exit.isSuccess(exit))
                throw new Error("Expected provider failure");
              expect(Cause.squash(exit.cause)).toMatchObject({
                _tag: "RunFailed",
                stageError: failure._tag,
                retryable: false,
              });
              const failed = yield* queue.fail(
                job.seq,
                job.attempts,
                Worker.describeFailure(exit.cause, JOB_POLICIES[job.kind]),
              );
              expect(failed.state).toBe("failed");
              expect(failed.job.attempts).toBe(1);
              expect(
                existsSync(runFolder(run.ctx.location, job.eventId!)),
              ).toBe(false);
              expect(
                openRunLog(run.ctx.location, job.eventId!).read(),
              ).toContainEqual(expect.objectContaining({ type: "run.failed" }));
              break;
            }
            expect(
              Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined,
            ).toMatchObject({
              _tag: "JobHeld",
              hold: true,
              message: holdMessage,
            });
            expect(existsSync(runFolder(run.ctx.location, job.eventId!))).toBe(
              true,
            );
            expect(
              openRunLog(run.ctx.location, job.eventId!)
                .read()
                .filter((entry) => entry.type === "run.snapshot")
                .at(-1),
            ).toMatchObject({ mode: "held" });
            expect(yield* queue.release(job.seq, job.attempts)).toMatchObject({
              state: "waiting",
              attempts: 0,
            });
            expect(
              yield* routeReadiness(route, fake.registry, statuses),
            ).toEqual({
              ready: false,
              credential: readinessMessage,
            });
            expect(
              yield* admitReview(
                run.ctx.location,
                fake.registry,
                statuses,
              )(job),
            ).toBe(false);
            expect(readHeldReviews(run.ctx.location)).toMatchObject([
              {
                seq: job.seq,
                credential: readinessMessage,
              },
            ]);
            expect(
              openRunLog(run.ctx.location, job.eventId!)
                .read()
                .some((entry) => entry.type === "run.failed"),
            ).toBe(false);
            if (refusedBytes === undefined)
              throw new Error("No refused status");
            expect(readFileSync(statusPath, "utf8")).toBe(refusedBytes);
            if (statusKind === "unreadable")
              expect(yield* Effect.result(service.read)).toMatchObject({
                _tag: "Failure",
                failure: { _tag: "AccountStoreError" },
              });
            if (claim < JOB_POLICIES["review.run"].maxAttempts)
              job = Option.getOrThrow(yield* queue.take(["review.run@2"]));
          }
        }).pipe(
          Effect.provide(JobQueue.layer),
          Effect.provide(run.ctx.records),
        ),
      );
      expect(checks).toBe(0);
      expect(fake.probes()).toBe(0);
      expect(fake.opens()).toBe(1);
      expect(fake.turns).toHaveLength(1);
    } finally {
      registrySpy.mockRestore();
      statusesSpy.mockRestore();
      settingsSpy.mockRestore();
      integrationSpy.mockRestore();
      await Effect.runPromise(Scope.close(run.scope, Exit.void));
      temp.close();
    }
  });
}

test("a refused account is distinct from absent through lookup, checkTurn, capabilities and readiness", async () => {
  const temp = scratch();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(temp.home);
          const account = yield* store.add("claude", route.account.name);
          const sibling = yield* store.add("claude", "sibling");
          const path = recordFile(temp.home, account.name);
          const raw = JSON.parse(readFileSync(path, "utf8"));
          raw.account.credential.kind = "future-folder";
          const bytes = JSON.stringify(raw);
          writeFileSync(path, bytes);
          const calls: string[] = [];
          const registry = yield* RuntimeRegistry.pipe(
            Effect.provide(provideRegistry(store, [fakeRuntime({ calls })])),
          );
          const scope = yield* Scope.Scope;
          const statuses = Effect.succeed({
            scope,
            service: {
              read: Effect.die("No status read"),
              check: () => Effect.die("No probe"),
            },
          });
          for (const result of [
            yield* store.directory
              .lookup(account.name, "use")
              .pipe(Effect.result),
            yield* store.directory
              .lookup(account.name, "sign-out")
              .pipe(Effect.result),
            yield* store.directory.checkTurn(account.name).pipe(Effect.result),
            yield* registry.capabilities(account.name).pipe(Effect.result),
            yield* registry.continuation(account.name).pipe(Effect.result),
            yield* registry.probe(account.name).pipe(Effect.result),
          ])
            expect(result).toMatchObject({
              _tag: "Failure",
              failure: {
                _tag: "AccountNeedsNewerBuild",
                account: account.name,
              },
            });
          expect(yield* routeReadiness(route, registry, statuses)).toEqual({
            ready: false,
            credential: "Account fake-claude needs a newer Neuve.",
          });
          const absent = AccountName.parse("absent");
          expect(yield* store.directory.lookup(absent, "use")).toBeUndefined();
          for (const result of [
            yield* store.directory.checkTurn(absent).pipe(Effect.result),
            yield* registry.capabilities(absent).pipe(Effect.result),
            yield* routeReadiness(
              { ...route, account: { ...route.account, name: absent } },
              registry,
              statuses,
            ).pipe(Effect.result),
          ])
            expect(result).toMatchObject({
              _tag: "Failure",
              failure: { _tag: "AccountNotFound" },
            });
          expect(yield* store.directory.lookup(sibling.name, "use")).toEqual(
            sibling,
          );
          expect(yield* registry.capabilities(sibling.name)).toMatchObject({
            ownsLoop: true,
          });
          expect(calls).toEqual([]);
          expect(readFileSync(path, "utf8")).toBe(bytes);
          const failure = runtimeErrorToFailure(
            new AccountNeedsNewerBuild({ account: account.name }),
          );
          expect(runtimeFailurePolicy(failure)).toEqual({
            action: "hold",
            retryable: false,
          });
          expect(terminalText(failure)).toBe(
            "Account fake-claude needs a newer Neuve.",
          );
        }),
      ),
    );
  } finally {
    temp.close();
  }
});

// Why: the shared store's refusal must remove an open chat's model and retain its native head without another request.
test("a refused account removes the open chat model without sending", async () => {
  const temp = scratch();
  const scope = await Effect.runPromise(Scope.make());
  let run: Awaited<ReturnType<typeof chat>> | undefined;
  try {
    const store = await Effect.runPromise(
      AccountStore.make(temp.home).pipe(
        Effect.provideService(Scope.Scope, scope),
      ),
    );
    const account = await Effect.runPromise(
      store.add("claude", "subscription"),
    );
    const path = recordFile(temp.home, account.name);
    run = await chat({
      accounts: [account],
      registry: (_registry, fake) =>
        Effect.runSync(
          RuntimeRegistry.pipe(
            Effect.provide(provideRegistry(store, [fake.shape])),
            Effect.provideService(Scope.Scope, scope),
          ),
        ),
    });
    run.fake.frames.push({ text: "first" });
    expect((await run.submit("hello")).status).toBe("done");
    const saved = JSON.stringify(run.heads.get(String(run.conversation.id)));
    const raw = JSON.parse(readFileSync(path, "utf8"));
    raw.account.credential.kind = "future-folder";
    const bytes = JSON.stringify(raw);
    writeFileSync(path, bytes);
    run.statuses.set([...AccountStore.readStatuses(temp.home)]);
    const current = run;
    await until(() => current.models.getModels("subscription").length === 0);
    expect(run.models.getModel("subscription", "sonnet")).toBeUndefined();
    await run.submit("after refusal");
    expect(run.fake.opened).toHaveLength(1);
    expect(run.fake.requests).toHaveLength(1);
    expect(JSON.stringify(run.heads.get(String(run.conversation.id)))).toBe(
      saved,
    );
    expect(readFileSync(path, "utf8")).toBe(bytes);
  } finally {
    await run?.close();
    await Effect.runPromise(Scope.close(scope, Exit.void));
    temp.close();
  }
});
