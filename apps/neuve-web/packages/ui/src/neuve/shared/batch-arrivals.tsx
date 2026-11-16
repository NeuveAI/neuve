import { atom, getDefaultStore, useAtomValue, useSetAtom } from "jotai"
import { useHydrateAtoms } from "jotai/utils"
import { createContext, useContext, useEffect } from "react"
import type * as React from "react"

import type { ReviewBatches } from "@workspace/ui/neuve/types"

/*
 * Batches that arrive while the reader is in a review. A review too large
 * for one run publishes its batches one at a time, and the page's data
 * reloads when one does. The header tells the reader once, in a polite live
 * region, and marks the batch menu; the overview's meta row holds its width.
 * Nothing else on the page moves.
 *
 *   first shown      the batches on screen are known; nothing is said
 *   reload, +1       "New batch: <title>" is announced, once; the menu's
 *                    trigger carries a dot
 *   menu opened      the dot goes; the new rows read "New" while it is open
 *   menu reopened    no row reads "New" (unless another batch came since)
 *   other screens    the overview and every unit page of the review keep the
 *                    dot until the menu is opened; nothing is said again
 *   newer review     a newer review of the work replaced this one (the
 *                    reload's `newer`): "A newer review of this work is
 *                    ready" is announced once per review; the header links
 *                    to it (app-header.tsx)
 *
 * What a review's screens share lives in a store the screens share, as the
 * live status does (`liveStatusAtom`, set by the root route): jotai's
 * default store, which no screen's own Provider replaces. It is keyed by the
 * review. What one screen says (its announcement) and whether it showed
 * batches still being reviewed live in that screen's own store, so a new
 * screen starts silent.
 */

/** A store the screens of a review share: the default one, or a story's own. */
const SharedStoreContext = createContext(getDefaultStore())

/**
 * Gives the screens below a store of their own for arrivals: stories, so
 * one story's arrivals never reach another's. The app uses the default store.
 */
export function BatchArrivalsStore({
  store,
  children,
}: {
  store: ReturnType<typeof getDefaultStore>
  children: React.ReactNode
}) {
  return (
    <SharedStoreContext.Provider value={store}>
      {children}
    </SharedStoreContext.Provider>
  )
}

/** How the overview's meta row said the batches still to come. */
export interface PendingItem {
  pending: number
  stopped: boolean
}

/** One review's arrivals, shared by every screen of it. */
interface ReviewArrivals {
  /** Batches already told of: those on screen when it was first shown, and each arrival since. */
  told: ReadonlyArray<string>
  /** Arrived batches the menu has not shown yet: the trigger's dot. */
  unseen: ReadonlyArray<string>
  /** The rows that read "New": what was unseen when the menu last opened. */
  menuNew: ReadonlyArray<string>
  /** The meta row's item as the review first showed it, while it had batches to come. */
  firstItem: PendingItem | null
  /** The reader was told a newer review of this work is ready. */
  newerTold?: true
}

/** Every review's arrivals, by the review's key (the first batch it was seen with). */
export const reviewArrivalsAtom = atom<
  Readonly<Record<string, ReviewArrivals>>
>({})

/**
 * The review a list of batches belongs to: the one already told of any of
 * them (so a batch published out of order still finds its review), else a
 * new one named by its first batch.
 */
function reviewKey(
  all: Readonly<Record<string, ReviewArrivals>>,
  ids: ReadonlyArray<string>
): string | undefined {
  return (
    Object.keys(all).find((key) =>
      all[key]!.told.some((id) => ids.includes(id))
    ) ?? ids[0]
  )
}

const pendingItem = (batches: ReviewBatches | undefined): PendingItem | null =>
  batches && (batches.pending ?? 0) > 0
    ? { pending: batches.pending!, stopped: batches.stopped === true }
    : null

/** This screen showed batches still to come (the screen's own store). */
const screenHeldAtom = atom(false)

/** This screen's last announcement, and how many (a repeat is re-read). */
const announcementAtom = atom({ text: "", count: 0 })

/** Whether this screen has shown the review with batches still to come. */
function useScreenHeld(batches: ReviewBatches | undefined) {
  useHydrateAtoms([[screenHeldAtom, pendingItem(batches) !== null]])
  return useAtomValue(screenHeldAtom) || pendingItem(batches) !== null
}

/** The shared arrivals of the review these batches belong to. */
function useReviewArrivals(batches: ReviewBatches | undefined) {
  const store = useContext(SharedStoreContext)
  const all = useAtomValue(reviewArrivalsAtom, { store })
  const ids = batches?.all.map((batch) => batch.id) ?? []
  const key = reviewKey(all, ids)
  return key === undefined ? undefined : all[key]
}

/** The menu was opened: what arrived unseen reads "New" there, and the dot goes. */
export function useOpenedBatchMenu() {
  const store = useContext(SharedStoreContext)
  const set = useSetAtom(reviewArrivalsAtom, { store })
  return (batches: ReviewBatches) =>
    set((all) => {
      const key = reviewKey(
        all,
        batches.all.map((batch) => batch.id)
      )
      const entry = key === undefined ? undefined : all[key]
      if (!entry || key === undefined) return all
      return { ...all, [key]: { ...entry, menuNew: entry.unseen, unseen: [] } }
    })
}

/**
 * The batches whose menu rows read "New" while the menu is open, and how
 * many arrivals the menu has not shown yet (the trigger's dot).
 */
export function useNewBatches(batches: ReviewBatches) {
  const entry = useReviewArrivals(batches)
  return {
    fresh: new Set(entry?.menuNew ?? []),
    unseen: entry?.unseen.length ?? 0,
  }
}

/**
 * The overview's meta-row item for the batches still to come: what it says
 * now (null once none are), and the item whose width it keeps while this
 * screen lives (the one the review first showed), so the row never narrows
 * or rewraps under the reader. Null for a screen that never showed any.
 */
export function usePendingItem(batches: ReviewBatches | undefined) {
  const held = useScreenHeld(batches)
  const entry = useReviewArrivals(batches)
  const shown = pendingItem(batches)
  return {
    shown,
    held: held ? (entry?.firstItem ?? shown) : null,
  }
}

/** "New batch: Expiry reminders by email", or "2 new batches". */
function announcement(titles: ReadonlyArray<string>) {
  return titles.length === 1
    ? `New batch: ${titles[0]}`
    : `${titles.length} new batches`
}

/** What the reader hears when a newer review of the work on screen is ready. */
export const NEWER_REVIEW_ANNOUNCEMENT = "A newer review of this work is ready"

/**
 * The header's one polite live region for arriving batches, and for a
 * newer review that replaced the one on screen. It is in the page from the
 * first render of a review that is still being reviewed, so the first
 * announcement is read; for a newer review it comes in empty and is filled
 * after, as the reload brings it. It is visually hidden and takes no focus.
 * The newer review is said once per review, on whichever of its screens
 * the reader is on.
 */
export function BatchArrivalsAnnouncer({
  batches,
  newer,
}: {
  batches: ReviewBatches | undefined
  /** A newer review replaced this screen's (`ReviewDeskData.newer`). */
  newer?: boolean
}) {
  const shared = useContext(SharedStoreContext)
  const held = useScreenHeld(batches)
  const setHeld = useSetAtom(screenHeldAtom)
  const said = useAtomValue(announcementAtom)
  const say = useSetAtom(announcementAtom)
  // A data reload from the records stream, not anything the reader did,
  // brings the batches; the live region is already in the page.
  // Effect: tells assistive tech, after commit, what a data reload brought.
  useEffect(() => {
    const ids = batches?.all.map((batch) => batch.id) ?? []
    if (!batches || ids.length === 0) return
    const item = pendingItem(batches)
    if (item) setHeld(true)
    const all = shared.get(reviewArrivalsAtom)
    const key = reviewKey(all, ids)!
    const entry = all[key]
    const tellNewer = newer === true && !entry?.newerTold
    if (tellNewer)
      say((last) => ({
        text: NEWER_REVIEW_ANNOUNCEMENT,
        count: last.count + 1,
      }))
    if (!entry) {
      // The review's first screen in this session: nothing is new.
      shared.set(reviewArrivalsAtom, {
        ...all,
        [key]: {
          told: ids,
          unseen: [],
          menuNew: [],
          firstItem: item,
          ...(tellNewer ? { newerTold: true as const } : {}),
        },
      })
      return
    }
    if (tellNewer)
      shared.set(reviewArrivalsAtom, {
        ...all,
        [key]: { ...entry, newerTold: true },
      })
    const arrived = batches.all.filter(
      (batch) => !entry.told.includes(batch.id)
    )
    if (arrived.length === 0 && (entry.firstItem || !item)) return
    shared.set(reviewArrivalsAtom, {
      ...all,
      [key]: {
        ...entry,
        ...(tellNewer ? { newerTold: true as const } : {}),
        firstItem: entry.firstItem ?? item,
        told: [...entry.told, ...arrived.map((batch) => batch.id)],
        unseen: [...entry.unseen, ...arrived.map((batch) => batch.id)],
      },
    })
    if (arrived.length > 0)
      say((last) => ({
        text: announcement(arrived.map((batch) => batch.title)),
        count: last.count + 1,
      }))
  }, [shared, setHeld, say, batches, newer])
  if (!held && !newer) return null
  return (
    <div role="status" data-batch-arrivals="" className="sr-only">
      {said.text && (
        // Keyed by announcement, so the same words twice are read twice.
        <span key={said.count}>{said.text}</span>
      )}
    </div>
  )
}
