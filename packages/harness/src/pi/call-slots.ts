import type {
  Api,
  Context as ModelContext,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Model,
  Provider,
} from "@earendil-works/pi-ai";
import { lazyStream } from "@earendil-works/pi-ai/api/lazy";
import { Effect } from "effect";
import {
  LIMIT_CAUSE,
  LIMIT_CAUSE_COUNT,
  Scheduler,
  type Budget,
  type Numbers,
  type Priority,
  type Observation,
} from "../budget/scheduler.ts";
import {
  acquireGrant,
  type BudgetAdmissionFailed,
  type OnBudgetYield,
} from "../budget/acquire.ts";
import { recordBudget } from "../budget/telemetry.ts";
import {
  CurrentAttempt,
  genAiAttributes,
  type AttemptMetrics,
  recordLate,
  withSlot,
} from "../telemetry.ts";

/** Runs a slot's Effect where the attempt's telemetry is; `signal` interrupts its wait. */
export type RunSlot = <A, E>(
  effect: Effect.Effect<A, E>,
  signal: AbortSignal | undefined,
) => Promise<A>;

type SlotRelease = ((observation?: Observation) => void) & {
  readonly signal?: AbortSignal | undefined;
};

export interface CallSlots {
  /** Resolves with the slot's release once one is free; rejects when the wait ends without one. */
  readonly acquire: (
    attributes: Record<string, string>,
    signal: AbortSignal | undefined,
    priority?: Priority,
  ) => Promise<SlotRelease>;
}

export interface CallSlotOptions {
  readonly budget: Budget;
  /** SHA-256 of provider endpoint plus credential source identity, excluding model and secrets. */
  readonly account: string;
  readonly owner: string;
  readonly priority: () => Priority;
  readonly onYield?: OnBudgetYield;
}

const causeNames = new Map<number, string>(
  Object.entries(LIMIT_CAUSE).map(([name, code]) => [code, name]),
);
/** Per attempt, then per account and limiter: the most decisions it has written a line for. */
const loggedDecisions = new WeakMap<AttemptMetrics, Map<string, number>>();

/** One run-log line per limiter decision a grant's or a release's numbers first show a run. */
const recordLimit = (account: string, numbers: Numbers) =>
  recordLate(
    Effect.gen(function* () {
      const decisions = numbers.limitChanges,
        cause = numbers.cause;
      if (!decisions || cause === undefined || numbers.limit === undefined)
        return;
      const attempt = yield* CurrentAttempt;
      if (!attempt) return;
      const logged = loggedDecisions.get(attempt) ?? new Map<string, number>();
      loggedDecisions.set(attempt, logged);
      const key = `${account}:${numbers.limiterSince ?? 0}`;
      if ((logged.get(key) ?? 0) >= decisions) return;
      logged.set(key, decisions);
      attempt.log.write({
        type: "budget.limit",
        limit: numbers.limit,
        change: numbers.change ?? 0,
        cause: causeNames.get(cause) ?? "unknown",
        ...Object.fromEntries(
          Object.values(LIMIT_CAUSE_COUNT).flatMap((name) =>
            numbers[name] === undefined ? [] : [[name, numbers[name]]],
          ),
        ),
      });
    }),
  );

/** The slot wait's attributes for the call's owner and its place in the queue. */
const slotAttributes = (owner: string, priority: Priority) => ({
  "harness.slot.owner": owner,
  "harness.slot.band": priority.reading ? "reading" : "turn",
  "harness.slot.position": priority.position,
  "harness.slot.stage": String(priority.stage),
  ...(priority.reading
    ? { "harness.slot.rank": String(priority.reading.rank) }
    : {}),
});

export const callSlots = (
  limit: number,
  run: RunSlot,
  options?: CallSlotOptions,
): CallSlots => {
  const budget = options?.budget ?? new Scheduler(limit, limit, limit);
  const account = options?.account ?? "0".repeat(64);
  let usedFloor = false;
  const measure = async () => {
    try {
      return (await budget.measure?.(account)) ?? {};
    } catch {
      return {};
    }
  };
  return {
    acquire: (attributes, signal, requested) =>
      new Promise((admit, refuse) => {
        const owner = options?.owner ?? "run";
        const priority = requested ??
          options?.priority() ?? {
            class: "interactive",
            position: "new",
            stage: 0,
          };
        let admitted = false;
        let observation: Observation | undefined;
        let hostSignal: AbortSignal | undefined;
        let recordGrant: Effect.Effect<void> = Effect.void;
        const slots = {
          withPermits:
            (_n: number) =>
            <A, E, R>(effect: Effect.Effect<A, E, R>) =>
              Effect.acquireUseRelease(
                Effect.interruptible(
                  acquireGrant(
                    budget,
                    {
                      owner,
                      priority,
                      resource: { kind: "provider", account },
                    },
                    options?.onYield,
                  ),
                ),
                (grant) =>
                  Effect.suspend(() => {
                    hostSignal = grant.signal;
                    usedFloor ||= grant.floor === true;
                    recordGrant = Effect.flatMap(
                      Effect.promise(async () => ({
                        ...(await measure()),
                        ...grant.numbers,
                        floor: usedFloor ? 1 : 0,
                      })),
                      (numbers) =>
                        Effect.andThen(
                          recordBudget(numbers),
                          recordLimit(account, numbers),
                        ),
                    );
                    return effect;
                  }),
                (grant) =>
                  Effect.flatMap(
                    Effect.promise(async () => {
                      await grant.release(observation);
                      return {
                        ...(await measure()),
                        floor: usedFloor ? 1 : 0,
                      };
                    }),
                    (numbers) =>
                      Effect.andThen(
                        recordBudget(numbers),
                        recordLimit(account, numbers),
                      ),
                  ),
              ),
        };

        const held = Effect.uninterruptible(
          Effect.promise(
            () =>
              new Promise<void>((release) => {
                admitted = true;
                admit(
                  Object.assign(
                    (sample?: Observation) => {
                      observation = sample;
                      release();
                    },
                    { signal: hostSignal },
                  ),
                );
              }),
          ),
        );
        run(
          withSlot<BudgetAdmissionFailed>(slots, {
            ...attributes,
            ...slotAttributes(owner, priority),
          })(
            Effect.andThen(
              Effect.suspend(() => recordGrant),
              held,
            ),
          ),
          signal,
        ).catch((error: unknown) => {
          if (!admitted) refuse(error);
        });
      }),
  };
};

/**
 * `start`'s events while the slot is held; the slot goes back however the stream ends. Time to
 * answer runs from the call's start under its slot to its first event that is not an error (a
 * provider's `start` comes with the response headers; a first delta would wait out the reasoning).
 */
async function* holding(
  start: () => AsyncIterable<AssistantMessageEvent>,
  release: (observation?: Observation) => void,
): AsyncGenerator<AssistantMessageEvent> {
  const started = performance.now();
  let answerMs: number | undefined;
  try {
    let terminal = false;
    for await (const event of start()) {
      if (answerMs === undefined && event.type !== "error")
        answerMs = performance.now() - started;
      if (event.type === "done" || event.type === "error") terminal = true;
      yield event;
    }
    if (!terminal)
      throw new Error("the provider's stream ended without a terminal event");
  } finally {
    release({
      durationMs: performance.now() - started,
      throttled: false,
      retryAfter: false,
      ...(answerMs === undefined ? {} : { firstTokenMs: answerMs }),
    });
  }
}

const limited = (
  slots: CallSlots,
  attributes: Record<string, string>,
  model: Model<Api>,
  signal: AbortSignal | undefined,
  start: (signal: AbortSignal) => AssistantMessageEventStream,
  priority?: () => Priority,
): AssistantMessageEventStream =>
  lazyStream(model, async () => {
    const release = await slots.acquire(attributes, signal, priority?.());
    const combined = AbortSignal.any([
      ...(signal ? [signal] : []),
      ...(release.signal ? [release.signal] : []),
    ]);
    return holding(() => start(combined), release);
  });

/** `provider`, with each of its requests streamed under one of the run's slots. */
export const limitProvider = (
  provider: Provider,
  slots: CallSlots,
  route: {
    readonly provider: string;
    readonly model: string;
    readonly stage?: string;
    readonly agent?: string;
    readonly conversationId?: number;
  },
  priority?: (context: ModelContext | undefined) => Priority,
): Provider => {
  let sequence = 0;
  const attributes = () => ({
    ...genAiAttributes(route),
    ...(route.stage === undefined ? {} : { "harness.stage": route.stage }),
    ...(route.agent === undefined ? {} : { "harness.agent": route.agent }),
    ...(route.conversationId === undefined
      ? {}
      : { "harness.conversation_id": String(route.conversationId) }),
    "harness.call_sequence": String(++sequence),
  });
  const { fetchDeferred } = provider;
  return {
    ...provider,
    stream: (model, context, options) =>
      limited(
        slots,
        attributes(),
        model,
        options?.signal,
        (signal) =>
          provider.stream(
            model,
            context,
            Object.assign(Object.assign({ signal }, options), { signal }),
          ),
        priority === undefined ? undefined : () => priority(context),
      ),
    streamSimple: (model, context, options) =>
      limited(
        slots,
        attributes(),
        model,
        options?.signal,
        (signal) =>
          provider.streamSimple(
            model,
            context,
            Object.assign(Object.assign({ signal }, options), { signal }),
          ),
        priority === undefined ? undefined : () => priority(context),
      ),
    ...(fetchDeferred === undefined
      ? {}
      : {
          fetchDeferred: (model, handle, options) =>
            limited(
              slots,
              attributes(),
              model,
              options?.signal,
              (signal) =>
                fetchDeferred.call(
                  provider,
                  model,
                  handle,
                  Object.assign(Object.assign({ signal }, options), { signal }),
                ),
              priority === undefined ? undefined : () => priority(undefined),
            ),
        }),
  };
};
