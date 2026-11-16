import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect } from "storybook/test"

import {
  colourUtilities,
  isShadow,
  themeTokens,
} from "@workspace/ui/foundations/inventory"
import type { Token } from "@workspace/ui/foundations/inventory"
import { Group, Name, Sheet } from "@workspace/ui/foundations/sheet"
import { globalsCss } from "@workspace/ui/foundations/sources"

/**
 * Every --nv-* colour token in styles/globals.css, light and dark side by
 * side, read from the stylesheet itself. "Now" is the live variable in the
 * current theme (the toolbar's theme switch).
 */
const TOKENS = themeTokens(globalsCss).filter((token) => !isShadow(token))
const UTILITY = colourUtilities(globalsCss)
const BG = TOKENS.find((token) => token.name === "nv-bg")!

/** Families, in reading order; a token joins the first that matches. */
const GROUPS: Array<[string, RegExp]> = [
  [
    "Surfaces and lines",
    /^nv-(bg|surface|raised|select|line|skel|hunk|expand)/,
  ],
  ["Ink", /^nv-(ink|muted|faint)/],
  ["Accent and focus", /^nv-(accent|focus|open-line|land|lit|warn|scrim)/],
  ["Lanes", /^nv-(req|on-req|sug|agt|sta)/],
  ["Diff", /^nv-(add|del)-/],
  ["Syntax", /^nv-syn-/],
  ["Read-only neighbour", /^nv-ro-/],
  ["Dock and peek", /^nv-(dock|peek)/],
  ["Capture player", /^nv-player-/],
]

function groupOf(token: Token) {
  return GROUPS.find(([, match]) => match.test(token.name))?.[0] ?? "Other"
}

function Swatch({ value, testId }: { value: string; testId?: string }) {
  return (
    <span
      data-testid={testId}
      className="block h-7 w-12 rounded-[5px] shadow-[inset_0_0_0_1px_rgba(128,128,128,0.25)]"
      style={{ background: value }}
    />
  )
}

function ColourSheet() {
  const groups = [...GROUPS.map(([label]) => label), "Other"]
  return (
    <Sheet
      title="Colour"
      lede={`${TOKENS.length} --nv-* colour tokens from styles/globals.css. Utilities use the name without nv- (bg-ink, text-ink, border-line).`}
    >
      {groups.map((label) => {
        const tokens = TOKENS.filter((token) => groupOf(token) === label)
        if (tokens.length === 0) return null
        return (
          <Group key={label} label={label}>
            <div className="grid grid-cols-[72px_72px_72px_minmax(0,1fr)] items-center gap-x-4 gap-y-2">
              <span className="text-[11px] text-faint">Light</span>
              <span className="text-[11px] text-faint">Dark</span>
              <span className="text-[11px] text-faint">Now</span>
              <span />
              {tokens.map((token) => (
                <div
                  key={token.name}
                  data-token={token.name}
                  className="contents"
                >
                  <span
                    className="rounded-lg p-1.5"
                    style={{ background: BG.light }}
                  >
                    <Swatch value={token.light} testId="light" />
                  </span>
                  <span
                    className="rounded-lg p-1.5"
                    style={{ background: BG.dark }}
                  >
                    <Swatch value={token.dark} testId="dark" />
                  </span>
                  <span className="rounded-lg bg-paper p-1.5">
                    <Swatch value={`var(--${token.name})`} testId="live" />
                  </span>
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <Name>--{token.name}</Name>
                    <span className="font-mono text-[11px] text-faint">
                      {UTILITY.has(token.name)
                        ? `bg-${UTILITY.get(token.name)} · `
                        : ""}
                      {token.light === token.dark
                        ? token.light
                        : `${token.light} / ${token.dark}`}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </Group>
        )
      })}
    </Sheet>
  )
}

const meta = {
  title: "Foundations/Colour",
  component: ColourSheet,
} satisfies Meta<typeof ColourSheet>

export default meta
type Story = StoryObj<typeof meta>

/** Each live swatch must match the current theme's value from globals.css. */
async function expectLiveMatchesSource(canvasElement: HTMLElement) {
  const dark = document.documentElement.classList.contains("dark")
  const rows = canvasElement.querySelectorAll<HTMLElement>("[data-token]")
  await expect(rows.length).toBe(TOKENS.length)
  await expect(TOKENS.length).toBeGreaterThan(60)
  for (const row of rows) {
    const pick = (id: string) =>
      getComputedStyle(row.querySelector(`[data-testid="${id}"]`)!)
        .backgroundColor
    await expect(
      pick("live"),
      `--${row.dataset.token} in the ${dark ? "dark" : "light"} theme`
    ).toBe(pick(dark ? "dark" : "light"))
  }
}

export const Tokens: Story = {
  play: async ({ canvasElement }) => expectLiveMatchesSource(canvasElement),
}

export const TokensDark: Story = {
  globals: { theme: "dark" },
  play: async ({ canvasElement }) => expectLiveMatchesSource(canvasElement),
}
