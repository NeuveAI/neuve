import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Schema } from "effect";

const repository = resolve(import.meta.dir, "..");
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const argumentsByName = new Map<string, string>();
for (let index = 2; index < Bun.argv.length; index += 2) {
  const name = Bun.argv[index],
    value = Bun.argv[index + 1];
  if (
    !name ||
    !value ||
    !["--ref", "--output", "--parent", "--manifest"].includes(name) ||
    argumentsByName.has(name)
  )
    throw Error(
      "Usage: bun scripts/prepare-review-cut.ts [--ref refs/neuve/reviews/name] [--output directory] [--parent refs/neuve/reviews/previous] [--manifest frozen-source-manifest.json]",
    );
  argumentsByName.set(name, value);
}
const stamp = new Date().toISOString().replaceAll(/[^0-9TZ]/g, "");
const ref = argumentsByName.get("--ref") ?? `refs/neuve/reviews/${stamp}`;
if (!ref.startsWith("refs/neuve/reviews/"))
  throw Error(
    "Review snapshots must use the private refs/neuve/reviews namespace",
  );
const parentRef = argumentsByName.get("--parent");
const manifestPath = argumentsByName.get("--manifest");
const sourceManifestSchema = Schema.Struct({
  sources: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      sha256: Schema.NullOr(Schema.String),
    }),
  ),
});
const selection =
  manifestPath === undefined
    ? undefined
    : Schema.decodeUnknownSync(sourceManifestSchema)(
        JSON.parse(await readFile(resolve(manifestPath), "utf8")),
      );
if (selection) {
  if (!selection.sources.length) throw Error("Source manifest is empty");
  const paths = new Set<string>();
  for (const file of selection.sources) {
    if (
      file.path.startsWith("/") ||
      file.path.includes("\\") ||
      file.path.includes("\0") ||
      file.path
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      file.path === "apps/neuve-graph" ||
      file.path.startsWith(".git/") ||
      file.path === ".git" ||
      paths.has(file.path) ||
      (file.sha256 !== null && !/^[a-f0-9]{64}$/.test(file.sha256))
    )
      throw Error(`Invalid or repeated manifest source: ${file.path}`);
    paths.add(file.path);
  }
}
if (parentRef !== undefined && !parentRef.startsWith("refs/neuve/reviews/"))
  throw Error(
    "An explicit review parent must use the private refs/neuve/reviews namespace",
  );
const output = resolve(
  argumentsByName.get("--output") ??
    join(repository, "neuve", "review-cuts", stamp),
);
const temporary = await mkdtemp(join(tmpdir(), "neuve-private-review-index-"));
const indexFile = join(temporary, "index");
const gitEnvironment = { ...process.env };
for (const name of [
  "GIT_DIR",
  "GIT_COMMON_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_IMPLICIT_WORK_TREE",
])
  delete gitEnvironment[name];
gitEnvironment.GIT_OPTIONAL_LOCKS = "0";
gitEnvironment.GIT_TERMINAL_PROMPT = "0";
gitEnvironment.GIT_PAGER = "cat";
let publishedRevision: string | undefined;
let attemptedRevision: string | undefined;
let ownsOutput = false;
async function git(
  args: string[],
  privateIndex = false,
  input?: Uint8Array | string,
) {
  const child = Bun.spawn(["git", ...args], {
    cwd: repository,
    env: privateIndex
      ? { ...gitEnvironment, GIT_INDEX_FILE: indexFile }
      : gitEnvironment,
    timeout: 30_000,
    stdin:
      input === undefined
        ? "ignore"
        : new Blob([typeof input === "string" ? input : new Uint8Array(input)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw Error(`Git ${args[0]} failed: ${stderr.trim()}`);
  return stdout;
}
async function sourceFile(path: string) {
  const absolute = resolve(repository, path);
  let entry;
  try {
    entry = await lstat(absolute);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return { kind: "deleted" } as const;
    throw error;
  }
  const parent = await realpath(dirname(absolute));
  if (parent !== repository && !parent.startsWith(repository + "/"))
    throw Error(`Source parent escapes repository: ${path}`);
  if (!entry.isFile() && !entry.isSymbolicLink())
    throw Error(`Review source is not a regular file or symlink: ${path}`);
  return {
    kind: "file",
    mode: entry.isSymbolicLink()
      ? "120000"
      : entry.mode & 0o111
        ? "100755"
        : "100644",
    bytes: entry.isSymbolicLink()
      ? Buffer.from(await readlink(absolute))
      : await readFile(absolute),
  } as const;
}
async function verifySelection() {
  for (const file of selection?.sources ?? []) {
    const entry = await sourceFile(file.path);
    const actual = entry.kind === "deleted" ? null : digest(entry.bytes);
    if (actual !== file.sha256)
      throw Error(`Source differs from frozen manifest: ${file.path}`);
  }
}
const pathspecs = selection?.sources.map(
  (file) => `:(top,literal)${file.path}`,
);
const selectedStatus = () =>
  git([
    "status",
    "--porcelain=v1",
    "-z",
    ...(pathspecs
      ? ["--untracked-files=all", "--ignore-submodules=all", "--", ...pathspecs]
      : []),
  ]);
try {
  if (
    (await realpath((await git(["rev-parse", "--show-toplevel"])).trim())) !==
    (await realpath(repository))
  )
    throw Error("The script directory must be the Git repository root");
  await git(["check-ref-format", ref]);
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output, { mode: 0o700 });
  ownsOutput = true;
  const head = (await git(["rev-parse", "HEAD"])).trim();
  if (parentRef !== undefined) await git(["check-ref-format", parentRef]);
  const parentRevision =
    parentRef === undefined
      ? head
      : (
          await git([
            "rev-parse",
            "--verify",
            "--end-of-options",
            parentRef + "^{commit}",
          ])
        ).trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(parentRevision))
    throw Error("The private parent did not resolve to a full commit identity");
  if (parentRef !== undefined) {
    await git(["merge-base", "--is-ancestor", head, parentRevision]);
    const [headGraph, parentGraph] = await Promise.all([
      git(["ls-tree", head, "--", "apps/neuve-graph"]),
      git(["ls-tree", parentRevision, "--", "apps/neuve-graph"]),
    ]);
    if (headGraph !== parentGraph)
      throw Error(
        "The private parent changes Graph attribution relative to HEAD. Establish its explicit review attribution first.",
      );
  }
  const realIndex = resolve(
    repository,
    (await git(["rev-parse", "--git-path", "index"])).trim(),
  );
  const originalIndex = digest(await readFile(realIndex));
  const status = await selectedStatus();
  const [changed, untracked] = await Promise.all([
    git([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      ...(pathspecs ? ["--ignore-submodules=all"] : []),
      "HEAD",
      "--name-only",
      "-z",
      ...(pathspecs ? ["--", ...pathspecs] : []),
    ]),
    git([
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      ...(pathspecs ? ["--", ...pathspecs] : []),
    ]),
  ]);
  const dirtyPaths = [
    ...new Set((changed + untracked).split("\0").filter(Boolean)),
  ].sort();
  const paths = [...dirtyPaths];
  const unchangedDependencies: {
    path: string;
    mode: string;
    blob: string;
    sourceSha256: string;
  }[] = [];
  await verifySelection();
  if (selection && pathspecs) {
    const headEntries = new Map<string, { mode: string; blob: string }>();
    for (const entry of (
      await git(["ls-tree", "-z", "HEAD", "--", ...pathspecs])
    )
      .split("\0")
      .filter(Boolean)) {
      const tab = entry.indexOf("\t");
      const [mode, kind, blob] = entry.slice(0, tab).split(" ");
      if (tab < 0 || !mode || kind !== "blob" || !blob)
        throw Error("Selected dependency is not a committed file");
      headEntries.set(entry.slice(tab + 1), { mode, blob });
    }
    for (const file of selection.sources) {
      if (paths.includes(file.path)) continue;
      const committed = headEntries.get(file.path);
      const current = await sourceFile(file.path);
      if (!committed || current.kind !== "file")
        throw Error(
          `Declared source is neither a captured change nor an unchanged HEAD dependency: ${file.path}`,
        );
      const blob = (
        await git(["hash-object", "--stdin"], false, current.bytes)
      ).trim();
      if (blob !== committed.blob || current.mode !== committed.mode) {
        paths.push(file.path);
        continue;
      }
      unchangedDependencies.push({
        path: file.path,
        mode: current.mode,
        blob,
        sourceSha256: digest(current.bytes),
      });
    }
  }
  paths.sort();
  if (paths.includes("apps/neuve-graph"))
    throw Error(
      "The graph submodule differs from the base. Establish its explicit review attribution before taking this root snapshot.",
    );
  if (!paths.length) throw Error("No current changes to snapshot");
  await git(["read-tree", head], true);
  const inventory: {
    path: string;
    mode: string;
    blob: string | null;
    sourceSha256: string | null;
    bytes: number;
  }[] = [];
  for (const path of paths) {
    const entry = await sourceFile(path);
    if (entry.kind === "deleted") {
      await git(["update-index", "--force-remove", "--", path], true);
      inventory.push({
        path,
        mode: "deleted",
        blob: null,
        sourceSha256: null,
        bytes: 0,
      });
      continue;
    }
    const { bytes, mode } = entry;
    const blob = (
      await git(["hash-object", "-w", "--stdin"], true, bytes)
    ).trim();
    await git(["update-index", "--add", "--cacheinfo", mode, blob, path], true);
    inventory.push({
      path,
      mode,
      blob,
      sourceSha256: digest(bytes),
      bytes: bytes.byteLength,
    });
  }
  const tree = (await git(["write-tree"], true)).trim();
  const revision = (
    await git(
      ["commit-tree", tree, "-p", parentRevision],
      true,
      "Current Neuve implementation verification snapshot\n",
    )
  ).trim();
  // Validate that the captured blobs still describe the working tree before publishing the private ref.
  for (const file of inventory) {
    const entry = await sourceFile(file.path);
    if (file.blob === null) {
      if (entry.kind !== "deleted")
        throw Error(`Source changed during capture: ${file.path}`);
      continue;
    }
    if (
      entry.kind !== "file" ||
      entry.mode !== file.mode ||
      digest(entry.bytes) !== file.sourceSha256
    )
      throw Error(`Source changed during capture: ${file.path}`);
  }
  await verifySelection();
  if (
    (await git(["rev-parse", "HEAD"])).trim() !== head ||
    digest(await readFile(realIndex)) !== originalIndex ||
    (await selectedStatus()) !== status
  )
    throw Error(
      "Repository HEAD, index or inventory changed during capture. Retry after concurrent writers settle.",
    );
  if (
    parentRef !== undefined &&
    (
      await git([
        "rev-parse",
        "--verify",
        "--end-of-options",
        parentRef + "^{commit}",
      ])
    ).trim() !== parentRevision
  )
    throw Error(
      "The private parent ref changed during capture. Retry after concurrent writers settle.",
    );
  attemptedRevision = revision;
  await git(["update-ref", ref, revision, "0".repeat(head.length)]);
  publishedRevision = revision;
  const patch = await git(["diff", "--binary", "--full-index", head, revision]);
  await writeFile(join(output, "source.patch"), patch, { flag: "wx" });
  const receipt = {
    schemaVersion: 1,
    repository,
    baseRevision: head,
    parentRevision,
    parentRef: parentRef ?? null,
    revision,
    ref,
    createdAt: new Date().toISOString(),
    selection:
      selection === undefined
        ? { kind: "all-dirty" }
        : {
            kind: "frozen-source-manifest",
            manifest: resolve(manifestPath ?? ""),
            sources: selection.sources,
            unchangedDependencies,
            outsideSelection:
              "Working files outside the manifest were not inventoried or read.",
          },
    files: inventory.length,
    sourceBytes: inventory.reduce((sum, file) => sum + file.bytes, 0),
    patchBytes: Buffer.byteLength(patch),
    inventory,
    limitations: [
      "This private immutable source cut does not confer review approval.",
      "Private Git parentage does not establish review-unit continuity or a counted review cycle.",
      "The parent repository's HEAD and index were not modified.",
      "Ignored artifacts remain outside the source cut and retain separate evidence attribution.",
      "The Graph submodule retains the base commit identity.",
      ...(selection
        ? [
            "The incremental bundle requires the recorded baseRevision; it does not package committed ancestor history.",
          ]
        : [
            "The full bundle includes committed ancestor history, beyond the dirty files listed in inventory.",
          ]),
    ],
  };
  const bundle = join(temporary, "source.bundle");
  await git([
    "bundle",
    "create",
    bundle,
    ref,
    ...(selection ? [`^${head}`] : []),
  ]);
  if (
    (await git(["bundle", "list-heads", bundle, ref])).trim() !==
      `${revision} ${ref}` ||
    (
      await git([
        "rev-parse",
        "--verify",
        "--end-of-options",
        ref + "^{commit}",
      ])
    ).trim() !== revision
  )
    throw Error("The published review ref changed while writing its artifacts");
  await copyFile(
    bundle,
    join(output, "source.bundle"),
    constants.COPYFILE_EXCL,
  );
  await writeFile(
    join(output, "receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
    { flag: "wx" },
  );
  console.log(
    JSON.stringify(
      {
        ...receipt,
        inventory: undefined,
        receipt: join(output, "receipt.json"),
        bundle: join(output, "source.bundle"),
      },
      null,
      2,
    ),
  );
} catch (error) {
  let refCleanup =
    attemptedRevision === undefined
      ? "not-attempted"
      : "publication-unconfirmed";
  if (publishedRevision !== undefined) {
    try {
      await git(["update-ref", "-d", ref, publishedRevision]);
      refCleanup = "removed-owned-ref";
    } catch {
      refCleanup = "retained-ref-cleanup-rejected";
    }
  }
  if (ownsOutput) {
    try {
      await writeFile(
        join(output, "failure.json"),
        JSON.stringify(
          {
            status: "failed",
            ref,
            revision: publishedRevision ?? attemptedRevision ?? null,
            publication:
              publishedRevision !== undefined
                ? "confirmed"
                : attemptedRevision !== undefined
                  ? "unconfirmed"
                  : "not-attempted",
            refCleanup,
            limitations: [
              "Incomplete artifacts are not a published review cut. A changed ref is never removed by cleanup.",
            ],
          },
          null,
          2,
        ) + "\n",
        { flag: "wx" },
      );
    } catch {
      // Preserve files created by another writer, including an existing failure receipt.
    }
  }
  throw error;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
