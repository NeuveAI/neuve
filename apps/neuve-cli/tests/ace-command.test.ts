import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runAceReviewCommand } from "../src/ace-review-command.ts";

test("the Neuve proxy leaves original Ace commands to the original CLI", async () => {
  for (const command of ["new", "tabs", "directory", "key", "backup", "serve"])
    expect(await runAceReviewCommand([command])).toBeUndefined();
});

test("the complete Ace CLI help and Neuve review flags remain reachable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ace-command-"));
  const cli = join(import.meta.dirname, "../src/ace-cli.ts");
  const run = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, "--no-env-file", cli, ...args], {
      env: {
        ...process.env,
        ACE_HOME: join(directory, "home"),
        ACE_CONFIG_HOME: join(directory, "settings"),
        ACE_KEYCHAIN_SERVICE: `neuve-cli-fixture-${process.pid}`,
        ACE_USER: "fixture",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    return stdout;
  };
  try {
    const help = await run(["--help"]);
    for (const command of [
      "ace backup",
      "ace restore",
      "ace export",
      "ace import",
      "ace directory",
      "ace desktop",
      "ace tab rename",
      "ace project share",
      "ace logs",
      "ace review",
    ])
      expect(help).toContain(command);
    const review = await run(["review", "--help", "--repo", directory]);
    expect(review).toContain("neuve review");
    expect(review).not.toContain("Unknown option");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
