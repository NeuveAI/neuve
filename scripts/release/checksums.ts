import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/** SHA256SUMS for `names` in `directory`, or for every archive and install.sh there. */
export const writeChecksums = async (
  directory: string,
  only?: ReadonlyArray<string>,
) => {
  const names = (only === undefined ? await readdir(directory) : [...only])
    .filter((name) => /^neuve-.*\.tar\.gz$/.test(name) || name === "install.sh")
    .sort();
  if (names.length === 0)
    throw new Error("No release archives or install.sh found.");
  const lines = await Promise.all(
    names.map(
      async (name) =>
        `${createHash("sha256")
          .update(await readFile(join(directory, name)))
          .digest("hex")}  ${name}`,
    ),
  );
  await writeFile(join(directory, "SHA256SUMS"), lines.join("\n") + "\n");
};
if (import.meta.main) {
  if (Bun.argv.length !== 3)
    throw new Error("Usage: bun scripts/release/checksums.ts <dir>");
  await writeChecksums(resolve(Bun.argv[2] ?? "."));
}
