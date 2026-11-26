import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import {
  Blobs,
  JobQueue,
  Store,
  TurnRecovery,
  Worker,
  type StoreLocation,
} from "@neuve/records-core";
import { sharedWorkSocket } from "@neuve/records-core/shared-work-socket";
import {
  SharedWork,
  type SharedWorkTransport,
} from "@neuve/records-core/shared-work";
import { ContentBlock } from "@neuve/runtime";
import { z } from "zod";
import {
  TurnRecoveryPayload,
  type TurnRetryStatusState,
} from "@neuve/records-schema";
import {
  RecoveryOwnershipUnknown,
  type RecoveryResult,
  type TurnRecoveryDriver,
} from "./recovery.ts";
import type { Log } from "./transcript.ts";

const Request = z.union([z.string(), z.array(ContentBlock)]);
type StatusListener = Parameters<TurnRecoveryDriver["subscribe"]>[0];
export async function turnRecoveryStore(
  location: StoreLocation,
  options: {
    readonly namespace: string;
    readonly wake: (signal: AbortSignal) => Promise<void>;
    readonly log?: Log;
    readonly transport?: SharedWorkTransport;
  },
) {
  const { log = () => {}, transport = sharedWorkSocket(), wake } = options;
  const prefix = options.namespace ? `${options.namespace}/` : "";
  const sql = Store.layer(location, { create: true });
  const blobs = Blobs.layer(location).pipe(
    Layer.provide(sql),
    Layer.provide(BunFileSystem.layer),
  );
  const queues = JobQueue.layer.pipe(Layer.provide(sql));
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(sql, blobs, queues).pipe(Layer.provide(BunFileSystem.layer)),
  );
  try {
    await runtime.runPromise(Store.prepareForWrite);
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
  const listeners = new Set<StatusListener>();
  const notifyListener = async (
    listener: StatusListener,
    state: TurnRecovery.RecoveryState,
    status: TurnRetryStatusState,
  ) => {
    const chat = state.value.chat.slice(prefix.length);
    try {
      await listener(chat, status);
    } catch {
      log("chat-runtime.retry.status.failed", {
        chat,
        turn: state.value.turn,
        event: state.event,
      });
    }
  };
  const notify = async (state: TurnRecovery.RecoveryState) => {
    const status = await runtime.runPromise(TurnRecovery.status(state));
    for (const listener of listeners)
      await notifyListener(listener, state, status);
    return state;
  };
  const scoped = <T extends TurnRecovery.RecoveryOrigin>(input: T): T =>
    input.first === undefined
      ? input
      : {
          ...input,
          first: { ...input.first, chat: prefix + input.first.chat },
        };
  const executions = new SharedWork<RecoveryResult, unknown>();
  const driver: TurnRecoveryDriver = {
    async subscribe(listener) {
      listeners.add(listener);
      try {
        for (const state of await runtime.runPromise(
          TurnRecovery.statuses(prefix),
        ))
          await notifyListener(
            listener,
            state,
            await runtime.runPromise(TurnRecovery.status(state)),
          );
      } catch (error) {
        listeners.delete(listener);
        throw error;
      }
      return () => {
        listeners.delete(listener);
      };
    },
    async execute(state, signal, run) {
      state = await runtime.runPromise(TurnRecovery.scheduledState(state));
      let claimed = false;
      const read = async (publication?: string) => {
        const found = await runtime.runPromise(
          TurnRecovery.publishedResult(state.event, publication),
        );
        if (!found) return undefined;
        const blob = await runtime.runPromise(
          Blobs.BlobStore.use((store) => store.get(found.hash)),
        );
        if (blob._tag !== "Present")
          throw new Error("Retry publication is unavailable");
        const decoded = JSON.parse(
          new TextDecoder().decode(blob.bytes),
        ) as RecoveryResult;
        TurnRecoveryPayload.parse(decoded.state.value);
        if (
          decoded.message &&
          (decoded.message.role !== "assistant" ||
            !Array.isArray(decoded.message.content))
        )
          throw new Error("Invalid retry response publication");
        return {
          publication: found.publication,
          outcome: { kind: "succeeded" as const, value: decoded },
        };
      };
      const result = await executions.run({
        scope: location.database,
        key: `chat.turn-attempt:${state.event}`,
        signal,
        crossProcess: { store: location.database, transport, read },
        reportFloor: ({ floor }) =>
          log("chat-runtime.retry.shared-work.floor", { floor }),
        onEvent: (event) => {
          claimed = event.role === "holder" || event.role === "takeover";
          log("chat-runtime.retry.shared-work", {
            turn: state.value.turn,
            attempt: state.value.attempt,
            ...event,
          });
        },
        run: async (sharedSignal) => {
          const prior = await read();
          if (prior) return prior;
          const current = await runtime.runPromise(
            TurnRecovery.current(state.value.turn),
          );
          if (!current) throw new Error("Retry turn is missing");
          sharedSignal.throwIfAborted();
          signal.throwIfAborted();
          let value: RecoveryResult;
          if (!claimed)
            throw new RecoveryOwnershipUnknown(
              "Retry ownership cannot be established safely",
            );
          if (
            current.event !== state.event &&
            current.value.state !== "started"
          ) {
            value = { state: current };
          } else if (current.value.state === "started") {
            const reconciled = await runtime.runPromise(
              TurnRecovery.reconcile(state.value.turn, state.event),
            );
            value = { state: await notify(reconciled) };
          } else {
            value = await run(sharedSignal, state);
          }
          sharedSignal.throwIfAborted();
          const blob = await runtime.runPromise(
            Blobs.BlobStore.use((store) =>
              store.put({
                bytes: new TextEncoder().encode(JSON.stringify(value)),
                mediaType: "application/json",
                retention: "durable",
              }),
            ),
          );
          const publication = await runtime.runPromise(
            TurnRecovery.publishResult(state, blob.blob.hash),
          );
          return { publication, outcome: { kind: "succeeded", value } };
        },
      });
      if (result.outcome.kind === "failed") throw result.outcome.error;
      return result.outcome.value;
    },
    async saveRequest(request) {
      const stored = await runtime.runPromise(
        Blobs.BlobStore.use((blobs) =>
          blobs.put({
            bytes: new TextEncoder().encode(
              JSON.stringify(Request.parse(request)),
            ),
            mediaType: "application/json",
            retention: "durable",
          }),
        ),
      );
      return stored.blob.hash;
    },
    async loadRequest(hash) {
      const stored = await runtime.runPromise(
        Blobs.BlobStore.use((blobs) => blobs.get(hash)),
      );
      if (stored._tag !== "Present")
        throw new Error("Recovery request is unavailable");
      return Request.parse(JSON.parse(new TextDecoder().decode(stored.bytes)));
    },
    latest: (chat) => runtime.runPromise(TurnRecovery.latest(prefix + chat)),
    find: (chat, generation) =>
      runtime.runPromise(TurnRecovery.find(prefix + chat, generation)),
    begin: async (input) =>
      notify(
        await runtime.runPromise(
          TurnRecovery.begin({ ...input, chat: prefix + input.chat }),
        ),
      ),
    schedule: async (input) => {
      const state = await runtime.runPromise(
        TurnRecovery.schedule(scoped(input)),
      );
      const { turn, attempt, reason, nextAt, checkpoint } = state.value;
      const job = await runtime.runPromise(TurnRecovery.delivery(state.event));
      log(`chat-runtime.retry.${state.value.state}`, {
        turn,
        event: state.event,
        attempt,
        reason,
        nextAt,
        checkpoint: checkpoint.id,
        job: job?.seq,
      });
      return notify(state);
    },
    async wait(state, signal) {
      const job = await runtime.runPromise(TurnRecovery.delivery(state.event));
      if (!job) throw new Error("Recovery schedule has no queue job");
      let subscription:
        Awaited<ReturnType<typeof Worker.subscribeJob>> | undefined;
      try {
        await wake(signal);
        for (;;) {
          signal.throwIfAborted();
          const current = await runtime.runPromise(
            TurnRecovery.current(state.value.turn),
          );
          if (!current) throw new Error("Recovery state is missing");
          signal.throwIfAborted();
          if (current.event !== state.event) return current;
          const queued = await runtime.runPromise(
            JobQueue.JobQueue.use((queue) => queue.inspect(job.seq)),
          );
          if (Option.isNone(queued))
            throw new Error("Recovery queue job is missing");
          if (queued.value.state === "failed") {
            return driver.settle({
              turn: state.value.turn,
              expected: state.event,
              state: "terminal",
              reason: "unsafe-continuation",
            });
          }
          if (queued.value.state === "completed") {
            const started = await runtime.runPromise(
              TurnRecovery.start(queued.value),
            );
            if (started) {
              log("chat-runtime.retry.started", {
                turn: started.value.turn,
                attempt: started.value.attempt,
                checkpoint: started.value.checkpoint.id,
                job: job.seq,
              });
              return notify(started);
            }
            const latest = await runtime.runPromise(
              TurnRecovery.current(state.value.turn),
            );
            if (latest && latest.event !== state.event) return latest;
            throw new Error("Retry delivery could not start");
          }
          try {
            if (!subscription) {
              subscription = await Worker.subscribeJob(
                location,
                job.seq,
                signal,
              );
              // Completion may have committed between the queue read and subscription.
              continue;
            }
            if ((await subscription.next()) === "held")
              throw new Error("Recovery queue job is held");
          } catch (error) {
            signal.throwIfAborted();
            if (!(error instanceof Worker.WorkerSubscriptionLost)) throw error;
            subscription?.close();
            subscription = undefined;
            await wake(signal);
          }
        }
      } finally {
        subscription?.close();
      }
    },
    settle: async (input) => {
      const state = await runtime.runPromise(
        TurnRecovery.settle(scoped(input)),
      );
      log(`chat-runtime.retry.${state.value.state}`, {
        turn: state.value.turn,
        attempt: state.value.attempt,
        reason: state.value.reason,
        checkpoint: state.value.checkpoint.id,
        job: state.value.job,
      });
      return notify(state);
    },
    cancel: async (turn) => {
      const state = await runtime.runPromise(TurnRecovery.cancel(turn));
      if (state) await notify(state);
      return state;
    },
  };
  return { driver, close: () => runtime.dispose() };
}
