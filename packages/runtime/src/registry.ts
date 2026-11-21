import {
  Context,
  Data,
  Effect,
  Layer,
  PubSub,
  Stream,
  type Scope,
} from "effect";
import type { Account, AccountName, RuntimeKind } from "./account.ts";
import type {
  ContinuationIdentity,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeSession,
  RuntimeShape,
  SessionPolicy,
  SessionStart,
} from "./contract.ts";
import {
  AccountNotFound,
  CapabilityUnsupported,
  RuntimeUnavailable,
  TurnFailed,
  type RuntimeError,
} from "./errors.ts";
import type { AccountStatus } from "./status.ts";

export interface AccountDirectoryShape {
  /** Returns an account being removed only for sign-out; use hides it from capabilities, continuation, probes and new sessions. */
  readonly lookup: (
    name: AccountName,
    purpose: "use" | "sign-out",
  ) => Effect.Effect<Account | undefined, RuntimeError>;
  /**
   * Admit opening under the account's access scope. Removal closes admission and stops
   * admitted sessions before deleting credentials. Fixed directories need no removal guard.
   */
  readonly withAccess: <A, E, R>(
    name: AccountName,
    open: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | RuntimeError, R | Scope.Scope>;
  /**
   * Before each turn of a session admitted by withAccess: when the account is no longer usable,
   * stop this process's sessions on it in t3code's order, then fail with AccountNotFound
   * if absent, or AccountNeedsNewerBuild if its record was refused.
   */
  readonly checkTurn: (name: AccountName) => Effect.Effect<void, RuntimeError>;
}
export class AccountDirectory extends Context.Service<
  AccountDirectory,
  AccountDirectoryShape
>()("@neuve/runtime/AccountDirectory") {}

export class DuplicateAccount extends Data.TaggedError("DuplicateAccount")<{
  readonly account: AccountName;
}> {
  override get message() {
    return "Two accounts have the same name.";
  }
}

/** A copied directory for fixed accounts. Duplicate names throw a construction defect. */
export function inMemoryAccountDirectory(
  accounts: ReadonlyArray<Account>,
): AccountDirectoryShape {
  const entries = new Map<AccountName, Account>();
  for (const account of accounts) {
    if (entries.has(account.name))
      throw new DuplicateAccount({ account: account.name });
    entries.set(account.name, account);
  }
  return AccountDirectory.of({
    lookup: (name, _purpose) => Effect.sync(() => entries.get(name)),
    withAccess: (name, open) =>
      Effect.gen(function* () {
        if (!entries.has(name))
          return yield* new AccountNotFound({ account: name });
        return yield* open;
      }),
    checkTurn: (_name) => Effect.void,
  });
}
export const inMemoryAccountDirectoryLayer = (
  accounts: ReadonlyArray<Account>,
) => Layer.succeed(AccountDirectory, inMemoryAccountDirectory(accounts));

export interface AccountEvent {
  readonly account: AccountName;
  readonly event: Extract<RuntimeEvent, { type: "usage" | "rate-limit" }>;
}

export interface RuntimeRegistryShape {
  /** Live broadcast, no replay. Subscribe before consuming sessions; tapping their events publishes observations. */
  readonly accountEvents: Stream.Stream<AccountEvent>;
  readonly capabilities: (
    name: AccountName,
  ) => Effect.Effect<RuntimeCapabilities, RuntimeError>;
  readonly continuation: (
    name: AccountName,
  ) => Effect.Effect<ContinuationIdentity, RuntimeError>;
  /**
   * Decide whether to drive a contract session by reading capabilities(name).ownsLoop,
   * never by the account's runtime kind or a lookup error. Refuses without ownsLoop;
   * capabilities, continuation, probe and signOut still route normally.
   */
  readonly openSession: (
    name: AccountName,
    policy: SessionPolicy,
    start?: SessionStart,
  ) => Effect.Effect<RuntimeSession, RuntimeError, Scope.Scope>;
  /** Without statusProbe, returns unknown without calling the runtime's probe. */
  readonly probe: (
    name: AccountName,
  ) => Effect.Effect<AccountStatus, RuntimeError>;
  readonly signOut: (name: AccountName) => Effect.Effect<void, RuntimeError>;
}
export class RuntimeRegistry extends Context.Service<
  RuntimeRegistry,
  RuntimeRegistryShape
>()("@neuve/runtime/RuntimeRegistry") {}
export class DuplicateRuntime extends Data.TaggedError("DuplicateRuntime")<{
  readonly kind: RuntimeKind;
}> {
  override get message() {
    return "Two runtimes have the same kind.";
  }
}

/** This registry alone selects a runtime; callers pass only an account name. */
export const runtimeRegistryLayer = (
  runtimes: ReadonlyArray<RuntimeShape>,
): Layer.Layer<RuntimeRegistry, DuplicateRuntime, AccountDirectory> =>
  Layer.effect(
    RuntimeRegistry,
    Effect.gen(function* () {
      const directory = yield* AccountDirectory;
      const byKind = new Map<RuntimeKind, RuntimeShape>();
      for (const runtime of runtimes) {
        if (byKind.has(runtime.kind))
          return yield* new DuplicateRuntime({ kind: runtime.kind });
        byKind.set(runtime.kind, runtime);
      }
      const accountEvents = yield* Effect.acquireRelease(
        PubSub.unbounded<AccountEvent>(),
        PubSub.shutdown,
      );
      const resolve = (name: AccountName, purpose: "use" | "sign-out") =>
        Effect.gen(function* () {
          const account = yield* directory.lookup(name, purpose);
          if (account === undefined)
            return yield* new AccountNotFound({ account: name });
          const runtime = byKind.get(account.runtime);
          if (runtime === undefined)
            return yield* new RuntimeUnavailable({
              account: name,
              reason: "not-registered",
            });
          return { account, runtime };
        });
      return RuntimeRegistry.of({
        accountEvents: Stream.fromPubSub(accountEvents),
        capabilities: (name) =>
          Effect.gen(function* () {
            const { account, runtime } = yield* resolve(name, "use");
            return yield* runtime.capabilities(account);
          }),
        continuation: (name) =>
          Effect.gen(function* () {
            const { account, runtime } = yield* resolve(name, "use");
            return runtime.continuation(account);
          }),
        openSession: (name, policy, start = { kind: "new" }) =>
          directory.withAccess(
            name,
            Effect.gen(function* () {
              const { account, runtime } = yield* resolve(name, "use");
              const capabilities = yield* runtime.capabilities(account);
              if (!capabilities.ownsLoop)
                return yield* new CapabilityUnsupported({
                  account: name,
                  capability: "ownsLoop",
                });
              if (policy.approvalPolicy === "ask" && !capabilities.approvals)
                return yield* new CapabilityUnsupported({
                  account: name,
                  capability: "approvals",
                });
              if (
                policy.outputSchema !== undefined &&
                !capabilities.structuredOutput
              )
                return yield* new CapabilityUnsupported({
                  account: name,
                  capability: "structuredOutput",
                });
              if (start.kind === "resume") {
                if (!capabilities.resume)
                  return yield* new CapabilityUnsupported({
                    account: name,
                    capability: "resume",
                  });
                if (start.fork && !capabilities.fork)
                  return yield* new CapabilityUnsupported({
                    account: name,
                    capability: "fork",
                  });
              }
              const session = yield* runtime.openSession(
                account,
                policy,
                start,
              );
              return {
                get nativeSessionId() {
                  return session.nativeSessionId;
                },
                startTurn: (input) =>
                  input.final === true && policy.outputSchema === undefined
                    ? Effect.fail(
                        new TurnFailed({
                          account: name,
                          reason: "no-output-schema",
                        }),
                      )
                    : directory
                        .checkTurn(name)
                        .pipe(Effect.andThen(() => session.startTurn(input))),
                steerTurn: (input) =>
                  capabilities.steering
                    ? session.steerTurn(input)
                    : Effect.fail(
                        new CapabilityUnsupported({
                          account: name,
                          capability: "steering",
                        }),
                      ),
                interruptTurn: (input) =>
                  capabilities.interrupt
                    ? session.interruptTurn(input)
                    : Effect.fail(
                        new CapabilityUnsupported({
                          account: name,
                          capability: "interrupt",
                        }),
                      ),
                setModel: (input) =>
                  capabilities.modelSwitchInSession
                    ? session.setModel(input)
                    : Effect.fail(
                        new CapabilityUnsupported({
                          account: name,
                          capability: "modelSwitchInSession",
                        }),
                      ),
                respondToApproval: (input) =>
                  capabilities.approvals
                    ? session.respondToApproval(input)
                    : Effect.fail(
                        new CapabilityUnsupported({
                          account: name,
                          capability: "approvals",
                        }),
                      ),
                events: session.events.pipe(
                  Stream.tap((event) =>
                    event.type === "usage" || event.type === "rate-limit"
                      ? PubSub.publish(accountEvents, { account: name, event })
                      : Effect.void,
                  ),
                ),
              } satisfies RuntimeSession;
            }),
          ),
        probe: (name) =>
          Effect.gen(function* () {
            const { account, runtime } = yield* resolve(name, "use");
            const capabilities = yield* runtime.capabilities(account);
            if (!capabilities.statusProbe)
              return {
                name: account.name,
                kind: account.kind,
                signIn: { state: "unknown", reason: "not-checked" },
                limits: [],
                checkedAt: new Date().toISOString(),
              } satisfies AccountStatus;
            const probe = yield* runtime.probe(account);
            return {
              name: account.name,
              kind: account.kind,
              signIn: probe.signIn,
              limits: probe.limits,
              checkedAt: probe.checkedAt,
              ...(probe.models === undefined ? {} : { models: probe.models }),
              ...(probe.program === undefined
                ? {}
                : { program: probe.program }),
            };
          }),
        signOut: (name) =>
          Effect.gen(function* () {
            const { account, runtime } = yield* resolve(name, "sign-out");
            return yield* runtime.signOut(account);
          }),
      });
    }),
  );

/** Builds and releases effectful runtimes in the registry layer's scope. */
export const runtimeRegistryLayerEffect = <E, R>(
  runtimes: Effect.Effect<ReadonlyArray<RuntimeShape>, E, R>,
): Layer.Layer<
  RuntimeRegistry,
  E | DuplicateRuntime,
  AccountDirectory | Exclude<R, Scope.Scope>
> => Layer.unwrap(Effect.map(runtimes, runtimeRegistryLayer));
