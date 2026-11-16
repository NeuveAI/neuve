import { atomWithStorage } from "jotai/utils"

import { deliverySettingsStorage } from "@workspace/ui/neuve/shared/delivery"
import type { DeliverySettingsAtom } from "@workspace/ui/neuve/shared/delivery"

import { sampleDeliverySettings } from "@workspace/ui/fixtures/delivery-languages.fixtures"

/**
 * The review delivery setting for `/mock` pages, provided by the `/mock`
 * layout: sample refinements (Go and HCL refined) under their own
 * browser-storage key, so the sample never reaches the real setting that
 * `/settings` reads (`deliverySettingsAtom`, which starts with every language
 * following the default).
 */
export const MOCK_DELIVERY_SETTINGS_STORAGE_KEY =
  "neuve.review-delivery.mock.v1"

export const mockDeliverySettingsAtom: DeliverySettingsAtom = atomWithStorage(
  MOCK_DELIVERY_SETTINGS_STORAGE_KEY,
  sampleDeliverySettings,
  deliverySettingsStorage
)
