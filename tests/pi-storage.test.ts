import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
  diskutilVolumeProbe,
  prepareStorage,
  spawnEnvironment,
  STORAGE_ROLES,
  StorageRefused,
  validateStorageProfile,
  type StorageProfile,
  type StorageRefusalReason,
  type VolumeProbe,
} from "../scripts/pi-storage.ts";

const script = resolve(import.meta.dir, "../scripts/pi-storage.ts");
const scratch = await realpath(
  await mkdtemp(join(tmpdir(), "neuve pi-storage's ")),
);
afterAll(() => rm(scratch, { recursive: true, force: true }));

const mountOf = async (path: string): Promise<string> => {
  const device = (await stat(path)).dev;
  let current = path;
  while (current !== "/" && (await stat(dirname(current))).dev === device)
    current = dirname(current);
  return current;
};
const mountPoint = await mountOf(scratch);

const diskutilCannotIdentify = (path: string): string | undefined => {
  if (Bun.which("diskutil") === null) return "diskutil is not on PATH";
  const info = Bun.spawnSync(["diskutil", "info", path], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return info.exitCode === 0
    ? undefined
    : `${info.stdout.toString()}${info.stderr.toString()}`.trim();
};
/**
 * diskutil names `/` and mounted volumes, but not every mount TMPDIR can sit on: not `/private` on a Mac
 * that gives it its own device, and nothing inside a sandbox without DiskManagement. There every case runs
 * on a stand-in identity for the same mount, and only the CLI case, which reads the real identity, is skipped.
 */
const unidentified = diskutilCannotIdentify(mountPoint);
if (unidentified !== undefined)
  console.warn(
    `diskutil cannot identify ${mountPoint}, the mount holding TMPDIR (${unidentified}). The cases use a stand-in identity for it and the CLI case is skipped.`,
  );
const probe: VolumeProbe =
  unidentified === undefined
    ? diskutilVolumeProbe
    : async () => ({ mountPoint, volumeUuid: "stand-in" });
const { volumeUuid } = await probe(mountPoint);
const volume = { mountPoint, volumeUuid };
const validate = (
  profile: StorageProfile,
  options: Readonly<{ checkout?: string }> = {},
) => validateStorageProfile(profile, { ...options, probe });

/** A folder on another device, so a link or `..` to it leaves the volume even when the volume is `/`. */
const elsewhere =
  (await stat("/")).dev === (await stat(mountPoint)).dev ? "/dev" : "/";

const git = (cwd: string, ...args: string[]): string => {
  const result = Bun.spawnSync(
    ["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args],
    {
      cwd,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
};

const repository = async (path: string): Promise<string> => {
  await mkdir(path, { recursive: true });
  git(path, "init", "-q");
  git(path, "commit", "-q", "--allow-empty", "-m", "first");
  return path;
};

let cases = 0;
const layout = async () => {
  const base = join(scratch, `case ${++cases}`);
  const clone = await repository(join(base, "neuve clone"));
  const profile = {
    volume,
    paths: {
      canonicalClone: clone,
      worktrees: join(base, "work trees"),
      state: join(base, "state"),
      captures: join(base, "state", "captures"),
      cache: join(base, "cache"),
      bunCache: join(base, "cache", "bun"),
      tmp: join(base, "t m p"),
      builds: join(base, "builds"),
    },
  } satisfies StorageProfile;
  return { base, clone, profile };
};

const withPaths = (
  profile: StorageProfile,
  paths: Partial<StorageProfile["paths"]>,
): StorageProfile => ({ ...profile, paths: { ...profile.paths, ...paths } });

const existingRoles = (profile: StorageProfile) =>
  STORAGE_ROLES.filter((role) => existsSync(profile.paths[role]));

const refusal = async (
  attempt: Promise<unknown>,
): Promise<StorageRefusalReason> => {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof StorageRefused) return error.reason;
    throw error;
  }
  throw new Error("The profile was accepted.");
};

const run = async (
  argv: readonly string[],
  env: Record<string, string>,
): Promise<{ stdout: string; exitCode: number }> => {
  const child = Bun.spawn([...argv], { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  return { stdout, exitCode };
};

describe("validateStorageProfile", () => {
  test("validates the real mounted volume without creating a folder, then prepares the same folders on every run", async () => {
    const { clone, profile } = await layout();
    const validated = await validate(profile);
    expect(validated.volume).toEqual({
      mountPoint,
      volumeUuid: volumeUuid.toUpperCase(),
      device: (await stat(mountPoint)).dev,
    });
    expect(validated.paths).toEqual(profile.paths);
    expect(validated.gitCommonDir).toBe(join(clone, ".git"));
    expect(existingRoles(profile)).toEqual(["canonicalClone"]);

    await prepareStorage(validated);
    await writeFile(join(profile.paths.state, "kept"), "first run");
    const again = await prepareStorage(await validate(profile));
    expect(again.paths).toEqual(validated.paths);
    expect(await readFile(join(profile.paths.state, "kept"), "utf8")).toBe(
      "first run",
    );
    expect(existingRoles(profile)).toEqual([...STORAGE_ROLES]);
    expect(
      Object.values(validated.environment).filter((path) => !existsSync(path)),
    ).toEqual([]);
  });

  test("a missing mount is refused and no mount folder or storage folder appears", async () => {
    const { base, profile } = await layout();
    const absent = join("/Volumes", `neuve-absent-${crypto.randomUUID()}`);
    const onAbsent = {
      volume: { mountPoint: absent, volumeUuid },
      paths: { ...profile.paths, state: join(absent, "state") },
    };
    expect(await refusal(validate(onAbsent))).toBe("volume-absent");
    expect(existsSync(absent)).toBe(false);
    expect(await readdir(base)).toEqual(["neuve clone"]);
  });

  test("a folder named like the volume is not a mount, whatever its name and UUID", async () => {
    const { base, profile } = await layout();
    const lookalike = join(base, basename(mountPoint) || "Macintosh HD");
    await mkdir(lookalike);
    const onLookalike = {
      volume: { mountPoint: lookalike, volumeUuid },
      paths: { ...profile.paths, state: join(lookalike, "state") },
    };
    expect(await refusal(validate(onLookalike))).toBe("not-a-mount-point");
    expect(await readdir(lookalike)).toEqual([]);
    expect(existingRoles(profile)).toEqual(["canonicalClone"]);
  });

  test("the real mount point with another identity is refused, so a matching label never passes", async () => {
    const { profile } = await layout();
    const otherUuid = {
      ...profile,
      volume: {
        mountPoint,
        volumeUuid: "00000000-0000-0000-0000-000000000000",
      },
    };
    expect(await refusal(validate(otherUuid))).toBe("volume-identity-mismatch");
    const misplaced = async () => ({
      mountPoint: "/Volumes/elsewhere",
      volumeUuid,
    });
    expect(
      await refusal(validateStorageProfile(profile, { probe: misplaced })),
    ).toBe("volume-identity-mismatch");
    const unreadable = async (): Promise<never> => {
      throw new Error("probe unavailable");
    };
    expect(
      await refusal(validateStorageProfile(profile, { probe: unreadable })),
    ).toBe("volume-probe-failed");
    expect(existingRoles(profile)).toEqual(["canonicalClone"]);
  });

  test("a symlink, a dangling link or .. that leads off the volume is refused before anything is written", async () => {
    const { base, clone, profile } = await layout();
    const escape = join(base, "escape");
    await symlink(elsewhere, escape);
    const target = `neuve-escape-${crypto.randomUUID()}`;
    expect(
      await refusal(
        validate(withPaths(profile, { tmp: join(escape, target) })),
      ),
    ).toBe("path-off-volume");
    expect(existsSync(join(elsewhere, target))).toBe(false);

    expect(
      await refusal(
        validate(
          withPaths(profile, {
            state: `${mountPoint}/../..${join(elsewhere, target)}`,
          }),
        ),
      ),
    ).toBe("path-off-volume");

    await mkdir(profile.paths.cache);
    await symlink(elsewhere, join(profile.paths.cache, "xdg"));
    expect(await refusal(validate(profile))).toBe("path-off-volume");
    await rm(profile.paths.cache, { recursive: true });

    await symlink(join(base, "nowhere"), join(base, "dangling"));
    expect(
      await refusal(
        validate(
          withPaths(profile, { builds: join(base, "dangling", "builds") }),
        ),
      ),
    ).toBe("path-dangling-link");

    expect(
      await refusal(validate(withPaths(profile, { tmp: join(clone, "tmp") }))),
    ).toBe("path-inside-checkout");
    expect(
      await refusal(validate(withPaths(profile, { tmp: "relative/tmp" }))),
    ).toBe("profile-malformed");
    expect(existingRoles(profile)).toEqual(["canonicalClone"]);
    expect(existsSync(join(base, "nowhere"))).toBe(false);
  });

  test("an ancestor swapped for an off-volume link after validation stops prepare before any folder is made", async () => {
    const { base, profile } = await layout();
    const ancestor = join(base, "swapped ancestor");
    await mkdir(ancestor);
    const target = `neuve-swap-${crypto.randomUUID()}`;
    const swapped = withPaths(profile, {
      state: join(ancestor, target, "state"),
      captures: join(ancestor, target, "captures"),
    });
    const validated = await validate(swapped);
    expect(validated.paths.state).toBe(join(ancestor, target, "state"));

    await rm(ancestor, { recursive: true });
    await symlink(elsewhere, ancestor);
    expect(await refusal(prepareStorage(validated))).toBe("path-off-volume");
    expect(existsSync(join(elsewhere, target))).toBe(false);
    expect(existingRoles(swapped)).toEqual(["canonicalClone"]);

    const onVolume = join(base, "elsewhere on the volume");
    await mkdir(onVolume);
    await rm(ancestor);
    await symlink(onVolume, ancestor);
    expect(await refusal(prepareStorage(validated))).toBe("path-off-volume");
    expect(await readdir(onVolume)).toEqual([]);
    expect(existingRoles(swapped)).toEqual(["canonicalClone"]);
    await expect(prepareStorage({ ...validated })).rejects.toThrow(
      "prepareStorage takes the result of validateStorageProfile.",
    );
  });

  test("a name the filesystem stores in its own form, as HFS+ decomposes é, prepares every time and comes back as stored, and a link under that name is still refused", async () => {
    const { base, profile } = await layout();
    const composed = join(base, "café");
    const accented = withPaths(profile, {
      tmp: composed,
      builds: join(composed, "builds"),
    });
    const validated = await validate(accented);
    expect(validated.paths.tmp).toBe(composed);

    const prepared = await prepareStorage(validated);
    const stored = await realpath(composed);
    expect(["café", "café"]).toContain(basename(stored));
    expect(await readdir(base)).toContain(basename(stored));
    expect(prepared.paths).toEqual({
      ...accented.paths,
      tmp: stored,
      builds: join(stored, "builds"),
    });
    expect(prepared.environment.TMPDIR).toBe(stored);
    expect(await prepareStorage(validated)).toEqual(prepared);
    expect(await prepareStorage(await validate(accented))).toEqual(prepared);

    await rm(stored, { recursive: true });
    await symlink(elsewhere, composed);
    expect(await refusal(prepareStorage(validated))).toBe("path-off-volume");
    const onVolume = join(base, "elsewhere on the volume");
    await mkdir(onVolume);
    await rm(composed);
    await symlink(onVolume, composed);
    expect(await refusal(prepareStorage(validated))).toBe("path-off-volume");
    expect(await readdir(onVolume)).toEqual([]);
  });

  test("a malformed profile is refused before the volume is read", async () => {
    const { profile } = await layout();
    const { tmp: _tmp, ...withoutTmp } = profile.paths;
    for (const malformed of [
      withPaths(profile, { tmp: "relative/tmp" }),
      { ...profile, paths: withoutTmp },
      { ...profile, paths: { ...profile.paths, extra: "/elsewhere" } },
      { ...profile, volume: { ...profile.volume, label: "LaCie Blu" } },
    ])
      expect(
        await refusal(
          validateStorageProfile(malformed as StorageProfile, {
            probe: async () => {
              throw new Error("The volume was read.");
            },
          }),
        ),
      ).toBe("profile-malformed");
    expect(existingRoles(profile)).toEqual(["canonicalClone"]);
  });

  test("a checkout must be the canonical clone or a worktree sharing its Git common directory", async () => {
    const { base, clone, profile } = await layout();
    await mkdir(profile.paths.worktrees);
    const lane = join(profile.paths.worktrees, "lane 'one'");
    git(clone, "worktree", "add", "-q", "--detach", lane);
    const validated = await validate(profile, { checkout: lane });
    expect(validated.gitCommonDir).toBe(join(clone, ".git"));

    const foreign = await repository(join(profile.paths.worktrees, "foreign"));
    expect(await refusal(validate(profile, { checkout: foreign }))).toBe(
      "checkout-foreign-repository",
    );
    const outside = await repository(join(base, "outside"));
    expect(await refusal(validate(profile, { checkout: outside }))).toBe(
      "checkout-outside-profile",
    );
    await mkdir(join(clone, "sub"));
    expect(
      await refusal(
        validate(withPaths(profile, { canonicalClone: join(clone, "sub") })),
      ),
    ).toBe("not-a-git-top-level");
  });

  test("inherited Git variables, as a hook receives them, neither admit a foreign checkout nor redirect the canonical clone", async () => {
    const { clone, profile } = await layout();
    await mkdir(profile.paths.worktrees);
    const foreign = await repository(join(profile.paths.worktrees, "foreign"));
    const hookVariables = (gitDir: string, workTree: string) => ({
      GIT_DIR: gitDir,
      GIT_COMMON_DIR: gitDir,
      GIT_WORK_TREE: workTree,
      GIT_INDEX_FILE: join(gitDir, "index"),
    });
    const saved = Object.keys(hookVariables("", "")).map(
      (name) => [name, process.env[name]] as const,
    );
    const outcome = async (
      variables: Record<string, string>,
      checkout: string,
    ) => {
      Object.assign(process.env, variables);
      try {
        return await validate(profile, { checkout }).then(
          (validated) => validated.gitCommonDir,
          (error) => (error instanceof StorageRefused ? error.reason : error),
        );
      } finally {
        for (const [name, value] of saved)
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
      }
    };
    // GIT_DIR alone makes `git -C foreign` report foreign as its top level and the clone's common directory.
    expect(await outcome({ GIT_DIR: join(clone, ".git") }, foreign)).toBe(
      "checkout-foreign-repository",
    );
    expect(
      await outcome(hookVariables(join(clone, ".git"), foreign), foreign),
    ).toBe("checkout-foreign-repository");
    expect(
      await outcome(hookVariables(join(foreign, ".git"), clone), clone),
    ).toBe(join(clone, ".git"));
  });
});

describe("spawnEnvironment", () => {
  test("forces every temporary and cache variable onto the profile and passes sign-in variables through", async () => {
    const { base, profile } = await layout();
    const storage = await validate(profile);
    const base_ = {
      TMPDIR: "/tmp/",
      tmp: "/tmp",
      BUN_INSTALL_CACHE_DIR: "/elsewhere/bun",
      NPM_CONFIG_CACHE: "/elsewhere/npm",
      XDG_CACHE_HOME: "/elsewhere/cache",
      HOME: "/Users/someone",
      CODEX_HOME: "/Users/someone/.codex",
      PATH: "/usr/bin:/bin",
      UNSET: undefined,
    };
    expect(spawnEnvironment(storage, base_)).toEqual({
      HOME: "/Users/someone",
      CODEX_HOME: "/Users/someone/.codex",
      PATH: "/usr/bin:/bin",
      TMPDIR: join(base, "t m p"),
      TMP: join(base, "t m p"),
      TEMP: join(base, "t m p"),
      BUN_TMPDIR: join(base, "t m p"),
      GOTMPDIR: join(base, "t m p"),
      BUN_INSTALL_CACHE_DIR: join(base, "cache", "bun"),
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(base, "cache", "bun-transpiler"),
      XDG_CACHE_HOME: join(base, "cache", "xdg"),
      GOCACHE: join(base, "cache", "go-build"),
      GOMODCACHE: join(base, "cache", "go-mod"),
      npm_config_cache: join(base, "cache", "npm"),
    });
  });

  test("children launched with it write under the profile, through paths with spaces and apostrophes", async () => {
    const { profile } = await layout();
    const storage = await prepareStorage(await validate(profile));
    const env = spawnEnvironment(storage, { PATH: process.env["PATH"] ?? "" });

    const shell = await run(
      ["/bin/sh", "-c", 'mkdir -p "$TMPDIR/sh probe" && printf %s "$TMPDIR"'],
      env,
    );
    expect(shell).toEqual({ stdout: profile.paths.tmp, exitCode: 0 });
    expect(existsSync(join(profile.paths.tmp, "sh probe"))).toBe(true);
    const bun = await run(
      [
        process.execPath,
        "-e",
        "process.stdout.write(require('node:os').tmpdir() + '|' + process.env.BUN_INSTALL_CACHE_DIR)",
      ],
      env,
    );
    expect(bun).toEqual({
      stdout: `${profile.paths.tmp}|${profile.paths.bunCache}`,
      exitCode: 0,
    });
  });

  test.skipIf(unidentified !== undefined)(
    "the CLI, launched with it, prepares through paths with spaces and apostrophes and refuses another identity as JSON",
    async () => {
      const { base, clone, profile } = await layout();
      const storage = await prepareStorage(await validate(profile));
      const env = spawnEnvironment(storage, {
        PATH: process.env["PATH"] ?? "",
      });
      await mkdir(profile.paths.worktrees, { recursive: true });
      const lane = join(profile.paths.worktrees, "lane 'two'");
      git(clone, "worktree", "add", "-q", "--detach", lane);
      const profileFile = join(base, "the owner's profile.json");
      await writeFile(profileFile, JSON.stringify(profile));
      const cli = await run(
        [
          process.execPath,
          script,
          "--profile",
          profileFile,
          "--checkout",
          lane,
          "--prepare",
        ],
        env,
      );
      expect(cli.exitCode).toBe(0);
      expect(JSON.parse(cli.stdout)).toMatchObject({
        status: "prepared",
        paths: profile.paths,
        gitCommonDir: join(clone, ".git"),
      });

      await writeFile(
        profileFile,
        JSON.stringify({ ...profile, volume: { mountPoint, volumeUuid: "0" } }),
      );
      const refused = await run(
        [process.execPath, script, "--profile", profileFile],
        env,
      );
      expect(refused.exitCode).toBe(1);
      expect(JSON.parse(refused.stdout)).toMatchObject({
        status: "refused",
        reason: "volume-identity-mismatch",
      });
    },
  );
});

describe("SQLite on the profile's volume", () => {
  test("two processes: a held write lock outlasts the other's busy timeout, and a killed holder's write is rolled back", async () => {
    const { profile } = await layout();
    const storage = await prepareStorage(await validate(profile));
    const env = {
      ...spawnEnvironment(storage, { PATH: process.env["PATH"] ?? "" }),
      DB: join(storage.paths.state, "lock probe.sqlite"),
    };
    const holder = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const { Database } = require("bun:sqlite");
const db = new Database(process.env.DB);
db.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(v TEXT); BEGIN IMMEDIATE; INSERT INTO t VALUES ('holder');");
process.stdout.write("held\\n");
setInterval(() => {}, 1000);`,
      ],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    const contender = `const { Database } = require("bun:sqlite");
const db = new Database(process.env.DB);
db.exec("PRAGMA busy_timeout=300");
const started = performance.now();
let error = null;
try { db.exec("INSERT INTO t VALUES ('contender')"); } catch (cause) { error = cause.message; }
process.stdout.write(JSON.stringify({ error, waitedMs: Math.round(performance.now() - started),
  rows: db.query("SELECT v FROM t").all().map((row) => row.v),
  integrity: db.query("PRAGMA integrity_check").get().integrity_check,
  journal: db.query("PRAGMA journal_mode").get().journal_mode }));`;
    let blocked;
    try {
      const reader = holder.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(
        "held\n",
      );
      blocked = JSON.parse(
        (await run([process.execPath, "-e", contender], env)).stdout,
      );
    } finally {
      holder.kill("SIGKILL");
      await holder.exited;
    }
    const recovered = JSON.parse(
      (await run([process.execPath, "-e", contender], env)).stdout,
    );
    console.log(JSON.stringify({ volume: storage.volume, blocked, recovered }));

    expect(blocked.error).toBe("database is locked");
    expect(blocked.waitedMs).toBeGreaterThanOrEqual(300);
    expect(blocked.rows).toEqual([]);
    expect(recovered).toMatchObject({
      error: null,
      rows: ["contender"],
      integrity: "ok",
      journal: "wal",
    });
  });
});
