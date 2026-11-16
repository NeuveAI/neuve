import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const launcher = join(import.meta.dir, "../scripts/test-budget.ts");
const fixture = () => mkdtempSync(join(tmpdir(), "test-shards-"));
const spawn = (
  cwd: string,
  args: string[],
  env: Record<string, string | undefined> = {},
) =>
  Bun.spawn([process.execPath, "--no-env-file", launcher, ...args], {
    cwd,
    env: {
      ...process.env,
      NEUVE_TEST_SHARDS: undefined,
      NEUVE_TEST_SUITE_TIMEOUT_MS: "60000",
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
const files = (root: string, count: number, failure = false) => {
  for (let i = 0; i < count; i++)
    writeFileSync(
      join(root, `file-${i}.test.ts`),
      `
    import { test, expect } from "bun:test";
    import { existsSync, writeFileSync } from "node:fs";
    test("file ${i}", () => {
      const directory = process.env.NEUVE_BUDGET_DIRECTORY;
      expect(existsSync(directory)).toBe(true);
      writeFileSync(${JSON.stringify(join(root, `seen-${i}.json`))}, JSON.stringify({directory, pid:process.pid}));
      console.log("FILE:${i}"); console.error("STDERR:${i}");
      expect(${failure && i === 0}).toBe(false);
    });`,
    );
};

test("three shards run every file once with separate, removed budgets and exact totals", async () => {
  const root = fixture();
  files(root, 12);
  const child = spawn(root, ["--shards=3", "./"]);
  try {
    const { code, output } = await collect(child);
    expect({ code, output }).toMatchObject({ code: 0 });
    const directories = new Set<string>();
    for (let i = 0; i < 12; i++) {
      expect(output.match(new RegExp(`^FILE:${i}$`, "gm"))).toHaveLength(1);
      expect(output.match(new RegExp(`^STDERR:${i}$`, "gm"))).toHaveLength(1);
      const seen = JSON.parse(
        readFileSync(join(root, `seen-${i}.json`), "utf8"),
      );
      directories.add(seen.directory);
      expect(existsSync(seen.directory)).toBe(false);
    }
    expect(directories.size).toBe(3);
    expect(output).toContain("Totals: 12 tests, 12 files, 12 pass, 0 fail");
    expect(
      output.match(/^\[test-budget\] Shard \d\/3, exit 0,/gm),
    ).toHaveLength(3);
  } finally {
    await stop(child);
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failing shard still prints every complete shard output and summed failures", async () => {
  const root = fixture();
  files(root, 12, true);
  const child = spawn(root, ["--shards=3", "./"]);
  try {
    const { code, output } = await collect(child);
    expect(code).not.toBe(0);
    expect(output).toContain("Totals: 12 tests, 12 files, 11 pass, 1 fail");
    const blocks = output
      .split(/\[test-budget\] Shard \d\/3, exit \d+, [\d.]+s\n/)
      .slice(1);
    expect(blocks).toHaveLength(3);
    for (let i = 0; i < 12; i++) {
      expect(
        blocks.filter(
          (block) =>
            block.includes(`FILE:${i}\n`) && block.includes(`STDERR:${i}\n`),
        ),
      ).toHaveLength(1);
    }
  } finally {
    await stop(child);
    rmSync(root, { recursive: true, force: true });
  }
});

test("large shard blocks stay whole before the summary through a delayed pipe reader", async () => {
  const root = fixture();
  const payload = "x".repeat(200) + "é";
  const expected: string[] = [];
  for (let file = 0; file < 12; file++) {
    for (let line = 0; line < 4096; line++)
      expected.push(`${file}:${line}:${payload}`);
    writeFileSync(
      join(root, `large-${file}.test.ts`),
      `
      import { test } from "bun:test";
      import { writeFileSync } from "node:fs";
      import { basename } from "node:path";
      test("large ${file}", () => {
        const shard = basename(process.env.NEUVE_BUDGET_DIRECTORY).split("-")[1];
        for (let line = 0; line < 4096; line++)
          console.log("LINE:" + shard + ":${file}:" + line + ":" + ${JSON.stringify(payload)});
        writeFileSync(${JSON.stringify(join(root, `ready-${file}`))}, String(process.pid));
      });`,
    );
  }
  const child = spawn(root, ["--shards=2", "./"]);
  let collected: ReturnType<typeof collect> | undefined;
  try {
    // Leave stdout unread until both shards have finished producing their logs.
    await waitFor(() =>
      Array.from({ length: 12 }, (_, file) =>
        join(root, `ready-${file}`),
      ).every(
        (path) =>
          existsSync(path) && !alive(Number(readFileSync(path, "utf8"))),
      ),
    );
    await Bun.sleep(100);
    collected = collect(child);
    const { code, output } = await collected;
    expect(code).toBe(0);
    const summary = output.indexOf("\n[test-budget] Shard summary\n");
    expect(summary).toBeGreaterThan(output.lastIndexOf("\nLINE:"));
    const headers = [
      ...output.matchAll(/^\[test-budget\] Shard (\d)\/2, exit 0, [\d.]+s\n/gm),
    ];
    expect(headers.map((header) => header[1]).sort()).toEqual(["1", "2"]);
    const actual: string[] = [];
    for (const [index, header] of headers.entries()) {
      const block = output.slice(
        header.index + header[0].length,
        headers[index + 1]?.index ?? summary,
      );
      const lines = block
        .split("\n")
        .filter((line) => line.startsWith("LINE:"));
      expect(Buffer.byteLength(lines.join("\n"))).toBeGreaterThan(64 * 1024);
      expect(lines.every((line) => line.startsWith(`LINE:${header[1]}:`))).toBe(
        true,
      );
      actual.push(
        ...lines.map((line) => line.slice(`LINE:${header[1]}:`.length)),
      );
    }
    expect(actual.sort()).toEqual(expected.sort());
    expect(output.slice(summary)).toMatch(
      /Totals: 12 tests, 12 files, 12 pass, 0 fail\n$/,
    );
  } finally {
    collected ??= collect(child);
    await stop(child);
    await collected;
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);

test("totals use Bun's final counts after test output resembling summaries", async () => {
  const root = fixture();
  files(root, 12, true);
  for (let file = 0; file < 12; file++) {
    const path = join(root, `file-${file}.test.ts`);
    writeFileSync(
      path,
      readFileSync(path, "utf8") +
        '\nconsole.log("Ran 999 tests across 888 files.\\n 777 pass\\n 666 fail\\nRan 555 tests across 444 files.\\n 333 pass\\n 222 fail");\n',
    );
  }
  const child = spawn(root, ["--shards=3", "./"]);
  try {
    const { code, output } = await collect(child);
    expect(code).not.toBe(0);
    expect(output).toContain("Totals: 12 tests, 12 files, 11 pass, 1 fail");
    const summary = output.slice(
      output.indexOf("\n[test-budget] Shard summary\n"),
    );
    expect(
      summary.match(/^Shard \d\/3:.* \| Ran 4 tests across 4 files\./gm),
    ).toHaveLength(3);
  } finally {
    await stop(child);
    rmSync(root, { recursive: true, force: true });
  }
});

test("single-shard launches and the override preserve the normal output path", async () => {
  const root = fixture();
  files(root, 1);
  try {
    for (const [args, env] of [
      [[], {}],
      [["--shards=1"], {}],
      [["--shards=3"], { NEUVE_TEST_SHARDS: "1" }],
    ] satisfies [string[], Record<string, string>][]) {
      const child = spawn(root, [...args, "./"], env);
      try {
        const { code, output } = await collect(child);
        expect(code).toBe(0);
        expect(output).toContain("1 pass");
        expect(output).not.toContain("Shard summary");
        const seen = JSON.parse(
          readFileSync(join(root, "seen-0.json"), "utf8"),
        );
        expect(existsSync(seen.directory)).toBe(false);
      } finally {
        await stop(child);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("launcher refuses conflicting shard flags and invalid counts before running tests", async () => {
  const root = fixture();
  files(root, 1);
  try {
    for (const args of [
      ["--shards=3", "--shard=1/3"],
      ["--shards=1", "--shard", "1/3"],
      ["--shards=3", "--update-timings"],
      ["--shards=0"],
      ["--shards=-1"],
      ["--shards=1.5"],
      ["--shards=oops"],
      ["--shards"],
    ]) {
      const child = spawn(root, [...args, "./"]);
      try {
        expect((await collect(child)).code).toBe(2);
      } finally {
        await stop(child);
      }
    }
    const child = spawn(root, ["--shards=3", "./"], { NEUVE_TEST_SHARDS: "0" });
    try {
      expect((await collect(child)).code).toBe(2);
    } finally {
      await stop(child);
    }
    expect(existsSync(join(root, "seen-0.json"))).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing timings warn once; existing timings balance shards without being rewritten", async () => {
  const root = fixture();
  files(root, 12);
  try {
    const missing = spawn(root, [
      "--shards=3",
      "--shard-timings=missing.json",
      "./",
    ]);
    try {
      const { code, output } = await collect(missing);
      expect(code).toBe(0);
      expect(
        output.match(/absent; running without shard timings/g),
      ).toHaveLength(1);
    } finally {
      await stop(missing);
    }
    const timings = join(root, "timings.json");
    writeFileSync(timings, '{"version":1,"files":{}}\n');
    const child = spawn(root, [
      "--shards=3",
      `--shard-timings=${timings}`,
      "./",
    ]);
    try {
      const { code, output } = await collect(child);
      expect({ code, output }).toMatchObject({ code: 0 });
      expect(output).not.toContain("absent;");
      expect(readFileSync(timings, "utf8")).toBe('{"version":1,"files":{}}\n');
    } finally {
      await stop(child);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a shard without a test summary fails even when its process exits zero", async () => {
  const root = fixture();
  writeFileSync(join(root, "early.test.ts"), "process.exit(0);");
  const child = spawn(root, ["--shards=2", "./"]);
  try {
    const { code, output } = await collect(child);
    expect(code).toBe(1);
    expect(output).toContain("missing Ran tests/files summary");
  } finally {
    await stop(child);
    rmSync(root, { recursive: true, force: true });
  }
});

const waitFor = async (check: () => boolean) => {
  const deadline = Date.now() + 10000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Fixture did not become ready");
    await Bun.sleep(20);
  }
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a closed stdout waits for the slow shard and preserves shard exit codes", async () => {
  for (const fastCode of [0, 7]) {
    const root = fixture();
    const fast = join(root, "fast.pid");
    const ready = join(root, "slow.json");
    const release = join(root, "release");
    const ended = join(root, "ended");
    for (let file = 0; file < 12; file++)
      writeFileSync(
        join(root, `pipe-${file}.test.ts`),
        `
        import { expect, test } from "bun:test";
        import { existsSync, writeFileSync } from "node:fs";
        import { basename } from "node:path";
        test("pipe ${file}", async () => {
          const directory = process.env.NEUVE_BUDGET_DIRECTORY;
          if (basename(directory).startsWith("shard-2-")) {
            if (!existsSync(${JSON.stringify(ready)}))
              writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pid: process.pid, directory }));
            while (!existsSync(${JSON.stringify(release)})) await Bun.sleep(10);
            expect(existsSync(directory)).toBe(true);
            writeFileSync(${JSON.stringify(ended)}, "done");
          } else {
            writeFileSync(${JSON.stringify(fast)}, String(process.pid));
            while (!existsSync(${JSON.stringify(ready)})) await Bun.sleep(10);
            if (${fastCode} !== 0) process.exit(${fastCode});
          }
        }, 60000);`,
      );
    const child = spawn(root, ["--shards=2", "./"]);
    let stderr = "";
    const errors = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of child.stderr)
        stderr += decoder.decode(chunk, { stream: true });
      stderr += decoder.decode();
    })();
    let slowPid: number | undefined;
    try {
      await child.stdout.cancel();
      await waitFor(() => existsSync(ready));
      const slow = JSON.parse(readFileSync(ready, "utf8"));
      slowPid = slow.pid;
      await waitFor(() => stderr.includes("EPIPE") || child.exitCode !== null);
      expect(stderr).toContain("EPIPE");
      expect(child.exitCode).toBeNull();
      expect(alive(slow.pid)).toBe(true);
      expect(existsSync(slow.directory)).toBe(true);
      writeFileSync(release, "");
      expect(await child.exited).toBe(fastCode || 1);
      expect(existsSync(ended)).toBe(true);
      expect(alive(slow.pid)).toBe(false);
      expect(alive(Number(readFileSync(fast, "utf8")))).toBe(false);
      expect(existsSync(slow.directory)).toBe(false);
      expect(existsSync(dirname(slow.directory))).toBe(false);
    } finally {
      writeFileSync(release, "");
      await stop(child);
      await errors;
      if (slowPid !== undefined) {
        const pid = slowPid;
        try {
          await waitFor(() => !alive(pid));
        } finally {
          if (alive(pid)) process.kill(pid, "SIGKILL");
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 30000);

test("SIGTERM stops every shard and its descendants and removes budgets", async () => {
  const root = fixture();
  const ready = join(root, "ready.jsonl");
  for (let i = 0; i < 12; i++)
    writeFileSync(
      join(root, `wait-${i}.test.ts`),
      `
    import { test } from "bun:test";
    import { appendFileSync } from "node:fs";
    test("wait ${i}", async () => {
      const child = Bun.spawn([process.execPath, "-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)']);
      appendFileSync(${JSON.stringify(ready)}, JSON.stringify({pid:process.pid, child:child.pid, directory:process.env.NEUVE_BUDGET_DIRECTORY})+"\\n");
      await new Promise(() => {});
    }, 60000);`,
    );
  const child = spawn(root, ["--shards=3", "./"]);
  let pids: number[] = [];
  try {
    await waitFor(
      () =>
        existsSync(ready) &&
        readFileSync(ready, "utf8").trim().split("\n").length === 3,
    );
    const entries = readFileSync(ready, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    pids = entries.flatMap((entry) => [entry.pid, entry.child]);
    child.kill("SIGTERM");
    expect((await collect(child)).code).not.toBe(0);
    await waitFor(() => pids.every((pid) => !alive(pid)));
    for (const entry of entries)
      expect(existsSync(entry.directory)).toBe(false);
  } finally {
    await stop(child);
    for (const pid of pids) if (alive(pid)) process.kill(pid, "SIGKILL");
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);

test("each shard has its own suite watchdog and preserves exit 124", async () => {
  const root = fixture();
  for (let i = 0; i < 12; i++)
    writeFileSync(
      join(root, `wait-${i}.test.ts`),
      `await new Promise(() => {});`,
    );
  const child = spawn(root, ["--shards=3", "./"], {
    NEUVE_TEST_SUITE_TIMEOUT_MS: "600",
  });
  try {
    const { code, output } = await collect(child);
    expect(code).toBe(124);
    expect(output.match(/Suite timed out after 600 ms/g)).toHaveLength(3);
    expect(output.match(/Shard \d\/3: exit 124/g)).toHaveLength(3);
  } finally {
    await stop(child);
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test("exit codes follow shard order while output follows completion order", async () => {
  const root = fixture();
  for (let i = 0; i < 12; i++)
    writeFileSync(
      join(root, `exit-${i}.test.ts`),
      `
    import { test } from "bun:test";
    import { basename } from "node:path";
    import { existsSync } from "node:fs";
    const budget = basename(process.env.NEUVE_BUDGET_DIRECTORY);
    if (budget.startsWith("shard-1-")) { while (!existsSync(${JSON.stringify(join(root, "release"))})) await Bun.sleep(10); process.exit(7); }
    if (budget.startsWith("shard-3-")) process.exit(9);
    test("middle shard", () => {});
  `,
    );
  const child = spawn(root, ["--shards=3", "./"]);
  let output = "";
  const stdout = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout)
      output += decoder.decode(chunk, { stream: true });
    output += decoder.decode();
  })();
  const stderr = new Response(child.stderr).text();
  try {
    await waitFor(() => output.includes("Shard 3/3, exit 9"));
    writeFileSync(join(root, "release"), "");
    const code = await child.exited;
    await stdout;
    output += await stderr;
    expect(code).toBe(7);
    expect(output).toContain("Shard 1/3, exit 7");
    const headers = output.match(/\[test-budget\] Shard [13]\/3, exit/g);
    expect(headers).toEqual([
      "[test-budget] Shard 3/3, exit",
      "[test-budget] Shard 1/3, exit",
    ]);
  } finally {
    await stop(child);
    await stdout;
    await stderr;
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
