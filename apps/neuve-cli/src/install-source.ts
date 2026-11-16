import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

/**
 * The branches a checkout may install the shared copy from (12.24): `main`, and during the
 * transition the branch the coordinator integrates reviewed work into (12.4). A lane's branch, or
 * any other, never replaces it; a lane installs a private copy under its own prefix.
 */
export const INTEGRATION_BRANCHES: ReadonlyArray<string> = [
  "main",
  "codex/pi-transition",
];

/**
 * Whether this process runs in check mode (12.24): `bun run check`, its typecheck and tests mark
 * themselves with `NEUVE_MODE=check`, `bun test` sets `NODE_ENV=test`, and CI sets `CI`. Check mode
 * never writes the shared installed copy; an install aimed at it fails.
 */
export const checkContext = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined => {
  if (env["NEUVE_MODE"] === "check") return "NEUVE_MODE=check";
  if (env["NODE_ENV"] === "test") return "NODE_ENV=test";
  if (env["CI"] !== undefined && env["CI"] !== "" && env["CI"] !== "false")
    return "CI";
  return undefined;
};

let account: string | null | undefined;

/**
 * This account's home from the system's account database, read once per process. Bun's
 * `userInfo().homedir` follows `HOME`, so the database is asked directly: `dscl` on macOS, `getent`
 * elsewhere, and where neither answers (a sandbox blocks `dscl`), the shell's `~name`, which reads
 * the same database. Null when none answers: then no prefix can be shown to be scratch.
 */
const accountHome = () => {
  if (account !== undefined) return account;
  const run = (command: ReadonlyArray<string>) => {
    try {
      const result = Bun.spawnSync([...command], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      });
      return result.exitCode === 0 ? result.stdout.toString().trim() : "";
    } catch {
      return "";
    }
  };
  const absolute = (path: string | undefined) =>
    path !== undefined && path.startsWith("/") ? path : null;
  const name = run(["id", "-un"]);
  let found: string | null = null;
  if (process.platform === "darwin") {
    const entry = run([
      "dscl",
      ".",
      "-read",
      `/Users/${name}`,
      "NFSHomeDirectory",
    ]);
    found = absolute(/^NFSHomeDirectory:\s+(\/.*)$/.exec(entry)?.[1]);
  } else {
    const uid = process.getuid?.();
    if (uid !== undefined)
      found = absolute(run(["getent", "passwd", String(uid)]).split(":")[5]);
  }
  // The name goes into a shell word only when it is a plain account name.
  if (found === null && /^[A-Za-z0-9._][A-Za-z0-9._-]*$/.test(name))
    found = absolute(run(["/bin/sh", "-c", `echo ~${name}`]));
  account = found;
  return account;
};

/**
 * The prefixes that are the shared copy: `.local` under `HOME` and under the account's own home from
 * the account database, which differ when `HOME` points elsewhere. Any of them is shared.
 */
export const sharedPrefixes = (): ReadonlyArray<string> => {
  const homes = new Set<string>([homedir()]);
  for (const home of [userInfo().homedir, accountHome()])
    if (home) homes.add(home);
  return [...homes].map((home) => join(home, ".local"));
};

/**
 * Every folder an install writes into or creates under a prefix: the prefix, `bin`, `lib`,
 * `lib/neuve` and the folders inside it (`installLayout`'s). Any of them may be a link elsewhere.
 */
export const layoutFolders = (prefix: string): ReadonlyArray<string> => {
  const root = resolve(prefix);
  const lib = join(root, "lib/neuve");
  return [
    root,
    join(root, "bin"),
    join(root, "lib"),
    lib,
    join(lib, "semantic"),
  ];
};

interface Place {
  /** The device and inode of the path itself, when it exists. */
  readonly node: { readonly dev: number; readonly ino: number } | undefined;
  /** The nearest existing ancestor's device and inode, and the names below it. */
  readonly ancestor: { readonly dev: number; readonly ino: number };
  readonly rest: string;
  /** The real path through that ancestor. */
  readonly real: string;
}

/**
 * Where a path lands on disk, through symlinks (dangling ones too), firmlinks and case: the device
 * and inode of the path or of its nearest existing ancestor. Two spellings of one folder share it.
 */
const placeOf = (path: string): Place => {
  let current = resolve(path);
  const rest: Array<string> = [];
  for (let hops = 0; hops < 64; hops += 1) {
    try {
      const real = realpathSync.native(current);
      const stats = statSync(real);
      const id = { dev: stats.dev, ino: stats.ino };
      return {
        node: rest.length === 0 ? id : undefined,
        ancestor: id,
        rest: rest.toReversed().join("/"),
        real: join(real, ...rest.toReversed()),
      };
    } catch {
      // A dangling symlink leads where it points; anything else, to its parent.
      const link = (() => {
        try {
          return lstatSync(current).isSymbolicLink()
            ? readlinkSync(current)
            : undefined;
        } catch {
          return undefined;
        }
      })();
      if (link !== undefined) {
        current = resolve(dirname(current), link);
        continue;
      }
      const parent = dirname(current);
      if (parent === current) break;
      rest.push(basename(current));
      current = parent;
    }
  }
  return {
    node: undefined,
    ancestor: { dev: -1, ino: -1 },
    rest: "",
    real: resolve(path),
  };
};

/** Names compare without case on macOS, whose volumes usually ignore it; a false match only refuses. */
const fold = (text: string) =>
  process.platform === "darwin" ? text.toLowerCase() : text;

const samePlace = (a: Place, b: Place) =>
  a.node !== undefined && b.node !== undefined
    ? a.node.dev === b.node.dev && a.node.ino === b.node.ino
    : (a.ancestor.dev === b.ancestor.dev &&
        a.ancestor.ino === b.ancestor.ino &&
        fold(a.rest) === fold(b.rest)) ||
      fold(a.real) === fold(b.real);

/**
 * Whether an install under `prefix` would write the shared copy (12.24), decided per destination:
 * every folder it writes into (`layoutFolders`) is placed on disk and compared with every folder of
 * every shared layout, so a scratch prefix whose `bin` or `lib` links into the shared copy is the
 * shared copy, and so is any other spelling of it. When the account's home cannot be read, no
 * prefix can be shown to be scratch, and every one counts as shared. `alsoShared` adds prefixes
 * that count as shared too (a test's stand-in); it can only make an install stricter.
 */
export const isSharedPrefix = (
  prefix: string,
  alsoShared: ReadonlyArray<string> = [],
) => {
  if (accountHome() === null) return true;
  const shared = [...sharedPrefixes(), ...alsoShared]
    .flatMap(layoutFolders)
    .map(placeOf);
  return layoutFolders(prefix)
    .map(placeOf)
    .some((place) => shared.some((other) => samePlace(place, other)));
};

/** Reads only: no git read here may take `index.lock` or refresh the index (`--no-optional-locks`). */
const git = async (root: string, args: ReadonlyArray<string>) => {
  const child = Bun.spawn(["git", "--no-optional-locks", "-C", root, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  return { code, stdout: stdout.trim() };
};

/** The checkout an install would build: its HEAD, its branch (none when detached), whether clean. */
export interface CheckoutState {
  readonly head: string | null;
  readonly branch: string | null;
  readonly clean: boolean;
  readonly commonDirectory: string | null;
}

export const checkoutState = async (root: string): Promise<CheckoutState> => {
  const [head, branch, status, common] = await Promise.all([
    git(root, ["rev-parse", "HEAD"]),
    git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    // Untracked files count as local changes; ignored ones do not.
    git(root, ["status", "--porcelain", "--untracked-files=normal"]),
    git(root, ["rev-parse", "--git-common-dir"]),
  ]);
  return {
    head: head.code === 0 ? head.stdout : null,
    branch: branch.code === 0 ? branch.stdout : null,
    clean: status.code === 0 && status.stdout === "",
    commonDirectory:
      common.code !== 0
        ? null
        : isAbsolute(common.stdout)
          ? common.stdout
          : resolve(root, common.stdout),
  };
};

/**
 * Where git places the installed copy's commit against HEAD: the same commit, a strict ancestor
 * (the only one an install may replace), another line of history, or a commit it does not know.
 * Git orders copies, not version numbers, which each branch counts on its own.
 */
export const placeCommit = async (
  root: string,
  commit: string,
  head: string,
): Promise<"same" | "ancestor" | "elsewhere" | "unknown"> => {
  if (commit === head) return "same";
  const ancestor = await git(root, [
    "merge-base",
    "--is-ancestor",
    commit,
    head,
  ]);
  return ancestor.code === 0
    ? "ancestor"
    : ancestor.code === 1
      ? "elsewhere"
      : "unknown";
};

/**
 * What `bun run check` leaves when every phase passed on a clean tree: one file per commit under
 * `<git common directory>/neuve-check/`, shared by the repository's worktrees and never inside
 * `.git/neuve`. An install to the shared copy reads it for the exact commit it builds.
 */
export const CheckReceipt = z.strictObject({
  version: z.literal(1),
  commit: z.string().regex(/^[0-9a-f]{40,64}$/),
  branch: z.string().nullable(),
  at: z.string(),
});
export type CheckReceipt = z.infer<typeof CheckReceipt>;

export const receiptDirectory = (commonDirectory: string) =>
  join(commonDirectory, "neuve-check");

export const receiptPath = (directory: string, commit: string) =>
  join(directory, `${commit}.json`);

/** The receipt for `commit`, or why there is none that counts. */
export const readReceipt = async (
  directory: string,
  commit: string,
): Promise<CheckReceipt | string> => {
  let text: string;
  try {
    text = await readFile(receiptPath(directory, commit), "utf8");
  } catch {
    return `no passing \`bun run check\` recorded for ${commit.slice(0, 10)}`;
  }
  try {
    const parsed = CheckReceipt.safeParse(JSON.parse(text));
    if (parsed.success && parsed.data.commit === commit) return parsed.data;
  } catch {
    // Falls through.
  }
  return `the check receipt for ${commit.slice(0, 10)} cannot be read`;
};

export const writeReceipt = async (
  directory: string,
  receipt: CheckReceipt,
) => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = receiptPath(directory, receipt.commit);
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    await writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return path;
};
