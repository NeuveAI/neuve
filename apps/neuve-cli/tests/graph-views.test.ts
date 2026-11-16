// Why: Graph's temporary views go in folders of Neuve's own outside the Git folder. Each level must
// be a private folder of this user's, made by Neuve or refused; nothing may be followed through a
// link; a planted folder must never be deleted; an ended view is unregistered in the repository it
// belongs to before it goes; and every level is removed once empty. These are the reviewer's
// reproductions, at the temporary folder (the same checks guard the folder at a volume's top).
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { viewFolder } from "../src/graph-views.ts";

const roots: string[] = [];
const savedTemporary = process.env["TMPDIR"];
const savedShared = process.env["NEUVE_TEST_SHARED_TMP"];
let root = "";
let temporary = "";
const uid = process.getuid?.() ?? 0;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "neuve-views-")));
  roots.push(root);
  temporary = join(root, "tmp");
  await mkdir(temporary);
  // Views are looked for under the temporary folder, as on a tester's Mac.
  process.env["TMPDIR"] = temporary;
});
afterEach(() => {
  process.env["TMPDIR"] = savedTemporary;
  if (savedShared === undefined) delete process.env["NEUVE_TEST_SHARED_TMP"];
  else process.env["NEUVE_TEST_SHARED_TMP"] = savedShared;
});
afterAll(async () => {
  for (const at of roots) await rm(at, { recursive: true, force: true });
});

const repository = async (name: string) => {
  const repo = join(root, name);
  await mkdir(repo);
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "-C", repo, ...args], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    })
      .stdout.toString()
      .trim();
  git("init", "-q");
  git(
    "-c",
    "user.name=T",
    "-c",
    "user.email=t@example.invalid",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "one",
  );
  return { repo, git };
};

/** A folder shaped like an ended view, with a file that must survive. */
const decoy = async (at: string, withOwner?: string) => {
  const run = join(at, "graph-views", "run-decoy");
  await mkdir(run, { recursive: true, mode: 0o700 });
  await writeFile(join(run, "run.sqlite"), "");
  await writeFile(join(run, "precious.txt"), "keep me");
  if (withOwner !== undefined) await writeFile(join(run, "owner"), withOwner);
  return join(run, "precious.txt");
};

/** A use of `repo` in another process that ends without its release; its folder. */
const endedView = (repo: string) => {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "fixtures/ended-view.ts"),
      repo,
    ],
    {
      env: { ...process.env, TMPDIR: temporary },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  return child.stdout.toString().trim();
};

test("our folders are made private, used, and removed once empty", async () => {
  const { repo } = await repository("repo");
  const owned = join(temporary, `neuve-${uid}`);
  const views = await viewFolder(repo);
  expect(views?.parent.startsWith(join(owned, "graph-views", "run-"))).toBe(
    true,
  );
  for (const level of [owned, join(owned, "graph-views")]) {
    const info = await lstat(level);
    expect(info.isDirectory() && (info.mode & 0o777) === 0o700).toBe(true);
  }
  await views?.release();
  expect(existsSync(owned)).toBe(false);
});

test("a folder that isn't private, or a link at either level, is refused and left as it is", async () => {
  const { repo } = await repository("repo");
  const owned = join(temporary, `neuve-${uid}`);
  const elsewhere = join(root, "elsewhere");
  await mkdir(elsewhere, { mode: 0o700 });
  const cases = [
    async () => {
      await mkdir(owned, { mode: 0o700 });
      await chmod(owned, 0o777);
      return "a 0777 folder";
    },
    async () => {
      await symlink(elsewhere, owned);
      return "a link in place of our folder";
    },
    async () => {
      await mkdir(owned, { mode: 0o700 });
      await symlink(elsewhere, join(owned, "graph-views"));
      return "a link in place of the views folder";
    },
  ];
  for (const plant of cases) {
    await rm(owned, { recursive: true, force: true });
    const name = await plant();
    const precious = await decoy(elsewhere, repo);
    const views = await viewFolder(repo);
    expect({ name, under: views?.parent.startsWith(temporary) }).toEqual({
      name,
      under: false,
    });
    await views?.release();
    // The planted folder and what it points at are as they were.
    expect({ name, kept: await readFile(precious, "utf8") }).toEqual({
      name,
      kept: "keep me",
    });
    await rm(join(elsewhere, "graph-views"), { recursive: true, force: true });
  }
  await rm(owned, { recursive: true, force: true });
});

test("a folder shaped like an ended view but without its owner record is never removed", async () => {
  const { repo } = await repository("repo");
  const owned = join(temporary, `neuve-${uid}`);
  await mkdir(owned, { mode: 0o700 });
  const precious = await decoy(owned);
  const views = await viewFolder(repo);
  await views?.release();
  expect(await readFile(precious, "utf8")).toBe("keep me");
  await rm(owned, { recursive: true, force: true });
});

test("an ended view of another repository is unregistered there before it goes; a held one stays", async () => {
  const a = await repository("a");
  const b = await repository("b");
  // A's refresh ends in another process without its release, as a killed one does.
  const ended = endedView(a.repo);
  const view = join(ended, "neuve-graph-client-x", "source", "view");
  expect(a.git("worktree", "list", "--porcelain")).toContain(view);
  // A use of A still running holds its own folder.
  const held = await viewFolder(a.repo);
  if (held === undefined) throw new Error("no view folder");
  const heldView = join(held.parent, "view");
  a.git("worktree", "add", "-q", "--detach", heldView);
  // B's next use removes A's ended folder, after unregistering its view in A.
  const next = await viewFolder(b.repo);
  await next?.release();
  expect(existsSync(ended)).toBe(false);
  expect(a.git("worktree", "list", "--porcelain")).not.toContain(view);
  // The held use keeps its folder and its registered view.
  expect(existsSync(heldView)).toBe(true);
  expect(a.git("worktree", "list", "--porcelain")).toContain(heldView);
  // The same goes when the next use is A's own.
  const again = endedView(a.repo);
  const own = await viewFolder(a.repo);
  await own?.release();
  expect(existsSync(again)).toBe(false);
  expect(a.git("worktree", "list", "--porcelain")).toContain(heldView);
  await held.release();
});

// Why: a use that ends removes each of our levels once empty, and another use may be starting in
// them at that moment. Three processes loop over taking and releasing a view folder; before the
// fix some failed (the level vanished under `mkdtemp`) or moved elsewhere.
test("uses starting while others end never fail and never move elsewhere", async () => {
  const uses = 150;
  const loops = await Promise.all(
    ["a", "b", "c"].map(async (name) => {
      const { repo } = await repository(name);
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          join(import.meta.dir, "fixtures/view-loop.ts"),
          repo,
          String(uses),
        ],
        {
          env: { ...process.env, TMPDIR: temporary },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code, stderr).toBe(0);
      return JSON.parse(stdout) as {
        failed: number;
        elsewhere: number;
        errors: string[];
      };
    }),
  );
  expect(loops).toEqual(
    loops.map(() => ({ failed: 0, elsewhere: 0, errors: [] })),
  );
  expect(existsSync(join(temporary, `neuve-${uid}`))).toBe(false);
}, 120_000);

// Why: the last place for a view is the store, `<git common dir>/neuve/graph/views`, and it gets
// the same checks as every other level: a link there or a folder others can open is refused and
// left as it was, and nothing behind it is followed or pruned.
test("the store's views folder is used only when it is ours; a link or a loose one is refused", async () => {
  const { repo } = await repository("repo");
  // Both temporary places refused, so the view has to go in the store.
  const shared = join(root, "shared");
  await mkdir(shared);
  process.env["NEUVE_TEST_SHARED_TMP"] = shared;
  for (const at of [temporary, shared]) {
    await mkdir(join(at, `neuve-${uid}`), { mode: 0o700 });
    await chmod(join(at, `neuve-${uid}`), 0o777);
  }
  const graph = join(repo, ".git", "neuve", "graph");
  const store = join(graph, "views");
  // Ours: made private, used, removed once empty.
  const views = await viewFolder(repo);
  expect(views?.store).toBe(true);
  expect(views?.parent.startsWith(join(store, "run-"))).toBe(true);
  expect((await lstat(store)).mode & 0o777).toBe(0o700);
  await views?.release();
  expect(existsSync(store)).toBe(false);
  // A link to a folder holding a decoy shaped like an ended view of this repository.
  const elsewhere = join(root, "elsewhere");
  const precious = await decoy(elsewhere, repo);
  await symlink(join(elsewhere, "graph-views"), store);
  await expect(viewFolder(repo)).rejects.toThrow(
    `Neuve found no folder of its own for Graph's temporary view: ${store}`,
  );
  expect(await readFile(precious, "utf8")).toBe("keep me");
  expect((await lstat(store)).isSymbolicLink()).toBe(true);
  await rm(store);
  // A folder others can open.
  await mkdir(store, { mode: 0o700 });
  await chmod(store, 0o777);
  await expect(viewFolder(repo)).rejects.toThrow(
    `Neuve found no folder of its own for Graph's temporary view: ${store}`,
  );
  expect((await lstat(store)).mode & 0o777).toBe(0o777);
  await rm(store, { recursive: true });
  // A link in place of the store's graph folder is refused too.
  await rm(graph, { recursive: true });
  await mkdir(join(elsewhere, "graph"), { mode: 0o700 });
  await symlink(join(elsewhere, "graph"), graph);
  await expect(viewFolder(repo)).rejects.toThrow(
    `Neuve found no folder of its own for Graph's temporary view: ${graph}`,
  );
  expect(existsSync(join(elsewhere, "graph", "views"))).toBe(false);
});
