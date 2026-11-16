import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
// Only precondition evaluation runs in these children. The manager is mocked and
// every branch exits or skips before registering a native lifecycle test body.
for (const kind of ["manager", "archive", "graph", "opt-out"]) {
  test(`native systemd preconditions fail when required and skip when optional: ${kind}`, async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "neuve-systemd-precondition-"),
    );
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (child?.exitCode === null) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (!(
            error instanceof Error &&
            "code" in error &&
            error.code === "ESRCH"
          ))
            throw error;
        }
      }
    };
    try {
      const preload = join(directory, "precondition.ts");
      const graph = join(root, "apps/neuve-graph/entire-graph");
      await writeFile(
        preload,
        `import { mock } from "bun:test";
Object.defineProperty(process, "platform", { value: "linux" });
const systemd = await import(${JSON.stringify(join(root, "packages/records-core/src/systemd.ts"))});
mock.module(${JSON.stringify(join(root, "packages/records-core/src/systemd.ts"))}, () => ({ ...systemd, userSystemdAvailable: async () => ${kind !== "manager"} }));
const file = Bun.file;
Bun.file = (...args) => args[0] === ${JSON.stringify(graph)} ? {exists: async () => false} : file(...args);
`,
      );
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: directory,
        XDG_CONFIG_HOME: join(directory, "config"),
        XDG_CONFIG_DIRS: join(directory, "config-dirs"),
        XDG_DATA_HOME: join(directory, "data"),
        XDG_DATA_DIRS: join(directory, "data-dirs"),
        XDG_RUNTIME_DIR: join(directory, "runtime"),
        NEUVE_RELEASE_SYSTEMD: kind === "opt-out" ? "0" : "1",
      };
      delete env.NEUVE_RELEASE_ARCHIVE;
      if (kind === "archive")
        env.NEUVE_RELEASE_ARCHIVE = join(directory, "missing.tar.gz");
      const spawned = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "test",
          "--preload",
          preload,
          "./tests/release/systemd-native.test.ts",
        ],
        {
          cwd: root,
          env,
          detached: true,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      child = spawned;
      timeout = setTimeout(stop, 10_000);
      const [stdout, stderr, code] = await Promise.all([
        new Response(spawned.stdout).text(),
        new Response(spawned.stderr).text(),
        spawned.exited,
      ]);
      const reason =
        kind === "manager"
          ? "requires a reachable real systemd user manager"
          : kind === "archive"
            ? "requires a readable NEUVE_RELEASE_ARCHIVE"
            : kind === "graph"
              ? "requires NEUVE_RELEASE_ARCHIVE or a workspace Graph engine"
              : "requires NEUVE_RELEASE_SYSTEMD=1";
      expect(stdout + stderr).toContain(
        `Native systemd lifecycle tests ${kind === "opt-out" ? "skipped" : "required"}: ${reason}.`,
      );
      expect(code).toBe(kind === "opt-out" ? 0 : 1);
    } finally {
      clearTimeout(timeout);
      stop();
      if (child) await child.exited;
      await rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
}
