import type { Gap, LockfileRead } from "./capability.ts";

/**
 * The `bun.lock` reader (proposal SC4): Bun's text lockfile, the default since Bun 1.2. Each
 * workspace lists its direct dependencies by name; each package entry is
 * `["name@version", "<registry, or empty for the default>", {metadata}, "sha512-…"]`, keyed by the
 * name, or by `<workspace name>/<name>` where a workspace resolves a version of its own. Direct
 * dependencies (runtime, development and optional) of every workspace are read, at their exact
 * resolved version, registry and hash; workspace and link packages are the repository itself and are
 * skipped, and git, file and tarball-URL dependencies are disclosed, never fetched.
 */

type Workspace = {
  readonly name?: unknown;
  readonly dependencies?: unknown;
  readonly devDependencies?: unknown;
  readonly optionalDependencies?: unknown;
};

const SOURCE_PREFIXES =
  /^(?:git\+|git:|github:|gitlab:|bitbucket:|https?:|file:)/;
const LOCAL_PREFIXES = /^(?:workspace:|link:)/;

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export const readBunLock = (text: string): LockfileRead => {
  let lock: Record<string, unknown>;
  try {
    lock = record(Bun.JSONC.parse(text));
  } catch (error) {
    return {
      pins: [],
      gaps: [
        {
          reason: "unreadable-lockfile",
          detail: `bun.lock does not parse: ${String(error).slice(0, 200)}`,
        },
      ],
    };
  }
  const version = lock["lockfileVersion"];
  if (typeof version !== "number" || version < 0 || version > 2)
    return {
      pins: [],
      gaps: [
        {
          reason: "unreadable-lockfile",
          detail: `bun.lock declares lockfileVersion ${JSON.stringify(version)}, which this reader does not know`,
        },
      ],
    };
  const workspaces = record(lock["workspaces"]);
  const packages = record(lock["packages"]);
  const gaps: Array<Gap> = [];
  const pins = new Map<
    string,
    {
      name: string;
      version: string;
      integrity: string;
      workspaces: Array<string>;
    }
  >();
  for (const [path, raw] of Object.entries(workspaces)) {
    const workspace = raw as Workspace;
    const workspaceName =
      typeof workspace.name === "string" ? workspace.name : undefined;
    const label = path === "" ? "(root)" : path;
    const direct = {
      ...record(workspace.optionalDependencies),
      ...record(workspace.devDependencies),
      ...record(workspace.dependencies),
    };
    for (const [dependency, range] of Object.entries(direct)) {
      if (typeof range === "string" && LOCAL_PREFIXES.test(range)) continue;
      const entry =
        (workspaceName === undefined
          ? undefined
          : packages[`${workspaceName}/${dependency}`]) ?? packages[dependency];
      if (!Array.isArray(entry) || typeof entry[0] !== "string") {
        gaps.push({
          reason: "unreadable-lockfile",
          detail: `${label} depends on ${dependency}, which bun.lock does not resolve`,
        });
        continue;
      }
      const ident = entry[0];
      const at = ident.lastIndexOf("@");
      const name = at > 0 ? ident.slice(0, at) : ident;
      const resolved = at > 0 ? ident.slice(at + 1) : "";
      if (LOCAL_PREFIXES.test(resolved)) continue;
      if (SOURCE_PREFIXES.test(resolved) || resolved.includes("/")) {
        gaps.push({
          reason: "not-a-registry-package",
          detail: `${name} resolves to ${resolved.split("#")[0]?.slice(0, 120)}, a git, file or tarball source; only registry packages are fetched`,
        });
        continue;
      }
      const registry = typeof entry[1] === "string" ? entry[1] : "";
      if (registry !== "") {
        let host = registry;
        try {
          host = new URL(registry).hostname;
        } catch {
          // Shown as written.
        }
        gaps.push({
          reason: "private-registry",
          detail: `${name}@${resolved} resolves through ${host}, not the default registry; it is never looked up publicly`,
        });
        continue;
      }
      const integrity = entry.find(
        (part, index) =>
          index > 0 &&
          typeof part === "string" &&
          /^sha(?:512|384|256|1)-/.test(part),
      ) as string | undefined;
      if (integrity === undefined) {
        gaps.push({
          reason: "no-hash",
          detail: `${name}@${resolved} has no hash in bun.lock, so its contents could not be verified`,
        });
        continue;
      }
      const id = `${name}@${resolved}\0${integrity}`;
      const known = pins.get(id);
      if (known !== undefined) {
        if (!known.workspaces.includes(label)) known.workspaces.push(label);
      } else
        pins.set(id, {
          name,
          version: resolved,
          integrity,
          workspaces: [label],
        });
    }
  }
  return {
    pins: [...pins.values()].sort((a, b) =>
      a.name === b.name
        ? a.version < b.version
          ? -1
          : 1
        : a.name < b.name
          ? -1
          : 1,
    ),
    gaps,
  };
};
