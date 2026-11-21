import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

/**
 * The `neuve` agent skill as files: its template in the workspace (`apps/neuve-cli/skills/neuve/`),
 * and the copy an install or a release keeps beside the CLI:
 *
 *   <prefix>/share/neuve/skills/manifest.json      each skill's version and files, by SHA-256
 *   <prefix>/share/neuve/skills/neuve/SKILL.md     metadata.version filled from the CLI's version
 *   <prefix>/share/neuve/skills/neuve/references/  the references the entry file names
 *
 * `bun run install:cli` and the release build both write that copy with `writeSkillShare`; `neuve
 * skills` reads it with `readSharedSkill` and installs it into an agent's skill folder.
 */
export const SKILL_NAME = "neuve";

/** Where the template's SKILL.md takes the CLI's version. */
export const VERSION_PLACEHOLDER = "{{NEUVE_VERSION}}";

export const SHARE_MANIFEST = "manifest.json";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * A file's place inside a skill folder: relative, with forward slashes, and every part starting
 * with a letter, digit or underscore, so it can name nothing hidden, nothing above the folder and
 * no absolute path, whatever a receipt or manifest on disk says.
 */
export const skillPathSchema = z
  .string()
  .max(200)
  .regex(/^(?:[A-Za-z0-9_][A-Za-z0-9._-]*\/)*[A-Za-z0-9_][A-Za-z0-9._-]*$/);

/** A version as a manifest or receipt may hold it: plain ASCII, so it can never drive a terminal. */
export const versionSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);

export type SkillFile = Readonly<{
  /** Relative to the skill's folder, for example `references/setup.md`. */
  path: string;
  bytes: Uint8Array;
  sha256: string;
}>;

export type SkillBundle = Readonly<{
  name: typeof SKILL_NAME;
  version: string;
  files: ReadonlyArray<SkillFile>;
}>;

export const sha256Of = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

const skillFile = (path: string, bytes: Uint8Array): SkillFile => ({
  path,
  bytes,
  sha256: sha256Of(bytes),
});

export const lstatIfPresent = async (path: string): Promise<Stats | null> => {
  try {
    return await lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
};

/** Writes beside the destination, then renames over it, so a reader never sees half a file. */
export const writeFileAtomically = async (
  path: string,
  bytes: Uint8Array | string,
  mode = 0o644,
) => {
  const temporary = join(
    dirname(path),
    `.${SKILL_NAME}-${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, bytes, { mode });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
};

/** Refuses a folder on the way to a file that is a link or not a folder. */
export const requireRealFolders = async (root: string, path: string) => {
  const parts = path.split("/").slice(0, -1);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    const stats = await lstatIfPresent(current);
    if (stats !== null && (stats.isSymbolicLink() || !stats.isDirectory()))
      throw new Error(
        `${current} is ${stats.isSymbolicLink() ? "a symbolic link" : "not a folder"}; move it away and rerun.`,
      );
  }
};

/** The SKILL.md frontmatter's `metadata.version`, if it has one. */
export const frontmatterVersion = (text: string) => {
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1];
  if (frontmatter === undefined) return undefined;
  return /^metadata:\n(?:[ \t]+.*\n)*?[ \t]+version:[ \t]*"?([^"\n]+)"?[ \t]*$/m.exec(
    `${frontmatter}\n`,
  )?.[1];
};

/**
 * The workspace template, with the CLI's version filled into SKILL.md: SKILL.md and the Markdown
 * files under references/. Anything else in the folder (other than hidden files) is an error, so
 * what is installed is always what this function lists.
 */
export const readSkillTemplate = async (
  directory: string,
  version: string,
): Promise<SkillBundle> => {
  if (!versionSchema.safeParse(version).success)
    throw new Error(`${JSON.stringify(version)} is not a version.`);
  const root = resolve(directory);
  const files: Array<SkillFile> = [];
  const visit = async (relative: string) => {
    const absolute = join(root, relative);
    const entries = (await readdir(absolute, { withFileTypes: true }))
      .filter((entry) => !entry.name.startsWith("."))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory() && path === "references") {
        await visit(path);
        continue;
      }
      const allowed =
        entry.isFile() &&
        (path === "SKILL.md" ||
          (relative === "references" && entry.name.endsWith(".md")));
      if (!allowed || !skillPathSchema.safeParse(path).success)
        throw new Error(
          `The skill template holds ${join(root, path)}, which is not SKILL.md or a Markdown reference.`,
        );
      const text = await readFile(join(root, path), "utf8");
      files.push(
        skillFile(
          path,
          new TextEncoder().encode(
            path === "SKILL.md"
              ? text.replaceAll(VERSION_PLACEHOLDER, version)
              : text,
          ),
        ),
      );
    }
  };
  await visit("");
  const entry = files.find((file) => file.path === "SKILL.md");
  if (entry === undefined)
    throw new Error(`The skill template ${root} has no SKILL.md.`);
  if (frontmatterVersion(new TextDecoder().decode(entry.bytes)) !== version)
    throw new Error(
      `The skill template's SKILL.md must carry metadata.version "${VERSION_PLACEHOLDER}".`,
    );
  files.sort((left, right) =>
    left.path === "SKILL.md"
      ? -1
      : right.path === "SKILL.md"
        ? 1
        : left.path.localeCompare(right.path),
  );
  return { name: SKILL_NAME, version, files };
};

export const shareManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  skills: z
    .array(
      z.strictObject({
        name: z.literal(SKILL_NAME),
        version: versionSchema,
        files: z
          .array(
            z.strictObject({ path: skillPathSchema, sha256: sha256Schema }),
          )
          .min(1),
      }),
    )
    .length(1),
});
export type ShareManifest = z.infer<typeof shareManifestSchema>;

/** The manifest's bytes for a bundle, the same every time for the same files. */
export const shareManifestBytes = (bundle: SkillBundle) =>
  new TextEncoder().encode(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        skills: [
          {
            name: bundle.name,
            version: bundle.version,
            files: bundle.files.map(({ path, sha256 }) => ({ path, sha256 })),
          },
        ],
      } satisfies ShareManifest,
      null,
      2,
    )}\n`,
  );

/**
 * Every file of the shared copy, relative to `<prefix>/share/neuve/skills`: the skill's files under
 * `neuve/`, then the manifest. This is the list an install records and a release archive carries.
 */
export const shareFiles = (bundle: SkillBundle): ReadonlyArray<SkillFile> => [
  ...bundle.files.map((file) => ({
    ...file,
    path: `${SKILL_NAME}/${file.path}`,
  })),
  skillFile(SHARE_MANIFEST, shareManifestBytes(bundle)),
];

/**
 * Reads the shared copy at `shareDirectory` (`<prefix>/share/neuve/skills`) and checks every file
 * against its manifest: a copy that doesn't match is an error, never installed.
 */
export const readSharedSkill = async (
  shareDirectory: string,
): Promise<SkillBundle> => {
  const manifestPath = join(shareDirectory, SHARE_MANIFEST);
  const stats = await lstatIfPresent(manifestPath);
  if (stats === null || !stats.isFile())
    throw new Error(`${manifestPath} is not a file.`);
  let parsed: ShareManifest;
  try {
    parsed = shareManifestSchema.parse(
      JSON.parse(await readFile(manifestPath, "utf8")),
    );
  } catch {
    throw new Error(
      `${manifestPath} can't be read; reinstall Neuve to repair the skill files.`,
    );
  }
  const skill = parsed.skills[0]!;
  const folder = join(shareDirectory, SKILL_NAME);
  const files: Array<SkillFile> = [];
  for (const entry of skill.files) {
    const path = join(folder, entry.path);
    await requireRealFolders(folder, entry.path);
    const fileStats = await lstatIfPresent(path);
    const bytes =
      fileStats?.isFile() === true
        ? new Uint8Array(await readFile(path))
        : undefined;
    if (bytes === undefined || sha256Of(bytes) !== entry.sha256)
      throw new Error(
        `${path} doesn't match ${manifestPath}; reinstall Neuve to repair the skill files.`,
      );
    files.push({ path: entry.path, bytes, sha256: entry.sha256 });
  }
  const skillMd = files.find((file) => file.path === "SKILL.md");
  if (
    skillMd === undefined ||
    frontmatterVersion(new TextDecoder().decode(skillMd.bytes)) !==
      skill.version
  )
    throw new Error(
      `${join(folder, "SKILL.md")} doesn't carry version ${skill.version}; reinstall Neuve to repair the skill files.`,
    );
  return { name: SKILL_NAME, version: skill.version, files };
};

/**
 * Writes the shared copy into `shareDirectory` (`<prefix>/share/neuve/skills`, or a release's
 * staging folder): the skill's files first, its manifest last, each atomically. A file already
 * there is replaced only when it holds what `recorded` says Neuve installed at that path, what an
 * interrupted install was writing (`pending`), or the same bytes; anything else is refused before
 * the first write. A file the previous install recorded and this bundle no longer has is removed
 * when it still holds the recorded bytes. Returns what was written, for the install's record.
 */
export const writeSkillShare = async (
  input: Readonly<{
    bundle: SkillBundle;
    shareDirectory: string;
    /** What the previous install recorded, path (relative to `shareDirectory`) to SHA-256. */
    recorded?: ReadonlyMap<string, string>;
    /** SHA-256s an interrupted install was writing. */
    pending?: ReadonlySet<string>;
    /** Only run the checks, so an install can refuse before its first copy of anything. */
    checkOnly?: boolean;
  }>,
): Promise<ReadonlyArray<{ path: string; sha256: string }>> => {
  const root = resolve(input.shareDirectory);
  const recorded = input.recorded ?? new Map<string, string>();
  const pending = input.pending ?? new Set<string>();
  const files = shareFiles(input.bundle);
  const incoming = new Set(files.map((file) => file.path));
  const owned = (path: string, sha256: string, incomingSha?: string) =>
    recorded.get(path) === sha256 ||
    pending.has(sha256) ||
    incomingSha === sha256;
  const rootStats = await lstatIfPresent(root);
  if (
    rootStats !== null &&
    (rootStats.isSymbolicLink() || !rootStats.isDirectory())
  )
    throw new Error(
      `Refusing to write the skill files into ${root}: it is not a folder Neuve made. Move it away and rerun.`,
    );
  const stale: Array<string> = [];
  for (const file of files) {
    await requireRealFolders(root, file.path);
    const path = join(root, file.path);
    const stats = await lstatIfPresent(path);
    if (stats === null) continue;
    if (
      !stats.isFile() ||
      !owned(file.path, sha256Of(await readFile(path)), file.sha256)
    )
      throw new Error(
        `Refusing to replace ${path}: Neuve did not install it. Move it away and rerun.`,
      );
  }
  for (const [path] of recorded) {
    if (incoming.has(path) || !skillPathSchema.safeParse(path).success)
      continue;
    const absolute = join(root, path);
    await requireRealFolders(root, path);
    const stats = await lstatIfPresent(absolute);
    if (stats === null) continue;
    if (stats.isFile() && owned(path, sha256Of(await readFile(absolute))))
      stale.push(absolute);
  }
  if (input.checkOnly === true)
    return files.map(({ path, sha256 }) => ({ path, sha256 }));
  for (const file of files) {
    const path = join(root, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFileAtomically(path, file.bytes);
  }
  for (const path of stale) {
    await rm(path, { force: true });
    await rmdir(dirname(path)).catch(() => undefined);
  }
  return files.map(({ path, sha256 }) => ({ path, sha256 }));
};
