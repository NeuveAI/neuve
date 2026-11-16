import { z } from "zod";

/**
 * `<prefix>/lib/neuve/release.json`, what a release archive says about itself. The release build
 * (scripts/release/build.ts) writes it, and the installer (scripts/install.sh) reads it to decide
 * whether a folder holds a release it may replace, and whether the new one is older. A copy built
 * from source (`bun run install:cli`) has no release.json.
 */

const numeric = "(?:0|[1-9][0-9]*)";
const identifier = "(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)";

/** A semantic version without a leading v, such as 0.1.0-preview.1. */
export const releaseVersionSchema = z
  .string()
  .regex(
    new RegExp(
      `^${numeric}\\.${numeric}\\.${numeric}(?:-${identifier}(?:\\.${identifier})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
    ),
  );

/** The platforms a release is built for: Macs with Apple silicon, and Linux with glibc on x64 and arm64. */
export const RELEASE_TARGETS = [
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
] as const;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.string().regex(/^[0-9a-f]{40,64}$/);

export const releaseSchema = z.strictObject({
  schemaVersion: z.literal(1),
  version: releaseVersionSchema,
  target: z.enum(RELEASE_TARGETS),
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  cliSha256: sha256,
  /** The Neuve commit the release was built from, and whether the tree had local changes. */
  commit: revision.nullable(),
  dirty: z.boolean(),
  /** The Neuve Graph revision that commit pins, which the engine was built from. */
  graphRevision: revision.nullable(),
  /** The top-level paths the release installs under its prefix. */
  files: z.array(z.string()),
});
export type Release = z.infer<typeof releaseSchema>;
