import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { csp, inlineScripts, sha256 } from "../src/build/csp";
import {
  BATCH,
  DESK,
  HERO,
  AGENTS,
  HEADING,
  OPEN,
  CLOSE,
} from "../src/content";
import { render } from "../src/entry-server";
import { READY_MS, THEME_INIT, THEME_STORAGE_KEY } from "../src/theme-init";
import { fill } from "../src/build/html";

const template = await Bun.file(
  new URL("../index.html", import.meta.url),
).text();
const page = fill(template, render());

describe("the prerendered page", () => {
  // Reason: the H1 is the page's largest paint and every section must read without JavaScript.
  test("holds the headline and every section heading as HTML", () => {
    expect(page).toContain(
      `${HERO.headlineLead}<span class="landmark"><span class="hl">${HERO.headlineMark}</span></span>`,
    );
    for (const heading of [
      BATCH.title,
      DESK.title,
      AGENTS.title,
      HEADING.title,
      OPEN.title,
      CLOSE.title,
    ])
      expect(page).toContain(heading.replace(/'/g, "&#x27;"));
  });

  // Reason: "no third-party anything at runtime". Only outbound <a> links, and the canonical
  // address (which browsers don't fetch), may point elsewhere.
  test("loads nothing from another origin", () => {
    const loads = [
      ...page.matchAll(
        /<(?!a\b)([a-z]+)\b([^>]*)\s(?:src|href|srcset)="([^"]*)"/gi,
      ),
    ]
      .filter((m) => !/rel="canonical"/.test(m[0]))
      .map((m) => m[3] ?? "");
    expect(loads.length).toBeGreaterThan(4);
    expect(
      loads.filter(
        (url) =>
          !(
            url.startsWith("/") ||
            url.startsWith("#") ||
            url.startsWith("data:")
          ),
      ),
    ).toEqual([]);
  });

  // Reason: the CSP forbids inline style attributes, so any in the markup would be dropped in production.
  test("carries no inline style attributes", () => {
    expect(page).not.toMatch(/\sstyle="/);
  });
});

describe("the content security policy", () => {
  // Reason: a stale hash breaks the theme on deploy; a missing one would need 'unsafe-inline'.
  test("allows exactly the inline theme script, by its hash", () => {
    expect(inlineScripts(page)).toEqual([THEME_INIT]);
    const policy = csp(page);
    expect(policy).toContain(`script-src 'self' ${sha256(THEME_INIT)}`);
    expect(policy).not.toContain("unsafe-inline");
    expect(policy).toContain("frame-ancestors 'none'");
  });

  // Reason: the policy enforces Trusted Types with no policy, so one HTML-string
  // write in any browser script (+= and bracket writes too) would throw in Chromium and leave that part dead.
  test("enforces Trusted Types, and no browser script writes HTML strings", async () => {
    expect(csp(page)).toContain("require-trusted-types-for 'script'");
    const glob = new Bun.Glob("**/*.ts");
    const dir = fileURLToPath(new URL("../src/", import.meta.url));
    const writers: string[] = [];
    for await (const f of glob.scan(dir)) {
      const src = await Bun.file(dir + f).text();
      if (
        /\b(innerHTML|outerHTML)\b|insertAdjacentHTML|document\.write|setHTMLUnsafe|createContextualFragment/.test(
          src,
        )
      )
        writers.push(f);
    }
    expect(writers).toEqual([]);
  });
});

describe("the theme script", () => {
  // Reason: first paint must not flash the wrong theme, and storage can throw (private windows).
  const run = (stored: string | null | "throws", systemDark: boolean) => {
    const classes = new Set<string>();
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const document = {
      documentElement: {
        classList: {
          add: (c: string) => classes.add(c),
          remove: (c: string) => classes.delete(c),
          contains: (c: string) => classes.has(c),
        },
      },
    };
    const localStorage = {
      getItem: (k: string) => {
        if (stored === "throws") throw new Error("blocked");
        return k === THEME_STORAGE_KEY ? stored : null;
      },
    };
    const window = {
      matchMedia: (q: string) => ({
        matches: systemDark && q.includes("dark"),
      }),
    };
    const setTimeout = (fn: () => void, ms: number) => timers.push({ fn, ms });
    new Function(
      "document",
      "window",
      "localStorage",
      "setTimeout",
      THEME_INIT,
    )(document, window, localStorage, setTimeout);
    return Object.assign(classes, { timers });
  };
  test("a pinned theme wins over the system", () => {
    expect(run("dark", false).has("dark")).toBe(true);
    expect(run("light", true).has("dark")).toBe(false);
  });
  test("with nothing pinned, or storage blocked, it follows the system", () => {
    expect(run(null, true).has("dark")).toBe(true);
    expect(run(null, false).has("dark")).toBe(false);
    expect(run("throws", true).has("dark")).toBe(true);
  });
  test("it marks the page as scripted before first paint", () => {
    expect(run(null, false).has("js")).toBe(true);
  });
  // Reason: every starting state hangs on .js, so a bundle that never runs must not leave the page half-hidden.
  test("if the bundle never marks the page live, the page goes back to its rendered state", () => {
    const failed = run(null, false);
    expect(failed.timers.map((t) => t.ms)).toEqual([READY_MS]);
    failed.timers[0]!.fn();
    expect(failed.has("js")).toBe(false);
    const ok = run(null, false);
    ok.add("live");
    ok.timers[0]!.fn();
    expect(ok.has("js")).toBe(true);
  });
});

describe("the prerender", () => {
  // Reason: a slot the formatter split silently shipped a page without its theme script (review 1, F1).
  test("refuses a template with a missing slot", () => {
    expect(() => fill(template.replace("<!--theme-init-->", ""), "x")).toThrow(
      /theme-init/,
    );
    expect(() => fill(template.replace("<!--app-->", ""), "x")).toThrow(/app/);
  });
});
