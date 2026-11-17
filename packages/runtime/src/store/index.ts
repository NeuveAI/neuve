import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Scope,
  Stream,
} from "effect";
import { z } from "zod";
import { DEFAULT_ACCOUNTS, RESERVED_ACCOUNT_NAMES } from "../defaults.ts";
import { forgetStatus } from "./status.ts";
import { Account, AccountName } from "../account.ts";
import {
  AccountNotFound,
  AccountNeedsNewerBuild,
  AccountStoreRefused,
  accountReadRefused,
  type RuntimeError,
} from "../errors.ts";
import {
  AccountDirectory,
  type AccountDirectoryShape,
  inMemoryAccountDirectory,
  type RuntimeRegistryShape,
} from "../registry.ts";
import {
  StoreError,
  UnreadableFile,
  accountsPath,
  folderChanges,
  folderKey,
  missing,
  unlinkIfPresent,
  neuveFolder,
  privateDirectory,
  privateParents,
  privatePath,
  readJson,
  storeNotice,
  storeIO,
  refuseCredentials,
} from "./files.ts";

export {
  StoreError,
  accountsPath,
  neuveFolder,
  statusesPath,
} from "./files.ts";
export * from "./status.ts";

const Record = z.strictObject({
  version: z.literal(1),
  account: Account,
  folderId: z.string().uuid().optional(),
});
const RecordState = z.enum(["adding", "active", "removing"]);
type AccountRecord = z.infer<typeof Record> & {
  state: z.infer<typeof RecordState>;
};
const RemovingAccount = Context.Reference<AccountRecord | undefined>(
  "@neuve/runtime/RemovingAccount",
  { defaultValue: () => undefined },
);
export const claimPath = (home: string, name: AccountName) =>
  join(accountsPath(home), name);
export const recordPath = (home: string, entry: AccountRecord) =>
  join(
    claimPath(home, entry.account.name),
    `${entry.folderId ?? "default"}.${entry.state}.json`,
  );
const isDefault = (name: AccountName) =>
  DEFAULT_ACCOUNTS.some((account) => account.name === name);

type AccountEntry = AccountRecord | { state: "refused"; name: AccountName };

export function readAccounts(home: string): ReadonlyArray<AccountRecord> {
  return readAccountEntries(home).filter((entry) => entry.state !== "refused");
}

function readAccountEntries(home: string): ReadonlyArray<AccountEntry> {
  const folder = accountsPath(home);
  privateParents(home, folder);
  const entries: AccountEntry[] = DEFAULT_ACCOUNTS.map((account) => ({
    version: 1,
    account,
    state: "active",
  }));
  if (!existsSync(folder)) return entries;
  let unnameable = 0;
  for (const name of readdirSync(folder)) {
    if (name.startsWith(".")) continue;
    const claim = join(folder, name);
    let invalid = claim;
    try {
      for (;;) {
        privatePath(claim, true);
        const files = readdirSync(claim).filter(
          (file) => !file.startsWith("."),
        );
        if (files.length === 0) break;
        if (files.length !== 1)
          throw new StoreError({
            message: `${claim} must hold exactly one account record.`,
          });
        const file = files[0];
        if (file === undefined) break;
        const path = join(claim, file);
        invalid = path;
        const match =
          /^(default|[0-9a-f-]+)\.(adding|active|removing)\.json$/.exec(file);
        const state = RecordState.safeParse(match?.[2]);
        let entry: z.infer<typeof Record> | undefined;
        try {
          entry = readJson(home, path, Record);
        } catch (error) {
          if (!(error instanceof UnreadableFile)) throw error;
          const parsed = AccountName.safeParse(name);
          if (parsed.success) {
            storeNotice(path, "is not a readable Neuve account record.");
            entries.push({ state: "refused", name: parsed.data });
          } else {
            unnameable++;
          }
          break;
        }
        // A concurrent state rename moves the file atomically. Read its new name
        // before deciding that no record protects the provider folder.
        if (entry === undefined) continue;
        if (
          !state.success ||
          match?.[1] !== (entry.folderId ?? "default") ||
          name !== entry.account.name ||
          isDefault(entry.account.name) ||
          entry.account.name === "openai"
        )
          throw new StoreError({
            message: `${path} has an invalid account identity or state.`,
          });
        entries.push({ ...entry, state: state.data });
        break;
      }
    } catch (error) {
      if (missing(error)) continue;
      if (
        error instanceof StoreError &&
        error.refusal !== undefined &&
        AccountName.safeParse(name).success
      )
        throw error;
      // Name only Neuve's folder, never submitted record contents or field names.
      throw new StoreError({
        message: `${invalid} is not a valid Neuve account record.`,
      });
    }
  }
  if (unnameable > 0)
    storeNotice(
      folder,
      `holds ${unnameable} account folders this build can't name; leaving them as stored.`,
    );
  return entries;
}

/** Even an unreadable record owns the folder named by its generation file. */
function hasFolderClaim(home: string, id: string): boolean {
  const records = accountsPath(home);
  if (!existsSync(records)) return false;
  for (const name of readdirSync(records)) {
    if (name.startsWith(".")) continue;
    const claim = join(records, name);
    try {
      privatePath(claim, true);
      if (
        readdirSync(claim).some((file) =>
          ["adding", "active", "removing"].some(
            (state) => file === `${id}.${state}.json`,
          ),
        )
      )
        return true;
    } catch (error) {
      if (!missing(error)) throw error;
    }
  }
  return false;
}

function refuseUnreadableMutation(home: string, entry: AccountRecord): void {
  if (
    !readAccounts(home).some(
      (current) =>
        current.account.name === entry.account.name &&
        current.folderId === entry.folderId,
    ) &&
    hasFolderClaim(home, entry.folderId ?? "default")
  )
    throw new StoreError({
      message: `${claimPath(home, entry.account.name)} is not a readable Neuve account record.`,
    });
}

/** Inspect Neuve's parents and account folder itself, never provider-owned contents. */
function sweep(home: string) {
  for (const kind of ["claude", "chatgpt"]) {
    const parent = join(neuveFolder(home), "accounts", kind);
    privateParents(home, parent);
    if (!existsSync(parent)) continue;
    for (const id of readdirSync(parent)) {
      if (
        !z.uuid().safeParse(id).success ||
        readAccounts(home).some((entry) => entry.folderId === id) ||
        hasFolderClaim(home, id)
      )
        continue;
      deleteOwnedFolder(home, parent, id);
    }
  }
  if (existsSync(accountsPath(home)))
    for (const file of readdirSync(accountsPath(home))) {
      const path = join(accountsPath(home), file);
      if (file.startsWith(".")) {
        const tombstone = file.startsWith(".swept-")
          ? path
          : join(accountsPath(home), `.swept-${process.pid}-${randomUUID()}`);
        if (tombstone !== path) {
          try {
            // Take the claim before traversing it. A publisher can only rename
            // the original path, so exactly one of these renames can win.
            renameSync(path, tombstone);
          } catch (error) {
            if (missing(error)) continue;
            throw error;
          }
        }
        rmSync(tombstone, { recursive: true, force: true });
      } else {
        try {
          privatePath(path, true);
          for (const temporary of readdirSync(path))
            if (temporary.startsWith("."))
              rmSync(join(path, temporary), { recursive: true, force: true });
        } catch (error) {
          if (!missing(error)) throw error;
        }
        removeEmptyClaim(path);
      }
    }
}
function removeEmptyClaim(path: string) {
  try {
    rmdirSync(path);
  } catch (error) {
    if (!missing(error) && !occupied(error)) throw error;
  }
}
function occupied(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "ENOTEMPTY" || error.code === "EEXIST")
  );
}

/** Publish a complete generation by claiming a name with a non-empty folder. */
function createRecord(home: string, entry: AccountRecord) {
  const { state: _state, ...content } = entry;
  refuseCredentials(content);
  const records = accountsPath(home);
  privateDirectory(home, records);
  for (let attempt = 0; attempt < 2; attempt++) {
    const temporary = join(records, `.${process.pid}-${randomUUID()}`);
    try {
      mkdirSync(temporary, { mode: 0o700 });
      writeFileSync(
        join(temporary, `${entry.folderId ?? "default"}.${entry.state}.json`),
        `${JSON.stringify(content)}\n`,
        { mode: 0o600, flag: "wx" },
      );
      renameSync(temporary, claimPath(home, entry.account.name));
      return;
    } catch (error) {
      if (occupied(error))
        throw new StoreError({
          message: "That account name is already in use.",
        });
      // A sweep can take the claim during the write or the publishing rename.
      if (!missing(error)) throw error;
      if (attempt === 1)
        throw new StoreError({
          message:
            "Another Neuve process was tidying the account files. Add the account again.",
        });
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
}
function publishClaimChange(home: string) {
  // Claim folders are one level down, and recursive watches lose events on macOS.
  const marker = join(
    accountsPath(home),
    `.${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(marker, "", { mode: 0o600, flag: "wx" });
  } finally {
    unlinkIfPresent(marker);
  }
}
function changeState(
  home: string,
  entry: AccountRecord,
  state: AccountRecord["state"],
) {
  refuseUnreadableMutation(home, entry);
  try {
    renameSync(recordPath(home, entry), recordPath(home, { ...entry, state }));
  } catch (error) {
    if (!missing(error)) throw error;
  }
  publishClaimChange(home);
  sweep(home);
}
function drop(home: string, entry: AccountRecord) {
  refuseUnreadableMutation(home, entry);
  unlinkIfPresent(recordPath(home, { ...entry, state: "removing" }));
  removeEmptyClaim(claimPath(home, entry.account.name));
  publishClaimChange(home);
  sweep(home);
}
function deleteOwnedFolder(home: string, parent: string, folderId: string) {
  privateParents(home, parent);
  const folder = join(parent, folderId);
  if (!existsSync(folder)) return;
  try {
    const resolved = realpathSync(folder);
    if (
      dirname(resolved) !== realpathSync(parent) ||
      resolved !== join(realpathSync(parent), folderId)
    )
      throw new StoreError({
        message: "Refusing to delete a folder outside Neuve's account folder.",
      });
    privatePath(folder, true);
    rmSync(folder, { recursive: true, force: true });
  } catch (error) {
    if (!missing(error)) throw error;
  }
}

function deleteFolder(home: string, entry: AccountRecord) {
  refuseUnreadableMutation(home, entry);
  const account = entry.account;
  if (
    account.credential.kind !== "claude-config-folder" &&
    account.credential.kind !== "neuve-sign-in"
  )
    throw new StoreError({
      message: "Removing key accounts is not supported.",
    });
  const folder = account.credential.folder;
  const parent = join(
    neuveFolder(home),
    "accounts",
    account.credential.kind === "claude-config-folder" ? "claude" : "chatgpt",
  );
  if (
    folder === undefined ||
    entry.folderId === undefined ||
    folder !== join(parent, entry.folderId)
  )
    throw new StoreError({
      message:
        "Refusing to delete a folder outside this account's Neuve folder.",
    });
  deleteOwnedFolder(home, parent, entry.folderId);
}

export type RemovalStep =
  | "admission-closed"
  | "sessions-closed"
  | "signed-out"
  | "sign-out-skipped"
  | "folder-deleted"
  | "record-dropped";
export interface RemoveOptions {
  readonly force?: boolean;
  readonly onStep?: (step: RemovalStep) => Effect.Effect<void>;
}
export interface AccountStoreShape {
  readonly directory: AccountDirectoryShape;
  readonly list: Effect.Effect<ReadonlyArray<Account>, StoreError>;
  readonly checkTurn: (name: AccountName) => Effect.Effect<void, RuntimeError>;
  readonly add: (
    kind: "claude" | "chatgpt",
    name: string,
  ) => Effect.Effect<Account, StoreError>;
  /**
   * Other processes close their own sessions when their record watch runs. Until then,
   * sign-out makes their next request require sign-in. A dying process can recreate
   * its folder, but no record can use it, and the next store write deletes it.
   */
  readonly remove: (
    name: AccountName,
    registry: RuntimeRegistryShape,
    options?: RemoveOptions,
  ) => Effect.Effect<void, StoreError | RuntimeError>;
}
export class AccountStore extends Context.Service<
  AccountStore,
  AccountStoreShape
>()("@neuve/runtime/AccountStore") {}

type Session = {
  home: string;
  scope: Scope.Closeable;
  account: Account;
  finished: Deferred.Deferred<void>;
  closing: Deferred.Deferred<void>;
  settled: Deferred.Deferred<void>;
  opening: Fiber.Fiber<unknown, unknown>;
};
const processSessions = new Set<Session>();

export const make = (
  home: string,
): Effect.Effect<AccountStoreShape, StoreError, Scope.Scope> =>
  Effect.gen(function* () {
    yield* storeIO(() => readAccounts(home));
    const key = yield* storeIO(() => folderKey(accountsPath(home)));
    const ownSessions = new Set<Session>();
    const sessions = () =>
      [...processSessions].filter((session) => session.home === key);
    // Scope.close is idempotent but a second close does not await the first close's finalizers.
    const closeSession = (session: Session) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          yield* Deferred.succeed(session.closing, undefined);
          yield* Fiber.interrupt(session.opening);
          yield* Deferred.await(session.settled);
          yield* Scope.close(session.scope, Exit.void);
          yield* Deferred.await(session.finished);
        }),
      );
    const closeSessions = (name: AccountName, account?: Account) =>
      Effect.forEach(
        sessions().filter(
          (session) =>
            session.account.name === name &&
            (account === undefined ||
              JSON.stringify(session.account) === JSON.stringify(account)),
        ),
        closeSession,
        {
          discard: true,
        },
      );
    yield* Effect.addFinalizer(() =>
      Effect.forEach([...ownSessions], closeSession, { discard: true }),
    );
    let readFailed = false;
    const refresh = storeIO(() => readAccounts(home)).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          readFailed = false;
        }),
      ),
      Effect.flatMap((entries) =>
        Effect.forEach(
          sessions().filter(
            (session) =>
              !entries.some(
                (entry) =>
                  entry.state === "active" &&
                  JSON.stringify(entry.account) ===
                    JSON.stringify(session.account),
              ),
          ),
          closeSession,
          { discard: true },
        ),
      ),
      Effect.catch(() => {
        if (readFailed) return Effect.void;
        readFailed = true;
        return Effect.logError("Neuve could not read account records.").pipe(
          Effect.ignoreCause,
        );
      }),
    );
    const changes = yield* Stream.toPull(folderChanges(accountsPath(home)));
    yield* Stream.fromPull(Effect.succeed(changes)).pipe(
      Stream.runForEach(() => refresh),
      Effect.catch((error) => Effect.logError(error.message)),
      Effect.forkScoped({ startImmediately: true }),
    );
    const available = (name: AccountName, purpose: "use" | "sign-out") =>
      Effect.gen(function* () {
        const captured = yield* RemovingAccount;
        if (purpose === "sign-out" && captured?.account.name === name)
          return captured.account;
        const declared = DEFAULT_ACCOUNTS.find(
          (account) => account.name === name,
        );
        if (declared !== undefined) return declared;
        const entry = yield* storeIO(() =>
          readAccountEntries(home).find((entry) =>
            entry.state === "refused"
              ? entry.name === name
              : entry.account.name === name,
          ),
        ).pipe(Effect.mapError((error) => refusedStore(home, name, error)));
        if (entry?.state === "refused")
          return yield* new AccountNeedsNewerBuild({ account: name });
        return entry !== undefined &&
          (purpose === "sign-out" || entry.state === "active")
          ? entry.account
          : undefined;
      });
    const checkTurn = (name: AccountName) =>
      Effect.gen(function* () {
        const current = yield* available(name, "use").pipe(
          Effect.tapError((error) =>
            accountReadRefused(error) ? closeSessions(name) : Effect.void,
          ),
        );
        if (current === undefined) {
          yield* closeSessions(name);
          return yield* new AccountNotFound({ account: name });
        }
        yield* Effect.forEach(
          sessions().filter(
            (session) =>
              session.account.name === name &&
              JSON.stringify(session.account) !== JSON.stringify(current),
          ),
          closeSession,
          { discard: true },
        );
      });
    const directory = AccountDirectory.of({
      lookup: available,
      checkTurn,
      withAccess: (name, open) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const caller = yield* Scope.Scope;
            const account = yield* available(name, "use");
            if (account === undefined)
              return yield* new AccountNotFound({ account: name });
            const child = yield* Scope.fork(caller);
            const finished = yield* Deferred.make<void>();
            const closing = yield* Deferred.make<void>();
            const settled = yield* Deferred.make<void>();
            // Fork suspended so registration precedes any provider work.
            const opening = yield* restore(
              Effect.gen(function* () {
                const admitted = yield* available(name, "use");
                if (JSON.stringify(admitted) !== JSON.stringify(account))
                  return yield* new AccountNotFound({ account: name });
                return yield* open;
              }),
            ).pipe(
              Effect.provideService(Scope.Scope, child),
              Effect.forkChild({ startImmediately: false }),
            );
            const session: Session = {
              home: key,
              scope: child,
              account,
              finished,
              closing,
              settled,
              opening,
            };
            yield* Scope.addFinalizer(
              child,
              Deferred.await(settled).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    processSessions.delete(session);
                    ownSessions.delete(session);
                  }),
                ),
                Effect.andThen(Deferred.succeed(finished, undefined)),
              ),
            );
            yield* Scope.addFinalizer(
              child,
              Deferred.succeed(closing, undefined).pipe(
                Effect.andThen(Fiber.interrupt(opening)),
              ),
            );
            ownSessions.add(session);
            processSessions.add(session);
            const joined = yield* restore(Fiber.join(opening)).pipe(
              Effect.exit,
            );
            const removed = yield* Deferred.isDone(closing);
            const result = removed
              ? Exit.fail(new AccountNotFound({ account: name }))
              : joined;
            if (Exit.isFailure(result)) yield* Fiber.interrupt(opening);
            yield* Deferred.succeed(settled, undefined);
            if (Exit.isFailure(result)) {
              yield* Scope.close(child, result);
              return yield* Effect.failCause(result.cause);
            }
            return result.value;
          }),
        ),
    });
    return AccountStore.of({
      directory,
      checkTurn,
      list: storeIO(() => readAccounts(home).map((entry) => entry.account)),
      add: (kind, name) =>
        storeIO(() => {
          const entries = readAccounts(home);
          const parsedName = AccountName.safeParse(name);
          if (!parsedName.success)
            throw new StoreError({
              message:
                "Use an account name of 1 to 63 lowercase letters, numbers or hyphens, starting with a letter or number.",
            });
          if (RESERVED_ACCOUNT_NAMES.includes(name))
            throw new StoreError({
              message: `${name} already names a built-in route or account, and neuve review --route ${name} reads that first. Choose another name.`,
            });
          if (
            (existsSync(claimPath(home, parsedName.data)) &&
              readdirSync(claimPath(home, parsedName.data)).some(
                (file) => !file.startsWith("."),
              )) ||
            entries.some((entry) => entry.account.name === name)
          )
            throw new StoreError({
              message: "That account name is already in use.",
            });
          const folderId = randomUUID();
          const folder = join(neuveFolder(home), "accounts", kind, folderId);
          const account = Account.parse(
            kind === "claude"
              ? {
                  name: parsedName.data,
                  kind: "claude-subscription",
                  runtime: "claude-code",
                  credential: { kind: "claude-config-folder", folder },
                }
              : {
                  name: parsedName.data,
                  kind: "chatgpt-subscription",
                  runtime: "pi",
                  credential: { kind: "neuve-sign-in", folder },
                },
          );
          const entry: AccountRecord = {
            version: 1,
            account,
            folderId,
            state: "adding",
          };
          createRecord(home, entry);
          sweep(home);
          privateDirectory(home, folder);
          changeState(home, entry, "active");
          return account;
        }),
      remove: (name, registry, options = {}) =>
        Effect.gen(function* () {
          if (isDefault(name))
            return yield* new StoreError({
              message:
                name === "claude"
                  ? "Claude Code owns this sign-in. Sign out yourself with claude auth logout."
                  : name === "chatgpt"
                    ? "Sign out with neuve auth logout openai."
                    : "This key is set where ANTHROPIC_API_KEY is set today.",
            });
          const step = (value: RemovalStep) =>
            options.onStep?.(value) ?? Effect.void;
          const entry = yield* storeIO(() => {
            const entry = readAccounts(home).find(
              (item) => item.account.name === name,
            );
            if (entry === undefined)
              throw new StoreError({ message: "Account not found." });
            return entry;
          });
          if (entry.state !== "removing") {
            yield* storeIO(() => changeState(home, entry, "removing"));
            yield* step("admission-closed");
          }
          yield* closeSessions(name, entry.account);
          yield* step("sessions-closed");
          yield* storeIO(() => refuseUnreadableMutation(home, entry));
          const signedOut = yield* registry
            .signOut(name)
            .pipe(Effect.provideService(RemovingAccount, entry), Effect.result);
          if (signedOut._tag === "Failure") {
            const gone = yield* storeIO(
              () =>
                !readAccounts(home).some(
                  (item) =>
                    item.account.name === name &&
                    item.folderId === entry.folderId,
                ) && !hasFolderClaim(home, entry.folderId ?? "default"),
            );
            if (signedOut.failure._tag === "AccountNotFound" && gone) {
              yield* step("signed-out");
            } else {
              if (
                signedOut.failure._tag !== "RuntimeUnavailable" ||
                (signedOut.failure.reason !== "not-installed" &&
                  signedOut.failure.reason !== "not-registered")
              )
                return yield* signedOut.failure;
              if (options.force !== true)
                return yield* new StoreError({
                  message:
                    "Install Claude Code and run neuve auth remove " +
                    name +
                    " again, or pass --force. The sign-in may remain in the Keychain without its own sign-out.",
                });
              yield* step("sign-out-skipped");
            }
          } else yield* step("signed-out");
          yield* storeIO(() => deleteFolder(home, entry));
          yield* step("folder-deleted");
          yield* storeIO(() => refuseUnreadableMutation(home, entry));
          yield* forgetStatus(home, entry);
          yield* storeIO(() => drop(home, entry));
          yield* step("record-dropped");
        }),
    });
  });

export const layer = (home: string) => Layer.effect(AccountStore, make(home));
export const directoryLayer = Layer.effect(
  AccountDirectory,
  Effect.map(AccountStore, (store) => store.directory),
);

/** Never echo incidental I/O diagnostics or a record path. Folder checks supply safe typed details. */
export const refusedStore = (
  home: string,
  account: AccountName,
  error: StoreError,
) =>
  new AccountStoreRefused({
    account,
    ...(error.refusal ?? {
      folder: accountsPath(home),
      problem: { kind: "unreadable" as const },
    }),
  });

/**
 * One shared open (0016); failed opens expire, and a successful store lives in this directory's
 * scope. The open runs in its own fiber in that scope, never in a caller's: a caller that is
 * interrupted stops only its own wait, and every subscriber gets the open's own result.
 */
export const retryingDirectory = (
  home: string,
): Effect.Effect<AccountDirectoryShape, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const defaults = inMemoryAccountDirectory(DEFAULT_ACCOUNTS);
    let expire: Effect.Effect<void> = Effect.void;
    const [current, invalidate] = yield* Effect.cachedInvalidateWithTTL(
      Effect.gen(function* () {
        const child = yield* Scope.fork(scope);
        return yield* make(home).pipe(
          Effect.provideService(Scope.Scope, child),
          // Expire before the fiber's exit is visible, so a later lookup opens again.
          Effect.onExit((exit) =>
            Exit.isFailure(exit)
              ? Scope.close(child, exit).pipe(Effect.andThen(expire))
              : Effect.void,
          ),
        );
      }).pipe(Effect.forkIn(scope)),
      Infinity,
    );
    expire = invalidate;
    const opened = Effect.flatMap(current, Fiber.join);
    const directory = (name: AccountName) =>
      isDefault(name)
        ? Effect.succeed(defaults)
        : opened.pipe(
            Effect.map((store) => store.directory),
            Effect.mapError((error) => refusedStore(home, name, error)),
          );
    return AccountDirectory.of({
      lookup: (name, purpose) =>
        directory(name).pipe(Effect.flatMap((d) => d.lookup(name, purpose))),
      checkTurn: (name) =>
        directory(name).pipe(Effect.flatMap((d) => d.checkTurn(name))),
      withAccess: (name, open) =>
        directory(name).pipe(Effect.flatMap((d) => d.withAccess(name, open))),
    });
  });
