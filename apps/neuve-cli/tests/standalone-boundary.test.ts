import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// The load trap must also reject workspace, proving it observes actual imports.
test("standalone help, Records and review do not load the Ace host", async () => {
  const directory = await mkdtemp(join(tmpdir(), "standalone-boundary-"));
  const preload = join(directory, "forbid-host.ts");
  await writeFile(
    preload,
    `import { plugin } from "bun";
plugin({ name: "forbid-host", setup(build) {
  build.onLoad({ filter: /apps\\/neuve-host\\/src\\// }, () => {
    throw new Error("ACE_HOST_MODULE_LOADED");
  });
} });`,
  );
  try {
    const cli = join(import.meta.dirname, "../src/cli.ts");
    for (const args of [
      ["--help"],
      ["records", "--help"],
      ["review", "--help"],
    ]) {
      const child = Bun.spawn(
        [process.execPath, "--no-env-file", "--preload", preload, cli, ...args],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ args, code, stderr }).toEqual({ args, code: 0, stderr: "" });
      expect(stdout).toContain("Usage:");
    }
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--preload",
        preload,
        cli,
        "workspace",
        "--loopback",
        "--help",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stderr, code] = await Promise.all([
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).not.toBe(0);
    expect(stderr).toContain("ACE_HOST_MODULE_LOADED");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
