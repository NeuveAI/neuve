import { expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Effect } from "effect";
import { type Account, type LimitWindow } from "../../src/index.ts";
import { writeJson } from "../../src/store/files.ts";
import {
  AccountStore,
  RuntimeRegistry,
  fakeRuntime,
  folderOf,
  provideRegistry,
  recordFile,
  scratch,
} from "./fixtures.ts";

const status = (name: string, identity?: string) => ({
  name,
  kind: "claude-subscription",
  ...(identity === undefined ? {} : { identity }),
  signIn: { state: "unknown", reason: "not-checked" },
  limits: [],
  checkedAt: "1970-01-01T00:00:00.000Z",
  futureKey: { kept: true },
});
const stored = (home: string) =>
  JSON.parse(readFileSync(AccountStore.statusesPath(home), "utf8"));
const identityOf = (home: string, account: Account) =>
  AccountStore.readAccounts(home).find(
    (entry) => entry.account.name === account.name,
  )?.folderId;

// Reason: one additive record field must not hide this account or its siblings from a worker directory.
test("newer account fields read through make and remain in the record", async () => {
  const { home, close } = scratch();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const setup = yield* AccountStore.make(home);
          const account = yield* setup.add("claude", "work");
          yield* setup.add("claude", "sibling");
          const path = recordFile(home, account.name);
          const raw = JSON.parse(readFileSync(path, "utf8"));
          writeFileSync(
            path,
            JSON.stringify({
              ...raw,
              account: { ...raw.account, label: "newer" },
              futureKey: true,
            }),
          );
          const store = yield* AccountStore.make(home);
          expect(yield* store.directory.lookup(account.name, "use")).toEqual(
            account,
          );
          expect((yield* store.list).map((item) => item.name)).toContain(
            account.name,
          );
          expect(
            (yield* store.list).map((item) => String(item.name)),
          ).toContain("sibling");
          expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
            ...raw,
            account: { ...raw.account, label: "newer" },
            futureKey: true,
          });
        }),
      ),
    );
  } finally {
    close();
  }
});

for (const corrupt of ["invalid-json", "newer-variant"]) {
  // Reason: refusing one record must keep its name and folder while other accounts remain usable.
  test(`a ${corrupt} record is omitted, reported once and still owns its name and folder`, async () => {
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
            const setup = yield* AccountStore.make(home);
            const account = yield* setup.add("claude", "work");
            yield* setup.add("claude", "sibling");
            const path = recordFile(home, account.name);
            const contents =
              corrupt === "invalid-json"
                ? "unprintable-secret"
                : JSON.stringify({ version: 2, account });
            writeFileSync(path, contents);
            const store = yield* AccountStore.make(home);
            expect(
              (yield* store.list).map((item) => String(item.name)),
            ).toContain("sibling");
            expect(
              yield* store.directory
                .lookup(account.name, "use")
                .pipe(Effect.result),
            ).toMatchObject({
              _tag: "Failure",
              failure: {
                _tag: "AccountNeedsNewerBuild",
                account: account.name,
              },
            });
            expect(
              (yield* store.add("claude", "work").pipe(Effect.result))._tag,
            ).toBe("Failure");
            yield* store.add("claude", "trigger-sweep");
            expect(existsSync(folderOf(account))).toBe(true);
            yield* Effect.gen(function* () {
              expect(
                (yield* store
                  .remove(account.name, yield* RuntimeRegistry)
                  .pipe(Effect.result))._tag,
              ).toBe("Failure");
            }).pipe(
              Effect.provide(
                provideRegistry(store, [fakeRuntime({ calls: [] })]),
              ),
            );
            expect(readFileSync(path, "utf8")).toBe(contents);
            expect(notices.filter((line) => line.includes(path))).toEqual([
              `${path} is not a readable Neuve account record.\n`,
            ]);
            expect(notices.join("")).not.toContain("unprintable-secret");
          }),
        ),
      );
    } finally {
      stderr.mockRestore();
      close();
    }
  });
}

// Reason: a status reader must accept additive fields at both stored levels without probing.
test("newer status fields read through readStatuses and statusSource", () => {
  const { home, close } = scratch();
  try {
    writeJson(home, AccountStore.statusesPath(home), {
      version: 1,
      futureKey: true,
      accounts: [
        { ...status("claude", "claude"), checkedAt: "2026-11-11T00:00:00Z" },
      ],
    });
    expect(
      AccountStore.readStatuses(home).find((item) => item.name === "claude")
        ?.checkedAt,
    ).toBe("2026-11-11T00:00:00Z");
    expect(AccountStore.statusSource(home).current()).toEqual(
      AccountStore.readStatuses(home),
    );
  } finally {
    close();
  }
});

// Reason: probe write-back and removal must preserve unlisted, legacy and duplicate raw entries and newer fields.
test("check and remove preserve newer status data and unlisted occurrences", async () => {
  const { home, close } = scratch();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(home);
          const account = yield* store.add("claude", "work");
          const refused = yield* store.add("claude", "refused");
          const refusedStatus = status("refused", identityOf(home, refused));
          writeFileSync(recordFile(home, refused.name), "invalid");
          const work = status("work", identityOf(home, account));
          const kept = [
            status("newer-default", "newer-default"),
            status("work"),
            { ...work, futureKey: { duplicate: true } },
            { ...work, kind: "chatgpt-subscription" },
            status("duplicate", "duplicate"),
            { ...status("duplicate", "duplicate"), futureKey: { other: true } },
            refusedStatus,
          ];
          writeJson(home, AccountStore.statusesPath(home), {
            version: 1,
            futureKey: { top: true },
            accounts: [work, ...kept],
          });
          yield* Effect.gen(function* () {
            const registry = yield* RuntimeRegistry;
            const service = yield* AccountStore.makeStatuses(home, registry);
            const checked = yield* service.check(account.name);
            expect(checked.signIn.state).toBe("not-signed-in");
            const after = stored(home);
            expect(after.futureKey).toEqual({ top: true });
            expect(
              after.accounts.find(
                (item: { name: string }) => item.name === "work",
              ).futureKey,
            ).toEqual(work.futureKey);
            expect(after.accounts.slice(1, kept.length + 1)).toEqual(kept);
            yield* store.remove(account.name, registry);
            const removed = stored(home);
            expect(removed.futureKey).toEqual({ top: true });
            expect(removed.accounts.slice(0, kept.length - 1)).toEqual(
              kept.filter(
                (item) =>
                  item.identity !== work.identity || item.kind !== work.kind,
              ),
            );
            expect(
              removed.accounts.filter(
                (item: { name: string; kind: string }) =>
                  item.name === "work" && item.kind === work.kind,
              ),
            ).toEqual([status("work")]);
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

for (const modelSpecific of [false, true]) {
  // Reason: newer window fields must not freeze repeated probes, and full identities must keep their own fields.
  test(`repeated probes preserve newer limit fields with ${modelSpecific ? "model-specific and model-less windows" : "a weekly window"}`, async () => {
    const { home, close } = scratch();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* AccountStore.make(home);
            const account = yield* store.add("claude", "work");
            const windows: Array<LimitWindow & { futureKey: string }> = [
              { window: "weekly", status: "allowed", futureKey: "general" },
            ];
            if (modelSpecific)
              windows.unshift(
                {
                  window: "weekly",
                  model: "sonnet",
                  status: "allowed",
                  futureKey: "sonnet",
                },
                {
                  window: "weekly",
                  model: "opus",
                  status: "allowed",
                  futureKey: "opus",
                },
                {
                  window: "weekly",
                  model: "",
                  status: "allowed",
                  futureKey: "empty-model",
                },
              );
            writeJson(home, AccountStore.statusesPath(home), {
              version: 1,
              accounts: [
                {
                  ...status("work", identityOf(home, account)),
                  limits: windows.map((window) => ({
                    ...window,
                    observedAt: "2026-11-10T00:00:00Z",
                  })),
                },
              ],
            });
            let probes = 0;
            yield* Effect.gen(function* () {
              const service = yield* AccountStore.makeStatuses(
                home,
                yield* RuntimeRegistry,
              );
              for (const state of ["rejected", "warning"] as const) {
                const checked = yield* service.check(account.name);
                expect(checked.limits).toHaveLength(windows.length);
                expect(
                  AccountStore.statusSource(home)
                    .current()
                    .find((entry) => entry.name === account.name)?.limits,
                ).toEqual(checked.limits);
                const disk = stored(home).accounts[0];
                for (const { futureKey, ...window } of windows) {
                  const expected = {
                    ...window,
                    status: state,
                    utilization: probes === 1 ? 1 : 0.8,
                    observedAt: `2026-11-11T12:00:0${probes}Z`,
                  };
                  const match = disk.limits.filter(
                    (limit: LimitWindow) =>
                      limit.window === window.window &&
                      limit.model === window.model,
                  );
                  expect(match).toEqual([{ ...expected, futureKey }]);
                  expect(checked.limits).toContainEqual(expected);
                }
              }
              expect(probes).toBe(2);
            }).pipe(
              Effect.provide(
                provideRegistry(store, [
                  fakeRuntime({
                    calls: [],
                    probe: () =>
                      Effect.sync(() => {
                        probes++;
                        return {
                          signIn: { state: "signed-in" },
                          limits: windows.map(
                            ({ futureKey: _, ...window }) => ({
                              ...window,
                              status: probes === 1 ? "rejected" : "warning",
                              utilization: probes === 1 ? 1 : 0.8,
                              observedAt: `2026-11-11T12:00:0${probes}Z`,
                            }),
                          ),
                          checkedAt: `2026-11-11T12:00:0${probes}Z`,
                        };
                      }),
                  }),
                ]),
              ),
            );
          }),
        ),
      );
    } finally {
      close();
    }
  });
}

// Reason: ambiguous nested preservation must leave disk untouched and permit later probes to record again.
test("a status preservation refusal leaves the file and recording path alive", async () => {
  const { home, close } = scratch();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(home);
          const account = yield* store.add("claude", "work");
          const work = {
            ...status("work", identityOf(home, account)),
            limits: [
              { window: "weekly", status: "allowed", futureKey: true },
              { window: "weekly", status: "allowed", futureKey: "duplicate" },
            ],
          };
          writeJson(home, AccountStore.statusesPath(home), {
            version: 1,
            accounts: [work],
          });
          const before = readFileSync(AccountStore.statusesPath(home), "utf8");
          let checks = 0;
          yield* Effect.gen(function* () {
            const service = yield* AccountStore.makeStatuses(
              home,
              yield* RuntimeRegistry,
            );
            const notices: string[] = [];
            const stderr = spyOn(process.stderr, "write").mockImplementation(
              (line) => {
                notices.push(String(line));
                throw new Error("Diagnostic sink unavailable");
              },
            );
            try {
              yield* service.check(account.name);
              yield* service.check(account.name);
            } finally {
              stderr.mockRestore();
            }
            expect(readFileSync(AccountStore.statusesPath(home), "utf8")).toBe(
              before,
            );
            expect(notices).toEqual([
              `${AccountStore.statusesPath(home)} cannot preserve newer fields; leaving the status file unchanged.\n`,
            ]);
            writeJson(home, AccountStore.statusesPath(home), {
              version: 1,
              accounts: [status("work", identityOf(home, account))],
            });
            yield* service.check(account.name);
            expect(stored(home).accounts[0].signIn.state).toBe("signed-in");
            expect(checks).toBe(3);
          }).pipe(
            Effect.provide(
              provideRegistry(store, [
                fakeRuntime({
                  calls: [],
                  probe: () =>
                    Effect.sync(() => ({
                      signIn: { state: "signed-in" },
                      limits: [
                        {
                          window: "weekly",
                          status: "allowed",
                          utilization: 0.5,
                        },
                      ],
                      checkedAt: `2026-11-11T12:00:0${checks++}Z`,
                    })),
                }),
              ]),
            ),
          );
        }),
      ),
    );
  } finally {
    close();
  }
});

// Reason: a failed refusal notice must not turn one unreadable record into a whole-store failure.
test("a refused account stays isolated when stderr fails", async () => {
  const { home, close } = scratch();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(home);
          const account = yield* store.add("claude", "work");
          const path = recordFile(home, account.name);
          writeFileSync(path, "invalid");
          const stderr = spyOn(process.stderr, "write").mockImplementation(
            () => {
              throw new Error("Diagnostic sink unavailable");
            },
          );
          try {
            expect(
              (yield* store.list).map((item) => String(item.name)),
            ).toEqual(["anthropic", "chatgpt", "claude", "codex"]);
          } finally {
            stderr.mockRestore();
          }
        }),
      ),
    );
  } finally {
    close();
  }
});

for (const pause of ["sessions-closed", "signed-out"] as const) {
  // Reason: a record can become unreadable while removal yields, before sign-out or folder deletion.
  test(`remove refuses a record changed at ${pause} without deleting its folder or record`, async () => {
    const { home, close } = scratch();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* AccountStore.make(home);
            const account = yield* store.add("claude", "work");
            const calls: string[] = [];
            yield* Effect.gen(function* () {
              const registry = yield* RuntimeRegistry;
              const result = yield* store
                .remove(account.name, registry, {
                  onStep: (step) =>
                    Effect.sync(() => {
                      if (step === pause)
                        writeFileSync(
                          recordFile(home, account.name),
                          "unreadable",
                        );
                    }),
                })
                .pipe(Effect.result);
              expect(result._tag).toBe("Failure");
              expect(existsSync(folderOf(account))).toBe(true);
              expect(calls).toEqual(
                pause === "sessions-closed" ? [] : ["signOut:work"],
              );
              expect(
                AccountStore.readAccounts(home).some(
                  (entry) => entry.account.name === account.name,
                ),
              ).toBe(false);
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
