import { OPENAI_BASE_URL } from "../../provider-urls.ts";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AnyRouteConfig } from "../../route.ts";

/**
 * The physical route's native descriptor, shared by registration and the coding host.
 * The ChatGPT plan has no token price. Its mandatory numeric rates are placeholders;
 * display prices only when `route.price !== null`, and account with Neuve's `costOf`.
 */
export const routeModel = (route: AnyRouteConfig): Model<Api> => {
  const common = {
    id: route.model,
    name: route.model,
    provider: route.provider,
    reasoning: true,
    input: ["text"],
    thinkingLevelMap: {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: null,
      max: null,
    },
    contextWindow: route.window,
    maxTokens: route.maxOutputTokens,
  } satisfies Omit<Model<Api>, "api" | "baseUrl" | "cost" | "compat">;
  return route.provider === "openai"
    ? {
        ...common,
        api: "openai-responses",
        baseUrl: OPENAI_BASE_URL,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { supportsStrictMode: true, supportsMaxOutputTokens: false },
      }
    : {
        ...common,
        api: "anthropic-messages",
        baseUrl: "https://api.anthropic.com",
        cost: {
          input: route.price.input,
          output: route.price.output,
          cacheRead: route.price.input * route.price.cacheRead,
          cacheWrite: route.price.input * route.price.cacheWrite5m,
        },
        compat: {
          supportsStrictTools: true,
          supportsEagerToolInputStreaming: false,
        },
      };
};
