/**
 * The desk never opens a unit on a stop it has nothing for: the reader's
 * default or override is held to the stops the payload offers, the deepest
 * offered stop below it showing, while what the reader stored keeps its
 * value. A payload built without `stops` still offers all four.
 */
import { describe, expect, test } from "bun:test"
import { createStore } from "jotai"

import {
  setUnitDeliveryStopAtom,
  shownDeliveryStop,
} from "@workspace/ui/neuve/review-desk/delivery/delivery-state"
import { unitDeliveryOverrideAtom } from "@workspace/ui/neuve/shared/delivery"
import type {
  DeliveryPayload,
  DeliverySettings,
} from "@workspace/ui/neuve/shared/delivery"

const GUIDED: DeliverySettings = { workspaceDefault: "guided", byLanguage: {} }
const FACTS = [{ kind: "text" as const, text: "Commit retries." }]
const factsOnly: DeliveryPayload = { stops: ["facts"], facts: FACTS }
const factsGuided: DeliveryPayload = {
  stops: ["facts", "guided"],
  facts: FACTS,
}

describe("shownDeliveryStop", () => {
  test("a reader default of Guided shows Facts on a Facts-only unit", () => {
    expect(shownDeliveryStop(GUIDED, {}, "u", factsOnly)).toBe("facts")
  })

  test("a reader default of Guided shows Guided on a Facts-plus-Guided unit", () => {
    expect(shownDeliveryStop(GUIDED, {}, "u", factsGuided)).toBe("guided")
  })

  test("a stop not offered shows the deepest offered stop below it", () => {
    expect(
      shownDeliveryStop(GUIDED, { u: "explained" }, "u", factsGuided)
    ).toBe("facts")
    expect(
      shownDeliveryStop(GUIDED, {}, "u", {
        stops: ["facts", "briefed", "explained"],
        facts: FACTS,
      })
    ).toBe("explained")
  })

  test("a payload without stops offers all four", () => {
    expect(shownDeliveryStop(GUIDED, {}, "u", { facts: FACTS })).toBe("guided")
  })
})

describe("setUnitDeliveryStopAtom", () => {
  test("picking the stop a unit shows for the setting stores no override", () => {
    const store = createStore()
    store.set(setUnitDeliveryStopAtom, {
      unitId: "u",
      language: undefined,
      stop: "facts",
      settings: GUIDED,
      offered: factsOnly.stops,
    })
    expect(store.get(unitDeliveryOverrideAtom)).toEqual({})
  })

  test("an override the reader set is kept while a unit shows less", () => {
    const store = createStore()
    const settings: DeliverySettings = {
      workspaceDefault: "facts",
      byLanguage: {},
    }
    store.set(setUnitDeliveryStopAtom, {
      unitId: "u",
      language: undefined,
      stop: "guided",
      settings,
    })
    const overrides = store.get(unitDeliveryOverrideAtom)
    expect(overrides).toEqual({ u: "guided" })
    // Facts-only data for the same unit shows Facts; once the unit offers
    // Guided, the same stored override opens it there again.
    expect(shownDeliveryStop(settings, overrides, "u", factsOnly)).toBe("facts")
    expect(shownDeliveryStop(settings, overrides, "u", factsGuided)).toBe(
      "guided"
    )
  })
})
