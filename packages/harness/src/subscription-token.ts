import { Data } from "effect";

/** Anthropic's credential prefixes are case-sensitive. Whitespace is not part of a credential. */
export const isClaudeSubscriptionToken = (value: string | undefined): boolean =>
  value?.trim().startsWith("sk-ant-oat") ?? false;

export class ClaudeSubscriptionTokenRefused extends Data.TaggedError(
  "ClaudeSubscriptionTokenRefused",
)<{
  readonly credentialVariable: string;
  readonly message: string;
  readonly retryable: false;
}> {
  constructor(credentialVariable: string) {
    super({
      credentialVariable,
      retryable: false,
      message: `${credentialVariable} contains a Claude subscription token. A Claude subscription runs only through Claude Code; this route needs an Anthropic API key. To use a Claude subscription, sign in to Claude Code itself.`,
    });
  }
}
