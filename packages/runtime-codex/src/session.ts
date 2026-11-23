/**
 * One provider session on Codex: the person's own Codex program run as its app server, mapped onto
 * the runtime contract as the [Codex runtime design](../../../process/proposals/codex-runtime.md#sessions-turns-and-events)
 * maps it. The table of how a turn ends is in this package's `PROTOCOL.md`; every ending goes
 * through `finish`, which emits a turn's one terminal event and ignores every later source.
 */
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  AccountRejected,
  RuntimeUnavailable,
  SignInRequired,
  TurnFailed,
  runtimeErrorToFailure,
  type AccountName,
  type ApprovalDelivery,
  type ContentBlock,
  type InterruptReason,
  type LimitWindow,
  type RuntimeCapabilities,
  type RuntimeError,
  type RuntimeEvent,
  type RuntimeFailure,
  type RuntimeSession,
  type SessionPolicy,
  type SessionStart,
  type SignInHint,
  type TurnFailureReason,
  type TurnOutcome,
  type TurnWorkspace,
  type WorkKind,
} from "@neuve/runtime";
import {
  Cause,
  Deferred,
  type Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Queue,
  Scope,
  Stream,
} from "effect";
import { z } from "zod";
import { describeApproval } from "./approval-asked.ts";
import {
  connect,
  type Answer,
  type CodexConnection,
  type Notification,
  type Reply,
  type ServerRequest,
} from "./client.ts";
import * as Decode from "./decode.ts";
import type { CodexFailure, CodexTermination } from "./errors.ts";
import type { FileUpdateChange } from "./generated/v2/FileUpdateChange";
import type { UserInput } from "./generated/v2/UserInput";
import {
  codexEnvironment,
  launchArguments,
  NEUVE_SERVER,
  turnSettings,
  unaddressable,
  type Configuration,
  type OwnSettings,
} from "./launch.ts";
import { protocolLog, type LogEntry } from "./log.ts";
import { replaceKnown } from "./redact.ts";
import { CodexProcess } from "./services.ts";
import { serveTools, toolHandler, type RunTool } from "./tools.ts";
import { judge, versionOf } from "./version.ts";

/** What this runtime declares; the three a review stage needs are not among them. */
export const capabilities: RuntimeCapabilities = {
  ownsLoop: true,
  ownTools: true,
  toolEndsTurn: false,
  resumeInTurn: false,
  perMessageUsage: false,
  resume: true,
  fork: true,
  interrupt: true,
  modelSwitchInSession: true,
  structuredOutput: true,
  steering: true,
  approvals: true,
  nativeToolServer: true,
  statusProbe: true,
  internalRetries: true,
  perRequestTelemetry: false,
  byteExactCapture: false,
};

export interface CodexAccessToken {
  readonly token: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
}

export type CodexTokenSource = (
  rejectedToken?: string,
) => Effect.Effect<
  CodexAccessToken,
  SignInRequired | AccountRejected | TurnFailed
>;

export interface CodexSessionOptions {
  readonly account: AccountName;
  /** The program the account names, found by the caller; never looked up here. */
  readonly program: string;
  /** Required on Neuve's sign-in. Otherwise absent selects the person's default. */
  readonly codexHome?: string | undefined;
  /** Present for an account on Neuve's sign-in. */
  readonly accessToken?: CodexTokenSource | undefined;
  /** The thread's working folder: the chat's own worktree. */
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly policy: SessionPolicy;
  readonly start: SessionStart;
  /** Receives each protocol line, already redacted. */
  readonly log?: ((entry: LogEntry) => void) | undefined;
  readonly handshakeTimeout?: Duration.Input | undefined;
  /** How long an interrupted turn has to end before the process is stopped; ten seconds. */
  readonly interruptWait?: Duration.Input | undefined;
  readonly stopWait?: Duration.Input | undefined;
  /** The releases refused as broken; the compatibility table's by default. */
  readonly broken?: ReadonlyArray<string> | undefined;
}

type ApprovalChoice = "allow" | "deny" | "automatic-deny" | "resolved";
interface Pending {
  readonly codexId: ServerRequest["id"];
  readonly decision: Deferred.Deferred<ApprovalChoice>;
  readonly delivery: Deferred.Deferred<ApprovalDelivery>;
  resolved: boolean;
}
interface Turn {
  readonly id: string;
  readonly final: boolean;
  readonly configuration: Configuration;
  codexId: string | undefined;
  /** Whether `turn/start` was written: from then on Codex may be running the turn. */
  sent: boolean;
  /** Settles when turn/start is answered: Codex's turn id, or nothing if it was refused. */
  readonly started: Deferred.Deferred<string | undefined>;
  interrupt: { readonly reason: InterruptReason | undefined } | undefined;
  finished: boolean;
  lastError: z.infer<typeof Decode.ErrorNotice>["error"] | undefined;
  lastText: string | undefined;
  baseline: Decode.Breakdown | undefined;
  retries: number;
  readonly approvals: Map<string, Pending>;
  readonly calls: Map<
    string,
    { readonly toolName: string; readonly controller: AbortController }
  >;
  /** Codex's own work that started and has not completed: an interrupt leaves it so. */
  readonly work: Map<
    string,
    {
      readonly kind: WorkKind;
      readonly input: unknown;
      readonly changes?: FileUpdateChange[];
    }
  >;
}
interface Current {
  readonly connection: CodexConnection;
  readonly scope: Scope.Closeable;
  readonly configuration: Configuration;
  readonly generation: number;
  /** Set once its output has ended: a process that died is never made current. */
  ended: boolean;
}

interface SessionAccess {
  readonly token: string;
  readonly state: "available" | "replacement" | "rejected";
}

const EMPTY: OwnSettings = {
  mcpServers: [],
  plugins: [],
  apps: [],
  skills: [],
  exclude: [],
};
const ERROR_TO_UNAVAILABLE = new Set([
  "serverOverloaded",
  "internalServerError",
  "httpConnectionFailed",
  "responseStreamConnectionFailed",
  "responseStreamDisconnected",
  "responseTooManyFailedAttempts",
  "rateLimitExceeded",
  "flexUnavailable",
  "policyCapacityUnavailable",
]);
const infoName = (info: unknown) =>
  typeof info === "string"
    ? info
    : info !== null && typeof info === "object"
      ? Object.keys(info)[0]
      : undefined;
const HttpStatus = z.object({ httpStatusCode: z.number() });
const httpStatusOf = (info: unknown, name: string | undefined) =>
  name !== undefined && typeof info === "object" && info !== null
    ? HttpStatus.safeParse(Object.values(info)[0]).data?.httpStatusCode
    : undefined;
const minus = (a: Decode.Breakdown, b: Decode.Breakdown): Decode.Breakdown => ({
  inputTokens: a.inputTokens - b.inputTokens,
  cachedInputTokens: a.cachedInputTokens - b.cachedInputTokens,
  cacheWriteInputTokens: a.cacheWriteInputTokens - b.cacheWriteInputTokens,
  outputTokens: a.outputTokens - b.outputTokens,
  reasoningOutputTokens: a.reasoningOutputTokens - b.reasoningOutputTokens,
});
const count = (n: number) => Math.max(0, Math.round(n));
/** OpenAI's input counts include cached and cache-written tokens; the contract's do not. */
const callUsage = (b: Decode.Breakdown) => ({
  input: count(b.inputTokens - b.cachedInputTokens - b.cacheWriteInputTokens),
  cacheWrite5m: count(b.cacheWriteInputTokens),
  cacheWrite1h: 0,
  cacheRead: count(b.cachedInputTokens),
  output: count(b.outputTokens),
  thinking: count(b.reasoningOutputTokens),
});
export const windows = (limits: Decode.RateLimits): Array<LimitWindow> =>
  [limits.primary, limits.secondary].flatMap((window) =>
    window == null
      ? []
      : [
          {
            window:
              window.windowDurationMins === 300
                ? "five-hour"
                : window.windowDurationMins === 10080
                  ? "weekly"
                  : "other",
            status:
              limits.rateLimitReachedType != null && window.usedPercent >= 100
                ? "rejected"
                : "allowed",
            utilization: Math.min(1, Math.max(0, window.usedPercent / 100)),
            ...(window.resetsAt == null
              ? {}
              : { resetsAt: new Date(window.resetsAt * 1000).toISOString() }),
            observedAt: new Date().toISOString(),
          } satisfies LimitWindow,
        ],
  );
const userInput = (
  message: string | ReadonlyArray<ContentBlock>,
): Array<UserInput> =>
  (typeof message === "string"
    ? [{ type: "text" as const, text: message }]
    : message
  ).map((block) =>
    block.type === "text"
      ? { type: "text", text: block.text, text_elements: [] }
      : { type: "image", url: `data:${block.mimeType};base64,${block.data}` },
  );
/**
 * What a piece of Codex's own work returned, bounded where it is read: a command can print without
 * end, and the event, the transcript and the log each carry it. The start and the end are kept.
 */
export const MAX_WORK_OUTPUT = 64 * 1024;
export const bounded = (text: string) =>
  text.length <= MAX_WORK_OUTPUT
    ? text
    : `${text.slice(0, MAX_WORK_OUTPUT / 2)}\n… ${text.length - MAX_WORK_OUTPUT} characters left out …\n${text.slice(-MAX_WORK_OUTPUT / 2)}`;
const errorOf = <E>(cause: Cause.Cause<E>) =>
  Option.getOrUndefined(Cause.findErrorOption(cause));
const asJson = (value: unknown) => {
  const parsed = z.json().safeParse(value);
  return parsed.success ? parsed.data : null;
};
const FileChanges = z.array(
  z.object({
    path: z.string(),
    kind: z.discriminatedUnion("type", [
      z.object({ type: z.enum(["add", "delete"]) }),
      z.object({ type: z.literal("update"), move_path: z.string().nullable() }),
    ]),
    diff: z.string(),
  }),
) satisfies z.ZodType<FileUpdateChange[]>;

/** Opens one session. Closing the caller's scope ends it, its processes and its tool server. */
export const openCodexSession = Effect.fnUntraced(function* (
  options: CodexSessionOptions,
) {
  const sessionScope = yield* Effect.scope;
  const processes = yield* CodexProcess;
  const context = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(context);
  const { account, policy } = options;
  const threadOptions = {
    cwd: options.cwd,
    developerInstructions: policy.systemPrompt,
  };
  if (options.accessToken !== undefined && options.codexHome === undefined)
    return yield* new RuntimeUnavailable({ account, reason: "start-failed" });
  const events = yield* Queue.unbounded<RuntimeEvent, Cause.Done>();
  const token = randomBytes(32).toString("base64url");
  const codexHome = options.codexHome ?? join(homedir(), ".codex");
  const log = options.log === undefined ? undefined : protocolLog(options.log);
  log?.know(token, "<token>");
  log?.know(options.cwd, "<cwd>");
  log?.know(codexHome, "<codex-home>");
  log?.know(options.program, "<program>");
  // Signed in by the program the session runs: a bare `codex` on the PATH may be another one.
  const hint: SignInHint =
    options.accessToken !== undefined
      ? { kind: "command", command: "neuve auth login", account }
      : {
          kind: "command",
          command: "codex login",
          ...(options.codexHome === undefined
            ? {}
            : { environment: { CODEX_HOME: options.codexHome } }),
          program: options.program,
        };
  const turnFailed = (reason: TurnFailureReason) =>
    new TurnFailed({ account, reason });
  const now = () => new Date().toISOString();
  const emit = (event: RuntimeEvent) => {
    Queue.offerUnsafe(events, event);
  };

  let model = policy.model;
  let threadModel: string | undefined;
  let threadId = "";
  let own: OwnSettings | undefined;
  let current: Current | undefined;
  let access: SessionAccess | undefined;
  let generation = 0;
  let dead = false;
  let turn: Turn | undefined;
  const closedApprovals = new Map<string, "runtime-resolved" | "turn-ended">();
  /** Whether any turn was ever sent to Codex on this thread. */
  let turnSent = false;
  let rateLimits: Decode.RateLimits | undefined;
  /** Every process's scope until it is closed, so none outlives the session, whatever was cut short. */
  const scopes = new Set<Scope.Closeable>();
  const closeScope = (scope: Scope.Closeable) =>
    Scope.close(scope, Exit.void).pipe(
      Effect.ensuring(Effect.sync(() => scopes.delete(scope))),
    );

  const failure = (
    failed: RuntimeFailure,
    disposition: "reusable" | "broken" = "reusable",
  ): TurnOutcome => ({ status: "failed", failure: failed, disposition });
  const turnFailure = (
    reason: TurnFailureReason,
    disposition: "reusable" | "broken" = "reusable",
  ) => failure({ _tag: "TurnFailed", account, reason }, disposition);

  /**
   * Ends the session: its open turn as given, the stream, and the process. From inside the
   * process's own reader the close is forked, since closing waits for that reader to end.
   */
  const stop = (outcome?: TurnOutcome, wait = false) =>
    Effect.gen(function* () {
      if (dead) return;
      dead = true;
      if (turn !== undefined && outcome !== undefined)
        yield* finish(turn, outcome);
      yield* Queue.end(events);
      current = undefined;
      generation++;
      const close = Effect.forEach([...scopes], closeScope, { discard: true });
      if (wait) yield* close;
      else yield* Effect.forkDetach(close);
    });

  /** The one terminal event of a turn; every later source of an ending is ignored. */
  const finish = (
    active: Turn,
    outcome: TurnOutcome,
    resumePoint?: string,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (active.finished) return;
      active.finished = true;
      if (turn === active) turn = undefined;
      yield* Deferred.succeed(active.started, active.codexId);
      for (const [id, pending] of active.approvals) {
        if (!closedApprovals.has(id)) closedApprovals.set(id, "turn-ended");
        yield* Deferred.succeed(pending.decision, "automatic-deny");
      }
      // Taken out of the map before any is aborted: an abort can resume its handler at once, and
      // a handler that still found its call there would report it a second time.
      const running = [...active.calls];
      active.calls.clear();
      for (const [callId, call] of running) {
        emit({
          type: "tool.finished",
          turnId: active.id,
          at: now(),
          callId,
          toolName: call.toolName,
          errored: true,
        });
        call.controller.abort();
      }
      // Work Codex started and never completed is reported once, as not finished.
      for (const [workId, work] of active.work)
        emit({
          type: "work.finished",
          turnId: active.id,
          at: now(),
          workId,
          kind: work.kind,
          input: asJson(work.input),
          errored: true,
        });
      active.work.clear();
      emit({
        type: "turn.finished",
        turnId: active.id,
        at: now(),
        outcome,
        ...(resumePoint === undefined ? {} : { resumePoint }),
      });
      if (outcome.status === "failed" && outcome.disposition === "broken")
        yield* stop();
    });

  const acceptAccess = () => {
    if (access?.state === "replacement")
      access = { token: access.token, state: "available" };
  };

  /** What a Codex error on a turn means for the contract. */
  const errorOutcome = (info: unknown): TurnOutcome => {
    const name = infoName(info);
    if (
      access !== undefined &&
      (name === "unauthorized" || httpStatusOf(info, name) === 401)
    ) {
      const replacement = access.state === "replacement";
      access = { token: access.token, state: "rejected" };
      return replacement
        ? failure({ _tag: "AccountRejected", account, hint, reason: "other" })
        : turnFailure("provider-failed");
    }
    if (name === "unauthorized")
      return failure({ _tag: "SignInRequired", account, hint });
    if (name === "usageLimitExceeded") {
      const window =
        rateLimits === undefined
          ? undefined
          : (windows(rateLimits).find((w) => w.status === "rejected") ??
            windows(rateLimits)[0]);
      return failure({
        _tag: "UsageLimitReached",
        account,
        ...(window === undefined ? {} : { ...window, status: "rejected" }),
      });
    }
    if (name === "contextWindowExceeded")
      return turnFailure("context-overflow");
    if (name !== undefined && ERROR_TO_UNAVAILABLE.has(name))
      return turnFailure("provider-unavailable");
    return turnFailure("provider-failed");
  };
  const requestOutcome = (error: CodexFailure): TurnOutcome =>
    error._tag === "CodexRequestFailed"
      ? errorOutcome(
          error.code === 401 && access !== undefined
            ? "unauthorized"
            : error.type,
        )
      : turnFailure("provider-failed", "broken");

  /**
   * Whether a notification is the open turn's. Codex names the turn in turn/start's answer and in
   * turn/started; until then nothing is taken as the turn's, so a late line of an earlier turn is
   * never mistaken for it.
   */
  const matches = (active: Turn, codexTurnId: string | null | undefined) =>
    !active.finished &&
    active.codexId !== undefined &&
    active.codexId === codexTurnId;

  const workOf = (
    item: Decode.KnownItem,
  ):
    | {
        kind: WorkKind;
        input: unknown;
        output?: string;
        errored: boolean;
        durationMs?: number;
      }
    | undefined => {
    switch (item.type) {
      case "commandExecution":
        return {
          kind: "command",
          input: { command: item.command, cwd: item.cwd },
          ...(item.aggregatedOutput == null
            ? {}
            : { output: bounded(item.aggregatedOutput) }),
          errored: item.status !== "completed" || (item.exitCode ?? 0) !== 0,
          ...(item.durationMs == null ? {} : { durationMs: item.durationMs }),
        };
      case "fileChange":
        return {
          kind: "file-change",
          input: {
            changes: item.changes.map((c) => ({
              path: c.path,
              kind: c.kind.type,
            })),
          },
          output: bounded(item.changes.map((c) => c.diff).join("\n")),
          errored: item.status !== "completed",
        };
      case "webSearch":
        return {
          kind: "web-search",
          input: { query: item.query, action: item.action ?? null },
          errored: false,
        };
      case "mcpToolCall":
        if (ours(item.server)) return undefined;
        return {
          kind: "tool",
          input: {
            server: item.server,
            tool: item.tool,
            arguments: item.arguments ?? null,
          },
          ...(item.error != null
            ? { output: bounded(item.error.message) }
            : item.result != null
              ? { output: bounded(JSON.stringify(item.result.content)) }
              : {}),
          errored: item.status !== "completed",
          ...(item.durationMs == null ? {} : { durationMs: item.durationMs }),
        };
      case "agentMessage":
        return undefined;
    }
  };

  const onNotification = (notification: Notification) =>
    Effect.gen(function* () {
      const active = turn;
      const params: unknown = notification.params;
      switch (notification.method) {
        case "turn/started": {
          const started = Decode.TurnAnswer.safeParse(params);
          if (active && !active.finished && started.success) {
            active.codexId ??= started.data.turn.id;
            // Codex has named the turn: an interrupt waiting for that can now be sent.
            yield* Deferred.succeed(active.started, active.codexId);
          }
          return;
        }
        case "item/agentMessage/delta": {
          const delta = Decode.Delta.safeParse(params);
          if (active && delta.success && matches(active, delta.data.turnId)) {
            acceptAccess();
            emit({
              type: "text",
              turnId: active.id,
              at: now(),
              text: delta.data.delta,
            });
          }
          return;
        }
        case "item/started": {
          const started = Decode.ItemCompleted.safeParse(params);
          if (!active || !started.success) return;
          if (!matches(active, started.data.turnId)) return;
          const item = Decode.KnownItem.safeParse(started.data.item);
          const work = item.success ? workOf(item.data) : undefined;
          if (item.success && work !== undefined) {
            const changes =
              item.data.type === "fileChange"
                ? FileChanges.safeParse(item.data.changes).data
                : undefined;
            active.work.set(item.data.id, {
              kind: work.kind,
              input: work.input,
              ...(changes === undefined ? {} : { changes }),
            });
          }
          return;
        }
        case "item/completed": {
          const completed = Decode.ItemCompleted.safeParse(params);
          if (!active || !completed.success) return;
          if (!matches(active, completed.data.turnId)) return;
          const item = Decode.KnownItem.safeParse(completed.data.item);
          if (!item.success) {
            if (
              [
                "agentMessage",
                "commandExecution",
                "fileChange",
                "webSearch",
                "mcpToolCall",
              ].includes(completed.data.item.type)
            )
              yield* Effect.logWarning("codex item did not decode", {
                type: completed.data.item.type,
              });
            return;
          }
          if (item.data.type === "agentMessage") {
            acceptAccess();
            active.lastText = item.data.text;
            emit({
              type: "message.finished",
              turnId: active.id,
              at: now(),
              messageId: item.data.id,
              // Commentary is followed by Codex's own work; anything else may end the turn.
              stopReason:
                item.data.phase === "commentary" ? "tool-use" : "end-turn",
              toolCalls: [],
              ...((model?.id ?? threadModel) === undefined
                ? {}
                : { model: (model?.id ?? threadModel)! }),
            });
            return;
          }
          const work = workOf(item.data);
          active.work.delete(item.data.id);
          if (work !== undefined)
            emit({
              type: "work.finished",
              turnId: active.id,
              at: now(),
              workId: item.data.id,
              kind: work.kind,
              input: asJson(work.input),
              ...(work.output === undefined ? {} : { output: work.output }),
              errored: work.errored,
              ...(work.durationMs === undefined
                ? {}
                : { durationMs: work.durationMs }),
            });
          return;
        }
        case "thread/tokenUsage/updated": {
          const usage = Decode.TokenUsage.safeParse(params);
          if (!active || !usage.success || !matches(active, usage.data.turnId))
            return;
          acceptAccess();
          const { total, last, modelContextWindow } = usage.data.tokenUsage;
          active.baseline ??= minus(total, last);
          const name = model?.id ?? threadModel;
          emit({
            type: "usage",
            turnId: active.id,
            at: now(),
            scope: "turn",
            ...(name === undefined ? {} : { model: name }),
            ...(modelContextWindow == null || modelContextWindow <= 0
              ? {}
              : { contextWindow: Math.round(modelContextWindow) }),
            usage: callUsage(minus(total, active.baseline)),
            costUsd: null,
          });
          return;
        }
        case "account/rateLimits/updated": {
          const limits = Decode.RateLimits.safeParse(params);
          if (!limits.success) return;
          rateLimits = limits.data.rateLimits;
          if (active && !active.finished)
            for (const window of windows(rateLimits))
              emit({
                type: "rate-limit",
                turnId: active.id,
                at: now(),
                ...window,
              });
          return;
        }
        case "error": {
          const notice = Decode.ErrorNotice.safeParse(params);
          if (
            !active ||
            !notice.success ||
            !matches(active, notice.data.turnId)
          )
            return;
          if (notice.data.willRetry)
            emit({
              type: "retry",
              turnId: active.id,
              at: now(),
              attempt: ++active.retries,
              delayMs: 0,
            });
          else active.lastError = notice.data.error;
          return;
        }
        case "serverRequest/resolved": {
          const resolved = Decode.Resolved.safeParse(params);
          if (!active || !resolved.success) return;
          for (const [id, pending] of active.approvals)
            if (pending.codexId === resolved.data.requestId) {
              if (Deferred.isDoneUnsafe(pending.delivery)) return;
              pending.resolved = true;
              closedApprovals.set(id, "runtime-resolved");
              yield* Deferred.succeed(pending.decision, "resolved");
              yield* Deferred.await(pending.delivery);
              return;
            }
          return;
        }
        case "turn/completed": {
          const completed = Decode.TurnCompleted.safeParse(params);
          if (!active) return;
          if (!completed.success)
            return yield* finish(
              active,
              turnFailure("protocol-error", "broken"),
            );
          if (!matches(active, completed.data.turn.id)) return;
          const { status, error } = completed.data.turn;
          if (status === "completed") {
            acceptAccess();
            if (!active.final)
              return yield* finish(
                active,
                { status: "completed" },
                completed.data.turn.id,
              );
            if (active.lastText === undefined)
              return yield* finish(
                active,
                turnFailure("structured-output-missing"),
              );
            let output: unknown;
            try {
              output = JSON.parse(active.lastText);
            } catch {
              return yield* finish(
                active,
                turnFailure("structured-output-invalid"),
              );
            }
            return yield* finish(
              active,
              { status: "completed", structuredOutput: asJson(output) },
              completed.data.turn.id,
            );
          }
          if (status === "interrupted")
            return yield* finish(active, {
              status: "interrupted",
              ...(active.interrupt?.reason === undefined
                ? {}
                : { reason: active.interrupt.reason }),
            });
          if (status === "failed")
            return yield* finish(
              active,
              errorOutcome(
                error?.codexErrorInfo ?? active.lastError?.codexErrorInfo,
              ),
            );
          return;
        }
        default:
          return;
      }
    });

  /** Codex's requests: approvals are the person's in an attended turn, and declined otherwise. */
  const declined = (method: string) =>
    Effect.logWarning("codex request declined: no person is attending", {
      method,
    });
  const approve = (
    request: ServerRequest,
    kind: WorkKind,
    itemId: string,
    answer: (decision: "allow" | "deny") => unknown,
    reply: Reply,
    changes?: FileUpdateChange[],
  ) =>
    Effect.gen(function* () {
      const active = turn;
      if (
        policy.approvalPolicy !== "ask" ||
        active === undefined ||
        active.finished ||
        active.configuration !== "own"
      ) {
        yield* declined(request.method);
        return { result: answer("deny") } satisfies Answer;
      }
      const requestId = `approval-${crypto.randomUUID()}`;
      const pending: Pending = {
        codexId: request.id,
        decision: yield* Deferred.make<ApprovalChoice>(),
        delivery: yield* Deferred.make<ApprovalDelivery>(),
        resolved: false,
      };
      yield* Effect.sync(() => {
        active.approvals.set(requestId, pending);
        emit({
          type: "approval.requested",
          turnId: active.id,
          at: now(),
          requestId,
          callId: itemId,
          work: kind,
          input: asJson(
            changes === undefined
              ? request.params
              : { ...request.params, changes },
          ),
          asked: describeApproval(request, changes),
        });
      }).pipe(
        Effect.andThen(Deferred.await(pending.decision)),
        Effect.flatMap((decision) =>
          Effect.uninterruptible(
            Effect.gen(function* () {
              if (pending.resolved || decision === "resolved") return;
              if (decision === "automatic-deny") {
                yield* reply({ result: answer("deny") });
              } else if (!active.finished) {
                const result = yield* reply({ result: answer(decision) });
                if (result === "written") {
                  closedApprovals.delete(requestId);
                  yield* Deferred.succeed(pending.delivery, {
                    delivered: true,
                  });
                }
                if (result === "resolved") pending.resolved = true;
              }
            }),
          ),
        ),
        Effect.ensuring(
          Effect.suspend(() => {
            active.approvals.delete(requestId);
            if (Deferred.isDoneUnsafe(pending.delivery)) return Effect.void;
            const reason = pending.resolved ? "runtime-resolved" : "turn-ended";
            closedApprovals.set(requestId, reason);
            if (reason === "runtime-resolved")
              emit({
                type: "approval.resolved",
                turnId: active.id,
                at: now(),
                requestId,
              });
            return Deferred.succeed(pending.delivery, {
              delivered: false,
              reason,
            });
          }),
        ),
      );
    });
  const answerRequest = (
    request: ServerRequest,
    reply: Reply,
  ): Effect.Effect<Answer | undefined> =>
    Effect.gen(function* () {
      switch (request.method) {
        case "item/commandExecution/requestApproval":
        case "item/fileChange/requestApproval": {
          const asked = Decode.ApprovalAsk.parse(request.params);
          const kind =
            request.method === "item/fileChange/requestApproval"
              ? "file-change"
              : "command";
          const active = turn;
          const changes =
            kind === "file-change" && active && matches(active, asked.turnId)
              ? active.work.get(asked.itemId)?.changes
              : undefined;
          return yield* approve(
            request,
            kind,
            asked.itemId,
            (decision) => ({
              decision: decision === "allow" ? "accept" : "decline",
            }),
            reply,
            changes,
          );
        }
        case "item/permissions/requestApproval": {
          const asked = Decode.ApprovalAsk.parse(request.params);
          const permissions = request.params.permissions;
          return yield* approve(
            request,
            "command",
            asked.itemId,
            (decision) => ({
              permissions:
                decision === "allow"
                  ? {
                      ...(permissions.network === null
                        ? {}
                        : { network: permissions.network }),
                      ...(permissions.fileSystem === null
                        ? {}
                        : { fileSystem: permissions.fileSystem }),
                    }
                  : {},
              scope: "turn",
            }),
            reply,
          );
        }
        case "mcpServer/elicitation/request": {
          const asked = Decode.Elicitation.parse(request.params);
          const refuse = { action: "decline", content: null, _meta: null };
          if (ours(asked.serverName)) return { result: refuse };
          return yield* approve(
            request,
            "tool",
            `elicitation-${String(request.id)}`,
            (decision) =>
              decision === "allow"
                ? {
                    action: "accept",
                    content: asked.mode === "url" ? null : {},
                    _meta: null,
                  }
                : refuse,
            reply,
          );
        }
        case "item/tool/requestUserInput":
          yield* declined(request.method);
          return { result: { answers: {} } };
        case "applyPatchApproval":
        case "execCommandApproval":
          yield* declined(request.method);
          return {
            result: {
              decision: { denied: { rejection: "No person is attending." } },
            },
          };
        default:
          yield* declined(request.method);
          return {
            error: { code: -32601, message: "Neuve does not answer this" },
          };
      }
    }).pipe(
      Effect.catchCause(() =>
        Effect.succeed<Answer>({
          error: { code: -32602, message: "the request did not decode" },
        }),
      ),
    );

  const unavailable = (reason: RuntimeUnavailable["reason"]) =>
    new RuntimeUnavailable({ account, reason });
  const terminationOf = (termination: CodexTermination) =>
    termination._tag === "CodexExited" ||
    termination._tag === "CodexOutputEnded" ||
    termination._tag === "CodexInputRefused"
      ? "provider-failed"
      : "protocol-error";

  /** Starts one Codex process in its own scope, with the handshake and the version check. */
  const startProcess = (
    configuration: Configuration,
    settings: OwnSettings,
    toolServer: string | undefined,
    cwd: string,
    accessToken?: string,
  ) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      scopes.add(scope);
      // The one place a process starts: never once the session is stopped. A start a stop
      // overtakes is closed by it, since its scope is already in the set.
      if (dead)
        return yield* closeScope(scope).pipe(
          Effect.andThen(Effect.fail(turnFailed("session-stopped"))),
        );
      return yield* starting(
        scope,
        configuration,
        settings,
        toolServer,
        cwd,
        accessToken,
      ).pipe(
        // A start cut short leaves no process behind.
        Effect.onInterrupt(() => closeScope(scope)),
      );
    });
  const starting = (
    scope: Scope.Closeable,
    configuration: Configuration,
    settings: OwnSettings,
    toolServer: string | undefined,
    cwd: string,
    accessToken: string | undefined,
  ) =>
    Effect.gen(function* () {
      const gen = ++generation;
      const secrets = [
        ...(toolServer === undefined ? [] : [token]),
        ...(accessToken === undefined ? [] : [accessToken]),
      ];
      const connected = yield* connect({
        program: options.program,
        args: launchArguments(
          configuration,
          settings,
          toolServer,
          accessToken !== undefined,
        ),
        env: codexEnvironment(
          options.environment,
          options.codexHome,
          toolServer === undefined ? undefined : token,
          accessToken,
        ),
        secrets,
        cwd,
        clientInfo: { name: "neuve", title: "Neuve", version: "0.1.0" },
        answer: answerRequest,
        ...(log === undefined
          ? {}
          : { onLine: (line) => log.onLine(line, accessToken) }),
        ...(options.handshakeTimeout === undefined
          ? {}
          : { handshakeTimeout: options.handshakeTimeout }),
        ...(options.stopWait === undefined
          ? {}
          : { stopWait: options.stopWait }),
      }).pipe(
        Scope.provide(scope),
        Effect.provideService(CodexProcess, processes),
        Effect.exit,
      );
      if (Exit.isFailure(connected)) {
        yield* closeScope(scope);
        const failed = errorOf(connected.cause)?._tag;
        if (failed === "CodexSpawnFailed")
          return yield* unavailable("not-installed");
        // It started and did not answer as Codex: the program is not the one it is named for.
        yield* Effect.logWarning("codex did not answer as Codex", { failed });
        return yield* unavailable("start-failed");
      }
      const connection = connected.value;
      const verdict = judge(
        Decode.Initialize.safeParse(connection.initialize).data?.userAgent ===
          undefined
          ? undefined
          : versionOf(
              replaceKnown(
                connection.initialize.userAgent,
                secrets.map((value) => [value, "<token>"]),
              ),
            ),
        options.broken,
      );
      if (verdict.kind === "broken") {
        yield* closeScope(scope);
        yield* Effect.logWarning("codex version is marked broken", {
          version: verdict.version,
        });
        return yield* unavailable("unsupported-version");
      }
      if (verdict.kind === "unsupported")
        yield* Effect.logWarning("codex version", { advice: verdict.advice });
      const started: Current = {
        connection,
        scope,
        configuration,
        generation: gen,
        ended: false,
      };
      yield* Stream.runForEach(connection.notifications, onNotification).pipe(
        // Only the current process's end is the session's. One still being prepared is marked
        // ended, and the code preparing it closes it rather than making it current.
        Effect.catch((termination) =>
          Effect.suspend(() => {
            started.ended = true;
            return current === started
              ? stop(turnFailure(terminationOf(termination), "broken"))
              : Effect.void;
          }),
        ),
        Effect.ensuring(Effect.sync(() => (started.ended = true))),
        Effect.forkIn(scope),
      );
      return started;
    });

  const ask = <A>(
    connection: CodexConnection,
    decoder: z.ZodType<A>,
    run: (connection: CodexConnection) => Effect.Effect<unknown, CodexFailure>,
  ) =>
    Effect.gen(function* () {
      const answer = yield* run(connection);
      const decoded = decoder.safeParse(answer);
      return decoded.success
        ? decoded.data
        : yield* turnFailed("protocol-error");
    });
  const request = <A>(
    decoder: z.ZodType<A>,
    run: (connection: CodexConnection) => Effect.Effect<unknown, CodexFailure>,
  ) =>
    current === undefined
      ? Effect.fail(turnFailed("session-stopped"))
      : ask(current.connection, decoder, run);

  /** The names of the person's own settings, read once through a process that runs none of them. */
  const readOwn = Effect.gen(function* () {
    const probe = yield* startProcess("clean", EMPTY, undefined, options.cwd);
    const names = yield* Effect.gen(function* () {
      const config = Decode.ConfigAnswer.parse(
        yield* probe.connection.request("config/read", { cwd: options.cwd }),
      ).config;
      const skills = Decode.SkillsAnswer.parse(
        yield* probe.connection.request("skills/list", { cwds: [options.cwd] }),
      );
      return {
        // The probe serves no Neuve server, so every name here is the person's.
        mcpServers: Object.keys(config.mcp_servers ?? {}),
        plugins: Object.keys(config.plugins ?? {}),
        apps: Object.keys(config.apps ?? {}).filter(
          (name) => name !== "_default",
        ),
        skills: [
          ...new Set(
            skills.data.flatMap((entry) =>
              entry.skills
                .filter((skill) => skill.scope !== "repo")
                .map((skill) => skill.name),
            ),
          ),
        ],
        exclude: config.shell_environment_policy?.exclude ?? [],
      } satisfies OwnSettings;
    }).pipe(
      Effect.ensuring(closeScope(probe.scope)),
      Effect.catchCause(() => Effect.fail(unavailable("start-failed"))),
    );
    // Each name is the person's: none reaches the log as written.
    for (const [list, label] of [
      [names.mcpServers, "server"],
      [names.plugins, "plugin"],
      [names.apps, "app"],
      [names.skills, "skill"],
    ] as const)
      list.forEach((name, i) => log?.know(name, `<${label}-${i + 1}>`));
    return names;
  });

  /**
   * A clean session is refused unless the running Codex reports each of the person's additions
   * off where it would show it running: no hook listed, each server of theirs disabled in its
   * effective configuration and listing no tools (a server that failed to start lists none too, so
   * the switch itself is read), none of their skills enabled, and web search, hooks, apps and
   * plugins off.
   */
  const verifyClean = (connection: CodexConnection) =>
    Effect.gen(function* () {
      const config = Decode.ConfigAnswer.parse(
        yield* connection.request("config/read", { cwd: options.cwd }),
      ).config;
      const hooks = Decode.HooksAnswer.parse(
        yield* connection.request("hooks/list", { cwds: [options.cwd] }),
      );
      const servers = Decode.ServerStatusAnswer.parse(
        yield* connection.request("mcpServerStatus/list", { limit: 1000 }),
      );
      const skills = Decode.SkillsAnswer.parse(
        yield* connection.request("skills/list", { cwds: [options.cwd] }),
      );
      const features = config.features ?? {};
      return (
        config.web_search === "disabled" &&
        features.hooks === false &&
        features.apps === false &&
        features.plugins === false &&
        hooks.data.every((entry) => entry.hooks.length === 0) &&
        Object.entries(config.mcp_servers ?? {}).every(
          ([name, server]) => ours(name) || server.enabled === false,
        ) &&
        servers.nextCursor == null &&
        servers.data
          .filter((server) => !ours(server.name))
          .every((server) => Object.keys(server.tools ?? {}).length === 0) &&
        skills.data.every((entry) =>
          entry.skills.every(
            (skill) => skill.scope === "repo" || !skill.enabled,
          ),
        )
      );
    }).pipe(Effect.catchCause(() => Effect.succeed(false)));

  let toolServer: string | undefined;
  /** A server is Neuve's only when this session started it under that name. */
  const ours = (name: string) =>
    toolServer !== undefined && name === NEUVE_SERVER;
  const runTool: RunTool = (definition, input, signal, nativeId) =>
    runPromise(
      Effect.gen(function* () {
        const active = turn;
        if (active === undefined || active.finished || dead)
          return {
            content: [{ type: "text", text: "No turn is running." }],
            isError: true,
          };
        const callId =
          nativeId !== undefined && !active.calls.has(nativeId)
            ? nativeId
            : `call-${crypto.randomUUID()}`;
        const toolName = definition.name;
        const json = asJson(input);
        // Codex reports work by item, so the call is its own unit, complete when it arrives.
        emit({
          type: "message.finished",
          turnId: active.id,
          at: now(),
          messageId: callId,
          stopReason: "tool-use",
          toolCalls: [{ callId, toolName, input: json }],
        });
        emit({
          type: "tool.started",
          turnId: active.id,
          at: now(),
          callId,
          toolName,
          input: json,
        });
        const controller = new AbortController();
        signal.addEventListener("abort", () => controller.abort(), {
          once: true,
        });
        active.calls.set(callId, { toolName, controller });
        const began = Date.now();
        const outcome = yield* definition
          .handle(input, { callId, signal: controller.signal })
          .pipe(Effect.exit);
        const settled = active.calls.delete(callId);
        const errored =
          Exit.isFailure(outcome) || outcome.value.error !== undefined;
        if (settled)
          emit({
            type: "tool.finished",
            turnId: active.id,
            at: now(),
            callId,
            toolName,
            errored,
            durationMs: Date.now() - began,
          });
        return {
          content: [
            {
              type: "text" as const,
              text: Exit.isSuccess(outcome)
                ? outcome.value.text
                : "The tool failed.",
            },
          ],
          isError: errored,
        };
      }),
    );

  const collides = (settings: OwnSettings) =>
    policy.tools.length > 0 && settings.mcpServers.includes(NEUVE_SERVER);
  /** Whether the session, and the turn when one is given, are still live. */
  const live = (active?: Turn) =>
    !dead && (active === undefined || !active.finished);
  /** After every wait, before anything more is written: the session and the turn still live. */
  const still = (active?: Turn) =>
    live(active) ? Effect.void : Effect.fail(turnFailed("session-stopped"));
  /**
   * Puts the session on the configuration a turn needs. One process at a time: the current one is
   * closed first. The next becomes current only once its handshake, its version, its clean check
   * and the thread's resume have all succeeded, with the session and the turn re-checked after each
   * wait; on any failure or interruption on the way it is closed, and no process is current, so the
   * next turn starts over. The table of the session's states is in `PROTOCOL.md`.
   */
  const ensure = (configuration: Configuration, active?: Turn) =>
    Effect.gen(function* () {
      const rejectedToken =
        access?.state === "rejected" ? access.token : undefined;
      const accessToken =
        options.accessToken === undefined
          ? undefined
          : (yield* options.accessToken(rejectedToken)).token;
      yield* still(active);
      if (accessToken !== undefined && accessToken === rejectedToken)
        return yield* new AccountRejected({ account, hint, reason: "other" });
      if (
        current?.configuration === configuration &&
        access?.token === accessToken
      )
        return;
      const previous = current;
      current = undefined;
      if (previous !== undefined) yield* closeScope(previous.scope);
      yield* still(active);
      if (configuration === "clean") {
        // Read at each clean start, so a server the person added since is switched off by name.
        own = yield* readOwn;
        yield* still(active);
        // A server of the person's under Neuve's name would take Neuve's place: refused.
        if (collides(own)) {
          yield* Effect.logWarning(
            "codex: a server of the person's has Neuve's name",
          );
          return yield* unavailable("start-failed");
        }
        if (unaddressable(own) !== undefined)
          return yield* unavailable("start-failed");
      }
      const next = yield* startProcess(
        configuration,
        own ?? EMPTY,
        toolServer,
        options.cwd,
        accessToken,
      );
      yield* prepare(next, configuration, active).pipe(
        // A process that died after its last answer failed its preparation too.
        // One scheduler turn first, so a death the client has already read is seen here.
        Effect.andThen(Effect.yieldNow),
        Effect.andThen(
          Effect.suspend(() =>
            next.ended || !next.connection.open()
              ? Effect.fail(unavailable("start-failed"))
              : Effect.void,
          ),
        ),
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) ? Effect.void : closeScope(next.scope),
        ),
      );
      current = next;
      // A mode change can restart Codex without changing the token.
      if (accessToken !== undefined && accessToken !== access?.token)
        access = {
          token: accessToken,
          state: rejectedToken === undefined ? "available" : "replacement",
        };
    });
  /** The clean check, then the thread loaded into the new process; it is not current yet. */
  const prepare = (
    next: Current,
    configuration: Configuration,
    active: Turn | undefined,
  ) =>
    Effect.gen(function* () {
      if (configuration === "clean" && !(yield* verifyClean(next.connection)))
        return yield* unavailable("start-failed");
      yield* still(active);
      if (threadId === "") return;
      const resumed = yield* ask(next.connection, Decode.ThreadAnswer, (c) =>
        c.request("thread/resume", {
          threadId,
          ...threadOptions,
          excludeTurns: true,
        }),
      ).pipe(Effect.exit);
      yield* still(active);
      if (Exit.isSuccess(resumed)) return;
      // A thread no turn was ever sent to may not be resumable yet, and holds nothing: a new one
      // stands in for it. One that had a turn, finished or not, is never silently replaced.
      if (turnSent || options.start.kind === "resume")
        return yield* turnFailed("protocol-error");
      yield* newThread(next.connection);
      yield* still(active);
    });
  const newThread = (connection: CodexConnection) =>
    Effect.gen(function* () {
      const started = yield* ask(connection, Decode.ThreadAnswer, (c) =>
        c.request("thread/start", {
          ...threadOptions,
          ...(model === undefined ? {} : { model: model.id }),
          sandbox: "read-only",
        }),
      );
      threadId = started.thread.id;
      threadModel = (started as { model?: string }).model ?? threadModel;
    });

  // Opening: the tool server, then a clean process, then the thread.
  if (policy.tools.length > 0)
    toolServer = yield* serveTools(
      toolHandler(policy.tools, token, runTool),
    ).pipe(
      Scope.provide(sessionScope),
      Effect.catchDefect(() => Effect.fail(unavailable("start-failed"))),
    );
  if (toolServer !== undefined) log?.serves();
  // Every process the session ever started is closed and waited for, whether or not a death or a
  // broken turn stopped the session first.
  yield* Effect.addFinalizer(() =>
    stop({ status: "interrupted", reason: "shutdown" }, true).pipe(
      Effect.andThen(
        Effect.suspend(() =>
          Effect.forEach([...scopes], closeScope, { discard: true }),
        ),
      ),
    ),
  );
  // A setting the command line cannot switch off refuses read-only turns only: the session opens on
  // the person's own Codex instead.
  yield* ensure("clean").pipe(
    Effect.catchTag("RuntimeUnavailable", (error) =>
      own !== undefined && unaddressable(own) !== undefined && !collides(own)
        ? ensure("own")
        : Effect.fail(error),
    ),
  );
  if (options.accessToken === undefined) {
    const signedIn = yield* request(Decode.AccountAnswer, (c) =>
      c.request("account/read", { refreshToken: false }),
    ).pipe(Effect.option);
    if (
      signedIn._tag === "Some" &&
      signedIn.value.account == null &&
      signedIn.value.requiresOpenaiAuth
    )
      return yield* new SignInRequired({ account, hint });
  }
  const { start } = options;
  if (start.kind === "new") yield* newThread(current!.connection);
  else {
    const resumed = yield* request(Decode.ThreadAnswer, (c) =>
      c.request("thread/resume", {
        threadId: start.session,
        ...threadOptions,
        excludeTurns: start.at === undefined,
      }),
    );
    threadId = resumed.thread.id;
    const last = resumed.thread.turns?.at(-1)?.id;
    if (start.fork || (start.at !== undefined && last !== start.at)) {
      const forked = yield* request(Decode.ThreadAnswer, (c) =>
        c.request("thread/fork", {
          threadId: start.session,
          ...threadOptions,
          excludeTurns: true,
          ...(start.at === undefined ? {} : { lastTurnId: start.at }),
        }),
      );
      threadId = forked.thread.id;
    }
  }

  const startTurn: RuntimeSession["startTurn"] = (input) =>
    Effect.gen(function* () {
      if (dead) return yield* turnFailed("session-stopped");
      if (turn !== undefined) return yield* turnFailed("previous-turn-active");
      if (input.final && policy.outputSchema === undefined)
        return yield* turnFailed("no-output-schema");
      if (input.workspace === undefined)
        return yield* turnFailed("protocol-error");
      const settings = turnSettings(input.workspace, policy.approvalPolicy);
      const active: Turn = {
        id: input.turnId,
        final: input.final === true,
        configuration: settings.configuration,
        codexId: undefined,
        sent: false,
        started: yield* Deferred.make<string | undefined>(),
        interrupt: undefined,
        finished: false,
        lastError: undefined,
        lastText: undefined,
        baseline: undefined,
        retries: 0,
        approvals: new Map(),
        calls: new Map(),
        work: new Map(),
      };
      closedApprovals.clear();
      turn = active;
      emit({ type: "turn.started", turnId: active.id, at: now() });
      return yield* begin(
        active,
        { ...input, workspace: input.workspace },
        settings,
      ).pipe(
        // A caller that gives up still gets the turn's one ending. Before turn/start was written
        // nothing runs in Codex and the turn ends now; after it, the turn is interrupted like any
        // other, so no Codex turn is left running that Neuve does not track.
        Effect.onInterrupt(() =>
          active.sent
            ? interrupt(active, undefined)
            : finish(active, { status: "interrupted" }),
        ),
      );
    });
  const begin = (
    active: Turn,
    input: Parameters<RuntimeSession["startTurn"]>[0] & {
      readonly workspace: TurnWorkspace;
    },
    settings: ReturnType<typeof turnSettings>,
  ) =>
    Effect.gen(function* () {
      const ready = yield* ensure(settings.configuration, active).pipe(
        Effect.exit,
      );
      if (Exit.isFailure(ready)) {
        const error = errorOf(ready.cause);
        // No process is current after a failed hand-over, and the next turn starts over: the
        // session stays usable unless it was stopped.
        const disposition = dead ? "broken" : "reusable";
        return yield* finish(
          active,
          error?._tag === "RuntimeUnavailable" ||
            error?._tag === "SignInRequired" ||
            error?._tag === "AccountRejected"
            ? failure(runtimeErrorToFailure(error), disposition)
            : turnFailure("provider-failed", disposition),
        );
      }
      if (active.interrupt !== undefined)
        return yield* finish(active, {
          status: "interrupted",
          ...(active.interrupt.reason === undefined
            ? {}
            : { reason: active.interrupt.reason }),
        });
      if (!live(active))
        return yield* finish(active, turnFailure("session-stopped"));
      // The process died after it was made current and before the turn reached it.
      if (current === undefined || !current.connection.open()) {
        const ended = current;
        current = undefined;
        if (ended !== undefined) yield* closeScope(ended.scope);
        return yield* finish(
          active,
          failure({
            _tag: "RuntimeUnavailable",
            account,
            reason: "start-failed",
          }),
        );
      }
      const connection = current.connection;
      active.sent = true;
      turnSent = true;
      const answered = yield* connection
        .request("turn/start", {
          threadId,
          input: userInput(input.message),
          cwd: input.workspace.folder,
          approvalPolicy: settings.approvalPolicy,
          sandboxPolicy: settings.sandboxPolicy,
          ...(model === undefined
            ? {}
            : { model: model.id, effort: model.effort ?? null }),
          ...(active.final ? { outputSchema: policy.outputSchema! } : {}),
        })
        .pipe(Effect.exit);
      if (Exit.isFailure(answered)) {
        if (active.finished) return;
        const error = errorOf(answered.cause);
        return yield* finish(
          active,
          error === undefined
            ? turnFailure("provider-failed", "broken")
            : requestOutcome(error),
        );
      }
      const decoded = Decode.TurnAnswer.safeParse(answered.value);
      if (!decoded.success)
        return yield* finish(active, turnFailure("protocol-error", "broken"));
      active.codexId ??= decoded.data.turn.id;
      yield* Deferred.succeed(active.started, active.codexId);
    });

  /**
   * One mechanism for every interrupt: a deadline that starts when the interrupt arrives, and ends
   * the turn interrupted and stops the process if the turn has not ended by then, whatever Codex
   * has or has not answered. Beside it, `turn/interrupt` is sent as soon as Codex has named the turn.
   */
  const interrupt = (active: Turn, reason: InterruptReason | undefined) =>
    Effect.gen(function* () {
      if (active.finished || active.interrupt !== undefined) return;
      active.interrupt = { reason };
      const ending: TurnOutcome = {
        status: "interrupted",
        ...(reason === undefined ? {} : { reason }),
      };
      yield* Effect.sleep(options.interruptWait ?? "10 seconds").pipe(
        Effect.andThen(
          Effect.suspend(() => (active.finished ? Effect.void : stop(ending))),
        ),
        Effect.forkIn(sessionScope),
      );
      yield* Deferred.await(active.started).pipe(
        Effect.flatMap((codexId) =>
          codexId === undefined || active.finished || current === undefined
            ? Effect.void
            : current.connection
                .request("turn/interrupt", { threadId, turnId: codexId })
                .pipe(Effect.ignore),
        ),
        Effect.forkIn(sessionScope),
      );
    });
  const interruptTurn: RuntimeSession["interruptTurn"] = (input) =>
    Effect.suspend(() =>
      turn === undefined || turn.id !== input.turnId
        ? Effect.void
        : interrupt(turn, input.reason),
    );

  return {
    get nativeSessionId() {
      return threadId;
    },
    startTurn,
    steerTurn: (input) =>
      Effect.gen(function* () {
        const active = turn;
        if (active === undefined || active.id !== input.turnId || dead)
          return yield* turnFailed("session-stopped");
        const codexId = yield* Deferred.await(active.started);
        if (codexId === undefined || active.finished || current === undefined)
          return yield* turnFailed("session-stopped");
        yield* current.connection
          .request("turn/steer", {
            threadId,
            input: userInput(input.message),
            expectedTurnId: codexId,
          })
          .pipe(Effect.mapError(() => turnFailed("protocol-error")));
      }),
    interruptTurn,
    setModel: (next) =>
      Effect.sync(() => {
        model = next;
      }),
    respondToApproval: (input) =>
      Effect.gen(function* (): Effect.fn.Return<ApprovalDelivery> {
        const reason = closedApprovals.get(input.requestId);
        if (reason !== undefined) return { delivered: false, reason };
        const pending = turn?.approvals.get(input.requestId);
        if (
          !pending ||
          !(yield* Deferred.succeed(pending.decision, input.decision))
        )
          return { delivered: false };
        return yield* Deferred.await(pending.delivery);
      }),
    events: Stream.fromQueue(events),
  } satisfies RuntimeSession as RuntimeSession;
}) as (
  options: CodexSessionOptions,
) => Effect.Effect<RuntimeSession, RuntimeError, Scope.Scope | CodexProcess>;
