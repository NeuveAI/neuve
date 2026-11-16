/**
 * Story kit, the review-delivery workspace setting (stories only; never
 * imported by product code).
 *
 * Stories read an in-memory setting, fresh per mounted story (never the one
 * stored in this browser), or a storage-backed atom they name.
 */
import * as React from "react"
import { atom } from "jotai"
import type { Decorator } from "@storybook/react-vite"

import { sampleDeliverySettings } from "@workspace/ui/fixtures/delivery-languages.fixtures"
import { DeliverySettingsAtomProvider } from "@workspace/ui/neuve/shared/delivery"
import type {
  DeliverySettings,
  DeliverySettingsAtom,
} from "@workspace/ui/neuve/shared/delivery"

/**
 * Provides a fresh in-memory settings atom per mount through the contract's
 * Provider (as the `/mock` layout does), or `source` when given.
 */
export function WithDeliverySettings({
  settings = sampleDeliverySettings,
  source,
  children,
}: {
  settings?: DeliverySettings
  /** A storage-backed atom to provide instead of an in-memory one. */
  source?: DeliverySettingsAtom
  children: React.ReactNode
}) {
  const memoryAtom = React.useMemo(() => atom(settings), [settings])
  return (
    <DeliverySettingsAtomProvider value={source ?? memoryAtom}>
      {children}
    </DeliverySettingsAtomProvider>
  )
}

/**
 * Story decorator: the workspace setting the stories read. In memory and
 * seeded from the sample (Go refined to Explained) unless `settings` or a
 * storage-backed `source` is given.
 */
export function withDeliverySettings(
  settings: DeliverySettings = sampleDeliverySettings,
  { source }: { source?: DeliverySettingsAtom } = {}
): Decorator {
  return (Story) => (
    <WithDeliverySettings settings={settings} source={source}>
      <Story />
    </WithDeliverySettings>
  )
}
