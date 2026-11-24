// Why: a release finds its Graph engine beside the CLI through one rule, which the CLI (setup and
// queries) and the harness (Graph and hybrid search) both call. Each layout and failure gets its answer.
import { afterAll, expect, test } from "bun:test";
import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { releaseSchema as buildReleaseSchema } from "../../apps/neuve-cli/src/release-metadata.ts";
import { releaseSchema } from "../../apps/neuve-cli/src/upgrade-cli.ts";
import { discoverGraphBinary } from "../../apps/neuve-cli/src/graph-query.ts";
import { discoverSearchGraphBinary } from "../../packages/harness/src/search-config.ts";

const root = await mkdtemp(join(tmpdir(), "graph-discovery-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const source = join(import.meta.dir, "../../apps/neuve-graph/entire-graph");
const sourceExecutable = await Promise.all([
  stat(source),
  access(source, constants.X_OK),
]).then(
  ([file]) => file.isFile(),
  () => false,
);
for (const scenario of [
  "environment",
  "installed",
  "workspace",
  "missing",
  "bad-environment",
  "not-executable",
])
  test(`CLI and harness Graph discovery: ${scenario}`, async () => {
    const directory = join(root, scenario);
    const executable = join(directory, "apps/neuve-cli/dist/neuve");
    const installed = join(dirname(executable), "../lib/neuve/entire-graph");
    const sibling = join(directory, "apps/neuve-graph/entire-graph");
    const override = scenario.includes("environment")
      ? join(directory, "override")
      : undefined;
    const files = [executable];
    if (
      scenario === "installed" ||
      scenario === "environment" ||
      scenario === "bad-environment"
    )
      files.push(installed);
    if (
      scenario === "installed" ||
      scenario === "workspace" ||
      scenario === "environment"
    )
      files.push(sibling);
    if (scenario === "environment" && override) files.push(override);
    if (scenario === "not-executable") files.push(installed);
    for (const path of files) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }
    if (scenario === "not-executable") await chmod(installed, 0o644);
    const link = join(directory, "neuve-link");
    await symlink(executable, link);
    const input = { executable: link, override };
    const cli = await discoverGraphBinary(input).then(
      (path) => ({ path }),
      (error) => ({ error: String(error) }),
    );
    let harness;
    try {
      harness = { path: discoverSearchGraphBinary(input) };
    } catch (error) {
      harness = { error: String(error) };
    }
    expect(harness).toEqual(cli);
    if (scenario === "environment" && override !== undefined)
      expect(cli).toEqual({ path: override });
    else if (scenario === "installed") expect(cli).toEqual({ path: installed });
    else if (scenario === "workspace") expect(cli).toEqual({ path: sibling });
    else if (
      (scenario === "missing" || scenario === "not-executable") &&
      sourceExecutable
    )
      expect(cli).toEqual({ path: source });
    else expect(cli).toHaveProperty("error");
  });

// Build and upgrade share this target validator, so rejecting Intel Macs here covers both entry points.
test("release build and upgrade accept only the three release targets", () => {
  expect(releaseSchema.shape.target.options).toEqual([
    "darwin-arm64",
    "linux-x64",
    "linux-arm64",
  ]);
  expect(releaseSchema.shape.target.safeParse("darwin-x64").success).toBe(
    false,
  );
  for (const target of ["darwin-arm64", "linux-x64", "linux-arm64"])
    expect(releaseSchema.shape.target.safeParse(target).success).toBe(true);
  expect(buildReleaseSchema.shape.target.options).toEqual(
    releaseSchema.shape.target.options,
  );
});
