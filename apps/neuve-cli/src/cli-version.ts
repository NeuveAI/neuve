import cliPackage from "../package.json" with { type: "json" };

/** Set by a release build (`bun build --define NEUVE_BUILD_VERSION=...`); absent otherwise. */
declare const NEUVE_BUILD_VERSION: string | undefined;

/**
 * The CLI's version, the one `neuve --version` prints after "neuve ": the release build stamps it,
 * and every other build takes the package's. The skill's `metadata.version` is filled from it.
 */
export const CLI_VERSION: string =
  typeof NEUVE_BUILD_VERSION === "string"
    ? NEUVE_BUILD_VERSION
    : cliPackage.version;

/** Whether this is a release build: its help leaves out what the release doesn't offer yet. */
export const RELEASE_BUILD: boolean = typeof NEUVE_BUILD_VERSION === "string";
