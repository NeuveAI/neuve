/**
 * Embedded mode: the review app shown in Ace's Review tab (decision 12.16).
 *
 * Ace serves the review app under its own origin and frames it; the same app
 * also runs on its own address, where nothing here changes it. Embedded is
 * decided once per page load, before first paint, like the theme: framed by
 * a page of the same origin, or `?embedded=1` for testing. It lives on
 * <html> as `data-embedded`, and the `embedded:` variant (globals.css) styles
 * from it, so server and client markup stay identical.
 *
 * Messages with Ace go through `postMessage` on the shared origin, each
 * tagged `{ source: "neuve-review" }` (Ace with Neuve contract, section 5):
 *
 *   Ace → app   theme      { type: "theme", theme: "light" | "dark" }
 *   app → Ace   escape     Escape with nothing left to close
 *               navigate   { type: "navigate", path } on each route change
 *               title      { type: "title", title } for the tab label
 */
import * as React from "react"

import { THEME_STORAGE_KEY } from "@workspace/ui/neuve/shared/theme"

export const EMBEDDED_ATTRIBUTE = "data-embedded"
/** `?embedded=1` (or a bare `?embedded`) embeds a top-level page, for testing. */
export const EMBEDDED_PARAM = "embedded"
export const MESSAGE_SOURCE = "neuve-review"

export type ReviewAppMessage =
  | { type: "escape" }
  | { type: "navigate"; path: string }
  | { type: "title"; title: string }

interface BootKeys {
  attribute: string
  param: string
  source: string
  storageKey: string
}

/**
 * Runs inline in <head> (EMBED_INIT_SCRIPT), so it must stay self-contained:
 * it is serialized, and reaches nothing outside its own arguments. Marks the
 * page embedded and, from then on, applies Ace's theme as it arrives. The
 * listener is installed here, not after hydration, so a theme Ace sends on
 * the frame's load is never missed. The theme is stored like the toggle's,
 * so the next load paints in it before Ace speaks.
 */
export function embeddedBoot(win: Window, keys: BootKeys): void {
  let framed = false
  try {
    // A frame of another origin throws here: never embedded.
    framed =
      win.parent !== win && win.parent.location.origin === win.location.origin
  } catch {}
  const flag = new URLSearchParams(win.location.search).get(keys.param)
  if (!framed && flag !== "1" && flag !== "") return
  const root = win.document.documentElement
  root.setAttribute(keys.attribute, "")
  win.addEventListener("message", (event) => {
    if (event.source !== win.parent || event.origin !== win.location.origin)
      return
    const data = event.data as Record<string, unknown> | null
    if (typeof data !== "object" || data === null) return
    if (data.source !== keys.source || data.type !== "theme") return
    if (data.theme !== "light" && data.theme !== "dark") return
    root.classList.toggle("dark", data.theme === "dark")
    try {
      win.localStorage.setItem(keys.storageKey, data.theme)
    } catch {}
  })
}

/** Inline, render-blocking script for <head>, after THEME_INIT_SCRIPT. */
export const EMBED_INIT_SCRIPT = `try{(${embeddedBoot.toString()})(window,${JSON.stringify(
  {
    attribute: EMBEDDED_ATTRIBUTE,
    param: EMBEDDED_PARAM,
    source: MESSAGE_SOURCE,
    storageKey: THEME_STORAGE_KEY,
  } satisfies BootKeys
)})}catch(e){}`

/** Whether this page is embedded: its <html> is marked. */
export function isEmbedded(): boolean {
  return document.documentElement.hasAttribute(EMBEDDED_ATTRIBUTE)
}

/**
 * Whether anything on the page is marked embedded: <html> in the app, or a
 * story's wrapper (so a Storybook page shows the embedded states).
 */
export function embeddedOnPage(): boolean {
  return document.querySelector(`[${EMBEDDED_ATTRIBUTE}]`) !== null
}

const unchanging = () => () => {}

/**
 * For the few parts that must render one way or the other rather than be
 * styled (`embedded:`): server render and hydration see `false`, then the
 * page's mark. The mark is set before paint and never changes.
 */
export function useEmbedded(): boolean {
  return React.useSyncExternalStore(unchanging, embeddedOnPage, () => false)
}

/** Sends a message to Ace, on the shared origin only. */
export function postToAce(message: ReviewAppMessage) {
  window.parent.postMessage(
    { source: MESSAGE_SOURCE, ...message },
    window.location.origin
  )
}

/**
 * Whether an Escape press found nothing left to close in the app, so it
 * belongs to Ace. Every layer that closes on Escape claims the press first:
 * Radix layers and the desk's own layers prevent its default, the cards and
 * composers stop it before it reaches the window, and an open modal dialog
 * closes as the press's default action.
 */
export function escapeLeavesApp(
  event: Pick<KeyboardEvent, "key" | "defaultPrevented" | "isComposing">,
  modalOpen: boolean
): boolean {
  return (
    event.key === "Escape" &&
    !event.defaultPrevented &&
    !event.isComposing &&
    !modalOpen
  )
}

/** The page's title for Ace's tab label: without the app's own name, which Ace already shows. */
export function aceTitle(documentTitle: string): string {
  return documentTitle.replace(/\s*·\s*Neuve$/, "").trim() || "Review"
}

/**
 * The app's side of the messages, while embedded: Escape that closes
 * nothing, the route and the page title. `route` changes once per settled
 * navigation; the path sent is the address as Ace serves it, with the base
 * and the search. Nothing runs on the app's own address. The theme is the
 * inline script's (embeddedBoot).
 */
export function useAceBridge(route: string | undefined) {
  // Escape reaches the window after every layer had the press.
  // Effect: subscribes to window keys and the document title (external systems) to message Ace's frame.
  React.useEffect(() => {
    if (!isEmbedded()) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        escapeLeavesApp(event, document.querySelector("dialog:modal") !== null)
      )
        postToAce({ type: "escape" })
    }
    let sent: string | undefined
    const sendTitle = () => {
      const title = aceTitle(document.title)
      if (title === sent) return
      sent = title
      postToAce({ type: "title", title })
    }
    const titles = new MutationObserver(sendTitle)
    titles.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    })
    sendTitle()
    window.addEventListener("keydown", onKeyDown)
    return () => {
      titles.disconnect()
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [])

  // Effect: tells Ace's frame (an external system) each settled route, saved as the tab's state.
  React.useEffect(() => {
    if (route === undefined || !isEmbedded()) return
    const { pathname, search, hash } = window.location
    postToAce({ type: "navigate", path: `${pathname}${search}${hash}` })
  }, [route])
}
