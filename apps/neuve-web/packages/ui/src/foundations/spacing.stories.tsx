import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect } from "storybook/test"

import {
  literalClasses,
  radiusScale,
  spacingSteps,
} from "@workspace/ui/foundations/inventory"
import { Group, Name, Sheet } from "@workspace/ui/foundations/sheet"
import { codeSources, globalsCss } from "@workspace/ui/foundations/sources"

/**
 * Spacing: the Tailwind steps (0.25rem each) the components use for
 * padding, margin and gap, plus the bracketed px values. Radius: the
 * @theme scale (from --radius, 10px) and the bracketed radii in use.
 */
const STEPS = spacingSteps(codeSources)
const LITERAL_SPACING = literalClasses(
  codeSources,
  /^-?(p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap|gap-x|gap-y)-\[[\d.]+px\]$/
)
const RADII = radiusScale(globalsCss)
const NAMED_RADII = literalClasses(
  codeSources,
  /^rounded(-[trblse]{1,2})?(-(sm|md|lg|xl|2xl|3xl|4xl|full|none))?$/
)
const LITERAL_RADII = literalClasses(codeSources, /^rounded(-[a-z]+)?-\[/)

function SpacingSheet() {
  return (
    <Sheet
      title="Spacing and radius"
      lede="What the components use, read from their class strings and the @theme radius scale."
    >
      <Group label="Spacing steps" note="step × 4px; bar = the step">
        {STEPS.map((use) => (
          <div
            key={use.step}
            data-step={use.step}
            className="grid grid-cols-[56px_minmax(0,320px)_minmax(0,1fr)_48px] items-center gap-4 py-1"
          >
            <Name>{use.step}</Name>
            <span className="flex h-4 items-center">
              <span
                data-bar=""
                className="block h-3 rounded-[2px] bg-brand"
                style={{ width: `calc(var(--spacing) * ${use.step})` }}
              />
            </span>
            <span className="font-mono text-[11px] text-faint">
              {use.px}px · {use.utilities.join(", ")}
            </span>
            <span className="text-right font-mono text-[11px] text-faint">
              ×{use.uses}
            </span>
          </div>
        ))}
      </Group>
      <Group label="Bracketed spacing" note="literal px, not on the scale">
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {LITERAL_SPACING.map((use) => (
            <Name key={use.name}>
              {use.name} ×{use.uses}
            </Name>
          ))}
        </div>
      </Group>
      <Group label="Radius scale" note="@theme --radius-*">
        <div className="flex flex-wrap gap-6">
          {RADII.map((radius) => (
            <div
              key={radius.name}
              data-radius={radius.name}
              data-px={radius.px}
              className="flex flex-col items-start gap-2"
            >
              <span
                data-box=""
                className="block size-16 bg-raised-2"
                style={{ borderRadius: radius.value }}
              />
              <Name>{radius.name.replace("radius-", "rounded-")}</Name>
              <span className="font-mono text-[11px] text-faint">
                {radius.px}px
              </span>
            </div>
          ))}
        </div>
      </Group>
      <Group label="Radius classes in use">
        <div className="flex flex-wrap gap-x-4 gap-y-1.5">
          {[...NAMED_RADII, ...LITERAL_RADII].map((use) => (
            <Name key={use.name}>
              {use.name} ×{use.uses}
            </Name>
          ))}
        </div>
      </Group>
    </Sheet>
  )
}

const meta = {
  title: "Foundations/Spacing and radius",
  component: SpacingSheet,
} satisfies Meta<typeof SpacingSheet>

export default meta
type Story = StoryObj<typeof meta>

/** Each bar is step × 4px wide; each radius box is its token's px. */
export const Scale: Story = {
  play: async ({ canvasElement }) => {
    const steps = canvasElement.querySelectorAll<HTMLElement>("[data-step]")
    await expect(steps.length).toBe(STEPS.length)
    for (const step of steps) {
      const bar = step.querySelector<HTMLElement>("[data-bar]")!
      await expect(bar.getBoundingClientRect().width).toBeCloseTo(
        Number(step.dataset.step) * 4,
        1
      )
    }
    const radii = canvasElement.querySelectorAll<HTMLElement>("[data-radius]")
    await expect(radii.length).toBe(7)
    for (const radius of radii) {
      const box = radius.querySelector<HTMLElement>("[data-box]")!
      await expect(
        parseFloat(getComputedStyle(box).borderTopLeftRadius)
      ).toBeCloseTo(Number(radius.dataset.px), 1)
    }
  },
}
