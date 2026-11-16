import type { Meta, StoryObj } from "@storybook/react-vite"
import { atomWithStorage } from "jotai/utils"
import { expect, waitFor, within } from "storybook/test"

import {
  sampleDeliverySettings,
  sampleWorkspaceLanguages,
} from "@workspace/ui/fixtures/delivery-languages.fixtures"
import { DEFAULT_DELIVERY_SETTINGS } from "@workspace/ui/neuve/shared/delivery"
import type {
  DeliverySettings,
  DeliverySettingsAtom,
  DeliveryStop,
} from "@workspace/ui/neuve/shared/delivery"
import { SettingsScreen } from "@workspace/ui/neuve/settings/settings-screen"
import { expectTabFocusRing } from "@workspace/ui/neuve/story-kit/play"
import { WithDeliverySettings } from "@workspace/ui/neuve/story-kit/settings"

/** Sample refinements (Go and HCL refined) with the given default. */
function sampleSettings(
  workspaceDefault: DeliveryStop = "briefed"
): DeliverySettings {
  return { ...sampleDeliverySettings, workspaceDefault }
}

const SAMPLE = sampleSettings()

const meta = {
  title: "Settings/Review delivery",
  component: SettingsScreen,
  args: { languages: sampleWorkspaceLanguages, sampleLanguages: true },
  // A fresh in-memory setting per story (the kit's), or the storage-backed
  // atom a story names; `parameters.settings` seeds the in-memory one.
  decorators: [
    (Story, { parameters }) => (
      <WithDeliverySettings
        settings={
          (parameters.settings as DeliverySettings | undefined) ?? SAMPLE
        }
        source={parameters.settingsAtom as DeliverySettingsAtom | undefined}
      >
        <Story />
      </WithDeliverySettings>
    ),
  ],
  parameters: {
    viewport: {
      options: {
        phone375: {
          name: "Phone 375",
          styles: { width: "375px", height: "812px" },
          type: "mobile",
        },
      },
    },
  },
} satisfies Meta<typeof SettingsScreen>

export default meta
type Story = StoryObj<typeof meta>

/**
 * The page with the sample refinements. Move the main dial or a language
 * row and watch the preview's layers open and close.
 */
export const Default: Story = {
  play: async ({ canvas, userEvent }) => {
    const preview = within(
      canvas.getByRole("complementary", { name: "Preview" })
    )
    await expect(canvas.getByText("2 of 4 refined")).toBeInTheDocument()
    await expect(
      preview.getByText("Workspace default · Briefed")
    ).toBeInTheDocument()
    // The main dial sets the workspace default and previews it.
    await userEvent.click(
      canvas.getByRole("radio", { name: "Guided", description: /No code/ })
    )
    await waitFor(() =>
      expect(
        preview.getByText("Workspace default · Guided")
      ).toBeInTheDocument()
    )
  },
}

export const Dark: Story = {
  globals: { theme: "dark" },
}

/** Not sample data: the copy drops the sample-languages line. */
export const ReportedLanguages: Story = {
  args: { sampleLanguages: false },
  play: async ({ canvas }) => {
    await expect(
      canvas.getByText(
        "Each language follows the workspace default until you set it."
      )
    ).toBeInTheDocument()
  },
}

/** Keyboard focus on the settings section link draws the focus ring. */
export const SectionLinkFocusRing: Story = {
  play: async ({ canvas, userEvent }) => {
    await expectTabFocusRing(
      userEvent,
      canvas.getByRole("link", { name: "Review delivery" })
    )
  },
}

/** Keyboard focus on a language row's preview button draws the focus ring. */
export const LanguageRowFocusRing: Story = {
  play: async ({ canvas, userEvent }) => {
    await expectTabFocusRing(
      userEvent,
      canvas.getByRole("button", { name: "Preview Go" })
    )
  },
}

/** Phone width: the large dial goes 2×2 and the preview stacks below. */
export const Phone: Story = {
  globals: { viewport: { value: "phone375", isRotated: false } },
}

export const PhoneDark: Story = {
  globals: {
    theme: "dark",
    viewport: { value: "phone375", isRotated: false },
  },
}

/** Each stop of the workspace default, as the preview shows it. */
export const Facts: Story = {
  parameters: { settings: sampleSettings("facts") },
}
export const Briefed: Story = {
  parameters: { settings: sampleSettings("briefed") },
}
export const Explained: Story = {
  parameters: { settings: sampleSettings("explained") },
}
/** Guided: the code block gives way to "Done when" and the suggested review. */
export const Guided: Story = {
  parameters: { settings: sampleSettings("guided") },
}

/** Previewing a refined language (Go at Explained). */
export const PreviewingGo: Story = {
  args: { initialPreview: { kind: "language", id: "go" } },
}

/**
 * Language rows: refine SQL, then reset it. Choosing the default's stop on a
 * row returns it to "Follows default".
 */
export const RefineAndReset: Story = {
  play: async ({ canvas, userEvent }) => {
    const preview = within(
      canvas.getByRole("complementary", { name: "Preview" })
    )
    const sql = within(canvas.getByRole("radiogroup", { name: "SQL delivery" }))
    await userEvent.click(sql.getByText("Guided"))
    await waitFor(() =>
      expect(canvas.getByText("3 of 4 refined")).toBeInTheDocument()
    )
    await expect(await preview.findByText("SQL · Guided")).toBeInTheDocument()
    await userEvent.click(
      canvas.getByRole("button", {
        name: "Reset SQL to the workspace default",
      })
    )
    await waitFor(() =>
      expect(canvas.getByText("2 of 4 refined")).toBeInTheDocument()
    )
    await expect(await preview.findByText("SQL · Briefed")).toBeInTheDocument()
    // Go: picking the default's stop means it follows the default again.
    const go = within(canvas.getByRole("radiogroup", { name: "Go delivery" }))
    await userEvent.click(go.getByText("Briefed"))
    await waitFor(() =>
      expect(canvas.getByText("1 of 4 refined")).toBeInTheDocument()
    )
  },
}

/** A workspace where every language follows the default. */
export const AllFollow: Story = {
  parameters: { settings: { workspaceDefault: "briefed", byLanguage: {} } },
  play: async ({ canvas }) => {
    await expect(canvas.getByText("All follow the default")).toBeInTheDocument()
    await expect(canvas.getAllByText("Follows default")).toHaveLength(4)
    // The mini dial announces that it follows the default.
    await expect(
      canvas.getByRole("radiogroup", { name: "TypeScript delivery" })
    ).toHaveAccessibleDescription("Follows default")
  },
}

/** Reduced motion: the thumb snaps; preview layers only fade (150ms). */
export const ReducedMotion: Story = {
  globals: { reducedMotion: "reduce" },
  play: async ({ canvas, canvasElement, userEvent }) => {
    await userEvent.click(
      within(
        canvas.getByRole("radiogroup", {
          name: "Review delivery for this workspace",
        })
      ).getByRole("radio", { name: "Explained" })
    )
    const thumb = canvasElement.querySelector<HTMLElement>(
      "[data-size=large] [data-dial-thumb]"
    )
    await new Promise((resolve) => requestAnimationFrame(resolve))
    await expect(thumb?.style.transform).toContain("translateX(200%)")
  },
}

/** Story-only storage key, so the story never touches the real setting. */
const STORED_KEY = "neuve.review-delivery.story.v1"
const storedSettingsAtom: DeliverySettingsAtom = atomWithStorage(
  STORED_KEY,
  DEFAULT_DELIVERY_SETTINGS
)

/**
 * A setting already in browser storage shows after a reload: the page reads
 * it through useSyncExternalStore (jotai 3's useAtomValue would keep the
 * default it rendered before storage loaded on mount).
 */
export const StoredSetting: Story = {
  parameters: { settingsAtom: storedSettingsAtom },
  beforeEach: () => {
    localStorage.setItem(
      STORED_KEY,
      JSON.stringify({
        workspaceDefault: "guided",
        byLanguage: { sql: "facts" },
      })
    )
    return () => localStorage.removeItem(STORED_KEY)
  },
  play: async ({ canvas }) => {
    await waitFor(() =>
      expect(
        canvas.getByRole("radio", { name: "Guided", description: /No code/ })
      ).toBeChecked()
    )
    await expect(canvas.getByText("1 of 4 refined")).toBeInTheDocument()
    const preview = within(
      canvas.getByRole("complementary", { name: "Preview" })
    )
    await expect(
      await preview.findByText("Workspace default · Guided")
    ).toBeInTheDocument()
    await expect(
      canvas.getByRole("radiogroup", { name: "SQL delivery" })
    ).not.toHaveAccessibleDescription("Follows default")
  },
}
