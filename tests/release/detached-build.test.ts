// Opt-in release check (`bun run test:release`): it copies the workspace,
// runs `bun install --frozen-lockfile` and compiles the CLI into a temporary
// detached worktree. It never builds into or replaces the installed command.
import { afterEach, describe, expect, test } from "bun:test";
import { constants } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

const temporaryDirectories: string[] = [];

const temporaryDirectory = async (prefix: string): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

// Removing a detached dependency tree and cache can exceed the five-second hook default.
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
}, 60_000);

const run = async (
  command: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string> => {
  const child = Bun.spawn([...command], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed: ${stderr.trim()}`);
  }
  return stdout.trim();
};

const packageSchema = z.object({
  name: z.string(),
  dependencies: z.record(z.string(), z.string()).default({}),
  devDependencies: z.record(z.string(), z.string()).default({}),
  optionalDependencies: z.record(z.string(), z.string()).default({}),
});

// Follow package declarations so newly imported workspaces enter this fixture too.
const buildWorkspaces = async (source: string): Promise<string[]> => {
  const root = z
    .object({ workspaces: z.array(z.string()) })
    .parse(await Bun.file(join(source, "package.json")).json());
  const packages = new Map<string, { path: string; dependencies: string[] }>();
  for (const pattern of root.workspaces) {
    for await (const file of new Bun.Glob(`${pattern}/package.json`).scan(
      source,
    )) {
      const manifest = packageSchema.parse(
        await Bun.file(join(source, file)).json(),
      );
      packages.set(manifest.name, {
        path: file.slice(0, -"/package.json".length),
        dependencies: Object.entries({
          ...manifest.dependencies,
          ...manifest.devDependencies,
          ...manifest.optionalDependencies,
        })
          .filter(([, version]) => version.startsWith("workspace:"))
          .map(([name]) => name),
      });
    }
  }
  const manifest = packageSchema.parse(
    await Bun.file(join(source, "package.json")).json(),
  );
  const pending = [
    "@neuve/cli",
    // The CLI compiles the review desk's server handler from the web app by path
    // (src/review-desk.ts), so the web app and its workspaces come along.
    "web",
    ...Object.entries({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    })
      .filter(([, version]) => version.startsWith("workspace:"))
      .map(([name]) => name),
  ];
  const selected = new Set<string>();
  for (const name of pending) {
    const workspace = packages.get(name);
    if (!workspace) throw new Error(`Missing workspace ${name}`);
    if (selected.has(workspace.path)) continue;
    selected.add(workspace.path);
    pending.push(...workspace.dependencies);
  }
  return [...selected].sort();
};

/** A cache of copies of the machine cache's entries for the lockfile's packages; never the original. */
const seededCache = async (source: string, home: string) => {
  const machine =
    process.env.NEUVE_TEST_BUN_CACHE ??
    Bun.spawnSync([process.execPath, "pm", "cache"], {
      env: { ...process.env, BUN_INSTALL_CACHE_DIR: undefined },
      stdout: "pipe",
    })
      .stdout.toString()
      .trim();
  // The copy goes on the machine cache's own volume, where each entry is an APFS clone that costs no
  // space or time: NEUVE_TEST_BUN_CACHE_SCRATCH, else the test's home when it shares that volume,
  // else this account's temporary folder on the internal disk (getconf DARWIN_USER_TEMP_DIR), so a
  // TMPDIR on another disk never receives a real copy of about 1 GB.
  const sameVolume = async (a: string, b: string) =>
    (await stat(a)).dev === (await stat(b)).dev;
  const internal = Bun.spawnSync(["getconf", "DARWIN_USER_TEMP_DIR"], {
    stdout: "pipe",
  })
    .stdout.toString()
    .trim();
  const scratch =
    process.env.NEUVE_TEST_BUN_CACHE_SCRATCH ??
    ((await sameVolume(machine, home)) ? undefined : internal || undefined);
  const cache =
    scratch === undefined
      ? join(home, "bun-cache")
      : await mkdtemp(join(scratch, "neuve-detached-build-cache-"));
  if (scratch !== undefined) temporaryDirectories.push(cache);
  await mkdir(cache, { recursive: true });
  const lock = await Bun.file(join(source, "bun.lock")).text();
  const locked = new Set(
    [...lock.matchAll(/^\s+"[^"]+": \["((?:@[^@"/]+\/)?[^@"]+@[^"]+)"/gm)].map(
      (match) => `${match[1]}@@@1`,
    ),
  );
  for (const entry of locked) {
    const from = join(machine, entry);
    if (!(await lstat(from).catch(() => null))?.isDirectory()) continue;
    await mkdir(dirname(join(cache, entry)), { recursive: true });
    // A clone where the two folders share a volume, else a copy: the machine cache is only read.
    await cp(from, join(cache, entry), {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
    });
  }
  return cache;
};

describe("detached public CLI build", () => {
  test("installs the frozen CLI workspace dependencies and compiles its worker entrypoints", async () => {
    const source = resolve(import.meta.dir, "../..");
    const repository = await temporaryDirectory("neuve-detached-build-source-");
    const home = await temporaryDirectory("neuve-detached-build-home-");
    const tools = join(home, "bin");
    await mkdir(tools);
    // Workspace imports discover the tailnet; help must not depend on the host's Tailscale.
    await writeFile(
      join(tools, "tailscale"),
      '#!/bin/sh\nprintf \'{"BackendState":"Stopped"}\\n\'\n',
      { mode: 0o755 },
    );
    const env = {
      ...process.env,
      HOME: home,
      PATH: `${tools}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      BUN_INSTALL: join(home, ".bun"),
      // A private cache, seeded with copies of the packages the lockfile names from the machine's
      // cache (NEUVE_TEST_BUN_CACHE names another), so the install never adds to the machine's
      // cache and doesn't download what this Mac already fetched.
      BUN_INSTALL_CACHE_DIR: await seededCache(source, home),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    };
    for (const path of [
      "package.json",
      "bun.lock",
      "tsconfig.base.json",
      "scripts",
      ...(await buildWorkspaces(source)),
    ]) {
      await cp(join(source, path), join(repository, path), {
        recursive: true,
        filter: (entry) =>
          !relative(source, entry)
            .split(sep)
            .some(
              (segment) => segment === "node_modules" || segment === "dist",
            ),
      });
    }
    await run(["git", "init", "--quiet"], repository, env);
    await run(["git", "config", "user.name", "Neuve test"], repository, env);
    await run(
      ["git", "config", "user.email", "neuve-test@example.test"],
      repository,
      env,
    );
    await run(["git", "add", "."], repository, env);
    await run(
      ["git", "commit", "--quiet", "-m", "cutover source"],
      repository,
      env,
    );

    const detached = await temporaryDirectory("neuve-detached-build-");
    await rm(detached, { recursive: true, force: true });
    await run(
      ["git", "worktree", "add", "--quiet", "--detach", detached, "HEAD"],
      repository,
      env,
    );
    // The worktree can be on a volume without clonefile support, including lane drives.
    await run(
      [process.execPath, "install", "--frozen-lockfile", "--backend=copyfile"],
      detached,
      env,
    );
    await run(
      [
        process.execPath,
        "apps/neuve-cli/scripts/build.ts",
        "--outfile",
        "./neuve",
      ],
      detached,
      env,
    );
    expect((await lstat(join(detached, "neuve"))).isFile()).toBe(true);
    const { version } = z
      .object({ version: z.string() })
      .parse(
        await Bun.file(join(detached, "apps/neuve-cli/package.json")).json(),
      );
    expect(
      await run([join(detached, "neuve"), "--version"], detached, env),
    ).toBe(`neuve ${version}`);
    expect(
      await run([join(detached, "neuve"), "--help"], detached, env),
    ).toContain("  workspace [");
    expect(
      await run(
        [join(detached, "neuve"), "workspace", "--help"],
        detached,
        env,
      ),
    ).toContain("Usage: neuve workspace [");
  }, 300_000);
});
