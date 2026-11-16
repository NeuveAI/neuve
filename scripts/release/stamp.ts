import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { releaseSchema } from "../../apps/neuve-cli/src/release-metadata.ts";
import { stampInstaller } from "./release.ts";

const root = resolve(import.meta.dir, "../..");

/** The version inside one release archive, read from its `lib/neuve/release.json`. */
const archiveVersion = async (archive: string, name: string) => {
  const target = name.replace(/^neuve-/, "").replace(/\.tar\.gz$/, "");
  const child = Bun.spawn(
    ["tar", "-xOzf", archive, `neuve-${target}/lib/neuve/release.json`],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [text, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${name} has no readable release.json.`);
  return releaseSchema.parse(JSON.parse(text)).version;
};

/**
 * Writes `<folder>/install.sh`: `scripts/install.sh` stamped with the version every release archive
 * in `<folder>` holds, as `bun run release` stamps it. A stamped installer installs its own release
 * by default, and `release --from` accepts only a folder whose installer names that version.
 */
export const stampFolder = async (folder: string) => {
  const archives = (await readdir(folder))
    .filter((name) => /^neuve-.*\.tar\.gz$/.test(name))
    .sort();
  if (archives.length === 0)
    throw new Error(
      `${folder} has no release archives to stamp an installer for.`,
    );
  const versions = new Set(
    await Promise.all(
      archives.map((name) => archiveVersion(join(folder, name), name)),
    ),
  );
  if (versions.size !== 1)
    throw new Error(
      `The release archives in ${folder} hold different versions: ${[...versions].join(", ")}.`,
    );
  const [version] = versions;
  const script = await readFile(join(root, "scripts/install.sh"), "utf8");
  await writeFile(
    join(folder, "install.sh"),
    stampInstaller(script, version!),
    { mode: 0o755 },
  );
  return version!;
};

if (import.meta.main) {
  if (Bun.argv.length !== 3)
    throw new Error("Usage: bun scripts/release/stamp.ts <folder>");
  const version = await stampFolder(resolve(Bun.argv[2] ?? "."));
  await Bun.write(Bun.stdout, `install.sh stamped with ${version}\n`);
}
