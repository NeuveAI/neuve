import { afterEach, describe, expect, test } from "bun:test";
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
import { dirname, join, resolve } from "node:path";

import { discoverGraphBinary } from "../src/graph-query.ts";
import { describeInstalledCopy } from "../src/installed-copy.ts";
import {
  checkoutState,
  isSharedPrefix,
  readReceipt,
  writeReceipt,
} from "../src/install-source.ts";
import {
  installFromCheckout,
  installLayout,
  installLocalCli,
  planInstall,
  withInstallLock,
} from "../scripts/install-local.ts";

// Every install goes under a temporary prefix, never the real ~/.local.
const temporaryDirectories: string[] = [];

const temporaryDirectory = async (prefix: string): Promise<string> => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const install = (
  directory: string,
  cli: string,
  graph: string,
  legacyLinkTarget?: string,
) =>
  installLocalCli({
    cli,
    graph,
    prefix: join(directory, "home/.local"),
    graphVersion: "dev",
    graphWorkspaceRevision: null,
    ...(legacyLinkTarget === undefined ? {} : { legacyLinkTarget }),
  });

describe("local CLI installation", () => {
  test("installs copies, replacing an earlier workspace symlink and its own install", async () => {
    const directory = await temporaryDirectory("neuve-cli-install-");
    const cli = join(directory, "dist/neuve");
    const graph = join(directory, "entire-graph");
    await Bun.write(cli, "cli-1");
    await Bun.write(graph, "graph-1");
    const layout = installLayout(join(directory, "home/.local"));
    expect(Object.keys(layout)).not.toContain("parser");
    await mkdir(dirname(layout.cli), { recursive: true });
    await symlink(cli, layout.cli);

    await install(directory, cli, graph, cli);
    expect((await lstat(layout.cli)).isFile()).toBe(true);
    expect((await lstat(layout.cli)).mode & 0o777).toBe(0o755);
    expect(await readFile(layout.graph, "utf8")).toBe("graph-1");
    expect(
      JSON.parse(await readFile(layout.manifest, "utf8")),
    ).not.toHaveProperty("parser");

    await Bun.write(cli, "cli-2");
    await Bun.write(graph, "graph-2");
    expect(await readFile(layout.cli, "utf8")).toBe("cli-1");
    await install(directory, cli, graph);
    expect(await readFile(layout.cli, "utf8")).toBe("cli-2");
    expect(await readFile(layout.graph, "utf8")).toBe("graph-2");
  });

  test("refuses to replace a command Neuve did not install", async () => {
    const directory = await temporaryDirectory("neuve-cli-foreign-");
    const cli = join(directory, "neuve");
    const graph = join(directory, "entire-graph");
    await Bun.write(cli, "cli");
    await Bun.write(graph, "graph");
    const layout = installLayout(join(directory, "home/.local"));
    await Bun.write(layout.cli, "someone else's neuve");

    await expect(install(directory, cli, graph)).rejects.toThrow(
      "Neuve did not install it",
    );
    expect(await readFile(layout.cli, "utf8")).toBe("someone else's neuve");

    await rm(layout.cli);
    await symlink(graph, layout.cli);
    await expect(install(directory, cli, graph)).rejects.toThrow(
      "symbolic link Neuve did not install",
    );
  });

  // Why: a compiled CLI cannot carry the semantic client's Python workers, so without these
  // copies an installed CLI could not run E0 or hybrid leads; and, like the CLI and the engine, a
  // worker Neuve did not install must never be overwritten.
  test("installs the semantic workers beside the CLI, recorded by SHA-256, and only its own", async () => {
    const directory = await temporaryDirectory("neuve-cli-semantic-");
    const cli = join(directory, "neuve");
    const graph = join(directory, "entire-graph");
    const encoder = join(directory, "worker.py");
    const reranker = join(directory, "reranker_worker.py");
    await Bun.write(cli, "cli");
    await Bun.write(graph, "graph");
    await Bun.write(encoder, "encoder-1");
    await Bun.write(reranker, "reranker-1");
    const prefix = join(directory, "home/.local");
    const layout = installLayout(prefix);
    const run = () =>
      installLocalCli({
        cli,
        graph,
        prefix,
        graphVersion: "dev",
        graphWorkspaceRevision: null,
        semantic: { encoder, reranker },
      });
    const manifest = await run();
    expect(await readFile(layout.semantic.encoder, "utf8")).toBe("encoder-1");
    expect(await readFile(layout.semantic.reranker, "utf8")).toBe("reranker-1");
    expect(manifest.semantic?.reranker).toEqual({
      path: layout.semantic.reranker,
      sha256: new Bun.CryptoHasher("sha256").update("reranker-1").digest("hex"),
    });
    // Its own copy is replaced by the next install.
    await Bun.write(reranker, "reranker-2");
    await run();
    expect(await readFile(layout.semantic.reranker, "utf8")).toBe("reranker-2");
    // A file someone else put there is not.
    await Bun.write(layout.semantic.encoder, "someone else's worker");
    await expect(run()).rejects.toThrow("Neuve did not install it");
    expect(await readFile(layout.semantic.encoder, "utf8")).toBe(
      "someone else's worker",
    );
  });

  // The manifest decides which files may be replaced, so a damaged one must
  // stop the install with a Neuve error, not a SyntaxError or TypeError.
  test("refuses a corrupt or incomplete install manifest", async () => {
    const directory = await temporaryDirectory("neuve-cli-manifest-");
    const cli = join(directory, "neuve");
    const graph = join(directory, "entire-graph");
    await Bun.write(cli, "cli");
    await Bun.write(graph, "graph");
    const layout = installLayout(join(directory, "home/.local"));

    for (const contents of [
      "{ truncated",
      JSON.stringify({ schemaVersion: 1, installedAt: "", cli: {} }),
    ]) {
      await Bun.write(layout.manifest, contents);
      await expect(install(directory, cli, graph)).rejects.toThrow(
        `The Neuve install manifest ${layout.manifest} is corrupt or incomplete`,
      );
    }
    expect(await Bun.file(layout.cli).exists()).toBe(false);
    expect(await Bun.file(layout.graph).exists()).toBe(false);
  });

  // Why (8.19): during the pi transition the installed copy may be a newer build whose stores need
  // it; main's install must never replace it with an older one, and offers no override.
  test("never replaces a copy that records a newer Records schema or writer", async () => {
    const directory = await temporaryDirectory("neuve-cli-downgrade-");
    const cli = join(directory, "neuve");
    const graph = join(directory, "entire-graph");
    await Bun.write(cli, "newer-cli");
    await Bun.write(graph, "newer-graph");
    const layout = installLayout(join(directory, "home/.local"));
    const newer = { schemaVersion: 16, writerVersion: 16, projectorVersion: 9 };
    for (const records of [
      newer,
      { ...newer, schemaVersion: 1 },
      { ...newer, writerVersion: 1 },
    ]) {
      await installLocalCli({
        cli,
        graph,
        prefix: join(directory, "home/.local"),
        graphVersion: "dev",
        graphWorkspaceRevision: null,
        records,
      });
      const plan = await planInstall({
        prefix: join(directory, "home/.local"),
        workspaceRoot: resolve(import.meta.dir, "../../.."),
        records: { schemaVersion: 14, writerVersion: 13, projectorVersion: 9 },
      });
      expect(
        plan.guards.find((entry) => entry.name === "installed copy"),
      ).toMatchObject({
        ok: false,
        detail: expect.stringContaining("installing never downgrades"),
      });
      await Bun.write(cli, "older-cli");
      await Bun.write(graph, "older-graph");
      await expect(
        installLocalCli({
          cli,
          graph,
          prefix: join(directory, "home/.local"),
          graphVersion: "dev",
          graphWorkspaceRevision: null,
          records: {
            schemaVersion: 14,
            writerVersion: 13,
            projectorVersion: 9,
          },
        }),
      ).rejects.toThrow(
        `Refusing to replace ${layout.cli}: it is a newer build (Records writer ${records.writerVersion}, schema ${records.schemaVersion}) than this one (writer 13, schema 14), and installing never downgrades.`,
      );
      expect(await readFile(layout.cli, "utf8")).toBe("newer-cli");
      expect(await readFile(layout.graph, "utf8")).toBe("newer-graph");
      // The next case installs its newer copy over this one, as a newer build's install would.
      await Bun.write(cli, "newer-cli");
      await Bun.write(graph, "newer-graph");
      await rm(layout.manifest);
      await rm(layout.cli);
      await rm(layout.graph);
    }
  });
});

// Why: checking and installing are separate modes (12.24), and only an install that passes every
// guard may replace the shared copy that every hook and terminal runs. So each guard needs proof at
// the script's boundary: check mode fails loudly instead of skipping, the dry run writes nothing,
// a lane, a dirty tree, a copy git cannot place before HEAD, or a commit without a passing check
// is refused, and a scratch prefix relaxes only what it may. The lock, the stop and the repair of
// an interrupted install are proven with real processes. Every write goes under a temporary prefix.
describe("install modes", () => {
  const OLDER = { writerVersion: 13, schemaVersion: 14, projectorVersion: 9 };
  const SCRIPT = resolve(import.meta.dir, "../scripts/install-local.ts");

  /** A checkout on `main` with two commits, a commit on another branch, and a built Graph engine. */
  const checkout = async () => {
    const root = await temporaryDirectory("neuve-cli-checkout-");
    const git = (...args: Array<string>) => {
      const result = Bun.spawnSync(["git", "-C", root, ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    git("init", "-q", "-b", "main");
    git("config", "user.email", "dev@example.com");
    git("config", "user.name", "Dev");
    const commit = async (file: string) => {
      await writeFile(join(root, file), `${file}\n`);
      git("add", file);
      git("commit", "-qm", file);
      return git("rev-parse", "HEAD");
    };
    // The built Graph engine is ignored, as the repository's own .gitignore ignores it.
    await writeFile(
      join(root, ".gitignore"),
      "/apps/neuve-graph/entire-graph\n",
    );
    git("add", ".gitignore");
    const first = await commit("a");
    git("checkout", "-q", "-b", "side");
    const side = await commit("s");
    git("checkout", "-q", "main");
    const second = await commit("b");
    // Ignored, so the tree stays clean; it answers `version` as the real engine does.
    const engine = join(root, "apps/neuve-graph/entire-graph");
    await Bun.write(engine, "#!/bin/sh\necho dev\n");
    await chmod(engine, 0o755);
    const receipts = join(root, ".git/neuve-check");
    return { root, git, first, second, side, receipts };
  };

  const installed = async (
    source: { commit: string | null; dirty: boolean } | undefined,
  ) => {
    const directory = await temporaryDirectory("neuve-cli-installed-");
    const cli = join(directory, "neuve");
    const graph = join(directory, "entire-graph");
    await Bun.write(cli, "installed-cli");
    await Bun.write(graph, "installed-graph");
    const prefix = join(directory, "home/.local");
    await installLocalCli({
      cli,
      graph,
      prefix,
      graphVersion: "dev",
      graphWorkspaceRevision: null,
      records: OLDER,
      ...(source === undefined ? {} : { source }),
    });
    return { prefix, layout: installLayout(prefix) };
  };

  const listing = (root: string) =>
    Bun.spawnSync(["find", root, "-print"], { stdout: "pipe" })
      .stdout.toString()
      .split("\n")
      .sort();

  test("the shared copy is installed only when every guard passes, each refusal named", async () => {
    const repo = await checkout();
    await writeReceipt(repo.receipts, {
      version: 1,
      commit: repo.second,
      branch: "main",
      at: "2026-11-01T10:00:00.000Z",
    });
    const plan = async (
      prefix: string,
      env: Record<string, string | undefined> = {},
    ) =>
      planInstall({
        prefix,
        workspaceRoot: repo.root,
        env,
        alsoShared: [prefix],
      });
    const blocked = async (
      source: { commit: string | null; dirty: boolean } | undefined,
      env: Record<string, string | undefined> = {},
    ) => {
      const { prefix } = await installed(source);
      const result = await plan(prefix, env);
      // Every guard is answered, whichever blocks first.
      expect(result.guards.map((entry) => entry.name)).toEqual([
        "mode",
        "tree",
        "branch",
        "installed copy",
        "check receipt",
        "graph engine",
      ]);
      return result.blocked === undefined
        ? undefined
        : `${result.blocked.name}: ${result.blocked.detail}`;
    };
    const ancestor = { commit: repo.first, dirty: false };

    expect(await blocked(ancestor)).toBeUndefined();
    expect(await blocked(ancestor, { NEUVE_MODE: "check" })).toBe(
      "mode: check mode (NEUVE_MODE=check) never installs the shared copy",
    );
    expect(await blocked(ancestor, { NODE_ENV: "test" })).toBe(
      "mode: check mode (NODE_ENV=test) never installs the shared copy",
    );
    expect(await blocked(ancestor, { CI: "true" })).toBe(
      "mode: check mode (CI) never installs the shared copy",
    );
    expect(await blocked({ commit: repo.second, dirty: false })).toBe(
      `installed copy: built from ${repo.second.slice(0, 10)}, this HEAD already`,
    );
    expect(await blocked({ commit: repo.side, dirty: false })).toBe(
      `installed copy: built from ${repo.side.slice(0, 10)}, which HEAD does not contain (another line of history, or newer)`,
    );
    expect(await blocked({ commit: "e".repeat(40), dirty: false })).toBe(
      `installed copy: built from ${"e".repeat(10)}, which this checkout does not know`,
    );
    expect(await blocked(undefined)).toBe(
      "installed copy: the installed copy records no commit it was built from",
    );

    // No Neuve-installed copy yet, or the old workspace symlink: allowed. A neuve Neuve did not
    // install: refused.
    const empty = join(await temporaryDirectory("neuve-cli-empty-"), ".local");
    expect((await plan(empty)).blocked).toBeUndefined();
    const linked = join(await temporaryDirectory("neuve-cli-link-"), ".local");
    await mkdir(join(linked, "bin"), { recursive: true });
    await symlink(join(repo.root, "a"), join(linked, "bin/neuve"));
    expect((await plan(linked)).blocked).toBeUndefined();
    const foreign = join(
      await temporaryDirectory("neuve-cli-foreign-"),
      ".local",
    );
    await Bun.write(join(foreign, "bin/neuve"), "someone else's neuve");
    expect((await plan(foreign)).blocked?.name).toBe("installed copy");

    await writeFile(join(repo.root, "a"), "changed\n");
    expect(await blocked(ancestor)).toBe(
      "tree: this checkout has local changes",
    );
    repo.git("checkout", "-q", "--", "a");

    await rm(join(repo.receipts, `${repo.second}.json`));
    expect(await blocked(ancestor)).toBe(
      `check receipt: no passing \`bun run check\` recorded for ${repo.second.slice(0, 10)}`,
    );

    repo.git("checkout", "-q", "-b", "claude/lane");
    expect(await blocked(ancestor)).toBe(
      "branch: claude/lane is not an integration branch (main, codex/pi-transition)",
    );
    repo.git("checkout", "-q", "-b", "codex/pi-transition");
    const transition = repo.git("rev-parse", "HEAD");
    await writeReceipt(repo.receipts, {
      version: 1,
      commit: transition,
      branch: "codex/pi-transition",
      at: "2026-11-01T10:00:00.000Z",
    });
    expect(await blocked(ancestor)).toBeUndefined();

    await rm(join(repo.root, "apps/neuve-graph/entire-graph"));
    expect(await blocked(ancestor)).toBe(
      "graph engine: not built; run `bun run build:graph`",
    );
  });

  test("a scratch prefix skips only the branch, history and receipt guards", async () => {
    const repo = await checkout();
    repo.git("checkout", "-q", "side");
    const { prefix } = await installed({ commit: repo.second, dirty: false });
    const scratch = await planInstall({
      prefix,
      workspaceRoot: repo.root,
      env: { NEUVE_MODE: "check" },
    });
    expect(scratch.shared).toBe(false);
    expect(scratch.blocked).toBeUndefined();
    // The tree still has to be clean.
    await writeFile(join(repo.root, "a"), "changed\n");
    expect(
      (await planInstall({ prefix, workspaceRoot: repo.root, env: {} })).blocked
        ?.name,
    ).toBe("tree");
  });

  // Why: the dry run must refuse what the install would refuse; a file Neuve didn't install in
  // the skill's share used to pass every guard and fail only the real install.
  test("the plan refuses a skill share holding a file Neuve didn't install", async () => {
    const prefix = join(
      await temporaryDirectory("neuve-cli-skills-"),
      "prefix",
    );
    const workspaceRoot = resolve(import.meta.dir, "../../..");
    const fine = await planInstall({ prefix, workspaceRoot, env: {} });
    expect(
      fine.guards.find((entry) => entry.name === "skill files"),
    ).toMatchObject({
      ok: true,
    });
    const foreign = join(prefix, "share/neuve/skills/neuve/SKILL.md");
    await mkdir(dirname(foreign), { recursive: true });
    await writeFile(foreign, "someone else's\n");
    const plan = await planInstall({ prefix, workspaceRoot, env: {} });
    expect(
      plan.guards.find((entry) => entry.name === "skill files"),
    ).toMatchObject({
      ok: false,
      detail: `Refusing to replace ${foreign}: Neuve did not install it. Move it away and rerun.`,
    });
    expect(await readFile(foreign, "utf8")).toBe("someone else's\n");
  });

  test("an install to the shared prefix from check mode fails loudly; the dry run writes nothing", async () => {
    // The scratch HOME's `.local` is the shared prefix for these processes.
    const home = await temporaryDirectory("neuve-cli-home-");
    const run = (env: Record<string, string>, ...args: Array<string>) => {
      const { NEUVE_INSTALL_PREFIX: _prefix, ...rest } = process.env;
      return Bun.spawnSync([process.execPath, SCRIPT, ...args], {
        env: { ...rest, HOME: home, ...env },
        stdout: "pipe",
        stderr: "pipe",
      });
    };
    const shared = join(home, ".local");
    const install = run({ NEUVE_MODE: "check" });
    expect(install.exitCode).toBe(1);
    expect(install.stderr.toString()).toContain(
      "refused: mode: check mode (NEUVE_MODE=check) never installs the shared copy",
    );
    const dry = run({ NEUVE_MODE: "check" }, "--dry-run");
    expect(dry.exitCode).toBe(1);
    expect(dry.stdout.toString()).toContain(
      `neuve install plan for ${join(home, ".local")} (the shared copy)`,
    );
    expect(dry.stderr.toString()).toContain(
      "an install would be refused: mode:",
    );
    // Nothing under the shared prefix: no lock, no copy, no manifest.
    expect(listing(home).some((path) => path.startsWith(shared))).toBe(false);

    const wrong = run({}, "--everything");
    expect(wrong.exitCode).toBe(1);
    expect(wrong.stderr.toString()).toContain("Usage: bun run install:cli");
  });

  test("check:installed only reads, and names the install steps only on an integration branch", async () => {
    const repo = await checkout();
    const { layout } = await installed({ commit: repo.first, dirty: false });
    const before = await readFile(layout.manifest, "utf8");
    const line = () =>
      describeInstalledCopy({
        manifestPath: layout.manifest,
        workspaceRoot: repo.root,
      });
    expect(await line()).toContain(
      "is behind this checkout (" +
        repo.second.slice(0, 10) +
        " on main); to install it: `bun run install:cli --dry-run`, then `bun run install:cli`",
    );
    repo.git("checkout", "-q", "-b", "claude/lane");
    expect(await line()).toContain("never from a lane");
    expect(await readFile(layout.manifest, "utf8")).toBe(before);
    // A copy from the second commit, read from the side branch, which does not contain it.
    const later = await installed({ commit: repo.second, dirty: false });
    repo.git("checkout", "-q", "side");
    expect(
      await describeInstalledCopy({
        manifestPath: later.layout.manifest,
        workspaceRoot: repo.root,
      }),
    ).toContain("is not behind this checkout");
    const newerManifest = JSON.parse(before);
    newerManifest.records = {
      schemaVersion: 999,
      writerVersion: 999,
      projectorVersion: 999,
    };
    await Bun.write(layout.manifest, JSON.stringify(newerManifest));
    const newerBefore = await readFile(layout.manifest, "utf8");
    expect(await line()).toContain(
      "has newer Records versions than this checkout; leave it",
    );
    expect(await line()).not.toContain("install:cli");
    expect(await readFile(layout.manifest, "utf8")).toBe(newerBefore);
  });

  test("bun run check leaves a receipt only when it started and finished clean at one commit", async () => {
    const receipts = await temporaryDirectory("neuve-cli-receipts-");
    const script = resolve(import.meta.dir, "../scripts/check-receipt.ts");
    const step = (name: string) =>
      Bun.spawnSync([process.execPath, script, name], {
        env: { ...process.env, NEUVE_CHECK_RECEIPTS: receipts },
        stdout: "pipe",
        stderr: "pipe",
      });
    const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
      cwd: import.meta.dir,
      stdout: "pipe",
    })
      .stdout.toString()
      .trim();
    // Exactly as check-receipt.ts decides it (checkoutState): an untracked file is a change too.
    const clean = (await checkoutState(resolve(import.meta.dir, "../../..")))
      .clean;
    // Without a start, a finish writes nothing.
    expect(step("finish").exitCode).toBe(0);
    expect(await Bun.file(join(receipts, `${head}.json`)).exists()).toBe(false);
    expect(step("start").exitCode).toBe(0);
    expect(step("finish").exitCode).toBe(0);
    expect(await Bun.file(join(receipts, `${head}.json`)).exists()).toBe(clean);
    if (clean)
      expect(await readReceipt(receipts, head)).toMatchObject({ commit: head });
  });

  test("one untracked file in the checkout leaves no receipt", async () => {
    // A scratch checkout holding the receipt script and the module it reads the tree with, so
    // the case can plant a file without touching this repository.
    const checkout = await temporaryDirectory("neuve-cli-receipt-checkout-");
    const receipts = await temporaryDirectory("neuve-cli-receipts-");
    for (const path of [
      "apps/neuve-cli/scripts/check-receipt.ts",
      "apps/neuve-cli/src/install-source.ts",
    ]) {
      await mkdir(dirname(join(checkout, path)), { recursive: true });
      await writeFile(
        join(checkout, path),
        await readFile(resolve(import.meta.dir, "../../..", path)),
      );
    }
    await symlink(
      resolve(import.meta.dir, "../../../node_modules"),
      join(checkout, "node_modules"),
    );
    await writeFile(join(checkout, ".gitignore"), "/node_modules\n");
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      NEUVE_CHECK_RECEIPTS: receipts,
    };
    const git = (...args: Array<string>) =>
      Bun.spawnSync(["git", ...args], { cwd: checkout, env, stdout: "pipe" });
    for (const args of [
      ["init", "--quiet", "-b", "main"],
      ["add", "."],
      [
        "-c",
        "user.name=Receipt test",
        "-c",
        "user.email=receipt@example.test",
        "commit",
        "--quiet",
        "-m",
        "checkout",
      ],
    ])
      expect(git(...args).exitCode).toBe(0);
    const head = git("rev-parse", "HEAD").stdout.toString().trim();
    const step = (name: string) =>
      Bun.spawnSync(
        [
          process.execPath,
          join(checkout, "apps/neuve-cli/scripts/check-receipt.ts"),
          name,
        ],
        { cwd: checkout, env, stdout: "pipe", stderr: "pipe" },
      );
    const receipt = join(receipts, `${head}.json`);
    // Clean, it leaves a receipt.
    expect((await checkoutState(checkout)).clean).toBe(true);
    expect(step("start").exitCode).toBe(0);
    expect(step("finish").exitCode).toBe(0);
    expect(await Bun.file(receipt).exists()).toBe(true);
    await rm(receipt);
    // One untracked file, ignored nowhere: no receipt, and the script says why.
    await writeFile(join(checkout, "notes.txt"), "draft\n");
    expect((await checkoutState(checkout)).clean).toBe(false);
    expect(step("start").exitCode).toBe(0);
    const finish = step("finish");
    expect(finish.exitCode).toBe(0);
    expect(await Bun.file(receipt).exists()).toBe(false);
    expect(finish.stderr.toString()).toContain(
      "no receipt: the tree has local changes",
    );
  });

  test("an install holds the lock; one stopped releases it and stops its build", async () => {
    const { prefix } = await installed({
      commit: "e".repeat(40),
      dirty: false,
    });
    expect(await withInstallLock(prefix, async () => "ran")).toBe("ran");
    let inner: unknown;
    await withInstallLock(prefix, async () => {
      inner = await withInstallLock(prefix, async () => "ran");
    });
    expect(inner).toBe("busy");

    // A holder stopped by SIGTERM: its build child is stopped and the lock is free again.
    const pidFile = join(dirname(prefix), "child.pid");
    const holder = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, "fixtures/hold-install-lock.ts"),
        prefix,
        pidFile,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    for (let waited = 0; waited < 10_000; waited += 50) {
      if (await Bun.file(pidFile).exists()) break;
      await Bun.sleep(50);
    }
    const child = Number((await readFile(pidFile, "utf8")).trim());
    expect(await withInstallLock(prefix, async () => "ran")).toBe("busy");
    holder.kill("SIGTERM");
    expect(await holder.exited).toBe(143);
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let waited = 0; waited < 2_000 && alive(child); waited += 50)
      await Bun.sleep(50);
    expect(alive(child)).toBe(false);
    expect(await withInstallLock(prefix, async () => "ran")).toBe("ran");
  });

  test("an install stopped before its manifest is repaired by the next, not refused", async () => {
    const directory = await temporaryDirectory("neuve-cli-half-");
    const cli = join(directory, "neuve");
    const graph = join(directory, "entire-graph");
    const layout = installLayout(join(directory, "home/.local"));
    await Bun.write(cli, "cli-1");
    await Bun.write(graph, "graph-1");
    await install(directory, cli, graph);
    // The second install recorded what it was copying and stopped after the CLI, before its
    // manifest: the manifest still names cli-1, while cli-2 is in place.
    const sha = (text: string) =>
      new Bun.CryptoHasher("sha256").update(text).digest("hex");
    await writeFile(
      layout.pending,
      JSON.stringify({ sha256: [sha("cli-2"), sha("graph-1")], parser: false }),
    );
    await Bun.write(layout.cli, "cli-2");
    await Bun.write(cli, "cli-3");
    await install(directory, cli, graph);
    expect(await readFile(layout.cli, "utf8")).toBe("cli-3");
    expect(await Bun.file(layout.pending).exists()).toBe(false);
    const manifest = JSON.parse(await readFile(layout.manifest, "utf8"));
    expect(manifest.cli.sha256).toBe(sha("cli-3"));
    // Without that record the same bytes are someone else's.
    await Bun.write(layout.cli, "cli-2");
    await expect(install(directory, cli, graph)).rejects.toThrow(
      "Neuve did not install it",
    );
  });
});

// Why: the guards are only as strong as their weakest reading. The shared copy has many spellings
// (a symlink, another case, the firmlink path, the account's own home when HOME points elsewhere),
// the checkout can change while the CLI builds, a read-only plan must not touch git's index, an
// untracked file is a local change, and a first install stopped halfway must not lock the copy for
// good. Each is shown at the script's boundary, with real processes and real git, under temporary
// folders only.
describe("install guard strictness", () => {
  const SCRIPT = resolve(import.meta.dir, "../scripts/install-local.ts");
  const LINUX = resolve(import.meta.dir, "../scripts/install-linux.ts");
  const DIRECT = resolve(import.meta.dir, "fixtures/install-direct.ts");

  /** A home whose `.local` holds an installed copy, under /tmp so its firmlink path exists too. */
  const home = async () => {
    await mkdir("/tmp/claude", { recursive: true });
    const root = await realpath(await mkdtemp("/tmp/claude/neuve-home-"));
    temporaryDirectories.push(root);
    const build = join(root, "build");
    await Bun.write(join(build, "neuve"), "cli");
    await Bun.write(join(build, "entire-graph"), "graph");
    await installLocalCli({
      cli: join(build, "neuve"),
      graph: join(build, "entire-graph"),
      prefix: join(root, ".local"),
      graphVersion: "dev",
      graphWorkspaceRevision: null,
    });
    return { root, build, shared: join(root, ".local") };
  };

  const aliases = async (root: string) => {
    const link = join(root, "link-to-local");
    await symlink(join(root, ".local"), link);
    const dangling = join(root, "dangling");
    await symlink(join(root, ".local/not-yet"), dangling);
    // Scratch prefixes whose `bin` or `lib` link into the shared copy write the shared copy.
    const viaBin = join(root, "p-bin");
    await mkdir(viaBin);
    await symlink(join(root, ".local/bin"), join(viaBin, "bin"));
    const viaLib = join(root, "p-lib");
    await mkdir(viaLib);
    await symlink(join(root, ".local/lib"), join(viaLib, "lib"));
    return [
      link,
      viaBin,
      viaLib,
      ...(process.platform === "darwin" ? [join(root, ".LOCAL")] : []),
      ...((await lstat("/System/Volumes/Data/private/tmp").catch(() => null))
        ? [join("/System/Volumes/Data", root, ".local")]
        : []),
      join(root, "sub/../.local"),
    ];
  };

  test("the shared prefix is the shared prefix under every spelling", async () => {
    const { root, shared } = await home();
    for (const alias of await aliases(root))
      expect([alias, isSharedPrefix(alias, [shared])]).toEqual([alias, true]);
    // A path inside it, not yet created, through a symlink that dangles: still not scratch.
    expect(
      isSharedPrefix(join(root, "dangling"), [join(root, ".local/not-yet")]),
    ).toBe(true);
    expect(isSharedPrefix(join(root, "elsewhere"), [shared])).toBe(false);
    // The account's own home counts, whatever HOME says.
    const other = await temporaryDirectory("neuve-cli-other-home-");
    const probe = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `import { sharedPrefixes } from ${JSON.stringify(resolve(import.meta.dir, "../src/install-source.ts"))}; console.log(JSON.stringify(sharedPrefixes()));`,
      ],
      { env: { ...process.env, HOME: other }, stdout: "pipe" },
    );
    const account = Bun.spawnSync(["/bin/sh", "-c", 'eval echo "~$(id -un)"'], {
      env: { ...process.env, HOME: other },
      stdout: "pipe",
    })
      .stdout.toString()
      .trim();
    expect(account).not.toBe(other);
    expect(JSON.parse(probe.stdout.toString())).toEqual([
      join(other, ".local"),
      join(account, ".local"),
    ]);
  });

  test("check mode refuses every spelling of the shared prefix at each installer's boundary", async () => {
    const { root, build, shared } = await home();
    const before = await readFile(
      join(shared, "lib/neuve/install.json"),
      "utf8",
    );
    const env = (extra: Record<string, string> = {}) => {
      const { NEUVE_INSTALL_PREFIX: _prefix, ...rest } = process.env;
      return { ...rest, HOME: root, NEUVE_MODE: "check", ...extra };
    };
    for (const alias of await aliases(root)) {
      const plan = Bun.spawnSync(
        [process.execPath, SCRIPT, "--prefix", alias],
        {
          env: env(),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect([alias, plan.exitCode]).toEqual([alias, 1]);
      expect(plan.stdout.toString()).toContain("(the shared copy)");
      expect(plan.stderr.toString()).toContain("refused: mode: check mode");
      const viaEnv = Bun.spawnSync([process.execPath, SCRIPT, "--dry-run"], {
        env: env({ NEUVE_INSTALL_PREFIX: alias }),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(viaEnv.stdout.toString()).toContain("(the shared copy)");
      const direct = Bun.spawnSync(
        [
          process.execPath,
          DIRECT,
          alias,
          join(build, "neuve"),
          join(build, "entire-graph"),
        ],
        { env: env(), stdout: "pipe", stderr: "pipe" },
      );
      expect([alias, direct.exitCode]).toEqual([alias, 1]);
      expect(direct.stderr.toString()).toContain(
        "in check mode (NEUVE_MODE=check)",
      );
      const linux = Bun.spawnSync(
        [process.execPath, LINUX, "--prefix", alias],
        { env: env(), stdout: "pipe", stderr: "pipe" },
      );
      expect([alias, linux.exitCode]).toEqual([alias, 1]);
      expect(linux.stderr.toString()).toContain(
        "it is this machine's shared copy",
      );
    }
    // The image installer needs a prefix, and refuses check mode for any prefix.
    const bare = Bun.spawnSync([process.execPath, LINUX], {
      env: env(),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(bare.stderr.toString()).toContain("Usage:");
    const image = Bun.spawnSync(
      [process.execPath, LINUX, "--prefix", join(root, "image")],
      { env: env(), stdout: "pipe", stderr: "pipe" },
    );
    expect(image.stderr.toString()).toContain(
      "Refusing to install in check mode",
    );
    expect(await readFile(join(shared, "lib/neuve/install.json"), "utf8")).toBe(
      before,
    );
    expect(
      await Bun.file(join(shared, "lib/neuve/install-lock.sqlite")).exists(),
    ).toBe(false);
    // Alone 4.79-8.44 s at load 9-30 over 26 serial Bun starts; 10x slowest seen; child processes under load.
  }, 85_000);

  /** A clean checkout whose Graph engine is built and ignored. */
  const checkout = async () => {
    const root = await temporaryDirectory("neuve-cli-build-");
    const git = (...args: Array<string>) => {
      const result = Bun.spawnSync(["git", "-C", root, ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    git("init", "-q", "-b", "main");
    git("config", "user.email", "dev@example.com");
    git("config", "user.name", "Dev");
    await writeFile(
      join(root, ".gitignore"),
      "/apps/neuve-graph/entire-graph\nignored.txt\n",
    );
    await writeFile(join(root, "a"), "a\n");
    git("add", ".");
    git("commit", "-qm", "a");
    const engine = join(root, "apps/neuve-graph/entire-graph");
    await Bun.write(engine, "#!/bin/sh\necho dev\n");
    await chmod(engine, 0o755);
    return { root, git, head: git("rev-parse", "HEAD") };
  };

  test("an install is held to the commit its guards approved, before and after the build", async () => {
    const repo = await checkout();
    const prefix = join(await temporaryDirectory("neuve-cli-held-"), ".local");
    const installAs = (build: (outfile: string) => Promise<void>) =>
      installFromCheckout({
        prefix,
        workspaceRoot: repo.root,
        planned: { head: repo.head, branch: "main", shared: false },
        build,
        semantic: null,
        // A stand-in checkout has no web app; the desk build has tests of its own.
        desk: null,
      });
    let folder = "";
    // Another session commits while the CLI builds.
    await expect(
      installAs(async (outfile) => {
        folder = dirname(outfile);
        await Bun.write(outfile, "cli");
        await writeFile(join(repo.root, "b"), "b\n");
        repo.git("add", "b");
        repo.git("commit", "-qm", "b");
      }),
    ).rejects.toThrow("refused: the checkout changed during the build");
    expect(await Bun.file(join(prefix, "bin/neuve")).exists()).toBe(false);
    expect(await lstat(folder).catch(() => null)).toBeNull();
    repo.git("reset", "-q", "--hard", repo.head);
    // Or edits a tracked file, or leaves an untracked one.
    for (const change of [
      () => writeFile(join(repo.root, "a"), "edited\n"),
      () => writeFile(join(repo.root, "new.txt"), "new\n"),
    ]) {
      await expect(
        installAs(async (outfile) => {
          await Bun.write(outfile, "cli");
          await change();
        }),
      ).rejects.toThrow("refused: the checkout changed during the build");
      repo.git("checkout", "-q", "--", ".");
      await rm(join(repo.root, "new.txt"), { force: true });
    }
    // Already moved before the build: refused before it starts.
    await writeFile(join(repo.root, "a"), "edited\n");
    let built = false;
    await expect(
      installAs(async () => {
        built = true;
      }),
    ).rejects.toThrow("refused: the checkout changed before the build");
    expect(built).toBe(false);
    repo.git("checkout", "-q", "--", ".");
    // Unchanged: installed, recorded as the planned commit, clean.
    const manifest = await installAs((outfile) =>
      Bun.write(outfile, "cli").then(() => {}),
    );
    expect(manifest.source).toEqual({ commit: repo.head, dirty: false });
  });

  test("a scratch prefix whose lock, pending record or manifest links to the shared copy's is refused", async () => {
    const { root, build, shared } = await home();
    const sharedLayout = installLayout(shared);
    // The shared copy's lock exists once an install has held it.
    expect(await withInstallLock(shared, async () => "ran")).toBe("ran");
    const lockBefore = await lstat(sharedLayout.lock);
    const planted = async (name: string, target: string) => {
      const prefix = join(root, name);
      const layout = installLayout(prefix);
      await mkdir(dirname(layout.lock), { recursive: true });
      return { prefix, layout, target };
    };
    // A live link to the shared lock, and a dangling one to where it would be created.
    const live = await planted("p-lock", sharedLayout.lock);
    await symlink(live.target, live.layout.lock);
    await expect(
      withInstallLock(live.prefix, async () => "ran"),
    ).rejects.toThrow(
      `Refusing to use ${live.layout.lock} because it is a symbolic link`,
    );
    const afterLive = await lstat(sharedLayout.lock);
    expect([afterLive.mode, afterLive.mtimeMs, afterLive.ino]).toEqual([
      lockBefore.mode,
      lockBefore.mtimeMs,
      lockBefore.ino,
    ]);
    // Not held: the shared copy's own install still takes it.
    expect(await withInstallLock(shared, async () => "ran")).toBe("ran");
    const dangling = await planted(
      "p-dangling",
      join(shared, "lib/neuve/other-lock.sqlite"),
    );
    await symlink(dangling.target, dangling.layout.lock);
    await expect(
      withInstallLock(dangling.prefix, async () => "ran"),
    ).rejects.toThrow("because it is a symbolic link");
    expect(await lstat(dangling.target).catch(() => null)).toBeNull();

    // The pending record and the manifest, read through links, are refused too.
    const pending = await planted("p-pending", sharedLayout.manifest);
    await symlink(pending.target, pending.layout.pending);
    await expect(
      installLocalCli({
        cli: join(build, "neuve"),
        graph: join(build, "entire-graph"),
        prefix: pending.prefix,
        graphVersion: "dev",
        graphWorkspaceRevision: null,
      }),
    ).rejects.toThrow("because it is a symbolic link");
    const manifest = await planted("p-manifest", sharedLayout.manifest);
    await symlink(manifest.target, manifest.layout.manifest);
    await expect(
      installLocalCli({
        cli: join(build, "neuve"),
        graph: join(build, "entire-graph"),
        prefix: manifest.prefix,
        graphVersion: "dev",
        graphWorkspaceRevision: null,
      }),
    ).rejects.toThrow("because it is not a file");
    expect(
      await describeInstalledCopy({ manifestPath: manifest.layout.manifest }),
    ).toContain("cannot be read");
    expect(
      await lstat(join(manifest.prefix, "bin/neuve")).catch(() => null),
    ).toBeNull();
  });

  test("a folder linked into the shared copy during the build refuses the install before its first copy", async () => {
    const repo = await checkout();
    const { root, shared } = await home();
    const before = await readFile(join(shared, "bin/neuve"), "utf8");
    const attempt = (prefix: string) =>
      installFromCheckout({
        prefix,
        workspaceRoot: repo.root,
        planned: { head: repo.head, branch: "main", shared: false },
        alsoShared: [shared],
        semantic: null,
        desk: null,
        build: async (outfile) => {
          await Bun.write(outfile, "cli");
          // Another session links the scratch prefix's bin into the shared copy.
          await mkdir(prefix, { recursive: true });
          await symlink(join(shared, "bin"), join(prefix, "bin"));
        },
      });
    // In check mode, check mode's own refusal catches it.
    await expect(attempt(join(root, "scratch-check"))).rejects.toThrow(
      "in check mode (",
    );
    // Outside it, the guards' verdict no longer holds: the prefix now writes into the shared copy.
    const markers = ["NODE_ENV", "NEUVE_MODE", "CI"] as const;
    const saved = markers.map((name) => [name, process.env[name]] as const);
    for (const name of markers) delete process.env[name];
    try {
      await expect(attempt(join(root, "scratch-install"))).rejects.toThrow(
        "now writes into the shared copy since its guards ran",
      );
    } finally {
      for (const [name, value] of saved)
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    expect(await readFile(join(shared, "bin/neuve"), "utf8")).toBe(before);
    expect(
      await Bun.file(join(shared, "lib/neuve/install.pending.json")).exists(),
    ).toBe(false);
  });

  test("planning and check:installed never write git's index, and untracked files are local changes", async () => {
    const repo = await checkout();
    const index = join(repo.root, ".git/index");
    // A tracked file whose stat changed: a plain `git status` would refresh the index here.
    await writeFile(join(repo.root, "a"), "a\n");
    const stamp = async () => [
      (await lstat(index)).mtimeMs,
      await readFile(index),
      await Bun.file(join(repo.root, ".git/index.lock")).exists(),
    ];
    const before = await stamp();
    const prefix = join(await temporaryDirectory("neuve-cli-plan-"), ".local");
    const plan = await planInstall({
      prefix,
      workspaceRoot: repo.root,
      env: {},
    });
    expect(plan.blocked).toBeUndefined();
    await describeInstalledCopy({
      manifestPath: join(prefix, "lib/neuve/install.json"),
      workspaceRoot: repo.root,
    });
    expect(await stamp()).toEqual(before);

    await writeFile(join(repo.root, "ignored.txt"), "ignored\n");
    expect(
      (await planInstall({ prefix, workspaceRoot: repo.root, env: {} }))
        .blocked,
    ).toBeUndefined();
    await writeFile(join(repo.root, "untracked.txt"), "untracked\n");
    expect(
      (await planInstall({ prefix, workspaceRoot: repo.root, env: {} }))
        .blocked,
    ).toMatchObject({
      name: "tree",
      detail: "this checkout has local changes",
    });
  });

  test("a first install stopped before its manifest is completed, not refused", async () => {
    const repo = await checkout();
    const prefix = join(await temporaryDirectory("neuve-cli-first-"), ".local");
    const layout = installLayout(prefix);
    const sha = (text: string) =>
      new Bun.CryptoHasher("sha256").update(text).digest("hex");
    // It copied the Graph engine and the CLI, then stopped: no manifest.
    await Bun.write(layout.cli, "cli-1");
    await Bun.write(layout.graph, "graph-1");
    await Bun.write(
      layout.pending,
      JSON.stringify({ sha256: [sha("cli-1"), sha("graph-1")], parser: false }),
    );
    const plan = await planInstall({
      prefix,
      workspaceRoot: repo.root,
      env: {},
      alsoShared: [prefix],
    });
    expect(
      plan.guards.find((entry) => entry.name === "installed copy"),
    ).toMatchObject({
      ok: true,
      detail: `an interrupted first install at ${layout.cli}, which this install completes`,
    });
    const directory = await temporaryDirectory("neuve-cli-first-build-");
    await Bun.write(join(directory, "neuve"), "cli-2");
    await Bun.write(join(directory, "entire-graph"), "graph-2");
    await installLocalCli({
      cli: join(directory, "neuve"),
      graph: join(directory, "entire-graph"),
      prefix,
      graphVersion: "dev",
      graphWorkspaceRevision: null,
    });
    expect(await readFile(layout.cli, "utf8")).toBe("cli-2");
    expect(await Bun.file(layout.pending).exists()).toBe(false);
    // Bytes no pending record names are someone else's.
    await rm(layout.manifest);
    await Bun.write(layout.cli, "someone else's");
    expect(
      (
        await planInstall({
          prefix,
          workspaceRoot: repo.root,
          env: {},
          alsoShared: [prefix],
        })
      ).blocked?.name,
    ).toBe("installed copy");
  });
});

describe("Graph engine discovery", () => {
  // The installed command is a copy, so it cannot reach the workspace's Graph
  // checkout; it must find the engine install:cli copies beside it. A
  // workspace build at apps/neuve-cli/dist/neuve uses the sibling checkout.
  test("finds the engine beside an installed copy or a workspace build", async () => {
    const root = await temporaryDirectory("neuve-cli-discovery-");
    const builtCli = join(root, "workspace/apps/neuve-cli/dist/neuve");
    const builtGraph = join(root, "workspace/apps/neuve-graph/entire-graph");
    await Bun.write(builtCli, "#!/bin/sh\nexit 0\n");
    await Bun.write(builtGraph, "#!/bin/sh\nexit 0\n");
    await chmod(builtGraph, 0o755);
    const { cli, graph } = installLayout(join(root, "home/.local"));
    await installLocalCli({
      cli: builtCli,
      graph: builtGraph,
      prefix: join(root, "home/.local"),
      graphVersion: "dev",
      graphWorkspaceRevision: null,
    });

    expect((await lstat(cli)).isSymbolicLink()).toBe(false);
    expect(
      await discoverGraphBinary({ override: undefined, executable: cli }),
    ).toBe(graph);
    expect(
      await discoverGraphBinary({ override: builtGraph, executable: cli }),
    ).toBe(builtGraph);
    expect(
      await discoverGraphBinary({ override: undefined, executable: builtCli }),
    ).toBe(builtGraph);
  });
});
