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
import { securityHeaders, sha256 } from "../src/build/csp";
import {
  CACHE,
  backendHeaders,
  transitionHeaders,
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

// Reason: replacing the CSP before uploading must allow cached pages and the new build,
// while the deploy gate must still refuse a stale or weakened policy.
describe("theme CSP transitions", () => {
  const oldHtml = "<script>oldTheme()</script>";
  const nextHtml = "<script>newTheme()</script>";
  const old = securityHeaders(oldHtml);
  const next = securityHeaders(nextHtml);
  const lines = (headers: Array<[string, string]>) =>
    headers.map(([n, v]) => `${n}: ${v}`);
  const hashes = (headers: Array<[string, string]>) =>
    [...(headers[0]?.[1].match(/'sha256-[^']+'/g) ?? [])].sort();

  test("allows both theme scripts and deduplicates repeated preparation", () => {
    const transition = transitionHeaders(next, oldHtml);
    const policy = transition.find(
      ([name]) => name === "Content-Security-Policy",
    )?.[1];
    expect(policy).toContain(sha256("oldTheme()"));
    expect(policy).toContain(sha256("newTheme()"));
    expect(transitionHeaders(next, oldHtml)).toEqual(transition);
    expect(missingHeaders(transition, lines(transition))).toEqual([]);
    expect(missingHeaders(transition, lines(old)).map(([n]) => n)).toEqual([
      "Content-Security-Policy",
    ]);
    expect(transitionHeaders(next, nextHtml)).toEqual(next);
  });

  // Reason: successive preparations must expire hashes instead of accumulating A+B+C.
  test("allows only the deployed and new themes across A, B, and C", () => {
    const third = securityHeaders("<script>thirdTheme()</script>");
    const ab = transitionHeaders(next, oldHtml);
    const ac = transitionHeaders(third, oldHtml);
    const bc = transitionHeaders(third, nextHtml);
    expect(hashes(ab)).toEqual(
      [sha256("oldTheme()"), sha256("newTheme()")].sort(),
    );
    expect(hashes(ac)).toEqual(
      [sha256("oldTheme()"), sha256("thirdTheme()")].sort(),
    );
    expect(hashes(bc)).toEqual(
      [sha256("newTheme()"), sha256("thirdTheme()")].sort(),
    );
    const accumulated = lines(bc).map((h) =>
      h.replace(
        "script-src 'self'",
        `script-src 'self' ${sha256("oldTheme()")}`,
      ),
    );
    expect(missingHeaders(bc, accumulated).map(([n]) => n)).toEqual([
      "Content-Security-Policy",
    ]);
  });

  // Reason: an unrelated valid hash must not authorize itself through the checked header.
  test("rejects extra hashes and changes to other directives or headers", () => {
    const transition = transitionHeaders(next, oldHtml);
    for (const mutation of [
      (h: string) =>
        h.replace(
          "script-src 'self'",
          `script-src 'self' ${sha256("unrelatedScript()")}`,
        ),
      (h: string) =>
        h.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"),
      (h: string) => h.replace("style-src 'self'", "style-src 'unsafe-inline'"),
      (h: string) => h.replace("connect-src 'none'", "connect-src *"),
      (h: string) =>
        h.replace("script-src 'self'", "script-src 'self' 'sha256-invalid'"),
    ])
      expect(
        missingHeaders(transition, lines(transition).map(mutation)).map(
          ([n]) => n,
        ),
      ).toEqual(["Content-Security-Policy"]);
    expect(
      missingHeaders(
        transition,
        lines(transition).filter((h) => !h.startsWith("X-Frame-Options:")),
      ),
    ).toEqual([["X-Frame-Options", "DENY"]]);
    expect(
      missingHeaders(
        transition,
        lines(transition).map((h) =>
          h.replace("X-Frame-Options: DENY", "X-Frame-Options: SAMEORIGIN"),
        ),
      ),
    ).toEqual([["X-Frame-Options", "DENY"]]);
  });

  // Reason: an absent CSP must not prevent preparation or bypass the deploy gate.
  test("prepares from deployed HTML even when no CSP exists yet", () => {
    const actual = backendHeaders("{}");
    const prepared = transitionHeaders(next, oldHtml);
    expect(actual).toEqual([]);
    expect(hashes(prepared)).toEqual(
      [sha256("oldTheme()"), sha256("newTheme()")].sort(),
    );
    expect(missingHeaders(prepared, actual)).toEqual(prepared);
    expect(missingHeaders(prepared, lines(prepared))).toEqual([]);
  });

  test("refuses deployed HTML without exactly one inline theme script", () => {
    for (const html of [
      "",
      '<script src="theme.js"></script>',
      oldHtml + nextHtml,
    ])
      expect(() => transitionHeaders(next, html)).toThrow(/exactly one/);
  });

  test("validates the backend bucket's header response", () => {
    expect(
      backendHeaders(JSON.stringify({ customResponseHeaders: lines(old) })),
    ).toEqual(lines(old));
    expect(backendHeaders("{}")).toEqual([]);
    for (const json of [
      "null",
      "[]",
      '{"customResponseHeaders":[1]}',
      '{"customResponseHeaders":null}',
      "broken",
    ])
      expect(() => backendHeaders(json)).toThrow();
  });
});
