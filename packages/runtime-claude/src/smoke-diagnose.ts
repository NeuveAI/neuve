import type {
  Options,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  AccountRejectedReason,
  RuntimeUnavailableReason,
  TurnFailureReason,
  TurnLimit,
  TurnOutcome,
  type Account,
  type RuntimeEvent,
  type ToolDefinition,
} from "@neuve/runtime";
import { Cause, Effect, Logger, Stream } from "effect";
import { z } from "zod";
import { toolsFrameShape } from "./smoke-frame-shapes.ts";
import { messageCollector } from "./messages.ts";
import {
  frameShapeIssues,
  validFrame,
  protocolErrorSite,
  protocolErrorLine,
  protocolFrameShape,
} from "./protocol.ts";
import { point } from "./smoke-events.ts";
import { checkProbe } from "./smoke-checks.ts";
import {
  smokeOpenObservation,
  type SmokeOpenObservation,
} from "./smoke-open.ts";
import type { SmokeRuntime } from "./smoke-runtime.ts";

type FiredPath =
  | "validFrame"
  | "stampNotSent"
  | "emptyStampArray"
  | "resultWithoutPendingSend"
  | "replyWithoutTurn"
  | "publishedFrameAfterEnding";
const shape = (frame: SDKMessage): { type: string; subtype?: string } => {
  if (frame === null || typeof frame !== "object") return { type: "unknown" };
  const subtype =
    frame.type === "system" || frame.type === "result"
      ? frame.subtype
      : frame.type === "stream_event"
        ? frame.event?.type
        : undefined;
  return {
    type:
      typeof frame.type === "string"
        ? /^[a-z][a-z0-9_]{0,39}$/.test(frame.type)
          ? frame.type
          : "unrecognized"
        : "unknown",
    ...(typeof subtype === "string"
      ? {
          subtype: /^[a-z][a-z0-9_]{0,39}$/.test(subtype)
            ? subtype
            : "unrecognized",
        }
      : {}),
  };
};

type ObserverMethod =
  "begin" | "offered" | "receive" | "event" | "open" | "sdk";

const readSafely = <A>(read: () => A) => {
  try {
    return read();
  } catch {
    return undefined;
  }
};

const minimalOutcome = (
  event: Extract<RuntimeEvent, { type: "turn.finished" }>,
) => {
  const outcome = readSafely(() => event.outcome);
  const status = readSafely(() => outcome?.status);
  switch (status) {
    case "completed":
    case "interrupted":
      return { status };
    case "failed":
      return {
        status,
        reason: readSafely(() => {
          if (outcome?.status === "failed" && "reason" in outcome.failure)
            return failureReason.parse(outcome.failure.reason);
        }),
        disposition: readSafely(() => {
          if (outcome?.status === "failed")
            return TurnOutcome.options[2].shape.disposition.parse(
              outcome.disposition,
            );
        }),
      };
    default:
      return { status: "unknown" as const };
  }
};

export const diagnoseObservation = (options: { tools?: boolean } = {}) => {
  let protocolError:
    | {
        site: import("./protocol.ts").ProtocolErrorSite;
        frame: ReturnType<typeof protocolFrameShape>;
      }
    | undefined;
  const logger = Logger.make(({ message }) => {
    for (const line of Array.isArray(message) ? message : [message]) {
      if (typeof line !== "string") continue;
      const match =
        /^claude-runtime protocol-error site=([a-z-]+) frame=([a-z_]+)(?:\/([a-z_]+))?$/.exec(
          line,
        );
      if (match === null) continue;
      const site = protocolErrorSite.safeParse(match[1]);
      if (!site.success) continue;
      const frame = {
        type: match[2],
        subtype: match[3],
        event: { type: match[3] },
      };
      if (protocolErrorLine(site.data, frame) !== line) continue;
      protocolError ??= { site: site.data, frame: protocolFrameShape(frame) };
    }
  });
  let observerErrorIn: ObserverMethod | undefined;
  let totalRequestsStarted = 0;
  let totalRequestsCompleted = 0;
  let nextOutputFormat: Options["outputFormat"];
  let withholdSend = true;
  const contain =
    <Args extends unknown[], A>(
      method: ObserverMethod,
      action: (...args: Args) => A,
    ) =>
    (...args: Args) => {
      try {
        return action(...args);
      } catch {
        observerErrorIn ??= method;
        return undefined;
      }
    };
  let opens: SmokeOpenObservation[] = [];
  const openFields = () =>
    opens.length === 0
      ? {}
      : {
          opens: opens.map((open) => open.snapshot()),
          sendWithheld: opens.some((open) => open.sendWithheld),
        };
  let messages = messageCollector([]);
  let offered = new Set<string>();
  let pending = new Set<string>();
  let roots = new Set<string>();
  let active = false;
  let ending = false;
  let frames = 0;
  let requestsStarted = 0;
  let requestsCompleted = 0;
  let frameShapes = new Map<string, number>();
  let orderedFrames: Array<
    ReturnType<typeof faultShape> &
      ReturnType<typeof toolsFrameShape> & {
        valid: boolean;
        publishedTail: boolean;
        publishedFrame: boolean;
      }
  > = [];
  const frameFields = () => ({
    ...(options.tools
      ? { frames: [...orderedFrames], frameTotal: frames }
      : {}),
    ...(protocolError === undefined ? {} : { protocolError }),
  });
  let fault:
    | { path: FiredPath; index: number; frame: ReturnType<typeof faultShape> }
    | undefined;
  const faultShape = (frame: SDKMessage, path: FiredPath) => {
    const fields = frame !== null && typeof frame === "object" ? frame : {};
    const single =
      "user_message_uuid" in fields ? fields.user_message_uuid : undefined;
    const many =
      "user_message_uuids" in fields ? fields.user_message_uuids : undefined;
    const stamps = [
      ...(Array.isArray(many) ? many : []),
      ...(single === undefined ? [] : [single]),
    ];
    return {
      ...shape(frame),
      uuidPresent: "uuid" in fields,
      userMessageUuidPresent: "user_message_uuid" in fields,
      userMessageUuidsPresent: "user_message_uuids" in fields,
      userMessageUuidsCount: Array.isArray(many) ? many.length : 0,
      stampsMatchOffered: stamps.every(
        (stamp) => typeof stamp === "string" && offered.has(stamp),
      ),
      parentToolUseIdNull:
        "parent_tool_use_id" in fields && fields.parent_tool_use_id === null,
      ...(path === "validFrame"
        ? { shapeIssues: frameShapeIssues(frame) }
        : {}),
    };
  };
  const recordFault = (frame: SDKMessage, path: FiredPath) => {
    fault ??= { path, index: frames, frame: faultShape(frame, path) };
  };
  return {
    logger,
    get totalRequestsStarted() {
      return totalRequestsStarted;
    },
    get totalRequestsCompleted() {
      return totalRequestsCompleted;
    },
    schemaOnly: (schema: NonNullable<Options["outputFormat"]>["schema"]) => {
      nextOutputFormat = { type: "json_schema", schema };
    },
    prepareOpen: (options: Options) => {
      const outputFormat = nextOutputFormat;
      nextOutputFormat = undefined;
      return outputFormat === undefined
        ? options
        : { ...options, outputFormat };
    },
    shouldWithholdSend: () => withholdSend,
    allowNormalSend: () => {
      withholdSend = false;
    },
    observe: contain("sdk", (action: () => void) => action()),
    open: contain("open", (options: Options) => {
      const open = smokeOpenObservation(options);
      opens.push(open);
      return open;
    }),
    partial: () => {
      const read = <A>(action: () => A) => contain("event", action)();
      const fields = read(openFields);
      const shapes = read(() => Object.fromEntries(frameShapes));
      return {
        ...fields,
        ...frameFields(),
        observerError: observerErrorIn !== undefined,
        ...(observerErrorIn === undefined ? {} : { observerErrorIn }),
        frameShapes: shapes ?? {},
        requestsStarted,
        requestsCompleted,
      };
    },
    begin: contain("begin", () => {
      observerErrorIn = undefined;
      protocolError = undefined;
      withholdSend = true;
      nextOutputFormat = undefined;
      opens = [];
      offered = new Set();
      pending = new Set();
      roots = new Set();
      active = true;
      ending = false;
      frames = 0;
      requestsStarted = 0;
      requestsCompleted = 0;
      frameShapes = new Map();
      orderedFrames = [];
      fault = undefined;
      messages = messageCollector([]);
    }),
    toolPolicy: (tools: ReadonlyArray<ToolDefinition>) => {
      messages = messageCollector(tools);
    },
    handler: contain("event", (callId: string) => {
      // Streamed handlers leave publication to message_stop; only assistant-only replies complete here.
      messages.completeForTool(callId);
    }),
    offered: contain("offered", (message: SDKUserMessage) => {
      if (message.uuid !== undefined) {
        offered.add(message.uuid);
        pending.add(message.uuid);
      }
    }),
    receive: contain("receive", (frame: SDKMessage) => {
      frames++;
      if (options.tools && orderedFrames.length < 200)
        orderedFrames.push({
          ...faultShape(frame, "validFrame"),
          ...toolsFrameShape(frame),
          valid: validFrame(frame),
          publishedTail: messages.isPublishedTail(frame),
          publishedFrame: messages.isPublishedFrame(frame),
        });
      const { type, subtype } = shape(frame);
      const key = subtype === undefined ? type : `${type}:${subtype}`;
      frameShapes.set(key, (frameShapes.get(key) ?? 0) + 1);
      if (frame === null || typeof frame !== "object")
        return recordFault(frame, "validFrame");
      const id =
        frame.type === "assistant" && frame.parent_tool_use_id === null
          ? frame.message?.id
          : frame.type === "stream_event" &&
              frame.parent_tool_use_id === null &&
              frame.event?.type === "message_start"
            ? frame.event.message?.id
            : undefined;
      if (typeof id === "string" && !roots.has(id)) {
        roots.add(id);
        requestsStarted++;
        totalRequestsStarted++;
      }
      if (frame.type === "system" && frame.subtype === "api_retry") {
        requestsStarted++;
        totalRequestsStarted++;
      }
      if (!validFrame(frame)) return recordFault(frame, "validFrame");
      if (fault !== undefined) return;
      if (
        frame.type === "conversation_reset" ||
        (frame.type === "system" && frame.subtype === "init")
      ) {
        messages.receive(frame);
        return;
      }
      const publishedTail = messages.isPublishedTail(frame);
      const isReply =
        frame.type === "result" ||
        ((frame.type === "assistant" || frame.type === "stream_event") &&
          frame.parent_tool_use_id === null);
      if (isReply && (!ending || publishedTail)) {
        const stamps = [
          ...(frame.user_message_uuids ?? []),
          ...(frame.user_message_uuid === undefined
            ? []
            : [frame.user_message_uuid]),
        ];
        if (!active) return recordFault(frame, "replyWithoutTurn");
        if (frame.type === "result" && pending.size === 0)
          return recordFault(frame, "resultWithoutPendingSend");
        if (frame.user_message_uuids?.length === 0)
          return recordFault(frame, "emptyStampArray");
        if (stamps.some((stamp) => !offered.has(stamp)))
          return recordFault(frame, "stampNotSent");
      }
      if (publishedTail) {
        messages.receive(frame);
        return;
      }
      if (ending) {
        if (messages.isPublishedFrame(frame) || messages.isFurtherOutput(frame))
          recordFault(frame, "publishedFrameAfterEnding");
        return;
      }
      if (!active) {
        if (frame.type === "system" && frame.subtype === "api_retry")
          recordFault(frame, "replyWithoutTurn");
        return;
      }
      if (messages.isPublishedFrame(frame))
        return recordFault(frame, "publishedFrameAfterEnding");
      messages.receive(frame);
      if (frame.type === "result") {
        // Match the adapter's ordered drainage, including legacy aborted segments.
        const sends = [...pending];
        const consumed =
          frame.user_message_uuids !== undefined
            ? sends.findLastIndex((id) =>
                frame.user_message_uuids?.includes(id),
              ) + 1
            : frame.user_message_uuid !== undefined
              ? frame.queued_turn_count === undefined ||
                frame.queued_turn_count === 0
                ? sends.length
                : sends.lastIndexOf(frame.user_message_uuid) + 1
              : Math.max(
                  0,
                  sends.length -
                    (frame.queued_turn_count ??
                      (frame.terminal_reason === "aborted_streaming" ||
                      frame.terminal_reason === "aborted_tools"
                        ? Math.max(0, sends.length - 1)
                        : 0)),
                );
        for (const id of sends.slice(0, consumed)) pending.delete(id);
        ending = pending.size === 0;
      }
    }),
    event: (event: RuntimeEvent) => {
      try {
        if (event.type === "message.finished") {
          requestsCompleted++;
          totalRequestsCompleted++;
        }
        if (event.type !== "turn.finished") return undefined;
        const outcome = event.outcome;
        active = false;
        return {
          ...openFields(),
          ...frameFields(),
          observerError: observerErrorIn !== undefined,
          ...(observerErrorIn === undefined ? {} : { observerErrorIn }),
          outcome:
            outcome.status === "failed"
              ? {
                  status: outcome.status,
                  ...("reason" in outcome.failure
                    ? { reason: outcome.failure.reason }
                    : {}),
                  disposition: outcome.disposition,
                }
              : {
                  status: outcome.status,
                  ...(options.tools && outcome.status === "interrupted"
                    ? { reason: outcome.reason }
                    : {}),
                },
          firedPath:
            fault?.path ??
            (outcome.status === "failed" &&
            outcome.failure._tag === "TurnFailed" &&
            outcome.failure.reason === "protocol-error"
              ? "unclassified"
              : "none"),
          faultIsLastFrame: fault !== undefined && fault.index === frames,
          ...(fault === undefined ? {} : { faultingFrame: fault.frame }),
          frameShapes: Object.fromEntries(frameShapes),
          requestsStarted,
          requestsCompleted,
        };
      } catch {
        observerErrorIn ??= "event";
        const terminal = readSafely(() =>
          event.type === "turn.finished" ? event : undefined,
        );
        if (terminal === undefined) return undefined;
        active = false;
        return {
          ...readSafely(openFields),
          outcome: minimalOutcome(terminal),
          firedPath: "unclassified" as const,
          observerError: true,
          observerErrorIn: "event" as const,
          requestsStarted,
          requestsCompleted,
        };
      }
    },
  };
};

type DiagnoseStep =
  | "probe"
  | "freshFinal"
  | "schemaOnly"
  | "normalTurn"
  | "resumeOnly"
  | "resumeAtOnly"
  | "resumedFinal";
const failureReason = z.union([
  AccountRejectedReason,
  RuntimeUnavailableReason,
  TurnFailureReason,
]);

export const failureShape = (cause: Cause.Cause<unknown>) => {
  const failure = cause.reasons.find(Cause.isFailReason);
  const defect = cause.reasons.find(Cause.isDieReason);
  const error = failure === undefined ? defect?.defect : failure.error;
  const causeKind =
    failure !== undefined
      ? Cause.isTimeoutError(failure.error)
        ? "timeout"
        : "fail"
      : defect !== undefined
        ? "die"
        : "interrupt";
  const fields = error !== null && typeof error === "object" ? error : {};
  const tag = "_tag" in fields ? fields._tag : undefined;
  const reason = failureReason.safeParse(
    "reason" in fields ? fields.reason : undefined,
  );
  return {
    causeKind,
    ...(typeof tag === "string" && /^[a-z][a-z0-9_]{0,39}$/i.test(tag)
      ? { errorTag: tag }
      : {}),
    ...(reason.success ? { reason: reason.data } : {}),
  };
};

type TurnDiagnosis =
  | NonNullable<ReturnType<ReturnType<typeof diagnoseObservation>["event"]>>
  | (ReturnType<ReturnType<typeof diagnoseObservation>["partial"]> &
      ReturnType<typeof failureShape> & {
        outcome: "failed";
        step: DiagnoseStep;
      })
  | { skipped: "requestBudget" | "normalUnavailable" };

export const diagnoseRunState = () => {
  let step: DiagnoseStep = "probe";
  let probe:
    ReturnType<ReturnType<typeof diagnoseObservation>["partial"]> | undefined;
  const turns: Partial<
    Record<
      Exclude<DiagnoseStep, "probe" | "normalTurn"> | "normal",
      TurnDiagnosis
    >
  > = {};
  return {
    recordProbe: (value: NonNullable<typeof probe>) => {
      probe = value;
    },
    step: (next: DiagnoseStep) => {
      step = next;
    },
    record: (turn: keyof typeof turns, diagnosis: TurnDiagnosis) => {
      turns[turn] = diagnosis;
    },
    failure: (
      cause: Cause.Cause<unknown>,
      requestsStarted: number,
      requestsCompleted = 0,
    ) => ({
      mode: "diagnose" as const,
      outcome: "failed" as const,
      step,
      ...failureShape(cause),
      expectedRequests: 1,
      requestsStarted,
      requestsCompleted,
      withinPlan: requestsStarted <= 1,
      ...(probe === undefined ? {} : { probe }),
      ...(Object.keys(turns).length === 0 ? {} : { turns }),
    }),
  };
};

export const diagnoseSmoke = (
  runtime: SmokeRuntime,
  account: Account,
  observation: ReturnType<typeof diagnoseObservation>,
  state = diagnoseRunState(),
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const failed = (step: DiagnoseStep) => (cause: Cause.Cause<unknown>) =>
        Effect.sync(() => ({
          outcome: "failed" as const,
          step,
          ...failureShape(cause),
          ...observation.partial(),
        }));
      state.step("probe");
      observation.begin();
      const probe = yield* checkProbe(runtime, account).pipe(
        Effect.catchCause(failed("probe")),
        Effect.onExit(() =>
          Effect.sync(() => state.recordProbe(observation.partial())),
        ),
      );
      const probeDiagnosis = observation.partial();
      const policy = {
        systemPrompt: "Return the requested structured response.",
        tools: [],
        turnLimit: TurnLimit.parse(1),
        approvalPolicy: "allow" as const,
        outputSchema: z
          .record(z.string(), z.json())
          .parse(z.toJSONSchema(z.strictObject({ ok: z.boolean() }))),
      };
      type Session = Effect.Success<ReturnType<SmokeRuntime["openSession"]>>;
      const run = (session: Session, final: boolean, step: DiagnoseStep) =>
        Effect.gen(function* () {
          yield* session.startTurn({
            turnId: `smoke-diagnose-${step}`,
            message: final ? "Return ok as true." : "Reply briefly.",
            ...(final ? { final: true } : {}),
          });
          const events: RuntimeEvent[] = [];
          const diagnoses = yield* Stream.runCollect(
            session.events.pipe(
              Stream.takeUntil((event) => event.type === "turn.finished"),
              Stream.map((event) => {
                events.push(event);
                return observation.event(event);
              }),
              Stream.filter((diagnosis) => diagnosis !== undefined),
            ),
          );
          const diagnosis = diagnoses[0];
          if (diagnosis === undefined)
            return yield* Effect.die("Missing turn.finished");
          return { diagnosis, at: point(events) };
        });
      state.step("freshFinal");
      observation.begin();
      const freshFinal = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* runtime.openSession(account, policy, {
            kind: "new",
          });
          return (yield* run(session, true, "freshFinal")).diagnosis;
        }),
      ).pipe(Effect.catchCause(failed("freshFinal")));
      state.record("freshFinal", freshFinal);
      state.step("schemaOnly");
      observation.begin();
      const schemaOnly = yield* Effect.scoped(
        Effect.gen(function* () {
          observation.schemaOnly(policy.outputSchema);
          const session = yield* runtime.openSession(account, policy, {
            kind: "new",
          });
          return (yield* run(session, false, "schemaOnly")).diagnosis;
        }),
      ).pipe(Effect.catchCause(failed("schemaOnly")));
      state.record("schemaOnly", schemaOnly);
      const resumed = yield* Effect.scoped(
        Effect.gen(function* () {
          state.step("normalTurn");
          observation.begin();
          observation.allowNormalSend();
          const normalResult = yield* Effect.gen(function* () {
            const session = yield* runtime.openSession(account, policy, {
              kind: "new",
            });
            const { diagnosis: normal, at } = yield* run(
              session,
              false,
              "normalTurn",
            );
            return { session, normal, at };
          }).pipe(
            Effect.catchCause((cause) =>
              failed("normalTurn")(cause).pipe(
                Effect.map((normal) => ({
                  session: undefined,
                  normal,
                  at: undefined,
                })),
              ),
            ),
          );
          const { normal, session, at } = normalResult;
          state.record("normal", normal);
          if (normal.requestsStarted > 1)
            return {
              normal,
              resumeOnly: { skipped: "requestBudget" as const },
              resumeAtOnly: { skipped: "requestBudget" as const },
              resumedFinal: { skipped: "requestBudget" as const },
            };
          if (session === undefined)
            return {
              normal,
              resumeOnly: { skipped: "normalUnavailable" as const },
              resumeAtOnly: { skipped: "normalUnavailable" as const },
              resumedFinal: { skipped: "normalUnavailable" as const },
            };
          const resume = (step: "resumeOnly" | "resumeAtOnly") => {
            state.step(step);
            observation.begin();
            return Effect.scoped(
              Effect.gen(function* () {
                const resumedSession = yield* runtime.openSession(
                  account,
                  policy,
                  {
                    kind: "resume",
                    session: session.nativeSessionId,
                    ...(step === "resumeAtOnly" && at !== undefined
                      ? { at }
                      : {}),
                    fork: false,
                  },
                );
                return (yield* run(resumedSession, false, step)).diagnosis;
              }),
            ).pipe(Effect.catchCause(failed(step)));
          };
          const resumeOnly = yield* resume("resumeOnly");
          state.record("resumeOnly", resumeOnly);
          const resumeAtOnly =
            at === undefined
              ? { skipped: "normalUnavailable" as const }
              : yield* resume("resumeAtOnly");
          state.record("resumeAtOnly", resumeAtOnly);
          state.step("resumedFinal");
          observation.begin();
          const resumedFinal = yield* run(session, true, "resumedFinal").pipe(
            Effect.map((result) => result.diagnosis),
            Effect.catchCause(failed("resumedFinal")),
          );
          return { normal, resumeOnly, resumeAtOnly, resumedFinal };
        }),
      );
      state.record("resumeOnly", resumed.resumeOnly);
      state.record("resumeAtOnly", resumed.resumeAtOnly);
      state.record("resumedFinal", resumed.resumedFinal);
      const requestsStarted = observation.totalRequestsStarted;
      return {
        mode: "diagnose" as const,
        probe: {
          ...("counts" in probe ? probe.counts : probe),
          ...probeDiagnosis,
        },
        turns: { freshFinal, schemaOnly, ...resumed },
        requestsStarted,
        requestsCompleted: observation.totalRequestsCompleted,
        expectedRequests: 1,
        withinPlan: requestsStarted <= 1,
      };
    }),
  ).pipe(
    Effect.provide(
      Logger.layer([observation.logger], { mergeWithExisting: true }),
    ),
  );
