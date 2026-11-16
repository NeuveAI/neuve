import { Data, Effect } from "effect";
import {
  BackgroundYield,
  type Budget,
  type Grant,
  type Request,
} from "./scheduler.ts";

export class BudgetAdmissionFailed extends Data.TaggedError(
  "BudgetAdmissionFailed",
)<{ readonly cause: unknown }> {}

/** On interruption, join admission and release even when its grant arrives after cancellation. */
export type OnBudgetYield = (signal: AbortSignal) => Promise<void>;
export async function backgroundAdmission(
  budget: Budget,
  request: Request,
  signal?: AbortSignal,
): Promise<{ kind: "granted"; grant: Grant } | { kind: "yielded" }> {
  try {
    return { kind: "granted", grant: await budget.admit(request, signal) };
  } catch (cause) {
    if (cause instanceof BackgroundYield) return { kind: "yielded" };
    throw cause;
  }
}
export async function admitForJob(
  budget: Budget,
  request: Request,
  signal: AbortSignal,
  onYield?: OnBudgetYield,
): Promise<Grant> {
  const aged = onYield
    ? request
    : { ...request, queuedAt: request.queuedAt ?? Date.now() };
  for (;;) {
    signal.throwIfAborted();
    const result = await backgroundAdmission(budget, aged, signal);
    if (result.kind === "granted") return result.grant;
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener("abort", abort);
        reject(new Error("Budget wait aborted"));
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      const deferred = onYield
        ? onYield(signal)
        : new Promise<void>((r) => setTimeout(r, 0));
      deferred.then(
        () => {
          signal.removeEventListener("abort", abort);
          resolve();
        },
        (cause) => {
          signal.removeEventListener("abort", abort);
          reject(cause);
        },
      );
    });
  }
}
export const acquireGrant = (
  budget: Budget,
  request: Request,
  onYield?: OnBudgetYield,
) =>
  Effect.callback<Grant, BudgetAdmissionFailed>((resume, signal) => {
    const pending = admitForJob(budget, request, signal, onYield);
    pending.then(
      (grant) => resume(Effect.succeed(grant)),
      (cause) => resume(Effect.fail(new BudgetAdmissionFailed({ cause }))),
    );
    return Effect.promise(() =>
      pending.then(
        async (grant) => {
          await grant.release();
        },
        () => {},
      ),
    );
  });
