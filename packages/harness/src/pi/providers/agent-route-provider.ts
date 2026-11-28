import { logTimed } from "../../log-span.ts";
import {
  ClaudeSubscriptionTokenRefused,
  isClaudeSubscriptionToken,
} from "../../subscription-token.ts";
import { CallTelemetry } from "../../call-telemetry.ts";
import type { RunLog } from "../../run-log.ts";
import { tokensOf } from "../capture/usage.ts";
import {
  sdkContextSnapshot,
  sdkInvocationTracker,
} from "../capture/retained-context.ts";
import { rememberEphemeralCredentials } from "../capture/safety.ts";
import { randomUUID } from "node:crypto";
import {
  eventEvidence,
  refusalEvidence,
  historicalEvidence,
  type CredentialCapture,
} from "./credential-evidence.ts";
import { routeModel } from "./route-model.ts";
import { retryAfterAt } from "./retry-admission.ts";
import type { RouteAdmission } from "./route-admission.ts";
export { routeModel } from "./route-model.ts";
import { observeResponse, readRefusal } from "./response-observer.ts";
import {
  createModels,
  createProvider,
  isContextOverflow,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
  type MutableModels,
  type Provider,
  type ProviderStreams,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type {
  ConversationId,
  HarnessSettings,
} from "@earendil-works/pi-durable";
import { CallCapture } from "./capture-write.ts";
import {
  stream as anthropicMessages,
  type AnthropicOptions,
} from "@earendil-works/pi-ai/api/anthropic-messages";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import {
  stream as openAiResponses,
  type OpenAIResponsesOptions,
} from "@earendil-works/pi-ai/api/openai-responses";
import {
  OpenAiAuthError,
  accessToken,
  rejectedToken,
  signInProblem,
  type AuthOptions,
} from "../../openai-auth.ts";
import { requireDirectRoute, routeCredentialVariable } from "../../route.ts";
import type {
  AnthropicRouteConfig,
  AnyRouteConfig,
  OpenAiRouteConfig,
  RouteEffort,
} from "../../route.ts";
import {
  CaptureFailed,
  CapturedEvent,
  CaptureScope as CaptureScopeSchema,
  AuxiliaryPurpose,
  Json,
  type CaptureScope,
  type ModelCapture,
  type SdkInvocation,
  type ModelCaptureEvent,
  RequestBody,
} from "../capture/types.ts";
import type { AgentRouteBinding, AgentRouteMode } from "../contracts.ts";
import {
  REASONING_STALL_MS,
  STREAM_STALLED,
  STREAM_STALL_MS,
  StreamStall,
  TOOL_NAMESPACE,
  conversationId,
  errorOf,
  isObject,
  prepareToolArguments,
  safetyBufferingOf,
  toStrictSchema,
  watchForStall,
  type StallLimits,
  type StallPhase,
} from "./wire.ts";
import {
  captureRouteFailure,
  refusalKind,
  routeFailureDiagnostic,
  schedulerText,
  streamEndedNearContextLimit,
  type RouteFailure,
} from "./failure.ts";

/**
 * A Neuve route as a native pi provider (0008, 10.85), in two registrations over one transport:
 *
 * - **A review agent conversation** (`createAgentRouteProvider`), registered through
 *   `Models.setProvider` under the conversation's stable logical provider. Its one model keeps the
 *   physical route's model ID, window and output cap, so pi's transcript names the logical provider
 *   and the physical model, and normal and final generation share one model identity: pi replays
 *   reasoning, text signatures and tool call IDs only within an identity (`transformMessages`).
 *   Every call reads the runtime's binding before anything is sent. The binding names the run,
 *   stage, agent and conversation the call is captured under and whether this is the final
 *   generation. A binding that is missing, or names another logical provider or physical route,
 *   fails the call.
 * - **A coding session** (`createRouteModels`), registered under the physical provider's own ID.
 *   Its calls are captured under the session as the run, with the agent and conversation only
 *   where the host knows them; pi stores each call's response ID on its turn, which joins the rest.
 *
 * What a call is sent and captured under is its `Dispatch`; everything else is the same transport.
 *
 * Each provider streams through pi-ai's own adapter (`openai-responses`, `anthropic-messages`) and
 * reshapes only the request body, in `onPayload`, to the wire the route already runs on:
 *
 * - **OpenAI, the ChatGPT plan.** The public Responses API, the Neuve sign-in's access token per
 *   call (`accessToken`, so the sign-in folder or the token command keeps every refresh), and the
 *   request `buildRequest` sends: `store: false`, `stream: true`, the system prompt as
 *   `instructions`, no `previous_response_id`, no output cap and no prompt-cache field, the tools in
 *   the `neuve` namespace with strict ones in OpenAI's strict subset, reasoning replayed with its
 *   encrypted content and an empty summary, assistant text with its `phase`, `context: all_turns`,
 *   and the agent conversation's `session-id` header. Stalls are aborted as in `watchForStall`.
 * - **Anthropic.** The key from the route's variable, resolved per request; the output cap, the
 *   route's effort, the system block's 1-hour cache breakpoint and top-level automatic caching, as
 *   agent.ts's request transform sends them.
 *
 * The adapters branch on the provider ID in a few places. Under the logical ID, pi's ChatGPT
 * sign-in check sees another provider and keeps the prompt-cache and sampling fields, which
 * `toRouteRequest` drops anyway; Anthropic's workload federation needs a resolved key to be absent,
 * which the route's auth never allows. The wire is the physical route's, under a logical ID and
 * under the physical one a coding session registers.
 *
 * Capture retries its writes and records any loss separately. Credential safety failures stop the call.
 * A body that is not a JSON string is sent and recorded as missing, with the reason.
 */

export interface RouteTransportOptions {
  readonly route: AnyRouteConfig;
  /** The Neuve sign-in's folder or token command; tests point them at scratch ones. */
  readonly auth?: AuthOptions | undefined;
  readonly baseUrl?: string | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly log?: RunLog | undefined;
  readonly capture: ModelCapture;
  readonly retry?: HarnessSettings["retry"] | undefined;
  readonly credentialInspection: CredentialCapture;
  /** The OpenAI route's stall limits; tests shorten them. */
  readonly stallLimits?: StallLimits | undefined;
  readonly admission?: RouteAdmission | undefined;
}

export interface AgentRouteProviderOptions extends RouteTransportOptions {
  /** The provider ID pi routes this agent conversation by; the same for normal and final generation. */
  readonly logicalProvider: string;
  /** The runtime's committed binding of this logical provider, read at every dispatch. */
  readonly readBinding: () => Promise<AgentRouteBinding>;
}

interface CodingRouteOptions extends RouteTransportOptions {
  /** The coding session (the channel's ID): every call's capture `runId`. */
  readonly runId: string;
  /** The agent every call belongs to, only when the host knows it; never a stand-in name. */
  readonly agent?: string | undefined;
  /**
   * The session's stable prompt-cache key. The OpenAI route's `session-id` is its name-based UUID
   * with `runId`, so the same key after a restart keeps the cache and the key never reaches the wire.
   */
  readonly sessionAffinity: string;
}

/** A declared caption or recap always names its actual native conversation. */
export type RouteModelsOptions = CodingRouteOptions &
  (
    | {
        readonly purpose?: undefined;
        readonly conversationId?: ConversationId | undefined;
      }
    | {
        readonly purpose: "caption" | "recap";
        readonly conversationId: ConversationId;
      }
  );

/**
 * What one call is sent and captured under: a review conversation's binding as read at dispatch,
 * or a coding session's fixed identity.
 */
interface Dispatch {
  readonly scope: CaptureScope;
  /**
   * What the call's route telemetry rows name: the capture scope, except that a briefing's calls,
   * bound as Verify, are counted as their own stage. The capture journal keeps `scope`.
   */
  readonly telemetry: CaptureScope;
  readonly purpose?: "caption" | "recap" | undefined;
  readonly mode: AgentRouteMode;
  readonly effortPolicy: "fixed" | "selectable";
  /** The review conversation's logical provider; a coding session's calls have none. */
  readonly logicalProvider?: string | undefined;
  /** The OpenAI route's `session-id` header, which its prompt cache follows. */
  readonly sessionId: string;
  /** The OpenAI route's description of the tool namespace, as the model reads it. */
  readonly toolsDescription: string;
}

type DispatchOf = (model: Model<Api>) => Promise<Dispatch>;

const routeProvider = (
  options: RouteTransportOptions,
  id: string,
  dispatchOf: DispatchOf,
): Provider => {
  const route = requireDirectRoute(options.route);
  return route.provider === "openai"
    ? openAiProvider(route, options, id, dispatchOf)
    : anthropicProvider(route, options, id, dispatchOf);
};

/** The provider to register with `Models.setProvider` for one agent conversation. */
export const createAgentRouteProvider = (
  options: AgentRouteProviderOptions,
): Provider =>
  routeProvider(options, options.logicalProvider, async (model) => {
    const binding = await readBinding(options, model);
    const scope = {
      runId: binding.runId,
      stage: binding.stage,
      agent: binding.agent,
      conversationId: binding.conversationId,
    };
    return {
      scope,
      telemetry:
        binding.reading?.kind === "brief"
          ? { ...scope, stage: "brief" }
          : scope,
      mode: binding.mode,
      effortPolicy: "fixed",
      logicalProvider: binding.logicalProvider,
      sessionId: conversationId(binding.runId, binding.agent),
      toolsDescription: "Neuve's review tools.",
    };
  });

/** A coding session's `Models`: the route alone, under its physical provider's ID. */
export const createRouteModels = (
  options: RouteModelsOptions,
  models = createModels(),
): MutableModels => {
  requireDirectRoute(options.route);
  if (options.purpose !== undefined) {
    AuxiliaryPurpose.parse(options.purpose);
    CaptureScopeSchema.required({ conversationId: true }).parse({
      runId: options.runId,
      conversationId: options.conversationId,
    });
  }
  const scope: CaptureScope = {
    runId: options.runId,
    ...(options.agent === undefined ? {} : { agent: options.agent }),
    ...(options.conversationId === undefined
      ? {}
      : { conversationId: options.conversationId }),
  };
  const dispatch: Dispatch = {
    purpose: options.purpose,
    scope,
    telemetry: scope,
    mode: { kind: "normal" },
    effortPolicy: "selectable",
    sessionId: conversationId(options.runId, options.sessionAffinity),
    toolsDescription: "Neuve's tools.",
  };
  models.setProvider(
    routeProvider(options, options.route.provider, async () => dispatch),
  );
  return models;
};

/**
 * The route's tool argument preparation, for the host to compose into each tool's
 * `prepareArguments` before the tool's own repair. Only the OpenAI plan's route has its model write
 * nulls for optional properties it leaves out; on Anthropic a null stays for validation to judge.
 */
export const routeToolArguments = (route: AnyRouteConfig) =>
  route.provider === "openai" ? prepareToolArguments : undefined;

// One call's lifecycle, shared by both providers

type JsonObject = Record<string, unknown>;

const messageOf = (cause: unknown) =>
  cause instanceof CaptureFailed
    ? `${cause.kind}: ${cause.detail}`
    : cause instanceof Error
      ? cause.message
      : String(cause);

/** A failure the provider reported: an HTTP answer, or an error event inside the stream. */
interface Failure {
  readonly status?: number | undefined;
  readonly code?: string | undefined;
  readonly message?: string | undefined;
  readonly requestId?: string | undefined;
  readonly retryAfterAt?: number | undefined;
}

/** A function call as the provider sent it, before pi parses its arguments. */
interface RawCall {
  readonly callId: string;
  readonly itemId: string | undefined;
  readonly name: string;
  readonly arguments: string;
}

/** A function call item the provider finished, with the argument string it wrote. */
const rawCallOf = (event: JsonObject): RawCall | undefined => {
  const item = event["item"];
  if (
    event["type"] !== "response.output_item.done" ||
    !isObject(item) ||
    item["type"] !== "function_call" ||
    typeof item["call_id"] !== "string" ||
    typeof item["name"] !== "string" ||
    typeof item["arguments"] !== "string"
  )
    return undefined;
  return {
    callId: item["call_id"],
    itemId: typeof item["id"] === "string" ? item["id"] : undefined,
    name: item["name"],
    arguments: item["arguments"],
  };
};

interface Call {
  readonly telemetry: CallTelemetry;
  readonly id: string;
  readonly scope: CaptureScope;
  readonly capture: ModelCapture;
  readonly captureWrites: CallCapture;
  captureSignal?: AbortSignal | undefined;
  readonly credentialInspection: CredentialCapture;
  sdkContext?: ReturnType<typeof sdkContextSnapshot>;
  sdkInvocation?: ReturnType<typeof sdkInvocationTracker>;
  signal?: AbortSignal | undefined;
  readonly rawCalls: Array<RawCall>;
  /** Whether `model.request` was recorded; nothing else is recorded for a call without it. */
  requested: boolean;
  /** The response's status and safety-buffering headers, held until `model.response` is recorded. */
  answer?: {
    readonly status: number;
    readonly buffering: Record<string, string> | undefined;
  };
  responded: boolean;
  credentials?: Headers;
  captureFailure?: Failed;
  credentialGuard?: boolean;
  failure?: Failure;
  requestId?: string;
}

/** Check credential safety before attempting to write an event. */
const record = async (call: Call, event: ModelCaptureEvent) => {
  try {
    const evidence = eventEvidence(
      Json.parse(JSON.parse(JSON.stringify(event))),
      call.credentials ?? new Headers(),
    );
    let data = evidence.data;
    if (call.credentialInspection !== "ephemeral") {
      const historical = await historicalEvidence(
        data,
        call.credentialInspection,
        (epochs) => {
          for (const callId of epochs)
            call.capture({
              type: "credential.guard",
              scope: { runId: call.scope.runId },
              callId,
              status: "exposed",
            });
        },
        call.signal,
        call.captureWrites.lostRegistration,
      );
      data = historical.data;
    }
    const kept = CapturedEvent.parse(data);
    if (
      kept.type !== "model.request" &&
      kept.type !== "model.response" &&
      kept.type !== "model.event" &&
      kept.type !== "model.end"
    )
      throw new Error("credential exclusion changed a capture event identity");
    await call.captureWrites.write(kept, call.captureSignal);
    if (evidence.bodyRedactions.length > 0)
      await call.captureWrites.write(
        {
          type: "model.event",
          scope: call.scope,
          callId: call.id,
          name: "credential_redactions",
          data: { name: event.type, bodyRedactions: evidence.bodyRedactions },
        },
        call.captureSignal,
      );
  } catch (cause) {
    throw captureFailed(
      call,
      event.type === "model.event" ? `model.event ${event.name}` : event.type,
      cause,
    );
  }
};

const rememberCaptureFailure = (call: Call, what: string, cause: unknown) =>
  (call.captureFailure ??= captureLost(
    refusalEvidence(
      `capture failed: ${what} was not recorded: ${messageOf(cause)}`,
      call.credentials ?? new Headers(),
    ).body,
    cause,
  ));

const captureFailed = (call: Call, what: string, cause: unknown) =>
  new Error(rememberCaptureFailure(call, what, cause).failure.detail);

const recordEvent = async (call: Call, name: string, data: unknown) => {
  call.telemetry.event(name, data);
  let parsed: Json;
  try {
    const evidence = eventEvidence(
      Json.parse(data),
      call.credentials ?? new Headers(),
    );
    parsed = evidence.data;
    if (evidence.bodyRedactions.length > 0)
      await record(call, {
        type: "model.event",
        scope: call.scope,
        callId: call.id,
        name: "credential_redactions",
        data: { name, bodyRedactions: evidence.bodyRedactions },
      });
  } catch (cause) {
    throw captureFailed(call, `model.event ${name}`, cause);
  }
  await record(call, {
    type: "model.event",
    scope: call.scope,
    callId: call.id,
    name,
    data: parsed,
  });
};

/** Check the assembled native copy before pi can persist it; keep only a non-secret refusal fact. */
const inspectNativeCredentials = async (
  call: Call,
  message: AssistantMessage,
) => {
  if (call.credentialInspection !== "ephemeral") {
    await historicalEvidence(
      Json.parse(JSON.parse(JSON.stringify(message))),
      call.credentialInspection,
      (epochs) => {
        for (const callId of epochs)
          call.capture({
            type: "credential.guard",
            scope: { runId: call.scope.runId },
            callId,
            status: "exposed",
          });
      },
      call.signal,
      call.captureWrites.lostRegistration,
    );
  }
  const evidence = eventEvidence(
    Json.parse(JSON.parse(JSON.stringify(message))),
    call.credentials ?? new Headers(),
  );
  if (evidence.bodyRedactions.length > 0)
    await record(call, {
      type: "model.event",
      scope: call.scope,
      callId: call.id,
      name: "credential_redactions",
      data: { name: "native-message", bodyRedactions: evidence.bodyRedactions },
    });
};

/**
 * Records `model.response` once the response has headers: at its first stream event, with the
 * response ID when that event opens the response, or when the call settles without one.
 */
const respond = async (call: Call, responseId?: string) => {
  if (call.answer === undefined || call.responded) return;
  call.responded = true;
  await record(call, {
    type: "model.response",
    scope: call.scope,
    callId: call.id,
    status: call.answer.status,
    ...(call.requestId === undefined ? {} : { requestId: call.requestId }),
    ...(responseId === undefined ? {} : { responseId }),
  });
  if (call.answer.buffering !== undefined)
    await recordEvent(call, "safety_buffering", call.answer.buffering);
};

/** The response ID an opening event names: OpenAI's `response.created`, Anthropic's `message_start`. */
const openedResponseId = (event: JsonObject) => {
  const opened =
    event["type"] === "response.created"
      ? event["response"]
      : event["type"] === "message_start"
        ? event["message"]
        : undefined;
  return isObject(opened) && typeof opened["id"] === "string"
    ? opened["id"]
    : undefined;
};

/** The body as sent, or why it cannot be read; it is never rebuilt from what pi was given. */
const requestBody = (body: unknown): RequestBody => {
  if (typeof body !== "string")
    return {
      status: "missing",
      reason: `the request body is ${body === undefined || body === null ? "absent" : "not a string"}`,
    };
  try {
    return { status: "sent", json: Json.parse(JSON.parse(body)) };
  } catch (cause) {
    return {
      status: "missing",
      reason: `the request body is not JSON: ${messageOf(cause)}`,
    };
  }
};

/** The provider's message for a reported failure: its code, status and request ID, its text capped. */
const describe = (label: string, failure: Failure) =>
  `${label} (${failure.status === undefined ? "stream" : `HTTP ${failure.status}`}${failure.code === undefined ? "" : `, ${failure.code}`})${failure.message === undefined ? "" : `: ${failure.message.slice(0, 300)}`}${failure.requestId === undefined ? "" : ` (request ${failure.requestId})`}`;

/**
 * The fetch one call sends through: the request recorded before it goes out (and not sent when it
 * cannot be), no redirects, the response status captured, and a refused answer's complete body
 * recorded before the SDK receives those same bytes.
 */
const observedFetch = (
  base: typeof globalThis.fetch,
  call: Call,
  target: {
    readonly route: AnyRouteConfig;
    readonly model: Model<Api>;
    readonly dispatch: Dispatch;
  },
  requestIdOf: (headers: Headers) => string | undefined,
  onHeaders: (response: Response) => void,
  observe?: (name: string, data: unknown) => void | Promise<void>,
  admission?: RouteAdmission,
  touch?: (next: StallPhase) => void,
  authorize?: (
    headers: Headers,
    signal: AbortSignal | undefined,
  ) => Promise<void>,
) =>
  (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    const signal =
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (admission !== undefined) {
      touch?.("admission");
      await admission.wait(signal);
      await authorize?.(headers, signal);
      touch?.("headers");
    }
    init = { ...init, headers };
    call.credentials = headers;
    call.signal = signal ?? undefined;
    call.captureSignal = call.signal;
    const authenticated = [...headers].some(
      ([name, value]) =>
        /authorization|api[-_]?key|cookie/i.test(name) && value !== "",
    );
    if (authenticated && call.credentialInspection !== "ephemeral") {
      try {
        await call.captureWrites.register(
          call.scope,
          call.id,
          call.credentialInspection,
          headers,
          call.captureSignal,
        );
      } catch (cause) {
        throw captureFailed(call, "credential registration", cause);
      }
    }
    await record(call, {
      type: "model.request",
      scope: call.scope,
      callId: call.id,
      ...(target.dispatch.purpose === undefined
        ? {}
        : { purpose: target.dispatch.purpose }),
      route: target.route.provider,
      provider: target.route.provider,
      model: target.route.model,
      ...(target.dispatch.logicalProvider === undefined
        ? {}
        : { logicalRoute: target.dispatch.logicalProvider }),
      ...(call.sdkContext === undefined ? {} : { sdkContext: call.sdkContext }),
      api: target.model.api,
      path: url.pathname,
      headerNames: [...new Headers(init?.headers).keys()].sort(),
      credentialCoverage: [...headers].some(
        ([name, value]) =>
          /authorization|api[-_]?key|cookie/i.test(name) && value !== "",
      )
        ? "required"
        : "none",
      body: RequestBody.parse(
        eventEvidence(Json.parse(requestBody(init?.body)), headers).data,
      ),
    });
    call.requested = true;
    call.credentialGuard = [...headers].some(
      ([name, value]) =>
        /authorization|api[-_]?key|cookie/i.test(name) && value !== "",
    );
    if (call.credentialGuard) {
      if (call.credentialInspection === "ephemeral")
        try {
          await rememberEphemeralCredentials(
            call.capture,
            call.scope.runId,
            call.id,
            headers,
          );
        } catch (cause) {
          throw captureFailed(call, "credential registration", cause);
        }
      await recordEvent(call, "credential_guard", { status: "pending" });
    }
    const requestEvidence = eventEvidence(
      Json.parse(requestBody(init?.body)),
      headers,
    );
    if (requestEvidence.bodyRedactions.length > 0)
      await recordEvent(call, "credential_redactions", {
        name: "model.request",
        bodyRedactions: requestEvidence.bodyRedactions,
      });
    signal?.throwIfAborted();
    call.telemetry.sent();
    let response = await base(input, { ...init, redirect: "error" });
    call.telemetry.headers();
    const receivedAt = Date.now();
    try {
      onHeaders(response);
      const requestId = requestIdOf(response.headers);
      if (requestId !== undefined) call.requestId = requestId;
      const safeHeaders = new Headers(response.headers);
      for (const [name, value] of response.headers) {
        if (!name.startsWith("x-codex-safety-buffering-")) continue;
        const evidence = refusalEvidence(value, headers);
        safeHeaders.set(name, evidence.body);
        if (evidence.bodyRedactions.length > 0)
          await recordEvent(call, "credential_redactions", {
            name: "safety_buffering",
            bodyRedactions: evidence.bodyRedactions,
          });
      }
      call.answer = {
        status: response.status,
        buffering: safetyBufferingOf(safeHeaders),
      };
      if (!response.ok) {
        admission?.observe(response.headers.get("retry-after"), receivedAt);
        await respond(call);
        const refusal = await readRefusal(response, (cause) => {
          if (init?.signal?.aborted === true) throw cause;
          return captureFailed(call, "HTTP error body", cause);
        });
        response = refusal.response;
        const evidence = refusalEvidence(
          refusal.text,
          new Headers(init?.headers),
        );
        const text = evidence.body;
        let parsed: unknown;
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          parsed = undefined;
        }
        const error = errorOf(parsed);
        call.failure = {
          status: response.status,
          requestId,
          retryAfterAt: retryAfterAt(
            response.headers.get("retry-after"),
            receivedAt,
          ),
          ...error,
        };
        await recordEvent(call, "http_error", {
          status: response.status,
          code: error.code ?? null,
          retryAfter: response.headers.get("retry-after"),
          ...evidence,
        });
      }
    } catch (cause) {
      await response.body?.cancel().catch(() => undefined);
      throw cause;
    }
    return response.ok && observe !== undefined
      ? observeResponse(
          response,
          observe,
          (cause) => captureFailed(call, "provider event", cause),
          signal,
        )
      : response;
  }) as typeof globalThis.fetch;

/**
 * The function call as the provider wrote it beside the arguments pi parsed and replays: pi sends
 * `JSON.stringify(arguments)` back, not the provider's string, so the two are kept for comparison.
 */
const recordArguments = async (call: Call, message: AssistantMessage) => {
  for (const raw of call.rawCalls) {
    const parsed = message.content.find(
      (block) =>
        block.type === "toolCall" && block.id.split("|")[0] === raw.callId,
    );
    const args = parsed?.type === "toolCall" ? parsed.arguments : undefined;
    const replay = args === undefined ? null : JSON.stringify(args);
    await recordEvent(call, "function_call.arguments", {
      callId: raw.callId,
      itemId: raw.itemId ?? null,
      name: raw.name,
      raw: raw.arguments,
      arguments: args ?? null,
      replay,
      replayMatchesRaw: replay === raw.arguments,
    });
  }
};

const DONE = new Set(["stop", "length", "toolUse", "deferred"]);

/** An assistant message for a call that failed before the provider's stream produced one. */
const failedMessage = (model: Model<Api>): AssistantMessage => ({
  role: "assistant",
  content: [],
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "error",
  timestamp: Date.now(),
});

const outcomeOf = (message: AssistantMessage) =>
  DONE.has(message.stopReason)
    ? "completed"
    : message.stopReason === "aborted"
      ? "aborted"
      : "failed";

/**
 * How a call failed: the route's failure with its full detail, the capture's error type, and for a
 * sign-in whether a later attempt may work.
 */
interface Failed {
  readonly failure: RouteFailure & { readonly detail: string };
  readonly type: string;
  readonly transient?: boolean;
}

const captureLost = (detail: string, cause: unknown): Failed => ({
  failure: captureRouteFailure(detail, cause),
  type: "capture",
});

class RouteBindingError extends Error {}
class RouteEffortError extends Error {}

const effortOf = (
  route: AnyRouteConfig,
  dispatch: Dispatch,
  requested: string | undefined,
): RouteEffort => {
  if (dispatch.effortPolicy === "fixed" || requested === undefined)
    return route.effort;
  if (requested === "low" || requested === "medium" || requested === "high")
    return requested;
  throw new RouteEffortError(
    `unsupported route effort ${requested}; choose low, medium or high`,
  );
};

/** The runtime's binding for this dispatch, refused unless it names this provider's route. */
const readBinding = async (
  options: AgentRouteProviderOptions,
  model: Model<Api>,
) => {
  let binding: AgentRouteBinding;
  try {
    binding = await options.readBinding();
  } catch (cause) {
    throw new RouteBindingError(
      `agent route binding unavailable for ${options.logicalProvider}: ${messageOf(cause)}`,
    );
  }
  const mismatched = [
    binding.logicalProvider === options.logicalProvider
      ? undefined
      : `logical provider ${binding.logicalProvider}`,
    binding.physicalProvider === options.route.provider
      ? undefined
      : `physical provider ${binding.physicalProvider}`,
    binding.physicalModel === options.route.model &&
    model.id === binding.physicalModel
      ? undefined
      : `physical model ${binding.physicalModel}`,
  ].filter((part) => part !== undefined);
  if (mismatched.length > 0)
    throw new RouteBindingError(
      `agent route binding for ${options.logicalProvider} names ${mismatched.join(", ")}, not this route`,
    );
  return binding;
};

const finalSchemaOf = (dispatch: Dispatch) =>
  dispatch.mode.kind === "final" ? dispatch.mode.schema : undefined;

type Open = (
  call: Call,
  signal: AbortSignal,
  touch: (next: StallPhase) => void,
) => AssistantMessageEventStream;

/**
 * Runs one call: `prepare` reads the dispatch and resolves what the request needs, then `open` starts
 * pi's stream under the stall watch when `limits` is given. The caller's stream gets pi's events as
 * they come and one terminal event that tells a stall, a cancellation, a provider failure and a
 * capture failure apart.
 */
const runCall = (input: {
  readonly log?: RunLog | undefined;
  readonly route: AnyRouteConfig;
  readonly model: Model<Api>;
  readonly messages: TranscriptContext["messages"];
  readonly label: string;
  readonly capture: ModelCapture;
  readonly retry: HarnessSettings["retry"];
  readonly signal: AbortSignal | undefined;
  readonly limits: StallLimits | undefined;
  readonly credentialInspection: CredentialCapture;
  readonly prepare: (telemetry: CallTelemetry) => Promise<{
    readonly scope: CaptureScope;
    readonly open: Open;
  }>;
}) => {
  const { model } = input;
  const telemetry = new CallTelemetry(input.log, input.route);
  const outer = new AssistantMessageEventStream();
  const parent = input.signal ?? new AbortController().signal;
  let call: Call | undefined;
  let last: AssistantMessage | undefined;
  let over = false;
  /** The message as the caller gets it: the scheduler's text in `errorMessage`, never the detail. */
  const failedWith = (message: AssistantMessage, failed: Failed) => ({
    ...message,
    ...(failed.failure.kind === "aborted"
      ? {}
      : { stopReason: "error" as const }),
    errorMessage: schedulerText(input.label, failed.failure, failed.transient),
  });
  const finish = async (
    reported: AssistantMessage,
    reportedFailure?: Failed,
  ) => {
    if (over) return;
    over = true;
    let failed = call?.captureFailure ?? reportedFailure;
    if (
      failed?.failure.kind === "stream" &&
      call?.scope.stage === undefined &&
      call?.answer?.status === 200 &&
      streamEndedNearContextLimit(model, input.messages, failed.failure.detail)
    ) {
      failed = {
        ...failed,
        failure: { ...failed.failure, kind: "context_overflow" },
      };
    }
    if (failed !== undefined && call?.credentials !== undefined)
      failed = {
        ...failed,
        type: refusalEvidence(failed.type, call.credentials).body,
        failure: {
          ...failed.failure,
          ...(failed.failure.code === undefined
            ? {}
            : {
                code: refusalEvidence(failed.failure.code, call.credentials)
                  .body,
              }),
          ...(failed.failure.requestId === undefined
            ? {}
            : {
                requestId: refusalEvidence(
                  failed.failure.requestId,
                  call.credentials,
                ).body,
              }),
          detail: refusalEvidence(failed.failure.detail, call.credentials).body,
        },
      };
    let message =
      failed === undefined ? reported : failedWith(reported, failed);
    telemetry.endStream();
    if (call?.requested === true) {
      call.signal = AbortSignal.timeout(30_000);
      call.captureSignal = parent;
      const outcome = outcomeOf(message);
      try {
        if (call.sdkInvocation !== undefined)
          await recordEvent(
            call,
            "sdk_invocation_end",
            call.sdkInvocation.finish(),
          );
        await inspectNativeCredentials(call, reported);
        await respond(call);
        await recordArguments(call, message);
        if (call.credentialGuard)
          await recordEvent(call, "credential_guard", { status: "observed" });
        await record(call, {
          type: "model.end",
          scope: call.scope,
          callId: call.id,
          outcome,
          ...(message.responseId === undefined
            ? {}
            : { responseId: message.responseId }),
          messageTimestamp: message.timestamp,
          stopReason: message.stopReason,
          sdkUsage: message.usage,
          ...(outcome === "completed" || message.usage.totalTokens > 0
            ? { usage: tokensOf(message.usage) }
            : {}),
          ...(failed === undefined
            ? {}
            : { error: { type: failed.type, message: failed.failure.detail } }),
        });
      } catch (cause) {
        failed = rememberCaptureFailure(call, "model.end", cause);
        message = failedWith(message, failed);
      }
    }
    if (failed !== undefined)
      message = {
        ...message,
        diagnostics: [
          ...(message.diagnostics ?? []),
          routeFailureDiagnostic(failed.failure, message.timestamp),
        ],
      };
    telemetry.finish(message, failed?.failure.kind, parent.reason);
    outer.push(
      outcomeOf(message) === "completed"
        ? {
            type: "done",
            reason: message.stopReason as
              "stop" | "length" | "toolUse" | "deferred",
            message,
          }
        : {
            type: "error",
            reason: message.stopReason === "aborted" ? "aborted" : "error",
            error: message,
          },
    );
    outer.end(message);
  };
  /** pi's terminal message, settled with the provider's refusal when it reported one. */
  const settle = async (
    event: Extract<AssistantMessageEvent, { type: "done" | "error" }>,
  ) => {
    if (event.type === "done") return finish(event.message);
    const message = event.error;
    const own = message.errorMessage ?? message.stopReason;
    if (message.stopReason === "aborted")
      return finish(message, {
        failure: { kind: "aborted", detail: own },
        type: "aborted",
      });
    const failure = call?.failure;
    if (failure === undefined)
      return finish(message, {
        failure: { kind: "stream", detail: own },
        type: "transport",
      });
    const detail = describe(input.label, failure);
    const safeDetail = describe(input.label, {
      ...failure,
      message:
        failure.message === undefined
          ? undefined
          : refusalEvidence(failure.message, call?.credentials ?? new Headers())
              .body,
    });
    await finish(message, {
      failure: {
        kind: refusalKind(
          failure,
          isContextOverflow({ ...message, errorMessage: detail }),
        ),
        ...(failure.status === undefined ? {} : { status: failure.status }),
        ...(failure.code === undefined ? {} : { code: failure.code }),
        ...(failure.requestId === undefined
          ? {}
          : { requestId: failure.requestId }),
        ...(failure.retryAfterAt === undefined
          ? {}
          : { retryAfterAt: failure.retryAfterAt }),
        detail: safeDetail,
      },
      type:
        failure.code ??
        (failure.status === undefined ? "stream" : `http_${failure.status}`),
    });
  };
  void (async () => {
    let prepared: Awaited<ReturnType<typeof input.prepare>>;
    try {
      prepared = await input.prepare(telemetry);
    } catch (error) {
      if (error instanceof CaptureFailed)
        return finish(
          failedMessage(model),
          captureLost(messageOf(error), error),
        );
      if (parent.aborted)
        return finish(
          { ...failedMessage(model), stopReason: "aborted" },
          { failure: { kind: "aborted", detail: "aborted" }, type: "aborted" },
        );
      if (error instanceof RouteEffortError)
        return finish(failedMessage(model), {
          failure: { kind: "invalid_request", detail: error.message },
          type: "invalid_request",
        });
      if (error instanceof RouteBindingError)
        return finish(failedMessage(model), {
          failure: { kind: "binding", detail: error.message },
          type: "binding",
        });
      return finish(failedMessage(model), {
        failure: {
          kind: "sign_in",
          detail:
            error instanceof OpenAiAuthError
              ? error.message
              : "the route's credential could not be read",
        },
        type: "auth",
        transient: error instanceof OpenAiAuthError && error.transient,
      });
    }
    const current: Call = {
      telemetry,
      id: telemetry.id,
      scope: prepared.scope,
      capture: input.capture,
      captureWrites: new CallCapture(input.capture, input.retry),
      credentialInspection: input.credentialInspection,
      rawCalls: [],
      requested: false,
      responded: false,
    };
    call = current;
    const relay = async (
      signal: AbortSignal,
      touch: (next: StallPhase) => void,
    ) => {
      const transport = new AbortController();
      try {
        for await (const event of prepared.open(
          current,
          AbortSignal.any([signal, transport.signal]),
          touch,
        )) {
          if (over) return;
          if (event.type === "done" || event.type === "error")
            return await settle(event);
          // The adapter keeps mutating its live partial while inspection awaits. Publish
          // the same snapshot we inspected, so later deltas cannot cross this boundary first.
          const partial = structuredClone(event.partial);
          await inspectNativeCredentials(current, partial);
          last = partial;
          outer.push({ ...event, partial });
        }
      } finally {
        transport.abort();
      }
    };
    try {
      await (input.limits === undefined
        ? relay(parent, () => undefined)
        : watchForStall(input.limits, parent, relay));
    } catch (cause) {
      if (!(cause instanceof StreamStall)) throw cause;
      const awaiting =
        cause.awaiting === "headers"
          ? "the response headers"
          : cause.awaiting === "reasoning"
            ? "a stream event inside a reasoning item"
            : "a stream event";
      // pi still owns the live partial and marks it aborted; the caller gets a copy.
      const base =
        last === undefined ? failedMessage(model) : structuredClone(last);
      // Streaming scratch buffers never persist, as pi's own failures drop them.
      for (const block of base.content)
        for (const key of ["index", "partialJson", "customInput"])
          delete (block as unknown as Record<string, unknown>)[key];
      await finish(base, {
        failure: {
          kind: "stalled",
          detail: `${STREAM_STALLED}: timed out after ${cause.gapMs} ms waiting for ${awaiting}`,
        },
        type: STREAM_STALLED,
      });
    }
    if (!over)
      await finish(failedMessage(model), {
        failure: {
          kind: "stream",
          detail: "the stream ended without a terminal event",
        },
        type: "stream",
      });
  })().catch(
    async (error: unknown) =>
      await finish(
        failedMessage(model),
        error instanceof CaptureFailed
          ? captureLost(messageOf(error), error)
          : {
              failure: { kind: "stream", detail: messageOf(error) },
              type: "transport",
            },
      ),
  );
  return outer;
};

const textOf = (content: unknown) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((part) =>
            isObject(part) && typeof part["text"] === "string"
              ? part["text"]
              : "",
          )
          .join("")
      : "";

/**
 * The request `buildRequest` sends, from the body pi's adapter built: the system prompt moved to
 * `instructions`, the history in the route's replay shape, the tools in the namespace, and nothing
 * the route rejects (an output cap, prompt-cache fields, sampling settings).
 */
const toRouteRequest = (
  payload: unknown,
  route: Pick<OpenAiRouteConfig, "effort" | "reasoningSummary">,
  final: Readonly<Record<string, Json>> | undefined,
  toolsDescription: string,
): JsonObject => {
  const body = isObject(payload) ? payload : {};
  const instructions: Array<string> = [];
  const input: Array<unknown> = [];
  for (const item of Array.isArray(body["input"]) ? body["input"] : []) {
    if (!isObject(item)) continue;
    const role = item["role"];
    if (
      item["type"] === undefined &&
      (role === "developer" || role === "system")
    ) {
      instructions.push(textOf(item["content"]));
      continue;
    }
    if (item["type"] === undefined && role === "user") {
      input.push({ type: "message", role: "user", content: item["content"] });
      continue;
    }
    switch (item["type"]) {
      case "reasoning":
        // Reasoning without encrypted content cannot be replayed; a summary is never replayed.
        if (typeof item["encrypted_content"] === "string")
          input.push({
            type: "reasoning",
            ...(typeof item["id"] === "string" ? { id: item["id"] } : {}),
            summary: [],
            encrypted_content: item["encrypted_content"],
          });
        break;
      case "message":
        input.push({
          type: "message",
          role: item["role"],
          content: item["content"],
          ...(typeof item["phase"] === "string"
            ? { phase: item["phase"] }
            : {}),
        });
        break;
      case "function_call":
        input.push({
          type: "function_call",
          call_id: item["call_id"],
          name: item["name"],
          namespace:
            typeof item["namespace"] === "string"
              ? item["namespace"]
              : TOOL_NAMESPACE,
          arguments: item["arguments"],
        });
        break;
      default:
        input.push(item);
    }
  }
  const tools = (Array.isArray(body["tools"]) ? body["tools"] : [])
    .filter(isObject)
    .map((tool) => ({
      type: "function",
      name: tool["name"],
      ...(typeof tool["description"] === "string"
        ? { description: tool["description"] }
        : {}),
      parameters:
        tool["strict"] === true
          ? toStrictSchema(tool["parameters"])
          : tool["parameters"],
      strict: tool["strict"] === true,
    }));
  const text = instructions.filter((part) => part !== "").join("\n\n");
  return {
    model: body["model"],
    ...(text === "" ? {} : { instructions: text }),
    input,
    ...(tools.length === 0
      ? {}
      : {
          tools: [
            {
              type: "namespace",
              name: TOOL_NAMESPACE,
              description: toolsDescription,
              tools,
            },
          ],
        }),
    tool_choice: final === undefined ? "auto" : "none",
    ...(final === undefined
      ? {}
      : {
          text: {
            format: {
              type: "json_schema",
              name: "stage_output",
              strict: true,
              schema: toStrictSchema(final),
            },
          },
        }),
    reasoning: {
      effort: route.effort,
      context: "all_turns",
      ...(route.reasoningSummary === undefined
        ? {}
        : { summary: route.reasoningSummary }),
    },
    include: ["reasoning.encrypted_content"],
    store: false,
    stream: true,
  };
};

const openAiRequestId = (headers: Headers) =>
  headers.get("x-request-id") ?? headers.get("x-oai-request-id") ?? undefined;

const openAiProvider = (
  route: OpenAiRouteConfig,
  options: RouteTransportOptions,
  id: string,
  dispatchOf: DispatchOf,
) => {
  const auth = options.auth ?? {};
  const base = options.fetch ?? globalThis.fetch;
  const limits = options.stallLimits ?? {
    quietMs: STREAM_STALL_MS,
    reasoningMs: REASONING_STALL_MS,
  };
  const descriptor = routeModel(route);
  const model = {
    ...descriptor,
    provider: id,
    baseUrl: options.baseUrl ?? descriptor.baseUrl,
  };
  const stream = (
    target: Model<Api>,
    context: TranscriptContext,
    streamOptions?: OpenAIResponsesOptions,
    requested: string | undefined = streamOptions?.reasoningEffort,
  ) =>
    runCall({
      log: options.log,
      route,
      model: target,
      messages: context.messages,
      label: "OpenAI API error",
      capture: options.capture,
      retry: options.retry,
      credentialInspection: options.credentialInspection,
      signal: streamOptions?.signal,
      limits,
      prepare: async (telemetry) => {
        const dispatch = await dispatchOf(target);
        telemetry.bind(dispatch.telemetry, dispatch.mode.kind === "final");
        const final = finalSchemaOf(dispatch);
        const effort = effortOf(route, dispatch, requested);
        const admission = options.admission;
        if (admission)
          await logTimed(
            options.log,
            "harness.route.retry-after.wait",
            {
              "harness.stage": dispatch.scope.stage ?? "coding",
              "harness.agent": dispatch.scope.agent ?? "coding",
            },
            () => admission.wait(streamOptions?.signal),
          );
        const leaseToken = (signal: AbortSignal | undefined) =>
          logTimed(
            options.log,
            "harness.route.credential",
            {
              "harness.category":
                (auth.tokenCommand ??
                  process.env["NEUVE_OPENAI_TOKEN_COMMAND"]) ===
                "/opt/replay/lease-token"
                  ? "bench-specific"
                  : "product",
            },
            () =>
              accessToken({
                ...auth,
                ...(signal === undefined ? {} : { signal }),
              }),
          );
        let lease = await leaseToken(streamOptions?.signal);
        const open: Open = (call, signal, touch) => {
          call.sdkInvocation = sdkInvocationTracker(call.id, signal);
          const invocation = {
            version: 1,
            api: "openai-responses",
            options: { cacheRetention: "none" },
          } satisfies SdkInvocation;
          call.sdkContext = sdkContextSnapshot(
            call.id,
            target,
            context,
            invocation,
          );
          const reasoning = new Set<unknown>();
          return openAiResponses(target as Model<"openai-responses">, context, {
            signal,
            onProviderStreamEvent: call.sdkInvocation.onProviderStreamEvent,
            apiKey: lease.token,
            fetch: observedFetch(
              base,
              call,
              { route, model: target, dispatch },
              openAiRequestId,
              (response) => {
                if (response.status === 401) rejectedToken(lease.token);
                touch("event");
              },
              async (name, event) => {
                if (isObject(event)) {
                  const item = event["item"];
                  if (isObject(item) && item["type"] === "reasoning") {
                    if (event["type"] === "response.output_item.added")
                      reasoning.add(event["output_index"]);
                    else if (event["type"] === "response.output_item.done")
                      reasoning.delete(event["output_index"]);
                  }
                  const raw = rawCallOf(event);
                  if (raw !== undefined) call.rawCalls.push(raw);
                  const failed =
                    event["type"] === "response.failed"
                      ? errorOf({
                          error: isObject(event["response"])
                            ? event["response"]["error"]
                            : undefined,
                        })
                      : event["type"] === "error" ||
                          name === "error" ||
                          isObject(event["error"])
                        ? errorOf(event)
                        : undefined;
                  if (failed !== undefined)
                    call.failure = {
                      ...failed,
                      status: call.answer?.status,
                      requestId: call.requestId,
                    };
                }
                touch(reasoning.size > 0 ? "reasoning" : "event");
                await respond(
                  call,
                  isObject(event) ? openedResponseId(event) : undefined,
                );
                await recordEvent(
                  call,
                  isObject(event) && typeof event["type"] === "string"
                    ? event["type"]
                    : name,
                  event,
                );
              },
              options.admission,
              touch,
              async (headers, signal) => {
                while (lease.expiresAt <= Date.now()) {
                  lease = await leaseToken(signal);
                  await options.admission?.wait(signal);
                }
                headers.set("authorization", `Bearer ${lease.token}`);
              },
            ),
            headers: {
              ...streamOptions?.headers,
              "session-id": dispatch.sessionId,
            },
            ...invocation.options,
            maxRetries: 0,
            ...(streamOptions?.timeoutMs === undefined
              ? {}
              : { timeoutMs: streamOptions.timeoutMs }),
            onPayload: (payload) =>
              toRouteRequest(
                payload,
                { ...route, effort },
                final,
                dispatch.toolsDescription,
              ),
          });
        };
        return { scope: dispatch.scope, open };
      },
    });
  const streams: ProviderStreams = {
    stream,
    streamSimple: (target, context, options?: SimpleStreamOptions) =>
      stream(target, context, options, options?.reasoning),
  };
  return createProvider({
    id,
    name: "OpenAI (ChatGPT plan)",
    auth: {
      apiKey: {
        name: "the Neuve sign-in (neuve auth login openai)",
        // Whether a sign-in or a token command is configured; nothing is run or refreshed.
        check: async () =>
          signInProblem(auth) === undefined
            ? { source: "neuve-sign-in", type: "api_key" }
            : undefined,
        // The token is fetched per call inside the stream (above), so pi never holds it.
        resolve: async () =>
          signInProblem(auth) === undefined
            ? { auth: {}, source: "neuve-sign-in" }
            : undefined,
      },
    },
    models: [model],
    api: streams,
  });
};

const withoutCacheControl = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutCacheControl);
  if (!isObject(value)) return value;
  const { cache_control: _dropped, ...rest } = value;
  return Object.fromEntries(
    Object.entries(rest).map(([key, child]) => [
      key,
      withoutCacheControl(child),
    ]),
  );
};

/**
 * The request agent.ts's transform sends, from the body pi's adapter built: automatic prompt caching
 * after the system block's 1-hour breakpoint (no other breakpoint), the route's effort, and for the
 * final generation `tool_choice: none` with the output schema as structured output.
 */
const toAnthropicRequest = (
  payload: unknown,
  route: Pick<AnthropicRouteConfig, "effort">,
  final: Readonly<Record<string, Json>> | undefined,
): JsonObject => {
  const body = isObject(payload) ? payload : {};
  const outputConfig = isObject(body["output_config"])
    ? body["output_config"]
    : {};
  return {
    ...body,
    messages: withoutCacheControl(body["messages"]),
    ...(Array.isArray(body["tools"])
      ? { tools: withoutCacheControl(body["tools"]) }
      : {}),
    cache_control: { type: "ephemeral" },
    output_config: {
      ...outputConfig,
      effort: route.effort,
      ...(final === undefined
        ? {}
        : { format: { type: "json_schema", schema: final } }),
    },
    ...(final === undefined ? {} : { tool_choice: { type: "none" } }),
  };
};

const anthropicProvider = (
  route: AnthropicRouteConfig,
  options: RouteTransportOptions,
  id: string,
  dispatchOf: DispatchOf,
) => {
  const base = options.fetch ?? globalThis.fetch;
  const variable = routeCredentialVariable(route);
  if (isClaudeSubscriptionToken(process.env[variable]))
    throw new ClaudeSubscriptionTokenRefused(variable);
  const descriptor = routeModel(route);
  const model = {
    ...descriptor,
    provider: id,
    baseUrl: options.baseUrl ?? descriptor.baseUrl,
  };
  const stream = (
    target: Model<Api>,
    context: TranscriptContext,
    streamOptions?: AnthropicOptions,
    requested: string | undefined = streamOptions?.effort,
  ) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries({
      ...target.headers,
      ...streamOptions?.headers,
    }))
      if (value !== null) headers.set(name, value);
    if (
      isClaudeSubscriptionToken(streamOptions?.apiKey) ||
      isClaudeSubscriptionToken(headers.get("x-api-key") ?? undefined) ||
      isClaudeSubscriptionToken(
        headers.get("authorization")?.replace(/^Bearer\s+/i, ""),
      )
    )
      throw new ClaudeSubscriptionTokenRefused(variable);
    return runCall({
      log: options.log,
      route,
      model: target,
      messages: context.messages,
      label: "Anthropic API error",
      capture: options.capture,
      retry: options.retry,
      credentialInspection: options.credentialInspection,
      signal: streamOptions?.signal,
      limits: undefined,
      prepare: async (telemetry) => {
        const dispatch = await dispatchOf(target);
        telemetry.bind(dispatch.telemetry, dispatch.mode.kind === "final");
        const final = finalSchemaOf(dispatch);
        const effort = effortOf(route, dispatch, requested);
        const open: Open = (call, signal) => {
          call.sdkInvocation = sdkInvocationTracker(call.id, signal);
          const invocation = {
            version: 1,
            api: "anthropic-messages",
            authMode: "non-oauth",
            options: {
              maxTokens: route.maxOutputTokens,
              cacheRetention: "long",
            },
          } satisfies SdkInvocation;
          call.sdkContext = sdkContextSnapshot(
            call.id,
            target,
            context,
            invocation,
          );
          return anthropicMessages(
            target as Model<"anthropic-messages">,
            context,
            {
              signal,
              onProviderStreamEvent: call.sdkInvocation.onProviderStreamEvent,
              ...(streamOptions?.apiKey === undefined
                ? {}
                : { apiKey: streamOptions.apiKey }),
              ...(streamOptions?.headers === undefined
                ? {}
                : { headers: streamOptions.headers }),
              ...(streamOptions?.timeoutMs === undefined
                ? {}
                : { timeoutMs: streamOptions.timeoutMs }),
              fetch: observedFetch(
                base,
                call,
                { route, model: target, dispatch },
                (headers) =>
                  headers.get("request-id") ??
                  headers.get("x-request-id") ??
                  undefined,
                () => undefined,
                async (name, event) => {
                  if (
                    name === "error" ||
                    (isObject(event) && event["type"] === "error")
                  )
                    call.failure = {
                      ...errorOf(event),
                      status: call.answer?.status,
                      requestId: call.requestId,
                    };
                  await respond(
                    call,
                    isObject(event) ? openedResponseId(event) : undefined,
                  );
                  await recordEvent(
                    call,
                    isObject(event) && typeof event["type"] === "string"
                      ? event["type"]
                      : name,
                    event,
                  );
                },
                options.admission,
              ),
              ...invocation.options,
              maxRetries: 0,
              onPayload: (payload) =>
                toAnthropicRequest(payload, { effort }, final),
            },
          );
        };
        return { scope: dispatch.scope, open };
      },
    });
  };
  const streams: ProviderStreams = {
    stream,
    streamSimple: (target, context, options?: SimpleStreamOptions) =>
      stream(target, context, options, options?.reasoning),
  };
  return createProvider({
    id,
    name: "Anthropic",
    auth: {
      apiKey: {
        name: variable,
        check: async ({ ctx }) => {
          const value = await ctx.env(variable);
          if (isClaudeSubscriptionToken(value))
            throw new ClaudeSubscriptionTokenRefused(variable);
          return value === undefined || value.trim() === ""
            ? undefined
            : { source: variable, type: "api_key" };
        },
        resolve: async ({ ctx }) => {
          const value = await ctx.env(variable);
          if (isClaudeSubscriptionToken(value))
            throw new ClaudeSubscriptionTokenRefused(variable);
          return value === undefined || value.trim() === ""
            ? undefined
            : { auth: { apiKey: value }, source: variable };
        },
      },
    },
    models: [model],
    api: streams,
  });
};
