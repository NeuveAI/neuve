import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { Effect } from "effect";
import { resolveStoreLocation, type StoreLocation } from "@neuve/records-core";
import { z } from "zod";
import { writePrivateEnvironment } from "./private-environment.ts";

const absolute = z.string().refine(isAbsolute, "must be an absolute path");

/**
 * What `neuve setup` records, in `<store>/setup/config.json` (schema 4): the repository that ran it
 * and the CLI and Graph engine it found, by their paths. Nothing is linked: a link inside the Git
 * directory to another volume makes the Graph engine refuse the repository.
 */
export const installationSchema = z.strictObject({
  schemaVersion: z.literal(4),
  repository: absolute,
  cliBinary: absolute,
  graphBinary: absolute,
});
export type Installation = z.infer<typeof installationSchema>;

/**
 * Schema 3 named two links beside the record (`bin/neuve`, `bin/neuve-graph`): in the working tree's
 * `neuve/` folder before setup moved to the store, and in the store for a short while after.
 */
const linkedSchema = z.strictObject({
  schemaVersion: z.literal(3),
  repository: z.string(),
  cliBinary: z.string(),
  graphBinary: z.string(),
});
/**
 * Versions 1 and 2 also named a Graph cache in the working tree (and version 1 the old ledger path
 * and ACP harness), which nothing reads any more. They stay readable until setup rewrites them.
 */
const legacyInstallationSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  repository: z.string(),
  cliBinary: z.string(),
  graphBinary: z.string(),
});

/**
 * Where setup keeps its state: `<store>/setup/` beside the Records store in the Git common
 * directory, so a set-up repository's working tree and `git status` stay as they were. Every
 * worktree of the repository shares it, as they share the store.
 *
 *   setup/config.json         the installation above
 *   setup/initial-index.json  the engine check setup ran (graph-query.ts `checkGraphEngine`)
 *
 * `bin/` and its two links belong to the older layouts only.
 */
export const setupLayout = (directory: string) => ({
  directory,
  config: join(directory, "config.json"),
  initialIndex: join(directory, "initial-index.json"),
  bin: join(directory, "bin"),
  cliLink: join(directory, "bin/neuve"),
  graphLink: join(directory, "bin/neuve-graph"),
});
export type SetupLayout = ReturnType<typeof setupLayout>;

export const setupDirectoryIn = (location: StoreLocation) =>
  join(location.directory, "setup");

/** The store's setup folder for a repository or any of its worktrees, when it is in Git. */
export const storeSetupLayout = async (repository: string) => {
  const location = await Effect.runPromise(
    Effect.result(resolveStoreLocation(repository)),
  );
  return location._tag === "Success"
    ? setupLayout(setupDirectoryIn(location.success))
    : undefined;
};

/**
 * The folder setup wrote inside the working tree before it moved to the store. A record there that
 * is Neuve's own still counts, so a repository set up earlier stays set up.
 */
export const legacySetupLayout = (repository: string) =>
  setupLayout(resolve(repository, "neuve"));

/** Setup's state was copied or moved from elsewhere; running setup again replaces it. */
export class RelocatedSetup extends Error {}

/** Refuses a link or the wrong kind of entry anywhere setup reads or writes. */
export const validateInstallationState = async (layout: SetupLayout) => {
  for (const [path, kind] of [
    [layout.directory, "directory"],
    [layout.bin, "directory"],
    [layout.config, "file"],
    [layout.initialIndex, "file"],
  ] as const) {
    try {
      const entry = await lstat(path);
      if (
        entry.isSymbolicLink() ||
        (kind === "directory" ? !entry.isDirectory() : !entry.isFile())
      )
        throw new Error(`Unsafe installation ${kind}: ${path}`);
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
  }
};

const readText = async (path: string) => {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return await file.readFile("utf8");
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw error;
  }
};

/**
 * A record in the older, linked shape is Neuve's only when it names its own folder's two links and,
 * when `owner` is given, this repository.
 */
const fromLinked = (
  parsed: { repository: string; cliBinary: string; graphBinary: string },
  layout: SetupLayout,
  owner: string | undefined,
) =>
  (owner === undefined || parsed.repository === owner) &&
  parsed.cliBinary === layout.cliLink &&
  parsed.graphBinary === layout.graphLink;

/** The store's record. Unsafe state throws; a record copied from elsewhere is `RelocatedSetup`. */
const readStoreRecord = async (
  layout: SetupLayout,
): Promise<Installation | undefined> => {
  await validateInstallationState(layout);
  const text = await readText(layout.config);
  if (text === undefined) return undefined;
  const parsed = z
    .union([installationSchema, linkedSchema])
    .parse(JSON.parse(text));
  if (parsed.schemaVersion === 4) return parsed;
  if (!fromLinked(parsed, layout, undefined))
    throw new RelocatedSetup(
      "Installation paths do not belong to this repository; run neuve setup again.",
    );
  return { ...parsed, schemaVersion: 4 };
};

/**
 * The working tree's `neuve/config.json` when it is Neuve's own record for this repository, else
 * undefined: a project's own `neuve/` folder is never taken for setup, and never stops it.
 */
export const readWorkingTreeRecord = async (
  owner: string,
): Promise<Installation | undefined> => {
  const layout = legacySetupLayout(owner);
  try {
    await validateInstallationState(layout);
    const text = await readText(layout.config);
    if (text === undefined) return undefined;
    const parsed = z
      .union([linkedSchema, legacyInstallationSchema])
      .safeParse(JSON.parse(text));
    if (!parsed.success || !fromLinked(parsed.data, layout, owner))
      return undefined;
    return {
      schemaVersion: 4,
      repository: parsed.data.repository,
      cliBinary: parsed.data.cliBinary,
      graphBinary: parsed.data.graphBinary,
    };
  } catch {
    return undefined;
  }
};

/**
 * The repository's installation: the store's record, else Neuve's own record in the working tree
 * from an earlier setup. The store's names whichever worktree last ran setup.
 */
export const readInstallation = async (
  repository: string,
  { allowLegacy = true } = {},
): Promise<Installation | undefined> => {
  const owner = await realpath(repository);
  const store = await storeSetupLayout(owner);
  const current =
    store === undefined ? undefined : await readStoreRecord(store);
  return (
    current ?? (allowLegacy ? await readWorkingTreeRecord(owner) : undefined)
  );
};

/**
 * Setup's one writer of its record: `<store>/setup/config.json`, private to the user, after the
 * folder is checked. Tests that need a set-up repository call it too.
 */
export const writeInstallation = async (
  repository: string,
  binaries: Readonly<{ cliBinary: string; graphBinary: string }>,
) => {
  const owner = await realpath(repository);
  const layout = await storeSetupLayout(owner);
  if (layout === undefined)
    throw new Error(`${owner} has no Git directory to keep Neuve's setup in.`);
  const installation = installationSchema.parse({
    schemaVersion: 4,
    repository: owner,
    cliBinary: binaries.cliBinary,
    graphBinary: binaries.graphBinary,
  });
  await validateInstallationState(layout);
  await mkdir(layout.directory, { recursive: true, mode: 0o700 });
  await validateInstallationState(layout);
  await writePrivateEnvironment(
    layout.config,
    JSON.stringify(installation, null, 2) + "\n",
  );
  return { layout, installation };
};
