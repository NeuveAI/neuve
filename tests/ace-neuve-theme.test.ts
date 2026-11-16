import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MONO, SANS } from "../packages/ui/src/components/blocks/constants";

// Ace's Neuve sheet copies part of Neuve's palette; a copy that drifts from the design system
// would show Ace in different colours from the review app beside it.
const root = join(import.meta.dirname, "..");
const theme = readFileSync(
  join(root, "packages/ui/src/styles/neuve.css"),
  "utf8",
);
const source = readFileSync(
  join(root, "apps/neuve-web/packages/ui/src/styles/globals.css"),
  "utf8",
);

/** The `--nv-*` declarations of the first block opened by `selector`. */
function palette(css: string, selector: string) {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThan(-1);
  const body = css.slice(start, css.indexOf("\n}", start));
  const values = new Map<string, string>();
  for (const [, name, value] of body.matchAll(/(--nv-[\w-]+):\s*([^;]+);/g)) {
    values.set(name!, value!.replace(/\s+/g, " ").trim());
  }
  return values;
}

test.each([
  [":root", ":root"],
  [":root.dark", ".dark"],
])("the palette in %s matches Neuve's design system", (ours, theirs) => {
  const copied = palette(theme, ours);
  const neuve = palette(source, theirs);
  expect(copied.size).toBeGreaterThan(20);
  for (const [name, value] of copied) {
    expect({ name, value }).toEqual({ name, value: neuve.get(name)! });
  }
});

test("measured text names the faces the sheet renders", () => {
  const family = (stack: string) =>
    stack.split(",")[0]!.replaceAll("'", "").trim();
  expect(theme).toContain(`font-family: "${family(SANS)}"`);
  expect(theme).toContain(`font-family: "${family(MONO)}"`);
});
