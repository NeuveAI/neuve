import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";

const repositoryPaths = async (
  repository: string,
): Promise<readonly string[]> => {
  const process = Bun.spawn(
    ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: repository, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`Git file inventory failed: ${stderr.trim()}`);
  }
  return stdout.split("\0").filter(Boolean).sort();
};

export const repositoryFingerprint = async (
  repository: string,
): Promise<string> => {
  const hash = createHash("sha256");
  for (const relativePath of await repositoryPaths(repository)) {
    if (
      relativePath === "apps/neuve-graph" ||
      relativePath.startsWith("apps/neuve-graph/") ||
      relativePath.includes("/dist/") ||
      relativePath.includes("/node_modules/")
    ) {
      continue;
    }
    const path = join(repository, relativePath);
    try {
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) {
        hash.update(`symlink\0${relativePath}\0${await readlink(path)}\0`);
      } else if (metadata.isFile()) {
        hash.update(
          `file\0${relativePath}\0${(metadata.mode & 0o111).toString(8)}\0`,
        );
        hash.update(await readFile(path));
      } else {
        hash.update(`other\0${relativePath}\0`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hash.update(`missing\0${relativePath}\0`);
    }
  }
  return hash.digest("hex");
};
