import {
  createModels,
  createProvider,
  isModelType,
  type Models,
  type Model,
  type Api,
  type AnyModel,
  type AuthResult,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import { ANTHROPIC_MODELS } from "@earendil-works/pi-ai/providers/anthropic.models";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import { Effect } from "effect";
import {
  unavailableText,
  type AccountStatus,
  type RuntimeRegistryShape,
  type RuntimeModel,
  type SessionPolicy,
} from "@neuve/runtime";
import { ChatRuntimeBridge, type AccountRoute } from "./bridge.ts";
import { failureStream, terminalText } from "./failure.ts";
import { newest, responseId } from "./transcript.ts";
import type { Log } from "./transcript.ts";
import {
  CLAUDE_CODE_CATALOG_GAPS,
  CODEX_BUNDLED_LIMITS,
  logDefaultModelLimits,
  resolveModelLimits,
  type ModelLimits,
} from "../model-limits.ts";

export interface AccountStatusSource {
  current(): readonly AccountStatus[];
  subscribe(listener: (statuses: readonly AccountStatus[]) => void): () => void;
}
type Effort = NonNullable<NonNullable<SessionPolicy["model"]>["effort"]>;
const catalogs: Record<
  "anthropic" | "openai-codex",
  Readonly<Partial<Record<string, ModelLimits>>>
> = { anthropic: ANTHROPIC_MODELS, "openai-codex": OPENAI_CODEX_MODELS };
function resolveRow(status: AccountStatus, id: string) {
  const rows = status.models ?? [];
  return (
    rows.find((row) => row.id === id) ??
    rows.find((row) => row.resolvedModel === id)
  );
}
function effort(
  row: RuntimeModel | undefined,
  thinking?: ModelThinkingLevel,
): Effort | undefined {
  if (!row?.supportsEffort || !thinking || thinking === "off") return;
  const level = thinking === "minimal" ? "low" : thinking;
  return row.supportedEffortLevels?.includes(level) ? level : undefined;
}
export interface AccountModels {
  models: Models;
  owns(provider: string): boolean;
  ownTools(provider: string): boolean;
  close(): Promise<void>;
}
export async function accountModels(
  native: Models,
  options: {
    registry: RuntimeRegistryShape;
    statuses: AccountStatusSource;
    bridge: ChatRuntimeBridge;
    log?: Log;
  },
): Promise<AccountModels> {
  const added = createModels();
  const limits = new Map<string, Map<string, Partial<ModelLimits>>>();
  const warn = logDefaultModelLimits(options.log);
  const stopLimits = options.bridge.subscribeModelLimits(
    (account, model, value) => {
      const status = options.statuses
        .current()
        .find((status) => status.name === account);
      const row = status && resolveRow(status, model);
      const key = row?.resolvedModel ?? row?.id ?? model;
      let known = limits.get(account);
      if (!known) limits.set(account, (known = new Map()));
      known.set(key, { ...known.get(key), ...value });
      for (const candidate of added.getModels(account)) {
        const row = status && resolveRow(status, candidate.id);
        if ((row?.resolvedModel ?? row?.id ?? candidate.id) === key)
          Object.assign(candidate, value);
      }
    },
  );
  const makeModel = (
    status: AccountStatus,
    row: RuntimeModel,
    id = row.id,
  ): Model<Api> => {
    const model = row.resolvedModel ?? row.id;
    const provider =
      status.kind === "chatgpt-subscription"
        ? "openai-codex"
        : status.kind === "claude-subscription" ||
            status.kind === "anthropic-api-key"
          ? "anthropic"
          : undefined;
    const documented =
      status.kind === "chatgpt-subscription"
        ? CODEX_BUNDLED_LIMITS[model]
        : status.kind === "claude-subscription"
          ? CLAUDE_CODE_CATALOG_GAPS[model]
          : undefined;
    const levels = row.supportsEffort ? (row.supportedEffortLevels ?? []) : [];
    return {
      id,
      name: row.displayName,
      provider: status.name,
      api: "neuve-runtime",
      baseUrl: "",
      reasoning: row.supportsEffort === true,
      thinkingLevelMap: {
        off: null,
        minimal: null,
        low: null,
        medium: null,
        high: null,
        xhigh: null,
        max: null,
        ...Object.fromEntries(levels.map((level) => [level, level])),
      },
      input: ["text", "image"],
      ...resolveModelLimits(
        limits.get(status.name)?.get(model),
        { contextWindow: row.contextWindow, maxTokens: row.maxOutputTokens },
        documented,
        provider
          ? (native.getModel(provider, model) ?? catalogs[provider][model])
          : undefined,
        (defaults) => warn(status.name, model, defaults),
      ),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  };
  let routes = new Map<string, AccountRoute>();
  const shadowed = new Set<string>();
  const rebuild = async (statuses: readonly AccountStatus[]) => {
    const next = new Map<string, AccountRoute>();
    for (const status of statuses) {
      const caps = await Effect.runPromise(
        options.registry.capabilities(status.name).pipe(Effect.result),
      );
      if (caps._tag === "Failure" || !caps.success.ownsLoop) continue;
      if (
        native.getProviders().some((provider) => provider.id === status.name)
      ) {
        if (!shadowed.has(status.name))
          options.log?.("chat-runtime.account.shadowed", { name: status.name });
        shadowed.add(status.name);
        continue;
      }
      const continuation = await Effect.runPromise(
        options.registry.continuation(status.name).pipe(Effect.result),
      );
      if (continuation._tag === "Failure") continue;
      const route = {
        name: status.name,
        continuation: continuation.success,
        capabilities: caps.success,
      };
      next.set(status.name, route);
    }
    for (const [name, route] of routes)
      if (!next.has(name)) {
        added.deleteProvider(name);
        await options.bridge.closeAccount(route.name);
      }
    routes = next;
    for (const status of statuses) {
      const route = routes.get(status.name);
      if (!route) continue;
      const models = (status.models ?? []).map((row) => makeModel(status, row));
      const stream: Parameters<typeof createProvider>[0]["api"] = {
        stream: (model, context, streamOptions) =>
          serve(route, model, context, streamOptions),
        streamSimple: (model, context, streamOptions) =>
          serve(route, model, context, streamOptions, streamOptions?.reasoning),
      };
      added.setProvider(
        createProvider({
          id: route.name,
          name: route.name,
          models,
          // Auth stays with the runtime; pi never receives or refreshes a credential.
          auth: {
            apiKey: {
              name: "runtime sign-in",
              check: async () => ({ source: "runtime", type: "api_key" }),
              resolve: async () => ({ auth: {}, source: "runtime" }),
            },
          },
          filterModels: (known) => (signedIn(route.name) ? known : []),
          api: stream,
        }),
      );
    }
  };
  const signedIn = (name: string) =>
    options.statuses.current().find((status) => status.name === name)?.signIn
      .state === "signed-in";
  const serve = (
    route: AccountRoute,
    model: Model<Api>,
    context: Parameters<Models["streamSimple"]>[1],
    streamOptions: Parameters<Models["streamSimple"]>[2],
    thinking?: ModelThinkingLevel,
  ) => {
    if (options.bridge.isRedispatched(context.messages))
      return options.bridge.stream(route, model, context, streamOptions);
    const status = options.statuses
      .current()
      .find((status) => status.name === route.name);
    if (!status || status.signIn.state !== "signed-in") {
      const state = status?.signIn;
      const text =
        state?.state === "runtime-unavailable" && state.fix !== undefined
          ? unavailableText(state)
          : state?.state === "unknown" &&
              state.reason === "check-failed" &&
              state.hint === undefined
            ? `Neuve couldn't check ${route.name}. Run neuve auth status ${route.name} --check.`
            : state && "hint" in state && state.hint
              ? terminalText({
                  _tag: "SignInRequired",
                  account: route.name,
                  hint: state.hint,
                })
              : `Sign in for ${route.name} before continuing.`;
      const previous = newest(context.messages);
      return failureStream(
        model,
        text,
        previous.message?.role === "assistant" &&
          previous.message.provider === route.name &&
          previous.pointer
          ? responseId(previous.pointer.session)
          : undefined,
      );
    }
    const row = resolveRow(status, model.id);
    const mapped = effort(row, thinking);
    const selected =
      mapped === undefined
        ? { id: model.id }
        : { id: model.id, effort: mapped };
    const resolved = row ? makeModel(status, row, model.id) : model;
    return options.bridge.stream(
      route,
      resolved,
      context,
      streamOptions,
      selected,
    );
  };
  let updating = Promise.resolve();
  let closed = false;
  const unsubscribe = options.statuses.subscribe((statuses) => {
    updating = updating
      .then(async () => {
        if (!closed) await rebuild(statuses);
      })
      .catch(() => {
        options.log?.("chat-runtime.accounts.failed", {});
      });
  });
  updating = updating.then(() => rebuild(options.statuses.current()));
  try {
    await updating;
  } catch (error) {
    closed = true;
    unsubscribe();
    stopLimits();
    throw error;
  }
  const owner = (model: AnyModel) =>
    routes.has(model.provider) ? added : native;
  const only = (provider?: string) =>
    provider !== undefined && routes.has(provider);
  function getAuth(
    value: string,
    overrides?: Parameters<Models["getAuth"]>[1],
  ): Promise<AuthResult | undefined>;
  function getAuth(
    value: AnyModel,
    overrides?: Parameters<Models["getAuth"]>[1],
  ): Promise<AuthResult | undefined>;
  function getAuth(
    value: string | AnyModel,
    overrides?: Parameters<Models["getAuth"]>[1],
  ) {
    return typeof value === "string"
      ? (only(value) ? added : native).getAuth(value, overrides)
      : owner(value).getAuth(value, overrides);
  }
  const getAccountModel = (provider: string, id: string) => {
    const status = options.statuses
      .current()
      .find((status) => status.name === provider);
    const row = status && resolveRow(status, id);
    return status && row ? makeModel(status, row, id) : undefined;
  };
  const models: Models = {
    getProviders: () => [...native.getProviders(), ...added.getProviders()],
    getProvider: (id) => native.getProvider(id) ?? added.getProvider(id),
    getModels: (provider) =>
      only(provider)
        ? added.getModels(provider)
        : [
            ...native.getModels(provider),
            ...(provider ? [] : added.getModels()),
          ],
    getModel: (provider, id) =>
      only(provider)
        ? getAccountModel(provider, id)
        : native.getModel(provider, id),
    getModelsOfType: (type, provider) =>
      only(provider)
        ? added.getModelsOfType(type, provider)
        : [
            ...native.getModelsOfType(type, provider),
            ...(provider ? [] : added.getModelsOfType(type)),
          ],
    getModelOfType: (type, provider, id) => {
      if (!only(provider)) return native.getModelOfType(type, provider, id);
      const model = getAccountModel(provider, id);
      return model && isModelType(model, type) ? model : undefined;
    },
    getAllModels: (provider) =>
      only(provider)
        ? added.getAllModels(provider)
        : [
            ...native.getAllModels(provider),
            ...(provider ? [] : added.getAllModels()),
          ],
    getAvailable: async (provider, opts) =>
      only(provider)
        ? availableAccount(provider, opts)
        : [
            ...(await native.getAvailable(provider, opts)),
            ...(provider ? [] : await added.getAvailable(undefined, opts)),
          ],
    getAvailableOfType: async (type, provider, opts) =>
      only(provider)
        ? added.getAvailableOfType(type, provider, opts)
        : [
            ...(await native.getAvailableOfType(type, provider, opts)),
            ...(provider
              ? []
              : await added.getAvailableOfType(type, undefined, opts)),
          ],
    getAllAvailable: async (provider, opts) =>
      only(provider)
        ? added.getAllAvailable(provider, opts)
        : [
            ...(await native.getAllAvailable(provider, opts)),
            ...(provider ? [] : await added.getAllAvailable(undefined, opts)),
          ],
    getAuth,
    refresh: (...args) => native.refresh(...args),
    checkAuth: (id, opts) => (only(id) ? added : native).checkAuth(id, opts),
    login: (...args) => native.login(...args),
    logout: (...args) => native.logout(...args),
    stream: (model, context, opts) => owner(model).stream(model, context, opts),
    complete: (model, context, opts) =>
      owner(model).complete(model, context, opts),
    streamSimple: (model, context, opts) =>
      owner(model).streamSimple(model, context, opts),
    completeSimple: (model, context, opts) =>
      owner(model).completeSimple(model, context, opts),
    streamDeferred: (model, handle, opts) =>
      owner(model).streamDeferred(model, handle, opts),
    fetchDeferred: (model, handle, opts) =>
      owner(model).fetchDeferred(model, handle, opts),
    cancelDeferred: (model, handle, opts) =>
      owner(model).cancelDeferred(model, handle, opts),
    generateImages: (...args) => native.generateImages(...args),
    classify: (...args) => native.classify(...args),
  };
  async function availableAccount(
    provider: string | undefined,
    opts: Parameters<Models["getAvailable"]>[1],
  ) {
    const status = options.statuses
      .current()
      .find((status) => status.name === provider);
    if (
      status &&
      status.signIn.state !== "signed-in" &&
      "hint" in status.signIn &&
      status.signIn.hint
    )
      throw new Error(
        terminalText({
          _tag: "SignInRequired",
          account: status.name,
          hint: status.signIn.hint,
        }),
      );
    return added.getAvailable(provider, opts);
  }
  return {
    models,
    owns: (provider) => routes.has(provider),
    ownTools: (provider) =>
      routes.get(provider)?.capabilities.ownTools === true,
    close: async () => {
      closed = true;
      unsubscribe();
      stopLimits();
      await updating;
      await options.bridge.close();
    },
  };
}
