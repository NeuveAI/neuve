/**
 * Search params of the `/mock` pages, so loading and empty states can be
 * seen in the app: `?delay=1200` holds the loader (and renders on the
 * client, so the skeleton shows), `?state=empty` serves the empty variant
 * (`?state=no-batch` on a desk serves "No review batch yet"), and
 * `?variant=gathered` opens a desk as one of its Storybook variants.
 */
export interface MockSearch {
  delay?: number
  state?: "empty" | "no-batch"
  variant?: string
}

const MAX_DELAY = 10_000

export function validateMockSearch(
  search: Record<string, unknown>
): MockSearch {
  const delay = Number(search.delay)
  const state = search.state
  const variant = search.variant
  return {
    ...(Number.isFinite(delay) && delay > 0
      ? { delay: Math.min(delay, MAX_DELAY) }
      : {}),
    ...(state === "empty" || state === "no-batch" ? { state } : {}),
    ...(typeof variant === "string" && /^[a-z-]{1,40}$/.test(variant)
      ? { variant }
      : {}),
  }
}

/** Holds a mock loader for `ms` (abortable with the navigation). */
export function mockDelay(ms: number | undefined, signal: AbortSignal) {
  if (!ms || signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const settle = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", settle)
      resolve()
    }
    const timer = setTimeout(settle, ms)
    signal.addEventListener("abort", settle, { once: true })
  })
}

/** Delayed mock pages render on the client, so the skeleton is visible. */
export function ssrUnlessDelayed({
  search,
}: {
  search: { status: "success"; value: MockSearch } | { status: "error" }
}) {
  return !(search.status === "success" && search.value.delay)
}
