// Why: every directory operation must distinguish an unreadable store from an absent account,
// preserve defaults, share startup work, and recover in the same scope after repair.
import { expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { Effect, Exit, Fiber, Layer, Scope } from "effect";
import {
  AccountDirectory,
  AccountName,
  AccountStore,
  DEFAULT_ACCOUNTS,
  RuntimeRegistry,
  runtimeRegistryLayer,
  runtimeErrorToFailure,
  runtimeFailureToError,
} from "../../src/index.ts";
import * as files from "../../src/store/files.ts";
import { fakeRuntime, scratch } from "./fixtures.ts";
import { routeReadiness } from "../../../harness/src/route-provider.ts";
import { ClaudeRouteConfig, OPUS_ROUTE } from "../../../harness/src/route.ts";
const route = ClaudeRouteConfig.parse({
  model: OPUS_ROUTE.model,
  effort: OPUS_ROUTE.effort,
  window: OPUS_ROUTE.window,
  maxOutputTokens: OPUS_ROUTE.maxOutputTokens,
  provider: "claude",
  account: { name: "work", kind: "claude-subscription" },
  price: null,
});

for (const startup of [true, false]) {
  test(`a refused store ${startup ? "at startup" : "after opening"} preserves defaults and recovers named lookups`, async () => {
    const at = scratch();
    const folder = AccountStore.neuveFolder(at.home);
    const calls: string[] = [];
    const name = AccountName.parse("work");
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* AccountStore.make(at.home);
            yield* store.add("claude", name);
          }),
        ),
      );
      if (startup) chmodSync(folder, 0o775);
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const directory = yield* AccountStore.retryingDirectory(at.home);
            if (!startup)
              expect(yield* directory.lookup(name, "use")).toMatchObject({
                name,
              });
            chmodSync(folder, 0o775);
            for (const account of DEFAULT_ACCOUNTS) {
              expect(yield* directory.lookup(account.name, "use")).toEqual(
                account,
              );
              yield* directory.checkTurn(account.name);
              expect(
                yield* directory.withAccess(
                  account.name,
                  Effect.succeed("opened"),
                ),
              ).toBe("opened");
            }
            const expected = {
              _tag: "AccountStoreRefused",
              account: name,
              folder,
              problem: { kind: "writable-by-others" },
            };
            for (const operation of [
              directory.lookup(name, "use"),
              directory.checkTurn(name),
              directory.withAccess(name, Effect.die("must not open")),
            ]) {
              const result = yield* operation.pipe(Effect.result);
              expect(result).toMatchObject({
                _tag: "Failure",
                failure: expected,
              });
              if (result._tag !== "Failure")
                throw new Error("Expected refusal");
              expect(result.failure.message).toBe(
                `${folder} is writable by other users. Neuve needs it writable only by you.`,
              );
              expect(
                runtimeFailureToError(runtimeErrorToFailure(result.failure))
                  .message,
              ).toBe(result.failure.message);
            }
            const registry = yield* RuntimeRegistry.pipe(
              Effect.provide(
                runtimeRegistryLayer([fakeRuntime({ calls })]).pipe(
                  Layer.provide(Layer.succeed(AccountDirectory, directory)),
                ),
              ),
            );
            const readiness = yield* routeReadiness(
              { ...route, account: { ...route.account, name } },
              registry,
              Effect.die("no status or probe on refusal"),
            );
            expect(readiness).toEqual({
              ready: false,
              credential: `${folder} is writable by other users. Neuve needs it writable only by you.`,
            });
            expect(readiness.credential).not.toContain("needs a newer Neuve");
            chmodSync(folder, 0o755);
            expect(yield* directory.lookup(name, "use")).toMatchObject({
              name,
            });
            yield* directory.checkTurn(name);
            expect(yield* registry.capabilities(name)).toMatchObject({
              ownsLoop: true,
            });
            expect(
              yield* directory.lookup(AccountName.parse("absent"), "use"),
            ).toBeUndefined();
          }),
        ),
      );
      expect(calls).toEqual([]);
    } finally {
      chmodSync(folder, 0o755);
      at.close();
    }
  });
}

test("concurrent refused opens subscribe once, then a later lookup retries and caches the real store", async () => {
  const at = scratch();
  const folder = AccountStore.neuveFolder(at.home);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  chmodSync(folder, 0o775);
  const parents = spyOn(files, "privateParents");
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* AccountStore.retryingDirectory(at.home);
          const names = Array.from({ length: 8 }, (_, n) =>
            AccountName.parse(`work-${n}`),
          );
          const failures = yield* Effect.forEach(
            names,
            (name) => directory.lookup(name, "use").pipe(Effect.result),
            { concurrency: "unbounded" },
          );
          expect(failures.map((r) => r._tag)).toEqual(Array(8).fill("Failure"));
          expect(parents.mock.calls).toHaveLength(1);
          yield* directory.lookup(names[0]!, "use").pipe(Effect.result);
          expect(parents.mock.calls).toHaveLength(2);
          chmodSync(folder, 0o755);
          expect(yield* directory.lookup(names[0]!, "use")).toBeUndefined();
          // A successful open is retained: further calls read accounts once each, never reopen/watch again.
          const before = parents.mock.calls.length;
          expect(yield* directory.lookup(names[0]!, "use")).toBeUndefined();
          expect(parents.mock.calls.length - before).toBe(1);
        }),
      ),
    );
  } finally {
    parents.mockRestore();
    chmodSync(folder, 0o755);
    at.close();
  }
});

// Why (0016): the caller that starts the shared open may leave; every other caller still gets the
// open's own result, never that caller's interruption, and a successful open is kept.
test("a subscriber gets the shared open's result when the caller that started it is interrupted", async () => {
  const at = scratch();
  const folder = AccountStore.neuveFolder(at.home);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  chmodSync(folder, 0o775);
  const parents = spyOn(files, "privateParents");
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* AccountStore.retryingDirectory(at.home);
          const race = Effect.gen(function* () {
            const started = yield* directory
              .lookup(AccountName.parse("work-a"), "use")
              .pipe(Effect.forkChild({ startImmediately: true }));
            const subscribed = yield* directory
              .lookup(AccountName.parse("work-b"), "use")
              .pipe(
                Effect.result,
                Effect.forkChild({ startImmediately: true }),
              );
            yield* Fiber.interrupt(started);
            expect(Exit.hasInterrupts(yield* Fiber.await(started))).toBe(true);
            return yield* Fiber.await(subscribed);
          });
          expect(yield* race).toMatchObject({
            _tag: "Success",
            value: {
              _tag: "Failure",
              failure: {
                _tag: "AccountStoreRefused",
                account: "work-b",
                folder,
                problem: { kind: "writable-by-others" },
              },
            },
          });
          chmodSync(folder, 0o755);
          expect(yield* race).toMatchObject({
            _tag: "Success",
            value: { _tag: "Success", success: undefined },
          });
          // The open that succeeded while its starter was interrupted is retained: one read, no reopen.
          const before = parents.mock.calls.length;
          expect(
            yield* directory.lookup(AccountName.parse("work-c"), "use"),
          ).toBeUndefined();
          expect(parents.mock.calls.length - before).toBe(1);
        }),
      ),
    );
  } finally {
    parents.mockRestore();
    chmodSync(folder, 0o755);
    at.close();
  }
});

test("an incidental store I/O failure holds with safe unreadable-folder details", async () => {
  const at = scratch();
  const folder = AccountStore.accountsPath(at.home);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  // A malformed named record's payload and filename must never become runtime diagnostics.
  const claim = AccountStore.claimPath(at.home, AccountName.parse("work"));
  mkdirSync(claim, { mode: 0o700 });
  writeFileSync(`${claim}/private-record-name`, "{}", { mode: 0o644 });
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* AccountStore.retryingDirectory(at.home);
          const result = yield* directory
            .lookup(AccountName.parse("work"), "use")
            .pipe(Effect.result);
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: {
              _tag: "AccountStoreRefused",
              folder,
              problem: { kind: "unreadable" },
            },
          });
          expect(JSON.stringify(result)).not.toContain("private-record-name");
        }),
      ),
    );
  } finally {
    at.close();
  }
});

// Why: the folder can become refused between capabilities and reading the status snapshot.
test("readiness preserves the folder problem when the status read is refused after capabilities", async () => {
  const at = scratch();
  const folder = AccountStore.neuveFolder(at.home);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Scope.Scope;
          const runtime = fakeRuntime({ calls: [] });
          const ready = yield* routeReadiness(
            route,
            {
              capabilities: () =>
                Effect.sync(() => {
                  chmodSync(folder, 0o775);
                  return Effect.runSync(
                    runtime.capabilities(DEFAULT_ACCOUNTS[2]!),
                  );
                }),
            },
            Effect.succeed({
              scope,
              service: {
                read: files.storeIO(() => AccountStore.readStatuses(at.home)),
                check: () => Effect.die("no probe after a failed read"),
              },
            }),
          );
          expect(ready).toEqual({
            ready: false,
            credential: `${folder} is writable by other users. Neuve needs it writable only by you.`,
          });
        }),
      ),
    );
  } finally {
    chmodSync(folder, 0o755);
    at.close();
  }
});
