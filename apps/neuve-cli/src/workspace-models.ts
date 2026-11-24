import type { AnyModel, AuthResult, Models } from "@earendil-works/pi-ai";

const combine = <T extends { provider: string; id: string; type?: string }>(
  native: readonly T[],
  configured: readonly T[],
): T[] => {
  const key = (model: T) =>
    `${model.type ?? "chat"}/${model.provider}/${model.id}`;
  const models = new Map(native.map((model) => [key(model), model]));
  for (const model of configured) models.set(key(model), model);
  return [...models.values()];
};

/** One configured chat route overrides its exact model, while Ace retains every other model. */
export function workspaceModels(
  native: Models,
  configured: Models,
  route: {
    provider: string;
    model: string;
  },
): Models {
  const matches = (model: AnyModel) =>
    (model.type === undefined || model.type === "chat") &&
    model.provider === route.provider &&
    model.id === route.model;
  const owner = (model: AnyModel) => (matches(model) ? configured : native);
  const available = async <
    T extends { provider: string; id: string; type?: string },
  >(
    native: Promise<readonly T[]>,
    configured: Promise<readonly T[]>,
  ) => {
    const [original, added] = await Promise.allSettled([native, configured]);
    const models = combine(
      original.status === "fulfilled" ? original.value : [],
      added.status === "fulfilled" ? added.value : [],
    );
    if (models.length) return models;
    if (original.status === "rejected") throw original.reason;
    if (added.status === "rejected") throw added.reason;
    return models;
  };
  function getAuth(
    provider: string,
    overrides?: Parameters<Models["getAuth"]>[1],
  ): Promise<AuthResult | undefined>;
  function getAuth(
    model: AnyModel,
    overrides?: Parameters<Models["getAuth"]>[1],
  ): Promise<AuthResult | undefined>;
  function getAuth(
    value: string | AnyModel,
    overrides?: Parameters<Models["getAuth"]>[1],
  ) {
    return typeof value === "string"
      ? native.getAuth(value, overrides)
      : owner(value).getAuth(value, overrides);
  }
  return {
    getProviders: () => {
      const original = native.getProviders();
      return [
        ...original,
        ...configured
          .getProviders()
          .filter(
            (provider) => !original.some((found) => found.id === provider.id),
          ),
      ];
    },
    getProvider: (id) => native.getProvider(id) ?? configured.getProvider(id),
    getModels: (provider) =>
      combine(native.getModels(provider), configured.getModels(provider)),
    getModel: (provider, id) =>
      provider === route.provider && id === route.model
        ? configured.getModel(provider, id)
        : native.getModel(provider, id),
    getModelsOfType: (type, provider) =>
      combine(
        native.getModelsOfType(type, provider),
        configured.getModelsOfType(type, provider),
      ),
    getModelOfType: (type, provider, id) =>
      type === "chat" && provider === route.provider && id === route.model
        ? configured.getModelOfType(type, provider, id)
        : native.getModelOfType(type, provider, id),
    getAllModels: (provider) =>
      combine(native.getAllModels(provider), configured.getAllModels(provider)),
    refresh: (...args) => native.refresh(...args),
    checkAuth: (...args) => native.checkAuth(...args),
    getAvailable: (provider, options) =>
      available(
        native.getAvailable(provider, options),
        configured.getAvailable(provider, options),
      ),
    getAvailableOfType: (type, provider, options) =>
      available(
        native.getAvailableOfType(type, provider, options),
        configured.getAvailableOfType(type, provider, options),
      ),
    getAllAvailable: (provider, options) =>
      available(
        native.getAllAvailable(provider, options),
        configured.getAllAvailable(provider, options),
      ),
    getAuth,
    login: (...args) => native.login(...args),
    logout: (...args) => native.logout(...args),
    stream: (model, context, options) =>
      owner(model).stream(model, context, options),
    complete: (model, context, options) =>
      owner(model).complete(model, context, options),
    streamSimple: (model, context, options) =>
      owner(model).streamSimple(model, context, options),
    completeSimple: (model, context, options) =>
      owner(model).completeSimple(model, context, options),
    streamDeferred: (model, handle, options) =>
      owner(model).streamDeferred(model, handle, options),
    fetchDeferred: (model, handle, options) =>
      owner(model).fetchDeferred(model, handle, options),
    cancelDeferred: (model, handle, options) =>
      owner(model).cancelDeferred(model, handle, options),
    generateImages: (...args) => native.generateImages(...args),
    classify: (...args) => native.classify(...args),
  };
}

/**
 * What the configured review route supplies coding sessions: its model as the host's default and
 * its default reasoning effort. A Claude route's model is offered under one of its account's model
 * rows (an alias such as `opus`), which only the account's current status names, so its default
 * is resolved per session (`claudeDefaultModel`) and the host is given none.
 */
export const routeCodingDefaults = (route: {
  provider: string;
  model: string;
  effort: string;
}) =>
  route.provider === "claude"
    ? { thinkingLevel: route.effort }
    : {
        model: { provider: route.provider, modelId: route.model },
        thinkingLevel: route.effort,
      };

export const routeModelRef = (route: {
  provider: string;
  model: string;
  account?: { name: string } | undefined;
}) => {
  if (route.provider === "claude") return undefined;
  const account = route.account?.name;
  return {
    provider: route.provider,
    modelId: route.model,
    ...(account === undefined ? {} : { account }),
  };
};

export const routeHostModels = <E>(
  route: Parameters<typeof routeModelRef>[0],
  efforts: () => E[],
) => {
  const model = routeModelRef(route);
  return model ? [{ ...model, efforts: efforts() }] : [];
};
