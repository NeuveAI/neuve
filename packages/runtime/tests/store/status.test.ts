import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  PubSub,
  Queue,
  Scope,
  Stream,
} from "effect";
import {
  AccountName,
  RuntimeUnavailable,
  TurnFailed,
  TurnLimit,
  type AccountProbe,
  AccountStatus,
} from "../../src/index.ts";
import { privateDirectory } from "../../src/store/files.ts";
import { readStatuses } from "../../src/store/status.ts";
import {
  AccountStore,
  RuntimeRegistry,
  eventBus,
  fakeRuntime,
  folderOf,
  provideRegistry,
  scratch,
} from "./fixtures.ts";

// Reason: each account's folder selects its own sign-in and limits, with no automatic account switch.
test("two Claude folders keep independent states and rejected limits", async () => {
  const { home, close } = scratch();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(home);
          const first = yield* store.add("claude", "work");
          const second = yield* store.add("claude", "personal");
          const bus = yield* eventBus;
          const calls: string[] = [];
          const runtime = fakeRuntime({
            calls,
            events: Stream.fromPubSub(bus),
            probe: (account) =>
              Effect.succeed({
                signIn:
                  folderOf(account) === folderOf(first)
                    ? {
                        state: "signed-in",
                        email: "work@example.com",
                        sourceMatchesAccount: false,
                      }
                    : {
                        state: "not-signed-in",
                        hint: { kind: "command", command: "claude auth login" },
                      },
                limits: [
                  {
                    window: "weekly",
                    status: "allowed",
                    utilization: account.name === first.name ? 0.3 : 0.1,
                  },
                ],
                checkedAt: "2026-11-10T12:00:00Z",
              }),
          });
          yield* Effect.gen(function* () {
            const registry = yield* RuntimeRegistry;
            const service = yield* AccountStore.makeStatuses(home, registry);
            yield* AccountStore.makeStatuses(home, registry);
            const statuses = yield* Effect.all(
              [service.check(first.name), service.check(second.name)],
              { concurrency: 2 },
            );
            expect(statuses[0]?.signIn).toEqual({
              state: "signed-in",
              email: "work@example.com",
              sourceMatchesAccount: false,
            });
            expect(statuses[1]?.limits[0]?.utilization).toBe(0.1);
            const before = AccountStore.readStatuses(home).find(
              (status) => status.name === second.name,
            );
            const session = yield* registry.openSession(first.name, {
              systemPrompt: "fake",
              tools: [],
              turnLimit: TurnLimit.parse(1),
              approvalPolicy: "allow",
            });
            yield* session.events.pipe(
              Stream.runDrain,
              Effect.forkScoped({ startImmediately: true }),
            );
            yield* PubSub.publish(bus, {
              type: "rate-limit",
              turnId: "fake",
              at: "2026-11-10T13:00:00Z",
              window: "five-hour",
              status: "rejected",
              resetsAt: "2026-11-10T17:00:00Z",
            });
            yield* Effect.yieldNow;
            const after = AccountStore.readStatuses(home);
            expect(after.find((status) => status.name === second.name)).toEqual(
              before,
            );
            expect(
              after.find((status) => status.name === first.name)?.limits,
            ).toContainEqual({
              window: "five-hour",
              status: "rejected",
              observedAt: "2026-11-10T13:00:00Z",
              resetsAt: "2026-11-10T17:00:00Z",
            });
            expect(
              calls.filter((call) => call.startsWith("openSession:")),
            ).toEqual(["openSession:work"]);
            expect("next" in store).toBe(false);
            yield* PubSub.publish(bus, {
              type: "rate-limit",
              turnId: "older",
              at: "2026-11-10T12:30:00Z",
              window: "five-hour",
              status: "allowed",
            });
            yield* PubSub.publish(bus, {
              type: "usage",
              turnId: "fake",
              at: "2026-11-10T13:30:00Z",
              scope: "turn",
              costUsd: null,
              usage: {
                input: 1,
                output: 1,
                cacheWrite5m: 0,
                cacheWrite1h: 0,
                cacheRead: 0,
              },
            });
            yield* Effect.yieldNow;
            expect(AccountStore.readStatuses(home)).toEqual(after);
          }).pipe(Effect.provide(provideRegistry(store, [runtime])));
        }),
      ),
    );
  } finally {
    close();
  }
});

// Reason: status checks spend no model usage and duplicate callers subscribe to one probe.
test("concurrent checks share one probe, and list checks only probe", async () => {
  const { home, close } = scratch();
  try {
    const calls: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((done) => {
      release = done;
    });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(home);
          const account = yield* store.add("claude", "work");
          const runtime = fakeRuntime({
            calls,
            probe: () =>
              Effect.promise(() => gate).pipe(
                Effect.as({
                  signIn: { state: "signed-in" },
                  limits: [],
                  checkedAt: new Date().toISOString(),
                } satisfies AccountProbe),
              ),
          });
          yield* Effect.gen(function* () {
            const service = yield* AccountStore.makeStatuses(
              home,
              yield* RuntimeRegistry,
            );
            const other = yield* AccountStore.makeStatuses(
              home,
              yield* RuntimeRegistry,
            );
            const one = yield* service
              .check(account.name)
              .pipe(Effect.forkScoped({ startImmediately: true }));
            const two = yield* other
              .check(account.name)
              .pipe(Effect.forkScoped({ startImmediately: true }));
            yield* Effect.yieldNow;
            release();
            expect(yield* Fiber.join(one)).toEqual(yield* Fiber.join(two));
            expect(calls).toEqual(["probe:work"]);
            calls.length = 0;
            yield* service.checkAll;
            expect(calls.sort()).toEqual(["probe:claude", "probe:work"]);
            expect(calls.every((call) => call.startsWith("probe:"))).toBe(true);
          }).pipe(Effect.provide(provideRegistry(store, [runtime])));
        }),
      ),
    );
  } finally {
    close();
  }
});

// Reason: different accounts may check concurrently, but never more than four at once.
test("checks for different accounts run concurrently with a maximum of four", async () => {
  const { home, close } = scratch();
  try {
    let active = 0;
    let peak = 0;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(home);
          for (let i = 0; i < 6; i++) yield* store.add("claude", `work-${i}`);
          const runtime = fakeRuntime({
            calls: [],
            probe: () =>
              Effect.acquireUseRelease(
                Effect.sync(() => {
                  active++;
                  peak = Math.max(peak, active);
                }),
                () =>
                  Effect.sleep("20 millis").pipe(
                    Effect.as({
                      signIn: { state: "signed-in" },
                      limits: [],
                      checkedAt: new Date().toISOString(),
                    } satisfies AccountProbe),
                  ),
                () =>
                  Effect.sync(() => {
                    active--;
                  }),
              ),
          });
          yield* Effect.gen(function* () {
            const service = yield* AccountStore.makeStatuses(
              home,
              yield* RuntimeRegistry,
            );
            yield* service.checkAll;
            expect(peak).toBe(4);
            expect(active).toBe(0);
          }).pipe(Effect.provide(provideRegistry(store, [runtime])));
        }),
      ),
    );
  } finally {
    close();
  }
});

// Reason: a failed or timed-out check cannot erase earlier limits or pretend the sign-in was checked successfully.
test("failed probes keep limits and missing runtimes report their reason", async () => {
  const { home, close } = scratch();
  try {
    let fails = false;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(home);
          const account = yield* store.add("claude", "work");
          const runtime = fakeRuntime({
            calls: [],
            probe: (account) =>
              fails
                ? Effect.fail(
                    new TurnFailed({
                      account: account.name,
                      reason: "provider-failed",
                    }),
                  )
                : Effect.succeed({
                    signIn: { state: "signed-in" },
                    limits: [
                      { window: "weekly", status: "warning", utilization: 0.8 },
                    ],
                    checkedAt: "2026-01-01T12:00:00Z",
                  }),
          });
          yield* Effect.gen(function* () {
            const service = yield* AccountStore.makeStatuses(
              home,
              yield* RuntimeRegistry,
            );
            yield* service.check(account.name);
            fails = true;
            const after = yield* service.check(account.name);
            expect(after.signIn).toEqual({
              state: "unknown",
              reason: "check-failed",
            });
            expect(after.limits[0]?.utilization).toBe(0.8);
            expect(
              (yield* service.check(AccountName.parse("chatgpt"))).signIn,
            ).toEqual({
              state: "runtime-unavailable",
              reason: "not-registered",
            });
          }).pipe(Effect.provide(provideRegistry(store, [runtime])));
        }),
      ),
    );
  } finally {
    close();
  }
});

// Reason: coding chats read model choices from stored snapshots and the status file, so a newer probe's list must
// replace the stored one there, and a newer probe without a list must leave none rather than a stale one.
test("a newer probe's models replace the stored list in snapshots and the status file", async () => {
  const { home, close } = scratch();
  try {
    let step = 0;
    const lists = [
      [{ id: "old", displayName: "Old", description: "" }],
      [
        { id: "default", displayName: "Default", description: "Recommended" },
        { id: "haiku", displayName: "Haiku", description: "Fast" },
      ],
      undefined,
    ];
    const seen = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(home);
          const account = yield* store.add("claude", "work");
          const runtime = fakeRuntime({
            calls: [],
            probe: () =>
              Effect.sync(() => {
                const models = lists[step];
                const at = `2026-01-01T12:0${step}:00Z`;
                step++;
                return {
                  signIn: { state: "signed-in" as const },
                  limits: [],
                  checkedAt: at,
                  ...(models === undefined ? {} : { models }),
                };
              }),
          });
          return yield* Effect.gen(function* () {
            const service = yield* AccountStore.makeStatuses(
              home,
              yield* RuntimeRegistry,
            );
            const fromFile = () =>
              readStatuses(home).find((s) => s.name === account.name)?.models;
            const results: unknown[] = [];
            for (let i = 0; i < lists.length; i++) {
              const checked = yield* service.check(account.name);
              const read = (yield* service.read).find(
                (s) => s.name === account.name,
              );
              results.push([checked.models, read?.models, fromFile()]);
            }
            return results;
          }).pipe(Effect.provide(provideRegistry(store, [runtime])));
        }),
      ),
    );
    expect(seen).toEqual(lists.map((models) => [models, models, models]));
  } finally {
    close();
  }
});

// Reason: lost concurrent snapshot writes must heal from live services, retaining each newest observation.
test("two services merge probe and event observations, preserving newest windows and publishing changes", async () => {
  const { home, close } = scratch();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // The store's watch must attach to records directly, without re-attaching after creation.
          privateDirectory(home, AccountStore.accountsPath(home));
          const store = yield* AccountStore.make(home);
          const bus = yield* eventBus;
          const runtime = fakeRuntime({
            calls: [],
            events: Stream.fromPubSub(bus),
            probe: () =>
              Effect.succeed({
                signIn: { state: "signed-in", plan: "work" },
                limits: [
                  {
                    window: "weekly",
                    status: "allowed",
                    observedAt: "2026-11-10T12:00:00Z",
                  },
                ],
                checkedAt: "2026-11-10T12:00:00Z",
              }),
          });
          yield* Effect.gen(function* () {
            const registry = yield* RuntimeRegistry;
            const one = yield* AccountStore.makeStatuses(home, {
              ...registry,
              accountEvents: Stream.empty,
            });
            const secondScope = yield* Scope.make();
            yield* Effect.addFinalizer(() =>
              Scope.close(secondScope, Exit.void),
            );
            yield* AccountStore.makeStatuses(home, registry).pipe(
              Effect.provideService(Scope.Scope, secondScope),
            );
            const watched = yield* Stream.toPull(
              AccountStore.watchStatuses(home),
            );
            const changes = Stream.fromPull(Effect.succeed(watched));
            const waitFor = (predicate: (status: AccountStatus) => boolean) =>
              changes.pipe(
                Stream.filter((statuses) =>
                  statuses.some(
                    (status) => status.name === "work" && predicate(status),
                  ),
                ),
                Stream.take(1),
                Stream.runDrain,
                Effect.timeout("3 seconds"),
              );
            // Every watcher is attached to an existing folder before the observed writes.
            const account = yield* store.add("claude", "work");
            const entries = AccountStore.readAccounts(home);
            const initialFile = {
              version: 1,
              accounts: AccountStore.readStatuses(home).map((status) => ({
                ...status,
                identity:
                  entries.find((entry) => entry.account.name === status.name)
                    ?.folderId ?? status.name,
              })),
            };
            const replaceFile = (snapshot: typeof initialFile) =>
              Effect.sync(() => {
                const path = AccountStore.statusesPath(home);
                const temporary = `${path}.${process.pid}-${randomUUID()}.tmp`;
                try {
                  writeFileSync(temporary, JSON.stringify(snapshot), {
                    mode: 0o600,
                    flag: "wx",
                  });
                  renameSync(temporary, path);
                  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(
                    snapshot,
                  );
                } finally {
                  rmSync(temporary, { force: true });
                }
              });
            const session = yield* registry.openSession(account.name, {
              systemPrompt: "fake",
              tools: [],
              turnLimit: TurnLimit.parse(1),
              approvalPolicy: "allow",
            });
            yield* session.events.pipe(
              Stream.runDrain,
              Effect.forkScoped({ startImmediately: true }),
            );
            yield* PubSub.publish(bus, {
              type: "rate-limit",
              turnId: "fake",
              at: "2026-11-10T13:00:00Z",
              window: "five-hour",
              status: "rejected",
              resetsAt: "2026-11-10T17:00:00Z",
            });
            yield* waitFor((status) =>
              status.limits.some((limit) => limit.status === "rejected"),
            );
            const staleFile: typeof initialFile = JSON.parse(
              readFileSync(AccountStore.statusesPath(home), "utf8"),
            );
            expect(
              AccountStore.readStatuses(home).find(
                (status) => status.name === account.name,
              )?.signIn,
            ).toEqual({ state: "unknown", reason: "not-checked" });
            // Retain the first service and watchStatuses watches while retiring the second writer.
            yield* Scope.close(secondScope, Exit.void);
            yield* replaceFile(initialFile);
            const checked = yield* one.check(account.name);
            expect(checked.limits.map((limit) => limit.window)).toEqual([
              "weekly",
            ]);
            yield* waitFor((status) => status.signIn.state === "signed-in");
            // Publish the stale writer's saved merge after the newer probe's rename.
            yield* replaceFile(staleFile);
            yield* waitFor(
              (status) =>
                status.signIn.state === "signed-in" &&
                status.limits.length === 2,
            );
            expect(
              AccountStore.readStatuses(home).find(
                (status) => status.name === account.name,
              ),
            ).toEqual({
              name: account.name,
              kind: account.kind,
              signIn: { state: "signed-in", plan: "work" },
              checkedAt: "2026-11-10T12:00:00Z",
              limits: [
                {
                  window: "five-hour",
                  status: "rejected",
                  resetsAt: "2026-11-10T17:00:00Z",
                  observedAt: "2026-11-10T13:00:00Z",
                },
                {
                  window: "weekly",
                  status: "allowed",
                  observedAt: "2026-11-10T12:00:00Z",
                },
              ],
            });
            expect(statSync(AccountStore.statusesPath(home)).mode & 0o777).toBe(
              0o600,
            );
            const before = statSync(AccountStore.statusesPath(home)).mtimeMs;
            yield* one.check(account.name);
            expect(statSync(AccountStore.statusesPath(home)).mtimeMs).toBe(
              before,
            );
          }).pipe(Effect.provide(provideRegistry(store, [runtime])));
        }),
      ),
    );
  } finally {
    close();
  }
});

// Reason: a hung provider cannot hold a status check indefinitely or erase its saved windows.
test("a probe deadline produces check-failed after thirty seconds without another runtime call", async () => {
  const { TestClock } = await import("effect/testing");
  const { home, close } = scratch();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(home);
          const account = yield* store.add("claude", "work");
          const calls: string[] = [];
          const runtime = fakeRuntime({ calls, probe: () => Effect.never });
          yield* Effect.gen(function* () {
            const service = yield* AccountStore.makeStatuses(
              home,
              yield* RuntimeRegistry,
            );
            const fiber = yield* service
              .check(account.name)
              .pipe(Effect.forkScoped({ startImmediately: true }));
            yield* TestClock.adjust("30 seconds");
            expect((yield* Fiber.join(fiber)).signIn).toEqual({
              state: "unknown",
              reason: "check-failed",
            });
            expect(calls).toEqual(["probe:work"]);
          }).pipe(Effect.provide(provideRegistry(store, [runtime])));
        }),
      ).pipe(Effect.provide(TestClock.layer())),
    );
  } finally {
    close();
  }
});

// Reason: one caller cancelling must not interrupt the probe another caller still needs.
test("cancelling one subscriber preserves the other subscriber's probe", async () => {
  const { home, close } = scratch();
  try {
    let release = () => {};
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const calls: string[] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(home);
          const account = yield* store.add("claude", "work");
          const runtime = fakeRuntime({
            calls,
            probe: () =>
              Effect.promise(() => gate).pipe(
                Effect.as({
                  signIn: { state: "signed-in" },
                  limits: [],
                  checkedAt: new Date().toISOString(),
                } satisfies AccountProbe),
              ),
          });
          yield* Effect.gen(function* () {
            const service = yield* AccountStore.makeStatuses(
              home,
              yield* RuntimeRegistry,
            );
            const first = yield* service
              .check(account.name)
              .pipe(Effect.forkScoped({ startImmediately: true }));
            const second = yield* service
              .check(account.name)
              .pipe(Effect.forkScoped({ startImmediately: true }));
            yield* Effect.yieldNow;
            yield* Fiber.interrupt(first);
            release();
            expect((yield* Fiber.join(second)).signIn).toEqual({
              state: "signed-in",
            });
            expect(calls).toEqual(["probe:work"]);
          }).pipe(Effect.provide(provideRegistry(store, [runtime])));
        }),
      ),
    );
  } finally {
    close();
  }
});

// Reason: reusing a removed name must never inherit the former sign-in state or usage limits.
test("a re-added name starts unchecked after its former sign-in is removed", async () => {
  const { home, close } = scratch();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(home);
          const account = yield* store.add("claude", "work");
          const runtime = fakeRuntime({
            calls: [],
            probe: () =>
              Effect.succeed({
                signIn: { state: "signed-in" },
                limits: [{ window: "weekly", status: "rejected" }],
                checkedAt: new Date().toISOString(),
              }),
          });
          yield* Effect.gen(function* () {
            const registry = yield* RuntimeRegistry;
            const statuses = yield* AccountStore.makeStatuses(home, registry);
            yield* statuses.check(account.name);
            yield* store.remove(account.name, registry);
            yield* store.add("claude", "work");
            const fresh = (yield* statuses.read).find(
              (status) => status.name === account.name,
            );
            expect(fresh?.signIn).toEqual({
              state: "unknown",
              reason: "not-checked",
            });
            expect(fresh?.limits).toEqual([]);
          }).pipe(Effect.provide(provideRegistry(store, [runtime])));
        }),
      ),
    );
  } finally {
    close();
  }
});

// Reason: a probe started before removal must not publish into a new sign-in with the same name.
test("an old in-flight probe cannot update a re-added account", async () => {
  const { home, close } = scratch();
  try {
    let release = () => {};
    const gate = new Promise<void>((done) => {
      release = done;
    });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(home);
          const account = yield* store.add("claude", "work");
          const calls: string[] = [];
          const runtime = fakeRuntime({
            calls,
            probe: (current) =>
              (folderOf(current) === folderOf(account)
                ? Effect.promise(() => gate)
                : Effect.void
              ).pipe(
                Effect.as({
                  signIn: { state: "signed-in" },
                  limits: [],
                  checkedAt: new Date().toISOString(),
                } satisfies AccountProbe),
              ),
          });
          yield* Effect.gen(function* () {
            const registry = yield* RuntimeRegistry;
            const statuses = yield* AccountStore.makeStatuses(home, registry);
            const old = yield* statuses
              .check(account.name)
              .pipe(
                Effect.result,
                Effect.forkScoped({ startImmediately: true }),
              );
            yield* Effect.yieldNow;
            yield* store.remove(account.name, registry);
            yield* store.add("claude", "work");
            const fresh = yield* statuses
              .check(account.name)
              .pipe(Effect.timeout("2 seconds"));
            expect(fresh.signIn).toEqual({ state: "signed-in" });
            expect(calls).toEqual(["probe:work", "signOut:work", "probe:work"]);
            release();
            expect((yield* Fiber.join(old))._tag).toBe("Failure");
            expect(
              (yield* statuses.read).find(
                (status) => status.name === account.name,
              )?.signIn,
            ).toEqual({ state: "signed-in" });
          }).pipe(Effect.provide(provideRegistry(store, [runtime])));
        }),
      ),
    );
  } finally {
    close();
  }
});

// Reason: signin-ui needs current contents immediately and complete pushed sets after changes, without probes on subscribe.
test("statusSource reads defaults without files and pushes the full set after add, probe and removal", async () => {
  const { home, close } = scratch();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const source = AccountStore.statusSource(home);
          const defaults = source.current();
          expect(defaults.map((status) => String(status.name))).toEqual([
            "anthropic",
            "chatgpt",
            "claude",
          ]);
          expect(
            defaults.every(
              (status) =>
                status.signIn.state === "unknown" &&
                status.signIn.reason === "not-checked",
            ),
          ).toBe(true);
          expect(existsSync(AccountStore.neuveFolder(home))).toBe(false);
          privateDirectory(home, AccountStore.accountsPath(home));
          const store = yield* AccountStore.make(home);
          yield* store.add("claude", "first");
          const initial = source.current();
          yield* Effect.gen(function* () {
            const registry = yield* RuntimeRegistry;
            const service = yield* AccountStore.makeStatuses(home, registry);
            const watched = yield* Stream.toPull(
              AccountStore.watchStatuses(home),
            );
            const changes = yield* Effect.acquireRelease(
              Queue.make<ReadonlyArray<AccountStatus>>(),
              Queue.shutdown,
            );
            const delivered: Array<ReadonlyArray<AccountStatus>> = [];
            yield* Effect.acquireRelease(
              Effect.sync(() =>
                source.subscribe((statuses) => {
                  delivered.push(statuses);
                  Queue.offerUnsafe(changes, statuses);
                }),
              ),
              (unsubscribe) => Effect.sync(unsubscribe),
            );
            expect(delivered).toEqual([initial]);
            const next = (
              predicate: (statuses: ReadonlyArray<AccountStatus>) => boolean,
            ) =>
              Stream.fromQueue(changes).pipe(
                Stream.filter(predicate),
                Stream.take(1),
                Stream.runCollect,
                Effect.map((values) => values[0]),
                Effect.timeout("3 seconds"),
              );
            const fileHas = (
              predicate: (statuses: ReadonlyArray<AccountStatus>) => boolean,
            ) =>
              Stream.fromPull(Effect.succeed(watched)).pipe(
                Stream.filter(predicate),
                Stream.take(1),
                Stream.runDrain,
                Effect.timeout("3 seconds"),
              );
            const account = yield* store.add("claude", "work");
            const hasAccount = (statuses: ReadonlyArray<AccountStatus>) =>
              statuses.some((status) => status.name === account.name);
            yield* fileHas(hasAccount);
            expect(yield* next(hasAccount)).toEqual([
              ...initial,
              {
                name: account.name,
                kind: account.kind,
                signIn: { state: "unknown", reason: "not-checked" },
                limits: [],
                checkedAt: "1970-01-01T00:00:00.000Z",
              },
            ]);
            // A later subscriber reads the current set synchronously, even without a watch event.
            const late: Array<ReadonlyArray<AccountStatus>> = [];
            const unsubscribe = source.subscribe((statuses) => {
              late.push(statuses);
            });
            try {
              expect(late).toEqual([source.current()]);
            } finally {
              unsubscribe();
            }
            const checked = yield* service.check(account.name);
            const isChecked = (statuses: ReadonlyArray<AccountStatus>) =>
              statuses.some(
                (status) =>
                  status.name === account.name &&
                  status.signIn.state === "not-signed-in",
              );
            yield* fileHas(isChecked);
            expect(yield* next(isChecked)).toEqual([...initial, checked]);
            yield* store.remove(account.name, registry);
            yield* fileHas((statuses) => !hasAccount(statuses));
            expect(yield* next((statuses) => !hasAccount(statuses))).toEqual(
              initial,
            );
            expect(source.current()).toEqual(initial);
          }).pipe(
            Effect.provide(
              provideRegistry(store, [fakeRuntime({ calls: [] })]),
            ),
          );
        }),
      ),
    );
  } finally {
    close();
  }
});

// Reason: subscribing must read current files even if an existing watcher missed every intervening write.
test("new statusSource and watchStatuses subscribers start current and expose no private identity", async () => {
  const { home, close } = scratch();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(home);
          const source = AccountStore.statusSource(home);
          const unsubscribe = source.subscribe(() => {});
          yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
          yield* Effect.gen(function* () {
            const registry = yield* RuntimeRegistry;
            const statuses = yield* AccountStore.makeStatuses(home, registry);
            const account = yield* store.add("claude", "work");
            const checked = yield* statuses.check(account.name);
            const delivered: Array<ReadonlyArray<AccountStatus>> = [];
            const leave = source.subscribe((values) => {
              delivered.push(values);
            });
            try {
              expect(delivered).toEqual([yield* statuses.read]);
              expect(
                delivered[0]?.find((status) => status.name === account.name),
              ).toEqual(checked);
              for (const value of delivered[0] ?? [])
                expect(AccountStatus.safeParse(value).success).toBe(true);
            } finally {
              leave();
            }
            const initial = yield* AccountStore.watchStatuses(home).pipe(
              Stream.take(1),
              Stream.runCollect,
            );
            expect(initial).toEqual([yield* statuses.read]);
          }).pipe(
            Effect.provide(
              provideRegistry(store, [fakeRuntime({ calls: [] })]),
            ),
          );
        }),
      ),
    );
  } finally {
    close();
  }
});
