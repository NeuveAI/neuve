import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Deferred, Effect, Fiber, Scope } from "effect";
import {
  AccountName,
  AccountNotFound,
  RuntimeUnavailable,
  TurnLimit,
  type SessionPolicy,
} from "../../src/index.ts";
import { refuseCredentials } from "../../src/store/files.ts";
import {
  AccountStore,
  RuntimeRegistry,
  fakeRuntime,
  folderOf,
  provideRegistry,
  scratch,
  recordFile,
} from "./fixtures.ts";

// Reason: existing defaults must use the contract references and reads must create nothing.
test("defaults exist without files and anthropic reads the environment", async () => {
  const { home, close } = scratch();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(home);
          const accounts = yield* store.list;
          expect(accounts.map((account) => String(account.name))).toEqual([
            "anthropic",
            "chatgpt",
            "claude",
          ]);
          expect(accounts[0]?.credential).toEqual({
            kind: "environment",
            variable: "ANTHROPIC_API_KEY",
          });
          expect(
            AccountStore.readStatuses(home).every(
              (status) =>
                status.signIn.state === "unknown" && status.limits.length === 0,
            ),
          ).toBe(true);
          expect(existsSync(AccountStore.neuveFolder(home))).toBe(false);
        }),
      ),
    );
  } finally {
    close();
  }
});

// Reason: reference fields must reject whole credentials without rejecting ordinary names, emails, paths or versions.
test("credential guard matches whole trimmed credential shapes only and never reports their value", () => {
  for (const value of [
    "sk-ant-" + "a".repeat(20),
    "sk-" + "b".repeat(20),
    "eyJabc.def.",
    "eyJabc.def.ghi",
  ]) {
    expect(() => refuseCredentials({ label: `  ${value}  ` })).toThrow(
      "field accounts.label",
    );
    try {
      refuseCredentials({ label: value });
    } catch (error) {
      expect(String(error)).not.toContain(value);
    }
  }
  for (const value of [
    "jane.q.doe@example.com",
    `/Users/disk-admin/Library/Application Support/Neuve/accounts/claude/${randomUUID()}`,
    "task-runner",
    "Max 20x plan",
    "v1.2.3",
  ])
    expect(() => refuseCredentials({ label: value })).not.toThrow();
});

// Reason: exclusive folder publication must preserve unique names across stores, with one complete private record and folder.
test("concurrent adds leave one private record and folder and reject duplicate and reserved names", async () => {
  const { home, close } = scratch();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const one = yield* AccountStore.make(home);
          const two = yield* AccountStore.make(home);
          const results = yield* Effect.all(
            [
              one.add("claude", "work").pipe(Effect.result),
              two.add("claude", "work").pipe(Effect.result),
            ],
            { concurrency: 2 },
          );
          expect(
            results.filter((result) => result._tag === "Success"),
          ).toHaveLength(1);
          expect(
            results.filter((result) => result._tag === "Failure"),
          ).toHaveLength(1);
          for (const result of results)
            if (result._tag === "Failure")
              expect(result.failure.message).toBe(
                "That account name is already in use.",
              );
          const account = (yield* one.list).find(
            (account) => account.name === "work",
          );
          if (!account) throw new Error("missing account");
          expect(readdirSync(AccountStore.accountsPath(home))).toEqual([
            "work",
          ]);
          expect(
            readdirSync(
              join(AccountStore.neuveFolder(home), "accounts", "claude"),
            ),
          ).toHaveLength(1);
          expect(readdirSync(folderOf(account))).toEqual([]);
          expect(statSync(folderOf(account)).mode & 0o777).toBe(0o700);
          expect(statSync(AccountStore.accountsPath(home)).mode & 0o777).toBe(
            0o700,
          );
          expect(statSync(recordFile(home, account.name)).mode & 0o777).toBe(
            0o600,
          );
          expect(
            statSync(AccountStore.claimPath(home, account.name)).mode & 0o777,
          ).toBe(0o700);
          expect(recordFile(home, account.name)).toEndWith(".active.json");
          expect(
            JSON.parse(readFileSync(recordFile(home, account.name), "utf8")),
          ).not.toHaveProperty("state");
          expect(
            AccountStore.readAccounts(home).find(
              (entry) => entry.account.name === account.name,
            )?.state,
          ).toBe("active");
          for (const name of ["Bad", "../bad"])
            expect(
              (yield* one.add("claude", name).pipe(Effect.result))._tag,
            ).toBe("Failure");
          // `neuve review --route <name>` reads these first, so the refusal says so.
          for (const name of ["claude", "chatgpt", "anthropic", "openai"]) {
            const refused = yield* one.add("chatgpt", name).pipe(Effect.result);
            expect(
              refused._tag === "Failure" ? refused.failure.message : "added",
            ).toBe(
              `${name} already names a built-in route or account, and neuve review --route ${name} reads that first. Choose another name.`,
            );
          }
          expect(readdirSync(AccountStore.accountsPath(home))).toEqual([
            "work",
          ]);
        }),
      ),
    );
  } finally {
    close();
  }
});

// Reason: the next write removes recreated orphans and crash temporaries while an adding record protects its folder.
test("orphan sweep preserves non-UUID entries and adding folders", async () => {
  const { home, close } = scratch();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(home);
          const account = yield* store.add("claude", "pending");
          const path = recordFile(home, account.name);
          renameSync(path, path.replace(".active.json", ".adding.json"));
          const parent = join(
            AccountStore.neuveFolder(home),
            "accounts",
            "claude",
          );
          const orphan = join(parent, randomUUID());
          mkdirSync(orphan, { mode: 0o700 });
          mkdirSync(join(parent, "leave-me"), { mode: 0o700 });
          const temporary = join(AccountStore.accountsPath(home), ".crash.tmp");
          writeFileSync(temporary, "unfinished", { mode: 0o600 });
          expect(
            yield* store.directory.lookup(account.name, "use"),
          ).toBeUndefined();
          expect(
            yield* store.directory.lookup(account.name, "sign-out"),
          ).toEqual(account);
          expect(
            (yield* store.directory
              .withAccess(account.name, Effect.void)
              .pipe(Effect.result))._tag,
          ).toBe("Failure");
          yield* store.add("claude", "other");
          expect(existsSync(orphan)).toBe(false);
          expect(existsSync(temporary)).toBe(false);
          expect(existsSync(join(parent, "leave-me"))).toBe(true);
          expect(existsSync(folderOf(account))).toBe(true);
        }),
      ),
    );
  } finally {
    close();
  }
});

// Reason: invalid records must name the file without echoing contents, and metadata must remain private.
test("malformed, credential-bearing, public and symlinked records are refused", async () => {
  const { home, close } = scratch();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(home);
          const account = yield* store.add("claude", "work");
          const path = recordFile(home, account.name);
          const valid = readFileSync(path, "utf8");
          writeFileSync(path, "not-json-secret");
          expect(
            (yield* store.list).some((item) => item.name === account.name),
          ).toBe(false);
          for (const text of [
            JSON.stringify({ password: "sk-" + "x".repeat(20) }),
            JSON.stringify({
              ...JSON.parse(valid),
              account: { ...account, name: "claude" },
            }),
          ]) {
            writeFileSync(path, text);
            const result = yield* store.list.pipe(Effect.result);
            expect(result._tag).toBe("Failure");
            if (result._tag === "Failure") {
              expect(result.failure.message).toContain(
                AccountStore.claimPath(home, account.name),
              );
              expect(result.failure.message).not.toContain("secret");
              expect(result.failure.message).not.toContain("x".repeat(20));
            }
          }
          writeFileSync(path, valid);
          chmodSync(path, 0o644);
          expect((yield* store.list.pipe(Effect.result))._tag).toBe("Failure");
          chmodSync(path, 0o600);
          chmodSync(AccountStore.accountsPath(home), 0o755);
          expect((yield* store.list.pipe(Effect.result))._tag).toBe("Failure");
          chmodSync(AccountStore.accountsPath(home), 0o700);
          const target = join(home, "record");
          writeFileSync(target, valid, { mode: 0o600 });
          rmSync(path);
          symlinkSync(target, path);
          expect((yield* store.list.pipe(Effect.result))._tag).toBe("Failure");
        }),
      ),
    );
  } finally {
    close();
  }
});

const policy: SessionPolicy = {
  systemPrompt: "fake",
  tools: [],
  turnLimit: TurnLimit.parse(1),
  approvalPolicy: "allow",
};
// Reason: removing an account closes admission and its session before sign-out or deletion.
test("removal closes admission and session, signs out, deletes its folder, then drops its record", async () => {
  const { home, close } = scratch();
  const calls: string[] = [];
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(home);
          const account = yield* store.add("claude", "work");
          yield* Effect.gen(function* () {
            const registry = yield* RuntimeRegistry;
            yield* registry.openSession(account.name, policy);
            calls.length = 0;
            const callerScope = yield* Scope.Scope;
            yield* store.remove(account.name, registry, {
              onStep: (step) =>
                Effect.gen(function* () {
                  if (step === "admission-closed") {
                    expect(
                      (yield* store.directory
                        .withAccess(account.name, Effect.void)
                        .pipe(Effect.result))._tag,
                    ).toBe("Failure");
                    expect(
                      yield* store.directory.lookup(account.name, "use"),
                    ).toBeUndefined();
                    expect(
                      yield* store.directory.lookup(account.name, "sign-out"),
                    ).toEqual(account);
                    calls.push("admission-refused");
                  }
                  if (step === "folder-deleted") {
                    expect(existsSync(folderOf(account))).toBe(false);
                    calls.push("folder-deleted");
                  }
                  if (step === "record-dropped") {
                    expect(
                      yield* store.directory.lookup(account.name, "sign-out"),
                    ).toBeUndefined();
                    calls.push("record-dropped");
                  }
                }).pipe(
                  Effect.provideService(Scope.Scope, callerScope),
                  Effect.orDie,
                ),
            });
            expect(calls).toEqual([
              "admission-refused",
              "closed:work",
              "signOut:work",
              "folder-deleted",
              "record-dropped",
            ]);
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

// Reason: a missed watch event must cost at most until the next turn, with local finalizers awaited.
test("checkTurn closes unusable sessions even before the watch sees a removal", async () => {
  const { home, close } = scratch();
  const calls: string[] = [];
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(home);
          const other = yield* AccountStore.make(home);
          const account = yield* store.add("claude", "work");
          yield* Effect.gen(function* () {
            const registry = yield* RuntimeRegistry;
            yield* registry.openSession(account.name, policy);
            // No asynchronous boundary between the external record change and checkTurn.
            const path = recordFile(home, account.name);
            const removing = path.replace(".active.json", ".removing.json");
            renameSync(path, removing);
            expect(calls).toEqual(["openSession:work"]);
            const result = yield* store
              .checkTurn(account.name)
              .pipe(Effect.result);
            expect(result._tag).toBe("Failure");
            if (result._tag === "Failure")
              expect(result.failure).toBeInstanceOf(AccountNotFound);
            expect(calls).toEqual(["openSession:work", "closed:work"]);
            rmSync(removing);
            expect(
              (yield* store.checkTurn(account.name).pipe(Effect.result))._tag,
            ).toBe("Failure");
          }).pipe(
            Effect.provide(provideRegistry(other, [fakeRuntime({ calls })])),
          );
        }),
      ),
    );
  } finally {
    close();
  }
});

// Reason: replacing a name closes only its older sessions; the active replacement remains usable.
test("checkTurn closes old identities and preserves sessions on the active replacement", async () => {
  const { home, close } = scratch();
  const calls: string[] = [];
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(home);
          const account = yield* store.add("claude", "work");
          yield* Effect.gen(function* () {
            const registry = yield* RuntimeRegistry;
            yield* registry.openSession(account.name, policy);
            rmSync(recordFile(home, account.name));
            const replacement = yield* store.add("claude", "work");
            yield* registry.openSession(replacement.name, policy);
            yield* store.checkTurn(account.name);
            expect(calls.filter((call) => call === "closed:work")).toHaveLength(
              1,
            );
            expect(yield* store.directory.lookup(account.name, "use")).toEqual(
              replacement,
            );
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

// Reason: one stable watcher in another process closes its own session, without the remover awaiting it.
test("removal finishes before a child process releases its watched session finalizer", async () => {
  const { home, close } = scratch();
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(home);
          const account = yield* store.add("claude", "work");
          const process = Bun.spawn(
            [
              globalThis.process.execPath,
              "--no-env-file",
              join(import.meta.dir, "watched-session-child.ts"),
              home,
            ],
            {
              stdin: "pipe",
              stdout: "pipe",
              stderr: "inherit",
            },
          );
          child = process;
          const reader = process.stdout.getReader();
          const decoder = new TextDecoder();
          let pending = "";
          const line = () =>
            Effect.promise(async () => {
              for (;;) {
                const end = pending.indexOf("\n");
                if (end >= 0) {
                  const value = pending.slice(0, end);
                  pending = pending.slice(end + 1);
                  return value;
                }
                const value = await reader.read();
                if (value.done)
                  throw new Error("child exited before reporting its session");
                pending += decoder.decode(value.value, { stream: true });
              }
            }).pipe(Effect.timeout("3 seconds"));
          yield* Effect.gen(function* () {
            expect(yield* line()).toBe("ready");
            yield* store
              .remove(account.name, yield* RuntimeRegistry)
              .pipe(Effect.timeout("2 seconds"));
            expect(existsSync(folderOf(account))).toBe(false);
            expect(yield* line()).toBe("session-finalizer");
            process.stdin.write("finish\n");
            process.stdin.end();
            expect(
              yield* Effect.promise(() => process.exited).pipe(
                Effect.timeout("3 seconds"),
              ),
            ).toBe(0);
          }).pipe(
            Effect.provide(
              provideRegistry(store, [fakeRuntime({ calls: [] })]),
            ),
          );
        }),
      ),
    );
  } finally {
    if (child !== undefined) {
      child.kill();
      await child.exited;
    }
    close();
  }
});

// Reason: an admitted opening must settle with AccountNotFound and finalize before sessions-closed.
test("removal interrupts an opening in flight and waits for its finalizer and refusal", async () => {
  const { home, close } = scratch();
  const calls: string[] = [];
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(home);
          const account = yield* store.add("claude", "work");
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const base = fakeRuntime({ calls });
          const runtime = {
            ...base,
            openSession: (...args: Parameters<typeof base.openSession>) =>
              Effect.gen(function* () {
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    calls.push("opening-finalized");
                  }),
                );
                yield* Deferred.succeed(entered, undefined);
                yield* Deferred.await(release);
                return yield* base.openSession(...args);
              }).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    calls.push("opening-settled");
                  }),
                ),
              ),
          };
          yield* Effect.gen(function* () {
            const registry = yield* RuntimeRegistry;
            const opener = yield* registry
              .openSession(account.name, policy)
              .pipe(
                Effect.result,
                Effect.tap(() =>
                  Effect.sync(() => {
                    calls.push("opener-refused");
                  }),
                ),
                Effect.forkScoped({ startImmediately: true }),
              );
            yield* Deferred.await(entered);
            yield* store.remove(account.name, registry, {
              onStep: (step) =>
                Effect.sync(() => {
                  calls.push(step);
                }),
            });
            yield* Deferred.succeed(release, undefined);
            const result = yield* Fiber.join(opener);
            expect(result._tag).toBe("Failure");
            if (result._tag === "Failure")
              expect(result.failure).toBeInstanceOf(AccountNotFound);
            expect(calls).toEqual([
              "admission-closed",
              "opening-settled",
              "opening-finalized",
              "opener-refused",
              "sessions-closed",
              "signOut:work",
              "signed-out",
              "folder-deleted",
              "record-dropped",
            ]);
          }).pipe(
            Effect.provide(provideRegistry(store, [runtime])),
            Effect.ensuring(Deferred.succeed(release, undefined)),
          );
        }),
      ),
    );
  } finally {
    close();
  }
});

// Reason: a delayed remover must sign out and clear only its captured identity after a name is reused.
test("delayed removal preserves the replacement folder, record and checked status", async () => {
  const { home, close } = scratch();
  const signedOut: string[] = [];
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(home);
          const account = yield* store.add("claude", "work");
          const paused = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const runtime = fakeRuntime({
            calls: [],
            signOut: (account) =>
              Effect.sync(() => {
                signedOut.push(folderOf(account));
              }),
          });
          yield* Effect.gen(function* () {
            const registry = yield* RuntimeRegistry;
            const oldRemove = yield* store
              .remove(account.name, registry, {
                onStep: (step) =>
                  step === "sessions-closed"
                    ? Deferred.succeed(paused, undefined).pipe(
                        Effect.andThen(Deferred.await(release)),
                      )
                    : Effect.void,
              })
              .pipe(Effect.forkScoped({ startImmediately: true }));
            yield* Deferred.await(paused);
            yield* store.remove(account.name, registry);
            const replacement = yield* store.add("claude", "work");
            const statuses = yield* AccountStore.makeStatuses(home, registry);
            const checked = yield* statuses.check(replacement.name);
            const record = readFileSync(
              recordFile(home, replacement.name),
              "utf8",
            );
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(oldRemove);
            expect(signedOut).toEqual([folderOf(account), folderOf(account)]);
            expect(existsSync(folderOf(replacement))).toBe(true);
            expect(
              readFileSync(recordFile(home, replacement.name), "utf8"),
            ).toBe(record);
            expect(
              (yield* statuses.read).find(
                (status) => status.name === replacement.name,
              ),
            ).toEqual(checked);
            expect(
              yield* store.directory.lookup(replacement.name, "sign-out"),
            ).toEqual(replacement);
          }).pipe(
            Effect.provide(provideRegistry(store, [runtime])),
            Effect.ensuring(Deferred.succeed(release, undefined)),
          );
        }),
      ),
    );
  } finally {
    close();
  }
});

// Reason: absent runtimes and missing Claude Code must preserve sign-in data until explicitly forced; defaults remain protected.
test("unavailable sign-out preserves removing records and force resumes removal", async () => {
  const { home, close } = scratch();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(home);
          for (const runtime of [
            undefined,
            fakeRuntime({
              calls: [],
              signOut: (account) =>
                Effect.fail(
                  new RuntimeUnavailable({
                    account: account.name,
                    reason: "not-installed",
                  }),
                ),
            }),
          ]) {
            const account = yield* store.add("claude", "work");
            yield* Effect.gen(function* () {
              const registry = yield* RuntimeRegistry;
              for (const name of ["claude", "chatgpt", "anthropic", "unknown"])
                expect(
                  (yield* store
                    .remove(AccountName.parse(name), registry)
                    .pipe(Effect.result))._tag,
                ).toBe("Failure");
              const steps: string[] = [];
              const result = yield* store
                .remove(account.name, registry, {
                  onStep: (step) =>
                    Effect.sync(() => {
                      steps.push(step);
                    }),
                })
                .pipe(Effect.result);
              expect(result._tag).toBe("Failure");
              if (result._tag === "Failure") {
                expect(result.failure.message).toContain("Install Claude Code");
                expect(result.failure.message).toContain("--force");
              }
              expect(steps).toEqual(["admission-closed", "sessions-closed"]);
              expect(existsSync(folderOf(account))).toBe(true);
              expect(
                AccountStore.readAccounts(home).find(
                  (entry) => entry.account.name === account.name,
                )?.state,
              ).toBe("removing");
              steps.length = 0;
              yield* store.remove(account.name, registry, {
                force: true,
                onStep: (step) =>
                  Effect.sync(() => {
                    steps.push(step);
                  }),
              });
              expect(steps).toEqual([
                "sessions-closed",
                "sign-out-skipped",
                "folder-deleted",
                "record-dropped",
              ]);
            }).pipe(
              Effect.provide(provideRegistry(store, runtime ? [runtime] : [])),
            );
          }
        }),
      ),
    );
  } finally {
    close();
  }
});

// Reason: retrying concurrent removers must safely repeat sign-out, deletion and record drop.
test("two concurrent removals finish idempotently", async () => {
  const { home, close } = scratch();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(home);
          const second = yield* AccountStore.make(home);
          const account = yield* store.add("claude", "work");
          const both = yield* Deferred.make<void>();
          let count = 0;
          const runtime = fakeRuntime({
            calls: [],
            signOut: () =>
              Effect.gen(function* () {
                if (++count === 2) yield* Deferred.succeed(both, undefined);
                yield* Deferred.await(both);
              }),
          });
          yield* Effect.gen(function* () {
            const registry = yield* RuntimeRegistry;
            yield* Effect.all(
              [
                store.remove(account.name, registry),
                second.remove(account.name, registry),
              ],
              { concurrency: 2 },
            );
            expect(existsSync(folderOf(account))).toBe(false);
            expect(
              yield* store.directory.lookup(account.name, "sign-out"),
            ).toBeUndefined();
          }).pipe(Effect.provide(provideRegistry(store, [runtime])));
        }),
      ),
    );
  } finally {
    close();
  }
});

// Reason: a tampered reference must never allow deletion outside the account's Neuve parent.
test("removal refuses outside folder references", async () => {
  const { home, close } = scratch();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(home);
          const account = yield* store.add("claude", "work");
          const path = recordFile(home, account.name);
          const entry = JSON.parse(readFileSync(path, "utf8"));
          entry.account.credential.folder = home;
          writeFileSync(path, JSON.stringify(entry));
          yield* Effect.gen(function* () {
            const registry = yield* RuntimeRegistry;
            expect(
              (yield* store.remove(account.name, registry).pipe(Effect.result))
                ._tag,
            ).toBe("Failure");
            expect(existsSync(home)).toBe(true);
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

// Reason: following a symlink at deletion could erase a folder owned by another application.
test("removal refuses a Claude folder symlink that resolves outside its direct parent", async () => {
  const { home, close } = scratch();
  const outside = scratch();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(home);
          const account = yield* store.add("claude", "work");
          const { rmSync } = yield* Effect.promise(() => import("node:fs"));
          rmSync(folderOf(account), { recursive: true });
          symlinkSync(outside.home, folderOf(account));
          yield* Effect.gen(function* () {
            const registry = yield* RuntimeRegistry;
            expect(
              (yield* store.remove(account.name, registry).pipe(Effect.result))
                ._tag,
            ).toBe("Failure");
            expect(existsSync(outside.home)).toBe(true);
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
    outside.close();
  }
});

// Reason: concurrent local removals must await an already-closing session before either signs out.
test("concurrent removals await this process's session finalizers", async () => {
  const { home, close } = scratch();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(home);
          const account = yield* store.add("claude", "work");
          const closing = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const calls: string[] = [];
          const base = fakeRuntime({ calls });
          const runtime = {
            ...base,
            openSession: (...args: Parameters<typeof base.openSession>) =>
              Effect.gen(function* () {
                yield* Effect.addFinalizer(() =>
                  Deferred.succeed(closing, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                  ),
                );
                return yield* base.openSession(...args);
              }),
          };
          yield* Effect.gen(function* () {
            const registry = yield* RuntimeRegistry;
            yield* registry.openSession(account.name, policy);
            const first = yield* store
              .remove(account.name, registry)
              .pipe(Effect.forkScoped({ startImmediately: true }));
            yield* Deferred.await(closing);
            const second = yield* store
              .remove(account.name, registry)
              .pipe(Effect.forkScoped({ startImmediately: true }));
            yield* Effect.yieldNow;
            expect(calls).not.toContain("signOut:work");
            expect(existsSync(folderOf(account))).toBe(true);
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(first);
            yield* Fiber.join(second);
            expect(existsSync(folderOf(account))).toBe(false);
          }).pipe(
            Effect.provide(provideRegistry(store, [runtime])),
            Effect.ensuring(Deferred.succeed(release, undefined)),
          );
        }),
      ),
    );
  } finally {
    close();
  }
});

// Reason: F3, the filesystem mutation itself must stay bound to its generation across processes.
for (const operation of ["drop", "state"]) {
  test(`a stale ${operation} across processes preserves the active replacement record and folder`, async () => {
    const { home, close } = scratch();
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* AccountStore.make(home);
            const old = yield* store.add("claude", "work");
            const process = Bun.spawn(
              [
                globalThis.process.execPath,
                "--no-env-file",
                join(import.meta.dir, "stale-remover-child.ts"),
                home,
                operation,
              ],
              { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
            );
            child = process;
            const reader = process.stdout.getReader();
            const decoder = new TextDecoder();
            let pending = "";
            const line = () =>
              Effect.promise(async () => {
                for (;;) {
                  const end = pending.indexOf("\n");
                  if (end >= 0) {
                    const value = pending.slice(0, end);
                    pending = pending.slice(end + 1);
                    return value;
                  }
                  const value = await reader.read();
                  if (value.done)
                    throw new Error("child exited before the expected barrier");
                  pending += decoder.decode(value.value, { stream: true });
                }
              }).pipe(Effect.timeout("3 seconds"));
            yield* Effect.gen(function* () {
              expect(yield* line()).toBe("paused");
              yield* store.remove(old.name, yield* RuntimeRegistry);
              const replacement = yield* store.add("claude", "work");
              const path = recordFile(home, replacement.name);
              const contents = readFileSync(path, "utf8");
              const files = readdirSync(
                AccountStore.claimPath(home, replacement.name),
              );
              expect(existsSync(folderOf(replacement))).toBe(true);
              expect(folderOf(replacement)).not.toBe(folderOf(old));
              process.stdin.write("x");
              process.stdin.end();
              expect(yield* line()).toBe("removed");
              expect(
                yield* Effect.promise(() => process.exited).pipe(
                  Effect.timeout("3 seconds"),
                ),
              ).toBe(0);
              expect(readFileSync(path, "utf8")).toBe(contents);
              expect(
                readdirSync(AccountStore.claimPath(home, replacement.name)),
              ).toEqual(files);
              expect(existsSync(folderOf(replacement))).toBe(true);
              expect(
                AccountStore.readAccounts(home).find(
                  (entry) => entry.account.name === replacement.name,
                )?.state,
              ).toBe("active");
              expect(
                yield* store.directory.lookup(replacement.name, "use"),
              ).toEqual(replacement);
              yield* store.checkTurn(replacement.name);
            }).pipe(
              Effect.provide(
                provideRegistry(store, [fakeRuntime({ calls: [] })]),
              ),
            );
          }),
        ),
      );
    } finally {
      if (child !== undefined) {
        child.kill();
        await child.exited;
      }
      close();
    }
  });
}

// Reason: crash leftovers do not claim a name; an atomic state rename remains readable after a crash.
test("empty and temporary-only claims are no account and moved records remain readable", async () => {
  const { home, close } = scratch();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(home);
          const pending = yield* store.add("claude", "pending");
          const path = recordFile(home, pending.name);
          const content = readFileSync(path, "utf8");
          renameSync(path, path.replace(".active.json", ".adding.json"));
          expect(readFileSync(recordFile(home, pending.name), "utf8")).toBe(
            content,
          );
          expect(
            yield* store.directory.lookup(pending.name, "use"),
          ).toBeUndefined();
          expect(
            yield* store.directory.lookup(pending.name, "sign-out"),
          ).toEqual(pending);
          const empty = AccountStore.claimPath(
            home,
            AccountName.parse("empty"),
          );
          const temporaryOnly = AccountStore.claimPath(
            home,
            AccountName.parse("unfinished"),
          );
          mkdirSync(empty, { mode: 0o700 });
          mkdirSync(temporaryOnly, { mode: 0o700 });
          writeFileSync(join(temporaryOnly, ".partial"), "unfinished", {
            mode: 0o600,
          });
          const temporary = join(
            AccountStore.accountsPath(home),
            ".crashed-claim",
          );
          mkdirSync(temporary, { mode: 0o700 });
          writeFileSync(join(temporary, "partial"), "unfinished", {
            mode: 0o600,
          });
          // Reason: a crash after taking a claim leaves a tombstone that any later sweep can delete.
          const tombstone = join(
            AccountStore.accountsPath(home),
            `.swept-${process.pid}-${randomUUID()}`,
          );
          mkdirSync(tombstone, { mode: 0o700 });
          writeFileSync(join(tombstone, "partial"), "unfinished", {
            mode: 0o600,
          });
          expect(
            (yield* store.list).map((account) => account.name),
          ).not.toContain("empty");
          expect(
            (yield* store.list).map((account) => account.name),
          ).not.toContain("unfinished");
          yield* store.add("claude", "empty");
          expect(existsSync(temporary)).toBe(false);
          expect(existsSync(tombstone)).toBe(false);
          expect(existsSync(temporaryOnly)).toBe(false);
          expect(existsSync(folderOf(pending))).toBe(true);
        }),
      ),
    );
  } finally {
    close();
  }
});

// Reason: multiple generation files are corrupt metadata, and diagnostics must not echo their contents.
test("a claim with multiple record files is refused with only its folder in the error", async () => {
  const { home, close } = scratch();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(home);
          const account = yield* store.add("claude", "work");
          const claim = AccountStore.claimPath(home, account.name);
          writeFileSync(
            join(claim, `${randomUUID()}.active.json`),
            "private-content",
            { mode: 0o600 },
          );
          const result = yield* store.list.pipe(Effect.result);
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") {
            expect(result.failure.message).toContain(claim);
            expect(result.failure.message).not.toContain("private-content");
          }
        }),
      ),
    );
  } finally {
    close();
  }
});
