import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";

export const STORAGE_ROLES = [
  "canonicalClone",
  "worktrees",
  "state",
  "captures",
  "cache",
  "bunCache",
  "tmp",
  "builds",
] as const;
export const StorageRole = z.enum(STORAGE_ROLES);
export type StorageRole = z.infer<typeof StorageRole>;

const WRITABLE_ROLES = [
  "state",
  "captures",
  "cache",
  "bunCache",
  "tmp",
  "builds",
] as const satisfies readonly StorageRole[];

const AbsolutePath = z.string().refine(isAbsolute, "Expected an absolute path");

/** Explicit checkout, state and cache paths, with an optional volume pin. */
export const StorageProfile = z
  .strictObject({
    /** The volume's identity is its mount point and UUID together, never its name. */
    volume: z
      .strictObject({
        mountPoint: AbsolutePath,
        volumeUuid: z.string().min(1),
      })
      .optional(),
    paths: z.record(StorageRole, AbsolutePath),
    /** A linked source checkout outside the managed worktrees folder, explicitly admitted by local. */
    sourceCheckout: AbsolutePath.optional(),
  })
  .refine(
    (profile) =>
      profile.volume === undefined || profile.sourceCheckout === undefined,
    "A profile with a volume cannot also set sourceCheckout; it uses only its canonical clone and worktrees",
  );
export type StorageProfile = z.infer<typeof StorageProfile>;

export type VolumeIdentity = Readonly<NonNullable<StorageProfile["volume"]>>;

/** Reads the identity of the volume mounted at `mountPoint`, without writing anything. */
export type VolumeProbe = (mountPoint: string) => Promise<VolumeIdentity>;

export type StorageRefusalReason =
  | "profile-malformed"
  | "volume-absent"
  | "not-a-mount-point"
  | "volume-probe-failed"
  | "volume-identity-mismatch"
  | "path-dangling-link"
  | "path-not-directory"
  | "path-off-volume"
  | "path-inside-checkout"
  | "not-a-git-top-level"
  | "git-common-dir-off-volume"
  | "checkout-outside-profile"
  | "checkout-foreign-repository";

export class StorageRefused extends Error {
  readonly reason: StorageRefusalReason;
  readonly path: string;

  constructor(reason: StorageRefusalReason, path: string, detail: string) {
    super(`Storage refused (${reason}) at ${path}: ${detail}`);
    this.name = "StorageRefused";
    this.reason = reason;
    this.path = path;
  }
}

const storageVariables = (paths: Readonly<Record<StorageRole, string>>) => ({
  TMPDIR: paths.tmp,
  TMP: paths.tmp,
  TEMP: paths.tmp,
  BUN_TMPDIR: paths.tmp,
  GOTMPDIR: paths.tmp,
  BUN_INSTALL_CACHE_DIR: paths.bunCache,
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(paths.cache, "bun-transpiler"),
  XDG_CACHE_HOME: join(paths.cache, "xdg"),
  GOCACHE: join(paths.cache, "go-build"),
  GOMODCACHE: join(paths.cache, "go-mod"),
  npm_config_cache: join(paths.cache, "npm"),
});
export type StorageVariable = keyof ReturnType<typeof storageVariables>;

type VolumeReceipt = Readonly<{
  mountPoint: string;
  volumeUuid: string;
  device: number;
}>;

export type ValidatedStorage = Readonly<{
  volume: VolumeReceipt | undefined;
  /** Real paths, on the declared volume when pinned. A folder that does not exist yet keeps the profile's spelling until `prepareStorage` creates it. */
  paths: Readonly<Record<StorageRole, string>>;
  gitCommonDir: string;
  environment: Readonly<Record<StorageVariable, string>>;
}>;

/** Every `ValidatedStorage` this module made, with the validation that made it, so `prepareStorage` can repeat it. */
const revalidations = new WeakMap<
  ValidatedStorage,
  () => Promise<ValidatedStorage>
>();

/** HFS+ and other volumes without clonefile: Bun's default backend is not assumed. */
export const BUN_INSTALL_COPYFILE = [
  "bun",
  "install",
  "--backend=copyfile",
] as const;

/** Set by a release build (`bun build --define NEUVE_BUILD_VERSION=...`); absent otherwise. */
declare const NEUVE_BUILD_VERSION: string | undefined;

/** The owner's machine: the LaCie volume and the transition's folders on it. */
const ownerProfile = () => {
  const transitionState = "/Volumes/LaCie Blu/code/neuve-pi-state";
  return {
    volume: {
      mountPoint: "/Volumes/LaCie Blu",
      volumeUuid: "7B9DF8FD-71A0-3AEF-A6C0-C301C9B7033C",
    },
    paths: {
      canonicalClone: "/Volumes/LaCie Blu/code/neuve-pi",
      worktrees: "/Volumes/LaCie Blu/code/neuve-pi-worktrees",
      state: `${transitionState}/state`,
      captures: `${transitionState}/captures`,
      cache: `${transitionState}/cache`,
      bunCache: `${transitionState}/cache/bun`,
      tmp: `${transitionState}/tmp`,
      builds: `${transitionState}/builds`,
    },
  } as const satisfies StorageProfile;
};

/**
 * The owner's pi transition profile. Generic users pass their own profile instead. A release build
 * leaves it out (the bundler drops the branch the version stamp rules out), so the archive names
 * none of the owner's paths; there, `piTransitionProfile` refuses.
 */
export const PI_TRANSITION_STORAGE_PROFILE: ReturnType<typeof ownerProfile> =
  typeof NEUVE_BUILD_VERSION === "string"
    ? (undefined as unknown as ReturnType<typeof ownerProfile>)
    : ownerProfile();

/** The pi transition profile, or a plain refusal in a release build, which doesn't carry it. */
export const piTransitionProfile = (): StorageProfile => {
  if (PI_TRANSITION_STORAGE_PROFILE === undefined)
    throw new Error(
      "This neuve is a release build, which doesn't carry the pi-transition profile. Pass --profile <profile.json>.",
    );
  return PI_TRANSITION_STORAGE_PROFILE;
};

/** Selection uses declared paths only, so an absent volume never changes the profile. */
export const defaultStorageProfile = (
  source: string,
): "pi-transition" | "local" => {
  // A release build carries no pi-transition profile, so everything there is local.
  if (PI_TRANSITION_STORAGE_PROFILE === undefined) return "local";
  const paths = PI_TRANSITION_STORAGE_PROFILE.paths;
  return resolve(source) === paths.canonicalClone ||
    inside(paths.worktrees, resolve(source))
    ? "pi-transition"
    : "local";
};

export const localStorageProfile = async (
  source: string,
  home = homedir(),
  platform = process.platform,
): Promise<StorageProfile> => {
  const checkout = await realpath(source);
  const result = await output([
    "git",
    "-C",
    checkout,
    "worktree",
    "list",
    "--porcelain",
    "-z",
  ]);
  const main = result.stdout.split("\0")[0]?.replace(/^worktree /, "");
  if (result.exitCode !== 0 || !main)
    throw new StorageRefused(
      "not-a-git-top-level",
      checkout,
      result.stderr || "git worktree list found no main worktree.",
    );
  const root =
    platform === "darwin"
      ? join(home, "Library", "Application Support", "Neuve", "workspace")
      : join(home, ".local", "state", "neuve", "workspace");
  const canonicalClone = await realpath(main);
  return {
    ...(checkout === canonicalClone ? {} : { sourceCheckout: checkout }),
    paths: {
      canonicalClone,
      worktrees: join(root, "worktrees"),
      state: join(root, "state"),
      captures: join(root, "captures"),
      cache: join(root, "cache"),
      bunCache: join(root, "cache", "bun"),
      tmp: join(root, "tmp"),
      builds: join(root, "builds"),
    },
  };
};

export const readStorageProfile = async (
  source: string,
  name: string = defaultStorageProfile(source),
  home = homedir(),
): Promise<StorageProfile> => {
  if (name === "local") return localStorageProfile(source, home);
  return loadProfile(name);
};

const parseProfile = (value: unknown): StorageProfile => {
  const parsed = StorageProfile.safeParse(value);
  if (!parsed.success)
    throw new StorageRefused(
      "profile-malformed",
      "",
      z.prettifyError(parsed.error),
    );
  return parsed.data;
};

type Output = Readonly<{ stdout: string; stderr: string; exitCode: number }>;

/** Without these, which a Git hook inherits, `git -C` reads another repository. As in `prepare-review-cut.ts`. */
const childEnvironment = () => {
  const environment: Record<string, string | undefined> = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: "0",
  };
  for (const name of [
    "GIT_DIR",
    "GIT_COMMON_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_NAMESPACE",
    "GIT_PREFIX",
    "GIT_IMPLICIT_WORK_TREE",
  ])
    delete environment[name];
  return environment;
};

const output = async (
  argv: readonly string[],
  stdin?: string,
): Promise<Output> => {
  const child = Bun.spawn([...argv], {
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
    env: childEnvironment(),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode };
};

const DiskutilInfo = z.object({
  MountPoint: z.string(),
  VolumeUUID: z.string(),
});

/** macOS: `diskutil info -plist`, read-only. */
export const diskutilVolumeProbe: VolumeProbe = async (mountPoint) => {
  const runProbe = async (command: string[], stdin?: string) => {
    try {
      const result = await output(command, stdin);
      if (result.exitCode !== 0)
        throw new Error(
          result.stderr ||
            result.stdout ||
            `exited with code ${result.exitCode}`,
        );
      return result.stdout;
    } catch (error) {
      throw new StorageRefused(
        "volume-probe-failed",
        mountPoint,
        `${command.join(" ")}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const info = await runProbe(["diskutil", "info", "-plist", mountPoint]);
  const command = ["plutil", "-convert", "json", "-o", "-", "-"];
  const converted = await runProbe(command, info);
  try {
    const { MountPoint, VolumeUUID } = DiskutilInfo.parse(
      JSON.parse(converted),
    );
    return { mountPoint: MountPoint, volumeUuid: VolumeUUID };
  } catch (error) {
    throw new StorageRefused(
      "volume-probe-failed",
      mountPoint,
      `${command.join(" ")}: ${error instanceof Error ? error.message : String(error)}; output: ${converted}`,
    );
  }
};

const missing = (error: unknown): boolean =>
  error instanceof Error &&
  "code" in error &&
  (error.code === "ENOENT" || error.code === "ENOTDIR");

const inside = (root: string, path: string): boolean =>
  root === "/"
    ? path.startsWith("/")
    : path === root || path.startsWith(`${root}/`);

const verifyVolume = async (
  declared: NonNullable<StorageProfile["volume"]>,
  probe: VolumeProbe,
): Promise<VolumeReceipt> => {
  const mountPoint = resolve(declared.mountPoint);
  let real: string;
  let device: number;
  try {
    real = await realpath(mountPoint);
    device = (await stat(real)).dev;
  } catch (error) {
    if (missing(error))
      throw new StorageRefused(
        "volume-absent",
        mountPoint,
        "nothing is mounted there.",
      );
    throw error;
  }
  if (real !== "/" && (await stat(dirname(real))).dev === device)
    throw new StorageRefused(
      "not-a-mount-point",
      real,
      "it is a folder on its parent's volume, not a mounted volume.",
    );
  let identity: VolumeIdentity;
  try {
    identity = await probe(real);
  } catch (error) {
    if (error instanceof StorageRefused) throw error;
    throw new StorageRefused(
      "volume-probe-failed",
      real,
      error instanceof Error ? error.message : String(error),
    );
  }
  const expected = declared.volumeUuid.toUpperCase();
  const found = identity.volumeUuid.toUpperCase();
  if (identity.mountPoint !== real || found !== expected)
    throw new StorageRefused(
      "volume-identity-mismatch",
      real,
      `expected volume ${expected} at ${real}; found ${found} at ${identity.mountPoint}.`,
    );
  return { mountPoint: real, volumeUuid: found, device };
};

type Placement = Readonly<{ path: string; exists: boolean }>;

/** Resolves `path` through its nearest existing ancestor and keeps it on the volume. */
const place = async (
  volume: VolumeReceipt | undefined,
  path: string,
): Promise<Placement> => {
  let existing = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = await realpath(existing);
      const info = await stat(real);
      const placed = join(real, ...tail);
      if (
        volume !== undefined &&
        (!inside(volume.mountPoint, placed) || info.dev !== volume.device)
      )
        throw new StorageRefused(
          "path-off-volume",
          path,
          `it resolves to ${placed}, outside ${volume.mountPoint}.`,
        );
      if (!info.isDirectory())
        throw new StorageRefused(
          "path-not-directory",
          path,
          `${real} is not a folder.`,
        );
      return { path: placed, exists: tail.length === 0 };
    } catch (error) {
      if (!missing(error)) throw error;
      const link = await lstat(existing).catch(() => undefined);
      if (link !== undefined)
        throw new StorageRefused(
          "path-dangling-link",
          path,
          `${existing} is a link to nothing.`,
        );
      tail.unshift(basename(existing));
      existing = dirname(existing);
    }
  }
};

/**
 * Places `path` and refuses it if a link has moved it anywhere else. Without a link on the way,
 * a different real path is the filesystem's own spelling of the same name, as HFS+ stores é decomposed.
 */
const placeExactly = async (
  volume: VolumeReceipt | undefined,
  path: string,
): Promise<Placement> => {
  const placement = await place(volume, path);
  if (placement.path !== path)
    for (
      let prefix = path;
      prefix !== dirname(prefix);
      prefix = dirname(prefix)
    )
      if ((await lstat(prefix).catch(() => undefined))?.isSymbolicLink())
        throw new StorageRefused(
          "path-off-volume",
          path,
          `it resolves through the link ${prefix} to ${placement.path}, not where the profile placed it.`,
        );
  return placement;
};

/** Checks that `directory` is a Git top level whose common directory is on the volume, and returns that directory. */
const gitCommonDir = async (
  volume: VolumeReceipt | undefined,
  directory: string,
): Promise<string> => {
  const result = await output([
    "git",
    "-C",
    directory,
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--git-common-dir",
  ]);
  const [top, common] =
    result.exitCode === 0
      ? await Promise.all(
          result.stdout.split("\n").map((line) => realpath(line)),
        )
      : [];
  if (top !== directory || common === undefined)
    throw new StorageRefused(
      "not-a-git-top-level",
      directory,
      result.stderr || `its Git top level is ${top}.`,
    );
  if (
    volume !== undefined &&
    (!inside(volume.mountPoint, common) ||
      (await stat(common)).dev !== volume.device)
  )
    throw new StorageRefused(
      "git-common-dir-off-volume",
      directory,
      `its Git common directory ${common} is outside ${volume.mountPoint}.`,
    );
  return common;
};

/** Validate a workspace project with the same path and Git boundary as the source checkout. */
export const validateWorkspaceProject = async (
  directory: string,
  storage: ValidatedStorage,
): Promise<string> => {
  const placed = await place(storage.volume, directory);
  await gitCommonDir(storage.volume, placed.path);
  return placed.path;
};

/**
 * Checks the volume's identity and every path, and reads Git, without writing anything.
 * A refusal is a `StorageRefused`; there is no fallback location.
 */
export const validateStorageProfile = async (
  profile: StorageProfile,
  options: Readonly<{ probe?: VolumeProbe; checkout?: string }> = {},
): Promise<ValidatedStorage> => {
  const parsed = parseProfile(profile);
  const volume =
    parsed.volume === undefined
      ? undefined
      : await verifyVolume(parsed.volume, options.probe ?? diskutilVolumeProbe);
  const paths = { ...parsed.paths };
  for (const role of STORAGE_ROLES)
    paths[role] = (await place(volume, parsed.paths[role])).path;
  const sourceCheckout =
    parsed.sourceCheckout === undefined
      ? undefined
      : await place(volume, parsed.sourceCheckout);
  for (const role of WRITABLE_ROLES)
    if (
      inside(paths.canonicalClone, paths[role]) ||
      inside(paths.worktrees, paths[role]) ||
      (sourceCheckout !== undefined && inside(sourceCheckout.path, paths[role]))
    )
      throw new StorageRefused(
        "path-inside-checkout",
        paths[role],
        `${role} would write inside a Git checkout.`,
      );
  const common = await gitCommonDir(volume, paths.canonicalClone);
  if (
    sourceCheckout !== undefined &&
    (await gitCommonDir(volume, sourceCheckout.path)) !== common
  )
    throw new StorageRefused(
      "checkout-foreign-repository",
      sourceCheckout.path,
      `its Git common directory is not ${common}.`,
    );
  if (options.checkout !== undefined) {
    const checkout = await place(volume, options.checkout);
    if (
      !checkout.exists ||
      (checkout.path !== paths.canonicalClone &&
        !inside(paths.worktrees, checkout.path) &&
        checkout.path !== sourceCheckout?.path)
    )
      throw new StorageRefused(
        "checkout-outside-profile",
        checkout.path,
        parsed.sourceCheckout === undefined
          ? "a checkout is the canonical clone or one of the profile's worktrees."
          : "a checkout is the canonical clone, the declared source checkout or one of the profile's worktrees.",
      );
    if ((await gitCommonDir(volume, checkout.path)) !== common)
      throw new StorageRefused(
        "checkout-foreign-repository",
        checkout.path,
        `its Git common directory is not ${common}.`,
      );
  }
  const environment = storageVariables(paths);
  for (const path of Object.values(environment))
    await placeExactly(volume, path);
  const storage: ValidatedStorage = Object.freeze({
    volume,
    paths,
    gitCommonDir: common,
    environment,
  });
  const again = { ...options };
  revalidations.set(storage, () => validateStorageProfile(parsed, again));
  return storage;
};

/** The folders `prepareStorage` creates. */
const foldersOf = (storage: ValidatedStorage): string[] => [
  storage.paths.worktrees,
  ...WRITABLE_ROLES.map((role) => storage.paths[role]),
  ...Object.values(storage.environment),
];

/**
 * Repeats the validation that made `storage`, volume probe included, and refuses if any folder
 * now resolves elsewhere. Only then creates the folders, and places each again after its `mkdir`.
 * Returns the validation repeated over the created folders, so every path is the one the filesystem stored. Idempotent.
 */
export const prepareStorage = async (
  storage: ValidatedStorage,
): Promise<ValidatedStorage> => {
  const revalidate = revalidations.get(storage);
  if (revalidate === undefined)
    throw new TypeError(
      "prepareStorage takes the result of validateStorageProfile.",
    );
  const unmoved = async (): Promise<ValidatedStorage> => {
    const fresh = await revalidate();
    const now = foldersOf(fresh);
    for (const [index, folder] of foldersOf(storage).entries())
      if ((await placeExactly(fresh.volume, folder)).path !== now[index])
        throw new StorageRefused(
          "path-off-volume",
          folder,
          "it resolves elsewhere since it was validated.",
        );
    return fresh;
  };
  const { volume } = await unmoved();
  for (const folder of new Set(foldersOf(storage))) {
    await mkdir(folder, { recursive: true });
    await placeExactly(volume, folder);
  }
  return unmoved();
};

/**
 * The environment for a child process: `base` with every temporary and cache variable forced
 * onto the profile. Sign-in variables such as HOME pass through untouched.
 */
export const spawnEnvironment = (
  storage: ValidatedStorage,
  base: Readonly<Record<string, string | undefined>>,
): Record<string, string> => {
  const forced = new Set(
    Object.keys(storage.environment).map((key) => key.toUpperCase()),
  );
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(base))
    if (value !== undefined && !forced.has(key.toUpperCase()))
      environment[key] = value;
  return { ...environment, ...storage.environment };
};

const loadProfile = async (name: string): Promise<StorageProfile> => {
  if (name === "pi-transition") return piTransitionProfile();
  try {
    return parseProfile(JSON.parse(await Bun.file(name).text()));
  } catch (error) {
    if (error instanceof StorageRefused) throw error;
    throw new StorageRefused(
      "profile-malformed",
      name,
      error instanceof Error ? error.message : String(error),
    );
  }
};

const main = async (): Promise<number> => {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      profile: { type: "string" },
      checkout: { type: "string" },
      prepare: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.profile === undefined) {
    await Bun.write(
      Bun.stderr,
      "Usage: bun scripts/pi-storage.ts --profile <pi-transition | local | profile.json> [--checkout <dir>] [--prepare]\n",
    );
    return 2;
  }
  try {
    const profile = await readStorageProfile(
      values.checkout ?? process.cwd(),
      values.profile,
    );
    const validated = await validateStorageProfile(
      profile,
      values.checkout === undefined ? {} : { checkout: values.checkout },
    );
    const storage = values.prepare
      ? await prepareStorage(validated)
      : validated;
    await Bun.write(
      Bun.stdout,
      `${JSON.stringify({ status: values.prepare ? "prepared" : "validated", ...storage }, null, 2)}\n`,
    );
    return 0;
  } catch (error) {
    if (!(error instanceof StorageRefused)) throw error;
    await Bun.write(
      Bun.stdout,
      `${JSON.stringify({ status: "refused", reason: error.reason, path: error.path, message: error.message }, null, 2)}\n`,
    );
    return 1;
  }
};

if (import.meta.main) {
  process.exitCode = await main();
}
