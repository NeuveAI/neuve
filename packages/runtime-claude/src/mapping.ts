import type {
  AccountInfo,
  ModelUsage,
  SDKAssistantMessage,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  EffortLevel,
  RuntimeModel,
  type SessionPolicy,
  type CallUsage,
  type LimitWindow,
  type SignInState,
  type TurnOutcome,
  type RuntimeFailure,
} from "@neuve/runtime";
import { z } from "zod";
import { signInHint, type ClaudeAccount } from "./environment.ts";
import type { ErrorPrefixes } from "./services.ts";

const sdkModel = z.object({
  value: z.string().min(1),
  resolvedModel: z.string().optional(),
  displayName: z.string(),
  description: z.string(),
  supportsEffort: z.boolean().optional(),
  supportedEffortLevels: z.array(z.unknown()).optional(),
});
/** Malformed rows and future effort levels must not hide the account's other models. */
export function runtimeModels(input: unknown): RuntimeModel[] | undefined {
  const list = z.array(z.unknown()).safeParse(input);
  if (!list.success) return undefined;
  const models: RuntimeModel[] = [];
  for (const row of list.data) {
    const parsed = sdkModel.safeParse(row);
    if (!parsed.success) continue;
    const model = parsed.data;
    const mapped = RuntimeModel.safeParse({
      id: model.value,
      displayName: model.displayName,
      description: model.description,
      ...(model.resolvedModel === undefined
        ? {}
        : { resolvedModel: model.resolvedModel }),
      ...(model.supportsEffort === undefined
        ? {}
        : { supportsEffort: model.supportsEffort }),
      ...(model.supportedEffortLevels === undefined
        ? {}
        : {
            supportedEffortLevels: model.supportedEffortLevels.flatMap(
              (level) => {
                const known = EffortLevel.safeParse(level);
                return known.success ? [known.data] : [];
              },
            ),
          }),
    });
    if (mapped.success) models.push(mapped.data);
  }
  return [
    ...models.filter((model) => model.id === "default"),
    ...models.filter((model) => model.id !== "default"),
  ];
}

export function selectionEffort(
  selection: SessionPolicy["model"],
  models: ReadonlyArray<RuntimeModel> | undefined,
): { effort: EffortLevel | undefined; refused: boolean } {
  const effort = selection?.effort;
  const model =
    models?.find((row) => row.id === selection?.id) ??
    models?.find((row) => row.resolvedModel === selection?.id);
  if (
    effort === undefined ||
    (model !== undefined && model.supportsEffort !== true)
  )
    return { effort: undefined, refused: false };
  return {
    effort,
    refused: model?.supportedEffortLevels?.includes(effort) === false,
  };
}

export function modelLimits(
  entry: Pick<ModelUsage, "contextWindow" | "maxOutputTokens">,
) {
  const positive = z.number().int().positive();
  const contextWindow = positive.safeParse(entry.contextWindow);
  const maxOutputTokens = positive.safeParse(entry.maxOutputTokens);
  return {
    ...(contextWindow.success ? { contextWindow: contextWindow.data } : {}),
    ...(maxOutputTokens.success
      ? { maxOutputTokens: maxOutputTokens.data }
      : {}),
  };
}

export function probeSignIn(
  account: ClaudeAccount,
  info: AccountInfo,
): SignInState {
  const provider =
    info.apiProvider !== undefined && info.apiProvider !== "firstParty";
  // A key Claude Code's own /login made, or its OAuth sign-in, is the account's own login.
  const ownKey =
    info.apiKeySource === "/login managed key" || info.apiKeySource === "oauth";
  const key =
    info.apiKeySource !== undefined && info.apiKeySource !== "none" && !ownKey;
  if (
    !provider &&
    info.tokenSource === "none" &&
    !key &&
    !ownKey &&
    !info.email &&
    !info.subscriptionType
  )
    return { state: "not-signed-in", hint: signInHint(account) };
  const helper = /helper/i.test(info.apiKeySource ?? "");
  const folder =
    !provider &&
    !key &&
    (ownKey ||
      info.tokenSource === "claude.ai" ||
      info.tokenSource === "oauth" ||
      info.tokenSource === "config" ||
      info.tokenSource === "credentials" ||
      info.tokenSource === "keychain" ||
      (info.tokenSource === "none" &&
        Boolean(info.email || info.subscriptionType)));
  return {
    state: "signed-in",
    ...(info.email === undefined ? {} : { email: info.email }),
    ...(info.organization === undefined
      ? {}
      : { organization: info.organization }),
    ...(info.subscriptionType === undefined
      ? {}
      : { plan: info.subscriptionType }),
    credentialSource: folder
      ? "claude-config-folder"
      : helper
        ? "credential-helper"
        : "environment",
    sourceMatchesAccount: folder,
  };
}
export function limitWindow(info: RateInfo, at: string): LimitWindow {
  const type = info.rateLimitType;
  const window =
    type === "five_hour"
      ? "five-hour"
      : type === "seven_day"
        ? "weekly"
        : type === "seven_day_opus" || type === "seven_day_sonnet"
          ? "weekly-model"
          : type === "overage" || type === "seven_day_overage_included"
            ? "overage"
            : "other";
  const reset =
    info.resetsAt === undefined ? undefined : new Date(info.resetsAt * 1000);
  return {
    window,
    ...(window !== "weekly-model"
      ? {}
      : { model: type === "seven_day_opus" ? "opus" : "sonnet" }),
    status: info.status === "allowed_warning" ? "warning" : info.status,
    ...(info.utilization === undefined || !Number.isFinite(info.utilization)
      ? {}
      : { utilization: Math.min(1, Math.max(0, info.utilization)) }),
    ...(reset === undefined || !Number.isFinite(reset.getTime())
      ? {}
      : { resetsAt: reset.toISOString() }),
    observedAt: at,
  };
}
export function usageBlocked(info: RateInfo): boolean {
  return (
    info.status === "rejected" &&
    info.overageStatus !== "allowed" &&
    info.overageStatus !== "allowed_warning" &&
    !info.isUsingOverage &&
    !info.overageInUse
  );
}
type RateInfo = z.infer<typeof rateInfo>;
export const rateInfo = z.object({
  status: z.enum(["allowed", "allowed_warning", "rejected"]),
  rateLimitType: z
    .enum([
      "five_hour",
      "seven_day",
      "seven_day_opus",
      "seven_day_sonnet",
      "seven_day_overage_included",
      "overage",
    ])
    .optional(),
  resetsAt: z.number().optional(),
  utilization: z.number().optional(),
  overageStatus: z.enum(["allowed", "allowed_warning", "rejected"]).optional(),
  isUsingOverage: z.boolean().optional(),
  overageInUse: z.boolean().optional(),
});
export function assistantRateInfo(
  message: SDKAssistantMessage,
): RateInfo | undefined {
  const parsed = z
    .object({ api_error_params: z.object({ rate_limit_info: rateInfo }) })
    .safeParse(message);
  return parsed.success
    ? parsed.data.api_error_params.rate_limit_info
    : undefined;
}
export function assistantText(message: SDKAssistantMessage): string {
  return message.message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
}
export interface TurnObservations {
  readonly assistant?:
    | { readonly code: SDKAssistantMessage["error"]; readonly text: string }
    | undefined;
  readonly limited?: LimitWindow | undefined;
  readonly overloaded?: boolean | undefined;
}
export function outcomeFromResult(
  account: ClaudeAccount,
  result: SDKResultMessage,
  observations: TurnObservations,
  final: boolean,
  prefixes: ErrorPrefixes,
): TurnOutcome {
  const fail = (
    failure: RuntimeFailure,
    disposition: "reusable" | "broken" = "reusable",
  ): TurnOutcome => ({ status: "failed", failure, disposition });
  const turnFailure = (
    reason: Extract<RuntimeFailure, { _tag: "TurnFailed" }>["reason"],
  ) => fail({ _tag: "TurnFailed", account: account.name, reason });
  const hint = signInHint(account);
  const status =
    "api_error_status" in result ? result.api_error_status : undefined;
  const errorEvidence =
    result.is_error ||
    result.subtype !== "success" ||
    observations.assistant?.code !== undefined ||
    (status != null && status >= 400);
  const text = errorEvidence
    ? observations.assistant?.text ||
      ("errors" in result
        ? result.errors.find((line) => !line.startsWith("[ede_diagnostic]"))
        : result.result) ||
      ""
    : "";
  const code = observations.assistant?.code;
  const accountRejection =
    code === "oauth_org_not_allowed"
      ? "organization-not-allowed"
      : code === "account_on_hold"
        ? "account-on-hold"
        : code === "billing_error"
          ? "billing"
          : prefixes.organization.some((prefix) => text.startsWith(prefix))
            ? "organization-not-allowed"
            : undefined;
  if (accountRejection !== undefined)
    return fail({
      _tag: "AccountRejected",
      account: account.name,
      hint,
      reason: accountRejection,
    });
  const accountEvidence =
    status == null ||
    status < 400 ||
    ((status === 401 || status === 403) &&
      (code === "authentication_failed" || code === "verification_required"));
  const rejection =
    code === "authentication_failed" && /revoked/i.test(text)
      ? "revoked"
      : code === "authentication_failed" &&
          /expired|could not be refreshed/i.test(text)
        ? "expired"
        : status === 403 &&
            (code === "authentication_failed" ||
              code === "verification_required")
          ? "other"
          : undefined;
  if (accountEvidence && rejection !== undefined)
    return fail({
      _tag: "AccountRejected",
      account: account.name,
      hint,
      reason: rejection,
    });
  if (
    accountEvidence &&
    (code === "authentication_failed" || /not (?:logged|signed) in/i.test(text))
  )
    return fail({ _tag: "SignInRequired", account: account.name, hint });
  if (status != null && status >= 500)
    return turnFailure("provider-unavailable");
  const reason = result.terminal_reason;
  const limited =
    (observations.limited !== undefined ||
      prefixes.usage.some((prefix) => text.startsWith(prefix))) &&
    (status == null || status === 429) &&
    (reason == null || reason === "api_error" || reason === "blocking_limit");
  if (limited)
    return fail({
      _tag: "UsageLimitReached",
      account: account.name,
      ...observations.limited,
    });
  if (status != null && status >= 400) return turnFailure("provider-failed");
  if (
    reason === "aborted_streaming" ||
    reason === "aborted_tools" ||
    (result.subtype !== "success" && /interrupt|cancel/i.test(text))
  )
    return { status: "interrupted" };
  if (reason === "prompt_too_long" || reason === "blocking_limit")
    return turnFailure("context-overflow");
  if (result.subtype === "error_max_turns" || reason === "max_turns")
    return turnFailure("turn-limit-reached");
  if (
    ("startup_failure_reason" in result &&
      result.startup_failure_reason !== undefined) ||
    reason === "turn_setup_failed"
  )
    return fail(
      {
        _tag: "RuntimeUnavailable",
        account: account.name,
        reason: "start-failed",
      },
      "broken",
    );
  if (
    observations.overloaded ||
    code === "overloaded" ||
    /\b529\b|overloaded/i.test(text)
  )
    return turnFailure("provider-unavailable");
  if (
    result.subtype === "error_max_structured_output_retries" ||
    reason === "structured_output_retry_exhausted"
  )
    return turnFailure("structured-output-invalid");
  if (
    code !== undefined ||
    (reason !== undefined &&
      reason !== "completed" &&
      reason !== "stop_hook_prevented" &&
      reason !== "hook_stopped" &&
      reason !== "tool_deferred" &&
      reason !== "background_requested") ||
    result.subtype !== "success" ||
    result.is_error
  )
    return turnFailure("provider-failed");
  if (!final) return { status: "completed" };
  if (result.structured_output === undefined)
    return turnFailure("structured-output-missing");
  const structured = z.json().safeParse(result.structured_output);
  return structured.success
    ? { status: "completed", structuredOutput: structured.data }
    : turnFailure("structured-output-invalid");
}
export const zeroUsage = (): CallUsage => ({
  input: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
  output: 0,
});
export function modelUsage(entry: ModelUsage): CallUsage {
  // sdk.d.ts:1494: unattributed writes use the 5-minute lifetime. For
  // inconsistent subsets, cap the explicit 1-hour subset at the total and
  // allocate the remainder to 5 minutes, so normalized writes never exceed it.
  const hour = Math.min(
    entry.cacheCreationInputTokens,
    entry.cacheCreationEphemeral1hInputTokens ?? 0,
  );
  return {
    input: entry.inputTokens,
    output: entry.outputTokens,
    cacheRead: entry.cacheReadInputTokens,
    cacheWrite5m: entry.cacheCreationInputTokens - hour,
    cacheWrite1h: hour,
    ...(entry.thinkingTokens === undefined
      ? {}
      : { thinking: entry.thinkingTokens }),
  };
}
export function addUsage(a: CallUsage, b: CallUsage): CallUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
    ...(a.thinking === undefined && b.thinking === undefined
      ? {}
      : { thinking: (a.thinking ?? 0) + (b.thinking ?? 0) }),
  };
}
export function advanceLedger(
  previous: ReadonlyMap<string, CallUsage>,
  current: ReadonlyMap<string, CallUsage>,
): { baseline: Map<string, CallUsage>; deltas: Map<string, CallUsage> } {
  const baseline = new Map(previous);
  const deltas = new Map<string, CallUsage>();
  for (const [model, after] of current) {
    const before = previous.get(model) ?? zeroUsage();
    if (
      after.input < before.input ||
      after.output < before.output ||
      after.cacheRead < before.cacheRead ||
      after.cacheWrite5m < before.cacheWrite5m ||
      after.cacheWrite1h < before.cacheWrite1h ||
      (after.thinking ?? 0) < (before.thinking ?? 0)
    )
      continue;
    baseline.set(model, after);
    deltas.set(model, {
      input: after.input - before.input,
      output: after.output - before.output,
      cacheRead: after.cacheRead - before.cacheRead,
      cacheWrite5m: after.cacheWrite5m - before.cacheWrite5m,
      cacheWrite1h: after.cacheWrite1h - before.cacheWrite1h,
      ...(after.thinking === undefined
        ? {}
        : {
            thinking: Math.max(0, after.thinking - (before.thinking ?? 0)),
          }),
    });
  }
  return { baseline, deltas };
}
