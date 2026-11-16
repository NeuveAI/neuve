import { setPriority } from "node:os";
import { posix } from "node:path";
import {
  ECOSYSTEM_CAPABILITIES,
  UNREAD_LOCKFILES,
  pinKey,
  type EcosystemCapability,
  type Gap,
  type Pin,
  type RegistryConfig,
} from "./capability.ts";

/**
 * Reads a repository's stack pins at one commit, from git objects only (10.34, proposal SC4): the
 * lockfiles and committed registry configuration every capability declares, wherever they sit in
 * the tree outside the folders capabilities declare as installed dependencies. Never the working
 * tree, never user-level configuration.
 */

export interface RepositoryGit {
  /** Runs git in the user's repository; read-only object commands only. */
  readonly run: (
    args: ReadonlyArray<string>,
    stdin?: string,
  ) => Promise<Uint8Array>;
}

/** Git in the user's repository at nice 10, for reads of objects. */
export const repositoryGit = (
  repository: string,
  env?: Readonly<Record<string, string>>,
  gitPath = "git",
  signal?: AbortSignal,
): RepositoryGit => ({
  run: async (args, stdin) => {
    const child = Bun.spawn([gitPath, "-C", repository, ...args], {
      stdin: stdin === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
      ...(env === undefined ? {} : { env: { ...env } }),
      ...(signal === undefined ? {} : { signal }),
    });
    try {
      setPriority(child.pid, 10);
    } catch {
      // A sandbox may refuse; the read still runs.
    }
    if (stdin !== undefined && child.stdin !== undefined) {
      child.stdin.write(stdin);
      await child.stdin.end();
    }
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).bytes(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0)
      throw new Error(
        `git ${args[0] ?? ""} failed: ${stderr.trim().slice(0, 300)}`,
      );
    return stdout;
  },
});

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

export interface RevisionPins {
  readonly commit: string;
  readonly pins: ReadonlyArray<Pin>;
  readonly gaps: ReadonlyArray<Gap>;
  /** The lockfiles read, with their blob OIDs, for refresh keys. */
  readonly lockfiles: ReadonlyArray<{
    readonly path: string;
    readonly blob: string;
  }>;
}

export interface DetectOptions {
  /** The user says their default registry is a private one: every entry becomes a gap (SC4). */
  readonly privateDefaultRegistry: boolean;
  readonly capabilities?: ReadonlyArray<EcosystemCapability>;
}

/** Whether a path lies in a folder any capability declares as installed dependencies. */
const isInstalled = (
  capabilities: ReadonlyArray<EcosystemCapability>,
  path: string,
) =>
  path
    .split("/")
    .some((part) =>
      capabilities.some((capability) =>
        capability.installFolders.includes(part),
      ),
    );

/** Blob contents by OID through one `cat-file --batch`. */
const readBlobs = async (git: RepositoryGit, oids: ReadonlyArray<string>) => {
  const out = new Map<string, Uint8Array>();
  if (oids.length === 0) return out;
  const bytes = await git.run(["cat-file", "--batch"], `${oids.join("\n")}\n`);
  let at = 0;
  for (const oid of oids) {
    const newline = bytes.indexOf(10, at);
    const header = text(bytes.subarray(at, newline)).split(" ");
    const size = Number(header[2]);
    if (header[1] !== "blob" || !Number.isFinite(size)) {
      at = newline + 1;
      continue;
    }
    out.set(oid, bytes.slice(newline + 1, newline + 1 + size));
    at = newline + 1 + size + 1;
  }
  return out;
};

/** Every capability's pins and gaps at `commit`. */
export const detectPins = async (
  git: RepositoryGit,
  commit: string,
  options: DetectOptions,
): Promise<RevisionPins> => {
  const capabilities = options.capabilities ?? ECOSYSTEM_CAPABILITIES;
  const listing = text(
    await git.run(["ls-tree", "-r", "-z", "--full-tree", commit]),
  )
    .split("\0")
    .filter((line) => line !== "")
    .map((line) => {
      const tab = line.indexOf("\t");
      const [, type = "", oid = ""] = line.slice(0, tab).split(/ +/);
      return { type, oid, path: line.slice(tab + 1) };
    })
    .filter(
      (entry) =>
        entry.type === "blob" && !isInstalled(capabilities, entry.path),
    );
  const byName = (names: ReadonlyArray<string>) =>
    listing.filter((entry) => names.includes(posix.basename(entry.path)));
  const gaps: Array<Gap> = [];
  const pins = new Map<string, Pin>();
  const lockfiles: Array<{ path: string; blob: string }> = [];
  const readDirectories = new Set<string>();
  for (const capability of capabilities) {
    const locks = byName(capability.lockfiles);
    const configs = byName(capability.registryConfigs);
    const blobs = await readBlobs(git, [
      ...new Set([...locks, ...configs].map((entry) => entry.oid)),
    ]);
    for (const lock of locks) {
      const directory = posix.dirname(lock.path);
      readDirectories.add(directory);
      lockfiles.push({ path: lock.path, blob: lock.oid });
      const content = blobs.get(lock.oid);
      if (content === undefined) continue;
      // The repository root's configuration, then the lockfile's own folder's.
      let registry: RegistryConfig = { scopes: new Map() };
      for (const config of configs
        .filter((entry) => {
          const dir = posix.dirname(entry.path);
          return dir === "." || dir === directory;
        })
        .sort(
          (a, b) => posix.dirname(a.path).length - posix.dirname(b.path).length,
        )) {
        const raw = blobs.get(config.oid);
        if (raw === undefined) continue;
        const read = capability.readRegistryConfig(
          posix.basename(config.path),
          text(raw),
        );
        registry = {
          ...((read.defaultHost ?? registry.defaultHost) === undefined
            ? {}
            : {
                defaultHost: (read.defaultHost ??
                  registry.defaultHost) as string,
              }),
          scopes: new Map([...registry.scopes, ...read.scopes]),
        };
      }
      const read = capability.readLockfile(text(content));
      for (const gap of read.gaps) gaps.push({ ...gap, path: lock.path });
      const publicHost = capability.registry.host;
      const privateDefault =
        options.privateDefaultRegistry ||
        (registry.defaultHost !== undefined &&
          registry.defaultHost !== publicHost);
      for (const found of read.pins) {
        const key = pinKey(capability.ecosystem, found.name, found.version);
        const disclose = (reason: Gap["reason"], detail: string) =>
          gaps.push({ reason, detail, key, path: lock.path });
        if (!capability.registry.validName(found.name)) {
          disclose("invalid-name", `${found.name} is not a valid package name`);
          continue;
        }
        if (!capability.registry.validVersion(found.version)) {
          disclose(
            "invalid-name",
            `${found.name}@${found.version}: not an exact version`,
          );
          continue;
        }
        if (capability.registry.hashOf(found.integrity) !== capability.hash) {
          disclose(
            "no-hash",
            `${found.name}@${found.version} has no ${capability.hash} hash in ${lock.path}`,
          );
          continue;
        }
        const scope = capability.registry.scopeOf(found.name);
        const scopedHost =
          scope === undefined ? undefined : registry.scopes.get(scope);
        if (
          privateDefault ||
          (scopedHost !== undefined && scopedHost !== publicHost)
        ) {
          disclose(
            "private-registry",
            `${found.name}@${found.version} resolves through ${scopedHost ?? registry.defaultHost ?? "a private default registry (user settings)"}, not ${publicHost}; it is never looked up publicly`,
          );
          continue;
        }
        const known = pins.get(key);
        if (known !== undefined) {
          if (known.integrity !== found.integrity)
            disclose(
              "hash-mismatch",
              `${found.name}@${found.version}: ${lock.path} and ${known.lockfile} pin different hashes`,
            );
          else
            pins.set(key, {
              ...known,
              workspaces: [
                ...new Set([
                  ...known.workspaces,
                  ...found.workspaces.map(
                    (w) => `${directory === "." ? "" : `${directory}/`}${w}`,
                  ),
                ]),
              ],
            });
          continue;
        }
        pins.set(key, {
          key,
          ecosystem: capability.ecosystem,
          name: found.name,
          version: found.version,
          integrity: found.integrity,
          lockfile: lock.path,
          workspaces: found.workspaces.map(
            (w) => `${directory === "." ? "" : `${directory}/`}${w}`,
          ),
        });
      }
    }
    if (locks.length === 0) {
      const manifest = byName(capability.manifests).sort(
        (a, b) => a.path.length - b.path.length,
      )[0];
      const unread = byName(UNREAD_LOCKFILES.map((entry) => entry.name)).filter(
        (entry) =>
          UNREAD_LOCKFILES.some(
            (lock) =>
              lock.name === posix.basename(entry.path) &&
              lock.ecosystem === capability.ecosystem,
          ),
      );
      if (manifest !== undefined && unread.length === 0)
        gaps.push({
          reason: "no-lockfile",
          detail: `${manifest.path} has no lockfile beside it, so it pins nothing`,
          path: manifest.path,
        });
    }
  }
  for (const entry of byName(UNREAD_LOCKFILES.map((lock) => lock.name)))
    if (!readDirectories.has(posix.dirname(entry.path)))
      gaps.push({
        reason: "no-capability",
        detail: `no capability reads ${posix.basename(entry.path)} yet`,
        path: entry.path,
      });
  return {
    commit,
    pins: [...pins.values()].sort((a, b) => (a.key < b.key ? -1 : 1)),
    gaps,
    lockfiles,
  };
};

/**
 * The default branch's head (SC7): what the local `refs/remotes/origin/HEAD` points at, read
 * without network; else the branch the review request is attributed to; else none, and every entry
 * is unvetted.
 */
export const defaultHead = async (
  git: RepositoryGit,
  baseRef?: string,
): Promise<string | undefined> => {
  const resolve = async (ref: string) => {
    try {
      return text(
        await git.run([
          "rev-parse",
          "--verify",
          "--quiet",
          "--end-of-options",
          `${ref}^{commit}`,
        ]),
      ).trim();
    } catch {
      return undefined;
    }
  };
  try {
    const target = text(
      await git.run(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]),
    ).trim();
    if (target !== "") {
      const commit = await resolve(target);
      if (commit !== undefined && commit !== "") return commit;
    }
  } catch {
    // No origin HEAD.
  }
  if (
    baseRef === undefined ||
    baseRef.startsWith("-") ||
    baseRef.includes("..")
  )
    return undefined;
  for (const ref of [
    `refs/heads/${baseRef}`,
    `refs/remotes/origin/${baseRef}`,
    baseRef,
  ]) {
    const commit = await resolve(ref);
    if (commit !== undefined && commit !== "") return commit;
  }
  return undefined;
};
