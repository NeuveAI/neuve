import { closeSync, openSync, writeSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  closeWorkspaceTab,
  connectDevelopmentBrowser,
  developmentBrowserFlags,
  signInWorkspaceTab,
} from "@ace/host/browser";
import { config } from "@ace/host/config";
import { GIT_LOCAL } from "@ace/host/host-config";
import {
  currentProcess,
  laneWorkspaceEnvironment,
  readLaneWorkspace,
  stopLaneWorkspace,
  stopLaneWorkspaces,
  validationRoot,
  withLaneBrowser,
  withLaneWorkspace,
  writeLaneWorkspace,
  type LaneWorkspace,
} from "@ace/host/lane-workspace";
import { resolveStoreLocation } from "@neuve/records-core";
import { Effect } from "effect";
import { z } from "zod";
import {
  prepareStorage,
  spawnEnvironment,
  validateStorageProfile,
  type StorageProfile,
} from "../../../scripts/pi-storage";
import { closeChild } from "./workspace-child";
import { placeWorkspaceGraph } from "./workspace-graph";
import { requireWorkspaceBun } from "./workspace-runtime";

const HELP = "Usage: neuve workspace lane [stop]";
const output = (value: unknown) => writeSync(1, `${JSON.stringify(value)}\n`);
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const cli = "apps/neuve-cli/src/cli.ts";
const startLog = (scratch: string) => join(scratch, "startup.log");

const HostReady = z.strictObject({
  "neuve-host": z.literal("ready"),
  url: z.url(),
  tokenFile: z.string(),
  web: z.url(),
  repository: z.string(),
  pid: z.int().positive(),
});

function recordProcess(pid: number) {
  const identity = currentProcess(pid);
  if (!identity)
    throw new Error(`Process ${pid} exited before it could be recorded.`);
  return identity;
}

function environmentOfCaller() {
  const env = { ...process.env };
  for (const key of GIT_LOCAL) delete env[key];
  for (const key of [
    "ACE_HOME",
    "ACE_CONFIG_HOME",
    "ACE_KEYCHAIN_SERVICE",
    "ACE_PORT",
    "ACE_APP_URL",
    "ACE_PEER_PORT",
    "ACE_WEB_PORT",
    "NEUVE_WORKSPACE_PROJECT",
    "NEUVE_RECORDS_REGISTRY",
  ])
    delete env[key];
  return env;
}

function sourceCommand(source: string, ...args: string[]): string[] {
  const bun = Bun.main.startsWith("/$bunfs/")
    ? Bun.which("bun")
    : process.execPath;
  if (!bun) throw new Error("The workspace requires Bun on PATH.");
  return [bun, "--no-env-file", join(source, cli), "workspace", ...args];
}

async function workLane() {
  const git = Bun.spawnSync(
    [
      "git",
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-dir",
      "--git-common-dir",
    ],
    { env: environmentOfCaller() },
  );
  const [top, gitDir, common] = git.stdout.toString().trimEnd().split("\n");
  if (!git.success || !top || !gitDir || !common || gitDir === common)
    throw new Error("Run this command from a Neuve work lane.");
  return realpath(top);
}

function spawnLogged<const In extends "ignore" | "pipe">(
  command: string[],
  options: Bun.SpawnOptions.OptionsObject<In, number, number>,
  scratch: string,
) {
  const fd = openSync(startLog(scratch), "a", 0o600);
  try {
    return Bun.spawn(command, { ...options, stdout: fd, stderr: fd });
  } finally {
    closeSync(fd);
  }
}

async function runBuildStep(
  name: string,
  command: string[],
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    signal: AbortSignal;
  },
  scratch: string,
) {
  options.signal.throwIfAborted();
  const { signal, ...spawnOptions } = options;
  const child = spawnLogged(
    command,
    { ...spawnOptions, stdin: "ignore" },
    scratch,
  );
  const stop = () => void closeChild(child);
  options.signal.addEventListener("abort", stop, { once: true });
  try {
    const exit = await child.exited;
    options.signal.throwIfAborted();
    if (exit !== 0) throw new Error(`${name} exited with code ${exit}.`);
  } finally {
    options.signal.removeEventListener("abort", stop);
  }
}

async function start(root: string, lane: string) {
  // Refuse before creating scratch if the caller cannot verify process identities.
  recordProcess(process.pid);
  const browserProfile = await realpath(join(config.home, "browser")).catch(
    () => join(config.home, "browser"),
  );
  const scratch = await mkdtemp(join(root, "workspace-"));
  const { ACE_HOME, ACE_CONFIG_HOME, ACE_KEYCHAIN_SERVICE } =
    laneWorkspaceEnvironment(scratch);
  const reply = Promise.withResolvers<
    { ready: unknown } | { failure: string }
  >();
  const child = await withLaneWorkspace(scratch, async () => {
    const keeper = spawnLogged(
      sourceCommand(lane, "lane", "--keep", scratch, browserProfile),
      {
        cwd: lane,
        env: {
          ...environmentOfCaller(),
          ACE_HOME,
          ACE_CONFIG_HOME,
          ACE_KEYCHAIN_SERVICE,
        },
        stdin: "ignore",
        detached: true,
        ipc(value: unknown) {
          const parsed = z
            .union([
              z.strictObject({ ready: z.unknown() }),
              z.strictObject({ failure: z.string() }),
            ])
            .safeParse(value);
          if (parsed.success) reply.resolve(parsed.data);
          else
            reply.reject(
              new Error(
                "The workspace keeper returned an invalid readiness record.",
              ),
            );
        },
      },
      scratch,
    );
    try {
      await writeLaneWorkspace({
        version: 1,
        scratch,
        lane,
        keeper: recordProcess(keeper.pid),
        ready: false,
      });
    } catch (error) {
      await closeChild(keeper);
      throw error;
    }
    return keeper;
  }).catch(async (error: unknown) => {
    await rm(scratch, { recursive: true, force: true });
    throw error;
  });
  const interrupt = () => child.kill("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    const value = await Promise.race([
      reply.promise,
      child.exited.then((code) => {
        throw new Error(
          `The workspace keeper exited with code ${code} before readiness.`,
        );
      }),
    ]);
    if ("failure" in value) throw new Error(value.failure);
    output(value.ready);
  } catch (error) {
    try {
      await stopLaneWorkspace(root, scratch);
    } catch (cleanup) {
      throw new Error(
        `${message(error)} Cleanup at ${scratch} failed. ${message(cleanup)}`,
      );
    }
    throw error;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    if (child.exitCode === null) child.disconnect();
    child.unref();
  }
}

async function connectBrowser(browserProfile: string, signal: AbortSignal) {
  const connected = await connectDevelopmentBrowser(
    browserProfile,
    signal,
  ).catch(() => undefined);
  if (connected) return connected;
  signal.throwIfAborted();
  const system = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const chrome = (await Bun.file(system).exists())
    ? system
    : join(
        homedir(),
        "Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      );
  await mkdir(browserProfile, { recursive: true, mode: 0o700 });
  const child = Bun.spawn(
    [chrome, ...developmentBrowserFlags(browserProfile)],
    {
      detached: true,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  child.unref();
  while (!signal.aborted && child.exitCode === null) {
    const browser = await connectDevelopmentBrowser(
      browserProfile,
      signal,
    ).catch(() => undefined);
    if (browser) return browser;
    await Bun.sleep(100);
  }
  throw new Error("Could not start the dedicated development browser.");
}

async function keep(
  root: string,
  scratch: string,
  browserProfile: string,
): Promise<void> {
  const abort = new AbortController();
  const interrupt = () => abort.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  process.on("disconnect", interrupt);
  let launcher: Bun.Subprocess<"pipe", number, number> | undefined;
  try {
    const state = await withLaneWorkspace(
      scratch,
      () => readLaneWorkspace(root, scratch),
      abort.signal,
    );
    if (!state || state.keeper.pid !== process.pid)
      throw new Error("Missing workspace ownership marker.");
    const { lane } = state;
    const signal = abort.signal;
    requireWorkspaceBun(process.execPath);
    const repository = join(scratch, "project");
    const profile: StorageProfile = {
      sourceCheckout: lane,
      isolatedProject: true,
      paths: {
        canonicalClone: repository,
        worktrees: join(scratch, "worktrees"),
        state: join(scratch, "state"),
        captures: join(scratch, "captures"),
        cache: join(scratch, "cache"),
        bunCache: join(scratch, "bun-cache"),
        tmp: join(scratch, "tmp"),
        builds: join(scratch, "builds"),
      },
    };
    const env = environmentOfCaller();
    await runBuildStep(
      "Git clone",
      [
        "git",
        "-c",
        "core.hooksPath=/dev/null",
        "clone",
        "--shared",
        "--",
        lane,
        repository,
      ],
      { cwd: lane, env, signal },
      scratch,
    );
    const storage = await prepareStorage(
      await validateStorageProfile(profile, { checkout: lane }),
    );
    const profileFile = join(scratch, "profile.json");
    await writeFile(profileFile, JSON.stringify(profile), { mode: 0o600 });

    const bin = join(scratch, "bin");
    const neuve = join(bin, "neuve");
    await mkdir(bin);
    const buildOptions = {
      cwd: lane,
      env: spawnEnvironment(storage, env),
      signal,
    };
    const graph = await placeWorkspaceGraph({
      lane,
      scratch,
      installed: Bun.which("neuve"),
      env,
      build: (command) =>
        runBuildStep("Neuve Graph build", command, buildOptions, scratch),
    });
    const environment = {
      ...laneWorkspaceEnvironment(scratch, env.PATH),
      // The source host runs scope reads with Bun as its executable, so it needs the path too.
      NEUVE_GRAPH_BINARY: graph,
      NEUVE_BUDGET_DIRECTORY: join(scratch, "cache", "budget"),
    };
    const childEnvironment = {
      ...buildOptions.env,
      ...environment,
    };
    await runBuildStep(
      "Neuve build",
      [
        process.execPath,
        "--no-env-file",
        join(lane, "apps/neuve-cli/scripts/build.ts"),
        "--outfile",
        neuve,
      ],
      { cwd: lane, env: childEnvironment, signal },
      scratch,
    );

    const records = await Effect.runPromise(resolveStoreLocation(repository));
    if (records.directory !== join(repository, ".git", "neuve"))
      throw new Error("The project clone does not have its own Records store.");
    await runBuildStep(
      "Records initialization",
      [neuve, "records", "migrate"],
      { cwd: lane, env: childEnvironment, signal },
      scratch,
    );
    if (!(await Bun.file(records.database).exists()))
      throw new Error(
        "The built Neuve did not open the workspace's Records store.",
      );

    // Only commands run from the lane change into the clone; the build's own channels keep their lanes.
    const { NEUVE_WORKSPACE_PROJECT: _, ...launcherEnvironment } =
      childEnvironment;
    const ready = Promise.withResolvers<z.infer<typeof HostReady>>();
    launcher = spawnLogged(
      sourceCommand(
        lane,
        "--profile",
        profileFile,
        "--repo",
        repository,
        "--web-port",
        "0",
        "--port",
        "0",
        "--loopback",
      ),
      {
        cwd: lane,
        env: launcherEnvironment,
        stdin: "pipe",
        ipc(value: unknown) {
          const parsed = HostReady.safeParse(value);
          if (parsed.success) ready.resolve(parsed.data);
          else
            ready.reject(
              new Error("The launcher returned an invalid readiness record."),
            );
        },
      },
      scratch,
    );
    state.launcher = recordProcess(launcher.pid);
    await writeLaneWorkspace(state);
    const startup = AbortSignal.any([signal, AbortSignal.timeout(180_000)]);
    const host = await Promise.race([
      ready.promise,
      launcher.exited.then((code) => {
        throw new Error(
          `The workspace launcher exited with code ${code} before readiness.`,
        );
      }),
      new Promise<never>((_, reject) => {
        const stop = () =>
          reject(
            new Error("The workspace launcher did not announce readiness."),
          );
        if (startup.aborted) stop();
        else startup.addEventListener("abort", stop, { once: true });
      }),
    ]);

    await signInAndMarkReady({
      root,
      state,
      browserProfile,
      host,
      launcher,
      signal,
    });
    signal.throwIfAborted();
    process.off("disconnect", interrupt);
    process.send?.({
      ready: {
        "neuve-host": "ready",
        web: host.web,
        url: host.url,
        ports: {
          web: Number(new URL(host.web).port),
          host: Number(new URL(host.url).port),
        },
        pids: {
          launcher: launcher.pid,
          keeper: process.pid,
        },
        scratch,
        log: startLog(scratch),
        repository,
        records: records.database,
        neuve,
        environment,
      },
    });
    await launcher.exited;
  } catch (error) {
    if (launcher) {
      launcher.stdin.end();
      await launcher.exited;
    }
    if (process.connected) process.send?.({ failure: message(error) });
  } finally {
    process.off("disconnect", interrupt);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

async function signInAndMarkReady({
  root,
  state,
  browserProfile,
  host,
  launcher,
  signal,
}: {
  root: string;
  state: LaneWorkspace;
  browserProfile: string;
  host: z.infer<typeof HostReady>;
  launcher: Bun.Subprocess<"pipe", number, number>;
  signal: AbortSignal;
}) {
  const web = new URL(host.web);
  const endpoint = new URL(host.url);
  const tokenFile = join(state.scratch, "state", "neuve-host", "host.token");
  if (
    web.protocol !== "http:" ||
    web.hostname !== "127.0.0.1" ||
    !web.port ||
    web.username ||
    web.password ||
    new URLSearchParams(web.hash.slice(1)).has("token") ||
    endpoint.protocol !== "ws:" ||
    endpoint.hostname !== "127.0.0.1" ||
    !endpoint.port ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    host.tokenFile !== tokenFile ||
    host.pid !== state.launcher?.pid ||
    host.repository !== join(state.scratch, "project")
  )
    throw new Error("The launcher did not announce this workspace.");
  const token = await readFile(tokenFile, "utf8");
  if (!/^[a-f0-9]{64}$/.test(token))
    throw new Error("The workspace token file is invalid.");
  await withLaneBrowser(
    root,
    browserProfile,
    async () => {
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
      const { cdp, endpoint: browser } = await connectBrowser(
        browserProfile,
        deadline,
      );
      try {
        await signInWorkspaceTab(
          cdp,
          web.href,
          token,
          async (id) => {
            state.browser = {
              profile: browserProfile,
              target: { browser: browser.id, target_id: id },
            };
            await writeLaneWorkspace(state);
          },
          deadline,
        );
      } catch (error) {
        if (state.browser?.target)
          await closeWorkspaceTab(browserProfile, state.browser.target);
        throw error;
      } finally {
        cdp.close();
      }
      signal.throwIfAborted();
      if (launcher.exitCode !== null)
        throw new Error("The workspace launcher stopped during sign-in.");
      state.ready = true;
      await writeLaneWorkspace(state);
    },
    signal,
  );
}

export async function workspaceLane(args: readonly string[]): Promise<number> {
  if (args[0] === "--keep" && args.length === 3 && process.connected) {
    const scratch = resolve(args[1]!);
    const root = await validationRoot();
    if (!root || dirname(scratch) !== root)
      throw new Error("The workspace scratch is not on LaCie.");
    await keep(root, scratch, args[2]!);
  } else if (args.length === 0) {
    const lane = await workLane();
    const root = await validationRoot(true);
    if (!root)
      throw new Error("Mount LaCie Blu before starting a lane workspace.");
    await start(root, lane);
  } else if (args.length === 1 && args[0] === "stop") {
    await stopLaneWorkspaces([await workLane()]);
  } else if (args.length === 1 && args[0] === "--help") {
    writeSync(1, `${HELP}\n`);
  } else {
    throw new Error(HELP);
  }
  return 0;
}
