/**
 * Token contrast (round 5c): WCAG 2.2 contrast of the desk's code colours on
 * every row they are drawn on, in both themes, read from globals.css.
 *
 * - Text (1.4.3, ≥ 4.55:1, WCAG 4.5 plus a rendering margin): syntax colours, comment, add/del signs and the
 *   read-only neighbour's ink, on plain rows, rows with the hover tint
 *   (--nv-lit, also the engaged tint), landed rows (--nv-land) and number
 *   cells with the open tint.
 * - The engaged outline (1.4.11, ≥ 3.05:1) on plain and tinted rows.
 * - The keyboard focus ring (1.4.11, ≥ 3.05:1) on every surface a ring sits
 *   on: paper, surface, raised, chip tints, tinted and selected rows and
 *   number cells, the read-only band; and the inverse ring on the surfaces
 *   that stay dark in both themes (the dock, its hover, the capture player).
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const CSS = readFileSync(
  join(import.meta.dir, "../../src/styles/globals.css"),
  "utf8"
)

type Rgb = [number, number, number]
interface Paint {
  rgb: Rgb
  alpha: number
}

/** The `--nv-*` declarations of one rule block (`:root {` or `.dark {`). */
function tokens(selector: string): Record<string, string> {
  const start = CSS.indexOf(`${selector} {`)
  const body = CSS.slice(start, CSS.indexOf("\n}", start))
  const out: Record<string, string> = {}
  for (const match of body.matchAll(/--nv-([\w-]+):\s*([^;]+);/g))
    out[match[1]!] = match[2]!.trim()
  return out
}

function paint(value: string): Paint {
  const hex = /^#([0-9a-f]{6})$/i.exec(value)
  if (hex)
    return {
      rgb: [0, 2, 4].map(
        (i) => parseInt(hex[1]!.slice(i, i + 2), 16) / 255
      ) as Rgb,
      alpha: 1,
    }
  const rgba = /^rgba\(([^)]+)\)$/.exec(value)
  if (rgba) {
    const [r, g, b, a] = rgba[1]!.split(",").map((part) => Number(part))
    return { rgb: [r! / 255, g! / 255, b! / 255], alpha: a! }
  }
  throw new Error(`Unparsed colour ${value}`)
}

/**
 * WCAG minimums plus a margin: browsers composite tints in 8-bit, so a pair
 * computed exactly at 4.5:1 can render a hair below it (round 5c).
 */
const TEXT = 4.55
const NON_TEXT = 3.05

/** A tint over a background, rounded to 8 bits per channel as rendered. */
function over(top: Paint, base: Rgb): Rgb {
  return base.map((channel, i) => {
    const mixed = top.rgb[i]! * top.alpha + channel * (1 - top.alpha)
    return Math.round(mixed * 255) / 255
  }) as Rgb
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

/**
 * The open and selection tint, --nv-range-strong: a colour token mixed with
 * transparent, read as that colour at the mixed share.
 */
function rangeStrong(t: Record<string, string>): Paint {
  const mix =
    /color-mix\(\s*in oklab,\s*var\(--nv-([\w-]+)\)\s*(\d+)%,\s*transparent\s*\)/.exec(
      t["range-strong"]!
    )
  if (!mix) throw new Error(`Unparsed --nv-range-strong ${t["range-strong"]}`)
  return { rgb: paint(t[mix[1]!]!).rgb, alpha: Number(mix[2]) / 100 }
}

const LIGHT = tokens(":root")
const THEMES = [
  ["light", LIGHT],
  // .dark redefines what changes; the rest (the capture player) is inherited.
  ["dark", { ...LIGHT, ...tokens(".dark") }],
] as const

const SYNTAX = ["kw", "st", "fn", "cm", "nu", "id", "pl"].map(
  (name) => `syn-${name}`
)

describe.each(THEMES)("%s theme", (theme, t) => {
  const color = (name: string) => paint(t[name]!).rgb
  const tints = {
    hint: paint(t.lit!),
    land: paint(t.land!),
    strong: rangeStrong(t),
  }
  /**
   * A row background plain, hint-tinted (also the engaged code tint),
   * landed, and selected (the selection tint, also the open tint).
   */
  const row = (bg: string) => {
    const base = color(bg)
    return {
      [bg]: base,
      [`${bg} + hint`]: over(tints.hint, base),
      [`${bg} + land`]: over(tints.land, base),
      [`${bg} + selected`]: over(tints.strong, base),
    }
  }
  const numberCell = (bg: string) => ({
    ...row(bg),
    [`${bg} + open`]: over(tints.strong, color(bg)),
  })

  const worst = (fg: string, rows: Record<string, Rgb>) =>
    Math.min(...Object.values(rows).map((bg) => contrast(color(fg), bg)))

  test("syntax colours reach 4.55:1 on code rows, plain, tinted, landed and selected", () => {
    const rows = { ...row("surface"), ...row("add-bg"), ...row("del-bg") }
    // Named, so a failure says which colour and how far it falls.
    const failing = SYNTAX.map((token) => ({
      token,
      ratio: Number(worst(token, rows).toFixed(2)),
    })).filter(({ ratio }) => ratio < TEXT)
    expect(failing).toEqual([])
  })

  test("add and del signs reach 4.55:1 on their rows and number cells", () => {
    expect(
      worst("add-fg", {
        ...row("add-bg"),
        ...numberCell("add-num"),
        surface: color("surface"),
      })
    ).toBeGreaterThanOrEqual(TEXT)
    expect(
      worst("del-fg", {
        ...row("del-bg"),
        ...numberCell("del-num"),
        surface: color("surface"),
      })
    ).toBeGreaterThanOrEqual(TEXT)
  })

  test("line numbers reach 4.55:1 on their cells in every state", () => {
    const failing = [
      ["ln", "surface"],
      ["add-ln", "add-num"],
      ["del-ln", "del-num"],
      // A selected line's number, on the selection tint.
      ["ln-select", "surface"],
      ["ln-select", "add-num"],
      ["ln-select", "del-num"],
    ]
      .map(([fg, bg]) => ({
        pair: `${fg} on ${bg}`,
        ratio: Number(worst(fg!, numberCell(bg!)).toFixed(2)),
      }))
      .filter(({ ratio }) => ratio < TEXT)
    expect(failing).toEqual([])
  })

  test("line numbers outside the diff reach 4.55:1 (source sheet, lineage)", () => {
    const failing = [
      ["ln", "surface"],
      ["sug-ink", "sug-tint"],
      ["ln", "req-tint"],
      ["del-ln", "del-bg"],
      ["add-ln", "add-bg"],
    ]
      .map(([fg, bg]) => ({
        pair: `${fg} on ${bg}`,
        ratio: Number(contrast(color(fg!), color(bg!)).toFixed(2)),
      }))
      .filter(({ ratio }) => ratio < TEXT)
    expect(failing).toEqual([])
  })

  test("line numbers stay quieter than code text", () => {
    // Nearer the background than the plain code colour.
    const bg = luminance(color("surface"))
    for (const token of ["ln", "add-ln", "del-ln"])
      expect(Math.abs(luminance(color(token)) - bg)).toBeLessThan(
        Math.abs(luminance(color("syn-pl")) - bg)
      )
  })

  test("the read-only background is a visible step from the surface", () => {
    expect(contrast(color("ro-bg"), color("surface"))).toBeGreaterThanOrEqual(
      1.1
    )
  })

  test("the read-only neighbour's ink reaches 4.55:1 on its backgrounds", () => {
    expect(
      worst("ro-ink", {
        bg: color("ro-bg"),
        row: color("ro-row"),
        add: color("ro-add"),
        del: color("ro-del"),
      })
    ).toBeGreaterThanOrEqual(TEXT)
  })

  test("the engaged outline reaches 3.05:1 on plain and tinted rows", () => {
    const rows = {
      ...row("surface"),
      ...row("add-bg"),
      ...row("del-bg"),
      ...numberCell("add-num"),
      ...numberCell("del-num"),
    }
    expect(worst("engaged-ring", rows)).toBeGreaterThanOrEqual(NON_TEXT)
  })

  test("the focus ring reaches 3.05:1 on every surface it sits on", () => {
    const surfaces: Record<string, Rgb> = {}
    for (const bg of [
      // Page and panels.
      "bg",
      "surface",
      "raised",
      "raised-2",
      "select",
      // Chips and lane tints.
      "req-tint",
      "req-tint-2",
      "sug-tint",
      "sug-tint-2",
      "agt-tint",
      "agt-tint-2",
      "sta-fill",
      // Diff rows outside the overlay tints.
      "hunk",
      "expand",
      // The read-only band.
      "ro-bg",
      "ro-row",
      "ro-add",
      "ro-del",
    ])
      surfaces[bg] = color(bg)
    // Rows and number cells plain, hinted, landed, selected and engaged.
    Object.assign(
      surfaces,
      row("bg"),
      row("surface"),
      row("add-bg"),
      row("del-bg"),
      numberCell("add-num"),
      numberCell("del-num")
    )
    const failing = Object.entries(surfaces)
      .map(([bg, rgb]) => ({
        bg,
        ratio: Number(contrast(color("focus"), rgb).toFixed(2)),
      }))
      .filter(({ ratio }) => ratio < NON_TEXT)
    expect(failing).toEqual([])
  })

  test("inverse surfaces take the inverse ring, at 3.05:1 on the dock, its hover and the player", () => {
    // data-surface="inverse" swaps both the focus token and shadcn's --ring.
    // A dock button's ring never sits on its own hover fill: the house
    // outline is drawn 2px outside the button, over the dock (and the old
    // 1px border-ring, under bg-clip-padding, was drawn over the dock too).
    // dock-hover is checked as a guard for an inset ring, not because a
    // ring meets it today.
    const scope = /\[data-surface="inverse"\]\s*\{([^}]*)\}/.exec(CSS)
    expect(scope).not.toBeNull()
    expect(scope![1]).toMatch(/--nv-focus:\s*var\(--nv-focus-inverse\)/)
    expect(scope![1]).toMatch(/--ring:\s*var\(--nv-focus-inverse\)/)
    const failing = ["dock", "dock-hover", "player-bg"]
      .map((bg) => ({
        bg,
        ratio: Number(contrast(color("focus-inverse"), color(bg)).toFixed(2)),
      }))
      .filter(({ ratio }) => ratio < NON_TEXT)
    expect(failing).toEqual([])
  })

  test("the delivery glyphs' hollow ticks reach 3.05:1 on their open fills (round 7)", () => {
    // Open, the title glyph is raised-2 with ink-2 tick outlines; the dock
    // glyph is dock-line with dock-muted outlines. Their hover fills too.
    const failing = [
      ["ink-2", "raised-2"],
      ["muted", "raised"],
      ["dock-muted", "dock-line"],
      ["dock-muted", "dock-hover"],
      ["dock-muted", "dock"],
    ]
      .map(([tick, fill]) => ({
        pair: `${tick} on ${fill}`,
        ratio: Number(contrast(color(tick!), color(fill!)).toFixed(2)),
      }))
      .filter(({ ratio }) => ratio < NON_TEXT)
    expect(failing).toEqual([])
  })

  test("the composer's anchor ring reaches 3.05:1 on its rows, selected or not", () => {
    // The overlay's expanded-anchor ring, as the desk maps it.
    const mapped = /--diffs-overlay-expanded-ring:\s*var\(--nv-([\w-]+)\)/.exec(
      CSS
    )
    expect(mapped).not.toBeNull()
    const rows: Record<string, Rgb> = {}
    for (const bg of ["surface", "add-bg", "del-bg"]) {
      rows[bg] = color(bg)
      rows[`${bg} + selected`] = over(tints.strong, color(bg))
    }
    expect(worst(mapped![1]!, rows)).toBeGreaterThanOrEqual(NON_TEXT)
  })
})

/*
 * Ink and marks on the desk's chrome (contrast and hit-area sweep, round 6).
 * Each pair reads the colour class the component draws today from its
 * source, so stepping one back to a quieter token (faint) fails here:
 *
 * - text at ≥ 4.55:1 (1.4.3): a margin pin's cited file, a read-only pin's
 *   label, the read-only neighbour's note, the rail's Files directories, a
 *   conflict card's "vs", a graph card's tree prefix (aria-hidden, but read
 *   as text), a history card's quote glyph, the Find ⌘K hint and the
 *   dock's ⌘↵ hint;
 * - marks at ≥ 3.05:1 (1.4.11): the Viewed box edge, the lock on read-only
 *   rows and a pin's shared-unit dots.
 *
 * These guard the class choice, not rendering. They pass when a colour class
 * is removed (the element inherits its parent's ink) or opacity arrives
 * through another class (only the ⌘↵ hint checks for it), and a reformat that
 * moves an anchor fails them loudly. Rendered colours belong in a Storybook
 * play that composites the computed colour on its background, as
 * diff-file.stories.tsx GapRangeContrast does; these pairs were measured
 * rendered, in both themes, when the sweep landed.
 */
const SRC = join(import.meta.dir, "../../src")
const source = (file: string) => readFileSync(join(SRC, file), "utf8")

/** Tailwind colour names (`text-ink-muted`) to their --nv-* tokens. */
const COLOR_TOKEN: Record<string, string> = {}
for (const match of CSS.matchAll(/--color-([\w-]+):\s*var\(--nv-([\w-]+)\)/g))
  COLOR_TOKEN[match[1]!] = match[2]!

/**
 * The plain (unprefixed) `text-*` colour class nearest before `anchor` in a
 * component's source, as its --nv-* token. Sizes (`text-xs`, `text-[11px]`)
 * and state variants (`hover:text-ink`) are skipped.
 */
function inkBefore(file: string, anchor: string): string {
  const code = source(file)
  const at = code.indexOf(anchor)
  if (at < 0) throw new Error(`${anchor} not found in ${file}`)
  const window = code.slice(Math.max(0, at - 700), at)
  const classes = [...window.matchAll(/(?<![\w:/-])text-([a-z][\w-]*)/g)]
    .map((match) => match[1]!)
    .filter((name) => name in COLOR_TOKEN)
  const last = classes.at(-1)
  if (!last) throw new Error(`No text colour before ${anchor} in ${file}`)
  return COLOR_TOKEN[last]!
}

describe.each(THEMES)("%s theme: desk chrome", (_theme, t) => {
  const color = (name: string) => paint(t[name]!).rgb
  const ratio = (fg: string, bg: string) =>
    Number(contrast(color(fg), color(bg)).toFixed(2))
  /** [source file, anchor after the element, where, backgrounds] */
  type Pair = readonly [string, string, string, ReadonlyArray<string>]
  const below = (pairs: ReadonlyArray<Pair>, min: number) =>
    pairs.flatMap(([file, anchor, where, bgs]) => {
      const fg = inkBefore(file, anchor)
      return bgs
        .map((bg) => ({
          pair: `${where}: ${fg} on ${bg}`,
          ratio: ratio(fg, bg),
        }))
        .filter(({ ratio: r }) => r < min)
    })

  test("chrome text reaches 4.55:1 where it is drawn", () => {
    const TEXT_PAIRS: ReadonlyArray<Pair> = [
      // A filled pin's rest tints, and an outlined pin on the page, surface
      // and read-only rows; on the hover tints the target takes the pin's
      // own ink (next test).
      [
        "neuve/review-desk/context-margin.tsx",
        "{target}",
        "pin target",
        [
          "raised",
          "req-tint",
          "sug-tint",
          "bg",
          "surface",
          "ro-bg",
          "ro-add",
          "ro-del",
        ],
      ],
      [
        "neuve/review-desk/context-margin.tsx",
        "shadow-[inset_0_0_0_1px_var(--nv-line)] hover:bg-raised",
        "read-only pin label",
        ["ro-bg", "ro-row", "ro-add", "ro-del", "bg", "surface", "raised"],
      ],
      [
        "neuve/review-desk/context-margin.tsx",
        ": style.icon",
        "read-only pin icon",
        ["ro-bg", "ro-row", "ro-add", "ro-del", "bg", "surface", "raised"],
      ],
      [
        "neuve/review-desk/read-only-neighbor.tsx",
        "{neighbor.note}",
        "read-only neighbour note",
        ["ro-bg"],
      ],
      [
        "neuve/review-desk/unit-rail.tsx",
        "{dir}",
        "rail Files directory",
        // The rail, the current file's row and a hovered row.
        ["bg", "select", "raised"],
      ],
      [
        "neuve/review-desk/context-margin.tsx",
        "\n            vs\n",
        "conflict card vs",
        ["surface"],
      ],
      [
        "neuve/review-desk/context-margin.tsx",
        "{node.prefix}",
        "graph card tree prefix",
        ["surface"],
      ],
      [
        "neuve/review-desk/context-margin.tsx",
        "\n            “\n",
        "history card quote glyph",
        ["surface"],
      ],
      [
        "neuve/shared/app-header.tsx",
        "\n            ⌘K\n",
        "Find ⌘K",
        ["raised-2"],
      ],
    ]
    expect(below(TEXT_PAIRS, TEXT)).toEqual([])
  })

  test("a pin's target takes the pin's own ink on its hover tint", () => {
    const code = source("neuve/review-desk/context-margin.tsx")
    expect(code).toMatch(/text-ink-muted group-hover\/pin:text-current/)
    const failing = [
      ["ink-2", "raised-2"],
      ["req-ink", "req-tint-2"],
      ["sug-ink", "sug-tint-2"],
    ]
      .map(([fg, bg]) => ({ pair: `${fg} on ${bg}`, ratio: ratio(fg!, bg!) }))
      .filter(({ ratio: r }) => r < TEXT)
    expect(failing).toEqual([])
  })

  test("the dock's ⌘↵ hint reaches 4.55:1 in its buttons, at full strength", () => {
    const code = source("neuve/review-desk/decision-dock.tsx")
    const hints = [
      ...code.matchAll(/<span className="([^"]*)">\{SHORTCUT\}<\/span>/g),
    ].map((hint) => hint[1]!)
    expect(hints.length).toBeGreaterThan(0)
    // No opacity on the hint: it takes the button's own ink.
    expect(hints.filter((names) => /opacity-/.test(names))).toEqual([])
    const failing = [
      // dock-primary at rest and on hover; the ink button.
      ["accent-ink", "accent"],
      ["accent-ink", "accent-hover"],
      ["bg", "ink"],
    ]
      .map(([fg, bg]) => ({ pair: `${fg} on ${bg}`, ratio: ratio(fg!, bg!) }))
      .filter(({ ratio: r }) => r < TEXT)
    expect(failing).toEqual([])
  })

  test("the lock on read-only rows reaches 3.05:1", () => {
    const LOCKS: ReadonlyArray<Pair> = [
      [
        "neuve/review-desk/read-only-neighbor.tsx",
        "strokeWidth={1.6}",
        "neighbour header lock",
        ["ro-bg"],
      ],
      [
        "neuve/review-desk/diff-file.tsx",
        "<span className=\"truncate\">{unitsPhrase",
        "gap-row lock",
        ["expand"],
      ],
      [
        "neuve/review-desk/diff-file.tsx",
        '<span className="min-w-0 truncate">{name}</span>',
        "owner-chip lock",
        ["ro-bg", "raised"],
      ],
    ]
    expect(below(LOCKS, NON_TEXT)).toEqual([])
  })

  test("the Viewed box edge reaches 3.05:1 at rest and on hover", () => {
    const code = source("neuve/review-desk/diff-file.tsx")
    const edge = (prefix: string) => {
      const match = new RegExp(
        `(?<![\\w:/-])${prefix}shadow-\\[inset_0_0_0_1\\.5px_var\\(--nv-([\\w-]+)\\)\\]`
      ).exec(code)
      if (!match) throw new Error(`No ${prefix || "rest "}Viewed edge`)
      return match[1]!
    }
    const rest = edge("")
    const hover = edge("group-hover/viewed:")
    // The file header is the surface; a hovered button is raised.
    expect(ratio(rest, "surface")).toBeGreaterThanOrEqual(NON_TEXT)
    expect(ratio(hover, "raised")).toBeGreaterThanOrEqual(NON_TEXT)
  })

  test("a pin's shared-unit dots reach 3.05:1 on the pin or the row behind it", () => {
    const code = source("neuve/review-desk/context-margin.tsx")
    const share = /!outlined && "opacity-(\d+)"/.exec(code)
    expect(share).not.toBeNull()
    const alpha = Number(share![1]) / 100
    expect(code).toMatch(/"size-1 rounded-full bg-current"/)
    const dot = (fg: string, bg: Rgb, a: number) =>
      contrast(over({ rgb: color(fg), alpha: a }, bg), bg)
    // Filled pins: the family ink at the shared alpha, on the rest tint and
    // the hover tint (and the open pin's paper on ink).
    const filled = [
      ["ink-2", "raised"],
      ["ink-2", "raised-2"],
      ["req-ink", "req-tint"],
      ["req-ink", "req-tint-2"],
      ["sug-ink", "sug-tint"],
      ["sug-ink", "sug-tint-2"],
      ["bg", "ink"],
    ].map(([fg, bg]) => ({
      pair: `${fg} at ${alpha} on ${bg}`,
      ratio: Number(dot(fg!, color(bg!), alpha).toFixed(2)),
    }))
    // Outlined pins (transient, draft, read-only): muted at full strength
    // on the rows behind them, tinted or not.
    const rows = {
      ...Object.fromEntries(
        ["bg", "surface", "raised", "ro-bg", "ro-add", "ro-del"].map((bg) => [
          bg,
          color(bg),
        ])
      ),
      "add-bg + land": over(paint(t.land!), color("add-bg")),
      "del-bg + land": over(paint(t.land!), color("del-bg")),
      "del-bg + hint": over(paint(t.lit!), color("del-bg")),
    }
    const outlined = Object.entries(rows).map(([bg, rgb]) => ({
      pair: `muted on ${bg}`,
      ratio: Number(dot("muted", rgb, 1).toFixed(2)),
    }))
    expect(
      [...filled, ...outlined].filter(({ ratio: r }) => r < NON_TEXT)
    ).toEqual([])
  })
})
