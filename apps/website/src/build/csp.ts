import { createHash } from "node:crypto";

/** The body of every inline <script> (no src) in an HTML document. */
export function inlineScripts(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1] ?? "";
    if (/\bsrc\s*=/.test(attrs)) continue;
    out.push(m[2] ?? "");
  }
  return out;
}

export const sha256 = (text: string) =>
  `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

/**
 * The Content-Security-Policy for the page: everything same-origin, inline
 * scripts allowed only by hash, no inline styles, no frames, no plugins.
 */
export function csp(html: string): string {
  const hashes = inlineScripts(html).map(sha256);
  return [
    "default-src 'self'",
    `script-src 'self' ${hashes.join(" ")}`.trim(),
    "style-src 'self'",
    "img-src 'self'",
    "font-src 'self'",
    "connect-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    // No script writes HTML strings, so no Trusted Types policy is needed;
    // browsers without Trusted Types ignore these two (modern-web-guidance: security).
    "require-trusted-types-for 'script'",
    "trusted-types 'none'",
  ].join("; ");
}

/**
 * The headers every response carries. Cloud Storage can't set them on objects,
 * so the load balancer's backend bucket adds them; scripts/deploy-gcp.ts checks
 * them before each upload. Caching and content types are object metadata
 * instead, which that script sets per file.
 */
export function securityHeaders(
  html: string,
): Array<[name: string, value: string]> {
  return [
    ["Content-Security-Policy", csp(html)],
    ["X-Content-Type-Options", "nosniff"],
    ["Referrer-Policy", "strict-origin-when-cross-origin"],
    [
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    ],
    ["Cross-Origin-Opener-Policy", "same-origin"],
    // For browsers that predate CSP frame-ancestors.
    ["X-Frame-Options", "DENY"],
  ];
}

/** Keep deployed inline-script hashes while pages from the previous build are cached. */
export function withScriptHashes(policy: string, deployed: string): string {
  const script = /(?:^|;\s*)script-src\s+([^;]*)/.exec(deployed)?.[1] ?? "";
  const hashes = script
    .split(/\s+/)
    .filter((token) => /^'sha256-[A-Za-z0-9+/]{43}='$/.test(token));
  return policy.replace(
    /(^|;\s*)script-src\s+([^;]*)/,
    (_, prefix: string, sources: string) => {
      const tokens = sources.trim().split(/\s+/);
      const all = [...new Set([...tokens, ...hashes])];
      const kept = all.filter(
        (token) => !/^'sha256-[A-Za-z0-9+/]{43}='$/.test(token),
      );
      const allowed = all
        .filter((token) => /^'sha256-[A-Za-z0-9+/]{43}='$/.test(token))
        .sort();
      return `${prefix}script-src ${[...kept, ...allowed].join(" ")}`;
    },
  );
}
