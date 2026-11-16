import { Outlet, createFileRoute } from "@tanstack/react-router"

import { NeuveModeProvider } from "@workspace/ui/neuve/shared/nav-link"
import { DeliverySettingsAtomProvider } from "@workspace/ui/neuve/shared/delivery"
import { FeedbackSettingAtomProvider } from "@workspace/ui/neuve/review-desk/feedback/atoms"

import { mockDeliverySettingsAtom } from "@/components/mock-delivery-settings"
import { mockFeedbackSettingAtom } from "@/components/mock-feedback-setting"

/**
 * Fixture-backed sample pages. Everything under `/mock` renders in mock
 * mode, so every link (header, rail, back, Start review, What changed)
 * stays under `/mock`. The review delivery setting is the sample one, so
 * the mock settings page and the mock desk share it and the real setting
 * never sees sample refinements. The feedback setting is a sample too.
 */
export const Route = createFileRoute("/mock")({
  component: MockLayout,
})

function MockLayout() {
  return (
    <NeuveModeProvider mode="mock">
      <DeliverySettingsAtomProvider value={mockDeliverySettingsAtom}>
        <FeedbackSettingAtomProvider value={mockFeedbackSettingAtom}>
          <Outlet />
        </FeedbackSettingAtomProvider>
      </DeliverySettingsAtomProvider>
    </NeuveModeProvider>
  )
}
