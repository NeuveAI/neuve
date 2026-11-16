import type { RuntimeShape } from "@neuve/runtime";
import type {
  Options,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Effect, Stream } from "effect";
import { executableLayer, processLayer, sdkLayer } from "./production.ts";
import { makeRuntime, type ClaudeRuntimeConfig } from "./runtime.ts";
import type { SmokeOpenObservation } from "./smoke-open.ts";
import { ClaudeSdk, ClaudeSdkError } from "./services.ts";

/** The adapter suppresses further output after endTurn; observe it before mapping. */
export const toolOutputObservation = () => {
  let active = false;
  let ending = false;
  let lastMessage: string | undefined;
  let extraRequest = false;
  let discardedToken: string | undefined;
  let discardedSteerAbsent = true;
  let discardedSteerNotOffered = true;
  return {
    begin: () => {
      active = true;
      ending = false;
      lastMessage = undefined;
      extraRequest = false;
      discardedToken = undefined;
      discardedSteerAbsent = true;
      discardedSteerNotOffered = true;
    },
    discardSteer: (token: string) => {
      discardedToken = token;
    },
    offered: (message: unknown) => {
      if (
        active &&
        discardedToken !== undefined &&
        JSON.stringify(message).includes(discardedToken)
      )
        discardedSteerNotOffered = false;
    },
    get discardedSteerAbsent() {
      return discardedSteerAbsent;
    },
    get discardedSteerNotOffered() {
      return discardedSteerNotOffered;
    },
    finish: () => {
      ending = true;
    },
    get extraRequest() {
      return extraRequest;
    },
    receive: (frame: SDKMessage) => {
      if (!active) return;
      if (
        discardedToken !== undefined &&
        JSON.stringify(frame).includes(discardedToken)
      )
        discardedSteerAbsent = false;
      const id =
        frame.type === "assistant" && frame.parent_tool_use_id === null
          ? frame.message.id
          : frame.type === "stream_event" &&
              frame.parent_tool_use_id === null &&
              frame.event.type === "message_start"
            ? frame.event.message.id
            : undefined;
      if (id !== undefined) {
        if (ending && id !== lastMessage) extraRequest = true;
        lastMessage = id;
      }
      if (ending && frame.type === "system" && frame.subtype === "api_retry")
        extraRequest = true;
    },
  };
};
export type ToolOutputObservation = ReturnType<typeof toolOutputObservation>;

export type SmokeObservation = {
  prepareOpen?: (options: Options) => Options;
  shouldWithholdSend?: () => boolean;
  open?: (options: Options) => SmokeOpenObservation | undefined;
  observe?: (action: () => void) => void;
  permission?: (name: string, behavior: "allow" | "deny") => void;
  afterReceive?: () => Effect.Effect<void>;
  offered: (message: SDKUserMessage) => void;
  receive: (frame: SDKMessage) => void;
};

export const observeSmokeSdk = (
  sdk: ClaudeSdk["Service"],
  observation: SmokeObservation,
): ClaudeSdk["Service"] => ({
  ...sdk,
  open: (options) =>
    Effect.suspend(() => {
      const contain = observation.observe ?? ((action: () => void) => action());
      const prepared = observation.prepareOpen?.(options) ?? options;
      const opening = observation.open?.(prepared);
      const canUseTool = prepared.canUseTool;
      const observed =
        observation.permission === undefined || canUseTool === undefined
          ? prepared
          : {
              ...prepared,
              canUseTool: (...args: Parameters<typeof canUseTool>) =>
                canUseTool(...args).then((decision) => {
                  if (decision !== null)
                    contain(() =>
                      observation.permission?.(args[0], decision.behavior),
                    );
                  return decision;
                }),
            };
      const track = <A, E, R>(
        name: "sdkOpen" | "initialization" | "effortUpdate",
        effect: Effect.Effect<A, E, R>,
      ) =>
        opening === undefined ? effect : opening.track(name, effect, contain);
      return track(
        "sdkOpen",
        sdk.open(
          opening === undefined
            ? observed
            : {
                ...observed,
                stderr: (chunk) => contain(() => opening.stderr(chunk)),
              },
        ),
      ).pipe(
        Effect.map((query) => ({
          ...query,
          initializationResult: track(
            "initialization",
            query.initializationResult,
          ),
          applyFlagSettings: (settings) =>
            track("effortUpdate", query.applyFlagSettings(settings)),
          offer: (message) =>
            observation.shouldWithholdSend?.() === true
              ? Effect.sync(() => contain(() => opening?.withhold())).pipe(
                  Effect.andThen(
                    Effect.fail(new ClaudeSdkError({ method: "offer" })),
                  ),
                )
              : Effect.sync(() => observation.offered(message)).pipe(
                  Effect.andThen(query.offer(message)),
                ),
          messages: query.messages.pipe(
            Stream.tap((frame) =>
              Effect.sync(() => contain(() => observation.receive(frame))).pipe(
                Effect.andThen(
                  Effect.suspend(() => {
                    let after: Effect.Effect<void> | undefined;
                    contain(() => {
                      after = observation.afterReceive?.();
                    });
                    return after ?? Effect.void;
                  }),
                ),
              ),
            ),
          ),
        })),
      );
    }),
});

export const smokeRuntime = (
  config: ClaudeRuntimeConfig,
  observation: SmokeObservation,
) =>
  Effect.gen(function* () {
    const sdk = yield* ClaudeSdk;
    return yield* makeRuntime(config).pipe(
      Effect.provideService(ClaudeSdk, observeSmokeSdk(sdk, observation)),
    );
  }).pipe(
    Effect.provide(sdkLayer),
    Effect.provide(executableLayer),
    Effect.provide(processLayer),
  );

export type SmokeRuntime = Omit<RuntimeShape, "openSession"> &
  Pick<Effect.Success<ReturnType<typeof makeRuntime>>, "openSession">;
