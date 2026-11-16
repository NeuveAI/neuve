/* ─────────────────────────────────────────────────────────
 * ANIMATION STORYBOARD — Navigation (typed router view transitions)
 *
 * The chrome stays put; the content moves in the direction of travel.
 * Names: packages/ui/src/neuve/shared/view-transitions.ts; timing: PAGE in
 * packages/ui/src/lib/motion.ts, read by globals.css as --nv-vt-*.
 * Transform + opacity only, no morphs. Sequential, never overlapping.
 *
 * forward  overview → desk, desk → another unit, desk → lineage
 *    0ms   header (app-header): no animation, holds still
 *    0ms   old regions: opacity 1 → 0, y 0 → −4px (exit 110ms, standard
 *          accelerate)
 *  140ms   after a 30ms empty beat, stage-1 regions: opacity 0 → 1,
 *          y +8px → 0 (enter 220ms, emphasized decelerate)
 *  185ms   stage-2 regions, the same (stagger 45ms)
 *  230ms   stage-3 regions (enterLast 190ms)
 *  245ms   desk rail, when it appears: opacity 0 → 1 (rail 170ms);
 *          desk → desk it stays put
 *  420ms   done
 *
 * back     desk → overview (back link, rail, logo), lineage → desk
 *          mirrored: old page y 0 → +4px, new page from −8px
 *
 * slow     a route skeleton shows after 150ms (pendingMs) for ≥400ms
 *          (pendingMinMs); its content then fades in (content-fade 160ms),
 *          never on top of a running page transition
 *
 * Reduced motion, no View Transitions API, or no direction: instant swap.
 * ───────────────────────────────────────────────────────── */

import { createRouter as createTanStackRouter } from "@tanstack/react-router"
import type { ParsedLocation } from "@tanstack/react-router"

import type { NavigationDirection } from "@workspace/ui/neuve/shared/view-transitions"

import { routeTree } from "./routeTree.gen"

/** Depth of a page: overview 0, a review unit 1, a commit's lineage 2. */
function depth(pathname: string): number {
  const path = pathname.replace(/^\/mock(?=\/|$)/, "") || "/"
  if (path.startsWith("/changes/")) return 2
  if (path.startsWith("/review/")) return 1
  return 0
}

/**
 * Direction of travel for the typed view transition: deeper (or sideways to
 * another page) is forward, shallower is back. Same-page hash or search
 * changes get no type, so they swap instantly.
 */
export function navigationTypes({
  fromLocation,
  toLocation,
  pathChanged,
}: {
  fromLocation?: ParsedLocation
  toLocation: ParsedLocation
  pathChanged: boolean
}): Array<NavigationDirection> {
  if (!fromLocation || !pathChanged) return []
  const from = depth(fromLocation.pathname)
  const to = depth(toLocation.pathname)
  return [to < from ? "back" : "forward"]
}

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    // The desk's own scroll container starts at the top of each unit,
    // instead of inheriting the previous unit's position (round 3, item 10).
    scrollToTopSelectors: ["[data-desk-scroll]"],
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    // Feature-detected by the router: without document.startViewTransition
    // navigation is a plain, instant update.
    defaultViewTransition: { types: navigationTypes },
  })

  return router
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
