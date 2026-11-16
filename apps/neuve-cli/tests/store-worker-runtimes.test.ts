// Why: removing configureProcessRuntimes from --store must leave Claude unregistered and fail this test.
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("the --store worker registers Claude before running work without creating its folder", async () => {
  const root = mkdtempSync(join(tmpdir(), "worker-runtime-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const marker = join(root, "unexpected-child");
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh\ntouch '${marker}'\nexit 99\n`,
    { mode: 0o700 },
  );
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "fixtures/store-worker-runtimes.ts"),
      join(root, "neuve"),
    ],
    {
      env: { ...process.env, HOME: root, TMPDIR: root, PATH: bin },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    const code = await child.exited;
    const output = await stdout;
    expect({ code, stderr: await stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(output.trim().split("\n").at(-1)!)).toEqual({
      ownsLoop: true,
      internalRetries: true,
      folder: false,
    });
    expect(existsSync(marker)).toBe(false);
    expect(
      existsSync(join(root, "Library/Application Support/Neuve/claude-code")),
    ).toBe(false);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await Promise.all([stdout, stderr]);
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
