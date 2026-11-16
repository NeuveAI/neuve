/**
 * Renders styles/motion.css from lib/motion.ts, so CSS reads the same motion
 * tokens as motion/react. Pure: gen-motion-css.ts writes the result, and
 * test/foundations/motion-css.test.ts checks the committed file against it.
 *
 *   TIMING.surfaceTone   → --nv-dur-surface-tone      duration-surface-tone
 *   CSS_DELAYS           →                            delay-switch-wait
 *   EASE.standard        → --nv-ease-standard         ease-standard
 *   SPRING.snappy        → --nv-spring-snappy (+ -dur) ease-spring-snappy, duration-spring-snappy
 *   CSS_ANIMATIONS       →                            animate-skeleton, animate-working-spin…
 *   OFFSET / SCALE / OPACITY → --nv-offset-* / --nv-scale-* / --nv-opacity-*
 *   SHARE                → --nv-share-* (phased delivery choreography)
 *   PAGE                 → --nv-vt-* (router view transitions)
 * The utility names come from CSS_UTILITIES, which cn() also merges by.
 */
import {
  CSS_ANIMATIONS,
  CSS_UTILITIES,
  EASE,
  OFFSET,
  OPACITY,
  PAGE,
  SCALE,
  SHARE,
  SPRING,
  TIMING,
  cssBezier,
  cssName as kebab,
  cssSpring,
} from "../src/lib/motion"

/** Published path of the generated file, relative to the package root. */
export const MOTION_CSS_PATH = "src/styles/motion.css"

const entries = <T extends object>(table: T) =>
  Object.entries(table) as Array<[string, T[keyof T]]>

const WIDTH = 80

/** One declaration, wrapped the way Prettier wraps it (the file stays clean). */
export function decl(name: string, value: string): string {
  const line = `  ${name}: ${value};`
  if (line.length <= WIDTH) return line
  const call = /^(linear|var)\((.*)\)$/.exec(value)
  if (call) {
    const args = call[2]!.split(", ").map((arg) => `    ${arg}`)
    return [`  ${name}: ${call[1]}(`, args.join(",\n"), "  );"].join("\n")
  }
  const words = value.split(" ")
  const lines = [`  ${name}: ${words[0]}`]
  words.slice(1).forEach((word, index) => {
    const end = index === words.length - 2 ? ";" : ""
    const last = lines.length - 1
    if (`${lines[last]} ${word}${end}`.length <= WIDTH)
      lines[last] = `${lines[last]} ${word}`
    else lines.push(`    ${word}`)
  })
  return `${lines.join("\n")};`
}

/** The --nv-* motion custom properties, one declaration per line. */
export function motionDeclarations(): Array<string> {
  const root: Array<string> = []
  const prop = (name: string, value: string) =>
    root.push(decl(`--nv-${name}`, value))

  root.push("  /* TIMING */")
  for (const [key, value] of entries(TIMING))
    prop(`dur-${kebab(key)}`, `${value}ms`)

  root.push("  /* EASE */")
  for (const [key, curve] of entries(EASE))
    prop(`ease-${kebab(key)}`, cssBezier(curve))

  root.push("  /* SPRING: a linear() easing and its settle time */")
  for (const [key, spring] of entries(SPRING)) {
    const css = cssSpring(spring)
    prop(`spring-${kebab(key)}`, css.easing)
    prop(`spring-${kebab(key)}-dur`, `${css.duration}ms`)
  }

  root.push("  /* OFFSET */")
  for (const [key, value] of entries(OFFSET))
    prop(`offset-${kebab(key)}`, `${value}px`)
  root.push("  /* SCALE */")
  for (const [key, value] of entries(SCALE))
    prop(`scale-${kebab(key)}`, `${value}`)
  root.push("  /* OPACITY */")
  for (const [key, value] of entries(OPACITY))
    prop(`opacity-${kebab(key)}`, `${value}`)
  root.push("  /* SHARE: shares of a movement */")
  for (const [key, value] of entries(SHARE))
    prop(`share-${kebab(key)}`, `${value}`)

  root.push("  /* PAGE: router view transitions */")
  for (const [key, value] of entries(PAGE))
    prop(`vt-${kebab(key)}`, `${value}${key.endsWith("Offset") ? "px" : "ms"}`)
  const stage1 = PAGE.exit + PAGE.beat
  prop("vt-stage-1", `${stage1}ms`)
  prop("vt-stage-2", `${stage1 + PAGE.stagger}ms`)
  prop("vt-stage-3", `${stage1 + 2 * PAGE.stagger}ms`)
  return root
}

export function renderMotionCss(): string {
  const root = motionDeclarations()
  const theme: Array<string> = []
  const themeKey = (name: string, value: string) =>
    theme.push(decl(name, value))

  // A spring's duration is its settle time; every other name is a TIMING key.
  const durationVar = (name: string) =>
    name.startsWith("spring-")
      ? `var(--nv-${name}-dur)`
      : `var(--nv-dur-${name})`
  for (const name of CSS_UTILITIES.duration)
    themeKey(`--transition-duration-${name}`, durationVar(name))
  for (const name of CSS_UTILITIES.delay)
    themeKey(`--transition-delay-${name}`, `var(--nv-dur-${name})`)
  for (const name of CSS_UTILITIES.ease)
    themeKey(
      `--ease-${name}`,
      name.startsWith("spring-")
        ? `var(--nv-${name})`
        : `var(--nv-ease-${name})`
    )
  for (const [name, value] of entries(CSS_ANIMATIONS))
    themeKey(`--animate-${name}`, value)

  return [
    "/*",
    " * GENERATED from src/lib/motion.ts by scripts/gen-motion-css.ts",
    " * (`bun run tokens:motion`). Do not edit: test/foundations/motion-css.test.ts",
    " * fails when this file and motion.ts disagree.",
    " *",
    " * Utilities: duration-<timing>, delay-<css delay>, ease-<ease>,",
    " * ease-spring-<spring> with duration-spring-<spring>, animate-<loop>.",
    " * EASE.out, inOut and linear are variables only (var(--nv-ease-out)):",
    " * Tailwind's ease-out, ease-in-out and ease-linear keep their own curves.",
    " */",
    ":root {",
    ...root,
    "}",
    "",
    "@theme inline {",
    ...theme,
    "}",
    "",
  ].join("\n")
}
