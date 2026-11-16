import { z } from "zod";
import { ActorId, GitOid, Ulid } from "./envelope.ts";
import {
  CommitLink,
  DeliveryContent,
  FeedbackTarget,
  FindingAbout,
  FindingKind,
  FindingSignal,
  Lane,
  MarkerKind,
  Quadrant,
  Stance,
  UnitGrouping,
  Verdict,
} from "./events.ts";
import { EndedBy, StageStatus } from "./telemetry.ts";

/**
 * Read models of the projection tables. Each row is current state for one entity, keyed by that
 * entity; nothing here is a copy of state per change. Text that lives in an event (comment bodies,
 * summaries) is read from the event by `eventId`, not copied.
 */
const nullable = <T extends z.ZodType>(schema: T) => schema.nullable();

export const ReviewOriginView = z.strictObject({
  eventId: Ulid,
  identity: z.string().regex(/^[a-f0-9]{64}$/),
  cycleId: Ulid,
  host: z.string(),
  channel: nullable(z.string()),
  chat: nullable(z.int()),
  lane: nullable(z.string()),
  originJson: z.string(),
  baseOid: GitOid,
  headOid: GitOid,
  occurredAt: z.iso.datetime(),
});

/**
 * One actor. `alias` is three words from the fingerprint, or more when an earlier registration holds
 * the same three (D22); `registeredEventId` is the earliest registration, which decides who was first.
 */
export const ActorView = z.strictObject({
  actorId: ActorId,
  actorKind: z.enum(["agent", "human"]),
  harness: z.string(),
  sessionId: nullable(z.string()),
  subagentId: nullable(z.string()),
  parentActor: nullable(ActorId),
  agentType: nullable(z.string()),
  displayName: nullable(z.string()),
  email: nullable(z.string()),
  aliasBase: z.string(),
  alias: z.string(),
  registeredEventId: Ulid,
  labelEventId: nullable(Ulid),
  eventId: Ulid,
});

/**
 * Activity counted per actor; `model` is the one reported by the actor's latest turn, session start or
 * turn summary. Token totals add up the actor's `turn.summarized` events; `summaries` counts them.
 * `commitsDeclared` counts the commits among `commits` linked only by a declared session ID (8.13).
 */
export const ActorActivityView = z.strictObject({
  actorId: ActorId,
  sessionsStarted: z.int().min(0),
  sessionsEnded: z.int().min(0),
  turns: z.int().min(0),
  commits: z.int().min(0),
  commitsDeclared: z.int().min(0),
  model: nullable(z.string()),
  modelEventId: nullable(Ulid),
  summaries: z.int().min(0),
  tokensInput: z.int().min(0),
  tokensCacheCreation: z.int().min(0),
  tokensCacheRead: z.int().min(0),
  tokensOutput: z.int().min(0),
  apiCalls: z.int().min(0),
  toolCalls: z.int().min(0),
});

export const CycleView = z.strictObject({
  cycleId: Ulid,
  baseRef: z.string(),
  baseOid: GitOid,
  headOid: GitOid,
  eventId: Ulid,
});

export const BatchView = z.strictObject({
  batchId: Ulid,
  cycleId: Ulid,
  title: z.string(),
  eventId: Ulid,
});

const count = z.int().min(0);
/** SQLite has no boolean: 0 or 1. */
const flag = z.union([z.literal(0), z.literal(1)]);

/**
 * Columns stay null until the event that sets them is projected, so arrival order never loses data.
 * Grouping comes from `unit.recorded@2` (10.70); quadrant, complexity and whether a gap touched
 * ease of validation from `assessment.recorded@2` (10.55). Version 1 events leave them null.
 */
export const UnitView = z.strictObject({
  unitId: Ulid,
  cycleId: nullable(Ulid),
  batchId: nullable(Ulid),
  title: nullable(z.string()),
  ownedRangeCount: z.int().min(0),
  recordedEventId: nullable(Ulid),
  lane: nullable(Lane),
  assessmentEventId: nullable(Ulid),
  contextReferenceCount: z.int().min(0),
  commentCount: z.int().min(0),
  groupingGapLines: nullable(UnitGrouping.shape.gapLines),
  groupingAdjustment: nullable(z.enum(["merge", "split"])),
  quadrant: nullable(Quadrant),
  complexity: nullable(z.enum(["low", "high"])),
  validationGap: nullable(flag),
});

/**
 * Every disposition. The current one for an actor on a unit in a cycle is the newest by ULID that no
 * event supersedes, so it does not depend on the order events were appended in. `restsOnCount` is
 * how many comments a request for changes names and `proofCount` how many proof records it names
 * (10.62, 10.69); both are null for version 1, which can name neither.
 */
export const DispositionView = z.strictObject({
  eventId: Ulid,
  unitId: Ulid,
  cycleId: Ulid,
  actorId: ActorId,
  verdict: Verdict,
  reviewedHeadOid: GitOid,
  restsOnCount: nullable(count),
  proofCount: nullable(count),
});

/** An event superseded by a later correction or retraction, which may arrive before its target. */
export const SupersessionView = z.strictObject({
  targetId: Ulid,
  byEventId: Ulid,
});

export const CommentView = z.strictObject({
  eventId: Ulid,
  cycleId: Ulid,
  actorId: ActorId,
  anchorPath: nullable(z.string()),
  unitCount: z.int().min(1),
  findingKind: nullable(FindingKind),
  findingAbout: nullable(FindingAbout),
  findingSignal: nullable(FindingSignal),
});

export const ContextReferenceView = z.strictObject({
  eventId: Ulid,
  cycleId: Ulid,
  markerKind: MarkerKind,
  sourceKind: z.string(),
  unitCount: z.int().min(1),
  stance: nullable(Stance),
  origin: nullable(z.enum(["committed", "same-batch"])),
});

/** One commit and how its actor was found (`link`, and for a declared link its `linkSource`). */
export const CommitView = z.strictObject({
  oid: GitOid,
  tree: GitOid,
  actorId: ActorId,
  sessionId: nullable(z.string()),
  link: CommitLink,
  linkSource: nullable(z.string()),
  eventId: Ulid,
});

export const CommitRewriteView = z.strictObject({
  fromOid: GitOid,
  toOid: GitOid,
  eventId: Ulid,
});

/** One digest or delivery stop; its text is the event's referenced computation. */
export const DeliveryView = z.strictObject({
  eventId: Ulid,
  cycleId: Ulid,
  batchId: Ulid,
  unitId: nullable(Ulid),
  content: DeliveryContent,
  verdictWords: nullable(count),
});

/** One published packet; its manifest is the event's reference (8.7). */
export const PacketView = z.strictObject({
  eventId: Ulid,
  cycleId: Ulid,
  runId: z.string(),
  complete: flag,
  units: count,
  gaps: count,
});

/** One disclosed gap, by kind, with the run and stage that disclosed it. */
export const GapView = z.strictObject({
  eventId: Ulid,
  runId: z.string(),
  cycleId: Ulid,
  stage: nullable(z.string()),
  kind: z.string(),
  unitCount: count,
});

/** One stage's telemetry (10.32). Cost in micro-USD; cache writes are the 5-minute and 1-hour sum. */
export const StageView = z.strictObject({
  eventId: Ulid,
  runId: z.string(),
  cycleId: Ulid,
  stage: z.string(),
  agent: z.string(),
  batchId: nullable(Ulid),
  status: StageStatus,
  wallMs: count,
  expectedMs: nullable(count),
  modelCalls: count,
  tokensInput: count,
  tokensCacheWrite: count,
  tokensCacheRead: count,
  tokensOutput: count,
  /** Null when the run's route has no per-token price (the ChatGPT plan, 10.85). */
  costMicroUsd: nullable(count),
  turnsUsed: nullable(count),
  turnLimit: nullable(count),
  finalGeneration: nullable(flag),
  endedBy: nullable(EndedBy),
});

/**
 * One run, from its earliest receipt by ULID. Unit counts at 10, 20 and 40 lines are null until the
 * receipt carries them (10.70). Its stages and gaps are counted from their own projections.
 */
export const RunView = z.strictObject({
  runId: z.string(),
  cycleId: Ulid,
  eventId: Ulid,
  outcome: z.enum(["completed", "timed-out"]),
  endedAt: z.iso.datetime(),
  wallMs: count,
  queueWaitMs: z.int(),
  modelCalls: count,
  retries: count,
  /** Null when the run's route has no per-token price (the ChatGPT plan, 10.85). */
  costMicroUsd: nullable(count),
  tokensInput: count,
  tokensOutput: count,
  unitCount10: nullable(count),
  unitCount20: nullable(count),
  unitCount40: nullable(count),
});

/**
 * One feedback answer (FB1). The answer's scales and note stay in the event, read by `eventId`.
 * A person's current answer on a target is the newest of theirs that no answer of theirs
 * supersedes; `supersedesEventId` is null for a first answer.
 */
export const FeedbackView = z.strictObject({
  eventId: Ulid,
  cycleId: Ulid,
  actorId: ActorId,
  targetKind: FeedbackTarget,
  targetEventId: Ulid,
  harnessCallVisible: flag,
  supersedesEventId: nullable(Ulid),
});

export type ActorView = z.infer<typeof ActorView>;
export type ActorActivityView = z.infer<typeof ActorActivityView>;
export type UnitView = z.infer<typeof UnitView>;
export type DispositionView = z.infer<typeof DispositionView>;
export type FeedbackView = z.infer<typeof FeedbackView>;
