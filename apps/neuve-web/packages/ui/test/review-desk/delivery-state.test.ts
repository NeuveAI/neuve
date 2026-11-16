/**
 * The "Why" disclosure in a human-suggested unit's review card is open per
 * unit (review F5, round 4.3): opening it on one unit never opens it on
 * another, and leaving Guided closes it for that unit only.
 */
import { describe, expect, test } from "bun:test"
import { createStore } from "jotai"

import {
  setUnitDeliveryStopAtom,
  toggleWhyAtom,
  whyOpenAtom,
} from "@workspace/ui/neuve/review-desk/delivery/delivery-state"
import { DEFAULT_DELIVERY_SETTINGS } from "@workspace/ui/neuve/shared/delivery"

const isOpen = (store: ReturnType<typeof createStore>, unitId: string) =>
  store.get(whyOpenAtom)[unitId] ?? false

describe("whyOpenAtom", () => {
  test("opens for one unit only", () => {
    const store = createStore()
    store.set(toggleWhyAtom, "a")
    expect(isOpen(store, "a")).toBe(true)
    expect(isOpen(store, "b")).toBe(false)
    store.set(toggleWhyAtom, "a")
    expect(isOpen(store, "a")).toBe(false)
  })

  test("leaving Guided closes that unit's disclosure only", () => {
    const store = createStore()
    store.set(toggleWhyAtom, "a")
    store.set(toggleWhyAtom, "b")
    store.set(setUnitDeliveryStopAtom, {
      unitId: "a",
      language: undefined,
      stop: "briefed",
      settings: DEFAULT_DELIVERY_SETTINGS,
    })
    expect(isOpen(store, "a")).toBe(false)
    expect(isOpen(store, "b")).toBe(true)
  })
})
