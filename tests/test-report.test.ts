import { afterAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  errorCountOf,
  FAILED_AGAIN,
  failLineOf,
  type Failure,
  finishRun,
  labelFailure,
  MAX_RERUN_FILES,
  PASSED_ALONE,
  parseJunit,
  type Rerun,
  type Target,
  writePoolRecord,
} from "../scripts/test-report.ts";

const failure = (overrides: Partial<Failure> = {}): Failure => ({
  package: "@neuve/probe",
  cwd: "/probe",
  file: "tests/a.test.ts",
  test: "outer > fails",
  note: null,
  at: 1_000,
  load1: 20,
  timing: "fail line",
  uncertaintySeconds: null,
  occurrence: null,
  target: {
    kind: "file",
    via: "script",
    script: "test",
    cwd: "/probe",
    file: "tests/a.test.ts",
  },
  ...overrides,
});
const rerun = (code: number, cases: Rerun["cases"]): Rerun => ({
  code,
  cases,
  startedAt: 2_000,
  endedAt: 3_000,
  loadAtStart: 4,
  loadAtEnd: 5,
});
const testCase = (status: "passed" | "failed" | "skipped") => ({
  file: "/probe/tests/a.test.ts",
  name: "outer > fails",
  leaf: "fails",
  seconds: 0.1,
  status,
});

// Why: the two labels are the ruling's whole output; a wrong label hides a real defect as load.
test("a named test passes alone only when the rerun's report has it passing", () => {
  expect(labelFailure(failure(), rerun(0, [testCase("passed")]))).toEqual({
    label: PASSED_ALONE,
    reason: null,
  });
  expect(labelFailure(failure(), rerun(1, [testCase("failed")]))).toEqual({
    label: FAILED_AGAIN,
    reason: "failed in the rerun",
  });
  // A crashed rerun with no report, or a report without the test, never counts as a pass.
  expect(labelFailure(failure(), rerun(124, undefined)).label).toBe(
    FAILED_AGAIN,
  );
  expect(labelFailure(failure(), rerun(0, [testCase("skipped")])).label).toBe(
    FAILED_AGAIN,
  );
  // Same name in another file is not the same test.
  expect(
    labelFailure(
      failure(),
      rerun(0, [{ ...testCase("passed"), file: "/probe/tests/b.test.ts" }]),
    ).label,
  ).toBe(FAILED_AGAIN);
  // test.each can repeat a name: the case at the same position among all same-named cases is the match.
  const second = failure({ occurrence: { index: 1, of: 2 } });
  expect(
    labelFailure(second, rerun(1, [testCase("passed"), testCase("failed")]))
      .label,
  ).toBe(FAILED_AGAIN);
  expect(
    labelFailure(second, rerun(0, [testCase("failed"), testCase("passed")]))
      .label,
  ).toBe(PASSED_ALONE);
  // Different counts are not guessed: any same-named failure in the rerun keeps it failed again.
  expect(
    labelFailure(
      second,
      rerun(1, [testCase("passed"), testCase("passed"), testCase("failed")]),
    ),
  ).toEqual({
    label: FAILED_AGAIN,
    reason:
      "2 tests of this name in the pool's report and 3 in the rerun's, so not matched one to one; one failed in the rerun",
  });
  const unnamed = failure({ file: null, test: null, note: "no JUnit" });
  expect(labelFailure(unnamed, rerun(0, undefined)).label).toBe(PASSED_ALONE);
  expect(labelFailure(unnamed, rerun(1, undefined)).label).toBe(FAILED_AGAIN);
});

const junit = (file: string, cases: { name: string; fail?: boolean }[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="${cases.length}">
  <testsuite name="${file}" file="${file}" tests="${cases.length}">
${cases
  .map(
    (item) =>
      `    <testcase name="${item.name}" classname="${item.name}" time="0.5" file="${file}">${item.fail ? '<failure type="AssertionError"></failure>' : ""}</testcase>`,
  )
  .join("\n")}
  </testsuite>
</testsuites>
`;
/** A run directory as the launcher and pool leave it: one record per failing file. */
const runDirectory = (files: number) => {
  const directory = mkdtempSync(join(tmpdir(), "test-report-"));
  mkdirSync(join(directory, "junit"));
  const shards = Array.from({ length: files }, (_, index) => {
    const path = join(directory, "junit", `${index}.xml`);
    writeFileSync(
      path,
      junit(`tests/f${index}.test.ts`, [
        { name: "passes" },
        { name: `fails ${index}`, fail: true },
      ]),
    );
    return {
      shard: null,
      junit: path,
      code: 1,
      startedAt: 10_000 + index,
      endedAt: 20_000 + index,
      fails: [],
      errors: 0,
    };
  });
  writeFileSync(
    join(directory, "launch-1.json"),
    JSON.stringify({
      kind: "launcher",
      package: "@neuve/probe",
      cwd: directory,
      shards,
    }),
  );
  writePoolRecord(directory, 0, [
    {
      name: "@neuve/probe",
      cwd: directory,
      mode: "launcher",
      args: null,
      code: 1,
      startedAt: 10_000,
      endedAt: 20_000,
      junit: null,
      fails: [],
      errors: 0,
    },
  ]);
  directories.push(directory);
  return directory;
};
const directories: string[] = [];
afterAll(() => {
  for (const directory of directories)
    rmSync(directory, { recursive: true, force: true });
});
const finish = async (
  directory: string,
  options: {
    runCode?: number;
    interrupted?: boolean;
    passAlone?: boolean;
    stopAfter?: number;
  } = {},
) => {
  const lines: string[] = [];
  const targets: Target[] = [];
  let stopped = 0;
  const report = join(directory, "report.json");
  const code = await finishRun({
    directory,
    samples: [{ at: 10_000, load1: 30 }],
    runCode: options.runCode ?? 1,
    interrupted: options.interrupted ?? false,
    stopped: () => stopped,
    report,
    print: (line) => lines.push(line),
    rerun: async (target) => {
      targets.push(target);
      if (
        options.stopAfter !== undefined &&
        targets.length >= options.stopAfter
      )
        stopped = 143;
      const file = target.kind === "file" ? target.file : "";
      const index = file.match(/f(\d+)/)?.[1] ?? "";
      return rerun(options.passAlone ? 0 : 1, [
        {
          file: join(directory, file),
          name: `fails ${index}`,
          leaf: `fails ${index}`,
          seconds: 0.1,
          status: options.passAlone ? "passed" : "failed",
        },
      ]);
    },
  });
  return {
    code,
    lines,
    targets,
    report: JSON.parse(readFileSync(report, "utf8")),
  };
};

// Why: the ruling keeps the run red whenever the pool failed, even if every rerun passes.
test("a pool failure exits non-zero even when every rerun passes alone", async () => {
  const directory = runDirectory(2);
  try {
    const result = await finish(directory, { passAlone: true });
    expect(result.code).toBe(1);
    expect(result.targets).toHaveLength(2);
    expect(result.lines).toContain(
      `${PASSED_ALONE} | @neuve/probe | tests/f0.test.ts | fails 0 | pool load 30.00 at ${new Date(11_000).toTimeString().slice(0, 8)} (time estimated, up to 9 s late) | rerun load 5.00`,
    );
    expect(result.report).toMatchObject({
      exitCode: 1,
      counts: { failed: 2, files: 2, passedAlone: 2, failedAgainAlone: 0 },
    });
    // The pool's own code is kept when it is not 1.
    expect(
      (await finish(runDirectory(1), { runCode: 3, passAlone: true })).code,
    ).toBe(3);
    // Records name a failure even when the pool's code says 0.
    expect(
      (await finish(runDirectory(1), { runCode: 0, passAlone: true })).code,
    ).toBe(1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a failure that fails again alone is labelled so and stays red", async () => {
  const directory = runDirectory(1);
  try {
    const result = await finish(directory);
    expect(result.code).toBe(1);
    expect(
      result.lines.some((line) =>
        line.startsWith(
          `${FAILED_AGAIN} | @neuve/probe | tests/f0.test.ts | fails 0 |`,
        ),
      ),
    ).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Why: more than ten failing files is not load; only the first ten (in failure order) run again.
test("more than ten failing files reruns the first ten and names the rest not rerun", async () => {
  const directory = runDirectory(MAX_RERUN_FILES + 1);
  try {
    const result = await finish(directory, { passAlone: true });
    expect(result.code).toBe(1);
    expect(result.targets).toHaveLength(MAX_RERUN_FILES);
    expect(result.lines).toContain(
      `[test-report] ${MAX_RERUN_FILES + 1} files failed: more than ${MAX_RERUN_FILES} failing files is not load, so only the first ${MAX_RERUN_FILES} ran again.`,
    );
    const skipped = result.lines.filter((line) =>
      line.startsWith("not rerun |"),
    );
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain(`tests/f${MAX_RERUN_FILES}.test.ts`);
    expect(result.report.counts).toMatchObject({
      passedAlone: 10,
      notRerun: 1,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Why: an interrupted pool says nothing about load; a signal during reruns stops them with its own code.
test("no rerun after an interrupted pool, and a signal during reruns stops the rest", async () => {
  const directory = runDirectory(3);
  try {
    const interrupted = await finish(directory, {
      runCode: 130,
      interrupted: true,
    });
    expect(interrupted.code).toBe(130);
    expect(interrupted.targets).toHaveLength(0);
    expect(
      interrupted.lines.filter((line) =>
        line.endsWith("| the pool was interrupted"),
      ),
    ).toHaveLength(3);
    const stopped = await finish(directory, { stopAfter: 1 });
    expect(stopped.code).toBe(143);
    expect(stopped.targets).toHaveLength(1);
    expect(
      stopped.lines.filter((line) => line.startsWith("not rerun |")),
    ).toHaveLength(3);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a run with no failure prints that nothing reran and keeps exit 0", async () => {
  const directory = mkdtempSync(join(tmpdir(), "test-report-"));
  try {
    writePoolRecord(directory, 0, []);
    const result = await finish(directory, { runCode: 0 });
    expect(result.code).toBe(0);
    expect(result.lines).toContain(
      "[test-report] No test failed in the pool; nothing to rerun.",
    );
    expect(result.report.counts.failed).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// A non-zero run with no record naming anything is still reported, never dropped.
test("a failing run without records reports an unnamed failure and is not rerun", async () => {
  const directory = mkdtempSync(join(tmpdir(), "test-report-"));
  try {
    const result = await finish(directory, { runCode: 2 });
    expect(result.code).toBe(2);
    expect(result.targets).toHaveLength(0);
    expect(
      result.lines.find((line) => line.startsWith("not rerun |")),
    ).toContain("no record names what failed");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Why: names come from Bun's own JUnit, so the parser is checked against what this Bun writes, not a hand-made sample.
test("JUnit from this Bun names nested describes, each rows, skips, timeouts and leaves load failures out", async () => {
  const directory = mkdtempSync(join(tmpdir(), "test-report-junit-"));
  try {
    writeFileSync(
      join(directory, "cases.test.ts"),
      `import { describe, expect, test } from "bun:test";
      test("top fail", () => { expect(1).toBe(2); });
      describe("outer", () => {
        describe('inner <&> "quoted"', () => {
          test("nested fail", () => { throw new Error("boom"); });
          test("nested pass", () => {});
        });
        test.each([1, 2])("each %p", (n) => { expect(n).toBe(1); });
        test.skip("skipped", () => {});
        test.todo("todo one");
      });
      test("slow", async () => { await Bun.sleep(1000); }, 50);`,
    );
    writeFileSync(
      join(directory, "broken.test.ts"),
      `import { test } from "bun:test";
      throw new Error("fails to load");
      test("never", () => {});`,
    );
    const report = join(directory, "junit.xml");
    const child = Bun.spawn(
      [
        process.execPath,
        "test",
        "--reporter=junit",
        `--reporter-outfile=${report}`,
        "./cases.test.ts",
        "./broken.test.ts",
      ],
      {
        cwd: directory,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NEUVE_TEST_PROCESS: undefined },
      },
    );
    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(1);
    const cases = parseJunit(readFileSync(report, "utf8"));
    expect(cases.map(({ file, name, status }) => [file, name, status])).toEqual(
      [
        ["cases.test.ts", "top fail", "failed"],
        ["cases.test.ts", 'outer > inner <&> "quoted" > nested fail', "failed"],
        ["cases.test.ts", 'outer > inner <&> "quoted" > nested pass', "passed"],
        ["cases.test.ts", "outer > each 1", "passed"],
        ["cases.test.ts", "outer > each 2", "failed"],
        ["cases.test.ts", "outer > skipped", "skipped"],
        ["cases.test.ts", "outer > todo one", "skipped"],
        ["cases.test.ts", "slow", "failed"],
      ],
    );
    // The file that failed to load is absent; only Bun's closing error count shows it.
    expect(cases.some((item) => item.file.includes("broken"))).toBe(false);
    const lines = stderr.split("\n");
    expect(
      lines.map(errorCountOf).filter((count) => count !== undefined),
    ).toEqual([1]);
    // Each console (fail) line starts with the name the report builds, which is how a line's time joins its test.
    for (const item of cases.filter(({ status }) => status === "failed"))
      expect(
        lines.some((line) =>
          failLineOf(line)?.line.startsWith(`(fail) ${item.name}`),
        ),
      ).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

// Why: the root runner must rerun a root file through test:root, once; rerunning its own `test` script would start
// the whole run again inside itself (a fixture run on 13 November recursed this way until stopped).
test("the root runner reruns a failed root file once through test:root and a nested runner leaves the report to the outer run", async () => {
  const root = mkdtempSync(join(tmpdir(), "test-report-root-"));
  const scripts = join(import.meta.dir, "../scripts");
  try {
    mkdirSync(join(root, "roottests"));
    mkdirSync(join(root, "packages/ok/tests"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "rerun-root",
        workspaces: ["packages/*"],
        scripts: {
          test: `bun ${JSON.stringify(join(scripts, "test-run.ts"))}`,
          "test:root": `bun ${JSON.stringify(join(scripts, "test-budget.ts"))} ./roottests`,
          "test:workspaces": `bun ${JSON.stringify(join(scripts, "test-workspaces.ts"))}`,
        },
      }),
    );
    writeFileSync(
      join(root, "bunfig.toml"),
      `[test]\npreload = [${JSON.stringify(join(scripts, "test-budget.ts"))}]\n`,
    );
    writeFileSync(
      join(root, "roottests/root.test.ts"),
      `import { expect, test } from "bun:test";
      test("root fails", () => { expect(1).toBe(2); });`,
    );
    writeFileSync(
      join(root, "packages/ok/package.json"),
      JSON.stringify({
        name: "@neuve/ok",
        scripts: { test: "bun test ./tests" },
      }),
    );
    writeFileSync(
      join(root, "packages/ok/tests/ok.test.ts"),
      `import { test } from "bun:test"; test("ok", () => {});`,
    );
    const run = async (env: Record<string, string | undefined>) => {
      const child = Bun.spawn([process.execPath, "run", "test"], {
        cwd: root,
        env: {
          ...process.env,
          ...env,
          NEUVE_TEST_REPORT: join(root, "report.json"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, output: stdout + stderr };
    };
    const outer = await run({ NEUVE_TEST_RUN_DIRECTORY: undefined });
    expect(outer.code, outer.output).toBe(1);
    expect(outer.output.match(/\[test-report\] Rerunning/g)).toHaveLength(1);
    expect(outer.output.match(/\[test-report\] Rerun alone: /g)).toHaveLength(
      1,
    );
    expect(outer.output).toContain(
      "FAILED AGAIN ALONE | rerun-root | roottests/root.test.ts | root fails | pool load ",
    );
    expect(outer.output).toMatch(/^test:root +\| \(fail\) root fails/m);
    const nested = await run({
      NEUVE_TEST_RUN_DIRECTORY: join(root, "outer-run"),
    });
    expect(nested.code).toBe(1);
    expect(nested.output).not.toContain("[test-report]");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);

// Why: test.each rows and repeated test("x") share one name; the review reproduced a pass-then-fail file that failed
// again alone being labelled passed alone. Pool and rerun reports here are real Bun 1.4.4 JUnit.
test("same-named cases are matched by their position among all of them in real Bun reports", async () => {
  const directory = mkdtempSync(join(tmpdir(), "test-report-rows-"));
  directories.push(directory);
  writeFileSync(
    join(directory, "rows.test.ts"),
    `import { expect, test } from "bun:test";
    // ROWS gives each row's outcome in order: f fails, anything else passes. Every row has the same name.
    test.each([...process.env.ROWS!].map((outcome, row) => [outcome, row]))("row", (outcome) => {
      expect(outcome).not.toBe("f");
    });
    test("plain", () => {});
    test("plain", () => { expect(process.env.ROWS).not.toContain("x"); });`,
  );
  let reports = 0;
  const report = async (rows: string) => {
    const path = join(directory, `junit-${reports++}.xml`);
    const child = Bun.spawn(
      [
        process.execPath,
        "test",
        "--reporter=junit",
        `--reporter-outfile=${path}`,
        "./rows.test.ts",
      ],
      {
        cwd: directory,
        env: { ...process.env, ROWS: rows, NEUVE_TEST_PROCESS: undefined },
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    return { code, path, stderr };
  };
  const labels = async (pool: string, alone: string) => {
    const run = mkdtempSync(join(directory, "run-"));
    const first = await report(pool);
    writeFileSync(
      join(run, "launch-1.json"),
      JSON.stringify({
        kind: "launcher",
        package: "@neuve/rows",
        cwd: directory,
        shards: [
          {
            shard: null,
            junit: first.path,
            code: first.code,
            startedAt: 1_000,
            endedAt: 2_000,
            // Bun's own (fail) lines, so timing joins as it does in a real run.
            fails: first.stderr
              .split("\n")
              .flatMap((line) => failLineOf(line) ?? []),
            errors: 0,
          },
        ],
      }),
    );
    writePoolRecord(run, 0, [
      {
        name: "@neuve/rows",
        cwd: directory,
        mode: "launcher",
        args: null,
        code: first.code,
        startedAt: 1_000,
        endedAt: 2_000,
        junit: null,
        fails: [],
        errors: 0,
      },
    ]);
    const printed: string[] = [];
    await finishRun({
      directory: run,
      samples: [],
      runCode: first.code,
      interrupted: false,
      stopped: () => 0,
      report: join(run, "report.json"),
      print: (line) => printed.push(line),
      rerun: async () => {
        const second = await report(alone);
        return rerun(
          second.code,
          parseJunit(readFileSync(second.path, "utf8")).map((item) => ({
            ...item,
            file: join(directory, item.file),
          })),
        );
      },
    });
    return printed
      .filter((line) => line.includes(" | @neuve/rows | "))
      .map(
        (line) =>
          line.split(" | ").slice(0, 4).join(" | ") +
          (line.includes("not matched one to one") ? " | unmatched" : ""),
      );
  };
  const again = `${FAILED_AGAIN} | @neuve/rows | rows.test.ts | row`;
  const alone = `${PASSED_ALONE} | @neuve/rows | rows.test.ts | row`;
  // Pass then fail, in the pool and alone: the second row failed again.
  expect(await labels("pf", "pf")).toEqual([again]);
  // Fail then pass, in the pool and alone: the first row failed again.
  expect(await labels("fp", "fp")).toEqual([again]);
  // Both fail in both runs.
  expect(await labels("ff", "ff")).toEqual([again, again]);
  // The second row failed in the pool and passed alone: that is load.
  expect(await labels("pf", "pp")).toEqual([alone]);
  // A different number of rows alone is not matched by position; a failing row keeps it failed again.
  expect(await labels("pf", "ppf")).toEqual([`${again} | unmatched`]);
  // Repeated test("plain"): the second one fails in the pool and alone.
  expect(await labels("px", "px")).toEqual([
    `${FAILED_AGAIN} | @neuve/rows | rows.test.ts | plain`,
  ]);
}, 60000);
