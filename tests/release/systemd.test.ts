import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import {
  agentOwnerPrefix,
  otherOwnerMessage,
  agentService,
  agentTimer,
  agentUnitPaths,
  FOREIGN,
  installAgent,
  INSTALLED,
  NO_USER_SYSTEMD,
  ownsService,
  ownsTimer,
  ROLLBACK_REFUSED,
  rollbackAgent,
  SERVICE,
  TIMER,
  uninstallAgent,
  UNSAFE,
  UNSUPPORTED_EXECUTABLE,
} from "../../packages/records-core/src/systemd.ts";
import { systemctlArray, systemdFixture } from "./systemd-fixture.ts";

// Pure unit checks prove exact argv ownership before any registration is authorized.
test("systemd unit text uses the five-minute sweep, restart limit and journal defaults", () => {
  expect(agentService("/opt/neuve/bin/neuve")).toBe(`[Unit]
Description=Neuve worker sweep
StartLimitIntervalSec=10min
StartLimitBurst=5

[Service]
Type=oneshot
# Detached on-demand workers must survive the sweep leaving this service cgroup.
KillMode=process
ExecStart="/opt/neuve/bin/neuve" worker sweep
`);
  expect(agentTimer()).toBe(`[Unit]
Description=Run the Neuve worker sweep every 5 minutes

[Timer]
OnBootSec=1min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
`);
});
test("systemd executable quoting preserves spaces, percent signs, dollars and shell punctuation", () => {
  const command = "/home/a b/100%/dollar${USER}/semicolon;`literal`/bin/neuve";
  expect(agentService(command)).toContain(
    'ExecStart="/home/a b/100%%/dollar${USER}/semicolon;`literal`/bin/neuve" worker sweep\n',
  );
  expect(ownsService(agentService(command), command)).toBe(true);
  expect(() => agentService("bin/neuve")).toThrow("absolute path");
  expect(() => agentService("/home/new\nline/neuve")).toThrow(
    "control characters",
  );
  for (const character of ['"', "'", "\\"])
    expect(() => agentService(`/home/${character}/bin/neuve`)).toThrow(
      "quotes or backslashes",
    );
});

test("systemd ownership requires exactly one executable and worker sweep in the Service section", () => {
  const command = "/opt/neuve/bin/neuve";
  for (const exec of [
    `${command} worker sweep`,
    `"${command}" "worker" 'sweep'`,
  ])
    expect(
      ownsService(`[Service]\nKillMode=process\nExecStart=${exec}\n`, command),
    ).toBe(true);
  for (const text of [
    "",
    "[Service]\nType=oneshot\n",
    `[Unit]\nExecStart=${command} worker sweep\n`,
    `[Service]\nExecStart=/other/neuve worker sweep\n`,
    `[Service]\n# ExecStart=${command} worker sweep\n`,
    `[Service]\nExecStart=${command} worker sweep extra\n`,
    `[Service]\nExecStart=${command} worker sweep\nExecStart=\n`,
    `[Service]\nExecStart=${command} worker sweep\nExecStart=/other\n`,
    `[Service]\nExecStart="${command} worker sweep\n`,
    `[Service]\nExecStart=-${command} worker sweep\n`,
    `[Service]\nExecStart=${command} worker sweep ; /other\n`,
    `[Service]\nExecStart=${command} worker \\\nsweep\n`,
    `[Service]\nExecStart=${command} worker sweep\n.include /other\n`,
  ])
    expect(
      ownsService(`${text}\n[Service]\nKillMode=process\n`, command),
      text,
    ).toBe(false);
  expect(
    ownsService(
      '[Service]\nKillMode=process\nExecStart="/opt/%h/bin/neuve" worker sweep\n',
      "/opt/%h/bin/neuve",
    ),
  ).toBe(false);
});
test("systemd parses only space, tab, newline as whitespace and refuses carriage return", () => {
  const command = "/opt/neuve/bin/neuve";
  for (const character of ["\u00a0", "\u2003", "\ufeff", "\v", "\f"])
    for (const text of [
      agentService(command).replace(
        '" worker sweep',
        '"' + character + "worker sweep",
      ),
      agentService(command).replace(
        '" worker sweep',
        '" worker sweep' + character,
      ),
      agentService(command).replace("ExecStart=", "ExecStart=" + character),
      agentService(command).replace(
        "KillMode=process",
        "KillMode=" + character + "process",
      ),
      agentService(command).replace(
        "ExecStart=",
        "ExecStart" + character + "=",
      ),
    ])
      expect(ownsService(text, command), JSON.stringify(text)).toBe(false);
  expect(
    ownsService(
      agentService(command).replace('" worker sweep', '"\tworker\tsweep'),
      command,
    ),
  ).toBe(true);
});
test("systemd timer ownership rejects missing schedules, duplicate targets and another service", () => {
  expect(ownsTimer(agentTimer())).toBe(true);
  expect(
    ownsTimer(agentTimer().replace("[Timer]", `[Timer]\nUnit=${SERVICE}`)),
  ).toBe(true);
  for (const text of [
    "broken timer",
    "[Timer]\nUnit=other.service\n",
    agentTimer().replace("[Timer]", "[Timer]\nUnit=other.service"),
    agentTimer().replace(
      "[Timer]",
      `[Timer]\nUnit=${SERVICE}\nUnit=${SERVICE}`,
    ),
    // systemd keeps the first target. Neuve conservatively refuses both targets.
    agentTimer().replace(
      "[Timer]",
      `[Timer]\nUnit=${SERVICE}\nUnit=other.service`,
    ),
  ])
    expect(ownsTimer(text)).toBe(false);
});
test("XDG config accepts only a safe absolute raw path", () => {
  for (const config of [
    "",
    "relative",
    "/config\n",
    '/config"',
    "/config\\",
    "/config|",
    "/config&",
    "/config:",
    "/config/../elsewhere",
  ])
    expect(agentUnitPaths("/home/test", config).directory).toBe(
      "/home/test/.config/systemd/user",
    );
  expect(agentUnitPaths("/home/test", "/config space").directory).toBe(
    "/config space/systemd/user",
  );
});

test("systemd's array printer quotes and escapes only its documented byte alphabet", () => {
  expect(
    systemctlArray([
      "/plain].conf",
      "/space path.conf",
      '/dollar$`"\\.conf',
      "/tab\t.conf",
      "/line\n.conf",
      "/cc\x01\x7f.conf",
    ]),
  ).toBe(
    '/plain].conf "/space path.conf" "/dollar\\$\\`\\"\\\\.conf" "/tab\\t.conf" "/line\\n.conf" "/cc\\001\\177.conf"',
  );
});
test("the default XDG config lookup is isolated from the runner", () => {
  const previous = process.env.XDG_CONFIG_HOME;
  try {
    delete process.env.XDG_CONFIG_HOME;
    expect(agentUnitPaths("/home/test", undefined).directory).toBe(
      "/home/test/.config/systemd/user",
    );
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  }
});

describe("systemd registration through an isolated user manager", () => {
  let fixture: Awaited<ReturnType<typeof systemdFixture>>;
  let original: NodeJS.ProcessEnv;
  let options: { command: string; load: boolean };
  beforeEach(async () => {
    fixture = await systemdFixture();
    original = { ...process.env };
    Object.assign(process.env, fixture.env);
    options = {
      command: join(fixture.home, "release copy/bin/neuve"),
      load: true,
    };
  });
  afterEach(async () => {
    for (const key of Object.keys(process.env))
      if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    await fixture.close();
  });
  const mutations = (calls: string[]) =>
    calls.filter((line) =>
      /^(?:daemon-reload|enable|disable|stop)(?: |$)/.test(line),
    );

  // Missing user sessions must leave no registration, including WSL without its bus.
  for (const kind of [
    "missing-runtime",
    "file-runtime",
    "missing-bus",
    "failed-manager",
    "wsl",
  ])
    test(`skips without user systemd: ${kind}`, async () => {
      if (kind === "missing-runtime") delete process.env.XDG_RUNTIME_DIR;
      if (kind === "file-runtime") {
        const path = join(fixture.directory, "not-a-runtime-folder");
        await writeFile(path, "not a folder");
        process.env.XDG_RUNTIME_DIR = path;
      }
      if (kind === "missing-bus" || kind === "wsl")
        process.env.XDG_RUNTIME_DIR = fixture.directory;
      if (kind === "failed-manager") process.env.NEUVE_SYSTEMD_OFF = "1";
      if (kind === "wsl") {
        process.env.PATH += ":/mnt/c/Windows/System32:/mnt/c/Users/Someone/bin";
        await writeFile(
          join(fixture.directory, "proc-version"),
          "Linux version Microsoft WSL2",
        );
      }
      expect(await installAgent(options)).toBe(NO_USER_SYSTEMD);
      expect(
        await lstat(agentUnitPaths().directory).catch(() => null),
      ).toBeNull();
      expect(mutations(await fixture.calls())).toEqual([]);
    });
  // The first registration must write both units, enable the timer, and uninstall it.
  test("creates, enables and uninstalls owned units", async () => {
    expect(await installAgent(options)).toBe(INSTALLED);
    const paths = agentUnitPaths();
    expect(await readFile(paths.service, "utf8")).toBe(
      agentService(options.command),
    );
    expect(await readFile(paths.timer, "utf8")).toBe(agentTimer());
    expect(mutations(await fixture.calls())).toEqual([
      "daemon-reload",
      `enable --now ${TIMER}`,
    ]);
    expect(await uninstallAgent(options)).toBe(
      "Removed the systemd timer for this install.",
    );
    expect(await lstat(paths.service).catch(() => null)).toBeNull();
    expect(await lstat(paths.timer).catch(() => null)).toBeNull();
    expect(mutations(await fixture.calls()).slice(-2)).toEqual([
      `disable --now ${TIMER}`,
      "daemon-reload",
    ]);
  });
  // A healthy timer stays running during an upgrade, with customized bytes intact.
  test("preserves an active registration and repairs a disabled or inactive timer", async () => {
    await installAgent(options);
    const paths = agentUnitPaths();
    const customized = `${agentService(options.command)}# custom bytes\n`;
    await writeFile(paths.service, customized);
    await writeFile(paths.timer, agentTimer().replace("5min", "7min"));
    expect(
      await Bun.spawn(["systemctl", "--user", "daemon-reload"], {
        env: process.env,
      }).exited,
    ).toBe(0);
    await fixture.clear();
    expect(await installAgent(options)).toBe(
      "The systemd timer already runs this install.",
    );
    expect(mutations(await fixture.calls())).toEqual([]);
    for (const state of ["enabled", "active"]) {
      await rm(join(fixture.state, state));
      expect(await installAgent(options)).toBe(INSTALLED);
      expect(await readFile(paths.service, "utf8")).toBe(customized);
      expect(await readFile(paths.timer, "utf8")).toContain("7min");
    }
  });
  // An owned service alone can survive a KILL between writing the two files.
  test("repairs a missing timer", async () => {
    const paths = agentUnitPaths();
    await mkdir(paths.directory, { recursive: true });
    await writeFile(paths.service, agentService(options.command));
    expect(await installAgent(options)).toBe(INSTALLED);
    expect(await readFile(paths.timer, "utf8")).toBe(agentTimer());
  });
  // Failure can occur after enable created its link, so rollback must undo partial state.
  test("rolls back failed enable and succeeds on a plain retry", async () => {
    process.env.NEUVE_FAIL_ENABLE = "1";
    await expect(installAgent(options)).rejects.toThrow("failed (78)");
    expect(await lstat(agentUnitPaths().service).catch(() => null)).toBeNull();
    expect(await lstat(agentUnitPaths().timer).catch(() => null)).toBeNull();
    expect(
      await lstat(join(fixture.state, "enabled")).catch(() => null),
    ).toBeNull();
    delete process.env.NEUVE_FAIL_ENABLE;
    expect(await installAgent(options)).toBe(INSTALLED);
  });
  // Failed repair must retain both existing bytes and prior timer state.
  test("restores customized unit bytes and prior enabled state after failed repair", async () => {
    await installAgent(options);
    const paths = agentUnitPaths();
    const text = `${agentService(options.command)}# retain this comment\n`;
    await writeFile(paths.service, text);
    await rm(join(fixture.state, "active"));
    process.env.NEUVE_FAIL_ENABLE = "1";
    await expect(installAgent(options)).rejects.toThrow("failed (78)");
    expect(await readFile(paths.service, "utf8")).toBe(text);
    expect(await readFile(paths.timer, "utf8")).toBe(agentTimer());
    expect(await lstat(join(fixture.state, "enabled"))).toBeDefined();
    expect(
      await lstat(join(fixture.state, "active")).catch(() => null),
    ).toBeNull();
  });
  // Manager failures must preserve registrations and expose a retryable error.
  test("keeps unit bytes when daemon reload or uninstall disable fails", async () => {
    await installAgent(options);
    const paths = agentUnitPaths();
    const service = await readFile(paths.service, "utf8");
    const timer = await readFile(paths.timer, "utf8");
    process.env.NEUVE_FAIL_DISABLE = "1";
    await expect(uninstallAgent(options)).rejects.toThrow("failed (79)");
    expect(await readFile(paths.service, "utf8")).toBe(service);
    expect(await readFile(paths.timer, "utf8")).toBe(timer);
    delete process.env.NEUVE_FAIL_DISABLE;
    await rm(join(fixture.state, "active"));
    process.env.NEUVE_FAIL_RELOAD = "1";
    await expect(installAgent(options)).rejects.toThrow(
      "Couldn't fully restore",
    );
    expect(await readFile(paths.service, "utf8")).toBe(service);
    expect(await readFile(paths.timer, "utf8")).toBe(timer);
    delete process.env.NEUVE_FAIL_RELOAD;
    expect(await installAgent(options)).toBe(
      "The systemd timer already runs this install.",
    );
    expect(await uninstallAgent(options)).toBe(
      "Removed the systemd timer for this install.",
    );
  });
  // Uninstall must retain the executable until its existing registration can be disabled.
  test("refuses an owned loaded uninstall without a manager and allows explicit file-only removal", async () => {
    await installAgent(options);
    const paths = agentUnitPaths();
    const original = await readFile(paths.service, "utf8");
    delete process.env.XDG_RUNTIME_DIR;
    await expect(uninstallAgent(options)).rejects.toThrow("can't be disabled");
    expect(await readFile(paths.service, "utf8")).toBe(original);
    expect(await uninstallAgent({ ...options, load: false })).toBe(
      "Removed the systemd timer for this install.",
    );
  });
  for (const timer of [
    "broken timer bytes\n",
    agentTimer().replace("[Timer]", "[Timer]\nUnit=other.service"),
  ])
    test(`preserves an owned service beside a foreign timer: ${timer.split("\n")[0]}`, async () => {
      const paths = agentUnitPaths();
      await mkdir(paths.directory, { recursive: true });
      await writeFile(paths.service, agentService(options.command));
      await writeFile(paths.timer, timer);
      expect(await installAgent(options)).toBe(FOREIGN);
      expect(await uninstallAgent(options)).toBe(FOREIGN);
      expect(await readFile(paths.timer, "utf8")).toBe(timer);
      expect(mutations(await fixture.calls())).toEqual([]);
    });
  // Distribution-wide defaults can coexist with our units, but command overrides cannot.
  test("accepts benign generic drop-ins and preserves registrations under a generic command override", async () => {
    const paths = agentUnitPaths();
    const directory = join(paths.directory, "service.d");
    await mkdir(directory, { recursive: true });
    const config = join(directory, "defaults.conf");
    await writeFile(config, "[Service]\nTimeoutStopFailureMode=abort\n");
    expect(await installAgent(options)).toBe(INSTALLED);
    await fixture.clear();
    await writeFile(config, "[Service]\nExecStart=/other/command\n");
    expect(await installAgent(options)).toBe(FOREIGN);
    expect(await uninstallAgent(options)).toBe(FOREIGN);
    expect(mutations(await fixture.calls())).toEqual([]);
  });
  // The manager discovers overrides in every search folder, beyond the early file scan.
  for (const folder of [
    "etc/xdg/systemd/user",
    "config/systemd/user.control",
    "runtime/systemd/generator",
    "data/systemd/user",
  ]) {
    for (const directive of [
      "ExecStart=/other/command",
      "KillMode=control-group",
      "KillMode=process",
      "Unit=other.service",
    ]) {
      test(`rejects loaded override in ${folder}: ${directive}`, async () => {
        const timer = directive.startsWith("Unit=");
        const dropIn = join(
          fixture.directory,
          folder,
          `${timer ? TIMER : SERVICE}.d`,
          "override.conf",
        );
        await mkdir(join(dropIn, ".."), { recursive: true });
        await writeFile(
          dropIn,
          `${timer ? "[Timer]" : "[Service]"}\n${directive}\n`,
        );
        process.env[timer ? "NEUVE_TIMER_DROPINS" : "NEUVE_SERVICE_DROPINS"] =
          dropIn;
        await expect(installAgent(options)).rejects.toThrow(ROLLBACK_REFUSED);
        expect(await readFile(agentUnitPaths().service, "utf8")).toBe(
          agentService(options.command),
        );
        expect(await readFile(agentUnitPaths().timer, "utf8")).toBe(
          agentTimer(),
        );
        expect(mutations(await fixture.calls())).toEqual(["daemon-reload"]);
        expect(await readFile(dropIn, "utf8")).toContain(directive);
      });
    }
  }
  // Loaded fragments, command argv and target must all agree before enable or disable.
  for (const kind of [
    "service-fragment",
    "timer-fragment",
    "exec-extra",
    "exec-duplicate",
    "kill-mode",
    "timer-target",
    "show-failed",
    "unreadable-dropin",
  ]) {
    test(`preserves existing units under a foreign loaded view: ${kind}`, async () => {
      expect(await installAgent(options)).toBe(INSTALLED);
      const paths = agentUnitPaths();
      const service = await readFile(paths.service, "utf8");
      const timer = await readFile(paths.timer, "utf8");
      const elsewhere = join(fixture.directory, "higher-priority-fragment");
      await writeFile(elsewhere, kind.startsWith("service") ? service : timer);
      if (kind === "service-fragment")
        process.env.NEUVE_SERVICE_FRAGMENT = elsewhere;
      if (kind === "timer-fragment")
        process.env.NEUVE_TIMER_FRAGMENT = elsewhere;
      const exec = `{ path=${options.command} ; argv[]=${options.command} worker sweep ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0 }`;
      if (kind === "exec-extra")
        process.env.NEUVE_EXEC_START = exec.replace(
          "worker sweep ;",
          "worker sweep extra ;",
        );
      if (kind === "exec-duplicate")
        process.env.NEUVE_EXEC_START = `${exec} ${exec}`;
      if (kind === "kill-mode") process.env.NEUVE_KILL_MODE = "control-group";
      if (kind === "timer-target")
        process.env.NEUVE_TIMER_TRIGGERS = JSON.stringify([
          SERVICE,
          "other.service",
        ]);
      if (kind === "show-failed") process.env.NEUVE_FAIL_SHOW = "1";
      if (kind === "unreadable-dropin")
        process.env.NEUVE_SERVICE_DROPINS = join(
          fixture.directory,
          "missing.conf",
        );
      await fixture.clear();
      expect(await installAgent(options)).toBe(FOREIGN);
      expect(await uninstallAgent(options)).toBe(FOREIGN);
      expect(mutations(await fixture.calls())).toEqual([]);
      expect(await readFile(paths.service, "utf8")).toBe(service);
      expect(await readFile(paths.timer, "utf8")).toBe(timer);
    });
  }
  test("allows a loaded benign distribution drop-in with spaces in its path", async () => {
    const dropIn = join(
      fixture.directory,
      "etc xdg",
      "service.d",
      "defaults.conf",
    );
    await mkdir(join(dropIn, ".."), { recursive: true });
    await writeFile(dropIn, "[Service]\nTimeoutStopFailureMode=abort\n");
    process.env.NEUVE_SERVICE_DROPINS = dropIn;
    expect(await installAgent(options)).toBe(INSTALLED);
    const calls = await fixture.calls();
    expect(
      calls.findIndex((line) => line.startsWith("show -p FragmentPath")),
    ).toBeGreaterThan(calls.indexOf("daemon-reload"));
    expect(mutations(calls).at(-1)).toBe(`enable --now ${TIMER}`);
  });
  test("reloads stale manager state before repairing a running timer", async () => {
    expect(await installAgent(options)).toBe(INSTALLED);
    await rm(join(fixture.state, "reloaded"));
    process.env.NEUVE_NEED_RELOAD = "yes";
    await fixture.clear();
    expect(await installAgent(options)).toBe(INSTALLED);
    expect(mutations(await fixture.calls())).toEqual([
      "daemon-reload",
      `enable --now ${TIMER}`,
    ]);
    expect(await readFile(agentUnitPaths().service, "utf8")).toBe(
      agentService(options.command),
    );
  });
  test("rejects fragment KillMode defaults, resets and duplicates", () => {
    for (const text of [
      agentService(options.command).replace("KillMode=process\n", ""),
      agentService(options.command).replace(
        "KillMode=process",
        "KillMode=control-group",
      ),
      agentService(options.command) + "KillMode=\n",
      agentService(options.command) + "KillMode=process\n",
    ])
      expect(ownsService(text, options.command)).toBe(false);
  });
  // Installer rollback uses a separate receipt, so copy changes cannot change ownership.
  test("writes a receipt only for a changed registration", async () => {
    const receipt = join(fixture.directory, "installed");
    expect(await installAgent({ ...options, receipt })).toBe(INSTALLED);
    expect(JSON.parse(await readFile(receipt, "utf8"))).toMatchObject({
      command: options.command,
      enabled: false,
      active: false,
    });
    await rm(receipt);
    expect(await installAgent({ ...options, receipt })).toBe(
      "The systemd timer already runs this install.",
    );
    expect(await lstat(receipt).catch(() => null)).toBeNull();
  });
  test("rolls back when a registration receipt cannot be claimed", async () => {
    const receipt = join(fixture.directory, "foreign-receipt");
    await writeFile(receipt, "keep bytes\n");
    await expect(installAgent({ ...options, receipt })).rejects.toThrow();
    expect(await readFile(receipt, "utf8")).toBe("keep bytes\n");
    expect(await lstat(agentUnitPaths().service).catch(() => null)).toBeNull();
    expect(await lstat(agentUnitPaths().timer).catch(() => null)).toBeNull();
    expect(
      await lstat(join(fixture.state, "enabled")).catch(() => null),
    ).toBeNull();
  });
  // Receipts record this attempt's bytes, and each rollback step rechecks current state.
  for (const kind of [
    "same-prefix-bytes",
    "foreign-prefix",
    "filesystem",
    "loaded-view",
  ])
    test(`rollback refuses a stale receipt: ${kind}`, async () => {
      const receipt = join(fixture.directory, "receipt");
      await installAgent({ ...options, receipt });
      const paths = agentUnitPaths();
      if (kind === "same-prefix-bytes")
        await writeFile(
          paths.service,
          agentService(options.command) + "# newer install\n",
        );
      if (kind === "foreign-prefix")
        await writeFile(paths.service, agentService("/other/bin/neuve"));
      if (kind === "filesystem") await chmod(paths.timer, 0o444);
      if (kind === "loaded-view") process.env.NEUVE_KILL_MODE = "control-group";
      const service = await readFile(paths.service);
      const timer = await readFile(paths.timer);
      await fixture.clear();
      try {
        await expect(rollbackAgent({ ...options, receipt })).rejects.toThrow(
          ROLLBACK_REFUSED,
        );
        expect(await readFile(paths.service)).toEqual(service);
        expect(await readFile(paths.timer)).toEqual(timer);
        expect(mutations(await fixture.calls())).toEqual(
          kind === "same-prefix-bytes" ? ["daemon-reload"] : [],
        );
      } finally {
        await chmod(paths.timer, 0o644);
      }
    });
  test("rollback rechecks after stop before disabling or removing", async () => {
    const receipt = join(fixture.directory, "receipt");
    await installAgent({ ...options, receipt });
    const paths = agentUnitPaths();
    const wrapper = join(fixture.wrappers, "systemctl");
    const text = await readFile(wrapper, "utf8");
    await writeFile(
      wrapper,
      text.replace(
        "stop) rm -f",
        'stop) printf "# changed during stop\\n" >>"$XDG_CONFIG_HOME/systemd/user/dev.neuve.worker.service"; rm -f',
      ),
    );
    await fixture.clear();
    await expect(rollbackAgent({ ...options, receipt })).rejects.toThrow(
      ROLLBACK_REFUSED,
    );
    expect(mutations(await fixture.calls())).toEqual([
      `stop ${TIMER}`,
      "daemon-reload",
      `enable --now ${TIMER}`,
    ]);
    expect(await lstat(join(fixture.state, "active"))).toBeDefined();
    expect(await readFile(paths.service, "utf8")).toContain(
      "# changed during stop",
    );
    expect(await lstat(join(fixture.state, "enabled"))).toBeDefined();
  });
  // Unicode spaces must survive show parsing and cannot hide a loaded override.
  for (const character of ["\u00a0", "\u2003", "\ufeff"])
    test(`refuses Unicode suffix in the loaded timer target: U+${character.charCodeAt(0).toString(16)}`, async () => {
      await installAgent(options);
      const paths = agentUnitPaths();
      const service = await readFile(paths.service);
      const timer = await readFile(paths.timer);
      // Make Triggers the last property, to catch trimEnd() removing its suffix.
      const printer = join(fixture.directory, "show.ts");
      const text = await readFile(printer, "utf8");
      await writeFile(
        printer,
        text.replace(
          "for (const key of keys)",
          'keys.sort((a, b) => Number(a === "Triggers") - Number(b === "Triggers")); for (const key of keys)',
        ),
      );
      process.env.NEUVE_TIMER_TRIGGERS = SERVICE + character;
      await fixture.clear();
      expect(await installAgent(options)).toBe(FOREIGN);
      expect(await uninstallAgent(options)).toBe(FOREIGN);
      expect(await readFile(paths.service)).toEqual(service);
      expect(await readFile(paths.timer)).toEqual(timer);
      expect(mutations(await fixture.calls())).toEqual([]);
    });
  test("leaves an arbitrary empty service foreign", async () => {
    const paths = agentUnitPaths();
    await mkdir(paths.directory, { recursive: true });
    await writeFile(paths.service, "");
    expect(await installAgent(options)).toBe(FOREIGN);
    expect(await readFile(paths.service, "utf8")).toBe("");
    expect(mutations(await fixture.calls())).toEqual([]);
  });
  // Ubuntu 22.04's systemd rejects these bytes even after C-style unquoting.
  test("skips unsupported executable paths without writing a registration", async () => {
    expect(
      await installAgent({
        ...options,
        command: join(fixture.home, "owner's copy/bin/neuve"),
      }),
    ).toBe(UNSUPPORTED_EXECUTABLE);
    expect(await lstat(agentUnitPaths().service).catch(() => null)).toBeNull();
    expect(mutations(await fixture.calls())).toEqual([]);
  });
  // An unreadable drop-in cannot establish ownership and must skip without mutation.
  test("preserves an unreadable generic drop-in directory", async () => {
    const path = join(agentUnitPaths().directory, "service.d");
    await mkdir(path, { recursive: true });
    await chmod(path, 0o000);
    try {
      expect(await installAgent(options)).toBe(FOREIGN);
      expect(await uninstallAgent(options)).toBe(FOREIGN);
      expect(mutations(await fixture.calls())).toEqual([]);
    } finally {
      await chmod(path, 0o755);
    }
  });
  // --no-load performs file work only, even without a session or systemctl.
  test("writes and removes files only with --no-load", async () => {
    delete process.env.XDG_RUNTIME_DIR;
    options.load = false;
    expect(await installAgent(options)).toContain("not loaded: --no-load");
    expect(await uninstallAgent(options)).toBe(
      "Removed the systemd timer for this install.",
    );
    expect(await fixture.calls()).toEqual([]);
  });
  // Unsupported registration cannot authorize any systemctl mutation or file replacement.
  for (const kind of [
    "broken",
    "other-prefix",
    "other-prefix-foreign-timer",
    "other-prefix-dropin",
    "duplicate-exec",
    "service-dropin",
    "timer-dropin",
    "orphan-timer",
  ])
    test(`preserves a foreign registration: ${kind}`, async () => {
      const paths = agentUnitPaths();
      await mkdir(paths.directory, { recursive: true });
      const text =
        kind === "broken"
          ? "broken unit\n"
          : kind.startsWith("other-prefix")
            ? agentService("/elsewhere/bin/neuve")
            : agentService(options.command) +
              (kind === "duplicate-exec" ? "ExecStart=/other\n" : "");
      if (kind !== "orphan-timer") await writeFile(paths.service, text);
      const timerText =
        kind === "other-prefix" || kind === "other-prefix-dropin"
          ? agentTimer()
          : "foreign timer bytes\n";
      await writeFile(paths.timer, timerText);
      if (kind.endsWith("dropin")) {
        const folder = `${kind === "service-dropin" ? paths.service : paths.timer}.d`;
        await mkdir(folder);
        await writeFile(
          join(folder, "override.conf"),
          "[Service]\nExecStart=/other\n",
        );
      }
      const message =
        kind === "other-prefix" ? otherOwnerMessage("/elsewhere") : FOREIGN;
      expect(await installAgent(options)).toBe(message);
      const result = await uninstallAgent(options);
      expect(result).toBe(message);
      if (kind !== "orphan-timer")
        expect(await readFile(paths.service, "utf8")).toBe(text);
      expect(await readFile(paths.timer, "utf8")).toBe(timerText);
      expect(mutations(await fixture.calls())).toEqual([]);
    });
  // Both unit destinations and their parents get the same filesystem preflight.
  for (const unit of [SERVICE, TIMER])
    for (const kind of [
      "link",
      "dangling-link",
      "directory",
      "readonly",
      "fifo",
    ])
      test(`preflights unit path: ${unit}/${kind}`, async () => {
        const paths = agentUnitPaths();
        await mkdir(paths.directory, { recursive: true });
        const path = join(paths.directory, unit);
        const target = join(fixture.directory, "untouched");
        await writeFile(target, "outside bytes\n");
        if (kind === "link" || kind === "dangling-link")
          await symlink(kind === "link" ? target : `${target}-missing`, path);
        if (kind === "directory") await mkdir(path);
        if (kind === "readonly") {
          await writeFile(path, "read only\n");
          await chmod(path, 0o444);
        }
        if (kind === "fifo") {
          const child = Bun.spawn(["mkfifo", path], { env: fixture.env });
          expect(await child.exited).toBe(0);
        }
        try {
          expect(await installAgent(options)).toBe(UNSAFE);
          expect(await uninstallAgent(options)).toBe(UNSAFE);
          expect(await readFile(target, "utf8")).toBe("outside bytes\n");
          expect(mutations(await fixture.calls())).toEqual([]);
        } finally {
          if (kind === "readonly") await chmod(path, 0o644);
        }
      });
  for (const kind of ["link-parent", "readonly-parent", "file-parent"])
    test(`preflights unit ancestors: ${kind}`, async () => {
      const parent = join(fixture.home, ".config");
      if (kind === "link-parent") await symlink(fixture.wrappers, parent);
      if (kind === "file-parent") await writeFile(parent, "not a folder");
      if (kind === "readonly-parent") {
        await mkdir(parent);
        await chmod(parent, 0o555);
      }
      try {
        expect(await installAgent(options)).toBe(UNSAFE);
        expect(mutations(await fixture.calls())).toEqual([]);
      } finally {
        if (kind === "readonly-parent") await chmod(parent, 0o755);
      }
    });
  // Every reader must reject systemd's extra line endings before skipping comments.
  for (const delimiter of ["\r", "\r\n", "\0"])
    for (const directive of [
      "ExecStart=\nExecStart=/other/bin/neuve worker sweep",
      "Unit=other.service",
      "KillMode=control-group",
    ])
      for (const location of ["unit", "generic", "loaded"]) {
        test(`refuses hidden directives: ${JSON.stringify(delimiter)}/${directive.split("=")[0]}/${location}`, async () => {
          await installAgent(options);
          const paths = agentUnitPaths();
          const timerOverride = directive.startsWith("Unit=");
          const hidden =
            "# comment" +
            delimiter +
            directive.replaceAll("\n", delimiter) +
            "\n";
          let changed: string;
          if (location === "unit") {
            changed = timerOverride ? paths.timer : paths.service;
            await writeFile(
              changed,
              (timerOverride
                ? agentTimer() + "[Timer]\n"
                : agentService(options.command)) + hidden,
            );
          } else {
            changed = join(
              location === "generic" ? paths.directory : fixture.directory,
              timerOverride ? "timer.d" : "service.d",
              "hidden.conf",
            );
            await mkdir(join(changed, ".."), { recursive: true });
            await writeFile(
              changed,
              (timerOverride ? "[Timer]\n" : "[Service]\n") + hidden,
            );
            if (location === "loaded")
              process.env[
                timerOverride ? "NEUVE_TIMER_DROPINS" : "NEUVE_SERVICE_DROPINS"
              ] = changed;
          }
          const service = await readFile(paths.service),
            timer = await readFile(paths.timer),
            bytes = await readFile(changed);
          await fixture.clear();
          expect(await installAgent(options)).toBe(FOREIGN);
          expect(await uninstallAgent(options)).toBe(FOREIGN);
          if (location !== "loaded")
            expect(await uninstallAgent({ ...options, load: false })).toBe(
              FOREIGN,
            );
          expect(await readFile(paths.service)).toEqual(service);
          expect(await readFile(paths.timer)).toEqual(timer);
          expect(await readFile(changed)).toEqual(bytes);
          expect(mutations(await fixture.calls())).toEqual([]);
        });
      }
  test("accepts real systemctl quoted and escaped drop-in arrays", async () => {
    const dropIn = join(fixture.directory, "space $`\"\\'", "defaults.conf");
    await mkdir(join(dropIn, ".."), { recursive: true });
    await writeFile(dropIn, "[Service]\nTimeoutStopSec=30\n");
    process.env.NEUVE_SERVICE_DROPINS = JSON.stringify([dropIn]);
    expect(await installAgent(options)).toBe(INSTALLED);
    expect(await uninstallAgent(options)).toBe(
      "Removed the systemd timer for this install.",
    );
  });
  for (const output of [
    '"/unterminated.conf',
    '"/unknown\\q.conf"',
    '"/null\\000.conf"',
    "/raw space.conf",
    '"/one.conf""/two.conf"',
  ])
    test(`refuses malformed systemctl arrays without mutation: ${JSON.stringify(output)}`, async () => {
      await installAgent(options);
      const paths = agentUnitPaths(),
        service = await readFile(paths.service),
        timer = await readFile(paths.timer);
      process.env.NEUVE_RAW_DROPINS = output;
      await fixture.clear();
      expect(await installAgent(options)).toBe(FOREIGN);
      expect(await uninstallAgent(options)).toBe(FOREIGN);
      expect(await readFile(paths.service)).toEqual(service);
      expect(await readFile(paths.timer)).toEqual(timer);
      expect(mutations(await fixture.calls())).toEqual([]);
    });
  for (const character of ["\r", "\0"])
    test(`refuses raw systemctl line delimiters: ${JSON.stringify(character)}`, async () => {
      await installAgent(options);
      const paths = agentUnitPaths(),
        service = await readFile(paths.service),
        timer = await readFile(paths.timer);
      process.env.NEUVE_RAW_TRIGGERS_JSON = JSON.stringify(SERVICE + character);
      await fixture.clear();
      expect(await uninstallAgent(options)).toBe(FOREIGN);
      expect(await readFile(paths.service)).toEqual(service);
      expect(await readFile(paths.timer)).toEqual(timer);
      expect(mutations(await fixture.calls())).toEqual([]);
    });
  // A remaining timer must not be mistaken for an already removed registration.
  test("preserves an orphan timer when the service is missing", async () => {
    const paths = agentUnitPaths();
    await mkdir(paths.directory, { recursive: true });
    await writeFile(paths.timer, agentTimer());
    expect(await uninstallAgent({ ...options, load: false })).toBe(FOREIGN);
    expect(await readFile(paths.timer, "utf8")).toBe(agentTimer());
    expect(mutations(await fixture.calls())).toEqual([]);
  });
});

// The public owner helper shares the exact command parser with lifecycle operations.
test("identifies only a complete Neuve service owner", () => {
  expect(agentOwnerPrefix(agentService("/a path/100%/bin/neuve"))).toBe(
    "/a path/100%",
  );
  expect(agentOwnerPrefix(agentService("/a/bin/another"))).toBeNull();
  expect(
    agentOwnerPrefix(agentService("/a/bin/neuve") + "ExecStart=/other\n"),
  ).toBeNull();
});
