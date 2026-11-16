/**
 * Story kit, play actions (stories only; never imported by product code).
 *
 * The review-delivery helpers work with the always-visible dial and with the
 * title glyph that opens it: when a `[data-delivery-trigger]` exists and the
 * dial isn't shown, they press the trigger first. The dial never closes on
 * its own (only its trigger or Escape close it), so picking a stop waits for
 * no fold. Plays that go through these helpers survive the switch unedited.
 */
import { expect, userEvent, waitFor, within } from "storybook/test"

import { DELIVERY_STOP_LABEL } from "@workspace/ui/neuve/shared/delivery"
import type { DeliveryStop } from "@workspace/ui/neuve/shared/delivery"
import { mainColumn } from "@workspace/ui/neuve/story-kit/dom"

/** Layers fade in, so an element is visible once its entrance has run. */
export function visible(element: HTMLElement) {
  return waitFor(() => expect(element).toBeVisible(), { timeout: 3000 })
}

/** Resolves after `count` animation frames. */
export async function frames(count = 2) {
  for (let i = 0; i < count; i++)
    await new Promise((resolve) => requestAnimationFrame(resolve))
}

/** Resolves after `ms` milliseconds. */
export function pause(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** A button by its name, once the overlay has placed (shown) it. */
export function placedButton(
  canvasElement: HTMLElement,
  name: string | RegExp
) {
  return waitFor(() => {
    const found = within(canvasElement).getByRole("button", { name })
    expect(found).toBeVisible()
    return found
  })
}

/* ── Keyboard focus ────────────────────────────────────── */

/**
 * The focus token (--nv-focus) as the browser resolves it in this theme, at
 * `at` when given: a [data-surface] scope there (the dock's inverse ring)
 * changes it.
 */
export function focusColor(doc: Document, at?: Element): string {
  const probe = doc.createElement("span")
  const scoped = at
    ? getComputedStyle(at).getPropertyValue("--nv-focus").trim()
    : ""
  probe.style.color = scoped || "var(--nv-focus)"
  doc.body.append(probe)
  const color = getComputedStyle(probe).color
  probe.remove()
  return color
}

/**
 * `:focus-visible` can only match in a document that has focus. A headless
 * page that was never focused (no focus emulation, no trusted input) never
 * shows a ring, so a ring check there is meaningless: fail and say why.
 */
export async function expectDocumentFocus(doc: Document) {
  await expect(
    doc.hasFocus(),
    "The story's document has no focus, so :focus-visible can never match. Run the play in a focused page: Storybook's own frame, or a headless runner with focus emulation (CDP Emulation.setFocusEmulationEnabled)."
  ).toBe(true)
}

/**
 * Keyboard focus on `element` shows its ring: the document has focus, the
 * element has focus and matches :focus-visible, and (unless `ring: false`,
 * for controls whose ring is drawn by a child) it draws the house ring, a
 * solid 2px outline in --nv-focus as its own surface scope resolves it. The
 * colour is awaited, as controls with colour transitions ease their outline
 * in.
 */
export async function expectFocusVisible(
  element: HTMLElement,
  { ring = true }: { ring?: boolean } = {}
) {
  await expectDocumentFocus(element.ownerDocument)
  await expect(element).toHaveFocus()
  await expect(element.matches(":focus-visible")).toBe(true)
  if (!ring) return
  const style = getComputedStyle(element)
  await expect(style.outlineStyle).toBe("solid")
  await expect(style.outlineWidth).toBe("2px")
  // The ring in the element's own scope (inverse on the dock).
  const color = focusColor(element.ownerDocument, element)
  await waitFor(() => expect(style.outlineColor).toBe(color))
}

/**
 * Tab until `target` has focus, then assert its ring is the house ring
 * (`expectFocusVisible`, which first requires a focused document). A class
 * list can carry `focus-visible:outline-2` and still draw nothing: Tailwind
 * v4's `outline-none` and `outline-hidden` set `--tw-outline-style: none`,
 * which the focus-visible width then reads as its style.
 */
export async function expectTabFocusRing(
  keyboard: { tab: () => Promise<void> },
  target: HTMLElement,
  maxTabs = 40
): Promise<void> {
  const doc = target.ownerDocument
  // :focus never matches while the story frame itself lacks focus.
  doc.defaultView?.focus()
  for (let tabs = 0; tabs < maxTabs && doc.activeElement !== target; tabs++)
    await keyboard.tab()
  await expect(target).toHaveFocus()
  await expectFocusVisible(target)
}

/**
 * Focus moved to `element` by a pointer (or script) shows no ring. Checked
 * in a focused document only, where a ring could show: an unfocused one
 * would pass vacuously.
 */
export async function expectNoFocusRing(element: HTMLElement) {
  await expectDocumentFocus(element.ownerDocument)
  await expect(element).toHaveFocus()
  await expect(element.matches(":focus-visible")).toBe(false)
}

/* ── Review delivery ───────────────────────────────────── */

const DIAL_NAME = "Review delivery"

function dialElement(canvasElement: HTMLElement) {
  return within(canvasElement.ownerDocument.body).queryByRole("radiogroup", {
    name: DIAL_NAME,
  })
}

/** The title glyph that opens the dial, when the desk has one. */
export function deliveryTrigger(canvasElement: HTMLElement) {
  return (
    canvasElement.querySelector<HTMLElement>("[data-delivery-trigger]") ??
    within(canvasElement).queryByRole("button", {
      name: /^Review delivery\b/,
    })
  )
}

/**
 * The desk's delivery dial (radiogroup "Review delivery"), opening the title
 * glyph first when the dial sits behind one.
 */
export async function dialGroup(canvasElement: HTMLElement) {
  if (!dialElement(canvasElement)) {
    const trigger = deliveryTrigger(canvasElement)
    if (trigger) await userEvent.click(trigger)
  }
  const group = await waitFor(() => {
    const found = dialElement(canvasElement)
    expect(found).toBeTruthy()
    return found!
  })
  return within(group)
}

/** A stop's radio in the dial (opened if needed), e.g. to assert it's checked. */
export async function stopRadio(
  canvasElement: HTMLElement,
  stop: DeliveryStop
) {
  return (await dialGroup(canvasElement)).getByLabelText(
    DELIVERY_STOP_LABEL[stop]
  )
}

/** Picks a stop on the dial; the dial stays open (it never closes itself). */
export async function chooseStop(
  canvasElement: HTMLElement,
  stop: DeliveryStop
) {
  const radio = await stopRadio(canvasElement, stop)
  await userEvent.click(radio)
  return radio
}

/**
 * Closes a glyph-opened dial (its trigger again) and waits for its exit.
 * Does nothing while the dial is always visible.
 */
export async function closeDial(canvasElement: HTMLElement) {
  const trigger = deliveryTrigger(canvasElement)
  if (!trigger || trigger.getAttribute("aria-expanded") !== "true") return
  await userEvent.click(trigger)
  await waitFor(() => expect(dialElement(canvasElement)).toBeNull())
}

/* ── Reading the desk ──────────────────────────────────── */

/**
 * The review is said once in the column (Option A): exactly one innermost
 * element of the main column matches `words`.
 */
export async function saidOnce(canvasElement: HTMLElement, words: RegExp) {
  const column = mainColumn(canvasElement)
  const matches = Array.from(
    column.querySelectorAll<HTMLElement>("p, span, h2, h3, li")
  ).filter(
    (element) =>
      words.test(element.textContent) &&
      !Array.from(element.children).some((child) =>
        words.test(child.textContent)
      )
  )
  await expect(matches).toHaveLength(1)
}

/**
 * The open tooltip's visible text (Radix also renders a hidden copy, and a
 * closing tooltip lingers while it fades).
 */
export function tooltipText(doc: Document) {
  return waitFor(() => {
    const content = doc.querySelector<HTMLElement>(
      "[data-slot='tooltip-content'][data-state$='open']"
    )
    expect(content).toBeVisible()
    return content!.textContent
  })
}

/* ── Input ─────────────────────────────────────────────── */

/**
 * A press and release at an element's point, as a hand clicks it: pressed
 * and released apart (one pointer session), on the topmost element there,
 * inside a diff's shadow root too.
 */
export async function clickAt(element: HTMLElement) {
  // The first line box: a phrase that wraps spans two lines.
  const box = element.getClientRects()[0] ?? element.getBoundingClientRect()
  const x = box.left + Math.min(12, box.width / 2)
  const y = box.top + box.height / 2
  let target = element.ownerDocument.elementFromPoint(x, y) as HTMLElement
  while (target.shadowRoot) {
    const inner = target.shadowRoot.elementFromPoint(x, y) as HTMLElement | null
    if (!inner || inner === target) break
    target = inner
  }
  const coords = { clientX: x, clientY: y }
  const user = userEvent.setup()
  await user.pointer({ keys: "[MouseLeft>]", target, coords })
  await pause(120)
  await user.pointer({ keys: "[/MouseLeft]", target, coords })
}

/** Tab until `target` has focus (real keyboard focus, focus-visible). */
export async function tabTo(
  target: HTMLElement,
  keyboard: { tab: () => Promise<void> } = userEvent
) {
  for (let i = 0; i < 40 && target.ownerDocument.activeElement !== target; i++)
    await keyboard.tab()
  await expect(target).toHaveFocus()
}

/* ── Layout stability ──────────────────────────────────── */

/** The Layout Instability API's entry (not yet in TypeScript's DOM types). */
interface LayoutShift extends PerformanceEntry {
  value: number
  sources: ReadonlyArray<{
    node: Node | null
    previousRect: DOMRectReadOnly
    currentRect: DOMRectReadOnly
  }>
}

function shiftedNode(node: Node | null) {
  const element = node instanceof Element ? node : node?.parentElement
  if (!element) return "a removed node"
  const text = element.textContent.trim().replace(/\s+/g, " ")
  return `<${element.localName}> "${text.slice(0, 48)}"`
}

/**
 * Runs `action` and fails if it moved anything else on the page: every
 * layout-shift entry counts, those right after input too (the CLS score
 * excuses them; the desk does not). Interacting with one part of the desk
 * never moves the parts around it. `ignoring` names that part when it may
 * move inside itself (a composer growing with its text): shifts of nodes in
 * it don't count, and the play asserts its frame instead.
 */
export async function expectNoLayoutShift(
  action: () => Promise<unknown>,
  { ignoring }: { ignoring?: Element } = {}
) {
  const shifts: Array<LayoutShift> = []
  const observer = new PerformanceObserver((list) => {
    shifts.push(...(list.getEntries() as Array<LayoutShift>))
  })
  observer.observe({ type: "layout-shift" })
  await action()
  // Entries arrive after the frame that laid the change out.
  await frames(3)
  await pause(150)
  shifts.push(...(observer.takeRecords() as Array<LayoutShift>))
  observer.disconnect()
  const outside = (node: Node | null) =>
    !ignoring || !node || !ignoring.contains(node)
  const moved = shifts.flatMap((shift) =>
    shift.sources
      .filter((source) => outside(source.node))
      .map(
        (source) =>
          `${shiftedNode(source.node)} moved ${Math.round(source.currentRect.x - source.previousRect.x)}, ${Math.round(source.currentRect.y - source.previousRect.y)}`
      )
  )
  await expect(moved, "Nothing around the interaction moves").toEqual([])
}

/**
 * Runs a typed view transition over the story, as the router does on a
 * navigation, and fails if any transition group shows its old and new
 * snapshots at once at any frame. Without a cross-fade, two snapshots drawn
 * together double every text that changed or moved between them. Nothing
 * changes in the update: every named element is on both sides, which is the
 * case that doubles. Keep it that way: a snapshot that doesn't exist still
 * reads as opacity 1, so a one-sided transition would fail falsely.
 */
export async function expectOneSnapshotAtATime(
  doc: Document,
  types: Array<string>
) {
  const root = doc.documentElement
  const names = [
    "root",
    ...new Set(
      [...doc.querySelectorAll<HTMLElement>("[data-vt]")].map((element) =>
        element.style.getPropertyValue("--vt-name")
      )
    ),
  ]
  const shown = (pseudo: string) =>
    Number(getComputedStyle(root, pseudo).opacity) > 0
  const doubled = new Set<string>()
  let frameCount = 0
  const transition = doc.startViewTransition({ update: () => {}, types })
  await transition.ready
  while (root.matches(":active-view-transition")) {
    for (const name of names)
      if (
        shown(`::view-transition-old(${name})`) &&
        shown(`::view-transition-new(${name})`)
      )
        doubled.add(name)
    frameCount++
    await frames(1)
  }
  await transition.finished
  await expect(frameCount, "The transition ran").toBeGreaterThan(0)
  await expect([...doubled], "No group shows two snapshots at once").toEqual([])
}
