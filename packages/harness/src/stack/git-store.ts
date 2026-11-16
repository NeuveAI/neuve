import { spawn } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Data } from "effect";
import { GIT_CONFIG, TransportRefused, checkUrl } from "./transport.ts";

/**
 * Git for the stack store (proposal SC2, SC5, SC7). Every tree is its own small bare repository,
 * written once and never repacked, garbage-collected or checked with `fsck`; eviction deletes its
 * directory. Every command runs with `GIT_CONFIG` on top of an empty system and global
 * configuration and the scrubbed environment, so hooks, symlinks, credential helpers, redirects and
 * every protocol but HTTPS are off, and `GIT_NO_LAZY_FETCH=1` keeps a filtered tree from fetching
 * what it left out.
 */

export class StoreGitFailed extends Data.TaggedError("StoreGitFailed")<{
  readonly args: ReadonlyArray<string>;
  readonly exitCode: number;
  readonly message: string;
}> {}

export class UpstreamFetchStopped extends Data.TaggedError(
  "UpstreamFetchStopped",
)<{
  readonly message: string;
  readonly reason: "over-cap" | "timeout" | "failed" | "interrupted";
}> {}

/** How store git runs: which binary, and the whole environment it gets. */
export interface StoreGit {
  readonly gitPath: string;
  readonly env: Readonly<Record<string, string>>;
  /** Stops a running command with the job: a stopped child must not leave a long one behind. */
  readonly signal?: AbortSignal;
}

/**
 * The git binary store commands run, as an absolute path. On macOS `/usr/bin/git` is a shim that
 * looks the developer tools up through `xcrun` on every call, which in the scrubbed environment
 * (no cache, temporary HOME) takes seconds per call; the real binary it would run is used instead.
 */
export const resolveGitBinary = (): string | undefined => {
  const found = Bun.which("git") ?? undefined;
  if (process.platform !== "darwin" || found !== "/usr/bin/git") return found;
  const xcrun = Bun.spawnSync(["/usr/bin/xcrun", "--find", "git"], {
    stdout: "pipe",
    stderr: "ignore",
    timeout: 10_000,
  });
  const real = xcrun.success ? xcrun.stdout.toString().trim() : "";
  return real.startsWith("/") ? real : found;
};

/** The commit message and identity of the commit object made for each tree (SC8's handles). */
const COMMIT_IDENTITY = {
  GIT_AUTHOR_NAME: "Neuve stack store",
  GIT_AUTHOR_EMAIL: "stack@neuve.invalid",
  GIT_AUTHOR_DATE: "1970-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "Neuve stack store",
  GIT_COMMITTER_EMAIL: "stack@neuve.invalid",
  GIT_COMMITTER_DATE: "1970-01-01T00:00:00Z",
};

/** The promisor remote a kept upstream tree points at: a path that does not exist. */
export const UNREACHABLE_PROMISOR =
  "file:///nonexistent/neuve-stack-no-lazy-fetch";

export const runGit = async (
  git: StoreGit,
  gitDir: string | undefined,
  args: ReadonlyArray<string>,
  options: {
    readonly stdin?: string | Uint8Array;
    readonly env?: Readonly<Record<string, string>>;
    readonly allowFailure?: boolean;
  } = {},
) => {
  const full = [
    ...GIT_CONFIG,
    ...(gitDir === undefined ? [] : ["--git-dir", gitDir]),
    ...args,
  ];
  const child = Bun.spawn([git.gitPath, ...full], {
    stdin: options.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...git.env, ...options.env },
    ...(git.signal === undefined ? {} : { signal: git.signal }),
  });
  if (options.stdin !== undefined && child.stdin !== undefined) {
    child.stdin.write(options.stdin);
    await child.stdin.end();
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).bytes(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0 && options.allowFailure !== true)
    throw new StoreGitFailed({
      args,
      exitCode,
      message: stderr.trim().slice(0, 500),
    });
  return { stdout, stderr, exitCode };
};

const textOf = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/**
 * The git floor for fetching (SC7): the CVE-2024-32002 fix, in 2.45.1 or one of its backports.
 * Returns the reason a version is refused, or undefined.
 */
export const gitVersionRefusal = (versionText: string) => {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(versionText);
  if (match === null) return `cannot read a version from ${versionText.trim()}`;
  const [major, minor, patch] = match.slice(1).map(Number) as [
    number,
    number,
    number,
  ];
  const backports: Record<string, number> = {
    "2.39": 4,
    "2.40": 2,
    "2.41": 1,
    "2.42": 2,
    "2.43": 4,
    "2.44": 1,
  };
  if (major > 2 || (major === 2 && minor > 45)) return undefined;
  if (major === 2 && minor === 45 && patch >= 1) return undefined;
  const floor = backports[`${major}.${minor}`];
  if (floor !== undefined && patch >= floor) return undefined;
  return `stack fetches need git 2.45.1 or a patched release (2.39.4, 2.40.2, 2.41.1, 2.42.2, 2.43.4, 2.44.1); found ${versionText.trim()}`;
};

export const checkGitVersion = async (git: StoreGit) => {
  const { stdout } = await runGit(git, undefined, ["version"]);
  return gitVersionRefusal(textOf(stdout));
};

/** A new empty bare repository with Neuve's configuration and no template (so no sample hooks). */
export const initTreeRepository = async (git: StoreGit, gitDir: string) => {
  await runGit(git, undefined, [
    "init",
    "--bare",
    "--quiet",
    "--template=",
    gitDir,
  ]);
  for (const [key, value] of [
    ["maintenance.auto", "false"],
    ["gc.auto", "0"],
    ["core.hooksPath", "/dev/null"],
    ["core.fsmonitor", "false"],
    ["core.symlinks", "false"],
  ] as const)
    await runGit(git, gitDir, ["config", key, value]);
};

/**
 * The disk every file under `path` takes: its allocated blocks, or its size where the file system
 * reports no blocks. Small files take a whole block, so this, not the bytes written, is what the
 * caps count. Links are counted, never followed.
 */
export const directoryBytes = async (path: string): Promise<number> => {
  let total = 0;
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) total += await directoryBytes(full);
    else
      try {
        const stats = await lstat(full);
        total += stats.blocks > 0 ? stats.blocks * 512 : stats.size;
      } catch {
        // Gone while counting (a fetch's temporary pack).
      }
  }
  return total;
};

/**
 * A package's tree, from files already extracted under `folder` (SC2): each blob written with
 * `git hash-object -w --no-filters`, so the package's own `.gitattributes` and `.gitignore` change
 * nothing, and each folder with `git mktree`, deepest first; never `git add` or `update-index --add`
 * on paths. Every file is stored with mode 100644: nothing in the store is executable. Returns the
 * tree and a commit object made for it.
 */
export const writePackageTree = async (
  git: StoreGit,
  gitDir: string,
  folder: string,
  paths: ReadonlyArray<string>,
  label: string,
) => {
  const oids: Array<string> = [];
  for (let at = 0; at < paths.length; at += 2_000) {
    const group = paths.slice(at, at + 2_000);
    const { stdout } = await runGit(
      git,
      gitDir,
      ["hash-object", "-w", "--no-filters", "--stdin-paths"],
      { stdin: group.map((path) => join(folder, path)).join("\n") + "\n" },
    );
    oids.push(...textOf(stdout).trim().split("\n"));
  }
  if (oids.length !== paths.length)
    throw new StoreGitFailed({
      args: ["hash-object"],
      exitCode: 0,
      message: `wrote ${oids.length} blobs for ${paths.length} files`,
    });
  const folders = new Map<string, Array<string>>([["", []]]);
  const ensure = (dir: string) => {
    if (folders.has(dir)) return;
    folders.set(dir, []);
    const slash = dir.lastIndexOf("/");
    ensure(slash === -1 ? "" : dir.slice(0, slash));
  };
  paths.forEach((path, index) => {
    const slash = path.lastIndexOf("/");
    const dir = slash === -1 ? "" : path.slice(0, slash);
    ensure(dir);
    folders
      .get(dir)
      ?.push(`100644 blob ${oids[index]}\t${path.slice(slash + 1)}`);
  });
  const depth = (dir: string) => (dir === "" ? 0 : dir.split("/").length);
  const byDepth = [...folders.keys()].sort((a, b) => depth(b) - depth(a));
  const treeOf = new Map<string, string>();
  for (let level = depth(byDepth[0] ?? ""); level >= 0; level--) {
    const dirs = byDepth.filter((dir) => depth(dir) === level);
    if (dirs.length === 0) continue;
    const input = dirs
      .map((dir) => (folders.get(dir) ?? []).join("\n"))
      .join("\n\n");
    const { stdout } = await runGit(git, gitDir, ["mktree", "--batch"], {
      stdin: `${input}\n`,
    });
    const made = textOf(stdout).trim().split("\n");
    dirs.forEach((dir, index) => {
      const oid = made[index] ?? "";
      treeOf.set(dir, oid);
      if (dir === "") return;
      const slash = dir.lastIndexOf("/");
      const parent = slash === -1 ? "" : dir.slice(0, slash);
      folders.get(parent)?.push(`040000 tree ${oid}\t${dir.slice(slash + 1)}`);
    });
  }
  const tree = treeOf.get("") ?? "";
  const commit = await commitFor(git, gitDir, tree, label);
  return { tree, commit };
};

/** The commit object the store makes for a tree, with a fixed identity, so it is reproducible. */
export const commitFor = async (
  git: StoreGit,
  gitDir: string,
  tree: string,
  label: string,
) => {
  const { stdout } = await runGit(
    git,
    gitDir,
    ["commit-tree", tree, "-m", `neuve stack: ${label}`],
    { env: COMMIT_IDENTITY },
  );
  const commit = textOf(stdout).trim();
  await runGit(git, gitDir, ["update-ref", "refs/neuve/stack", commit]);
  return commit;
};

export interface WatchdogOptions {
  /** The directory whose size is polled each second. */
  readonly watch: string;
  readonly capBytes: number;
  readonly timeoutMs: number;
  readonly killGraceMs: number;
  readonly pollMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * Runs a command in its own process group under a byte and time watchdog (SC5): git cannot cap a
 * fetch, so the directory it writes is polled each second, and once it passes the cap, or the time
 * passes the timeout, the whole group gets SIGTERM and, after the grace, SIGKILL, so
 * `git-remote-https` and `index-pack` die with it.
 */
export const runWatched = (
  command: ReadonlyArray<string>,
  env: Readonly<Record<string, string>>,
  options: WatchdogOptions,
): Promise<{ readonly exitCode: number; readonly stderr: string }> =>
  new Promise((resolve, reject) => {
    const [file = "", ...args] = command;
    const child = spawn(file, args, {
      detached: true,
      env: { ...env },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 8_000) stderr += chunk.toString();
    });
    const started = Date.now();
    let stopped: UpstreamFetchStopped | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const group = child.pid;
    const signalGroup = (signal: NodeJS.Signals) => {
      if (group === undefined) return;
      try {
        process.kill(-group, signal);
      } catch {
        // The group is gone.
      }
    };
    const stop = (reason: UpstreamFetchStopped) => {
      if (stopped !== undefined) return;
      stopped = reason;
      signalGroup("SIGTERM");
      killTimer = setTimeout(() => signalGroup("SIGKILL"), options.killGraceMs);
    };
    const onAbort = () =>
      stop(
        new UpstreamFetchStopped({
          message: "the job was interrupted",
          reason: "interrupted",
        }),
      );
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    let polling = false;
    const poll = setInterval(() => {
      if (polling || stopped !== undefined) return;
      polling = true;
      void directoryBytes(options.watch)
        .then((bytes) => {
          if (bytes > options.capBytes)
            stop(
              new UpstreamFetchStopped({
                message: `the fetch passed its ${options.capBytes}-byte cap (${bytes} bytes) and was killed`,
                reason: "over-cap",
              }),
            );
          else if (Date.now() - started > options.timeoutMs)
            stop(
              new UpstreamFetchStopped({
                message: `the fetch passed ${Math.round(options.timeoutMs / 1000)} s and was killed`,
                reason: "timeout",
              }),
            );
        })
        .finally(() => {
          polling = false;
        });
    }, options.pollMs ?? 1_000);
    child.on("error", (error) => {
      clearInterval(poll);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearInterval(poll);
      options.signal?.removeEventListener("abort", onAbort);
      // The group may hold children that outlived git; they get the same end.
      if (stopped !== undefined) {
        if (killTimer !== undefined) clearTimeout(killTimer);
        signalGroup("SIGKILL");
        reject(stopped);
        return;
      }
      resolve({
        exitCode: code ?? (signal === null ? 1 : 128),
        stderr,
      });
    });
  });

/**
 * Fetches one commit's tree, depth 1, without blobs over the filter, into a fresh quarantine
 * repository, under the watchdog (SC5 step 1 and 2). The URL must be HTTPS to an allowed host, or
 * the protocol rules refuse it again inside git. Then the repository is made safe to keep (step 3):
 * the `remote.<url>` section the filtered fetch wrote is removed, so the real URL does not stay, and
 * the promisor remote becomes a `file:` URL that does not exist, which `protocol.allow=never` also
 * refuses, so a lazy fetch, should one start despite `GIT_NO_LAZY_FETCH=1`, fails locally.
 */
export const fetchUpstreamTree = async (
  git: StoreGit,
  gitDir: string,
  url: string,
  commit: string,
  options: {
    readonly capBytes: number;
    readonly timeoutMs: number;
    readonly killGraceMs: number;
    readonly hosts: ReadonlyArray<string>;
    readonly blobLimit: string;
    readonly signal?: AbortSignal;
    /** Tests only: the protocols git may use, in place of HTTPS. */
    readonly protocolsForTests?: ReadonlyArray<string>;
  },
) => {
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(commit))
    throw new UpstreamFetchStopped({
      message: `${commit} is not a full commit ID`,
      reason: "failed",
    });
  if (options.protocolsForTests === undefined) {
    try {
      checkUrl(url, { hosts: options.hosts });
    } catch (error) {
      if (error instanceof TransportRefused)
        throw new UpstreamFetchStopped({
          message: error.message,
          reason: "failed",
        });
      throw error;
    }
  }
  await initTreeRepository(git, gitDir);
  const protocols = (options.protocolsForTests ?? []).flatMap((protocol) => [
    "-c",
    `protocol.${protocol}.allow=always`,
  ]);
  const result = await runWatched(
    [
      git.gitPath,
      ...GIT_CONFIG,
      ...protocols,
      "--git-dir",
      gitDir,
      "fetch",
      "--quiet",
      "--depth",
      "1",
      `--filter=blob:limit=${options.blobLimit}`,
      "--no-recurse-submodules",
      "--no-tags",
      "--no-write-fetch-head",
      "--end-of-options",
      url,
      `${commit}:refs/neuve/upstream`,
    ],
    git.env,
    {
      watch: gitDir,
      capBytes: options.capBytes,
      timeoutMs: options.timeoutMs,
      killGraceMs: options.killGraceMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );
  if (result.exitCode !== 0)
    throw new UpstreamFetchStopped({
      message: `git fetch exited ${result.exitCode}: ${result.stderr.trim().slice(0, 300)}`,
      reason: "failed",
    });
  const size = await directoryBytes(gitDir);
  if (size > options.capBytes)
    throw new UpstreamFetchStopped({
      message: `the fetched tree takes ${size} bytes, over its ${options.capBytes}-byte cap`,
      reason: "over-cap",
    });
  // Step 3: keep the filtered pack valid to git, with nothing that could reach the network.
  const { stdout } = await runGit(
    git,
    gitDir,
    ["config", "--name-only", "--get-regexp", "^remote\\."],
    { allowFailure: true },
  );
  const sections = new Set(
    textOf(stdout)
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => line.slice(0, line.lastIndexOf("."))),
  );
  for (const section of sections)
    await runGit(git, gitDir, ["config", "--remove-section", section]);
  for (const [key, value] of [
    ["remote.neuve-unreachable.url", UNREACHABLE_PROMISOR],
    ["remote.neuve-unreachable.promisor", "true"],
    [
      "remote.neuve-unreachable.partialclonefilter",
      `blob:limit=${options.blobLimit}`,
    ],
    ["extensions.partialClone", "neuve-unreachable"],
  ] as const)
    await runGit(git, gitDir, ["config", key, value]);
  const tree = textOf(
    (await runGit(git, gitDir, ["rev-parse", "--verify", `${commit}^{tree}`]))
      .stdout,
  ).trim();
  return { tree, objectBytes: size };
};

export interface StoreTreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly oid: string;
  readonly path: string;
}

/** Every entry of a tree, recursively, without sizes (`-l` would ask for the filtered blobs). */
export const listTree = async (
  git: StoreGit,
  gitDir: string,
  tree: string,
): Promise<ReadonlyArray<StoreTreeEntry>> => {
  const { stdout } = await runGit(git, gitDir, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    tree,
  ]);
  return textOf(stdout)
    .split("\0")
    .filter((line) => line !== "")
    .map((line) => {
      const tab = line.indexOf("\t");
      const [mode = "", type = "", oid = ""] = line.slice(0, tab).split(/ +/);
      return { mode, type, oid, path: line.slice(tab + 1) };
    });
};

/**
 * Blob contents by OID; a blob the filter left out is reported missing, never fetched. Read in
 * groups of at most `groupBytes`, so a large tree is never held at once.
 */
export const readStoreBlobs = async function* (
  git: StoreGit,
  gitDir: string,
  oids: ReadonlyArray<string>,
  groupBytes = 16 * 1024 * 1024,
): AsyncGenerator<{ readonly oid: string; readonly bytes: Uint8Array | null }> {
  const unique = [...new Set(oids)];
  const sizes = new Map<string, number | null>();
  for (let at = 0; at < unique.length; at += 5_000) {
    const group = unique.slice(at, at + 5_000);
    const { stdout } = await runGit(
      git,
      gitDir,
      ["cat-file", "--batch-check"],
      {
        stdin: `${group.join("\n")}\n`,
      },
    );
    for (const line of textOf(stdout).split("\n")) {
      if (line === "") continue;
      const [oid = "", type = "", size = ""] = line.split(" ");
      sizes.set(oid, type === "blob" ? Number(size) : null);
    }
  }
  let group: Array<string> = [];
  let bytes = 0;
  const flush = async function* () {
    if (group.length === 0) return;
    const { stdout } = await runGit(git, gitDir, ["cat-file", "--batch"], {
      stdin: `${group.join("\n")}\n`,
    });
    let at = 0;
    for (const oid of group) {
      const newline = stdout.indexOf(10, at);
      const header = textOf(stdout.subarray(at, newline));
      const size = Number(header.split(" ")[2]);
      if (header.endsWith(" missing") || !Number.isFinite(size)) {
        at = newline + 1;
        yield { oid, bytes: null };
        continue;
      }
      yield { oid, bytes: stdout.slice(newline + 1, newline + 1 + size) };
      at = newline + 1 + size + 1;
    }
    group = [];
    bytes = 0;
  };
  for (const oid of unique) {
    const size = sizes.get(oid);
    if (size === undefined || size === null) {
      yield { oid, bytes: null };
      continue;
    }
    if (bytes + size > groupBytes && group.length > 0) yield* flush();
    group.push(oid);
    bytes += size;
  }
  yield* flush();
};
