import { expect, test } from "bun:test";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
  realpath,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function run(args: string[], mode = "shapes") {
  // The preload replaces executable, process and SDK services before the manual entrypoint loads.
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--preload",
      join(import.meta.dir, "smoke-tools-diagnose-preload.ts"),
      join(import.meta.dir, "../src/smoke.ts"),
      "--live",
      "/test",
      ...args,
    ],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, FIXTURE_FLAG_MODE: mode },
    },
  );
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stdout + stderr).not.toContain("private-");
    return { code, stdout };
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}

// Reason: invalid recorder flags must reject before even the fake SDK is opened.
test("record flag rejects missing combinations, invalid roots or names and existing files at the entrypoint", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "fixture-flag-"));
  try {
    const target = join(root, "fixture.json");
    for (const args of [
      ["--record-fixture", target],
      ["--diagnose", "--record-fixture", target],
      ["--diagnose-tools", "--record-fixture", "relative"],
      ["--diagnose-tools", "--record-fixture-root", root],
      [
        "--diagnose-tools",
        "--record-fixture-root",
        "relative",
        "--record-fixture",
        "fixture.json",
      ],
      [
        "--diagnose-tools",
        "--record-fixture-root",
        join(root, "missing"),
        "--record-fixture",
        "fixture.json",
      ],
      [
        "--diagnose-tools",
        "--record-fixture-root",
        root,
        "--record-fixture",
        "../fixture.json",
      ],
      [
        "--diagnose-tools",
        "--record-fixture-root",
        root,
        "--record-fixture",
        target,
      ],
      [
        "--diagnose-tools",
        "--record-fixture-root",
        root,
        "--record-fixture",
        "nested//fixture.json",
      ],
      [
        "--diagnose-tools",
        "--record-fixture-root",
        root,
        "--record-fixture",
        "fixture.json",
        "--record-fixture",
        "other.json",
      ],
    ]) {
      expect((await run(args)).code).not.toBe(0);
      expect(await readdir(root)).toEqual([]);
    }
    await writeFile(target, "existing");
    expect(
      (
        await run([
          "--diagnose-tools",
          "--record-fixture-root",
          root,
          "--record-fixture",
          "fixture.json",
        ])
      ).code,
    ).not.toBe(0);
    expect(await readFile(target, "utf8")).toBe("existing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Reason: the real diagnose observation must feed only sanitized frames to the exclusive writer.
test.each(["fixture.json", "nested/fixture.json"])(
  "record flag writes the fake tools diagnosis to %s as a private shape fixture",
  async (name) => {
    const root = await mkdtemp(join(await realpath(tmpdir()), "fixture-flag-"));
    try {
      await mkdir(join(root, "nested"));
      const target = join(root, name);
      expect(
        (
          await run([
            "--diagnose-tools",
            "--record-fixture-root",
            root,
            "--record-fixture",
            name,
          ])
        ).code,
      ).toBe(0);
      const text = await readFile(target, "utf8");
      expect(text).not.toContain("private-");
      expect(text).not.toContain("00000000-");
      const fixture = JSON.parse(text);
      expect(fixture.sends).toBe(2);
      expect(
        fixture.frames.map((frame: { type: string }) => frame.type),
      ).toEqual([
        "assistant",
        "user",
        "user",
        "stream_event",
        "assistant",
        "result",
      ]);
      expect(fixture.frames.at(-1).user_message_uuid).toBe("send_2");
      expect((await stat(target)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

// Reason: capture failures contained by the observer still must refuse the output file.
test("record flag writes nothing on a throwing accessor or exceeded request cap", async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "fixture-flag-"));
  try {
    for (const mode of ["recorder-getter", "cap"]) {
      expect(
        (
          await run(
            [
              "--diagnose-tools",
              "--record-fixture-root",
              root,
              "--record-fixture",
              "fixture.json",
            ],
            mode,
          )
        ).code,
      ).not.toBe(0);
      expect(await readdir(root)).toEqual([]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
