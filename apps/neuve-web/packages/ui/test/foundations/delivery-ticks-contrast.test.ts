/**
 * Delivery ticks contrast (round 6, DialTitle.dc.html B): the glyph's
 * filled and hollow ticks are non-text graphics that carry the stop's depth
 * (WCAG 1.4.11, ≥ 3.05:1, the 3:1 minimum plus contrast.test.ts's rendering
 * margin) on every fill they are drawn on, in both themes. The glyph's name
 * on hover is text (1.4.3, ≥ 4.55:1).
 *
 * Where each pair comes from (delivery-dial.tsx, delivery-title-dial.tsx):
 * - hollow ticks are a 1px inset in --line-strong on the page and the
 *   surface, and in --nv-muted (TICKS_ON_RAISED) on a raised fill;
 * - filled ticks are currentColor: --nv-muted, ink 2 or ink.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const CSS = readFileSync(
  join(import.meta.dir, "../../src/styles/globals.css"),
  "utf8"
)

type Rgb = [number, number, number]

/** The `--nv-*` hex declarations of one rule block (`:root {` or `.dark {`). */
function tokens(selector: string): Record<string, Rgb> {
  const start = CSS.indexOf(`${selector} {`)
  const body = CSS.slice(start, CSS.indexOf("\n}", start))
  const out: Record<string, Rgb> = {}
  for (const match of body.matchAll(/--nv-([\w-]+):\s*#([0-9a-f]{6});/gi))
    out[match[1]!] = [0, 2, 4].map(
      (i) => parseInt(match[2]!.slice(i, i + 2), 16) / 255
    ) as Rgb
  return out
}

function luminance([r, g, b]: Rgb) {
  const lin = (c: number) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function contrast(a: Rgb, b: Rgb) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

const TEXT = 4.55
const NON_TEXT = 3.05

const LIGHT = tokens(":root")
const THEMES = [
  ["light", LIGHT],
  ["dark", { ...LIGHT, ...tokens(".dark") }],
] as const

/** [tick colour, fill it sits on, where] */
const PAIRS: ReadonlyArray<readonly [string, string, string]> = [
  // Hollow ticks.
  ["line-strong", "bg", "title glyph at rest, on the page"],
  ["line-strong", "surface", "popover dial, unchecked stops"],
  [
    "muted",
    "raised",
    "title glyph hovered, focused or open; dial groups; popover thumb",
  ],
  [
    "muted",
    "surface",
    "compact and large dials, the checked stop's surface thumb",
  ],
  // Filled ticks.
  ["muted", "bg", "title glyph at rest"],
  ["ink-2", "raised", "title glyph hovered, focused or open"],
  ["ink-2", "surface", "an unchecked stop hovered in the popover"],
  ["ink", "surface", "the checked stop on a surface thumb"],
  ["ink", "raised", "the checked stop on the popover's raised thumb"],
]

/**
 * The "follows the default" thumb outline (shared/delivery-dial.tsx,
 * THUMB_OUTLINE), read from the source so a change of its colour is tested
 * as it ships. It sits on the dial's raised group.
 */
const DIAL_SOURCE = readFileSync(
  join(import.meta.dir, "../../src/neuve/shared/delivery-dial.tsx"),
  "utf8"
)
const THUMB_OUTLINE = /const THUMB_OUTLINE =\s*"[^"]*var\(--nv-([\w-]+)\)/.exec(
  DIAL_SOURCE
)?.[1]

describe.each(THEMES)("%s theme", (_theme, t) => {
  test("the follows-default thumb outline reaches 3.05:1 on the raised group", () => {
    expect(THUMB_OUTLINE).toBeDefined()
    expect(
      Number(contrast(t[THUMB_OUTLINE!]!, t.raised!).toFixed(2))
    ).toBeGreaterThanOrEqual(NON_TEXT)
  })

  test("filled and hollow ticks reach 3.05:1 on every fill", () => {
    const failing = PAIRS.map(([fg, bg, where]) => ({
      pair: `${fg} on ${bg} (${where})`,
      ratio: Number(contrast(t[fg]!, t[bg]!).toFixed(2)),
    })).filter(({ ratio }) => ratio < NON_TEXT)
    expect(failing).toEqual([])
  })

  test("the glyph's name reaches 4.55:1 in its bubble", () => {
    expect(contrast(t["peek-fg"]!, t["peek-bg"]!)).toBeGreaterThanOrEqual(TEXT)
  })
})
