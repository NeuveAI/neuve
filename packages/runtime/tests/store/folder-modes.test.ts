import { expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { neuveFolder } from "../../src/store/files.ts";
import {
  AccountStore,
  RuntimeRegistry,
  fakeRuntime,
  folderOf,
  provideRegistry,
  recordFile,
  scratch,
} from "./fixtures.ts";

function rootAt(home: string, mode: number) {
  const root = neuveFolder(home);
  mkdirSync(root, { recursive: true });
  chmodSync(root, mode);
  return root;
}

function refuses<A>(
  effect: Effect.Effect<A, AccountStore.StoreError>,
  message: string,
) {
  const result = Effect.runSync(Effect.result(effect));
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") expect(result.failure.message).toBe(message);
}

// Reason: upgrades already have settings in a public-readable root; only account data must be private.
test("0755 settings root supports account and status writes without changing its mode", async () => {
  const { home, close } = scratch();
  const root = rootAt(home, 0o755);
  const settings = '{"telemetry":{"enabled":true}}\n';
  writeFileSync(join(root, "settings.json"), settings);
  const calls: string[] = [];
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(home);
          const account = yield* store.add("claude", "work");
          expect((yield* store.list).map((entry) => entry.name)).toContain(
            account.name,
          );
          yield* Effect.gen(function* () {
            const registry = yield* RuntimeRegistry;
            const statuses = yield* AccountStore.makeStatuses(home, registry);
            expect(
              (yield* statuses.read).find(
                (entry) => entry.name === account.name,
              )?.signIn.state,
            ).toBe("unknown");
            yield* statuses.check(account.name);
            expect(
              (yield* statuses.read).find(
                (entry) => entry.name === account.name,
              )?.signIn.state,
            ).toBe("not-signed-in");
            expect(
              AccountStore.readStatuses(home).find(
                (entry) => entry.name === account.name,
              )?.signIn.state,
            ).toBe("not-signed-in");
          }).pipe(
            Effect.provide(provideRegistry(store, [fakeRuntime({ calls })])),
          );
          for (const path of [
            join(root, "accounts"),
            AccountStore.accountsPath(home),
            join(AccountStore.accountsPath(home), account.name),
            join(root, "accounts", "claude"),
            folderOf(account),
          ]) {
            expect(statSync(path).mode & 0o777).toBe(0o700);
          }
          for (const path of [
            recordFile(home, account.name),
            AccountStore.statusesPath(home),
          ]) {
            expect(statSync(path).mode & 0o777).toBe(0o600);
          }
          expect(calls).toEqual(["probe:work"]);
          expect(statSync(root).mode & 0o777).toBe(0o755);
          expect(readFileSync(join(root, "settings.json"), "utf8")).toBe(
            settings,
          );
        }),
      ),
    );
  } finally {
    close();
  }
});

// Reason: group read and traversal on the shared Neuve root do not permit changing account data.
test("0750 root supports adding and listing an account without changing its mode", async () => {
  const { home, close } = scratch();
  const root = rootAt(home, 0o750);
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(home);
          const account = yield* store.add("claude", "work");
          expect((yield* store.list).map((entry) => entry.name)).toContain(
            account.name,
          );
          expect(statSync(root).mode & 0o777).toBe(0o750);
        }),
      ),
    );
  } finally {
    close();
  }
});

for (const mode of [0o775, 0o757, 0o777]) {
  // Reason: another user's write access could replace the private account tree.
  test(`${mode.toString(8)} root refuses list, add and status reads before creating account data`, async () => {
    const { home, close } = scratch();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const store = yield* AccountStore.make(home);
            const root = rootAt(home, mode);
            const message = `${root} is writable by other users. Neuve needs it writable only by you.`;
            refuses(store.list, message);
            refuses(store.add("claude", "work"), message);
            expect(() => AccountStore.readStatuses(home)).toThrow(message);
            expect(readdirSync(root)).toEqual([]);
            expect(statSync(root).mode & 0o777).toBe(mode);
          }),
        ),
      );
    } finally {
      close();
    }
  });
}

// Reason: a non-writable root owned by someone else can still be replaced by its owner.
test("another owner's root refuses list, add and status reads without creating data", async () => {
  const { home, close } = scratch();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(home);
          const root = rootAt(home, 0o755);
          const uid = spyOn(process, "getuid").mockReturnValue(
            statSync(root).uid + 1,
          );
          try {
            const message = `${root} is owned by another user.`;
            refuses(store.list, message);
            refuses(store.add("claude", "work"), message);
            expect(() => AccountStore.readStatuses(home)).toThrow(message);
            expect(readdirSync(root)).toEqual([]);
          } finally {
            uid.mockRestore();
          }
        }),
      ),
    );
  } finally {
    close();
  }
});

// Reason: accepting the shared root must not relax privacy for the store's own folders.
test("0755 accounts under a 0755 root refuses with the account folder and mode unchanged", async () => {
  const { home, close } = scratch();
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const store = yield* AccountStore.make(home);
          const root = rootAt(home, 0o755);
          const accounts = join(root, "accounts");
          mkdirSync(accounts);
          chmodSync(accounts, 0o755);
          const message = `${accounts} can be read by other users (mode 0755). Neuve keeps account folders readable only by you (0700).`;
          refuses(store.list, message);
          refuses(store.add("claude", "work"), message);
          expect(() => AccountStore.readStatuses(home)).toThrow(message);
          expect(readdirSync(accounts)).toEqual([]);
          expect(statSync(accounts).mode & 0o777).toBe(0o755);
        }),
      ),
    );
  } finally {
    close();
  }
});

// Reason: a symlink can redirect the entire account tree outside Neuve's folder.
test("symlinked Neuve root refuses with the link's path", () => {
  const { home, close } = scratch();
  try {
    const root = neuveFolder(home);
    const target = join(home, "target");
    mkdirSync(dirname(root), { recursive: true });
    mkdirSync(target);
    symlinkSync(target, root);
    expect(() => AccountStore.readStatuses(home)).toThrow(
      `${root} is a symbolic link.`,
    );
    expect(readdirSync(target)).toEqual([]);
  } finally {
    close();
  }
});
