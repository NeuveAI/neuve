import type {
  ReviewBatch,
  ReviewLane,
  ReviewSummary,
  ReviewsData,
} from "@workspace/ui/neuve/types"

/*
 * What the home page (`/`) shows: every review's batches, newest review
 * first, each with its batch digest (14.30, 14.31), its units by lane, what
 * waits on the reader (14.33) and where its review stands.
 */

/** One batch as the home page shows it. */
export interface HomeBatch extends ReviewBatch {
  /** Its units by lane, in lane order; lanes with none are left out. */
  lanes: Array<{ lane: ReviewLane; count: number }>
  /**
   * The batch digest's account of what changed, as plain text: phrase links
   * read as their phrase, and `**Label:**` stays for the page to bold.
   * Absent when the batch has no digest, or it couldn't be read.
   */
  digest?: string
  /** The digest's account of what was verified, as plain text. */
  toCheck?: string
  /** What the batch removes, disables or narrows (13.19), one sentence each. */
  removes?: Array<string>
  /** Human units it asks a person about, decided or not (`needYou` waits). */
  asked: number
  /** The unit its desk opens on: the first waiting on the reader, else its first. */
  deskUnitId?: string
}

/** A review with its batches as the home page shows them. */
export interface HomeReview extends Omit<ReviewSummary, "batches"> {
  batches: Array<HomeBatch>
}

export interface HomeData extends Omit<ReviewsData, "reviews"> {
  /** This page's reviews, newest run first. */
  reviews: Array<HomeReview>
}

export type HomeLoad =
  | { status: "ready"; data: HomeData }
  /** No review was ever started here. */
  | { status: "empty" }
