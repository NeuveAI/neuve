import { expect, test } from "bun:test"
import { createStore } from "jotai"
import { createElement } from "react"
import { renderToString } from "react-dom/server"

import {
  DEFAULT_DELIVERY_SETTINGS,
  DELIVERY_SETTINGS_STORAGE_KEY,
  DeliverySettingsAtomProvider,
  deliverySettingsAtom,
  useDeliverySettingsAtom,
} from "@workspace/ui/neuve/shared/delivery"
import { sampleDeliverySettings } from "@workspace/ui/fixtures/delivery-languages.fixtures"

import {
  MOCK_DELIVERY_SETTINGS_STORAGE_KEY,
  mockDeliverySettingsAtom,
} from "./mock-delivery-settings"

/** Renders a probe and reports whether it read the real or the mock atom. */
function readsAtom(wrapInMock: boolean): string {
  function Probe() {
    const source = useDeliverySettingsAtom()
    return source === deliverySettingsAtom
      ? "real"
      : source === mockDeliverySettingsAtom
        ? "mock"
        : "other"
  }
  const probe = createElement(Probe)
  return renderToString(
    wrapInMock
      ? createElement(
          DeliverySettingsAtomProvider,
          { value: mockDeliverySettingsAtom },
          probe
        )
      : probe
  )
}

test("the real setting starts with every language following the default", () => {
  expect(DEFAULT_DELIVERY_SETTINGS.byLanguage).toEqual({})
})

test("the sample setting lives under its own storage key", () => {
  expect(MOCK_DELIVERY_SETTINGS_STORAGE_KEY).not.toBe(
    DELIVERY_SETTINGS_STORAGE_KEY
  )
  expect(mockDeliverySettingsAtom).not.toBe(deliverySettingsAtom)
})

test("the sample atom starts from the sample refinements", () => {
  // An unmounted store holds the initial value (storage is read on mount).
  const store = createStore()
  expect(store.get(mockDeliverySettingsAtom)).toEqual(sampleDeliverySettings)
  expect(store.get(deliverySettingsAtom)).toEqual(DEFAULT_DELIVERY_SETTINGS)
})

test("pages outside /mock read the real setting; the /mock layout provides the sample", () => {
  expect(readsAtom(false)).toBe("real")
  expect(readsAtom(true)).toBe("mock")
})
