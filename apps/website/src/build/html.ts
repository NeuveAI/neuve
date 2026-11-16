/**
 * The page's HTML shell: the meta tags and the inline theme script, filled
 * into index.html's three slots. Used by scripts/prerender.ts for the build
 * and by vite.config.ts for `vite dev`, so both serve the same page.
 */
import { META, SITE_URL } from "../content";
import { THEME_INIT } from "../theme-init";

const escape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export function headTags(): string {
  return [
    `<title>${escape(META.title)}</title>`,
    `<meta name="description" content="${escape(META.description)}" />`,
    `<link rel="canonical" href="${SITE_URL}/" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="Neuve" />`,
    `<meta property="og:title" content="${escape(META.title)}" />`,
    `<meta property="og:description" content="${escape(META.description)}" />`,
    `<meta property="og:url" content="${SITE_URL}/" />`,
    `<meta property="og:image" content="${META.ogImage}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta property="og:image:alt" content="${escape(META.ogImageAlt)}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${escape(META.title)}" />`,
    `<meta name="twitter:description" content="${escape(META.description)}" />`,
    `<meta name="twitter:image" content="${META.ogImage}" />`,
    `<meta name="twitter:image:alt" content="${escape(META.ogImageAlt)}" />`,
  ].join("\n    ");
}

export const SLOTS = [
  "<!--head-->",
  "<!--theme-init-->",
  "<!--app-->",
] as const;

/**
 * Preloads for the fonts the first screen paints with. Without them the browser
 * finds the fonts only once the stylesheet has arrived, and the headline paints
 * in the fallback face first (modern-web-guidance: optimize-preload-priority).
 */
export const fontPreloads = (hrefs: string[]) =>
  hrefs.map(
    (href) =>
      `<link rel="preload" href="${href}" as="font" type="font/woff2" crossorigin />`,
  );

/** Fills the template's three slots; a missing slot is an error, never a silent no-op. */
export function fill(
  template: string,
  app: string,
  fonts: string[] = [],
): string {
  for (const slot of SLOTS)
    if (!template.includes(slot))
      throw new Error(`index.html has no ${slot} slot`);
  return template
    .replace("<!--head-->", [headTags(), ...fontPreloads(fonts)].join("\n    "))
    .replace("<!--theme-init-->", `<script>${THEME_INIT}</script>`)
    .replace("<!--app-->", app);
}
