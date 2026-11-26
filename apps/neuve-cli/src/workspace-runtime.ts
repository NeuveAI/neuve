import { CLI_VERSION, RELEASE_BUILD } from "./cli-version";
import {
  readFile,
  rename,
  writeFile,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { config as native } from "@ace/host/config";
import { settingsRoute, type AnyRouteConfig } from "@neuve/harness/coding";
import { Starter } from "@neuve/records-core";
import { configureRuntime } from "@ace/host/runtime-hooks";
import { workspaceNativeSources } from "./workspace-native-sources.ts";
import { routeCodingDefaults } from "./workspace-models.ts";
import { writeSkillShare } from "./skill-bundle.ts";
import { findSkillSource } from "./skills-cli.ts";
import {
  GIT_LOCAL,
  HostConfigSchema,
  configure,
  bindConfiguredCatalog,
  type HostConfig,
} from "@ace/host/host-config";
import {
  readStorageProfile,
  StorageProfile,
  spawnEnvironment,
  validateStorageProfile,
  prepareStorage,
  type ValidatedStorage,
} from "../../../scripts/pi-storage.ts";

const RECEIPT = "workspace-runtime.json";

export function useWorkspaceProject(): void {
  const project = process.env.NEUVE_WORKSPACE_PROJECT;
  if (!project) return;
  // Consumed here, so channels and workers this command starts keep their own folders.
  delete process.env.NEUVE_WORKSPACE_PROJECT;
  for (const key of GIT_LOCAL) delete process.env[key];
  process.chdir(project);
}

export function requireWorkspaceBun(executable: string): void {
  let version = "unreadable";
  try {
    const runtime = Bun.spawnSync([executable, "--version"]);
    version = runtime.stdout.toString().trim() || "unreadable";
    // Older Bun can hang Vite's probe; 1.4.4 is the version the checks run on.
    if (runtime.success && version === "1.4.4") return;
  } catch {}
  throw new Error(
    `The workspace requires Bun 1.4.4. ${executable} reported ${JSON.stringify(version)}. Install it with curl -fsSL https://bun.com/install | bash -s bun-v1.4.4.`,
  );
}

const RuntimeReceipt = z.strictObject({
  version: z.literal(1),
  source: z.string().min(1),
  profile: StorageProfile,
  settings: z.string().min(1),
  keychain: z.string().min(1),
  appUrl: z.url().optional(),
  configuration: z
    .record(z.string(), z.unknown())
    .refine(
      (value) => !Object.hasOwn(value, "environment"),
      "A public workspace receipt cannot contain an environment",
    ),
});

export async function writeWorkspaceRuntime(
  profile: StorageProfile,
  source: string,
  configuration: HostConfig,
  appUrl?: string,
): Promise<void> {
  const { environment: _environment, ...publicConfiguration } =
    HostConfigSchema.parse(configuration);
  const path = join(configuration.home, RECEIPT);
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(
      temporary,
      JSON.stringify(
        RuntimeReceipt.parse({
          version: 1,
          profile,
          source,
          settings: native.settings,
          keychain: native.keychain,
          appUrl,
          configuration: publicConfiguration,
        }),
      ),
      { mode: 0o600 },
    );
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function workspaceDirectories(storage: Pick<ValidatedStorage, "paths">) {
  const home = join(storage.paths.state, "neuve-host");
  const lanes = join(storage.paths.worktrees, "neuve-lanes");
  for (const directory of [home, lanes, join(storage.paths.captures, "coding")])
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  return { home, lanes };
}

export function workspaceConfiguration(input: {
  storage: ValidatedStorage;
  environment: Record<string, string>;
  profile: StorageProfile;
  source: string;
  user: string;
  port: number;
  route: AnyRouteConfig;
  app?: string;
}): HostConfig {
  const { home, lanes } = workspaceDirectories(input.storage);
  const bundled = Bun.main.startsWith("/$bunfs/");
  const command = bundled
    ? [process.execPath]
    : [
        process.execPath,
        ...Starter.sourceRunFlags(),
        join(input.source, "apps/neuve-cli/src/cli.ts"),
      ];
  // A bundled worker uses the executable's code, regardless of the source checkout.
  const provenance = bundled
    ? undefined
    : Bun.spawnSync(["git", "-C", input.source, "rev-parse", "HEAD"], {
        env: input.environment,
        timeout: 2000,
      });
  const commit = provenance?.success
    ? provenance.stdout.toString().trim()
    : undefined;
  return HostConfigSchema.parse({
    build: {
      version: CLI_VERSION,
      release: RELEASE_BUILD,
      ...(commit ? { commit } : {}),
    },
    ...(input.app === undefined ? {} : { app: input.app }),
    home,
    lanes,
    ...(input.storage.volume === undefined
      ? {}
      : { volume: input.storage.volume.mountPoint }),
    projects: resolve(input.storage.paths.canonicalClone, ".."),
    user: input.user,
    port: input.port,
    ...(input.environment.ACE_WEB_PORT
      ? { webPort: Number(input.environment.ACE_WEB_PORT) }
      : input.port === 0
        ? { webPort: 0 }
        : {}),
    ...routeCodingDefaults(input.route),
    workerCloseTimeoutMs: 130_000,
    worker: [...command, "workspace", "worker"],
    environment: {
      ...input.environment,
      NEUVE_WORKSPACE_PROFILE: JSON.stringify(input.profile),
      NEUVE_WORKSPACE_SOURCE: input.source,
    },
  });
}

/**
 * Writes the Neuve skill this neuve carries, with its version, into the host's home on every
 * launch, so the workspace's agents have it before anyone installs it.
 */
export async function writeCarriedSkill(
  home: string,
): Promise<{ skills?: string }> {
  const carried = await findSkillSource();
  if (!carried.found) return {};
  const skills = join(home, "skills");
  await rm(skills, { recursive: true, force: true });
  await writeSkillShare({ bundle: carried.bundle, shareDirectory: skills });
  return { skills };
}

async function activateWorkspaceCli(
  profile: StorageProfile,
  source: string,
  configuration: HostConfig,
  args: readonly string[],
  fresh: boolean,
  storage: ValidatedStorage,
) {
  const local = args[0] === "serve" && args.includes("--loopback");
  const managed = configure({
    ...configuration,
    ...(args[0] === "serve" ? await writeCarriedSkill(configuration.home) : {}),
    ...(local ? { channelScope: "local" } : {}),
  });
  await bindConfiguredCatalog(
    fresh && !local ? { scope: "automatic" } : undefined,
  );
  configureRuntime({
    nativeSources: workspaceNativeSources(storage),
    listening(port) {
      const final = configure({ ...managed, port });
      void writeWorkspaceRuntime(profile, source, final).catch(
        (error: unknown) => console.error(error),
      );
    },
  });
}

/** Configure the original CLI before its catalog and worker command capture process state. */
export async function configureWorkspaceCli(
  args: readonly string[],
): Promise<boolean> {
  const source = await realpath(resolve(import.meta.dirname, "../../.."));
  let home = process.env.ACE_HOME;
  let initial: StorageProfile | undefined;
  if (home === undefined) {
    initial = process.env.NEUVE_WORKSPACE_PROFILE
      ? StorageProfile.parse(JSON.parse(process.env.NEUVE_WORKSPACE_PROFILE))
      : await readStorageProfile(source);
    home = join(initial.paths.state, "neuve-host");
  }
  let text: string;
  try {
    text = await readFile(join(home, RECEIPT), "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
    if (initial === undefined) return false;
    const storage = await prepareStorage(
      await validateStorageProfile(initial, { checkout: source }),
    );
    const configuration = workspaceConfiguration({
      storage,
      profile: initial,
      source,
      environment: spawnEnvironment(storage, process.env),
      user: process.env.USER ?? process.env.LOGNAME ?? "",
      port: 4140,
      route: settingsRoute(),
    });
    await activateWorkspaceCli(
      initial,
      source,
      configuration,
      args,
      true,
      storage,
    );
    return true;
  }
  const receipt = RuntimeReceipt.parse(JSON.parse(text));
  if ((await realpath(receipt.source)) !== source)
    throw new Error(
      "The workspace was launched from another checkout. Run its Neuve CLI or restart it from this checkout.",
    );
  const storage = await validateStorageProfile(receipt.profile, {
    checkout: source,
  });
  const environment = spawnEnvironment(storage, process.env);
  const configuration = HostConfigSchema.parse({
    ...receipt.configuration,
    environment: {
      ...environment,
      ACE_CONFIG_HOME: receipt.settings,
      ACE_KEYCHAIN_SERVICE: receipt.keychain,
      NEUVE_WORKSPACE_PROFILE: JSON.stringify(receipt.profile),
      NEUVE_WORKSPACE_SOURCE: source,
    },
  });
  const executable = await stat(configuration.worker[0]);
  if (!executable.isFile())
    throw new Error("The workspace worker executable is unavailable.");
  for (const argument of configuration.worker.slice(1))
    if (argument.startsWith("/") && argument.endsWith(".ts"))
      await stat(argument);
  if (configuration.home !== (await realpath(home)))
    throw new Error("The workspace runtime receipt belongs to another home.");
  if (args[0] !== "serve" && receipt.appUrl !== undefined)
    native.appUrl = receipt.appUrl;
  await activateWorkspaceCli(
    receipt.profile,
    source,
    configuration,
    args,
    false,
    storage,
  );
  return true;
}
