import { expect, test } from "bun:test";
import { CorruptRecord } from "@neuve/records-core";
import { runtimeFailurePolicy } from "../../src/pi/failure-policy.ts";

// Why: a known malformed variant must not silently become an indefinite compatibility hold.
for (const failure of [
  { _tag: "AccountNotFound" },
  { _tag: "TurnFailed", account: 17, reason: "future" },
  { _tag: "RuntimeUnavailable", reason: "future" },
  { _tag: "AccountRejected", account: 17, reason: "future" },
  {
    _tag: "AccountRejected",
    account: "fake-claude",
    reason: "future",
    hint: 17,
  },
  { _tag: "AccountNotFound", account: 17, future: true },
  { _tag: "TurnFailed", account: "fake-claude" },
  { _tag: "TurnFailed", account: "fake-claude", reason: 17 },
  { _tag: "RuntimeUnavailable", account: "fake-claude", reason: null },
  { _tag: "AccountRejected", account: "fake-claude", reason: 17 },
  {
    _tag: "CapabilityUnsupported",
    account: "fake-claude",
    capability: "future",
  },
  { account: "fake-claude" },
  null,
]) {
  test(`runtime policy rejects corrupt failure ${JSON.stringify(failure)}`, () => {
    expect(() => runtimeFailurePolicy(failure)).toThrow(CorruptRecord);
    try {
      runtimeFailurePolicy(failure);
    } catch (error) {
      expect(error).toMatchObject({ _tag: "CorruptRecord", retryable: false });
    }
  });
}

// Why: tags and reason enums belong to the schema; prose and unrelated fields never select a policy.
for (const failure of [
  { _tag: "FutureFailure" },
  { _tag: "TurnFailed", account: "fake-claude", reason: "future" },
  { _tag: "RuntimeUnavailable", account: "fake-claude", reason: "future" },
  { _tag: "AccountRejected", account: "fake-claude", reason: "future" },
]) {
  test(`runtime policy leaves newer variant ${JSON.stringify(failure)}`, () => {
    expect(runtimeFailurePolicy(failure)).toEqual({
      action: "hold",
      retryable: false,
    });
  });
}

test("runtime policy reads additive fields on a known valid failure", () => {
  expect(
    runtimeFailurePolicy({
      _tag: "AccountNotFound",
      account: "fake-claude",
      future: true,
    }),
  ).toEqual({ action: "fail", retryable: false });
});

// Why: an unopened stage on a refused account must hold in every retry and final-turn mode.
test("runtime policy holds AccountNeedsNewerBuild before opening a stage", () => {
  for (const final of [false, true])
    for (const internalRetries of [false, true])
      expect(
        runtimeFailurePolicy(
          { _tag: "AccountNeedsNewerBuild", account: "fake-claude" },
          final,
          internalRetries,
        ),
      ).toEqual({ action: "hold", retryable: false });
});
