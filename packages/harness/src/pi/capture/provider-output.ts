import type { InspectionBudget } from "./credential-detectors.ts";
import { foldJson, isJsonObject, rebuildJson } from "./json-walk.ts";
import { type RetainedSdkRun, retainedSdk } from "./retained-sdk.ts";
import type { NativeSnapshot } from "./sources.ts";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { routeFailureOf, schedulerText } from "../providers/failure.ts";
import { outcomeOfStop } from "./call-lifecycle.ts";
import { PiUsage } from "./usage.ts";
import { DumpFailed } from "./sources.ts";
import { maskRecord } from "./mask.ts";
import type { CallRecord } from "./dump.ts";
import { Json } from "./types.ts";

type Call = Omit<CallRecord, "role">;
const SupportedApi = z.enum(["openai-responses", "anthropic-messages"]);
const SnapshotIdentity = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  status: z.string().optional(),
});
const Frame = z.object({
  type: z.string(),
  response: SnapshotIdentity.optional(),
  message: z.union([z.string(), SnapshotIdentity]).optional(),
});
const snapshotStatuses: Record<string, ReadonlyArray<string>> = {
  "response.created": ["queued", "in_progress"],
  "response.queued": ["queued"],
  "response.in_progress": ["in_progress"],
  "response.completed": ["completed"],
  "response.incomplete": ["incomplete"],
  "response.failed": ["failed"],
};

type FramingState = "waiting" | "open" | "terminal";

const outputFrames = (call: Call, native?: ResponseMessage) => {
  const reject = (reason: string): never => {
    throw new DumpFailed({ reason: `call ${call.callId} ${reason}` });
  };
  const events = call.events.filter(
    ({ name }) =>
      name.startsWith("response.") ||
      name === "error" ||
      name.startsWith("message_") ||
      name.startsWith("content_block_"),
  );
  const families = new Set(
    events.flatMap(({ name, data }) =>
      data === null ||
      Array.isArray(data) ||
      typeof data !== "object" ||
      !("type" in data) ||
      data.type !== name
        ? []
        : name.startsWith("response.")
          ? ["openai-responses"]
          : name.startsWith("message_") || name.startsWith("content_block_")
            ? ["anthropic-messages"]
            : [],
    ),
  );
  const stamps = [call.api, native?.api, ...families].filter(
    (value) => value !== undefined,
  );
  const known = stamps.map((stamp) => SupportedApi.safeParse(stamp));
  const api = known.find((parsed) => parsed.success)?.data;
  if (api === undefined) return null;
  if (stamps.some((stamp) => stamp !== api))
    reject("provider output contradicts its API or native assistant API");
  const required =
    call.end?.outcome === "completed" ||
    (native !== undefined && outcomeOfStop(native.stopReason) === "completed");
  if (
    required &&
    (call.response === null ||
      call.response.status < 200 ||
      call.response.status >= 300)
  )
    reject("lacks required successful HTTP response observation");
  if (events.length === 0) {
    if (required) reject("lacks required original provider output");
    return null;
  }
  let state: FramingState = "waiting";
  const identities = new Map<string, string>();
  for (const value of [
    call.response?.responseId,
    call.end?.responseId,
    native?.responseId,
  ])
    if (value !== undefined) {
      const retained = identities.get("id");
      if (retained !== undefined && retained !== value)
        reject("contradicts native assistant output response identity");
      identities.set("id", value);
    }
  for (const event of events) {
    const parsed = Frame.safeParse(event.data);
    const frame = parsed.success
      ? parsed.data
      : reject("has invalid provider framing");
    if (frame.type !== event.name) reject("has invalid provider framing");
    const opening =
      event.name === "response.created" || event.name === "message_start";
    const failure = event.name === "error" || event.name === "response.failed";
    const terminal =
      failure ||
      ["response.completed", "response.incomplete", "message_stop"].includes(
        event.name,
      );
    if (state === "terminal" || (opening && state !== "waiting"))
      reject("has repeated or reordered provider lifecycle output");
    if (state === "waiting" && !opening && !failure)
      reject(
        "lacks required original provider opening before content or terminal output",
      );
    const snapshot =
      frame.response ??
      (typeof frame.message === "object" ? frame.message : undefined);
    const statuses = snapshotStatuses[event.name];
    if (statuses !== undefined && snapshot === undefined)
      reject("has a provider response snapshot without identity");
    if (
      snapshot?.status !== undefined &&
      statuses !== undefined &&
      !statuses.includes(snapshot.status)
    )
      reject("has a provider response status that contradicts its framing");
    if (snapshot !== undefined) {
      if (snapshot.id === undefined)
        reject("has a provider response snapshot without identity");
      for (const [key, value] of Object.entries({
        id: snapshot.id,
        model: snapshot.model,
      })) {
        if (value === undefined) continue;
        const previous = identities.get(key);
        if (previous !== undefined && previous !== value)
          reject(
            "contradicts native assistant output or observed provider response identity",
          );
        identities.set(key, value);
      }
    } else if (opening)
      reject("has a provider opening without response identity");
    if (opening) state = "open";
    if (terminal) state = "terminal";
  }
  if (required && state !== "terminal")
    reject("lacks required original provider terminal output");
  return { api, events, terminal: state === "terminal" };
};

export const ResponseMessage = z.object({
  api: z.string().optional(),
  content: Json,
  responseId: z.string().optional(),
  responseModel: z.string().optional(),
  usage: PiUsage,
  stopReason: z.string(),
  rawStopReason: z.string().optional(),
  errorMessage: z.string().optional(),
  diagnostics: z
    .array(
      z.object({
        type: z.string(),
        details: Json.optional(),
      }),
    )
    .optional(),
});
type ResponseMessage = z.infer<typeof ResponseMessage>;

const responseFacts = (message: ResponseMessage, finish: boolean) => {
  const { cost: _cost, ...usage } = message.usage;
  return {
    content: message.content,
    responseId: message.responseId ?? null,
    responseModel: message.responseModel ?? null,
    usage,
    finish: finish
      ? {
          stopReason: message.stopReason,
          rawStopReason: message.rawStopReason ?? null,
          errorMessage: message.errorMessage ?? null,
        }
      : null,
    diagnostics: finish
      ? (message.diagnostics
          ?.filter(({ type }) => type === "anthropic_input_transformations")
          .map(({ type, details }) => ({ type, details })) ?? [])
      : [],
  };
};
export type OriginalResponseFacts = ReturnType<typeof responseFacts>;

const RouteFailureDetail = z.object({
  code: z.string().optional(),
  status: z.number().optional(),
  requestId: z.string().optional(),
  detail: z.string(),
});

const RuntimeDiagnostic = ResponseMessage.shape.diagnostics
  .unwrap()
  .element.extend({ details: z.record(z.string(), Json).optional() })
  .transform(({ type, details }) => ({
    type,
    timestamp: 0,
    ...(details === undefined ? {} : { details }),
  }));

const ErrorDetail = z.object({
  code: z.string().nullish(),
  type: z.string().nullish(),
  message: z.string().min(1),
});
const WireError = z
  .union([
    z
      .object({ type: z.literal("error"), error: ErrorDetail })
      .transform(({ error }) => error),
    ErrorDetail.extend({
      type: z.literal("error"),
      error: z.null().optional(),
    }),
  ])
  .transform((error) => ({
    code: error.code || error.type || undefined,
    message: error.message,
  }));

const originalErrorMatches = (
  sdkError: string,
  failure: z.infer<typeof RouteFailureDetail>,
  api: string | undefined,
  rawStopReason: string | null,
  equal: (a: unknown, b: unknown) => boolean,
  wireError: z.infer<typeof WireError> | undefined,
) => {
  if (
    failure.code === undefined &&
    equal(sdkError, failure.detail) &&
    wireError === undefined
  )
    return true;
  const marker = `(${failure.status === undefined ? "stream" : `HTTP ${failure.status}`}${failure.code === undefined ? "" : `, ${failure.code}`})`;
  const start = failure.detail.indexOf(marker);
  if (start < 0) return false;
  let detail = failure.detail.slice(start + marker.length);
  if (!detail.startsWith(": ")) return false;
  detail = detail.slice(2);
  if (failure.requestId !== undefined) {
    const suffix = ` (request ${failure.requestId})`;
    if (!detail.endsWith(suffix)) return false;
    detail = detail.slice(0, -suffix.length);
  }
  if (api === "anthropic-messages") {
    const parsed = z
      .object({
        type: z.literal("error"),
        error: z.object({
          type: z.string().optional(),
          code: z.string().optional(),
          message: z.string(),
        }),
      })
      .safeParse(
        (() => {
          try {
            return JSON.parse(sdkError);
          } catch {
            return null;
          }
        })(),
      );
    if (parsed.success)
      return (
        equal(parsed.data.error.type ?? parsed.data.error.code, failure.code) &&
        equal(parsed.data.error.message.slice(0, 300), detail)
      );
  }
  if (api === "openai-responses" && wireError !== undefined) {
    return (
      equal(wireError.code ?? null, failure.code ?? null) &&
      equal(wireError.message.slice(0, 300), detail)
    );
  }
  const prefix =
    api === "openai-responses"
      ? rawStopReason === "failed"
        ? `${failure.code ?? "unknown"}: `
        : `Error Code ${failure.code}: `
      : "";
  if (!sdkError.startsWith(prefix)) return false;
  return equal(sdkError.slice(prefix.length).slice(0, 300), detail);
};

const withheldSummary =
  /^(?:<withheld: reasoning summary, \d+ characters>\s*)+$/;
const withheldContinuation =
  /^<withheld: encrypted reasoning, \d+ characters>$/;
const portableComparison = (value: Json): Json =>
  foldJson<
    {
      parent: Readonly<Record<string, Json>> | undefined;
      key: string | undefined;
    },
    Json
  >(
    value,
    { parent: undefined, key: undefined },
    (child, { parent, key }, children) => {
      if (
        parent !== undefined &&
        parent["type"] === "thinking" &&
        key === "thinking" &&
        typeof child === "string" &&
        (withheldSummary.test(child) ||
          (child === "[Reasoning redacted]" &&
            "thinkingSignature" in parent &&
            typeof parent.thinkingSignature === "string" &&
            withheldContinuation.test(parent.thinkingSignature)))
      )
        return "<declared withheld reasoning>";
      else if (
        parent !== undefined &&
        parent["type"] === "thinking" &&
        key === "thinkingSignature" &&
        typeof child === "string"
      ) {
        let signature: Json = child;
        try {
          signature = Json.parse(JSON.parse(child));
        } catch {}
        const object = isJsonObject(signature) ? signature : undefined;
        const partsWithheld = (parts: Json | undefined) =>
          parts === undefined ||
          (Array.isArray(parts) &&
            parts.every(
              (part) =>
                part !== null &&
                typeof part === "object" &&
                !Array.isArray(part) &&
                (!("text" in part) ||
                  (typeof part.text === "string" &&
                    withheldSummary.test(part.text))),
            ));
        if (
          withheldContinuation.test(child) ||
          (object?.["type"] === "reasoning" &&
            partsWithheld(object["summary"]) &&
            partsWithheld(object["content"]) &&
            (object["encrypted_content"] === undefined ||
              (typeof object["encrypted_content"] === "string" &&
                withheldContinuation.test(object["encrypted_content"]))))
        )
          return "<declared withheld continuation>";
        else return child;
      }

      return rebuildJson(
        child,
        children((key) => ({
          parent: isJsonObject(child) ? child : undefined,
          key,
        })),
      );
    },
  );

export const reconcileProviderOutput = (
  call: Omit<CallRecord, "role">,
  output: OriginalResponseFacts,
  native?: ResponseMessage,
  declared?: ReadonlyArray<string>,
) => {
  const end = call.end;
  const { usage, responseId, finish } = output;
  const { cost: _cost, ...endUsage } = end?.sdkUsage ?? {};
  const equal = (a: unknown, b: unknown) =>
    isDeepStrictEqual(
      declared === undefined
        ? a
        : portableComparison(maskRecord(Json.parse(a), declared)),
      declared === undefined
        ? b
        : portableComparison(maskRecord(Json.parse(b), declared)),
    );
  const error = finish?.errorMessage;
  const parsedWireError = WireError.safeParse(
    call.events.find(({ name }) => name === "error")?.data,
  );
  const wireError = parsedWireError.success ? parsedWireError.data : undefined;
  const terminalFailure =
    end?.error === undefined
      ? undefined
      : {
          code:
            end.error.type !== undefined &&
            end.error.message.includes(`, ${end.error.type})`)
              ? end.error.type
              : undefined,
          status: call.response?.status,
          requestId: call.response?.requestId,
          detail: end.error.message,
        };
  const nativeFacts =
    native === undefined ? undefined : responseFacts(native, finish !== null);
  const diagnostics = z
    .array(RuntimeDiagnostic)
    .safeParse(native?.diagnostics ?? []);
  const failure = diagnostics.success
    ? routeFailureOf({ diagnostics: diagnostics.data })
    : undefined;
  const nativeFailure = RouteFailureDetail.safeParse(failure);
  const hasOpenAiWireError =
    call.api === "openai-responses" &&
    call.events.some(({ name }) => name === "error");
  let errorsAgree =
    (!hasOpenAiWireError || wireError !== undefined) &&
    diagnostics.success &&
    (!native?.diagnostics?.some(({ type }) => type === "neuve.route_failure") ||
      nativeFailure.success);
  if (error !== undefined && error !== null) {
    if (terminalFailure !== undefined)
      errorsAgree &&= originalErrorMatches(
        error,
        terminalFailure,
        call.api,
        finish?.rawStopReason ?? null,
        equal,
        wireError,
      );
    if (
      nativeFailure.success &&
      nativeFacts?.finish !== null &&
      nativeFacts?.finish !== undefined
    ) {
      errorsAgree &&=
        originalErrorMatches(
          error,
          nativeFailure.data,
          call.api,
          finish?.rawStopReason ?? null,
          equal,
          wireError,
        ) &&
        (terminalFailure === undefined ||
          equal(nativeFailure.data.detail, terminalFailure.detail));
      const label =
        call.api === "openai-responses"
          ? "OpenAI API error"
          : "Anthropic API error";
      errorsAgree &&=
        failure !== undefined &&
        equal(nativeFacts.finish.errorMessage, schedulerText(label, failure));
      nativeFacts.finish.errorMessage = error;
    }
  }
  if (
    !errorsAgree ||
    (end !== null &&
      finish !== null &&
      end.outcome !== outcomeOfStop(finish.stopReason)) ||
    (end?.responseId !== undefined && !equal(responseId, end.responseId)) ||
    (call.response?.responseId !== undefined &&
      !equal(responseId, call.response.responseId)) ||
    (end?.sdkUsage !== undefined && !equal(usage, endUsage)) ||
    (finish !== null &&
      end?.stopReason !== undefined &&
      finish.stopReason !== end.stopReason) ||
    (nativeFacts !== undefined && !equal(output, nativeFacts))
  )
    throw new DumpFailed({
      reason: `call ${call.callId} contradicts native assistant output or retained SDK response facts`,
    });
};

export const providerOutputAvailable = (call: Omit<CallRecord, "role">) =>
  outputFrames(call) !== null;

/** Compare the original retained frames through the complete pinned public SDK stream. */
export const providerOutput = async (
  call: Call,
  native?: ResponseMessage,
  snapshot: NativeSnapshot = { conversations: [], session: [] },
  run: RetainedSdkRun = retainedSdk,
  budget?: InspectionBudget,
) => {
  const frames = outputFrames(call, native);
  if (frames === null) return null;
  const message = await run(call, snapshot, undefined, budget, {
    purpose: frames.terminal ? "comparison" : "scalar-enumeration",
  });
  const normalized = ResponseMessage.parse(message);
  return responseFacts(normalized, frames.terminal);
};
