import { z } from "zod";
import { AbsoluteFolder, AccountKind, AccountName } from "./account.ts";

/** Commands have fixed words; callers apply or print the supplied environment. */
export const SignInHint = z.union([
  z.strictObject({
    kind: z.literal("command"),
    command: z.literal("claude auth login"),
    environment: z
      .strictObject({ CLAUDE_CONFIG_DIR: AbsoluteFolder })
      .optional(),
  }),
  z.strictObject({
    kind: z.literal("command"),
    command: z.literal("neuve auth login"),
    account: AccountName,
  }),
  z.strictObject({ kind: z.literal("settings"), entry: z.literal("accounts") }),
]);
export type SignInHint = z.infer<typeof SignInHint>;
export const RuntimeUnavailableReason = z.enum([
  "not-installed",
  "not-registered",
  "unsupported-version",
  "start-failed",
]);
export type RuntimeUnavailableReason = z.infer<typeof RuntimeUnavailableReason>;
export const CredentialSource = z.enum([
  "claude-config-folder",
  "environment",
  "vault",
  "neuve-sign-in",
  "runtime-default",
  "credential-helper",
]);
export type CredentialSource = z.infer<typeof CredentialSource>;
export const AccountRejectedReason = z.enum([
  "expired",
  "revoked",
  "account-on-hold",
  "billing",
  "organization-not-allowed",
  "other",
]);
export type AccountRejectedReason = z.infer<typeof AccountRejectedReason>;
export const SignInState = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("signed-in"),
    email: z.string().optional(),
    organization: z.string().optional(),
    plan: z.string().optional(),
    credentialSource: CredentialSource.optional(),
    sourceMatchesAccount: z.boolean().optional(),
  }),
  z.strictObject({ state: z.literal("not-signed-in"), hint: SignInHint }),
  z.strictObject({
    state: z.literal("credential-rejected"),
    hint: SignInHint.optional(),
    reason: AccountRejectedReason.optional(),
  }),
  z.strictObject({
    state: z.literal("runtime-unavailable"),
    reason: RuntimeUnavailableReason,
  }),
  z.strictObject({
    state: z.literal("unknown"),
    reason: z.enum(["not-checked", "check-failed", "needs-newer-build"]),
    hint: SignInHint.optional(),
  }),
]);
export type SignInState = z.infer<typeof SignInState>;
export const LimitWindowKind = z.enum([
  "five-hour",
  "weekly",
  "weekly-model",
  "overage",
  "other",
]);
export type LimitWindowKind = z.infer<typeof LimitWindowKind>;
export const LimitWindow = z.strictObject({
  window: LimitWindowKind,
  /** The model for a weekly-model window, when known. */
  model: z.string().optional(),
  status: z.enum(["allowed", "warning", "rejected"]),
  utilization: z.number().min(0).max(1).optional(),
  resetsAt: z.iso.datetime({ offset: true }).optional(),
  observedAt: z.iso.datetime({ offset: true }).optional(),
});
export type LimitWindow = z.infer<typeof LimitWindow>;

export const EffortLevel = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type EffortLevel = z.infer<typeof EffortLevel>;

/**
 * A model the runtime offers for this account, with the runtime's own display name. `id` is what
 * SessionPolicy.model.id takes; `resolvedModel` is the model an alias row stands for. A model
 * without supportsEffort takes no effort.
 */
export const RuntimeModel = z.strictObject({
  id: z.string().min(1),
  resolvedModel: z.string().optional(),
  displayName: z.string(),
  description: z.string(),
  supportsEffort: z.boolean().optional(),
  supportedEffortLevels: z.array(EffortLevel).optional(),
});
export type RuntimeModel = z.infer<typeof RuntimeModel>;

/** A probe supplies only observations; the registry supplies account identity. */
export const AccountProbe = z.strictObject({
  signIn: SignInState,
  limits: z.array(LimitWindow),
  checkedAt: z.iso.datetime({ offset: true }),
  /** The models the runtime offers for this account, its default first. Omitted by pi. */
  models: z.array(RuntimeModel).optional(),
});
export type AccountProbe = z.infer<typeof AccountProbe>;

/** Pushed metadata only. The runtime normalizes labels and omits provider error text. */
export const AccountStatus = z.strictObject({
  name: AccountName,
  kind: AccountKind,
  ...AccountProbe.shape,
});
export type AccountStatus = z.infer<typeof AccountStatus>;
