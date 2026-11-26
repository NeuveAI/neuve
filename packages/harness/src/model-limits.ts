import { SOL_ROUTE } from "./route.ts";

type Log = (event: string, fields: Readonly<Record<string, unknown>>) => void;

export type ModelLimits = { contextWindow: number; maxTokens: number };
export type ReportedModelLimits = {
  [Limit in keyof ModelLimits]?: ModelLimits[Limit] | undefined;
};

// Neuve's cautious defaults. GPT-5.3 Codex Spark has the smallest context window in
// pi-ai's bundled Anthropic and Codex catalogues (dist/providers/data/{anthropic,openai-codex}.json).
// The output cap matches pi-durable's blocking compaction reserve (dist/harness/agent.js).
export const DEFAULT_MODEL_LIMITS: ModelLimits = {
  contextWindow: 128_000,
  maxTokens: 16_384,
};

// Claude Code's extended-context defaults and Anthropic's model output limits
// cover these two IDs missing from the bundled pi-ai catalog.
// https://code.claude.com/docs/en/model-config#extended-context
// https://platform.claude.com/docs/en/models/overview
export const CLAUDE_CODE_CATALOG_GAPS: Readonly<
  Partial<Record<string, ModelLimits>>
> = {
  "claude-fable-5-2": { contextWindow: 1_000_000, maxTokens: 128_000 },
  "claude-haiku-5-5": { contextWindow: 1_000_000, maxTokens: 128_000 },
};

// Codex uses 95% of each bundled window by default, giving Sol 475,000 usable tokens.
// The model metadata has no output cap.
// https://github.com/openai/codex/blob/581161ab41e643d942e1e1b5f561034060bf18e3/codex-rs/models-manager/models.json
export const CODEX_BUNDLED_LIMITS: Readonly<
  Partial<Record<string, ReportedModelLimits>>
> = {
  "gpt-6.1-sol": { contextWindow: SOL_ROUTE.window },
  "gpt-6.1-terra": { contextWindow: 475_000 },
  "gpt-6.2-sol": { contextWindow: 475_000 },
  "gpt-6.2-astra": { contextWindow: 258_400 },
};

type Observations = ReportedModelLimits | undefined;

/** Resolve each field independently: runtimes can report one without the other. */
export function resolveModelLimits(
  turn: Observations,
  account: Observations,
  documented: Observations,
  catalog: Observations,
  onDefault?: (limits: Partial<ModelLimits>) => void,
): ModelLimits {
  const contextWindow =
    turn?.contextWindow ??
    account?.contextWindow ??
    documented?.contextWindow ??
    catalog?.contextWindow;
  const maxTokens =
    turn?.maxTokens ??
    account?.maxTokens ??
    documented?.maxTokens ??
    catalog?.maxTokens;
  if (contextWindow === undefined || maxTokens === undefined)
    onDefault?.({
      ...(contextWindow === undefined
        ? { contextWindow: DEFAULT_MODEL_LIMITS.contextWindow }
        : {}),
      ...(maxTokens === undefined
        ? { maxTokens: DEFAULT_MODEL_LIMITS.maxTokens }
        : {}),
    });
  return {
    contextWindow: contextWindow ?? DEFAULT_MODEL_LIMITS.contextWindow,
    maxTokens: maxTokens ?? DEFAULT_MODEL_LIMITS.maxTokens,
  };
}

/** Warn once per account and model, including when only one limit is missing. */
export function logDefaultModelLimits(log?: Log) {
  const warned = new Set<string>();
  return (account: string, model: string, defaults: Partial<ModelLimits>) => {
    const key = JSON.stringify([account, model]);
    if (warned.has(key)) return;
    warned.add(key);
    log?.("model-limits.default", { account, model, ...defaults });
  };
}
