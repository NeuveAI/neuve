/*
 * The live reload, marked. When Records moves past the page on screen, the
 * root reloads the router's data (`router.invalidate()`, `__root.tsx`); a
 * newer review that replaced the unit or batch on screen must not move the
 * reader then. Every other load (the first load, the server's render, a
 * navigation, back and forward, a hard refresh) follows the work as before.
 *
 * The router's loader cause alone cannot tell them apart: it is "stay"
 * whenever a route stays matched, also on a move from one unit to another.
 * So the root marks its own reload: a flag set before `router.invalidate()`
 * and cleared when it settles, on failure too. It lives in the browser
 * only; the server never sets it, so a server render never reads it set.
 */

/** Live reloads in flight in this tab (they can overlap). */
let inFlight = 0

/**
 * Runs `reload` (the root's `router.invalidate()`) as the live reload: the
 * flag is set for exactly as long as it runs, and cleared however it ends.
 */
export async function liveReload<TResult>(
  reload: () => Promise<TResult>
): Promise<TResult> {
  inFlight += 1
  try {
    return await reload()
  } finally {
    inFlight -= 1
  }
}

/** Whether a live reload is in flight in this tab; never on the server. */
export const liveReloadInFlight = () =>
  typeof window !== "undefined" && inFlight > 0

/**
 * Whether a unit's or batch's load keeps the page the reader is on (`stay`
 * for the loads): only the live reload, in the browser, of a route that
 * stays matched. Anything else enters the page and follows the work.
 */
export const keepsPage = (load: {
  readonly client: boolean
  readonly liveReload: boolean
  readonly cause: "preload" | "enter" | "stay"
}) => load.client && load.liveReload && load.cause === "stay"

/** The decision for a route's loader, from where and how it runs now. */
export const loaderKeepsPage = (cause: "preload" | "enter" | "stay") =>
  keepsPage({
    client: typeof window !== "undefined",
    liveReload: liveReloadInFlight(),
    cause,
  })
