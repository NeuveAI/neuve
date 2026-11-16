import { createHash } from "node:crypto";
import {
  GitReadRefusal,
  gitReadText,
  recheckLocalGitRead,
  runQualifiedGit,
  type GitReadRun,
  type QualifiedGitRead,
} from "./git-read-qualification.ts";

export type CommitSourceEntry = Readonly<{
  path: string;
  oid: string;
  mode: "100644" | "100755";
}>;
export type CommitSourceOmission = Readonly<{
  path: string;
  oid: string;
  reason: "symlink" | "submodule" | "entry-limit" | "tree-byte-limit";
}>;
export type CommitSourceInventory = Readonly<{
  commit: string;
  tree: string;
  entries: readonly CommitSourceEntry[];
  directories: readonly Readonly<{
    path: string;
    oid: string;
    byteLength: number;
  }>[];
  omissions: readonly CommitSourceOmission[];
  completeTreeTraversal: boolean;
  treeObjectsRead: number;
  treeBytesRead: number;
  enumeratedEntries: number;
}>;

const oidPattern = (format: "sha1" | "sha256") =>
  format === "sha1" ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/;
const pathIsRelative = (path: string) =>
  path.length > 0 &&
  !path.includes("\0") &&
  path
    .split("/")
    .every((part) => part.length > 0 && part !== "." && part !== "..");
const objectMatches = (
  format: "sha1" | "sha256",
  kind: "tree" | "blob",
  bytes: Uint8Array,
  oid: string,
) =>
  createHash(format)
    .update(`${kind} ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex") === oid;

export const decodeCommitTree = (
  bytes: Uint8Array,
  format: "sha1" | "sha256",
) => {
  const entries: {
    name: string;
    oid: string;
    mode: "40000" | "100644" | "100755" | "120000" | "160000";
  }[] = [];
  const width = format === "sha1" ? 20 : 32;
  const buffer = Buffer.from(bytes);
  const names = new Set<string>();
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    const nul = buffer.indexOf(0, space + 1);
    if (space < offset || nul < space || nul + 1 + width > buffer.length)
      throw new GitReadRefusal("command", "tree-entry-framing");
    const mode = buffer.subarray(offset, space).toString("latin1");
    if (
      mode !== "40000" &&
      mode !== "100644" &&
      mode !== "100755" &&
      mode !== "120000" &&
      mode !== "160000"
    )
      throw new GitReadRefusal("command", "tree-entry-mode");
    let name: string;
    try {
      name = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        buffer.subarray(space + 1, nul),
      );
    } catch {
      throw new GitReadRefusal("command", "tree-entry-name-encoding");
    }
    if (!pathIsRelative(name) || name.includes("/") || names.has(name))
      throw new GitReadRefusal("command", "tree-entry-name");
    names.add(name);
    entries.push({
      name,
      mode,
      oid: buffer.subarray(nul + 1, nul + 1 + width).toString("hex"),
    });
    offset = nul + 1 + width;
  }
  return entries;
};

export const resolveQualifiedCommitSourceView = async (
  git: QualifiedGitRead,
  input: Readonly<{ commit: string }>,
  run: GitReadRun = {},
): Promise<Readonly<{ repository: string; commit: string; tree: string }>> => {
  if (!oidPattern(git.objectFormat).test(input.commit))
    throw new GitReadRefusal("command", "source-view-input");
  const outputBytes = input.commit.length + 2;
  const commit = gitReadText(
    await runQualifiedGit(
      git,
      { kind: "exact-commit", oid: input.commit },
      run,
      outputBytes,
    ),
  );
  if (commit !== input.commit)
    throw new GitReadRefusal("command", "source-view-commit");
  const tree = gitReadText(
    await runQualifiedGit(
      git,
      { kind: "exact-tree", oid: commit },
      run,
      outputBytes,
    ),
  );
  if (!oidPattern(git.objectFormat).test(tree))
    throw new GitReadRefusal("command", "source-view-tree");
  if (
    gitReadText(
      await runQualifiedGit(git, { kind: "object-type", oid: tree }, run, 16),
    ) !== "tree"
  )
    throw new GitReadRefusal("command", "source-view-tree-type");
  await recheckLocalGitRead(git, run);
  return { repository: git.scope.repository, commit, tree };
};

export const createQualifiedCommitSourceEntryResolver = (
  git: QualifiedGitRead,
  run: GitReadRun = {},
): ((
  input: Readonly<{ commit: string; tree: string; path: string }>,
) => Promise<CommitSourceEntry>) => {
  const trees = new Map<string, Promise<ReturnType<typeof decodeCommitTree>>>();
  let treeBytesRead = 0;
  let entriesRead = 0;
  const readTree = (oid: string) => {
    const cached = trees.get(oid);
    if (cached) return cached;
    const reading = (async () => {
      const sizeText = gitReadText(
        await runQualifiedGit(git, { kind: "object-size", oid }, run, 128),
      );
      if (!/^(0|[1-9][0-9]*)$/.test(sizeText))
        throw new GitReadRefusal("command", "tree-size");
      const size = Number(sizeText);
      if (
        !Number.isSafeInteger(size) ||
        size > 1024 * 1024 ||
        treeBytesRead + size > 16 * 1024 * 1024
      )
        throw new GitReadRefusal("command", "source-entry-tree-byte-limit");
      treeBytesRead += size;
      const body = await runQualifiedGit(
        git,
        { kind: "tree-body", oid },
        run,
        size,
      );
      if (
        body.bytes.byteLength !== size ||
        !objectMatches(git.objectFormat, "tree", body.bytes, oid)
      )
        throw new GitReadRefusal("command", "tree-identity");
      const decoded = decodeCommitTree(body.bytes, git.objectFormat);
      if (entriesRead + decoded.length > 100000)
        throw new GitReadRefusal("command", "source-entry-limit");
      entriesRead += decoded.length;
      return decoded;
    })();
    trees.set(oid, reading);
    return reading;
  };
  return async (input) => {
    if (
      !oidPattern(git.objectFormat).test(input.commit) ||
      !oidPattern(git.objectFormat).test(input.tree) ||
      !pathIsRelative(input.path)
    )
      throw new GitReadRefusal("command", "source-entry-input");
    const view = await resolveQualifiedCommitSourceView(
      git,
      { commit: input.commit },
      run,
    );
    if (view.tree !== input.tree)
      throw new GitReadRefusal("command", "source-entry-view");
    const components = input.path.split("/");
    let tree = input.tree;
    for (const [index, name] of components.entries()) {
      const entries = await readTree(tree);
      const selected = entries.find((entry) => entry.name === name);
      if (!selected)
        throw new GitReadRefusal("command", "source-entry-missing");
      if (index === components.length - 1) {
        if (selected.mode !== "100644" && selected.mode !== "100755")
          throw new GitReadRefusal("command", "source-entry-regular-file");
        await recheckLocalGitRead(git, run);
        return { path: input.path, oid: selected.oid, mode: selected.mode };
      }
      if (selected.mode !== "40000")
        throw new GitReadRefusal("command", "source-entry-ancestor");
      tree = selected.oid;
    }
    throw new GitReadRefusal("command", "source-entry-missing");
  };
};

export const enumerateQualifiedCommitTree = async (
  git: QualifiedGitRead,
  input: Readonly<{
    commit: string;
    tree: string;
    maximumEntries: number;
    maximumTreeBytes: number;
    maximumTotalTreeBytes: number;
  }>,
  run: GitReadRun = {},
): Promise<CommitSourceInventory> => {
  if (
    !oidPattern(git.objectFormat).test(input.commit) ||
    !oidPattern(git.objectFormat).test(input.tree) ||
    [
      input.maximumEntries,
      input.maximumTreeBytes,
      input.maximumTotalTreeBytes,
    ].some((value) => !Number.isSafeInteger(value) || value < 1)
  )
    throw new GitReadRefusal("command", "source-inventory-input");
  if (
    gitReadText(
      await runQualifiedGit(
        git,
        { kind: "exact-commit", oid: input.commit },
        run,
      ),
    ) !== input.commit ||
    gitReadText(
      await runQualifiedGit(
        git,
        { kind: "exact-tree", oid: input.commit },
        run,
      ),
    ) !== input.tree
  )
    throw new GitReadRefusal("command", "source-inventory-view");
  const pending = [{ path: "", oid: input.tree }];
  const entries: CommitSourceEntry[] = [];
  const directories: { path: string; oid: string; byteLength: number }[] = [];
  const omissions: CommitSourceOmission[] = [];
  let treeObjectsRead = 0;
  let treeBytesRead = 0;
  let enumerated = 0;
  let completeTreeTraversal = true;
  while (pending.length) {
    const next = pending.pop();
    if (!next) break;
    if (enumerated >= input.maximumEntries) {
      omissions.push({ ...next, reason: "entry-limit" });
      completeTreeTraversal = false;
      continue;
    }
    const sizeText = gitReadText(
      await runQualifiedGit(git, { kind: "object-size", oid: next.oid }, run),
    );
    if (!/^(0|[1-9][0-9]*)$/.test(sizeText))
      throw new GitReadRefusal("command", "tree-size");
    const size = Number(sizeText);
    if (
      !Number.isSafeInteger(size) ||
      size > input.maximumTreeBytes ||
      treeBytesRead + size > input.maximumTotalTreeBytes
    ) {
      omissions.push({ ...next, reason: "tree-byte-limit" });
      completeTreeTraversal = false;
      continue;
    }
    const body = await runQualifiedGit(
      git,
      { kind: "tree-body", oid: next.oid },
      run,
      size,
    );
    if (
      body.bytes.byteLength !== size ||
      !objectMatches(git.objectFormat, "tree", body.bytes, next.oid)
    )
      throw new GitReadRefusal("command", "tree-identity");
    treeObjectsRead++;
    treeBytesRead += size;
    directories.push({ path: next.path, oid: next.oid, byteLength: size });
    const decoded = decodeCommitTree(body.bytes, git.objectFormat);
    for (const entry of decoded) {
      const path = next.path ? `${next.path}/${entry.name}` : entry.name;
      if (enumerated++ >= input.maximumEntries) {
        omissions.push({ path, oid: entry.oid, reason: "entry-limit" });
        completeTreeTraversal = false;
        continue;
      }
      switch (entry.mode) {
        case "40000":
          pending.push({ path, oid: entry.oid });
          break;
        case "100644":
        case "100755":
          entries.push({ path, oid: entry.oid, mode: entry.mode });
          break;
        case "120000":
          omissions.push({ path, oid: entry.oid, reason: "symlink" });
          break;
        case "160000":
          omissions.push({ path, oid: entry.oid, reason: "submodule" });
          break;
      }
    }
  }
  await recheckLocalGitRead(git, run);
  return {
    commit: input.commit,
    tree: input.tree,
    entries,
    directories,
    omissions,
    completeTreeTraversal,
    treeObjectsRead,
    treeBytesRead,
    enumeratedEntries: enumerated,
  };
};

type CommitSourceSelection = Readonly<{
  commit: string;
  tree: string;
  entry: CommitSourceEntry;
}>;
export type CommitSourceMetadata = CommitSourceEntry &
  Omit<CommitSourceSelection, "entry"> &
  Readonly<{
    kind: "regular-blob-metadata";
    repository: string;
    byteLength: number;
  }>;

export const describeQualifiedCommitSource = async (
  git: QualifiedGitRead,
  input: CommitSourceSelection,
  run: GitReadRun = {},
): Promise<CommitSourceMetadata> => {
  if (
    !oidPattern(git.objectFormat).test(input.commit) ||
    !oidPattern(git.objectFormat).test(input.tree) ||
    !pathIsRelative(input.entry.path) ||
    (input.entry.mode !== "100644" && input.entry.mode !== "100755") ||
    !oidPattern(git.objectFormat).test(input.entry.oid)
  )
    throw new GitReadRefusal("command", "source-read-input");
  if (
    gitReadText(
      await runQualifiedGit(
        git,
        { kind: "exact-commit", oid: input.commit },
        run,
      ),
    ) !== input.commit ||
    gitReadText(
      await runQualifiedGit(
        git,
        { kind: "exact-tree", oid: input.commit },
        run,
      ),
    ) !== input.tree
  )
    throw new GitReadRefusal("command", "source-read-view");
  const metadata = await runQualifiedGit(
    git,
    { kind: "source-entry", oid: input.commit, path: input.entry.path },
    run,
    Buffer.byteLength(input.entry.path) + 128,
  );
  const expected = `${input.entry.mode} blob ${input.entry.oid}\t${input.entry.path}\0`;
  if (
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      metadata.bytes,
    ) !== expected
  )
    throw new GitReadRefusal("command", "source-read-entry");
  const objectType = gitReadText(
    await runQualifiedGit(
      git,
      { kind: "object-type", oid: input.entry.oid },
      run,
      128,
    ),
  );
  if (objectType !== "blob")
    throw new GitReadRefusal("command", "source-metadata-type");
  const sizeText = gitReadText(
    await runQualifiedGit(
      git,
      { kind: "object-size", oid: input.entry.oid },
      run,
      128,
    ),
  );
  if (!/^(0|[1-9][0-9]*)$/.test(sizeText))
    throw new GitReadRefusal("command", "source-metadata-size");
  const byteLength = Number(sizeText);
  if (!Number.isSafeInteger(byteLength))
    throw new GitReadRefusal("command", "source-metadata-size");
  await recheckLocalGitRead(git, run);
  return {
    kind: "regular-blob-metadata",
    repository: git.scope.repository,
    commit: input.commit,
    tree: input.tree,
    ...input.entry,
    byteLength,
  };
};

export const readQualifiedCommitSource = async (
  git: QualifiedGitRead,
  input: CommitSourceSelection & Readonly<{ maximumBytes: number }>,
  run: GitReadRun = {},
) => {
  if (!Number.isSafeInteger(input.maximumBytes) || input.maximumBytes < 1)
    throw new GitReadRefusal("command", "source-read-input");
  const metadata = await describeQualifiedCommitSource(git, input, run);
  if (metadata.byteLength > input.maximumBytes)
    throw new GitReadRefusal("command", "source-read-byte-limit");
  const body = await runQualifiedGit(
    git,
    { kind: "blob-body", oid: input.entry.oid },
    run,
    input.maximumBytes,
  );
  if (
    body.bytes.byteLength !== metadata.byteLength ||
    !objectMatches(git.objectFormat, "blob", body.bytes, input.entry.oid)
  )
    throw new GitReadRefusal("command", "source-read-blob");
  await recheckLocalGitRead(git, run);
  return {
    commit: input.commit,
    tree: input.tree,
    ...input.entry,
    bytes: body.bytes,
    sha256: createHash("sha256").update(body.bytes).digest("hex"),
  };
};
