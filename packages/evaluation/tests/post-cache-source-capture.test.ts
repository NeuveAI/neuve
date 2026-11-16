import { afterEach, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureSourceFiles,
  deriveCapturedWorkspace,
  graphCapturePaths,
} from "../src/post-cache-source-capture.ts";

const owned: string[] = [];
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "post-cache-capture-test-"));
  owned.push(root);
  return root;
};
afterEach(async () => {
  for (const root of owned.splice(0))
    await rm(root, { recursive: true, force: true });
});

test("captures actual allowed bytes and leaves excluded inputs outside the manifest", async () => {
  const root = await fixture();
  const destination = await fixture();
  await mkdir(join(root, "packages/evaluation/src"), { recursive: true });
  await writeFile(
    join(root, "packages/evaluation/src/input.ts"),
    "export const value = 7;\n",
  );
  const manifest = await captureSourceFiles({
    root,
    paths: ["packages/evaluation/src/input.ts"],
    destination,
  });
  expect(manifest.map(({ path, bytes }) => ({ path, bytes }))).toEqual([
    { path: "packages/evaluation/src/input.ts", bytes: 24 },
  ]);
  expect(
    await readFile(
      join(destination, "packages/evaluation/src/input.ts"),
      "utf8",
    ),
  ).toBe("export const value = 7;\n");
  await expect(
    captureSourceFiles({ root, paths: ["apps/neuve-web/sentinel"] }),
  ).rejects.toThrow("Excluded capture path");
  await expect(
    captureSourceFiles({ root, paths: ["design/neuve-web/sentinel"] }),
  ).rejects.toThrow("Excluded capture path");
});

test("rejects directory symlink before a missing sentinel leaf can be accessed", async () => {
  const root = await fixture();
  const excluded = await fixture();
  await mkdir(join(root, "validation"));
  await symlink(excluded, join(root, "validation/fixtures"), "dir");
  await expect(
    captureSourceFiles({
      root,
      paths: ["validation/fixtures/sentinel-must-never-open"],
    }),
  ).rejects.toThrow("Capture refuses symlink");
});

test("rejects leaf symlink and parent traversal while valid capture still succeeds", async () => {
  const root = await fixture();
  const excluded = await fixture();
  await writeFile(join(root, "allowed.ts"), "literal");
  await symlink(join(excluded, "missing"), join(root, "link.ts"));
  await expect(
    captureSourceFiles({ root, paths: ["link.ts"] }),
  ).rejects.toThrow("Capture refuses symlink");
  await expect(
    captureSourceFiles({ root, paths: ["../excluded.ts"] }),
  ).rejects.toThrow("Unsafe capture path");
  expect(
    (await captureSourceFiles({ root, paths: ["allowed.ts"] }))[0]?.bytes,
  ).toBe(7);
});

test("Graph capture inventories native sources and embedded resource without testdata", async () => {
  const root = await fixture();
  for (const path of [
    "cmd/entire-graph",
    "internal/agentsetup",
    "internal/testdata",
  ])
    await mkdir(join(root, path), { recursive: true });
  for (const path of [
    "cmd/entire-graph/main.go",
    "cmd/entire-graph/main_test.go",
    "internal/agentsetup/guide.go",
    "internal/testdata/ignored.go",
  ])
    await writeFile(join(root, path), "package fixture\n");
  expect(await graphCapturePaths(root)).toEqual([
    "cmd/entire-graph/main.go",
    "go.mod",
    "go.sum",
    "internal/agentsetup/brain-reference.md",
    "internal/agentsetup/guide.go",
    "mise.toml",
  ]);
});

test("derived workspace changes only workspaces and preserves original dependency data", () => {
  const source = {
    name: "neuve",
    version: "0.1.0",
    workspaces: ["apps/*", "packages/*"],
    devDependencies: { typescript: "latest" },
  };
  expect(deriveCapturedWorkspace(source)).toEqual({
    ...source,
    workspaces: [
      "apps/neuve-cli",
      "packages/graph-client",
      "packages/evaluation",
      "packages/records-core",
      "packages/records-schema",
      "packages/semantic-client",
    ],
  });
  expect(source.workspaces).toEqual(["apps/*", "packages/*"]);
});
