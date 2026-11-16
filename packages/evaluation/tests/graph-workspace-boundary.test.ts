import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "../../..");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const listWorkspaces = async (cwd: string) => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      join(repository, "scripts/test-workspaces.ts"),
      "--list",
    ],
    {
      cwd,
      env: {
        ...process.env,
        NEUVE_TEST_JOBS: undefined,
        NEUVE_TEST_SHARDS: undefined,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    return stdout;
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    await child.exited;
  }
};

describe("graph workspace boundary", () => {
  test("keeps the graph as a separate workspace dependency", async () => {
    const packageValue: unknown = await Bun.file(
      join(repository, "package.json"),
    ).json();
    if (!isRecord(packageValue) || !isRecord(packageValue.scripts)) {
      throw new Error("package.json scripts must contain an object.");
    }
    expect(packageValue.workspaces).toEqual([
      "apps/*",
      "apps/neuve-web/apps/*",
      "apps/neuve-web/packages/*",
      "packages/*",
      "services/*",
    ]);
    expect(packageValue.scripts.format).not.toMatch(
      /--filter @neuve\/graph(?:\s|$)/,
    );
    expect(packageValue.scripts["format:check"]).not.toMatch(
      /--filter @neuve\/graph(?:\s|$)/,
    );
    expect(packageValue.scripts["typecheck:workspaces"]).toContain(
      "--filter '@neuve/*' --filter '!@neuve/graph'",
    );
    expect(packageValue.scripts["test:workspaces"]).toBe(
      "bun scripts/test-workspaces.ts",
    );

    const gitmodules = await Bun.file(join(repository, ".gitmodules")).text();
    expect(gitmodules).toContain('[submodule "apps/neuve-graph"]');
    expect(gitmodules).toContain("path = apps/neuve-graph");
    expect(gitmodules).toContain(
      "url = https://github.com/NeuveAI/neuve-graph.git",
    );
  });

  test("the test pool excludes Graph from the repository selection", async () => {
    const output = await listWorkspaces(repository);
    expect(output).toMatch(
      /^\[test-workspaces\] Selected [1-9]\d* packages, capacity 6 slots:$/m,
    );
    expect(output).not.toMatch(/^@neuve\/graph \(/m);
  });

  test("the test pool excludes Graph even when it has a test script", async () => {
    const root = mkdtempSync(join(tmpdir(), "graph-workspace-boundary-"));
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ workspaces: ["apps/*", "packages/*"] }),
      );
      for (const [folder, name] of [
        ["apps/neuve-graph", "@neuve/graph"],
        ["packages/review-rules", "@neuve/review-rules"],
      ] satisfies [string, string][]) {
        const cwd = join(root, folder);
        mkdirSync(cwd, { recursive: true });
        writeFileSync(
          join(cwd, "package.json"),
          JSON.stringify({ name, scripts: { test: "bun test" } }),
        );
      }
      expect((await listWorkspaces(root)).trim().split("\n")).toEqual([
        "[test-workspaces] Selected 1 packages, capacity 6 slots:",
        "@neuve/review-rules (1 slots)",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
