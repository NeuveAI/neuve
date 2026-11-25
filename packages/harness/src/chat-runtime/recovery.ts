import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ContentBlock } from "@neuve/runtime";
import type { TurnRecoveryCheckpoint, TurnRecoveryReason, TurnRetryStatus } from "@neuve/records-schema";
import type { TurnRecovery } from "@neuve/records-core";

export class RecoveryOwnershipUnknown extends Error {}

export type RecoveryResult = { state: TurnRecovery.RecoveryState; message?: AssistantMessage };

/** Records owns scheduling; the bridge never sleeps or redraws a persisted retry time. */
export interface TurnRecoveryDriver {
  execute(state: TurnRecovery.RecoveryState, signal: AbortSignal,
    run: (signal: AbortSignal, schedule: TurnRecovery.RecoveryState) => Promise<RecoveryResult>): Promise<RecoveryResult>;
  saveRequest(request: string | readonly ContentBlock[]): Promise<string>;
  loadRequest(checkpoint: string): Promise<string | readonly ContentBlock[]>;
  subscribe(listener: (chat: string, status: TurnRetryStatus) => Promise<void>): Promise<() => void>;
  latest(chat: string): Promise<TurnRecovery.RecoveryState | undefined>;
  find(chat: string, generation: string): Promise<TurnRecovery.RecoveryState | undefined>;
  begin(input: { turn: string; chat: string; checkpoint: TurnRecoveryCheckpoint }): Promise<TurnRecovery.RecoveryState>;
  schedule(input: { turn: string; expected: string; nextAt: string;
    reason: "temporary-provider-failure" | "reusable-protocol-failure";
    checkpoint: TurnRecoveryCheckpoint }): Promise<TurnRecovery.RecoveryState>;
  wait(state: TurnRecovery.RecoveryState, signal: AbortSignal): Promise<TurnRecovery.RecoveryState>;
  settle(input: { turn: string; expected: string; state: "recovered" | "terminal" | "cancelled";
    reason?: TurnRecoveryReason }): Promise<TurnRecovery.RecoveryState>;
  cancel(turn: string): Promise<unknown>;
}
