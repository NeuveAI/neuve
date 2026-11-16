/**
 * Writes styles/motion.css from lib/motion.ts, and the canvas's tokens.css
 * (design/neuve-web/design-export) from globals.css and motion.ts:
 * `bun run tokens:motion [more canvas folders…]`. Each extra folder (a local
 * copy of the canvas project) gets the same tokens.css.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { CANVAS_TOKENS_PATH, renderCanvasTokensCss } from "./canvas-tokens"
import { MOTION_CSS_PATH, renderMotionCss } from "./motion-css"

const at = (path: string) => new URL(`../${path}`, import.meta.url)

writeFileSync(at(MOTION_CSS_PATH), renderMotionCss())
console.log(`wrote ${MOTION_CSS_PATH}`)

const tokens = renderCanvasTokensCss(
  readFileSync(at("src/styles/globals.css"), "utf8")
)
for (const target of [
  at(CANVAS_TOKENS_PATH),
  ...process.argv.slice(2).map((dir) => join(dir, "tokens.css")),
]) {
  writeFileSync(target, tokens)
  console.log(`wrote ${target instanceof URL ? target.pathname : target}`)
}
