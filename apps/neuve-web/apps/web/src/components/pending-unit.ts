import { useRouterState } from "@tanstack/react-router"

/** The review unit a desk path names (`/review/<id>`, also under `/mock`). */
export function deskUnitFromPath(pathname: string): string | null {
  const match = /^(?:\/mock)?\/review\/([^/]+)\/?$/.exec(pathname)
  if (!match?.[1]) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return null
  }
}

/**
 * The unit the router is navigating to while a navigation is pending, else
 * null (round 3, item 10; review F3). The router owns the pending location,
 * so Back, Forward and superseded navigations settle the desk's switching
 * state the moment they resolve.
 */
export function usePendingUnitId(): string | null {
  return useRouterState({
    select: (state) =>
      state.status === "pending"
        ? deskUnitFromPath(state.location.pathname)
        : null,
  })
}
