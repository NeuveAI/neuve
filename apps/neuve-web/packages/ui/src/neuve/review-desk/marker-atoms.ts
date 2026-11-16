import { atom } from "jotai"

import {
  composerAtom,
  hoverHintAtom,
  openMarkerAtom,
} from "@workspace/ui/neuve/review-desk/atoms"

/**
 * Round 3 margin state (context-markers.md). A line with several items
 * shows one pin; clicking it opens the line's list, and choosing one opens
 * that item's card through `openMarkerAtom` as before.
 *
 * Opening any card or the composer must clear the list. The actions here
 * and the briefing do; the openers in atoms.ts (toggleMarker, openCitation,
 * openComposer, selectLines, closeExpanded) are to set `openLineAtom` to null
 * too (requested of its owner). This module reads atoms.ts only inside write
 * functions, so the two modules may import each other.
 */

/** A margin line across the desk: its file and its group id (`side:line`). */
export function lineKey(filePath: string, groupId: string): string {
  return JSON.stringify([filePath, groupId])
}

/** The margin line (`lineKey`) whose list is open. */
export const openLineAtom = atom<string | null>(null)

/** A card chosen from a line's list: the line and the chosen item. */
export interface LineOrigin {
  line: string
  markerKey: string
}

/**
 * The list the open card was chosen from. While that card is open, its back
 * control returns to the list; back there, it names the row to focus. The
 * other openers (toggleMarker, openCitation in atoms.ts) clear it, so a card
 * opened any other way has no back control.
 */
export const cardFromLineAtom = atom<LineOrigin | null>(null)

/** Pin click on a shared line: open its list, or close it when it is open. */
export const toggleLineAtom = atom(null, (get, set, line: string) => {
  set(openLineAtom, get(openLineAtom) === line ? null : line)
  set(cardFromLineAtom, null)
  set(openMarkerAtom, null)
  set(hoverHintAtom, null)
  set(composerAtom, null)
})

export const closeLineAtom = atom(null, (_get, set) => {
  set(openLineAtom, null)
})

/** A row of the line's list: its item's card replaces the list. */
export const chooseLineMarkerAtom = atom(
  null,
  (_get, set, origin: LineOrigin) => {
    set(openLineAtom, null)
    set(openMarkerAtom, origin.markerKey)
    set(cardFromLineAtom, origin)
    set(hoverHintAtom, null)
    set(composerAtom, null)
  }
)

/** The card's back control (or Escape): the list it came from replaces it. */
export const backToLineAtom = atom(null, (get, set) => {
  const origin = get(cardFromLineAtom)
  if (!origin) return
  set(openMarkerAtom, null)
  set(openLineAtom, origin.line)
})
