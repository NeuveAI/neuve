import type { Context } from "@earendil-works/chord";
import type {
  Api,
  AssistantMessage,
  AssistantMessageDiagnostic,
  Message,
  Model,
} from "@earendil-works/pi-ai";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { DEFAULT_COMPACTION_POLICY } from "@earendil-works/pi-durable";
import type {
  Conversation,
  Cursor,
  EntryId,
  EntryRecord,
  SettledSubmissionRecord,
  TaskId,
} from "@earendil-works/pi-durable";
import { NOT_RETRYABLE_CODES, USAGE_LIMIT } from "./wire.ts";
import { CaptureFailed } from "../capture/types.ts";

/** An early EOF on a serving request is an overflow only near the selected model's limit. */
export function streamEndedNearContextLimit(
  model: Model<Api>,
  messages: readonly Message[],
  detail: string,
): boolean {
  if (
    !/\bstream ended (?:before|without) (?:an? )?(?:terminal(?: response)? event|(?:stop|finish) reason|message_stop)\b/i.test(
      detail,
    )
  )
    return false;
  // Pi's transcript estimator drops usage that predates a prepended compaction summary.
  const { lastUsageIndex, usageTokens } = estimateContextTokens(messages);
  const last = lastUsageIndex === null ? undefined : messages[lastUsageIndex];
  if (
    last?.role !== "assistant" ||
    last.provider !== model.provider ||
    last.model !== model.id ||
    (last.stopReason !== "stop" &&
      last.stopReason !== "toolUse" &&
      last.stopReason !== "length")
  )
    return false;
  const margin = Math.min(
    DEFAULT_COMPACTION_POLICY.reserveTokens,
    model.contextWindow / 10,
  );
  return usageTokens >= model.contextWindow - margin;
}

/**
 * Why a route call failed, as the route provider records it on the failed `AssistantMessage` it
 * hands pi (`diagnostics`), which pi stores with the turn. Runtime and stages read it with
 * `routeFailureOf` instead of matching the error text. The error text is `schedulerText`, which
 * pi's own classifiers read as the kind means: they alone retry, compact or give up.
 *
 * - `auth`: the provider refused the credential (HTTP 401, 403, or a plan-access code).
 * - `plan_quota`: the account's quota is used up: the ChatGPT plan's usage limit, which resets after
 *   hours, or OpenAI's `insufficient_quota`. It is never retried.
 * - `rate_limit`: a transient throttle (HTTP 429), retried.
 * - `context_overflow`, `invalid_request`: the request itself was refused.
 * - `server`: HTTP 5xx; `provider`: any other refusal.
 * - `stream`: the stream failed or ended without its terminal event; `stalled`: it went silent.
 * - `sign_in`: the Neuve sign-in could not give a token, before anything was sent.
 * - `binding`: the agent route binding was missing or named another route; nothing was sent.
 * - `capture`: an event could not be recorded, so the call is not answered.
 * - `aborted`: the caller cancelled.
 */
export type RouteFailureKind =
  | "auth"
  | "plan_quota"
  | "rate_limit"
  | "context_overflow"
  | "invalid_request"
  | "server"
  | "provider"
  | "stream"
  | "stalled"
  | "sign_in"
  | "binding"
  | "capture"
  | "aborted";

export interface RouteFailure {
  readonly kind: RouteFailureKind;
  /** The HTTP status, when the provider answered with one. */
  readonly status?: number;
  /** The provider's error code, when it gave one. */
  readonly code?: string;
  /** The provider's ID for the request, when it named one. */
  readonly requestId?: string;
  /** What happened, in full: the provider's own message, or the call's account of its failure. */
  readonly detail?: string;
  /** Absolute provider admission floor, measured when the refusal's headers arrived. */
  readonly retryAfterAt?: number;
}

/** The `diagnostics` type the route's failure is recorded under. */
export const ROUTE_FAILURE = "neuve.route_failure";
export const CAPTURE_FULL = "capture_full";

export const captureRouteFailure = (detail: string, cause: unknown) => ({
  kind: "capture" as const,
  detail,
  ...(cause instanceof CaptureFailed && cause.kind === "full"
    ? { code: CAPTURE_FULL }
    : {}),
});

const KINDS: ReadonlySet<string> = new Set<RouteFailureKind>([
  "auth",
  "plan_quota",
  "rate_limit",
  "context_overflow",
  "invalid_request",
  "server",
  "provider",
  "stream",
  "stalled",
  "sign_in",
  "binding",
  "capture",
  "aborted",
]);

/**
 * A refusal the provider reported, by its status and code. Anthropic names an overflow only in the
 * message of a refused request, so `overflows` is whether pi's own `isContextOverflow` reads the
 * provider's message as one; it is trusted only for a refused request.
 */
export const refusalKind = (
  failure: {
    readonly status?: number | undefined;
    readonly code?: string | undefined;
  },
  overflows: boolean,
): RouteFailureKind => {
  const { status, code } = failure;
  if (code === USAGE_LIMIT || code === "insufficient_quota")
    return "plan_quota";
  if (code !== undefined && NOT_RETRYABLE_CODES.test(code))
    return status === 400 ? "invalid_request" : "auth";
  if (
    status === 401 ||
    status === 403 ||
    code === "authentication_error" ||
    code === "permission_error"
  )
    return "auth";
  if (
    status === 429 ||
    code === "rate_limit_exceeded" ||
    code === "rate_limit_error"
  )
    return "rate_limit";
  if (code === "context_length_exceeded") return "context_overflow";
  if (code === "billing_error") return "provider";
  if (
    status === 400 ||
    status === 404 ||
    status === 413 ||
    code === "invalid_request_error" ||
    code === "not_found_error"
  )
    return overflows ? "context_overflow" : "invalid_request";
  if (
    (status !== undefined && status >= 500) ||
    code === "overloaded_error" ||
    code === "api_error" ||
    code === "timeout_error"
  )
    return "server";
  return status === undefined || (status >= 200 && status < 300)
    ? "stream"
    : "provider";
};

/** What pi's classifiers are to read for each kind; a phrase `schedulerText` places after the status. */
const SCHEDULED: Readonly<Record<RouteFailureKind, string>> = {
  auth: "the provider refused the credential or plan access",
  plan_quota: "quota exceeded, the account's usage quota is used up",
  rate_limit: "rate limited by the provider",
  context_overflow: "the request exceeds the context window",
  invalid_request: "the provider refused the request as invalid",
  server: "server error",
  provider: "the provider refused the request",
  stream: "the stream failed or ended without a terminal event",
  stalled: "the stream stalled and timed out",
  sign_in: "the route's credential is unavailable",
  binding: "the agent route binding is missing or names another route",
  capture: "capture failed, the call could not be recorded",
  aborted: "the request was aborted",
};

/** The kinds pi retries because of their status. */
const RETRIED_STATUS: ReadonlySet<RouteFailureKind> = new Set<RouteFailureKind>(
  ["rate_limit", "server"],
);

/**
 * The failed message's `errorMessage`, which pi's scheduler reads: `isContextOverflow` and then
 * `isRetryableAssistantError` match substrings of it, and a failed run settles with it as `detail`.
 * It is the label, the HTTP status and a fixed phrase for the kind, and never the provider's message,
 * code or request ID, a route or agent ID, or a thrown error's text, any of which can hold words or
 * digits pi reads as transient. Those stay in `detail` and the capture. A sign-in that may work on a
 * later attempt (`transient`) reads as a network error.
 */
export const schedulerText = (
  label: string,
  failure: Pick<RouteFailure, "kind" | "status" | "code">,
  transient = false,
) => {
  const { kind, status } = failure;
  // pi reads 429 and most 5xx statuses anywhere in the text as transient, so only a kind it
  // retries names one of them.
  const named =
    status !== undefined &&
    (status < 200 || status >= 300) &&
    (RETRIED_STATUS.has(kind) || (status < 500 && status !== 429));
  const phrase =
    kind === "capture" && failure.code === CAPTURE_FULL
      ? "the capture journal is full"
      : kind === "sign_in" && transient
        ? "the route's credential is unavailable for now (network error)"
        : SCHEDULED[kind];
  return `${label}${named ? ` (HTTP ${status})` : ""}: ${phrase}`;
};

/** The failure as the diagnostic the provider appends to its failed message. */
export const routeFailureDiagnostic = (
  failure: RouteFailure,
  timestamp: number,
): AssistantMessageDiagnostic => ({
  type: ROUTE_FAILURE,
  timestamp,
  details: {
    kind: failure.kind,
    ...(failure.status === undefined ? {} : { status: failure.status }),
    ...(failure.code === undefined ? {} : { code: failure.code }),
    ...(failure.requestId === undefined
      ? {}
      : { requestId: failure.requestId }),
    ...(failure.detail === undefined ? {} : { detail: failure.detail }),
    ...(failure.retryAfterAt === undefined
      ? {}
      : { retryAfterAt: failure.retryAfterAt }),
  },
});

/** The route's failure recorded on a message, or undefined for an answer or another provider's failure. */
export const routeFailureOf = (
  message: Pick<AssistantMessage, "diagnostics">,
): RouteFailure | undefined => {
  const details = message.diagnostics?.findLast(
    (diagnostic) => diagnostic.type === ROUTE_FAILURE,
  )?.details;
  const kind = details?.["kind"];
  if (typeof kind !== "string" || !KINDS.has(kind)) return undefined;
  const status = details?.["status"];
  const code = details?.["code"];
  const requestId = details?.["requestId"];
  const detail = details?.["detail"];
  const retryAfterAt = details?.["retryAfterAt"];
  return {
    kind: kind as RouteFailureKind,
    ...(typeof status === "number" ? { status } : {}),
    ...(typeof code === "string" ? { code } : {}),
    ...(typeof requestId === "string" ? { requestId } : {}),
    ...(typeof detail === "string" ? { detail } : {}),
    ...(typeof retryAfterAt === "number" && Number.isFinite(retryAfterAt)
      ? { retryAfterAt }
      : {}),
  };
};

/**
 * The route failure an unanswered submission's run ended with. pi settles every input of a failed
 * run `model_error` with the run's terminal turn's error text as `detail`, and the model context
 * leaves failed turns out, so the turn is found in pi's stored entries. Retried attempts share the
 * terminal turn's text, so the text cannot pick it. The terminal turn is the last entry its
 * generation task appended (`byTaskId`): pi appends it as it settles the run, or before a compaction
 * that failed to save the run, and a retried attempt is followed by its retry. The first such failed
 * turn at or after the submission's input entry is its run's, since a later run comes after it.
 * Undefined when the submission was answered, settled for another reason, or that turn's text is not
 * the run's `detail` or its failure not the route's.
 */
export const routeFailureOfSubmission = async (
  conversation: Pick<Conversation, "entries">,
  settled: SettledSubmissionRecord,
  context: Context,
): Promise<RouteFailure | undefined> => {
  if (
    settled.status !== "unanswered" ||
    settled.reason !== "model_error" ||
    settled.entry === undefined ||
    typeof settled.detail !== "string"
  )
    return undefined;
  const entries: Array<EntryRecord> = [];
  let cursor: Cursor | undefined;
  do {
    const page = await conversation.entries(
      { minEntryId: settled.entry },
      100,
      cursor,
      context,
    );
    entries.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  const sorted = entries.toSorted((a, b) => a.id - b.id);
  const lastOfTask = new Map<TaskId, EntryId>();
  for (const entry of sorted)
    if (entry.byTaskId !== undefined) lastOfTask.set(entry.byTaskId, entry.id);
  for (const entry of sorted) {
    const turn = entry.model?.find((message) => message.role === "assistant");
    if (
      turn?.role === "assistant" &&
      (turn.stopReason === "error" || turn.stopReason === "aborted") &&
      entry.byTaskId !== undefined &&
      lastOfTask.get(entry.byTaskId) === entry.id
    )
      return turn.errorMessage === settled.detail
        ? routeFailureOf(turn)
        : undefined;
  }
  return undefined;
};

/** Native provider refusals consume a turn; transport failures do not. */
export const isRefusal = (message: AssistantMessage | undefined) => {
  if (message?.stopReason !== "error") return false;
  const failure = routeFailureOf(message);
  if (failure !== undefined && failure.kind !== "stream") return false;
  return (
    (message.api === "anthropic-messages" &&
      message.rawStopReason === "refusal") ||
    (message.api === "openai-responses" &&
      message.rawStopReason === "incomplete.content_filter")
  );
};
