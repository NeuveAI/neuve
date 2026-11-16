import { SharedWork } from "@neuve/records-core/shared-work";
import { sharedWorkEffect } from "@neuve/records-core/shared-work-effect";
import { preserveUnknown, safeRead } from "@neuve/records-schema";
import type { RuntimeError } from "../errors.ts";
import { dirname } from "node:path";
import {
  Cause,
  Context,
  Effect,
  Layer,
  Queue,
  type Scope,
  Semaphore,
  Stream,
} from "effect";
import { z } from "zod";
import { AccountName, type Account } from "../account.ts";
import type { AccountEvent, RuntimeRegistryShape } from "../registry.ts";
import { AccountStatus, LimitWindow } from "../status.ts";
import {
  StoreError,
  accountsPath,
  folderChanges,
  readStoredJson,
  statusesPath,
  storeIO,
  storeNotice,
  watchFolder,
  writeJson,
} from "./files.ts";
import { readAccounts } from "./index.ts";

const Entry = AccountStatus.extend({ identity: z.string().optional() });
// Limit windows are preserved individually by full identity before preserving the entry.
const EntryWithRawLimits = Entry.extend({ limits: z.array(z.unknown()) });
const File = z.strictObject({
  version: z.literal(1),
  accounts: z.array(z.unknown()),
});
const Identity = z.object({
  name: z.string(),
  kind: z.string(),
  identity: z.string().optional(),
});
type StatusIdentity = z.infer<typeof Identity>;
type SavedEntry =
  | { kind: "readable"; status: z.infer<typeof Entry> }
  | { kind: "refused"; identity?: StatusIdentity };
type Saved = ReturnType<typeof readSaved>;
const readSaved = (home: string) => {
  const source = statusesPath(home);
  const saved = readStoredJson(home, source, File);
  if (saved === undefined) return undefined;
  const accounts = saved.data.accounts.map((raw): SavedEntry => {
    const read = safeRead(Entry, raw, { source });
    if (read.success) return { kind: "readable", status: read.data };
    const identity = Identity.safeParse(raw);
    storeNotice(
      source,
      identity.success
        ? `account ${identity.data.name}'s status needs a newer build; leaving it as stored.`
        : "an account status needs a newer build; leaving it as stored.",
    );
    return identity.success
      ? { kind: "refused", identity: identity.data }
      : { kind: "refused" };
  });
  return { ...saved, data: { ...saved.data, accounts } };
};
const notChecked = (account: Account): AccountStatus => ({
  name: account.name,
  kind: account.kind,
  signIn: { state: "unknown", reason: "not-checked" },
  limits: [],
  checkedAt: "1970-01-01T00:00:00.000Z",
});
const needsNewerBuild = (status: AccountStatus) =>
  status.signIn.state === "unknown" &&
  status.signIn.reason === "needs-newer-build";

const refusedIdentity = (saved: Saved, identity: StatusIdentity) =>
  saved?.data.accounts.some(
    (entry) =>
      entry.kind === "refused" &&
      entry.identity !== undefined &&
      sameEntry(entry.identity, identity),
  ) ?? false;

const publicStatus = ({
  identity: _identity,
  ...status
}: AccountStatus & { identity?: string | undefined }): AccountStatus => status;

function readSnapshots(
  entries: ReturnType<typeof readAccounts>,
  snapshot: Saved,
) {
  const saved = snapshot?.data.accounts ?? [];
  return entries.map((entry) => {
    const identity = entry.folderId ?? entry.account.name;
    const key = {
      name: entry.account.name,
      kind: entry.account.kind,
      identity,
    };
    const savedStatus = saved.find(
      (status) => status.kind === "readable" && sameEntry(status.status, key),
    );
    // A refused occurrence wins over a readable duplicate: this build cannot tell which is current.
    if (refusedIdentity(snapshot, key))
      return {
        ...notChecked(entry.account),
        signIn: { state: "unknown", reason: "needs-newer-build" },
        identity,
      } satisfies z.infer<typeof Entry>;
    return {
      ...(savedStatus?.kind !== "readable"
        ? notChecked(entry.account)
        : publicStatus(savedStatus.status)),
      identity,
    };
  });
}

const sameEntry = (left: StatusIdentity, right: StatusIdentity) =>
  left.name === right.name &&
  left.kind === right.kind &&
  left.identity === right.identity;

const limitKey = (limit: LimitWindow) =>
  JSON.stringify([limit.window, limit.model ?? null]);

function preserveStatus(
  stored: unknown,
  previous: z.infer<typeof Entry>,
  next: z.infer<typeof Entry>,
  source: string,
) {
  const raw = z.looseObject({ limits: z.array(z.unknown()) }).parse(stored);
  const windows = new Map<string, unknown>();
  previous.limits.forEach((limit, at) => {
    const key = limitKey(limit);
    if (windows.has(key))
      throw new StoreError({
        message: "The stored limit identity is ambiguous.",
      });
    windows.set(key, raw.limits[at]);
  });
  const limits = next.limits.map((limit) => {
    const key = limitKey(limit);
    return windows.has(key)
      ? preserveUnknown(LimitWindow, windows.get(key), limit, { source })
      : limit;
  });
  return preserveUnknown(
    EntryWithRawLimits,
    stored,
    { ...next, limits },
    {
      source,
      arrayKeys: { models: ["id"] },
    },
  );
}

/** Plan against raw occurrences so duplicates and legacy entries need no invented identity. */
function saveSnapshots(
  home: string,
  saved: Saved,
  next: ReadonlyArray<z.infer<typeof Entry>>,
  forget?: StatusIdentity,
) {
  let planned: unknown;
  try {
    const raw =
      saved === undefined
        ? { version: 1, accounts: [] }
        : z.looseObject({ accounts: z.array(z.unknown()) }).parse(saved.stored);
    const accounts = [...raw.accounts];
    for (const status of next) {
      if (needsNewerBuild(status) || refusedIdentity(saved, status)) continue;
      const at =
        saved?.data.accounts.findIndex(
          (previous) =>
            previous.kind === "readable" && sameEntry(previous.status, status),
        ) ?? -1;
      const previous = saved?.data.accounts[at];
      if (previous === undefined) accounts.push(status);
      else if (
        previous.kind === "readable" &&
        JSON.stringify(previous.status) !== JSON.stringify(status)
      )
        accounts[at] = preserveStatus(
          accounts[at],
          previous.status,
          status,
          statusesPath(home),
        );
    }
    planned = {
      ...raw,
      accounts:
        forget === undefined
          ? accounts
          : accounts.filter((_, at) => {
              const status = saved?.data.accounts[at];
              // Keep refused entries even on removal. A re-added account has a new folder identity.
              return (
                status?.kind !== "readable" || !sameEntry(status.status, forget)
              );
            }),
    };
  } catch {
    const path = statusesPath(home);
    storeNotice(
      path,
      "cannot preserve newer fields; leaving the status file unchanged.",
    );
    return;
  }
  writeJson(home, statusesPath(home), planned);
}

/** A read never probes, starts a runtime, or creates an account file. */
export function readStatuses(home: string): ReadonlyArray<AccountStatus> {
  return readSnapshots(readAccounts(home), readSaved(home)).map(publicStatus);
}

function mergeLimits(
  old: ReadonlyArray<LimitWindow>,
  incoming: ReadonlyArray<LimitWindow>,
  at: string,
): LimitWindow[] {
  const windows = new Map(old.map((limit) => [limitKey(limit), limit]));
  for (const limit of incoming) {
    const key = limitKey(limit);
    const previous = windows.get(key);
    const observation = { ...limit, observedAt: limit.observedAt ?? at };
    if (
      previous === undefined ||
      Date.parse(observation.observedAt) >
        Date.parse(previous.observedAt ?? "1970-01-01T00:00:00Z")
    )
      windows.set(key, observation);
  }
  return [...windows.values()].sort((a, b) =>
    `${a.window}:${a.model ?? ""}`.localeCompare(
      `${b.window}:${b.model ?? ""}`,
    ),
  );
}

function mergeStatus(
  previous: AccountStatus,
  observation: AccountStatus,
): AccountStatus {
  const newer =
    Date.parse(observation.checkedAt) > Date.parse(previous.checkedAt);
  // A newer observation's model list replaces the stored one; one without a list leaves none.
  const { models: _stored, ...kept } = previous;
  return {
    ...(newer ? kept : previous),
    ...(newer
      ? {
          checkedAt: observation.checkedAt,
          signIn: observation.signIn,
          ...(observation.models === undefined
            ? {}
            : { models: observation.models }),
        }
      : {}),
    limits: mergeLimits(
      previous.limits,
      observation.limits,
      observation.checkedAt,
    ),
  };
}

const update = (
  home: string,
  observation: AccountStatus,
  expectedAccount?: Account,
) =>
  storeIO(() => {
    const entries = readAccounts(home);
    if (expectedAccount !== undefined) {
      const current = entries.find(
        (entry) =>
          entry.account.name === expectedAccount.name &&
          entry.state === "active",
      );
      if (
        current === undefined ||
        JSON.stringify(current.account) !== JSON.stringify(expectedAccount)
      )
        throw new StoreError({
          message: "The account changed while checking. Check again.",
        });
    }
    const saved = readSaved(home);
    const before = readSnapshots(entries, saved);
    const after = before.map((previous) => {
      if (
        needsNewerBuild(previous) ||
        previous.name !== observation.name ||
        previous.kind !== observation.kind
      )
        return previous;
      return {
        ...mergeStatus(previous, observation),
        identity: previous.identity,
      };
    });
    if (JSON.stringify(before) !== JSON.stringify(after))
      saveSnapshots(home, saved, after);
    return publicStatus(
      after.find((status) => status.name === observation.name) ?? observation,
    );
  });

/** Watch the containing folder so atomic replacement of status.json stays visible. */
export const watchStatuses = (
  home: string,
): Stream.Stream<ReadonlyArray<AccountStatus>, StoreError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const queue = yield* Effect.acquireRelease(
        Queue.make<ReadonlyArray<AccountStatus>, StoreError>(),
        Queue.shutdown,
      );
      const runSync = Effect.runSyncWith(yield* Effect.context<never>());
      let readFailed = false;
      const emit = () => {
        try {
          Queue.offerUnsafe(queue, readStatuses(home));
          readFailed = false;
        } catch {
          if (!readFailed) {
            readFailed = true;
            runSync(
              Effect.logError("Neuve could not read account status.").pipe(
                Effect.ignoreCause,
              ),
            );
          }
        }
      };
      for (const folder of [dirname(statusesPath(home)), accountsPath(home)])
        yield* Effect.acquireRelease(
          storeIO(() =>
            watchFolder(folder, emit, () => {
              Queue.failCauseUnsafe(
                queue,
                Cause.fail(
                  new StoreError({
                    message: "The account status watch failed.",
                  }),
                ),
              );
            }),
          ),
          (close) => Effect.sync(close),
        );
      yield* Effect.sync(emit);
      return Stream.fromQueue(queue);
    }),
  ).pipe(Stream.changesWith((a, b) => JSON.stringify(a) === JSON.stringify(b)));

/** Called by account removal so a reused name cannot inherit a previous sign-in's snapshot. */
export const forgetStatus = (
  home: string,
  entry: { readonly account: Account; readonly folderId?: string | undefined },
) =>
  storeIO(() => {
    const saved = readSaved(home);
    const forgotten = {
      name: entry.account.name,
      kind: entry.account.kind,
      identity: entry.folderId ?? entry.account.name,
    };
    if (
      saved === undefined ||
      !saved.data.accounts.some(
        (entry) =>
          entry.kind === "readable" && sameEntry(entry.status, forgotten),
      )
    )
      return;
    saveSnapshots(home, saved, [], forgotten);
  });

export interface AccountStatusesShape {
  readonly read: Effect.Effect<ReadonlyArray<AccountStatus>, StoreError>;
  readonly check: (
    name: AccountName,
  ) => Effect.Effect<AccountStatus, StoreError>;
  readonly checkAll: Effect.Effect<ReadonlyArray<AccountStatus>, StoreError>;
}
export class AccountStatuses extends Context.Service<
  AccountStatuses,
  AccountStatusesShape
>()("@neuve/runtime/AccountStatuses") {}

const probeWork = new SharedWork<AccountStatus, RuntimeError>();
const permits = Semaphore.makeUnsafe(4);

export const makeStatuses = (
  home: string,
  registry: RuntimeRegistryShape,
): Effect.Effect<AccountStatusesShape, StoreError, Scope.Scope> =>
  Effect.gen(function* () {
    yield* storeIO(() => readStatuses(home));
    const latest = new Map<
      AccountName,
      { account: Account; status: AccountStatus }
    >();
    const remember = (account: Account, observation: AccountStatus) =>
      Effect.suspend(() => {
        const previous = latest.get(account.name);
        const merged =
          previous !== undefined &&
          JSON.stringify(previous.account) === JSON.stringify(account)
            ? mergeStatus(previous.status, observation)
            : observation;
        return update(home, merged, account).pipe(
          Effect.tap((status) =>
            Effect.sync(() => {
              if (needsNewerBuild(status)) latest.delete(account.name);
              else latest.set(account.name, { account, status });
            }),
          ),
        );
      });
    const watched = yield* Stream.toPull(
      Stream.merge(
        folderChanges(dirname(statusesPath(home))),
        folderChanges(accountsPath(home)),
      ),
    );
    yield* Stream.fromPull(Effect.succeed(watched)).pipe(
      Stream.runForEach(() =>
        storeIO(() => readAccounts(home)).pipe(
          Effect.flatMap((entries) =>
            Effect.forEach(
              [...latest.values()],
              ({ account, status }) => {
                const current = entries.find(
                  (entry) =>
                    entry.account.name === account.name &&
                    entry.state === "active",
                );
                if (
                  current === undefined ||
                  JSON.stringify(current.account) !== JSON.stringify(account)
                ) {
                  latest.delete(account.name);
                  return Effect.void;
                }
                return remember(account, status).pipe(
                  Effect.asVoid,
                  Effect.catch((error) => Effect.logError(error.message)),
                );
              },
              { discard: true },
            ),
          ),
        ),
      ),
      Effect.catch((error) => Effect.logError(error.message)),
      Effect.forkScoped({ startImmediately: true }),
    );
    const event = ({ account: name, event }: AccountEvent) => {
      if (event.type !== "rate-limit") return Effect.void;
      return storeIO(() => {
        const entry = readAccounts(home).find(
          (entry) => entry.account.name === name && entry.state === "active",
        );
        const previous = readStatuses(home).find(
          (status) => status.name === name,
        );
        return entry && previous && !needsNewerBuild(previous)
          ? { account: entry.account, previous }
          : undefined;
      }).pipe(
        Effect.flatMap((found) => {
          if (found === undefined) return Effect.void;
          const limit = LimitWindow.parse({
            window: event.window,
            status: event.status,
            ...(event.model === undefined ? {} : { model: event.model }),
            ...(event.utilization === undefined
              ? {}
              : { utilization: event.utilization }),
            ...(event.resetsAt === undefined
              ? {}
              : { resetsAt: event.resetsAt }),
            observedAt: event.observedAt ?? event.at,
          });
          return remember(found.account, {
            ...found.previous,
            limits: [limit],
          }).pipe(Effect.asVoid);
        }),
      );
    };
    // Start subscription before returning. The registry's event stream has no replay.
    const events = yield* Stream.toPull(registry.accountEvents);
    yield* Stream.fromPull(Effect.succeed(events)).pipe(
      Stream.runForEach((value) =>
        event(value).pipe(
          Effect.catch((error) => Effect.logError(error.message)),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );

    const check = (
      name: AccountName,
    ): Effect.Effect<AccountStatus, StoreError> =>
      Effect.gen(function* () {
        const entry = yield* storeIO(() =>
          readAccounts(home).find(
            (entry) => entry.account.name === name && entry.state === "active",
          ),
        );
        if (entry === undefined)
          return yield* new StoreError({ message: "Account not found." });
        const { account, folderId } = entry;
        const result = yield* sharedWorkEffect(probeWork, {
          scope: "account-status",
          key: JSON.stringify([home, name, folderId]),
          run: () =>
            Effect.gen(function* () {
              const previous = yield* storeIO(() => {
                const current = readAccounts(home).find(
                  (entry) =>
                    entry.account.name === name && entry.state === "active",
                );
                if (
                  current === undefined ||
                  JSON.stringify(current.account) !== JSON.stringify(account)
                )
                  throw new StoreError({
                    message: "The account changed while checking. Check again.",
                  });
                return readStatuses(home).find(
                  (status) => status.name === name,
                );
              });
              if (previous === undefined)
                return yield* new StoreError({ message: "Account not found." });
              if (needsNewerBuild(previous))
                return { kind: "succeeded" as const, value: previous };
              const probed = yield* registry
                .probe(name)
                .pipe(Effect.timeout("30 seconds"), Effect.result);
              const observation: AccountStatus =
                probed._tag === "Success"
                  ? probed.success
                  : {
                      ...previous,
                      checkedAt: new Date().toISOString(),
                      signIn:
                        probed.failure._tag === "RuntimeUnavailable"
                          ? {
                              state: "runtime-unavailable",
                              reason: probed.failure.reason,
                            }
                          : { state: "unknown", reason: "check-failed" },
                    };
              const value = yield* remember(account, observation);
              return { kind: "succeeded" as const, value };
            }).pipe(permits.withPermits(1), Effect.orDie),
        }).pipe(
          Effect.mapError(
            () =>
              new StoreError({
                message:
                  "The account changed or its status check could not complete. Check again.",
              }),
          ),
        );
        if (needsNewerBuild(result.value)) latest.delete(name);
        else latest.set(name, { account, status: result.value });
        return result.value;
      });
    return AccountStatuses.of({
      read: storeIO(() => readStatuses(home)),
      check,
      checkAll: storeIO(() => readAccounts(home)).pipe(
        Effect.flatMap((entries) =>
          Effect.forEach(
            entries.filter((entry) => entry.state === "active"),
            ({ account }) => check(account.name),
            { concurrency: 4 },
          ),
        ),
      ),
    });
  });
export const statusesLayer = (home: string, registry: RuntimeRegistryShape) =>
  Layer.effect(AccountStatuses, makeStatuses(home, registry));

/** Node-only status source used by the host and BFF, sharing the process's folder watches. */
export function statusSource(home: string): {
  current(): ReadonlyArray<AccountStatus>;
  subscribe(
    listener: (statuses: ReadonlyArray<AccountStatus>) => void,
  ): () => void;
} {
  return {
    current: () => readStatuses(home),
    subscribe: (listener) => {
      let previous = readStatuses(home);
      listener(previous);
      const fiber = Effect.runFork(
        Effect.scoped(
          watchStatuses(home).pipe(
            Stream.runForEach((statuses) =>
              Effect.sync(() => {
                if (JSON.stringify(statuses) === JSON.stringify(previous))
                  return;
                previous = statuses;
                listener(statuses);
              }),
            ),
            Effect.catch((error) => Effect.logError(error.message)),
          ),
        ),
      );
      return () => {
        fiber.interruptUnsafe();
      };
    },
  };
}
