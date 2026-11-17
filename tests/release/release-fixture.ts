// Shared by the release tests: tiny releases whose `neuve` is a shell script (so the installer's
// transaction runs in milliseconds), scratch homes and prefixes, a recorder for every file a run
// leaves behind, and a scratch checkout with a stub gh for the release command. Native archives are
// covered by archive.test.ts.
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { installManifestSchema } from "../../apps/neuve-cli/src/install-manifest.ts";
import { releaseSchema } from "../../apps/neuve-cli/src/release-metadata.ts";
import { writeChecksums } from "../../scripts/release/checksums.ts";

export const root = resolve(import.meta.dir, "../..");
export const installer = join(root, "scripts/install.sh");
/** This host's release target: darwin-arm64, linux-x64 or linux-arm64. */
export const TARGET = `${process.platform}-${process.arch}`;
export const ASSET = `neuve-${TARGET}.tar.gz`;

export const hash = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

const scratchRoots = new Set<string>();

export const scratchDirectory = async (prefix = "neuve-release-test-") => {
  const path = await mkdtemp(join(tmpdir(), prefix));
  scratchRoots.add(path);
  return path;
};

const makeWritable = async (path: string): Promise<void> => {
  const entry = await lstat(path).catch(() => null);
  if (!entry?.isDirectory()) return;
  await chmod(path, entry.mode | 0o700);
  for (const name of await readdir(path)) await makeWritable(join(path, name));
};

export const removeScratch = async (path: string) => {
  await makeWritable(path);
  await rm(path, { recursive: true, force: true });
  scratchRoots.delete(path);
};

export const removeAllScratch = async () => {
  for (const path of [...scratchRoots]) await removeScratch(path);
};

/**
 * Links `folder/git` to the Git first on this test process's PATH, for a release test that runs
 * `neuve setup` on a PATH built from /usr/bin. Neuve's Git reads start every command with
 * `git --no-lazy-fetch` (Git 2.44 or newer) and refuse an older Git. GitHub's macOS 15 runners keep
 * Apple Git 2.39.5 in /usr/bin and a newer Homebrew Git first on PATH, so without this link setup
 * fails there with "Local Git preparation qualification refused". It refuses an older host Git.
 */
export const linkHostGit = async (folder: string) => {
  const git = Bun.which("git");
  if (!git) throw new Error("The release tests need git on PATH.");
  const checked = Bun.spawnSync([git, "--no-lazy-fetch", "version"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if (checked.exitCode !== 0)
    throw new Error(
      `The release tests need Git 2.44 or newer first on PATH (neuve runs git --no-lazy-fetch), and ${git} is older.`,
    );
  await mkdir(folder, { recursive: true });
  await symlink(git, join(folder, "git"));
  return folder;
};

export interface TinyRelease {
  readonly directory: string;
  readonly archive: string;
  readonly sums: string;
  readonly version: string;
}

/**
 * A release archive whose `neuve` answers `--version`, `worker uninstall-agent` (as the real CLI
 * does with no timer registered) and, when `skills` is set, `skills --help` and
 * `skills install --offer`, logging each call to `$NEUVE_TEST_LOG` when that is set.
 */
export const tinyRelease = async (
  version: string,
  options: Readonly<{
    skills?: boolean;
    /** Changes the staged tree before it is packed: a way to plant bad members. */
    plant?: (stage: string) => Promise<void>;
    tarArgs?: ReadonlyArray<string>;
  }> = {},
): Promise<TinyRelease> => {
  const directory = await scratchDirectory("neuve-tiny-release-");
  const content = join(directory, "content");
  const name = `neuve-${TARGET}`;
  const stage = join(content, name);
  const neuve = [
    "#!/bin/sh",
    `[ -z "\${NEUVE_TEST_LOG:-}" ] || printf '%s\\n' "neuve ${version}: $*" >>"$NEUVE_TEST_LOG"`,
    `if [ "\${1:-}" = --version ]; then printf 'neuve ${version}\\n'; exit 0; fi`,
    // A Linux uninstall always asks the CLI to remove its systemd timer, whatever NEUVE_NO_AGENT
    // said at install, since a timer may have been registered later.
    'if [ "${1:-}" = worker ] && [ "${2:-}" = uninstall-agent ]; then echo "There is no systemd timer dev.neuve.worker, so there was nothing to remove."; exit 0; fi',
    ...(options.skills
      ? [
          'if [ "${1:-}" = skills ] && [ "${2:-}" = --help ]; then exit 0; fi',
          'if [ "${1:-}" = skills ] && [ "${2:-}" = install ]; then [ -t 0 ] && echo "skills offer read a terminal"; exit 0; fi',
        ]
      : []),
    'echo "neuve: Unknown command: ${1:-}" >&2',
    "exit 2",
    "",
  ].join("\n");
  const files: Record<string, string> = {
    "bin/neuve": neuve,
    "lib/neuve/entire-graph": `#!/bin/sh\nprintf 'graph ${version}\\n'\n`,
    "lib/neuve/semantic/worker.py": `# encoder ${version}\n`,
    "lib/neuve/semantic/reranker_worker.py": `# reranker ${version}\n`,
    "share/neuve/notices/THIRD_PARTY_NOTICES.md": "# Third-party notices\n",
    "share/neuve/skills/manifest.json":
      '{\n  "schemaVersion": 1,\n  "skills": []\n}\n',
  };
  for (const [path, data] of Object.entries(files)) {
    await mkdir(dirname(join(stage, path)), { recursive: true });
    await writeFile(join(stage, path), data, {
      mode:
        path.startsWith("bin/") || path.endsWith("entire-graph")
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
    source: { commit: null, dirty: false },
    semantic: {
      encoder: await entry("lib/neuve/semantic/worker.py"),
      reranker: await entry("lib/neuve/semantic/reranker_worker.py"),
    },
  });
  await writeFile(
    join(stage, "lib/neuve/install.json.in"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  const release = releaseSchema.parse({
    schemaVersion: 1,
    version,
    target: TARGET,
    repository: "NeuveAI/neuve",
    cliSha256: await hash(join(stage, "bin/neuve")),
    commit: null,
    dirty: false,
    graphRevision: null,
    files: [
      "bin/neuve",
      "lib/neuve",
      "share/neuve/notices",
      "share/neuve/skills",
    ],
  });
  await writeFile(
    join(stage, "lib/neuve/release.json"),
    `${JSON.stringify(release, null, 2)}\n`,
  );
  await options.plant?.(stage);
  const assets = join(directory, "assets");
  await mkdir(assets);
  const archive = join(assets, ASSET);
  const packed = Bun.spawnSync(
    [
      "tar",
      "--no-xattrs",
      "-czf",
      archive,
      ...(options.tarArgs ?? []),
      "-C",
      content,
      name,
    ],
    { env: { ...process.env, COPYFILE_DISABLE: "1" }, stderr: "pipe" },
  );
  if (packed.exitCode !== 0) throw new Error(packed.stderr.toString());
  await writeFile(join(assets, "install.sh"), await readFile(installer));
  await writeChecksums(assets);
  return { directory, archive, sums: join(assets, "SHA256SUMS"), version };
};

export interface Scratch {
  readonly directory: string;
  readonly home: string;
  readonly prefix: string;
  readonly temporary: string;
  readonly cli: string;
  readonly log: string;
  env: Record<string, string>;
}

/** A scratch HOME (zsh, its own ZDOTDIR) and a default prefix, with no Bun, Go or gh on PATH. */
export const scratch = async (): Promise<Scratch> => {
  const directory = await scratchDirectory("neuve-install-test-");
  const home = join(directory, "home");
  const temporary = join(directory, "tmp");
  await mkdir(home);
  await mkdir(temporary);
  const prefix = join(home, ".neuve");
  const log = join(directory, "calls.log");
  return {
    directory,
    home,
    prefix,
    temporary,
    cli: join(prefix, "bin/neuve"),
    log,
    env: {
      HOME: home,
      TMPDIR: temporary,
      SHELL: "/bin/zsh",
      ZDOTDIR: home,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "C",
      NEUVE_TEST_LOG: log,
      // These fixtures test the download and install steps. The background agent has its own
      // tests (distribution, systemd-installer), so a stand-in CLI that registers none skips it.
      NEUVE_NO_AGENT: "1",
      // A GitHub CLI already on the host (Linux runners have one in /usr/bin) keeps its state and
      // configuration here, outside the home the tests snapshot. Not signed in, it changes no route.
      GH_CONFIG_DIR: join(directory, "gh-config"),
      XDG_STATE_HOME: join(directory, "state"),
      GH_NO_UPDATE_NOTIFIER: "1",
    },
  };
};

export const run = async (
  argv: ReadonlyArray<string>,
  env: Record<string, string>,
  options: Readonly<{ cwd?: string; stdin?: string }> = {},
) => {
  const child = Bun.spawn([...argv], {
    env,
    cwd: options.cwd ?? root,
    stdin:
      options.stdin === undefined
        ? "ignore"
        : new TextEncoder().encode(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code, output: stdout + stderr };
};

export const install = (
  context: Scratch,
  release: TinyRelease | undefined,
  extra: ReadonlyArray<string> = [],
  shell = "sh",
) =>
  run(
    [
      shell,
      installer,
      ...(release === undefined
        ? []
        : ["--archive", release.archive, "--checksums", release.sums]),
      ...extra,
    ],
    context.env,
  );

/** Every path under `path` with its kind, mode and content hash, without following links. */
export const snapshot = async (
  path: string,
  relative = "",
): Promise<Record<string, string>> => {
  const result: Record<string, string> = {};
  const entries = await readdir(join(path, relative), {
    withFileTypes: true,
  }).catch(() => []);
  for (const entry of entries) {
    const name = join(relative, entry.name);
    const full = join(path, name);
    const mode = (await lstat(full)).mode & 0o7777;
    if (entry.isSymbolicLink()) result[name] = `link:${await readlink(full)}`;
    else if (entry.isDirectory()) {
      result[name] = `directory:${mode}`;
      Object.assign(result, await snapshot(path, name));
    } else result[name] = `${mode}:${await hash(full)}`;
  }
  return result;
};

/** Every regular file under `path` that contains `needle`. */
export const filesContaining = async (
  path: string,
  needle: string,
): Promise<Array<string>> => {
  const found: Array<string> = [];
  const visit = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && (await stat(full)).size < 64 * 1024 * 1024)
        if ((await readFile(full)).includes(needle)) found.push(full);
    }
  };
  await visit(path);
  return found;
};

/** A folder of executable shell scripts to put first on PATH. */
export const stubs = async (scripts: Record<string, string>) => {
  const directory = await scratchDirectory("neuve-stubs-");
  for (const [name, body] of Object.entries(scripts))
    await writeFile(join(directory, name), body, { mode: 0o755 });
  return directory;
};

/** Every call the stub gh recorded: its working directory and each argument as it was given. */
export const ghInvocations = async (
  ghLog: string,
): Promise<Array<{ cwd: string; args: Array<string> }>> => {
  if (!(await Bun.file(ghLog).exists())) return [];
  return (await readFile(ghLog, "utf8"))
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [cwd = "", ...args] = line.split("\x1f");
      return { cwd, args };
    });
};

/** git in a scratch repository, with no global or system configuration. */
export const git = (cwd: string, ...args: Array<string>) => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.toString().trim();
};

export interface Checkout {
  readonly root: string;
  readonly head: string;
  readonly graph: string;
  readonly ghLog: string;
  readonly env: Record<string, string>;
}

/** A checkout on origin/main with a Graph pointer, a check receipt, and a stub gh. */
export const releaseCheckout = async (): Promise<Checkout> => {
  const root = await scratchDirectory("neuve-release-checkout-");
  const graphRoot = join(root, "apps/neuve-graph");
  await mkdir(graphRoot, { recursive: true });
  for (const cwd of [root, graphRoot]) {
    git(cwd, "init", "--quiet", "-b", "main");
    git(cwd, "config", "user.name", "Release test");
    git(cwd, "config", "user.email", "release@example.test");
  }
  await writeFile(join(graphRoot, "go.mod"), "module example.test/graph\n");
  git(graphRoot, "add", ".");
  git(graphRoot, "commit", "--quiet", "-m", "graph");
  const graph = git(graphRoot, "rev-parse", "HEAD");
  await mkdir(join(root, "scripts"));
  await writeFile(join(root, "scripts/install.sh"), await readFile(installer));
  await writeFile(join(root, ".gitignore"), "/dist/\n");
  git(root, "add", "scripts", ".gitignore");
  git(
    root,
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${graph},apps/neuve-graph`,
  );
  git(root, "commit", "--quiet", "-m", "release source");
  const head = git(root, "rev-parse", "HEAD");
  git(root, "update-ref", "refs/remotes/origin/main", head);
  await mkdir(join(root, ".git/neuve-check"));
  await writeFile(
    join(root, ".git/neuve-check", `${head}.json`),
    JSON.stringify({
      version: 1,
      commit: head,
      branch: "main",
      at: "2026-11-13T12:00:00.000Z",
    }),
  );
  // Its own folder: two checkouts made in the same second share their commit ids.
  const ghLog = join(await scratchDirectory("neuve-gh-log-"), "gh.log");
  const shim = await stubs({
    gh: [
      "#!/bin/sh",
      // One line per call: its working directory, then each argument after a unit separator.
      `{ printf '%s' "$(pwd -P)"; for a in "$@"; do printf '\\037%s' "$a"; done; printf '\\n'; } >>"${ghLog}"`,
      'case "$1 $2" in',
      '  "release list") printf "%s" "${STUB_TAGS:-}"; exit 0 ;;',
      '  "release create") echo "https://github.com/NeuveAI/neuve/releases/tag/$3"; exit 0 ;;',
      "esac",
      'if [ "$1" = api ]; then',
      '  if [ "${STUB_TAG_EXISTS:-0}" = 1 ]; then echo 0123abcd; exit 0; fi',
      '  echo "gh: Not Found (HTTP 404)" >&2; exit 1',
      "fi",
      "exit 1",
      "",
    ].join("\n"),
  });
  return {
    root,
    head,
    graph,
    ghLog,
    env: {
      ...(process.env as Record<string, string>),
      PATH: `${shim}:${process.env.PATH}`,
      STUB_TAGS: "v0.0.9\nv0.1.0-preview.1\nnot-a-version\n",
    },
  };
};
