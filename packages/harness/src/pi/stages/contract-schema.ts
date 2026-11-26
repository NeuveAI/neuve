import {
  AccountName,
  AccountKind,
  ContinuationIdentity,
  RuntimeEvent,
  TurnOutcome,
} from "@neuve/runtime";
import { z } from "zod";
import { addUsage, zeroUsage } from "../../route.ts";

import { HeadRead, FindSubmission } from "../../find-schema.ts";
import { HandleRegistryState } from "../../handle-schema.ts";
import {
  RecordedReviewClaim,
  ReviewEvidence,
} from "../../readings/reviewer-claims.ts";

/**
 * What an agent context's tools hold between calls: its handles, recorded findings, reading budget
 * and head reads. Validated when read back, so a stored value that no longer parses
 * fails the call instead of answering from a wrong registry.
 */
export const ToolState = z.strictObject({
  handles: HandleRegistryState.optional(),
  reading: z.strictObject({ used: z.int().min(0) }).optional(),
  findings: FindSubmission.optional(),
  headReads: z.array(HeadRead).optional(),
  reviewEvidence: z.array(ReviewEvidence).optional(),
  reviewClaims: z.array(RecordedReviewClaim).optional(),
});
export type ToolState = z.infer<typeof ToolState>;

/** The agent kinds of the review, one tool extension each (tools.ts). */
export const AGENT_KINDS = [
  "scope-change",
  "frame",
  "map",
  "find",
  "verify",
  // The section readings (NEU-148), and the check of a Lane review's defect claim: its own kind,
  // since a kind's tool declarations are frozen by its first step and a claim's check has no tools.
  "assess",
  "lane-review",
  "verify-claim",
  // The briefing (NEU-148 round 27): a part of a reading group's sections, or a batch's digest.
  "brief",
] as const;
export const AgentKind = z.enum(AGENT_KINDS);
export type AgentKind = z.infer<typeof AgentKind>;

const Outcome = z.object({
  text: z.string(),
  error: z.string().optional(),
  paged: z.boolean().optional(),
  empty: z.boolean().optional(),
  endTurn: z.literal(true).optional(),
});
export const ContractState = z.object({
  contextKey: z.string(),
  agent: z.string(),
  stage: z.enum(["frame", "map", "find", "verify"]),
  kind: AgentKind,
  account: AccountName,
  accountKind: AccountKind.optional(),
  continuation: ContinuationIdentity,
  startedAt: z.number(),
  system: z.string(),
  outputSchema: z.record(z.string(), z.json()),
  declarations: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      parameters: z.record(z.string(), z.json()),
      strict: z.boolean(),
      replay: z.enum(["safe", "unsafe"]),
    }),
  ),
  model: z.object({
    id: z.string(),
    effort: z.enum(["low", "medium", "high"]),
  }),
  native: z
    .object({ sessionId: z.string(), resumePoint: z.string().nullable() })
    .nullable(),
  continuations: z.int().nonnegative().default(0),
  refusals: z.int().nonnegative().default(0),
  endedBy: z
    .enum([
      "submit",
      "turn-limit",
      "ceiling",
      "continuations",
      "overflow",
      "timeout",
    ])
    .default("turn-limit"),
  final: z.boolean().default(false),
  ending: z
    .object({
      status: z.enum([
        "submitted",
        "backstop",
        "final-generation",
        "interrupted",
      ]),
      endedBy: z.enum([
        "submit",
        "turn-limit",
        "ceiling",
        "continuations",
        "overflow",
        "timeout",
      ]),
      output: z.json().optional(),
      repairedFrom: z.json().optional(),
      finalGeneration: z.boolean(),
    })
    .nullable()
    .default(null),
  rounds: z.array(
    z.object({
      id: z.string(),
      prompt: z.string(),
      final: z.boolean(),
      attempt: z.int().positive().default(1),
      dispatched: z.boolean().default(false),
      recovery: z.string().nullable().default(null),
      state: z.enum(["prepared", "active", "settled"]),
      outcome: TurnOutcome.nullable(),
      /** Announced identities alone never authorize a tool or a submission. */
      announced: z
        .record(
          z.string(),
          z.object({
            toolName: z.string(),
            status: z.enum(["announced", "cancelled"]),
          }),
        )
        .default({}),
      carrier: z.boolean().default(false),
      fork: z.boolean().default(false),
    }),
  ),
  events: z.array(RuntimeEvent),
  /** Previous physical attempts survive a hold or interruption resetting the round. */
  settlements: z.record(z.string(), TurnOutcome).default({}),
  calls: z.record(
    z.string(),
    z.discriminatedUnion("status", [
      z.object({ status: z.literal("observed"), eligible: z.literal(false) }),
      z.object({ status: z.literal("cancelled"), eligible: z.literal(false) }),
      z.object({ status: z.literal("started"), eligible: z.boolean() }),
      z.object({
        status: z.literal("completed"),
        eligible: z.boolean(),
        outcome: Outcome,
      }),
    ]),
  ),
  toolState: ToolState.nullable(),
  reminder: z.boolean(),
  endedMessages: z.array(z.string()),
});
export type ContractState = z.infer<typeof ContractState>;

/** Only usage events charge the context. A turn's snapshots replace earlier snapshots per model. */
export function contractUsage(state: Pick<ContractState, "events">) {
  const turns = new Map<
    string,
    { scope: "request" | "turn"; models: Map<string, typeof zeroUsage> }
  >();
  for (const event of state.events) {
    if (event.type !== "usage") continue;
    let turn = turns.get(event.turnId);
    if (turn === undefined) {
      turn = { scope: event.scope, models: new Map() };
      turns.set(event.turnId, turn);
    }
    if (turn.scope !== event.scope)
      throw new Error("TurnFailed: mixed usage scopes");
    const model = event.model ?? "";
    turn.models.set(
      model,
      event.scope === "turn"
        ? event.usage
        : addUsage(turn.models.get(model) ?? zeroUsage, event.usage),
    );
  }
  let usage = zeroUsage;
  for (const turn of turns.values())
    for (const value of turn.models.values()) usage = addUsage(usage, value);
  return usage;
}

export const physicalTurnId = (round: ContractState["rounds"][number]) =>
  round.attempt === 1 ? round.id : `${round.id}:attempt:${round.attempt}`;
