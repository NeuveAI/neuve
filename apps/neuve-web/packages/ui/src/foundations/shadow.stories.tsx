import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect } from "storybook/test"

import {
  isShadow,
  literalClasses,
  themeTokens,
} from "@workspace/ui/foundations/inventory"
import { Group, Name, Sheet } from "@workspace/ui/foundations/sheet"
import { codeSources, globalsCss } from "@workspace/ui/foundations/sources"

/** The --nv-shadow-* tokens, light and dark, and the bracketed shadows in use. */
const TOKENS = themeTokens(globalsCss).filter(isShadow)
const SURFACE = themeTokens(globalsCss).find((t) => t.name === "nv-surface")!
const BG = themeTokens(globalsCss).find((t) => t.name === "nv-bg")!
const LITERAL = literalClasses(codeSources, /^shadow-\[/)

function Card({
  shadow,
  surface,
  testId,
}: {
  shadow: string
  surface: string
  testId: string
}) {
  return (
    <span
      data-testid={testId}
      className="block h-16 w-28 rounded-[10px]"
      style={{ boxShadow: shadow, background: surface }}
    />
  )
}

function ShadowSheet() {
  return (
    <Sheet
      title="Shadow"
      lede={`${TOKENS.length} shadow tokens from styles/globals.css (utilities shadow-card, shadow-dock, …). "Now" is the live variable in the current theme.`}
    >
      <Group label="Tokens">
        {TOKENS.map((token) => (
          <div
            key={token.name}
            data-token={token.name}
            className="grid grid-cols-[150px_150px_150px_minmax(0,1fr)] items-center gap-4 py-2"
          >
            <span className="rounded-xl p-5" style={{ background: BG.light }}>
              <Card
                shadow={token.light}
                surface={SURFACE.light}
                testId="light"
              />
            </span>
            <span className="rounded-xl p-5" style={{ background: BG.dark }}>
              <Card shadow={token.dark} surface={SURFACE.dark} testId="dark" />
            </span>
            <span className="rounded-xl bg-paper p-5">
              <Card
                shadow={`var(--${token.name})`}
                surface="var(--nv-surface)"
                testId="live"
              />
            </span>
            <span className="flex min-w-0 flex-col gap-1">
              <Name>--{token.name}</Name>
              <Name className="text-faint">
                {token.name.replace("nv-", "")}
              </Name>
              <span className="font-mono text-[11px] text-faint">
                {token.light}
                {token.dark !== token.light && <br />}
                {token.dark !== token.light && token.dark}
              </span>
            </span>
          </div>
        ))}
      </Group>
      <Group label="Bracketed shadows in use" note="literal values, no token">
        <div className="flex flex-col gap-1.5">
          {LITERAL.map((use) => (
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
  title: "Foundations/Shadow",
  component: ShadowSheet,
} satisfies Meta<typeof ShadowSheet>

export default meta
type Story = StoryObj<typeof meta>

async function expectLiveMatchesSource(canvasElement: HTMLElement) {
  const dark = document.documentElement.classList.contains("dark")
  const rows = canvasElement.querySelectorAll<HTMLElement>("[data-token]")
  await expect(rows.length).toBe(TOKENS.length)
  await expect(TOKENS.length).toBeGreaterThanOrEqual(5)
  for (const row of rows) {
    const pick = (id: string) =>
      getComputedStyle(row.querySelector(`[data-testid="${id}"]`)!).boxShadow
    await expect(pick("live")).not.toBe("none")
    await expect(pick("live"), `--${row.dataset.token}`).toBe(
      pick(dark ? "dark" : "light")
    )
  }
}

export const Tokens: Story = {
  play: async ({ canvasElement }) => expectLiveMatchesSource(canvasElement),
}

export const TokensDark: Story = {
  globals: { theme: "dark" },
  play: async ({ canvasElement }) => expectLiveMatchesSource(canvasElement),
}
