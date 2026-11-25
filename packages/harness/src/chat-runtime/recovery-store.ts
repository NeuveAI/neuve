import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { Blobs, Computations, JobQueue, Store, TurnRecovery, Worker, type StoreLocation } from "@neuve/records-core";
import { sharedWorkSocket } from "@neuve/records-core/shared-work-socket";
import { SharedWork, type SharedWorkTransport } from "@neuve/records-core/shared-work";
import { ContentBlock } from "@neuve/runtime";
import { z } from "zod";
import { TurnRecoveryPayload, type TurnRetryStatus } from "@neuve/records-schema";
import { RecoveryOwnershipUnknown, type RecoveryResult, type TurnRecoveryDriver } from "./recovery.ts";
import type { Log } from "./transcript.ts";

const Request = z.union([z.string(), z.array(ContentBlock)]);
/** Reuses the Records worker's socket claim, delayed jobs, deadlines and stalled-job recovery. */
export async function turnRecoveryStore(location: StoreLocation, log: Log = () => {}, transport: SharedWorkTransport = sharedWorkSocket()) {
  const sql = Store.layer(location, { create: true });
  const blobs = Blobs.layer(location).pipe(Layer.provide(sql), Layer.provide(BunFileSystem.layer));
  const computations = Computations.layer.pipe(Layer.provide(sql), Layer.provide(blobs));
  const queues = JobQueue.layer.pipe(Layer.provide(sql));
  const runtime = ManagedRuntime.make(Layer.mergeAll(sql, blobs, computations, queues, BunFileSystem.layer).pipe(Layer.provide(BunFileSystem.layer)));
  await runtime.runPromise(Store.prepareForWrite);
  const stop = new AbortController();
  const ready = Promise.withResolvers<void>();
  const worker = runtime.runPromise(Effect.scoped(Worker.run({
    location,
    handlers: {
      "chat.turn-retry@1": (job) => Effect.gen(function* () {
        log("chat-runtime.retry.delivery", { job: job.seq, event: job.eventId });
      }),
    },
    openSessions: Effect.succeed(1),
    afterRecovery: Effect.sync(() => ready.resolve()),
  })), { signal: stop.signal });
  void worker.then(() => ready.resolve(), (error: unknown) => ready.reject(error));
  await ready.promise;
  const waits = new SharedWork<TurnRecovery.RecoveryState, unknown>();
  const listeners = new Set<(chat: string, status: TurnRetryStatus) => Promise<void>>();
  const notify = async (state: TurnRecovery.RecoveryState) => {
    const status = await runtime.runPromise(TurnRecovery.status(state));
    await Promise.all([...listeners].map((listener) => listener(state.value.chat, status)));
    return state;
  };
  const executions = new SharedWork<RecoveryResult, unknown>();
  const driver: TurnRecoveryDriver = {
    async subscribe(listener) {
      listeners.add(listener);
      try { for (const state of await runtime.runPromise(TurnRecovery.statuses())) await listener(state.value.chat, await runtime.runPromise(TurnRecovery.status(state))); }
      catch (error) { listeners.delete(listener); throw error; }
      return () => { listeners.delete(listener); };
    },
    async execute(state, signal, run) {
      state = await runtime.runPromise(TurnRecovery.scheduledState(state));
      let takeover = false;
      let claimed = false;
      const read = async (publication?: string) => {
        const found = await runtime.runPromise(TurnRecovery.publishedResult(state.event, publication));
        if (!found) return undefined;
        const blob = await runtime.runPromise(Blobs.BlobStore.use((store) => store.get(found.hash)));
        if (blob._tag !== "Present") throw new Error("Retry publication is unavailable");
        const decoded = JSON.parse(new TextDecoder().decode(blob.bytes)) as RecoveryResult;
        TurnRecoveryPayload.parse(decoded.state.value);
        if (decoded.message && (decoded.message.role !== "assistant" || !Array.isArray(decoded.message.content)))
          throw new Error("Invalid retry response publication");
        return { publication: found.publication, outcome: { kind: "succeeded" as const, value: decoded } };
      };
      const result = await executions.run({
        scope: location.database, key: `chat.turn-attempt:${state.event}`, signal,
        crossProcess: { store: location.database, transport: {
          ...transport,
          claim: async (request) => {
            const opened = await transport.claim(request);
            if (opened.kind !== "connected") return opened;
            const claim = opened.claim;
            return { kind: "connected", claim: {
              next: async () => { const event = await claim.next(); if (event.kind === "claimed") claimed = true; return event; },
              withdraw: () => claim.withdraw(), settle: (outcome, publication) => claim.settle(outcome, publication), close: () => claim.close(),
            } };
          },
        }, read },
        onTakeover: async () => { takeover = true; },
        reportFloor: (notice) => log("chat-runtime.retry.shared-work.floor", { ...notice }),
        onEvent: (event) => { claimed ||= event.role === "holder" || event.role === "takeover"; log("chat-runtime.retry.shared-work", { turn: state.value.turn, attempt: state.value.attempt, ...event }); },
        run: async (sharedSignal) => {
          const prior = await read();
          if (prior) return prior;
          const current = await runtime.runPromise(TurnRecovery.current(state.value.turn));
          if (!current) throw new Error("Retry turn is missing");
          sharedSignal.throwIfAborted();
          signal.throwIfAborted();
          let value: RecoveryResult;
          if (!claimed && !takeover) {
            if (current.value.state !== "scheduled") throw new RecoveryOwnershipUnknown("Retry ownership cannot be established safely");
            value = { state: await notify(await runtime.runPromise(TurnRecovery.settle({ turn: current.value.turn, expected: current.event, state: "terminal", reason: "unsafe-continuation" }))) };
          } else if (current.value.state === "started") {
            if (!takeover && !claimed) throw new RecoveryOwnershipUnknown("Retry ownership cannot be established safely");
            const reconciled = await runtime.runPromise(TurnRecovery.reconcile(state.value.turn));
            value = { state: await notify(reconciled!) };
          } else value = await run(sharedSignal, state);
          sharedSignal.throwIfAborted();
          const blob = await runtime.runPromise(Blobs.BlobStore.use((store) => store.put({
            bytes: new TextEncoder().encode(JSON.stringify(value)), mediaType: "application/json", retention: "durable",
          })));
          const publication = await runtime.runPromise(TurnRecovery.publishResult(state, blob.blob.hash));
          return { publication, outcome: { kind: "succeeded", value } };
        },
      });
      if (result.outcome.kind === "failed") throw result.outcome.error;
      return result.outcome.value;
    },
    async saveRequest(request) {
      const stored = await runtime.runPromise(Blobs.BlobStore.use((blobs) => blobs.put({
        bytes: new TextEncoder().encode(JSON.stringify(Request.parse(request))),
        mediaType: "application/json", retention: "durable",
      })));
      return stored.blob.hash;
    },
    async loadRequest(hash) {
      const stored = await runtime.runPromise(Blobs.BlobStore.use((blobs) => blobs.get(hash)));
      if (stored._tag !== "Present") throw new Error("Recovery request is unavailable");
      return Request.parse(JSON.parse(new TextDecoder().decode(stored.bytes)));
    },
    latest: (chat) => runtime.runPromise(TurnRecovery.latest(chat)),
    find: (chat, generation) => runtime.runPromise(TurnRecovery.find(chat, generation)),
    begin: async (input) => notify(await runtime.runPromise(TurnRecovery.begin(input))),
    schedule: async (input) => {
      const state = await runtime.runPromise(TurnRecovery.schedule(input));
      log(`chat-runtime.retry.${state.value.state}`, { ...state.value, checkpoint: state.value.checkpoint.id });
      // The existing worker observes the database and owns the persisted next deadline.
      return notify(state);
    },
    async wait(state, signal) {
      const result = await waits.run({
        scope: location.database, key: state.event, signal,
        run: async (sharedSignal) => {
          const job = await runtime.runPromise(TurnRecovery.delivery(state.event));
          if (!job) throw new Error("Recovery schedule has no queue job");
          const subscription = await Worker.subscribeJob(location, job.seq, sharedSignal);
          try {
            for (;;) {
              const queued = await runtime.runPromise(JobQueue.JobQueue.use((q) => q.inspect(job.seq)));
              if (Option.isNone(queued)) throw new Error("Recovery queue job is missing");
              if (queued.value.state === "completed" || queued.value.state === "failed") {
                if (queued.value.state === "completed") {
                  const started = await runtime.runPromise(TurnRecovery.start(queued.value));
                  if (started) {
                    log("chat-runtime.retry.started", { turn: started.value.turn, attempt: started.value.attempt, checkpoint: started.value.checkpoint.id, job: job.seq });
                    await notify(started);
                    return { kind: "succeeded", value: started };
                  }
                }
                let current = await runtime.runPromise(TurnRecovery.current(state.value.turn));
                if (queued.value.state === "completed" && current?.value.state === "started")
                  throw new Error("Retry dispatch is owned by another execution");
                if (!current) throw new Error("Recovery state is missing");
                if (queued.value.state === "failed") current = await runtime.runPromise(TurnRecovery.settle({
                  turn: state.value.turn, expected: current.event, state: "terminal", reason: "unsafe-continuation",
                }));
                return { kind: "succeeded", value: current };
              }
              await subscription.next();
            }
          } finally { subscription.close(); }
        },
      });
      if (result.outcome.kind === "failed") throw result.outcome.error;
      return result.outcome.value;
    },
    settle: async (input) => {
      const state = await runtime.runPromise(TurnRecovery.settle(input));
      log(`chat-runtime.retry.${state.value.state}`, { turn: state.value.turn, attempt: state.value.attempt, reason: state.value.reason, checkpoint: state.value.checkpoint.id, job: state.value.job });
      return notify(state);
    },
    cancel: async (turn) => { const state = await runtime.runPromise(TurnRecovery.cancel(turn)); if (state) await notify(state); return state; },
  };
  return { driver, async close() {
    stop.abort();
    await worker.catch(() => {});
    await runtime.dispose();
  } };
}
