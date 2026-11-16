/**
 * Fills dist/index.html with the rendered page, the meta tags and the inline
 * theme script, then writes dist/_headers with a CSP that allows that script
 * by its hash. Runs after `vite build` and `vite build --ssr`.
 */
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { headersFile } from "../src/build/csp";
import { fill } from "../src/build/html";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
const ssr = join(root, "dist-ssr");

/** The Latin subsets of Geist and Geist Mono, the only ones the page's copy needs. */
const FIRST_SCREEN_FONTS = [
  /^geist-latin-wght-normal-.+\.woff2$/,
  /^geist-mono-latin-wght-normal-.+\.woff2$/,
];

function firstScreenFonts(): string[] {
  const assets = readdirSync(join(dist, "assets"));
  return FIRST_SCREEN_FONTS.map((re) => {
    const name = assets.find((f) => re.test(f));
    if (!name) throw new Error(`no font in dist/assets matches ${re}`);
    return `/assets/${name}`;
  });
}

if (import.meta.main) {
  const { render } = (await import(join(ssr, "entry-server.js"))) as {
    render: () => string;
  };
  const template = await Bun.file(join(dist, "index.html")).text();
  if (!template.includes("<!--app-->"))
    throw new Error(
      "dist/index.html has no <!--app--> slot: run vite build first",
    );
  const html = fill(template, render(), firstScreenFonts());
  await Bun.write(join(dist, "index.html"), html);
  await Bun.write(join(dist, "404.html"), html);
  await Bun.write(join(dist, "_headers"), headersFile(html));
  rmSync(ssr, { recursive: true, force: true });
  console.log(
    `prerendered dist/index.html (${html.length} bytes) and dist/_headers`,
  );
}
