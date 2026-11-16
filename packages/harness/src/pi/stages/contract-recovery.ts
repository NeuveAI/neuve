import { Data } from "effect";
import type { SessionStart } from "@neuve/runtime";
import { physicalTurnId, type ContractState } from "./contract-schema.ts";

export { physicalTurnId } from "./contract-schema.ts";

export class ContractRecoveryFailed extends Data.TaggedError(
  "ContractRecoveryFailed",
)<{
  readonly reason: "continuation-mismatch" | "no-safe-point";
}> {
  readonly retryable = false;
  override get message() {
    return this.reason === "continuation-mismatch"
      ? "The account's continuation identity changed; partial work is retained."
      : "The dispatched turn has no committed safe point; partial work is retained.";
  }
}

/** Only the message at the saved point can have undelivered results. */
export function recoveryText(state: ContractState) {
  const point = state.native?.resumePoint;
  if (point == null) return "";
  const last = state.events.findLast(
    (event) => event.type === "message.finished",
  );
  if (last?.type !== "message.finished" || last.resumePoint !== point)
    return "";
  if (
    state.events.some(
      (event) => event.type === "turn.finished" && event.resumePoint === point,
    )
  )
    return "";
  const messages: string[] = [];
  for (const call of last.toolCalls) {
    const entry = state.calls[call.callId];
    if (entry?.status === "completed")
      messages.push(
        `Call ${call.callId} of ${call.toolName} already ran. Do not call it again. Its result was: ${entry.outcome.text}`,
      );
    else if (entry?.status === "started")
      messages.push(
        `Call ${call.callId} of ${call.toolName} started, but its outcome is unknown. Do not call it again.`,
      );
  }
  return messages.join("\n\n");
}

/** Only the persisted call marker authorizes an effect; recovery never invokes one. */
export function retryContractRound(state: ContractState) {
  const round = state.rounds.at(-1);
  if (round === undefined || round.state === "prepared") return;
  if (round.dispatched)
    state.settlements[physicalTurnId(round)] ??= round.outcome ?? {
      status: "interrupted",
    };
  const text = recoveryText(state);
  for (const [id, call] of Object.entries(state.calls))
    if (call.status === "observed")
      state.calls[id] = { status: "cancelled", eligible: false };
    else if (call.status === "started")
      state.calls[id] = { ...call, eligible: false };
  round.fork = !round.carrier;
  round.state = "prepared";
  round.outcome = null;
  round.carrier = false;
  round.recovery = text;
}

export function contractSessionStart(state: ContractState): SessionStart {
  const last = state.rounds.at(-1);
  if (state.native?.resumePoint != null)
    return {
      kind: "resume",
      session: state.native.sessionId,
      at: state.native.resumePoint,
      fork: last?.fork === true || last?.state === "active",
    };
  if (Object.keys(state.calls).length > 0)
    throw new ContractRecoveryFailed({ reason: "no-safe-point" });
  return { kind: "new" };
}
