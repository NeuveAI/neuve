import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

import {
  CANVAS_TOKENS_PATH,
  renderCanvasTokensCss,
} from "../../scripts/canvas-tokens"
import { MOTION_CSS_PATH, renderMotionCss } from "../../scripts/motion-css"
import { CSS_DELAYS, PAGE, TIMING } from "../../src/lib/motion"
import allowlist from "./motion-literals.allowlist.json"
import {
  countLiterals,
  findUndefinedVariables,
  scanMotionLiterals,
  scanSource,
  undefinedVariables,
} from "./motion-literals"
import type { LiteralCounts } from "./motion-literals"

const PACKAGE_ROOT = join(import.meta.dir, "../..")

describe("styles/motion.css", () => {
  test("is the generator's output for lib/motion.ts (run `bun run tokens:motion`)", () => {
    const committed = readFileSync(join(PACKAGE_ROOT, MOTION_CSS_PATH), "utf8")
    expect(committed).toBe(renderMotionCss())
  })

  test("names every TIMING key and the page transition set", () => {
    const css = renderMotionCss()
    expect(css).toContain("--nv-dur-surface-tone: 120ms;")
    expect(css).toContain(
      "--transition-duration-surface-tone: var(--nv-dur-surface-tone);"
    )
    for (const key of Object.keys(TIMING)) {
      const name = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
      expect(css).toContain(`--nv-dur-${name}: `)
    }
    expect(css).toContain(`--nv-vt-exit: ${PAGE.exit}ms;`)
    expect(css).toContain(`--nv-vt-stage-1: ${PAGE.exit + PAGE.beat}ms;`)
    expect(css).toContain(
      `--nv-vt-stage-3: ${PAGE.exit + PAGE.beat + 2 * PAGE.stagger}ms;`
    )
  })

  test("gives delay-* utilities only to the keys CSS uses as delays", () => {
    const delays = [
      ...renderMotionCss().matchAll(/--transition-delay-[\w-]+/g),
    ].map(([name]) => name)
    expect(delays).toEqual(
      CSS_DELAYS.map(
        (key) =>
          `--transition-delay-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`
      )
    )
  })

  test("leaves Tailwind's own ease-out / ease-in-out / ease-linear alone", () => {
    const css = renderMotionCss()
    expect(css).not.toMatch(/--ease-(?:out|in-out|linear):/)
    expect(css).toContain("--nv-ease-out: cubic-bezier(0, 0, 0.58, 1);")
  })
})

describe("the canvas tokens.css (design-export)", () => {
  const globals = readFileSync(
    join(PACKAGE_ROOT, "src/styles/globals.css"),
    "utf8"
  )
  const css = renderCanvasTokensCss(globals)

  test("is the generator's output (run `bun run tokens:motion`)", () => {
    expect(readFileSync(join(PACKAGE_ROOT, CANVAS_TOKENS_PATH), "utf8")).toBe(
      css
    )
  })

  test("carries every --nv-* token, light and dark, and the motion tokens", () => {
    const light = css.slice(0, css.indexOf(".theme-dark {"))
    const dark = css.slice(css.indexOf(".theme-dark {"))
    for (const [, name] of globals
      .slice(0, globals.indexOf(".dark {"))
      .matchAll(/^\s*(--nv-[\w-]+)\s*:/gm))
      expect(light).toContain(`${name}:`)
    expect(dark).toContain("--nv-ink: #edeae3;")
    expect(css).toContain(`--nv-dur-card: ${TIMING.card}ms;`)
    expect(css).toContain("--raised2: var(--nv-raised-2);")
    expect(css).toContain("--kw: var(--nv-syn-kw);")
  })
})

describe("motion literals", () => {
  // Every owner group merged ("$comment" is the file's note).
  const allowed: LiteralCounts = Object.assign(
    {},
    ...Object.entries(allowlist)
      .filter(([owner]) => !owner.startsWith("$"))
      .map(([, files]) => files as LiteralCounts)
  )
  const found = scanMotionLiterals()
  const counts = countLiterals(found)

  test("no new literal motion outside lib/motion.ts and the allowlist", () => {
    const added = found.filter(
      ({ file, text }) =>
        (counts[file]?.[text] ?? 0) > (allowed[file]?.[text] ?? 0)
    )
    // Read a TIMING / EASE token instead (duration-surface-tone, ease-standard,
    // var(--nv-dur-*), EASE.out…): see styles/motion.css.
    expect(
      added.map(({ file, line, text }) => `${file}:${line}  ${text}`)
    ).toEqual([])
  })

  test("the allowlist only lists literals that still exist", () => {
    const stale: Array<string> = []
    for (const [file, byText] of Object.entries(allowed))
      for (const [text, count] of Object.entries(byText)) {
        const now = counts[file]?.[text] ?? 0
        if (now < count) stale.push(`${file}  ${text}: ${count} → ${now}`)
      }
    expect(stale).toEqual([])
  })
})

describe("the literal scan", () => {
  const texts = (file: string, source: string) =>
    scanSource(file, source).map(({ text }) => text)

  test("flags motion/react numbers, curves and named eases", () => {
    expect(
      texts(
        "a.tsx",
        `const A = { duration: 0.3, delay: 0.05, ease: [0.4, 0, 0.2, 1] }
         const B = { type: "spring", stiffness: 300, damping: 20, mass: 1 }
         const C = { ease: "easeOut" }`
      )
    ).toEqual([
      'ease: "easeOut"',
      "ease: [0",
      "duration: 0.3",
      "delay: 0.05",
      "stiffness: 300",
      "damping: 20",
      "mass: 1",
    ])
  })

  test("flags Tailwind's implicit defaults and its own loops", () => {
    expect(
      texts(
        "a.tsx",
        `const z = "Page transition"
         const y = "Card transition-colors hover:bg-raised"
         const a = "transition-colors hover:bg-raised"
         const b = "transition-opacity duration-surface-tone"
         const c = "data-open:animate-in data-open:fade-in-0"
         const d = "size-3 animate-spin"`
      )
    ).toEqual([
      "transition-colors (no duration token)",
      "transition-colors (no duration token)",
      "transition-opacity (no ease token)",
      "animate-in (no duration token)",
      "animate-spin",
    ])
  })

  test("flags numbers handed to ms(), alone or added to a token", () => {
    expect(
      texts(
        "a.tsx",
        "const A = { duration: ms(300), delay: ms(TIMING.hint), x: ms(0) }\nconst B = { delay: ms(TIMING.hint + 100), d: ms(TIMING.landHold + TIMING.landFade) }\nconst C = { a: ms(TIMING.card * 2), b: ms(2 * TIMING.card), c: ms(TIMING.card / 2) }"
      )
    ).toEqual([
      "ms(300)",
      "ms(TIMING.hint + 100)",
      "ms(TIMING.card * 2)",
      "ms(2 * TIMING.card)",
      "ms(TIMING.card / 2)",
    ])
  })

  test("flags a style-object time in seconds", () => {
    expect(
      texts(
        "a.tsx",
        'const s = { animationDuration: "0.3s", transitionDelay: \'1s\', label: "5s" }'
      )
    ).toEqual(["0.3s", "1s"])
  })

  test("leaves seconds in product copy alone", () => {
    expect(
      texts(
        "a.tsx",
        'const a = "Updated 5s ago"\nconst b = <span>within 2s</span>'
      )
    ).toEqual([])
  })

  test("flags seconds in CSS-in-TS strings and a bare CSS linear", () => {
    expect(
      texts(
        "a.ts",
        "const a = `transition: opacity 0.2s`\nconst b = 'opacity 0.3s, color 1s'"
      )
    ).toEqual(["0.2s", "0.3s", "1s"])
    expect(texts("a.ts", "const css = `opacity 0.2s, color 1s`")).toEqual([
      "0.2s",
      "1s",
    ])
    expect(
      texts("a.css", ".x { animation: spin 1s linear infinite; }")
    ).toEqual(["1s", "linear"])
  })

  test("leaves tokens, zeros, comments and keyframe data alone", () => {
    expect(
      texts(
        "a.tsx",
        `// duration: 0.3, 120ms, transition-colors
         /* ease: [0.4, 0, 0.2, 1] */
         const a = "transition-colors duration-surface-tone ease-standard"
         const b = "press motion-reduce:transition-none duration-0"
         const c = { duration: 0, times: [0, 0.3, 1], ease: EASE.linear }
         const d = \`opacity var(--nv-dur-hint) var(--nv-ease-ios-out)\`
         const e = cn("motion-safe:animate-working-spin")`
      )
    ).toEqual([])
    expect(
      texts(
        "a.css",
        ".x { background: linear-gradient(red, blue); animation: none 0s; }"
      )
    ).toEqual([])
  })
})

describe("--nv-* variables", () => {
  test("every one the code reads is defined (motion.css, globals.css or at run time)", () => {
    expect(
      undefinedVariables().map(
        ({ file, line, text }) => `${file}:${line}  ${text}`
      )
    ).toEqual([])
  })

  test("a read of a renamed or removed token is caught", () => {
    expect(
      findUndefinedVariables([
        { file: "a.css", source: ":root { --nv-dur-hint: 140ms; }" },
        {
          file: "b.tsx",
          source:
            'el.style.setProperty("--nv-dock-h", "64px")\nconst style = { "--nv-row": "4px" }\nconst css = `.x { --nv-gap: 2px }`\nread("--nv-arg-gone", 1)\nconst list = ["--nv-list-gone", "a"]\nconst pick = on ? "--nv-ternary-gone" : "--nv-row"\nconst a = "pb-[var(--nv-row)] gap-(--nv-gap)"\nconst a = "transition-[opacity] duration-(--nv-dur-hint) pb-[var(--nv-dock-h)]"\nconst css = `opacity var(--nv-dur-gone) var(--nv-ease-gone)`',
        },
      ]).map(({ text }) => text)
    ).toEqual([
      "--nv-arg-gone",
      "--nv-list-gone",
      "--nv-ternary-gone",
      "--nv-dur-gone",
      "--nv-ease-gone",
    ])
  })
})
