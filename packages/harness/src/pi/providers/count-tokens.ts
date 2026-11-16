import { randomUUID } from "node:crypto";
import { AnthropicClient } from "@effect/ai-anthropic";
import { Data, Effect, Layer, Redacted } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import type { AnyRouteConfig } from "../../route.ts";
import {
  CREDENTIAL_INSPECTION_POLICY,
  type Capture,
} from "../capture/types.ts";
import { rememberEphemeralCredentials } from "../capture/safety.ts";
import {
  refusalEvidence,
  historicalEvidence,
  type CredentialCapture,
} from "./credential-evidence.ts";
import { readRefusal } from "./response-observer.ts";

/**
 * The route's free token count (§2.1, 10.35) for the review stages' `CountTokens`: Anthropic's
 * `/v1/messages/count_tokens` through the official generated client, with the payload the incumbent
 * preflight sends. The OpenAI route counts nothing (10.85) and resolves null without a request.
 *
 * A count is not a model generation, so it records no `model.*` event: each call keeps its route
 * and label, the exact request body and the provider's answer as JSON artifacts under its own call
 * ID. A request that cannot be recorded is never sent.
 */

/** The free count was refused or could not run; a credential the provider refuses is not retryable. */
export class PreflightFailed extends Data.TaggedError("PreflightFailed")<{
  readonly message: string;
  /** False for 401 and 403, a missing credential and a capture failure. */
  readonly retryable: boolean;
  /** The provider's HTTP status, when it answered. */
  readonly status?: number;
}> {}

export interface CountTokensRequest {
  readonly label: string;
  readonly system: string;
  readonly user: string;
  readonly tools: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly input_schema: Record<string, unknown>;
  }>;
}

export interface CountTokensOptions {
  readonly route: AnyRouteConfig;
  readonly capture: Capture;
  readonly credentialInspection: CredentialCapture;
  /** The run every artifact is scoped to. */
  readonly runId: string;
  readonly fetch?: typeof globalThis.fetch | undefined;
  /** The Anthropic API's base URL; tests point it at a local endpoint. */
  readonly baseUrl?: string | undefined;
}

type Answer =
  | { readonly status: number; readonly body: unknown }
  | { readonly error: string };

const encoder = new TextEncoder();
const messageOf = (cause: unknown) =>
  cause instanceof Error && cause.message !== ""
    ? cause.message
    : String(cause);

/** The body as the client sent it, or undefined when it is not bytes this process can read. */
const bodyBytes = (body: unknown) =>
  typeof body === "string"
    ? encoder.encode(body)
    : body instanceof Uint8Array
      ? body
      : body instanceof ArrayBuffer
        ? new Uint8Array(body)
        : undefined;

/** The provider's own words for a refusal: its status, and its error body's type and message. */
const refusalText = (status: number, body: unknown) => {
  const error =
    typeof body === "object" && body !== null
      ? (body as { error?: { type?: unknown; message?: unknown } }).error
      : undefined;
  return `HTTP ${status}${typeof error?.type === "string" ? ` ${error.type}` : ""}${typeof error?.message === "string" ? `: ${error.message.slice(0, 300)}` : ""}`;
};

export const createCountTokens =
  (options: CountTokensOptions) =>
  async (
    request: CountTokensRequest,
    signal?: AbortSignal,
  ): Promise<number | null> => {
    const { route } = options;
    if (route.provider !== "anthropic") return null;
    const key = process.env[route.credentialVariable];
    let credentials = new Headers({ "x-api-key": key ?? "" });
    const failed = (reason: string, retryable: boolean, status?: number) =>
      new PreflightFailed({
        message: refusalEvidence(
          `token counting (${request.label}) failed: ${reason}`,
          credentials,
        ).body,
        retryable,
        ...(status === undefined ? {} : { status }),
      });
    signal?.throwIfAborted();
    if (key === undefined || key.trim() === "")
      throw failed(
        `${route.credentialVariable} is not set in this process's environment`,
        false,
      );

    const callId = randomUUID();
    let exposed = false;
    const guard = (status: "pending" | "observed" | "exposed") =>
      options.capture({
        type: "credential.guard",
        scope: { runId: options.runId },
        callId,
        status,
      });
    const inspect = async (text: string) => {
      const evidence = refusalEvidence(text, credentials);
      if (evidence.bodyRedactions.length > 0 && !exposed) {
        exposed = true;
        guard("exposed");
      }
      if (options.credentialInspection !== "ephemeral") {
        const historical = await historicalEvidence(
          evidence.body,
          options.credentialInspection,
          (epochs) => {
            for (const epoch of epochs)
              options.capture({
                type: "credential.guard",
                scope: { runId: options.runId },
                callId: epoch,
                status: "exposed",
              });
          },
          signal,
        );
        if (historical.exposedEpochs.length > 0) {
          exposed = true;
          guard("exposed");
        }
        if (typeof historical.data !== "string")
          throw new Error("Historical count observation is invalid");
        return { ...evidence, body: historical.data };
      }
      return evidence;
    };
    const keep = async (name: string, bytes: Uint8Array) => {
      const evidence = await inspect(new TextDecoder().decode(bytes));
      options.capture({
        type: "artifact",
        scope: { runId: options.runId },
        name: `count-tokens/${callId}/${name}`,
        mediaType: "application/json",
        bytes: encoder.encode(evidence.body),
      });
      if (evidence.bodyRedactions.length > 0)
        options.capture({
          type: "artifact",
          scope: { runId: options.runId },
          name: `count-tokens/${callId}/${name}.redactions.json`,
          mediaType: "application/json",
          bytes: encoder.encode(
            JSON.stringify({ bodyRedactions: evidence.bodyRedactions }),
          ),
        });
    };
    const keepJson = async (name: string, value: unknown) =>
      await keep(name, encoder.encode(JSON.stringify(value)));
    let captureFailure: unknown;
    let answer: Answer | undefined;
    const base = options.fetch ?? globalThis.fetch;
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const headers = new Headers(init?.headers);
      credentials = headers;
      try {
        if (options.credentialInspection !== "ephemeral") {
          const { CredentialEpochId, InspectionBudget } =
            await import("../capture/credential-detectors.ts");
          const registration = await options.credentialInspection.register({
            epoch: CredentialEpochId.parse(callId),
            headers,
            budget: new InspectionBudget(),
            deduplicate: true,
            ...(signal === undefined ? {} : { signal }),
          });
          if (registration.status !== "registered")
            throw new Error("Durable count registration is unavailable");
          options.capture({
            type: "credential.registration",
            scope: { runId: options.runId },
            callId,
            epochId: registration.epoch,
            policy: CREDENTIAL_INSPECTION_POLICY,
          });
        }
        if (options.credentialInspection === "ephemeral")
          await rememberEphemeralCredentials(
            options.capture,
            options.runId,
            callId,
            headers,
          );
        guard("pending");
        const body = bodyBytes(init?.body);
        if (body === undefined)
          throw new Error("the request body is not bytes it can record");
        await keepJson("call.json", {
          label: request.label,
          route: route.provider,
          provider: route.provider,
          model: route.model,
          path: url.pathname,
          headerNames: [...new Headers(init?.headers).keys()].sort(),
        });
        await keep("request.json", body);
      } catch (cause) {
        captureFailure = cause;
        throw cause;
      }
      let response: Response;
      try {
        response = await base(input, { ...init, redirect: "error" });
      } catch (cause) {
        try {
          answer = { error: (await inspect(messageOf(cause))).body };
          await keepJson("outcome.json", answer);
          if (!exposed) guard("observed");
        } catch (failure) {
          captureFailure = failure;
        }
        throw cause;
      }
      try {
        const observed = await readRefusal(response, (cause) => {
          captureFailure = cause;
          return cause instanceof Error ? cause : new Error(messageOf(cause));
        });
        response = observed.response;
        const evidence = await inspect(observed.text);
        let body: unknown;
        try {
          body = JSON.parse(evidence.body) as unknown;
        } catch {
          body = { unparsed: evidence.body };
        }
        answer = { status: response.status, body };
        await keepJson("outcome.json", {
          status: response.status,
          requestId: response.headers.get("request-id"),
          body,
          ...(!response.ok || evidence.bodyRedactions.length > 0
            ? { text: evidence.body, bodyRedactions: evidence.bodyRedactions }
            : {}),
        });
        if (!exposed) guard("observed");
      } catch (cause) {
        captureFailure = cause;
        await response.body?.cancel().catch(() => undefined);
        throw cause;
      }
      return response;
    }) as typeof globalThis.fetch;

    const count = Effect.gen(function* () {
      const client = yield* AnthropicClient.AnthropicClient;
      return yield* client.client.messagesCountTokensPost({
        payload: {
          model: route.model,
          system: request.system,
          messages: [{ role: "user", content: request.user }],
          ...(request.tools.length === 0
            ? {}
            : { tools: request.tools as never }),
        },
      });
    }).pipe(
      Effect.provide(
        AnthropicClient.layer({
          apiKey: Redacted.make(key),
          ...(options.baseUrl === undefined ? {} : { apiUrl: options.baseUrl }),
        }).pipe(
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
        ),
      ),
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
    );
    try {
      const counted = await Effect.runPromise(
        count,
        signal === undefined ? undefined : { signal },
      );
      return counted.input_tokens;
    } catch (cause) {
      signal?.throwIfAborted();
      if (captureFailure !== undefined)
        throw failed(`capture failed: ${messageOf(captureFailure)}`, false);
      if (answer !== undefined && "status" in answer)
        throw failed(
          refusalText(answer.status, answer.body),
          answer.status !== 401 && answer.status !== 403,
          answer.status,
        );
      throw failed(
        answer !== undefined ? answer.error : "the request failed",
        true,
      );
    }
  };
