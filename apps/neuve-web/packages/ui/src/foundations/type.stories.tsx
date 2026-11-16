import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect } from "storybook/test"

import { typeStyles } from "@workspace/ui/foundations/inventory"
import type { TypeStyle } from "@workspace/ui/foundations/inventory"
import { Group, Name, Sheet } from "@workspace/ui/foundations/sheet"
import { codeSources } from "@workspace/ui/foundations/sources"
import { cn } from "@workspace/ui/lib/utils"

/**
 * Every text style the components set, read from their class strings: one
 * row per size, family, weight, leading and tracking found together.
 */
const STYLES = typeStyles(codeSources)

/** Expected line height in px for a leading class, when it names one. */
function leadingPx(style: TypeStyle) {
  if (!style.leading) return null
  const literal = /^\[([\d.]+)px\]$/.exec(style.leading)
  if (literal) return Number(literal[1])
  if (/^\d+$/.test(style.leading)) return Number(style.leading) * 4
  return style.leading === "none" ? style.size : null
}

function trackingPx(style: TypeStyle) {
  const em = /^\[?(-?[\d.]+)em\]?$/.exec(style.tracking ?? "")
  return em ? Number(em[1]) * style.size : null
}

function TypeSheet() {
  const sizes = [...new Set(STYLES.map((style) => style.size))]
  return (
    <Sheet
      title="Type"
      lede={`${STYLES.length} text styles the components set, from their class strings (Geist and Geist Mono). Uses counts the class strings that set each one.`}
    >
      {sizes.map((size) => (
        <Group key={size} label={`${size}px`}>
          {STYLES.filter((style) => style.size === size).map((style) => (
            <div
              key={style.classes.join(" ")}
              data-type-style=""
              data-size={style.size}
              data-leading={leadingPx(style) ?? ""}
              data-tracking={trackingPx(style) ?? ""}
              className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)_48px] items-baseline gap-4 border-b border-line-2 py-2.5 last:border-b-0"
            >
              <span
                data-sample=""
                className={cn("truncate", style.classes.join(" "))}
              >
                Review the change · 0123
              </span>
              <span className="flex flex-col gap-0.5">
                <Name>{style.classes.join(" ")}</Name>
                <span className="font-mono text-[11px] text-faint">
                  {style.family} · {style.weight}
                  {style.leading ? ` · leading ${style.leading}` : ""}
                  {style.tracking ? ` · tracking ${style.tracking}` : ""}
                </span>
              </span>
              <span className="text-right font-mono text-[11px] text-faint">
                ×{style.uses}
              </span>
            </div>
          ))}
        </Group>
      ))}
    </Sheet>
  )
}

const meta = {
  title: "Foundations/Type",
  component: TypeSheet,
} satisfies Meta<typeof TypeSheet>

export default meta
type Story = StoryObj<typeof meta>

/** Every sample renders at its class's size, leading and tracking. */
export const Styles: Story = {
  play: async ({ canvasElement }) => {
    const rows =
      canvasElement.querySelectorAll<HTMLElement>("[data-type-style]")
    await expect(rows.length).toBe(STYLES.length)
    await expect(STYLES.length).toBeGreaterThan(20)
    for (const row of rows) {
      const sample = getComputedStyle(row.querySelector("[data-sample]")!)
      await expect(parseFloat(sample.fontSize)).toBeCloseTo(
        Number(row.dataset.size),
        2
      )
      if (row.dataset.leading)
        await expect(parseFloat(sample.lineHeight)).toBeCloseTo(
          Number(row.dataset.leading),
          1
        )
      if (row.dataset.tracking)
        await expect(parseFloat(sample.letterSpacing)).toBeCloseTo(
          Number(row.dataset.tracking),
          1
        )
    }
  },
}
