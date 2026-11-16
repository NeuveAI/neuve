import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  otherOwnerMessage,
  agentService,
  agentTimer,
  agentUnitPaths,
  FOREIGN,
  INSTALLED,
  NO_USER_SYSTEMD,
  TIMER,
  UNSAFE,
  UNSUPPORTED_EXECUTABLE,
} from "../../packages/records-core/src/systemd.ts";
import { writeChecksums } from "../../scripts/release/checksums.ts";
import { systemdFixture } from "./systemd-fixture.ts";

const root = resolve(import.meta.dir, "../..");
const installer = join(root, "scripts/install.sh");
const shells: string[] = [];
const seen = new Set<string>();
for (const shell of ["sh", "dash"]) {
  const executable = Bun.which(shell);
  if (!executable) continue;
  const path = await realpath(executable);
  if (!seen.has(path)) shells.push(shell);
  seen.add(path);
}
let assets: string;
let archive: string;
let sums: string;
let driver: string;
const version = "0.1.0-systemd.fixture";
const commandGroups = new Set<number>();
const stopCommandGroup = (pid: number) => {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH"))
      throw error;
  }
};
const stopCommands = () => {
  for (const pid of commandGroups) stopCommandGroup(pid);
};
process.on("exit", stopCommands);
process.once("SIGINT", () => {
  stopCommands();
  process.exit(130);
});
process.once("SIGTERM", () => {
  stopCommands();
  process.exit(143);
});
const run = async (args: string[], env: NodeJS.ProcessEnv) => {
  const [command, ...parameters] = args;
  if (!command) throw new Error("Missing owned command");
  const child = spawn(command, parameters, {
    env,
    cwd: root,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (child.pid) commandGroups.add(child.pid);
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (bytes) => {
    stdout += bytes;
  });
  child.stderr.on("data", (bytes) => {
    stderr += bytes;
  });
  const closed = new Promise<void>((resolve) =>
    child.once("close", () => resolve()),
  );
  let code: number;
  try {
    code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (value, signal) =>
        resolve(
          value ??
            (signal === "SIGKILL"
              ? 137
              : signal === "SIGTERM"
                ? 143
                : signal === "SIGINT"
                  ? 130
                  : 1),
        ),
      );
    });
  } finally {
    // Exit and pipe EOF are different events. Reap this command's descendants
    // before waiting for capture closure, including after test cancellation.
    if (child.pid) {
      stopCommandGroup(child.pid);
      commandGroups.delete(child.pid);
    }
    await closed;
  }
  return { stdout, stderr, code };
};

const success = (result: Awaited<ReturnType<typeof run>>) =>
  expect(result, result.stdout + result.stderr).toMatchObject({ code: 0 });
const exists = async (path: string) =>
  (await lstat(path).catch(() => null)) !== null;
const mutations = (calls: string[]) =>
  calls.filter((line) =>
    /^(?:daemon-reload|enable|disable|stop)(?: |$)/.test(line),
  );

beforeAll(async () => {
  assets = await mkdtemp(join(tmpdir(), "neuve-systemd-release-"));
  driver = join(assets, "agent.ts");
  await writeFile(
    driver,
    `import { mock } from "bun:test";
import fs from "node:fs/promises";
import { basename } from "node:path";
const kill = () => { process.kill(-Number(process.env.NEUVE_INSTALL_GROUP), "SIGKILL"); return new Promise(() => {}); };
const boundary = process.env.NEUVE_WRITE_BOUNDARY;
const unit = process.env.NEUVE_WRITE_UNIT;
if (boundary) {
  const open = fs.open, rename = fs.rename, link = fs.link;
  mock.module("node:fs/promises", () => ({ ...fs,
    open: async (path, ...args) => {
      const temporary = basename(String(path)).startsWith(".neuve-worker-");
      if (temporary && boundary === "before-temp" && process.env.NEUVE_PUBLISHING === unit) await kill();
      const handle = await open(path, ...args);
      if (temporary) {
        const write = handle.writeFile.bind(handle), sync = handle.sync.bind(handle);
        handle.writeFile = async (bytes, ...args) => {
          const text = String(bytes);
          if (text.startsWith("[Unit]")) process.env.NEUVE_PUBLISHING = text.includes("ExecStart=") ? "service" : "timer";
          await write(bytes, ...args);
        };
        handle.sync = async () => { await sync(); if (boundary === "after-written" && process.env.NEUVE_PUBLISHING === unit) await kill(); };
      }
      // The old writer exposes an empty destination between truncate and write.
      if (String(path).endsWith("dev.neuve.worker." + unit)) {
        const truncate = handle.truncate.bind(handle);
        handle.truncate = async (...args) => { await truncate(...args); await kill(); };
      }
      return handle;
    },
    link: async (source, destination) => {
      await link(source, destination);
      process.env.NEUVE_PUBLISHING = String(destination).endsWith(".service") ? "service" : "timer";
      if (boundary === "after-claim" && process.env.NEUVE_PUBLISHING === unit) await kill();
    },
    rename: async (source, destination) => {
      await rename(source, destination);
      if (boundary === "after-rename" && String(destination).endsWith("dev.neuve.worker." + unit)) await kill();
    },
  }));
}
if (process.env.NEUVE_REMOVE_UNIT && process.env.NEUVE_ROLLBACK_AGENT_RECEIPT) {
  const unlink = fs.unlink;
  mock.module("node:fs/promises",()=>({...fs,unlink:async path=>{
    if(String(path).endsWith("dev.neuve.worker."+process.env.NEUVE_REMOVE_UNIT)) {
      await fs.writeFile(process.env.NEUVE_SYSTEMD_STATE+"/paused","");
      while(!await fs.lstat(process.env.NEUVE_TEST_RESUME).catch(()=>null)) await Bun.sleep(20);
    }
    return unlink(path);
  }}));
}
const Systemd = await import(${JSON.stringify(join(root, "packages/records-core/src/systemd.ts"))});
const [, , command, action, flag] = Bun.argv;
if (!command) throw new Error("Missing executable");
if (process.env.NEUVE_ROLLBACK_AGENT_RECEIPT && process.env.NEUVE_TEST_ROLLBACK_PID) await fs.writeFile(process.env.NEUVE_TEST_ROLLBACK_PID,String(process.pid));
const options = {command, load: flag !== "--no-load", receipt: process.env.NEUVE_INSTALL_AGENT_RECEIPT};
if (action === "uninstall-agent" && !process.env.NEUVE_ROLLBACK_AGENT_RECEIPT) {
  const core = await import(${JSON.stringify(join(root, "packages/records-core/src/index.ts"))});
  mock.module(${JSON.stringify(join(root, "packages/records-core/src/index.ts"))},()=>({...core,Starter:{...core.Starter,currentCliCommand:()=>[command]}}));
  Object.defineProperty(process,"platform",{value:"linux"});
  const {runWorkerCli}=await import(${JSON.stringify(join(root, "apps/neuve-cli/src/worker-cli.ts"))});
  process.exit(await runWorkerCli([action,...(flag ? [flag] : [])]));
}
const message = process.env.NEUVE_ROLLBACK_AGENT_RECEIPT
  ? await Systemd.rollbackAgent({...options, receipt: process.env.NEUVE_ROLLBACK_AGENT_RECEIPT})
  : await (action === "install-agent" ? Systemd.installAgent : Systemd.uninstallAgent)(options);
if (action === "install-agent" && process.env.NEUVE_TEST_FAIL_AFTER_AGENT === "1") process.exit(81);
console.log(message);
if (action === "uninstall-agent" && ([Systemd.FOREIGN, Systemd.UNSAFE, Systemd.ROLLBACK_REFUSED].includes(message))) process.exitCode = 1;
`,
  );
  const target = `linux-${process.arch}`;
  const name = `neuve-${target}`;
  const content = join(assets, "content");
  const stage = join(content, name);
  const cli = `#!/bin/sh
case "$1" in
  --version) printf 'neuve ${version}\\n' ;;
  worker) exec "$NEUVE_TEST_BUN" --no-env-file "$NEUVE_TEST_DRIVER" "$0" "$2" "\${3:-}" ;;
  *) exit 97 ;;
esac
`;
  for (const [path, bytes] of Object.entries({
    "bin/neuve": cli,
    "lib/neuve/entire-graph": "#!/bin/sh\nexit 0\n",
    "lib/neuve/install.json.in": "{}\n",
    "lib/neuve/release.json":
      JSON.stringify(
        {
          schemaVersion: 1,
          version,
          target,
          cliSha256: createHash("sha256").update(cli).digest("hex"),
        },
        null,
        2,
      ) + "\n",
  })) {
    await mkdir(dirname(join(stage, path)), { recursive: true });
    await writeFile(join(stage, path), bytes, {
      mode:
        path.endsWith("neuve") || path.endsWith("entire-graph") ? 0o755 : 0o644,
    });
  }
  archive = join(assets, `${name}.tar.gz`);
  success(
    await run(["tar", "-czf", archive, "-C", content, name], {
      ...process.env,
      COPYFILE_DISABLE: "1",
    }),
  );
  await writeChecksums(assets);
  sums = join(assets, "SHA256SUMS");
});
afterAll(async () => {
  if (assets) await rm(assets, { recursive: true, force: true });
});
const context = async (prefixName = "release copy") => {
  const fixture = await systemdFixture();
  // A Linux platform shim lets the actual POSIX installer run on the Mac too.
  await writeFile(
    join(fixture.wrappers, "uname"),
    `#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo ${process.arch === "arm64" ? "aarch64" : "x86_64"} ;; esac\n`,
    { mode: 0o755 },
  );
  await writeFile(
    join(fixture.wrappers, "getconf"),
    "#!/bin/sh\necho 'glibc 2.35'\n",
    { mode: 0o755 },
  );
  const prefix = join(fixture.home, prefixName);
  const env: NodeJS.ProcessEnv = {
    ...fixture.env,
    NEUVE_TEST_BUN: process.execPath,
    NEUVE_TEST_DRIVER: driver,
    NEUVE_NO_MODIFY_PATH: "1",
    NEUVE_NO_AGENT: "0",
    NEUVE_AGENT_NO_LOAD: "0",
    SHELL: "/bin/sh",
    NEUVE_VERSION: "latest",
  };
  const args = (shell: string, extra: string[] = [], location = prefix) => [
    shell,
    installer,
    "--prefix",
    location,
    "--archive",
    archive,
    "--checksums",
    sums,
    ...extra,
  ];
  return {
    ...fixture,
    prefix,
    env,
    args,
    paths: agentUnitPaths(fixture.home, env.XDG_CONFIG_HOME),
  };
};

// A completed command can leave a descendant holding its capture pipes open.
for (const shell of shells)
  test(`command capture reaps inherited output holders: ${shell}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "neuve-command-capture-"));
    const pidFile = join(directory, "child.pid");
    let finished = false;
    const pending = run(
      [
        shell,
        "-c",
        'sleep 30 & printf "%s\\n" "$!" >"$1"; printf ready',
        "capture",
        pidFile,
      ],
      process.env,
    );
    pending.then(() => {
      finished = true;
    });
    let completed = false;
    let result: Awaited<ReturnType<typeof run>> | undefined;
    try {
      await Promise.race([pending, Bun.sleep(1000)]);
      completed = finished;
    } finally {
      if (!finished) {
        const pid = Number(await readFile(pidFile, "utf8"));
        if (!Number.isSafeInteger(pid) || pid <= 1)
          throw new Error("Invalid owned capture child PID");
        try {
          process.kill(pid, "SIGKILL");
        } catch (error) {
          if (!(
            error instanceof Error &&
            "code" in error &&
            error.code === "ESRCH"
          ))
            throw error;
        }
      }
      result = await pending;
      await rm(directory, { recursive: true, force: true });
    }
    expect(completed).toBe(true);
    expect(result).toEqual({ code: 0, stdout: "ready", stderr: "" });
  }, 5000);

// F40: an identified winner must not prevent removing either form of the losing copy.
for (const shell of shells)
  for (const missing of [false, true])
    test(`F40 removes losing Linux payload: ${shell}/missing=${missing}`, async () => {
      const c = await context();
      try {
        const other = join(c.home, "winner");
        success(await run(c.args(shell), c.env));
        success(
          await run(
            [join(c.prefix, "bin/neuve"), "worker", "uninstall-agent"],
            c.env,
          ),
        );
        success(await run(c.args(shell, [], other), c.env));
        const winningFiles = await Promise.all(
          [
            "bin/neuve",
            "lib/neuve/release.json",
            "lib/neuve/install.json",
            "lib/neuve/entire-graph",
          ].map((file) => readFile(join(other, file))),
        );
        const service = await readFile(c.paths.service);
        const timer = await readFile(c.paths.timer);
        if (missing) await rm(join(c.prefix, "bin/neuve"));
        await c.clear();
        const result = await run(c.args(shell, ["--uninstall"]), c.env);
        success(result);
        expect(result.stdout).toContain(otherOwnerMessage(other));
        expect(await exists(join(c.prefix, "lib/neuve"))).toBe(false);
        expect(await exists(join(c.prefix, "bin/neuve"))).toBe(false);
        expect(
          await Promise.all(
            [
              "bin/neuve",
              "lib/neuve/release.json",
              "lib/neuve/install.json",
              "lib/neuve/entire-graph",
            ].map((file) => readFile(join(other, file))),
          ),
        ).toEqual(winningFiles);
        expect(await readFile(c.paths.service)).toEqual(service);
        expect(await readFile(c.paths.timer)).toEqual(timer);
        expect(await exists(join(c.state, "enabled"))).toBe(true);
        expect(await exists(join(c.state, "active"))).toBe(true);
        expect(mutations(await c.calls())).toEqual([]);
      } finally {
        await c.close();
      }
    }, 20_000);

// F47: loss of the executable must never bypass the CLI's refusal boundaries.
for (const shell of shells)
  for (const missing of [false, true])
    for (const kind of [
      "foreign-service",
      "foreign-timer",
      "service-link",
      "timer-hardlink",
      "readonly-timer",
      "dropin-service",
      "dropin-timer",
      "owner-alias",
    ])
      test(`F47 unsafe other owner keeps losing payload: ${shell}/${kind}/missing=${missing}`, async () => {
        const c = await context();
        try {
          const other = join(c.home, "winner");
          success(await run(c.args(shell), c.env));
          success(
            await run(
              [join(c.prefix, "bin/neuve"), "worker", "uninstall-agent"],
              c.env,
            ),
          );
          success(await run(c.args(shell, [], other), c.env));
          if (missing) await rm(join(c.prefix, "bin/neuve"));
          if (kind === "owner-alias") {
            await writeFile(
              c.paths.service,
              agentService(
                join(c.prefix, "bin/neuve").replace(
                  "/bin/neuve",
                  "/lib/../bin/neuve",
                ),
              ),
            );
            c.env.NEUVE_AGENT_NO_LOAD = "1";
          }
          if (kind === "foreign-service")
            await writeFile(
              c.paths.service,
              "[Service]\nExecStart=/usr/bin/false worker sweep\nKillMode=process\n",
            );
          if (kind === "foreign-timer")
            await writeFile(c.paths.timer, "[Timer]\nUnit=other.service\n");
          if (kind === "service-link") {
            const external = join(c.directory, "external-service");
            await writeFile(external, await readFile(c.paths.service));
            await rm(c.paths.service);
            await symlink(external, c.paths.service);
          }
          if (kind === "timer-hardlink")
            await link(c.paths.timer, join(c.directory, "external-timer"));
          if (kind === "readonly-timer") await chmod(c.paths.timer, 0o444);
          if (kind.startsWith("dropin-")) {
            const folder = join(
              c.paths.directory,
              `dev.neuve.worker.${kind.slice(7)}.d`,
            );
            await mkdir(folder);
            await writeFile(
              join(folder, "foreign.conf"),
              kind === "dropin-service"
                ? "[Service]\nExecStart=\nExecStart=/usr/bin/false worker sweep\n"
                : "[Timer]\nUnit=other.service\n",
            );
          }
          const bytes = await Promise.all(
            [c.paths.service, c.paths.timer].map((path) => readFile(path)),
          );
          const marker = await readFile(
            join(c.prefix, "lib/neuve/release.json"),
          );
          await c.clear();
          const result = await run(c.args(shell, ["--uninstall"]), c.env);
          expect(result.code, result.stdout + result.stderr).toBe(1);
          expect(
            await readFile(join(c.prefix, "lib/neuve/release.json")),
          ).toEqual(marker);
          expect(await exists(join(c.prefix, "bin/neuve"))).toBe(!missing);
          expect(
            await Promise.all(
              [c.paths.service, c.paths.timer].map((path) => readFile(path)),
            ),
          ).toEqual(bytes);
          expect(await exists(join(c.state, "enabled"))).toBe(true);
          expect(await exists(join(c.state, "active"))).toBe(true);
          expect(mutations(await c.calls())).toEqual([]);
        } finally {
          await chmod(c.paths.timer, 0o644).catch(() => {});
          await c.close();
        }
      }, 20_000);

// F42: each manager boundary can receive a second group TERM during rollback.
for (const shell of shells)
  for (const step of [
    "show",
    "stop",
    "disable",
    "unlink-service",
    "unlink-timer",
    "daemon-reload",
    "refusal",
    "refusal-special-prefix",
    "direct-term",
  ])
    test(`F42 second TERM during Linux agent rollback: ${shell}/${step}`, async () => {
      const c = await context(
        step === "refusal-special-prefix"
          ? "release $cash `literal`"
          : "release copy",
      );
      let child: ReturnType<typeof spawn> | undefined;
      let closed = false;
      let completion: Promise<number | null> | undefined;
      const resume = join(c.directory, "resume");
      try {
        const wrapper = join(c.wrappers, "systemctl");
        await writeFile(
          wrapper,
          (await readFile(wrapper, "utf8")).replace(
            'case "$1" in',
            `
if [ -n "\${NEUVE_ROLLBACK_AGENT_RECEIPT:-}" ] && [ "$1" = "${step.startsWith("refusal") || step === "direct-term" ? "show" : step}" ] && [ ! -f "$NEUVE_SYSTEMD_STATE/paused" ]; then
 : >"$NEUVE_SYSTEMD_STATE/paused"
 while [ ! -f "$NEUVE_TEST_RESUME" ]; do /bin/sleep 0.02; done
 ${step.startsWith("refusal") ? "exit 80" : ""}
fi
case "$1" in`,
          ),
        );
        const args = [
          shell,
          "-c",
          'printf() { command printf "$@"; case "${2:-}" in "Installed neuve "*) kill -TERM "$$" ;; esac; }; script=$1; shift; . "$script"',
          "rollback-signal",
          ...c.args(shell).slice(1),
        ];
        child = spawn(args[0]!, args.slice(1), {
          env: {
            ...c.env,
            NEUVE_TEST_RESUME: resume,
            NEUVE_TEST_ROLLBACK_PID: join(c.directory, "rollback.pid"),
            ...(step.startsWith("unlink-")
              ? { NEUVE_REMOVE_UNIT: step.slice(7) }
              : {}),
          },
          cwd: root,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "",
          stderr = "";
        child.stdout?.on("data", (bytes) => (stdout += bytes));
        child.stderr?.on("data", (bytes) => (stderr += bytes));
        completion = new Promise((resolve, reject) => {
          child!.once("error", reject);
          child!.once("close", (code) => {
            closed = true;
            resolve(code);
          });
        });
        const deadline = Date.now() + 15_000;
        while (!(await exists(join(c.state, "paused")))) {
          if (closed || Date.now() > deadline)
            throw new Error(`No rollback pause: ${stdout}${stderr}`);
          await Bun.sleep(20);
        }
        if (!child.pid) throw new Error("Missing owned installer PID");
        if (step === "direct-term") {
          const pid = Number(
            await readFile(join(c.directory, "rollback.pid"), "utf8"),
          );
          if (!Number.isSafeInteger(pid) || pid <= 1)
            throw new Error("Invalid owned rollback PID");
          process.kill(pid, "SIGTERM");
        } else if (!step.startsWith("refusal"))
          process.kill(-child.pid, "SIGTERM");
        await writeFile(resume, "");
        expect(await completion, stdout + stderr).not.toBe(0);
        const cli = await exists(join(c.prefix, "bin/neuve"));
        if (step.startsWith("refusal") || step === "direct-term") {
          expect(cli, stdout + stderr).toBe(true);
          expect(await exists(c.paths.service)).toBe(true);
          expect(await exists(c.paths.timer)).toBe(true);
          expect(await exists(join(c.state, "enabled"))).toBe(true);
          expect(await exists(join(c.state, "active"))).toBe(true);
          // Run the advice itself: quoting must preserve spaces, dollars and backticks.
          const advice =
            /reported above, run (.+), then run the installer again\./.exec(
              stderr,
            )?.[1];
          if (!advice) throw new Error("Missing recovery command: " + stderr);
          success(await run([shell, "-c", advice], c.env));
          for (const path of [
            c.paths.service,
            c.paths.timer,
            join(c.state, "enabled"),
            join(c.state, "active"),
          ])
            expect(await exists(path)).toBe(false);
        } else {
          expect(cli, stdout + stderr).toBe(false);
          for (const path of [
            c.paths.service,
            c.paths.timer,
            join(c.state, "enabled"),
            join(c.state, "active"),
          ])
            expect(await exists(path), stdout + stderr).toBe(false);
          expect(
            await readFile(join(c.state, "dev.neuve.worker.service"), "utf8"),
          ).toBe("");
          expect(
            await readFile(join(c.state, "dev.neuve.worker.timer"), "utf8"),
          ).toBe("");
        }
        expect(await exists(join(c.prefix, ".install.lock"))).toBe(false);
      } finally {
        await writeFile(resume, "");
        if (child?.pid && !closed) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        }
        await completion;
        await c.close();
      }
    }, 25_000);

for (const shell of shells) {
  // A successful install and upgrade exercise the complete Linux shell-to-module transaction.
  test(`Linux installer registers, preserves a running timer on upgrade, and uninstalls: ${shell}`, async () => {
    const c = await context();
    try {
      const installed = await run(c.args(shell), c.env);
      success(installed);
      expect(installed.stdout).toContain(`neuve install: ${INSTALLED}\n`);
      const service = await readFile(c.paths.service, "utf8");
      const timer = await readFile(c.paths.timer, "utf8");
      expect(service.toString()).toBe(
        agentService(join(c.prefix, "bin/neuve")),
      );
      const previous = mutations(await c.calls());
      const upgraded = await run(c.args(shell), c.env);
      success(upgraded);
      expect(upgraded.stdout).toContain(
        "The systemd timer already runs this install.",
      );
      expect(await readFile(c.paths.service, "utf8")).toBe(service);
      expect(await readFile(c.paths.timer, "utf8")).toBe(timer);
      expect(mutations(await c.calls())).toEqual(previous);
      success(await run(c.args(shell, ["--uninstall"]), c.env));
      expect(await exists(c.paths.service)).toBe(false);
      expect(await exists(c.paths.timer)).toBe(false);
      expect(await exists(join(c.state, "enabled"))).toBe(false);
      expect(await exists(c.prefix)).toBe(false);
    } finally {
      await c.close();
    }
  }, 12_000);
  // Containers and WSL must still get a usable CLI without a user manager.
  for (const kind of ["no-runtime", "no-bus-wsl", "failed-manager", "opt-out"])
    test(`Linux installer skips registration: ${shell}/${kind}`, async () => {
      const c = await context();
      try {
        if (kind === "no-runtime") delete c.env.XDG_RUNTIME_DIR;
        if (kind === "no-bus-wsl") {
          c.env.XDG_RUNTIME_DIR = c.directory;
          c.env.PATH += ":/mnt/c/Windows/System32:/mnt/c/Tools";
          await writeFile(
            join(c.directory, "proc-version"),
            "Linux version Microsoft WSL2\n",
          );
        }
        if (kind === "failed-manager") c.env.NEUVE_SYSTEMD_OFF = "1";
        const result = await run(
          c.args(shell, kind === "opt-out" ? ["--no-agent"] : []),
          c.env,
        );
        success(result);
        if (kind !== "opt-out")
          expect(result.stdout).toContain(
            `neuve install: ${NO_USER_SYSTEMD}\n`,
          );
        expect(await exists(join(c.prefix, "bin/neuve"))).toBe(true);
        expect(await exists(c.paths.service)).toBe(false);
        expect(mutations(await c.calls())).toEqual([]);
      } finally {
        await c.close();
      }
    }, 8_000);
  test(`Linux installer retains a working CLI in a prefix containing an apostrophe: ${shell}`, async () => {
    const c = await context();
    try {
      const prefix = join(c.home, "owner's release");
      const installed = await run(c.args(shell, [], prefix), c.env);
      success(installed);
      expect(installed.stdout).toContain(UNSUPPORTED_EXECUTABLE);
      expect(await exists(join(prefix, "bin/neuve"))).toBe(true);
      expect(await exists(c.paths.service)).toBe(false);
      expect(mutations(await c.calls())).toEqual([]);
    } finally {
      await c.close();
    }
  }, 8_000);
  // A failed start rolls back payload and unit claims, allowing an ordinary retry.
  test(`Linux installer rolls back failed starts and preserves owned bytes on failed repair: ${shell}`, async () => {
    const c = await context();
    try {
      c.env.NEUVE_FAIL_ENABLE = "1";
      const failed = await run(c.args(shell), c.env);
      expect(failed.code).toBe(1);
      expect(await exists(c.paths.service)).toBe(false);
      expect(await exists(c.paths.timer)).toBe(false);
      expect(await exists(c.prefix)).toBe(false);
      c.env.NEUVE_FAIL_ENABLE = "0";
      success(await run(c.args(shell), c.env));
      const service = await readFile(c.paths.service, "utf8");
      const timer = await readFile(c.paths.timer, "utf8");
      await rm(join(c.state, "enabled"));
      await rm(join(c.state, "active"));
      c.env.NEUVE_FAIL_ENABLE = "1";
      expect((await run(c.args(shell), c.env)).code).toBe(1);
      expect(await readFile(c.paths.service, "utf8")).toBe(service);
      expect(await readFile(c.paths.timer, "utf8")).toBe(timer);
      c.env.NEUVE_FAIL_ENABLE = "0";
      success(await run(c.args(shell), c.env));
      expect(await exists(join(c.state, "active"))).toBe(true);
    } finally {
      await c.close();
    }
  }, 15_000);
  // The claim is shared across prefixes, so exactly one concurrent installer owns it.
  test(`Linux installer keeps one winner across two-prefix claim races: ${shell}`, async () => {
    const c = await context();
    try {
      const other = join(c.home, "second copy");
      const results = await Promise.all([
        run(c.args(shell), c.env),
        run(c.args(shell, [], other), c.env),
      ]);
      results.forEach(success);
      const text = await readFile(c.paths.service, "utf8");
      const winner = text.includes(other) ? other : c.prefix;
      const loser = winner === other ? c.prefix : other;
      expect(text).toBe(agentService(join(winner, "bin/neuve")));
      expect(results.map((result) => result.stdout).join("\n")).toContain(
        otherOwnerMessage(winner),
      );
      expect(
        (await c.calls()).filter((line) => line === `enable --now ${TIMER}`),
      ).toHaveLength(1);
      await c.clear();
      expect(
        (await run(c.args(shell, ["--uninstall"], loser), c.env)).code,
      ).toBe(0);
      expect(await readFile(c.paths.service, "utf8")).toBe(text);
      expect(mutations(await c.calls())).toEqual([]);
      success(await run(c.args(shell, ["--uninstall"], winner), c.env));
    } finally {
      await c.close();
    }
  }, 12_000);
  // A later shell failure must undo successful registration and restore prior unit bytes.
  for (const prior of ["missing", "disabled"])
    test(`Linux installer rolls back after successful registration: ${shell}/${prior}`, async () => {
      const c = await context();
      try {
        let service: string | undefined;
        let timer: string | undefined;
        if (prior === "disabled") {
          success(await run(c.args(shell), c.env));
          await writeFile(
            c.paths.service,
            (await readFile(c.paths.service, "utf8")) + "# custom bytes\n",
          );
          service = await readFile(c.paths.service, "utf8");
          timer = await readFile(c.paths.timer, "utf8");
          await rm(join(c.state, "enabled"));
          await rm(join(c.state, "active"));
        }
        const failed = await run(
          [
            shell,
            "-c",
            `printf() { command printf "$@"; case "\${2:-}" in "Installed neuve "*) exit 61 ;; esac; }; script=$1; shift; . "$script"`,
            "post-registration-fault",
            ...c.args(shell).slice(1),
          ],
          c.env,
        );
        expect(failed.code).toBe(61);
        expect(await exists(join(c.state, "enabled"))).toBe(
          prior === "disabled",
        );
        expect(await exists(join(c.state, "active"))).toBe(
          prior === "disabled",
        );
        if (prior === "missing") {
          expect(await exists(c.paths.service)).toBe(false);
          expect(await exists(c.paths.timer)).toBe(false);
          expect(await exists(c.prefix)).toBe(false);
        } else {
          if (service === undefined || timer === undefined)
            throw new Error("Missing original units");
          expect(await readFile(c.paths.service, "utf8")).toBe(service);
          expect(await readFile(c.paths.timer, "utf8")).toBe(timer);
        }
        success(await run(c.args(shell), c.env));
      } finally {
        await c.close();
      }
    }, 12_000);
  // A receipt must be honored even if the CLI fails before it can print success.
  test(`Linux installer rolls back a CLI failure after registration: ${shell}`, async () => {
    const c = await context();
    try {
      c.env.NEUVE_TEST_FAIL_AFTER_AGENT = "1";
      const failed = await run(c.args(shell), c.env);
      expect(failed.code).toBe(1);
      expect(await exists(c.paths.service)).toBe(false);
      expect(await exists(c.paths.timer)).toBe(false);
      expect(await exists(join(c.state, "enabled"))).toBe(false);
      expect(await exists(join(c.state, "active"))).toBe(false);
      expect(await exists(c.prefix)).toBe(false);
      c.env.NEUVE_TEST_FAIL_AFTER_AGENT = "0";
      success(await run(c.args(shell), c.env));
    } finally {
      await c.close();
    }
  }, 10_000);
  // A SIGKILL after the claim or file writes cannot strand the prefix after the documented recovery.
  for (const boundary of ["claim", "written"])
    test(`Linux installer recovers KILL and --force: ${shell}/${boundary}`, async () => {
      const c = await context();
      try {
        const systemctl = join(c.wrappers, "systemctl");
        const original = await readFile(systemctl, "utf8");
        c.env.NEUVE_CLAIM_PATH = c.paths.service;
        await writeFile(
          systemctl,
          original.replace(
            'case "$1" in',
            `if [ "$1" = ${boundary === "claim" ? "is-enabled" : "daemon-reload"} ] && [ -f "$NEUVE_CLAIM_PATH" ] && [ ! -f "$NEUVE_SYSTEMD_STATE/killed" ]; then
  : >"$NEUVE_SYSTEMD_STATE/killed"
  kill -KILL -"$NEUVE_INSTALL_GROUP"
fi
case "$1" in`,
          ),
        );
        const command = c.args(shell);
        const child = spawn(
          shell,
          [
            "-c",
            'export NEUVE_INSTALL_GROUP=$$; exec "$@"',
            "kill-systemd",
            ...command,
          ],
          { env: c.env, cwd: root, detached: true, stdio: "ignore" },
        );
        let closed = false;
        const stop = () => {
          if (!closed && child.pid) {
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
        const timeout = setTimeout(stop, 10_000);
        try {
          const signal = await new Promise<string | null>((resolve, reject) => {
            child.once("error", reject);
            child.once("close", (_code, signal) => {
              closed = true;
              resolve(signal);
            });
          });
          expect(signal).toBe("SIGKILL");
        } finally {
          clearTimeout(timeout);
          stop();
        }
        const text = await readFile(c.paths.service, "utf8");
        expect(text).toBe(
          boundary === "claim"
            ? `Neuve installer claim\n${c.prefix}\n`
            : agentService(join(c.prefix, "bin/neuve")),
        );
        expect(await readFile(c.paths.timer, "utf8").catch(() => null)).toBe(
          boundary === "claim" ? null : agentTimer(),
        );
        expect((await run(c.args(shell), c.env)).stderr).toContain(
          "Then run the same command again with --force.",
        );
        await rm(join(c.prefix, ".install.lock"), { recursive: true });
        success(await run(c.args(shell, ["--force"]), c.env));
        expect(await readFile(c.paths.service, "utf8")).toBe(
          agentService(join(c.prefix, "bin/neuve")),
        );
        expect(await readFile(c.paths.timer, "utf8")).toBe(agentTimer());
        expect(await exists(join(c.state, "enabled"))).toBe(true);
        expect(await exists(join(c.state, "active"))).toBe(true);
      } finally {
        await c.close();
      }
    }, 15_000);
  // systemd's token separators exclude Unicode spaces, even next to a closing quote.
  for (const character of ["\u00a0", "\u2003", "\ufeff"])
    test(`Linux installer refuses Unicode ownership separators: ${shell}/U+${character.charCodeAt(0).toString(16)}`, async () => {
      const c = await context();
      try {
        success(await run(c.args(shell), c.env));
        const service = agentService(join(c.prefix, "bin/neuve")).replace(
          '" worker sweep',
          '"' + character + "worker sweep",
        );
        const timer = await readFile(c.paths.timer);
        await writeFile(c.paths.service, service);
        await c.clear();
        const result = await run(c.args(shell, ["--uninstall"]), c.env);
        expect(result.code).not.toBe(0);
        expect(result.stdout).toContain(FOREIGN);
        expect(await readFile(c.paths.service, "utf8")).toBe(service);
        expect(await readFile(c.paths.timer)).toEqual(timer);
        expect(mutations(await c.calls())).toEqual([]);
      } finally {
        await c.close();
      }
    }, 15_000);
  // Kill the real installer group only after the filesystem reaches each publication boundary.
  for (const unit of ["service", "timer"])
    for (const boundary of [
      "after-claim",
      "before-temp",
      "after-written",
      "after-rename",
    ])
      test(`Linux installer recovers atomic publication: ${shell}/${unit}/${boundary}`, async () => {
        const c = await context();
        let child: ReturnType<typeof spawn> | undefined;
        let closed = false;
        const stop = () => {
          if (!closed && child?.pid) {
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
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          child = spawn(
            shell,
            [
              "-c",
              'export NEUVE_INSTALL_GROUP=$$; exec "$@"',
              "kill-publication",
              ...c.args(shell),
            ],
            {
              env: {
                ...c.env,
                NEUVE_WRITE_UNIT: unit,
                NEUVE_WRITE_BOUNDARY: boundary,
              },
              cwd: root,
              detached: true,
              stdio: "ignore",
            },
          );
          timeout = setTimeout(stop, 12_000);
          const signal = await new Promise<string | null>((resolve, reject) => {
            child?.once("error", reject);
            child?.once("close", (_code, signal) => {
              closed = true;
              resolve(signal);
            });
          });
          expect(signal).toBe("SIGKILL");
          expect(await exists(join(c.prefix, ".install.lock"))).toBe(true);
          const serviceBytes = await readFile(c.paths.service, "utf8");
          const timerBytes = await readFile(c.paths.timer, "utf8").catch(
            () => null,
          );
          const claim = `Neuve installer claim\n${c.prefix}\n`;
          const completeService = agentService(join(c.prefix, "bin/neuve"));
          if (unit === "service") {
            expect([claim, completeService]).toContain(serviceBytes);
            expect(timerBytes).toBeNull();
          } else {
            expect(serviceBytes).toBe(completeService);
            expect([claim, agentTimer()]).toContain(timerBytes ?? "");
          }
          await rm(join(c.prefix, ".install.lock"), { recursive: true });
          success(await run(c.args(shell, ["--force"]), c.env));
          expect(await readFile(c.paths.service, "utf8")).toBe(
            agentService(join(c.prefix, "bin/neuve")),
          );
          expect(await readFile(c.paths.timer, "utf8")).toBe(agentTimer());
          expect(await exists(join(c.state, "enabled"))).toBe(true);
          expect(await exists(join(c.state, "active"))).toBe(true);
          expect(
            (await readdir(c.paths.directory)).filter((name) =>
              name.startsWith(".neuve-worker-"),
            ),
          ).toEqual([]);
        } finally {
          clearTimeout(timeout);
          stop();
          await c.close();
        }
      }, 25_000);
  // A genuine receipt cannot authorize rollback after another prefix takes over.
  test(`Linux installer preserves a replacement registration during rollback: ${shell}`, async () => {
    const c = await context();
    try {
      const handoff = join(c.directory, "handoff.ts");
      const other = join(c.home, "second copy/bin/neuve");
      await writeFile(
        handoff,
        `import {installAgent, uninstallAgent} from ${JSON.stringify(join(root, "packages/records-core/src/systemd.ts"))};
import {readFile, writeFile} from "node:fs/promises";
await uninstallAgent({command: ${JSON.stringify(join(c.prefix, "bin/neuve"))}, load:true});
await installAgent({command:${JSON.stringify(other)}, load:true});
await writeFile(${JSON.stringify(join(c.directory, "replacement-service"))}, await readFile(${JSON.stringify(c.paths.service)}));
await writeFile(${JSON.stringify(join(c.directory, "replacement-timer"))}, await readFile(${JSON.stringify(c.paths.timer)}));
`,
      );
      const failed = await run(
        [
          shell,
          "-c",
          `printf() { command printf "$@"; case "\${2:-}" in "Installed neuve "*) "$NEUVE_TEST_BUN" --no-env-file "$NEUVE_HANDOFF" || exit 99; exit 61 ;; esac; }; script=$1; shift; . "$script"`,
          "stale-receipt",
          ...c.args(shell).slice(1),
        ],
        { ...c.env, NEUVE_HANDOFF: handoff },
      );
      expect(failed.code).not.toBe(0);
      expect(await readFile(c.paths.service)).toEqual(
        await readFile(join(c.directory, "replacement-service")),
      );
      expect(await readFile(c.paths.timer)).toEqual(
        await readFile(join(c.directory, "replacement-timer")),
      );
      expect(await exists(join(c.state, "enabled"))).toBe(true);
      expect(await exists(join(c.state, "active"))).toBe(true);
      expect((await c.calls()).slice(-1)[0]).not.toBe("daemon-reload");
    } finally {
      await c.close();
    }
  }, 20_000);
  // The same preflight must protect both destinations through the installer's CLI call.
  for (const unit of ["service", "timer"] as const)
    test(`Linux installer preserves an unwritable unit: ${shell}/${unit}`, async () => {
      const c = await context();
      const path = c.paths[unit];
      try {
        await mkdir(c.paths.directory, { recursive: true });
        await writeFile(path, "keep read-only bytes\n");
        await chmod(path, 0o444);
        const result = await run(c.args(shell), c.env);
        success(result);
        expect(result.stdout).toContain(UNSAFE);
        expect(await readFile(path, "utf8")).toBe("keep read-only bytes\n");
        expect(mutations(await c.calls())).toEqual([]);
      } finally {
        await chmod(path, 0o644);
        await c.close();
      }
    }, 8_000);
}

// Foreign units and unsafe .config parents explain the filesystem matrix's refusals.
for (const shell of shells)
  for (const kind of [
    "file",
    "readonly",
    "link",
    "dangling",
    "directory",
    "fifo",
    "linked-parent",
    "readonly-parent",
  ])
    test(`uninstall preserves a real unsafe or foreign registration: ${shell}/${kind}`, async () => {
      const c = await context();
      const config = join(c.home, ".config");
      try {
        c.env.NEUVE_NO_AGENT = "1";
        success(await run(c.args(shell), c.env));
        if (kind.endsWith("-parent")) {
          if (kind === "linked-parent") {
            const target = join(c.directory, "managed-config");
            await mkdir(target);
            await symlink(target, config);
          } else await mkdir(config, { mode: 0o555 });
        } else {
          await mkdir(c.paths.directory, { recursive: true });
          if (kind === "file" || kind === "readonly")
            await writeFile(c.paths.service, "# managed configuration\n", {
              mode: kind === "readonly" ? 0o444 : 0o644,
            });
          else if (kind === "directory") {
            await mkdir(c.paths.service);
            await writeFile(join(c.paths.service, "keep"), "keep");
          } else if (kind === "fifo")
            success(await run(["mkfifo", c.paths.service], c.env));
          else {
            const target = join(c.directory, "managed-unit");
            if (kind === "link") await writeFile(target, "keep");
            await symlink(target, c.paths.service);
          }
        }
        const before = await lstat(c.paths.service).catch(() => null);
        const cli = await readFile(join(c.prefix, "bin/neuve"));
        await c.clear();
        const refused = await run(c.args(shell, ["--uninstall"]), c.env);
        expect(refused.code, refused.stdout + refused.stderr).toBe(1);
        expect(refused.stdout).toContain(kind === "file" ? FOREIGN : UNSAFE);
        expect(await readFile(join(c.prefix, "bin/neuve"))).toEqual(cli);
        const after = await lstat(c.paths.service).catch(() => null);
        expect(after?.ino).toBe(before?.ino);
        expect(after?.mode).toBe(before?.mode);
        expect(mutations(await c.calls())).toEqual([]);
        expect(await exists(join(c.prefix, ".install.lock"))).toBe(false);
      } finally {
        if (kind === "readonly-parent") await chmod(config, 0o755);
        await c.close();
      }
    }, 15_000);

// Successful CLIs can change their copy without changing uninstall's meaning.
for (const shell of shells)
  test(`uninstall accepts a successful CLI without matching its wording: ${shell}`, async () => {
    const c = await context();
    try {
      c.env.NEUVE_NO_AGENT = "1";
      success(await run(c.args(shell), c.env));
      const wrapper = join(c.directory, "success.ts");
      await writeFile(wrapper, 'console.log("The timer was removed.");');
      c.env.NEUVE_TEST_DRIVER = wrapper;
      success(await run(c.args(shell, ["--uninstall"]), c.env));
      expect(await exists(join(c.prefix, "bin/neuve"))).toBe(false);
      expect(await exists(join(c.prefix, ".install.lock"))).toBe(false);
    } finally {
      await c.close();
    }
  }, 15_000);

// The CLI owns refusal status. Its wording must not control the installer's decision.
for (const shell of shells)
  for (const refusal of [
    FOREIGN,
    UNSAFE,
    "Left the systemd timer dev.neuve.worker in place instead of undoing it.",
    "missing-manager",
    "missing-cli",
  ])
    test(`uninstall retains CLI when agent removal refuses: ${shell}/${refusal}`, async () => {
      const c = await context();
      try {
        success(await run(c.args(shell), c.env));
        const cli = await readFile(join(c.prefix, "bin/neuve"));
        const service = await readFile(c.paths.service),
          timer = await readFile(c.paths.timer);
        if (refusal === "missing-manager") c.env.NEUVE_SYSTEMD_OFF = "1";
        else if (refusal === "missing-cli")
          await chmod(join(c.prefix, "bin/neuve"), 0o644);
        else {
          const wrapper = join(c.directory, "refuse.ts");
          await writeFile(
            wrapper,
            `console.log(${JSON.stringify(refusal)}); process.exitCode = 1;`,
          );
          c.env.NEUVE_TEST_DRIVER = wrapper;
        }
        await c.clear();
        const result = await run(c.args(shell, ["--uninstall"]), c.env);
        expect(result.code).not.toBe(0);
        expect(await readFile(join(c.prefix, "bin/neuve"))).toEqual(cli);
        expect(await readFile(c.paths.service)).toEqual(service);
        expect(await readFile(c.paths.timer)).toEqual(timer);
        expect(await exists(join(c.state, "enabled"))).toBe(true);
        expect(await exists(join(c.state, "active"))).toBe(true);
        expect(mutations(await c.calls())).toEqual([]);
      } finally {
        await c.close();
      }
    }, 15_000);

// A missing executable only blocks removing this prefix when agent ownership is
// ours or undecidable. Another prefix keeps its complete running registration.
for (const shell of shells)
  for (const owner of [
    "ours",
    "other",
    "foreign",
    "unreadable",
    "foreign-timer",
    "unreadable-timer",
  ])
    test(`missing executable uninstall checks owner: ${shell}/${owner}`, async () => {
      const c = await context();
      try {
        success(await run(c.args(shell), c.env));
        const other = join(c.home, "other copy");
        if (owner === "other" || owner.endsWith("-timer"))
          await writeFile(
            c.paths.service,
            agentService(join(other, "bin/neuve")),
          );
        if (owner === "foreign-timer")
          await writeFile(
            c.paths.timer,
            "[Timer]\nUnit=other.service\nOnBootSec=1min\n",
          );
        if (owner === "foreign")
          await writeFile(
            c.paths.service,
            "[Service]\nExecStart=/usr/bin/true\n",
          );
        if (owner === "other" || owner === "foreign")
          success(await run(["systemctl", "--user", "daemon-reload"], c.env));
        const service = await readFile(c.paths.service),
          timer = await readFile(c.paths.timer);
        if (owner === "unreadable") await chmod(c.paths.service, 0o000);
        if (owner === "unreadable-timer") await chmod(c.paths.timer, 0o000);
        await rm(join(c.prefix, "bin/neuve"));
        await c.clear();
        const result = await run(c.args(shell, ["--uninstall"]), c.env);
        expect(result.code, result.stdout + result.stderr).toBe(
          owner === "other" ? 0 : 1,
        );
        expect(await exists(join(c.prefix, "lib/neuve"))).toBe(
          owner !== "other",
        );
        if (owner === "other")
          expect(result.stdout).toContain(otherOwnerMessage(other));
        await chmod(c.paths.service, 0o644);
        await chmod(c.paths.timer, 0o644);
        expect(await readFile(c.paths.service)).toEqual(service);
        expect(await readFile(c.paths.timer)).toEqual(timer);
        expect(await exists(join(c.state, "enabled"))).toBe(true);
        expect(await exists(join(c.state, "active"))).toBe(true);
        expect(mutations(await c.calls())).toEqual([]);
      } finally {
        await chmod(c.paths.service, 0o644).catch(() => {});
        await chmod(c.paths.timer, 0o644).catch(() => {});
        await c.close();
      }
    }, 30_000);
