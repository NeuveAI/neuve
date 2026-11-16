import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  agentService,
  agentTimer,
  ownsService,
  ownsTimer,
  SERVICE,
  userSystemdAvailable,
} from "../../packages/records-core/src/systemd.ts";
import { writeChecksums } from "../../scripts/release/checksums.ts";

const root = resolve(import.meta.dir, "../..");
const graph = join(root, "apps/neuve-graph/entire-graph");
const skipReason =
  process.platform !== "linux"
    ? "requires Linux, this host is " + process.platform
    : process.env.NEUVE_RELEASE_SYSTEMD !== "1"
      ? "requires NEUVE_RELEASE_SYSTEMD=1"
      : !(await userSystemdAvailable())
        ? "requires a reachable real systemd user manager"
        : process.env.NEUVE_RELEASE_ARCHIVE
          ? !(await Bun.file(process.env.NEUVE_RELEASE_ARCHIVE).exists())
            ? "requires a readable NEUVE_RELEASE_ARCHIVE"
            : null
          : !(await Bun.file(graph).exists())
            ? "requires NEUVE_RELEASE_ARCHIVE or a workspace Graph engine"
            : null;
if (skipReason && process.env.NEUVE_RELEASE_SYSTEMD === "1")
  throw new Error(`Native systemd lifecycle tests required: ${skipReason}.`);
if (skipReason)
  console.info(`Native systemd lifecycle tests skipped: ${skipReason}.`);

const run = async (argv: string[], env: NodeJS.ProcessEnv, cwd = root) => {
  const child = Bun.spawn(argv, {
    env,
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, code };
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
};
const success = (result: Awaited<ReturnType<typeof run>>) => {
  expect(result, result.stdout + result.stderr).toMatchObject({ code: 0 });
  return result.stdout;
};
const jobSchema = z.object({
  state: z.string(),
  finishedAt: z.string().nullable(),
});
const running = async (pid: number) => {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
  return stat !== "" && !/^\S+ \(.*\) Z /.test(stat);
};

// The real cgroup boundary is essential: a fake systemctl cannot reproduce F29.
for (const killMode of ["process", "control-group"]) {
  test.skipIf(skipReason !== null)(
    `native systemd sweep completes queued work and idles out: KillMode=${killMode}`,
    async () => {
      const directory = await realpath(
        await mkdtemp(join(tmpdir(), "neuve-systemd-native-")),
      );
      const home = join(directory, "home");
      const repository = join(directory, "repository");
      const prefix = join(home, "release copy");
      const cli = join(prefix, "bin/neuve");
      const store = join(repository, ".git/neuve");
      const unit = `neuve-release-test-${randomUUID()}.service`;
      const env: NodeJS.ProcessEnv = {
        HOME: home,
        PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
        TMPDIR: directory,
        XDG_CONFIG_HOME: join(home, ".config"),
        XDG_CONFIG_DIRS: join(home, "config-dirs"),
        XDG_DATA_DIRS: join(home, "data-dirs"),
        XDG_DATA_HOME: join(home, ".local/share"),
        XDG_CACHE_HOME: join(home, ".cache"),
        XDG_STATE_HOME: join(home, ".local/state"),
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
        DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        NEUVE_NO_AGENT: "1",
        NEUVE_NO_MODIFY_PATH: "1",
        NEUVE_MODE: "check",
        NEUVE_BUDGET_DIRECTORY: join(directory, "budget"),
        ENTIRE_GRAPH_SERVICE: "off",
      };
      let pid: number | undefined;
      let unitStarted = false;
      try {
        await mkdir(home);
        await mkdir(repository);
        let archive = process.env.NEUVE_RELEASE_ARCHIVE;
        if (!archive) {
          const out = join(directory, "archive");
          success(
            await run(
              [
                process.execPath,
                "--no-env-file",
                join(root, "scripts/release/build.ts"),
                "--target",
                `linux-${process.arch}`,
                "--version",
                "0.1.0-test.systemd",
                "--out",
                out,
                "--graph",
                graph,
              ],
              { ...process.env, ...env },
            ),
          );
          archive = join(out, `neuve-linux-${process.arch}.tar.gz`);
        }
        const assets = join(directory, "assets");
        await mkdir(assets);
        // Hash only our test archive, with the basename expected by the installer.
        const localArchive = join(assets, `neuve-linux-${process.arch}.tar.gz`);
        await Bun.write(localArchive, Bun.file(archive));
        await writeChecksums(assets);
        success(
          await run(
            [
              "sh",
              join(root, "scripts/install.sh"),
              "--prefix",
              prefix,
              "--archive",
              localArchive,
              "--checksums",
              join(assets, "SHA256SUMS"),
            ],
            env,
          ),
        );
        success(await run(["git", "init", "--quiet", repository], env));
        const enqueued = z
          .object({
            job: z.object({ seq: z.number().int() }),
            worker: z.null(),
          })
          .parse(
            JSON.parse(
              success(
                await run(
                  [
                    cli,
                    "jobs",
                    "enqueue",
                    "worker.probe",
                    '{"sleepMs":5000}',
                    "--no-start",
                    "--json",
                    "--repo",
                    repository,
                  ],
                  env,
                ),
              ),
            ),
          );
        const inspect = async () =>
          jobSchema.parse(
            JSON.parse(
              success(
                await run(
                  [
                    cli,
                    "jobs",
                    "inspect",
                    String(enqueued.job.seq),
                    "--json",
                    "--repo",
                    repository,
                  ],
                  env,
                ),
              ),
            ),
          );
        expect((await inspect()).state).toBe("waiting");
        // Register without setup hooks or a worker start, so the sweep is the only starter.
        const registry = join(
          env.XDG_STATE_HOME ?? "",
          "neuve/repositories.json",
        );
        await mkdir(dirname(registry), { recursive: true });
        await writeFile(
          registry,
          JSON.stringify({ version: 1, repositories: [{ store, repository }] }),
        );
        const environment = Object.entries(env).flatMap(([key, value]) =>
          value === undefined ? [] : [`--setenv=${key}=${value}`],
        );
        unitStarted = true;
        const sweep = await run(
          [
            "systemd-run",
            "--user",
            "--wait",
            "--collect",
            "--pipe",
            `--unit=${unit}`,
            "--property=Type=oneshot",
            `--property=KillMode=${killMode}`,
            ...environment,
            cli,
            "worker",
            "sweep",
          ],
          env,
        );
        success(sweep);
        expect(sweep.stdout).toContain("1 job(s)");
        expect(sweep.stdout).toContain("spawned");
        const sweepExitedAt = Date.now();
        // --wait returned: the oneshot has exited. A sleeping probe cannot already be done.
        expect((await inspect()).state).not.toBe("completed");
        const logPath = join(store, "worker.log");
        const workerPid = async () => {
          const log = await readFile(logPath, "utf8").catch(() => "");
          const match = /worker\[(\d+)\].*worker starting for /.exec(log);
          return match?.[1] === undefined ? undefined : Number(match[1]);
        };
        if (killMode === "control-group") {
          await Bun.sleep(7000);
          pid = await workerPid();
          expect((await inspect()).state).not.toBe("completed");
          if (pid !== undefined) expect(await running(pid)).toBe(false);
          const status = await run(
            [cli, "worker", "status", "--json", "--repo", repository],
            env,
          );
          expect(status.code).toBe(3);
        } else {
          const deadline = sweepExitedAt + 100_000;
          let job = await inspect();
          while (job.state !== "completed" && Date.now() < deadline) {
            await Bun.sleep(250);
            job = await inspect();
          }
          expect(job.state).toBe("completed");
          expect(Date.parse(job.finishedAt ?? "")).toBeGreaterThan(
            sweepExitedAt,
          );
          pid = await workerPid();
          expect(pid).toBeDefined();
          if (pid === undefined)
            throw new Error("The worker didn't log its PID.");
          expect(await running(pid)).toBe(true);
          while ((await running(pid)) && Date.now() < deadline)
            await Bun.sleep(250);
          expect(await running(pid)).toBe(false);
          expect(await readFile(logPath, "utf8")).toMatch(
            /idle for .*socket released/,
          );
        }
        console.info(
          `Native systemd ${killMode}: sweep exited; job ${(await inspect()).state}; worker exited.`,
        );
      } finally {
        // This UUID unit and its cgroup contain only processes created by this test.
        if (unitStarted)
          await run(
            [
              "systemctl",
              "--user",
              "kill",
              "--kill-who=all",
              "--signal=SIGKILL",
              unit,
            ],
            env,
          );
        // The unit may already be collected. Find any survivor by its exact private
        // executable and repository argv, never by a shared process name or PID alone.
        const survivors: number[] = [];
        for (const name of await readdir("/proc")) {
          if (!/^\d+$/.test(name)) continue;
          const candidate = Number(name);
          const argv = await readFile(
            `/proc/${candidate}/cmdline`,
            "utf8",
          ).catch(() => "");
          const words = argv.split("\0");
          if (
            words.includes(cli) &&
            words.includes(repository) &&
            (await running(candidate))
          ) {
            process.kill(candidate, "SIGKILL");
            survivors.push(candidate);
          }
        }
        const cleanupDeadline = Date.now() + 5000;
        for (const candidate of survivors) {
          while ((await running(candidate)) && Date.now() < cleanupDeadline)
            await Bun.sleep(25);
          expect(
            await running(candidate),
            `Test worker ${candidate} survived cleanup`,
          ).toBe(false);
        }
        await rm(directory, { recursive: true, force: true });
      }
    },
    150_000,
  );
}

// The real manager supplies the oracle. These UUID units are loaded but never started.
test.skipIf(skipReason !== null)(
  "native systemd parser agrees on whitespace, CR, CRLF, NUL and quoted arrays",
  async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), "neuve-systemd-parser-")),
    );
    const env: NodeJS.ProcessEnv = {
      HOME: directory,
      PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_CONFIG_DIRS: join(directory, "config-dirs"),
      XDG_DATA_HOME: join(directory, "data"),
      XDG_DATA_DIRS: join(directory, "data-dirs"),
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
      DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
    };
    const command = "/usr/bin/true";
    const cases: {
      name: string;
      service: string;
      timer: string;
      owned: boolean;
      kind: string;
      explicitFirst?: boolean;
      dropIn?: string;
    }[] = [
      {
        name: "tab",
        service: agentService(command).replace(
          '" worker sweep',
          '"\tworker\tsweep',
        ),
        timer: agentTimer(),
        owned: true,
        kind: "exec",
      },
      ...["\u00a0", "\u2003", "\ufeff"].map((character) => ({
        name: `unicode-${character.charCodeAt(0)}`,
        service: agentService(command).replace(
          '" worker sweep',
          '"' + character + "worker sweep",
        ),
        timer: agentTimer(),
        owned: false,
        kind: "exec",
      })),
      ...["\r", "\r\n", "\0"].flatMap((delimiter) =>
        ["exec", "kill", "timer"].flatMap((kind) =>
          [false, true].flatMap((dropIn) =>
            (kind === "timer" ? [false, true] : [false]).map(
              (explicitFirst) => {
                const hidden =
                  "# comment" +
                  delimiter +
                  (kind === "exec"
                    ? "ExecStart=" +
                      delimiter +
                      "ExecStart=/usr/bin/false worker sweep"
                    : kind === "kill"
                      ? "KillMode=control-group"
                      : "Unit=other.service") +
                  "\n";
                return {
                  name: `${JSON.stringify(delimiter)}-${kind}-${dropIn}${explicitFirst ? "-explicit-first" : ""}`,
                  service:
                    agentService(command) +
                    (!dropIn && kind !== "timer" ? hidden : ""),
                  timer:
                    (explicitFirst
                      ? agentTimer().replace(
                          "[Timer]",
                          `[Timer]\nUnit=${SERVICE}`,
                        )
                      : agentTimer()) +
                    (!dropIn && kind === "timer" ? "[Timer]\n" + hidden : ""),
                  owned: false,
                  kind,
                  explicitFirst,
                  dropIn: dropIn
                    ? (kind === "timer" ? "[Timer]\n" : "[Service]\n") + hidden
                    : undefined,
                };
              },
            ),
          ),
        ),
      ),
    ];
    const disagreements: Error[] = [];
    const inspect = async (entry: (typeof cases)[number]) => {
      const name = `neuve-parser-${randomUUID()}`;
      const service = join(directory, name + ".service"),
        timer = join(directory, name + ".timer");
      const dropIns = join(
        directory,
        `${name}.${entry.kind === "timer" ? "timer" : "service"}.d`,
      );
      const config = join(dropIns, "space $`quote\"\\'.conf");
      const linkedDropIns = join(
        env.XDG_RUNTIME_DIR ?? "",
        "systemd/user",
        `${name}.${entry.kind === "timer" ? "timer" : "service"}.d`,
      );
      let dropInsLinked = false;
      const units = [name + ".service", name + ".timer"];
      try {
        await writeFile(service, entry.service);
        // Keep the default private target private; explicit foreign targets are unchanged.
        await writeFile(
          timer,
          entry.timer.replaceAll(SERVICE, name + ".service"),
        );
        if (entry.dropIn) {
          await mkdir(dirname(config), { recursive: true });
          await writeFile(config, entry.dropIn);
          await mkdir(dirname(linkedDropIns), { recursive: true });
          await symlink(dropIns, linkedDropIns);
          dropInsLinked = true;
        }
        success(
          await run(
            ["systemctl", "--user", "--runtime", "link", service, timer],
            env,
          ),
        );
        success(await run(["systemctl", "--user", "daemon-reload"], env));
        const observed = success(
          await run(
            [
              "systemctl",
              "--user",
              "show",
              "-p",
              "ExecStart,KillMode,DropInPaths,FragmentPath",
              units[0] ?? "",
            ],
            env,
          ),
        );
        const target = success(
          await run(
            [
              "systemctl",
              "--user",
              "show",
              "-p",
              "Unit,Triggers",
              units[1] ?? "",
            ],
            env,
          ),
        );
        const verdict = entry.dropIn
          ? entry.kind === "timer"
            ? ownsTimer(entry.timer + entry.dropIn)
            : ownsService(entry.service + entry.dropIn, command)
          : entry.kind === "timer"
            ? ownsTimer(entry.timer)
            : ownsService(entry.service, command);
        const timerDropIns =
          entry.dropIn && entry.kind === "timer"
            ? success(
                await run(
                  [
                    "systemctl",
                    "--user",
                    "show",
                    "-p",
                    "DropInPaths",
                    units[1] ?? "",
                  ],
                  env,
                ),
              )
            : "";
        console.info(
          JSON.stringify({
            case: entry.name,
            systemd: { service: observed, timer: target + timerDropIns },
            neuveOwned: verdict,
          }),
        );
        expect(verdict, entry.name).toBe(entry.owned);
        if (entry.owned) {
          expect(observed).toContain(`path=${command} ;`);
          expect(observed).toContain(`argv[]=${command} worker sweep ;`);
          expect(observed).toContain("KillMode=process\n");
        } else if (entry.kind === "kill")
          expect(observed).toContain("KillMode=control-group\n");
        else if (entry.kind === "timer")
          expect(target).toContain(
            `Unit=${entry.explicitFirst ? name + ".service" : "other.service"}\n`,
          );
        else
          expect(observed).not.toContain(
            `path=${command} ; argv[]=${command} worker sweep ;`,
          );
        if (entry.dropIn) {
          // Compare the real printer directly with the fixture's independent encoder.
          const { systemctlArray } = await import("./systemd-fixture.ts");
          expect(observed + timerDropIns).toContain(
            `DropInPaths=${systemctlArray([config])}\n`,
          );
        }
      } finally {
        // disable unlinks only the private names that this iteration linked; no unit was started.
        await run(
          ["systemctl", "--user", "--runtime", "disable", ...units],
          env,
        );
        for (const [unit, source] of [
          [units[0], service],
          [units[1], timer],
        ] as const) {
          if (!unit) throw new Error("Missing private unit name");
          const linked = join(env.XDG_RUNTIME_DIR ?? "", "systemd/user", unit);
          const target = await readlink(linked).catch((error: unknown) => {
            if (
              error instanceof Error &&
              "code" in error &&
              error.code === "ENOENT"
            )
              return null;
            throw error;
          });
          if (target !== null) {
            expect(resolve(dirname(linked), target)).toBe(source);
            await rm(linked);
          }
        }
        await rm(service, { force: true });
        await rm(timer, { force: true });
        if (dropInsLinked) await rm(linkedDropIns);
        await rm(dirname(config), { recursive: true, force: true });
        success(await run(["systemctl", "--user", "daemon-reload"], env));
        await run(["systemctl", "--user", "reset-failed", ...units], env);
      }
    };
    try {
      for (const entry of cases) {
        try {
          await inspect(entry);
        } catch (error) {
          disagreements.push(
            new Error(
              `Systemd parser case ${entry.name} disagreed: ${String(error)}`,
              { cause: error },
            ),
          );
        }
      }
      if (disagreements.length)
        throw new AggregateError(
          disagreements,
          disagreements.map((error) => error.message).join("\n"),
        );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  150_000,
);
