import { expect, test } from "bun:test";
import {
  ClaudeSubscriptionTokenRefused,
  isClaudeSubscriptionToken,
} from "../src/subscription-token.ts";

test("one case-sensitive definition classifies subscription credentials after trimming", () => {
  expect(isClaudeSubscriptionToken(" \tsk-ant-oat01-fake-subscription\n")).toBe(
    true,
  );
  for (const value of [
    "sk-ant-api03-fake-key",
    "",
    " \t",
    undefined,
    "SK-ANT-OAT01-fake",
    "prefix-sk-ant-oat01-fake",
  ]) {
    expect(isClaudeSubscriptionToken(value)).toBe(false);
  }
});

test("the refusal identifies the variable and Claude Code sign-in without carrying a credential", () => {
  const error = new ClaudeSubscriptionTokenRefused("ANTHROPIC_API_KEY");
  expect(error._tag).toBe("ClaudeSubscriptionTokenRefused");
  expect(error.message).toBe(
    "ANTHROPIC_API_KEY contains a Claude subscription token. A Claude subscription runs only through Claude Code; this route needs an Anthropic API key. To use a Claude subscription, sign in to Claude Code itself.",
  );
  expect(error.message).not.toContain("sk-ant-");
  expect(error.message).not.toContain("neuve auth");
});
