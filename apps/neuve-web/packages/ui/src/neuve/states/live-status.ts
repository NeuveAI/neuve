import { atom } from "jotai"

import type { LiveStatus } from "@workspace/ui/neuve/shared/app-header"

/*
 * Web events (M5 LV1). The BFF sends one mark per change over a server-sent
 * event stream; the app compares it with the mark its pages were loaded at
 * and reloads them when the two differ. The header's live indicator reads
 * the stream's status.
 */

/** Where Records stands: the log's review position and a stamp of the review jobs. */
export interface LiveMark {
  /**
   * The log's position counting only what a person's screens show: review
   * requests, stage completions, packets, dispositions, comments, feedback.
   */
  sequence: number
  /**
   * The queue's unfinished review jobs, the worker holding the socket and
   * the jobs it holds for a missing sign-in: none of these append an event,
   * and the running state of "Start a review" shows each.
   */
  jobs: string
}

/**
 * What moved between the stream's last mark and this one: `"all"` when the
 * stream cannot name it (the first mark of a connection, a store replaced,
 * a whole review landing at once), else the reviews (cycle IDs) whose events
 * moved and whether the jobs stamp did. A change of the jobs alone names no
 * review.
 */
export type LiveChange =
  "all" | { readonly cycles: ReadonlyArray<string>; readonly jobs: boolean }

/** One mark of the stream, with what moved since the one before it. */
export interface LiveEvent extends LiveMark {
  changed: LiveChange
}

export const sameMark = (left: LiveMark | null, right: LiveMark | null) =>
  left !== null &&
  right !== null &&
  left.sequence === right.sequence &&
  left.jobs === right.jobs

/** The stream's status; null where nothing listens (mock pages, stories). */
export const liveStatusAtom = atom<LiveStatus | null>(null)

/** The newest mark the stream sent. */
export const liveMarkAtom = atom<LiveEvent | null>(null)

/** What the indicator says while the stream is down, in its tooltip and to screen readers. */
export const RECONNECTING_DETAIL =
  "Updates disconnected. Showing the last loaded review while reconnecting."
