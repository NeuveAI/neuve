import { mock, spyOn } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { dirname } from "node:path";
import { Effect, Exit, Fiber, Logger, Scope, Stream } from "effect";

const watches: Array<{
  folder: string;
  changed: () => void;
  failed: () => void;
  closed: boolean;
}> = [];
mock.module("node:fs", () => ({
  ...fs,
  watch: (folder: string, changed: () => void) => {
    const entry = { folder, changed, failed: () => {}, closed: false };
    watches.push(entry);
    return {
      on(_event: string, failed: () => void) {
        entry.failed = failed;
        return this;
      },
      close() {
        entry.closed = true;
      },
    };
  },
}));

const {
  AccountStore,
  RuntimeRegistry,
  fakeRuntime,
  provideRegistry,
  recordFile,
  scratch,
} = await import("./fixtures.ts");
const { TurnLimit } = await import("../../src/index.ts");
const { privateDirectory } = await import("../../src/store/files.ts");
const { home, close } = scratch();
const logs: unknown[] = [];
const logger = Logger.make(({ message }) => {
  logs.push(message);
  if (
    process.argv[2]?.endsWith("logger-failure") &&
    Array.isArray(message) &&
    (message.includes(statusMessage) || message.includes(recordMessage))
  )
    throw new Error("Log sink unavailable");
});
// A scheduler turn drains effects queued by a controlled callback, without a sleep or filesystem event.
const drain = () => new Promise<void>((resolve) => setImmediate(resolve));
const changed = (folder: string) => {
  const watch = watches.find(
    (entry) => entry.folder === folder && !entry.closed,
  );
  assert.ok(watch, "watch must remain attached");
  watch.changed();
};
const failWatch = () => {
  const watch = watches[0];
  assert.ok(watch);
  watch.failed();
};
const statusMessage = "Neuve could not read account status.";
const recordMessage = "Neuve could not read account records.";
const scenario = process.argv[2];
const notices: string[] = [];
if (scenario === "malformed-record")
  spyOn(process.stderr, "write").mockImplementation((line) => {
    notices.push(String(line));
    return true;
  });
try {
  privateDirectory(home, AccountStore.accountsPath(home));
  const statusPath = AccountStore.statusesPath(home);
  const initial = AccountStore.readStatuses(home);
  const updated = initial.map((status) => ({
    ...status,
    checkedAt: "2026-11-10T12:00:00Z",
  }));
  const write = (statuses: typeof initial) =>
    fs.writeFileSync(
      statusPath,
      JSON.stringify({
        version: 1,
        accounts: statuses.map((status) => ({
          ...status,
          identity: status.name,
        })),
      }),
      { mode: 0o600 },
    );
  if (scenario === "status-source") {
    // statusSource uses its own Effect runtime, whose logger writes to console.log.
    const originalLog = console.log;
    console.log = (...values) => {
      logs.push(values.join(" "));
    };
    const source = AccountStore.statusSource(home);
    const delivered: Array<typeof initial> = [];
    const unsubscribe = source.subscribe((values) => delivered.push(values));
    try {
      await drain();
      assert.equal(watches.length, 2);
      write(updated);
      changed(dirname(statusPath));
      await drain();
      assert.deepEqual(delivered, [initial, updated]);
      fs.writeFileSync(statusPath, "{private-invalid-content", { mode: 0o600 });
      changed(dirname(statusPath));
      changed(dirname(statusPath));
      await drain();
      assert.throws(() => source.current());
      assert.throws(() =>
        source.subscribe(() => assert.fail("must not start")),
      );
      assert.equal(watches.length, 2);
      assert.ok(watches.every((entry) => !entry.closed));
      assert.equal(logs.length, 1);
      assert.ok(String(logs[0]).includes(statusMessage));
      assert.ok(!String(logs[0]).includes("private-invalid-content"));
      write(initial);
      changed(dirname(statusPath));
      await drain();
      assert.deepEqual(delivered, [initial, updated, initial]);
      fs.writeFileSync(statusPath, "{", { mode: 0o600 });
      changed(dirname(statusPath));
      await drain();
      assert.equal(
        logs.length,
        2,
        "a successful read resets the failure period",
      );
      failWatch();
      await drain();
      assert.ok(watches.every((entry) => entry.closed));
      assert.equal(
        logs.length,
        3,
        "real watch failure still ends and logs the subscription",
      );
    } finally {
      unsubscribe();
      await drain();
      console.log = originalLog;
    }
  } else if (scenario === "status-logger-failure") {
    write(initial);
    const delivered: Array<typeof initial> = [];
    const scope = Effect.runSync(Scope.make());
    const fiber = Effect.runFork(
      AccountStore.watchStatuses(home).pipe(
        Stream.runForEach((values) =>
          Effect.sync(() => {
            delivered.push(values);
          }),
        ),
        Effect.provideService(Scope.Scope, scope),
        Effect.provide(Logger.layer([logger])),
      ),
    );
    try {
      await drain();
      assert.deepEqual(delivered, [initial]);
      assert.equal(watches.length, 2);
      fs.writeFileSync(statusPath, "{", { mode: 0o600 });
      changed(dirname(statusPath));
      changed(dirname(statusPath));
      await drain();
      assert.deepEqual(delivered, [initial]);
      assert.deepEqual(logs, [[statusMessage]]);
      assert.ok(watches.every((entry) => !entry.closed));
      write(updated);
      changed(dirname(statusPath));
      await drain();
      assert.deepEqual(delivered, [initial, updated]);
      assert.ok(watches.every((entry) => !entry.closed));
      failWatch();
      const exit = await Effect.runPromise(Fiber.await(fiber));
      assert.ok(Exit.isFailure(exit));
      assert.ok(watches.every((entry) => entry.closed));
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  } else if (scenario === "watch-statuses") {
    fs.writeFileSync(statusPath, "{private-invalid-content", { mode: 0o600 });
    const delivered: Array<typeof initial> = [];
    const scope = Effect.runSync(Scope.make());
    const fiber = Effect.runFork(
      AccountStore.watchStatuses(home).pipe(
        Stream.runForEach((values) =>
          Effect.sync(() => {
            delivered.push(values);
          }),
        ),
        Effect.provideService(Scope.Scope, scope),
        Effect.provide(Logger.layer([logger])),
      ),
    );
    try {
      await drain();
      assert.deepEqual(delivered, []);
      assert.equal(watches.length, 2);
      assert.ok(watches.every((entry) => !entry.closed));
      assert.deepEqual(logs, [[statusMessage]]);
      assert.throws(() => AccountStore.readStatuses(home));
      write(updated);
      changed(dirname(statusPath));
      await drain();
      assert.deepEqual(delivered, [updated]);
      changed(dirname(statusPath));
      await drain();
      assert.deepEqual(
        delivered,
        [updated],
        "unchanged snapshots remain suppressed",
      );
      fs.writeFileSync(statusPath, "{", { mode: 0o600 });
      changed(dirname(statusPath));
      changed(dirname(statusPath));
      await drain();
      assert.deepEqual(logs, [[statusMessage], [statusMessage]]);
      write(initial);
      changed(dirname(statusPath));
      await drain();
      assert.deepEqual(delivered, [updated, initial]);
      failWatch();
      const exit = await Effect.runPromise(Fiber.await(fiber));
      assert.ok(Exit.isFailure(exit));
      assert.ok(watches.every((entry) => entry.closed));
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber));
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  } else {
    assert.ok(
      scenario === "malformed-record" ||
        scenario === "duplicate-record" ||
        scenario === "record-logger-failure",
    );
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(home);
          const account = yield* store.add("claude", "work");
          const calls: string[] = [];
          yield* Effect.gen(function* () {
            yield* (yield* RuntimeRegistry).openSession(account.name, {
              systemPrompt: "fake",
              tools: [],
              turnLimit: TurnLimit.parse(1),
              approvalPolicy: "allow",
            });
            const path = recordFile(home, account.name);
            const saved = fs.readFileSync(path, "utf8");
            const removing = path.replace(".active.json", ".removing.json");
            const corrupt = () =>
              scenario === "malformed-record"
                ? fs.writeFileSync(path, "{private-invalid-content", {
                    mode: 0o600,
                  })
                : fs.writeFileSync(removing, saved, { mode: 0o600 });
            const repair = () => {
              fs.writeFileSync(path, saved, { mode: 0o600 });
              if (scenario !== "malformed-record") fs.rmSync(removing);
            };
            corrupt();
            changed(AccountStore.accountsPath(home));
            yield* Effect.promise(drain);
            changed(AccountStore.accountsPath(home));
            yield* Effect.promise(drain);
            const firstPeriod = [...logs];
            assert.deepEqual(
              calls,
              scenario === "malformed-record"
                ? ["openSession:work", "closed:work"]
                : ["openSession:work"],
            );
            assert.ok(watches.every((entry) => !entry.closed));
            repair();
            changed(AccountStore.accountsPath(home));
            yield* Effect.promise(drain);
            corrupt();
            changed(AccountStore.accountsPath(home));
            yield* Effect.promise(drain);
            const secondPeriod = [...logs];
            repair();
            fs.renameSync(path, removing);
            changed(AccountStore.accountsPath(home));
            yield* Effect.promise(drain);
            assert.deepEqual(calls, ["openSession:work", "closed:work"]);
            assert.ok(watches.every((entry) => !entry.closed));
            assert.deepEqual(
              firstPeriod,
              scenario === "malformed-record" ? [] : [[recordMessage]],
            );
            assert.deepEqual(
              secondPeriod,
              scenario === "malformed-record"
                ? []
                : [[recordMessage], [recordMessage]],
            );
            if (scenario === "malformed-record")
              assert.deepEqual(notices, [
                `${path} is not a readable Neuve account record.\n`,
              ]);
            failWatch();
            yield* Effect.promise(drain);
            assert.deepEqual(
              logs,
              scenario === "malformed-record"
                ? [["The account file watch failed."]]
                : [
                    [recordMessage],
                    [recordMessage],
                    ["The account file watch failed."],
                  ],
            );
          }).pipe(
            Effect.provide(provideRegistry(store, [fakeRuntime({ calls })])),
          );
        }),
      ).pipe(Effect.provide(Logger.layer([logger]))),
    );
  }
  assert.ok(
    watches.every((entry) => entry.closed),
    "all watch scopes must close",
  );
} finally {
  mock.restore();
  close();
}
