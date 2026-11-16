import type { Meta, StoryObj } from "@storybook/react-vite"
import * as Lucide from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { expect } from "storybook/test"

import { customIcons, iconInventory } from "@workspace/ui/foundations/inventory"
import { Group, Name, Sheet } from "@workspace/ui/foundations/sheet"
import { codeSources } from "@workspace/ui/foundations/sources"

/**
 * Every Lucide icon the code imports, read from the import statements:
 * where it's imported and the strokeWidth each render passes ("default"
 * is Lucide's 2). Each icon is drawn at every stroke it's used with.
 */
const ICONS = iconInventory(codeSources)
const CUSTOM = customIcons(codeSources)
const LIBRARY = Lucide as unknown as Record<string, LucideIcon | undefined>

const short = (path: string) =>
  path.replace("packages/ui/src/", "").replace(/\.tsx?$/, "")

function IconsSheet() {
  const strokes = [...new Set(ICONS.flatMap((icon) => icon.strokes))]
    .filter((stroke) => /^[\d.]+$/.test(stroke))
    .sort((a, b) => Number(a) - Number(b))
  return (
    <Sheet
      title="Icons"
      lede={`${ICONS.length} Lucide icons imported by the code, at the strokes the code passes (${strokes.join(", ")} and the default 2).`}
    >
      <Group label="Imported icons">
        {ICONS.map((icon) => {
          const Icon = LIBRARY[icon.name]
          return (
            <div
              key={icon.name}
              data-icon={icon.name}
              className="grid grid-cols-[96px_200px_minmax(0,1fr)] items-center gap-4 border-b border-line-2 py-2 last:border-b-0"
            >
              <span className="flex items-center gap-2 text-ink">
                {Icon ? (
                  icon.strokes.map((stroke) => (
                    <Icon
                      key={stroke}
                      data-stroke={/^[\d.]+$/.test(stroke) ? stroke : "2"}
                      className="size-5"
                      strokeWidth={/^[\d.]+$/.test(stroke) ? Number(stroke) : 2}
                    />
                  ))
                ) : (
                  <span className="text-xs text-del-fg">missing</span>
                )}
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <Name>{icon.name}</Name>
                <span className="font-mono text-[11px] text-faint">
                  stroke {icon.strokes.join(", ")}
                </span>
              </span>
              <span className="text-xs break-words text-ink-muted">
                {icon.files.map(short).join(" · ")}
              </span>
            </div>
          )
        })}
      </Group>
      <Group label="Drawn with createLucideIcon" note="the code's own icons">
        {CUSTOM.map((icon) => (
          <div
            key={icon.name}
            className="grid grid-cols-[200px_minmax(0,1fr)] gap-4 py-1"
          >
            <Name>{icon.name}</Name>
            <span className="text-xs text-ink-muted">
              "{icon.lucideName}" · {short(icon.file)}
            </span>
          </div>
        ))}
      </Group>
    </Sheet>
  )
}

const meta = {
  title: "Foundations/Icons",
  component: IconsSheet,
} satisfies Meta<typeof IconsSheet>

export default meta
type Story = StoryObj<typeof meta>

/** Every imported icon resolves and draws at the strokes the code passes. */
export const Imported: Story = {
  play: async ({ canvasElement }) => {
    const rows = canvasElement.querySelectorAll<HTMLElement>("[data-icon]")
    await expect(rows.length).toBe(ICONS.length)
    await expect(ICONS.length).toBeGreaterThan(30)
    for (const row of rows) {
      const svgs = row.querySelectorAll("svg")
      await expect(svgs.length, row.dataset.icon).toBeGreaterThan(0)
      for (const svg of svgs)
        await expect(svg.getAttribute("stroke-width")).toBe(svg.dataset.stroke!)
    }
  },
}
