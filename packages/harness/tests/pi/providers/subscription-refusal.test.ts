import { afterEach, expect, test } from "bun:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { OPUS_ROUTE } from "../../../src/route.ts";
import { credentialPresent } from "../../../src/route-provider.ts";
import { ClaudeSubscriptionTokenRefused } from "../../../src/subscription-token.ts";
import {
  createAgentRouteProvider,
  createRouteModels,
} from "../../../src/pi/providers/agent-route-provider.ts";
import { createCountTokens } from "../../../src/pi/providers/count-tokens.ts";

const variable = "ANTHROPIC_API_KEY";
const subscription = "sk-ant-oat01-fake-refusal";
const apiKey = "sk-ant-api03-fake-refusal";
const message = new ClaudeSubscriptionTokenRefused(variable).message;
const context = {
  messages: [{ role: "user" as const, content: "Review it.", timestamp: 1 }],
};
const request = {
  label: "frame",
  system: "Review.",
  user: "Review it.",
  tools: [],
};
afterEach(() => {
  delete process.env[variable];
});

const transport = () => {
  const paths: string[] = [];
  const fetch: typeof globalThis.fetch = Object.assign(
    async (input: string | URL | Request) => {
      const path = new URL(input instanceof Request ? input.url : input)
        .pathname;
      paths.push(path);
      return path.endsWith("count_tokens")
        ? Response.json({ input_tokens: 7 })
        : Response.json(
            {
              type: "error",
              error: {
                type: "invalid_request_error",
                message: "fake endpoint reached",
              },
            },
            { status: 400 },
          );
    },
    globalThis.fetch,
  );
  return {
    paths,
    options: {
      route: OPUS_ROUTE,
      runId: "refusal",
      sessionAffinity: "refusal",
      credentialInspection: "ephemeral" as const,
      capture: () => {},
      fetch,
    },
  };
};

test("a present subscription reaches a concrete refusal before Messages or count preflight can send it, rather than being held as missing", async () => {
  const { paths, options } = transport();
  process.env[variable] = `  ${subscription}  `;
  expect(credentialPresent(OPUS_ROUTE)).toBe(true);
  for (const start of [
    () => createRouteModels(options),
    () =>
      createAgentRouteProvider({
        ...options,
        logicalProvider: "review.frame",
        readBinding: async () => {
          throw new Error("must not read binding");
        },
      }),
  ]) {
    expect(start).toThrow(ClaudeSubscriptionTokenRefused);
    expect(start).toThrow(message);
  }
  await expect(createCountTokens(options)(request)).rejects.toBeInstanceOf(
    ClaudeSubscriptionTokenRefused,
  );
  await expect(createCountTokens(options)(request)).rejects.toThrow(message);
  expect(message).not.toContain(subscription);
  expect(paths).toEqual([]);
});

test("provider check and resolution refuse a credential introduced after creation before a request", async () => {
  const { paths, options } = transport();
  delete process.env[variable];
  const models = createRouteModels(options);
  const provider = models.getProvider("anthropic")!;
  const input = {
    ctx: { env: async () => subscription, fileExists: async () => false },
    signal: new AbortController().signal,
  };
  await expect(provider.auth.apiKey!.check!(input)).rejects.toThrow(message);
  await expect(provider.auth.apiKey!.resolve(input)).rejects.toBeInstanceOf(
    ClaudeSubscriptionTokenRefused,
  );
  expect(paths).toEqual([]);
});

test("the stream itself refuses explicit subscription keys and bearer headers so callers cannot bypass resolution", async () => {
  const { paths, options } = transport();
  delete process.env[variable];
  const models = createRouteModels(options);
  const provider = models.getProvider("anthropic")!;
  const model = models.getModel("anthropic", OPUS_ROUTE.model)!;
  for (const auth of [
    { apiKey: subscription },
    { headers: { Authorization: `Bearer ${subscription}` } },
    { headers: { "x-api-key": subscription } },
  ]) {
    expect(() =>
      provider.stream(model, normalizeContext(context), auth),
    ).toThrow(ClaudeSubscriptionTokenRefused);
    expect(() =>
      provider.stream(model, normalizeContext(context), auth),
    ).toThrow(message);
  }
  expect(paths).toEqual([]);
});

test("ordinary API credentials still reach Messages and count_tokens through the same route", async () => {
  const { paths, options } = transport();
  process.env[variable] = apiKey;
  expect(credentialPresent(OPUS_ROUTE)).toBe(true);
  const models = createRouteModels(options);
  expect(await models.checkAuth("anthropic")).toEqual({
    source: variable,
    type: "api_key",
  });
  const answer = await models.complete(
    models.getModel("anthropic", OPUS_ROUTE.model)!,
    context,
  );
  expect(answer.stopReason).toBe("error");
  expect(await createCountTokens(options)(request)).toBe(7);
  expect(paths).toEqual(["/v1/messages", "/v1/messages/count_tokens"]);
});

test("empty and whitespace credentials remain missing at route admission and provider authentication", async () => {
  const { paths, options } = transport();
  for (const value of ["", " \t "]) {
    process.env[variable] = value;
    expect(credentialPresent(OPUS_ROUTE)).toBe(false);
    const models = createRouteModels(options);
    expect(await models.checkAuth("anthropic")).toBeUndefined();
    expect(await models.getAuth("anthropic")).toBeUndefined();
    await expect(createCountTokens(options)(request)).rejects.toThrow(
      "not set",
    );
  }
  expect(paths).toEqual([]);
});
