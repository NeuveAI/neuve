import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTestProcess, testLaunchOptions } from "../scripts/test-process.ts";
import { z } from "zod";

const launcher = join(import.meta.dir, "../scripts/test-budget.ts");
const runner = join(import.meta.dir, "../scripts/test-workspaces.ts");

// Check both argument preservation and Bun's actual timeout precedence at launch.
test("launch options add a 30 s default and preserve either caller timeout spelling", () => {
  const args = ["./tests", "--test-name-pattern", "slow"];
  expect(testLaunchOptions(args).args).toEqual([...args, "--timeout=30000"]);
  expect(args).toEqual(["./tests", "--test-name-pattern", "slow"]);
  for (const timeout of [["--timeout=7000"], ["--timeout", "7000"]]) {
    const explicit = [...args, ...timeout];
    expect(testLaunchOptions(explicit).args).toEqual(explicit);
  }
});

test("launch options refuse a parallel coordinator that cannot load the preload", () => {
  for (const parallel of ["--parallel", "--parallel=4"])
    expect(() => testLaunchOptions([parallel, "./tests"])).toThrow(
      "The launcher cannot watch a parallel coordinator because it never loads the preload. Run bun test --parallel --timeout=… directly.",
    );
});

for (const shards of [1, 2]) {
  for (const limit of ["default", "test", "caller"] as const) {
    test(`launcher ${limit} timeout with ${shards} processes`, async () => {
      const root = mkdtempSync(join(tmpdir(), "test-launcher-timeout-"));
      writeFileSync(join(root, "package.json"), '{"private":true}');
      writeFileSync(
        join(root, "slow.test.ts"),
        `import { expect, test } from "bun:test";
        test("six second body", async () => {
          await Bun.sleep(6000);
          expect(true).toBe(true);
        }${limit === "test" ? ", 1000" : ""});`,
      );
      writeFileSync(
        join(root, "fast.test.ts"),
        'import { expect, test } from "bun:test"; test("fast body", () => expect(1).toBe(1));',
      );
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          launcher,
          ...(shards === 2 ? ["--shards=2"] : []),
          ...(limit === "caller" ? ["--timeout=2000"] : []),
          "./",
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            NEUVE_TEST_SHARDS: undefined,
            NEUVE_TEST_SUITE_TIMEOUT_MS: "20000",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const output = Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      try {
        const code = await child.exited;
        const text = (await output).join("\n");
        expect({ code, output: text }).toMatchObject({
          code: limit === "default" ? 0 : 1,
        });
        if (limit === "default") {
          expect(text).toContain("2 pass");
          expect(text).toContain("0 fail");
        } else {
          expect(text).toContain("1 pass");
          expect(text).toContain("1 fail");
          expect(text).toContain(
            `this test timed out after ${limit === "test" ? 1000 : 2000}ms`,
          );
        }
        if (shards === 2)
          expect(text).toContain(
            `Totals: 2 tests, 2 files, ${limit === "default" ? "2 pass, 0 fail" : "1 pass, 1 fail"}`,
          );
      } finally {
        if (child.exitCode === null) child.kill("SIGTERM");
        await child.exited;
        await output;
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

const receipt = z.object({
  pid: z.number().int().positive(),
  child: z.number().int().positive(),
  directory: z.string(),
  launcher: z.number().int().positive(),
  upstreamGroup: z.number().int().positive(),
});
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH")
      return false;
    throw error;
  }
};
const waitFor = async (check: () => boolean, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Process deadline exceeded");
    await Bun.sleep(50);
  }
};

// Real processes prove both the parent-death path and the live-parent guard.
const watchFixture = async (mode: "serial" | "shards" | "pool" | "alive") => {
  const root = mkdtempSync(join(tmpdir(), "test-launcher-death-"));
  const suite = join(root, "suite");
  mkdirSync(suite);
  writeFileSync(
    join(suite, "bunfig.toml"),
    `[test]\npreload = [${JSON.stringify(launcher)}]\n`,
  );
  for (let index = 0; index < (mode === "shards" ? 12 : 1); index++)
    writeFileSync(
      join(suite, `wait-${index}.test.ts`),
      `import { test, expect } from "bun:test";
      import { renameSync, writeFileSync } from "node:fs";
      import { dlopen } from "bun:ffi";
      test("wait ${index}", async () => {
        const libc = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6", {getpgid:{args:["i32"],returns:"i32"}});
        const launcher = process.ppid;
        const upstreamGroup = libc.symbols.getpgid(launcher);
        libc.close();
        const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {stdout:"ignore",stderr:"ignore"});
        const pending = ${JSON.stringify(root)} + "/pending-" + process.pid;
        writeFileSync(pending, JSON.stringify({pid:process.pid, child:child.pid, directory:process.env.NEUVE_BUDGET_DIRECTORY, launcher, upstreamGroup}));
        renameSync(pending, ${JSON.stringify(root)} + "/seen-" + process.pid + ".json");
        ${mode === "alive" ? "await Bun.sleep(3200); expect(process.ppid).toBe(Number(process.env.NEUVE_TEST_LAUNCHER_PID));" : "await new Promise(() => {});"}
      }, 60000);`,
    );
  if (mode === "pool") {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ workspaces: ["suite"] }),
    );
    writeFileSync(
      join(suite, "package.json"),
      JSON.stringify({
        name: "@neuve/watch-fixture",
        scripts: {
          test: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(join(root, "pool-budget"))}, process.env.NEUVE_BUDGET_DIRECTORY)`)} && ${JSON.stringify(process.execPath)} --no-env-file ${JSON.stringify(launcher)} ./`,
        },
      }),
    );
  }
  const entries = () =>
    readdirSync(root)
      .filter((name) => name.startsWith("seen-"))
      .map((name) =>
        receipt.parse(JSON.parse(readFileSync(join(root, name), "utf8"))),
      );
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      mode === "pool" ? runner : launcher,
      ...(mode === "pool"
        ? []
        : [...(mode === "shards" ? ["--shards=2"] : []), "./"]),
    ],
    {
      cwd: mode === "pool" ? root : suite,
      env: {
        ...process.env,
        NEUVE_TEST_SHARDS: undefined,
        NEUVE_TEST_SUITE_TIMEOUT_MS: "60000",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const output = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  try {
    await waitFor(() => entries().length === (mode === "shards" ? 2 : 1));
    const seen = entries();
    expect(seen.every((entry) => alive(entry.pid) && alive(entry.child))).toBe(
      true,
    );
    if (mode === "alive") {
      expect(await child.exited).toBe(0);
      expect((await output).join("\n")).toContain("1 pass");
    } else {
      // Kill only the launcher. Its detached groups must stop themselves.
      child.kill("SIGKILL");
      await child.exited;
    }
    if (mode === "pool")
      await waitFor(() =>
        seen.every(
          (entry) => !alive(entry.launcher) && !alive(-entry.upstreamGroup),
        ),
      );
    await waitFor(() =>
      seen.every((entry) => !alive(entry.pid) && !alive(entry.child)),
    );
    expect(
      seen.every((entry) => !alive(entry.pid) && !alive(entry.child)),
    ).toBe(true);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    const seen = entries();
    if (mode === "pool")
      for (const entry of seen)
        if (alive(-entry.upstreamGroup))
          process.kill(-entry.upstreamGroup, "SIGKILL");
    for (const entry of seen) {
      if (alive(entry.pid)) process.kill(-entry.pid, "SIGKILL");
      if (alive(entry.child)) process.kill(entry.child, "SIGKILL");
    }
    await waitFor(() =>
      seen.every((entry) => !alive(entry.pid) && !alive(entry.child)),
    );
    await output;
    // SIGKILL cannot run the launcher's temporary-directory finalizer.
    for (const entry of seen) {
      const directory =
        mode === "shards" ? join(entry.directory, "..") : entry.directory;
      if (existsSync(directory))
        rmSync(directory, { recursive: true, force: true });
    }
    const poolBudget = join(root, "pool-budget");
    if (existsSync(poolBudget))
      rmSync(join(readFileSync(poolBudget, "utf8"), ".."), {
        recursive: true,
        force: true,
      });
    rmSync(root, { recursive: true, force: true });
  }
};

test(
  "SIGKILL of a serial launcher stops its test group and descendants",
  () => watchFixture("serial"),
  45000,
);
test(
  "SIGKILL of a two-shard launcher stops both test groups and descendants",
  () => watchFixture("shards"),
  45000,
);
test(
  "SIGKILL of the workspace pool stops package tests and descendants",
  () => watchFixture("pool"),
  45000,
);
test(
  "a live launcher lets a slow test finish normally",
  () => watchFixture("alive"),
  45000,
);

for (const mode of ["guard", "preload"])
  test(`a launcher killed immediately after spawning stops its ${mode} group and child`, async () => {
    const root = mkdtempSync(join(tmpdir(), "test-launcher-startup-"));
    const groupFile = join(root, "group.pid");
    const childFile = join(root, "child.pid");
    const startup = join(root, "startup.ts");
    writeFileSync(
      startup,
      `import { writeFileSync } from "node:fs";
        writeFileSync(${JSON.stringify(groupFile)}, String(process.pid));
        const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {stdout:"ignore",stderr:"ignore"});
        writeFileSync(${JSON.stringify(childFile)}, String(child.pid));
        // Hold startup before the real watcher until the launcher has died.
        // This makes the startup gap deterministic under any scheduler load.
        while (true) {
          try { process.kill(Number(process.env.NEUVE_TEST_LAUNCHER_PID), 0); }
          catch (error) { if (error.code === "ESRCH") break; throw error; }
          await Bun.sleep(1);
        }`,
    );
    writeFileSync(
      join(root, "bunfig.toml"),
      `[test]\npreload = [${JSON.stringify(startup)}, ${JSON.stringify(launcher)}]\n`,
    );
    writeFileSync(
      join(root, "slow.test.ts"),
      `import { test } from "bun:test";
        test("wait", async () => { await new Promise(() => {}); }, 60000);`,
    );
    const command = [
      process.execPath,
      "--no-env-file",
      ...(mode === "guard"
        ? [
            "--preload",
            startup,
            join(import.meta.dir, "../scripts/test-guard.ts"),
            process.execPath,
            "-e",
            "setInterval(() => {}, 1000)",
          ]
        : ["test", "./"]),
    ];
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "-e",
        `import { runTestProcess } from ${JSON.stringify(join(import.meta.dir, "../scripts/test-process.ts"))};
          const run = runTestProcess(${JSON.stringify(command)}, {directory:${JSON.stringify(root)}, cwd:${JSON.stringify(root)}});
          process.kill(process.pid, "SIGKILL");
          await run;`,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    const errors = new Response(child.stderr).text();
    const readPid = (path: string) =>
      z.coerce.number().int().positive().parse(readFileSync(path, "utf8"));
    try {
      await child.exited;
      await waitFor(() => existsSync(childFile));
      const pid = readPid(groupFile);
      const descendant = readPid(childFile);
      await waitFor(() => !alive(pid) && !alive(descendant), 5000);
      expect({
        group: alive(-pid),
        leader: alive(pid),
        child: alive(descendant),
      }).toEqual({ group: false, leader: false, child: false });
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      if (existsSync(groupFile)) {
        const pid = readPid(groupFile);
        if (alive(pid)) process.kill(-pid, "SIGKILL");
        await waitFor(() => !alive(pid));
      }
      if (existsSync(childFile)) {
        const pid = readPid(childFile);
        if (alive(pid)) process.kill(pid, "SIGKILL");
        await waitFor(() => !alive(pid));
      }
      await errors;
      rmSync(root, { recursive: true, force: true });
    }
  }, 45000);

test("an inherited preload never kills a group it does not lead", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--preload",
      launcher,
      "-e",
      "await Bun.sleep(2200)",
    ],
    {
      // Its real parent is alive. The mismatched PID would trip the watch if
      // this ordinary, non-detached descendant could own a group kill.
      env: {
        ...process.env,
        NEUVE_TEST_PROCESS: "1",
        NEUVE_TEST_LAUNCHER_PID: "1",
      },
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const errors = new Response(child.stderr).text();
  try {
    expect({ code: await child.exited, errors: await errors }).toEqual({
      code: 0,
      errors: "",
    });
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await errors;
  }
}, 30000);

test("a detached nested bun test with an inherited launcher marker finishes normally", async () => {
  const root = mkdtempSync(join(tmpdir(), "test-nested-preload-"));
  const outer = join(root, "outer");
  const nested = join(root, "nested");
  const pidFile = join(root, "nested.pid");
  for (const directory of [outer, nested]) {
    mkdirSync(directory);
    writeFileSync(
      join(directory, "bunfig.toml"),
      `[test]\npreload = [${JSON.stringify(launcher)}]\n`,
    );
  }
  writeFileSync(
    join(nested, "slow.test.ts"),
    `import { test } from "bun:test";
    test("nested run finishes", async () => { await Bun.sleep(2200); }, 30000);`,
  );
  writeFileSync(
    join(outer, "outer.test.ts"),
    `import { expect, test } from "bun:test";
    import { writeFileSync } from "node:fs";
    test("run a detached nested suite", async () => {
      const child = Bun.spawn([process.execPath, "--no-env-file", "test", "./"], {
        cwd: ${JSON.stringify(nested)}, detached: true, stdout: "pipe", stderr: "pipe",
      });
      writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
      try {
        const code = await child.exited;
        const text = (await output).join("\\n");
        expect({code, output: text}).toMatchObject({code: 0});
        expect(text).toContain("1 pass");
      } finally {
        if (child.exitCode === null) {
          try { process.kill(-child.pid, "SIGKILL"); }
          catch (error) { if (error.code !== "ESRCH") throw error; }
        }
        await child.exited;
        await output;
      }
    }, 30000);`,
  );
  const child = Bun.spawn([process.execPath, "--no-env-file", launcher, "./"], {
    cwd: outer,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  try {
    expect({
      code: await child.exited,
      output: (await output).join("\n"),
    }).toMatchObject({ code: 0 });
    expect(existsSync(pidFile)).toBe(true);
    await waitFor(() => !alive(Number(readFileSync(pidFile, "utf8"))));
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await child.exited;
    if (existsSync(pidFile)) {
      const pid = Number(readFileSync(pidFile, "utf8"));
      if (alive(pid)) process.kill(-pid, "SIGKILL");
      await waitFor(() => !alive(pid));
    }
    await output;
    rmSync(root, { recursive: true, force: true });
  }
}, 45000);

test("the suite watchdog names and kills a test process stuck outside its test body", async () => {
  const directory = mkdtempSync(join(tmpdir(), "test-process-"));
  const started = performance.now();
  try {
    expect(
      await runTestProcess(
        [
          process.execPath,
          "-e",
          'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)',
        ],
        {
          directory,
          timeoutMs: 150,
          stopGraceMs: 100,
        },
      ),
    ).toBe(124);
    expect(performance.now() - started).toBeLessThan(2000);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the launcher kills descendants retaining output after the test process exits", async () => {
  const directory = mkdtempSync(join(tmpdir(), "test-process-"));
  const pidFile = join(directory, "descendant.pid");
  try {
    expect(
      await runTestProcess(
        [
          process.execPath,
          "-e",
          `
      const child = Bun.spawn([process.execPath, "-e", 'setInterval(() => {}, 1000)'], {stdout:"inherit",stderr:"inherit"});
      await Bun.write(${JSON.stringify(pidFile)}, String(child.pid)); child.unref(); process.exit(0);
    `,
        ],
        { directory, timeoutMs: 2000 },
      ),
    ).toBe(0);
    const pid = Number(await Bun.file(pidFile).text());
    // Give the kernel time to deliver the group kill.
    for (let i = 0; i < 50; i++) {
      try {
        process.kill(pid, 0);
      } catch {
        break;
      }
      await Bun.sleep(10);
    }
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
