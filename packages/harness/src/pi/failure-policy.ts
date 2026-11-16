import type { Context } from "@earendil-works/chord";
import {
  defineTask,
  type TaskDefinition,
  type Task,
  type TaskRuntime,
} from "@earendil-works/pi-durable";
import { z } from "zod";
import type { HeldStep } from "./control.ts";
import type { RouteFailure, RouteFailureKind } from "./providers/failure.ts";

/**
 * How a provider failure a step held for ends the job's attempt, by the incumbent policy: each
 * kind keeps the error tag and retryability its failure had on the route before the port (the
 * route's `AiError` reasons, `SignInRequired`), so the queue retries what it retried and stops
 * what it stopped. A credential this worker lacks is decided before this (10.17, `JobHeld`).
 */
const POLICY: Readonly<
  Record<
    RouteFailureKind,
    { readonly tag: string; readonly retryable: boolean }
  >
> = {
  auth: { tag: "AuthenticationError", retryable: false },
  // The plan's usage limit resets after hours: the run stops instead of retrying.
  plan_quota: { tag: "QuotaExhaustedError", retryable: false },
  rate_limit: { tag: "RateLimitError", retryable: true },
  context_overflow: { tag: "InvalidRequestError", retryable: false },
  invalid_request: { tag: "InvalidRequestError", retryable: false },
  server: { tag: "InternalProviderError", retryable: true },
  provider: { tag: "UnknownError", retryable: true },
  stream: { tag: "NetworkError", retryable: true },
  stalled: { tag: "NetworkError", retryable: true },
  sign_in: { tag: "SignInRequired", retryable: false },
  binding: { tag: "AgentRouteMissing", retryable: false },
  capture: { tag: "CaptureFailed", retryable: true },
  aborted: { tag: "Aborted", retryable: true },
};

/**
 * The route failures that are the worker's own access to the account, why each is here:
 * - `auth`: the provider refused the credential or the plan's access;
 * - `sign_in`: the Neuve sign-in could not give a token;
 * - `binding`: the conversation's route binding is missing or names another route;
 * - `plan_quota`: the account's quota is used up, for hours.
 */
const ACCOUNT_KINDS: ReadonlySet<RouteFailureKind> = new Set<RouteFailureKind>([
  "auth",
  "sign_in",
  "binding",
  "plan_quota",
]);

/**
 * Whether a failure is the worker's own access to the account, so no later call of the run can
 * succeed: a step that ends failed on an unanswered call (`AgentSpec.unanswered`) still holds for
 * it. A failed turn that recorded no route failure is not.
 */
export const isAccountFailure = (
  failure: Pick<RouteFailure, "kind"> | undefined,
): boolean => {
  if (failure === undefined) return false;
  return ACCOUNT_KINDS.has(failure.kind);
};

export type HeldFailure = {
  readonly tag: string;
  readonly retryable: boolean;
  /** Said when the failed turn recorded no route failure, so its kind is not known. */
  readonly unclassified?: string | undefined;
};

/** The attempt's failure for the steps held in it: the first that no attempt can recover from wins. */
export const heldFailure = (
  steps: ReadonlyArray<Pick<HeldStep, "failure">>,
): HeldFailure => {
  const failures = steps.map(({ failure }): HeldFailure =>
    failure === null
      ? {
          tag: "ModelError",
          retryable: true,
          unclassified:
            "the failed turn recorded no route failure, so its kind is unknown",
        }
      : POLICY[failure.kind],
  );
  return (
    failures.find((failure) => !failure.retryable) ??
    failures[0] ?? { tag: "ModelError", retryable: true }
  );
};

const ExpectedFailure = z.object({
  _tag: z.string(),
  message: z.string(),
  retryable: z.boolean().optional(),
  status: z.number().optional(),
});

/** Preserve expected domain failures before pi reduces an uncaught exception to a fault message. */
export const definePolicyTask = <
  I,
  S extends { phase: string },
  R,
  H extends object = object,
>(
  definition: TaskDefinition<I, S, R, H>,
): Task<I, S, R, H> => {
  const phases: {
    -readonly [P in keyof TaskDefinition<I, S, R, H>["phases"]]: TaskDefinition<
      I,
      S,
      R,
      H
    >["phases"][P];
  } = { ...definition.phases };
  const preserve = async (
    runtime: TaskRuntime<I, S, R, H>,
    context: Context,
    invoke: () => Promise<void>,
  ) => {
    try {
      await invoke();
    } catch (cause) {
      if (runtime.signal.aborted) throw cause;
      const parsed = ExpectedFailure.safeParse(cause);
      if (!parsed.success) throw cause;
      const error = parsed.data;
      await runtime.commit(
        () => ({
          status: "terminal",
          outcome: {
            status: "failed",
            error: {
              message: error.message,
              detail: {
                tag: error._tag,
                retryable: error.retryable ?? true,
                ...(error.status === undefined ? {} : { status: error.status }),
              },
            },
          },
        }),
        context,
      );
    }
  };
  const wrap = <P extends S["phase"]>(phase: P) => {
    const invoke = definition.phases[phase];
    phases[phase] = (task, runtime, context) =>
      preserve(runtime, context, () => invoke(task, runtime, context));
  };
  for (const phase in phases) wrap(phase);
  return defineTask({
    ...definition,
    phases,
    abort: (task, runtime, context) =>
      preserve(runtime, context, () =>
        definition.abort(task, runtime, context),
      ),
  });
};
