import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import {
  GitReadRefusal,
  preflightLocalGitRead,
  qualifyLocalGitRead,
  type GitReadObservation,
  type GitReadRun,
} from "../src/git-read-qualification.ts";
import {
  describeQualifiedCommitSource,
  readQualifiedCommitSource,
  createQualifiedCommitSourceEntryResolver,
  resolveQualifiedCommitSourceView,
} from "../src/semantic-source-read.ts";

// Each test runs 30 to 115 git processes one after another (fixture, read
// qualification, then a fenced read per tree and blob), so its time is spawn
// latency. Alone the heaviest takes about 1.3 s; under `bun run check`, with
// every package's suites and typechecks running at once on a 12-core machine,
// it measured 5.8 to 8.0 s, past Bun's 5 s default. 20 s keeps 2.5x headroom.
setDefaultTimeout(20_000);

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const literalPath = "nested/β\tline\n.unusual";
const beforeText = "\uFEFFbefore\r\nβ\n";
const afterText = "\uFEFFafter\r\nβ\n";
const renamedText = "same bytes on either rename side\n";
const binaryBytes = Buffer.from([0, 1, 255, 10]);
const blobOid = (format: "sha1" | "sha256", bytes: Uint8Array) =>
  createHash(format)
    .update(`blob ${bytes.byteLength}\0`)
    .update(bytes)
    .digest("hex");
const resolveEntry = (
  git: Parameters<typeof createQualifiedCommitSourceEntryResolver>[0],
  input: Parameters<
    ReturnType<typeof createQualifiedCommitSourceEntryResolver>
  >[0],
  run: GitReadRun = {},
) => createQualifiedCommitSourceEntryResolver(git, run)(input);

const fixture = async (format: "sha1" | "sha256") => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "neuve-commit-entry-")),
  );
  roots.push(root);
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      timeout: 5000,
      env: {
        ...environment,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-b", "main", `--object-format=${format}`);
  git("config", "user.name", "Native source entry fixture");
  git("config", "user.email", "native@example.invalid");
  git("config", "commit.gpgsign", "false");
  await mkdir(join(root, "nested"));
  await mkdir(join(root, "unrelated/deep"), { recursive: true });
  await writeFile(join(root, literalPath), beforeText);
  await writeFile(join(root, "nested/sibling"), "shared ancestor\n");
  await writeFile(join(root, "old.name"), renamedText);
  await writeFile(join(root, "deleted.data"), "deleted original\n");
  await writeFile(join(root, "mode"), "unchanged executable bytes\n");
  await writeFile(join(root, "binary"), binaryBytes);
  await writeFile(join(root, "oversize"), "x".repeat(512));
  await writeFile(join(root, "unrelated/deep/neighbor"), "not selected\n");
  git("add", ".");
  git("commit", "-m", "before");
  const base = git("rev-parse", "HEAD");
  await writeFile(join(root, literalPath), afterText);
  await rename(join(root, "old.name"), join(root, "new.name"));
  await rm(join(root, "deleted.data"));
  await chmod(join(root, "mode"), 0o755);
  await symlink("mode", join(root, "link"));
  git("add", "-A");
  git("update-index", "--add", "--cacheinfo", `160000,${base},vendor/link`);
  git("commit", "-m", "after");
  const head = git("rev-parse", "HEAD");
  const qualified = await qualifyLocalGitRead(
    await preflightLocalGitRead({ repository: root, workdir: root }),
  );
  const before = await resolveQualifiedCommitSourceView(qualified, {
    commit: base,
  });
  const after = await resolveQualifiedCommitSourceView(qualified, {
    commit: head,
  });
  return { root, git, qualified, before, after };
};

const formats: readonly ("sha1" | "sha256")[] = ["sha1", "sha256"];
for (const format of formats) {
  test(`qualified exact paths retain literal names, modes and bytes in ${format}`, async () => {
    const input = await fixture(format);
    const observations: GitReadObservation[] = [];
    const run = {
      onObservation: (observation: GitReadObservation) => {
        observations.push(observation);
      },
    };
    const read = async (view: typeof input.before, path: string) => {
      const entry = await resolveEntry(input.qualified, { ...view, path }, run);
      return readQualifiedCommitSource(
        input.qualified,
        { ...view, entry, maximumBytes: 1024 },
        run,
      );
    };
    const old = await read(input.before, literalPath);
    const current = await read(input.after, literalPath);
    expect({
      path: old.path,
      mode: old.mode,
      oid: old.oid,
      bytes: Buffer.from(old.bytes),
    }).toEqual({
      path: literalPath,
      mode: "100644",
      oid: blobOid(format, Buffer.from(beforeText)),
      bytes: Buffer.from(beforeText),
    });
    expect({
      path: current.path,
      mode: current.mode,
      oid: current.oid,
      bytes: Buffer.from(current.bytes),
    }).toEqual({
      path: literalPath,
      mode: "100644",
      oid: blobOid(format, Buffer.from(afterText)),
      bytes: Buffer.from(afterText),
    });
    const oldName = await read(input.before, "old.name");
    const newName = await read(input.after, "new.name");
    expect(Buffer.from(oldName.bytes).toString("utf8")).toBe(renamedText);
    expect(Buffer.from(newName.bytes).toString("utf8")).toBe(renamedText);
    expect((await read(input.before, "mode")).mode).toBe("100644");
    expect((await read(input.after, "mode")).mode).toBe("100755");
    expect(Buffer.from((await read(input.after, "binary")).bytes)).toEqual(
      binaryBytes,
    );
    expect(
      Buffer.from((await read(input.before, "deleted.data")).bytes).toString(
        "utf8",
      ),
    ).toBe("deleted original\n");
    expect(
      observations.some(
        (observation) => observation.command === "source-entry",
      ),
    ).toBe(true);
    expect(
      observations.some((observation) => observation.command === "blob-body"),
    ).toBe(true);
    expect(
      observations.some((observation) => observation.command === "tree-body"),
    ).toBe(true);
    const unselectedTree = input.git(
      "rev-parse",
      `${input.after.commit}:unrelated`,
    );
    expect(
      observations.filter(
        (observation) =>
          observation.command === "tree-body" &&
          observation.argv.at(-1) === unselectedTree,
      ),
    ).toEqual([]);
  });
}

test("metadata reports oversized originals before a body read", async () => {
  const input = await fixture("sha1");
  const observations: GitReadObservation[] = [];
  const run = {
    onObservation: (observation: GitReadObservation) => {
      observations.push(observation);
    },
  };
  const entry = await resolveEntry(
    input.qualified,
    { ...input.after, path: "oversize" },
    run,
  );
  const metadata = await describeQualifiedCommitSource(
    input.qualified,
    { ...input.after, entry },
    run,
  );
  expect({
    path: metadata.path,
    mode: metadata.mode,
    byteLength: metadata.byteLength,
  }).toEqual({ path: "oversize", mode: "100644", byteLength: 512 });
  expect(
    observations.filter((observation) => observation.command === "blob-body"),
  ).toEqual([]);
  await expect(
    readQualifiedCommitSource(
      input.qualified,
      { ...input.after, entry, maximumBytes: 1 },
      run,
    ),
  ).rejects.toBeInstanceOf(GitReadRefusal);
  expect(
    observations.filter((observation) => observation.command === "blob-body"),
  ).toEqual([]);
});

test("wrong views, absent and non-regular paths refuse without substituting another entry", async () => {
  const input = await fixture("sha1");
  const valid = await resolveEntry(input.qualified, {
    ...input.after,
    path: "mode",
  });
  expect({ path: valid.path, mode: valid.mode }).toEqual({
    path: "mode",
    mode: "100755",
  });
  for (const path of [
    "missing",
    "deleted.data",
    "old.name",
    "link",
    "vendor/link",
    "nested",
    "/absolute",
    "../mode",
    "nested/../mode",
    "mode\0suffix",
  ]) {
    await expect(
      resolveEntry(input.qualified, { ...input.after, path }),
    ).rejects.toBeInstanceOf(GitReadRefusal);
  }
  await expect(
    resolveEntry(input.qualified, {
      commit: input.after.commit,
      tree: input.before.tree,
      path: "mode",
    }),
  ).rejects.toBeInstanceOf(GitReadRefusal);
});

test("current configuration changes and cancellation still fence a previously qualified reader", async () => {
  const input = await fixture("sha1");
  expect(
    (await resolveEntry(input.qualified, { ...input.after, path: "mode" }))
      .mode,
  ).toBe("100755");
  const abort = new AbortController();
  abort.abort();
  await expect(
    resolveEntry(
      input.qualified,
      { ...input.after, path: "mode" },
      { signal: abort.signal },
    ),
  ).rejects.toBeInstanceOf(GitReadRefusal);
  input.git("config", "native.sourceEntry", "changed");
  await expect(
    resolveEntry(input.qualified, { ...input.after, path: "mode" }),
  ).rejects.toBeInstanceOf(GitReadRefusal);
});

test("one request verifies shared ancestors once and leaves unselected subtrees unread", async () => {
  const input = await fixture("sha1");
  const observations: GitReadObservation[] = [];
  const resolve = createQualifiedCommitSourceEntryResolver(input.qualified, {
    onObservation: (observation) => {
      observations.push(observation);
    },
  });
  const first = await resolve({ ...input.after, path: literalPath });
  const sibling = await resolve({ ...input.after, path: "nested/sibling" });
  expect({ path: first.path, mode: first.mode, oid: first.oid }).toEqual({
    path: literalPath,
    mode: "100644",
    oid: blobOid("sha1", Buffer.from(afterText)),
  });
  expect(sibling.oid).toBe(blobOid("sha1", Buffer.from("shared ancestor\n")));
  const rootTree = input.after.tree;
  const parentTree = input.git("rev-parse", `${input.after.commit}:nested`);
  expect(
    observations
      .filter((observation) => observation.command === "tree-body")
      .map((observation) => observation.argv.at(-1))
      .sort(),
  ).toEqual([rootTree, parentTree].sort());
});

const corruptTreeMember = async (root: string, oid: string) => {
  const path = join(root, ".git/objects", oid.slice(0, 2), oid.slice(2));
  const bytes = inflateSync(await readFile(path));
  const last = bytes.at(-1);
  if (last === undefined) throw new Error("Empty native tree fixture");
  bytes[bytes.length - 1] = last ^ 1;
  await chmod(path, 0o600);
  await writeFile(path, deflateSync(bytes));
};

test("unselected corrupted tree is untouched but selected ancestor membership must hash-match", async () => {
  const input = await fixture("sha1");
  const unselectedTree = input.git(
    "rev-parse",
    `${input.after.commit}:unrelated`,
  );
  await corruptTreeMember(input.root, unselectedTree);
  const qualified = await qualifyLocalGitRead(
    await preflightLocalGitRead({
      repository: input.root,
      workdir: input.root,
    }),
  );
  const observations: GitReadObservation[] = [];
  const resolve = createQualifiedCommitSourceEntryResolver(qualified, {
    onObservation: (observation) => {
      observations.push(observation);
    },
  });
  const selected = await resolve({ ...input.after, path: literalPath });
  expect(selected.oid).toBe(blobOid("sha1", Buffer.from(afterText)));
  expect(
    observations.filter(
      (observation) =>
        observation.command === "tree-body" &&
        observation.argv.at(-1) === unselectedTree,
    ),
  ).toEqual([]);
  try {
    await resolve({ ...input.after, path: "unrelated/deep/neighbor" });
    throw new Error("Accepted corrupted selected ancestor");
  } catch (error) {
    expect(error).toBeInstanceOf(GitReadRefusal);
    if (!(error instanceof GitReadRefusal)) throw error;
    expect(error.detail).toBe("tree-identity");
  }
});
