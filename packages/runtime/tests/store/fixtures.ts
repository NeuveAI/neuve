import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, PubSub, Stream } from "effect";
import {
  AccountStore,
  AccountDirectory,
  RuntimeRegistry,
  runtimeRegistryLayer,
  type Account,
  type AccountProbe,
  type RuntimeCapabilities,
  type RuntimeEvent,
  type RuntimeShape,
  type RuntimeSession,
} from "../../src/index.ts";

export function scratch() {
  const home = mkdtempSync(join(tmpdir(), "accounts-test-"));
  return { home, close: () => rmSync(home, { recursive: true, force: true }) };
}
export const capabilities: RuntimeCapabilities = {
  ownsLoop: true,
  resume: true,
  fork: true,
  interrupt: false,
  modelSwitchInSession: false,
  structuredOutput: true,
  steering: false,
  approvals: false,
  perRequestTelemetry: false,
  byteExactCapture: false,
  nativeToolServer: false,
  statusProbe: true,
  internalRetries: false,
};
export const fakeRuntime = (input: {
  calls: string[];
  probe?: RuntimeShape["probe"];
  signOut?: RuntimeShape["signOut"];
  events?: Stream.Stream<RuntimeEvent>;
}): RuntimeShape => ({
  kind: "claude-code",
  capabilities: () => Effect.succeed(capabilities),
  continuation: (account) => ({ runtime: account.runtime, key: account.name }),
  probe: (account) =>
    Effect.sync(() => {
      input.calls.push(`probe:${account.name}`);
    }).pipe(
      Effect.andThen(
        input.probe?.(account) ??
          Effect.succeed({
            signIn: {
              state: "not-signed-in",
              hint: {
                kind: "command",
                command: "claude auth login",
                ...(account.credential.kind === "claude-config-folder" &&
                account.credential.folder !== undefined
                  ? {
                      environment: {
                        CLAUDE_CONFIG_DIR: account.credential.folder,
                      },
                    }
                  : {}),
              },
            },
            limits: [],
            checkedAt: new Date().toISOString(),
          } satisfies AccountProbe),
      ),
    ),
  signOut: (account) =>
    Effect.sync(() => {
      input.calls.push(`signOut:${account.name}`);
    }).pipe(Effect.andThen(input.signOut?.(account) ?? Effect.void)),
  openSession: (account) =>
    Effect.gen(function* () {
      input.calls.push(`openSession:${account.name}`);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          input.calls.push(`closed:${account.name}`);
        }),
      );
      return {
        nativeSessionId: "fake-session",
        startTurn: () => Effect.void,
        steerTurn: () => Effect.void,
        interruptTurn: () => Effect.void,
        respondToApproval: () => Effect.void,
        setModel: () => Effect.void,
        events: input.events ?? Stream.empty,
      } satisfies RuntimeSession;
    }),
});
export const provideRegistry = (
  store: AccountStore.AccountStoreShape,
  runtimes: ReadonlyArray<RuntimeShape>,
) =>
  runtimeRegistryLayer(runtimes).pipe(
    Layer.provide(Layer.succeed(AccountDirectory, store.directory)),
  );
export const eventBus = Effect.acquireRelease(
  PubSub.unbounded<RuntimeEvent>(),
  PubSub.shutdown,
);
export { AccountStore, RuntimeRegistry };
export const folderOf = (account: Account) => {
  if (
    account.credential.kind !== "claude-config-folder" &&
    account.credential.kind !== "neuve-sign-in"
  )
    throw new Error("expected folder");
  if (account.credential.folder === undefined)
    throw new Error("expected added folder");
  return account.credential.folder;
};

/** Locate the current generation only for test setup and assertions. */
export function recordFile(home: string, name: Account["name"]) {
  const entry = AccountStore.readAccounts(home).find(
    (entry) => entry.account.name === name,
  );
  if (entry === undefined) throw new Error("expected account record");
  return AccountStore.recordPath(home, entry);
}
