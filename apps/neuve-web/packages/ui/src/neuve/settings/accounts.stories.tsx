import type { Meta, StoryObj } from "@storybook/react-vite"
import { Provider } from "jotai"
import { expect } from "storybook/test"
import { accountFixtures } from "@workspace/ui/fixtures/accounts.fixtures"
import { AccountsSection } from "./accounts-section"

const meta = {
  title: "Settings/Accounts",
  component: AccountsSection,
  args: { accounts: accountFixtures.signedIn },
  decorators: [
    (Story) => (
      <Provider>
        <main className="min-h-svh bg-paper p-6 font-sans text-ink">
          <Story />
        </main>
      </Provider>
    ),
  ],
} satisfies Meta<typeof AccountsSection>
export default meta
type Story = StoryObj<typeof meta>

const claudeCommand =
  "CLAUDE_CONFIG_DIR='/tmp/Neuve'\\''s work account' claude auth login"

/** Every state proves its copy and the absence of any credential input. */
function state(
  fixture: keyof typeof accountFixtures,
  descriptions: string[],
  commands: string[] = [],
  limits: RegExp[] = []
): Story {
  return {
    args: { accounts: accountFixtures[fixture] },
    play: async ({ canvas, canvasElement }) => {
      for (const description of descriptions)
        await expect(
          canvas.getByText(description, { exact: true })
        ).toBeInTheDocument()
      const section = canvasElement.querySelector("#accounts")!
      await expect(canvas.queryByRole("textbox")).not.toBeInTheDocument()
      await expect(section.querySelector('input[type="password"]')).toBeNull()
      await expect(section.querySelector("input")).toBeNull()
      const rendered = Array.from(
        section.querySelectorAll("code"),
        (code) => code.textContent
      )
      await expect(rendered).toEqual(commands)
      for (const limit of limits)
        await expect(canvas.getByText(limit)).toBeInTheDocument()
      for (const time of section.querySelectorAll("time"))
        await expect(time.getAttribute("datetime")).toBeTruthy()
    },
  }
}

export const SignedIn = state("signedIn", [
  "Signed in as alex@example.com · Max",
])
export const SignedInWithoutDetails = state("signedInWithoutDetails", [
  "Signed in",
])
export const NotSignedIn = state(
  "notSignedIn",
  ["Not signed in"],
  [claudeCommand]
)
export const Rejected = state(
  "rejected",
  ["Claude rejected this sign-in"],
  [claudeCommand]
)
export const RejectedWithoutHint = state("rejectedWithoutHint", [
  "Claude rejected this sign-in",
])
export const NearLimit = state(
  "nearLimit",
  ["Signed in as alex@example.com · Max"],
  [],
  [/5-hour limit: 82% used · resets/]
)
export const LimitReached = state(
  "limitReached",
  ["Signed in as alex@example.com · Max"],
  [],
  [/5-hour limit reached · resets/]
)
export const Unknown = state("unknown", ["Not checked yet"])
export const CheckFailed = state(
  "checkFailed",
  ["Couldn't check this account"],
  [claudeCommand]
)
export const NotInstalled = state("notInstalled", [
  "Claude Code isn't installed",
])
export const NotRegistered = state("notRegistered", [
  "Claude Code isn't set up for Neuve",
])
export const UnsupportedVersion = state("unsupportedVersion", [
  "Claude Code needs a newer version",
])
export const StartFailed = state("startFailed", ["Claude Code couldn't start"])
export const EnvironmentMismatch = state("environmentMismatch", [
  "Signed in through a credential from the environment, not a Claude Code login",
])
export const Chatgpt = state(
  "chatgpt",
  ["Not signed in"],
  ["neuve auth login personal"]
)
export const SettingsHint = state("settingsHint", [
  "Not signed in",
  "Add a key in Settings → Providers in the coding app",
])
export const KeyAccount = state("keyAccount", [
  "Not signed in",
  "Add a key in Settings → Providers in the coding app",
])
export const SeveralAccounts = state(
  "severalAccounts",
  [
    "Signed in as alex@example.com · Max",
    "Not signed in",
    "Signed in · Plus",
    "Signed in",
  ],
  [claudeCommand]
)
