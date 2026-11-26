import { randomUUID } from "node:crypto";
import type {
  AnyModel,
  Api,
  AssistantMessage,
  Model,
  Models,
  ModelsApiStreamOptions,
  Context,
  ModelsSimpleStreamOptions,
  ModelsRequestTransforms,
  ProviderHeaders,
  ProviderRequestOptions,
} from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { sdkContextSnapshot } from "../capture/retained-context.ts";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type {
  ConversationId,
  HarnessSettings,
} from "@earendil-works/pi-durable";
import { CallCapture } from "./capture-write.ts";
import { rememberEphemeralCredentials } from "../capture/safety.ts";
import {
  CaptureFailed,
  CapturedEvent,
  CaptureScope,
  Json,
  type ModelCapture,
  type ModelCaptureEvent,
  type RequestBody,
} from "../capture/types.ts";
import {
  eventEvidence,
  historicalEvidence,
  type CredentialCapture,
} from "./credential-evidence.ts";
import {
  captureRouteFailure,
  routeFailureDiagnostic,
  schedulerText,
} from "./failure.ts";

export interface NativeModelsCaptureOptions {
  readonly capture: ModelCapture;
  readonly retry?: HarnessSettings["retry"] | undefined;
  readonly credentialInspection: CredentialCapture;
  readonly runId: string;
  readonly agent?: string | undefined;
  readonly conversationId?: ConversationId | undefined;
  readonly purpose?: "caption" | "recap" | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
}

const injectableApis = new Set([
  "openai-responses",
  "openai-completions",
  "azure-openai-responses",
  "anthropic-messages",
  "mistral-conversations",
  "pi-messages",
]);
const jsonCopy = (value: unknown): Json =>
  Json.parse(JSON.parse(JSON.stringify(value)));
const authenticated = (headers: Headers) =>
  [...headers].some(
    ([name, value]) =>
      /authorization|api[-_]?key|cookie/i.test(name) && value !== "",
  );
const providerHeaders = (headers: ProviderHeaders) => {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers))
    if (value !== null) result.set(name, value);
  return result;
};
const failedMessage = (
  model: Model<Api>,
  message = "Native model capture is unavailable",
): AssistantMessage => ({
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
  errorMessage: message,
  timestamp: Date.now(),
});

/** Decorates native Models operations without replacing providers, auth, catalogs or model metadata. */
export const captureNativeModels = (
  defaults: Models,
  options: NativeModelsCaptureOptions,
): Models => {
  const scope = CaptureScope.parse({
    runId: options.runId,
    ...(options.agent === undefined ? {} : { agent: options.agent }),
    ...(options.conversationId === undefined
      ? {}
      : { conversationId: options.conversationId }),
  });
  if (options.purpose !== undefined && scope.conversationId === undefined)
    throw new Error("An auxiliary native capture requires its conversation");

  const observe = <TModel extends AnyModel>(
    model: TModel,
    request: ProviderRequestOptions<TModel> & ModelsRequestTransforms = {},
    contextOf?: (
      id: string,
    ) => ReturnType<typeof sdkContextSnapshot> | undefined,
  ) => {
    let current:
      | {
          id: string;
          headers: Headers;
          guarded: boolean;
          actualHttp: boolean;
          writes: CallCapture;
        }
      | undefined;
    let assembledHeaders = new Headers();
    let received = false;
    const startedAt = Date.now();
    const captureAbort = new AbortController();
    let captureFailure: CaptureFailed | undefined;
    const failCapture = (error: unknown): never => {
      captureFailure ??=
        error instanceof CaptureFailed
          ? error
          : new CaptureFailed({
              kind: "invalid",
              event: "model capture",
              detail: "Native capture evidence or credential inspection failed",
            });
      captureAbort.abort();
      throw error;
    };
    const capture = options.capture;
    const checkedWrite = async (event: ModelCaptureEvent) => {
      const evidence = eventEvidence(
        jsonCopy(event),
        current?.headers ?? assembledHeaders,
      );
      let data = evidence.data;
      if (options.credentialInspection !== "ephemeral") {
        data = (
          await historicalEvidence(
            data,
            options.credentialInspection,
            (epochs) => {
              for (const callId of epochs)
                capture({
                  type: "credential.guard",
                  scope: { runId: scope.runId },
                  callId,
                  status: "exposed",
                });
            },
            undefined,
            current?.writes.lostRegistration,
          )
        ).data;
      }
      const parsed = CapturedEvent.parse(data);
      if (
        parsed.type === "model.request" ||
        parsed.type === "model.response" ||
        parsed.type === "model.event" ||
        parsed.type === "model.end"
      )
        await current?.writes.write(parsed, request.signal);
      else throw new Error("Native capture identity changed");
    };
    const write = (event: ModelCaptureEvent) =>
      checkedWrite(event).catch(failCapture);
    const event = async (name: string, data: Json) => {
      if (current === undefined) return;
      await write({
        type: "model.event",
        scope,
        callId: current.id,
        name,
        data,
      });
    };
    const begin = async (
      body: RequestBody,
      headers: Headers,
      path?: string,
    ) => {
      if (current !== undefined)
        await end(undefined, "Native HTTP attempt was retried");
      current = {
        id: randomUUID(),
        headers,
        guarded: authenticated(headers),
        actualHttp: path !== undefined,
        writes: new CallCapture(capture, options.retry),
      };
      received = false;
      if (current.guarded) {
        if (options.credentialInspection === "ephemeral")
          await rememberEphemeralCredentials(
            options.capture,
            scope.runId,
            current.id,
            headers,
          );
        else
          await current.writes.register(
            scope,
            current.id,
            options.credentialInspection,
            headers,
            request.signal,
          );
      }
      const sdkContext = current.actualHttp
        ? contextOf?.(current.id)
        : undefined;
      await write({
        type: "model.request",
        scope,
        callId: current.id,
        route: model.provider,
        provider: model.provider,
        model: model.id,
        api: model.api,
        ...(path === undefined ? {} : { path }),
        ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
        ...(sdkContext === undefined
          ? {}
          : {
              sdkContext: {
                ...sdkContext,
                unavailableReason:
                  "Native retained invocation capture is not certified",
              },
            }),
        headerNames: [...headers.keys()].sort(),
        credentialCoverage:
          !current.actualHttp || current.guarded ? "required" : "none",
        body,
      });
      if (current.guarded)
        await event("credential_guard", { status: "pending" });
      await event("native_capture_gap", {
        reason:
          "Native provider retained invocation is not certified for portable export",
        requestBody: body.status,
        credentialBoundary: current.actualHttp
          ? "observed-http"
          : "unavailable",
      });
    };
    const ensure = async () => {
      if (current === undefined)
        await begin(
          {
            status: "missing",
            reason: "Native transport did not expose its actual HTTP request",
          },
          assembledHeaders,
        ).catch(failCapture);
    };
    const response = async (status: number, headers: Headers) => {
      await ensure();
      if (received || current === undefined) return;
      received = true;
      const requestId =
        headers.get("x-request-id") ?? headers.get("request-id");
      await write({
        type: "model.response",
        scope,
        callId: current.id,
        status,
        ...(requestId === null ? {} : { requestId }),
      });
    };
    const end = async (
      message?: Pick<AssistantMessage, "timestamp" | "stopReason"> &
        Partial<
          Pick<AssistantMessage, "usage" | "responseId" | "errorMessage">
        >,
      failure?: string,
    ) => {
      await ensure();
      if (current === undefined) return;
      await event("native_call_timing", { startedAt, endedAt: Date.now() });
      if (current.guarded)
        await event("credential_guard", { status: "observed" });
      await write({
        type: "model.end",
        scope,
        callId: current.id,
        outcome:
          failure !== undefined || message?.stopReason === "error"
            ? "failed"
            : message?.stopReason === "aborted"
              ? "aborted"
              : "completed",
        ...(message === undefined
          ? {}
          : {
              messageTimestamp: message.timestamp,
              stopReason: message.stopReason,
              ...(message.responseId === undefined
                ? {}
                : { responseId: message.responseId }),
              ...(message.usage === undefined
                ? {}
                : {
                    sdkUsage: message.usage,
                    usage: {
                      input: message.usage.input,
                      output: message.usage.output,
                      cacheRead: message.usage.cacheRead,
                      cacheWrite: message.usage.cacheWrite,
                      ...(message.usage.reasoning === undefined
                        ? {}
                        : { reasoning: message.usage.reasoning }),
                      totalTokens: message.usage.totalTokens,
                    },
                  }),
            }),
        ...(failure === undefined && message?.errorMessage === undefined
          ? {}
          : {
              error: {
                message: current.actualHttp
                  ? (failure ?? message?.errorMessage ?? "Native model failed")
                  : "Native provider failed outside observed HTTP transport",
              },
            }),
      });
      current = undefined;
    };
    const base = request.fetch ?? options.fetch ?? globalThis.fetch;
    const fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const assembled = new Request(input, init);
        const text = await assembled.clone().text();
        let body: RequestBody;
        try {
          body = { status: "sent", json: Json.parse(JSON.parse(text)) };
        } catch {
          body = {
            status: "missing",
            reason: "Native HTTP request body is not JSON",
          };
        }
        await begin(
          body,
          assembled.headers,
          new URL(assembled.url).pathname,
        ).catch(failCapture);
        request.signal?.throwIfAborted();
        const result = await base(input, init);
        await response(result.status, result.headers);
        return result;
      },
      { preconnect: base.preconnect },
    );
    return {
      signal:
        request.signal === undefined
          ? captureAbort.signal
          : AbortSignal.any([request.signal, captureAbort.signal]),
      captureFailure: () => captureFailure,
      async transformHeaders(headers: ProviderHeaders) {
        const effective =
          (await request.transformHeaders?.(headers)) ?? headers;
        assembledHeaders = providerHeaders(effective);
        return effective;
      },
      ...(injectableApis.has(model.api) ? { fetch } : {}),
      async onPayload(payload: unknown, selected: TModel) {
        return request.onPayload?.(payload, selected);
      },
      async onResponse(
        value: { status: number; headers: Record<string, string> },
        selected: TModel,
      ) {
        await response(value.status, new Headers(value.headers));
        await request.onResponse?.(value, selected);
      },
      async providerEvent(value: unknown) {
        await ensure();
        if (current === undefined) return;
        // Unsupported transports expose no credential-complete boundary, so retain no provider payload.
        if (!current.actualHttp) return;
        const data = jsonCopy(value);
        const name =
          data !== null &&
          typeof data === "object" &&
          !Array.isArray(data) &&
          "type" in data &&
          typeof data["type"] === "string"
            ? data["type"]
            : "native_provider_event";
        await event(name, data);
      },
      async inspect(value: unknown) {
        await ensure();
        if (current === undefined) return;
        const evidence = eventEvidence(jsonCopy(value), current.headers);
        let exposed = evidence.bodyRedactions.length > 0;
        if (options.credentialInspection !== "ephemeral")
          await historicalEvidence(
            jsonCopy(value),
            options.credentialInspection,
            (epochs) => {
              exposed ||= epochs.length > 0;
              for (const callId of epochs)
                capture({
                  type: "credential.guard",
                  scope: { runId: scope.runId },
                  callId,
                  status: "exposed",
                });
            },
            undefined,
            current.writes.lostRegistration,
          );
        if (exposed) {
          if (current.guarded)
            capture({
              type: "credential.guard",
              scope: { runId: scope.runId },
              callId: current.id,
              status: "exposed",
            });
          throw new Error("Native model returned credential material");
        }
      },
      async failureText(cause: unknown) {
        if (!current?.actualHttp) return "Native model capture is unavailable";
        let data = eventEvidence(
          cause instanceof Error
            ? cause.message
            : "Native model operation failed",
          current.headers,
        ).data;
        if (options.credentialInspection !== "ephemeral")
          data = (
            await historicalEvidence(
              data,
              options.credentialInspection,
              () => {},
              undefined,
              current.writes.lostRegistration,
            )
          ).data;
        return typeof data === "string"
          ? data
          : "Native model operation failed";
      },
      end,
    };
  };

  const stream = <TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    request?: ModelsApiStreamOptions<TApi>,
  ): AssistantMessageEventStream => {
    const observer = observe<Model<Api>>(model, request, (id) =>
      model.api === "openai-responses" || model.api === "anthropic-messages"
        ? sdkContextSnapshot(id, model, normalizeContext(context))
        : undefined,
    );
    return relay(model, observer, () =>
      defaults.stream<Api>(model, context, {
        ...request,
        ...observer,
        onProviderStreamEvent: async (data, selected) => {
          await observer.providerEvent(data);
          await request?.onProviderStreamEvent?.(data, selected);
        },
      }),
    );
  };
  const streamSimple = (
    model: Model<Api>,
    context: Parameters<Models["streamSimple"]>[1],
    request: ModelsSimpleStreamOptions = {},
  ) => {
    const observer = observe<Model<Api>>(model, request, (id) =>
      model.api === "openai-responses" || model.api === "anthropic-messages"
        ? sdkContextSnapshot(id, model, normalizeContext(context))
        : undefined,
    );
    return relay(model, observer, () =>
      defaults.streamSimple(model, context, {
        ...request,
        ...observer,
        onProviderStreamEvent: async (data, selected) => {
          await observer.providerEvent(data);
          await request?.onProviderStreamEvent?.(data, selected);
        },
      }),
    );
  };
  const relay = (
    model: Model<Api>,
    observer: ReturnType<typeof observe<Model<Api>>>,
    open: () => AssistantMessageEventStream,
  ) => {
    const output = new AssistantMessageEventStream();
    void (async () => {
      try {
        const native = open();
        for await (const raw of native) {
          const captureFailure = observer.captureFailure();
          if (captureFailure !== undefined) throw captureFailure;
          const event = structuredClone(raw);
          await observer.inspect(event);
          if (event.type === "done" || event.type === "error")
            await observer.end(
              event.type === "done" ? event.message : event.error,
            );
          output.push(event);
        }
        output.end(await native.result());
      } catch (cause) {
        let text = "Native model capture is unavailable";
        try {
          text = await observer.failureText(cause);
        } catch {}
        let failure = failedMessage(model, text);
        try {
          if (observer.captureFailure() === undefined)
            await observer.end(failure);
        } catch {
          /* Capture failure must not expose provider error data. */
        }
        const rejected = observer.captureFailure();
        if (rejected !== undefined) {
          const route = captureRouteFailure(rejected.detail, rejected);
          failure = {
            ...failure,
            errorMessage: schedulerText("Model error", route),
            diagnostics: [routeFailureDiagnostic(route, failure.timestamp)],
          };
        }
        output.push({ type: "error", reason: "error", error: failure });
        output.end(failure);
      }
    })();
    return output;
  };
  const overrides: Partial<Models> = {
    stream,
    streamSimple,
    complete: (model, context, request) =>
      stream(model, context, request).result(),
    completeSimple: (model, context, request) =>
      streamSimple(model, context, request).result(),
    streamDeferred: (model, handle, request = {}) => {
      const observer = observe(model, request);
      return relay(model, observer, () =>
        defaults.streamDeferred(model, handle, { ...request, ...observer }),
      );
    },
    fetchDeferred: async (model, handle, request = {}) => {
      const observer = observe(model, request);
      const result = await defaults.fetchDeferred(model, handle, {
        ...request,
        ...observer,
      });
      await observer.inspect(result);
      await observer.end(result);
      return result;
    },
    cancelDeferred: async (model, handle, request = {}) => {
      const observer = observe(model, request);
      try {
        await defaults.cancelDeferred(model, handle, {
          ...request,
          ...observer,
        });
        await observer.end();
      } catch {
        await observer.end(undefined, "Native deferred cancellation failed");
        throw new Error("Native deferred cancellation failed");
      }
    },
    generateImages: async (model, context, request = {}) => {
      const observer = observe(model, request);
      const result = await defaults.generateImages(model, context, {
        ...request,
        ...observer,
      });
      await observer.inspect(result);
      await observer.end(result);
      return result;
    },
    classify: async (model, context, request = {}) => {
      const observer = observe(model, request);
      const result = await defaults.classify(model, context, {
        ...request,
        ...observer,
      });
      await observer.inspect(result);
      await observer.end(result);
      return result;
    },
  };
  return new Proxy(defaults, {
    get(target, key) {
      if (typeof key === "string" && key in overrides)
        return Reflect.get(overrides, key);
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};
