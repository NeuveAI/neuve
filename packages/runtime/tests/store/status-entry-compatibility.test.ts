import { expect, spyOn, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { Deferred, Effect, Fiber, Stream } from "effect";
import { type Account, type AccountStatus } from "../../src/index.ts";
import { forgetStatus } from "../../src/store/status.ts";
import { writeJson } from "../../src/store/files.ts";
import * as StoreFiles from "../../src/store/files.ts";
import {
  AccountStore,
  RuntimeRegistry,
  fakeRuntime,
  provideRegistry,
  scratch,
} from "./fixtures.ts";

const snapshot = (
  home: string,
  account: Account,
): AccountStatus & { identity: string } => ({
  name: account.name,
  kind: account.kind,
  identity:
    AccountStore.readAccounts(home).find(
      (entry) => entry.account.name === account.name,
    )?.folderId ?? account.name,
  signIn: { state: "signed-in" },
  limits: [],
  models: [{ id: "sonnet", displayName: "Sonnet", description: "A model" }],
  checkedAt: "2026-11-11T00:00:00Z",
});
const refusedStatus = (account: Account): AccountStatus => ({
  name: account.name,
  kind: account.kind,
  signIn: { state: "unknown", reason: "needs-newer-build" },
  limits: [],
  checkedAt: "1970-01-01T00:00:00.000Z",
});
const bytes = (home: string) =>
  readFileSync(AccountStore.statusesPath(home), "utf8");
const stored = (home: string) => JSON.parse(bytes(home));

// Reason: one future variant must remain local across every status reader and must never be probed or rewritten.
test("a refused status stays isolated in reads, checks, watches and sibling write-backs", async () => {
  const { home, close } = scratch();
  const notices: string[] = [];
  const stderr = spyOn(process.stderr, "write").mockImplementation((line) => {
    notices.push(String(line));
    return true;
  });
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(home);
          const work = yield* store.add("claude", "work");
          const sibling = yield* store.add("claude", "sibling");
          const good = snapshot(home, sibling);
          const { identity: _, ...publicGood } = good;
          const calls: string[] = [];
          writeJson(home, AccountStore.statusesPath(home), {
            version: 1,
            accounts: [snapshot(home, work), good],
          });
          yield* Effect.gen(function* () {
            const service = yield* AccountStore.makeStatuses(
              home,
              yield* RuntimeRegistry,
            );
            const refused = {
              ...snapshot(home, work),
              signIn: { state: "future-state" },
            };
            writeJson(home, AccountStore.statusesPath(home), {
              version: 1,
              accounts: [refused, good],
            });
            const before = bytes(home);
            const inode = statSync(AccountStore.statusesPath(home)).ino;
            const values = AccountStore.readStatuses(home);
            expect(values.find((value) => value.name === work.name)).toEqual(
              refusedStatus(work),
            );
            expect(values.find((value) => value.name === sibling.name)).toEqual(
              publicGood,
            );
            expect(yield* service.read).toEqual(values);
            expect(AccountStore.statusSource(home).current()).toEqual(values);
            const deliveries: unknown[] = [];
            const stop = AccountStore.statusSource(home).subscribe((value) =>
              deliveries.push(value),
            );
            try {
              expect(deliveries[0]).toEqual(values);
            } finally {
              stop();
            }
            expect(
              yield* AccountStore.watchStatuses(home).pipe(
                Stream.take(1),
                Stream.runCollect,
              ),
            ).toEqual([values]);
            expect(yield* service.check(work.name)).toEqual(
              refusedStatus(work),
            );
            expect(calls).toEqual([]);
            expect(bytes(home)).toBe(before);
            expect(statSync(AccountStore.statusesPath(home)).ino).toBe(inode);
            yield* service.check(sibling.name);
            expect(calls).toEqual(["probe:sibling"]);
            expect(stored(home).accounts[0]).toEqual(refused);
            expect(JSON.stringify(stored(home).accounts[0])).toBe(
              JSON.stringify(refused),
            );
            expect(stored(home).accounts).toHaveLength(5); // Default accounts retain the existing write-back behavior.
            yield* forgetStatus(home, {
              account: sibling,
              folderId: good.identity,
            });
            expect(stored(home).accounts[0]).toEqual(refused);
            yield* forgetStatus(home, {
              account: work,
              folderId: refused.identity,
            });
            expect(stored(home).accounts[0]).toEqual(refused);
          }).pipe(
            Effect.provide(provideRegistry(store, [fakeRuntime({ calls })])),
          );
          expect(notices).toEqual([
            `${AccountStore.statusesPath(home)} account work's status needs a newer build; leaving it as stored.\n`,
          ]);
          expect(notices.join("")).not.toContain("future-state");
        }),
      ),
    );
  } finally {
    stderr.mockRestore();
    close();
  }
});

// Reason: a pushed limit must not change a refused entry or write a second occurrence for it.
test("a rate-limit event for a refused account writes nothing", async () => {
  const { home, close } = scratch();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(home);
          const work = yield* store.add("claude", "work");
          writeJson(home, AccountStore.statusesPath(home), {
            version: 1,
            accounts: [
              { ...snapshot(home, work), signIn: { state: "future-state" } },
            ],
          });
          const before = bytes(home);
          const inode = statSync(AccountStore.statusesPath(home)).ino;
          const calls: string[] = [];
          yield* Effect.gen(function* () {
            const registry = yield* RuntimeRegistry;
            const done = yield* Deferred.make<void>();
            yield* AccountStore.makeStatuses(home, {
              ...registry,
              accountEvents: Stream.concat(
                Stream.make({
                  account: work.name,
                  event: {
                    type: "rate-limit",
                    turnId: "fake",
                    at: "2026-11-11T12:00:00Z",
                    window: "weekly",
                    status: "rejected",
                  },
                }),
                Stream.drain(
                  Stream.fromEffect(Deferred.succeed(done, undefined)),
                ),
              ),
            });
            yield* Deferred.await(done);
            expect(bytes(home)).toBe(before);
            expect(statSync(AccountStore.statusesPath(home)).ino).toBe(inode);
            expect(calls).toEqual([]);
          }).pipe(
            Effect.provide(provideRegistry(store, [fakeRuntime({ calls })])),
          );
        }),
      ),
    );
  } finally {
    close();
  }
});

for (const refusedFirst of [true, false]) {
  // Reason: no ordering can establish which duplicate is current, and checkAll must still check every sibling.
  test(`a refused duplicate ${refusedFirst ? "before" : "after"} a readable status wins without blocking checkAll`, async () => {
    const { home, close } = scratch();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* AccountStore.make(home);
            const work = yield* store.add("claude", "work");
            const sibling = yield* store.add("claude", "sibling");
            const good = snapshot(home, work);
            const refused = { ...good, signIn: { state: "future-state" } };
            const accounts = refusedFirst ? [refused, good] : [good, refused];
            writeJson(home, AccountStore.statusesPath(home), {
              version: 1,
              accounts,
            });
            const calls: string[] = [];
            yield* Effect.gen(function* () {
              const service = yield* AccountStore.makeStatuses(
                home,
                yield* RuntimeRegistry,
              );
              expect(
                (yield* service.checkAll).find(
                  (value) => value.name === work.name,
                ),
              ).toEqual(refusedStatus(work));
              expect(calls.sort()).toEqual([
                "probe:claude",
                `probe:${sibling.name}`,
              ]);
              expect(stored(home).accounts.slice(0, 2)).toEqual(accounts);
              yield* forgetStatus(home, {
                account: work,
                folderId: good.identity,
              });
              expect(stored(home).accounts[0]).toEqual(refused);
              yield* store.remove(work.name, yield* RuntimeRegistry);
              yield* store.add("claude", "work");
              expect(
                (yield* service.read).find((value) => value.name === work.name)
                  ?.signIn,
              ).toEqual({ state: "unknown", reason: "not-checked" });
            }).pipe(
              Effect.provide(provideRegistry(store, [fakeRuntime({ calls })])),
            );
          }),
        ),
      );
    } finally {
      close();
    }
  });
}

// Reason: raw data without a readable name has no account owner but must retain its position through sibling writes.
test("unattributable entries survive write-back without changing any account status", async () => {
  const { home, close } = scratch();
  const notices: string[] = [];
  const stderr = spyOn(process.stderr, "write").mockImplementation((line) => {
    notices.push(String(line));
    return true;
  });
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(home);
          const work = yield* store.add("claude", "work");
          const raw = {
            kind: work.kind,
            identity: snapshot(home, work).identity,
            signIn: { state: "future-state" },
          };
          const good = snapshot(home, work);
          writeJson(home, AccountStore.statusesPath(home), {
            version: 1,
            futureTop: true,
            accounts: [raw, null, good],
          });
          const { identity: _, ...publicGood } = good;
          expect(
            AccountStore.readStatuses(home).find(
              (value) => value.name === work.name,
            ),
          ).toEqual(publicGood);
          yield* Effect.gen(function* () {
            const service = yield* AccountStore.makeStatuses(
              home,
              yield* RuntimeRegistry,
            );
            yield* service.check(work.name);
            expect(stored(home).accounts.slice(0, 2)).toEqual([raw, null]);
            expect(stored(home).accounts[2].signIn.state).toBe("not-signed-in");
            expect(stored(home).futureTop).toBe(true);
          }).pipe(
            Effect.provide(
              provideRegistry(store, [fakeRuntime({ calls: [] })]),
            ),
          );
          expect(
            notices.filter((line) =>
              line.startsWith(AccountStore.statusesPath(home)),
            ),
          ).toEqual([
            `${AccountStore.statusesPath(home)} an account status needs a newer build; leaving it as stored.\n`,
          ]);
        }),
      ),
    );
  } finally {
    stderr.mockRestore();
    close();
  }
});

// Reason: a remembered observation must not overwrite a future entry when the shared file changes later.
test("the latest observation recheck leaves a newly refused entry untouched", async () => {
  const { home, close } = scratch();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(home);
          const work = yield* store.add("claude", "work");
          const changed = yield* Deferred.make<void>();
          const rechecked = yield* Deferred.make<void>();
          let subscriptions = 0;
          // Drive the production recheck loop with one deterministic folder notification.
          const changes = spyOn(StoreFiles, "folderChanges").mockImplementation(
            () =>
              subscriptions++ === 0
                ? Stream.concat(
                    Stream.fromEffect(Deferred.await(changed)),
                    Stream.fromEffectDrain(
                      Deferred.succeed(rechecked, undefined),
                    ),
                  )
                : Stream.empty,
          );
          try {
            const calls: string[] = [];
            yield* Effect.gen(function* () {
              const service = yield* AccountStore.makeStatuses(
                home,
                yield* RuntimeRegistry,
              );
              yield* service.check(work.name);
              const refused = {
                ...snapshot(home, work),
                signIn: { state: "future-state" },
              };
              writeJson(home, AccountStore.statusesPath(home), {
                version: 1,
                accounts: [refused],
              });
              const before = bytes(home);
              const inode = statSync(AccountStore.statusesPath(home)).ino;
              yield* Deferred.succeed(changed, undefined);
              yield* Deferred.await(rechecked);
              expect(bytes(home)).toBe(before);
              expect(statSync(AccountStore.statusesPath(home)).ino).toBe(inode);
              expect(
                (yield* service.read).find((value) => value.name === work.name),
              ).toEqual(refusedStatus(work));
              expect(calls).toEqual(["probe:work"]);
            }).pipe(
              Effect.provide(provideRegistry(store, [fakeRuntime({ calls })])),
            );
          } finally {
            changes.mockRestore();
          }
        }),
      ),
    );
  } finally {
    close();
  }
});

// Reason: a refusal appearing during an in-flight probe owns the write boundary, even after the probe completes.
test("a probe already in flight cannot replace a newly refused entry", async () => {
  const { home, close } = scratch();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(home);
          const work = yield* store.add("claude", "work");
          const started = yield* Deferred.make<void>();
          const finish = yield* Deferred.make<void>();
          const calls: string[] = [];
          const fake = fakeRuntime({
            calls,
            probe: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(finish)),
                Effect.as({
                  signIn: { state: "signed-in" },
                  limits: [],
                  checkedAt: "2026-11-11T12:00:00Z",
                }),
              ),
          });
          yield* Effect.gen(function* () {
            const service = yield* AccountStore.makeStatuses(
              home,
              yield* RuntimeRegistry,
            );
            const checking = yield* service
              .check(work.name)
              .pipe(Effect.forkScoped({ startImmediately: true }));
            yield* Deferred.await(started);
            writeJson(home, AccountStore.statusesPath(home), {
              version: 1,
              accounts: [
                { ...snapshot(home, work), signIn: { state: "future-state" } },
              ],
            });
            const before = bytes(home);
            const inode = statSync(AccountStore.statusesPath(home)).ino;
            yield* Deferred.succeed(finish, undefined);
            expect(yield* Fiber.join(checking)).toEqual(refusedStatus(work));
            expect(bytes(home)).toBe(before);
            expect(statSync(AccountStore.statusesPath(home)).ino).toBe(inode);
            expect(calls).toEqual(["probe:work"]);
          }).pipe(Effect.provide(provideRegistry(store, [fake])));
        }),
      ),
    );
  } finally {
    close();
  }
});
