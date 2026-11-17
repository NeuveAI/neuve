import { lstat, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { isCompiled } from "../../../packages/harness/src/compiled.ts";
import { isSharedPrefix } from "./install-source.ts";
import { hashDesk } from "./review-desk-files.ts";
import { quote } from "./shell-quote.ts";

/** `neuve review desk`: the subcommand's one name, used by help, refusals and printed commands. */
export const REVIEW_DESK_COMMAND = "desk";

/**
 * `<desk>/desk.json`, written last by `build-desk.ts`: the base the web app was built for, the CLI
 * version it belongs to and the content hash of everything beside it (`hashDesk`).
 */
export const deskManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  base: z.literal("/"),
  version: z.string(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type DeskManifest = z.infer<typeof deskManifestSchema>;

/** Where the review desk is installed under a prefix, beside the Graph engine. */
export const deskDirectoryIn = (prefix: string) =>
  join(resolve(prefix), "lib/neuve/desk");

/** The release installer's prefix: `~/.neuve`. */
export const releasePrefix = (home = homedir()) => join(home, ".neuve");

/** How a release install is installed again, the same version included. */
export const RELEASE_REINSTALL_FIX =
  "curl -fsSL https://neuve.ai/install.sh | sh -s -- --force";

/** The command that installs this prefix again, as a person types it. */
export const reinstallFix = async (prefix: string, home = homedir()) => {
  const release = await realpath(releasePrefix(home)).catch(() =>
    releasePrefix(home),
  );
  if (resolve(prefix) === release) return RELEASE_REINSTALL_FIX;
  if (isSharedPrefix(prefix))
    return "From a clean Neuve checkout on main, run bun run build:graph && bun run install:cli";
  return `From your Neuve checkout, run bun run build:graph && bun run install:cli --prefix ${quote(resolve(prefix))}`;
};

/** A source run has no prefix of its own, so it needs a desk named by NEUVE_DESK_DIR. */
export const SOURCE_DESK_FIX =
  'From your Neuve checkout, run bun run build:graph && bun run install:cli --prefix ~/.neuve-src, then export NEUVE_DESK_DIR="$HOME/.neuve-src/lib/neuve/desk"';

export type DeskDiagnosis =
  | { readonly kind: "ready"; readonly directory: string }
  | {
      readonly kind: "source" | "override" | "missing" | "invalid";
      readonly directory?: string;
      readonly detail: string;
      readonly fix: string;
    };

/**
 * Finds the review desk this CLI serves: `NEUVE_DESK_DIR` when set, else `lib/neuve/desk` beside
 * the CLI's own binary, as the Graph engine is found. It only reads.
 */
export const diagnoseDesk = async (
  version: string,
  executable = process.execPath,
  fromSource = !isCompiled(),
): Promise<DeskDiagnosis> => {
  const override = process.env["NEUVE_DESK_DIR"];
  if (override !== undefined && override !== "") {
    const directory = resolve(override);
    try {
      await readDesk(directory, version);
      return { kind: "ready", directory };
    } catch {
      return {
        kind: "override",
        directory,
        detail: `NEUVE_DESK_DIR points at ${directory}, which isn't a review desk for neuve ${version}.`,
        fix: fromSource
          ? SOURCE_DESK_FIX
          : "Point NEUVE_DESK_DIR at an install's lib/neuve/desk folder, or run unset NEUVE_DESK_DIR",
      };
    }
  }
  if (fromSource)
    return {
      kind: "source",
      detail:
        "NEUVE_DESK_DIR is unset, and neuve needs it when it runs from source.",
      fix: SOURCE_DESK_FIX,
    };
  const prefix = resolve(dirname(await realpath(executable)), "..");
  const directory = deskDirectoryIn(prefix);
  const fix = await reinstallFix(prefix);
  const present = await lstat(directory).then(
    () => true,
    (error: unknown) =>
      !(error instanceof Error && "code" in error && error.code === "ENOENT"),
  );
  if (!present)
    return {
      kind: "missing",
      directory,
      detail: `There's no review desk at ${directory}.`,
      fix,
    };
  try {
    await readDesk(directory, version);
    return { kind: "ready", directory };
  } catch {
    return {
      kind: "invalid",
      directory,
      detail: `The review desk at ${directory} is incomplete, changed or from another version.`,
      fix,
    };
  }
};

/** `desk.json` as written, refusing a link or anything but a regular file. */
export const readDeskMetadata = async (directory: string) => {
  const path = join(directory, "desk.json");
  if (!(await lstat(path)).isFile())
    throw new Error(`${path} is not a regular file.`);
  return deskManifestSchema.parse(await Bun.file(path).json());
};

/** A desk this CLI may serve: its metadata, its content hash and its version all hold. */
export const readDesk = async (directory: string, version: string) => {
  const manifest = await readDeskMetadata(directory);
  if (manifest.version !== version)
    throw new Error(
      `The review desk is for neuve ${manifest.version}, not ${version}.`,
    );
  if (!(await stat(join(directory, "client"))).isDirectory())
    throw new Error("The review desk has no client folder.");
  if (!(await lstat(join(directory, "server/server.js"))).isFile())
    throw new Error("The review desk has no server.");
  if (manifest.sha256 !== (await hashDesk(directory)))
    throw new Error("The review desk's files don't match its desk.json.");
  return manifest;
};
