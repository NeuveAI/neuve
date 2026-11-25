// Reason: eligibility crosses a persisted runtime boundary; terminal and malformed assertions must not retry.
import { expect, test } from "bun:test";
import { RetryEligibility, TurnOutcome } from "../src/index.ts";

const failed = {
  status: "failed",
  disposition: "reusable",
  failure: { _tag: "TurnFailed", account: "fixture", reason: "protocol-error" },
  retry: { kind: "protocol", continuation: "resume" },
};

test("only explicitly reusable matching failures can authorize harness retry", () => {
  expect(TurnOutcome.safeParse(failed).success).toBe(true);
  expect(TurnOutcome.safeParse({ ...failed, retry: undefined }).success).toBe(
    true,
  );
  expect(
    TurnOutcome.safeParse({ ...failed, disposition: "broken" }).success,
  ).toBe(false);
  for (const reason of [
    "session-stopped",
    "turn-limit-reached",
    "context-overflow",
    "previous-turn-active",
  ])
    expect(
      TurnOutcome.safeParse({
        ...failed,
        failure: { ...failed.failure, reason },
      }).success,
    ).toBe(false);
  for (const failure of [
    {
      _tag: "SignInRequired",
      account: "fixture",
      hint: { kind: "command", command: "claude auth login" },
    },
    { _tag: "AccountRejected", account: "fixture" },
    { _tag: "UsageLimitReached", account: "fixture" },
  ])
    expect(TurnOutcome.safeParse({ ...failed, failure }).success).toBe(false);
  const transient = {
    kind: "transient-provider",
    continuation: "repeat-request",
  };
  expect(TurnOutcome.safeParse({ ...failed, retry: transient }).success).toBe(
    false,
  );
  expect(
    TurnOutcome.safeParse({
      ...failed,
      failure: { ...failed.failure, reason: "provider-unavailable" },
      retry: transient,
    }).success,
  ).toBe(true);
});

test("retry delay metadata rejects nonfinite, negative, fractional and unbounded delays at ingress", () => {
  for (const retryAfterMs of [
    -1,
    NaN,
    Infinity,
    -Infinity,
    1.5,
    2_147_483_648,
    "2000",
  ])
    expect(
      RetryEligibility.safeParse({ ...failed.retry, retryAfterMs }).success,
    ).toBe(false);
  for (const retryAfterMs of [0, 2000, 2_147_483_647])
    expect(
      RetryEligibility.safeParse({ ...failed.retry, retryAfterMs }).success,
    ).toBe(true);
});
