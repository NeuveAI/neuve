/**
 * The stage loop (re-prompts, submit tools, final generation and refusals) runs above
 * this contract. A runtime runs one turn per startTurn and owns its agent loop,
 * retries, compaction, resume, capture and credentials.
 * Shared tools, telemetry, logs, receipts, budgets and stage policy read only these events.
 * For an ownsLoop runtime, Neuve's stage loop drives one turn per round;
 * the runtime's own model loop runs within that turn and calls Neuve's tool handlers.
 * A subscription account is unpriced: costUsd is null, never priced at API rates.
 */
import type { Effect, Scope, Stream } from "effect";
import { z } from "zod";
import { AbsoluteFolder, RuntimeKind, type Account } from "./account.ts";
import {
  RuntimeCapability,
  RuntimeFailure,
  type RuntimeError,
} from "./errors.ts";
import { LimitWindow, type AccountProbe, type EffortLevel } from "./status.ts";

/**
 * Every capability is required. internalRetries is true for runtime retries outside
 * Neuve's retry and admission rules, so shared code maps only the final failure.
 */
export const RuntimeCapabilities = z.record(RuntimeCapability, z.boolean());
export type RuntimeCapabilities = z.infer<typeof RuntimeCapabilities>;
export const JsonSchema = z.record(z.string(), z.json());
export type JsonSchema = z.infer<typeof JsonSchema>;
export const TurnLimit = z.number().int().positive().brand<"TurnLimit">();
export type TurnLimit = z.infer<typeof TurnLimit>;

export const ContentBlock = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: z.string() }),
  z.strictObject({
    type: z.literal("image"),
    mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
    data: z.base64(),
  }),
]);
export type ContentBlock = z.infer<typeof ContentBlock>;

/** Equal identities let accounts continue each other's native sessions; different identities require a new session. */
export const ContinuationIdentity = z.strictObject({
  runtime: RuntimeKind,
  /** Never contains a credential. For Claude, derived from the config folder's identity, not its contents. */
  key: z.string().min(1),
});
export type ContinuationIdentity = z.infer<typeof ContinuationIdentity>;
/**
 * Resume only a session opened on an account with the same continuation identity.
 * The runtime may refuse any other with TurnFailed, reason protocol-error.
 */
export type SessionStart =
  | { readonly kind: "new" }
  | {
      readonly kind: "resume";
      /** The runtime's native session id. */
      readonly session: string;
      /** An opaque resumePoint from the same runtime's message.finished or turn.finished event. */
      readonly at?: string | undefined;
      readonly fork: boolean;
    };

/** The four MCP behaviour hints, always set. */
export interface ToolHints {
  readonly readOnly: boolean;
  readonly destructive: boolean;
  readonly idempotent: boolean;
  readonly openWorld: boolean;
}
/** What a tool handler returns: text for the agent, plus what telemetry records about it. */
export interface ToolOutcome {
  readonly text: string;
  readonly paged?: boolean | undefined;
  readonly empty?: boolean | undefined;
  readonly error?: string | undefined;
  /**
   * Ends a stage round from a tool: submission accepted, chances used up, turn limit
   * or context ceiling. The runtime records the result, sends no further model request
   * in this turn and finishes it completed. Only a runtime that declares toolEndsTurn
   * honours this; review stages require it.
   */
  readonly endTurn?: true | undefined;
}
export interface ToolCall {
  /** Native tool-use id, also carried by tool.started and tool.finished. */
  readonly callId: string;
  /** Aborts when the call is cancelled or the session closes. */
  readonly signal: AbortSignal;
}
/** Handler-side shape the harness toolkit uses, including its parsed input schema. */
export interface ToolSpec<I = unknown> {
  readonly name: string;
  readonly description: string;
  /** Absent for a tool that takes no input. */
  readonly input?: z.ZodType<I> | undefined;
  readonly hints: ToolHints;
  /**
   * Whether the provider enforces the input schema (strict tool use). Only submit tools are strict:
   * the provider caps how many optional and union-typed parameters strict tools may hold together
   * ("Schema is too complex"), and every other tool's input is parsed with zod anyway, an invalid
   * input answered as data the agent can correct.
   */
  readonly strict?: boolean | undefined;
  /** A runtime always passes call; optional for existing harness tools and callers. */
  readonly handle: (input: I, call?: ToolCall) => Effect.Effect<ToolOutcome>;
}
/** handle receives raw input; the definition's builder parses it with input, as the harness does. */
export interface ToolDefinition extends ToolSpec {
  readonly inputSchema: JsonSchema;
}
export interface SessionPolicy {
  readonly systemPrompt: string;
  readonly tools: ReadonlyArray<ToolDefinition>;
  /**
   * For ownsLoop, a backstop for one turn. Neuve's stage counts rounds itself;
   * do not map this to the runtime's own per-query turn count.
   */
  readonly turnLimit: TurnLimit;
  /** Declared at open; only a completed startTurn({ final: true }) carries structuredOutput. */
  readonly outputSchema?: JsonSchema | undefined;
  readonly approvalPolicy: "allow" | "ask";
  /**
   * The folder the session's work is in: a chat's own worktree. A runtime that declares ownTools
   * starts there and refuses a session without it; pi and Claude Code ignore it, as they do a
   * turn's workspace.
   */
  readonly folder?: string | undefined;
  /**
   * Absent selects the runtime's default for the account. An absent effort sends none. A runtime
   * refuses an effort its model doesn't support with TurnFailed, reason protocol-error: effort support is per model,
   * so a caller offers only the levels in that model's supportedEffortLevels.
   */
  readonly model?:
    | { readonly id: string; readonly effort?: EffortLevel | undefined }
    | undefined;
}

/**
 * Where a turn's work is and what may be done there, set by the caller from the chat's mode. A
 * runtime that declares ownTools turns it into its own sandbox and approvals, and refuses a turn
 * without it. pi and Claude Code ignore it: their tools are Neuve's, which check the mode themselves.
 */
export const TurnWorkspace = z.strictObject({
  folder: AbsoluteFolder,
  access: z.enum(["read-only", "write"]),
});
export type TurnWorkspace = z.infer<typeof TurnWorkspace>;
/** What a runtime with tools of its own did by itself. Neuve's own tools are never one of these. */
export const WorkKind = z.enum([
  "command",
  "file-change",
  "web-search",
  "tool",
]);
export type WorkKind = z.infer<typeof WorkKind>;

const approvalReason = { reason: z.exactOptional(z.string()) };
const approvalChange = { path: z.string(), diff: z.string() };
const approvalTarget = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("path"), path: z.string() }),
  z.strictObject({ kind: z.literal("glob"), pattern: z.string() }),
  z.strictObject({ kind: z.enum(["root", "minimal", "tmpdir", "slash-tmp"]) }),
  z.strictObject({
    kind: z.literal("project-roots"),
    subpath: z.exactOptional(z.string()),
  }),
]);

/** What a person is being asked to allow, in terms the chat can show. */
export const ApprovalAsked = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("command"),
    command: z.string(),
    folder: z.string(),
    network: z.exactOptional(
      z.strictObject({
        host: z.string(),
        protocol: z.enum(["http", "https", "socks5-tcp", "socks5-udp"]),
      }),
    ),
    ...approvalReason,
  }),
  z.strictObject({
    kind: z.literal("file-change"),
    changes: z
      .array(
        z.discriminatedUnion("kind", [
          z.strictObject({
            ...approvalChange,
            kind: z.enum(["add", "delete"]),
          }),
          z.strictObject({
            ...approvalChange,
            kind: z.literal("update"),
            newPath: z.exactOptional(z.string()),
          }),
        ]),
      )
      .min(1)
      .nullable(),
    ...approvalReason,
  }),
  z.strictObject({
    kind: z.literal("wider-access"),
    paths: z.array(
      z.strictObject({
        target: approvalTarget,
        access: z.enum(["read", "write", "deny"]),
      }),
    ),
    network: z.boolean().nullable(),
    folder: z.exactOptional(z.string()),
    globDepthLimit: z.exactOptional(z.int().nonnegative()),
    ...approvalReason,
  }),
  z.strictObject({
    kind: z.literal("server-prompt"),
    server: z.string(),
    message: z.string(),
    url: z.exactOptional(z.string()),
    ...approvalReason,
  }),
  z.strictObject({ kind: z.literal("unrecognised"), ...approvalReason }),
]);
export type ApprovalAsked = z.infer<typeof ApprovalAsked>;

export const CallUsage = z.strictObject({
  input: z.number().int().nonnegative(),
  cacheWrite5m: z.number().int().nonnegative(),
  cacheWrite1h: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  /** Included in output, when reported. */
  thinking: z.number().int().nonnegative().optional(),
});
export type CallUsage = z.infer<typeof CallUsage>;
export const InterruptReason = z.enum([
  "stop",
  "cutoff",
  "deadline",
  "shutdown",
]);
export type InterruptReason = z.infer<typeof InterruptReason>;
export const TurnOutcome = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("completed"),
    /** Required on a completed final turn; absent on every other turn. */
    structuredOutput: z.json().optional(),
  }),
  z.strictObject({
    status: z.literal("interrupted"),
    reason: InterruptReason.optional(),
  }),
  z.strictObject({
    status: z.literal("failed"),
    failure: RuntimeFailure,
    /** Reusable permits another turn, including final generation after a limit or overflow; broken requires closing. */
    disposition: z.enum(["reusable", "broken"]),
  }),
]);
export type TurnOutcome = z.infer<typeof TurnOutcome>;
const eventFields = {
  turnId: z.string().min(1),
  at: z.iso.datetime({ offset: true }),
};
/** toolName is always the ToolDefinition name, never a runtime wire name. */
export const RuntimeEvent = z.discriminatedUnion("type", [
  z.strictObject({ ...eventFields, type: z.literal("turn.started") }),
  /** Text is an append-only delta. */
  z.strictObject({ ...eventFields, type: z.literal("text"), text: z.string() }),
  /**
   * One event per unit of model output the runtime can prove complete, a whole model
   * response on Claude Code. It lists every tool call of that unit. The runtime emits it as soon as the unit is known
   * complete: at message stop, or at the first tool handler call of that message when
   * the runtime calls handlers only after a response ends. It never waits on later
   * frames. A frame of that unit arriving after the event ends the turn with TurnFailed
   * protocol-error, never a second or partial event. Turn usage totals also include
   * requests without message.finished: runtime retries, structured-output retries
   * and compaction.
   */
  z.strictObject({
    ...eventFields,
    type: z.literal("message.finished"),
    /** The runtime's native message id. */
    messageId: z.string().min(1),
    /**
     * The message's last assistant block, as an opaque resume.at for the same runtime; Claude Code
     * uses its chain UUID. A runtime that declares resumeInTurn sets it on every message: Claude
     * Code's own type requires it, and review stages refuse a message without it. A runtime that
     * resumes only between turns leaves it out.
     */
    resumePoint: z.string().min(1).optional(),
    stopReason: z.enum([
      "end-turn",
      "tool-use",
      "max-tokens",
      "refusal",
      "other",
    ]),
    toolCalls: z.array(
      z.strictObject({
        callId: z.string().min(1),
        toolName: z.string().min(1),
        /** The arguments the model wrote, before any validation. */
        input: z.json(),
      }),
    ),
    model: z.string().optional(),
    /**
     * Usage of this message's model request. Never sum with usage events; totals
     * come only from those events. A runtime that declares perMessageUsage always
     * fills this, so a stage can read each request's input tokens for its context ceiling.
     */
    usage: CallUsage.optional(),
  }),
  /** Emitted when the runtime receives the call from the model in its message, not only when the handler runs. */
  z.strictObject({
    ...eventFields,
    type: z.literal("tool.started"),
    callId: z.string().min(1),
    toolName: z.string().min(1),
    input: z.json(),
  }),
  z.strictObject({
    ...eventFields,
    type: z.literal("tool.finished"),
    callId: z.string().min(1),
    toolName: z.string().min(1),
    errored: z.boolean(),
    durationMs: z.number().nonnegative().optional(),
  }),
  z.strictObject({
    ...eventFields,
    type: z.literal("usage"),
    /**
     * Request requires perRequestTelemetry; otherwise emit turn only. Turn usage is a
     * running total per (turnId, model): keep the latest, never sum it. Never combine
     * request and turn usage for the same turn. Turn totals include requests without
     * message.finished: runtime retries, structured-output retries and compaction.
     */
    scope: z.enum(["request", "turn"]),
    model: z.string().optional(),
    /** The model's limits as the runtime reports them on turn usage; never inside CallUsage. */
    contextWindow: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    usage: CallUsage,
    /**
     * Neuve prices usage from the route's frozen price table, per
     * [decision 10.32](../../../process/decisions.md#area-10-harness-m3-18-october-2026).
     * The runtime fills this from the route price it is given, or null when it has none.
     * Null for subscriptions or unknown prices, never a runtime estimate.
     */
    costUsd: z.number().nonnegative().nullable(),
  }),
  z.strictObject({
    ...eventFields,
    type: z.literal("rate-limit"),
    ...LimitWindow.shape,
  }),
  z.strictObject({
    ...eventFields,
    type: z.literal("retry"),
    attempt: z.number().int().positive(),
    maxAttempts: z.number().int().positive().optional(),
    delayMs: z.number().nonnegative(),
    httpStatus: z.number().int().min(100).max(599).optional(),
  }),
  /**
   * Names exactly one of toolName, for one of Neuve's tools, or work, for work the runtime does
   * itself (then callId is that work's workId and input says what it asks).
   */
  z
    .strictObject({
      ...eventFields,
      type: z.literal("approval.requested"),
      requestId: z.string().min(1),
      callId: z.string().min(1),
      toolName: z.string().min(1).optional(),
      work: WorkKind.optional(),
      input: z.json(),
      asked: ApprovalAsked.optional(),
    })
    .refine(
      (event) => (event.toolName === undefined) !== (event.work === undefined),
      "an approval request names either a tool or work",
    ),
  /** The runtime resolved an open approval request itself. The request can no longer be answered. */
  z.strictObject({
    ...eventFields,
    type: z.literal("approval.resolved"),
    requestId: z.string().min(1),
  }),
  /**
   * One piece of work a runtime that declares ownTools did itself, once, when it ended: what kind,
   * what it was asked, what came back, and whether it failed. Neuve ran none of it.
   */
  z.strictObject({
    ...eventFields,
    type: z.literal("work.finished"),
    workId: z.string().min(1),
    kind: WorkKind,
    input: z.json(),
    output: z.string().optional(),
    errored: z.boolean(),
    durationMs: z.number().nonnegative().optional(),
  }),
  z.strictObject({
    ...eventFields,
    type: z.literal("turn.finished"),
    outcome: TurnOutcome,
    /**
     * Set when a turn ends on a tool-result carrier with no trailing assistant message; names the point to
     * resume or fork from. When set, it takes precedence over the turn's last message.finished resumePoint,
     * so a resume keeps the round's tool results.
     *
     * On a runtime without resumeInTurn, whose messages carry no resume point, a completed turn sets this
     * to the turn's end: the only point it can resume or fork from.
     *
     * The receipt a resume point gives: a resume point (message.finished's, or this one when set) names a
     * point whose whole chain is in the native session. A completed turn.finished means every input given
     * to the turn (its message, steers and tool results) precedes its final resume point.
     */
    resumePoint: z.string().min(1).optional(),
  }),
]);
export type RuntimeEvent = z.infer<typeof RuntimeEvent>;

export interface RuntimeSession {
  /**
   * Native session id for a later resume. May change on fork or a conversation reset.
   * Read it when needed, for example after a turn finishes; never cache it from open.
   * Right after openSession it is the id of the session that open created (the new
   * session, for a fork). It is a live property: don't spread or copy the session object.
   */
  readonly nativeSessionId: string;
  /**
   * Exactly one turn.finished per started turn. final without policy.outputSchema
   * fails immediately with no-output-schema, before starting. Accepting an input
   * (startTurn, steerTurn) is not storage: only a resume point says it is kept.
   */
  readonly startTurn: (input: {
    readonly turnId: string;
    readonly message: string | ReadonlyArray<ContentBlock>;
    readonly final?: true | undefined;
    readonly workspace?: TurnWorkspace | undefined;
  }) => Effect.Effect<void, RuntimeError>;
  /** Fails with CapabilityUnsupported for steering when steering is false. */
  readonly steerTurn: (input: {
    readonly turnId: string;
    readonly message: string | ReadonlyArray<ContentBlock>;
  }) => Effect.Effect<void, RuntimeError>;
  /** Fails with CapabilityUnsupported for interrupt when interrupt is false. */
  readonly interruptTurn: (input: {
    readonly turnId: string;
    /** The interrupted outcome carries this reason when given. */
    readonly reason?: InterruptReason | undefined;
  }) => Effect.Effect<void, RuntimeError>;
  /**
   * Switches model within this live session; fails with CapabilityUnsupported without modelSwitchInSession.
   * An absent effort clears any earlier one, so the model runs at the runtime's default.
   */
  readonly setModel: (
    model: NonNullable<SessionPolicy["model"]>,
  ) => Effect.Effect<void, RuntimeError>;
  /** Fails with CapabilityUnsupported for approvals when approvals is false. */
  readonly respondToApproval: (input: {
    readonly requestId: string;
    readonly decision: "allow" | "deny";
    readonly message?: string | undefined;
  }) => Effect.Effect<void, RuntimeError>;
  /**
   * Single consumer, no error channel. Session death finishes each open turn as failed
   * with disposition broken, then ends. Scope closure finishes open turns as interrupted,
   * then ends. Pending approval requests end with their turn's turn.finished.
   */
  readonly events: Stream.Stream<RuntimeEvent>;
}
export interface RuntimeShape {
  readonly kind: RuntimeKind;
  readonly continuation: (account: Account) => ContinuationIdentity;
  readonly capabilities: (
    account: Account,
  ) => Effect.Effect<RuntimeCapabilities, RuntimeError>;
  /**
   * Closing the caller's scope ends the provider session and all its owned processes.
   * Fails with CapabilityUnsupported for ask without approvals or a schema without structuredOutput.
   */
  readonly openSession: (
    account: Account,
    policy: SessionPolicy,
    start: SessionStart,
  ) => Effect.Effect<RuntimeSession, RuntimeError, Scope.Scope>;
  /** Never signs in or sends a model request. Sign-in problems are states; only lookup and runtime failures are errors. */
  readonly probe: (
    account: Account,
  ) => Effect.Effect<AccountProbe, RuntimeError>;
  /** Runs the runtime's own sign-out for this account's credential and never reads it; a no-op for key references. */
  readonly signOut: (account: Account) => Effect.Effect<void, RuntimeError>;
}
