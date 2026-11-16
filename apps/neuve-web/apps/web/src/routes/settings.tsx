import { loadAccounts } from "@/server/accounts"
import { createFileRoute } from "@tanstack/react-router"

import { sampleWorkspaceLanguages } from "@workspace/ui/fixtures/delivery-languages.fixtures"
import { SettingsScreen } from "@workspace/ui/neuve/settings/settings-screen"

/**
 * Workspace settings: Review delivery. The setting is a sample stored in
 * this browser (`deliverySettingsAtom`, every language following the default
 * until set). The language list stands in for the languages a provider
 * observes in the workspace until the backend carries them.
 */
export const Route = createFileRoute("/settings")({
  loader: async () => ({
    languages: sampleWorkspaceLanguages,
    accounts: await loadAccounts(),
  }),
  head: () => ({ meta: [{ title: "Review delivery · Settings · Neuve" }] }),
  component: SettingsRoute,
})

function SettingsRoute() {
  const { languages, accounts } = Route.useLoaderData()
  // The list is the sample fixture until the workspace reports its own.
  return (
    <SettingsScreen languages={languages} sampleLanguages accounts={accounts} />
  )
}
