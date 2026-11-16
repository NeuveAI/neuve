/**
 * Renders the Claude Design canvas stylesheet, tokens.css, from the code's
 * sources: the --nv-* colours and shadows of styles/globals.css (light and
 * dark), its radius and font tokens, and the motion tokens of lib/motion.ts.
 * Boards link it (<link rel="stylesheet" href="./tokens.css"> in <helmet>)
 * and switch theme with class="theme-{{theme}}", so light sits on :root and
 * .theme-light, dark on .theme-dark.
 *
 * A temporary alias layer maps the names boards were drawn with (--bg,
 * --raised2, --kw, --stuck-shadow, …) onto the code tokens, so a board keeps
 * working after its own token block is removed. Names with no code token
 * (--bar, --gra, --land0, …) are not aliased: they stay on their board.
 */
import { motionDeclarations } from "./motion-css"

/** Where the canvas export lives, relative to the package root. */
export const CANVAS_TOKENS_PATH =
  "../../../../design/neuve-web/design-export/tokens.css"

/** Board names that differ from the code's, by board name → code token. */
const RENAMED: Record<string, string> = {
  raised2: "raised-2",
  line2: "line-2",
  ink2: "ink-2",
  "req-tint2": "req-tint-2",
  "sug-tint2": "sug-tint-2",
  "agt-tint2": "agt-tint-2",
  kw: "syn-kw",
  st: "syn-st",
  fn: "syn-fn",
  cm: "syn-cm",
  nu: "syn-nu",
  id: "syn-id",
  pl: "syn-pl",
  "stuck-shadow": "shadow-stuck",
  peek: "peek-bg",
}

function block(css: string, selector: string): string {
  const start = css.search(new RegExp(`^${selector}\\s*\\{`, "m"))
  if (start < 0) throw new Error(`globals.css has no ${selector} block`)
  let depth = 0
  for (let index = css.indexOf("{", start); index < css.length; index++) {
    if (css[index] === "{") depth++
    if (css[index] === "}" && --depth === 0)
      return css.slice(css.indexOf("{", start) + 1, index)
  }
  throw new Error(`globals.css: ${selector} block is not closed`)
}

/** name → value for the declarations in a block whose name matches. */
function declarations(body: string, name: RegExp): Array<[string, string]> {
  const clean = body.replace(/\/\*[\s\S]*?\*\//g, "")
  return [...clean.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)]
    .filter((match) => name.test(match[1]!))
    .map((match) => [match[1]!, match[2]!.replace(/\s+/g, " ").trim()])
}

export function renderCanvasTokensCss(globalsCss: string): string {
  const light = declarations(block(globalsCss, ":root"), /^--nv-/)
  const dark = declarations(block(globalsCss, "\\.dark"), /^--nv-/)
  const radius = declarations(block(globalsCss, ":root"), /^--radius$/)
  const theme = block(globalsCss, "@theme inline")
  const scale = declarations(theme, /^--radius-|^--font-(sans|mono)$/)

  // One declaration per line, unwrapped: the canvas file isn't Prettier's.
  const lines = (pairs: Array<[string, string]>) =>
    pairs.map(([name, value]) => `  ${name}: ${value};`)
  const aliases = [
    ...light
      .map(([name]) => name.slice("--nv-".length))
      .map((name): [string, string] => [`--${name}`, `var(--nv-${name})`]),
    ...Object.entries(RENAMED).map(([board, code]): [string, string] => [
      `--${board}`,
      `var(--nv-${code})`,
    ]),
  ]

  return [
    "/*",
    " * GENERATED for the Claude Design canvas by packages/ui/scripts/gen-motion-css.ts",
    " * (`bun run tokens:motion`) from styles/globals.css and lib/motion.ts.",
    " * Do not edit: packages/ui/test/foundations/motion-css.test.ts fails when it drifts.",
    ' * Boards link it from <helmet> and set class="theme-{{theme}}".',
    " */",
    "",
    "/* Colours and shadows, light (the code's :root). */",
    ":root,",
    ".theme-light {",
    "  color-scheme: light;",
    ...lines(light),
    "}",
    "",
    "/* Dark (the code's .dark). */",
    ".theme-dark {",
    "  color-scheme: dark;",
    ...lines(dark),
    "}",
    "",
    "/* Radius, fonts and motion: the same in both themes. */",
    ":root,",
    ".theme-light,",
    ".theme-dark {",
    ...lines(radius),
    ...lines(scale),
    "  --spacing: 0.25rem; /* Tailwind's step: p-2.5 = calc(var(--spacing) * 2.5) */",
    ...motionDeclarations(),
    "}",
    "",
    "/*",
    " * Temporary: the names boards were drawn with, mapped onto the code tokens.",
    " * Declared on each theme element so they follow its theme. Delete once",
    " * every board reads --nv-* directly.",
    " */",
    ":root,",
    ".theme-light,",
    ".theme-dark {",
    ...lines(aliases),
    "}",
    "",
  ].join("\n")
}
