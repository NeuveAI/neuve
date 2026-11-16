import "../../neuve-host/tests/fixtures/memory-secrets";
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PI_TRANSITION_STORAGE_PROFILE,
  type ValidatedStorage,
} from "../../../scripts/pi-storage.ts";
import {
  requireWorkspaceBun,
  workspaceConfiguration,
} from "../src/workspace-runtime.ts";
import { configure } from "@ace/host/host-config";
import { config as native } from "@ace/host/config";
import { SOL_ROUTE } from "../../../packages/harness/src/route.ts";

// Why: the selected Bun must avoid Vite probe hangs and match the version the checks run on.
test("workspace accepts only Bun 1.4.4 before starting Vite", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-bun-"));
  const executable = join(root, "bun");
  try {
    await writeFile(executable, "#!/bin/sh\necho '1.4.4'\n", {
      mode: 0o700,
    });
    expect(() => requireWorkspaceBun(executable)).not.toThrow();
    for (const [version, exit] of [
      ["1.4.0", 0],
      ["1.4.3", 0],
      ["1.4.5", 0],
      ["1.5.0", 0],
      ["unparseable", 0],
      ["1.4.4", 1],
      ["", 1],
    ] as const) {
      await writeFile(
        executable,
        `#!/bin/sh\necho '${version}'\nexit ${exit}\n`,
        { mode: 0o700 },
      );
      expect(() => requireWorkspaceBun(executable)).toThrow(
        `The workspace requires Bun 1.4.4. ${executable} reported ${JSON.stringify(version || "unreadable")}. Install it with curl -fsSL https://bun.com/install | bash -s bun-v1.4.4.`,
      );
    }
    await rm(executable);
    expect(() => requireWorkspaceBun(executable)).toThrow(
      `The workspace requires Bun 1.4.4. ${executable} reported "unreadable". Install it with curl -fsSL https://bun.com/install | bash -s bun-v1.4.4.`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dynamic workspace host chooses explicit free HTTPS while respecting configured HTTPS ports", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-tls-"));
  const paths = Object.fromEntries(
    Object.keys(PI_TRANSITION_STORAGE_PROFILE.paths).map((role) => [
      role,
      join(root, role),
    ]),
  );
  const profile = {
    ...PI_TRANSITION_STORAGE_PROFILE,
    paths: {
      ...PI_TRANSITION_STORAGE_PROFILE.paths,
      state: paths.state!,
      captures: paths.captures!,
      worktrees: paths.worktrees!,
      canonicalClone: paths.canonicalClone!,
    },
  };
  await Promise.all(
    Object.values(profile.paths)
      .filter((path) => path.startsWith(root))
      .map((path) => mkdir(path, { recursive: true })),
  );
  const storage: ValidatedStorage = {
    paths: profile.paths,
    volume: { mountPoint: root, volumeUuid: "fixture", device: 0 },
    gitCommonDir: root,
    environment: {
      TMPDIR: root,
      TMP: root,
      TEMP: root,
      BUN_TMPDIR: root,
      GOTMPDIR: root,
      BUN_INSTALL_CACHE_DIR: root,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: root,
      XDG_CACHE_HOME: root,
      GOCACHE: root,
      GOMODCACHE: root,
      npm_config_cache: root,
    },
  };
  const input = {
    storage,
    profile,
    source: root,
    user: "owner",
    route: SOL_ROUTE,
  };
  const original = { ...native };
  const names = [
    "NEUVE_HOST_CONFIG",
    "ACE_HOME",
    "ACE_CONFIG_HOME",
    "ACE_KEYCHAIN_SERVICE",
    "ACE_USER",
    "ACE_PORT",
  ];
  const environment = new Map(names.map((name) => [name, process.env[name]]));
  try {
    const dynamic = workspaceConfiguration({
      ...input,
      port: 0,
      environment: {},
    });
    expect(dynamic.webPort).toBe(0);
    // Why: a local profile must reach project admission without an inherited volume pin.
    const local = workspaceConfiguration({
      ...input,
      storage: { ...storage, volume: undefined },
      port: 0,
      environment: {},
    });
    expect(local.volume).toBeUndefined();
    // The configured worker runs inside a project; neither its env nor its Bun preload may load.
    const entry = join(root, "apps/neuve-cli/src");
    const project = join(root, "project");
    await Promise.all([
      mkdir(entry, { recursive: true }),
      mkdir(project, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(entry, "cli.ts"),
        "console.log(JSON.stringify({env: process.env.NEUVE_WORKER_PROJECT_FIXTURE ?? null, args: Bun.argv.slice(2)}))",
      ),
      writeFile(join(project, ".env"), "NEUVE_WORKER_PROJECT_FIXTURE=loaded\n"),
      writeFile(join(project, "bunfig.toml"), 'preload = ["./preload.ts"]\n'),
      writeFile(
        join(project, "preload.ts"),
        'throw new Error("Project preload ran")',
      ),
    ]);
    const child = Bun.spawn(dynamic.worker, {
      cwd: project,
      env: { ...process.env, NEUVE_WORKER_PROJECT_FIXTURE: undefined },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [output, error, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ exit, error }).toEqual({ exit: 0, error: "" });
    expect(JSON.parse(output)).toEqual({
      env: null,
      args: ["workspace", "worker"],
    });
    configure(dynamic);
    expect(native.webPort).toBe(0);
    const explicit = workspaceConfiguration({
      ...input,
      port: 0,
      environment: { ACE_WEB_PORT: "54443" },
    });
    expect(explicit.webPort).toBe(54443);
    configure(explicit);
    expect(native.webPort).toBe(54443);
    const fixed = workspaceConfiguration({
      ...input,
      port: 4140,
      environment: {},
    });
    expect(fixed.webPort).toBeUndefined();
    configure(fixed);
    expect(native.webPort).toBe(original.webPort);
    expect(() =>
      workspaceConfiguration({
        ...input,
        port: 0,
        environment: { ACE_WEB_PORT: "70000" },
      }),
    ).toThrow();
  } finally {
    Object.assign(native, original);
    for (const [name, value] of environment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
