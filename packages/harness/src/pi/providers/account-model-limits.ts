import { z } from "zod";
import { accessToken } from "../../openai-auth.ts";
import {
  routeAccount,
  routeCredentialVariable,
  type DirectRouteConfig,
} from "../../route.ts";
import { isClaudeSubscriptionToken } from "../../subscription-token.ts";
import { routeModel } from "./route-model.ts";
import type { RouteModelsOptions } from "./agent-route-provider.ts";
import type { RouteAdmission } from "./route-admission.ts";

const positive = z.number().int().positive().nullish().catch(undefined);
const planCatalog = z.object({ models: z.array(z.unknown()) });
const planModel = z.object({
  slug: z.string(),
  context_window: positive,
  effective_context_window_percent: z.number().int().min(1).max(100).nullish(),
  max_output_tokens: positive,
});
const anthropicModel = z.object({
  max_input_tokens: positive,
  max_tokens: positive,
});

type CatalogTransport = Pick<
  RouteModelsOptions,
  "auth" | "baseUrl" | "fetch"
> & {
  readonly admission: RouteAdmission;
};

async function readAccountModel(
  route: DirectRouteConfig,
  transport: CatalogTransport,
) {
  // Codex's best-effort catalog refresh deadline includes credential resolution.
  // https://github.com/openai/codex/blob/581161ab41e643d942e1e1b5f561034060bf18e3/codex-rs/models-manager/src/manager.rs#L572-L598
  const signal = AbortSignal.timeout(5_000);
  const { admission } = transport;
  const base = (transport.baseUrl ?? routeModel(route).baseUrl).replace(
    /\/$/,
    "",
  );
  const fetchModel = async (path: string, headers: Record<string, string>) => {
    const response = await (transport.fetch ?? globalThis.fetch)(
      `${base}${path}`,
      {
        headers,
        redirect: "error",
        signal,
      },
    );
    if (!response.ok)
      admission.observe(
        response.headers.get("retry-after"),
        Date.now(),
        response.status,
      );
    return response;
  };
  await admission.wait(signal);
  if (route.provider === "openai") {
    const { token, expiresAt } = await accessToken({
      ...transport.auth,
      signal,
    });
    await admission.wait(signal);
    if (expiresAt <= Date.now()) return;
    // https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
    const response = await fetchModel("/models", {
      authorization: `Bearer ${token}`,
    });
    if (!response.ok) return;
    const list = planCatalog.parse(await response.json());
    for (const raw of list.models) {
      const row = planModel.safeParse(raw);
      if (!row.success || row.data.slug !== route.model) continue;
      const {
        context_window,
        effective_context_window_percent,
        max_output_tokens,
      } = row.data;
      // Codex defaults to a 95% usable share.
      // https://github.com/openai/codex/blob/581161ab41e643d942e1e1b5f561034060bf18e3/codex-rs/protocol/src/openai_models.rs#L384-L386
      const usablePercent = effective_context_window_percent ?? 95;
      return {
        contextWindow:
          context_window == null
            ? undefined
            : Math.floor((context_window * usablePercent) / 100) || undefined,
        maxTokens: max_output_tokens,
      };
    }
    return;
  }
  const key = process.env[routeCredentialVariable(route)];
  if (!key || isClaudeSubscriptionToken(key)) return;
  // https://platform.claude.com/docs/en/api/http/models/retrieve
  const response = await fetchModel(
    `/v1/models/${encodeURIComponent(route.model)}`,
    {
      "x-api-key": key,
      "anthropic-version": "2026-10-21",
    },
  );
  if (!response.ok) return;
  const row = anthropicModel.parse(await response.json());
  return { contextWindow: row.max_input_tokens, maxTokens: row.max_tokens };
}

/** Return a route only when the account reports at least one limit. */
export async function codingRouteLimits(
  route: DirectRouteConfig,
  transport: CatalogTransport,
  log: (fields: Readonly<Record<string, unknown>>) => void,
): Promise<DirectRouteConfig | undefined> {
  const reported = await readAccountModel(route, transport).catch(
    () => undefined,
  );
  const window = reported?.contextWindow ?? route.window;
  const maxOutputTokens = reported?.maxTokens ?? route.maxOutputTokens;
  const contextSource =
    reported?.contextWindow == null ? "configured-route" : "account-catalog";
  const outputSource =
    reported?.maxTokens == null ? "configured-route" : "account-catalog";
  log({
    account: routeAccount(route)?.name ?? route.provider,
    model: route.model,
    contextWindow: window,
    maxOutputTokens,
    contextSource,
    outputSource,
  });
  if (contextSource === "account-catalog" || outputSource === "account-catalog")
    return { ...route, window, maxOutputTokens };
}
