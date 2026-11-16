import { Context, Effect } from "effect";
import {
  KeyHeld,
  SharedWork,
  type SharedWorkOptions,
  type SharedFloor,
  type SharedWorkEvent,
} from "./shared-work.ts";

export const InsideSharedWorkGrant = Context.Reference<boolean>(
  "@neuve/records-core/InsideSharedWorkGrant",
  { defaultValue: () => false },
);
export class SharedWorkError extends Error {
  readonly _tag = "SharedWorkError";
  constructor(override readonly cause: unknown) {
    super("Shared work could not complete");
  }
}
type EffectOptions<Options, R> = Options extends {
  readonly run: (signal: AbortSignal) => Promise<infer Outcome>;
}
  ? Omit<Options, "run" | "signal" | "insideGrant"> & {
      readonly run: (signal: AbortSignal) => Effect.Effect<Outcome, never, R>;
    }
  : never;
export type EffectSharedWorkOptions<A, E, R> = EffectOptions<
  SharedWorkOptions<A, E>,
  R
>;
/** Typed recorded failures enter the Effect error channel; publication defects remain distinct. */
export const sharedWorkEffect = <A, E, R>(
  work: SharedWork<A, E>,
  options: EffectSharedWorkOptions<A, E, R>,
): Effect.Effect<
  { readonly value: A; readonly floor?: SharedFloor },
  E | KeyHeld | SharedWorkError,
  R
> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<R>();
    return yield* Effect.gen(function* () {
      const eventContext = yield* Effect.context<never>();
      const insideGrant = yield* InsideSharedWorkGrant;
      const onEvent = (event: SharedWorkEvent) => {
        options.onEvent?.(event);
        Effect.runSyncWith(eventContext)(
          Effect.andThen(
            Effect.annotateCurrentSpan({
              "shared_work.role": event.role,
              ...(event.floor ? { "shared_work.floor": event.floor } : {}),
            }),
            Effect.logDebug("shared-work", {
              type: "shared-work.role",
              ...event,
            }),
          ),
        );
      };
      const result = yield* Effect.tryPromise({
        try: (signal) => {
          if (options.crossProcess)
            return work.run({
              ...options,
              signal,
              insideGrant,
              onEvent,
              run: (runSignal) =>
                Effect.runPromiseWith(context)(options.run(runSignal), {
                  signal: runSignal,
                }),
            });
          return work.run({
            ...options,
            signal,
            insideGrant,
            onEvent,
            run: (runSignal) =>
              Effect.runPromiseWith(context)(options.run(runSignal), {
                signal: runSignal,
              }),
          });
        },
        catch: (cause) =>
          cause instanceof KeyHeld ? cause : new SharedWorkError(cause),
      });
      if (result.outcome.kind === "failed")
        return yield* Effect.fail(result.outcome.error);
      return {
        value: result.outcome.value,
        ...(result.floor ? { floor: result.floor } : {}),
      };
    }).pipe(Effect.withSpan("records.shared-work"));
  });
