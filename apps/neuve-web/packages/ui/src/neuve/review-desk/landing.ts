import { atom, useAtomValueRawSync } from "jotai"
import { atomWithStorage } from "jotai/utils"

import type { LineRange } from "@workspace/ui/neuve/types"

/**
 * Round 3 cross-component contract: where the reviewer is in the diff, and
 * where something asked to take them.
 *
 * Written once by the supervisor so the briefing, the rail and the diff can be
 * built in parallel. Owners:
 *
 *   landingAtom      written by briefing citation chips, briefing phrases and
 *                    the rail Files tab;
 *                    consumed by the diff, which scrolls the target below the
 *                    sticky file header and tints the range once, then clears it
 *   currentFileAtom  written by the diff (the file whose header is stuck or
 *                    nearest the top); read by the rail Files tab
 *   viewedFilesAtom  written by the file header's Viewed toggle; read by the
 *                    rail Files tab and the diff toolbar count
 *
 * A landing names its unit. The diff ignores (and clears) a target for another
 * unit or for a file it does not render; a citation into a file outside the
 * diff opens the source sheet instead of landing.
 *
 * Design source: Sticky.dc.html in the canvas (round 3).
 */

export interface LandingTarget {
  unitId: string
  filePath: string
  /** Omitted to land on the file header itself. */
  range?: LineRange
  /** More lines that land with `range` (a section's separate runs). */
  ranges?: Array<LineRange>
  /**
   * "if-needed": lines already in view are not scrolled to; they only take
   * the landing tint (a margin pin opening its card, round 5b). "none": the
   * caller has scrolled already (a section step brings its row in); the
   * lines only take the tint.
   */
  scroll?: "if-needed" | "none"
  /** Strictly increasing per session, so a repeat request is never mistaken for one already handled. */
  nonce: number
}

export const landingAtom = atom<LandingTarget | null>(null)

// Independent of the slot: clearing landingAtom must not restart the sequence.
let landingSequence = 0

/** Request a landing; the diff consumes and clears it. */
export const landOnAtom = atom(
  null,
  (_get, set, target: Omit<LandingTarget, "nonce">) => {
    landingSequence += 1
    set(landingAtom, { ...target, nonce: landingSequence })
  }
)

/**
 * Lines a briefing phrase describes, lit while the phrase has real hover or
 * keyboard focus (round 5), as a pointed-at marker pin lights its lines.
 * Written by the briefing, read by the diff (the same --nv-lit hint tint).
 * `phrase` names the phrase that lit them, so only it clears them.
 */
export interface LitLines {
  unitId: string
  filePath: string
  range: LineRange
  /** More lines lit with `range` (a section's separate runs). */
  ranges?: Array<LineRange>
  phrase: string
}

export const litLinesAtom = atom<LitLines | null>(null)

export const currentFileAtom = atom<string | null>(null)

/**
 * Files the viewer marked viewed. Viewer-local progress, not review state.
 * Server rendering has no storage, so viewed files render open first and fold
 * once storage is read on the client.
 */
export const VIEWED_FILES_STORAGE_KEY = "neuve.viewed-files.v1"
export const viewedFilesAtom = atomWithStorage<Record<string, true>>(
  VIEWED_FILES_STORAGE_KEY,
  {}
)

/**
 * The viewed record, read through useSyncExternalStore. jotai 3's
 * useAtomValue no longer re-renders after subscribing, so it misses the record
 * atomWithStorage (getOnInit false) loads on mount; read viewed files with this.
 */
export function useViewedFiles(): Readonly<Record<string, true>> {
  return useAtomValueRawSync(viewedFilesAtom)
}

/** Collision-free: revisions may contain ":" (e.g. "snapshot:<sha>"). */
export function viewedKey(unitId: string, revision: string, filePath: string) {
  return JSON.stringify([unitId, revision, filePath])
}

/** Stored viewed keys at most; the oldest go first. */
export const MAX_VIEWED_FILES = 500

/** The unit and revision of a key (only this module reads its format). */
function keyScope(key: string): { unitId: string; revision: string } | null {
  try {
    const parts: unknown = JSON.parse(key)
    if (
      Array.isArray(parts) &&
      parts.length === 3 &&
      typeof parts[0] === "string" &&
      typeof parts[1] === "string"
    )
      return { unitId: parts[0], revision: parts[1] }
  } catch {
    // A key from an older format: dropped by the next prune.
  }
  return null
}

/**
 * The viewed record after marking `key` viewed or not. Bounded: viewing a
 * file of a unit drops the unit's other revisions (a new commit restarts
 * the unit's progress), unreadable keys go, and at most MAX_VIEWED_FILES
 * keys stay, the most recently marked ones (insertion order).
 */
export function nextViewedFiles(
  current: Readonly<Record<string, true>>,
  key: string,
  viewed: boolean
): Record<string, true> {
  const scope = keyScope(key)
  const next: Record<string, true> = {}
  for (const existing of Object.keys(current)) {
    if (existing === key) continue
    const other = keyScope(existing)
    if (!other) continue
    if (
      scope &&
      other.unitId === scope.unitId &&
      other.revision !== scope.revision
    )
      continue
    next[existing] = true
  }
  if (viewed) next[key] = true
  const keys = Object.keys(next)
  for (const old of keys.slice(0, Math.max(keys.length - MAX_VIEWED_FILES, 0)))
    delete next[old]
  return next
}

/** Mark a file (its viewedKey) viewed or not, keeping the record bounded. */
export const markViewedAtom = atom(
  null,
  (get, set, key: string, viewed: boolean) => {
    set(viewedFilesAtom, nextViewedFiles(get(viewedFilesAtom), key, viewed))
  }
)
