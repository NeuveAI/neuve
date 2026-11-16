import { Data, Effect } from "effect";
import {
  OpenAiAuthError,
  accessToken,
  rejectedToken,
  signInProblem,
} from "./openai-auth.ts";
import { errorOf, isObject } from "./pi/providers/wire.ts";
import type { OpenAiRouteConfig } from "./route.ts";

/** The route cannot be used from this process: not signed in, or the plan does not allow it. */
export class SignInRequired extends Data.TaggedError("SignInRequired")<{
  readonly message: string;
  readonly retryable: false;
}> {}

/** The cheap route check before a run failed: the account, the model or the service. */
export class RouteUnavailable extends Data.TaggedError("RouteUnavailable")<{
  readonly message: string;
  readonly retryable: boolean;
}> {}

export interface SessionOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  /** The sign-in's folder and issuer; tests point them at a scratch folder and a fake server. */
  readonly auth?: import("./openai-auth.ts").AuthOptions | undefined;
}

/**
 * The route check before a run (preflight): a usable token and the model in the account's catalogue
 * (`GET /v1/models`). It spends no plan usage; there is no free token count on this route, so UN9's
 * estimates stand.
 */
export const checkRoute = (route: OpenAiRouteConfig, options: SessionOptions) =>
  Effect.gen(function* () {
    const problem = signInProblem(options.auth ?? {});
    if (problem !== undefined)
      return yield* new SignInRequired({ message: problem, retryable: false });
    const token = yield* Effect.tryPromise({
      try: () => accessToken(options.auth ?? {}),
      catch: (error) =>
        error instanceof OpenAiAuthError && error.transient
          ? new RouteUnavailable({ message: error.message, retryable: true })
          : new SignInRequired({
              message:
                error instanceof OpenAiAuthError
                  ? error.message
                  : "the OpenAI sign-in could not be read",
              retryable: false,
            }),
    });
    const listed = yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await options.fetch(`${options.baseUrl}/models`, {
          redirect: "error",
          signal,
          headers: {
            authorization: `Bearer ${token.token}`,
            accept: "application/json",
          },
        });
        const body = (await response.json().catch(() => undefined)) as unknown;
        return { status: response.status, body };
      },
      catch: () =>
        new RouteUnavailable({
          message: `could not reach ${options.baseUrl}`,
          retryable: true,
        }),
    });
    if (listed.status !== 200) {
      if (listed.status === 401) rejectedToken(token.token);
      const error = errorOf(listed.body);
      return yield* new RouteUnavailable({
        message: `the model catalogue answered HTTP ${listed.status}${error.code === undefined ? "" : ` (${error.code})`}`,
        retryable: listed.status >= 500,
      });
    }
    const models =
      isObject(listed.body) && Array.isArray(listed.body["models"])
        ? listed.body["models"]
        : [];
    const offered = models.some(
      (model) => isObject(model) && model["slug"] === route.model,
    );
    if (!offered)
      return yield* new RouteUnavailable({
        message: `${route.model} is not in this ChatGPT account's model catalogue`,
        retryable: false,
      });
    return { expiresAt: new Date(token.expiresAt).toISOString() };
  });
