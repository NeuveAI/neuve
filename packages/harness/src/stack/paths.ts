/**
 * Path rules for everything the stack store writes to disk (proposal SC7): fetched archives and
 * upstream trees are untrusted, and an inner-loop agent, or an editor, may run git inside the
 * extracted folders. Git reads a repository's configuration, which can name a command to run
 * (`core.fsmonitor`), wherever it finds one, so two shapes are kept out:
 *
 * - any path component git would treat as `.git`, which refuses the whole archive;
 * - any folder git would take for a bare repository (a `HEAD` beside `objects`, `refs` or
 *   `commondir`): its `HEAD` is left out and counted, so the folder no longer passes git's check.
 *
 * Absolute paths, `..`, control characters and backslashes refuse the archive too, as do two paths
 * that collide the way the default macOS disk (APFS, case-insensitive and normalisation-insensitive)
 * compares names, since one would overwrite the other.
 */

/** Code points HFS+ ignores when it compares names, which git strips before its `.git` check. */
const HFS_IGNORABLE =
  /[\u200c\u200d\u200e\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;

/**
 * A name as a case-insensitive, normalisation-insensitive disk compares it: full Unicode case
 * folding (upper then lower case, so `ß` meets `ss` and `ς` meets `σ`) on the decomposed form.
 */
export const foldName = (name: string) =>
  name.normalize("NFD").toUpperCase().toLowerCase().normalize("NFD");

/** A component as git compares it with its own names on such disks, ignorables removed. */
const gitFold = (component: string) =>
  foldName(component.replace(HFS_IGNORABLE, "")).replace(HFS_IGNORABLE, "");

/**
 * Whether git would treat a path component as `.git`: case-insensitively, after removing the code
 * points HFS+ ignores, and with the trailing dots and spaces NTFS drops; also NTFS's short name
 * `git~1`.
 */
export const isGitComponent = (component: string) => {
  const folded = gitFold(component).replace(/[. ]+$/, "");
  return folded === ".git" || folded === "git~1";
};

export type PathRefusal =
  | "absolute"
  | "parent"
  | "git-component"
  | "control-character"
  | "backslash"
  | "empty";

/** Why a relative path may not be written, or undefined when it may. */
export const pathRefusal = (path: string): PathRefusal | undefined => {
  if (path === "") return "empty";
  if (path.startsWith("/")) return "absolute";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) return "control-character";
  if (path.includes("\\")) return "backslash";
  for (const component of path.split("/")) {
    if (component === "..") return "parent";
    if (isGitComponent(component)) return "git-component";
  }
  return undefined;
};

/** A relative path with empty and `.` components removed; never resolves `..`. */
export const cleanPath = (path: string) =>
  path
    .split("/")
    .filter((component) => component !== "" && component !== ".")
    .join("/");

/**
 * The `HEAD` files that would make their folder pass git's bare-repository check: a `HEAD` beside
 * `objects`, `refs` or `commondir` (any of the three, of any type: stricter than git, which also
 * wants a valid `HEAD`), compared as the disk compares names. The folder of the root counts too.
 * Leaving these out is enough: without `HEAD` git never takes the folder for a repository.
 */
export const bareRepositoryHeads = (
  paths: Iterable<string>,
): ReadonlySet<string> => {
  const children = new Map<string, Map<string, Array<string>>>();
  const add = (folder: string, name: string, path: string) => {
    let named = children.get(folder);
    if (named === undefined) children.set(folder, (named = new Map()));
    const key = gitFold(name);
    named.set(key, [...(named.get(key) ?? []), path]);
  };
  for (const path of paths) {
    const parts = path.split("/");
    for (let end = 1; end <= parts.length; end++)
      add(
        parts.slice(0, end - 1).join("/"),
        parts[end - 1] ?? "",
        end === parts.length ? path : "",
      );
  }
  const heads = new Set<string>();
  for (const named of children.values()) {
    const head = named.get(gitFold("HEAD"));
    if (head === undefined) continue;
    if (
      !["objects", "refs", "commondir"].some((name) => named.has(gitFold(name)))
    )
      continue;
    for (const path of head) if (path !== "") heads.add(path);
  }
  return heads;
};

/**
 * Collects the paths of one archive or tree and reports the first collision: two files under one
 * folded name, or a file whose folded name is also a folder's.
 */
export class CollisionCheck {
  readonly #files = new Set<string>();
  readonly #folders = new Set<string>();

  /** Adds a file path; returns the reason it collides, or undefined. */
  add(path: string): string | undefined {
    const key = foldName(path);
    if (this.#files.has(key) || this.#folders.has(key))
      return `${path} collides with another path under case folding or Unicode normalisation`;
    const parts = key.split("/");
    for (let end = 1; end < parts.length; end++) {
      const folder = parts.slice(0, end).join("/");
      if (this.#files.has(folder))
        return `${path} lies under a path that is also a file`;
      this.#folders.add(folder);
    }
    this.#files.add(key);
    return undefined;
  }
}
