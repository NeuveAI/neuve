import { atom } from "jotai"

import type { ReviewLane } from "@workspace/ui/neuve/types"

/**
 * Batch overview interaction state, scoped by the screen's jotai Provider.
 *
 *   lane bar   none (rest: every lane full strength) → hovered lane
 *              pointer leaves the lane bar → none
 */
export const activeLaneAtom = atom<ReviewLane | null>(null)

export interface BatchOverviewState {
  activeLane: ReviewLane | null
}

export function batchOverviewHydration(state: Partial<BatchOverviewState>) {
  return [[activeLaneAtom, state.activeLane ?? null]] as const
}

export const pickLaneAtom = atom(null, (get, set, lane: ReviewLane) => {
  if (get(activeLaneAtom) !== lane) set(activeLaneAtom, lane)
})

export const resetLaneAtom = atom(null, (_get, set) => {
  set(activeLaneAtom, null)
})
