/**
 * The repository's installer, which neuve.ai serves at /install.sh. The site
 * serves the repository's own copy, never a stamped one from a release: with
 * no shipped_version, the installer installs the newest release, and
 * --version still picks another.
 */
import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const INSTALLER = fileURLToPath(
  new URL("../../../../scripts/install.sh", import.meta.url),
);

/** True when the script names no release of its own (scripts/release/release.ts fills this line). */
export const unstamped = (script: string) => /^shipped_version=$/m.test(script);

/** Copies the installer into dist/ as install.sh. */
export function copyInstaller(dist: string): void {
  if (!unstamped(readFileSync(INSTALLER, "utf8")))
    throw new Error(
      `${INSTALLER} names a release in shipped_version=; the site serves only the unstamped installer`,
    );
  copyFileSync(INSTALLER, join(dist, "install.sh"));
}
