/**
 * The comment thread both apps share: a comment, the replies under it, and where the latest
 * message is on its way to the agent. The review desk adds its own states and steps on top.
 *
 *   queued ─▶ sent ─▶ picked up ─▶ working ─▶ replied
 *   any state before replied ─▶ failed
 *
 * There is no read receipt: "picked up" (the agent's turn started) is the closest signal to read.
 */
export type CommentThreadState =
  "queued" | "sent" | "picked-up" | "working" | "replied" | "failed";

/** The line under a thread's latest message while it is on its way; none once it arrived. */
export function deliveryLine(
  state: CommentThreadState,
  agent: string,
): string | undefined {
  switch (state) {
    case "queued":
      return `Queued · reaches ${agent} when it’s free`;
    case "sent":
      return `Sent to ${agent}`;
    case "picked-up":
      return `Picked up by ${agent}`;
    default:
      return undefined;
  }
}

/** Each state in a word or two, as a thread's preview names it. */
export const THREAD_STATUS: Record<CommentThreadState, string> = {
  queued: "queued",
  sent: "sent",
  "picked-up": "picked up",
  working: "working",
  replied: "replied",
  failed: "failed",
};

/** "now", "4 min", "2 h", "Oct 2", from an ISO-8601 string or ms. */
export function relativeTime(
  at: string | number,
  now: Date = new Date(),
): string {
  const date = new Date(at);
  const minutes = Math.round((now.getTime() - date.getTime()) / 60000);
  if (Number.isNaN(minutes)) return String(at);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
