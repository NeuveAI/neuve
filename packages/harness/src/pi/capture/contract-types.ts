import { z } from "zod";
import { CallUsage, TurnOutcome } from "@neuve/runtime";
import { ContractState } from "../stages/contract-schema.ts";

/** A declaration of durable observations, with no provider wire or replay claim. */
export const ContractContextCapture = z.strictObject({
  /** Inspection retains versions; scoring decides which it supports. Older declarations are v1. */
  captureVersion: z.int().positive().default(1),
  taskId: z.int().nonnegative(),
  coverage: z.literal("no-wire-capture"),
  state: ContractState,
  settlements: z.record(z.string(), TurnOutcome),
  callDispositions: z.record(
    z.string(),
    z.enum(["completed", "cancelled", "unknown", "pending"]),
  ),
  usage: CallUsage,
  costUsd: z.null(),
});
export type ContractContextCapture = z.infer<typeof ContractContextCapture>;
