// Why: setup must never cost a project its own files, and must work wherever the install sits.
// - It never deletes a project's own `neuve/` files, tracked or not, and such a folder never stops
//   it (a raw schema error stopped it before). An old folder goes only as a whole, when every
//   entry is setup's own and Git says it tracks none of them: a look-alike index, one file of the
//   project's beside setup's, or a Git that can't answer leaves the entire folder.
// - It records the CLI and engine by path, so an engine or a temporary folder on another volume
//   than the repository still indexes: links inside `.git` to another volume made the Graph
//   engine refuse the repository, and a temporary view on another volume did too.
// Each runs the real setup from source; its first index needs the built Graph engine. The file
// imports nothing setup added since, so it runs against older builds too.
import { afterAll, expect, test } from "bun:test";
import { statSync } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import {
  CLI,
  ENGINE,
  engineIn,
  legacyFolder,
  otherVolume,
  prerequisite,
  removeScratch,
  scratch,
  temporary,
} from "./fixtures/setup-scratch.ts";

afterAll(removeScratch);

test.skipIf(prerequisite.skip)(
  "a project's own neuve/ folder is never deleted and never stops setup",
  async () => {
    prerequisite.require();
    const { repository, git, commit, setup } = await scratch();
    const folder = join(repository, "neuve");
    // The project's own files, not Neuve's: a config of its own, a note, a link of its own.
    await mkdir(join(folder, "bin"), { recursive: true });
    await writeFile(join(folder, "config.json"), '{"theme": "dark"}\n');
    await writeFile(join(folder, "README.md"), "Our tool's settings.\n");
    await symlink("../README.md", join(folder, "bin/neuve"));
    const snapshot = async () =>
      Object.fromEntries(
        await Promise.all(
          ["config.json", "README.md"].map(
            async (name) =>
              [name, await readFile(join(folder, name), "utf8")] as const,
          ),
        ),
      );
    const before = await snapshot();
    // Before any setup, and again once the store has a record (the fix doctor prints).
    for (const round of [1, 2]) {
      const { stderr, code } = await setup();
      expect({ round, code }, stderr).toEqual({ round, code: 0 });
      expect(stderr).toContain(
        `An old neuve/ folder was left in place at ${folder}: its config.json isn't Neuve's setup record.\n`,
      );
      expect(await snapshot()).toEqual(before);
      expect((await lstat(join(folder, "bin/neuve"))).isSymbolicLink()).toBe(
        true,
      );
    }
    // A folder shaped exactly like Neuve's old one is still the project's once Git tracks it.
    await rm(folder, { recursive: true });
    await mkdir(join(folder, "bin"), { recursive: true });
    // A relative link, so the case holds wherever the engine is.
    await symlink("../../a.ts", join(folder, "bin/neuve-graph"));
    await writeFile(
      join(folder, "config.json"),
      JSON.stringify({
        schemaVersion: 3,
        repository,
        cliBinary: join(folder, "bin/neuve"),
        graphBinary: join(folder, "bin/neuve-graph"),
      }),
    );
    git("add", "neuve");
    await commit("b.ts", "export const b = 2;\n");
    const tracked = await setup();
    expect(tracked.code, tracked.stderr).toBe(0);
    expect(tracked.stderr).toContain(
      `An old neuve/ folder was left in place at ${folder}: Git tracks`,
    );
    expect(git("status", "--porcelain")).toBe("");
  },
  60_000,
);

test.skipIf(prerequisite.skip)(
  "setup and a refresh work on a repository that commits links to a device, to another volume and relative ones, with the engine and the temporary folder on its volume or another",
  async () => {
    prerequisite.require();
    const { root, repository, git, commit, setup, run } = await scratch();
    const elsewhere = await otherVolume(repository);
    // Links a project commits: one that switches a file off, one to another disk, one inside.
    await symlink("/dev/null", join(repository, "off"));
    await symlink("a.ts", join(repository, "alias.ts"));
    if (elsewhere !== undefined)
      await symlink(elsewhere, join(repository, "elsewhere"));
    git("add", "-A");
    await commit(
      "greeting.ts",
      "export function greetingFor(name: string) {\n  return `Hello, ${name}`;\n}\n",
    );
    const cases: Array<{ name: string; engine: string; tmp: string }> = [
      { name: "same volume", engine: await engineIn(root), tmp: root },
    ];
    if (elsewhere !== undefined) {
      const engine =
        statSync(ENGINE).dev !== statSync(repository).dev
          ? ENGINE
          : await engineIn(elsewhere);
      cases.push(
        { name: "engine on another volume", engine, tmp: root },
        {
          name: "temporary folder on another volume",
          engine: await engineIn(root),
          tmp: await temporary(elsewhere, "neuve-tmp-"),
        },
      );
    } else console.log("No second volume here: only the same-volume case ran.");
    for (const { name, engine, tmp } of cases) {
      await rm(join(repository, ".git/neuve"), {
        recursive: true,
        force: true,
      });
      const done = await setup(engine, { TMPDIR: tmp });
      expect({ name, code: done.code }, done.stderr).toEqual({ name, code: 0 });
      expect({
        name,
        index: JSON.parse(done.stdout).initialIndexStatus,
      }).toEqual({
        name,
        index: "ok",
      });
      // A later refresh, as a review's Graph queries make, is accepted too.
      const query = await run(
        [
          process.execPath,
          "--no-env-file",
          CLI,
          "query",
          "--repo",
          repository,
          "--revision",
          git("rev-parse", "HEAD"),
          "--question",
          "greetingFor",
          "--max-results",
          "1",
          "--max-context-bytes",
          "4000",
          "--relationship-plan",
          "[]",
          "--refresh-cache",
        ],
        { TMPDIR: tmp, NEUVE_GRAPH_BINARY: engine },
      );
      expect({ name, code: query.code }, query.stderr).toEqual({
        name,
        code: 0,
      });
      // The refresh answered: a question that names a function in the repository finds it.
      expect({
        name,
        status: JSON.parse(query.stdout).retrieval.status,
      }).toEqual({ name, status: "ok" });
      // The view was outside the Git directory and is gone, with its registration.
      expect(git("worktree", "list").split("\n")).toHaveLength(1);
      expect(
        statSync(join(repository, ".git/neuve/graph/views"), {
          throwIfNoEntry: false,
        }),
      ).toBeUndefined();
    }
  },
  180_000,
);

/** Every file under `folder` and its bytes or link target, to show nothing in it changed. */
const snapshot = async (folder: string) => {
  const { readdir, readlink } = await import("node:fs/promises");
  const names = (await readdir(folder, { recursive: true })).sort();
  return Promise.all(
    names.map(async (name) => {
      const path = join(folder, name);
      const info = await lstat(path);
      return [
        name,
        info.isSymbolicLink()
          ? `-> ${await readlink(path)}`
          : info.isDirectory()
            ? "/"
            : await readFile(path, "utf8"),
      ] as const;
    }),
  );
};

test.skipIf(prerequisite.skip)(
  "an old folder whose index only looks like setup's is left whole",
  async () => {
    prerequisite.require();
    const { repository, git, copy, setup } = await scratch();
    const folder = await legacyFolder(
      repository,
      copy,
      git("rev-parse", "HEAD"),
      { retrieval: "notes" },
    );
    const before = await snapshot(folder);
    const done = await setup();
    expect(done.code, done.stderr).toBe(0);
    expect(done.stderr).toContain(
      `An old neuve/ folder was left in place at ${folder}: ${join(folder, "initial-index.json")} isn't an index setup wrote.\n`,
    );
    expect(await snapshot(folder)).toEqual(before);
  },
  60_000,
);

test.skipIf(prerequisite.skip)(
  "an old folder that also holds a project file is left whole",
  async () => {
    prerequisite.require();
    const { repository, git, copy, setup } = await scratch();
    const folder = await legacyFolder(
      repository,
      copy,
      git("rev-parse", "HEAD"),
    );
    await writeFile(join(folder, "notes.md"), "Ours, beside setup's files.\n");
    const before = await snapshot(folder);
    const done = await setup();
    expect(done.code, done.stderr).toBe(0);
    expect(done.stderr).toContain(
      `An old neuve/ folder was left in place at ${folder}: it holds notes.md, which setup didn't write.\n`,
    );
    expect(await snapshot(folder)).toEqual(before);
  },
  60_000,
);

test.skipIf(prerequisite.skip)(
  "when Git can't say whether it tracks the old folder, it is left whole",
  async () => {
    prerequisite.require();
    const { root, repository, git, copy, setup } = await scratch();
    const folder = await legacyFolder(
      repository,
      copy,
      git("rev-parse", "HEAD"),
    );
    const before = await snapshot(folder);
    // A git that fails, as on a damaged index, only when asked what it tracks under neuve/.
    const real = Bun.which("git");
    if (real === null) throw new Error("Git is required");
    const wrapped = join(root, "git-wrapper");
    await mkdir(wrapped);
    await writeFile(
      join(wrapped, "git"),
      `#!/bin/sh\ncase "$*" in *ls-files*neuve*) echo "fatal: index file corrupt" >&2; exit 128;; esac\nexec ${JSON.stringify(real)} "$@"\n`,
    );
    await chmod(join(wrapped, "git"), 0o755);
    const done = await setup(ENGINE, {
      PATH: `${wrapped}:${process.env["PATH"] ?? ""}`,
    });
    expect(done.code, done.stderr).toBe(0);
    expect(done.stderr).toContain(
      `An old neuve/ folder was left in place at ${folder}: Git couldn't say`,
    );
    expect(await snapshot(folder)).toEqual(before);
  },
  60_000,
);

// Why: when Neuve has no folder of its own on the repository's disk, Graph's view goes in the
// store, where Graph refuses a repository that commits a link leaving its disk. `neuve query` then
// says why and what to change, not Graph's own words. Shown with the temporary folder's level
// refused (a folder there that isn't private) and so is `/private/tmp`'s, which a test process
// may place elsewhere, so the case runs whatever disk `/private/tmp` is on.
test.skipIf(prerequisite.skip)(
  "a refresh with nowhere to put its view but the Git folder says why and what to change",
  async () => {
    prerequisite.require();
    const { root, repository, git, commit, run } = await scratch();
    await symlink("/dev/null", join(repository, "off"));
    git("add", "-A");
    await commit("b.ts", "export const b = 2;\n");
    const shared = join(root, "shared");
    await mkdir(shared);
    const blocked = [root, shared].map((at) =>
      join(at, `neuve-${process.getuid?.() ?? 0}`),
    );
    for (const folder of blocked) {
      await mkdir(folder, { mode: 0o700 });
      await chmod(folder, 0o777);
    }
    const query = await run(
      [
        process.execPath,
        "--no-env-file",
        CLI,
        "query",
        "--repo",
        repository,
        "--revision",
        git("rev-parse", "HEAD"),
        "--question",
        "b",
        "--max-results",
        "1",
        "--max-context-bytes",
        "4000",
        "--relationship-plan",
        "[]",
        "--refresh-cache",
      ],
      {
        TMPDIR: root,
        NEUVE_TEST_SHARED_TMP: shared,
        NEUVE_GRAPH_BINARY: ENGINE,
      },
    );
    expect(query.code).not.toBe(0);
    expect(query.stderr).toContain(
      "Neuve found no folder of its own on this repository's disk for Graph's temporary view",
    );
    expect(query.stderr).not.toContain("refuse Git subprocesses");
    // The view went in the store, and is gone with its registration.
    expect(git("worktree", "list", "--porcelain").split("\n\n").length).toBe(1);
    // The folders that weren't private were left as they were.
    for (const folder of blocked)
      expect((await lstat(folder)).mode & 0o777).toBe(0o777);
  },
  60_000,
);

// Why: graph-client's Git qualification refuses a repository whose objects live in another one
// (`git clone --shared` or `--reference`), and setup's engine check went through it, so setup
// failed on such a clone though reviews read their own `--shared` clone fine.
test.skipIf(prerequisite.skip)(
  "setup works on a repository whose objects live in another repository",
  async () => {
    prerequisite.require();
    const { root, repository, copy, run } = await scratch();
    const shared = join(root, "shared");
    const clone = Bun.spawnSync(
      ["git", "clone", "-q", "--shared", repository, shared],
      { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } },
    );
    expect(clone.exitCode, clone.stderr.toString()).toBe(0);
    expect(
      (await readFile(join(shared, ".git/objects/info/alternates"), "utf8"))
        .length,
    ).toBeGreaterThan(0);
    const done = await run([
      process.execPath,
      "--no-env-file",
      CLI,
      "setup",
      "--repo",
      shared,
      "--cli-binary",
      copy,
      "--graph-binary",
      ENGINE,
      "--agents",
      "none",
      "--json",
    ]);
    expect(done.code, done.stderr).toBe(0);
    expect(JSON.parse(done.stdout).initialIndexStatus).toBe("ok");
    const check = JSON.parse(
      await readFile(
        join(shared, ".git/neuve/setup/initial-index.json"),
        "utf8",
      ),
    );
    expect({ status: check.status, plan: check.plan }).toEqual({
      status: "ok",
      plan: "alternates",
    });
  },
  60_000,
);
