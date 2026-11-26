import { OPENAI_MODELS } from "@earendil-works/pi-ai/providers/openai.models";
import type { Log } from "./chat-runtime/transcript.ts";

export type ModelLimits = { contextWindow: number; maxTokens: number };
export type ReportedModelLimits = {
  [Limit in keyof ModelLimits]?: ModelLimits[Limit] | undefined;
};

export const DEFAULT_MODEL_LIMITS: ModelLimits = {
  contextWindow: 64_000,
  maxTokens: 8_192,
};

// The ChatGPT-plan window in process/decisions.md, 2.11. Codex applies
// effective_context_window_percent to context_window. pi-ai's openai provider
// supplies the output cap and supports Sign in with ChatGPT.
export const SOL_PLAN_WINDOW = 475_000;
export const SOL_PLAN_LIMITS: ModelLimits = {
  contextWindow: SOL_PLAN_WINDOW,
  maxTokens: OPENAI_MODELS["gpt-6.1-sol"].maxTokens,
};

// https://platform.claude.com/docs/en/models/opus-5-5/overview
export const OPUS_API_LIMITS: ModelLimits = {
  contextWindow: 1_000_000,
  maxTokens: 128_000,
};

// Claude Code documents the 1M default and defers its output cap to the model.
// https://code.claude.com/docs/en/model-config#extended-context
// https://code.claude.com/docs/en/env-vars
export const OPUS_CODE_LIMITS = OPUS_API_LIMITS;

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
