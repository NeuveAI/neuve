import type { RuntimeEvent, RuntimeSession } from "@neuve/runtime";
import { Stream } from "effect";

export const collect = (session: RuntimeSession) =>
  Stream.runCollect(
    session.events.pipe(
      Stream.takeUntil((event) => event.type === "turn.finished"),
    ),
  );
export const point = (events: readonly RuntimeEvent[]) =>
  events.findLast((event) => event.type === "turn.finished")?.resumePoint ??
  events.findLast((event) => event.type === "message.finished")?.resumePoint;
export const completed = (events: readonly RuntimeEvent[]) =>
  events.findLast((event) => event.type === "turn.finished")?.outcome.status ===
  "completed";
export const requests = (events: readonly RuntimeEvent[]) =>
  events.filter((event) => event.type === "message.finished").length;
export const protocolError = (events: readonly RuntimeEvent[]) =>
  events.some(
    (event) =>
      event.type === "turn.finished" &&
      event.outcome.status === "failed" &&
      event.outcome.failure._tag === "TurnFailed" &&
      event.outcome.failure.reason === "protocol-error",
  );
