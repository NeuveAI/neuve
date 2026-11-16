// Why (12 November 2026): a newer review that replaces the one on screen must not move the reader
// when the live stream reloads the page, and every other load must still follow the work (an old
// link, the first load, the server's render, a navigation, back and forward, a hard refresh). The
// router's cause cannot tell these apart on its own, so the root marks its reload; these tests pin
// the decision and that the mark lasts exactly as long as the reload, however it ends.
import { afterEach, expect, test } from "bun:test"

import { keepsPage, liveReload, liveReloadInFlight } from "./live-reload"

const hadWindow = "window" in globalThis
afterEach(() => {
  if (!hadWindow) delete (globalThis as { window?: unknown }).window
})

/** As in the browser: the flag is read only where `window` exists. */
const inBrowser = () => {
  ;(globalThis as { window?: unknown }).window = globalThis
}

test("only the live reload, in the browser, of a route that stays matched keeps the page", () => {
  const causes = ["preload", "enter", "stay"] as const
  for (const client of [true, false])
    for (const live of [true, false])
      for (const cause of causes)
        expect(keepsPage({ client, liveReload: live, cause })).toBe(
          client && live && cause === "stay"
        )
})

test("the live reload's mark is set while it runs and cleared when it settles, on failure too", async () => {
  inBrowser()
  expect(liveReloadInFlight()).toBe(false)
  let during = false
  await liveReload(async () => {
    during = liveReloadInFlight()
  })
  expect(during).toBe(true)
  expect(liveReloadInFlight()).toBe(false)

  // A failed reload, and one that throws before it awaits anything.
  await expect(
    liveReload(() => Promise.reject(new Error("reload failed")))
  ).rejects.toThrow("reload failed")
  expect(liveReloadInFlight()).toBe(false)
  await expect(
    liveReload(() => {
      throw new Error("thrown at once")
    })
  ).rejects.toThrow("thrown at once")
  expect(liveReloadInFlight()).toBe(false)

  // Two that overlap: set until the last one settles.
  let release: () => void = () => undefined
  const first = liveReload(
    () => new Promise<void>((resolve) => (release = resolve))
  )
  await liveReload(async () => undefined)
  expect(liveReloadInFlight()).toBe(true)
  release()
  await first
  expect(liveReloadInFlight()).toBe(false)
})

test("a server render never reads the mark set", async () => {
  delete (globalThis as { window?: unknown }).window
  await liveReload(async () => {
    expect(liveReloadInFlight()).toBe(false)
  })
})
