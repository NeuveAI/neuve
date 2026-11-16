import { accountFixtures } from "@workspace/ui/fixtures/accounts.fixtures"
import { createFileRoute } from "@tanstack/react-router"

import { sampleWorkspaceLanguages } from "@workspace/ui/fixtures/delivery-languages.fixtures"
import { SettingsScreen } from "@workspace/ui/neuve/settings/settings-screen"

/**
 * Sample settings page (fixtures). The `/mock` layout provides the sample
 * setting (its own storage key), shared with the mock desk and apart from
 * the real `/settings`.
 */
export const Route = createFileRoute("/mock/settings")({
  loader: () => ({
    languages: sampleWorkspaceLanguages,
    accounts: accountFixtures.severalAccounts,
  }),
  head: () => ({
    meta: [{ title: "Review delivery (sample) · Settings · Neuve" }],
  }),
  component: MockSettingsRoute,
})

function MockSettingsRoute() {
  const { languages, accounts } = Route.useLoaderData()
  return (
    <SettingsScreen
      languages={languages}
      sampleLanguages
      accounts={accounts}
      fixtureAccounts
    />
  )
}
