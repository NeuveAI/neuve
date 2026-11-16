/**
 * What scripts/deploy-gcp.ts uploads, and with which object metadata. Kept
 * apart from the script so tests can check the plan without Google Cloud.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, posix, relative, sep } from "node:path";
import { INSTALLER } from "./installer";

export const CACHE = {
  /** Vite names these files by their content hash, so a name never changes meaning. */
  immutable: "public, max-age=31536000, immutable",
  /** The page and the installer: a deploy shows within five minutes. */
  short: "public, max-age=300",
  /** Fixed names that rarely change: icons, robots.txt, the desk screenshots. */
  hour: "public, max-age=3600",
} as const;

/**
 * Every type the build emits. A file of any other type stops the deploy
 * rather than being guessed at, because the load balancer sends nosniff.
 */
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
  // Plain text, so a browser shows the script for reading instead of downloading it.
  ".sh": "text/plain; charset=utf-8",
};

export type ObjectMetadata = { cacheControl: string; contentType: string };

/** The metadata for one file, by its path inside dist/ ("assets/x.js"). */
export function metadata(path: string): ObjectMetadata {
  const contentType = TYPES[extname(path)];
  if (!contentType)
    throw new Error(
      `dist/${path} has a type the deploy doesn't know; add it to TYPES in src/build/deploy.ts`,
    );
  const cacheControl = path.startsWith("assets/")
    ? CACHE.immutable
    : path.endsWith(".html") || path === "install.sh"
      ? CACHE.short
      : CACHE.hour;
  return { cacheControl, contentType };
}

/** One `gcloud storage cp`: files of one folder that share their metadata. */
export type Upload = ObjectMetadata & { dir: string; files: string[] };

/**
 * The uploads in order: hashed assets first, then the other files, and the
 * pages and the installer last, so a new page never names a missing asset.
 * Nothing is deleted, so pages still cached elsewhere keep their old assets.
 */
export function uploads(paths: string[]): Upload[] {
  const stage = (p: string) =>
    p.startsWith("assets/")
      ? 0
      : metadata(p).cacheControl === CACHE.short
        ? 2
        : 1;
  const groups = new Map<string, Upload & { stage: number }>();
  for (const path of [...paths].sort()) {
    const meta = metadata(path);
    const dir = posix.dirname(path) === "." ? "" : posix.dirname(path);
    const key = [stage(path), dir, meta.cacheControl, meta.contentType].join(
      "\0",
    );
    const group = groups.get(key) ?? {
      ...meta,
      dir,
      files: [],
      stage: stage(path),
    };
    group.files.push(path);
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) => a.stage - b.stage || a.dir.localeCompare(b.dir))
    .map(({ stage: _, ...upload }) => upload);
}

/** Every file under dir, as paths relative to it with forward slashes. */
function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => statSync(join(dir, f)).isFile())
    .map((f) => relative(dir, join(dir, f)).split(sep).join("/"));
}

/**
 * The files of a finished build, refusing one that would deploy a broken
 * site: no page, no 404 page, or an install.sh that isn't the repository's.
 */
export function builtFiles(dist: string): string[] {
  const found = files(dist);
  for (const needed of ["index.html", "404.html", "install.sh"])
    if (!found.includes(needed))
      throw new Error(`${dist} has no ${needed}: run bun run build first`);
  if (!found.some((f) => f.startsWith("assets/")))
    throw new Error(`${dist} has no assets/: run bun run build first`);
  if (!readFileSync(join(dist, "install.sh")).equals(readFileSync(INSTALLER)))
    throw new Error(
      `${dist}/install.sh differs from ${INSTALLER}: run bun run build again`,
    );
  for (const f of found) metadata(f);
  return found;
}

/**
 * The expected headers the backend bucket doesn't send with exactly this
 * value. `actual` is its customResponseHeaders, each "Name: value".
 */
export function missingHeaders(
  expected: Array<[string, string]>,
  actual: string[],
): Array<[string, string]> {
  const sent = new Map(
    actual.map((h) => {
      const at = h.indexOf(":");
      return [h.slice(0, at).trim().toLowerCase(), h.slice(at + 1).trim()];
    }),
  );
  return expected.filter(
    ([name, value]) => sent.get(name.toLowerCase()) !== value,
  );
}
