import * as React from "react"
import { atom, useAtomValueRawSync } from "jotai"
import type { WritableAtom } from "jotai"
import { atomWithStorage, createJSONStorage } from "jotai/utils"

import type {
  BriefingSegment,
  Checkpoint,
  ExplainedText,
  LineRange,
  MarkerTone,
} from "@workspace/ui/neuve/types"

/**
 * Round 4 cross-component contract: review delivery.
 *
 * One dial with four stops sets how much a review explains before anyone
 * reads the code. The cited facts never change between stops; higher stops add
 * layers, and Guided trades the diff for the ticket's "Done when" items,
 * ending in the harness's suggested disposition (a "suggested review" in UI
 * copy; user-facing naming per round-4.md).
 *
 * Written once by the supervisor so the settings page and the desk can be
 * built in parallel. Owners:
 *
 *   deliverySettingsAtom      written by the settings page; read by the desk
 *                             (mock only until the backend carries settings)
 *   unitDeliveryOverrideAtom  written by the desk dial for one unit; never
 *                             persisted and never recorded in review history
 *   DeliveryPayload           carried by ReviewDeskData.delivery (fixtures
 *                             today; the harness later)
 *
 * Neuve never infers a reader's skill: the stop comes only from the workspace
 * setting, refined by language, or from the reader moving the dial.
 *
 * Design source: Delivery, DeliverySettings and DeliveryRules boards in the
 * canvas (round 4); written spec in design/neuve-web/changes/round-4.md.
 */

export const DELIVERY_STOPS = [
  "facts",
  "briefed",
  "explained",
  "guided",
] as const
export type DeliveryStop = (typeof DELIVERY_STOPS)[number]

export const DELIVERY_STOP_LABEL: Record<DeliveryStop, string> = {
  facts: "Facts",
  briefed: "Briefed",
  explained: "Explained",
  guided: "Guided",
}

/** Settings copy under each stop of the large dial. */
export const DELIVERY_STOP_DESCRIPTION: Record<DeliveryStop, string> = {
  facts: "One cited sentence, then the code.",
  briefed: "Cited claims, one per line, then the code.",
  explained:
    "Adds what it did before and does after, and the language terms it uses.",
  guided:
    "No code. What the ticket asked for, done or not, with a suggested review.",
}

export function deliveryStopIndex(stop: DeliveryStop): number {
  return DELIVERY_STOPS.indexOf(stop)
}

/**
 * A repository language as the provider declares it. It is observation data,
 * never a closed list: Neuve doesn't select, privilege or infer languages
 * (CONSTITUTION.md, "Repository-language neutrality"). No frameworks.
 */
export type DeliveryLanguage = string

/** A language observed in the workspace, as listed on the settings page. */
export interface DeliveryLanguageInfo {
  id: DeliveryLanguage
  name: string
  /** Declared file types, shown as a hint only; never used to classify. */
  fileTypes?: Array<string>
}

export interface DeliverySettings {
  workspaceDefault: DeliveryStop
  /** A language absent here follows the workspace default. */
  byLanguage: Partial<Record<DeliveryLanguage, DeliveryStop>>
}

/** No language refinements by default: languages are observed data. */
export const DEFAULT_DELIVERY_SETTINGS: DeliverySettings = {
  workspaceDefault: "briefed",
  byLanguage: {},
}

/**
 * Mock workspace setting. Browser storage until settings exist in the
 * backend; server rendering sees the default and the client then reads storage.
 */
export const DELIVERY_SETTINGS_STORAGE_KEY = "neuve.review-delivery.v1"

const isStop = (value: unknown): value is DeliveryStop =>
  typeof value === "string" &&
  (DELIVERY_STOPS as ReadonlyArray<string>).includes(value)

/** A stored value the setting can use: anything else (null, an old shape) reads as the default. */
function isDeliverySettings(value: unknown): value is DeliverySettings {
  if (typeof value !== "object" || value === null) return false
  const { workspaceDefault, byLanguage } = value as Record<string, unknown>
  return (
    isStop(workspaceDefault) &&
    typeof byLanguage === "object" &&
    byLanguage !== null &&
    Object.values(byLanguage).every(isStop)
  )
}

const json = createJSONStorage<unknown>()

/** Browser storage for a delivery setting that never hands the screens a malformed value. */
export const deliverySettingsStorage = {
  getItem: (key: string, initialValue: DeliverySettings): DeliverySettings => {
    const value = json.getItem(key, initialValue)
    return isDeliverySettings(value) ? value : initialValue
  },
  setItem: (key: string, value: DeliverySettings) => json.setItem(key, value),
  removeItem: (key: string) => json.removeItem(key),
  subscribe: (
    key: string,
    callback: (value: DeliverySettings) => void,
    initialValue: DeliverySettings
  ) =>
    json.subscribe?.(
      key,
      (value) => callback(isDeliverySettings(value) ? value : initialValue),
      initialValue
    ),
}

export const deliverySettingsAtom = atomWithStorage<DeliverySettings>(
  DELIVERY_SETTINGS_STORAGE_KEY,
  DEFAULT_DELIVERY_SETTINGS,
  deliverySettingsStorage
)

/** Any atom holding the workspace setting (storage-backed or in memory). */
export type DeliverySettingsAtom = WritableAtom<
  DeliverySettings,
  [DeliverySettings],
  void
>

/**
 * Which settings atom a subtree reads. The real setting by default; the
 * `/mock` layout provides its sample atom, so the mock settings page and the
 * mock desk share one sample setting that never reaches the real one.
 */
const DeliverySettingsAtomContext =
  React.createContext<DeliverySettingsAtom>(deliverySettingsAtom)

export const DeliverySettingsAtomProvider = DeliverySettingsAtomContext.Provider

export function useDeliverySettingsAtom(): DeliverySettingsAtom {
  return React.useContext(DeliverySettingsAtomContext)
}

/**
 * The current setting, read through useSyncExternalStore. jotai 3's
 * useAtomValue no longer re-renders after subscribing, so it misses the value
 * atomWithStorage (getOnInit false) loads on mount; read settings with this.
 */
export function useDeliverySettings(): DeliverySettings {
  return useAtomValueRawSync(useDeliverySettingsAtom())
}

/** The reader's stop for one unit, keyed by unit id. Session only. */
export const unitDeliveryOverrideAtom = atom<Record<string, DeliveryStop>>({})

export function resolveDeliveryStop(
  settings: DeliverySettings,
  language: DeliveryLanguage | undefined,
  override?: DeliveryStop
): DeliveryStop {
  return (
    override ??
    (language === undefined ? undefined : settings.byLanguage[language]) ??
    settings.workspaceDefault
  )
}

/**
 * The stops a payload offers. A payload without `stops` (one built by hand:
 * fixtures, the canvas, stories) offers all four, as every payload did
 * before the field: only the projection knows what a unit's content holds,
 * so only a payload that says so can take a stop away.
 */
export function offeredStops(
  payload: Pick<DeliveryPayload, "stops">
): ReadonlyArray<DeliveryStop> {
  return payload.stops ?? DELIVERY_STOPS
}

/**
 * The stop a unit shows: the one asked for when it is offered, else the
 * deepest offered stop below it (Facts when nothing below is offered). The
 * reader's setting and overrides keep their values; only what shows moves.
 */
export function clampDeliveryStop(
  stop: DeliveryStop,
  offered: ReadonlyArray<DeliveryStop>
): DeliveryStop {
  for (let index = deliveryStopIndex(stop); index >= 0; index--) {
    const candidate = DELIVERY_STOPS[index]!
    if (offered.includes(candidate)) return candidate
  }
  return "facts"
}

/* ── Desk payload ─────────────────────────────────────────────────────── */

/** A box in the before/after flow; `range` lands on the symbol. */
export interface DeliveryFlowNode {
  label: string
  tone?: "plain" | "fails" | "end"
  range?: LineRange
}

export interface DeliveryFlowEdge {
  /** Edge text before the next node, e.g. "busy". Omitted for a plain arrow. */
  label?: string
  /** Draws the retry glyph with the label (e.g. "×3"). */
  loop?: boolean
}

/** Alternating nodes and edges: node, edge, node, edge, node. */
export type DeliveryFlowRow = Array<DeliveryFlowNode | DeliveryFlowEdge>

export interface DeliveryFlow {
  /** "How Commit changes" */
  title: string
  range: LineRange
  filePath: string
  before: DeliveryFlowRow
  after: DeliveryFlowRow
}

/** A construct from the owned lines, at most three per unit. */
export interface DeliveryTerm {
  term: string
  explanation: string
  filePath: string
  range: LineRange
}

export type DeliveryCriterionStatus =
  | "met"
  | "not-met"
  | "no-evidence"
  /** Found by the context margin outside the ticket; for the reader's judgement. */
  | "outside"

export interface DeliveryEvidence {
  /** Marker identity kind; "source" with an excerpt opens the cited lines. */
  kind: MarkerTone
  label: string
  /** Faint target text after the kind label, e.g. "line 34". */
  target?: string
  markerKey?: string
  /** Guided shows no diff; a source chip opens only these lines. */
  excerpt?: Array<string>
}

/**
 * A checkpoint as Guided shows it (11.23): its number, requirement, proof
 * state and Records' note pass through, with whether Records counts it
 * unmet (Missing, Out of date or Conflicting), so the desk derives nothing.
 */
export interface DeliveryCheckpoint extends Checkpoint {
  unmet: boolean
  /**
   * The first owned lines it is anchored to, as a pin that opens them.
   * Absent when it is anchored to its unit as a whole (11.17).
   */
  lines?: DeliveryEvidence
}

export interface DeliveryCriterion {
  id: string
  criterion: string
  status: DeliveryCriterionStatus
  /** What the change does about it, in words. */
  does: string
  evidence: Array<DeliveryEvidence>
  /**
   * "missing" when the item's file has no proof record (no test run or
   * static check is recorded, 11.1, 11.16). The status above stays the
   * review's answer. Absent when proof is recorded, or on older rows.
   */
  proofState?: "missing"
  /**
   * The agent's reading of whether the changed code, and any test it saw,
   * does what the item asks: plain words, and its own cited lines (which
   * can differ from `evidence`). Never a status. Absent on older rows.
   */
  reading?: { text: string; cites: Array<DeliveryEvidence> }
  /**
   * The unit's checkpoints whose requirement rests on this item (its
   * basis), in their order (11.23). The agent's word above never changes
   * with their states: a checkpoint is not a verdict.
   */
  checkpoints?: Array<DeliveryCheckpoint>
}

export interface DeliverySuggestion {
  decision: "request_changes" | "approve"
  /**
   * The agent's words. The conclusion ("2 of 3 not done") is never carried
   * here: the desk computes it from the criteria rows.
   */
  message: string
  /**
   * When the suggestion was carried from an earlier review, the line that
   * says so ("Carried from an earlier review."). It leads what the
   * dock sends or opens for editing (`suggestionText`), and the Guided card
   * always shows it.
   */
  carried?: string
}

/** What the dock sends as the reader's, or opens for editing: the carried line, then the agent's words. */
export const suggestionText = (
  suggestion: Pick<DeliverySuggestion, "message" | "carried">
) =>
  suggestion.carried === undefined
    ? suggestion.message
    : `${suggestion.carried}\n\n${suggestion.message}`

export interface DeliveryPayload {
  /**
   * The stops this unit has content for, in dial order. Facts always; the
   * others only when the unit says more there. Absent offers all four (see
   * `offeredStops`).
   */
  stops?: ReadonlyArray<DeliveryStop>
  /** Provider-declared language of the unit; absent → the workspace default. */
  language?: DeliveryLanguage
  /** The provider's display name for that language (e.g. "Go"), never derived from the id. */
  languageName?: string
  /** Facts stop: one sentence, every claim cited. */
  facts: Array<BriefingSegment>
  /** Explained and Guided. */
  flow?: DeliveryFlow
  /** Explained only. */
  terms?: Array<DeliveryTerm>
  /**
   * Explained as the harness writes it (10.60): before and after paragraphs
   * and up to three terms, shown as written in the flow card.
   */
  explained?: ExplainedText
  /**
   * Guided only. Never absent at Guided: the harness falls back from the
   * ticket's "Done when" to its scope, then to a scope it gathers from code and
   * history (round-4.md, "Scope is always gathered").
   */
  check?: {
    /**
     * The ticket the rows come from: people read the title; the id is
     * secondary. For a gathered scope the title is the gathered intent and
     * there is no id.
     */
    ticket: { id?: string; title: string }
    /** "done-when" (default), the ticket's "scope", or a "gathered" scope. */
    basis?: "done-when" | "scope" | "gathered"
    /**
     * Reported by the harness, for basis "gathered" only: no ticket, doc,
     * recorded decision or earlier review links to the change, so all
     * evidence is code and history. Rows can still be Covered. The desk
     * never infers it from the rows' statuses.
     */
    unlinked?: boolean
    criteria: Array<DeliveryCriterion>
    /**
     * The unit's checkpoints that rest on no item above: implied by the
     * change, or with a basis that names no row (11.23).
     */
    checkpoints?: Array<DeliveryCheckpoint>
    /** Human-required units only (round-4.md, "Guided per lane"). */
    suggestion?: DeliverySuggestion
  }
}
