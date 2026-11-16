import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect } from "effect";
import {
  Store,
  SCHEMA_VERSION,
  WRITER_VERSION,
  resolveStoreLocation,
  type StoreLocation,
} from "@neuve/records-core";
import {
  clearSkew,
  currentBinary,
  describeSkew,
  isCompiled,
  readSkew,
  refusalFrom,
  skewPath,
  writeSkew,
} from "./version-skew.ts";
import {
  installManifestSchema,
  type InstallManifest,
} from "./install-manifest.ts";
import {
  INTEGRATION_BRANCHES,
  checkoutState,
  placeCommit,
} from "./install-source.ts";

/**
 * Says whether the installed copy of neuve is behind the checkout, and never changes it (12.24).
 *
 * `bun run install:cli` records in `<prefix>/lib/neuve/install.json` the store versions the copy was
 * built with and the commit it came from. Checking and installing are separate modes: `bun run
 * check:installed`, `bun run check` and `records migrate` from a checkout only read that, and name
 * the commands that would install (`bun run install:cli --dry-run`, then `bun run install:cli`), which
 * are the only writers of the shared copy. Stores no longer lock an older copy out for additive
 * changes (it runs in compatibility mode), so only a breaking migration makes the worker refuse; it
 * then leaves the marker that hooks, `neuve jobs` and `neuve worker status` read (version-skew.ts).
 * Hooks never install.
 */

/**
 * The manifest beside this compiled binary when it is an installed copy; otherwise, for a checkout
 * run or a workspace build such as `apps/neuve-cli/dist/neuve`, the default install's, under
 * `NEUVE_INSTALL_PREFIX` when it is set.
 */
export const installedManifestPath = () => {
  const prefix = process.env["NEUVE_INSTALL_PREFIX"];
  if (prefix) return join(prefix, "lib/neuve/install.json");
  if (isCompiled()) {
    const beside = resolve(
      dirname(realpathSync(process.execPath)),
      "../lib/neuve/install.json",
    );
    if (existsSync(beside)) return beside;
  }
  return join(homedir(), ".local/lib/neuve/install.json");
};

export const readInstalledManifest = (
  path = installedManifestPath(),
): InstallManifest | "absent" | "unreadable" => {
  if (!existsSync(path)) return "absent";
  try {
    // Only a regular file is the copy's own manifest; a link could name another copy's.
    if (!lstatSync(path).isFile()) return "unreadable";
    const parsed = installManifestSchema.safeParse(
      JSON.parse(readFileSync(path, "utf8")),
    );
    return parsed.success ? parsed.data : "unreadable";
  } catch {
    return "unreadable";
  }
};

const realPath = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

const versionsText = (versions: {
  readonly writerVersion: number;
  readonly schemaVersion: number;
  readonly projectorVersion: number;
}) =>
  `writer ${versions.writerVersion}, schema ${versions.schemaVersion}, projector ${versions.projectorVersion}`;

const WORKSPACE_ROOT = resolve(import.meta.dir, "../../..");

const INSTALL_STEPS =
  "`bun run install:cli --dry-run`, then `bun run install:cli`";

/**
 * One line on the installed copy against this checkout, for `check:installed` and after a migrate:
 * behind it (and what would install, only from an integration branch), current, or not placeable
 * before it by git. It reads only. Never throws.
 */
export const describeInstalledCopy = async (
  options: Readonly<{ manifestPath?: string; workspaceRoot?: string }> = {},
): Promise<string> => {
  const manifestPath = options.manifestPath ?? installedManifestPath();
  try {
    const manifest = readInstalledManifest(manifestPath);
    if (manifest === "absent")
      return `no installed neuve recorded at ${manifestPath}; ${INSTALL_STEPS} installs one`;
    if (manifest === "unreadable")
      return `warning: the install manifest ${manifestPath} cannot be read, so neuve cannot tell whether the installed copy is behind this checkout`;
    const versions =
      manifest.records === undefined
        ? "no version record"
        : versionsText(manifest.records);
    const built = manifest.source?.commit ?? null;
    const copy = `the installed neuve (${versions}${built === null ? "" : `, built from ${built.slice(0, 10)}${manifest.source?.dirty ? " with local changes" : ""}`})`;
    if (
      manifest.records !== undefined &&
      (manifest.records.schemaVersion > SCHEMA_VERSION ||
        manifest.records.writerVersion > WRITER_VERSION)
    )
      return `${copy} has newer Records versions than this checkout; leave it`;
    const state = await checkoutState(options.workspaceRoot ?? WORKSPACE_ROOT);
    if (built === null || state.head === null)
      return `${copy} records no commit git can place against this checkout`;
    const place = await placeCommit(
      options.workspaceRoot ?? WORKSPACE_ROOT,
      built,
      state.head,
    );
    if (place === "same") return `${copy} is current with this checkout`;
    if (place === "unknown")
      return `${copy} was built from a commit this checkout does not know; leave it`;
    if (place === "elsewhere")
      return `${copy} is not behind this checkout (${state.head.slice(0, 10)} does not contain its commit); leave it`;
    const onBranch =
      state.branch !== null && INTEGRATION_BRANCHES.includes(state.branch);
    return onBranch
      ? `${copy} is behind this checkout (${state.head.slice(0, 10)} on ${state.branch}); to install it: ${INSTALL_STEPS}`
      : `${copy} is behind this checkout (${state.head.slice(0, 10)}); install it from a clean checkout of ${INSTALL_BRANCH_LIST} with ${INSTALL_STEPS}, never from a lane`;
  } catch (error) {
    return `warning: could not check the installed neuve: ${error instanceof Error ? error.message : String(error)}`;
  }
};

const INSTALL_BRANCH_LIST = INTEGRATION_BRANCHES.join(" or ");

/**
 * The worker's store preparation: the version gate, plus the marker. A refusal is logged as one line
 * and recorded for hooks, `neuve jobs` and `neuve worker status`; a pass removes a marker about this
 * binary. The refusal still fails the worker, which exits with the same sentence.
 */
export const prepareWorkerStore = (location: StoreLocation) =>
  Store.prepareForWrite.pipe(
    Effect.tapError((error) =>
      Effect.gen(function* () {
        const refusal = refusalFrom(error);
        if (refusal === undefined) return;
        writeSkew(location.directory, {
          refusal,
          by: "worker",
          binary: currentBinary(),
        });
        yield* Effect.logError(`refusing to start: ${refusal.message}`);
      }),
    ),
    Effect.tap(() => Effect.sync(() => clearSkew(location.directory))),
  );

/**
 * After `records migrate` from a checkout. It never installs. If the store now needs a writer the
 * installed copy lacks, which only a breaking migration causes, it warns and writes the marker naming
 * the installed binary, so its hooks hold off starting a worker that would refuse. A store brought
 * up to date clears a `store-older` marker. Returns the warning, if any, for the caller to print.
 */
export const afterMigrate = (repository: string) =>
  Effect.gen(function* () {
    const location = yield* resolveStoreLocation(repository);
    const state = yield* Store.readState.pipe(
      Effect.provide(Store.layer(location, { create: false })),
    );
    if (state._tag !== "Ready") return undefined;
    const marker = readSkew(location.directory);
    if (marker?.kind === "store-older")
      yield* Effect.sync(() => clearSkew(location.directory, marker.binary));
    const manifest = readInstalledManifest(installedManifestPath());
    if (
      manifest === "absent" ||
      manifest === "unreadable" ||
      manifest.records === undefined
    )
      return undefined;
    if (realPath(manifest.cli.path) === currentBinary()) return undefined;
    const store = state.versions;
    if (store.minWriterVersion <= manifest.records.writerVersion)
      return undefined;
    const refusal = refusalFrom(
      {
        _tag: "WriterTooOld",
        writerVersion: manifest.records.writerVersion,
        minWriterVersion: store.minWriterVersion,
      },
      true,
    );
    if (refusal === undefined) return undefined;
    writeSkew(location.directory, {
      refusal,
      by: "migrate",
      binary: manifest.cli.path,
    });
    return `warning: this checkout migrated the store past the installed copy: ${refusal.message}. Until then its hooks keep spooling and its worker refuses this store (marker ${skewPath(location.directory)}).`;
  }).pipe(
    Effect.provide(BunFileSystem.layer),
    // The migrate itself succeeded; failing to check afterwards must not turn it into a failure.
    Effect.catch(() => Effect.succeed(undefined)),
  );

/** Prints the marker's line to stderr for `neuve jobs` and `neuve worker status`. Never throws. */
export const warnIfPaused = async (repository: string) => {
  try {
    const location = await Effect.runPromise(resolveStoreLocation(repository));
    const line = describeSkew(location);
    if (line !== undefined) await Bun.write(Bun.stderr, `neuve: ${line}\n`);
  } catch {
    // No repository or store: nothing to report.
  }
};

if (import.meta.main) {
  // `bun run check:installed`: one line, read only. Never fails the check.
  await Bun.write(Bun.stderr, `neuve: ${await describeInstalledCopy()}\n`);
}
