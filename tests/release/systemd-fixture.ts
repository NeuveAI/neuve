import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// systemd 249 escape.c: shell_maybe_quote(value, 0), not POSIX $'...' quoting.
export const systemctlArray = (values: string[]) =>
  values
    .map((value) => {
      if (!/[\x00-\x20\x7f"\\`$*?\['()<>|&;!]/.test(value)) return value;
      const escapes: Record<string, string> = {
        "\x07": "\\a",
        "\b": "\\b",
        "\f": "\\f",
        "\n": "\\n",
        "\r": "\\r",
        "\t": "\\t",
        "\v": "\\v",
      };
      return (
        '"' +
        value.replace(
          /[\x00-\x1f\x7f"\\`$]/g,
          (character) =>
            escapes[character] ??
            ('"\\`$'.includes(character)
              ? "\\" + character
              : "\\" + character.charCodeAt(0).toString(8).padStart(3, "0")),
        ) +
        '"'
      );
    })
    .join(" ");

// Only this fake manager sees systemctl commands; the socket is owned by the fixture.
export const systemdFixture = async () => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "neuve-systemd-")),
  );
  const runtime = await realpath(await mkdtemp("/tmp/ns-"));
  const home = join(directory, "home");
  const scratch = join(directory, "scratch");
  const wrappers = join(directory, "wrappers");
  await mkdir(home);
  await mkdir(scratch);
  await mkdir(wrappers);
  const bus = createServer();
  await new Promise<void>((resolve, reject) => {
    bus.once("error", reject);
    bus.listen(join(runtime, "bus"), resolve);
  });
  const log = join(directory, "calls");
  const state = join(directory, "state");
  await mkdir(state);
  const showDriver = join(directory, "show.ts");
  await writeFile(
    showDriver,
    `
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
const state = process.env.NEUVE_SYSTEMD_STATE;
const config = process.env.XDG_CONFIG_HOME;
const reload = Bun.argv[2] === "reload";
const unit = Bun.argv.at(-1);
const service = "dev.neuve.worker.service";
const timer = "dev.neuve.worker.timer";
if (!state || !config) process.exit(98);
const read = (path) => readFile(path, "utf8").catch(() => "");
if (reload) {
  for (const name of [service, timer])
    await writeFile(join(state, name), await read(join(config, "systemd/user", name)));
  await writeFile(join(state, "reloaded"), "yes");
  process.exit(0);
}
if (process.env.NEUVE_FAIL_SHOW === "1") process.exit(80);
if (unit !== service && unit !== timer) process.exit(98);
const fragment = join(config, "systemd/user", unit);
const disk = await read(fragment);
const loaded = await read(join(state, unit));
const text = loaded || disk;
const isService = unit === service;
const exec = text.split("\\n").find((line) => line.startsWith("ExecStart="))?.slice(10) ?? "";
const match = /^"(.*)" worker sweep$/.exec(exec);
const command = match ? match[1].replaceAll("%%", "%") : exec.replace(/ worker sweep$/, "");
const kill = text.split("\\n").filter((line) => line.startsWith("KillMode=")).at(-1)?.slice(9) ?? "control-group";
const target = text.split("\\n").find((line) => line.startsWith("Unit="))?.slice(5) ?? service;
const array = ${systemctlArray.toString()};
const list = (value) => value ? (value.startsWith("[") ? JSON.parse(value) : [value]) : [];
const properties = {
  FragmentPath: !text ? "" : (isService ? process.env.NEUVE_SERVICE_FRAGMENT : process.env.NEUVE_TIMER_FRAGMENT) ?? fragment,
  DropInPaths: process.env.NEUVE_RAW_DROPINS ?? array(list((isService ? process.env.NEUVE_SERVICE_DROPINS : process.env.NEUVE_TIMER_DROPINS) ?? "")),
  ExecStart: process.env.NEUVE_EXEC_START ?? (command ? \`{ path=\${command} ; argv[]=\${command} worker sweep ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0 }\` : ""),
  KillMode: process.env.NEUVE_KILL_MODE ?? kill,
  Triggers: (process.env.NEUVE_RAW_TRIGGERS_JSON ? JSON.parse(process.env.NEUVE_RAW_TRIGGERS_JSON) : process.env.NEUVE_RAW_TRIGGERS) ?? array(list(process.env.NEUVE_TIMER_TRIGGERS ?? (text ? target : ""))),
  NeedDaemonReload: loaded && loaded !== disk || process.env.NEUVE_NEED_RELOAD === "yes" && !(await read(join(state, "reloaded"))) ? "yes" : "no",
};
const keys = Bun.argv[Bun.argv.indexOf("-p") + 1]?.split(",") ?? [];
for (const key of keys) console.log(\`\${key}=\${properties[key] ?? ""}\`);
`,
  );
  await writeFile(
    join(wrappers, "systemctl"),
    `#!/bin/sh
[ "$1" = --user ] || exit 99
shift
printf '%s\\n' "$*" >>"$NEUVE_SYSTEMD_LOG"
case "$1" in
  show-environment) [ "\${NEUVE_SYSTEMD_OFF:-0}" != 1 ] ;;
  daemon-reload)
    [ "\${NEUVE_FAIL_RELOAD:-0}" != 1 ] || exit 1
    exec "$NEUVE_SYSTEMD_BUN" --no-env-file "$NEUVE_SYSTEMD_SHOW" reload ;;
  is-enabled) [ -f "$NEUVE_SYSTEMD_STATE/enabled" ] ;;
  is-active) [ -f "$NEUVE_SYSTEMD_STATE/active" ] ;;
  enable)
    : >"$NEUVE_SYSTEMD_STATE/enabled"
    [ "\${NEUVE_FAIL_ENABLE:-0}" != 1 ] || exit 78
    if [ "\${2:-}" = --now ]; then : >"$NEUVE_SYSTEMD_STATE/active"; fi ;;
  disable)
    [ "\${NEUVE_FAIL_DISABLE:-0}" != 1 ] || exit 79
    rm -f "$NEUVE_SYSTEMD_STATE/enabled"
    if [ "\${2:-}" = --now ]; then rm -f "$NEUVE_SYSTEMD_STATE/active"; fi ;;
  stop) rm -f "$NEUVE_SYSTEMD_STATE/active" ;;
  show) exec "$NEUVE_SYSTEMD_BUN" --no-env-file "$NEUVE_SYSTEMD_SHOW" "$@" ;;
  *) exit 98 ;;
esac
`,
    { mode: 0o755 },
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    TMPDIR: scratch,
    BUN_TMPDIR: scratch,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_RUNTIME_DIR: runtime,
    XDG_CONFIG_DIRS: join(home, "config-dirs"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_DATA_DIRS: join(home, "data-dirs"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local/state"),
    NEUVE_BUDGET_DIRECTORY: join(home, "budget"),
    PATH: `${wrappers}:${join(process.execPath, "..")}:/usr/bin:/bin:/usr/sbin:/sbin`,
    NEUVE_SYSTEMD_BUN: process.execPath,
    NEUVE_SYSTEMD_SHOW: showDriver,
    NEUVE_SYSTEMD_LOG: log,
    NEUVE_SYSTEMD_STATE: state,
    NEUVE_SYSTEMD_OFF: "0",
    NEUVE_FAIL_ENABLE: "0",
    NEUVE_FAIL_DISABLE: "0",
    NEUVE_FAIL_RELOAD: "0",
  };
  return {
    directory,
    home,
    runtime,
    wrappers,
    state,
    log,
    env,
    calls: async () =>
      (await readFile(log, "utf8").catch(() => ""))
        .trim()
        .split("\n")
        .filter(Boolean),
    clear: () => rm(log, { force: true }),
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        bus.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(runtime, { recursive: true, force: true });
      // Permission fixtures must restore modes before closing.
      await rm(directory, { recursive: true, force: true });
    },
  };
};
