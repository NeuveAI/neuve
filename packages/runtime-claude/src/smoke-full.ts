import type { Cause } from "effect";
import { Effect, Stream } from "effect";
import { failureShape } from "./smoke-diagnose.ts";
import { toolOutputObservation, type SmokeRuntime } from "./smoke-runtime.ts";
import { EXPECTED_REQUESTS } from "./smoke-checks.ts";

type FullStep =
  | "probe"
  | "normalTurn"
  | "finalTurn"
  | "persistence"
  | "fork"
  | "tools"
  | "refused";
export const fullSmokeState = () => {
  let step: FullStep = "probe";
  let requestsStarted = 0;
  let requestsCompleted = 0;
  const roots = new Set<string>();
  const tools = toolOutputObservation();
  const receive = tools.receive;
  const counts = () => ({ requestsStarted, requestsCompleted });
  return {
    counts,
    observation: Object.assign(tools, {
      open: () => {
        roots.clear();
        return undefined;
      },
      receive: (frame: Parameters<typeof tools.receive>[0]) => {
        const id =
          frame?.type === "assistant" && frame.parent_tool_use_id === null
            ? frame.message?.id
            : frame?.type === "stream_event" &&
                frame.parent_tool_use_id === null &&
                frame.event?.type === "message_start"
              ? frame.event.message?.id
              : undefined;
        if (typeof id === "string" && !roots.has(id)) {
          roots.add(id);
          requestsStarted++;
        }
        if (frame?.type === "system" && frame.subtype === "api_retry")
          requestsStarted++;
        receive(frame);
      },
    }),
    step: (next: FullStep) => {
      step = next;
    },
    failure: (cause: Cause.Cause<unknown>) => ({
      outcome: "failed" as const,
      step,
      ...failureShape(cause),
      expectedRequests: EXPECTED_REQUESTS,
      ...counts(),
    }),
    observe: (runtime: SmokeRuntime): SmokeRuntime => ({
      ...runtime,
      openSession: (...args) => {
        if (args[2]?.kind === "resume" && args[2].fork) step = "fork";
        return runtime.openSession(...args).pipe(
          Effect.map((session) => ({
            ...session,
            get nativeSessionId() {
              return session.nativeSessionId;
            },
            events: session.events.pipe(
              Stream.tap((event) =>
                Effect.sync(() => {
                  if (event.type === "message.finished") requestsCompleted++;
                }),
              ),
            ),
            startTurn: (input) => {
              if (input.turnId === "smoke-normal") step = "normalTurn";
              else if (input.turnId === "smoke") step = "finalTurn";
              else if (input.turnId === "smoke-fork") step = "fork";
              return session.startTurn(input);
            },
          })),
        );
      },
    }),
  };
};
