/**
 * Embedded mode's input handling (shared/embedded.ts): when the page counts
 * as embedded, which theme messages it accepts, which Escape presses go to
 * Ace, and the title Ace's tab shows. The boot runs serialized in <head>, so
 * it is also run here from its own source text, as the page runs it.
 */
import { describe, expect, test } from "bun:test"

import {
  EMBED_INIT_SCRIPT,
  aceTitle,
  embeddedBoot,
  escapeLeavesApp,
} from "@workspace/ui/neuve/shared/embedded"
import { THEME_STORAGE_KEY } from "@workspace/ui/neuve/shared/theme"

type Listener = (event: {
  source: unknown
  origin: string
  data: unknown
}) => void

/** A window as the boot sees it: its frame, address, root, storage and messages. */
function fakeWindow({
  origin = "http://ace.test",
  search = "",
  parent,
}: {
  origin?: string
  search?: string
  /** The framing page: same origin, another one (reading it throws), or none. */
  parent?: "same" | "other"
}) {
  const attributes = new Set<string>()
  const classes = new Set<string>()
  const stored = new Map<string, string>()
  const listeners: Array<Listener> = []
  const win = {
    location: { origin, search },
    document: {
      documentElement: {
        setAttribute: (name: string) => attributes.add(name),
        classList: {
          toggle: (name: string, on: boolean) =>
            on ? classes.add(name) : classes.delete(name),
        },
      },
    },
    localStorage: {
      setItem: (key: string, value: string) => stored.set(key, value),
    },
    addEventListener: (type: string, listener: Listener) => {
      if (type === "message") listeners.push(listener)
    },
  } as Record<string, unknown>
  const framer =
    parent === "same"
      ? { location: { origin } }
      : parent === "other"
        ? {
            get location(): never {
              throw new DOMException("Blocked a frame", "SecurityError")
            },
          }
        : win
  win.parent = framer
  const send = (data: unknown, from: unknown = framer, at = origin) =>
    listeners.forEach((listener) =>
      listener({ source: from, origin: at, data })
    )
  return { win: win as unknown as Window, attributes, classes, stored, send }
}

const KEYS = {
  attribute: "data-embedded",
  param: "embedded",
  source: "neuve-review",
  storageKey: THEME_STORAGE_KEY,
}

describe("embeddedBoot", () => {
  test("framed by a page of the same origin, the page is embedded", () => {
    const page = fakeWindow({ parent: "same" })
    embeddedBoot(page.win, KEYS)
    expect(page.attributes.has("data-embedded")).toBe(true)
  })

  test("framed by another origin, it is not", () => {
    const page = fakeWindow({ parent: "other" })
    embeddedBoot(page.win, KEYS)
    expect(page.attributes.size).toBe(0)
  })

  test("on its own address it is not, unless asked by ?embedded=1 or ?embedded", () => {
    for (const [search, embedded] of [
      ["", false],
      ["?embedded=0", false],
      ["?embedded=yes", false],
      ["?embedded=1", true],
      ["?embedded", true],
    ] as const) {
      const page = fakeWindow({ search })
      embeddedBoot(page.win, KEYS)
      expect(page.attributes.has("data-embedded")).toBe(embedded)
    }
  })

  test("Ace's theme applies and is stored", () => {
    const page = fakeWindow({ parent: "same" })
    embeddedBoot(page.win, KEYS)
    page.send({ source: "neuve-review", type: "theme", theme: "dark" })
    expect(page.classes.has("dark")).toBe(true)
    expect(page.stored.get(THEME_STORAGE_KEY)).toBe("dark")
    page.send({ source: "neuve-review", type: "theme", theme: "light" })
    expect(page.classes.has("dark")).toBe(false)
    expect(page.stored.get(THEME_STORAGE_KEY)).toBe("light")
  })

  test("a theme from anyone but the framing page, or malformed, changes nothing", () => {
    const page = fakeWindow({ parent: "same" })
    embeddedBoot(page.win, KEYS)
    const theme = { source: "neuve-review", type: "theme", theme: "dark" }
    page.send(theme, {}) // another window
    page.send(theme, undefined, "http://elsewhere.test") // another origin
    for (const data of [
      null,
      "dark",
      { type: "theme", theme: "dark" },
      { source: "neuve-review", type: "title", theme: "dark" },
      { source: "neuve-review", type: "theme", theme: "sepia" },
    ])
      page.send(data)
    expect(page.classes.size).toBe(0)
    expect(page.stored.size).toBe(0)
  })

  test("a page that is not embedded never listens", () => {
    const page = fakeWindow({})
    embeddedBoot(page.win, KEYS)
    page.send({ source: "neuve-review", type: "theme", theme: "dark" })
    expect(page.classes.size).toBe(0)
  })

  test("the inline script runs the boot from its own text alone", () => {
    const page = fakeWindow({ parent: "same" })
    new Function("window", EMBED_INIT_SCRIPT)(page.win)
    expect(page.attributes.has("data-embedded")).toBe(true)
    page.send({ source: "neuve-review", type: "theme", theme: "dark" })
    expect(page.classes.has("dark")).toBe(true)
  })
})

describe("escapeLeavesApp", () => {
  const press = (overrides: Partial<KeyboardEvent> = {}) => ({
    key: "Escape",
    defaultPrevented: false,
    isComposing: false,
    ...overrides,
  })

  test("Escape that nothing claimed goes to Ace", () => {
    expect(escapeLeavesApp(press(), false)).toBe(true)
  })

  test("a layer that closed claims it", () => {
    expect(escapeLeavesApp(press({ defaultPrevented: true }), false)).toBe(
      false
    )
  })

  test("an open modal dialog closes first", () => {
    expect(escapeLeavesApp(press(), true)).toBe(false)
  })

  test("Escape ending a composition, and other keys, stay", () => {
    expect(escapeLeavesApp(press({ isComposing: true }), false)).toBe(false)
    expect(escapeLeavesApp(press({ key: "Enter" }), false)).toBe(false)
  })
})

describe("aceTitle", () => {
  test("drops the app's name, which Ace shows", () => {
    expect(aceTitle("Revoke cuts off open sessions · Neuve")).toBe(
      "Revoke cuts off open sessions"
    )
    expect(aceTitle("Review delivery · Settings · Neuve")).toBe(
      "Review delivery · Settings"
    )
  })

  test("an empty title still names the tab", () => {
    expect(aceTitle("Neuve")).toBe("Neuve")
    expect(aceTitle("")).toBe("Review")
  })
})
