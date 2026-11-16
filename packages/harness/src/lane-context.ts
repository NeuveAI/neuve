import { spawnSync } from "node:child_process";
import { publicEntry, type ReadAtHead } from "./lane-rule.ts";

/**
 * A file's text at one revision of a repository, read as a blob of that revision's own tree, so
 * nothing later than it is read; on a replay case the revision is the first one, the only one its
 * clone holds. A path that is no file there (missing, or a folder) reads as null. The revision must
 * be in the repository, or this fails at once rather than reading every path as missing. Reads are
 * kept for the revision's life, since a package's entry is read once per file.
 */
export const readAtRevision = (repository: string, oid: string): ReadAtHead => {
  if (!/^[0-9a-f]{40}$/.test(oid))
    throw new Error(`a revision is read by its full object id, got ${oid}`);
  const present = spawnSync(
    "git",
    ["-C", repository, "cat-file", "-e", `${oid}^{commit}`],
    { encoding: "utf8" },
  );
  if (present.status !== 0)
    throw new Error(`${repository} holds no commit ${oid}`);
  const read = new Map<string, string | null>();
  return (path) => {
    if (read.has(path)) return read.get(path)!;
    // A blob only: a folder's path is no file, so a specifier naming it falls through to its index.
    const shown = spawnSync(
      "git",
      ["-C", repository, "cat-file", "blob", `${oid}:${path}`],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    const text = shown.status === 0 ? shown.stdout : null;
    read.set(path, text);
    return text;
  };
};

/**
 * Whether an exported name crosses its package's public entry, at a range's head: what the
 * `public-surface-entry` lane candidate reads. The lanes evals call it, and the composition is to
 * call it, or hand `publicEntry` the same head read through its own readers, when a candidate is
 * placed, so a kept rule places units live as it scored.
 */
export const publicEntryAt = (repository: string, headOid: string) =>
  publicEntry(readAtRevision(repository, headOid));
