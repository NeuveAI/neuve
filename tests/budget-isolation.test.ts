import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTestProcess } from "../scripts/test-process.ts";

test("direct bun test refuses default-environment children before they can reach HOME", async () => {
  const root = mkdtempSync(join(tmpdir(), "budget-direct-"));
  const home = join(root, "home");
  mkdirSync(home);
  const fixture = join(root, "default-child.test.ts");
  const module = join(
    import.meta.dir,
    "../packages/harness/src/budget/local.ts",
  );
  const childCode = `import { workerBudget, closeWorkerBudget } from ${JSON.stringify(module)};
    try { await workerBudget(); } finally { await closeWorkerBudget(); }`;
  writeFileSync(
    fixture,
    `import { expect, test } from "bun:test";
    import { readdirSync } from "node:fs";
    test("default child environments", async () => {
      const command = [process.execPath, "--no-env-file", "-e", ${JSON.stringify(childCode)}];
      expect(await Bun.spawn(command, { stdout: "ignore", stderr: "ignore" }).exited).toBe(0);
      expect(Bun.spawnSync({ cmd: command, stdout: "ignore", stderr: "ignore" }).exitCode).toBe(0);
      expect(readdirSync(${JSON.stringify(home)})).toEqual([]);
    });`,
  );
  // HOME is set before Bun captures its default child environment.
  const command = [
    process.execPath,
    "--no-env-file",
    "test",
    "--preload",
    join(import.meta.dir, "../scripts/test-budget.ts"),
    fixture,
  ];
  const child = Bun.spawn(command, {
    env: {
      ...process.env,
      HOME: home,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(root, "transpiler"),
      XDG_DATA_HOME: undefined,
      XDG_STATE_HOME: undefined,
      NEUVE_TEST_PROCESS: undefined,
      NEUVE_BUDGET_DIRECTORY: undefined,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(readdirSync(home)).toEqual([]);
    expect(code).toBe(1);
    expect(stdout + stderr).toContain(
      "Direct bun test requires the isolated launcher",
    );
    expect(stdout + stderr).not.toContain("(pass) default child environments");
    expect(existsSync(join(home, "Library"))).toBe(false);
    expect(existsSync(join(home, ".local"))).toBe(false);
    const marked = Bun.spawn(command, {
      env: {
        ...process.env,
        HOME: home,
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(root, "transpiler"),
        XDG_DATA_HOME: undefined,
        XDG_STATE_HOME: undefined,
        NEUVE_TEST_PROCESS: "1",
        NEUVE_BUDGET_DIRECTORY: join(root, "isolated"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [markedCode, markedOut, markedErr] = await Promise.all([
      marked.exited,
      new Response(marked.stdout).text(),
      new Response(marked.stderr).text(),
    ]);
    expect({ code: markedCode, output: markedOut + markedErr }).toMatchObject({
      code: 0,
    });
    expect(markedOut + markedErr).toContain("1 pass");
    expect(readdirSync(home)).toEqual([]);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    rmSync(root, { recursive: true, force: true });
  }
});

test("the startup marker refuses the user's budget when its directory is absent", async () => {
  expect(process.env.NEUVE_TEST_PROCESS).toBe("1");
  const home = mkdtempSync(join(tmpdir(), "budget-fake-home-"));
  const module = join(
    import.meta.dir,
    "../packages/harness/src/budget/local.ts",
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { workerBudget, closeWorkerBudget } from ${JSON.stringify(module)};
     process.env.HOME = ${JSON.stringify(home)};
     delete process.env.NEUVE_BUDGET_DIRECTORY;
     try { await workerBudget(); process.exitCode = 1; }
     catch (error) { process.exitCode = error.message === "Test processes require NEUVE_BUDGET_DIRECTORY" ? 0 : 2; }
     finally { if (process.env.NEUVE_BUDGET_DIRECTORY) await closeWorkerBudget(); }`,
    ],
    {
      env: { ...process.env, NODE_ENV: "production" },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  try {
    expect(await child.exited).toBe(0);
    expect(
      existsSync(join(home, "Library/Application Support/Neuve/budget")),
    ).toBe(false);
    expect(existsSync(join(home, ".local/share/neuve/budget"))).toBe(false);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    rmSync(home, { recursive: true, force: true });
  }
});

test("NODE_ENV=test alone starts a normal production worker budget", async () => {
  const home = mkdtempSync(join(tmpdir(), "budget-production-home-"));
  const module = join(
    import.meta.dir,
    "../packages/harness/src/budget/local.ts",
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `import { budgetDirectory, workerBudget, closeWorkerBudget } from ${JSON.stringify(module)};
     if (!budgetDirectory().startsWith(${JSON.stringify(home)})) process.exit(1);
     try { await workerBudget(); } finally { await closeWorkerBudget(); }`,
    ],
    {
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !key.startsWith("NEUVE_"),
          ),
        ),
        HOME: home,
        XDG_DATA_HOME: undefined,
        XDG_STATE_HOME: undefined,
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(home, "cache"),
        NODE_ENV: "test",
        NEUVE_TEST_PROCESS: undefined,
        NEUVE_BUDGET_DIRECTORY: undefined,
      },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  try {
    expect(await child.exited).toBe(0);
    expect(
      existsSync(
        join(
          home,
          process.platform === "darwin"
            ? "Library/Application Support/Neuve/budget/budget.sqlite"
            : ".local/state/neuve/budget/budget.sqlite",
        ),
      ),
    ).toBe(true);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    rmSync(home, { recursive: true, force: true });
  }
});

test("the launcher marks implicit child environments before Bun starts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "budget-launcher-"));
  try {
    const check = `process.exit(process.env.NEUVE_TEST_PROCESS === "1" && process.env.NEUVE_BUDGET_DIRECTORY === ${JSON.stringify(directory)} ? 0 : 1)`;
    expect(
      await runTestProcess(
        [
          process.execPath,
          "-e",
          `const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(check)}]); process.exit(await child.exited);`,
        ],
        { directory, timeoutMs: 5000 },
      ),
    ).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
