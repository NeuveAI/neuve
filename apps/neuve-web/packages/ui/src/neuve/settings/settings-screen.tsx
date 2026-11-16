import { Provider, useAtomValue } from "jotai"
import type { AccountStatus } from "@neuve/runtime/status"
import { accountsAtom } from "./accounts-atoms"
import { AccountsSection } from "./accounts-section"
import { accountsCopy } from "./accounts-copy"
import { useHydrateAtoms } from "jotai/utils"
import { MotionConfig } from "motion/react"

import { agentsHydration } from "@workspace/ui/neuve/agents/atoms"
import { AppHeader } from "@workspace/ui/neuve/shared/app-header"
import { NeuveLink } from "@workspace/ui/neuve/shared/nav-link"
import { regionTransition } from "@workspace/ui/neuve/shared/view-transitions"
import type { DeliveryLanguageInfo } from "@workspace/ui/neuve/shared/delivery"
import { previewTargetAtom } from "@workspace/ui/neuve/settings/atoms"
import type { PreviewTarget } from "@workspace/ui/neuve/settings/atoms"
import { ReviewDeliverySection } from "@workspace/ui/neuve/settings/review-delivery-section"
import { FeedbackSection } from "@workspace/ui/neuve/settings/feedback-section"

export interface SettingsScreenProps {
  /** The workspace's languages (provider data; a fixture today). */
  languages: ReadonlyArray<DeliveryLanguageInfo>
  /** The list is sample data, not languages the workspace reported. */
  sampleLanguages: boolean
  /** Stories: the row the preview starts on (the workspace default otherwise). */
  initialPreview?: PreviewTarget
  accounts?: readonly AccountStatus[]
  /** Fixture routes never follow the live stream. */
  fixtureAccounts?: boolean
}

const NO_AGENTS = { agents: [], configured: [], connections: {} }

function Hydrate({
  initialPreview = { kind: "workspace" },
  children,
}: Pick<SettingsScreenProps, "initialPreview"> & {
  children: React.ReactNode
}) {
  useHydrateAtoms(agentsHydration(NO_AGENTS))
  useHydrateAtoms([[previewTargetAtom, initialPreview]] as const)
  return children
}

/**
 * Workspace settings: "Review delivery", then "Feedback" (the owner's
 * instrument, 10.100); the section list above the content links both. The setting is the
 * one the contract provides (`useDeliverySettingsAtom`): the real setting by
 * default, the sample under the `/mock` layout and in stories.
 */
export function SettingsScreen({
  languages,
  sampleLanguages,
  initialPreview,
  accounts = [],
  fixtureAccounts = false,
}: SettingsScreenProps) {
  const pushed = useAtomValue(accountsAtom)
  const shownAccounts = fixtureAccounts ? accounts : (pushed ?? accounts)
  return (
    <Provider>
      <MotionConfig reducedMotion="user">
        <Hydrate initialPreview={initialPreview}>
          <div className="min-h-svh bg-paper font-sans text-sm text-ink">
            <AppHeader current="settings" />
            <main
              {...regionTransition("settings", 1)}
              className="mx-auto box-border flex max-w-[1240px] content-fade flex-col gap-2 px-4 pt-10 pb-16 sm:px-6 sm:pt-12"
            >
              <h1 className="sr-only">Workspace settings</h1>
              <nav
                aria-label="Settings sections"
                className="flex flex-wrap items-baseline gap-x-2 label-mono"
              >
                <span>Workspace settings</span>
                <span aria-hidden="true">·</span>
                <ul className="m-0 flex list-none flex-wrap gap-x-3 p-0">
                  <li>
                    <NeuveLink
                      destination={{ to: "settings" }}
                      aria-current="page"
                      className="rounded-[4px] text-ink-muted no-underline hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus focus-visible:outline-solid"
                    >
                      Review delivery
                    </NeuveLink>
                  </li>
                  <li>
                    <a
                      href="#feedback"
                      className="rounded-[4px] text-ink-muted no-underline hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus focus-visible:outline-solid"
                    >
                      Feedback
                    </a>
                  </li>
                  <li>
                    <a
                      href="#accounts"
                      className="rounded-[4px] text-ink-muted no-underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus focus-visible:outline-solid pointer-fine:hover:text-ink"
                    >
                      {accountsCopy.title}
                    </a>
                  </li>
                </ul>
              </nav>
              <ReviewDeliverySection
                languages={languages}
                sampleLanguages={sampleLanguages}
              />
              <div className="mt-12">
                <FeedbackSection />
              </div>
              <div className="mt-12">
                <AccountsSection accounts={shownAccounts} />
              </div>
            </main>
          </div>
        </Hydrate>
      </MotionConfig>
    </Provider>
  )
}
