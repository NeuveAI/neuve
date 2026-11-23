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

export function relativeTime(at: string, now: Date = new Date()): string {
  const date = new Date(at);
  const minutes = Math.round((now.getTime() - date.getTime()) / 60000);
  if (Number.isNaN(minutes)) return at;
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
