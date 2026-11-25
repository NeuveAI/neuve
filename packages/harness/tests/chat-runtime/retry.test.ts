// Why: retry eligibility must not regress to provider-text matching, and durable tool results gate continuation.
import { expect, test } from "bun:test";
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { retryAt, retryDecision, replayTool, toolLedger } from "../../src/chat-runtime/retry.ts";
import { usage } from "../../src/chat-runtime/transcript.ts";

const outcome = (kind = "transient-provider", continuation = "repeat-request") => ({
  status: "failed", disposition: "reusable", failure: { _tag: "TurnFailed", account: "claude", reason: kind === "protocol" ? "protocol-error" : "provider-failed" },
  retry: { kind, continuation },
});
const safe = { ledger: toolLedger([]), outstanding: false, canResume: true, resumePoint: "carrier" };
const call: AssistantMessage = { role: "assistant", content: [{ type: "toolCall", id: "write", name: "bash", arguments: { command: "increment-counter" } }],
  provider: "claude", model: "opus", api: "anthropic-messages", stopReason: "toolUse", timestamp: 0, usage: usage() };
const result: ToolResultMessage = { role: "toolResult", toolCallId: "write", toolName: "bash", content: [{ type: "text", text: "counter=1" }], isError: false, timestamp: 1 };

test("positive 25% jitter, doubling and retry-after floor; malformed metadata refused", () => {
  const now = 1_000;
  for (let attempt = 1; attempt <= 5; attempt++) {
    expect(Date.parse(retryAt(attempt, now, undefined, 0)) - now).toBe(2_000 * 2 ** (attempt - 1));
    expect(Date.parse(retryAt(attempt, now, undefined, 1)) - now).toBe(2_500 * 2 ** (attempt - 1));
  }
  expect(Date.parse(retryAt(1, now, 60_000, 0.5)) - now).toBe(60_000);
  for (const bad of [-1, NaN, Infinity, 0.1, 2_147_483_648]) expect(() => retryAt(1, now, bad)).toThrow();
  for (const bad of [0, 6, 1.2, NaN]) expect(() => retryAt(bad, now)).toThrow();
});

test("only explicit typed safe runtime assertions are eligible", () => {
  expect(retryDecision(outcome(), safe)).toMatchObject({ retry: true, reason: "temporary-provider-failure" });
  expect(retryDecision(outcome("protocol", "resume"), safe)).toMatchObject({ retry: true, reason: "reusable-protocol-failure" });
  const { retry: _retry, ...notEligible } = outcome();
  expect(retryDecision(notEligible, safe).retry).toBe(false);
  expect(retryDecision({ ...outcome(), disposition: "broken" }, safe).retry).toBe(false);
  expect(retryDecision({ ...outcome(), retry: { ...outcome().retry, retryAfterMs: NaN } }, safe).retry).toBe(false);
  expect(retryDecision(outcome("protocol", "resume"), { ...safe, resumePoint: "" }).retry).toBe(false);
  expect(retryDecision(outcome(), { ...safe, outstanding: true })).toEqual({ retry: false, reason: "ambiguous-tool-effect" });
});

test("sign-in, usage limits, account rejection and refusal remain terminal even with misleading eligibility", () => {
  for (const failure of [
    { _tag: "SignInRequired", account: "claude" },
    { _tag: "UsageLimitReached", account: "claude" },
    { _tag: "AccountRejected", account: "claude" },
    { _tag: "TurnFailed", account: "claude", reason: "refused" },
  ]) expect(retryDecision({ ...outcome(), failure }, safe).retry).toBe(false);
});

test("completed tool results replay from durable call/input/result ledger, never repeat-request", () => {
  const messages: Message[] = [call, result];
  const ledger = toolLedger(JSON.parse(JSON.stringify(messages)) as Message[]);
  expect(ledger.ambiguous).toBe(false);
  expect(replayTool(ledger, "write", "bash", { command: "increment-counter" })).toEqual({ text: "counter=1" });
  expect(() => replayTool(ledger, "write", "bash", { command: "another-effect" })).toThrow();
  expect(retryDecision(outcome(), { ...safe, ledger }).retry).toBe(false);
  expect(retryDecision(outcome("transient-provider", "resume"), { ...safe, ledger }).retry).toBe(true);
});

test("missing, conflicting or unbound tool results fail closed", () => {
  for (const messages of [[call], [result], [call, result, { ...result, content: [{ type: "text" as const, text: "counter=2" }] }]]) {
    const ledger = toolLedger(messages);
    expect(ledger.ambiguous).toBe(true);
    expect(retryDecision(outcome("protocol", "resume"), { ...safe, ledger })).toEqual({ retry: false, reason: "ambiguous-tool-effect" });
  }
});
