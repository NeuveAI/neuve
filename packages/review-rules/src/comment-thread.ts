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
