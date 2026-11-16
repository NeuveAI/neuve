import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, rmSync, type Stats } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  cp,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Subprocess } from "bun";
import { z } from "zod";
import {
  installManifestSchema,
  type InstallManifest,
  type InstalledRecords,
} from "../src/install-manifest.ts";
import {
  INTEGRATION_BRANCHES,
  checkContext,
  checkoutState,
  isSharedPrefix,
  placeCommit,
  readReceipt,
  receiptDirectory,
  type CheckoutState,
} from "../src/install-source.ts";
import {
  PROJECTOR_VERSION,
  SCHEMA_VERSION,
  WRITER_VERSION,
} from "@neuve/records-core";
import { readDeskMetadata } from "../src/review-desk-config.ts";
import { hashDesk } from "../src/review-desk-files.ts";
import { buildDesk } from "./build-desk.ts";
import { CLI_VERSION } from "../src/cli-version.ts";
import {
  readSkillTemplate,
  shareFiles,
  writeSkillShare,
  type SkillBundle,
} from "../src/skill-bundle.ts";

/**
 * The local install is a copy, never a link into the workspace:
 *
 *   <prefix>/bin/neuve                   the CLI
 *   <prefix>/lib/neuve/entire-graph      the Graph engine the CLI finds on its own
 *   <prefix>/lib/neuve/semantic/         the semantic client's Python workers (E0's encoder, the
 *                                        reranker), which a compiled binary cannot carry
 *   <prefix>/lib/neuve/desk/             the review desk `neuve review desk` serves (build-desk.ts)
 *   <prefix>/share/neuve/skills/         the `neuve` agent skill that `neuve skills install` copies
 *                                        into agents' folders, with its manifest
 *   <prefix>/lib/neuve/install.json      what Neuve installed, by SHA-256, with the store versions
 *                                        the CLI was built with and the commit it came from
 *
 * Rebuilding or testing the workspace cannot change the installed command.
 * An existing file is replaced only when the manifest shows Neuve installed it, or when the record
 * an interrupted install left (`install.pending.json`) names its bytes. Every install holds
 * `install-lock.sqlite`, a lock the system releases when its process ends, however it ends.
 *
 * Installing is its own mode (12.24): nothing else writes the shared copy under `~/.local`. An
 * install there runs every guard in `planInstall` and refuses unless all pass: not in check mode,
 * a clean tree on an integration branch, an installed copy built from a strict ancestor of HEAD (or
 * none yet), and a passing `bun run check` on this exact commit. `--dry-run` prints that plan and
 * writes nothing. `--prefix` or `NEUVE_INSTALL_PREFIX` names a scratch prefix, which skips the branch,
 * ancestry and receipt guards so a lane can install a private copy; the shared prefix never does.
 */
export type { InstallManifest };

export const installLayout = (prefix: string) => {
  const root = resolve(prefix);
  const lib = join(root, "lib/neuve");
  return {
    cli: join(root, "bin/neuve"),
    graph: join(lib, "entire-graph"),
    desk: join(lib, "desk"),
    semantic: {
      encoder: join(lib, "semantic/worker.py"),
      reranker: join(lib, "semantic/reranker_worker.py"),
    },
    manifest: join(lib, "install.json"),
    pending: join(lib, "install.pending.json"),
    lock: join(lib, "install-lock.sqlite"),
    skills: join(root, "share/neuve/skills"),
  };
};

/**
 * The default prefix, the shared install every hook and terminal runs. Whether another spelling is
 * the same place is `isSharedPrefix`'s question, by where it lands on disk.
 */
export const sharedPrefix = () => join(homedir(), ".local");

export { isSharedPrefix };

/** Where this process installs: `--prefix`, `NEUVE_INSTALL_PREFIX`, or the shared `~/.local`. */
export const installPrefix = (flag?: string) =>
  flag || process.env["NEUVE_INSTALL_PREFIX"] || sharedPrefix();

/** Fails loudly when check mode would write the shared copy; called before anything is written. */
export const refuseSharedInCheckMode = (
  prefix: string,
  alsoShared: ReadonlyArray<string> = [],
) => {
  const context = checkContext();
  if (context !== undefined && isSharedPrefix(prefix, alsoShared))
    throw new Error(
      `Refusing to install into the shared copy at ${resolve(prefix)} in check mode (${context}): checks and tests never write it. Install into a scratch prefix, or run \`bun run install:cli\` yourself.`,
    );
};

const lstatIfPresent = async (path: string): Promise<Stats | null> => {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
};

const sha256File = async (path: string): Promise<string> =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

/**
 * The manifest is the only proof of what Neuve installed, so an unreadable one
 * stops the install rather than being guessed at or overwritten.
 */
const readManifest = async (
  layout: ReturnType<typeof installLayout>,
): Promise<InstallManifest | null> => {
  const path = layout.manifest;
  const stats = await lstatIfPresent(path);
  if (stats === null) return null;
  if (!stats.isFile())
    throw new Error(`Refusing to use ${path} because it is not a file.`);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    value = undefined;
  }
  const manifest = installManifestSchema.safeParse(value);
  if (manifest.success) return manifest.data;
  throw new Error(
    `The Neuve install manifest ${path} is corrupt or incomplete, so Neuve cannot tell which files it installed. Remove it together with ${layout.cli} and ${layout.graph}, then rerun bun run install:cli.`,
  );
};

/**
 * What an install is about to copy, written before its first copy and removed after its manifest.
 * One left behind is an install that stopped between the two: the files it names by SHA-256 are
 * Neuve's, so the next install replaces them instead of refusing them for good.
 */
const pendingSchema = z.strictObject({
  sha256: z.array(z.string().regex(/^[0-9a-f]{64}$/)),
  parser: z.boolean().optional(),
});
type Pending = z.infer<typeof pendingSchema>;

/**
 * Refuses a path the install reads or holds unless it is absent or a regular file: a symlink planted
 * there could point a scratch install at another copy's file, the shared copy's included.
 */
const requireOwnFile = async (path: string) => {
  const stats = await lstatIfPresent(path);
  if (stats !== null && !stats.isFile())
    throw new Error(
      `Refusing to use ${path} because it is ${stats.isSymbolicLink() ? "a symbolic link" : "not a regular file"}. Move it away and rerun.`,
    );
  return stats;
};

/** A pending record that cannot be read only widens nothing: it is ignored. A link is refused. */
const readPending = async (
  layout: ReturnType<typeof installLayout>,
): Promise<Pending> => {
  await requireOwnFile(layout.pending);
  try {
    const parsed = pendingSchema.safeParse(
      JSON.parse(await readFile(layout.pending, "utf8")),
    );
    if (parsed.success) return parsed.data;
  } catch {
    // Absent or unreadable.
  }
  return { sha256: [] };
};

const writeAtomically = async (path: string, contents: string) => {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, contents);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
};

/**
 * Refuses unless `destination` is absent, holds what Neuve recorded installing
 * there or what an interrupted install was copying, already holds the bytes
 * being installed, or is the earlier symlink install into this workspace.
 */
const ensureOwned = async (
  input: Readonly<{
    destination: string;
    recordedSha256: string | undefined;
    incomingSha256: string;
    pending?: Pending;
    legacyLinkTarget?: string;
    manifestPath: string;
  }>,
): Promise<void> => {
  const stats = await lstatIfPresent(input.destination);
  if (stats === null) return;
  if (stats.isSymbolicLink()) {
    if (
      input.legacyLinkTarget !== undefined &&
      (await readlink(input.destination)) === input.legacyLinkTarget
    )
      return;
    throw new Error(
      `Refusing to replace ${input.destination}: it is a symbolic link Neuve did not install. Move it away and rerun.`,
    );
  }
  if (!stats.isFile())
    throw new Error(
      `Refusing to replace ${input.destination}: it is not a file. Move it away and rerun.`,
    );
  const current = await sha256File(input.destination);
  if (
    current === input.recordedSha256 ||
    current === input.incomingSha256 ||
    input.pending?.sha256.includes(current) === true
  )
    return;
  throw new Error(
    `Refusing to replace ${input.destination}: Neuve did not install it (no matching entry in ${input.manifestPath}). Move it away and rerun.`,
  );
};

/** Copies beside the destination, then renames over it. */
const copyAtomically = async (
  source: string,
  destination: string,
): Promise<void> => {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await copyFile(source, temporary);
    await chmod(temporary, 0o755);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
};

const requireRegularFile = async (path: string, label: string) => {
  const stats = await lstatIfPresent(path);
  if (stats === null || !stats.isFile())
    throw new Error(`${label} is not a regular file: ${path}.`);
};

/** A review desk is Neuve's when its `desk.json` reads; it is intact when its files match it. */
const deskState = async (
  directory: string,
): Promise<
  "absent" | "foreign" | "damaged" | { sha256: string; version: string }
> => {
  const stats = await lstatIfPresent(directory);
  if (stats === null) return "absent";
  if (!stats.isDirectory()) return "foreign";
  try {
    const metadata = await readDeskMetadata(directory);
    return (await hashDesk(directory).catch(() => undefined)) ===
      metadata.sha256
      ? metadata
      : "damaged";
  } catch {
    return "foreign";
  }
};

/**
 * Installs a built review desk folder at `destination`, under the install lock: copied beside it,
 * checked against its `desk.json`, then renamed into place. The desk it replaces is moved aside
 * first and removed only when it is an intact desk Neuve installed; a damaged one is kept beside it
 * and named. A folder that isn't a Neuve desk is never replaced.
 */
const installDesk = async (source: string, destination: string) => {
  const metadata = await readDeskMetadata(source);
  if ((await hashDesk(source)) !== metadata.sha256)
    throw new Error(
      `The review desk at ${source} doesn't match its desk.json; build it again.`,
    );
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  // Under the install lock, anything an earlier install left half-done is its own.
  for (const name of await readdir(parent)) {
    const at = join(parent, name);
    if (/^desk\.tmp-[0-9]+-[0-9a-f-]{36}$/.test(name))
      await rm(at, { recursive: true, force: true });
    else if (
      /^desk\.replaced-[0-9TZ-]+-[0-9a-f-]{36}$/.test(name) &&
      typeof (await deskState(at)) === "object"
    )
      await rm(at, { recursive: true, force: true });
  }
  const current = await deskState(destination);
  if (current === "foreign")
    throw new Error(
      `Refusing to replace ${destination}: it isn't a review desk Neuve installed. Move it away and rerun.`,
    );
  if (
    typeof current === "object" &&
    current.sha256 === metadata.sha256 &&
    current.version === metadata.version
  )
    return;
  const staging = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await cp(source, staging, { recursive: true, verbatimSymlinks: true });
    const copied = await deskState(staging);
    if (typeof copied !== "object" || copied.sha256 !== metadata.sha256)
      throw new Error("The review desk changed while it was copied; rerun.");
    let aside: string | undefined;
    if (current !== "absent") {
      aside = `${destination}.replaced-${new Date()
        .toISOString()
        .replaceAll(":", "-")
        .replace(/\.[0-9]+/, "")}-${randomUUID()}`;
      await rename(destination, aside);
    }
    await rename(staging, destination);
    if (aside !== undefined) {
      if (current === "damaged")
        await Bun.write(
          Bun.stdout,
          `The old review desk didn't match its desk.json, so it was kept at ${aside}.\n`,
        );
      else await rm(aside, { recursive: true, force: true });
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
};

/** The versions this workspace's sources declare, which the CLI built from them carries. */
const WORKSPACE_RECORDS: InstalledRecords = {
  schemaVersion: SCHEMA_VERSION,
  writerVersion: WRITER_VERSION,
  projectorVersion: PROJECTOR_VERSION,
};

/**
 * Refuses to replace a copy whose manifest records a higher Records schema or writer than the build
 * being installed (8.19): that copy is a newer build's, and the stores it upgraded need it. There is
 * no override.
 */
export const refuseDowngrade = (
  previous: InstallManifest | null,
  incoming: NonNullable<InstallManifest["records"]>,
  cliPath: string,
) => {
  const recorded = previous?.records;
  if (
    recorded !== undefined &&
    (recorded.schemaVersion > incoming.schemaVersion ||
      recorded.writerVersion > incoming.writerVersion)
  )
    throw new Error(
      `Refusing to replace ${cliPath}: it is a newer build (Records writer ${recorded.writerVersion}, schema ${recorded.schemaVersion}) than this one (writer ${incoming.writerVersion}, schema ${incoming.schemaVersion}), and installing never downgrades.`,
    );
};

export const installLocalCli = async (
  input: Readonly<{
    cli: string;
    graph: string;
    /** A review desk folder built by build-desk.ts, installed at `lib/neuve/desk`. */
    desk?: string;
    /** The semantic client's worker scripts to ship beside the CLI. */
    semantic?: { readonly encoder: string; readonly reranker: string };
    /** The agent skill to ship beside the CLI, with the CLI's version filled in. */
    skills?: SkillBundle;
    prefix: string;
    graphVersion: string;
    graphWorkspaceRevision: string | null;
    legacyLinkTarget?: string;
    /** What the built CLI reads and writes; defaults to this workspace's versions. */
    records?: NonNullable<InstallManifest["records"]>;
    source?: NonNullable<InstallManifest["source"]>;
    /**
     * Whether the guards that approved this install found the prefix shared: if a folder of it has
     * been linked into, or out of, the shared copy since, the install refuses before its first copy.
     */
    expectShared?: boolean;
    /** Prefixes that count as shared too, a test's stand-in; it only makes the check stricter. */
    alsoShared?: ReadonlyArray<string>;
  }>,
): Promise<InstallManifest> => {
  refuseSharedInCheckMode(input.prefix, input.alsoShared);
  const cli = resolve(input.cli);
  const graph = resolve(input.graph);
  await requireRegularFile(cli, "Built Neuve CLI");
  await requireRegularFile(graph, "Built Neuve Graph engine");
  const layout = installLayout(input.prefix);
  const previous = await readManifest(layout);
  const pending = await readPending(layout);
  const records = input.records ?? WORKSPACE_RECORDS;
  refuseDowngrade(previous, records, layout.cli);
  const [cliSha256, graphSha256] = await Promise.all([
    sha256File(cli),
    sha256File(graph),
  ]);
  const semanticSha256 =
    input.semantic === undefined
      ? []
      : await Promise.all(
          [input.semantic.encoder, input.semantic.reranker].map((path) =>
            sha256File(resolve(path)).catch(() => undefined),
          ),
        );
  const recordedSkills = new Map(
    (previous?.skills?.files ?? []).map((file) => [file.path, file.sha256]),
  );
  const check = async () => {
    if (input.skills !== undefined)
      await writeSkillShare({
        bundle: input.skills,
        shareDirectory: layout.skills,
        recorded: recordedSkills,
        pending: new Set(pending.sha256),
        checkOnly: true,
      });
    await ensureOwned({
      destination: layout.graph,
      recordedSha256: previous?.graph.sha256,
      incomingSha256: graphSha256,
      pending,
      manifestPath: layout.manifest,
    });
    await ensureOwned({
      destination: layout.cli,
      recordedSha256: previous?.cli.sha256,
      incomingSha256: cliSha256,
      pending,
      manifestPath: layout.manifest,
      ...(input.legacyLinkTarget === undefined
        ? {}
        : { legacyLinkTarget: input.legacyLinkTarget }),
    });
  };
  await check();
  // Again just before the first write: a folder linked into the shared copy since the start (or
  // since the guards ran, during the build) makes this a shared install.
  refuseSharedInCheckMode(input.prefix, input.alsoShared);
  if (
    input.expectShared !== undefined &&
    isSharedPrefix(input.prefix, input.alsoShared) !== input.expectShared
  )
    throw new Error(
      `refused: ${resolve(input.prefix)} ${input.expectShared ? "is no longer" : "now writes into"} the shared copy since its guards ran; nothing was installed`,
    );
  // Recorded before the first copy, so an install stopped before its manifest is repaired by the
  // next one rather than leaving files no manifest names.
  await mkdir(dirname(layout.pending), { recursive: true });
  await writeAtomically(
    layout.pending,
    JSON.stringify({
      sha256: [
        ...new Set([
          ...pending.sha256,
          graphSha256,
          cliSha256,
          ...semanticSha256.filter((sha) => sha !== undefined),
          ...(input.skills === undefined
            ? []
            : shareFiles(input.skills).map((file) => file.sha256)),
        ]),
      ],
    } satisfies Pending),
  );
  // The Graph engine goes first so a new CLI never runs without it. A rerun
  // after an interrupted install accepts files that already hold the new bytes.
  await copyAtomically(graph, layout.graph);
  await check();
  // The workers go before the CLI too, so a new CLI never runs with old ones.
  let semantic = previous?.semantic;
  if (input.semantic !== undefined) {
    const installed: Record<
      "encoder" | "reranker",
      { path: string; sha256: string }
    > = {
      encoder: { path: layout.semantic.encoder, sha256: "" },
      reranker: { path: layout.semantic.reranker, sha256: "" },
    };
    for (const role of ["encoder", "reranker"] as const) {
      const source = resolve(input.semantic[role]);
      await requireRegularFile(source, `The semantic client's ${role} worker`);
      const incoming = await sha256File(source);
      await ensureOwned({
        destination: layout.semantic[role],
        recordedSha256: previous?.semantic?.[role].sha256,
        incomingSha256: incoming,
        pending,
        manifestPath: layout.manifest,
      });
      await copyAtomically(source, layout.semantic[role]);
      installed[role].sha256 = incoming;
    }
    semantic = installed;
  }
  // The desk goes before the CLI too, so a new CLI never serves an old desk.
  if (input.desk !== undefined)
    await installDesk(resolve(input.desk), layout.desk);
  // The skill goes before the CLI too, so a new CLI never offers an old skill.
  let skills = previous?.skills;
  if (input.skills !== undefined)
    skills = {
      path: layout.skills,
      version: input.skills.version,
      files: [
        ...(await writeSkillShare({
          bundle: input.skills,
          shareDirectory: layout.skills,
          recorded: recordedSkills,
          pending: new Set(pending.sha256),
        })),
      ],
    };
  await copyAtomically(cli, layout.cli);
  const manifest: InstallManifest = {
    schemaVersion: 1,
    installedAt: new Date().toISOString(),
    cli: { path: layout.cli, sha256: cliSha256 },
    graph: {
      path: layout.graph,
      sha256: graphSha256,
      version: input.graphVersion,
      workspaceRevision: input.graphWorkspaceRevision,
    },
    records,
    ...(input.source === undefined ? {} : { source: input.source }),
    ...(semantic === undefined ? {} : { semantic }),
    ...(skills === undefined ? {} : { skills }),
  };
  await writeAtomically(
    layout.manifest,
    JSON.stringify(manifest, null, 2) + "\n",
  );
  await rm(layout.pending, { force: true });
  return manifest;
};

/**
 * Runs `run` holding `<prefix>/lib/neuve/install-lock.sqlite`: an exclusive SQLite transaction,
 * which the system releases when this process ends, however it ends, so no lock is ever left stale
 * and none needs taking over. Another install holding it gives `busy` at once.
 */
export const withInstallLock = async <A>(
  prefix: string,
  run: () => Promise<A>,
): Promise<A | "busy"> => {
  const layout = installLayout(prefix);
  await mkdir(dirname(layout.lock), { recursive: true });
  const before = await requireOwnFile(layout.lock);
  const lock = new Database(layout.lock, { create: true });
  try {
    // Again after opening: a link swapped in between the check and the open is refused before the
    // lock file is changed or held.
    const after = await requireOwnFile(layout.lock);
    if (after === null || (before !== null && before.ino !== after.ino))
      throw new Error(
        `Refusing to use ${layout.lock} because it changed while it was opened. Rerun.`,
      );
    chmodSync(layout.lock, 0o600);
    lock.run("PRAGMA busy_timeout = 0");
    try {
      lock.run("BEGIN EXCLUSIVE");
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        String(error.code).startsWith("SQLITE_BUSY")
      )
        return "busy";
      throw error;
    }
    try {
      return await run();
    } finally {
      lock.run("ROLLBACK");
    }
  } finally {
    lock.close();
  }
};

export interface Guard {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** What an install would do, and every guard's answer; `blocked` is the first that refuses. */
export interface InstallPlan {
  readonly prefix: string;
  readonly shared: boolean;
  readonly source: CheckoutState;
  readonly installed: string;
  readonly guards: ReadonlyArray<Guard>;
  readonly blocked: Guard | undefined;
  readonly paths: ReadonlyArray<{
    readonly path: string;
    readonly action: "replace" | "create";
  }>;
  readonly before: InstalledRecords | undefined;
  readonly after: InstalledRecords;
}

/**
 * Runs every guard an install to `prefix` must pass, reading only: it builds nothing, takes no
 * lock and writes nothing. The dry run prints it; the install runs it again under the lock.
 */
export const planInstall = async (
  input: Readonly<{
    prefix: string;
    workspaceRoot: string;
    env?: Readonly<Record<string, string | undefined>>;
    records?: InstalledRecords;
    /** Prefixes that count as shared too, a test's stand-in; it only makes the plan stricter. */
    alsoShared?: ReadonlyArray<string>;
  }>,
): Promise<InstallPlan> => {
  const shared = isSharedPrefix(input.prefix, input.alsoShared);
  const layout = installLayout(input.prefix);
  const source = await checkoutState(input.workspaceRoot);
  const guards: Array<Guard> = [];
  const guard = (name: string, ok: boolean, detail: string) =>
    guards.push({ name, ok, detail });
  const skipped = "skipped for a scratch prefix";

  const context = checkContext(input.env ?? process.env);
  guard(
    "mode",
    !shared || context === undefined,
    shared && context !== undefined
      ? `check mode (${context}) never installs the shared copy`
      : "install mode",
  );
  guard(
    "tree",
    source.clean,
    source.clean ? "clean" : "this checkout has local changes",
  );
  const onBranch =
    source.branch !== null && INTEGRATION_BRANCHES.includes(source.branch);
  guard(
    "branch",
    !shared || onBranch,
    !shared
      ? skipped
      : onBranch
        ? `${source.branch} is an integration branch`
        : `${source.branch ?? "a detached HEAD"} is not an integration branch (${INTEGRATION_BRANCHES.join(", ")})`,
  );

  let previous: InstallManifest | null = null;
  let installed = "none";
  let installedOk = true;
  let installedDetail = "no Neuve-installed copy yet";
  try {
    previous = await readManifest(layout);
  } catch (error) {
    installedOk = false;
    installedDetail = error instanceof Error ? error.message : String(error);
  }
  if (previous !== null) {
    const built = previous.source?.commit ?? null;
    installed = `${built === null ? "an unrecorded commit" : built.slice(0, 10)}${previous.source?.dirty ? " with local changes" : ""}, ${versionsOf(previous.records)}`;
    if (built === null) {
      installedOk = false;
      installedDetail =
        "the installed copy records no commit it was built from";
    } else if (source.head === null) {
      installedOk = false;
      installedDetail = "git cannot read this checkout's HEAD";
    } else {
      const place = await placeCommit(input.workspaceRoot, built, source.head);
      installedOk = place === "ancestor";
      installedDetail =
        place === "ancestor"
          ? `built from ${built.slice(0, 10)}, a strict ancestor of HEAD`
          : place === "same"
            ? `built from ${built.slice(0, 10)}, this HEAD already`
            : place === "elsewhere"
              ? `built from ${built.slice(0, 10)}, which HEAD does not contain (another line of history, or newer)`
              : `built from ${built.slice(0, 10)}, which this checkout does not know`;
    }
  } else if (installedOk) {
    const existing = await lstatIfPresent(layout.cli);
    const pending = await readPending(layout);
    if (existing?.isSymbolicLink() === true) {
      installed = `the old workspace symlink at ${layout.cli}`;
      installedDetail = installed;
    } else if (
      existing?.isFile() === true &&
      pending.sha256.includes(await sha256File(layout.cli))
    ) {
      // A first install stopped before its manifest: its pending record names these bytes.
      installed = `an interrupted first install at ${layout.cli}`;
      installedDetail = `${installed}, which this install completes`;
    } else if (existing !== null) {
      installedOk = false;
      installed = `a neuve Neuve did not install at ${layout.cli}`;
      installedDetail = `${layout.cli} holds a neuve Neuve did not install`;
    }
  }
  let downgrade: string | undefined;
  try {
    refuseDowngrade(previous, input.records ?? WORKSPACE_RECORDS, layout.cli);
  } catch (error) {
    downgrade = error instanceof Error ? error.message : String(error);
  }
  guard(
    "installed copy",
    (!shared || installedOk) && downgrade === undefined,
    downgrade ?? (shared ? installedDetail : `${skipped} (${installedDetail})`),
  );

  if (!shared) guard("check receipt", true, skipped);
  else if (source.head === null || source.commonDirectory === null)
    guard("check receipt", false, "not a git checkout");
  else {
    const receipt = await readReceipt(
      receiptDirectory(source.commonDirectory),
      source.head,
    );
    guard(
      "check receipt",
      typeof receipt !== "string",
      typeof receipt === "string"
        ? receipt
        : `\`bun run check\` passed on ${receipt.commit.slice(0, 10)} at ${receipt.at}`,
    );
  }
  const graph = join(input.workspaceRoot, "apps/neuve-graph/entire-graph");
  const graphBuilt = (await lstatIfPresent(graph))?.isFile() === true;
  guard(
    "graph engine",
    graphBuilt,
    graphBuilt ? `built at ${graph}` : `not built; run \`bun run build:graph\``,
  );
  // The skill's files beside the CLI, checked as the install checks them, so a dry run refuses a
  // prefix whose share holds a file Neuve didn't install. A checkout with no skill has no guard.
  const skillTemplate = join(
    input.workspaceRoot,
    "apps/neuve-cli/skills/neuve",
  );
  if ((await lstatIfPresent(join(skillTemplate, "SKILL.md"))) !== null) {
    let detail = `${layout.skills} holds only files Neuve installed`;
    let ok = true;
    try {
      await writeSkillShare({
        bundle: await readSkillTemplate(skillTemplate, CLI_VERSION),
        shareDirectory: layout.skills,
        recorded: new Map(
          (previous?.skills?.files ?? []).map((file) => [
            file.path,
            file.sha256,
          ]),
        ),
        pending: new Set((await readPending(layout)).sha256),
        checkOnly: true,
      });
    } catch (error) {
      ok = false;
      detail = error instanceof Error ? error.message : String(error);
    }
    guard("skill files", ok, detail);
  }

  const paths = [];
  for (const path of [
    layout.cli,
    layout.graph,
    layout.desk,
    layout.semantic.encoder,
    layout.semantic.reranker,
    join(layout.skills, "manifest.json"),
    layout.manifest,
  ])
    paths.push({
      path,
      action: (await lstatIfPresent(path)) === null ? "create" : "replace",
    } as const);
  return {
    prefix: resolve(input.prefix),
    shared,
    source,
    installed,
    guards,
    blocked: guards.find((entry) => !entry.ok),
    paths,
    before: previous?.records,
    after: input.records ?? WORKSPACE_RECORDS,
  };
};

/** The plan as lines a person reads before installing. */
export const describePlan = (plan: InstallPlan) =>
  [
    `neuve install plan for ${plan.prefix} (${plan.shared ? "the shared copy" : "a scratch prefix"})`,
    `  source     ${plan.source.head?.slice(0, 10) ?? "no commit"} on ${plan.source.branch ?? "a detached HEAD"}, tree ${plan.source.clean ? "clean" : "with local changes"}`,
    `  installed  ${plan.installed}`,
    `  records    ${versionsOf(plan.before)} -> ${versionsOf(plan.after)}`,
    ...plan.paths.map((entry) => `  ${entry.action.padEnd(9)}  ${entry.path}`),
    ...plan.guards.map(
      (entry) =>
        `  ${entry.ok ? "ok     " : "BLOCKED"}    ${entry.name}: ${entry.detail}`,
    ),
  ].join("\n");

/** The children an install runs, and its build folder, stopped and removed if the install is. */
const running = new Set<Subprocess>();
const temporaries = new Set<string>();

/**
 * On SIGTERM or SIGINT (an automatic reinstall past its time, a person's ^C), stops the children
 * this install started and removes its build folder before exiting. The install lock goes with the
 * process.
 */
export const stopOnSignals = () => {
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, () => {
      for (const child of running) child.kill("SIGTERM");
      for (const path of temporaries)
        rmSync(path, { recursive: true, force: true });
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
};

/** Runs a child the install waits on, stopped with it (`stopOnSignals`). */
export const runTracked = async (
  command: readonly string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<{ readonly code: number; readonly stdout: string }> => {
  const child = Bun.spawn([...command], {
    cwd,
    ...(env === undefined ? {} : { env }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  running.add(child);
  try {
    const [stdout, code] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ]);
    return { code, stdout: stdout.trim() };
  } finally {
    running.delete(child);
  }
};

const versionsOf = (records: InstalledRecords | undefined) =>
  records === undefined
    ? "no version record"
    : `writer ${records.writerVersion}, schema ${records.schemaVersion}, projector ${records.projectorVersion}`;

const output = async (
  command: readonly string[],
  cwd: string,
): Promise<string> => {
  const { code, stdout } = await runTracked(command, cwd);
  if (code !== 0) throw new Error(`${command.join(" ")} exited with ${code}.`);
  return stdout;
};

const WORKSPACE_ROOT = resolve(import.meta.dir, "../../..");

const USAGE = "Usage: bun run install:cli [--dry-run] [--prefix <path>]";

const main = async (): Promise<void> => {
  const flags = [...Bun.argv.slice(2)];
  let dryRun = false;
  let prefixFlag: string | undefined;
  while (flags.length > 0) {
    const flag = flags.shift();
    if (flag === "--dry-run") dryRun = true;
    else if (flag === "--prefix" && flags[0] !== undefined)
      prefixFlag = resolve(flags.shift()!);
    else throw new Error(USAGE);
  }
  const prefix = installPrefix(prefixFlag);
  const plan = await planInstall({ prefix, workspaceRoot: WORKSPACE_ROOT });
  await Bun.write(Bun.stdout, `${describePlan(plan)}\n`);
  if (plan.blocked !== undefined)
    throw new Error(
      `${dryRun ? "an install would be refused" : "refused"}: ${plan.blocked.name}: ${plan.blocked.detail}`,
    );
  if (dryRun) {
    await Bun.write(
      Bun.stdout,
      "neuve install: every guard passed; `bun run install:cli` would install this plan\n",
    );
    return;
  }
  stopOnSignals();
  const done = await withInstallLock(prefix, async () => {
    // Again under the lock: another install may have changed the copy since the plan was read.
    const again = await planInstall({ prefix, workspaceRoot: WORKSPACE_ROOT });
    if (again.blocked !== undefined)
      throw new Error(
        `refused: ${again.blocked.name}: ${again.blocked.detail}`,
      );
    if (again.source.head === null)
      throw new Error("refused: git cannot read this checkout's HEAD");
    // The build is held to the commit these guards approved (`installFromCheckout`).
    return installFromCheckout({
      prefix,
      workspaceRoot: WORKSPACE_ROOT,
      planned: {
        head: again.source.head,
        branch: again.source.branch,
        shared: again.shared,
      },
    });
  });
  if (done === "busy")
    throw new Error(
      `Another install of neuve under ${prefix} is running; rerun when it finishes.`,
    );
};

/** What the guards approved: the commit and branch the install must build, from a clean tree. */
export interface Planned {
  readonly head: string;
  readonly branch: string | null;
  /** Whether the guards found the prefix shared: the install refuses if that has changed. */
  readonly shared: boolean;
}

/**
 * Builds the CLI from `workspaceRoot` and installs it under `prefix`, as the commit the guards
 * approved (`planned`). The tree must still be that commit, clean, before the build and again after
 * it, just before the first copy: a commit or an edit by another session in between refuses the
 * install and removes the build, so nothing is installed under a commit it was not built from.
 * `build`, `desk` and `semantic` default to this workspace's; tests stand them in, and a `desk` of
 * null installs none.
 */
export const installFromCheckout = async (
  input: Readonly<{
    prefix: string;
    workspaceRoot: string;
    planned: Planned;
    build?: (outfile: string) => Promise<void>;
    desk?: ((out: string) => Promise<void>) | null;
    semantic?: { readonly encoder: string; readonly reranker: string } | null;
    /** The skill's template folder (default: this workspace's); null installs no skill. */
    skills?: string | null;
    /** Prefixes that count as shared too, a test's stand-in; it only makes the install stricter. */
    alsoShared?: ReadonlyArray<string>;
  }>,
): Promise<InstallManifest> => {
  const { workspaceRoot, planned, prefix } = input;
  const unchanged = async (when: string) => {
    const now = await checkoutState(workspaceRoot);
    if (now.head !== planned.head || !now.clean)
      throw new Error(
        `refused: the checkout changed ${when} (planned ${planned.head.slice(0, 10)}, now ${now.head?.slice(0, 10) ?? "no commit"}${now.clean ? "" : " with local changes"}); nothing was installed`,
      );
  };
  const graph = join(workspaceRoot, "apps/neuve-graph/entire-graph");
  await requireRegularFile(graph, "Built Neuve Graph engine").catch(() => {
    throw new Error(
      `Build Neuve Graph first with bun run build:graph (expected ${graph}).`,
    );
  });
  const graphVersion = await output([graph, "version"], workspaceRoot);
  const graphWorkspaceRevision = await output(
    [
      "git",
      "--no-optional-locks",
      "-C",
      join(workspaceRoot, "apps/neuve-graph"),
      "rev-parse",
      "HEAD",
    ],
    workspaceRoot,
  ).catch(() => null);
  const semantic =
    input.semantic === undefined
      ? {
          encoder: join(
            workspaceRoot,
            "packages/semantic-client/src/worker.py",
          ),
          reranker: join(
            workspaceRoot,
            "packages/semantic-client/src/reranker_worker.py",
          ),
        }
      : input.semantic;
  await unchanged("before the build");
  const buildDirectory = await mkdtemp(join(tmpdir(), "neuve-cli-install-"));
  temporaries.add(buildDirectory);
  try {
    const cli = join(buildDirectory, "neuve");
    await (
      input.build ??
      (async (outfile: string) => {
        // The Bun running this install builds the CLI, so its runtime is the Bun the notices name.
        await output(
          [
            process.execPath,
            resolve(import.meta.dir, "build.ts"),
            "--outfile",
            outfile,
          ],
          workspaceRoot,
        );
      })
    )(cli);
    // The workers are tracked files: copied into the build before the tree is checked again, and
    // installed from those copies, so nothing is read from the live tree after the check.
    const workers =
      semantic === null
        ? null
        : {
            encoder: join(buildDirectory, "worker.py"),
            reranker: join(buildDirectory, "reranker_worker.py"),
          };
    if (semantic !== null && workers !== null) {
      await copyFile(semantic.encoder, workers.encoder);
      await copyFile(semantic.reranker, workers.reranker);
    }
    // Built from the same tree, inside the build folder a stopped install removes.
    const desk = input.desk === null ? undefined : join(buildDirectory, "desk");
    if (desk !== undefined)
      await (
        input.desk ??
        (async (out: string) => {
          await buildDesk({
            out,
            source: workspaceRoot,
            scratch: buildDirectory,
            run: (command, cwd, env) => runTracked(command, cwd, env),
          });
        })
      )(desk);
    // Read into memory before the check too, with this checkout's version filled in. A checkout
    // from before the skill (a test's fixture) has no template, and ships none.
    const skillTemplate =
      input.skills === undefined
        ? join(workspaceRoot, "apps/neuve-cli/skills/neuve")
        : input.skills;
    const skills =
      skillTemplate === null ||
      (await lstatIfPresent(join(skillTemplate, "SKILL.md"))) === null
        ? undefined
        : await readSkillTemplate(skillTemplate, CLI_VERSION);
    await unchanged("during the build");
    const manifest = await installLocalCli({
      cli,
      graph,
      prefix,
      graphVersion,
      graphWorkspaceRevision,
      ...(desk === undefined ? {} : { desk }),
      ...(workers === null ? {} : { semantic: workers }),
      ...(skills === undefined ? {} : { skills }),
      legacyLinkTarget: join(workspaceRoot, "apps/neuve-cli/dist/neuve"),
      source: { commit: planned.head, dirty: false },
      expectShared: planned.shared,
      ...(input.alsoShared === undefined
        ? {}
        : { alsoShared: input.alsoShared }),
    });
    await Bun.write(
      Bun.stdout,
      `Installed copies of the Neuve CLI at ${manifest.cli.path} from ${planned.head.slice(0, 10)} (Records writer ${manifest.records?.writerVersion}, schema ${manifest.records?.schemaVersion}, projector ${manifest.records?.projectorVersion}), Neuve Graph at ${manifest.graph.path}, the semantic workers in ${dirname(manifest.semantic?.encoder.path ?? "?")}${desk === undefined ? "" : `, the review desk at ${installLayout(prefix).desk}`}${manifest.skills === undefined ? "" : ` and the Neuve skill ${manifest.skills.version} in ${manifest.skills.path}`}.\n`,
    );
    return manifest;
  } finally {
    await rm(buildDirectory, { recursive: true, force: true });
    temporaries.delete(buildDirectory);
  }
};

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await Bun.write(Bun.stderr, `neuve install: ${message}\n`);
    process.exitCode = 1;
  }
}
