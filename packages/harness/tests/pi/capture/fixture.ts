import { decodeDumpJournal } from "../../../src/pi/capture/journal.ts";
import { fileURLToPath } from "node:url";
import { watch } from "node:fs";
import { dirname } from "node:path";
import { ScanMachineBudget } from "../../../src/pi/capture/process.ts";
import {
  scanMemoryGrant,
  machineInspectionInputs,
} from "../../../src/pi/capture/inspection-pool.ts";
import { randomUUID } from "node:crypto";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Exit, Layer, Option } from "effect";
import {
  Blobs,
  Computations,
  Store,
  JobQueue,
  Worker,
  type StoreLocation,
} from "@neuve/records-core";
import {
  Type,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { createModels, type Provider } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type {
  Capture,
  CaptureScope,
  TokenUsage,
} from "../../../src/pi/capture/types.ts";

export const recordsLayer = (location: StoreLocation) =>
  Blobs.layer(location).pipe(
    Layer.provideMerge(Store.layer(location, { create: true })),
    Layer.provideMerge(BunFileSystem.layer),
  );

export const runIn =
  (location: StoreLocation) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.runPromiseExit(
      Effect.andThen(Store.prepareForWrite, effect).pipe(
        Effect.provide(recordsLayer(location)),
      ) as Effect.Effect<A, E, never>,
    );

export const value = <A, E>(exit: Exit.Exit<A, E>): A => {
  if (Exit.isFailure(exit))
    throw new Error(`expected success: ${String(exit.cause)}`);
  return exit.value;
};

export const usage = (input: number, output: number, cacheRead = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite: 0,
  totalTokens: input + output + cacheRead,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const tokenUsage = (message: AssistantMessage): TokenUsage => ({
  input: message.usage.input,
  output: message.usage.output,
  cacheRead: message.usage.cacheRead,
  cacheWrite: message.usage.cacheWrite,
  totalTokens: message.usage.totalTokens,
});

/** An encrypted reasoning item the route replays on every request, as the OpenAI route does. */
export const ENCRYPTED = "gAAAAB-encrypted-reasoning-blob";

export interface Route {
  readonly models: ReturnType<typeof createModels>;
  /** The scripted model behind the route, which counts the requests that reached it. */
  readonly faux: ReturnType<typeof fauxProvider>;
  /** The same model streaming slowly, under provider `openai-slow`, for a cutoff mid-stream. */
  readonly slow: ReturnType<typeof fauxProvider>;
  /** Scripts a response with the usage the provider reports when it completes; the faux model would estimate it. */
  readonly step: (
    message: AssistantMessage,
    tokens: ReturnType<typeof usage>,
  ) => AssistantMessage;
  /** The next request is answered with HTTP 500 before the model sees it. */
  readonly failNext: () => void;
  /** Extra request fields, such as a reasoning summary request. */
  readonly body: Record<string, unknown>;
}

/**
 * A provider wrapped the way the route's provider emits capture: `model.request` with the body as
 * sent before it dispatches, `model.response` on the first stream event with the response ID, each
 * function call's `response.output_item.done` with the model's raw argument text, and `model.end`
 * with the message's timestamp and usage. A capture that throws settles the stream as failed; a
 * failed `model.request` means the scripted model is never asked.
 */
export const route = (capture: Capture, scope: CaptureScope): Route => {
  const faux = fauxProvider({
    provider: "openai",
    api: "faux",
    models: [{ id: "gpt-5.5" }],
  });
  const slow = fauxProvider({
    provider: "openai-slow",
    api: "faux",
    models: [{ id: "gpt-5.5" }],
    tokensPerSecond: 20,
  });
  let calls = 0;
  let failing = false;
  const body: Record<string, unknown> = {};
  const scripted = new Map<string, ReturnType<typeof usage>>();
  const routed = (inner: Provider): Provider =>
    new Proxy(inner, {
      get: (target, key, receiver) =>
        key !== "streamSimple"
          ? Reflect.get(target, key, receiver)
          : (
              model: Model<string>,
              request: TranscriptContext,
              streamOptions?: SimpleStreamOptions,
            ) => {
              calls += 1;
              const callId = randomUUID();
              const out = createAssistantMessageEventStream();
              const settle = (message: AssistantMessage) => {
                out.push({ type: "error", reason: "error", error: message });
                out.end(message);
              };
              const failed = (
                errorMessage: string,
                timestamp: number,
              ): AssistantMessage => ({
                role: "assistant",
                content: [],
                api: model.api,
                provider: model.provider,
                model: model.id,
                usage: usage(0, 0),
                stopReason: "error",
                errorMessage,
                timestamp,
              });
              const common = { scope, callId };
              try {
                capture({
                  type: "model.request",
                  ...common,
                  route: "chatgpt",
                  provider: model.provider,
                  model: model.id,
                  logicalRoute: model.provider,
                  api: "faux",
                  path: "/backend-api/codex/responses",
                  credentialCoverage: "none",
                  headerNames: ["content-type", "session-id"],
                  body: {
                    status: "sent",
                    json: JSON.parse(
                      JSON.stringify({
                        model: model.id,
                        input: [
                          {
                            type: "reasoning",
                            encrypted_content: ENCRYPTED,
                            summary: [],
                          },
                          ...request.messages,
                        ],
                        include: ["reasoning.encrypted_content"],
                        ...body,
                      }),
                    ),
                  },
                });
              } catch (error) {
                settle(
                  failed(
                    `capture failed before dispatch: ${String(error)}`,
                    Date.now(),
                  ),
                );
                return out;
              }
              void (async () => {
                try {
                  if (failing) {
                    failing = false;
                    const message = failed("upstream 500", Date.now() + calls);
                    capture({
                      type: "model.response",
                      ...common,
                      status: 500,
                      requestId: `req-${callId}`,
                    });
                    capture({
                      type: "model.end",
                      ...common,
                      outcome: "failed",
                      messageTimestamp: message.timestamp,
                      stopReason: "error",
                      error: { type: "server_error", message: "upstream 500" },
                    });
                    settle(message);
                    return;
                  }
                  let responded = false;
                  for await (const event of target.streamSimple(
                    model,
                    request,
                    streamOptions,
                  )) {
                    if (event.type === "done" || event.type === "error") {
                      const tokens = scripted.get(
                        event.type === "done"
                          ? (event.message.responseId ?? "")
                          : "",
                      );
                      const message =
                        event.type === "done"
                          ? {
                              ...event.message,
                              ...(tokens === undefined
                                ? {}
                                : { usage: tokens }),
                            }
                          : event.error;
                      for (const content of message.content)
                        if (content.type === "toolCall")
                          capture({
                            type: "model.event",
                            ...common,
                            name: "response.output_item.done",
                            data: {
                              type: "function_call",
                              call_id: content.id,
                              name: content.name,
                              arguments: JSON.stringify(
                                content.arguments,
                                null,
                                1,
                              ),
                            },
                          });
                      capture({
                        type: "model.end",
                        ...common,
                        outcome:
                          event.type === "done"
                            ? "completed"
                            : event.reason === "aborted"
                              ? "aborted"
                              : "failed",
                        ...(message.responseId === undefined
                          ? {}
                          : { responseId: message.responseId }),
                        messageTimestamp: message.timestamp,
                        stopReason: message.stopReason,
                        ...(event.type === "done"
                          ? {
                              usage: tokenUsage(message),
                              sdkUsage: message.usage,
                            }
                          : {}),
                        ...(message.errorMessage === undefined
                          ? {}
                          : { error: { message: message.errorMessage } }),
                      });
                      out.push(
                        event.type === "done" ? { ...event, message } : event,
                      );
                      continue;
                    }
                    if (!responded) {
                      responded = true;
                      capture({
                        type: "model.response",
                        ...common,
                        status: 200,
                        requestId: `req-${callId}`,
                        ...(event.partial.responseId === undefined
                          ? {}
                          : { responseId: event.partial.responseId }),
                      });
                    }
                    out.push(event);
                  }
                  out.end();
                } catch (error) {
                  settle(
                    failed(`capture failed: ${String(error)}`, Date.now()),
                  );
                }
              })();
              return out;
            },
    });
  const models = createModels();
  models.setProvider(routed(faux.provider));
  models.setProvider(routed(slow.provider));
  return {
    models,
    faux,
    slow,
    step: (message, tokens) => {
      scripted.set(message.responseId!, tokens);
      return message;
    },
    failNext: () => {
      failing = true;
    },
    body,
  };
};

/** A read tool with a large result, and a tool that hands a task to a task-owned child conversation. */
export const Lab = defineExtension({
  name: "lab",
  tools: [
    defineTool({
      name: "read_file",
      description: "Read a file.",
      parameters: Type.Object({ path: Type.String() }),
      execute: async () => ({
        content: [
          {
            type: "text",
            text: 'owner: "ann@example.com"\nsecond line\nbob@example.com',
          },
        ],
      }),
    }),
    defineTool({
      name: "delegate",
      description: "Ask a subagent.",
      parameters: Type.Object({ task: Type.String() }),
      execute: async (args, api, ctx) => {
        const child = await api.commit(
          async (tx) =>
            (
              await tx.createConversation({
                ownership: { kind: "task", taskId: api.taskId },
              })
            ).id,
          ctx,
        );
        const handle = await api.conversation(child, ctx);
        const settled = await (
          await handle!.submit(
            {
              type: "input",
              content: args.task,
              requestId: `delegate:${api.taskId}`,
            },
            ctx,
          )
        ).wait(ctx);
        return { content: [{ type: "text", text: settled.status }] };
      },
    }),
  ],
});

export const MODEL = { provider: "openai", modelId: "gpt-5.5" } as const;

/** Runs queued capture jobs as the Records worker does, without starting other job kinds. */
/**
 * Waits until the store's worker answers on its socket. A coding close starts that worker and returns
 * before it listens; under load its start outlasts `stopStoreWorker`'s fixed count of 100-millisecond
 * probes, which then returns with the worker still starting, to race the caller's own scan. Woken by
 * the socket's folder changing, rechecked each second in case an event is missed; the bound only names
 * a worker that never starts.
 */
export const awaitStoreWorker = async (
  location: StoreLocation,
  boundMs = 60_000,
) => {
  const socket = await Effect.runPromise(Worker.socketPathFor(location));
  const deadline = Date.now() + boundMs;
  for (;;) {
    let wake = () => {};
    const changed = new Promise<void>((resolve) => (wake = resolve));
    const watcher = watch(dirname(socket), () => wake());
    const recheck = setTimeout(() => wake(), 1_000);
    try {
      const reach = await Effect.runPromise(
        Worker.reachWorker(socket, "status"),
      );
      if (reach._tag === "Answered") return;
      if (Date.now() >= deadline)
        throw new Error(
          `the store worker at ${socket} did not answer within ${boundMs} ms`,
        );
      // A connected worker that has not answered yet is asked again at once.
      if (reach._tag !== "Unanswered") await changed;
    } finally {
      clearTimeout(recheck);
      watcher.close();
    }
  }
};

export const scanCaptures = (location: StoreLocation) =>
  Effect.gen(function* () {
    const { captureScanHandler } = yield* Effect.promise(
      () => import("../../../src/pi/capture/job.ts"),
    );
    const queue = yield* JobQueue.JobQueue;
    for (;;) {
      const job = yield* queue.take(["capture.scan"]);
      if (Option.isNone(job)) break;
      const outcome = yield* Effect.result(
        captureScanHandler({
          location,
          command: [
            process.execPath,
            "--no-env-file",
            fileURLToPath(
              new URL(
                "../../../../../apps/neuve-cli/src/cli.ts",
                import.meta.url,
              ),
            ),
          ],
        })(job.value),
      );
      if (outcome._tag === "Failure") {
        yield* queue.fail(job.value.seq, job.value.attempts, {
          tag: "DumpFailed",
          message: String(outcome.failure),
        });
        return yield* Effect.fail(outcome.failure);
      }
      yield* queue.complete(job.value.seq, job.value.attempts);
    }
  }).pipe(
    Effect.provide(JobQueue.layer),
    Effect.provide(Computations.layer),
    Effect.provideService(ScanMachineBudget, (sizes) =>
      scanMemoryGrant(sizes, {
        ...machineInspectionInputs(),
        available: 8 * 1024 ** 3,
      }),
    ),
  );

export const dumpJournalLines = (files: ReadonlyMap<string, Uint8Array>) => {
  const journal = decodeDumpJournal(files);
  if (journal._tag !== "Read")
    throw new Error("Fixture dump journal is unreadable");
  return journal.lines;
};
