/**
 * Finds motion values written as literals instead of read from lib/motion.ts
 * (or its generated CSS, styles/motion.css). Comments are skipped, so
 * storyboards can keep quoting times.
 *
 * A literal is any of:
 *   Tailwind   duration-120, delay-150, duration-[140ms], ease-[…],
 *              animate-[…], [animation-duration:900ms]; Tailwind's own loops
 *              (animate-spin, -ping, -pulse, -bounce); and a transition-* or
 *              tw-animate animate-in / animate-out class whose string has no
 *              duration-<token> and ease-<token> (it would run on Tailwind's
 *              150ms and its default curve)
 *   CSS / TS   cubic-bezier(…), 120ms, ease-out / ease-in / ease-in-out /
 *              ease-linear; 1.4s in CSS, or in a TS string that reads as
 *              CSS motion (transition, animation, duration, delay…), never
 *              in copy such as "5s ago"; a bare `linear` easing in CSS
 *   motion     ease: "easeOut" (and the other named easing strings),
 *              ease: [ … ], ms(300), and numeric duration / delay /
 *              stiffness / damping / mass / bounce (and their kin) outside
 *              motion.ts
 * Zero times (duration-0, delay-0, 0s, duration: 0: motion switched off) are
 * not literals. Fixtures are product copy ("waits up to 350ms"), not styling.
 */
import { readFileSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"

import { CSS_UTILITIES } from "../../src/lib/motion"

/** apps/neuve-web: allowlist paths are relative to it. */
export const WEB_ROOT = join(import.meta.dir, "../../../..")

/** Scanned trees (relative to WEB_ROOT) and the file types read in each. */
const SCAN: ReadonlyArray<{ dir: string; ext: RegExp }> = [
  { dir: "packages/ui/src", ext: /\.(tsx?|css)$/ },
  { dir: "packages/ui/.storybook", ext: /\.(tsx?|css)$/ },
  { dir: "apps/web/src", ext: /\.(tsx?|css)$/ },
  // The diffs fork's stylesheets (Pierre upstream + NEUVE FORK rules).
  { dir: "packages/diffs/src", ext: /\.css$/ },
]

/** Fixture data is copy, not styling. */
const SKIP = /^packages\/ui\/src\/fixtures\//

/** The token source and its generated CSS: literals live here by design. */
const SOURCES = new Set([
  "packages/ui/src/lib/motion.ts",
  "packages/ui/src/styles/motion.css",
])

type Scope = "all" | "css" | "ts"

const MOTION_NUMBER_KEYS =
  "duration|delay|repeatDelay|delayChildren|staggerChildren|visualDuration|stiffness|damping|mass|bounce|restDelta|restSpeed"

/** 1.4s, .2s, 0s: a CSS time in seconds. */
const SECONDS = /(?<![\w.$#-])\d*\.?\d+s\b/g

/** A TS string that reads as CSS motion (not product copy such as "5s ago"). */
const CSS_MOTION_STRING = new RegExp(
  [
    "transition|animation|duration|delay|cubic-bezier|var\\(--nv-",
    // a time beside an easing, or after an animatable property
    "\\d*\\.?\\d+m?s\\s+(?:ease|linear|steps|cubic|var)",
    "(?:opacity|transform|scale|translate|rotate|color|box-shadow|filter)\\s+\\d*\\.?\\d+s\\b",
  ].join("|")
)

/** A style-object key whose string value is a CSS time: animationDuration: "0.3s". */
const MOTION_KEY = /(?:animation|transition)\w*["']?\s*:\s*$/

const PATTERNS: ReadonlyArray<{ re: RegExp; scope: Scope }> = [
  {
    re: /(?<![\w-])(?:duration|delay)-(?:\d+|\[[^\]\s]+\])(?![\w-])/g,
    scope: "all",
  },
  { re: /(?<![\w-])(?:ease|animate)-\[[^\]\s]+\]/g, scope: "all" },
  {
    re: /\[(?:animation|transition)-(?:duration|delay|timing-function):[^\]\s]+\]/g,
    scope: "all",
  },
  {
    re: /(?<![\w-])animate-(?:spin|ping|pulse|bounce)(?![\w-])/g,
    scope: "all",
  },
  { re: /cubic-bezier\([^)]*\)/g, scope: "all" },
  { re: /(?<![\w.$-])\d*\.?\d+ms\b/g, scope: "all" },
  { re: SECONDS, scope: "css" },
  { re: /(?<![\w-])ease-(?:in-out|in|out|linear)(?![\w-])/g, scope: "all" },
  {
    re: /\bease:\s*["'](?:linear|easeIn|easeOut|easeInOut|circIn|circOut|circInOut|backIn|backOut|backInOut|anticipate)["']/g,
    scope: "ts",
  },
  { re: /\bease:\s*\[\s*-?\.?\d/g, scope: "ts" },
  // A literal handed to the ms() helper: ms(300) instead of ms(TIMING.x).
  { re: /\bms\(\s*-?\.?\d[\d.]*\s*\)/g, scope: "ts" },
  // A token nudged or scaled by a number: ms(TIMING.hint + 100), ms(2 * x).
  {
    re: /\bms\([^()]*(?:[+\-*/]\s*\.?\d|\d\s*[*/])[^()]*\)/g,
    scope: "ts",
  },
  {
    re: new RegExp(
      `\\b(?:${MOTION_NUMBER_KEYS})\\s*:\\s*-?(?:\\d*\\.)?\\d+(?![\\w.])`,
      "g"
    ),
    scope: "ts",
  },
  // A bare `linear` timing keyword (not linear(), not linear-gradient).
  { re: /(?<![\w.$-])linear(?![\w(-])/g, scope: "css" },
]

const ZERO =
  /^(?:(?:duration|delay)-0|0m?s|(?:[a-zA-Z]+)\s*:\s*-?(?:0*\.)?0+|ms\(\s*0+(?:\.0+)?\s*\))$/

/** Blanks comments, keeping line breaks so line numbers stay true. */
function stripComments(source: string, css: boolean): string {
  const blank = (match: string) => match.replace(/[^\n]/g, " ")
  const block = source.replace(/\/\*[\s\S]*?\*\//g, blank)
  return css ? block : block.replace(/(^|[^:"'`\\])\/\/[^\n]*/g, blank)
}

/** String literals in TS/TSX (approximate: enough for class strings). */
const STRING = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g

const named = (list: ReadonlyArray<string>) => new Set(list)
const DURATIONS = named(CSS_UTILITIES.duration)
const EASES = named(CSS_UTILITIES.ease)

/** A class that animates on Tailwind's defaults unless the string names tokens. */
const IMPLICIT =
  /^(?:transition(?:-(?:all|colors|opacity|shadow|transform)|-\[[^\]]+\])?|animate-(?:in|out))$/

/**
 * transition-* / animate-in classes in a string with no duration-<token> and
 * ease-<token> beside them (variants such as hover: are ignored).
 */
function implicitDefaults(
  code: string
): Array<{ offset: number; text: string }> {
  const found: Array<{ offset: number; text: string }> = []
  for (const match of code.matchAll(STRING)) {
    const classes = match[0].slice(1, -1).split(/\s+/)
    // Copy, not classes: a capitalised word and nothing that looks like a
    // utility ("Page transition"; not "Card transition-colors hover:…").
    if (
      classes.some((name) => /^[A-Z]/.test(name)) &&
      !classes.some((name) => /[-:[]/.test(name))
    )
      continue
    const base = classes.map((name) => name.split(":").pop() ?? "")
    const animated = base.filter((name) => IMPLICIT.test(name))
    if (animated.length === 0) continue
    const hasDuration = base.some(
      (name) => name.startsWith("duration-") && DURATIONS.has(name.slice(9))
    )
    const hasEase = base.some(
      (name) => name.startsWith("ease-") && EASES.has(name.slice(5))
    )
    if (hasDuration && hasEase) continue
    for (const name of animated)
      found.push({
        offset: match.index,
        text: `${name} (no ${hasDuration ? "ease" : "duration"} token)`,
      })
  }
  return found
}

export interface Literal {
  file: string
  line: number
  text: string
}

function* files(): Generator<string> {
  for (const { dir, ext } of SCAN) {
    const root = join(WEB_ROOT, dir)
    for (const entry of readdirSync(root, { recursive: true })) {
      const path = join(root, String(entry))
      const file = relative(WEB_ROOT, path)
      if (!ext.test(file) || /\.test\.tsx?$/.test(file)) continue
      if (SOURCES.has(file) || SKIP.test(file)) continue
      yield file
    }
  }
}

/** Every literal in one file's source (`file` decides CSS or TS rules). */
export function scanSource(file: string, source: string): Array<Literal> {
  const found: Array<Literal> = []
  const css = file.endsWith(".css")
  let code = stripComments(source, css)
  const lineAt = (offset: number) => code.slice(0, offset).split("\n").length
  if (!css) {
    for (const { offset, text } of implicitDefaults(code))
      found.push({ file, line: lineAt(offset), text })
    for (const string of code.matchAll(STRING)) {
      const key = code.slice(Math.max(0, string.index - 40), string.index)
      if (!CSS_MOTION_STRING.test(string[0]) && !MOTION_KEY.test(key)) continue
      for (const time of string[0].matchAll(SECONDS))
        if (!ZERO.test(time[0]))
          found.push({
            file,
            line: lineAt(string.index + time.index),
            text: time[0],
          })
    }
  }
  for (const { re, scope } of PATTERNS) {
    if ((scope === "css" && !css) || (scope === "ts" && css)) continue
    code = code.replace(re, (text, offset: number) => {
      if (!ZERO.test(text)) found.push({ file, line: lineAt(offset), text })
      // Blank the match so a later, looser pattern can't count it twice.
      return " ".repeat(text.length)
    })
  }
  return found
}

export function scanMotionLiterals(): Array<Literal> {
  return [...files()].flatMap((file) =>
    scanSource(file, readFileSync(join(WEB_ROOT, file), "utf8"))
  )
}

/** file → literal text → count. */
export type LiteralCounts = Record<string, Record<string, number>>

export function countLiterals(literals: ReadonlyArray<Literal>): LiteralCounts {
  const counts: LiteralCounts = {}
  for (const { file, text } of literals) {
    const byText = (counts[file] ??= {})
    byText[text] = (byText[text] ?? 0) + 1
  }
  return counts
}

/** Every file the motion tokens reach, token source included. */
function* allFiles(): Generator<string> {
  for (const { dir, ext } of SCAN)
    for (const entry of readdirSync(join(WEB_ROOT, dir), { recursive: true })) {
      const file = relative(WEB_ROOT, join(WEB_ROOT, dir, String(entry)))
      if (ext.test(file)) yield file
    }
}

/**
 * --nv-* custom properties the code reads but nothing defines: not declared
 * in a stylesheet and not set at run time (setProperty or a style-object
 * key). Such a read silently drops its transition or colour.
 */
export function findUndefinedVariables(
  sources: ReadonlyArray<{ file: string; source: string }>
): Array<Literal> {
  const defined = new Set<string>()
  const stripped = sources.map(({ file, source }) => {
    const css = file.endsWith(".css")
    const code = stripComments(source, css)
    // CSS declarations (also inside TS template CSS), setProperty("--nv-…")
    // and style-object keys ("--nv-…": …). A quoted name passed on as an
    // argument or array element is a read, not a definition.
    const declared = css
      ? /(--nv-[\w-]+)\s*:/g
      : /setProperty\(\s*["'](--nv-[\w-]+)["']|(?<=[{,]\s*)["'](--nv-[\w-]+)["']\s*:|(?<!["'\w-])(--nv-[\w-]+)\s*:/g
    for (const match of code.matchAll(declared))
      defined.add((match[1] ?? match[2] ?? match[3])!)
    return { file, code }
  })
  const missing: Array<Literal> = []
  for (const { file, code } of stripped)
    for (const match of code.matchAll(/--nv-[\w-]+/g))
      // A prefix (`--nv-dur-${name}`, "--nv-vt-*") names a family built at
      // run time, not one variable: it can't be checked here.
      if (!defined.has(match[0]) && !match[0].endsWith("-"))
        missing.push({
          file,
          line: code.slice(0, match.index).split("\n").length,
          text: match[0],
        })
  return missing
}

/** findUndefinedVariables over every scanned tree, motion.ts included. */
export function undefinedVariables(): Array<Literal> {
  return findUndefinedVariables(
    [...allFiles()].map((file) => ({
      file,
      source: readFileSync(join(WEB_ROOT, file), "utf8"),
    }))
  )
}
