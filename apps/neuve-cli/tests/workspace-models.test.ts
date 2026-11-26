import { expect, test } from "bun:test";
import { createModels, type Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { Option } from "effect";
import {
  routeCodingDefaults,
  routeHostModels,
  workspaceModels,
} from "../src/workspace-models.ts";
import {
  defaultConfig,
  runKeyFor,
} from "../../../packages/harness/src/config.ts";
import { settingsRoute } from "../../../packages/harness/src/request.ts";
import { Settings } from "../../../packages/harness/src/settings.ts";

const context = { messages: [] };
const text = async (models: Models, provider: string, id: string) => {
  const model = models.getModel(provider, id);
  if (!model) throw new Error(`Missing ${provider}/${id}`);
  const answer = await models.completeSimple(model, context);
  return answer.content;
};

test("only the exact configured provider and model use Neuve's route", async () => {
  const native = createModels();
  const openai = fauxProvider({
    provider: "openai",
    models: [{ id: "selected" }, { id: "other" }],
  });
  const anthropic = fauxProvider({
    provider: "anthropic",
    models: [{ id: "selected" }],
  });
  native.setProvider(openai.provider);
  native.setProvider(anthropic.provider);
  const configured = createModels();
  const neuve = fauxProvider({
    provider: "openai",
    models: [{ id: "selected" }],
  });
  configured.setProvider(neuve.provider);
  const models = workspaceModels(native, configured, {
    provider: "openai",
    model: "selected",
  });
  neuve.setResponses([fauxAssistantMessage("Neuve configured route")]);
  openai.setResponses([fauxAssistantMessage("Ace other OpenAI model")]);
  anthropic.setResponses([fauxAssistantMessage("Ace other provider")]);
  expect(await text(models, "openai", "selected")).toEqual([
    { type: "text", text: "Neuve configured route" },
  ]);
  expect(await text(models, "openai", "other")).toEqual([
    { type: "text", text: "Ace other OpenAI model" },
  ]);
  expect(await text(models, "anthropic", "selected")).toEqual([
    { type: "text", text: "Ace other provider" },
  ]);
  expect(
    (await models.getAvailable())
      .map((model) => `${model.provider}/${model.id}`)
      .sort(),
  ).toEqual(["anthropic/selected", "openai/other", "openai/selected"]);
  expect(models.getProvider("openai")).toBe(openai.provider);
});

test("the actual pinned built-in catalog retains native providers and OpenAI models", () => {
  const native = builtinModels({
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  const configured = createModels();
  const neuve = fauxProvider({
    provider: "openai",
    models: [{ id: "neuve-only" }],
  });
  configured.setProvider(neuve.provider);
  const models = workspaceModels(native, configured, {
    provider: "openai",
    model: "neuve-only",
  });
  expect(models.getModel("openai", "gpt-6-astra")?.id).toBe("gpt-6-astra");
  expect(models.getModel("anthropic", "claude-opus-5-5")?.id).toBe(
    "claude-opus-5-5",
  );
  expect(models.getModel("openai", "neuve-only")?.id).toBe("neuve-only");
  expect(
    models
      .getModelsOfType("chat", "openai")
      .some((model) => model.id === "gpt-6-astra"),
  ).toBe(true);
  expect(
    models.getAllModels("openai").some((model) => model.id === "neuve-only"),
  ).toBe(true);
  expect(models.getProvider("openai")).toBe(native.getProvider("openai"));
  expect(
    models.getProviders().filter((provider) => provider.id === "openai"),
  ).toHaveLength(1);
});

// Why: A review route can list OpenAI as its provider while running on a ChatGPT account.
test("direct routes list accounts and keep coding defaults and equivalent current review identity; Claude adds no row", () => {
  const route = (name?: "anthropic" | "openai" | "claude") =>
    settingsRoute(
      name === undefined
        ? Option.none()
        : Option.some(Settings.parse({ version: 1, review: { route: name } })),
    );
  const range = {
    baseRef: "main",
    baseOid: "a".repeat(40),
    headOid: "b".repeat(40),
  };
  // Implied default credentials and explicit account metadata name the same current review.
  for (const [name, provider, model, account] of [
    [undefined, "anthropic", "claude-opus-5-5", "anthropic"],
    ["openai", "openai", "gpt-6.1-sol", "chatgpt"],
  ] as const) {
    const direct = route(name);
    if (direct.provider === "claude")
      throw new Error("A direct route fixture must not select Claude");
    expect(routeCodingDefaults(direct)).toEqual({
      model: { provider, modelId: model },
      thinkingLevel: "medium",
    });
    expect(routeHostModels(direct, () => ["low", "high"])).toEqual([
      { provider, modelId: model, account, efforts: ["low", "high"] },
    ]);
    const { account: _account, ...implied } = direct;
    expect(runKeyFor(range, defaultConfig(undefined, direct))).toBe(
      runKeyFor(range, defaultConfig(undefined, implied)),
    );
  }
  const claude = route("claude");
  expect(routeCodingDefaults(claude)).toEqual({ thinkingLevel: "medium" });
  expect(
    routeHostModels(claude, () => {
      throw new Error("a Claude route has no direct model's efforts");
    }),
  ).toEqual([]);
});
