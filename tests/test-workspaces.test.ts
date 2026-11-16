import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { testWorkspaces } from "../scripts/test-workspaces.ts";

const runner = join(import.meta.dir, "../scripts/test-workspaces.ts");

test("every selected launcher package's bunfig.toml preloads the launcher", async () => {
  const root = resolve(import.meta.dir, "..");
  const launcher = join(root, "scripts/test-budget.ts");
  const config = z.object({ test: z.object({ preload: z.array(z.string()) }) });
  const packages = (await testWorkspaces(root)).filter((pkg) =>
    pkg.test.includes("scripts/test-budget.ts"),
  );
  expect(packages.length).toBeGreaterThan(0);
  for (const pkg of packages) {
    const path = join(pkg.cwd, "bunfig.toml");
    expect(existsSync(path), `${pkg.name} needs ${path}`).toBe(true);
    const { test } = config.parse(Bun.TOML.parse(readFileSync(path, "utf8")));
    expect(
      test.preload.map((preload) => resolve(pkg.cwd, preload)),
      `${pkg.name} must preload the root launcher`,
    ).toContain(launcher);
  }
});

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "workspace-pool-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ workspaces: ["packages/*", "apps/*", "packages/*"] }),
  );
  writeFileSync(
    join(root, "child.ts"),
    `
    import { appendFileSync, writeFileSync, existsSync } from "node:fs";
    import { join } from "node:path";
    const [name, weight, fail] = Bun.argv.slice(2);
    const root = process.env.FIXTURE_ROOT;
    const slots = process.env.NEUVE_TEST_SHARDS ?? weight;
    const event = (kind) => appendFileSync(join(root,"events.jsonl"), JSON.stringify({kind,name,slots:Number(slots),pid:process.pid,mode:process.env.NEUVE_MODE,directory:process.env.NEUVE_BUDGET_DIRECTORY})+"\\n");
    event("start");
    writeFileSync(join(root, name.replaceAll("/", "_") + ".started"), "");
    if (process.env.HOLD_HARNESS && name === "@neuve/harness")
      while (!existsSync(join(root, "@neuve_cli.started"))) await Bun.sleep(10);
    console.write("out"); await Bun.sleep(10); console.write("put\\nlast");
    console.error("error line");
    await Bun.sleep(100);
    event("end");
    process.exit(fail === "yes" ? 7 : 0);
  `,
  );
  return root;
};
const add = (
  root: string,
  folder: string,
  name: string,
  options: { weight?: number; fail?: boolean; noTest?: boolean } = {},
) => {
  const cwd = join(root, folder);
  mkdirSync(cwd, { recursive: true });
  const weight = options.weight ?? 1;
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({
      name,
      scripts: options.noTest
        ? {}
        : {
            test: `bun ${JSON.stringify(join(root, "child.ts"))} ${name} ${weight} ${options.fail ? "yes" : "no"}${weight > 1 ? ` --shards=${weight}` : ""}`,
          },
    }),
  );
};
const spawn = (
  root: string,
  args: string[] = [],
  env: Record<string, string | undefined> = {},
) =>
  Bun.spawn([process.execPath, "--no-env-file", runner, ...args], {
    cwd: root,
    env: {
      ...process.env,
      FIXTURE_ROOT: root,
      // Keep each fixture pool's summary inside its root, not in the shared temporary directory.
      NEUVE_TEST_REPORT: join(root, "test-report.json"),
      NEUVE_TEST_JOBS: undefined,
      NEUVE_TEST_SHARDS: undefined,
      NEUVE_MODE: "check",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
const collect = async (child: ReturnType<typeof spawn>) => {
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, output: stdout + stderr };
};
const stop = async (child: ReturnType<typeof spawn>) => {
  if (child.exitCode === null) child.kill("SIGTERM");
  await child.exited;
};
const waitForExit = async (pids: number[]) => {
  const deadline = Date.now() + 10000;
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  while (pids.some(alive)) {
    if (Date.now() > deadline)
      throw new Error("Workspace processes did not exit");
    await Bun.sleep(20);
  }
};
const events = (root: string) =>
  readFileSync(join(root, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

test("package tests see no inherited Bun no-orphans flag under the pool", async () => {
  const root = setup();
  add(root, "packages/probe", "@neuve/probe");
  const cwd = join(root, "packages/probe");
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({ name: "@neuve/probe", scripts: { test: "bun test ./" } }),
  );
  writeFileSync(
    join(cwd, "flag.test.ts"),
    `import { expect, test } from "bun:test";
    test("no flag", () => {
      console.log("NO_ORPHANS=" + process.env.BUN_FEATURE_FLAG_NO_ORPHANS);
      expect(process.env.BUN_FEATURE_FLAG_NO_ORPHANS).toBeUndefined();
    });`,
  );
  const child = spawn(root);
  try {
    const { code, output } = await collect(child);
    expect({ code, output }).toMatchObject({ code: 0 });
    expect(output).toContain("@neuve/probe:test | NO_ORPHANS=undefined");
    expect(output).toContain("1 pass");
  } finally {
    await stop(child);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a broken caller leaking a detached grandchild fails under plain bun run and the pool", async () => {
  const root = setup();
  const cwd = join(root, "packages/probe");
  const tests = join(cwd, "tests");
  mkdirSync(tests, { recursive: true });
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({
      name: "@neuve/graph-client",
      scripts: { test: "bun test ./tests" },
    }),
  );
  // The pool reruns the failed file alone, so each caller keys its orphan by its own pid.
  const started = join(root, "started.pids");
  writeFileSync(
    join(tests, "grandchild.ts"),
    `import { appendFileSync, writeFileSync } from "node:fs";
    process.on("SIGTERM", () => {});
    appendFileSync(${JSON.stringify(started)}, process.pid + "\\n");
    writeFileSync(${JSON.stringify(root)} + "/grandchild-" + process.argv[2] + ".pid", String(process.pid));
    setInterval(() => {}, 1000);`,
  );
  writeFileSync(
    join(tests, "engine.ts"),
    `Bun.spawn([process.execPath, ${JSON.stringify(join(tests, "grandchild.ts"))}, process.argv[2]], {
      detached: true, stdout: "ignore", stderr: "ignore",
    }).unref();
    setInterval(() => {}, 1000);`,
  );
  writeFileSync(
    join(tests, "caller.ts"),
    `import { appendFileSync, existsSync } from "node:fs";
    const token = String(process.pid);
    const engine = Bun.spawn([process.execPath, ${JSON.stringify(join(tests, "engine.ts"))}, token], {
      detached: true, stdout: "ignore", stderr: "ignore",
    });
    appendFileSync(${JSON.stringify(started)}, engine.pid + "\\n");
    const deadline = Date.now() + 10000;
    while (!existsSync(${JSON.stringify(root)} + "/grandchild-" + token + ".pid")) {
      if (Date.now() > deadline) throw new Error("Grandchild never started");
      await Bun.sleep(20);
    }
    engine.kill("SIGKILL");
    await engine.exited;
    // Deliberately broken: the caller exits without stopping the grandchild.
    process.exit(0);`,
  );
  writeFileSync(
    join(tests, "orphan.test.ts"),
    `import { expect, test } from "bun:test";
    import { readFileSync } from "node:fs";
    test("caller must stop its orphan", async () => {
      const caller = Bun.spawn([process.execPath, ${JSON.stringify(join(tests, "caller.ts"))}], {
        stdout: "ignore", stderr: "inherit",
      });
      try {
        expect(await caller.exited).toBe(0);
        const pid = Number(readFileSync(${JSON.stringify(root)} + "/grandchild-" + caller.pid + ".pid", "utf8"));
        await Bun.sleep(1200);
        expect(() => process.kill(pid, 0)).toThrow();
      } finally {
        if (caller.exitCode === null) caller.kill("SIGKILL");
        await caller.exited;
      }
    }, 30000);`,
  );
  const cleanup = async () => {
    if (!existsSync(started)) return;
    const pids = readFileSync(started, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(Number);
    for (const pid of pids) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "ESRCH"
        ))
          throw error;
      }
    }
    await waitForExit(pids);
    rmSync(started, { force: true });
  };
  try {
    for (const pooled of [false, true]) {
      const child = pooled
        ? spawn(root)
        : Bun.spawn([process.execPath, "run", "test"], {
            cwd,
            stdout: "pipe",
            stderr: "pipe",
          });
      try {
        const { code, output } = await collect(child);
        expect({ code, output }).toMatchObject({ code: 1 });
        expect(output).toContain("(fail) caller must stop its orphan");
        expect(output).toContain("Received function did not throw");
        if (pooled)
          expect(output).toContain(
            "FAILED AGAIN ALONE | @neuve/graph-client | tests/orphan.test.ts | caller must stop its orphan |",
          );
      } finally {
        await stop(child);
        await cleanup();
      }
    }
  } finally {
    await cleanup();
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);

test("workspace discovery matches every filter, deduplicates globs and orders heavy suites first", async () => {
  const root = setup();
  add(root, "packages/harness", "@neuve/harness", { weight: 4 });
  add(root, "packages/z", "@workspace/z");
  add(root, "apps/web", "web");
  add(root, "packages/a", "@ace/a");
  add(root, "packages/review", "@neuve/review-rules");
  add(root, "packages/graph", "@neuve/graph");
  add(root, "packages/no-test", "@neuve/no-test", { noTest: true });
  add(root, "packages/other", "other");
  add(root, "outside/hidden", "@neuve/hidden");
  const child = spawn(root, ["--list"]);
  try {
    const { code, output } = await collect(child);
    expect(code).toBe(0);
    expect(output.trim().split("\n")).toEqual([
      "[test-workspaces] Selected 5 packages, capacity 6 slots:",
      "@neuve/harness (4 slots)",
      "@ace/a (1 slots)",
      "@neuve/review-rules (1 slots)",
      "@workspace/z (1 slots)",
      "web (1 slots)",
    ]);
    expect(existsSync(join(root, "events.jsonl"))).toBe(false);
  } finally {
    await stop(child);
    rmSync(root, { recursive: true, force: true });
  }
});

test("child events prove the slot bound; failures retain every package and the result table", async () => {
  const root = setup();
  add(root, "packages/harness", "@neuve/harness", { weight: 2 });
  add(root, "apps/cli", "@neuve/cli", { fail: true });
  add(root, "apps/host", "@ace/host");
  add(root, "packages/later", "@workspace/later");
  const child = spawn(root, [], { NEUVE_TEST_JOBS: "3", HOLD_HARNESS: "1" });
  try {
    const { code, output } = await collect(child);
    expect({ code, output }).toMatchObject({ code: 1 });
    let active = 0,
      maximum = 0;
    const records = events(root);
    for (const event of records) {
      active += event.kind === "start" ? event.slots : -event.slots;
      maximum = Math.max(maximum, active);
      expect(active).toBeLessThanOrEqual(3);
      expect(event.mode).toBe("check");
      expect(existsSync(event.directory)).toBe(false);
    }
    expect(maximum).toBe(3);
    expect(active).toBe(0);
    // The failed package runs once more, alone, after the pool has drained.
    expect(records.filter((event) => event.kind === "end")).toHaveLength(5);
    expect(new Set(records.map((event) => event.directory)).size).toBe(5);
    expect(records.at(-2)).toMatchObject({ kind: "start", name: "@neuve/cli" });
    expect(
      records.slice(0, -2).filter((event) => event.kind === "end"),
    ).toHaveLength(4);
    expect(output).toContain(
      "FAILED AGAIN ALONE | @neuve/cli | (whole package) | (not named: exit 7; the package's test script is neither the launcher nor a plain bun test, so nothing names its tests)",
    );
    for (const name of [
      "@neuve/harness",
      "@neuve/cli",
      "@ace/host",
      "@workspace/later",
    ]) {
      expect(output).toContain(`${name}:test | output`);
      expect(output).toContain(`${name}:test | last`);
      expect(output).toContain(`${name}:test | error line`);
      expect(output).toContain(`${name}\t${name === "@neuve/cli" ? 7 : 0}\t`);
    }
    expect(output).toContain("Package\tExit\tWall seconds");
  } finally {
    await stop(child);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a package heavier than capacity runs alone", async () => {
  const root = setup();
  add(root, "packages/harness", "@neuve/harness", { weight: 4 });
  add(root, "apps/cli", "@neuve/cli");
  add(root, "apps/host", "@ace/host");
  const child = spawn(root, [], { NEUVE_TEST_JOBS: "2" });
  try {
    expect((await collect(child)).code).toBe(0);
    const active = new Set<string>();
    for (const event of events(root)) {
      if (event.kind === "start") active.add(event.name);
      else active.delete(event.name);
      if (active.has("@neuve/harness")) expect(active.size).toBe(1);
    }
  } finally {
    await stop(child);
    rmSync(root, { recursive: true, force: true });
  }
});

test("shard override changes weights and repeatable only runs the requested selected packages", async () => {
  const root = setup();
  add(root, "packages/harness", "@neuve/harness", { weight: 4 });
  add(root, "apps/cli", "@neuve/cli");
  add(root, "apps/host", "@ace/host");
  const child = spawn(root, ["--only=@neuve/harness", "--only=@ace/host"], {
    NEUVE_TEST_SHARDS: "1",
  });
  try {
    const { code, output } = await collect(child);
    expect(code).toBe(0);
    expect(output).toContain("@neuve/harness (1 slots)");
    expect(output).not.toContain("@neuve/cli");
    expect(
      events(root)
        .filter((event) => event.kind === "start")
        .map((event) => event.name)
        .sort(),
    ).toEqual(["@ace/host", "@neuve/harness"]);
  } finally {
    await stop(child);
    rmSync(root, { recursive: true, force: true });
  }
});

test("no selected packages, invalid capacity and unknown only refuse to run", async () => {
  const root = setup();
  try {
    for (const [args, env] of [
      [[], {}],
      [["--list"], {}],
      [[], { NEUVE_TEST_JOBS: "0" }],
      [[], { NEUVE_TEST_JOBS: "1.5" }],
      [["--only=@neuve/missing"], {}],
    ] satisfies [string[], Record<string, string>][]) {
      const child = spawn(root, args, env);
      try {
        expect((await collect(child)).code).toBe(1);
      } finally {
        await stop(child);
      }
    }
    expect(existsSync(join(root, "events.jsonl"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SIGTERM stops active workspace processes and never starts queued packages", async () => {
  const root = setup();
  add(root, "packages/harness", "@neuve/harness", { weight: 2 });
  add(root, "apps/cli", "@neuve/cli");
  writeFileSync(
    join(root, "child.ts"),
    `
    import { writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(join(root, "ready"))}, String(process.pid));
    process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);
  `,
  );
  const child = spawn(root, [], { NEUVE_TEST_JOBS: "2" });
  let pid: number | undefined;
  try {
    const deadline = Date.now() + 10000;
    while (!existsSync(join(root, "ready"))) {
      if (Date.now() > deadline)
        throw new Error("Workspace never became ready");
      await Bun.sleep(20);
    }
    pid = Number(readFileSync(join(root, "ready"), "utf8"));
    child.kill("SIGTERM");
    const { code, output } = await collect(child);
    expect(code).toBe(143);
    expect(output).not.toContain("@neuve/cli:test |");
    await waitForExit([pid]);
  } finally {
    await stop(child);
    if (pid !== undefined) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);

test("stopping the workspace runner also stops detached launcher shards and descendants", async () => {
  const root = setup();
  const cwd = join(root, "packages/harness");
  mkdirSync(cwd, { recursive: true });
  const launcher = join(import.meta.dir, "../scripts/test-budget.ts");
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({
      name: "@neuve/harness",
      scripts: { test: `bun ${JSON.stringify(launcher)} --shards=2 ./` },
    }),
  );
  const ready = join(root, "ready.jsonl");
  for (let i = 0; i < 6; i++)
    writeFileSync(
      join(cwd, `wait-${i}.test.ts`),
      `
    import { test } from "bun:test";
    import { appendFileSync } from "node:fs";
    test("wait ${i}", async () => {
      const child = Bun.spawn([process.execPath, "-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)']);
      appendFileSync(${JSON.stringify(ready)}, JSON.stringify({pid:process.pid,child:child.pid,directory:process.env.NEUVE_BUDGET_DIRECTORY})+"\\n");
      await new Promise(() => {});
    }, 60000);
  `,
    );
  const child = spawn(root);
  let pids: number[] = [];
  try {
    const deadline = Date.now() + 10000;
    while (
      !existsSync(ready) ||
      readFileSync(ready, "utf8").trim().split("\n").length !== 2
    ) {
      if (Date.now() > deadline)
        throw new Error("Nested shards never became ready");
      await Bun.sleep(20);
    }
    const entries = readFileSync(ready, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    pids = entries.flatMap((entry) => [entry.pid, entry.child]);
    child.kill("SIGTERM");
    expect((await collect(child)).code).toBe(143);
    await waitForExit(pids);
    for (const entry of entries)
      expect(existsSync(entry.directory)).toBe(false);
  } finally {
    await stop(child);
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);

/** Three launcher packages and one plain `bun test --parallel` package, as the proof workspace uses. */
const rerunFixture = () => {
  const root = mkdtempSync(join(tmpdir(), "workspace-rerun-"));
  const launcher = join(import.meta.dir, "../scripts/test-budget.ts");
  const marker = join(root, "busy");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ workspaces: ["packages/*"] }),
  );
  const pkg = (
    folder: string,
    name: string,
    test: string,
    files: Record<string, string>,
  ) => {
    const cwd = join(root, "packages", folder);
    mkdirSync(join(cwd, "tests"), { recursive: true });
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ name, scripts: { test } }),
    );
    if (test.includes("test-budget.ts"))
      writeFileSync(
        join(cwd, "bunfig.toml"),
        `[test]\npreload = [${JSON.stringify(launcher)}]\n`,
      );
    for (const [file, source] of Object.entries(files))
      writeFileSync(
        join(cwd, "tests", file),
        `import { describe, expect, test } from "bun:test";\nimport { existsSync, rmSync, writeFileSync } from "node:fs";\n${source}`,
      );
  };
  // Holds a marker while it runs: a package running beside it is the pool's load.
  pkg("busy", "@neuve/busy", `bun ${JSON.stringify(launcher)} ./tests`, {
    "busy.test.ts": `test("holds the machine", async () => {
      writeFileSync(${JSON.stringify(marker)}, "");
      try { await Bun.sleep(4000); } finally { rmSync(${JSON.stringify(marker)}, { force: true }); }
    });`,
  });
  // Fails only while another package's test runs beside it, so it passes alone.
  pkg(
    "contended",
    "@neuve/contended",
    `bun ${JSON.stringify(launcher)} --shards=2 ./tests`,
    {
      "contended.test.ts": `describe("shared machine", () => {
      test("needs the machine to itself", async () => {
        const deadline = Date.now() + 2000;
        while (!existsSync(${JSON.stringify(marker)}) && Date.now() < deadline) await Bun.sleep(20);
        expect(existsSync(${JSON.stringify(marker)})).toBe(false);
      });
    });`,
      "steady.test.ts": `test("steady", () => {});`,
    },
  );
  pkg("broken", "@neuve/broken", `bun ${JSON.stringify(launcher)} ./tests`, {
    "broken.test.ts": `describe("arithmetic", () => {
      test("adds", () => { expect(1 + 1).toBe(3); });
      test("subtracts", () => { expect(2 - 1).toBe(1); });
    });`,
  });
  pkg(
    "plain",
    "@neuve/plain",
    "bun test --parallel=2 --timeout=30000 ./tests",
    {
      "plain.test.ts": `test("always fails", () => { expect("graph").toBe("none"); });`,
      "plain-ok.test.ts": `test("passes", () => {});`,
    },
  );
  return root;
};

// Why: the rerun's whole point; the contended test must read as load, the broken ones as real, and the run stay red.
test("after the pool, each failed file reruns alone with its label, load and a JSON summary, and the run stays red", async () => {
  const root = rerunFixture();
  const report = join(root, "report.json");
  const child = spawn(root, [], { NEUVE_TEST_REPORT: report });
  try {
    const { code, output } = await collect(child);
    expect({ code, output }).toMatchObject({ code: 1 });
    const block = output
      .split("\n")
      .filter((line) => / \| @neuve\//.test(line) && !line.includes(":test |"));
    const line = (label: string, rest: string) =>
      expect(
        block.some(
          (entry) =>
            entry.startsWith(`${label} | ${rest} | pool load `) &&
            / at \d\d:\d\d:\d\d \| rerun load \d+\.\d\d/.test(entry),
        ),
        `${label} | ${rest}\n${block.join("\n")}`,
      ).toBe(true);
    line(
      "FAILED UNDER LOAD, PASSED ALONE",
      "@neuve/contended | tests/contended.test.ts | shared machine > needs the machine to itself",
    );
    line(
      "FAILED AGAIN ALONE",
      "@neuve/broken | tests/broken.test.ts | arithmetic > adds",
    );
    line(
      "FAILED AGAIN ALONE",
      "@neuve/plain | tests/plain.test.ts | always fails",
    );
    expect(block).toHaveLength(3);
    expect(output).toContain(
      "[test-report] 3 failed in the pool across 3 files: 1 failed under load, passed alone; 2 failed again alone; 0 not rerun.",
    );
    const summary = JSON.parse(readFileSync(report, "utf8"));
    expect(summary).toMatchObject({
      exitCode: 1,
      counts: { failed: 3, passedAlone: 1, failedAgainAlone: 2 },
    });
    for (const failure of summary.failures)
      expect(failure).toMatchObject({ timing: "fail line" });
  } finally {
    await stop(child);
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);
