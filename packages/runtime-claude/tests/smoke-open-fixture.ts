import type {
  Options,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { Effect, Layer, Queue, Stream } from "effect";
import {
  ClaudeExecutable,
  ClaudeProcess,
  ClaudeSdk,
  ClaudeSdkError,
} from "../src/services.ts";
import { assistant, result } from "./frames.ts";

export const privateValues = [
  "00000000-0000-4000-8000-000000000099",
  "fixture-secret",
  "/private/fixture/path",
  "private multiline message",
];
export const stderrCases = [
  ["jsonSchemaNotJson", "--json-schema is not valid JSON"],
  ["jsonSchemaNotObject", "--json-schema must be a JSON object"],
  ["invalidSessionId", "Invalid session ID"],
  ["resumeNeedsValidId", "requires a valid session ID"],
  ["sessionIdInUse", "already in use"],
  ["cannotBeCombined", "cannot be combined with"],
  ["requiresResume", "requires --resume"],
  ["noMessagesReturned", "No messages returned from query"],
  ["notValidJson", "is not valid JSON"],
  ["invalidSchema", "Invalid schema"],
  ["schemaConversion", "JSON Schema"],
] as const;
export function openFixture(mode: string) {
  const optionsReceived: Options[] = [];
  const offersByOpen: number[] = [];
  const received: SDKUserMessage[] = [];
  let failedSdkOpens = 0;
  const entered = Promise.withResolvers<void>();
  let opens = 0;
  let closed = 0;
  const sdk = ClaudeSdk.of({
    prefixes: { usage: [], organization: [] },
    open: (options) =>
      Effect.gen(function* () {
        opens++;
        const index = opens - 1;
        optionsReceived.push(options);
        offersByOpen.push(0);
        const final = options.outputFormat !== undefined;
        const fails =
          final &&
          (mode !== "resumed" || opens > 3) &&
          (mode !== "timeout" || opens === 3);
        const error = new ClaudeSdkError({
          method: "fixture",
          ...{ errorClass: "process_exited_nonzero", exitCode: 1 },
        });
        if (fails && mode === "sdkOpen") {
          failedSdkOpens++;
          return yield* error;
        }
        const frames = yield* Queue.unbounded<SDKMessage>();
        let done = false;
        const close = Effect.sync(() => {
          if (!done) {
            done = true;
            closed++;
          }
        }).pipe(Effect.andThen(Queue.shutdown(frames)));
        yield* Effect.addFinalizer(() => close);
        const init = Effect.gen(function* () {
          if (
            (mode === "normalUnavailable" && index === 4) ||
            (mode === "resumeFailure" && index === 5) ||
            (mode === "resumeAtFailure" && index === 6)
          )
            return yield* error;
          const phrase = stderrCases.find(([name]) => mode === name)?.[1];
          if (final && (phrase !== undefined || mode === "unknownFlag")) {
            const line =
              mode === "jsonSchemaNotJson"
                ? `Error: --json-schema is not valid JSON: ${privateValues.join(" ")}\n`
                : `Error: ${privateValues.join(" ")} ${phrase ?? "--not-a-real-flag-zz"} ${privateValues.join(" ")}\n`;
            for (const char of line) options.stderr?.(char);
            return yield* error;
          }
          if (mode === "schemaFailure" && options.sessionId && final)
            return yield* error;
          if (
            fails &&
            [
              "initialization",
              "observerSdk",
              "resumed",
              "privacy",
              "unsafeToken",
              "fullFailure",
            ].includes(mode)
          ) {
            const marker = `${mode === "resumed" ? "No message found with message.uuid of" : "No conversation found with session ID:"} ${privateValues[0]}\n`;
            const text =
              mode === "privacy" || mode === "unsafeToken"
                ? `${marker}${privateValues.slice(1).join("\n")}\n${mode === "unsafeToken" ? "A".repeat(38) + "Exception" : "FixtureError"}\n`
                : marker;
            for (const char of text) options.stderr?.(char);
            return yield* error;
          }
          if (fails && mode === "timeout") {
            entered.resolve();
            return yield* Effect.never;
          }
          return {
            account: {},
            models: [
              {
                value: "default",
                displayName: "fixture",
                description: "fixture",
                supportsEffort: !(fails && mode === "effortUpdate"),
                supportedEffortLevels: ["low", "medium", "high"],
              },
            ],
          };
        });
        return {
          messages: Stream.fromQueue(frames),
          close,
          initializationResult: init,
          applyFlagSettings: () =>
            fails && mode === "effortUpdate" ? Effect.fail(error) : Effect.void,
          setModel: () => Effect.void,
          interrupt: Effect.void,
          offer: (message: SDKUserMessage) =>
            Effect.gen(function* () {
              received.push(message);
              offersByOpen[index] = (offersByOpen[index] ?? 0) + 1;
              if (mode === "twoRequests") {
                yield* Queue.offer(frames, assistant(undefined));
                const next = assistant(undefined);
                next.message.id = "second-request";
                yield* Queue.offer(frames, next);
              }
              if (mode === "fullFailure" && final) return yield* error;
              if (mode === "logging")
                yield* Queue.offer(
                  frames,
                  Object.assign(result(), {
                    type: "command_lifecycle",
                    content: privateValues.join(" "),
                  }),
                );
              yield* Queue.offer(frames, assistant(undefined));
              yield* Queue.offer(
                frames,
                result({ structured_output: { ok: true } }),
              );
            }),
        };
      }),
  });
  return {
    sdk,
    optionsReceived,
    offersByOpen,
    received,
    entered: entered.promise,
    get opens() {
      return opens;
    },
    get failedSdkOpens() {
      return failedSdkOpens;
    },
    get closed() {
      return closed;
    },
    layers: Layer.mergeAll(
      Layer.succeed(ClaudeExecutable, {
        resolve: () => Effect.succeed("/test/claude"),
      }),
      Layer.succeed(ClaudeProcess, {
        run: () => Effect.die("No process allowed"),
      }),
    ),
  };
}
