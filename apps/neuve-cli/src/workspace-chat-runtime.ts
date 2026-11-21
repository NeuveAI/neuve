import {
  createModels,
  type Models,
  getSupportedThinkingLevels,
} from "@earendil-works/pi-ai";
import type { Extension, Harness } from "@earendil-works/pi-durable";
import {
  accountModels,
  chatRuntimeExtension,
  ChatRuntimeBridge,
  NativeHeads,
  type AccountStatusSource,
} from "@neuve/harness/chat-runtime";
import type { RuntimeRegistryShape } from "@neuve/harness/chat-runtime";
import {
  codexRuntimeOptions,
  defaultClaudeWorkingFolder,
  harnessRuntimes,
} from "@neuve/harness/runtimes";
import {
  AccountDirectory,
  AccountStore,
  RuntimeRegistry,
  RuntimeUnavailable,
  type AccountStatus,
  type AccountName,
} from "@neuve/runtime";
import { Context, Effect, Layer, ManagedRuntime, Scope, Stream } from "effect";

export type ChatRuntimeSources = {
  registry: RuntimeRegistryShape;
  statuses: AccountStatusSource;
  unavailable?(): boolean;
  close?(): Promise<void>;
};

type ClaudeRuntimeConfig = Exclude<
  NonNullable<Parameters<typeof harnessRuntimes>[0]>["claude"],
  false | undefined
>;

/** One lazy registry and account-store scope, shared by all chats in this process. */
export function productionChatSources(options: {
  home: string;
  claude?: ClaudeRuntimeConfig;
}): ChatRuntimeSources & { close(): Promise<void> } {
  let ensureStatuses: Effect.Effect<void> = Effect.void;
  const runtime = ManagedRuntime.make(
    Layer.unwrap(
      Effect.gen(function* () {
        const directory = yield* AccountStore.retryingDirectory(options.home);
        return harnessRuntimes({
          accountDirectory: Layer.succeed(AccountDirectory, directory),
          claude: options.claude ?? {
            cwd: defaultClaudeWorkingFolder(options.home),
          },
          codex: codexRuntimeOptions(options.home),
        }).pipe(
          // Subscribe before exposing the registry: account events have no replay.
          Layer.tap((services) =>
            Effect.gen(function* () {
              const scope = yield* Scope.Scope;
              const start = yield* Effect.cachedWithTTL(
                Effect.gen(function* () {
                  const child = yield* Scope.fork(scope);
                  return yield* AccountStore.makeStatuses(
                    options.home,
                    Context.get(services, RuntimeRegistry),
                  ).pipe(
                    Effect.provideService(Scope.Scope, child),
                    Effect.onExit((exit) =>
                      exit._tag === "Failure"
                        ? Scope.close(child, exit)
                        : Effect.void,
                    ),
                  );
                }),
                (exit) => (exit._tag === "Success" ? Infinity : 0),
              );
              ensureStatuses = start.pipe(
                Effect.asVoid,
                Effect.catch((error) => Effect.logWarning(error.message)),
              );
              yield* ensureStatuses;
            }),
          ),
        );
      }),
    ),
  );
  // ManagedRuntime builds its layer once; all concurrent callers await that build.
  const registry = (name: AccountName) =>
    Effect.tryPromise({
      try: () => runtime.runPromise(RuntimeRegistry),
      catch: () =>
        new RuntimeUnavailable({ account: name, reason: "start-failed" }),
    }).pipe(
      Effect.flatMap((registry) => ensureStatuses.pipe(Effect.as(registry))),
    );
  const source = AccountStore.statusSource(options.home);
  let unavailable = false;
  const current = () => {
    try {
      const statuses = source.current();
      unavailable = false;
      return statuses;
    } catch {
      unavailable = true;
      return [];
    }
  };
  const subscriptions = new Set<() => void>();
  let closing: Promise<void> | undefined;
  return {
    registry: {
      accountEvents: Stream.unwrap(
        Effect.tryPromise(() => runtime.runPromise(RuntimeRegistry)).pipe(
          Effect.map((registry) => registry.accountEvents),
        ),
      ).pipe(Stream.catch(() => Stream.empty)),
      capabilities: (name) =>
        registry(name).pipe(Effect.flatMap((r) => r.capabilities(name))),
      continuation: (name) =>
        registry(name).pipe(Effect.flatMap((r) => r.continuation(name))),
      openSession: (name, policy, start) =>
        registry(name).pipe(
          Effect.flatMap((r) => r.openSession(name, policy, start)),
        ),
      probe: (name) =>
        registry(name).pipe(Effect.flatMap((r) => r.probe(name))),
      signOut: (name) =>
        registry(name).pipe(Effect.flatMap((r) => r.signOut(name))),
    },
    statuses: {
      current,
      subscribe: (listener: (statuses: readonly AccountStatus[]) => void) => {
        try {
          const stop = source.subscribe((statuses) => {
            unavailable = false;
            listener(statuses);
          });
          const unsubscribe = () => {
            if (subscriptions.delete(unsubscribe)) stop();
          };
          subscriptions.add(unsubscribe);
          return unsubscribe;
        } catch {
          unavailable = true;
          listener([]);
          return () => {};
        }
      },
    },
    unavailable: () => unavailable,
    close: () =>
      (closing ??= Promise.resolve().then(async () => {
        for (const stop of subscriptions) stop();
        await runtime.dispose();
      })),
  };
}

function sourceModels(
  models: Models,
  native: Models,
  sources: ChatRuntimeSources,
): Models {
  if (!sources.unavailable) return models;
  return {
    ...models,
    getModel(provider, id) {
      sources.statuses.current();
      if (sources.unavailable?.() && !native.getProvider(provider))
        throw new Error(`The selected account ${provider} cannot run here.`);
      return models.getModel(provider, id);
    },
  };
}
export type WorkerChatRuntime = {
  models: Models;
  owns(provider: string): boolean;
  extensions: readonly Extension[];
  attach(harness: Harness): void | Promise<void>;
  close(): Promise<void>;
};
export async function workspaceChatRuntime(
  native: Models,
  stateDirectory: string,
  sources?: ChatRuntimeSources,
): Promise<WorkerChatRuntime> {
  if (!sources)
    return {
      models: native,
      owns: () => false,
      extensions: [],
      attach: () => {},
      close: async () => {},
    };
  const log = (event: string, fields: Readonly<Record<string, unknown>>) =>
    process.stderr.write(`${JSON.stringify({ event, ...fields })}\n`);
  const bridge = new ChatRuntimeBridge({
    registry: sources.registry,
    heads: await NativeHeads.open(stateDirectory),
    log,
  });
  try {
    const layer = await accountModels(native, { ...sources, bridge, log });
    const extension = chatRuntimeExtension(bridge, layer.owns);
    return {
      models: sourceModels(layer.models, native, sources),
      owns: layer.owns,
      extensions: extension.extensions,
      attach: extension.attach,
      close: async () => {
        await extension.close();
        await layer.close();
      },
    };
  } catch (error) {
    await bridge.close();
    throw error;
  }
}

export async function workspaceChatModels(
  native: Models = createModels(),
  sources?: ChatRuntimeSources,
) {
  if (!sources) return { current: () => [], close: async () => {} };
  const bridge = new ChatRuntimeBridge({
    registry: sources.registry,
    heads: await NativeHeads.open(),
  });
  const layer = await accountModels(native, { ...sources, bridge });
  return {
    current: () =>
      layer.models
        .getModels()
        .filter(
          (model) =>
            layer.owns(model.provider) &&
            sources.statuses
              .current()
              .some(
                (status) =>
                  status.name === model.provider &&
                  status.signIn.state === "signed-in",
              ),
        )
        .map((model) => ({
          provider: model.provider,
          modelId: model.id,
          efforts: model.reasoning ? getSupportedThinkingLevels(model) : [],
        })),
    close: () => layer.close(),
  };
}

/**
 * A coding session's default model on a Claude route: the account's model row that resolves to the
 * route's model (Claude Code lists Opus as `opus`, resolving to `claude-opus-5-5`), so a chat with no
 * model named runs what reviews run. Refused in plain words when the account isn't signed in or its
 * Claude Code doesn't offer that model.
 */
export function claudeDefaultModel(
  route: { account: { name: string }; model: string },
  statuses: readonly AccountStatus[],
): { provider: string; modelId: string } {
  const name = route.account.name;
  const check = `neuve auth status ${name} --check`;
  const status = statuses.find((entry) => entry.name === name);
  if (
    status?.signIn.state === "runtime-unavailable" &&
    status.signIn.reason === "not-installed"
  )
    throw new Error(
      `Claude Code isn't installed for account ${name}: there's no claude on PATH. Install Claude Code, run claude auth login, then ${check}.`,
    );
  const state = status?.signIn.state;
  if (state === "not-signed-in" || state === "credential-rejected")
    throw new Error(
      `Claude Code isn't signed in for account ${name}. Run claude auth login, then ${check}.`,
    );
  if (state !== "signed-in")
    throw new Error(
      `Neuve doesn't know yet whether Claude Code is signed in for account ${name}. Run ${check}.`,
    );
  const row =
    status?.models?.find(
      (entry) => entry.id !== "default" && entry.resolvedModel === route.model,
    ) ??
    status?.models?.find((entry) => entry.id === route.model) ??
    status?.models?.find((entry) => entry.resolvedModel === route.model);
  if (row === undefined)
    throw new Error(
      `Claude Code for account ${name} doesn't offer ${route.model}, the model reviews run on. Run ${check} to read its models again, or pick another model for this chat.`,
    );
  return { provider: name, modelId: row.id };
}
