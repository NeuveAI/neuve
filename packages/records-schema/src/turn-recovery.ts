import { z } from "zod";
import { Instant } from "./envelope.ts";

const identity = z.string().min(1).max(512);
/** No provider text, tool input, credentials or prompt bodies cross the recovery status boundary. */
export const TurnRecoveryReason = z.enum([
  "temporary-provider-failure",
  "reusable-protocol-failure",
  "unsafe-continuation",
  "ambiguous-tool-effect",
  "retry-budget-exhausted",
  "terminal-runtime-failure",
  "cancelled",
]);

/** The transcript/result digest binds provider history to the durable generation being resumed. */
export const TurnRecoveryCheckpoint = z.strictObject({
  id: identity,
  generation: identity,
  account: identity,
  session: identity,
  resumePoint: identity.optional(),
  continuation: identity,
  transcriptDigest: z.string().regex(/^[a-f0-9]{64}$/),
  resultsDigest: z.string().regex(/^[a-f0-9]{64}$/),
  continuationMode: z.enum(["resume", "repeat-request"]),
});
export const TurnRecoveryPayload = z
  .strictObject({
    turn: identity,
    chat: identity,
    state: z.enum([
      "running",
      "scheduled",
      "started",
      "recovered",
      "terminal",
      "cancelled",
    ]),
    /** Retries after the original attempt, not queue deliveries or provider-internal retries. */
    attempt: z.int().min(0).max(5),
    reason: TurnRecoveryReason.optional(),
    checkpoint: TurnRecoveryCheckpoint,
    nextAt: Instant.optional(),
    job: z.int().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.state === "scheduled" &&
      (!value.nextAt || value.attempt === 0 || !value.reason)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Scheduled recovery needs a next time, reason and retry attempt.",
      });
    if (
      (value.state === "scheduled" || value.state === "started") &&
      value.checkpoint.continuationMode === "resume" &&
      !value.checkpoint.resumePoint
    )
      ctx.addIssue({
        code: "custom",
        message: "Resuming recovery requires an exact saved-history point.",
      });
    if (value.state !== "scheduled" && value.nextAt !== undefined)
      ctx.addIssue({
        code: "custom",
        message: "Only scheduled recovery carries a next time.",
      });
    if (
      value.state === "started" &&
      (value.job === undefined || value.attempt === 0)
    )
      ctx.addIssue({
        code: "custom",
        message: "Started recovery needs its queue job and retry attempt.",
      });
    if (
      (value.state === "terminal" || value.state === "cancelled") &&
      value.reason === undefined
    )
      ctx.addIssue({
        code: "custom",
        message: "Ended recovery needs a safe reason.",
      });
  });
export type TurnRecoveryPayload = z.infer<typeof TurnRecoveryPayload>;
export type TurnRecoveryCheckpoint = z.infer<typeof TurnRecoveryCheckpoint>;
export type TurnRecoveryReason = z.infer<typeof TurnRecoveryReason>;

export const TurnRetryFailure = z.strictObject({
  turn: identity,
  attempt: z.int().min(0).max(5),
  reason: TurnRecoveryReason.extract([
    "retry-budget-exhausted",
    "ambiguous-tool-effect",
    "unsafe-continuation",
    "terminal-runtime-failure",
  ]),
});
export const TURN_RETRY_FAILURE = "neuve.turn_retry_failure";
export const TURN_CANCELLED = "neuve.turn_cancelled";

/** Rebuildable conversation projection. Records remains the scheduling and history authority. */
export const TurnRetryStatusSchema = z.strictObject({
  turn: identity,
  state: z.enum([
    "running",
    "scheduled",
    "started",
    "recovered",
    "terminal",
    "cancelled",
  ]),
  attempt: z.int().min(0).max(5),
  reason: TurnRecoveryReason.optional(),
  nextAt: Instant.optional(),
});
export type TurnRetryStatus = Omit<
  z.infer<typeof TurnRetryStatusSchema>,
  "reason" | "nextAt"
> & {
  reason?: TurnRecoveryReason;
  nextAt?: string;
};
export type TurnRetryStatusState = {
  revision: number;
  current?: TurnRetryStatus;
};
export const TurnRetryStatusDefinition = {
  kind: "neuve.turn-retry-status",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: (): TurnRetryStatusState => ({ revision: 0 }),
} as const;
