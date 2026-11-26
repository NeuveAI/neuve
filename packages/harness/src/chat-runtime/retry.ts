import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { TurnOutcome, type ToolOutcome } from "@neuve/runtime";
import type { TurnRecoveryReason } from "@neuve/records-schema";
import { canonicalJson, sha256Hex } from "@neuve/records-core";
import { digest, resultText } from "./transcript.ts";

export const MAX_TURN_RETRIES = 5;
const MAX_DELAY = 2_147_483_647;
export const continueSavedTurn =
  "Continue the interrupted turn from the saved results. Do not repeat completed work.";

export function retryAt(
  attempt: number,
  now: number,
  retryAfterMs?: number,
  random = Math.random(),
): string {
  if (
    !Number.isInteger(attempt) ||
    attempt < 1 ||
    attempt > MAX_TURN_RETRIES ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isFinite(random) ||
    random < 0 ||
    random > 1 ||
    (retryAfterMs !== undefined &&
      (!Number.isInteger(retryAfterMs) ||
        retryAfterMs < 0 ||
        retryAfterMs > MAX_DELAY))
  )
    throw new RangeError("Invalid turn retry delay metadata");
  const base = 2_000 * 2 ** (attempt - 1);
  const delay = Math.max(
    Math.ceil(base * (1 + 0.25 * random)),
    retryAfterMs ?? 0,
  );
  return new Date(now + delay).toISOString();
}

export type DurableToolLedger = ReturnType<typeof toolLedger>;
/** Only generation input is durable: partial output or an in-memory delivered flag never proves a tool result. */
export function toolLedger(messages: readonly Message[]) {
  const calls = new Map<string, { name: string; input: string }>();
  const results = new Map<string, ToolResultMessage>();
  let ambiguous = false;
  for (const message of messages) {
    if (message.role === "assistant")
      for (const block of message.content) {
        if (block.type !== "toolCall") continue;
        const call = {
          name: block.name,
          input: canonicalJson(block.arguments),
        };
        const prior = calls.get(block.id);
        if (prior && (prior.name !== call.name || prior.input !== call.input))
          ambiguous = true;
        calls.set(block.id, call);
      }
    if (message.role === "toolResult") {
      const prior = results.get(message.toolCallId);
      if (prior && digest([prior]) !== digest([message])) ambiguous = true;
      results.set(message.toolCallId, message);
    }
  }
  for (const [id, call] of calls)
    if (results.get(id)?.toolName !== call.name) ambiguous = true;
  for (const id of results.keys()) if (!calls.has(id)) ambiguous = true;
  return {
    calls,
    results,
    ambiguous,
    digest: sha256Hex(
      canonicalJson(
        [...results].map(([id, result]) => [id, digest([result])]).sort(),
      ),
    ),
  };
}

export function replayTool(
  ledger: DurableToolLedger,
  callId: string,
  name: string,
  input: unknown,
): ToolOutcome | undefined {
  const call = ledger.calls.get(callId);
  if (!call) return undefined;
  if (
    ledger.ambiguous ||
    call.name !== name ||
    call.input !== canonicalJson(input)
  )
    throw new Error("Recorded tool identity does not match continuation");
  const result = ledger.results.get(callId);
  if (!result) throw new Error("Recorded tool has an ambiguous side effect");
  const text = resultText(result);
  return { text, ...(result.isError ? { error: text } : {}) };
}

export type RetryDecision =
  | { retry: false; reason: TurnRecoveryReason }
  | {
      retry: true;
      reason: "temporary-provider-failure" | "reusable-protocol-failure";
      continuation: "resume" | "repeat-request";
      retryAfterMs?: number;
    };

export function retryDecision(
  outcome: unknown,
  safety: {
    ledger: DurableToolLedger;
    outstanding: boolean;
    resumePoint?: string;
    canResume: boolean;
  },
): RetryDecision {
  const parsed = TurnOutcome.safeParse(outcome);
  if (!parsed.success || parsed.data.status !== "failed")
    return { retry: false, reason: "terminal-runtime-failure" };
  const { retry, failure } = parsed.data;
  if (
    failure._tag === "TurnFailed" &&
    failure.reason === "ambiguous-tool-effect"
  )
    return { retry: false, reason: "ambiguous-tool-effect" };
  if (!retry) return { retry: false, reason: "terminal-runtime-failure" };
  if (safety.outstanding || safety.ledger.ambiguous)
    return { retry: false, reason: "ambiguous-tool-effect" };
  if (retry.continuation === "repeat-request" && safety.ledger.calls.size > 0)
    return { retry: false, reason: "unsafe-continuation" };
  if (
    retry.continuation === "resume" &&
    (!safety.canResume || !safety.resumePoint)
  )
    return { retry: false, reason: "unsafe-continuation" };
  return {
    retry: true,
    reason:
      retry.kind === "protocol"
        ? "reusable-protocol-failure"
        : "temporary-provider-failure",
    continuation: retry.continuation,
    ...(retry.retryAfterMs === undefined
      ? {}
      : { retryAfterMs: retry.retryAfterMs }),
  };
}
