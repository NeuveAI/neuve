import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Capture committed identity plus dirty content without treating a clean
 * checkout as approval. Prints evidence; it does not mutate either repository.
 */
const git = (repository: string, args: readonly string[]): string => {
  const result = Bun.spawnSync(["git", "-C", repository, ...args]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || "Git state capture failed.");
  }
  return result.stdout.toString();
};

const digest = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const repositoryState = (repository: string) => {
  const status = git(repository, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  const records = status.split("\0").filter(Boolean);
  const dirty = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record === undefined) continue;
    const change = record.slice(0, 2);
    const path = record.slice(3);
    const absolute = resolve(repository, path);
    let content: string | null = null;
    try {
      const metadata = lstatSync(absolute);
      if (metadata.isSymbolicLink()) content = digest(readlinkSync(absolute));
      else if (metadata.isFile()) content = digest(readFileSync(absolute));
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      ) {
        throw error;
      }
    }
    dirty.push({ status: change, path, content_sha256: content });
    if (change.includes("R") || change.includes("C")) index++;
  }
  return {
    repository,
    revision: git(repository, ["rev-parse", "HEAD"]).trim(),
    branch: git(repository, ["branch", "--show-current"]).trim(),
    dirty,
    tracked_diff_sha256: digest(git(repository, ["diff", "HEAD", "--binary"])),
  };
};

export const captureDevelopmentState = () => {
  const workspace = resolve(import.meta.dir, "..");
  return {
    schema_version: 1,
    captured_at: new Date().toISOString(),
    workspace: repositoryState(workspace),
    graph: repositoryState(resolve(workspace, "apps/neuve-graph")),
  };
};

if (import.meta.main) {
  console.log(JSON.stringify(captureDevelopmentState(), null, 2));
}
