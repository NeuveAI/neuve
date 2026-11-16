/**
 * Inventories for the Foundations stories, read from the source itself so a
 * sheet can't drift from the code: colour and shadow tokens from
 * globals.css, the type, spacing and radius classes the components use, and
 * every Lucide icon they import. Pure functions over source text: the
 * stories feed them Vite's raw imports, the tests feed them the files.
 */

/** Source text by path (packages/ui/src/… or apps/web/src/…). */
export type Sources = Record<string, string>

/* ── Tokens in globals.css ──────────────────────────────────────────── */

export interface Token {
  /** Without the leading dashes: "nv-ink". */
  name: string
  light: string
  /** The .dark value, or the light one when dark doesn't override it. */
  dark: string
}

function block(css: string, selector: string): string {
  const start = css.search(new RegExp(`^${selector}\\s*\\{`, "m"))
  if (start < 0) return ""
  let depth = 0
  for (let index = css.indexOf("{", start); index < css.length; index++) {
    if (css[index] === "{") depth++
    if (css[index] === "}" && --depth === 0)
      return css.slice(css.indexOf("{", start) + 1, index)
  }
  return ""
}

function declarations(body: string): Map<string, string> {
  const values = new Map<string, string>()
  const clean = body.replace(/\/\*[\s\S]*?\*\//g, "")
  for (const match of clean.matchAll(/--(nv-[\w-]+)\s*:\s*([^;]+);/g))
    values.set(match[1]!, match[2]!.replace(/\s+/g, " ").trim())
  return values
}

/** Every --nv-* token on :root, with its .dark value. */
export function themeTokens(globalsCss: string): Array<Token> {
  const light = declarations(block(globalsCss, ":root"))
  const dark = declarations(block(globalsCss, "\\.dark"))
  return [...light].map(([name, value]) => ({
    name,
    light: value,
    dark: dark.get(name) ?? value,
  }))
}

export const isShadow = (token: Token) => token.name.startsWith("nv-shadow-")

/** The Tailwind colour utility stem for a token: nv-ink → "ink" (bg-ink, text-ink). */
export function colourUtilities(globalsCss: string): Map<string, string> {
  const names = new Map<string, string>()
  for (const match of globalsCss.matchAll(
    /--color-([\w-]+)\s*:\s*var\(--(nv-[\w-]+)\)/g
  ))
    names.set(match[2]!, match[1]!)
  return names
}

/** The radius scale from @theme (--radius-sm … --radius-4xl), in px. */
export function radiusScale(
  globalsCss: string
): Array<{ name: string; value: string; px: number }> {
  const base = /--radius\s*:\s*([\d.]+)rem/.exec(globalsCss)
  const radius = base ? Number(base[1]) * 16 : 0
  return [...globalsCss.matchAll(/--(radius-[\w]+)\s*:\s*([^;]+);/g)].map(
    (match) => {
      const value = match[2]!.trim()
      const factor = /\*\s*([\d.]+)/.exec(value)
      return {
        name: match[1]!,
        value,
        px: +(radius * (factor ? Number(factor[1]) : 1)).toFixed(2),
      }
    }
  )
}

/* ── Classes the components use ─────────────────────────────────────── */

/** String literals in TS/TSX (approximate: enough for class strings). */
const STRING = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g

function* classStrings(sources: Sources): Generator<Array<string>> {
  for (const [path, source] of Object.entries(sources)) {
    if (!path.endsWith(".tsx")) continue
    for (const match of source.matchAll(STRING))
      yield match[0].slice(1, -1).split(/\s+/)
  }
}

/** Tailwind v4 default text sizes, px. */
export const TEXT_SIZE: Record<string, number> = {
  xs: 12,
  sm: 14,
  base: 16,
  lg: 18,
  xl: 20,
  "2xl": 24,
  "3xl": 30,
  "4xl": 36,
}

export interface TypeStyle {
  /** The classes that set it, in a fixed order (size, family, weight, leading, tracking). */
  classes: Array<string>
  /** Font size in px. */
  size: number
  family: "sans" | "mono"
  weight: "normal" | "medium" | "semibold" | "bold"
  leading?: string
  tracking?: string
  uses: number
}

const SIZE = /^text-(xs|sm|base|lg|xl|[234]xl|\[(\d+(?:\.\d+)?)px\])$/
const WEIGHT = /^font-(normal|medium|semibold|bold)$/
const FAMILY = /^font-(mono|sans)$/
const LEADING =
  /^leading-(?:\d+|none|tight|snug|normal|relaxed|loose|\[[\d.]+px\])$/
const TRACKING =
  /^tracking-(?:tighter|tight|normal|wide|wider|widest|\[-?[\d.]+em\])$/

/**
 * Every text style the components set: one entry per distinct size, family,
 * weight, leading and tracking found together in a class string (variants
 * such as sm: are ignored). `label-mono` counts as its own style.
 */
export function typeStyles(sources: Sources): Array<TypeStyle> {
  const styles = new Map<string, TypeStyle>()
  for (const raw of classStrings(sources)) {
    const classes = raw.filter((name) => !name.includes(":"))
    if (classes.includes("label-mono")) {
      const key = "label-mono"
      const style = styles.get(key) ?? {
        classes: ["label-mono"],
        size: 11,
        family: "mono" as const,
        weight: "normal" as const,
        tracking: "0.07em",
        uses: 0,
      }
      style.uses++
      styles.set(key, style)
      continue
    }
    const size = classes.find((name) => SIZE.test(name))
    if (!size) continue
    const match = SIZE.exec(size)!
    const px = match[2] ? Number(match[2]) : TEXT_SIZE[match[1]!]!
    const family = classes.find((name) => FAMILY.test(name))
    const weight = classes.find((name) => WEIGHT.test(name))
    const leading = classes.find((name) => LEADING.test(name))
    const tracking = classes.find((name) => TRACKING.test(name))
    const set = [size, family, weight, leading, tracking].filter(
      (name): name is string => Boolean(name)
    )
    const key = set.join(" ")
    const style = styles.get(key) ?? {
      classes: set,
      size: px,
      family: family === "font-mono" ? ("mono" as const) : ("sans" as const),
      weight: (weight?.slice(5) ?? "normal") as TypeStyle["weight"],
      leading: leading?.slice(8),
      tracking: tracking?.slice(9),
      uses: 0,
    }
    style.uses++
    styles.set(key, style)
  }
  return [...styles.values()].sort(
    (a, b) =>
      a.size - b.size ||
      a.family.localeCompare(b.family) ||
      a.classes.join(" ").localeCompare(b.classes.join(" "))
  )
}

export interface SpacingUse {
  /** Tailwind spacing step: 2.5 → 10px. */
  step: number
  px: number
  /** Utility stems seen at this step: ["gap", "px", "py"]. */
  utilities: Array<string>
  uses: number
}

const SPACING =
  /^-?(p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me|gap|gap-x|gap-y|space-x|space-y)-(\d+(?:\.\d+)?)$/

/** The Tailwind spacing steps the components use (padding, margin, gap). */
export function spacingSteps(sources: Sources): Array<SpacingUse> {
  const steps = new Map<number, SpacingUse>()
  for (const raw of classStrings(sources))
    for (const name of raw) {
      const match = SPACING.exec(name.split(":").pop()!)
      if (!match) continue
      const step = Number(match[2])
      const use = steps.get(step) ?? {
        step,
        px: step * 4,
        utilities: [],
        uses: 0,
      }
      if (!use.utilities.includes(match[1]!)) use.utilities.push(match[1]!)
      use.uses++
      steps.set(step, use)
    }
  return [...steps.values()].sort((a, b) => a.step - b.step)
}

/** Literal values the components write in brackets: rounded-[7px], px-[18px]. */
export function literalClasses(
  sources: Sources,
  stem: RegExp
): Array<{ name: string; uses: number }> {
  const counts = new Map<string, number>()
  for (const raw of classStrings(sources))
    for (const name of raw) {
      const base = name.split(":").pop()!
      if (stem.test(base)) counts.set(base, (counts.get(base) ?? 0) + 1)
    }
  return [...counts]
    .map(([name, uses]) => ({ name, uses }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
}

/* ── Lucide icons ───────────────────────────────────────────────────── */

export interface IconUse {
  /** The export the code imports: "ArrowRightIcon". */
  name: string
  /** Files that import it. */
  files: Array<string>
  /** strokeWidth values passed where it renders; "default" when none is. */
  strokes: Array<string>
}

/** import { … }, import Default, { … } and export { … } from "lucide-react". */
const LUCIDE_IMPORT =
  /(?:import|export)\s+(type\s+)?(?:\w+\s*,\s*)?\{([^}]*)\}\s*from\s*["']lucide-react["']/g

/** Every value import from lucide-react: name → the local names it's bound to, per file. */
export function lucideImports(
  sources: Sources
): Map<string, Map<string, string>> {
  const imports = new Map<string, Map<string, string>>()
  for (const [path, source] of Object.entries(sources))
    for (const match of source.matchAll(LUCIDE_IMPORT)) {
      if (match[1]) continue
      for (const part of match[2]!.split(",")) {
        const spec = part.trim()
        if (!spec || spec.startsWith("type ")) continue
        const [name, local] = spec.split(/\s+as\s+/).map((s) => s.trim())
        if (!name || /^Lucide[A-Z]|^(?:icons|createLucideIcon)$/.test(name))
          continue
        const byFile = imports.get(name) ?? new Map<string, string>()
        byFile.set(path, local ?? name)
        imports.set(name, byFile)
      }
    }
  return imports
}

/** Every Lucide icon the code imports, where, and the strokes it passes. */
export function iconInventory(sources: Sources): Array<IconUse> {
  return [...lucideImports(sources)]
    .map(([name, byFile]) => {
      const strokes = new Set<string>()
      for (const [path, local] of byFile) {
        const source = sources[path]!
        for (const tag of source.matchAll(
          new RegExp(`<${local}\\b([^>]*)>`, "g")
        )) {
          const stroke = /strokeWidth=\{?["']?([\d.]+)/.exec(tag[1]!)
          strokes.add(stroke ? stroke[1]! : "default")
        }
      }
      return {
        name,
        files: [...byFile.keys()].sort(),
        strokes: strokes.size
          ? [...strokes].sort()
          : ["default (passed as a component)"],
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/* ── Notes beside the motion tokens ─────────────────────────────────── */

/**
 * The comment written beside each token in lib/motion.ts, by table and key:
 * notes.TIMING.card → "L2 context card enter (emphasized decelerate)".
 * A doc comment above a key (EASE, SPRING) counts too.
 */
export function tokenNotes(
  motionSource: string
): Record<string, Record<string, string>> {
  const notes: Record<string, Record<string, string>> = {}
  let table = ""
  let doc = ""
  for (const line of motionSource.split("\n")) {
    const start = /^export const (\w+) = \{/.exec(line)
    if (start) {
      table = start[1]!
      notes[table] = {}
      continue
    }
    if (!table) continue
    if (/^\}/.test(line)) {
      table = ""
      continue
    }
    const comment = /^\s*\/\*\*\s*(.*?)\s*\*\/\s*$/.exec(line)
    if (comment) {
      doc = comment[1]!
      continue
    }
    const entry = /^\s*"?([\w-]+)"?\s*:\s*[^/]*?(?:\/\/\s*(.*))?$/.exec(line)
    if (entry && (entry[2] || doc)) notes[table]![entry[1]!] = entry[2] ?? doc
    doc = ""
  }
  return notes
}

/** Icons the code draws itself with Lucide's createLucideIcon. */
export function customIcons(
  sources: Sources
): Array<{ name: string; lucideName: string; file: string }> {
  const icons: Array<{ name: string; lucideName: string; file: string }> = []
  for (const [file, source] of Object.entries(sources))
    for (const match of source.matchAll(
      /const\s+(\w+)\s*=\s*createLucideIcon\(\s*["']([\w-]+)["']/g
    ))
      icons.push({ name: match[1]!, lucideName: match[2]!, file })
  return icons.sort((a, b) => a.name.localeCompare(b.name))
}
