// Permissions must add exactly one socket and preserve unrelated settings.
import { expect, test } from "bun:test";
import { allowBudgetSocket } from "../../../scripts/configure-budget-sandbox.ts";
test("budget settings allow only the named socket and are idempotent", () => {
  const input = {
    sandbox: {
      enabled: true,
      network: {
        allowUnixSockets: ["/tmp/existing.sock"],
        allowedDomains: ["example.test"],
      },
    },
    hooks: { fixture: true },
  };
  const socket =
    "/Users/test/Library/Application Support/Neuve/budget/budget.sock";
  const expected = {
    ...input,
    sandbox: {
      ...input.sandbox,
      network: {
        ...input.sandbox.network,
        allowUnixSockets: ["/tmp/existing.sock", socket],
      },
    },
  };
  expect(allowBudgetSocket(input, socket)).toEqual(expected);
  expect(allowBudgetSocket(expected, socket)).toEqual(expected);
  expect(input.sandbox.network.allowUnixSockets).toEqual([
    "/tmp/existing.sock",
  ]);
});

import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("the sandbox script updates a temporary symlink target and leaves the symlink intact", async () => {
  const root = mkdtempSync(join(tmpdir(), "budget-settings-"));
  const target = join(root, "actual.json");
  const file = join(root, "linked.json");
  writeFileSync(target, JSON.stringify({ unrelated: "kept" }));
  symlinkSync("actual.json", file);
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../../../scripts/configure-budget-sandbox.ts"),
        file,
      ],
      {
        env: { ...process.env, NEUVE_BUDGET_DIRECTORY: join(root, "budget") },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stderr = await new Response(child.stderr).text();
    expect(await child.exited, stderr).toBe(0);
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({
      unrelated: "kept",
      sandbox: {
        network: { allowUnixSockets: [join(root, "budget", "budget.sock")] },
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the test launcher gives default-spawned descendants a temporary budget", async () => {
  const root = mkdtempSync(join(tmpdir(), "budget-launcher-"));
  const fixture = join(root, "isolation.test.ts");
  writeFileSync(
    fixture,
    `import { expect, test } from "bun:test";
    test("default child", () => {
      const child = Bun.spawnSync([process.execPath, "-e", 'process.stdout.write(process.env.NEUVE_BUDGET_DIRECTORY ?? "missing")']);
      expect(child.exitCode).toBe(0);
      expect(child.stdout.toString()).toMatch(/neuve-test-budget-/);
    });`,
  );
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../../../scripts/test-budget.ts"),
        fixture,
      ],
      {
        env: { ...process.env },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, stdout + stderr).toBe(0);
    expect(stderr).toContain("1 pass");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
