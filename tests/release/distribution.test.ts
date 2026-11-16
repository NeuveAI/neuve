import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { installManifestSchema } from "../../apps/neuve-cli/src/install-manifest.ts";
import { readInstallation } from "../../apps/neuve-cli/src/installation.ts";
import {
  agentService,
  agentUnitPaths,
} from "../../packages/records-core/src/systemd.ts";
import { systemdFixture } from "./systemd-fixture.ts";
import { writeChecksums } from "../../scripts/release/checksums.ts";

const root = resolve(import.meta.dir, "../..");
const installer =
  process.env.NEUVE_TEST_INSTALLER ?? join(root, "scripts/install.sh");
const graph = join(root, "apps/neuve-graph/entire-graph");
const available =
  !!process.env.NEUVE_RELEASE_ARCHIVE || (await Bun.file(graph).exists());
const directories = new Set<string>();
const suiteDirectories: string[] = [];
const groupCleanups = new Set<() => void>();
const installerShells: string[] = [];
const shellPaths = new Set<string>();
for (const shell of ["sh", "dash"]) {
  const executable = Bun.which(shell);
  if (!executable) continue;
  const path = await realpath(executable);
  if (!shellPaths.has(path)) installerShells.push(shell);
  shellPaths.add(path);
}
// Each shell owns separate homes, prefixes and process groups. Await both even if one fails.
const forEachInstallerShell = async (
  check: (shell: string) => Promise<void>,
) => {
  const results = await Promise.allSettled(installerShells.map(check));
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
};
// Permission cases can throw before restoring their directories. Never follow their links.
const makeDirectoriesWritable = async (path: string): Promise<void> => {
  const entry = await lstat(path).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  });
  if (!entry?.isDirectory()) return;
  await chmod(path, entry.mode | 0o700);
  for (const name of await readdir(path))
    await makeDirectoriesWritable(join(path, name));
};
const removeScratch = async (path: string) => {
  try {
    await rm(path, { recursive: true, force: true });
  } catch (error) {
    if (!(
      error instanceof Error &&
      "code" in error &&
      (error.code === "EACCES" ||
        error.code === "EPERM" ||
        error.code === "ENOTEMPTY")
    ))
      throw error;
    await makeDirectoriesWritable(path);
    await rm(path, { recursive: true, force: true });
  }
};
const temporary = async () => {
  const path = await mkdtemp(join(tmpdir(), "neuve-distribution-"));
  directories.add(path);
  return path;
};
const run = async (argv: string[], env: NodeJS.ProcessEnv, cwd = root) => {
  const started = performance.now();
  const child = Bun.spawn(argv, {
    env,
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (
    process.env.NEUVE_RELEASE_TIMINGS === "1" &&
    performance.now() - started > 1000
  )
    console.error(
      JSON.stringify({
        command: "release-child",
        executable: argv[0]?.split("/").at(-1),
        pid: child.pid,
        milliseconds: Math.round(performance.now() - started),
        code,
      }),
    );
  return { stdout, stderr, code };
};
// A new session confines group-directed test signals to this installer's descendants.
const runGroup = async (
  argv: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 60_000,
) => {
  const started = performance.now();
  const command = argv[0];
  if (!command) throw new Error("Missing group command");
  const child = spawn(command, argv.slice(1), {
    cwd: root,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (data) => {
    stdout += data;
  });
  child.stderr?.on("data", (data) => {
    stderr += data;
  });
  let closed = false;
  const stop = () => {
    if (closed || child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ESRCH"
      ))
        throw error;
    }
  };
  groupCleanups.add(stop);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeoutMs);
  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        closed = true;
        resolve(
          code ??
            (signal === "SIGHUP" ? 129 : signal === "SIGKILL" ? 137 : 143),
        );
      });
    });
    if (timedOut) throw new Error("Group command timed out");
    return { stdout, stderr, code };
  } finally {
    clearTimeout(timeout);
    stop();
    groupCleanups.delete(stop);
    if (
      process.env.NEUVE_RELEASE_TIMINGS === "1" &&
      performance.now() - started > 1000
    )
      console.error(
        JSON.stringify({
          command: "release-group",
          executable: command.split("/").at(-1),
          pid: child.pid,
          milliseconds: Math.round(performance.now() - started),
          closed,
          timedOut,
        }),
      );
  }
};
const waitForFile = async (path: string, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await Bun.file(path).exists())) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${path}`);
    await Bun.sleep(25);
  }
};
// Signal numbers and real-time signal names differ between the native shells and platforms.
const terminationSignals = async (shell: string) => {
  const listed = await run(
    [
      shell,
      "-c",
      `
i=1
while [ "$i" -le 64 ]; do
    name=$(kill -l "$i" 2>/dev/null) || name=
    case "$name" in
        ''|[0-9]*|*[!A-Z0-9+-]*|KILL|STOP|TSTP|TTIN|TTOU|CONT|CHLD|CLD|URG|WINCH|INFO) ;;
        *) printf '%s:%s\n' "$i" "$name" ;;
    esac
    i=$((i+1))
done
`,
    ],
    process.env,
  );
  expect(listed.code).toBe(0);
  const signals = listed.stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [number, label] = line.split(":");
      return {
        name: z.string().regex(/^\d+$/).parse(number),
        label: z.string().min(1).parse(label),
        code: 128 + Number(number),
      };
    });
  for (const name of [
    "HUP",
    "INT",
    "QUIT",
    "PIPE",
    "TERM",
    "ALRM",
    "USR1",
    "USR2",
  ])
    expect(signals.some((signal) => signal.label === name)).toBe(true);
  return signals;
};

const installerSignals = await Promise.all(
  installerShells.map(async (shell) => ({
    shell,
    signals: await terminationSignals(shell),
  })),
);

// Tiny executable releases isolate the shell transaction while native releases cover the CLI.
const signalRelease = async (version: string) => {
  const directory = await temporary();
  const target = `${process.platform}-${process.arch}`;
  const name = `neuve-${target}`;
  const content = join(directory, "content");
  const stage = join(content, name);
  const files = {
    "bin/neuve": `#!/bin/sh\nprintf 'neuve ${version}\\n'\n`,
    "lib/neuve/entire-graph": `#!/bin/sh\nprintf 'graph ${version}\\n'\n`,
    "lib/neuve/semantic/worker.py": `# encoder ${version}\n`,
    "lib/neuve/semantic/reranker_worker.py": `# reranker ${version}\n`,
    // Releases carry Neuve's licence among the notices, not at the top of the prefix.
    "share/neuve/notices/LICENSE": `license ${version}\n`,
  };
  for (const [path, data] of Object.entries(files)) {
    await mkdir(dirname(join(stage, path)), { recursive: true });
    await writeFile(join(stage, path), data, {
      mode:
        path === "bin/neuve" || path === "lib/neuve/entire-graph"
          ? 0o755
          : 0o644,
    });
  }
  const entry = async (path: string) => ({
    path: `@NEUVE_PREFIX@/${path}`,
    sha256: await hash(join(stage, path)),
  });
  const manifest = installManifestSchema.parse({
    schemaVersion: 1,
    installedAt: "@NEUVE_INSTALLED_AT@",
    cli: await entry("bin/neuve"),
    graph: {
      ...(await entry("lib/neuve/entire-graph")),
      version,
      workspaceRevision: null,
    },
    semantic: {
      encoder: await entry("lib/neuve/semantic/worker.py"),
      reranker: await entry("lib/neuve/semantic/reranker_worker.py"),
    },
  });
  await writeFile(
    join(stage, "lib/neuve/install.json.in"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  await writeFile(
    join(stage, "lib/neuve/release.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        version,
        target,
        repository: "NeuveAI/neuve",
        cliSha256: await hash(join(stage, "bin/neuve")),
        commit: null,
        dirty: false,
        graphRevision: null,
        files: Object.keys(files),
      },
      null,
      2,
    ) + "\n",
  );
  const archive = join(directory, `${name}.tar.gz`);
  const packed = await run(["tar", "-czf", archive, "-C", content, name], {
    ...process.env,
    COPYFILE_DISABLE: "1",
  });
  expect(packed.code, packed.stderr).toBe(0);
  await writeChecksums(directory);
  return { archive, sums: join(directory, "SHA256SUMS"), version };
};

let archive: string;
let sums: string;
let releaseVersion: string;
let nextArchive: string;
let nextSums: string;
let nextVersion: string;
const fresh = async () => {
  const directory = await temporary();
  const home = join(directory, "home");
  await mkdir(home);
  const scratch = join(directory, "scratch");
  await mkdir(scratch);
  const prefix = join(home, "release copy");
  const {
    NEUVE_GRAPH_BINARY,
    NEUVE_INSTALL_PREFIX,
    NEUVE_VERSION,
    NEUVE_DOWNLOAD_BASE,
    ...inherited
  } = process.env;
  const env: NodeJS.ProcessEnv = {
    ...inherited,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: home,
    TMPDIR: scratch,
    BUN_TMPDIR: scratch,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CONFIG_DIRS: join(home, "config-dirs"),
    XDG_DATA_DIRS: join(home, "data-dirs"),
    XDG_RUNTIME_DIR: join(home, "runtime"),
    XDG_STATE_HOME: join(home, ".local/state"),
    NEUVE_BUDGET_DIRECTORY: join(home, "budget"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    NEUVE_NO_AGENT: "1",
    NEUVE_AGENT_NO_LOAD: "1",
    ENTIRE_GRAPH_SERVICE: "off",
    SHELL: "/bin/zsh",
    ZDOTDIR: home,
    NEUVE_NO_MODIFY_PATH: "1",
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
  };
  return {
    directory,
    home,
    prefix,
    env,
    cli: join(prefix, "bin/neuve"),
    async [Symbol.asyncDispose]() {
      await removeScratch(directory);
      directories.delete(directory);
    },
  };
};
const install = (
  context: Awaited<ReturnType<typeof fresh>>,
  extra: string[] = [],
  shell = "sh",
) =>
  run(
    [
      shell,
      installer,
      "--prefix",
      context.prefix,
      "--archive",
      archive,
      "--checksums",
      sums,
      ...extra,
    ],
    context.env,
  );
const success = (result: Awaited<ReturnType<typeof run>>) =>
  expect(result, result.stdout + result.stderr).toMatchObject({ code: 0 });
const hash = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

const verifyInstall = async (
  context: Awaited<ReturnType<typeof fresh>>,
  version: string,
  abandonedStaging: string[] = [],
) => {
  const manifest = installManifestSchema.parse(
    JSON.parse(
      await readFile(join(context.prefix, "lib/neuve/install.json"), "utf8"),
    ),
  );
  for (const file of [
    manifest.cli,
    manifest.graph,
    ...Object.values(manifest.semantic ?? {}),
  ]) {
    expect(file.path.startsWith(`${await realpath(context.prefix)}/`)).toBe(
      true,
    );
    expect(await hash(file.path)).toBe(file.sha256);
  }
  expect(manifest).not.toHaveProperty("parser");
  const reported = await run([context.cli, "--version"], context.env);
  success(reported);
  expect(reported.stdout.trim()).toBe(`neuve ${version}`);
  const release = z
    .object({ version: z.string(), files: z.array(z.string()) })
    .parse(
      JSON.parse(
        await readFile(join(context.prefix, "lib/neuve/release.json"), "utf8"),
      ),
    );
  expect(release.version).toBe(version);
  expect((await readdir(context.prefix)).sort()).toEqual(
    ["bin", "lib", "share", ...abandonedStaging].sort(),
  );
  // share/neuve holds exactly the folders the release lists there (notices, skills).
  expect((await readdir(join(context.prefix, "share/neuve"))).sort()).toEqual(
    [
      ...new Set(
        release.files
          .filter((file) => file.startsWith("share/neuve/"))
          .map((file) => z.string().parse(file.split("/")[2])),
      ),
    ].sort(),
  );
};

// Compare every owned byte, including metadata and folders, after a failed replacement.
const snapshot = async (
  prefix: string,
  path = "",
): Promise<Record<string, string>> => {
  const result: Record<string, string> = {};
  for (const entry of await readdir(join(prefix, path), {
    withFileTypes: true,
  })) {
    const name = join(path, entry.name);
    const mode = (await lstat(join(prefix, name))).mode & 0o7777;
    if (entry.isSymbolicLink()) {
      result[name] = `link:${mode}:${await readlink(join(prefix, name))}`;
      const target = await stat(join(prefix, name)).catch(() => null);
      if (target?.isDirectory())
        Object.assign(result, await snapshot(prefix, name));
      else if (target?.isFile())
        result[`${name}:target`] = await hash(join(prefix, name));
    } else if (entry.isDirectory()) {
      result[name] = `directory:${mode}`;
      Object.assign(result, await snapshot(prefix, name));
    } else result[name] = `${mode}:${await hash(join(prefix, name))}`;
  }
  return result;
};

const setupRepository = async (context: Awaited<ReturnType<typeof fresh>>) => {
  const repository = join(context.directory, "repository");
  await mkdir(repository);
  for (const argv of [
    ["git", "init", "--quiet"],
    ["git", "config", "user.name", "Neuve release test"],
    ["git", "config", "user.email", "release@example.test"],
  ])
    success(await run(argv, context.env, repository));
  await writeFile(
    join(repository, "example.ts"),
    "export const answer = 42;\n",
  );
  success(await run(["git", "add", "."], context.env, repository));
  success(
    await run(
      ["git", "commit", "--quiet", "-m", "fixture"],
      context.env,
      repository,
    ),
  );
  success(await run([context.cli, "setup", "--repo", repository], context.env));
  return repository;
};

afterEach(async () => {
  for (const stop of groupCleanups) stop();
  groupCleanups.clear();
  const results = await Promise.allSettled(
    [...directories].map(async (path) => {
      await removeScratch(path);
      directories.delete(path);
    }),
  );
  for (const result of results)
    if (result.status === "rejected") throw result.reason;
}, 60_000);

afterAll(async () => {
  for (const path of suiteDirectories)
    await rm(path, { recursive: true, force: true });
}, 60_000);

test("removes a failed case's scratch home and retained installer files without following links", async () => {
  const external = await temporary();
  const sentinel = join(external, "keep");
  await writeFile(sentinel, "external bytes");
  let directory = "";
  await expect(
    (async () => {
      await using context = await fresh();
      directory = context.directory;
      const retained = join(context.env.TMPDIR ?? "", "retained-installer");
      await mkdir(retained);
      await writeFile(join(retained, "path-original"), "backup bytes");
      await symlink(external, join(context.home, "linked-parent"));
      await writeFile(join(context.home, "keep"), "scratch bytes");
      await chmod(context.home, 0o500);
      throw new Error("case failed after retaining its installer backup");
    })(),
  ).rejects.toThrow("case failed after retaining its installer backup");
  expect(await lstat(directory).catch(() => null)).toBeNull();
  expect(await readFile(sentinel, "utf8")).toBe("external bytes");
});

// A forwarded TERM can arrive after the group TERM has entered EXIT cleanup.
for (const shell of installerShells)
  test(`finishes rollback after a second TERM at cleanup entry: ${shell}`, async () => {
    const releaseA = await signalRelease("0.1.0-double.a");
    const releaseB = await signalRelease("0.1.0-double.b");
    await using context = await fresh();
    const observed = join(context.directory, "observed-install.sh");
    // Deliver the second signal at the pre-mask boundary instead of relying on scheduler luck.
    const source = await readFile(installer, "utf8");
    expect(source).toContain("    set +e\n");
    await writeFile(
      observed,
      source.replace("    set +e\n", () => '    kill -TERM "$$"\n    set +e\n'),
    );
    const wrappers = join(context.directory, "wrappers");
    const marker = join(context.directory, "interrupted");
    await mkdir(wrappers);
    await writeFile(
      join(wrappers, "mv"),
      `#!/bin/sh
/bin/mv "$@" || exit "$?"
for destination do :; done
case "$destination" in */old/lib/neuve/semantic)
    if [ ! -f "$NEUVE_FAULT_MARKER" ]; then
        : >"$NEUVE_FAULT_MARKER"
        kill -TERM -"$PPID"
    fi ;;
esac
`,
      { mode: 0o755 },
    );
    const args = (script: string, release: typeof releaseA) => [
      shell,
      script,
      "--prefix",
      context.prefix,
      "--archive",
      release.archive,
      "--checksums",
      release.sums,
    ];
    let failures = 0;
    for (let iteration = 0; iteration < 50; iteration++) {
      success(await run(args(installer, releaseA), context.env));
      const previous = await snapshot(context.prefix);
      await rm(marker, { force: true });
      const failed = await runGroup(
        args(observed, releaseB),
        {
          ...context.env,
          PATH: `${wrappers}:${context.env.PATH}`,
          NEUVE_FAULT_MARKER: marker,
        },
        15_000,
      );
      expect(await Bun.file(marker).exists()).toBe(true);
      expect(failed.code, failed.stdout + failed.stderr).toBe(143);
      if (
        JSON.stringify(await snapshot(context.prefix)) !==
        JSON.stringify(previous)
      )
        failures++;
      // Every iteration owns this scratch prefix, including an intentionally broken baseline.
      await rm(context.prefix, { recursive: true, force: true });
    }
    console.log(
      `Second TERM at cleanup entry: ${shell}: ${failures}/50 failed rollbacks`,
    );
    expect(failures).toBe(0);
  }, 300_000);

// A rollback refusal must keep the only copy of an existing startup file's old bytes.
for (const shell of installerShells)
  for (const change of ["edited", "readonly", "linked-parent"])
    test(`keeps the startup-file backup after refused rollback: ${shell}/${change}`, async () => {
      const release = await signalRelease("0.1.0-path.backup");
      await using context = await fresh();
      const rc = join(context.home, ".zshrc");
      const original = "# original startup bytes without a newline";
      await writeFile(rc, original);
      const collision = join(context.home, ".zshrc.neuve-backup.existing");
      await writeFile(collision, "keep this existing backup");
      const tmp = join(context.directory, "tmp");
      await mkdir(tmp);
      const failed = await runGroup(
        [
          shell,
          "-c",
          `
printf() {
    command printf "$@"
    case "\${2:-}" in "Added "*"/bin to PATH in "*)
        case "$NEUVE_PATH_CHANGE" in
            edited) command printf '\\n# concurrent edit\\n' >>"$HOME/.zshrc" ;;
            readonly) chmod 444 "$HOME/.zshrc" ;;
            linked-parent) mv "$HOME" "$HOME.saved"; ln -s "$HOME.saved" "$HOME" ;;
        esac
        exit 61 ;;
    esac
}
script=$1; shift; . "$script"
`,
          "path-backup",
          installer,
          "--prefix",
          context.prefix,
          "--archive",
          release.archive,
          "--checksums",
          release.sums,
        ],
        {
          ...context.env,
          TMPDIR: tmp,
          NEUVE_NO_MODIFY_PATH: "0",
          NEUVE_PATH_CHANGE: change,
        },
      );
      expect(failed.code).toBe(1);
      expect(failed.stderr).toContain(
        `Left ${rc} in place instead of undoing it.`,
      );
      const backup =
        /Its contents from before this install are kept in (.*); don't delete that file\./.exec(
          failed.stderr,
        )?.[1];
      expect(backup).toBeDefined();
      if (!backup) throw new Error(failed.stderr);
      expect(await readFile(backup, "utf8")).toBe(original);
      expect((await lstat(backup)).isSymbolicLink()).toBe(false);
      expect(await readFile(collision, "utf8")).toBe(
        "keep this existing backup",
      );
      expect(await readFile(rc, "utf8")).toContain(
        "# Added by the Neuve installer",
      );
      if (change !== "linked-parent") {
        expect(dirname(backup)).toBe(await realpath(context.home));
        expect(await readdir(tmp)).toEqual([]);
      }
      await chmod(rc, 0o644);
    }, 30_000);

// Platform refusal must happen before downloads, locks, or prefix creation.
for (const shell of installerShells)
  for (const arm64 of ["absent", "empty", "0"])
    for (const translated of ["absent", "0"])
      test(`refuses Intel Macs before writing: ${shell}/${arm64}/${translated}`, async () => {
        await using context = await fresh();
        const wrappers = join(context.directory, "platform");
        await mkdir(wrappers);
        await writeFile(
          join(wrappers, "uname"),
          '#!/bin/sh\ncase "$1" in -s) echo Darwin ;; -m) echo x86_64 ;; esac\n',
          { mode: 0o755 },
        );
        await writeFile(
          join(wrappers, "sysctl"),
          `#!/bin/sh
case "$2" in
  hw.optional.arm64) ${arm64 === "absent" ? "exit 1" : arm64 === "empty" ? "exit 0" : "echo 0"} ;;
  sysctl.proc_translated) ${translated === "absent" ? "exit 1" : "echo 0"} ;;
esac
`,
          { mode: 0o755 },
        );
        for (const command of ["curl", "wget"])
          await writeFile(
            join(wrappers, command),
            '#!/bin/sh\ntouch "$NEUVE_DOWNLOAD_MARKER"\nexit 99\n',
            { mode: 0o755 },
          );
        const before = await snapshot(context.home);
        const marker = join(context.directory, "downloaded");
        const result = await run(
          [shell, installer, "--prefix", context.prefix],
          {
            ...context.env,
            PATH: `${wrappers}:${context.env.PATH}`,
            NEUVE_DOWNLOAD_MARKER: marker,
          },
        );
        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe(
          "neuve install: There's no release for Intel Macs. Releases cover Macs with Apple silicon, Linux with glibc, and Windows through WSL.\n",
        );
        expect(await Bun.file(marker).exists()).toBe(false);
        expect(await snapshot(context.home)).toEqual(before);
      }, 4_000);

// Both hardware detection and the Rosetta flag must select the Apple silicon archive.
for (const shell of installerShells)
  for (const hardware of ["1", "absent"])
    test(`Rosetta selects darwin-arm64: ${shell}/${hardware}`, async () => {
      await using context = await fresh();
      const wrappers = join(context.directory, "platform");
      await mkdir(wrappers);
      await writeFile(
        join(wrappers, "uname"),
        '#!/bin/sh\ncase "$1" in -s) echo Darwin ;; -m) echo x86_64 ;; esac\n',
        { mode: 0o755 },
      );
      await writeFile(
        join(wrappers, "sysctl"),
        `#!/bin/sh
case "$2" in
  hw.optional.arm64) ${hardware === "1" ? "echo 1" : "exit 1"} ;;
  sysctl.proc_translated) echo 1 ;;
esac
`,
        { mode: 0o755 },
      );
      const log = join(context.directory, "download");
      // A signed-in GitHub CLI that logs what the installer asks it to download, then fails.
      await writeFile(
        join(wrappers, "gh"),
        '#!/bin/sh\ncase "$1 $2" in "auth status") exit 0 ;; "api "*) echo v0.1.0 ;; "release download") printf "%s\\n" "$@" >"$NEUVE_DOWNLOAD_LOG"; exit 1 ;; esac\n',
        { mode: 0o755 },
      );
      const result = await run([shell, installer, "--prefix", context.prefix], {
        ...context.env,
        PATH: `${wrappers}:${context.env.PATH}`,
        NEUVE_DOWNLOAD_LOG: log,
      });
      expect(result.code).not.toBe(0);
      expect(await readFile(log, "utf8")).toContain(
        "neuve-darwin-arm64.tar.gz",
      );
      expect(result.stderr).not.toContain("Intel Macs");
    }, 4_000);

/** This machine's go, which the notices step runs even when the engine is supplied. */
const hostGo = () => {
  const go = Bun.which("go");
  if (go === null)
    throw new Error("The release build needs go on PATH for its notices.");
  return go;
};
/** This machine's Go module cache, as `go env` reports it outside any scratch home. */
const hostGoModuleCache = () =>
  process.env.GOMODCACHE ||
  Bun.spawnSync(["go", "env", "GOMODCACHE"], { stdout: "pipe" })
    .stdout.toString()
    .trim();

// Ownership checks must refuse special executable entries before attempting to hash them.
test("refuses FIFO and linked CLI ownership without opening their targets", async () => {
  for (const shell of installerShells)
    for (const kind of ["fifo", "link"]) {
      await using context = await fresh();
      const lib = join(context.prefix, "lib/neuve");
      await mkdir(lib, { recursive: true });
      await mkdir(join(context.prefix, "bin"));
      await writeFile(join(lib, "install.json"), "{}\n");
      await writeFile(
        join(lib, "release.json"),
        JSON.stringify(
          {
            schemaVersion: 1,
            version: "0.1.0",
            target: `${process.platform}-${process.arch}`,
            cliSha256: "0".repeat(64),
          },
          null,
          2,
        ) + "\n",
      );
      const target = join(context.directory, "managed-cli");
      await writeFile(target, "keep bytes\n");
      if (kind === "fifo")
        success(await run(["mkfifo", context.cli], context.env));
      else await symlink(target, context.cli);
      const before = await lstat(context.cli);
      const refused = await runGroup(
        [shell, installer, "--prefix", context.prefix],
        context.env,
      );
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain(
        "This folder holds a copy built from source.",
      );
      expect((await lstat(context.cli)).ino).toBe(before.ino);
      expect(await readFile(target, "utf8")).toBe("keep bytes\n");
      expect((await readdir(context.prefix)).sort()).toEqual(["bin", "lib"]);
    }
}, 70_000);

// A cut-off curl response must never execute a partial install or change the temporary home.
test("a truncated installer piped through sh writes nothing", async () => {
  await using context = await fresh();
  const script = await readFile(installer, "utf8");
  const truncated = join(context.directory, "truncated.sh");
  await writeFile(truncated, script.slice(0, Math.floor(script.length / 2)));
  for (const shell of installerShells) {
    const result = await run(
      [
        "sh",
        "-c",
        'cat "$1" | "$2" -s -- --prefix "$3"',
        "truncated",
        truncated,
        shell,
        context.prefix,
      ],
      context.env,
    );
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("neuve install:");
    expect(await readdir(context.home)).toEqual([]);
    expect(await stat(context.prefix).catch(() => null)).toBeNull();
  }
});

// Refusals must identify whether the invalid version came from the environment or an option.
test("names NEUVE_VERSION when its value is invalid", async () => {
  await using context = await fresh();
  const result = await run(["sh", installer, "--prefix", context.prefix], {
    ...context.env,
    NEUVE_VERSION: "invalid",
  });
  expect(result.code).not.toBe(0);
  expect(result.stderr.trim()).toBe(
    "neuve install: NEUVE_VERSION must be latest or a release version such as 0.1.0-preview.1.",
  );
  const explicit = await run(
    ["sh", installer, "--prefix", context.prefix, "--version", "invalid"],
    context.env,
  );
  expect(explicit.code).not.toBe(0);
  expect(explicit.stderr.trim()).toBe(
    "neuve install: The version must be latest or a release version such as 0.1.0-preview.1.",
  );
  expect(await readdir(context.home)).toEqual([]);
});

// Failed external commands must expose their stderr before the installer's refusal.
test("shows download, tar and staged CLI errors with the install prefix", async () => {
  await using context = await fresh();
  // A signed-in GitHub CLI whose download fails with two lines of its own.
  const gh = join(context.directory, "gh-bin");
  await mkdir(gh);
  await writeFile(
    join(gh, "gh"),
    '#!/bin/sh\ncase "$1 $2" in "auth status") exit 0 ;; "api "*) echo v0.1.0 ;; "release download") echo "HTTP 404: Not Found" >&2; echo "release not found" >&2; exit 1 ;; esac\n',
    { mode: 0o755 },
  );
  const download = await run(["sh", installer, "--prefix", context.prefix], {
    ...context.env,
    PATH: `${gh}:${context.env.PATH}`,
  });
  expect(download.code).not.toBe(0);
  const downloadLines = download.stderr.trim().split("\n");
  expect(downloadLines.length).toBeGreaterThan(1);
  expect(
    downloadLines.every((line) => line.startsWith("neuve install: ")),
  ).toBe(true);
  expect(downloadLines.at(-1)).toBe(
    "neuve install: Couldn't download v0.1.0 from NeuveAI/neuve. Check the version, and that your GitHub account can read NeuveAI/neuve.",
  );
  const assets = join(context.directory, "broken-assets");
  await mkdir(assets);
  const archive = join(
    assets,
    `neuve-${process.platform}-${process.arch}.tar.gz`,
  );
  const checksums = join(assets, "SHA256SUMS");
  await writeFile(archive, "invalid archive");
  await writeChecksums(assets);
  const argv = [
    "sh",
    installer,
    "--prefix",
    context.prefix,
    "--archive",
    archive,
    "--checksums",
    checksums,
  ];
  const tar = await run(argv, context.env);
  expect(tar.code).not.toBe(0);
  const tarLines = tar.stderr.trim().split("\n");
  expect(tarLines.length).toBeGreaterThan(1);
  expect(tarLines.every((line) => line.startsWith("neuve install: "))).toBe(
    true,
  );
  expect(tarLines.at(-1)).toBe(
    "neuve install: Can't read the release archive.",
  );
  const name = `neuve-${process.platform}-${process.arch}`;
  const stage = join(context.directory, name);
  await mkdir(join(stage, "lib/neuve"), { recursive: true });
  await mkdir(join(stage, "bin"));
  await writeFile(
    join(stage, "lib/neuve/release.json"),
    JSON.stringify(
      {
        target: `${process.platform}-${process.arch}`,
        version: "0.1.0",
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(stage, "bin/neuve"),
    "#!/bin/sh\nprintf 'staged failure' >&2\nexit 42\n",
    { mode: 0o755 },
  );
  success(
    await run(["tar", "-czf", archive, "-C", context.directory, name], {
      ...context.env,
      COPYFILE_DISABLE: "1",
    }),
  );
  await writeChecksums(assets);
  const staged = await run(argv, context.env);
  expect(staged.code).not.toBe(0);
  expect(staged.stderr).toBe(
    "neuve install: staged failure\nneuve install: The downloaded neuve doesn't run on this machine, so nothing was replaced.\n",
  );
  expect(await stat(context.prefix).catch(() => null)).toBeNull();
  expect(await readdir(context.home)).toEqual([]);
});

describe.skipIf(!available)(
  "native release distribution (requires NEUVE_RELEASE_ARCHIVE or a workspace Graph engine)",
  () => {
    beforeAll(async () => {
      const directory = await mkdtemp(
        join(tmpdir(), "neuve-distribution-assets-"),
      );
      suiteDirectories.push(directory);
      await using context = await fresh();
      if (process.env.NEUVE_RELEASE_ARCHIVE)
        archive = resolve(process.env.NEUVE_RELEASE_ARCHIVE);
      else {
        success(
          await run(
            [
              process.execPath,
              join(root, "scripts/release/build.ts"),
              "--target",
              `${process.platform}-${process.arch}`,
              "--version",
              "0.1.0-test.release",
              "--out",
              directory,
              "--graph",
              graph,
            ],
            // As for B below: the notices read this machine's Go module cache with its go.
            {
              ...context.env,
              GOMODCACHE: hostGoModuleCache(),
              PATH: `${dirname(hostGo())}:${context.env.PATH}`,
            },
          ),
        );
        archive = join(
          directory,
          `neuve-${process.platform}-${process.arch}.tar.gz`,
        );
      }
      const assets = join(directory, "assets");
      await mkdir(assets);
      await copyFile(
        archive,
        join(assets, `neuve-${process.platform}-${process.arch}.tar.gz`),
      );
      await copyFile(installer, join(assets, "install.sh"));
      await writeChecksums(assets);
      sums = join(assets, "SHA256SUMS");
      const result = await run(
        [
          "tar",
          "-xOf",
          archive,
          `neuve-${process.platform}-${process.arch}/lib/neuve/release.json`,
        ],
        context.env,
      );
      success(result);
      releaseVersion = z
        .object({ version: z.string() })
        .parse(JSON.parse(result.stdout)).version;
      // Build B with A's shipped engine, including when CI supplies no workspace engine.
      const extracted = join(directory, "release-a");
      await mkdir(extracted);
      success(
        await run(["tar", "-xzf", archive, "-C", extracted], context.env),
      );
      nextVersion =
        releaseVersion === "0.1.0-test.upgrade"
          ? "0.1.0-test.upgrade.2"
          : "0.1.0-test.upgrade";
      const nextAssets = join(directory, "release-b");
      success(
        await run(
          [
            process.execPath,
            join(root, "scripts/release/build.ts"),
            "--target",
            `${process.platform}-${process.arch}`,
            "--version",
            nextVersion,
            "--out",
            nextAssets,
            "--graph",
            join(
              extracted,
              `neuve-${process.platform}-${process.arch}/lib/neuve/entire-graph`,
            ),
          ],
          // The notices copy each Go module's licence from the module cache. The scratch home has
          // none, so the build reads this machine's (only reads it).
          {
            ...context.env,
            GOMODCACHE: hostGoModuleCache(),
            PATH: `${dirname(hostGo())}:${context.env.PATH}`,
          },
        ),
      );
      await rm(extracted, { recursive: true, force: true });
      nextArchive = join(
        nextAssets,
        `neuve-${process.platform}-${process.arch}.tar.gz`,
      );
      await writeChecksums(nextAssets);
      nextSums = join(nextAssets, "SHA256SUMS");
      console.log(
        `Native release archives: A ${releaseVersion}, ${(await stat(archive)).size} bytes; B ${nextVersion}, ${(await stat(nextArchive)).size} bytes`,
      );
    }, 300_000);

    test("built archive has no oxc files or parser manifest key", async () => {
      const listing = await run(["tar", "-tzf", archive], process.env);
      success(listing);
      // The old parser's files; oxc's licence text in the notices is expected.
      expect(
        listing.stdout
          .split("\n")
          .filter(
            (member) =>
              !member.includes("/share/neuve/notices/") &&
              member.toLowerCase().includes("oxc"),
          ),
      ).toEqual([]);
      const template = await run(
        [
          "tar",
          "-xOzf",
          archive,
          `neuve-${process.platform}-${process.arch}/lib/neuve/install.json.in`,
        ],
        process.env,
      );
      success(template);
      expect(JSON.parse(template.stdout)).not.toHaveProperty("parser");
    });

    test("release engine symbol reads reuse a checked copy outside the prefix", async () => {
      await using context = await fresh();
      success(await install(context));
      const before = await snapshot(context.prefix);
      const engine = join(context.prefix, "lib/neuve/entire-graph");
      const digest = await hash(engine);
      const helper = join(context.directory, "symbols.ts");
      await writeFile(
        helper,
        `import { readGraphSymbols } from ${JSON.stringify(join(root, "packages/graph-client/src/index.ts"))};
const result = await readGraphSymbols({ executable:Bun.argv[2], temporaryParent:Bun.argv[3], files:[{path:"src/a.ts", bytes:new TextEncoder().encode("export function releaseSymbol() {}\\n")}] });
console.log(JSON.stringify({sha:result.provider.executable.sha256, symbols:result.files.get("src/a.ts")?.symbols.map(s => s.name)}));`,
      );
      const copy = join(
        context.home,
        "budget/graph/cache/executables",
        digest,
        "entire-graph",
      );
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await run(
          [
            process.execPath,
            "--no-env-file",
            helper,
            engine,
            context.directory,
          ],
          context.env,
          context.directory,
        );
        success(result);
        expect(JSON.parse(result.stdout)).toEqual({
          sha: digest,
          symbols: ["releaseSymbol"],
        });
        expect(await hash(copy)).toBe(digest);
        expect((await stat(copy)).mode & 0o777).toBe(0o500);
        if (attempt === 0)
          await writeFile(
            join(context.directory, "copy-inode"),
            String((await stat(copy)).ino),
          );
        else
          expect(String((await stat(copy)).ino)).toBe(
            await readFile(join(context.directory, "copy-inode"), "utf8"),
          );
      }
      expect(await snapshot(context.prefix)).toEqual(before);
      expect(
        (await readdir(context.directory)).filter((name) =>
          name.startsWith("neuve-graph-symbols-"),
        ),
      ).toEqual([]);
    }, 60_000);

    // KILL leaves the lock and old staging files; explicit force authorizes replacing partial payloads.
    test("completes forced retries after stale-lock removal at every KILL boundary", async () => {
      const releaseA = await signalRelease("0.1.0-kill.a");
      const releaseB = await signalRelease("0.1.0-kill.b");
      await forEachInstallerShell(async (shell) => {
        for (const upgrading of [false, true]) {
          const boundaries = [
            ...(upgrading
              ? ["old/lib/neuve/semantic", "old/share/neuve/notices"]
              : []),
            "lib/neuve/semantic",
            "share/neuve/notices",
            "lib/neuve/entire-graph",
            "bin/neuve",
            "lib/neuve/path-file",
            "lib/neuve/release.json",
            "lib/neuve/install.json",
          ];
          for (const boundary of boundaries) {
            await using context = await fresh();
            const args = (release: typeof releaseA) => [
              shell,
              installer,
              "--prefix",
              context.prefix,
              "--archive",
              release.archive,
              "--checksums",
              release.sums,
            ];
            if (upgrading) success(await run(args(releaseA), context.env));
            const wrappers = join(context.directory, "wrappers");
            await mkdir(wrappers);
            const marker = join(context.directory, "killed");
            await writeFile(
              join(wrappers, "mv"),
              `#!/bin/sh
/bin/mv "$@" || exit "$?"
for destination do :; done
case "$destination" in
    "$NEUVE_KILL_PREFIX"/.staging.*/$NEUVE_KILL_BOUNDARY|"$NEUVE_KILL_PREFIX/$NEUVE_KILL_BOUNDARY")
        : >"$NEUVE_KILL_MARKER"
        kill -KILL "$PPID" ;;
esac
`,
              { mode: 0o755 },
            );
            const killed = await runGroup(args(releaseB), {
              ...context.env,
              PATH: `${wrappers}:${context.env.PATH}`,
              NEUVE_KILL_PREFIX: context.prefix,
              NEUVE_KILL_BOUNDARY: boundary,
              NEUVE_KILL_MARKER: marker,
            });
            expect(
              killed.code,
              `${shell}/${upgrading}/${boundary}: ${killed.stdout}${killed.stderr}`,
            ).toBe(137);
            expect(await Bun.file(marker).exists()).toBe(true);
            expect(
              await readdir(join(context.prefix, ".install.lock")),
            ).toEqual([]);
            const refused = await run(args(releaseB), context.env);
            expect(refused.code).toBe(1);
            expect(refused.stderr).toContain(
              `Another install holds ${context.prefix}/.install.lock. If none is running, delete that empty folder. Then run the same command again with --force.`,
            );
            await rm(join(context.prefix, ".install.lock"), {
              recursive: true,
            });
            const abandonedStaging = (await readdir(context.prefix)).filter(
              (name) => name.startsWith(".staging."),
            );
            success(await run([...args(releaseB), "--force"], context.env));
            await verifyInstall(context, releaseB.version, abandonedStaging);
          }
        }
      });
    }, 240_000);

    // On Linux runners this uses the shipped CLI, not the source-driver fixture.
    for (const shell of installerShells)
      test.skipIf(process.platform !== "linux")(
        `native Linux release registers and uninstalls its user timer: ${shell}`,
        async () => {
          const fixture = await systemdFixture();
          await using context = await fresh();
          context.env = {
            ...context.env,
            PATH: fixture.env.PATH,
            XDG_RUNTIME_DIR: fixture.runtime,
            NEUVE_SYSTEMD_BUN: fixture.env.NEUVE_SYSTEMD_BUN,
            NEUVE_SYSTEMD_SHOW: fixture.env.NEUVE_SYSTEMD_SHOW,
            NEUVE_SYSTEMD_LOG: fixture.log,
            NEUVE_SYSTEMD_STATE: fixture.state,
            NEUVE_NO_AGENT: "0",
            NEUVE_AGENT_NO_LOAD: "0",
          };
          try {
            success(await install(context, [], shell));
            const paths = agentUnitPaths(
              context.home,
              context.env.XDG_CONFIG_HOME,
            );
            expect(await readFile(paths.service, "utf8")).toBe(
              agentService(context.cli),
            );
            const dropIn = join(
              context.directory,
              "distribution defaults $`\"\\'.conf",
            );
            await writeFile(dropIn, "[Service]\nTimeoutStopSec=30\n");
            context.env.NEUVE_SERVICE_DROPINS = JSON.stringify([dropIn]);
            const bytes = await readFile(paths.service);
            const calls = await fixture.calls();
            success(
              await install(
                context,
                ["--archive", nextArchive, "--checksums", nextSums],
                shell,
              ),
            );
            expect(await readFile(paths.service)).toEqual(bytes);
            const mutations = (lines: string[]) =>
              lines.filter((line) =>
                /^(?:daemon-reload|enable|disable|stop)(?: |$)/.test(line),
              );
            expect(mutations(await fixture.calls())).toEqual(mutations(calls));
            const timer = await readFile(paths.timer);
            context.env.NEUVE_KILL_MODE = "control-group";
            expect(
              (
                await run(
                  [context.cli, "worker", "uninstall-agent"],
                  context.env,
                )
              ).code,
            ).toBe(1);
            expect(
              (await install(context, ["--uninstall"], shell)).code,
            ).not.toBe(0);
            expect(await readFile(paths.service)).toEqual(bytes);
            expect(await readFile(paths.timer)).toEqual(timer);
            expect(await Bun.file(context.cli).exists()).toBe(true);
            expect(await Bun.file(join(fixture.state, "active")).exists()).toBe(
              true,
            );
            delete context.env.NEUVE_KILL_MODE;
            await chmod(paths.service, 0o444);
            try {
              expect(
                (
                  await run(
                    [context.cli, "worker", "uninstall-agent", "--no-load"],
                    context.env,
                  )
                ).code,
              ).toBe(1);
            } finally {
              await chmod(paths.service, 0o644);
            }
            success(await install(context, ["--uninstall"], shell));
            expect(await lstat(paths.service).catch(() => null)).toBeNull();
            expect(await lstat(paths.timer).catch(() => null)).toBeNull();
            expect(
              await lstat(join(fixture.state, "enabled")).catch(() => null),
            ).toBeNull();
          } finally {
            await fixture.close();
          }
        },
        45_000,
      );

    // The shipped CLI and native modules must recover together after CLI replacement.
    test("recovers a native A-to-B upgrade after KILL and an explicit forced retry", async () => {
      await forEachInstallerShell(async (shell) => {
        await using context = await fresh();
        success(await install(context, [], shell));
        const wrappers = join(context.directory, "wrappers");
        await mkdir(wrappers);
        await writeFile(
          join(wrappers, "mv"),
          `#!/bin/sh
/bin/mv "$@" || exit "$?"
for destination do :; done
if [ "$destination" = "$NEUVE_KILL_CLI" ]; then kill -KILL "$PPID"; fi
`,
          { mode: 0o755 },
        );
        const options = ["--archive", nextArchive, "--checksums", nextSums];
        const killed = await runGroup(
          [shell, installer, "--prefix", context.prefix, ...options],
          {
            ...context.env,
            PATH: `${wrappers}:${context.env.PATH}`,
            NEUVE_KILL_CLI: context.cli,
          },
        );
        expect(killed.code).toBe(137);
        expect(await readdir(join(context.prefix, ".install.lock"))).toEqual(
          [],
        );
        const refused = await install(context, options, shell);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain(
          "Then run the same command again with --force.",
        );
        await rm(join(context.prefix, ".install.lock"), { recursive: true });
        const abandoned = (await readdir(context.prefix)).filter((name) =>
          name.startsWith(".staging."),
        );
        success(await install(context, [...options, "--force"], shell));
        await verifyInstall(context, nextVersion, abandoned);
      });
    }, 90_000);

    // Reproduce complete handoffs inside launchctl before the older command returns.
    // Both shell orders use their own homes and an isolated manager registration.
    for (const shell of installerShells)
      for (const order of ["A-B", "B-A"])
        for (const boundary of ["print", "uninstall", "rollback"])
          test.skipIf(process.platform !== "darwin")(
            `launchd final state after handoff: ${shell}/${order}/${boundary}`,
            async () => {
              await using c = await fresh();
              const [first, last] = order.split("-");
              c.prefix = join(c.home, first!);
              c.cli = join(c.prefix, "bin/neuve");
              const other = join(c.home, last!);
              const wrappers = join(c.directory, "wrappers"),
                registered = join(c.directory, "registered"),
                marker = join(c.directory, "swapped");
              const plist = join(
                c.home,
                "Library/LaunchAgents/dev.neuve.worker.plist",
              );
              await mkdir(wrappers);
              await writeFile(
                join(wrappers, "launchctl"),
                `#!/bin/sh
case "$1" in
 print) if [ -f "$NEUVE_REGISTERED" ]; then printf 'program = %s\\n' "$(plutil -extract Program raw -o - "$NEUVE_REGISTERED" 2>/dev/null || plutil -extract ProgramArguments.0 raw -o - "$NEUVE_REGISTERED")"; result=0; else echo 'Could not find service "dev.neuve.worker" in domain for user gui: 501' >&2; result=113; fi ;;
 bootout) rm -f "$NEUVE_REGISTERED"; result=0 ;;
 bootstrap) cp "$3" "$NEUVE_REGISTERED"; result=$? ;;
 *) exit 99 ;;
esac
if { [ "\${NEUVE_ARM:-0}" = 1 ] || [ -f "$NEUVE_ARM_FILE" ]; } && [ "$1" = "$NEUVE_BOUNDARY" ] && [ ! -f "$NEUVE_MARKER" ]; then
 : >"$NEUVE_MARKER"
 rm -f "$NEUVE_PLIST" "$NEUVE_REGISTERED"
 NEUVE_ARM=0 "$NEUVE_SHELL" "$NEUVE_INSTALLER" --prefix "$NEUVE_OTHER" --archive "$NEUVE_ARCHIVE" --checksums "$NEUVE_SUMS" >"$NEUVE_MARKER.output" || exit 98
fi
exit "$result"
`,
                { mode: 0o755 },
              );
              c.env = {
                ...c.env,
                PATH: `${wrappers}:${c.env.PATH}`,
                NEUVE_NO_AGENT: "0",
                NEUVE_AGENT_NO_LOAD: "0",
                NEUVE_REGISTERED: registered,
                NEUVE_PLIST: plist,
                NEUVE_MARKER: marker,
                NEUVE_ARM_FILE: join(c.directory, "arm"),
                NEUVE_OTHER: other,
                NEUVE_ARCHIVE: archive,
                NEUVE_SUMS: sums,
                NEUVE_SHELL: shell,
                NEUVE_INSTALLER: installer,
                NEUVE_BOUNDARY: boundary === "print" ? "print" : "bootout",
              };
              success(await install(c, [], shell));
              let result;
              if (boundary === "rollback") {
                await rm(registered);
                result = await runGroup(
                  [
                    shell,
                    "-c",
                    `
printf() { command printf "$@"; case "\${2:-}" in "Installed neuve "*) : >"$NEUVE_ARM_FILE"; exit 61 ;; esac; }
script=$1; shift; . "$script"
`,
                    "rollback-handoff",
                    installer,
                    "--prefix",
                    c.prefix,
                    "--archive",
                    archive,
                    "--checksums",
                    sums,
                  ],
                  c.env,
                  90_000,
                );
              } else
                result = await install(
                  { ...c, env: { ...c.env, NEUVE_ARM: "1" } },
                  boundary === "uninstall" ? ["--uninstall"] : [],
                  shell,
                );
              expect(
                await Bun.file(marker).exists(),
                result.stdout + result.stderr,
              ).toBe(true);
              const bytes = await readFile(plist);
              expect(bytes.toString()).toContain(`${other}/bin/neuve`);
              expect(await readFile(registered)).toEqual(bytes);
              expect(await Bun.file(join(other, "bin/neuve")).exists()).toBe(
                true,
              );
              expect(result.stdout + result.stderr).toContain(
                `belongs to the neuve install in ${other}`,
              );
            },
            120_000,
          );

    // A repair receipt never authorizes rolling back a later prefix's registration.
    for (const shell of installerShells)
      for (const attempt of ["repair", "creation", "claim"])
        test.skipIf(process.platform !== "darwin")(
          `preserves the loaded launchd handoff during failed ${attempt}: ${shell}`,
          async () => {
            await using context = await fresh();
            const wrappers = join(context.directory, "wrappers");
            const registered = join(context.directory, "registered");
            const calls = join(context.directory, "calls");
            const plist = join(
              context.home,
              "Library/LaunchAgents/dev.neuve.worker.plist",
            );
            const other = join(context.home, "other prefix");
            const handoff = join(context.directory, "handoff.sh");
            const replacement = join(context.directory, "B.plist");
            await mkdir(wrappers);
            await writeFile(
              join(wrappers, "launchctl"),
              `#!/bin/sh
printf '%s\\n' "$*" >>"$NEUVE_CALLS"
case "$1" in
    print) if [ -f "$NEUVE_REGISTERED" ]; then printf 'program = %s\\n' "$(plutil -extract Program raw -o - "$NEUVE_REGISTERED" 2>/dev/null || plutil -extract ProgramArguments.0 raw -o - "$NEUVE_REGISTERED")"; else echo 'Could not find service "dev.neuve.worker" in domain for user gui: 501' >&2; exit 113; fi ;;
    bootstrap) cp "$3" "$NEUVE_REGISTERED" ;;
    bootout) rm -f "$NEUVE_REGISTERED" ;;
esac
`,
              { mode: 0o755 },
            );
            context.env = {
              ...context.env,
              PATH: `${wrappers}:${context.env.PATH}`,
              NEUVE_NO_AGENT: "0",
              NEUVE_AGENT_NO_LOAD: "0",
              NEUVE_REGISTERED: registered,
              NEUVE_CALLS: calls,
              NEUVE_PLIST: plist,
              NEUVE_OTHER: other,
              NEUVE_ARCHIVE: archive,
              NEUVE_SUMS: sums,
              NEUVE_SHELL: shell,
              NEUVE_INSTALLER: installer,
              NEUVE_HANDOFF: handoff,
              NEUVE_B_SNAPSHOT: replacement,
            };
            if (attempt === "repair") {
              success(await install(context, [], shell));
              await rm(registered);
            } else if (attempt === "claim") {
              await mkdir(dirname(plist), { recursive: true });
              await writeFile(
                plist,
                `Neuve installer claim\n${context.prefix}\n`,
              );
            }
            await writeFile(
              handoff,
              `#!/bin/sh
rm -f "$NEUVE_PLIST" "$NEUVE_REGISTERED"
"$NEUVE_SHELL" "$NEUVE_INSTALLER" --prefix "$NEUVE_OTHER" --archive "$NEUVE_ARCHIVE" --checksums "$NEUVE_SUMS" || exit 99
cp "$NEUVE_PLIST" "$NEUVE_B_SNAPSHOT"
cp "$NEUVE_CALLS" "$NEUVE_B_SNAPSHOT.calls"
`,
            );
            const failed = await runGroup(
              [
                shell,
                "-c",
                `
printf() {
    command printf "$@"
    case "\${2:-}" in 'Installed neuve '*) "$NEUVE_SHELL" "$NEUVE_HANDOFF" || exit 99; exit 61 ;; esac
}
script=$1; shift; . "$script"
`,
                "launchd-handoff",
                installer,
                "--prefix",
                context.prefix,
                "--archive",
                archive,
                "--checksums",
                sums,
              ],
              context.env,
              120_000,
            );
            expect(failed.code, failed.stdout + failed.stderr).not.toBe(0);
            const bytes = await readFile(replacement);
            expect(bytes.toString()).toContain(`${other}/bin/neuve`);
            expect(await readFile(plist)).toEqual(bytes);
            expect(await readFile(registered)).toEqual(bytes);
            expect(
              (await stat(join(context.home, "Library/Logs"))).isDirectory(),
            ).toBe(true);
            expect(await readFile(calls)).toEqual(
              await readFile(`${replacement}.calls`),
            );
            expect(failed.stderr).toContain(
              "neuve install: Left the launchd agent dev.neuve.worker in place instead of undoing it. Its plist changed since this install registered it, or the plist is no longer safe to change.\n",
            );
          },
          120_000,
        );

    // Foreign edits at final output must survive the payload and startup-file rollback too.
    for (const shell of installerShells)
      for (const existing of [false, true])
        for (const component of [
          "bin/neuve",
          "lib/neuve/release.json",
          "lib/neuve/path-file",
          "lib/neuve/semantic/worker.py",
          ".zshrc",
        ])
          test(`preserves a changed rollback destination: ${shell}/${component}/${existing ? "existing" : "new"}`, async () => {
            const release = await signalRelease("0.1.0-rollback.audit");
            await using context = await fresh();
            const destination =
              component === ".zshrc"
                ? join(context.home, component)
                : join(context.prefix, component);
            if (existing) {
              success(
                await install(
                  context,
                  ["--archive", release.archive, "--checksums", release.sums],
                  shell,
                ),
              );
              if (component === ".zshrc")
                await writeFile(destination, "# original startup bytes\n");
            }
            const bytes = "foreign bytes after installation\\n";
            const failed = await runGroup(
              [
                shell,
                "-c",
                `
printf() {
    command printf "$@"
    case "\${2:-}" in 'Installed neuve '*) command printf '%s' "$NEUVE_FOREIGN_BYTES" >"$NEUVE_DESTINATION"; exit 61 ;; esac
}
script=$1; shift; . "$script"
`,
                "rollback-handoff",
                installer,
                "--prefix",
                context.prefix,
                "--archive",
                release.archive,
                "--checksums",
                release.sums,
                // Without the agent the same version again is a no-op unless forced.
                ...(existing ? ["--force"] : []),
              ],
              {
                ...context.env,
                NEUVE_NO_MODIFY_PATH: "0",
                NEUVE_DESTINATION: destination,
                NEUVE_FOREIGN_BYTES: bytes,
              },
            );
            expect(failed.code).not.toBe(0);
            expect(await readFile(destination, "utf8")).toBe(bytes);
          }, 20_000);

    // Safety and byte checks must run again after bootout, before any restore or removal.
    for (const shell of installerShells)
      test.skipIf(process.platform !== "darwin")(
        `rechecks the launchd file at each rollback step: ${shell}`,
        async () => {
          for (const timing of ["before-rollback", "after-bootout"])
            for (const change of [
              "bytes",
              "Program",
              "Label",
              "link",
              "readonly",
              "parent-link",
              "log-link",
            ]) {
              await using context = await fresh();
              const wrappers = join(context.directory, "wrappers");
              const calls = join(context.directory, "calls");
              const registered = join(context.directory, "registered");
              const trigger = join(context.directory, "trigger");
              const mutate = join(context.directory, "mutate.sh");
              const plist = join(
                context.home,
                "Library/LaunchAgents/dev.neuve.worker.plist",
              );
              const log = join(
                context.home,
                "Library/Logs/neuve-worker-sweep.log",
              );
              const saved = join(context.directory, "changed.plist");
              const target = join(context.directory, "target");
              await mkdir(wrappers);
              await writeFile(
                join(wrappers, "launchctl"),
                `#!/bin/sh
printf '%s\\n' "$*" >>"$NEUVE_CALLS"
case "$1" in
    print) if [ -f "$NEUVE_REGISTERED" ]; then printf 'program = %s\\n' "$(plutil -extract Program raw -o - "$NEUVE_REGISTERED" 2>/dev/null || plutil -extract ProgramArguments.0 raw -o - "$NEUVE_REGISTERED")"; else echo 'Could not find service "dev.neuve.worker" in domain for user gui: 501' >&2; exit 113; fi ;;
    bootstrap) cp "$3" "$NEUVE_REGISTERED" ;;
    bootout)
        rm -f "$NEUVE_REGISTERED"
        if [ -f "$NEUVE_TRIGGER" ]; then rm "$NEUVE_TRIGGER"; "$NEUVE_SHELL" "$NEUVE_MUTATE"; fi ;;
esac
`,
                { mode: 0o755 },
              );
              const mutation = {
                bytes:
                  'command printf "\\n<!-- later same-prefix edit -->\\n" >>"$NEUVE_PLIST"',
                Program:
                  'plutil -insert Program -string /another/neuve "$NEUVE_PLIST"',
                Label:
                  'plutil -replace Label -string foreign.label "$NEUVE_PLIST"',
                link: 'cp "$NEUVE_PLIST" "$NEUVE_TARGET"; rm "$NEUVE_PLIST"; ln -s "$NEUVE_TARGET" "$NEUVE_PLIST"',
                readonly: 'chmod 444 "$NEUVE_PLIST"',
                "parent-link":
                  'mv "${NEUVE_PLIST%/*}" "$NEUVE_TARGET"; ln -s "$NEUVE_TARGET" "${NEUVE_PLIST%/*}"',
                "log-link":
                  'command printf "keep log bytes\\n" >"$NEUVE_TARGET"; ln -s "$NEUVE_TARGET" "$NEUVE_LOG"',
              };
              await writeFile(
                mutate,
                `#!/bin/sh\n${mutation[z.enum(["bytes", "Program", "Label", "link", "readonly", "parent-link", "log-link"]).parse(change)]}\ncp "$NEUVE_PLIST" "$NEUVE_SAVED"\ncp "$NEUVE_CALLS" "$NEUVE_SAVED.calls"\n`,
              );
              context.env = {
                ...context.env,
                PATH: `${wrappers}:${context.env.PATH}`,
                NEUVE_NO_AGENT: "0",
                NEUVE_AGENT_NO_LOAD: "0",
                NEUVE_SHELL: shell,
                NEUVE_PLIST: plist,
                NEUVE_LOG: log,
                NEUVE_CALLS: calls,
                NEUVE_REGISTERED: registered,
                NEUVE_TRIGGER: trigger,
                NEUVE_MUTATE: mutate,
                NEUVE_SAVED: saved,
                NEUVE_TARGET: target,
                NEUVE_TIMING: timing,
              };
              success(await install(context, [], shell));
              await rm(registered);
              try {
                const failed = await runGroup(
                  [
                    shell,
                    "-c",
                    `
printf() {
    command printf "$@"
    case "\${2:-}" in 'Installed neuve '*)
        if [ "$NEUVE_TIMING" = before-rollback ]; then "$NEUVE_SHELL" "$NEUVE_MUTATE"; else : >"$NEUVE_TRIGGER"; fi
        exit 61 ;;
    esac
}
script=$1; shift; . "$script"
`,
                    "launchd-rollback-step",
                    installer,
                    "--prefix",
                    context.prefix,
                    "--archive",
                    archive,
                    "--checksums",
                    sums,
                  ],
                  context.env,
                );
                expect(
                  failed.code,
                  `${timing}/${change}\n${failed.stdout}${failed.stderr}`,
                ).not.toBe(0);
                expect(
                  failed.stderr.match(
                    /Left the launchd agent dev.neuve.worker in place/g,
                  ),
                ).toHaveLength(1);
                expect(
                  await Bun.file(saved).exists(),
                  `${timing}/${change}\n${failed.stdout}${failed.stderr}`,
                ).toBe(true);
                expect(await readFile(plist)).toEqual(await readFile(saved));
                const previousCalls = (await readFile(`${saved}.calls`, "utf8"))
                  .trim()
                  .split("\n");
                const finalCalls = (await readFile(calls, "utf8"))
                  .trim()
                  .split("\n");
                expect(finalCalls.slice(0, previousCalls.length)).toEqual(
                  previousCalls,
                );
                expect(
                  finalCalls
                    .slice(previousCalls.length)
                    .filter((line) => !line.startsWith("print ")),
                ).toEqual(
                  timing === "after-bootout" && change === "bytes"
                    ? [`bootstrap gui/${process.getuid?.()} ${plist}`]
                    : [],
                );
                if (timing === "after-bootout" && change === "bytes") {
                  expect(await readFile(registered)).toEqual(
                    await readFile(plist),
                  );
                } else if (timing === "before-rollback")
                  expect(await readFile(registered)).not.toHaveLength(0);
                else expect(await Bun.file(registered).exists()).toBe(false);
                if (change === "link" || change === "parent-link")
                  expect(
                    (
                      await lstat(change === "link" ? plist : dirname(plist))
                    ).isSymbolicLink(),
                  ).toBe(true);
                if (change === "log-link")
                  expect(await readFile(target, "utf8")).toBe(
                    "keep log bytes\n",
                  );
              } finally {
                if (change === "readonly") await chmod(plist, 0o644);
              }
            }
        },
        300_000,
      );

    // A complete plist may survive KILL before launchd ever registers it.
    test.skipIf(process.platform !== "darwin")(
      "registers an owned full plist after KILL before bootstrap and rolls back failed repair",
      async () => {
        await forEachInstallerShell(async (shell) => {
          await using context = await fresh();
          const wrappers = join(context.directory, "wrappers");
          const registered = join(context.directory, "registered");
          const killedMarker = join(context.directory, "killed");
          const calls = join(context.directory, "calls");
          const plist = join(
            context.home,
            "Library/LaunchAgents/dev.neuve.worker.plist",
          );
          await mkdir(wrappers);
          await writeFile(
            join(wrappers, "launchctl"),
            `#!/bin/sh
printf '%s\\n' "$*" >>"$NEUVE_CALLS"
case "$1" in
    print) if [ -f "$NEUVE_REGISTERED" ]; then printf 'program = %s\\n' "$(plutil -extract Program raw -o - "$NEUVE_REGISTERED" 2>/dev/null || plutil -extract ProgramArguments.0 raw -o - "$NEUVE_REGISTERED")"; else echo 'Could not find service "dev.neuve.worker" in domain for user gui: 501' >&2; exit 113; fi ;;
    bootout)
        rm -f "$NEUVE_REGISTERED"
        if [ ! -f "$NEUVE_KILLED" ]; then
            : >"$NEUVE_KILLED"
            kill -KILL -"$NEUVE_INSTALL_GROUP"
        fi ;;
    bootstrap)
        [ "\${NEUVE_FAIL_BOOTSTRAP:-0}" != 1 ] || exit 78
        cp "$3" "$NEUVE_REGISTERED" ;;
    *) exit 1 ;;
esac
`,
            { mode: 0o755 },
          );
          context.env = {
            ...context.env,
            PATH: `${wrappers}:${context.env.PATH}`,
            NEUVE_NO_AGENT: "0",
            NEUVE_AGENT_NO_LOAD: "0",
            NEUVE_REGISTERED: registered,
            NEUVE_KILLED: killedMarker,
            NEUVE_CALLS: calls,
          };
          const killed = await runGroup(
            [
              shell,
              "-c",
              'export NEUVE_INSTALL_GROUP=$$; exec "$@"',
              "kill-agent",
              shell,
              installer,
              "--prefix",
              context.prefix,
              "--archive",
              archive,
              "--checksums",
              sums,
            ],
            context.env,
          );
          expect(killed.code).toBe(137);
          const complete = await readFile(plist);
          const executable = await run(
            [
              "plutil",
              "-extract",
              "ProgramArguments.0",
              "raw",
              "-o",
              "-",
              plist,
            ],
            context.env,
          );
          success(executable);
          expect(executable.stdout.trim()).toBe(context.cli);
          expect(await Bun.file(registered).exists()).toBe(false);
          const refused = await install(context, [], shell);
          expect(refused.code).toBe(1);
          expect(refused.stderr).toContain(
            "Then run the same command again with --force.",
          );
          await rm(join(context.prefix, ".install.lock"), { recursive: true });
          const abandoned = (await readdir(context.prefix)).filter((name) =>
            name.startsWith(".staging."),
          );
          const repaired = await install(context, ["--force"], shell);
          success(repaired);
          expect(repaired.stdout).toContain(
            "Installed the launchd agent that starts background workers at login and every 5 minutes.",
          );
          expect(await Bun.file(registered).exists()).toBe(true);
          expect(await readFile(plist)).toEqual(complete);
          expect(await readFile(calls, "utf8")).toContain(
            `print gui/${process.getuid?.()}/dev.neuve.worker`,
          );
          await verifyInstall(context, releaseVersion, abandoned);
          // A failed repair must restore both the payload and the pre-existing plist.
          await rm(registered);
          const previous = await snapshot(context.prefix);
          const failed = await install(
            { ...context, env: { ...context.env, NEUVE_FAIL_BOOTSTRAP: "1" } },
            ["--archive", nextArchive, "--checksums", nextSums],
            shell,
          );
          expect(failed.code).toBe(1);
          expect(await Bun.file(registered).exists()).toBe(false);
          expect(await readFile(plist)).toEqual(complete);
          expect(await snapshot(context.prefix)).toEqual(previous);
          success(await install(context, ["--uninstall"], shell));
          expect(await Bun.file(registered).exists()).toBe(false);
        });
      },
      120_000,
    );

    // KILL before the first payload leaves only empty folders, which need no force authorization.
    test("retries after KILL leaves empty bin and lib folders", async () => {
      const release = await signalRelease("0.1.0-empty");
      for (const shell of installerShells) {
        for (const folder of ["bin", "lib/neuve"]) {
          await using context = await fresh();
          const wrappers = join(context.directory, "wrappers");
          await mkdir(wrappers);
          await writeFile(
            join(wrappers, "mkdir"),
            `#!/bin/sh
/bin/mkdir "$@" || exit "$?"
for destination do :; done
if [ "$destination" = "$NEUVE_KILL_FOLDER" ]; then kill -KILL "$PPID"; fi
`,
            { mode: 0o755 },
          );
          const options = [
            "--archive",
            release.archive,
            "--checksums",
            release.sums,
          ];
          const killed = await runGroup(
            [shell, installer, "--prefix", context.prefix, ...options],
            {
              ...context.env,
              PATH: `${wrappers}:${context.env.PATH}`,
              NEUVE_KILL_FOLDER: join(context.prefix, folder),
            },
          );
          expect(killed.code).toBe(137);
          const refused = await install(context, options, shell);
          expect(refused.code).toBe(1);
          expect(refused.stderr).toContain(
            "Then run the same command again with --force.",
          );
          await rm(join(context.prefix, ".install.lock"), { recursive: true });
          const abandoned = (await readdir(context.prefix)).filter((name) =>
            name.startsWith(".staging."),
          );
          success(await install(context, options, shell));
          await verifyInstall(context, release.version, abandoned);
        }
      }
    }, 60_000);

    // An unreadable subtree cannot be classified as empty and must retain the foreign-file guard.
    test("refuses a foreign lib subtree that cannot be read", async () => {
      const release = await signalRelease("0.1.0-unreadable");
      for (const shell of installerShells) {
        await using context = await fresh();
        const folder = join(context.prefix, "lib/neuve/foreign");
        await mkdir(folder, { recursive: true });
        const sentinel = join(folder, "keep");
        await writeFile(sentinel, "foreign bytes");
        await chmod(folder, 0);
        try {
          const refused = await install(
            context,
            ["--archive", release.archive, "--checksums", release.sums],
            shell,
          );
          expect(refused.code).toBe(1);
          expect(refused.stderr).toContain(
            "This folder already has a bin/neuve, lib/neuve or share/neuve that this installer didn't write.",
          );
          expect(
            await lstat(join(context.prefix, ".install.lock")).catch(
              () => null,
            ),
          ).toBeNull();
        } finally {
          await chmod(folder, 0o755);
        }
        expect(await readFile(sentinel, "utf8")).toBe("foreign bytes");
      }
    }, 30_000);

    // A claim is not an installed agent. Retry must bootstrap it, and other prefixes must leave it alone.
    test.skipIf(process.platform !== "darwin")(
      "reclaims only its own killed agent claim and rolls it back on failure",
      async () => {
        for (const shell of installerShells) {
          await using context = await fresh();
          const wrappers = join(context.directory, "wrappers");
          const calls = join(context.directory, "calls");
          await mkdir(wrappers);
          await writeFile(
            join(wrappers, "launchctl"),
            `#!/bin/sh
printf '%s\\n' "$*" >>"$NEUVE_CALLS"
case "$1" in
 print) if [ -f "$NEUVE_CALLS.registered" ]; then printf 'program = %s\\n' "$(plutil -extract Program raw -o - "$NEUVE_CALLS.registered" 2>/dev/null || plutil -extract ProgramArguments.0 raw -o - "$NEUVE_CALLS.registered")"; else echo 'Could not find service "dev.neuve.worker" in domain for user gui: 501' >&2; exit 113; fi ;;
 bootstrap) [ "\${NEUVE_FAIL_BOOTSTRAP:-0}" != 1 ] || exit 61; cp "$3" "$NEUVE_CALLS.registered" ;;
 bootout) rm -f "$NEUVE_CALLS.registered" ;;
 *) exit 99 ;;
esac
`,
            { mode: 0o755 },
          );
          const env = {
            ...context.env,
            PATH: `${wrappers}:${context.env.PATH}`,
            NEUVE_NO_AGENT: "0",
            NEUVE_AGENT_NO_LOAD: "0",
            NEUVE_CALLS: calls,
          };
          const killed = await runGroup(
            [
              shell,
              "-c",
              `
printf() {
    command printf "$@"
    if [ "$1" = 'Neuve installer claim\\n%s\\n' ]; then kill -KILL "$$"; fi
}
script=$1
shift
. "$script"
`,
              "kill-claim",
              installer,
              "--prefix",
              context.prefix,
              "--archive",
              archive,
              "--checksums",
              sums,
            ],
            env,
          );
          expect(killed.code).toBe(137);
          const plist = join(
            context.home,
            "Library/LaunchAgents/dev.neuve.worker.plist",
          );
          const claim = await readFile(plist, "utf8");
          expect(claim).toBe(`Neuve installer claim\n${context.prefix}\n`);
          expect(await Bun.file(calls).exists()).toBe(false);
          const refused = await install({ ...context, env }, [], shell);
          expect(refused.code).toBe(1);
          expect(refused.stderr).toContain(
            "Then run the same command again with --force.",
          );
          const otherPrefix = join(context.home, "other release");
          const other = await install(
            { ...context, env, prefix: otherPrefix },
            [],
            shell,
          );
          success(other);
          expect(other.stdout).toContain(
            "The launchd agent runs another neuve, so the installer left it in place.",
          );
          expect(await readFile(plist, "utf8")).toBe(claim);
          expect(await Bun.file(calls).exists()).toBe(false);
          await rm(join(context.prefix, ".install.lock"), { recursive: true });
          success(await install({ ...context, env }, [], shell));
          const complete = await readFile(plist, "utf8");
          for (const text of [
            context.cli,
            "<key>Label</key>",
            "<key>RunAtLoad</key>",
            "<key>StartInterval</key>",
            "<string>sweep</string>",
          ])
            expect(complete).toContain(text);
          expect(await readFile(calls, "utf8")).toContain("bootstrap ");
          // Reclaim counts as creation for rollback, even though this attempt did not write the marker.
          await writeFile(plist, claim);
          const previous = await snapshot(context.prefix);
          const failed = await install(
            { ...context, env: { ...env, NEUVE_FAIL_BOOTSTRAP: "1" } },
            ["--archive", nextArchive, "--checksums", nextSums],
            shell,
          );
          expect(failed.code).toBe(1);
          expect(await Bun.file(plist).exists()).toBe(false);
          expect(await snapshot(context.prefix)).toEqual(previous);
          success(await install({ ...context, env }, [], shell));
          expect(await readFile(plist, "utf8")).toBe(complete);
        }
      },
      120_000,
    );

    // Ownership may change in mkdir itself, after it succeeds and before the under-lock check.
    test("uninstall refuses ownership lost during lock creation without changing the prefix", async () => {
      const release = await signalRelease("0.1.0-uninstall.race");
      for (const shell of installerShells) {
        for (const replaceCli of [false, true]) {
          await using context = await fresh();
          success(
            await install(
              context,
              ["--archive", release.archive, "--checksums", release.sums],
              shell,
            ),
          );
          const wrappers = join(context.directory, "wrappers");
          const paused = join(context.directory, "paused");
          const resume = join(context.directory, "resume");
          await mkdir(wrappers);
          await writeFile(
            join(wrappers, "mkdir"),
            `#!/bin/sh
/bin/mkdir "$@" || exit "$?"
for destination do :; done
case "$destination" in */.install.lock)
    : >"$NEUVE_FAULT_MARKER"
    while [ ! -f "$NEUVE_FAULT_RESUME" ]; do sleep 0.05; done ;;
esac
`,
            { mode: 0o755 },
          );
          const pending = runGroup(
            [shell, installer, "--prefix", context.prefix, "--uninstall"],
            {
              ...context.env,
              PATH: `${wrappers}:${context.env.PATH}`,
              NEUVE_FAULT_MARKER: paused,
              NEUVE_FAULT_RESUME: resume,
            },
          );
          try {
            await waitForFile(paused);
            await rm(join(context.prefix, "lib/neuve/release.json"));
            await rm(join(context.prefix, "lib/neuve/install.json"));
            if (replaceCli)
              await writeFile(
                context.cli,
                "#!/bin/sh\nprintf 'source copy\\n'\n",
              );
            const previous = await snapshot(context.prefix);
            delete previous[".install.lock"];
            await writeFile(resume, "");
            const refused = await pending;
            expect(refused.code).toBe(1);
            expect(refused.stderr).toContain(
              "This folder has no Neuve release, so nothing was removed.",
            );
            expect(await snapshot(context.prefix)).toEqual(previous);
          } finally {
            await writeFile(resume, "");
            await pending;
          }
        }
      }
    }, 120_000);

    // Two prefix locks cannot serialize the one plist, including a delayed failed bootstrap.
    test.skipIf(process.platform !== "darwin")(
      "keeps the first claimed agent across two-prefix races",
      async () => {
        for (const shell of installerShells) {
          for (const failDelayed of [false, true]) {
            await using delayed = await fresh();
            const first = {
              ...delayed,
              prefix: join(delayed.home, "first claimant"),
              cli: join(delayed.home, "first claimant/bin/neuve"),
            };
            const wrappers = join(delayed.directory, "wrappers");
            const paused = join(delayed.directory, "paused");
            const resume = join(delayed.directory, "resume");
            const calls = join(delayed.directory, "calls");
            const registered = join(delayed.directory, "registered");
            await mkdir(wrappers);
            await writeFile(
              join(wrappers, "mkdir"),
              `#!/bin/sh
/bin/mkdir "$@" || exit "$?"
for destination do :; done
if [ "$destination" = "$HOME/Library/Logs" ] && [ "\${NEUVE_PAUSE_AGENT:-0}" = 1 ]; then
    : >"$NEUVE_FAULT_MARKER"
    while [ ! -f "$NEUVE_FAULT_RESUME" ]; do sleep 0.05; done
fi
`,
              { mode: 0o755 },
            );
            await writeFile(
              join(wrappers, "launchctl"),
              `#!/bin/sh
printf '%s\\n' "$*" >>"$NEUVE_CALLS"
case "$1" in
    print) if [ -f "$NEUVE_REGISTERED" ]; then printf 'program = %s\\n' "$(plutil -extract Program raw -o - "$NEUVE_REGISTERED" 2>/dev/null || plutil -extract ProgramArguments.0 raw -o - "$NEUVE_REGISTERED")"; else echo 'Could not find service "dev.neuve.worker" in domain for user gui: 501' >&2; exit 113; fi ;;
    bootstrap)
        [ "\${NEUVE_FAIL_BOOTSTRAP:-0}" != 1 ] || exit 61
        cp "$3" "$NEUVE_REGISTERED" ;;
    bootout) rm -f "$NEUVE_REGISTERED" ;;
esac
`,
              { mode: 0o755 },
            );
            const env = {
              ...delayed.env,
              PATH: `${wrappers}:${delayed.env.PATH}`,
              NEUVE_NO_AGENT: "0",
              NEUVE_AGENT_NO_LOAD: "0",
              NEUVE_CALLS: calls,
              NEUVE_REGISTERED: registered,
            };
            const pending = runGroup(
              [
                shell,
                installer,
                "--prefix",
                delayed.prefix,
                "--archive",
                archive,
                "--checksums",
                sums,
              ],
              {
                ...env,
                NEUVE_PAUSE_AGENT: "1",
                NEUVE_FAULT_MARKER: paused,
                NEUVE_FAULT_RESUME: resume,
                NEUVE_FAIL_BOOTSTRAP: failDelayed ? "1" : "0",
              },
            );
            try {
              // A native install verifies and stages the archive before reaching this pause.
              // Under the full release suite that can exceed the old 15-second limit.
              await waitForFile(paused, 45_000);
              success(await install({ ...first, env }, [], shell));
              const plist = join(
                first.home,
                "Library/LaunchAgents/dev.neuve.worker.plist",
              );
              const bytes = await readFile(plist);
              const registration = await readFile(registered);
              const previousCalls = await readFile(calls);
              expect(bytes.toString()).toContain(first.cli);
              await writeFile(resume, "");
              success(await pending);
              expect(await readFile(plist)).toEqual(bytes);
              expect(await readFile(registered)).toEqual(registration);
              expect(await readFile(calls)).toEqual(previousCalls);
            } finally {
              await writeFile(resume, "");
              await pending;
            }
          }
        }
      },
      180_000,
    );

    // Exercise the owner's real source installer, including its clean-checkout guard.
    test("refuses a real source conversion during lock creation until force replaces it", async () => {
      await using context = await fresh();
      success(await install(context));
      const checkout = join(context.directory, "source");
      const sourceTar = join(context.directory, "source.tar");
      success(
        await run(
          ["git", "archive", "HEAD", "--format=tar", `--output=${sourceTar}`],
          context.env,
        ),
      );
      await mkdir(checkout);
      success(
        await run(["tar", "-xf", sourceTar, "-C", checkout], context.env),
      );
      for (const path of [
        "apps/neuve-cli/src/upgrade-cli.ts",
        "scripts/release/build.ts",
        "scripts/install.sh",
      ])
        await copyFile(join(root, path), join(checkout, path));
      await symlink(join(root, "node_modules"), join(checkout, "node_modules"));
      const workspace = z
        .object({ workspaces: z.array(z.string()) })
        .parse(await Bun.file(join(root, "package.json")).json());
      for (const pattern of workspace.workspaces) {
        for await (const manifest of new Bun.Glob(
          `${pattern}/package.json`,
        ).scan(root)) {
          const path = join(dirname(manifest), "node_modules");
          if (await lstat(join(root, path)).catch(() => null))
            await symlink(join(root, path), join(checkout, path));
        }
      }

      await mkdir(join(checkout, "apps/neuve-graph"), { recursive: true });
      await copyFile(
        join(context.prefix, "lib/neuve/entire-graph"),
        join(checkout, "apps/neuve-graph/entire-graph"),
      );
      await writeFile(
        join(checkout, ".gitignore"),
        (await readFile(join(checkout, ".gitignore"), "utf8")) +
          "\n/apps/neuve-graph/entire-graph\n",
      );
      for (const argv of [
        ["git", "init", "--quiet"],
        ["git", "add", "."],
        [
          "git",
          "-c",
          "user.name=Neuve test",
          "-c",
          "user.email=release@example.test",
          "commit",
          "--quiet",
          "-m",
          "source conversion fixture",
        ],
      ])
        success(await run(argv, context.env, checkout));
      const wrappers = join(context.directory, "wrappers");
      await mkdir(wrappers);
      await writeFile(
        join(wrappers, "mkdir"),
        `#!/bin/sh
/bin/mkdir "$@" || exit "$?"
for destination do :; done
case "$destination" in */.install.lock)
    if [ -n "\${NEUVE_FAULT_MARKER:-}" ]; then
        : >"$NEUVE_FAULT_MARKER"
        while [ ! -f "$NEUVE_FAULT_RESUME" ]; do sleep 0.05; done
    fi ;;
esac
`,
        { mode: 0o755 },
      );
      for (const shell of installerShells) {
        success(await install(context, ["--force"], shell));
        const marker = join(context.directory, `paused-${shell}`);
        const resume = join(context.directory, `resume-${shell}`);
        const pending = runGroup(
          [
            shell,
            installer,
            "--prefix",
            context.prefix,
            "--archive",
            nextArchive,
            "--checksums",
            nextSums,
          ],
          {
            ...context.env,
            PATH: `${wrappers}:${context.env.PATH}`,
            NEUVE_FAULT_MARKER: marker,
            NEUVE_FAULT_RESUME: resume,
          },
          180_000,
        );
        try {
          await waitForFile(marker);
          expect(await readdir(join(context.prefix, ".install.lock"))).toEqual(
            [],
          );
          success(
            await run(
              [
                process.execPath,
                "--no-env-file",
                "run",
                "install:cli",
                "--prefix",
                context.prefix,
              ],
              context.env,
              checkout,
            ),
          );
          const sourceCopy = await snapshot(context.prefix);
          delete sourceCopy[".install.lock"];
          await writeFile(resume, "");
          const refused = await pending;
          expect(refused.code).toBe(1);
          expect(refused.stderr).toContain(
            "This folder holds a copy built from source.",
          );
          expect(await snapshot(context.prefix)).toEqual(sourceCopy);
        } finally {
          await writeFile(resume, "");
          await pending;
        }
      }
      const source = await hash(context.cli);
      expect(source).not.toBe(
        JSON.parse(
          await readFile(
            join(context.prefix, "lib/neuve/release.json"),
            "utf8",
          ),
        ).cliSha256,
      );
      const upgrade = await run([context.cli, "upgrade"], context.env);
      expect(upgrade.code).not.toBe(0);
      expect(upgrade.stdout + upgrade.stderr).toContain(
        "This neuve was built from source.",
      );
      expect(await hash(context.cli)).toBe(source);
      const marker = join(context.prefix, "lib/neuve/release.json");
      const stale = await readFile(marker);
      await writeFile(
        marker,
        JSON.stringify(
          {
            ...JSON.parse(stale.toString()),
            cliSha256: source,
            version: "0.1.0",
          },
          null,
          2,
        ) + "\n",
      );
      const forged = await run([context.cli, "upgrade"], context.env);
      expect(forged.code).not.toBe(0);
      expect(forged.stdout + forged.stderr).toContain(
        "This neuve was built from source.",
      );
      expect(await hash(context.cli)).toBe(source);
      await writeFile(marker, stale);
      const refused = await install(context);
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain(
        "This folder holds a copy built from source.",
      );
      expect(await hash(context.cli)).toBe(source);
      success(await install(context, ["--force"]));
      await verifyInstall(context, releaseVersion);
      // A genuine source install cannot inherit an interrupted release's hash authority.
      await writeFile(
        join(wrappers, "mv"),
        `#!/bin/sh
/bin/mv "$@" || exit "$?"
for destination do :; done
if [ "$destination" = "$NEUVE_KILL_CLI" ]; then kill -KILL "$PPID"; fi
`,
        { mode: 0o755 },
      );
      await writeFile(
        join(wrappers, "mkdir"),
        `#!/bin/sh
/bin/mkdir "$@" || exit "$?"
for destination do :; done
case "$destination" in
    */.staging.*/old/share/neuve)
        if [ "\${NEUVE_KILL_SOURCE:-0}" = 1 ]; then kill -KILL "$PPID"; fi ;;
esac
`,
        { mode: 0o755 },
      );
      for (const shell of installerShells) {
        for (const previous of ["fresh", "release", "source"]) {
          await using interrupted = await fresh();
          const sourceArgs = [
            process.execPath,
            "--no-env-file",
            "run",
            "install:cli",
            "--prefix",
            interrupted.prefix,
          ];
          if (previous === "release")
            success(await install(interrupted, [], shell));
          if (previous === "source")
            success(await run(sourceArgs, interrupted.env, checkout));
          const killed = await runGroup(
            [
              shell,
              installer,
              "--prefix",
              interrupted.prefix,
              "--archive",
              nextArchive,
              "--checksums",
              nextSums,
              ...(previous === "source" ? ["--force"] : []),
            ],
            {
              ...interrupted.env,
              PATH: `${wrappers}:${interrupted.env.PATH}`,
              NEUVE_KILL_CLI: interrupted.cli,
              NEUVE_KILL_SOURCE: previous === "source" ? "1" : "0",
            },
          );
          expect(killed.code).toBe(137);
          await rm(join(interrupted.prefix, ".install.lock"), {
            recursive: true,
          });
          // Source installation refuses an interrupted CLI with no matching manifest.
          // Move those scratch entries away as advised, retaining the interrupted staging folder.
          if (previous !== "source") {
            await rename(
              interrupted.cli,
              join(interrupted.directory, "interrupted-cli"),
            );
            // B's skill files, placed before its CLI, are files the source install didn't write
            // and refuses to replace; it advises moving them away too.
            await rename(
              join(interrupted.prefix, "share/neuve/skills"),
              join(interrupted.directory, "interrupted-skills"),
            );
          }
          success(await run(sourceArgs, interrupted.env, checkout));
          const sourceCopy = await snapshot(interrupted.prefix);
          const refused = await install(
            interrupted,
            ["--archive", nextArchive, "--checksums", nextSums],
            shell,
          );
          expect(refused.code).toBe(1);
          expect(refused.stderr).toContain(
            "This folder holds a copy built from source.",
          );
          expect(await snapshot(interrupted.prefix)).toEqual(sourceCopy);
        }
      }
    }, 300_000);

    // Metadata cannot authorize a binary whose bytes or release stamp disagree with it.
    test("refuses stale, missing and tampered release ownership hashes", async () => {
      await using context = await fresh();
      success(await install(context));
      const path = join(context.prefix, "lib/neuve/release.json");
      const original = JSON.parse(await readFile(path, "utf8"));
      const cli = await hash(context.cli);
      for (const metadata of [
        { ...original, cliSha256: "0".repeat(64) },
        { ...original, cliSha256: undefined },
        { ...original, version: "0.0.0" },
      ]) {
        await writeFile(path, JSON.stringify(metadata, null, 2) + "\n");
        expect(
          (await run([context.cli, "upgrade"], context.env)).code,
        ).not.toBe(0);
        expect(await hash(context.cli)).toBe(cli);
        if (metadata.version === original.version) {
          expect((await install(context)).code).not.toBe(0);
          expect((await install(context, ["--uninstall"])).code).not.toBe(0);
          expect(await hash(context.cli)).toBe(cli);
        }
      }
      await rm(path);
      const target = join(context.directory, "managed-release.json");
      const bytes = JSON.stringify(original, null, 2) + "\n";
      await writeFile(target, bytes);
      for (const kind of ["fifo", "directory", "link"]) {
        if (kind === "fifo") success(await run(["mkfifo", path], context.env));
        if (kind === "directory") await mkdir(path);
        if (kind === "link") await symlink(target, path);
        const refused = await runGroup([context.cli, "upgrade"], context.env);
        expect(refused.code).not.toBe(0);
        expect(refused.stderr).toContain(
          "This install's release.json is invalid.",
        );
        expect(await hash(context.cli)).toBe(cli);
        expect(await readFile(target, "utf8")).toBe(bytes);
        expect((await install(context)).code).not.toBe(0);
        await rm(path, { recursive: true, force: true });
      }
      await writeFile(path, JSON.stringify(original, null, 2) + "\n");
      success(await install(context));
    }, 120_000);

    // A checksum-valid archive must also bind release ownership to the executable it ships.
    test("refuses an archive whose release hash disagrees with its CLI", async () => {
      const fixture = await signalRelease("0.1.0-tamper");
      const directory = dirname(fixture.archive);
      const name = `neuve-${process.platform}-${process.arch}`;
      const release = join(
        directory,
        "content",
        name,
        "lib/neuve/release.json",
      );
      const metadata = JSON.parse(await readFile(release, "utf8"));
      await writeFile(
        release,
        JSON.stringify({ ...metadata, cliSha256: "0".repeat(64) }, null, 2) +
          "\n",
      );
      await using context = await fresh();
      success(
        await run(
          [
            "tar",
            "-czf",
            fixture.archive,
            "-C",
            join(directory, "content"),
            name,
          ],
          { ...context.env, COPYFILE_DISABLE: "1" },
        ),
      );
      await writeChecksums(directory);
      const refused = await install(context, [
        "--archive",
        fixture.archive,
        "--checksums",
        fixture.sums,
      ]);
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain(
        "The downloaded neuve doesn't match its release.json, so nothing was replaced.",
      );
      expect(await lstat(context.prefix).catch(() => null)).toBeNull();
    });

    // The installed bytes, manifest and stable repository link must agree after replacement.
    test("installs offline, runs setup, and reinstalls without moving the CLI", async () => {
      await using context = await fresh();
      success(await install(context));
      const manifest = installManifestSchema.parse(
        JSON.parse(
          await readFile(
            join(context.prefix, "lib/neuve/install.json"),
            "utf8",
          ),
        ),
      );
      expect(manifest.installedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
      const files = [
        manifest.cli,
        manifest.graph,
        ...Object.values(manifest.semantic ?? {}),
      ];
      for (const file of files) {
        expect(file.path.startsWith(`${await realpath(context.prefix)}/`)).toBe(
          true,
        );
        expect(await hash(file.path)).toBe(file.sha256);
      }
      expect(manifest).not.toHaveProperty("parser");
      expect(
        await stat(join(context.prefix, "lib/neuve/semantic/worker.py")),
      ).toBeDefined();
      expect(
        (await run([context.cli, "--version"], context.env)).stdout.trim(),
      ).toBe(`neuve ${releaseVersion}`);
      const help = await run([context.cli, "--help"], context.env);
      success(help);
      expect(help.stdout).not.toContain("  workspace [");
      expect(await run([context.cli, "workspace"], context.env)).toEqual({
        code: 2,
        stdout: "",
        stderr: "neuve: neuve workspace isn't part of this release.\n",
      });
      const repository = join(context.directory, "repository");
      await mkdir(repository);
      for (const argv of [
        ["git", "init", "--quiet"],
        ["git", "config", "user.name", "Neuve release test"],
        ["git", "config", "user.email", "release@example.test"],
      ])
        success(await run(argv, context.env, repository));
      await writeFile(
        join(repository, "example.ts"),
        "export const answer = 42;\n",
      );
      success(await run(["git", "add", "."], context.env, repository));
      success(
        await run(
          ["git", "commit", "--quiet", "-m", "fixture"],
          context.env,
          repository,
        ),
      );
      success(
        await run([context.cli, "setup", "--repo", repository], context.env),
      );
      // Setup records this CLI by its path in the repository's store and writes nothing in the
      // working tree.
      const recorded = async () => {
        const installation = await readInstallation(repository);
        if (installation === undefined)
          throw new Error("Setup recorded nothing.");
        return installation.cliBinary;
      };
      expect(await recorded()).toBe(await realpath(context.cli));
      expect(
        await lstat(join(repository, "neuve")).catch(() => null),
      ).toBeNull();
      // Without the agent, the same version again changes nothing.
      const before = await snapshot(context.prefix);
      const same = await install(context);
      success(same);
      expect(same.stdout).toContain(
        `neuve ${releaseVersion} is already installed at ${await realpath(context.prefix)}/bin/neuve, so nothing changed. To install it again, add --force.`,
      );
      expect(await snapshot(context.prefix)).toEqual(before);
      // A forced reinstall replaces the CLI in place, so the recorded path still runs it.
      success(await install(context, ["--force"]));
      expect(await recorded()).toBe(await realpath(context.cli));
      const reported = await run([await recorded(), "--version"], context.env);
      success(reported);
      expect(reported.stdout.trim()).toBe(`neuve ${releaseVersion}`);
    }, 180_000);

    // A version change must reach the real binary, hashes and existing repository links together.
    // neuve upgrade downloads from the public release URL, which the private repository's releases
    // don't have, and the installer it runs now downloads only with a GitHub sign-in (NEU-374).
    test.skip("upgrades release A to B through file downloads and keeps repository links", async () => {
      await using context = await fresh();
      success(await install(context));
      await verifyInstall(context, releaseVersion);
      const repository = await setupRepository(context);
      const link = join(repository, "neuve/bin/neuve");
      expect(await realpath(link)).toBe(await realpath(context.cli));
      const base = join(context.directory, "downloads");
      const assets = join(base, "latest/download");
      await mkdir(assets, { recursive: true });
      await copyFile(
        nextArchive,
        join(assets, `neuve-${process.platform}-${process.arch}.tar.gz`),
      );
      await copyFile(installer, join(assets, "install.sh"));
      await writeChecksums(assets);
      success(
        await run([context.cli, "upgrade"], {
          ...context.env,
          NEUVE_DOWNLOAD_BASE: new URL(`file://${base}/`).href,
        }),
      );
      await verifyInstall(context, nextVersion);
      expect(await realpath(link)).toBe(await realpath(context.cli));
      const linked = await run([link, "--version"], context.env, repository);
      success(linked);
      expect(linked.stdout.trim()).toBe(`neuve ${nextVersion}`);
    }, 180_000);

    // The native CLI and its installer share the terminal's process group during replacement.
    // neuve upgrade downloads from the public release URL, which the private repository's releases
    // don't have, and the installer it runs now downloads only with a GitHub sign-in (NEU-374).
    test.skip("restores native release A after group TERM during upgrade and retries to B", async () => {
      await using context = await fresh();
      success(await install(context));
      const previous = await snapshot(context.prefix);
      const base = join(context.directory, "downloads");
      const assets = join(base, "latest/download");
      await mkdir(assets, { recursive: true });
      await copyFile(
        nextArchive,
        join(assets, `neuve-${process.platform}-${process.arch}.tar.gz`),
      );
      await copyFile(installer, join(assets, "install.sh"));
      await writeChecksums(assets);
      const wrappers = join(context.directory, "wrappers");
      const marker = join(context.directory, "interrupted");
      await mkdir(wrappers);
      await writeFile(
        join(wrappers, "mv"),
        `#!/bin/sh
/bin/mv "$@" || exit "$?"
for destination do :; done
case "$destination" in */old/lib/neuve/semantic)
    if [ ! -f "$NEUVE_FAULT_MARKER" ]; then
        : >"$NEUVE_FAULT_MARKER"
        kill -TERM -"$NEUVE_FAULT_GROUP"
    fi ;;
esac
`,
        { mode: 0o755 },
      );
      const env = {
        ...context.env,
        NEUVE_DOWNLOAD_BASE: new URL(`file://${base}/`).href,
      };
      const failed = await runGroup(
        [
          "sh",
          "-c",
          'export NEUVE_FAULT_GROUP=$$; exec "$@"',
          "native-upgrade",
          context.cli,
          "upgrade",
        ],
        {
          ...env,
          PATH: `${wrappers}:${context.env.PATH}`,
          NEUVE_FAULT_MARKER: marker,
        },
      );
      expect(await Bun.file(marker).exists()).toBe(true);
      expect(failed.code, failed.stdout + failed.stderr).toBe(143);
      expect(await snapshot(context.prefix)).toEqual(previous);
      await verifyInstall(context, releaseVersion);
      success(await run([context.cli, "upgrade"], env));
      await verifyInstall(context, nextVersion);
    }, 120_000);

    // A release must find its own engine through harness settings under an isolated HOME.
    test("native release resolves search.graph without an executable setting", async () => {
      await using context = await fresh();
      success(await install(context));
      const repository = await setupRepository(context);
      await writeFile(
        join(repository, "second.ts"),
        "export const second = 2;\n",
      );
      success(await run(["git", "add", "."], context.env, repository));
      success(
        await run(
          [
            "git",
            "-c",
            "core.hooksPath=/dev/null",
            "commit",
            "--quiet",
            "-m",
            "second",
          ],
          context.env,
          repository,
        ),
      );
      const settings =
        process.platform === "darwin"
          ? join(
              context.home,
              "Library/Application Support/Neuve/settings.json",
            )
          : join(context.home, ".config/neuve/settings.json");
      await mkdir(dirname(settings), { recursive: true });
      await writeFile(
        settings,
        JSON.stringify({ version: 1, search: { graph: {} } }),
      );
      const engine = join(context.prefix, "lib/neuve/entire-graph");
      const args = [
        context.cli,
        "review",
        "HEAD~1..HEAD",
        "--repo",
        repository,
        "--leads",
        "hybrid",
        "--detach",
      ];
      const result = await run(args, context.env);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("hybrid leads are not set up");
      // Breaking only the bundled executable must fail provider discovery before the hybrid refusal.
      const marker = join(context.directory, "engine-called");
      const quotedMarker = "'" + marker.replaceAll("'", "'\\''") + "'";
      await writeFile(engine, `#!/bin/sh\n: >${quotedMarker}\nexit 42\n`, {
        mode: 0o755,
      });
      const broken = await run(args, context.env);
      expect(broken.code).not.toBe(0);
      expect(broken.stderr).toContain(
        "Graph provider observation did not complete",
      );
      expect(await Bun.file(marker).exists()).toBe(true);
    }, 60_000);

    // Each boundary gets a fresh prefix. Allow 30 seconds for install, signal and retry;
    // the 12-second deadline killed a valid retry during a loaded full-suite run.
    const uninstallSteps = [
      "lib/neuve/entire-graph",
      "lib/neuve/install.json",
      "lib/neuve/path-file",
      "lib/neuve/semantic",
      "share/neuve/notices",
      "bin/neuve",
      "lib/neuve/release.json",
      "lib/neuve",
      "parents",
    ];
    for (const shell of installerShells)
      for (const signal of ["TERM", "KILL"])
        for (let step = 0; step < uninstallSteps.length; step++)
          test(`recovers uninstall interruption: ${shell}/${signal}/${uninstallSteps[step]}`, async () => {
            const release = await signalRelease("0.1.0-uninstall");
            await using context = await fresh();
            success(
              await install(
                context,
                ["--archive", release.archive, "--checksums", release.sums],
                shell,
              ),
            );
            const args = [
              shell,
              installer,
              "--prefix",
              context.prefix,
              "--uninstall",
            ];
            const delivery =
              signal === "KILL"
                ? step % 2
                  ? "group-kill"
                  : "kill"
                : step % 2
                  ? "group"
                  : "process";
            {
              const wrappers = join(context.directory, "wrappers");
              const marker = join(context.directory, "interrupted");
              await mkdir(wrappers);
              for (const command of ["rm", "rmdir"])
                await writeFile(
                  join(wrappers, command),
                  `#!/bin/sh
/bin/${command} "$@"
result=$?
for destination do :; done
if [ "$result" = 0 ] && [ "$destination" = "$NEUVE_FAULT_DESTINATION" ] && [ ! -f "$NEUVE_FAULT_MARKER" ]; then
    : >"$NEUVE_FAULT_MARKER"
    case "$NEUVE_FAULT_DELIVERY" in
        group) kill -TERM -"$PPID" ;;
        kill) kill -KILL "$PPID" ;;
        group-kill) kill -KILL -"$PPID" ;;
        *) kill -TERM "$PPID" ;;
    esac
fi
exit "$result"
`,
                  { mode: 0o755 },
                );
              const failed = await runGroup(args, {
                ...context.env,
                PATH: `${wrappers}:${context.env.PATH}`,
                NEUVE_FAULT_MARKER: marker,
                NEUVE_FAULT_DESTINATION: join(
                  context.prefix,
                  // The parents go in one rmdir, whose last folder is share.
                  uninstallSteps[step] === "parents"
                    ? "share"
                    : z.string().parse(uninstallSteps[step]),
                ),
                NEUVE_FAULT_DELIVERY: delivery,
              });
              expect(
                await Bun.file(marker).exists(),
                `${shell}/${delivery}/${uninstallSteps[step]}`,
              ).toBe(true);
              expect(failed.code, failed.stdout + failed.stderr).toBe(
                delivery === "kill" || delivery === "group-kill" ? 137 : 143,
              );
            }
            if (delivery === "kill" || delivery === "group-kill") {
              const lock = join(context.prefix, ".install.lock");
              expect(await readdir(lock)).toEqual([]);
              const refused = await run(args, context.env);
              expect(refused.code).toBe(1);
              expect(refused.stderr).toContain(
                `Another install holds ${context.prefix}/.install.lock. If none is running, delete that empty folder. Then run the same command again with --force.`,
              );
              success(await run(["rmdir", lock], context.env));
            }
            success(await run(args, context.env));
            expect(await lstat(context.prefix).catch(() => null)).toBeNull();
          }, 30_000);
    for (const shell of installerShells)
      test(`refuses uninstall of a replaced source CLI: ${shell}`, async () => {
        const release = await signalRelease("0.1.0-uninstall");
        await using source = await fresh();
        success(
          await install(
            source,
            ["--archive", release.archive, "--checksums", release.sums],
            shell,
          ),
        );
        await writeFile(source.cli, "#!/bin/sh\nprintf 'source copy\\n'\n");
        const previous = await snapshot(source.prefix);
        const refused = await run(
          [shell, installer, "--prefix", source.prefix, "--uninstall"],
          source.env,
        );
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain(
          "This folder holds a copy built from source.",
        );
        expect(await snapshot(source.prefix)).toEqual(previous);
      }, 8_000);

    // A genuine permission failure after folder replacement must restore every old component.
    test("rolls back an A to B upgrade when bin is not writable", async () => {
      await using context = await fresh();
      success(await install(context));
      const previous = await snapshot(context.prefix);
      const bin = join(context.prefix, "bin");
      await chmod(bin, 0o555);
      try {
        const failed = await install(context, [
          "--archive",
          nextArchive,
          "--checksums",
          nextSums,
        ]);
        expect(failed.code).not.toBe(0);
        expect(failed.stderr).toContain("Can't replace");
        expect(await snapshot(context.prefix)).toEqual({
          ...previous,
          bin: `directory:${0o555}`,
        });
        await verifyInstall(context, releaseVersion);
      } finally {
        await chmod(bin, 0o755);
      }
    }, 120_000);

    // Signals can arrive after a rename but before the installer executes its next statement.
    test("rolls back errors and transaction signals at each component replacement boundary under sh and dash", async () => {
      const releaseA = await signalRelease("0.1.0-signal.a");
      const releaseB = await signalRelease("0.1.0-signal.b");
      const nextArchive = releaseB.archive;
      const nextSums = releaseB.sums;
      const releaseVersion = releaseA.version;
      const nextVersion = releaseB.version;
      const installFixture = (
        context: Awaited<ReturnType<typeof fresh>>,
        extra: string[] = [],
        shell = "sh",
      ) =>
        install(
          context,
          [
            "--archive",
            releaseA.archive,
            "--checksums",
            releaseA.sums,
            ...extra,
          ],
          shell,
        );
      await forEachInstallerShell(async (shell) => {
        await using context = await fresh();
        success(await installFixture(context));
        let previous = await snapshot(context.prefix);
        const wrappers = join(context.directory, "wrappers");
        await mkdir(wrappers);
        const marker = join(context.directory, "interrupted");
        await writeFile(
          join(wrappers, "mv"),
          `#!/bin/sh
/bin/mv "$@" || exit "$?"
for destination do :; done
case "$NEUVE_FAULT_BOUNDARY:$destination" in
    folder:*/old/lib/neuve/semantic|folder:*/old/share/neuve/notices|file:*/lib/neuve/entire-graph|file:*/bin/neuve|file:*/lib/neuve/path-file|file:*/lib/neuve/release.json|file:*/lib/neuve/install.json)
        if [ "$destination" = "$NEUVE_FAULT_DESTINATION" ] || [ "$(basename "$destination")" = "$NEUVE_FAULT_DESTINATION" ]; then
            if [ ! -f "$NEUVE_FAULT_MARKER" ]; then
                : >"$NEUVE_FAULT_MARKER"
                if [ "$NEUVE_FAULT_SIGNAL" = error ]; then exit 61; fi
                kill -"$NEUVE_FAULT_SIGNAL" "$PPID"
            fi
        fi ;;
esac
`,
          { mode: 0o755 },
        );
        const boundaries = [
          { kind: "folder", name: "semantic" },
          { kind: "folder", name: "notices" },
          ...[
            "lib/neuve/entire-graph",
            "bin/neuve",
            "lib/neuve/path-file",
            "lib/neuve/release.json",
            "lib/neuve/install.json",
          ].map((name) => ({ kind: "file", name })),
        ];
        for (const signal of [
          { name: "error", label: "error", code: 1 },
          ...(await terminationSignals(shell)).filter((signal) =>
            ["HUP", "TERM"].includes(signal.label),
          ),
        ]) {
          for (const boundary of boundaries) {
            await rm(marker, { force: true });
            const failed = await installFixture(
              {
                ...context,
                env: {
                  ...context.env,
                  PATH: `${wrappers}:${context.env.PATH}`,
                  NEUVE_FAULT_BOUNDARY: boundary.kind,
                  NEUVE_FAULT_DESTINATION:
                    boundary.kind === "folder"
                      ? boundary.name
                      : join(context.prefix, boundary.name),
                  NEUVE_FAULT_MARKER: marker,
                  NEUVE_FAULT_SIGNAL: signal.name,
                },
              },
              ["--archive", nextArchive, "--checksums", nextSums],
              shell,
            );
            expect(
              await Bun.file(marker).exists(),
              `${shell}: ${signal.label} at ${boundary.name}`,
            ).toBe(true);
            expect(failed.code, failed.stdout + failed.stderr).toBe(
              signal.code,
            );
            expect(await snapshot(context.prefix)).toEqual(previous);
            await verifyInstall(context, releaseVersion);
            success(
              await installFixture(
                context,
                ["--archive", nextArchive, "--checksums", nextSums],
                shell,
              ),
            );
            await verifyInstall(context, nextVersion);
            // The installer never replaces B with the older A, so A returns after an uninstall.
            success(await install(context, ["--uninstall"], shell));
            success(await installFixture(context, [], shell));
            await verifyInstall(context, releaseVersion);
            previous = await snapshot(context.prefix);
          }
        }
      });
    }, 1_200_000);

    // Failed diagnostic writes must either finish or take the same rollback path as an explicit PIPE.
    test("cleans up with closed output descriptors and a broken output pipe", async () => {
      for (const shell of installerShells) {
        await using closed = await fresh();
        const result = await run(
          [
            shell,
            "-c",
            'exec 1>&- 2>&-; exec "$@"',
            "closed-output",
            shell,
            installer,
            "--prefix",
            closed.prefix,
            "--archive",
            archive,
            "--checksums",
            sums,
          ],
          closed.env,
        );
        success(result);
        await verifyInstall(closed, releaseVersion);
        await using broken = await fresh();
        const fifo = join(broken.directory, "output-pipe");
        success(await run(["mkfifo", fifo], broken.env));
        const failed = await run(
          [
            shell,
            "-c",
            `
pipe=$1
shift
head -n 0 <"$pipe" &
reader=$!
"$@" >"$pipe"
result=$?
wait "$reader"
exit "$result"
`,
            "broken-pipe",
            fifo,
            shell,
            installer,
            "--prefix",
            broken.prefix,
            "--archive",
            archive,
            "--checksums",
            sums,
          ],
          broken.env,
        );
        expect(failed.code, `${shell}\n${failed.stdout}${failed.stderr}`).toBe(
          141,
        );
        expect(await lstat(broken.prefix).catch(() => null)).toBeNull();
        success(await install(broken, [], shell));
        await verifyInstall(broken, releaseVersion);
      }
    }, 120_000);

    // Deferring PIPE out of printf must also undo a PIPE delivered during payload placement.
    test("restores the previous bytes after PIPE at CLI replacement", async () => {
      const releaseA = await signalRelease("0.1.0-pipe.a");
      const releaseB = await signalRelease("0.1.0-pipe.b");
      for (const shell of installerShells)
        for (const upgrading of [false, true]) {
          await using context = await fresh();
          if (upgrading)
            success(
              await install(
                context,
                ["--archive", releaseA.archive, "--checksums", releaseA.sums],
                shell,
              ),
            );
          const before = await snapshot(context.home);
          const wrappers = join(context.directory, "wrappers");
          await mkdir(wrappers);
          await writeFile(
            join(wrappers, "mv"),
            `#!/bin/sh
/bin/mv "$@" || exit "$?"
for destination do :; done
if [ "$destination" = "$NEUVE_FAULT_CLI" ] && [ ! -f "$NEUVE_FAULT_MARKER" ]; then
    : >"$NEUVE_FAULT_MARKER"
    kill -PIPE "$PPID"
fi
`,
            { mode: 0o755 },
          );
          const failed = await install(
            {
              ...context,
              env: {
                ...context.env,
                PATH: `${wrappers}:${context.env.PATH}`,
                NEUVE_FAULT_CLI: context.cli,
                NEUVE_FAULT_MARKER: join(context.directory, "pipe"),
              },
            },
            ["--archive", releaseB.archive, "--checksums", releaseB.sums],
            shell,
          );
          expect(
            failed.code,
            `${shell}/${upgrading}\n${failed.stdout}${failed.stderr}`,
          ).toBe(141);
          expect(await snapshot(context.home)).toEqual(before);
        }
    }, 30_000);

    // A fresh transaction owns only the folders it created, and failure must allow a plain retry.
    test("retries a fresh install after TERM at the first CLI replacement", async () => {
      for (const shell of installerShells) {
        for (const existing of [false, true]) {
          await using context = await fresh();
          if (existing) {
            await mkdir(join(context.prefix, "bin"), { recursive: true });
            await mkdir(join(context.prefix, "lib"));
            await writeFile(join(context.prefix, "bin/unrelated"), "keep");
            await writeFile(join(context.prefix, "lib/unrelated"), "keep");
          }
          const previous = await snapshot(context.home);
          const wrappers = join(context.directory, "wrappers");
          const marker = join(context.directory, "interrupted");
          await mkdir(wrappers);
          await writeFile(
            join(wrappers, "mv"),
            `#!/bin/sh
/bin/mv "$@" || exit "$?"
for destination do :; done
if [ "$destination" = "$NEUVE_FAULT_CLI" ] && [ ! -f "$NEUVE_FAULT_MARKER" ]; then
    : >"$NEUVE_FAULT_MARKER"
    kill -TERM "$PPID"
fi
`,
            { mode: 0o755 },
          );
          const failed = await install(
            {
              ...context,
              env: {
                ...context.env,
                PATH: `${wrappers}:${context.env.PATH}`,
                NEUVE_FAULT_CLI: context.cli,
                NEUVE_FAULT_MARKER: marker,
              },
            },
            [],
            shell,
          );
          expect(await Bun.file(marker).exists()).toBe(true);
          expect(failed.code, failed.stdout + failed.stderr).toBe(143);
          expect(await snapshot(context.home)).toEqual(previous);
          success(await install(context, [], shell));
          await verifyInstall(context, releaseVersion);
        }
      }
    }, 180_000);

    // Each creation boundary and platform signal gets an independent deadline.
    for (const { shell, signals } of installerSignals)
      for (const signal of signals)
        for (const operation of [
          ...(signal.label === "TERM"
            ? ["install", "uninstall", "empty-uninstall"]
            : []),
          "staging",
        ])
          test(`cleans signals during creation: ${shell}/${signal.label}/${operation}`, async () => {
            const releaseA = await signalRelease("0.1.0-signal.lock");
            const installFixture = (
              context: Awaited<ReturnType<typeof fresh>>,
              extra: string[] = [],
              shell = "sh",
            ) =>
              install(
                context,
                [
                  "--archive",
                  releaseA.archive,
                  "--checksums",
                  releaseA.sums,
                  ...extra,
                ],
                shell,
              );
            await using context = await fresh();
            if (operation === "uninstall")
              success(await installFixture(context));
            if (operation === "empty-uninstall") await mkdir(context.prefix);
            const options =
              operation === "empty-uninstall"
                ? ["--uninstall", "--force"]
                : operation === "uninstall"
                  ? ["--uninstall"]
                  : [];
            const previous = await snapshot(context.home);
            const wrappers = join(context.directory, "wrappers");
            const marker = join(context.directory, "interrupted");
            await mkdir(wrappers);
            await writeFile(
              join(wrappers, "mkdir"),
              `#!/bin/sh
/bin/mkdir "$@" || exit "$?"
for destination do :; done
case "$NEUVE_FAULT_DIRECTORY:$destination" in lock:*/.install.lock|staging:*/.staging.*)
    : >"$NEUVE_FAULT_MARKER"
    kill -"$NEUVE_FAULT_SIGNAL" "$PPID" ;;
esac
`,
              { mode: 0o755 },
            );
            const failed = await installFixture(
              {
                ...context,
                env: {
                  ...context.env,
                  PATH: `${wrappers}:${context.env.PATH}`,
                  NEUVE_FAULT_MARKER: marker,
                  NEUVE_FAULT_SIGNAL: signal.name,
                  NEUVE_FAULT_DIRECTORY:
                    operation === "staging" ? "staging" : "lock",
                },
              },
              options,
              shell,
            );
            expect(await Bun.file(marker).exists()).toBe(true);
            expect(failed.code, failed.stdout + failed.stderr).toBe(
              signal.code,
            );
            expect(await snapshot(context.home)).toEqual(previous);
            success(await installFixture(context, options, shell));
          }, 12_000);

    // A terminal signal also reaches the mkdir/mv child before ownership bookkeeping returns.
    test("restores state and retries after handled group signals at lock, staging and replacement boundaries", async () => {
      const releaseA = await signalRelease("0.1.0-group.a");
      const releaseB = await signalRelease("0.1.0-group.b");
      await forEachInstallerShell(async (shell) => {
        for (const signal of [
          { name: "HUP", code: 129 },
          { name: "INT", code: 130 },
          { name: "QUIT", code: 131 },
          { name: "PIPE", code: 141 },
          { name: "TERM", code: 143 },
        ]) {
          for (const operation of ["install", "upgrade", "uninstall"]) {
            for (const boundary of operation === "uninstall"
              ? ["lock"]
              : operation === "install"
                ? ["lock", "staging", "folder-install", "file"]
                : [
                    "lock",
                    "staging",
                    "folder-backup",
                    "folder-install",
                    "copy",
                    "file",
                  ]) {
              await using context = await fresh();
              const args = (release: typeof releaseA, extra: string[] = []) => [
                shell,
                installer,
                "--prefix",
                context.prefix,
                "--archive",
                release.archive,
                "--checksums",
                release.sums,
                ...extra,
              ];
              if (operation !== "install")
                success(await run(args(releaseA), context.env));
              const previous = await snapshot(context.home);
              const wrappers = join(context.directory, "wrappers");
              const marker = join(context.directory, "interrupted");
              await mkdir(wrappers);
              for (const command of ["mkdir", "mv", "cp"])
                await writeFile(
                  join(wrappers, command),
                  `#!/bin/sh
/bin/${command} "$@" || exit "$?"
for destination do :; done
case "$NEUVE_FAULT_BOUNDARY:$destination" in
    lock:*/.install.lock|staging:*/.staging.*|folder-backup:*/old/lib/neuve/semantic|folder-install:*/release\\ copy/lib/neuve/semantic|copy:*/old/bin/neuve|file:*/release\\ copy/bin/neuve)
        if [ ! -f "$NEUVE_FAULT_MARKER" ]; then
            : >"$NEUVE_FAULT_MARKER"
            kill -"$NEUVE_FAULT_SIGNAL" -"$PPID"
        fi ;;
esac
`,
                  { mode: 0o755 },
                );
              const options = operation === "uninstall" ? ["--uninstall"] : [];
              const failed = await runGroup(args(releaseB, options), {
                ...context.env,
                PATH: `${wrappers}:${context.env.PATH}`,
                NEUVE_FAULT_MARKER: marker,
                NEUVE_FAULT_BOUNDARY: boundary,
                NEUVE_FAULT_SIGNAL: signal.name,
              });
              expect(
                await Bun.file(marker).exists(),
                `${shell}/${signal.name}/${operation}/${boundary}`,
              ).toBe(true);
              expect(failed.code, failed.stdout + failed.stderr).toBe(
                signal.code,
              );
              expect(await snapshot(context.home)).toEqual(previous);
              success(await run(args(releaseB, options), context.env));
            }
          }
        }
      });
    }, 600_000);

    // A group signal after failed exclusive creation must never acquire or remove another lock.
    test("preserves another installer's lock when failed mkdir receives a group signal", async () => {
      const release = await signalRelease("0.1.0-held-lock");
      for (const shell of installerShells) {
        await using context = await fresh();
        const lock = join(context.prefix, ".install.lock");
        await mkdir(context.prefix, { recursive: true });
        const marker = join(context.directory, "contender-lock");
        const resume = join(context.directory, "resume");
        const wrappers = join(context.directory, "wrappers");
        await mkdir(wrappers);
        await writeFile(
          join(wrappers, "mkdir"),
          `#!/bin/sh
for destination do :; done
case "$destination" in */.install.lock)
    /bin/mkdir "$destination" || exit "$?"
    : >"$NEUVE_FAULT_MARKER"
    while [ ! -f "$NEUVE_FAULT_RESUME" ]; do sleep 0.05; done ;;
esac
/bin/mkdir "$@"
result=$?
case "$destination" in */.install.lock) kill -TERM -"$PPID" ;; esac
exit "$result"
`,
          { mode: 0o755 },
        );
        const pending = runGroup(
          [
            shell,
            installer,
            "--prefix",
            context.prefix,
            "--archive",
            release.archive,
            "--checksums",
            release.sums,
          ],
          {
            ...context.env,
            PATH: `${wrappers}:${context.env.PATH}`,
            NEUVE_FAULT_MARKER: marker,
            NEUVE_FAULT_RESUME: resume,
          },
        );
        try {
          await waitForFile(marker);
          const before = await lstat(lock);
          await writeFile(resume, "");
          const failed = await pending;
          expect(failed.code).toBe(143);
          expect((await lstat(lock)).ino).toBe(before.ino);
          expect(await readdir(context.prefix)).toEqual([".install.lock"]);
        } finally {
          await writeFile(resume, "");
          await pending;
        }
        await rm(lock, { recursive: true });
        success(
          await install(
            context,
            ["--archive", release.archive, "--checksums", release.sums],
            shell,
          ),
        );
      }
    }, 60_000);

    // An absent lock after failed creation is an I/O error, not evidence of another installer.
    test("reports lock creation errors without claiming contention", async () => {
      const release = await signalRelease("0.1.0-lock-error");
      for (const shell of installerShells) {
        for (const failure of process.getuid?.() === 0
          ? ["command"]
          : ["command", "permission"]) {
          await using context = await fresh();
          await mkdir(context.prefix);
          const wrappers = join(context.directory, "wrappers");
          await mkdir(wrappers);
          await writeFile(
            join(wrappers, "mkdir"),
            `#!/bin/sh
for destination do :; done
case "$destination" in */.install.lock) exit 1 ;; esac
exec /bin/mkdir "$@"
`,
            { mode: 0o755 },
          );
          if (failure === "permission") await chmod(context.prefix, 0o500);
          try {
            const refused = await install(
              {
                ...context,
                env:
                  failure === "command"
                    ? {
                        ...context.env,
                        PATH: `${wrappers}:${context.env.PATH}`,
                      }
                    : context.env,
              },
              ["--archive", release.archive, "--checksums", release.sums],
              shell,
            );
            expect(refused.code).toBe(1);
            expect(refused.stderr).toBe(
              `neuve install: Can't create ${context.prefix}/.install.lock. Check that you can write to its parent folder.\n`,
            );
            expect(await readdir(context.prefix)).toEqual([]);
          } finally {
            await chmod(context.prefix, 0o755);
          }
          success(
            await install(
              context,
              ["--archive", release.archive, "--checksums", release.sums],
              shell,
            ),
          );
        }
      }
    }, 60_000);

    // A command's surviving background descendant must not hold the installer in cleanup.
    test("exits while a wrapped command's background child remains alive", async () => {
      const release = await signalRelease("0.1.0-background");
      for (const shell of installerShells) {
        await using context = await fresh();
        const wrappers = join(context.directory, "wrappers");
        const childPid = join(context.directory, "child-pid");
        await mkdir(wrappers);
        await writeFile(
          join(wrappers, "mv"),
          `#!/bin/sh
/bin/mv "$@" || exit "$?"
if [ ! -f "$NEUVE_CHILD_PID" ]; then
    sleep 90 </dev/null >/dev/null 2>&1 &
    printf '%s\n' "$!" >"$NEUVE_CHILD_PID"
fi
`,
          { mode: 0o755 },
        );
        try {
          success(
            await runGroup(
              [
                shell,
                installer,
                "--prefix",
                context.prefix,
                "--archive",
                release.archive,
                "--checksums",
                release.sums,
              ],
              {
                ...context.env,
                PATH: `${wrappers}:${context.env.PATH}`,
                NEUVE_CHILD_PID: childPid,
              },
              15_000,
            ),
          );
          const pid = z.coerce
            .number()
            .int()
            .positive()
            .parse((await readFile(childPid, "utf8")).trim());
          process.kill(pid, 0);
          await verifyInstall(context, release.version);
          // Forced, so the same version runs the whole install again instead of a no-op.
          success(
            await install(
              context,
              [
                "--archive",
                release.archive,
                "--checksums",
                release.sums,
                "--force",
              ],
              shell,
            ),
          );
        } finally {
          const recorded = await readFile(childPid, "utf8").catch(() => null);
          if (recorded !== null) {
            const pid = z.coerce
              .number()
              .int()
              .positive()
              .parse(recorded.trim());
            try {
              process.kill(pid, "SIGKILL");
            } catch (error) {
              if (!(
                error instanceof Error &&
                "code" in error &&
                error.code === "ESRCH"
              ))
                throw error;
            }
          }
        }
      }
    }, 45_000);

    // Exclusion must last through rollback, including after a group TERM reaches every child.
    test("refuses a competing install during group TERM rollback and restores A", async () => {
      const releaseA = await signalRelease("0.1.0-rollback.a");
      const releaseB = await signalRelease("0.1.0-rollback.b");
      const releaseC = await signalRelease("0.1.0-rollback.c");
      for (const shell of installerShells) {
        await using context = await fresh();
        const args = (release: typeof releaseA) => [
          shell,
          installer,
          "--prefix",
          context.prefix,
          "--archive",
          release.archive,
          "--checksums",
          release.sums,
        ];
        success(await run(args(releaseA), context.env));
        const previous = await snapshot(context.prefix);
        const wrappers = join(context.directory, "wrappers");
        const paused = join(context.directory, "paused");
        const resume = join(context.directory, "resume");
        await mkdir(wrappers);
        await writeFile(
          join(wrappers, "mv"),
          `#!/bin/sh
restoring=0
for argument do
    case "$argument" in */old/lib/neuve/semantic) restoring=1 ;; esac
done
if [ "$restoring" = 1 ]; then
    : >"$NEUVE_ROLLBACK_PAUSED"
    while [ ! -f "$NEUVE_ROLLBACK_RESUME" ]; do sleep 0.05; done
fi
/bin/mv "$@" || exit "$?"
for destination do :; done
case "$destination" in */lib/neuve/entire-graph)
    if [ ! -f "$NEUVE_FAULT_MARKER" ]; then
        : >"$NEUVE_FAULT_MARKER"
        kill -TERM -"$PPID"
    fi ;;
esac
`,
          { mode: 0o755 },
        );
        const interrupted = runGroup(args(releaseB), {
          ...context.env,
          PATH: `${wrappers}:${context.env.PATH}`,
          NEUVE_FAULT_MARKER: join(context.directory, "interrupted"),
          NEUVE_ROLLBACK_PAUSED: paused,
          NEUVE_ROLLBACK_RESUME: resume,
        });
        try {
          await waitForFile(paused);
          expect(await readdir(join(context.prefix, ".install.lock"))).toEqual(
            [],
          );
          const refused = await run(args(releaseC), context.env);
          expect(refused.code).toBe(1);
          expect(refused.stderr).toContain(
            `Another install holds ${context.prefix}/.install.lock. If none is running, delete that empty folder. Then run the same command again with --force.`,
          );
          await writeFile(resume, "");
          const failed = await interrupted;
          expect(failed.code, failed.stdout + failed.stderr).toBe(143);
          expect(await snapshot(context.prefix)).toEqual(previous);
          await verifyInstall(context, releaseA.version);
          success(await run(args(releaseB), context.env));
          await verifyInstall(context, releaseB.version);
        } finally {
          await writeFile(resume, "");
          await interrupted;
        }
      }
    }, 120_000);

    // A failure after writing PATH must restore exact bytes and the previous multi-shell record.
    test("restores the startup file and PATH record after a real PATH edit fails", async () => {
      for (const shell of installerShells) {
        await using context = await fresh();
        success(
          await install({
            ...context,
            env: {
              ...context.env,
              SHELL: "/bin/bash",
              NEUVE_NO_MODIFY_PATH: "0",
            },
          }),
        );
        const rc = join(context.home, ".zshrc");
        const original = Buffer.from(
          "# existing startup file\nexport EXAMPLE=keep",
        );
        await writeFile(rc, original);
        const previous = await snapshot(context.prefix);
        const failed = await run(
          [
            shell,
            "-c",
            `
printf() {
    command printf "$@"
    case "\${2:-}" in "Added "*"/bin to PATH in "*) exit 61 ;; esac
}
script=$1
shift
. "$script"
`,
            "path-fault",
            installer,
            "--prefix",
            context.prefix,
            "--archive",
            nextArchive,
            "--checksums",
            nextSums,
          ],
          {
            ...context.env,
            NEUVE_NO_MODIFY_PATH: "0",
          },
        );
        expect(failed.stdout).toContain(
          `Added ${context.prefix}/bin to PATH in ${rc}.`,
        );
        expect(failed.code).toBe(61);
        expect(await readFile(rc)).toEqual(original);
        expect(await snapshot(context.prefix)).toEqual(previous);
        await verifyInstall(context, releaseVersion);
      }
    }, 120_000);

    // Every optional-file kind must preserve the pre-existing entry and any linked target.
    test("preserves external files through install, failed install, upgrade and uninstall under sh and dash", async () => {
      const kinds = [
        "absent",
        "file",
        "readonly-file",
        "link",
        "dangling",
        "directory",
        "fifo",
      ];
      const scenarios = installerShells.flatMap((shell) =>
        ["zsh", "bash", "fish"].flatMap((loginShell) =>
          kinds.map((kind) => ({ shell, loginShell, kind })),
        ),
      );
      // Independent homes and prefixes keep the complete matrix while bounding disk concurrency.
      const batchSize = 4;
      const completed: typeof scenarios = [];
      const started = performance.now();
      for (let offset = 0; offset < scenarios.length; offset += batchSize) {
        const cases = await Promise.allSettled(
          scenarios
            .slice(offset, offset + batchSize)
            .map(async ({ shell, loginShell, kind }) => {
              await using context = await fresh();
              context.env = {
                ...context.env,
                SHELL: `/bin/${loginShell}`,
                NEUVE_NO_MODIFY_PATH: "0",
                NEUVE_NO_AGENT: "0",
              };
              const selected =
                loginShell === "zsh"
                  ? ".zshrc"
                  : loginShell === "fish"
                    ? ".config/fish/conf.d/neuve.fish"
                    : process.platform === "darwin"
                      ? ".bash_profile"
                      : ".bashrc";
              const paths = [
                ".zshrc",
                ".bashrc",
                ".bash_profile",
                ".config/fish/conf.d/neuve.fish",
                ...(process.platform === "darwin"
                  ? ["Library/LaunchAgents/dev.neuve.worker.plist"]
                  : [
                      ".config/systemd/user/dev.neuve.worker.service",
                      ".config/systemd/user/dev.neuve.worker.timer",
                    ]),
              ];
              const original = "# managed configuration\nexport EXAMPLE=keep\n";
              const entries: { path: string; target: string }[] = [];
              const entryState = async (path: string, includeInode = true) => {
                const entry = await lstat(path).catch(() => null);
                if (entry === null) return null;
                return {
                  ino: includeInode ? entry.ino : undefined,
                  mode: entry.mode,
                  data: entry.isSymbolicLink()
                    ? await readlink(path)
                    : entry.isFile()
                      ? await readFile(path, "utf8")
                      : entry.isDirectory()
                        ? await snapshot(path)
                        : "special",
                };
              };
              const makeEntry = async (
                path: string,
                contents: string,
                target = `${path}.managed`,
              ) => {
                await mkdir(dirname(path), { recursive: true });
                if (kind === "file" || kind === "readonly-file") {
                  await writeFile(path, contents);
                  if (kind === "readonly-file") await chmod(path, 0o444);
                }
                if (kind === "link" || kind === "dangling") {
                  if (kind === "link") await writeFile(target, contents);
                  await symlink(target, path);
                }
                if (kind === "directory") {
                  await mkdir(path);
                  await writeFile(join(path, "keep"), original);
                }
                if (kind === "fifo")
                  success(await run(["mkfifo", path], context.env));
                return { path, target };
              };
              for (const path of paths)
                entries.push(
                  await makeEntry(
                    join(context.home, path),
                    path.endsWith(".plist") && kind === "link"
                      ? `<key>ProgramArguments</key>\n<array>\n<string>${context.cli}</string>\n</array>\n`
                      : original,
                  ),
                );
              const states = await Promise.all(
                entries.map(async (entry) => ({
                  entry: await entryState(entry.path),
                  target: await entryState(entry.target),
                })),
              );
              const assertExternal = async (
                phase: "failed" | "installed" | "removed",
              ) => {
                for (let index = 0; index < entries.length; index++) {
                  const entry = entries[index];
                  const before = states[index];
                  if (!entry || !before)
                    throw new Error("Missing matrix fixture");
                  const after = await entryState(entry.path);
                  expect(
                    await entryState(entry.target),
                    `${shell}/${loginShell}/${kind}/${phase}: target`,
                  ).toEqual(before.target);
                  if (
                    kind === "file" &&
                    entry.path === join(context.home, selected) &&
                    phase !== "failed"
                  ) {
                    expect(after?.ino).toBe(before.entry?.ino);
                    expect(after?.mode).toBe(before.entry?.mode);
                    const data = await readFile(entry.path, "utf8");
                    expect(data.startsWith(original)).toBe(true);
                    expect(
                      data.split("# Added by the Neuve installer").length - 1,
                    ).toBe(phase === "installed" ? 1 : 0);
                  } else if (kind === "absent" && phase === "installed") {
                    if (
                      entry.path === join(context.home, selected) ||
                      entry.path.endsWith(".plist") ||
                      entry.path.endsWith(".service") ||
                      entry.path.endsWith(".timer")
                    )
                      expect(after).not.toBeNull();
                    else expect(after).toBeNull();
                  } else if (
                    kind === "absent" &&
                    phase === "removed" &&
                    entry.path === join(context.home, selected)
                  ) {
                    // The installer created it, and uninstall removes it once it is empty.
                    expect(
                      after,
                      `${shell}/${loginShell}/${kind}/${phase}: ${entry.path}`,
                    ).toBeNull();
                  } else
                    expect(
                      after,
                      `${shell}/${loginShell}/${kind}/${phase}: ${entry.path}`,
                    ).toEqual(before.entry);
                }
              };
              const failedInstall = async (upgrading: boolean) =>
                run(
                  [
                    shell,
                    "-c",
                    `
printf() {
    command printf "$@"
    case "\${2:-}" in "Installed neuve "*) exit 61 ;; esac
}
script=$1
shift
. "$script"
`,
                    "matrix-failure",
                    installer,
                    "--prefix",
                    context.prefix,
                    "--archive",
                    upgrading ? nextArchive : archive,
                    "--checksums",
                    upgrading ? nextSums : sums,
                  ],
                  context.env,
                );
              const failedFresh = await failedInstall(false);
              expect(
                failedFresh.code,
                failedFresh.stdout + failedFresh.stderr,
              ).toBe(61);
              await assertExternal("failed");
              expect(await lstat(context.prefix).catch(() => null)).toBeNull();
              const installed = await install(context, [], shell);
              success(installed);
              await assertExternal("installed");
              // The PATH record is inside the prefix, but a link can lead outside it.
              const record = join(context.prefix, "lib/neuve/path-file");
              const contents = await readFile(record, "utf8");
              await rm(record);
              const recordEntry = await makeEntry(
                record,
                contents,
                join(context.home, "managed-path-record"),
              );
              const beforeRecord = await entryState(record, kind !== "file");
              const beforeTarget = await entryState(recordEntry.target);
              const oldCli = await hash(context.cli);
              const failedUpgrade = await failedInstall(true);
              expect(
                failedUpgrade.code,
                failedUpgrade.stdout + failedUpgrade.stderr,
              ).toBe(61);
              expect(await hash(context.cli)).toBe(oldCli);
              expect(await entryState(record, kind !== "file")).toEqual(
                beforeRecord,
              );
              expect(await entryState(recordEntry.target)).toEqual(
                beforeTarget,
              );
              await assertExternal("installed");
              const upgraded = await install(
                context,
                ["--archive", nextArchive, "--checksums", nextSums],
                shell,
              );
              success(upgraded);
              await assertExternal("installed");
              if (kind !== "absent" && kind !== "file")
                expect(await entryState(record, kind !== "file")).toEqual(
                  beforeRecord,
                );
              expect(await entryState(recordEntry.target)).toEqual(
                beforeTarget,
              );
              const removed = await install(context, ["--uninstall"], shell);
              const retained =
                (process.platform === "linux" && kind !== "absent") ||
                (process.platform === "darwin" &&
                  ["link", "dangling", "directory", "fifo"].includes(kind));
              if (retained) {
                // These unit fixtures are foreign or unsafe. Refusal must leave
                // the CLI and startup files intact, just like the unit files.
                expect(removed.code, removed.stdout + removed.stderr).toBe(1);
                expect(removed.stderr).toContain(
                  "neuve and its files were kept.",
                );
                await assertExternal("installed");
              } else {
                success(removed);
                await assertExternal("removed");
              }
              if (
                retained ||
                (kind !== "absent" &&
                  kind !== "file" &&
                  kind !== "readonly-file")
              )
                expect(await entryState(record, kind !== "file")).toEqual(
                  beforeRecord,
                );
              else expect(await entryState(record, kind !== "file")).toBeNull();
              expect(await entryState(recordEntry.target)).toEqual(
                beforeTarget,
              );
              expect(
                await lstat(join(context.prefix, ".install.lock")).catch(
                  () => null,
                ),
              ).toBeNull();
              expect(
                (await lstat(context.cli).catch(() => null)) !== null,
              ).toBe(retained);
              completed.push({ shell, loginShell, kind });
            }),
        );
        for (const result of cases)
          if (result.status === "rejected") throw result.reason;
      }
      const scenarioKey = (scenario: (typeof scenarios)[number]) =>
        `${scenario.shell}/${scenario.loginShell}/${scenario.kind}`;
      expect(completed.map(scenarioKey).sort()).toEqual(
        scenarios.map(scenarioKey).sort(),
      );
      console.log(
        `Filesystem matrix: ${completed.length}/${scenarios.length} scenarios in ${((performance.now() - started) / 1000).toFixed(2)} seconds`,
      );
    }, 900_000);

    // Working linked ancestors are valid; rollback removes only directories this install created.
    test("preserves linked and read-only parents through failure, install, upgrade and uninstall", async () => {
      await forEachInstallerShell(async (shell) => {
        for (const kind of ["linked-existing", "linked-missing", "readonly"]) {
          await using context = await fresh();
          context.env = {
            ...context.env,
            SHELL: "/bin/fish",
            NEUVE_NO_MODIFY_PATH: "0",
            NEUVE_NO_AGENT: "0",
            // Keep systemd's unit folder separate from the startup parents this
            // matrix deliberately makes unsafe. Unit safety has its own cases.
            XDG_CONFIG_HOME: join(context.directory, "systemd-config"),
          };
          const originals: { path: string; mode: number; ino: number }[] = [];
          for (const folder of [
            ".config",
            ...(process.platform === "darwin" ? ["Library"] : []),
          ]) {
            const parent = join(context.home, folder);
            const target = join(context.directory, `managed-${folder}`);
            await mkdir(target);
            if (kind.startsWith("linked")) await symlink(target, parent);
            else await mkdir(parent);
            if (kind !== "linked-missing")
              for (const suffix of folder === ".config"
                ? ["fish/conf.d"]
                : ["LaunchAgents", "Logs"])
                await mkdir(join(parent, suffix), { recursive: true });
            if (folder === ".config" && kind !== "linked-missing")
              await writeFile(
                join(parent, "fish/conf.d/neuve.fish"),
                "# keep bytes\n",
              );
            if (kind === "readonly") {
              for (const suffix of folder === ".config"
                ? ["fish/conf.d"]
                : ["LaunchAgents", "Logs"])
                await chmod(join(parent, suffix), 0o555);
              await chmod(parent, 0o555);
            }
            const entry = await lstat(parent);
            originals.push({ path: parent, mode: entry.mode, ino: entry.ino });
          }
          const before = await snapshot(context.home);
          const failed = await run(
            [
              shell,
              "-c",
              `
printf() { command printf "$@"; case "\${2:-}" in "Installed neuve "*) exit 61 ;; esac; }
script=$1; shift; . "$script"
`,
              "parent-failure",
              installer,
              "--prefix",
              context.prefix,
              "--archive",
              archive,
              "--checksums",
              sums,
            ],
            context.env,
          );
          expect(failed.code, failed.stdout + failed.stderr).toBe(61);
          expect(await snapshot(context.home)).toEqual(before);
          success(await install(context, [], shell));
          if (process.platform === "darwin" && kind.startsWith("linked"))
            expect(
              await Bun.file(
                join(
                  context.home,
                  "Library/LaunchAgents/dev.neuve.worker.plist",
                ),
              ).exists(),
            ).toBe(true);
          success(
            await install(
              context,
              ["--archive", nextArchive, "--checksums", nextSums],
              shell,
            ),
          );
          success(await install(context, ["--uninstall"], shell));
          for (const original of originals) {
            const after = await lstat(original.path);
            expect(after.mode).toBe(original.mode);
            expect(after.ino).toBe(original.ino);
            if (kind === "readonly") {
              await chmod(original.path, 0o755);
              for (const suffix of original.path.endsWith(".config")
                ? ["fish/conf.d"]
                : ["LaunchAgents", "Logs"])
                await chmod(join(original.path, suffix), 0o755);
            }
          }
        }
      });
    }, 180_000);

    // Preflight must leave launchd registration and pre-existing log entries untouched.
    test.skipIf(process.platform !== "darwin")(
      "skips unwritable owned agents and unsafe or unwritable agent logs",
      async () => {
        for (const kind of [
          "readonly-plist",
          "readonly-parent",
          "log-link",
          "log-dangling",
          "log-directory",
          "log-fifo",
          "log-readonly",
          "log-file",
          "log-absent",
        ]) {
          await using context = await fresh();
          const wrappers = join(context.directory, "wrappers");
          const calls = join(context.directory, "calls");
          await mkdir(wrappers);
          await writeFile(
            join(wrappers, "launchctl"),
            `#!/bin/sh
printf '%s\\n' "$*" >>"$NEUVE_CALLS"
case "$1" in
 print) if [ -f "$NEUVE_CALLS.loaded" ]; then printf 'program = %s\\n' "$(plutil -extract ProgramArguments.0 raw -o - "$NEUVE_CALLS.loaded")"; else echo 'Could not find service "dev.neuve.worker" in domain for user gui: 501' >&2; exit 113; fi ;;
 bootstrap) cp "$3" "$NEUVE_CALLS.loaded" ;;
 bootout) rm -f "$NEUVE_CALLS.loaded" ;;
esac
`,
            { mode: 0o755 },
          );
          context.env = {
            ...context.env,
            PATH: `${wrappers}:${context.env.PATH}`,
            NEUVE_CALLS: calls,
            NEUVE_NO_AGENT: "0",
            NEUVE_AGENT_NO_LOAD: "0",
          };
          const plist = join(
            context.home,
            "Library/LaunchAgents/dev.neuve.worker.plist",
          );
          const log = join(context.home, "Library/Logs/neuve-worker-sweep.log");
          if (kind.startsWith("readonly")) {
            success(await install(context));
            const bytes = await readFile(plist);
            const registered = await readFile(calls);
            await chmod(
              kind === "readonly-plist" ? plist : dirname(plist),
              kind === "readonly-plist" ? 0o444 : 0o555,
            );
            const removed = await install(context, ["--uninstall"]);
            expect(removed.code).toBe(1);
            expect(removed.stderr).toContain("neuve and its files were kept");
            expect(await Bun.file(context.cli).exists()).toBe(true);
            expect(await readFile(plist)).toEqual(bytes);
            expect(await readFile(calls)).toEqual(registered);
            await chmod(dirname(plist), 0o755);
            await chmod(plist, 0o644);
            continue;
          }
          await mkdir(dirname(log), { recursive: true });
          const target = join(context.directory, "managed-log");
          if (["log-link", "log-file", "log-readonly"].includes(kind))
            await writeFile(
              kind === "log-link" ? target : log,
              "keep log bytes\n",
            );
          if (["log-link", "log-dangling"].includes(kind))
            await symlink(target, log);
          if (kind === "log-directory") await mkdir(log);
          if (kind === "log-fifo")
            success(await run(["mkfifo", log], context.env));
          if (kind === "log-readonly") await chmod(log, 0o444);
          const entry = await lstat(log).catch(() => null);
          const logBytes = entry?.isFile() ? await readFile(log) : null;
          const installed = await install(context);
          success(installed);
          if (["log-file", "log-absent"].includes(kind)) {
            expect(await Bun.file(plist).exists()).toBe(true);
            expect(await readFile(calls, "utf8")).toContain("bootstrap");
          } else {
            expect(installed.stdout).toContain(
              "didn't set up the launchd agent",
            );
            expect(await lstat(plist).catch(() => null)).toBeNull();
            expect(await lstat(calls).catch(() => null)).toBeNull();
          }
          expect((await lstat(log).catch(() => null))?.ino).toBe(entry?.ino);
          expect((await lstat(log).catch(() => null))?.mode).toBe(entry?.mode);
          if (logBytes !== null) expect(await readFile(log)).toEqual(logBytes);
          if (kind === "log-link")
            expect(await readFile(target, "utf8")).toBe("keep log bytes\n");
          if (kind === "log-dangling")
            expect(await lstat(target).catch(() => null)).toBeNull();
          success(await install(context, ["--uninstall"]));
        }
      },
      180_000,
    );

    // Dotfile links must survive rollback without creating missing targets or changing existing bytes.
    for (const targetExists of [false, true]) {
      test(`preserves a ${targetExists ? "working" : "dangling"} startup-file link after a failed install`, async () => {
        for (const shell of installerShells) {
          await using context = await fresh();
          const rc = join(context.home, ".zshrc");
          const target = join(context.home, "managed-zshrc");
          const original = Buffer.from(
            "# managed startup file\nexport EXAMPLE=keep",
          );
          if (targetExists) await writeFile(target, original);
          const originalTarget = targetExists ? await stat(target) : null;
          await symlink("managed-zshrc", rc);
          const failed = await run(
            [
              shell,
              "-c",
              `
printf() {
    command printf "$@"
    case "\${2:-}" in "Added "*"/bin to PATH in "*|"Add this line to your shell startup file: "*) exit 61 ;; esac
}
script=$1
shift
. "$script"
`,
              "path-link-fault",
              installer,
              "--prefix",
              context.prefix,
              "--archive",
              archive,
              "--checksums",
              sums,
            ],
            { ...context.env, NEUVE_NO_MODIFY_PATH: "0" },
          );
          expect(failed.code).toBe(61);
          expect((await lstat(rc).catch(() => null))?.isSymbolicLink()).toBe(
            true,
          );
          expect(await readlink(rc)).toBe("managed-zshrc");
          if (originalTarget !== null) {
            expect(failed.stdout).toContain(
              `neuve install: ${rc} isn't a plain file, so the installer left it alone.`,
            );
            expect(await readFile(target)).toEqual(original);
            expect((await stat(target)).ino).toBe(originalTarget.ino);
          } else {
            expect(await lstat(target).catch(() => null)).toBeNull();
            expect(failed.stdout).toContain(
              `neuve install: ${rc} links to a file that doesn't exist, so the installer left it alone.\nneuve install: Add this line to your shell startup file: export PATH="${context.prefix}/bin:$PATH"\n`,
            );
          }
          expect(await stat(context.prefix).catch(() => null)).toBeNull();
        }
      }, 120_000);
    }

    // A plain retry must make the default install discoverable from only its shell startup file.
    test("retries a default install after a PATH edit and runs neuve in a fresh shell", async () => {
      const shell = (await Bun.file("/bin/zsh").exists())
        ? "/bin/zsh"
        : "/bin/bash";
      for (const installerShell of [
        "sh",
        ...(Bun.which("dash") ? ["dash"] : []),
      ]) {
        await using context = await fresh();
        const prefix = join(context.home, ".neuve");
        const rc = join(
          context.home,
          shell === "/bin/zsh"
            ? ".zshrc"
            : process.platform === "darwin"
              ? ".bash_profile"
              : ".bashrc",
        );
        const env = {
          ...context.env,
          SHELL: shell,
          NEUVE_NO_MODIFY_PATH: "0",
          NEUVE_INSTALL_DIR: undefined,
        };
        const options = ["--archive", archive, "--checksums", sums];
        const failed = await run(
          [
            installerShell,
            "-c",
            `
printf() {
    command printf "$@"
    case "\${2:-}" in "Added "*"/bin to PATH in "*) exit 61 ;; esac
}
script=$1
shift
. "$script"
`,
            "default-path-fault",
            installer,
            ...options,
          ],
          env,
        );
        expect(failed.code).toBe(61);
        expect(failed.stdout).toContain(
          `Added ${prefix}/bin to PATH in ${rc}.`,
        );
        expect(await stat(rc).catch(() => null)).toBeNull();
        expect(await stat(prefix).catch(() => null)).toBeNull();
        success(await run([installerShell, installer, ...options], env));
        const discovered = await run(
          [
            shell,
            ...(shell === "/bin/zsh" ? ["-f"] : ["--noprofile", "--norc"]),
            "-c",
            '. "$1"; command -v neuve; neuve --version',
            "fresh-shell",
            rc,
          ],
          { ...env, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
        );
        success(discovered);
        expect(discovered.stdout.trim()).toBe(
          `${prefix}/bin/neuve\nneuve ${releaseVersion}`,
        );
      }
    }, 120_000);

    // Upgrade must verify the script before it can execute, then use the same installer.
    // neuve upgrade downloads from the public release URL, which the private repository's releases
    // don't have, and the installer it runs now downloads only with a GitHub sign-in (NEU-374).
    test.skip("upgrades from file downloads and refuses a tampered script", async () => {
      await using context = await fresh();
      success(await install(context));
      const base = join(context.directory, "downloads");
      const assets = join(base, "latest/download");
      await mkdir(assets, { recursive: true });
      await copyFile(
        archive,
        join(assets, `neuve-${process.platform}-${process.arch}.tar.gz`),
      );
      await copyFile(installer, join(assets, "install.sh"));
      await writeChecksums(assets);
      const env = {
        ...context.env,
        NEUVE_DOWNLOAD_BASE: new URL(`file://${base}/`).href,
      };
      success(await run([context.cli, "upgrade"], env));
      success(
        await run([context.cli, "upgrade", "--version", "latest"], {
          ...env,
          NEUVE_VERSION: "v999.0.0",
        }),
      );
      await mkdir(join(base, "download"));
      await symlink(assets, join(base, "download", `v${releaseVersion}`));
      success(
        await run(
          [context.cli, "upgrade", "--version", `v${releaseVersion}`],
          env,
        ),
      );
      const marker = join(context.directory, "ran-tampered");
      await writeFile(join(assets, "install.sh"), `touch '${marker}'\n`);
      const result = await run([context.cli, "upgrade"], env);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("doesn't match SHA256SUMS");
      expect(await Bun.file(marker).exists()).toBe(false);
      const metadata = join(context.prefix, "lib/neuve/release.json");
      await writeFile(metadata, "{}");
      const invalid = await run([context.cli, "upgrade"], env);
      expect(invalid.code).not.toBe(0);
      expect(invalid.stderr).toContain(
        "This install's release.json is invalid.",
      );
    }, 120_000);

    // A failed download integrity check must leave even the destination directory absent.
    test("refuses a tampered archive before changing the prefix", async () => {
      await using context = await fresh();
      const bad = join(context.directory, "tampered.tar.gz");
      await writeFile(bad, "tampered");
      const result = await install(context, ["--archive", bad]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("doesn't match SHA256SUMS");
      expect(await Bun.file(join(context.prefix, "bin/neuve")).exists()).toBe(
        false,
      );
      expect(await stat(context.prefix).catch(() => null)).toBeNull();
    });

    // Source installs and the shared prefix have independent ownership and must be protected.
    test("refuses .local, source copies, symlink destinations, control characters and locks", async () => {
      await using context = await fresh();
      await mkdir(join(context.home, ".local"));
      const alias = join(context.directory, "shared-alias");
      await symlink(join(context.home, ".local"), alias);
      expect((await install(context, ["--prefix", alias])).stderr).toContain(
        "This folder is kept for the copy that bun run install:cli builds from source.",
      );
      const linked = join(context.directory, "linked-prefix");
      await mkdir(linked);
      await symlink(context.directory, join(linked, "bin"));
      expect((await install(context, ["--prefix", linked])).stderr).toContain(
        "is a symbolic link, which the installer won't follow.",
      );
      expect(
        (await install(context, ["--prefix", join(context.home, ".local")]))
          .stderr,
      ).toContain(
        "This folder is kept for the copy that bun run install:cli builds from source.",
      );
      await mkdir(join(context.prefix, "lib/neuve"), { recursive: true });
      await writeFile(join(context.prefix, "lib/neuve/install.json"), "{}");
      expect((await install(context)).stderr).toContain(
        "This folder holds a copy built from source.",
      );
      expect(
        (await install(context, ["--prefix", `${context.prefix}\ninvalid`]))
          .stderr,
      ).toContain("control character");
      for (const shell of installerShells) {
        const refused = await install(
          context,
          ["--prefix", `${context.prefix}:invalid`],
          shell,
        );
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain(
          "The install folder path must not contain a colon (:). PATH uses colons to separate folders.",
        );
        expect(
          await lstat(`${context.prefix}:invalid`).catch(() => null),
        ).toBeNull();
      }
      await rm(context.prefix, { recursive: true });
      await mkdir(join(context.prefix, ".install.lock"), { recursive: true });
      expect((await install(context)).stderr).toContain(
        "Another install holds",
      );
    }, 60_000);

    // Resolving a shared .local symlink must protect its whole physical subtree.
    test("refuses descendants of a symlinked .local before writing the prefix", async () => {
      await using context = await fresh();
      const shared = join(context.directory, "physical-local");
      await mkdir(shared);
      await symlink(shared, join(context.home, ".local"));
      const nested = join(shared, "other");
      const refused = await install(context, ["--prefix", nested]);
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toContain(
        "This folder is kept for the copy that bun run install:cli builds from source.",
      );
      expect(await readdir(shared)).toEqual([]);
    });

    test("force converts an old source copy and preserves its unused oxc folder", async () => {
      await using context = await fresh();
      const leftover = join(
        context.prefix,
        "lib/neuve/oxc-parser/src-js/old.node",
      );
      await mkdir(dirname(leftover), { recursive: true });
      await writeFile(leftover, "old source binding");
      await writeFile(join(context.prefix, "lib/neuve/install.json"), "{}\n");
      expect((await install(context)).code).not.toBe(0);
      success(await install(context, ["--force"]));
      expect(await readFile(leftover, "utf8")).toBe("old source binding");
      expect(
        JSON.parse(
          await readFile(
            join(context.prefix, "lib/neuve/install.json"),
            "utf8",
          ),
        ),
      ).not.toHaveProperty("parser");
      success(await run([context.cli, "--version"], context.env));
    }, 30_000);

    // A link or file in place of an owned folder must be refused without touching its contents.
    test("refuses semantic destinations that are files or symlinks", async () => {
      await using context = await fresh();
      success(await install(context));
      const outside = join(context.directory, "outside");
      await mkdir(outside);
      await writeFile(join(outside, "unrelated"), "keep");
      for (const name of ["semantic"]) {
        const destination = join(context.prefix, "lib/neuve", name);
        const backup = join(context.directory, `saved-${name}`);
        await rename(destination, backup);
        try {
          for (const kind of ["file", "symlink"]) {
            if (kind === "file") await writeFile(destination, "keep");
            else await symlink(outside, destination);
            const refused = await install(context, [
              "--archive",
              nextArchive,
              "--checksums",
              nextSums,
            ]);
            expect(refused.code).not.toBe(0);
            expect(refused.stderr).toContain(
              `${destination} isn't a real folder`,
            );
            if (kind === "file")
              expect(await readFile(destination, "utf8")).toBe("keep");
            else
              expect(await realpath(destination)).toBe(await realpath(outside));
            expect(await readFile(join(outside, "unrelated"), "utf8")).toBe(
              "keep",
            );
            await rm(destination);
          }
        } finally {
          await rename(backup, destination);
        }
      }
      await verifyInstall(context, releaseVersion);
    }, 120_000);

    // PATH edits must be idempotent and uninstall must keep unrelated prefix contents.
    test("writes one PATH block, uninstalls its files, and also runs under dash when available", async () => {
      await using context = await fresh();
      context.env.NEUVE_NO_MODIFY_PATH = "0";
      const dash = Bun.which("dash");
      const otherBin = join(context.directory, "other-bin");
      await mkdir(otherBin);
      const otherCli = join(otherBin, "neuve");
      await writeFile(otherCli, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      context.env.PATH = `${otherBin}:${context.env.PATH}`;
      const first = await install(context, [], dash ?? "sh");
      success(first);
      expect(first.stdout).toContain(
        `In this terminal, the neuve command still runs ${otherCli}.`,
      );
      expect(first.stdout.indexOf("Run exec $SHELL")).toBeLessThan(
        first.stdout.indexOf("Next, in a repository, run neuve setup"),
      );
      // Forced: without the agent the same version again would change nothing.
      const second = await install(context, ["--force"]);
      success(second);
      expect(second.stdout).toContain(`The neuve command runs ${otherCli}`);
      const rc = join(context.home, ".zshrc");
      expect(
        (await readFile(rc, "utf8")).split("# Added by the Neuve installer")
          .length - 1,
      ).toBe(1);
      await writeFile(join(context.prefix, "unrelated"), "keep");
      // Releases keep their licence in share/neuve/notices, so a top-level one isn't Neuve's.
      await writeFile(join(context.prefix, "LICENSE"), "unrelated license");
      const removed = await run(
        ["sh", installer, "--prefix", context.prefix, "--uninstall"],
        {
          ...context.env,
          SHELL: "/bin/bash",
          ZDOTDIR: join(context.directory, "different-zdotdir"),
        },
      );
      success(removed);
      expect(removed.stdout).toContain(
        "neuve install: Kept Records in each repository's .git/neuve/ folder, and settings in your user data folder.\nneuve install: Hooks that neuve setup hooks added stay in each repository and agent's settings; remove them by hand if you no longer want them.\n",
      );
      expect(await readFile(join(context.prefix, "unrelated"), "utf8")).toBe(
        "keep",
      );
      expect(await Bun.file(context.cli).exists()).toBe(false);
      expect(
        await stat(join(context.prefix, "lib/neuve")).catch(() => null),
      ).toBeNull();
      expect(
        await stat(join(context.prefix, "share")).catch(() => null),
      ).toBeNull();
      // The installer created the startup file; with its block gone it is empty and removed.
      expect(await lstat(rc).catch(() => null)).toBeNull();
      expect(await readFile(join(context.prefix, "LICENSE"), "utf8")).toBe(
        "unrelated license",
      );
    }, 120_000);

    // Invalid records cannot choose arbitrary cleanup files or marked lines.
    type PathEntryContext = {
      outside: string;
      line: string;
      home: string;
      rc: string;
      foreignLine: string;
    };
    const malformedPathEntries = [
      ({ line }: PathEntryContext) => `\n${line}\n`,
      ({ outside, line }: PathEntryContext) =>
        `${outside}/arbitrary\n${line}\n`,
      ({ outside, line }: PathEntryContext) => `${outside}/.bashrc\n${line}\n`,
      ({ line, home }: PathEntryContext) =>
        `${home}/../outside/.zshrc\n${line}\n`,
      ({ outside, line }: PathEntryContext) => `${outside}/./.zshrc\n${line}\n`,
      ({ outside, line }: PathEntryContext) => `${outside}//.zshrc\n${line}\n`,
      ({ outside, line }: PathEntryContext) => `${outside}/.zshrc\t\n${line}\n`,
      ({ line }: PathEntryContext) => `../outside/.zshrc\n${line}\n`,
      ({ outside, line }: PathEntryContext) => `${outside}/.zsh\nrc\n${line}\n`,
      ({ rc, foreignLine }: PathEntryContext) => `${rc}\n${foreignLine}\n`,
      ({ rc }: PathEntryContext) => `${rc}\n`,
      ({ rc }: PathEntryContext) => `${rc}`,
    ];
    for (const shell of installerShells)
      for (const [index, makeEntry] of malformedPathEntries.entries())
        test(`skips malformed PATH record entry: ${shell}/${index + 1}`, async () => {
          const release = await signalRelease("0.1.0-path.record");
          await using context = await fresh();
          const outside = join(context.directory, "outside");
          await mkdir(outside);
          const line = `export PATH="${context.prefix}/bin:$PATH"`;
          const originals = new Map<string, string>();
          for (const name of ["arbitrary", ".bashrc", ".zshrc", ".zshrc\t"]) {
            const path = join(outside, name);
            const content = `# Added by the Neuve installer\n${line}\nkeep\n`;
            originals.set(path, content);
            await writeFile(path, content);
          }
          const rc = join(context.home, ".zshrc");
          const foreignLine = 'export PATH="/other/bin:$PATH"';
          const originalRc = `# Added by the Neuve installer\n${foreignLine}\n`;
          await writeFile(rc, originalRc);
          const options = [
            "--archive",
            release.archive,
            "--checksums",
            release.sums,
          ];
          const entry = makeEntry({
            outside,
            line,
            home: context.home,
            rc,
            foreignLine,
          });
          success(await install(context, options, shell));
          await writeFile(join(context.prefix, "lib/neuve/path-file"), entry);
          const removed = await install(context, ["--uninstall"], shell);
          success(removed);
          expect(removed.stdout).toContain(
            "An entry in the installer's list of the startup files it changed is invalid, so the installer left that file alone.",
          );
          for (const [path, content] of originals)
            expect(await readFile(path, "utf8")).toBe(content);
          expect(await readFile(rc, "utf8")).toBe(originalRc);
          expect(await lstat(context.prefix).catch(() => null)).toBeNull();
        }, 6_000);

    // A previous ZDOTDIR may live outside HOME, so its absolute .zshrc shape remains supported.
    test("removes a recorded external ZDOTDIR block after ZDOTDIR changes", async () => {
      await using context = await fresh();
      const zdotdir = join(context.directory, "zsh config");
      success(
        await install({
          ...context,
          env: { ...context.env, ZDOTDIR: zdotdir, NEUVE_NO_MODIFY_PATH: "0" },
        }),
      );
      expect(await readFile(join(zdotdir, ".zshrc"), "utf8")).toContain(
        "# Added by the Neuve installer",
      );
      success(await install(context, ["--uninstall"]));
      // The installer created this .zshrc: without its block it is empty, so uninstall removes it.
      expect(await lstat(join(zdotdir, ".zshrc")).catch(() => null)).toBeNull();
    }, 60_000);

    // Uninstall owns no bytes in an unmarked file, including its missing final newline.
    test("leaves unmarked startup files byte-for-byte unchanged on uninstall", async () => {
      for (const shell of installerShells) {
        for (const recorded of [false, true]) {
          await using context = await fresh();
          const rc = join(context.home, ".zshrc");
          const original = Buffer.from(
            "# managed startup\nexport EXAMPLE=keep",
          );
          await writeFile(rc, original);
          const before = await lstat(rc);
          success(await install(context, [], shell));
          if (recorded)
            await writeFile(
              join(context.prefix, "lib/neuve/path-file"),
              `${rc}\nexport PATH="${context.prefix}/bin:$PATH"\n`,
            );
          success(await install(context, ["--uninstall"], shell));
          expect(await readFile(rc)).toEqual(original);
          expect((await lstat(rc)).ino).toBe(before.ino);
          expect((await lstat(rc)).mode).toBe(before.mode);
        }
      }
    }, 120_000);

    // An install can add PATH for several shells over time and owns only its exact blocks.
    test("removes every recorded PATH block after a shell and ZDOTDIR change", async () => {
      await using context = await fresh();
      context.env.NEUVE_NO_MODIFY_PATH = "0";
      const zsh = join(context.home, ".zshrc");
      const unrelated =
        '# Added by the Neuve installer\nexport PATH="/other/bin:$PATH"\n';
      await writeFile(zsh, unrelated);
      success(await install(context));
      const bashContext = {
        ...context,
        env: { ...context.env, SHELL: "/bin/bash" },
      };
      // Forced: without the agent the same version again would change nothing.
      success(await install(bashContext, ["--force"]));
      const bash = join(
        context.home,
        process.platform === "darwin" ? ".bash_profile" : ".bashrc",
      );
      const fishContext = {
        ...context,
        env: { ...context.env, SHELL: "/usr/bin/fish" },
      };
      success(await install(fishContext, ["--force"]));
      const fish = join(context.home, ".config/fish/conf.d/neuve.fish");
      for (const rc of [bash, fish])
        expect(await readFile(rc, "utf8")).toContain(
          "# Added by the Neuve installer",
        );
      success(
        await run(
          ["sh", installer, "--prefix", context.prefix, "--uninstall"],
          { ...context.env, SHELL: "/bin/other", ZDOTDIR: "/unused" },
        ),
      );
      expect(await readFile(zsh, "utf8")).toBe(unrelated);
      // The installer created both: without their blocks they are empty, so uninstall removes them.
      for (const rc of [bash, fish])
        expect(await lstat(rc).catch(() => null)).toBeNull();
    }, 120_000);

    // A missing PATH record must be repaired even when PATH editing is disabled.
    test("keeps current-shell PATH cleanup when upgrading an install without a record", async () => {
      await using context = await fresh();
      context.env.NEUVE_NO_MODIFY_PATH = "0";
      success(await install(context));
      await rm(join(context.prefix, "lib/neuve/path-file"));
      // Forced: without the agent the same version again would change nothing.
      success(await install(context, ["--no-modify-path", "--force"]));
      success(
        await run(
          ["sh", installer, "--prefix", context.prefix, "--uninstall"],
          context.env,
        ),
      );
      // The installer created .zshrc: without its block it is empty, so uninstall removes it.
      expect(
        await lstat(join(context.home, ".zshrc")).catch(() => null),
      ).toBeNull();
    }, 120_000);

    // A missing record is repaired when its old shell's own block is next observed.
    test("records an existing zsh block without a record when upgrading under bash", async () => {
      await using context = await fresh();
      context.env.NEUVE_NO_MODIFY_PATH = "0";
      success(await install(context));
      const record = join(context.prefix, "lib/neuve/path-file");
      await rm(record);
      // Forced: without the agent the same version again would change nothing.
      success(
        await install(
          {
            ...context,
            env: { ...context.env, SHELL: "/bin/bash" },
          },
          ["--force"],
        ),
      );
      expect(await readFile(record, "utf8")).toContain(
        join(context.home, ".zshrc"),
      );
      success(
        await install(
          { ...context, env: { ...context.env, SHELL: "/bin/bash" } },
          ["--uninstall"],
        ),
      );
      // The installer created both: without their blocks they are empty, so uninstall removes them.
      for (const file of [
        ".zshrc",
        process.platform === "darwin" ? ".bash_profile" : ".bashrc",
      ])
        expect(
          await lstat(join(context.home, file)).catch(() => null),
        ).toBeNull();
    }, 120_000);

    // Every startup path we write must survive the uninstall validator unchanged.
    test("normalizes trailing HOME and ZDOTDIR slashes and skips invalid startup paths", async () => {
      const release = await signalRelease("0.1.0-path.normalize");
      await forEachInstallerShell(async (shell) => {
        for (const suffix of ["/", "//"]) {
          for (const source of ["HOME", "ZDOTDIR"]) {
            await using context = await fresh();
            const rc = join(
              context.home,
              source === "HOME"
                ? process.platform === "darwin"
                  ? ".bash_profile"
                  : ".bashrc"
                : ".zshrc",
            );
            const original = Buffer.from("# startup\nexport EXAMPLE=keep\n\n");
            await writeFile(rc, original);
            context.env = {
              ...context.env,
              NEUVE_NO_MODIFY_PATH: "0",
              SHELL: source === "HOME" ? "/bin/bash" : "/bin/zsh",
              [source]: `${context.home}${suffix}`,
            };
            const options = [
              "--archive",
              release.archive,
              "--checksums",
              release.sums,
            ];
            success(await install(context, options, shell));
            expect(await readFile(rc, "utf8")).toContain(
              "# Added by the Neuve installer",
            );
            expect(
              await readFile(
                join(context.prefix, "lib/neuve/path-file"),
                "utf8",
              ),
            ).toBe(`${rc}\nexport PATH="${context.prefix}/bin:$PATH"\n`);
            success(await install(context, ["--uninstall"], shell));
            expect(await readFile(rc)).toEqual(original);
          }
        }
        for (const suffix of ["/.", "/nested/..", "/control\t"]) {
          await using context = await fresh();
          const zdotdir = `${context.home}${suffix}`;
          await mkdir(zdotdir, { recursive: true });
          const rc = join(zdotdir, ".zshrc");
          const original = Buffer.from("# untouched\n");
          await writeFile(rc, original);
          context.env = {
            ...context.env,
            ZDOTDIR: zdotdir,
            NEUVE_NO_MODIFY_PATH: "0",
          };
          const installed = await install(
            context,
            ["--archive", release.archive, "--checksums", release.sums],
            shell,
          );
          success(installed);
          expect(installed.stdout).toContain(
            `Add this line to your shell startup file: export PATH="${context.prefix}/bin:$PATH"`,
          );
          expect(await readFile(rc)).toEqual(original);
          expect(
            await readFile(join(context.prefix, "lib/neuve/path-file"), "utf8"),
          ).toBe("");
          success(await install(context, ["--uninstall"], shell));
          expect(await readFile(rc)).toEqual(original);
        }
      });
    }, 90_000);

    // Raw environment paths must not select a different file after shell command substitution.
    test("skips PATH edits for raw HOME or ZDOTDIR control characters", async () => {
      await forEachInstallerShell(async (shell) => {
        for (const source of ["HOME", "ZDOTDIR"]) {
          for (const suffix of ["\n", "\n\n", "\t", "\r"]) {
            await using context = await fresh();
            const configured = `${context.home}${suffix}`;
            await mkdir(configured);
            const filename =
              source === "HOME"
                ? process.platform === "darwin"
                  ? ".bash_profile"
                  : ".bashrc"
                : ".zshrc";
            const paths = [
              join(context.home, filename),
              join(configured, filename),
            ];
            const bytes = Buffer.from("# keep startup bytes\n");
            await Promise.all(paths.map((path) => writeFile(path, bytes)));
            context.env = {
              ...context.env,
              [source]: configured,
              NEUVE_NO_MODIFY_PATH: "0",
              SHELL: source === "HOME" ? "/bin/bash" : "/bin/zsh",
            };
            const result = await install(context, [], shell);
            success(result);
            expect(result.stdout).toContain(
              `Add this line to your shell startup file: export PATH="${context.prefix}/bin:$PATH"`,
            );
            for (const path of paths)
              expect(await readFile(path)).toEqual(bytes);
            expect(
              await readFile(
                join(context.prefix, "lib/neuve/path-file"),
                "utf8",
              ),
            ).toBe("");
            success(await install(context, ["--uninstall"], shell));
            for (const path of paths)
              expect(await readFile(path)).toEqual(bytes);
          }
        }
      });
    }, 180_000);

    // Symlink targets and mktemp output must retain bytes until their path validation runs.
    test("rejects control characters in resolved prefixes and raw TMPDIR", async () => {
      const release = await signalRelease("0.1.0-path.resolve");
      await forEachInstallerShell(async (shell) => {
        for (const source of ["prefix", "TMPDIR"]) {
          await using context = await fresh();
          const target = `${context.directory}/control\n`;
          await mkdir(target);
          if (source === "prefix") await symlink(target, context.prefix);
          else context.env.TMPDIR = target;
          const result = await install(
            context,
            ["--archive", release.archive, "--checksums", release.sums],
            shell,
          );
          expect(result.code).toBe(1);
          expect(result.stderr).toContain("contains a control character");
          expect(await readdir(target)).toEqual([]);
        }
      });
    }, 90_000);

    // Every load goes through this stub, including rollback; only a scratch HOME is used.
    test.skipIf(process.platform !== "darwin")(
      "preflights agent repair and restores an existing customized plist after failed bootstrap",
      async () => {
        await forEachInstallerShell(async (shell) => {
          await using context = await fresh();
          context.env.NEUVE_NO_AGENT = "0";
          success(await install(context, [], shell));
          const plist = join(
            context.home,
            "Library/LaunchAgents/dev.neuve.worker.plist",
          );
          const log = join(context.home, "Library/Logs/neuve-worker-sweep.log");
          success(
            await run(
              [
                "plutil",
                "-insert",
                "Round13",
                "-string",
                "keep custom bytes",
                plist,
              ],
              context.env,
            ),
          );
          const original = await readFile(plist);
          const wrappers = join(context.directory, "wrappers");
          const calls = join(context.directory, "calls");
          const registered = join(context.directory, "registered");
          await mkdir(wrappers);
          await writeFile(
            join(wrappers, "launchctl"),
            `#!/bin/sh
printf '%s\\n' "$*" >>"$NEUVE_CALLS"
case "$1" in
    print) if [ -f "$NEUVE_REGISTERED" ]; then printf 'program = %s\\n' "$(plutil -extract Program raw -o - "$NEUVE_REGISTERED" 2>/dev/null || plutil -extract ProgramArguments.0 raw -o - "$NEUVE_REGISTERED")"; else echo 'Could not find service "dev.neuve.worker" in domain for user gui: 501' >&2; exit 113; fi ;;
    bootstrap) [ "$NEUVE_BOOTSTRAP_SUCCESS" = 1 ] || exit 78; cp "$3" "$NEUVE_REGISTERED" ;;
    bootout) rm -f "$NEUVE_REGISTERED" ;;
    *) exit 1 ;;
esac
`,
            { mode: 0o755 },
          );
          context.env = {
            ...context.env,
            PATH: `${wrappers}:${context.env.PATH}`,
            NEUVE_CALLS: calls,
            NEUVE_REGISTERED: registered,
            NEUVE_AGENT_NO_LOAD: "0",
          };
          for (const kind of [
            "readonly-plist",
            "log-link",
            "log-fifo",
            "failed-bootstrap",
            "failed-after-bootstrap",
          ]) {
            context.env.NEUVE_BOOTSTRAP_SUCCESS =
              kind === "failed-after-bootstrap" ? "1" : "0";
            await rm(calls, { force: true });
            if (kind === "readonly-plist") await chmod(plist, 0o444);
            if (kind === "log-link")
              await symlink(join(context.directory, "unwritten-log"), log);
            if (kind === "log-fifo")
              success(await run(["mkfifo", log], context.env));
            const previous = await snapshot(context.prefix);
            const result =
              kind === "failed-after-bootstrap"
                ? await run(
                    [
                      shell,
                      "-c",
                      `
printf() { command printf "$@"; case "\${2:-}" in "Installed the launchd agent "*) exit 61 ;; esac; }
script=$1; shift; . "$script"
`,
                      "repair-failure",
                      installer,
                      "--prefix",
                      context.prefix,
                      "--archive",
                      archive,
                      "--checksums",
                      sums,
                    ],
                    context.env,
                  )
                : await install(context, [], shell);
            expect(await readFile(plist)).toEqual(original);
            const commands = (await readFile(calls, "utf8")).trim().split("\n");
            expect(commands[0]).toBe(
              `print gui/${process.getuid?.()}/dev.neuve.worker`,
            );
            if (kind.startsWith("failed-")) {
              expect(result.code).toBe(kind === "failed-bootstrap" ? 1 : 61);
              expect(await Bun.file(registered).exists()).toBe(
                kind === "failed-after-bootstrap",
              );
              expect(commands.map((line) => line.split(" ")[0])).toEqual(
                kind === "failed-bootstrap"
                  ? [
                      "print",
                      "bootout",
                      "bootstrap",
                      "print",
                      "print",
                      "bootstrap",
                    ]
                  : [
                      "print",
                      "bootout",
                      "bootstrap",
                      "print",
                      "bootout",
                      "print",
                      "print",
                      "bootstrap",
                    ],
              );
              expect(await snapshot(context.prefix)).toEqual(previous);
            } else {
              success(result);
              expect(result.stdout).toContain(
                "didn't set up the launchd agent",
              );
              expect(commands).toHaveLength(1);
            }
            await chmod(plist, 0o644);
            await rm(log, { force: true });
          }
          expect(
            await lstat(join(context.directory, "unwritten-log")).catch(
              () => null,
            ),
          ).toBeNull();
          context.env.NEUVE_AGENT_NO_LOAD = "1";
          success(await install(context, ["--uninstall"], shell));
        });
      },
      120_000,
    );

    // Every load goes through this stub, including rollback; only a scratch HOME is used.
    test.skipIf(process.platform !== "darwin")(
      "rolls back failed agent creation and leaves an existing owned agent untouched on upgrade",
      async () => {
        await using context = await fresh();
        const wrappers = join(context.directory, "wrappers");
        const log = join(context.directory, "launchctl.log");
        const registration = join(context.directory, "registered");
        await mkdir(wrappers);
        await writeFile(
          join(wrappers, "launchctl"),
          `#!/bin/sh
printf '%s\\n' "$*" >>"$NEUVE_LAUNCHCTL_LOG"
if [ "$1" = print ]; then if [ -f "$NEUVE_REGISTERED" ]; then printf 'program = %s\\n' "$(plutil -extract Program raw -o - "$NEUVE_REGISTERED" 2>/dev/null || plutil -extract ProgramArguments.0 raw -o - "$NEUVE_REGISTERED")"; else echo 'Could not find service "dev.neuve.worker" in domain for user gui: 501' >&2; exit 113; fi; exit 0; fi
if [ "$NEUVE_FAIL_LAUNCHCTL" = 1 ]; then
    case "$1" in bootout|bootstrap) exit 78 ;; esac
fi
if [ "$1" = bootstrap ] && [ "$NEUVE_FAIL_BOOTSTRAP" = 1 ]; then exit 78; fi
case "$1" in
    bootstrap) cp "$3" "$NEUVE_REGISTERED" ;;
    bootout) rm -f "$NEUVE_REGISTERED" ;;
esac
`,
          { mode: 0o755 },
        );
        context.env = {
          ...context.env,
          PATH: `${wrappers}:${context.env.PATH}`,
          NEUVE_NO_AGENT: "0",
          NEUVE_AGENT_NO_LOAD: "0",
          NEUVE_LAUNCHCTL_LOG: log,
          NEUVE_REGISTERED: registration,
          NEUVE_FAIL_BOOTSTRAP: "1",
          NEUVE_FAIL_LAUNCHCTL: "0",
        };
        const plist = join(
          context.home,
          "Library/LaunchAgents/dev.neuve.worker.plist",
        );
        const failed = await install(context);
        expect(failed.code).not.toBe(0);
        expect(failed.stdout + failed.stderr).toContain(
          "neuve worker install-agent failed",
        );
        expect(await Bun.file(plist).exists()).toBe(false);
        expect(await stat(context.prefix).catch(() => null)).toBeNull();
        expect(
          (await readFile(log, "utf8"))
            .split("\n")
            .filter((line) => line.startsWith("bootout ")).length,
        ).toBe(1);
        context.env.NEUVE_FAIL_BOOTSTRAP = "0";
        success(await install(context));
        await verifyInstall(context, releaseVersion);
        expect(
          (await readFile(log, "utf8"))
            .split("\n")
            .filter((line) => line.startsWith("bootstrap ")).length,
        ).toBe(2);
        await writeFile(
          plist,
          (await readFile(plist, "utf8")).replace(
            "<integer>300</integer>",
            "<integer>321</integer>",
          ),
        );
        const previousPlist = await readFile(plist);
        const mutationCalls = async () =>
          (await readFile(log, "utf8"))
            .split("\n")
            .filter((line) => !line.startsWith("print "));
        const previousCalls = await mutationCalls();
        context.env.NEUVE_FAIL_LAUNCHCTL = "1";
        const upgraded = await install(context, [
          "--archive",
          nextArchive,
          "--checksums",
          nextSums,
        ]);
        success(upgraded);
        expect(upgraded.stdout).toContain(
          "neuve install: The launchd agent already runs this install.\n",
        );
        expect(await readFile(plist)).toEqual(previousPlist);
        expect(await mutationCalls()).toEqual(previousCalls);
        expect(await Bun.file(registration).exists()).toBe(true);
        await verifyInstall(context, nextVersion);
        // B again, in place with the agent on: the installer never goes back to the older A.
        success(
          await install(context, [
            "--archive",
            nextArchive,
            "--checksums",
            nextSums,
          ]),
        );
        expect(await readFile(plist)).toEqual(previousPlist);
        expect(await mutationCalls()).toEqual(previousCalls);
        expect(await Bun.file(registration).exists()).toBe(true);
        context.env.NEUVE_FAIL_LAUNCHCTL = "0";
        success(await install(context, ["--uninstall"]));
        expect(await Bun.file(plist).exists()).toBe(false);
        const interrupted = await run(
          [
            "sh",
            "-c",
            `
printf() {
    command printf "$@"
    case "\${2:-}" in "Installed the launchd agent "*) exit 61 ;; esac
}
script=$1
shift
. "$script"
`,
            "agent-fault",
            installer,
            "--prefix",
            context.prefix,
            "--archive",
            archive,
            "--checksums",
            sums,
          ],
          context.env,
        );
        expect(interrupted.code).toBe(61);
        expect(await Bun.file(plist).exists()).toBe(false);
        expect(await stat(context.prefix).catch(() => null)).toBeNull();
        expect(
          (await readFile(log, "utf8"))
            .trim()
            .split("\n")
            .filter((line) => !line.startsWith("print "))
            .slice(-3)
            .map((line) => line.split(" ")[0]),
        ).toEqual(["bootout", "bootstrap", "bootout"]);
      },
      120_000,
    );

    // Comments and unreadable plist structures cannot authorize touching another agent.
    test.skipIf(process.platform !== "darwin")(
      "preserves foreign, malformed and missing-key plists without mutating launchctl",
      async () => {
        const release = await signalRelease("0.1.0-agent.ownership");
        const options = [
          "--archive",
          release.archive,
          "--checksums",
          release.sums,
        ];
        await forEachInstallerShell(async (shell) => {
          await using context = await fresh();
          const wrappers = join(context.directory, "wrappers");
          const calls = join(context.directory, "calls");
          await mkdir(wrappers);
          await writeFile(
            join(wrappers, "launchctl"),
            '#!/bin/sh\nprintf "%s\\n" "$*" >>"$NEUVE_CALLS"\ncase "$1" in print) echo "Could not find service \\"dev.neuve.worker\\" in domain for user gui: 501" >&2; exit 113 ;; *) exit 99 ;; esac\n',
            { mode: 0o755 },
          );
          context.env = {
            ...context.env,
            PATH: `${wrappers}:${context.env.PATH}`,
            NEUVE_CALLS: calls,
            NEUVE_NO_AGENT: "0",
            NEUVE_AGENT_NO_LOAD: "0",
          };
          const plist = join(
            context.home,
            "Library/LaunchAgents/dev.neuve.worker.plist",
          );
          await mkdir(dirname(plist), { recursive: true });
          const comment = `<!--\n<key>ProgramArguments</key>\n<array>\n<string>${context.cli}</string>\n</array>\n-->`;
          const foreign = `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n${comment}\n<key>ProgramArguments</key>\n<array>\n<string>/other/install/bin/neuve</string>\n</array>\n</dict></plist>\n`;
          for (const content of [
            foreign,
            `<plist version="1.0"><dict>${comment}</dict></plist>\n`,
            `${comment}\n<broken>\n`,
            ...[
              `<key>Program</key><string>/other/install/bin/neuve</string><key>ProgramArguments</key><array><string>${context.cli}</string></array>`,
              `<key>Program</key><string>${context.cli}</string><key>ProgramArguments</key><array><string>/other/install/bin/neuve</string></array>`,
              `<key>Program</key><integer>1</integer><key>ProgramArguments</key><array><string>${context.cli}</string></array>`,
              `<key>ProgramArguments</key><array><integer>1</integer></array>`,
              `<key>ProgramArguments</key><array><string>${context.cli}\n</string></array>`,
              `<key>ProgramArguments</key><array/>`,
            ].map(
              (keys) =>
                `<plist version="1.0"><dict><key>Label</key><string>dev.neuve.worker</string>${keys}</dict></plist>\n`,
            ),
            `<plist version="1.0"><dict><key>Label</key><string>another.worker</string><key>ProgramArguments</key><array><string>${context.cli}</string></array></dict></plist>\n`,
          ]) {
            await writeFile(plist, content);
            if (content === foreign)
              success(await run(["plutil", "-lint", plist], context.env));
            const installed = await install(context, options, shell);
            success(installed);
            expect(installed.stdout).toContain(
              "The launchd agent runs another neuve, so the installer left it in place.",
            );
            expect(await readFile(plist, "utf8")).toBe(content);
            success(await install(context, ["--uninstall"], shell));
            expect(await readFile(plist, "utf8")).toBe(content);
            expect(
              (await readFile(calls, "utf8"))
                .trim()
                .split("\n")
                .every((line) => line.startsWith("print ")),
            ).toBe(true);
          }
        });
      },
      90_000,
    );

    // F39 known limit: a bootout landing after the winner finishes unloads it; one install repairs it.
    test.skipIf(process.platform !== "darwin")(
      "F39 known limit late macOS bootout, recoverable",
      async () => {
        await forEachInstallerShell(async (shell) => {
          await using context = await fresh();
          const other = join(context.home, "winner"),
            wrappers = join(context.directory, "wrappers"),
            registered = join(context.directory, "registered"),
            swapped = join(context.directory, "swapped");
          await mkdir(wrappers);
          const plist = join(
            context.home,
            "Library/LaunchAgents/dev.neuve.worker.plist",
          );
          await writeFile(
            join(wrappers, "launchctl"),
            `#!/bin/sh
if [ "$1" = bootout ] && [ "\${NEUVE_HANDOFF_ARMED:-0}" = 1 ] && [ ! -f "$NEUVE_SWAPPED" ]; then
 : >"$NEUVE_SWAPPED"
 NEUVE_HANDOFF_ARMED=0 "$NEUVE_ORIGINAL/bin/neuve" worker uninstall-agent >"$NEUVE_SWAPPED.remove" 2>&1 || exit 97
 NEUVE_HANDOFF_ARMED=0 "$NEUVE_SHELL" "$NEUVE_INSTALLER" --prefix "$NEUVE_OTHER" --archive "$NEUVE_ARCHIVE" --checksums "$NEUVE_SUMS" >"$NEUVE_SWAPPED.install" 2>&1 || exit 98
fi
case "$1" in
 print) if [ -f "$NEUVE_REGISTERED" ]; then printf 'program = %s\\n' "$(plutil -extract Program raw -o - "$NEUVE_REGISTERED" 2>/dev/null || plutil -extract ProgramArguments.0 raw -o - "$NEUVE_REGISTERED")"; else echo 'Could not find service "dev.neuve.worker" in domain for user gui: 501' >&2; exit 113; fi ;;
 bootstrap) cp "$3" "$NEUVE_REGISTERED" ;;
 bootout) rm -f "$NEUVE_REGISTERED" ;;
 *) exit 99 ;;
esac
`,
            { mode: 0o755 },
          );
          context.env = {
            ...context.env,
            PATH: `${wrappers}:${context.env.PATH}`,
            NEUVE_NO_AGENT: "0",
            NEUVE_AGENT_NO_LOAD: "0",
            NEUVE_REGISTERED: registered,
            NEUVE_SWAPPED: swapped,
            NEUVE_ORIGINAL: context.prefix,
            NEUVE_OTHER: other,
            NEUVE_SHELL: shell,
            NEUVE_INSTALLER: installer,
            NEUVE_ARCHIVE: archive,
            NEUVE_SUMS: sums,
          };
          success(await install(context, [], shell));
          const result = await install(
            { ...context, env: { ...context.env, NEUVE_HANDOFF_ARMED: "1" } },
            ["--uninstall"],
            shell,
          );
          expect(result.code, result.stdout + result.stderr).toBe(1);
          expect(await Bun.file(swapped).exists()).toBe(true);
          expect(await Bun.file(registered).exists()).toBe(false);
          const winner = await readFile(plist, "utf8");
          expect(winner).toContain(other + "/bin/neuve");
          success(
            await install(
              { ...context, prefix: other, cli: join(other, "bin/neuve") },
              [],
              shell,
            ),
          );
          expect(await readFile(plist, "utf8")).toBe(winner);
          expect(await readFile(registered, "utf8")).toBe(winner);
          expect(await Bun.file(join(other, "bin/neuve")).exists()).toBe(true);
        });
      },
      90_000,
    );

    // F41: an owned registration must be safely unloaded before any payload disappears.
    for (const shell of installerShells)
      for (const kind of [
        "readonly-plist",
        "readonly-parent",
        "log-link",
        "log-parent-readonly",
        "log-parent-file",
        "plist-directory",
        "failed-bootout",
        "lying-bootout",
        "absent",
        "error-but-absent",
      ])
        test.skipIf(process.platform !== "darwin")(
          `F41 refuses unsafe or still-loaded macOS uninstall: ${shell}/${kind}`,
          async () => {
            await using context = await fresh();
            const wrappers = join(context.directory, "wrappers"),
              registered = join(context.directory, "registered");
            await mkdir(wrappers);
            await writeFile(
              join(wrappers, "launchctl"),
              `#!/bin/sh
case "$1" in
 print) if [ -f "$NEUVE_REGISTERED" ]; then printf 'program = %s\\n' "$(plutil -extract Program raw -o - "$NEUVE_REGISTERED" 2>/dev/null || plutil -extract ProgramArguments.0 raw -o - "$NEUVE_REGISTERED")"; else echo 'Could not find service "dev.neuve.worker" in domain for user gui: 501' >&2; exit 113; fi ;;
 bootstrap) cp "$3" "$NEUVE_REGISTERED" ;;
 bootout)
  case "\${NEUVE_BOOTOUT_KIND:-}" in
   failed-bootout) exit 5 ;;
   lying-bootout) exit 0 ;;
   error-but-absent) rm -f "$NEUVE_REGISTERED"; exit 5 ;;
   *) rm -f "$NEUVE_REGISTERED" ;;
  esac ;;
 *) exit 99 ;;
esac
`,
              { mode: 0o755 },
            );
            context.env = {
              ...context.env,
              PATH: `${wrappers}:${context.env.PATH}`,
              NEUVE_REGISTERED: registered,
              NEUVE_NO_AGENT: "0",
              NEUVE_AGENT_NO_LOAD: "0",
            };
            success(await install(context, [], shell));
            const plist = join(
              context.home,
              "Library/LaunchAgents/dev.neuve.worker.plist",
            );
            const original = await readFile(plist);
            const log = join(
              context.home,
              "Library/Logs/neuve-worker-sweep.log",
            );
            if (kind === "readonly-plist") await chmod(plist, 0o444);
            if (kind === "readonly-parent") await chmod(dirname(plist), 0o555);
            if (kind === "log-link") {
              await rm(log, { force: true });
              await symlink(join(context.directory, "external"), log);
            }
            if (kind === "log-parent-readonly")
              await chmod(dirname(log), 0o555);
            if (kind === "log-parent-file") {
              await rename(dirname(log), join(context.directory, "saved-logs"));
              await writeFile(dirname(log), "keep log parent bytes\n");
            }
            if (kind === "plist-directory") {
              await rm(plist);
              await mkdir(plist);
            }
            if (kind === "absent") await rm(registered);
            context.env.NEUVE_BOOTOUT_KIND = kind;
            const result = await install(context, ["--uninstall"], shell);
            if (["absent", "error-but-absent"].includes(kind)) {
              success(result);
              expect(await Bun.file(context.cli).exists()).toBe(false);
              expect(await Bun.file(registered).exists()).toBe(false);
              expect(await Bun.file(plist).exists()).toBe(false);
            } else {
              expect(result.code, result.stdout + result.stderr).toBe(1);
              expect(result.stderr).toContain("dev.neuve.worker");
              expect(result.stderr).toContain("neuve and its files were kept");
              expect(await Bun.file(context.cli).exists()).toBe(true);
              expect(await readFile(registered)).toEqual(original);
              if (kind !== "plist-directory")
                expect(await readFile(plist)).toEqual(original);
            }
            if (kind === "log-parent-readonly")
              await chmod(dirname(log), 0o755);
            if (kind === "log-parent-file")
              expect(await readFile(dirname(log), "utf8")).toBe(
                "keep log parent bytes\n",
              );
            await chmod(dirname(plist), 0o755);
            if (kind !== "plist-directory" && (await Bun.file(plist).exists()))
              await chmod(plist, 0o644);
          },
          25_000,
        );

    // F45: neither a missing plist nor a failed print proves launchd has unloaded.
    for (const shell of installerShells)
      for (const rollback of [false, true])
        for (const kind of [
          "missing-plist",
          "print-error",
          "print-error-113",
          "missing-other",
          "missing-foreign",
          "missing-ambiguous",
          "foreign-plist-loaded-ours",
          "owned-loaded-other",
          "owned-loaded-foreign",
        ])
          test.skipIf(process.platform !== "darwin")(
            `F45 confirms macOS unload: ${shell}/${rollback ? "rollback" : "uninstall"}/${kind}`,
            async () => {
              await using c = await fresh();
              const wrappers = join(c.directory, "wrappers"),
                registered = join(c.directory, "registered"),
                calls = join(c.directory, "calls");
              const plist = join(
                c.home,
                "Library/LaunchAgents/dev.neuve.worker.plist",
              );
              await mkdir(wrappers);
              await writeFile(
                join(wrappers, "launchctl"),
                `#!/bin/sh
printf '%s\\n' "$*" >>"$NEUVE_CALLS"
if [ -f "$NEUVE_FAILURE_FILE" ]; then NEUVE_FAILURE=$(cat "$NEUVE_FAILURE_FILE"); fi
case "$1" in
 print)
  if [ -f "$NEUVE_CALLS.bootout" ]; then case "\${NEUVE_FAILURE:-}" in
   print-error) echo 'Could not communicate with launchd' >&2; exit 5 ;;
   print-error-113) echo 'Could not communicate with launchd' >&2; exit 113 ;;
  esac; fi
  if [ -f "$NEUVE_REGISTERED" ]; then
   command=$(plutil -extract Program raw -o - "$NEUVE_REGISTERED" 2>/dev/null || plutil -extract ProgramArguments.0 raw -o - "$NEUVE_REGISTERED") || exit 91
   case "\${NEUVE_FAILURE:-}" in missing-other|owned-loaded-other) command="$HOME/other/bin/neuve" ;; missing-foreign|owned-loaded-foreign) command=/usr/bin/false ;; missing-ambiguous) command='"'"$command"'"' ;; esac
   printf 'program = %s\\n' "$command"
  else echo 'Could not find service "dev.neuve.worker" in domain for user gui: 501' >&2; exit 113; fi ;;
 bootstrap) cp "$3" "$NEUVE_REGISTERED" ;;
 bootout)
  if [ -f "$NEUVE_REGISTERED" ]; then
   case "\${NEUVE_FAILURE:-}" in print-error*) : >"$NEUVE_CALLS.bootout"; echo 'bootout failed' >&2; exit 5 ;; esac
  fi
  rm -f "$NEUVE_REGISTERED" ;;
 *) exit 99 ;;
esac
`,
                { mode: 0o755 },
              );
              c.env = {
                ...c.env,
                PATH: `${wrappers}:${c.env.PATH}`,
                NEUVE_REGISTERED: registered,
                NEUVE_CALLS: calls,
                NEUVE_NO_AGENT: "0",
                NEUVE_AGENT_NO_LOAD: "0",
                NEUVE_PLIST: plist,
                NEUVE_FAILURE: "",
                NEUVE_FAILURE_FILE: join(c.directory, "failure"),
              };
              let result: Awaited<ReturnType<typeof run>>;
              if (rollback) {
                // Fail after registration, while the install still owns the payload transaction.
                result = await runGroup(
                  [
                    shell,
                    "-c",
                    `printf() {
 command printf "$@"
 case "\${2:-}" in
  "Installed neuve "*)
   case "$NEUVE_KIND" in
    missing*) rm -f "$NEUVE_PLIST" ;;
    foreign-plist-loaded-ours) command printf 'a foreign plist, kept byte for byte\\n' >"$NEUVE_PLIST" ;;
   esac
   command printf 'phase cleanup\\n' >>"$NEUVE_CALLS"
   command printf '%s\\n' "$NEUVE_KIND" >"$NEUVE_FAILURE_FILE"
   kill -TERM "$$" ;;
 esac
}; script=$1; shift; . "$script"`,
                    "F45-rollback",
                    installer,
                    "--prefix",
                    c.prefix,
                    "--archive",
                    archive,
                    "--checksums",
                    sums,
                  ],
                  { ...c.env, NEUVE_KIND: kind },
                );
              } else {
                success(await install(c, [], shell));
                if (kind.startsWith("missing")) await rm(plist);
                if (kind === "foreign-plist-loaded-ours")
                  await writeFile(
                    plist,
                    "a foreign plist, kept byte for byte\n",
                  );
                await writeFile(calls, "phase cleanup\n", { flag: "a" });
                c.env.NEUVE_FAILURE = kind;
                result = await install(c, ["--uninstall"], shell);
              }
              const kept =
                rollback ||
                kind.startsWith("print-error") ||
                kind === "missing-ambiguous" ||
                kind.startsWith("owned-loaded");
              if (kept) {
                expect(result.code, result.stdout + result.stderr).not.toBe(0);
                expect(result.stderr).toContain(
                  "neuve and its files were kept",
                );
              } else expect(result.code, result.stdout + result.stderr).toBe(0);
              expect(await Bun.file(c.cli).exists()).toBe(kept);
              expect(
                await Bun.file(
                  join(c.prefix, "lib/neuve/release.json"),
                ).exists(),
              ).toBe(kept);
              const loaded =
                rollback ||
                !["missing-plist", "foreign-plist-loaded-ours"].includes(kind);
              expect(await Bun.file(registered).exists()).toBe(loaded);
              expect(await Bun.file(plist).exists()).toBe(
                (kept && !kind.startsWith("missing")) ||
                  (!rollback && kind === "foreign-plist-loaded-ours"),
              );
              if (kind === "foreign-plist-loaded-ours")
                expect(await readFile(plist, "utf8")).toBe(
                  "a foreign plist, kept byte for byte\n",
                );
              if (
                [
                  "missing-other",
                  "missing-foreign",
                  "missing-ambiguous",
                ].includes(kind) ||
                kind.startsWith("owned-loaded")
              ) {
                const entries = (await readFile(calls, "utf8"))
                  .trim()
                  .split("\n");
                const boundary = entries.indexOf("phase cleanup");
                expect(boundary).toBeGreaterThanOrEqual(0);
                expect(
                  entries
                    .slice(boundary + 1)
                    .filter((line) => /^(bootout|bootstrap) /.test(line)),
                ).toEqual([]);
              }
              if (!rollback && kind.startsWith("missing")) {
                const log = await readFile(calls, "utf8");
                expect(log).toContain("print gui/");
                if (kind !== "missing-plist")
                  expect(result.stdout + result.stderr).toContain(
                    "dev.neuve.worker",
                  );
              }
            },
            30_000,
          );

    // Accept supported Program plists during repair and uninstall, using the archived CLI.
    test.skipIf(process.platform !== "darwin")(
      "repairs and uninstalls owned Program-only and matching ProgramArguments agents",
      async () => {
        await forEachInstallerShell(async (shell) => {
          for (const withArguments of [false, true]) {
            await using context = await fresh();
            success(await install(context, [], shell));
            const wrappers = join(context.directory, "wrappers");
            const calls = join(context.directory, "calls");
            const registered = join(context.directory, "registered");
            await mkdir(wrappers);
            await writeFile(
              join(wrappers, "launchctl"),
              `#!/bin/sh
printf '%s\\n' "$*" >>"$NEUVE_CALLS"
case "$1" in
    print) if [ -f "$NEUVE_REGISTERED" ]; then printf 'program = %s\\n' "$(plutil -extract Program raw -o - "$NEUVE_REGISTERED" 2>/dev/null || plutil -extract ProgramArguments.0 raw -o - "$NEUVE_REGISTERED")"; else echo 'Could not find service "dev.neuve.worker" in domain for user gui: 501' >&2; exit 113; fi ;;
    bootstrap) cp "$3" "$NEUVE_REGISTERED" ;;
    bootout) rm -f "$NEUVE_REGISTERED" ;;
    *) exit 1 ;;
esac
`,
              { mode: 0o755 },
            );
            context.env = {
              ...context.env,
              PATH: `${wrappers}:${context.env.PATH}`,
              NEUVE_NO_AGENT: "0",
              NEUVE_AGENT_NO_LOAD: "0",
              NEUVE_CALLS: calls,
              NEUVE_REGISTERED: registered,
            };
            const plist = join(
              context.home,
              "Library/LaunchAgents/dev.neuve.worker.plist",
            );
            await mkdir(dirname(plist), { recursive: true });
            const original = `<plist version="1.0"><dict><key>Label</key><string>dev.neuve.worker</string><key>Program</key><string>${context.cli}</string>${withArguments ? `<key>ProgramArguments</key><array><string>${context.cli}</string><string>worker</string><string>sweep</string></array>` : ""}</dict></plist>\n`;
            await writeFile(plist, original);
            success(await run(["plutil", "-lint", plist], context.env));
            const repaired = await install(context, [], shell);
            success(repaired);
            expect(repaired.stdout).toContain(
              "Installed the launchd agent that starts background workers at login and every 5 minutes.",
            );
            expect(await Bun.file(registered).exists()).toBe(true);
            expect(await readFile(plist, "utf8")).not.toBe(original);
            // Restore the Program shape so uninstall also exercises its ownership branch.
            await writeFile(plist, original);
            const removed = await install(context, ["--uninstall"], shell);
            success(removed);
            expect(removed.stdout).toContain(
              "Removed the launchd agent for this install.",
            );
            expect(await Bun.file(plist).exists()).toBe(false);
            expect(await Bun.file(registered).exists()).toBe(false);
            const mutations = (await readFile(calls, "utf8"))
              .trim()
              .split("\n")
              .filter((line) => !line.startsWith("print "));
            expect(mutations).toEqual([
              `bootout gui/${process.getuid?.()}/dev.neuve.worker`,
              `bootstrap gui/${process.getuid?.()} ${plist}`,
              `bootout gui/${process.getuid?.()}/dev.neuve.worker`,
            ]);
          }
        });
      },
      120_000,
    );

    // Agent checks use a temporary home and never load into the user's launchd domain.
    test.skipIf(process.platform !== "darwin")(
      "writes the stable agent command and preserves another command's agent",
      async () => {
        await using context = await fresh();
        context.env.NEUVE_NO_AGENT = "0";
        success(await install(context));
        const plist = join(
          context.home,
          "Library/LaunchAgents/dev.neuve.worker.plist",
        );
        expect(await readFile(plist, "utf8")).toContain(
          `<string>${await realpath(context.cli)}</string>`,
        );
        success(
          await run(
            ["sh", installer, "--prefix", context.prefix, "--uninstall"],
            context.env,
          ),
        );
        expect(await Bun.file(plist).exists()).toBe(false);
        success(await install(context));
        await writeFile(
          plist,
          "<key>ProgramArguments</key>\n<array>\n<string>/other/neuve</string>\n</array>\n",
        );
        success(await install(context));
        expect(await readFile(plist, "utf8")).toContain("/other/neuve");
        success(
          await run(
            ["sh", installer, "--prefix", context.prefix, "--uninstall"],
            context.env,
          ),
        );
        expect(await readFile(plist, "utf8")).toContain("/other/neuve");
      },
      120_000,
    );
  },
);

// PR and manual builds must never receive the permissions or trigger needed to publish.
test("only a v-tag push can publish, and only publish has write permissions", async () => {
  const permission = z.record(z.string(), z.string());
  const schema = z.object({
    permissions: permission,
    jobs: z.record(
      z.string(),
      z.object({
        if: z.string().optional(),
        permissions: permission.optional(),
        strategy: z
          .object({
            matrix: z.object({
              include: z.array(
                z.object({ target: z.string(), runner: z.string() }),
              ),
            }),
          })
          .optional(),
      }),
    ),
  });
  const workflow = schema.parse(
    Bun.YAML.parse(
      await readFile(join(root, ".github/workflows/release.yml"), "utf8"),
    ),
  );
  expect(Object.values(workflow.permissions)).not.toContain("write");
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (name === "publish") {
      expect(job.if).toBe(
        "github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')",
      );
      expect(job.permissions).toEqual({
        contents: "write",
        "id-token": "write",
        attestations: "write",
      });
    } else expect(Object.values(job.permissions ?? {})).not.toContain("write");
  }
  expect(workflow.jobs.publish).toBeDefined();
  expect(workflow.jobs.build?.strategy?.matrix.include).toEqual([
    { target: "darwin-arm64", runner: "macos-15" },
    { target: "linux-x64", runner: "ubuntu-22.04" },
    { target: "linux-arm64", runner: "ubuntu-22.04-arm" },
  ]);
});
