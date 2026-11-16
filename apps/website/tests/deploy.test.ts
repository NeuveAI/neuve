import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { securityHeaders } from "../src/build/csp";
import {
  CACHE,
  builtFiles,
  metadata,
  missingHeaders,
  uploads,
} from "../src/build/deploy";
import { INSTALLER, unstamped } from "../src/build/installer";

const site = fileURLToPath(new URL("..", import.meta.url));

describe("the build", () => {
  // Reason: `curl -fsSL https://neuve.ai/install.sh | sh` is the README's install line, and
  // neuve.ai now serves that file itself, so the build must carry the repository's own copy.
  test("puts the repository's unstamped installer at dist/install.sh", async () => {
    const build = Bun.spawn(["bun", "run", "build"], {
      cwd: site,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, err] = await Promise.all([
      build.exited,
      new Response(build.stderr).text(),
    ]);
    expect(code, err).toBe(0);
    const dist = join(site, "dist");
    const served = await Bun.file(join(dist, "install.sh")).bytes();
    expect(served).toEqual(await Bun.file(INSTALLER).bytes());
    expect(unstamped(new TextDecoder().decode(served))).toBe(true);
    // The Cloudflare files are gone; Cloud Storage would serve them as pages.
    expect(existsSync(join(dist, "_headers"))).toBe(false);
    expect(existsSync(join(dist, "_redirects"))).toBe(false);
    expect(builtFiles(dist)).toContain("install.sh");
  }, 120_000);
});

describe("the deploy", () => {
  const fixture = (installer: string | null) => {
    const dir = mkdtempSync(join(tmpdir(), "neuve-site-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets", "index-abc.js"), "");
    writeFileSync(join(dir, "index.html"), "");
    writeFileSync(join(dir, "404.html"), "");
    if (installer !== null) writeFileSync(join(dir, "install.sh"), installer);
    return dir;
  };

  // Reason: a deploy without the installer, or with a stale one, breaks the install line.
  test("refuses a build without the repository's installer", async () => {
    const missing = fixture(null);
    const stale = fixture("#!/bin/sh\n");
    const good = fixture(await Bun.file(INSTALLER).text());
    try {
      expect(() => builtFiles(missing)).toThrow(/no install\.sh/);
      expect(() => builtFiles(stale)).toThrow(/differs/);
      expect(builtFiles(good).sort()).toEqual([
        "404.html",
        "assets/index-abc.js",
        "index.html",
        "install.sh",
      ]);
    } finally {
      for (const d of [missing, stale, good])
        rmSync(d, { recursive: true, force: true });
    }
  });

  // Reason: a year-long cache on the page or the installer would pin old copies in browsers and
  // caches; a wrong type is refused outright because the load balancer sends nosniff.
  test("caches hashed assets for a year, and the page and installer briefly", () => {
    expect(metadata("assets/index-abc.js")).toEqual({
      cacheControl: CACHE.immutable,
      contentType: "text/javascript; charset=utf-8",
    });
    for (const page of ["index.html", "404.html"])
      expect(metadata(page).cacheControl).toBe(CACHE.short);
    expect(metadata("install.sh")).toEqual({
      cacheControl: CACHE.short,
      contentType: "text/plain; charset=utf-8",
    });
    expect(metadata("screens/desk-dark@2x.webp")).toEqual({
      cacheControl: CACHE.hour,
      contentType: "image/webp",
    });
    expect(() => metadata("_headers")).toThrow(/type the deploy doesn't know/);
  });

  // Reason: a page uploaded before its assets would name files the bucket doesn't have yet.
  test("uploads every file once, assets first and pages last", () => {
    const files = [
      "index.html",
      "404.html",
      "install.sh",
      "favicon.svg",
      "screens/desk-dark@2x.webp",
      "assets/index-abc.js",
      "assets/index-abc.css",
    ];
    const plan = uploads(files);
    expect(plan.flatMap((u) => u.files).sort()).toEqual([...files].sort());
    expect(plan[0]!.dir).toBe("assets");
    const last = plan
      .slice(-2)
      .flatMap((u) => u.files)
      .sort();
    expect(last).toEqual(["404.html", "index.html", "install.sh"]);
    for (const u of plan)
      for (const f of u.files)
        expect(metadata(f)).toEqual({
          cacheControl: u.cacheControl,
          contentType: u.contentType,
        });
  });

  // Reason: a stale CSP on the load balancer would block the new page's theme script.
  test("finds a header the backend bucket doesn't send exactly", () => {
    const expected = securityHeaders("<script>x</script>");
    const sent = expected.map(([n, v]) => `${n.toLowerCase()}:${v}`);
    expect(missingHeaders(expected, sent)).toEqual([]);
    const stale = sent.map((h) =>
      h.startsWith("content-security-policy") ? `${h} 'unsafe-inline'` : h,
    );
    expect(missingHeaders(expected, stale).map(([n]) => n)).toEqual([
      "Content-Security-Policy",
    ]);
    expect(missingHeaders(expected, [])).toHaveLength(expected.length);
  });
});
