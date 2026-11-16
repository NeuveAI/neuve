import { z } from "zod";

export const AccountName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
  .brand<"AccountName">();
export type AccountName = z.infer<typeof AccountName>;

export const AccountKind = z.enum([
  "claude-subscription",
  "anthropic-api-key",
  "chatgpt-subscription",
  "openai-api-key",
]);
export type AccountKind = z.infer<typeof AccountKind>;
export const RuntimeKind = z.enum(["pi", "claude-code"]);
export type RuntimeKind = z.infer<typeof RuntimeKind>;
export const AbsoluteFolder = z.string().startsWith("/");
export const EnvironmentVariable = z.string().regex(/^[A-Z][A-Z0-9_]*$/);

/** Only Claude Code writes this folder; absence selects its own default configuration. */
export const ClaudeConfigFolder = z.strictObject({
  kind: z.literal("claude-config-folder"),
  folder: AbsoluteFolder.optional(),
});
const VaultReference = z.strictObject({
  kind: z.literal("vault"),
  entry: EnvironmentVariable,
});
const EnvironmentReference = z.strictObject({
  kind: z.literal("environment"),
  variable: EnvironmentVariable,
});
/** Absence selects today's default ChatGPT sign-in. */
const NeuveSignIn = z.strictObject({
  kind: z.literal("neuve-sign-in"),
  folder: AbsoluteFolder.optional(),
});
const ApiKeyReference = z.discriminatedUnion("kind", [
  VaultReference,
  EnvironmentReference,
]);
export const CredentialReference = z.discriminatedUnion("kind", [
  ClaudeConfigFolder,
  VaultReference,
  EnvironmentReference,
  NeuveSignIn,
]);
export type CredentialReference = z.infer<typeof CredentialReference>;

/** Each variant permits only the runtime and reference that can serve this account kind. */
export const Account = z.discriminatedUnion("kind", [
  z.strictObject({
    name: AccountName,
    kind: z.literal("claude-subscription"),
    runtime: z.literal("claude-code"),
    credential: ClaudeConfigFolder,
  }),
  z.strictObject({
    name: AccountName,
    kind: z.literal("anthropic-api-key"),
    runtime: RuntimeKind,
    credential: ApiKeyReference,
  }),
  z.strictObject({
    name: AccountName,
    kind: z.literal("chatgpt-subscription"),
    runtime: z.literal("pi"),
    credential: NeuveSignIn,
  }),
  z.strictObject({
    name: AccountName,
    kind: z.literal("openai-api-key"),
    runtime: z.literal("pi"),
    credential: ApiKeyReference,
  }),
]);
export type Account = z.infer<typeof Account>;
