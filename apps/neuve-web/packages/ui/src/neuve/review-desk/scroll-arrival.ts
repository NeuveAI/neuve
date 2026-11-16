/**
 * Scroll arrival, shared by the diff's landings and the briefing's jump to
 * the agent's review: the scroll ancestor, the reader's motion preference,
 * the frame after scrolls already made are reported, and a signal once a
 * scroll has settled (the tint starts only then).
 */

/** A scroll position unchanged for this many frames has arrived. */
const SETTLED_FRAMES = 6
/** Arrival fallback when no scrollend or settled position is seen. */
const ARRIVAL_TIMEOUT_MS = 2000

/** The nearest ancestor that scrolls; null when the page itself scrolls. */
export function scrollParent(node: HTMLElement): HTMLElement | null {
  for (let el = node.parentElement; el; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el)
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      el.scrollHeight > el.clientHeight
    )
      return el
  }
  return null
}

export function prefersReducedMotion() {
  return (
    typeof matchMedia !== "undefined" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches
  )
}

/**
 * Calls `run` on the next frame, after the scroll and scrollend events of
 * scrolls already made: those are reported a frame late (the press on a
 * link behind the dock scrolls the desk as it focuses the link). Started
 * before them, a landing would take that scrollend for its own arrival, and
 * a layer that closes when its trigger scrolls would close as it opens.
 * Returns a canceller.
 */
export function afterPendingScrolls(run: () => void) {
  const frame = requestAnimationFrame(() => run())
  return () => cancelAnimationFrame(frame)
}

/**
 * Calls `arrived` once the landing's scroll has settled: the scroller's
 * scrollend, or its position unchanged for SETTLED_FRAMES frames (no scroll
 * was needed, or no scrollend support), or a timeout. Returns a canceller.
 */
export function whenScrollSettles(host: HTMLElement, arrived: () => void) {
  const scroller = scrollParent(host)
  const target: EventTarget = scroller ?? window
  const position = () => (scroller ? scroller.scrollTop : window.scrollY)
  let done = false
  let frame = 0
  let last = position()
  let still = 0
  const finish = () => {
    if (done) return
    done = true
    cancel()
    arrived()
  }
  const tick = () => {
    const now = position()
    still = now === last ? still + 1 : 0
    last = now
    if (still >= SETTLED_FRAMES) finish()
    else frame = requestAnimationFrame(tick)
  }
  const timer = setTimeout(finish, ARRIVAL_TIMEOUT_MS)
  target.addEventListener("scrollend", finish, { once: true })
  frame = requestAnimationFrame(tick)
  function cancel() {
    clearTimeout(timer)
    cancelAnimationFrame(frame)
    target.removeEventListener("scrollend", finish)
  }
  return cancel
}
