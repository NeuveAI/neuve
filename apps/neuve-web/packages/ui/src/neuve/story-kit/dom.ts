/**
 * Story kit, DOM queries (stories only; never imported by product code).
 *
 * One dialect for what plays look up: the diff hosts and their shadow
 * roots, a line's row and its overlay state, margin pins, file cards and
 * the floating layers. Plays import these instead of redefining them per
 * file, so a markup change is fixed once.
 */
import { expect, waitFor } from "storybook/test"

/** Every diff host under `root` (unit files and the neighbor). */
export function diffHosts(root: ParentNode) {
  return Array.from(root.querySelectorAll<HTMLElement>("diffs-container"))
}

/** A host's shadow root (null until the renderer attaches). */
export function shadowOf(host: Element | null | undefined) {
  return host?.shadowRoot ?? null
}

/**
 * The shadow root of the `index`th diff under `root`, once its rows have
 * rendered.
 */
export function diffRoot(root: ParentNode, index = 0) {
  return waitFor(
    () => {
      const found = shadowOf(diffHosts(root)[index])
      expect(found?.querySelector("[data-content] [data-line]")).toBeTruthy()
      return found!
    },
    { timeout: 8000 }
  )
}

/** A file card by its path. */
export function fileCard(root: ParentNode, path: string) {
  return root.querySelector<HTMLElement>(
    `[data-file-card="${CSS.escape(path)}"]`
  )!
}

/** The shadow root of a file card's diff, once it has rendered rows. */
export function fileRoot(root: ParentNode, path: string) {
  return waitFor(
    () => {
      const found = shadowOf(
        root.querySelector(
          `[data-file-card="${CSS.escape(path)}"] diffs-container`
        )
      )
      expect(found?.querySelector("[data-line]")).toBeTruthy()
      return found!
    },
    { timeout: 8000 }
  )
}

/** The new-side content row of a line (never the paired deletion). */
export function row(root: ShadowRoot, line: number) {
  return [...root.querySelectorAll<HTMLElement>("[data-content] [data-line]")]
    .filter((el) => el.getAttribute("data-line") === String(line))
    .find((el) => el.getAttribute("data-line-type") !== "change-deletion")
}

/** A line's gutter number cell on the new side (or context). */
export function numberCell(root: ShadowRoot, line: number) {
  return root.querySelector<HTMLElement>(
    `[data-column-number="${line}"]:is([data-line-type="change-addition"], [data-line-type="context"])`
  )
}

/** Whether a line holds the hover hint (the --nv-lit tint). */
export function lit(root: ShadowRoot, line: number) {
  return row(root, line)?.getAttribute("data-overlay-range") === "hint"
}

/** A line's landing phase ("a", "b" or "static"), or null. */
export function landed(root: ShadowRoot, line: number) {
  return row(root, line)?.getAttribute("data-overlay-land") ?? null
}

/** A row's tint, as computed (the overlay draws it as an inset shadow). */
export function tint(root: ShadowRoot, line: number) {
  return getComputedStyle(row(root, line)!).boxShadow
}

/** Matches of `selector` summed over every diff host's shadow root. */
export function countInDiffs(root: ParentNode, selector: string) {
  return diffHosts(root).reduce(
    (sum, host) =>
      sum + (host.shadowRoot?.querySelectorAll(selector).length ?? 0),
    0
  )
}

/** A marker's pin in the margin, by its marker key. */
export function pinOf(root: ParentNode, markerKey: string) {
  return root.querySelector<HTMLElement>(
    `button[data-marker-key="${markerKey}"]`
  )!
}

/** The pin of a line whose list holds `markerKey`. */
export function linePinWith(root: ParentNode, markerKey: string) {
  return root.querySelector<HTMLElement>(
    `button[data-marker-keys~="${markerKey}"]`
  )!
}

/** A pin once the overlay has placed (un-hidden) it on its next frame. */
export function placedPin(root: ParentNode, markerKey: string) {
  return waitFor(() => {
    const found = pinOf(root, markerKey)
    expect(found).toBeVisible()
    return found
  })
}

/** The document a canvas lives in (floating layers portal to its body). */
function docOf(root: Node) {
  return root.ownerDocument ?? (root as Document)
}

/** The open floating card, or null. */
export function openCard(root: Node) {
  return docOf(root).querySelector<HTMLElement>("[data-floating-card]")
}

/** The open floating card, once visible. */
export function floatingCard(root: Node) {
  return waitFor(() => {
    const found = openCard(root)
    expect(found).toBeVisible()
    return found!
  })
}

/** The card sits 6px below its pin, or 6px above it when flipped. */
export function expectAttached(pin: HTMLElement, layer: HTMLElement) {
  const p = pin.getBoundingClientRect()
  const l = layer.getBoundingClientRect()
  const gap = layer.dataset.side === "top" ? p.top - l.bottom : l.top - p.bottom
  expect(Math.abs(gap - 6)).toBeLessThan(2)
}

/** A line's pinned-open list of markers, or null. */
export function lineList(root: Node) {
  return docOf(root).querySelector<HTMLElement>("[data-line-list]")
}

/** The desk's main column (the desk minus the rail and the dock). */
export function mainColumn(root: ParentNode) {
  return root.querySelector<HTMLElement>("[data-desk-scroll]")!
}

/** The unit-column scroller of `UnitColumnFrame`. */
export function scroller(root: ParentNode) {
  return root.querySelector<HTMLElement>("[data-story-scroller]")!
}

/** The engaged lines as drawn: which cells, their edges and their tints. */
export function engagedLook(root: ShadowRoot) {
  const code = root.querySelector<HTMLElement>(
    "[data-line][data-overlay-engaged]"
  )
  const number = root.querySelector<HTMLElement>(
    "[data-column-number][data-overlay-engaged]"
  )
  return {
    cells: [...root.querySelectorAll("[data-overlay-engaged]")]
      .map(
        (el) =>
          `${el.getAttribute("data-line") ?? `#${el.getAttribute("data-column-number")}`}:${el.getAttribute("data-overlay-engaged")}`
      )
      .join(","),
    code: code ? getComputedStyle(code).boxShadow : "",
    number: number ? getComputedStyle(number).boxShadow : "",
  }
}

/** An element's text as seen: without its visually hidden parts. */
export function seenText(element: Element) {
  const copy = element.cloneNode(true) as Element
  copy.querySelectorAll(".sr-only").forEach((hidden) => hidden.remove())
  return copy.textContent
}

/**
 * The header's rows: its visible links, buttons and text, grouped where
 * they share a line. Elements without a box (display: contents) are left
 * out.
 */
export function headerRows(header: HTMLElement) {
  const boxes = [
    ...header.querySelectorAll<HTMLElement>("a, button, span, kbd, nav"),
  ]
    .filter((element) => element.checkVisibility())
    .map((element) => element.getBoundingClientRect())
    .filter((box) => box.height > 0)
    .sort((a, b) => a.top - b.top)
  const rows: Array<{ top: number; bottom: number }> = []
  for (const box of boxes) {
    const last = rows.at(-1)
    if (last && box.top < last.bottom - 1)
      last.bottom = Math.max(last.bottom, box.bottom)
    else rows.push({ top: box.top, bottom: box.bottom })
  }
  return rows
}
