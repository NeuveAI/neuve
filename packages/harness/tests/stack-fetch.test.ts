import { captureOutlineSource } from "../src/graph-outline.ts";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  emptyRepoStack,
  readCatalog,
  readRepoStack,
  recordHold,
  resolveGitBinary,
  resolveStackSettings,
  runStackFetch,
  runStackIndex,
  scrubbedEnvironment,
  searchTrees,
  stackStateAt,
  storeLayout,
  writeRepoStack,
  type FetchInput,
  type StoreGit,
} from "../src/stack/index.ts";
import { integrityOf, tarGz } from "./fixtures/stack/archives.ts";
import {
  bunLock,
  commitFiles,
  git,
  repositoryWith,
  scratch,
} from "./fixtures/stack/repos.ts";

/**
 * Why: the fetch path is where untrusted bytes enter the user's disk (SC5–SC7). Each rule here
 * fails silently if broken: a wrong hash or a crafted archive would simply be stored, a private
 * name would simply be looked up publicly, a path-based add would quietly change file bytes, a
 * filtered tree would quietly fetch what it left out, and the caps and budget would quietly let
 * disk grow. The registry is a local fake (`http://127.0.0.1`, allowed for tests only); upstream
 * trees come from a local repository over `file://`, allowed for tests only.
 */

setDefaultTimeout(120_000);
const root = scratch("neuve-stack-fetch-");
const requests: Array<string> = [];
const archives = new Map<string, Uint8Array>();
const metadata = new Map<string, unknown>();
let server: ReturnType<typeof Bun.serve> | undefined;
let canBind = true;

const gitPath = resolveGitBinary() ?? "git";
const storeGit: StoreGit = {
  gitPath,
  env: scrubbedEnvironment({ gitPath, home: join(root, "home") }),
};

const good = tarGz([
  {
    path: "package/package.json",
    content: '{"name":"good","version":"1.0.0"}',
  },
  {
    path: "package/.gitattributes",
    content: "* text eol=crlf\n*.txt filter=lfs\n",
  },
  { path: "package/.gitignore", content: "ignored.txt\n" },
  { path: "package/ignored.txt", content: "kept although ignored\n" },
  { path: "package/crlf.txt", content: "a\r\nb\r\n" },
  {
    path: "package/src/route.ts",
    content: "export const createRootRoute = () => scaffold;\n",
  },
]);
const other = tarGz([
  { path: "package/index.js", content: "module.exports = 'other';\n" },
]);
const dotgit = tarGz([
  { path: "package/index.js", content: "x" },
  {
    path: "package/.git/config",
    content: "[core]\n\tfsmonitor = touch pwned\n",
  },
]);
const served = tarGz([{ path: "package/index.js", content: "served" }]);
const markers = scratch("neuve-stack-markers-");
/** A shell command as a quoted git config value: the path is one sh word, whatever it holds. */
const configCommand = (command: string, path: string): string =>
  `"${`${command} '${path.replaceAll("'", `'\\''`)}'`.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
/** A folder git takes for a bare repository, whose configuration runs a command on `git status`. */
const bareLayout = (
  prefix: string,
  marker: string,
): Record<string, string> => ({
  [`${prefix}HEAD`]: "ref: refs/heads/main\n",
  [`${prefix}config`]: `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = .\n\tfsmonitor = ${configCommand("touch", join(markers, marker))}\n`,
  [`${prefix}objects/info/x`]: "x\n",
  [`${prefix}refs/heads/x`]: "x\n",
});
const bareFiles = {
  ...bareLayout("", "root-ran"),
  "src/a.ts": "export const a = 1;\n",
  ...bareLayout("test/fixture.git/", "fixture-ran"),
};
const bare = tarGz(
  Object.entries(bareFiles).map(([path, content]) => ({
    path: `package/${path}`,
    content,
  })),
);
/** git status in a folder with nothing but PATH and a fresh HOME. */
const gitStatusIn = (cwd: string) =>
  Bun.spawnSync(["git", "status"], {
    cwd,
    env: {
      PATH: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
      HOME: markers,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

let upstreamCommit = "";
let upstreamRepo = "";

beforeAll(() => {
  archives.set("/good/-/good-1.0.0.tgz", good);
  archives.set("/other/-/other-1.0.0.tgz", other);
  archives.set("/dotgit/-/dotgit-1.0.0.tgz", dotgit);
  archives.set("/bad-hash/-/bad-hash-1.0.0.tgz", served);
  archives.set("/bare/-/bare-1.0.0.tgz", bare);
  upstreamRepo = repositoryWith(join(root, "upstream"), {
    "README.md": "# good\n",
    "examples/basic/src/routes/__root.tsx":
      "export const Route = createRootRoute();\n",
    "big.bin": new Uint8Array(1_500_000).fill(7),
    // A test fixture repository, as upstream trees often ship.
    ...bareLayout("test/fixture.git/", "upstream-ran"),
  }).repo;
  git(upstreamRepo, "config", "uploadpack.allowFilter", "true");
  upstreamCommit = git(upstreamRepo, "rev-parse", "HEAD");
  metadata.set("/good/1.0.0", {
    name: "good",
    version: "1.0.0",
    repository: { type: "git", url: "git+https://github.com/owner/good.git" },
    gitHead: upstreamCommit,
  });
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const path = new URL(request.url).pathname;
        requests.push(path);
        const archive = archives.get(path);
        if (archive !== undefined)
          return new Response(archive as Uint8Array<ArrayBuffer>);
        const doc = metadata.get(path);
        if (doc !== undefined) return Response.json(doc);
        return new Response("not found", { status: 404 });
      },
    });
  } catch {
    canBind = false;
    console.warn(
      "stack-fetch.test.ts: this host forbids binding a local port; the tests are skipped",
    );
  }
});

afterAll(() => {
  server?.stop(true);
  for (const dir of [root, markers]) {
    Bun.spawnSync(["chmod", "-R", "u+w", dir]);
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Fixture {
  readonly repo: string;
  readonly commit: string;
  readonly storeDirectory: string;
  readonly storeRoot: string;
  readonly input: (
    overrides?: Partial<FetchInput>,
    upstream?: boolean,
  ) => FetchInput;
}

const fixture = async (
  name: string,
  lock: string,
  options: { vetted: boolean; totalBytes?: number; storeRoot?: string } = {
    vetted: true,
  },
): Promise<Fixture> => {
  const { repo, commit } = repositoryWith(join(root, name), {
    "bun.lock": lock,
    "src/app.ts":
      'import { createRootRoute } from "good";\nimport x from "good/sub";\n',
    "package.json": '{"dependencies":{"good":"1.0.0"}}',
  });
  if (options.vetted) {
    git(repo, "update-ref", "refs/remotes/origin/main", commit);
    git(
      repo,
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    );
  }
  const storeDirectory = join(repo, ".git", "neuve");
  await writeRepoStack(storeDirectory, emptyRepoStack(true));
  const storeRoot = options.storeRoot ?? join(root, name, "store");
  const settings = {
    ...resolveStackSettings(undefined),
    ...(options.totalBytes === undefined
      ? {}
      : { totalBytes: options.totalBytes }),
  };
  return {
    repo,
    commit,
    storeDirectory,
    storeRoot,
    input: (overrides = {}, upstream = true) => ({
      repository: repo,
      storeDirectory,
      storeRoot,
      registryPath: join(root, name, "repositories.json"),
      settings,
      reason: "setup",
      revisions: [commit],
      git: storeGit,
      log: (line) => {
        if (process.env["NEUVE_TEST_LOG"] === "1") console.log(line);
      },
      registryBaseForTests: `http://127.0.0.1:${server?.port}`,
      // Never the network: without `upstream`, git is pointed at a path the file transport, not
      // allowed here, refuses locally.
      upstreamForTests: upstream
        ? { protocols: ["file"], url: () => `file://${upstreamRepo}` }
        : { protocols: [], url: () => "file:///nonexistent/upstream" },
      ...overrides,
    }),
  };
};

describe("stack.fetch", () => {
  test("stores verified package contents byte for byte, read-only, and refuses what SC7 refuses", async () => {
    if (!canBind) return;
    const lock = bunLock(
      [
        ["good", "1.0.0", integrityOf(good)],
        ["bad-hash", "1.0.0", integrityOf(other)],
        ["dotgit", "1.0.0", integrityOf(dotgit)],
        [
          "private",
          "1.0.0",
          integrityOf(other),
          "https://npm.private.example/private.tgz",
        ],
        ["missing", "1.0.0", integrityOf(other)],
      ],
      { linked: "workspace:*" },
    );
    const f = await fixture("main", lock);
    const report = await runStackFetch(f.input());
    if (process.env["NEUVE_TEST_LOG"] === "1")
      console.log(JSON.stringify(report.gaps, null, 1));
    expect(report.fetched).toEqual(["npm:good@1.0.0"]);
    const reasons = Object.fromEntries(
      report.gaps.map((gap) => [gap.key, gap.reason]),
    );
    expect(reasons).toMatchObject({
      "npm:bad-hash@1.0.0": "hash-mismatch",
      "npm:dotgit@1.0.0": "refused-archive",
      "npm:missing@1.0.0": "not-found",
    });
    expect(report.gaps.some((gap) => gap.reason === "private-registry")).toBe(
      true,
    );
    // The private name was never looked up on the public registry.
    expect(requests.some((path) => path.includes("private"))).toBe(false);

    const layout = storeLayout(f.storeRoot);
    const catalog = await readCatalog(f.storeRoot);
    const record = catalog.packages["npm:good@1.0.0"];
    expect(record).toBeDefined();
    const gitDir = layout.treeRepository(record?.tree ?? "");
    const show = (path: string) =>
      git(
        f.repo,
        `--git-dir=${gitDir}`,
        "cat-file",
        "-p",
        `${record?.tree}:${path}`,
      );
    // Written with hash-object --no-filters: the package's .gitattributes and .gitignore change nothing.
    expect(
      Bun.spawnSync([
        gitPath,
        `--git-dir=${gitDir}`,
        "cat-file",
        "-p",
        `${record?.tree}:crlf.txt`,
      ]).stdout.toString(),
    ).toBe("a\r\nb\r\n");
    expect(show("ignored.txt")).toBe("kept although ignored");
    expect(
      git(
        f.repo,
        `--git-dir=${gitDir}`,
        "rev-parse",
        `${record?.commit}^{tree}`,
      ),
    ).toBe(record?.tree ?? "");
    expect(readFileSync(join(gitDir, "config"), "utf8")).not.toContain(
      "[remote",
    );
    // The extracted folder is read-only, with no executable bits.
    const folder = join(f.storeRoot, record?.folder ?? "");
    expect(statSync(join(folder, "src", "route.ts")).mode & 0o777).toBe(0o444);
    expect(statSync(join(folder, "src")).mode & 0o777).toBe(0o555);
    expect(readFileSync(join(folder, "crlf.txt"), "utf8")).toBe("a\r\nb\r\n");
    // Nothing of the refused archive reached the store.
    expect(
      Bun.spawnSync(["find", f.storeRoot, "-path", "*dotgit*"])
        .stdout.toString()
        .trim(),
    ).toBe("");
    expect(
      Bun.spawnSync(["ls", layout.quarantine]).stdout.toString().trim(),
    ).toBe("");

    // The upstream tree: ranked by use, registry-stated, its blob filter held.
    const upstream = Object.values(catalog.upstream)[0];
    expect(upstream?.key).toBe(`github.com/owner/good@${upstreamCommit}`);
    expect(upstream?.level).toBe("registry-stated");
    // The filtered blob, and the fixture's HEAD.
    expect(upstream?.omitted).toBe(2);
    expect(
      existsSync(
        join(f.storeRoot, upstream?.folder ?? "", "test/fixture.git/HEAD"),
      ),
    ).toBe(false);
    expect(
      existsSync(
        join(f.storeRoot, upstream?.folder ?? "", "test/fixture.git/config"),
      ),
    ).toBe(true);
    const upstreamDir = layout.treeRepository(upstream?.tree ?? "");
    const config = readFileSync(join(upstreamDir, "config"), "utf8");
    expect(config).not.toContain(upstreamRepo);
    expect(config).toContain("file:///nonexistent/neuve-stack-no-lazy-fetch");
    const bigOid = git(upstreamRepo, "rev-parse", "HEAD:big.bin");
    for (const env of [
      storeGit.env,
      { ...storeGit.env, GIT_NO_LAZY_FETCH: "0" },
    ]) {
      const read = Bun.spawnSync(
        [gitPath, `--git-dir=${upstreamDir}`, "cat-file", "-p", bigOid],
        { env },
      );
      expect(read.exitCode).not.toBe(0);
    }
    expect(
      readFileSync(
        join(
          f.storeRoot,
          upstream?.folder ?? "",
          "examples/basic/src/routes/__root.tsx",
        ),
        "utf8",
      ),
    ).toContain("createRootRoute");
    expect(() =>
      lstatSync(join(f.storeRoot, upstream?.folder ?? "", "big.bin")),
    ).toThrow();

    const state = await readRepoStack(f.storeDirectory);
    expect(state?.revisions[0]?.pins).toContain("npm:good@1.0.0");
    expect(state?.outcomes["npm:good@1.0.0"]?.state).toBe("ready");
    expect(state?.upstream["npm:good@1.0.0"]).toMatchObject({
      rank: 1,
      tree: upstream?.key,
    });

    // The store-level index: built in its own job, each tree counted once in a search.
    expect(report.unindexed.length).toBe(2);
    const indexed = await runStackIndex({
      storeRoot: f.storeRoot,
      registryPath: join(root, "none.json"),
      settings: resolveStackSettings(undefined),
      trees: report.unindexed,
      git: storeGit,
      log: () => {},
    });
    expect(indexed.built.length).toBe(2);
    const once = await searchTrees(
      f.storeRoot,
      [record?.tree ?? ""],
      "createRootRoute",
      5,
      captureOutlineSource(),
    );
    const twice = await searchTrees(
      f.storeRoot,
      [record?.tree ?? "", record?.tree ?? ""],
      "createRootRoute",
      5,
      captureOutlineSource(),
    );
    expect(once.hits[0]?.path).toBe("src/route.ts");
    expect(twice.documents).toBe(once.documents);
    expect(twice.hits.map((hit) => hit.score)).toEqual(
      once.hits.map((hit) => hit.score),
    );
    const both = await searchTrees(
      f.storeRoot,
      report.unindexed,
      "createRootRoute root",
      5,
      captureOutlineSource(),
    );
    expect(both.hits.map((hit) => hit.path)).toContain(
      "examples/basic/src/routes/__root.tsx",
    );
    expect(both.notIndexed).toEqual([]);

    // What `neuve stack list` prints from: ready entries with their folders and source levels.
    const listed = await stackStateAt({
      source: captureOutlineSource(),
      repository: f.repo,
      storeDirectory: f.storeDirectory,
      storeRoot: f.storeRoot,
      commit: f.commit,
      settings: resolveStackSettings(undefined),
    });
    const goodEntry = listed.entries.find((entry) => entry.pin.name === "good");
    expect(goodEntry?.status).toBe("ready");
    expect(goodEntry?.contents?.folder).toBe(folder);
    expect(goodEntry?.upstream?.level).toBe("registry-stated");
    expect(
      listed.entries.find((entry) => entry.pin.name === "bad-hash")?.gap
        ?.reason,
    ).toBe("hash-mismatch");
    expect(listed.gaps.map((gap) => gap.reason)).toContain("private-registry");

    // A rerun reuses everything and fetches nothing.
    requests.length = 0;
    const again = await runStackFetch(f.input());
    expect(again.fetched).toEqual([]);
    expect(again.reused).toEqual(["npm:good@1.0.0"]);
    expect(
      requests.filter((path) => path.endsWith(".tgz") && path.includes("good")),
    ).toEqual([]);
  });

  test("entries the default branch does not pin draw on the day's budget and get no upstream tree", async () => {
    if (!canBind) return;
    const f = await fixture(
      "unvetted",
      bunLock([
        ["good", "1.0.0", integrityOf(good)],
        ["other", "1.0.0", integrityOf(other)],
      ]),
      {
        vetted: false,
      },
    );
    const state = await readRepoStack(f.storeDirectory);
    if (state === undefined) throw new Error("no state");
    const at = new Date().toISOString();
    state.budget = Array.from({ length: 9 }, (_, n) => ({
      key: `npm:earlier${n}@1.0.0`,
      bytes: 1,
      at,
    }));
    await writeRepoStack(f.storeDirectory, state);
    const report = await runStackFetch(f.input());
    expect(report.fetched).toEqual(["npm:good@1.0.0"]);
    expect(
      report.gaps.find((gap) => gap.key === "npm:other@1.0.0")?.reason,
    ).toBe("over-budget");
    expect(report.upstream).toEqual([]);
    expect((await readRepoStack(f.storeDirectory))?.budget.length).toBe(10);
  });

  test("the cap evicts the least recently used; a hold is never evicted and refuses new fetches past the cap", async () => {
    if (!canBind) return;
    const sizeOf = (
      record: { fileBytes: number; objectBytes: number } | undefined,
    ) => (record?.fileBytes ?? 0) + (record?.objectBytes ?? 0);
    // What good@1.0.0 takes in a store of its own.
    const probe = await fixture(
      "probe",
      bunLock([["good", "1.0.0", integrityOf(good)]]),
    );
    await runStackFetch(probe.input({}, false));
    const goodSize = sizeOf(
      (await readCatalog(probe.storeRoot)).packages["npm:good@1.0.0"],
    );

    const shared = join(root, "shared-store");
    const first = await fixture(
      "first",
      bunLock([["other", "1.0.0", integrityOf(other)]]),
      {
        vetted: true,
        storeRoot: shared,
      },
    );
    await runStackFetch(first.input({}, false));
    const before = await readCatalog(shared);
    expect(Object.keys(before.packages)).toEqual(["npm:other@1.0.0"]);
    const otherSize = sizeOf(before.packages["npm:other@1.0.0"]);

    // A second repository's entry does not fit beside the first: the least recently used goes.
    const cap =
      Math.max(goodSize, otherSize) +
      Math.floor(Math.min(goodSize, otherSize) / 2);
    const second = await fixture(
      "second",
      bunLock([["good", "1.0.0", integrityOf(good)]]),
      {
        vetted: true,
        storeRoot: shared,
        totalBytes: cap,
      },
    );
    const report = await runStackFetch(second.input({}, false));
    expect(report.fetched).toEqual(["npm:good@1.0.0"]);
    const after = await readCatalog(shared);
    expect(Object.keys(after.packages)).toEqual(["npm:good@1.0.0"]);
    expect(after.evicted["npm:other@1.0.0"]?.reason).toContain(
      "least recently used",
    );

    // A refetch that the registry no longer serves is disclosed as no longer available.
    archives.delete("/other/-/other-1.0.0.tgz");
    const refetch = await runStackFetch(
      first.input(
        { settings: { ...first.input().settings, totalBytes: 10_000_000 } },
        false,
      ),
    );
    expect(
      refetch.gaps.find((gap) => gap.key === "npm:other@1.0.0")?.reason,
    ).toBe("no-longer-available");
    archives.set("/other/-/other-1.0.0.tgz", other);

    // An open cycle holds good@1.0.0; with the cap below what it holds, nothing new is fetched.
    await recordHold(shared, {
      store: second.storeDirectory,
      cycleId: "01J00000000000000000000000",
      packages: ["npm:good@1.0.0"],
      upstream: [],
      lastRunAt: new Date().toISOString(),
    });
    const held = await runStackFetch(
      first.input(
        { settings: { ...first.input().settings, totalBytes: 1_000 } },
        false,
      ),
    );
    expect(held.gaps.find((gap) => gap.key === "npm:other@1.0.0")?.reason).toBe(
      "store-full-held",
    );
    expect(Object.keys((await readCatalog(shared)).packages)).toEqual([
      "npm:good@1.0.0",
    ]);
  });

  test("no folder of a package is a git repository: git in it runs nothing the package wrote", async () => {
    if (!canBind) return;
    // The control: the same files written as they are make git run the planted command.
    const control = join(markers, "control");
    for (const [path, content] of Object.entries(bareFiles)) {
      mkdirSync(dirname(join(control, path)), { recursive: true });
      writeFileSync(join(control, path), content);
    }
    gitStatusIn(control);
    expect(existsSync(join(markers, "root-ran"))).toBe(true);
    rmSync(join(markers, "root-ran"));

    const f = await fixture(
      "bare",
      bunLock([["bare", "1.0.0", integrityOf(bare)]]),
    );
    const report = await runStackFetch(f.input({}, false));
    expect(report.fetched).toEqual(["npm:bare@1.0.0"]);
    const record = (await readCatalog(f.storeRoot)).packages["npm:bare@1.0.0"];
    expect(record?.omitted).toBe(2);
    const folder = join(f.storeRoot, record?.folder ?? "");
    expect(existsSync(join(folder, "HEAD"))).toBe(false);
    expect(existsSync(join(folder, "test/fixture.git/HEAD"))).toBe(false);
    expect(existsSync(join(folder, "config"))).toBe(true);
    for (const cwd of [
      folder,
      join(folder, "src"),
      join(folder, "test/fixture.git"),
    ]) {
      const status = gitStatusIn(cwd);
      // Discovery ends at the store's guard: not a repository, and nothing ran.
      expect(status.exitCode).not.toBe(0);
      expect(status.stderr.toString()).toContain("not a git repository");
    }
    expect(existsSync(join(markers, "root-ran"))).toBe(false);
    expect(existsSync(join(markers, "fixture-ran"))).toBe(false);
  });

  test("every download attempt of an unvetted entry is charged, whatever its outcome", async () => {
    if (!canBind) return;
    const f = await fixture(
      "charged",
      bunLock([
        ["bad-hash", "1.0.0", integrityOf(other)],
        ["dotgit", "1.0.0", integrityOf(dotgit)],
        ["good", "1.0.0", integrityOf(good)],
        ["missing", "1.0.0", integrityOf(other)],
      ]),
      { vetted: false },
    );
    const state = await readRepoStack(f.storeDirectory);
    if (state === undefined) throw new Error("no state");
    const at = new Date().toISOString();
    state.budget = Array.from({ length: 7 }, (_, n) => ({
      key: `npm:earlier${n}@1.0.0`,
      bytes: 1,
      at,
    }));
    await writeRepoStack(f.storeDirectory, state);
    const report = await runStackFetch(f.input({}, false));
    const reasons = Object.fromEntries(
      report.gaps.map((gap) => [gap.key, gap.reason]),
    );
    expect(reasons["npm:bad-hash@1.0.0"]).toBe("hash-mismatch");
    expect(reasons["npm:dotgit@1.0.0"]).toBe("refused-archive");
    expect(reasons["npm:missing@1.0.0"]).toBe("over-budget");
    expect(report.fetched).toEqual(["npm:good@1.0.0"]);
    const budget = (await readRepoStack(f.storeDirectory))?.budget ?? [];
    expect(budget.length).toBe(10);
    expect(
      budget.find((charge) => charge.key === "npm:bad-hash@1.0.0")?.bytes,
    ).toBe(served.byteLength);
    expect(
      budget.find((charge) => charge.key === "npm:dotgit@1.0.0")?.bytes,
    ).toBe(dotgit.byteLength);
  });

  test("a repository turned off fetches nothing", async () => {
    if (!canBind) return;
    const f = await fixture(
      "off",
      bunLock([["good", "1.0.0", integrityOf(good)]]),
    );
    await writeRepoStack(f.storeDirectory, {
      ...emptyRepoStack(false),
      disabledBy: "--off",
    });
    requests.length = 0;
    const report = await runStackFetch(f.input());
    expect(report.skipped).toContain("off");
    expect(requests).toEqual([]);
    writeFileSync(join(f.repo, "unused"), "");
    commitFiles(f.repo, {});
  });
});
