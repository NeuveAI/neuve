import { relayChargedProgress, validProgress } from "./progress-relay.ts";
import { Usage, UsageCounter } from "./inspection-protocol.ts";
import { closeCeiling, deadlineTimer } from "./watchdog.ts";
import Anthropic from "@anthropic-ai/sdk";
import { stream as responses } from "@earendil-works/pi-ai/api/openai-responses";
import { stream as anthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { NativeSnapshot } from "./sources.ts";
import { retainedContext } from "./retained-context.ts";
import {
  InspectionBudget,
  DEFAULT_INSPECTION_LIMITS,
} from "./credential-detectors.ts";
import { CallRecord } from "./dump.ts";
import { z } from "zod";
import {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} from "node:worker_threads";
import { Json, SdkInvocationEnd } from "./types.ts";
import type { OpenAIResponsesOptions } from "@earendil-works/pi-ai/api/openai-responses";
import type { AnthropicOptions } from "@earendil-works/pi-ai/api/anthropic-messages";

import { SdkDiagnostic, sdkFailure, sdkFrameType } from "./sdk-diagnostic.ts";

type Call = Omit<CallRecord, "role">;
type ReplayPurpose = { readonly purpose: "comparison" | "scalar-enumeration" };
export class RetainedSdkUnavailable extends Error {
  constructor(
    message: string,
    readonly diagnostic?: SdkDiagnostic,
    readonly failureKind?: "worker" | "cancelled",
  ) {
    super(message);
  }
}
const Keepalive = z.object({ type: z.literal("keepalive") });
const validateFrame = (name: string, data: unknown, index: number) => {
  if (name === "keepalive" && !Keepalive.safeParse(data).success)
    throw new RetainedSdkUnavailable("SDK keepalive framing invalid", {
      reason: "SDK keepalive framing invalid",
      callbacks: 0,
      originalCallbacks: null,
      frameIndex: index + 1,
      expectedFrameType: "keepalive",
      frameType: sdkFrameType(
        data !== null && typeof data === "object"
          ? Reflect.get(data, "type")
          : undefined,
      ),
    });
};
/** One SDK owner supplies both credential scalars and the final comparison view. */
const inspectInputs = (call: Call, budget: InspectionBudget) => {
  const frames = call.events.filter(
    ({ name }) =>
      name.startsWith("response.") ||
      name === "error" ||
      name === "keepalive" ||
      name.startsWith("message_") ||
      name.startsWith("content_block_"),
  );
  if (frames.length > 16384)
    throw new RetainedSdkUnavailable("SDK frame count exceeded");
  const prewalk = (value: unknown, depth = 0): number => {
    if (depth > budget.limits.depth)
      throw new RetainedSdkUnavailable("SDK input depth exceeded");
    let units = typeof value === "string" ? value.length : 1;
    if (value !== null && typeof value === "object")
      for (const key in value)
        if (Object.hasOwn(value, key)) {
          units += key.length + prewalk(Reflect.get(value, key), depth + 1);
          if (units > 1_048_576)
            throw new RetainedSdkUnavailable(
              "SDK input exceeds bounded synchronous fold",
            );
        }
    if (units > 1_048_576)
      throw new RetainedSdkUnavailable(
        "SDK input exceeds bounded synchronous fold",
      );
    budget.charge("parseUnits", units);
    return units;
  };
  if (call.sdkContext !== undefined) prewalk(call.sdkContext);
  for (const [index, { name, data }] of frames.entries()) {
    validateFrame(name, data, index);
    prewalk(data);
  }
  if (call.body.status === "sent") prewalk(call.body.json);
  return frames;
};
const foldSdk = async (
  call: Call,
  native: NativeSnapshot,
  keep: (value: string) => void = () => {},
  budget = new InspectionBudget(),
  options: ReplayPurpose = { purpose: "comparison" },
  progress: Omit<SdkDiagnostic, "reason"> = {
    callbacks: 0,
    originalCallbacks: null,
    frameIndex: 0,
    frameType: "other",
    expectedFrameType: "other",
  },
) => {
  const frames = inspectInputs(call, budget);
  const { model, context, invocation } = retainedContext(call, native);
  if (invocation === undefined || invocation.api !== model.api)
    throw new RetainedSdkUnavailable(
      "original SDK invocation semantics unavailable",
    );
  if (invocation.options.cacheRetention === undefined)
    throw new RetainedSdkUnavailable(
      "original SDK cache retention semantics unavailable",
    );
  const ends = call.events.filter(({ name }) => name === "sdk_invocation_end");
  if (ends.length > 1)
    throw new RetainedSdkUnavailable("SDK invocation end repeated");
  const ending =
    ends[0] === undefined ? undefined : SdkInvocationEnd.parse(ends[0].data);
  if (ending?.callId !== undefined && ending.callId !== call.callId)
    throw new RetainedSdkUnavailable(
      "SDK invocation end belongs to another call",
    );
  if (
    ending === undefined &&
    (call.end !== null || options.purpose !== "scalar-enumeration")
  )
    throw new RetainedSdkUnavailable(
      "original SDK terminal semantics unavailable",
    );
  if (ending?.abort.status === "aborted")
    throw new RetainedSdkUnavailable(
      "original SDK cancellation boundary unavailable",
    );
  progress.originalCallbacks = ending?.callbacks ?? null;
  const payload = call.body.status === "sent" ? call.body.json : undefined;
  if (
    payload === undefined ||
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  )
    throw new RetainedSdkUnavailable(
      "original SDK request payload unavailable",
    );
  let callbacks = 0;
  const providerBoundary = async (data: unknown) => {
    callbacks++;
    progress.callbacks = callbacks;
    progress.expectedFrameType = sdkFrameType(frames[callbacks - 1]?.name);
    progress.frameType = sdkFrameType(
      data !== null && typeof data === "object"
        ? Reflect.get(data, "type")
        : undefined,
    );
    await boundary();
  };
  let failure: unknown;
  let generatedUnits = 0;
  const scalars = new Set<string>();
  const deadline = budget.deadline;
  let output: AssistantMessage = {
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
    stopReason: "pending",
    timestamp: 0,
  };
  const scan = (value: unknown, depth = 0): void => {
    if (depth > budget.limits.depth)
      throw new RetainedSdkUnavailable("SDK scalar depth exceeded");
    generatedUnits++;
    if (generatedUnits > 32 * 1024 * 1024)
      throw new RetainedSdkUnavailable("SDK generated scalar bound exceeded");
    budget.charge("units", 1);
    if (typeof value === "string") {
      budget.charge("units", value.length);
      // Census identities are set based. Charge every visit as work, retaining each exact string once.
      if (!scalars.has(value)) {
        generatedUnits += value.length;
        if (generatedUnits > 32 * 1024 * 1024)
          throw new RetainedSdkUnavailable(
            "SDK generated scalar bound exceeded",
          );
        scalars.add(value);
        keep(value);
      }
    } else if (value !== null && typeof value === "object")
      for (const key in value)
        if (Object.hasOwn(value, key)) {
          scan(key, depth + 1);
          scan(Reflect.get(value, key), depth + 1);
        }
  };
  const safeScan = (value: unknown) => {
    try {
      scan(value);
    } catch (error) {
      failure ??= error;
      throw error;
    }
  };
  const boundary = async () => {
    if (deadline !== undefined && performance.now() >= deadline)
      throw new RetainedSdkUnavailable("SDK cooperative deadline exceeded");
    safeScan(output);
    await budget.checkpoint(budget.limits.yieldUnits);
    if (failure) throw failure;
  };
  const argumentUnavailable = (): never => {
    const error = new RetainedSdkUnavailable("retained-argument-escape");
    failure ??= error;
    throw error;
  };
  const finalArgumentEscapes = () => {
    for (const block of output.content) {
      if (!("partialJson" in block) || typeof block.partialJson !== "string")
        continue;
      const text = block.partialJson;
      for (let i = 0; i < text.length; i++) {
        if (text[i] !== "\\") continue;
        const escaped = text[++i];
        if (escaped === "u") {
          const digits = text.slice(i + 1, i + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(digits)) argumentUnavailable();
          i += 4;
        } else if (escaped !== undefined && !'"\\/bfnrt'.includes(escaped))
          argumentUnavailable();
      }
    }
  };
  let index = 0;
  const response = new Response(
    new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          await boundary();
          const frame = frames[index++];
          if (frame !== undefined) {
            progress.frameIndex = index;
            budget.progress();
          }
          if (frame === undefined) {
            finalArgumentEscapes();
            controller.close();
            return;
          }
          controller.enqueue(
            new TextEncoder().encode(
              `event: ${frame.name}\ndata: ${JSON.stringify(frame.data)}\n\n`,
            ),
          );
        },
      },
      { highWaterMark: 0 },
    ),
    { headers: { "content-type": "text/event-stream" } },
  );
  const offlineFetch = Object.assign(async () => response, { preconnect() {} });
  const observe = (stream: ReturnType<typeof responses>) => {
    const push = stream.push.bind(stream);
    stream.push = (event) => {
      if ("partial" in event) output = event.partial;
      else if (event.type === "done") output = event.message;
      else if (event.type === "error") output = event.error;
      try {
        safeScan(event);
      } catch (error) {
        failure ??= error;
      }
      if (event.type === "done" || event.type === "error") push(event);
    };
    return stream;
  };
  if (invocation.api === "openai-responses") {
    const invocationOptions = invocation.options as OpenAIResponsesOptions;
    const stream = observe(
      responses({ ...model, api: "openai-responses" }, context, {
        ...invocationOptions,
        apiKey: "retained-offline-dummy",
        env: {},
        maxRetries: 0,
        fetch: offlineFetch,
        onPayload: (params) => {
          safeScan(params);
          return payload;
        },
        onProviderStreamEvent: providerBoundary,
      }),
    );
    output = await stream.result();
    if (failure) throw failure;
  } else {
    if (invocation.authMode !== "non-oauth")
      throw new RetainedSdkUnavailable(
        "original SDK authentication semantics unavailable",
      );
    const invocationOptions = invocation.options as AnthropicOptions;
    if (Object.hasOwn(process.env, "ANTHROPIC_CUSTOM_HEADERS"))
      throw new RetainedSdkUnavailable(
        "ambient Anthropic custom headers prevent isolated replay",
      );
    const client = new Anthropic({
      apiKey: "retained-offline-dummy",
      authToken: null,
      webhookKey: null,
      logLevel: "off",
      logger: { error() {}, warn() {}, info() {}, debug() {} },
      baseURL: "https://capture.invalid",
      maxRetries: 0,
      fetch: offlineFetch,
    });
    const { sessionAffinityFormat, ...compat } = model.compat ?? {};
    const stream = anthropic(
      {
        ...model,
        api: "anthropic-messages",
        compat: {
          ...compat,
          ...(sessionAffinityFormat === "openrouter"
            ? { sessionAffinityFormat }
            : {}),
        },
      },
      context,
      {
        ...invocationOptions,
        client,
        env: {},
        maxRetries: 0,
        onPayload: (params) => {
          safeScan(params);
          return payload;
        },
        onProviderStreamEvent: providerBoundary,
      },
    );
    output = await observe(stream).result();
    if (failure) throw failure;
  }
  await boundary();
  if (ending !== undefined && callbacks !== ending.callbacks)
    throw new RetainedSdkUnavailable(
      "SDK callback count contradicts original invocation",
    );
  return Json.parse(JSON.parse(JSON.stringify(output)));
};

const WorkerInput = z.strictObject({
  id: z.int().positive(),
  call: CallRecord,
  limits: z.record(z.string(), z.number()),
  purpose: z.enum(["comparison", "scalar-enumeration"]),
  deadlineEpochMs: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
const WorkerMessage = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("progress"),
    id: z.int().positive(),
    units: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }),
  z.strictObject({
    type: z.literal("scalar"),
    id: z.int().positive(),
    value: z.string(),
  }),
  z.strictObject({
    type: z.literal("done"),
    id: z.int().positive(),
    value: Json,
    usage: Usage,
  }),
  z.strictObject({
    type: z.literal("unavailable"),
    id: z.int().positive(),
    diagnostic: SdkDiagnostic,
    usage: Usage,
    exhausted: UsageCounter.optional(),
  }),
]);

export type RetainedSdkRun = (
  call: Call,
  native: NativeSnapshot,
  keep?: (value: string) => void,
  budget?: InspectionBudget,
  options?: ReplayPurpose,
) => Promise<Json>;

export const withRetainedSdk = async <T>(
  use: (run: RetainedSdkRun) => Promise<T>,
): Promise<T> => {
  let worker: Worker | undefined;
  let next = 0;
  let active: number | null = null;
  let rejectActive: ((error: unknown) => void) | undefined;
  let failure: { readonly cause: unknown } | undefined;
  let closed = false;
  const fail = (error: unknown) => {
    failure ??= { cause: error };
    rejectActive?.(failure.cause);
  };
  const runJob: RetainedSdkRun = async (
    call,
    native,
    keep = () => {},
    budget = new InspectionBudget(),
    options = { purpose: "comparison" },
  ) => {
    if (failure !== undefined) throw failure.cause;
    if (closed) throw new RetainedSdkUnavailable("SDK inspection closed");
    if (active !== null) {
      const error = new RetainedSdkUnavailable("SDK inspection calls overlap");
      fail(error);
      throw error;
    }
    if (
      Object.hasOwn(process.env, "OPENAI_CUSTOM_HEADERS") ||
      Object.hasOwn(process.env, "ANTHROPIC_CUSTOM_HEADERS")
    )
      throw new RetainedSdkUnavailable(
        "ambient provider configuration prevents isolated replay",
      );
    const deadline =
      budget.deadline ??
      performance.now() +
        closeCeiling({
          records: call.events.length,
          bytes: 0,
          calls: 1,
          frames: call.events.length,
        });
    budget.charge("units", 0);
    inspectInputs(
      call,
      new InspectionBudget(budget.limits, budget.signal, deadline),
    );
    retainedContext(call, native);
    const limits = { ...budget.limits };
    const used = budget.usage;
    for (const kind of [
      "units",
      "fullChecks",
      "fullBytes",
      "matches",
      "parseUnits",
      "decodeUnits",
    ] as const)
      limits[kind] -= used[kind];
    const input = WorkerInput.parse({
      id: ++next,
      call: {
        ...call,
        role: call.purpose === undefined ? "unjoined" : "non-turn",
      },
      limits,
      purpose: options.purpose,
      deadlineEpochMs: Date.now() + Math.max(0, deadline - performance.now()),
    });
    if (worker === undefined) {
      worker = new Worker(
        new URL(
          import.meta.url.endsWith(".ts")
            ? "./retained-sdk-worker.ts"
            : "./retained-sdk-worker.js",
          import.meta.url,
        ),
        {
          env: { OPENAI_LOG: "off" },
          execArgv: [],
          workerData: { retainedSdk: true },
        },
      );
      worker.on("message", () => {
        if (active === null)
          fail(new RetainedSdkUnavailable("SDK worker emitted outside a job"));
      });
      worker.on("error", () =>
        fail(
          new RetainedSdkUnavailable(
            "isolated SDK worker failed",
            undefined,
            "worker",
          ),
        ),
      );
      worker.on("exit", () =>
        fail(
          new RetainedSdkUnavailable(
            "isolated SDK worker exited",
            undefined,
            "worker",
          ),
        ),
      );
    }
    const owner = worker;
    active = input.id;
    return await new Promise<Json>((resolve, reject) => {
      let settled = false;
      const finish = () => {
        settled = true;
        active = null;
        rejectActive = undefined;
        stopTimer();
        clearInterval(cancellation);
        owner.off("message", message);
        owner.off("error", error);
        owner.off("exit", exit);
      };
      const refuse = (cause: unknown) => {
        if (settled) return;
        failure ??= { cause };
        finish();
        reject(cause);
      };
      rejectActive = refuse;
      const stopTimer = deadlineTimer(deadline, () =>
        refuse(new RetainedSdkUnavailable("SDK worker deadline exceeded")),
      );
      const cancellation = setInterval(() => {
        try {
          budget.charge("units", 0);
        } catch (cause) {
          refuse(cause);
        }
      }, 25);
      let progressed = -1;
      const message = (raw: unknown) => {
        if (settled) return;
        try {
          const result = WorkerMessage.parse(raw);
          if (result.id !== input.id)
            throw new RetainedSdkUnavailable(
              "SDK worker job identity mismatch",
            );
          if (result.type === "progress") {
            if (
              !validProgress(
                progressed,
                result.units,
                Object.values(limits).reduce((sum, n) => sum + n, 0),
              )
            )
              throw new RetainedSdkUnavailable(
                "isolated SDK worker failed",
                undefined,
                "worker",
              );
            progressed = result.units;
            budget.progress();
          } else if (result.type === "scalar") {
            budget.charge("units", 0);
            keep(result.value);
          } else {
            for (const kind of [
              "units",
              "fullChecks",
              "fullBytes",
              "matches",
              "parseUnits",
              "decodeUnits",
            ] as const) {
              if (result.usage[kind] > limits[kind])
                throw new RetainedSdkUnavailable(
                  "isolated SDK worker failed",
                  undefined,
                  "worker",
                );
              budget.charge(kind, result.usage[kind]);
            }
            if (
              result.type === "unavailable" &&
              result.exhausted !== undefined
            ) {
              const kind = result.exhausted;
              budget.charge(kind, budget.limits[kind] - budget.usage[kind] + 1);
            }
            if (result.type === "done") {
              budget.progress();
              finish();
              resolve(result.value);
            } else
              refuse(
                new RetainedSdkUnavailable(
                  result.diagnostic.reason === "retained-argument-escape"
                    ? "retained-argument-escape"
                    : "isolated SDK replay unavailable",
                  result.diagnostic,
                ),
              );
          }
        } catch (cause) {
          refuse(cause);
        }
      };
      const error = () =>
        refuse(
          new RetainedSdkUnavailable(
            "isolated SDK worker failed",
            undefined,
            "worker",
          ),
        );
      const exit = () =>
        refuse(
          new RetainedSdkUnavailable(
            "isolated SDK worker exited",
            undefined,
            "worker",
          ),
        );
      owner.on("message", message);
      owner.on("error", error);
      owner.on("exit", exit);
      try {
        owner.postMessage(input);
      } catch (cause) {
        refuse(cause);
      }
    });
  };
  const run: RetainedSdkRun = async (...args) => {
    try {
      return await runJob(...args);
    } catch (cause) {
      fail(cause);
      throw cause;
    }
  };
  try {
    const value = await use(run);
    if (active !== null)
      fail(
        new RetainedSdkUnavailable(
          "SDK inspection ended with an active replay",
        ),
      );
    if (failure !== undefined) throw failure.cause;
    return value;
  } finally {
    closed = true;
    fail(new RetainedSdkUnavailable("SDK inspection closed"));
    if (worker !== undefined) {
      await worker.terminate();
      worker.removeAllListeners();
    }
  }
};

export const retainedSdk: RetainedSdkRun = (...args) =>
  withRetainedSdk((run) => run(...args));

export const runRetainedSdkWorker = () => {
  if (
    isMainThread ||
    parentPort === null ||
    !z.strictObject({ retainedSdk: z.literal(true) }).safeParse(workerData)
      .success
  )
    return;
  const port = parentPort;
  let expected = 1;
  let busy = false;
  port.on("message", (raw: unknown) => {
    const input = WorkerInput.safeParse(raw);
    if (!input.success || busy || input.data.id !== expected) {
      port.close();
      return;
    }
    busy = true;
    const job = input.data;
    const budget = new InspectionBudget(
      {
        ...DEFAULT_INSPECTION_LIMITS,
        ...job.limits,
      },
      undefined,
      performance.now() + Math.max(0, job.deadlineEpochMs - Date.now()),
    );
    const reportProgress = relayChargedProgress((units) =>
      port.postMessage({ type: "progress", id: job.id, units }),
    );
    budget.onProgress = () =>
      reportProgress(
        Object.values(budget.usage).reduce((sum, n) => sum + n, 0),
      );
    const progress: Omit<SdkDiagnostic, "reason"> = {
      callbacks: 0,
      originalCallbacks: null,
      frameIndex: 0,
      frameType: "other",
      expectedFrameType: "other",
    };
    void foldSdk(
      job.call,
      { conversations: [], session: [] },
      (value) => {
        port.postMessage({ type: "scalar", id: job.id, value });
      },
      budget,
      { purpose: job.purpose },
      progress,
    ).then(
      (value) => {
        busy = false;
        expected++;
        port.postMessage({
          type: "done",
          id: job.id,
          value,
          usage: budget.usage,
        });
      },
      (error: unknown) => {
        port.postMessage({
          type: "unavailable",
          id: job.id,
          diagnostic: { ...progress, reason: sdkFailure(error) },
          usage: budget.usage,
          exhausted: budget.exhausted,
        });
        port.close();
      },
    );
  });
};
