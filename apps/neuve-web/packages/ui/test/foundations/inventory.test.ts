import { readFileSync, readdirSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, test } from "bun:test"
import * as Lucide from "lucide-react"

import {
  customIcons,
  iconInventory,
  isShadow,
  lucideImports,
  spacingSteps,
  themeTokens,
  tokenNotes,
  typeStyles,
} from "../../src/foundations/inventory"
import type { Sources } from "../../src/foundations/inventory"
import { EASE, SPRING, TIMING } from "../../src/lib/motion"

const WEB_ROOT = join(import.meta.dir, "../../../..")

/** The same files src/foundations/sources.ts hands the stories. */
function codeSources(): Sources {
  const sources: Sources = {}
  for (const dir of ["packages/ui/src", "apps/web/src"])
    for (const entry of readdirSync(join(WEB_ROOT, dir), { recursive: true })) {
      const file = relative(WEB_ROOT, join(WEB_ROOT, dir, String(entry)))
      if (!/\.tsx?$/.test(file)) continue
      if (/\.stories\.tsx$|\.test\.tsx?$|routeTree\.gen\.ts$/.test(file))
        continue
      if (/^packages\/ui\/src\/(fixtures|foundations)\//.test(file)) continue
      // Story-only code: the story kit and its story-state shims.
      if (
        /^packages\/ui\/src\/neuve\/(story-kit\/|.*\/story-state\.tsx$)/.test(
          file
        )
      )
        continue
      if (/^apps\/web\/src\/server\//.test(file)) continue
      sources[file] = readFileSync(join(WEB_ROOT, file), "utf8")
    }
  return sources
}

const SOURCES = codeSources()
const GLOBALS = readFileSync(
  join(WEB_ROOT, "packages/ui/src/styles/globals.css"),
  "utf8"
)

describe("the Icons sheet", () => {
  const sheet = new Set(iconInventory(SOURCES).map((icon) => icon.name))

  test("lists every icon imported from lucide-react", () => {
    const imported = new Set<string>()
    for (const source of Object.values(SOURCES))
      for (const match of source.matchAll(
        /(?:import|export)\s+(?:\w+\s*,\s*)?\{([^}]*)\}\s*from\s*["']lucide-react["']/g
      ))
        for (const spec of match[1]!.split(",")) {
          const name = spec
            .trim()
            .split(/\s+as\s+/)[0]!
            .trim()
          // The icon factory isn't an icon: its icons are on the custom list.
          if (
            name &&
            !name.startsWith("type ") &&
            name !== "LucideIcon" &&
            name !== "createLucideIcon"
          )
            imported.add(name)
        }
    expect(imported.size).toBeGreaterThan(30)
    expect([...imported].filter((name) => !sheet.has(name))).toEqual([])
  })

  test("only named imports and re-exports, which the sheet can read", () => {
    // Every statement naming lucide-react must be `import { … }`,
    // `import type { … }` or `export { … }`: a default, namespace, deep-path
    // or dynamic import would hide its icons from the sheet.
    const allowed =
      /^(?:import|export)(?:\s+type)?\s*\{[^}]*\}\s*from\s*["']lucide-react["']$/
    const offending = (source: string) =>
      [
        ...source.matchAll(
          /(?:import|export)(?:\s+type)?\s*(?:[\w$]+\s*,\s*)?(?:\*\s*as\s+[\w$]+|[\w$]+|\{[^}]*\})\s*from\s*["']lucide-react[^"']*["']|import\(\s*["']lucide-react[^"']*["']/g
        ),
      ]
        .map((match) => match[0].replace(/\s+/g, " "))
        .filter((statement) => !allowed.test(statement))
    expect(
      Object.entries(SOURCES).flatMap(([file, source]) =>
        offending(source).map((statement) => `${file}: ${statement}`)
      )
    ).toEqual([])
    expect(
      offending(
        'import Lucide, { XIcon } from "lucide-react"\nimport * as L from "lucide-react"\nimport { X } from "lucide-react/dynamic"\nconst m = import("lucide-react")\nexport { CheckIcon } from "lucide-react"'
      )
    ).toEqual([
      'import Lucide, { XIcon } from "lucide-react"',
      'import * as L from "lucide-react"',
      'import { X } from "lucide-react/dynamic"',
      'import("lucide-react"',
    ])
  })

  test("reads default-plus-named imports and re-exports", () => {
    expect(
      iconInventory({
        "a.tsx":
          'import Lucide, { AnchorIcon } from "lucide-react"\nconst a = <AnchorIcon />',
        "b.ts": 'export { CheckIcon } from "lucide-react"',
      }).map((icon) => icon.name)
    ).toEqual(["AnchorIcon", "CheckIcon"])
  })

  test("lists the icons drawn with createLucideIcon", () => {
    const custom = customIcons(SOURCES)
    const factories = Object.values(SOURCES)
      .join("\n")
      .match(/=\s*createLucideIcon\(/g)
    expect(custom.length).toBe(factories?.length ?? 0)
  })

  test("every listed icon is a lucide-react export", () => {
    const library = Lucide as Record<string, unknown>
    expect([...sheet].filter((name) => !library[name])).toEqual([])
  })

  test("reads aliases, type imports and the strokes passed", () => {
    const icons = iconInventory({
      "a.tsx": `import { CheckIcon as Check, XIcon, type LucideIcon } from "lucide-react"
        const a = <Check strokeWidth={2.5} />
        const b = <XIcon className="size-3" />`,
      "b.tsx": `import type { LucideProps } from "lucide-react"
        import { XIcon } from "lucide-react"
        const c = <XIcon strokeWidth={1.75} />`,
    })
    expect(icons).toEqual([
      { name: "CheckIcon", files: ["a.tsx"], strokes: ["2.5"] },
      {
        name: "XIcon",
        files: ["a.tsx", "b.tsx"],
        strokes: ["1.75", "default"],
      },
    ])
    expect([
      ...lucideImports({
        "c.ts": 'import { type LucideIcon } from "lucide-react"',
      }),
    ]).toEqual([])
  })
})

describe("the token sheets", () => {
  test("Colour and Shadow read every --nv-* token on :root, with a dark value", () => {
    const declared = new Set(
      [...GLOBALS.split(".dark {")[0]!.matchAll(/^\s*--(nv-[\w-]+)\s*:/gm)].map(
        (match) => match[1]!
      )
    )
    const tokens = themeTokens(GLOBALS)
    expect(new Set(tokens.map((token) => token.name))).toEqual(declared)
    expect(tokens.filter(isShadow).length).toBe(5)
    expect(tokens.find((t) => t.name === "nv-ink")).toEqual({
      name: "nv-ink",
      light: "#1c1a16",
      dark: "#edeae3",
    })
  })

  test("Type and Spacing find the classes the components use", () => {
    const styles = typeStyles(SOURCES)
    expect(styles.length).toBeGreaterThan(20)
    expect(styles.some((style) => style.classes[0] === "label-mono")).toBe(true)
    expect(
      typeStyles({
        "a.tsx": 'const a = "text-[12.5px] font-mono leading-[18px] text-ink"',
      })
    ).toEqual([
      {
        classes: ["text-[12.5px]", "font-mono", "leading-[18px]"],
        size: 12.5,
        family: "mono",
        weight: "normal",
        leading: "[18px]",
        tracking: undefined,
        uses: 1,
      },
    ])
    expect(spacingSteps(SOURCES).map((use) => use.step)).toContain(2.5)
  })

  test("Motion has a note for every TIMING, EASE and SPRING key", () => {
    const notes = tokenNotes(
      readFileSync(join(WEB_ROOT, "packages/ui/src/lib/motion.ts"), "utf8")
    )
    const missing = (table: string, keys: Array<string>) =>
      keys.filter((key) => !notes[table]?.[key]).map((key) => `${table}.${key}`)
    expect([
      ...missing("TIMING", Object.keys(TIMING)),
      ...missing("SPRING", Object.keys(SPRING)),
    ]).toEqual([])
    expect(Object.keys(notes.EASE ?? {}).length).toBeGreaterThan(0)
    expect(Object.keys(EASE).length).toBeGreaterThan(0)
  })
})
