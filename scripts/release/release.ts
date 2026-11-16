import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { Stats } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  releaseSchema,
  releaseVersionSchema,
} from "../../apps/neuve-cli/src/release-metadata.ts";
import {
  checkoutState,
  readReceipt,
  receiptDirectory,
} from "../../apps/neuve-cli/src/install-source.ts";
import { archiveName, buildArchive, RELEASE_TARGET } from "./build.ts";
import { writeChecksums } from "./checksums.ts";

/**
 * The one release command:
 * `bun run release --version <v> [--dry-run] [--out <folder> | --from <folder> [--target <commit>]]`.
 *
 * It checks the guards below and prints each with its result, builds the release files into
 * `--out` (default `dist/release/<version>`): the archive, `install.sh` and `SHA256SUMS`, and then
 * creates the tag `v<version>` on this commit and a release on GitHub with those files, through
 * `gh release create` with notes GitHub generates. A version with a prerelease part
 * (`0.1.0-preview.3`) is a prerelease; a plain version (`0.1.0`) is a full release marked latest,
 * which is what `https://neuve.ai/install.sh` and GitHub's `releases/latest/download/` resolve to.
 *
 * `--from <folder>` is how a measured archive ships: the build isn't byte-reproducible, so instead
 * of building it uploads the folder's files as they are. The same guards run, and then checks that
 * the folder holds exactly those three files, that `SHA256SUMS` verifies them, that the archive
 * holds no links, and that the archive and the installer are the release of this version built at
 * the commit the tag goes on. gh runs inside the folder with the files' bare names. That commit
 * is `--target` (HEAD by default) and must be on origin/main, so a later main can publish an
 * archive measured at an earlier commit.
 *
 * `--dry-run` builds the same files (or checks the `--from` folder) and prints the GitHub step it
 * would take, and creates nothing on GitHub: its only GitHub calls read. It runs with failing guards
 * too, so a branch can try it, and says which guards would refuse a real release. Without
 * `--dry-run` every guard must pass.
 */

const ROOT = resolve(import.meta.dir, "../..");
export const RELEASE_REPOSITORY = "NeuveAI/neuve";
export const RELEASE_BUN = "1.4.4";

export interface Guard {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const run = async (
  command: ReadonlyArray<string>,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
) => {
  const child = Bun.spawn([...command], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  // `raw` is stdout as the command wrote it, for readers where a space at either end matters.
  return { code, stdout: stdout.trim(), stderr: stderr.trim(), raw: stdout };
};

const firstLine = (text: string) => text.split("\n")[0]?.trim() || "no output";

/** The highest version among release tags `v<semver>`; tags that aren't one are ignored. */
export const highestRelease = (tags: ReadonlyArray<string>) => {
  let highest: string | undefined;
  for (const tag of tags) {
    if (!tag.startsWith("v")) continue;
    const version = tag.slice(1);
    if (!releaseVersionSchema.safeParse(version).success) continue;
    if (highest === undefined || Bun.semver.order(version, highest) > 0)
      highest = version;
  }
  return highest;
};

export interface ReleaseOptions {
  readonly version: string;
  readonly dryRun: boolean;
  readonly out?: string;
  /** A folder of release files to upload as they are, instead of building them. */
  readonly from?: string;
  /** With `from`: the commit the tag goes on, which the archive must be built from. HEAD by default. */
  readonly target?: string;
  /** The checkout to release; the workspace this script lives in by default. */
  readonly root?: string;
  readonly repository?: string;
  readonly host?: string;
  readonly bunVersion?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Builds the archive into a folder; the real release build by default. */
  readonly build?: (version: string, out: string) => Promise<void>;
  readonly say?: (line: string) => Promise<unknown> | unknown;
}

/** The guards, in order. Each reads only: git, the check receipt, and GitHub through `gh`. */
export const checkGuards = async (
  options: Pick<
    ReleaseOptions,
    "version" | "root" | "repository" | "host" | "bunVersion" | "env"
  >,
) => {
  const root = options.root ?? ROOT;
  const repository = options.repository ?? RELEASE_REPOSITORY;
  const env = options.env ?? process.env;
  const guards: Array<Guard> = [];
  const guard = (name: string, ok: boolean, detail: string) =>
    guards.push({ name, ok, detail });
  const git = (args: ReadonlyArray<string>, cwd = root) =>
    run(["git", "--no-optional-locks", ...args], cwd, env);

  const source = await checkoutState(root);
  guard(
    "tree",
    source.clean,
    source.clean
      ? "clean"
      : "this checkout has local changes (untracked files count)",
  );
  const head = source.head;
  if (head === null) guard("history", false, "git can't read HEAD");
  else {
    const onMain = await git([
      "merge-base",
      "--is-ancestor",
      head,
      "refs/remotes/origin/main",
    ]);
    guard(
      "history",
      onMain.code === 0,
      onMain.code === 0
        ? `${head.slice(0, 10)} is on origin/main's history (as of the last git fetch)`
        : onMain.code === 1
          ? `${head.slice(0, 10)} is not on origin/main's history (as of the last git fetch)`
          : `git can't compare HEAD with origin/main: ${firstLine(onMain.stderr)}`,
    );
  }
  if (head === null || source.commonDirectory === null)
    guard("check receipt", false, "not a git checkout");
  else {
    const receipt = await readReceipt(
      receiptDirectory(source.commonDirectory),
      head,
    );
    guard(
      "check receipt",
      typeof receipt !== "string",
      typeof receipt === "string"
        ? receipt
        : `\`bun run check\` passed on ${receipt.commit.slice(0, 10)} at ${receipt.at}`,
    );
  }

  const valid = releaseVersionSchema.safeParse(options.version).success;
  let latest: string | undefined;
  if (!valid)
    guard(
      "version",
      false,
      `${JSON.stringify(options.version)} is not a semantic version such as 0.1.0-preview.1 (no leading v)`,
    );
  else {
    const listed = await run(
      [
        "gh",
        "release",
        "list",
        "--repo",
        repository,
        "--limit",
        "1000",
        "--json",
        "tagName",
        "--jq",
        ".[].tagName",
      ],
      root,
      env,
    );
    if (listed.code !== 0)
      guard(
        "version",
        false,
        `couldn't read the releases of ${repository} with gh: ${firstLine(listed.stderr)}`,
      );
    else {
      latest = highestRelease(listed.stdout.split("\n").filter(Boolean));
      const higher =
        latest === undefined || Bun.semver.order(options.version, latest) > 0;
      const tag = `v${options.version}`;
      const existing = higher
        ? await run(
            [
              "gh",
              "api",
              `repos/${repository}/git/ref/tags/${tag}`,
              "--jq",
              ".object.sha",
            ],
            root,
            env,
          )
        : undefined;
      const tagFree =
        existing === undefined ||
        (existing.code !== 0 && /HTTP 404/.test(existing.stderr));
      guard(
        "version",
        higher && tagFree,
        !higher
          ? `${options.version} is not higher than ${latest}, the highest release of ${repository}`
          : !tagFree
            ? existing?.code === 0
              ? `the tag ${tag} already exists on ${repository}`
              : `couldn't check whether the tag ${tag} exists on ${repository}: ${firstLine(existing?.stderr ?? "")}`
            : `${options.version} is higher than ${latest === undefined ? "every release (there are none yet)" : `${latest}, the highest release of ${repository}`}, and ${tag} is free`,
      );
    }
  }

  const host = options.host ?? `${process.platform}-${process.arch}`;
  guard(
    "host",
    host === RELEASE_TARGET,
    host === RELEASE_TARGET
      ? `${host}, the release's platform`
      : `${host}; the release is built on ${RELEASE_TARGET} only`,
  );
  const bun = options.bunVersion ?? Bun.version;
  guard(
    "bun",
    bun === RELEASE_BUN,
    bun === RELEASE_BUN
      ? `Bun ${bun}`
      : `Bun ${bun}; the release is built with Bun ${RELEASE_BUN}`,
  );

  const pointer = (
    await git(["ls-tree", "HEAD", "apps/neuve-graph"])
  ).stdout.match(/^160000 commit ([0-9a-f]{40,64})\s/)?.[1];
  const graphRoot = join(root, "apps/neuve-graph");
  const checkedOut = await git(["rev-parse", "HEAD"], graphRoot);
  const graphStatus = await git(
    ["status", "--porcelain", "--untracked-files=normal"],
    graphRoot,
  );
  const graphOk =
    pointer !== undefined &&
    checkedOut.code === 0 &&
    checkedOut.stdout === pointer &&
    graphStatus.code === 0 &&
    graphStatus.stdout === "";
  guard(
    "graph engine",
    graphOk,
    pointer === undefined
      ? "this commit records no Neuve Graph pointer at apps/neuve-graph"
      : checkedOut.code !== 0
        ? "apps/neuve-graph is not checked out; run bun run setup:graph"
        : checkedOut.stdout !== pointer
          ? `apps/neuve-graph is at ${checkedOut.stdout.slice(0, 10)}, not the commit's pointer ${pointer.slice(0, 10)}`
          : graphStatus.stdout !== ""
            ? `apps/neuve-graph has local changes at ${pointer.slice(0, 10)}`
            : `built from ${pointer.slice(0, 10)}, the commit's Graph pointer`,
  );
  return { guards, head, graphRevision: pointer ?? null, latest };
};

/** The installer as a release ships it: it names its own release, so its help can give the tag. */
export const stampInstaller = (script: string, version: string) => {
  const line = "\nshipped_version=\n";
  if (script.split(line).length !== 2)
    throw new Error(
      "scripts/install.sh has no single empty shipped_version= line to fill in.",
    );
  return script.replace(line, `\nshipped_version=${version}\n`);
};

/** Whether a version has a prerelease part: `0.1.0-preview.3` does, `0.1.0` and `0.1.0+build.1` don't. */
export const isPrerelease = (version: string) =>
  (version.split("+", 1)[0] ?? version).includes("-");

/**
 * The GitHub step: the tag on this commit and a release with the release files. A prerelease
 * version publishes as a prerelease, which GitHub never calls latest; any other publishes as a
 * full release marked latest, so the one-line install finds it.
 */
export const publishCommand = (
  input: Readonly<{
    version: string;
    commit: string;
    repository: string;
    files: ReadonlyArray<string>;
  }>,
) => [
  "gh",
  "release",
  "create",
  `v${input.version}`,
  "--repo",
  input.repository,
  "--target",
  input.commit,
  isPrerelease(input.version) ? "--prerelease" : "--latest",
  "--generate-notes",
  "--title",
  `Neuve ${input.version}`,
  ...input.files,
];

const sha256 = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

export interface ArchiveInspection {
  /** Whether the archive unpacks into only folders and regular files, with one regular bin/neuve. */
  readonly members: Guard;
  /** lib/neuve/release.json as the unpacked tree holds it, when the members pass and it is there. */
  readonly release: string | undefined;
  /** Whether that same tree's bin/neuve has `neuve doctor`, which the installer's last step names. */
  readonly cli: Guard;
}

/**
 * What the installer refuses in tar's own listings before it unpacks anything, and a little more:
 * from `tar -tvzf` (`modes`), any member that isn't a folder or a regular file; from `tar -tzf`
 * (`names`, the same members in the same order), a path that is absolute, holds `.` or `..` or an
 * empty part, or isn't inside the release's folder (the bare folder entry included), and any name
 * that appears more than once, since tar keeps only the last copy and the installer reads them all.
 */
const memberProblems = (names: string, modes: string) => {
  // Only the final newline goes: a name may start or end with spaces, or be nothing but spaces.
  const lines = (text: string) =>
    text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const members = lines(names);
  const kinds = lines(modes);
  const problems: Array<string> = [];
  if (kinds.length !== members.length)
    problems.push(
      `tar lists ${members.length} members by name but ${kinds.length} with their types, so the listings can't be checked`,
    );
  kinds.forEach((line, index) => {
    const kind = line[0];
    if (kind === "d" || kind === "-") return;
    const name = kinds.length === members.length ? members[index] : line;
    problems.push(
      kind === "l"
        ? `${name} is a symbolic link`
        : kind === "h"
          ? `${name} is a hard link`
          : `${name} is not a regular file or a folder`,
    );
  });
  const top = `neuve-${RELEASE_TARGET}`;
  for (const member of members) {
    const parts = member.replace(/\/$/, "").split("/");
    // A name with a space at either end, or none at all, is shown in quotes so the space shows.
    const shown = /^\s|\s$|^$/.test(member) ? JSON.stringify(member) : member;
    if (member.startsWith("/")) problems.push(`${shown} is an absolute path`);
    else if (parts.some((part) => part === "" || part === "." || part === ".."))
      problems.push(`${shown} is an unsafe path`);
    else if (member === top)
      problems.push(`${shown} is a bare entry for the release's folder`);
    else if (!member.startsWith(`${top}/`))
      problems.push(`${shown} is outside ${top}/`);
  }
  const seen = new Map<string, number>();
  for (const member of members) {
    const name = member.replace(/\/$/, "");
    seen.set(name, (seen.get(name) ?? 0) + 1);
  }
  for (const [name, count] of seen)
    if (count > 1) problems.push(`${name} appears ${count} times`);
  return problems;
};

const octal = (mode: number) => (mode & 0o7777).toString(8).padStart(4, "0");
const errorCode = (error: unknown) =>
  error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : String(error);

/**
 * Every path under `root` that isn't a folder its owner can read, write and search, or a regular
 * file with one name, by lstat. A folder that can't be read is named, not entered; a folder its
 * owner can't write to is refused too, since the installer couldn't replace it.
 */
const treeProblems = async (
  root: string,
  relative = "",
): Promise<Array<string>> => {
  const problems: Array<string> = [];
  let names: Array<string>;
  try {
    names = await readdir(join(root, relative));
  } catch (error) {
    return [
      `${relative || "the unpacked archive"} can't be read (${errorCode(error)})`,
    ];
  }
  for (const name of names) {
    const path = relative === "" ? name : `${relative}/${name}`;
    const entry = await lstat(join(root, path)).catch(
      (error: unknown) => error,
    );
    if (!(entry instanceof Stats)) {
      problems.push(`${path} can't be read (${errorCode(entry)})`);
      continue;
    }
    if (entry.isDirectory()) {
      if ((entry.mode & 0o500) !== 0o500)
        problems.push(`${path} can't be read (mode ${octal(entry.mode)})`);
      else if ((entry.mode & 0o200) === 0)
        problems.push(
          `${path} can't be written to (mode ${octal(entry.mode)}), so the installer couldn't replace it`,
        );
      else problems.push(...(await treeProblems(root, path)));
    } else if (entry.isSymbolicLink())
      problems.push(`${path} is a symbolic link`);
    else if (!entry.isFile())
      problems.push(`${path} is not a regular file or a folder`);
    else if (entry.nlink > 1) problems.push(`${path} is a hard link`);
  }
  return problems;
};

/** Gives every folder under `path` its owner's read, write and search, by lstat, never through a link. */
const unlockFolders = async (path: string): Promise<void> => {
  const entry = await lstat(path).catch(() => null);
  if (entry === null || !entry.isDirectory()) return;
  await chmod(path, (entry.mode & 0o7777) | 0o700).catch(() => undefined);
  const names = await readdir(path).catch(() => []);
  for (const name of names) await unlockFolders(join(path, name));
};

/** Removes the unpack folder, whatever modes the archive gave its folders; says why it couldn't. */
const removeUnpacked = async (folder: string) => {
  await unlockFolders(folder);
  try {
    await rm(folder, { recursive: true, force: true });
    return undefined;
  } catch (error) {
    return `couldn't remove the unpack folder ${folder} (${errorCode(error)}); remove it by hand`;
  }
};

const listed = (problems: ReadonlyArray<string>) =>
  `${problems.slice(0, 5).join(", ")}${problems.length > 5 ? `, and ${problems.length - 5} more` : ""}`;

/**
 * Unpacks the archive once with /usr/bin/tar into a fresh folder, the way the installer reads it,
 * and checks that tree. First tar's own listings, refusing at least what the installer refuses
 * there (`memberProblems`), before anything is unpacked; then every unpacked path by lstat, never
 * following a link: only folders and regular files with one name, and bin/neuve a regular file. release.json is read and
 * `neuve doctor --help` runs from that same tree, so the file checked is the file run; a program
 * with a quarantine mark is never run. `skipCli` gives why the CLI isn't run at all. It never
 * throws: a path it can't read is a named problem, and the folder is always removed, after its
 * folders get back their owner's permissions; a folder it can't remove refuses, by name.
 */
export const inspectArchive = async (
  archive: string,
  skipCli?: string,
): Promise<ArchiveInspection> => {
  const members = (ok: boolean, detail: string): Guard => ({
    name: "archive members",
    ok,
    detail,
  });
  const cli = (ok: boolean, detail: string): Guard => ({
    name: "built CLI",
    ok,
    detail,
  });
  const notRun = (members: Guard): ArchiveInspection => ({
    members,
    release: undefined,
    cli: cli(false, skipCli ?? "not run: the archive's members don't pass"),
  });
  const listing = await run(
    ["/usr/bin/tar", "-tzf", archive],
    dirname(archive),
  );
  if (listing.code !== 0)
    return notRun(
      members(false, `can't read the archive: ${firstLine(listing.stderr)}`),
    );
  const modes = await run(["/usr/bin/tar", "-tvzf", archive], dirname(archive));
  if (modes.code !== 0)
    return notRun(
      members(false, `can't read the archive: ${firstLine(modes.stderr)}`),
    );
  const unsafe = memberProblems(listing.raw, modes.raw);
  if (unsafe.length > 0)
    return notRun(members(false, `${listed(unsafe)}; so it wasn't unpacked`));
  const inspectUnpacked = async (
    folder: string,
  ): Promise<ArchiveInspection> => {
    const unpacked = await run(
      ["/usr/bin/tar", "-xzf", archive, "-C", folder],
      folder,
    );
    if (unpacked.code !== 0)
      return notRun(
        members(
          false,
          `can't unpack the archive: ${firstLine(unpacked.stderr)}`,
        ),
      );
    const stage = join(folder, `neuve-${RELEASE_TARGET}`);
    const problems = await treeProblems(folder);
    const binary = join(stage, "bin/neuve");
    const entry = await lstat(binary).catch(() => null);
    if (entry === null) problems.push("the archive has no bin/neuve");
    else if (!entry.isFile() && !entry.isSymbolicLink())
      problems.push("the archive's bin/neuve is not a regular file");
    if (problems.length > 0) return notRun(members(false, listed(problems)));
    const checked = members(
      true,
      "unpacked into only folders and regular files, and bin/neuve is a regular file",
    );
    const release = await readFile(
      join(stage, "lib/neuve/release.json"),
      "utf8",
    ).catch(() => undefined);
    if (skipCli !== undefined)
      return { members: checked, release, cli: cli(false, skipCli) };
    // tar passes an archive's quarantine mark to what it extracts, and macOS stops a marked program.
    const quarantined = await run(
      ["/usr/bin/xattr", "-p", "com.apple.quarantine", binary],
      folder,
    );
    if (quarantined.code === 0)
      return {
        members: checked,
        release,
        cli: cli(
          false,
          "the archive carries a quarantine mark, so its bin/neuve was not run; ship the archive the release build made",
        ),
      };
    const doctor = await run([binary, "doctor", "--help"], folder, {
      PATH: "/usr/bin:/bin",
      HOME: folder,
      TMPDIR: folder,
    });
    return {
      members: checked,
      release,
      cli:
        doctor.code === 0
          ? cli(true, "has neuve doctor, which the installer's last step names")
          : cli(
              false,
              "has no neuve doctor, which the installer's last step names; release from a commit that carries it",
            ),
    };
  };
  const folder = await mkdtemp(join(tmpdir(), "neuve-release-archive-"));
  let inspection: ArchiveInspection;
  try {
    inspection = await inspectUnpacked(folder);
  } catch (error) {
    inspection = notRun(
      members(
        false,
        `can't check the unpacked archive: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
  const leftover = await removeUnpacked(folder);
  if (leftover === undefined) return inspection;
  // Keep what the check found, and say plainly what was left behind.
  return {
    ...inspection,
    members: members(
      false,
      inspection.members.ok
        ? leftover
        : `${inspection.members.detail}; and ${leftover}`,
    ),
  };
};

/** What `--from` uploads, in order. */
export const MEASURED_FILES = [archiveName(), "install.sh", "SHA256SUMS"];

/**
 * The checks on a `--from` folder: the commit the tag goes on, then that the folder holds exactly
 * the release files, that `SHA256SUMS` verifies them, that the archive holds no links and one
 * regular bin/neuve, and that the archive and the installer are the release of `version` built at
 * that commit. The archive is unpacked once into a scratch folder (`inspectArchive`), and
 * release.json and `neuve doctor --help` come from that tree; the CLI runs only once the files
 * verify and the tree passes, and never with a quarantine mark.
 */
export const checkMeasured = async (
  input: Readonly<{
    folder: string;
    version: string;
    target: string;
    root: string;
    env: NodeJS.ProcessEnv;
  }>,
) => {
  const guards: Array<Guard> = [];
  const guard = (name: string, ok: boolean, detail: string) =>
    guards.push({ name, ok, detail });
  const git = (args: ReadonlyArray<string>) =>
    run(["git", "--no-optional-locks", ...args], input.root, input.env);

  const resolved = await git([
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${input.target}^{commit}`,
  ]);
  const commit = resolved.code === 0 ? resolved.stdout : null;
  if (commit === null)
    guard("target", false, `${input.target} is not a commit in this checkout`);
  else {
    const onMain = await git([
      "merge-base",
      "--is-ancestor",
      commit,
      "refs/remotes/origin/main",
    ]);
    guard(
      "target",
      onMain.code === 0,
      onMain.code === 0
        ? `the tag goes on ${commit.slice(0, 10)}, which is on origin/main's history (as of the last git fetch)`
        : onMain.code === 1
          ? `${commit.slice(0, 10)} is not on origin/main's history (as of the last git fetch)`
          : `git can't compare ${commit.slice(0, 10)} with origin/main: ${firstLine(onMain.stderr)}`,
    );
  }

  const folder = resolve(input.folder);
  const files = MEASURED_FILES.map((name) => join(folder, name));
  const entries = await readdir(folder).catch(() => null);
  if (entries === null) {
    guard("release files", false, `can't read the folder ${folder}`);
    return { guards, commit, files, hashes: [] };
  }
  const problems = [
    ...MEASURED_FILES.filter((name) => !entries.includes(name)).map(
      (name) => `${name} is missing`,
    ),
    ...entries
      .filter((name) => !MEASURED_FILES.includes(name))
      .sort()
      .map((name) => `${name} is there too, and only the release files may be`),
  ];
  for (const name of MEASURED_FILES.filter((name) => entries.includes(name))) {
    const entry = await lstat(join(folder, name));
    if (entry.isSymbolicLink()) problems.push(`${name} is a link`);
    else if (!entry.isFile()) problems.push(`${name} is not a regular file`);
  }
  guard(
    "release files",
    problems.length === 0,
    problems.length === 0
      ? `${folder} holds exactly ${MEASURED_FILES.join(", ")}, each a regular file`
      : problems.join("; "),
  );
  if (problems.length > 0) return { guards, commit, files, hashes: [] };

  const hashes = await Promise.all(files.map(sha256));
  const [archive, installer, sums] = files as [string, string, string];
  const listed = new Map<string, string>();
  const sumProblems: Array<string> = [];
  for (const line of (await readFile(sums, "utf8")).split("\n")) {
    if (line === "") continue;
    const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
    if (match === null || listed.has(match[2] ?? ""))
      sumProblems.push(`SHA256SUMS has a line that isn't one sha256 and name`);
    else listed.set(match[2] ?? "", match[1] ?? "");
  }
  MEASURED_FILES.slice(0, 2).forEach((name, index) => {
    const expected = listed.get(name);
    if (expected === undefined)
      sumProblems.push(`SHA256SUMS has no line for ${name}`);
    else if (expected !== hashes[index])
      sumProblems.push(`${name} doesn't match its line in SHA256SUMS`);
  });
  for (const name of listed.keys())
    if (!MEASURED_FILES.slice(0, 2).includes(name))
      sumProblems.push(`SHA256SUMS lists ${name}, which isn't uploaded`);
  guard(
    "checksums",
    sumProblems.length === 0,
    sumProblems.length === 0
      ? `SHA256SUMS verifies ${MEASURED_FILES.slice(0, 2).join(" and ")}`
      : sumProblems.join("; "),
  );

  // One unpacked tree, checked before anything in it is read or run: release.json and the CLI
  // come from it, so what is checked is what tar, and the installer, would unpack.
  const inspected = await inspectArchive(
    archive,
    sumProblems.length > 0
      ? "not checked: the files don't match SHA256SUMS"
      : undefined,
  );
  guards.push(inspected.members);
  let parsed: ReturnType<typeof releaseSchema.safeParse> | undefined;
  try {
    parsed =
      inspected.release === undefined
        ? undefined
        : releaseSchema.safeParse(JSON.parse(inspected.release));
  } catch {
    parsed = undefined;
  }
  if (!inspected.members.ok)
    guard("archive", false, "not read: the archive's members don't pass");
  else if (inspected.release === undefined)
    guard("archive", false, "the archive has no lib/neuve/release.json");
  else if (parsed === undefined || !parsed.success)
    guard("archive", false, "the archive's lib/neuve/release.json isn't valid");
  else {
    const release = parsed.data;
    const differences = [
      ...(release.version === input.version
        ? []
        : [`the archive is ${release.version}, not ${input.version}`]),
      ...(commit !== null && release.commit !== commit
        ? [
            `the archive was built at ${release.commit?.slice(0, 10) ?? "no recorded commit"}, not ${commit.slice(0, 10)}, the commit the tag goes on`,
          ]
        : []),
      ...(release.dirty
        ? ["the archive was built from a tree with local changes"]
        : []),
    ];
    guard(
      "archive",
      differences.length === 0 && commit !== null,
      differences.length > 0
        ? differences.join("; ")
        : commit === null
          ? "not compared: there is no commit for the tag"
          : `${release.version}, built at ${commit.slice(0, 10)} with no local changes`,
    );
  }

  const shipped = /^shipped_version=(.*)$/m.exec(
    await readFile(installer, "utf8"),
  )?.[1];
  guard(
    "installer",
    shipped === input.version,
    shipped === input.version
      ? `install.sh installs ${input.version}`
      : shipped === undefined || shipped === ""
        ? "install.sh names no release version"
        : `install.sh installs ${shipped}, not ${input.version}`,
  );

  guards.push(inspected.cli);
  return { guards, commit, files, hashes };
};

/** A command line as a POSIX shell reads it: words outside a safe set go in single quotes. */
export const quote = (command: ReadonlyArray<string>) =>
  command
    .map((word) =>
      /^[\w@%+=:,./-]+$/.test(word)
        ? word
        : `'${word.replaceAll("'", "'\\''")}'`,
    )
    .join(" ");

/**
 * Prints a dry run's step, or runs `gh release create` once `unchanged` finds nothing changed.
 * gh runs inside `folder` with the release files' bare names: it reads `#` in an upload argument
 * as the start of a label and `*`, `?` and `[` as a pattern, and a folder's path may hold them.
 */
const publish = async (
  input: Readonly<{
    command: ReadonlyArray<string>;
    folder: string;
    refused: ReadonlyArray<Guard>;
    dryRun: boolean;
    commit: string;
    repository: string;
    version: string;
    env: NodeJS.ProcessEnv;
    say: (line: string) => Promise<unknown> | unknown;
    /** The last check before the upload: why it refuses, or undefined. */
    unchanged: () => Promise<string | undefined>;
  }>,
) => {
  const { say } = input;
  if (input.dryRun) {
    await say("The GitHub step a real release takes (not run):");
    await say(`  cd ${quote([input.folder])} && ${quote(input.command)}`);
    await say(
      input.refused.length === 0
        ? "Every guard passes: a real release would go ahead."
        : `A real release would refuse: ${input.refused.map((guard) => guard.name).join(", ")}.`,
    );
    return 0;
  }
  const changed = await input.unchanged();
  if (changed !== undefined) {
    await say(`Refused: ${changed}. Nothing was created on GitHub.`);
    return 1;
  }
  const child = Bun.spawn([...input.command], {
    cwd: input.folder,
    env: input.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await child.exited;
  if (code !== 0) {
    await say(
      `gh release create exited with ${code}. Check the releases of ${input.repository} before you run this again.`,
    );
    return 1;
  }
  await say(
    `Created the ${isPrerelease(input.version) ? "prerelease" : "release"} v${input.version} on ${input.repository} at ${input.commit.slice(0, 10)}.`,
  );
  return 0;
};

export const runRelease = async (options: ReleaseOptions): Promise<number> => {
  const root = options.root ?? ROOT;
  const repository = options.repository ?? RELEASE_REPOSITORY;
  const say =
    options.say ?? ((line: string) => Bun.write(Bun.stdout, `${line}\n`));
  const env = options.env ?? process.env;
  const from = options.from;
  if (from === undefined && options.target !== undefined) {
    await say("--target goes with --from: a build always releases HEAD.");
    return 1;
  }
  if (from !== undefined && options.out !== undefined) {
    await say("--from uploads a folder as it is, so --out doesn't apply.");
    return 1;
  }
  await say(
    `neuve release ${options.version}${options.dryRun ? " (dry run: nothing is created on GitHub)" : ""}`,
  );
  const checked = await checkGuards({ ...options, root, repository, env });
  for (const guard of checked.guards)
    await say(
      `  ${guard.ok ? "ok    " : "refuse"} ${guard.name}: ${guard.detail}`,
    );
  const refused: Array<Guard> = checked.guards.filter((guard) => !guard.ok);
  if (refused.length > 0 && !options.dryRun) {
    await say(
      `Refused: ${refused.map((guard) => guard.name).join(", ")}. ${from === undefined ? "Nothing was built or created." : "Nothing was uploaded or created."}`,
    );
    return 1;
  }
  if (!releaseVersionSchema.safeParse(options.version).success) {
    await say(
      from === undefined
        ? "Nothing was built: the version isn't valid."
        : "Nothing was checked: the version isn't valid.",
    );
    return 1;
  }

  if (from !== undefined) {
    await say(`Checking the release files in ${resolve(from)}`);
    const measured = await checkMeasured({
      folder: from,
      version: options.version,
      target: options.target ?? checked.head ?? "HEAD",
      root,
      env,
    });
    for (const guard of measured.guards)
      await say(
        `  ${guard.ok ? "ok    " : "refuse"} ${guard.name}: ${guard.detail}`,
      );
    for (const [index, hash] of measured.hashes.entries())
      await say(`  ${measured.files[index]}  sha256 ${hash}`);
    const failed = measured.guards.filter((guard) => !guard.ok);
    refused.push(...failed);
    if (failed.length > 0 && !options.dryRun) {
      await say(
        `Refused: ${failed.map((guard) => guard.name).join(", ")}. Nothing was uploaded or created.`,
      );
      return 1;
    }
    const commit = measured.commit ?? options.target ?? "HEAD";
    return publish({
      command: publishCommand({
        version: options.version,
        commit,
        repository,
        files: MEASURED_FILES,
      }),
      folder: resolve(from),
      refused,
      dryRun: options.dryRun,
      commit,
      repository,
      version: options.version,
      env,
      say,
      unchanged: async () => {
        const after = await checkoutState(root);
        if (!after.clean || after.head !== checked.head)
          return "the checkout changed after the guards ran";
        const now = await Promise.all(
          measured.files.map((file) => sha256(file).catch(() => "")),
        );
        return now.every((hash, index) => hash === measured.hashes[index])
          ? undefined
          : "the release files changed after they were checked";
      },
    });
  }

  const out = resolve(
    options.out ?? join(root, "dist/release", options.version),
  );
  await mkdir(out, { recursive: true });
  const build =
    options.build ??
    (async (version: string, folder: string) => {
      await buildArchive({ version, out: folder, repository });
    });
  await say(`Building into ${out}`);
  await build(options.version, out);
  await writeFile(
    join(out, "install.sh"),
    stampInstaller(
      await readFile(join(root, "scripts/install.sh"), "utf8"),
      options.version,
    ),
  );
  // Only the two files this run uploads, never a stale archive left in the folder.
  await writeChecksums(out, [archiveName(), "install.sh"]);
  const names = [archiveName(), "install.sh", "SHA256SUMS"];
  const files = names.map((name) => join(out, name));
  for (const file of files)
    await say(
      `  ${file}  ${(await stat(file)).size} bytes  sha256 ${await sha256(file)}`,
    );
  // The installer's last step names neuve doctor, so a CLI without it is not released; and the
  // archive must unpack into only folders and regular files, as the installer requires.
  const inspected = await inspectArchive(join(out, archiveName()));
  const built = [inspected.members, inspected.cli];
  for (const guard of built)
    await say(
      `  ${guard.ok ? "ok    " : "refuse"} ${guard.name}: ${guard.detail}`,
    );
  const failed = built.filter((guard) => !guard.ok);
  refused.push(...failed);
  const command = publishCommand({
    version: options.version,
    commit: checked.head ?? "HEAD",
    repository,
    files: names,
  });
  if (!options.dryRun && failed.length > 0) {
    await say(
      `Refused: ${failed.map((guard) => guard.name).join(", ")}. Nothing was created on GitHub.`,
    );
    return 1;
  }
  return publish({
    command,
    folder: out,
    refused,
    dryRun: options.dryRun,
    commit: checked.head ?? "HEAD",
    repository,
    version: options.version,
    env,
    say,
    // The build must not have changed the checkout it released.
    unchanged: async () => {
      const after = await checkoutState(root);
      return !after.clean || after.head !== checked.head
        ? "the checkout changed during the build"
        : undefined;
    },
  });
};

const USAGE = [
  "Usage: bun run release --version <x.y.z> [--dry-run] [--out <folder>]",
  "       bun run release --version <x.y.z> --from <folder> [--target <commit>] [--dry-run]",
  "",
  "The first form builds the release files and uploads them. The second is how a measured archive",
  "ships: it builds nothing and uploads the folder's neuve-darwin-arm64.tar.gz, install.sh and",
  "SHA256SUMS as they are, once they verify and the archive was built at the commit the tag goes",
  "on: --target, or HEAD.",
].join("\n");

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      version: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      out: { type: "string" },
      from: { type: "string" },
      target: { type: "string" },
    },
  });
  if (values.version === undefined) throw new Error(USAGE);
  process.exitCode = await runRelease({
    version: values.version,
    dryRun: values["dry-run"],
    ...(values.out === undefined ? {} : { out: values.out }),
    ...(values.from === undefined ? {} : { from: values.from }),
    ...(values.target === undefined ? {} : { target: values.target }),
  });
}
