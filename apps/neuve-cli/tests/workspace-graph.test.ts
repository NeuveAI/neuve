import { expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { discoverSearchGraphBinary } from "@neuve/harness/search-config";
import type { InstallManifest } from "../src/install-manifest.ts";
import { sha256Of } from "../src/skill-bundle.ts";
import { placeWorkspaceGraph } from "../src/workspace-graph.ts";

const pin = "1".repeat(40);
const engine = Buffer.from("#!/bin/sh\necho graph-fixture\n");

test.each([0, 1])(
  "lane scratch is removable after a Graph build exits %i",
  async (exitCode) => {
    const root = await mkdtemp(join(tmpdir(), "workspace-graph-build-"));
    const lane = join(root, "lane");
    const source = join(lane, "apps/neuve-graph");
    const scratch = join(root, "scratch");
    const cache = join(scratch, "cache", "go-mod");
    const toolchain = join(cache, "golang.org/toolchain@v0.0.1-go1.27.0/bin");
    try {
      await mkdir(source, { recursive: true });
      await writeFile(join(source, ".git"), "gitdir: fixture\n");
      await writeFile(
        join(root, "go"),
        String.raw`#!/bin/sh
set -eu
case "$1" in
  -C)
    mkdir -p "$FIXTURE_TOOLCHAIN"
    touch "$FIXTURE_TOOLCHAIN/go"
    chmod 555 "$FIXTURE_TOOLCHAIN"
    if [ "$FIXTURE_EXIT" -eq 0 ]; then
      printf 'built Graph\n' > "$5"
    fi
    exit "$FIXTURE_EXIT"
    ;;
  clean)
    [ "$2" = -modcache ]
    chmod u+w "$FIXTURE_TOOLCHAIN"
    rm -r "$GOMODCACHE"
    ;;
  *) exit 2 ;;
esac
`,
        { mode: 0o700 },
      );
      const env = {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        GOMODCACHE: cache,
        FIXTURE_EXIT: String(exitCode),
        FIXTURE_TOOLCHAIN: toolchain,
      };

      const placed = placeWorkspaceGraph({
        lane,
        scratch,
        installed: null,
        env,
        build: async (command) => {
          const result = Bun.spawnSync(command, { cwd: lane, env });
          if (!result.success)
            throw new Error(`Graph build failed with code ${result.exitCode}`);
        },
      });
      if (exitCode === 0) {
        const graph = await placed;
        expect(graph).toBe(join(scratch, "lib/neuve/entire-graph"));
        expect(await readFile(graph, "utf8")).toBe("built Graph\n");
      } else {
        await expect(placed).rejects.toThrow("Graph build failed with code 1");
      }

      await rm(scratch, { recursive: true, force: true });
      await expect(lstat(scratch)).rejects.toHaveProperty("code", "ENOENT");
    } finally {
      await chmod(toolchain, 0o700).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  },
);

for (const kind of [
  "matching",
  "different revision",
  "different bytes",
] as const) {
  test(`lane Graph placement with a ${kind} installed engine`, async () => {
    const root = await mkdtemp(join(tmpdir(), "workspace-graph-"));
    try {
      const lane = join(root, "lane");
      const scratch = join(root, "scratch");
      await mkdir(join(lane, "apps/neuve-graph"), { recursive: true });
      const git = (...args: string[]) => {
        const result = Bun.spawnSync(["git", "-C", lane, ...args]);
        if (!result.success) throw new Error(result.stderr.toString());
      };
      git("init", "-q");
      git(
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${pin},apps/neuve-graph`,
      );
      git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        "Pin Graph",
      );
      const installed = join(root, "installed", "bin", "neuve");
      const installedGraph = join(root, "installed", "lib/neuve/entire-graph");
      await mkdir(dirname(installed), { recursive: true });
      await mkdir(dirname(installedGraph), { recursive: true });
      await writeFile(installed, "", { mode: 0o700 });
      await writeFile(
        installedGraph,
        kind === "different bytes" ? "changed" : engine,
        { mode: 0o700 },
      );
      await writeFile(
        join(dirname(installedGraph), "install.json"),
        JSON.stringify({
          schemaVersion: 1,
          installedAt: "",
          cli: { path: installed, sha256: sha256Of(Buffer.alloc(0)) },
          graph: {
            path: installedGraph,
            sha256: sha256Of(engine),
            version: "fixture",
            workspaceRevision:
              kind === "different revision" ? "2".repeat(40) : pin,
          },
        } satisfies InstallManifest),
      );

      const graph = join(scratch, "lib/neuve/entire-graph");
      const placed = placeWorkspaceGraph({
        lane,
        scratch,
        installed,
        env: process.env,
        build: async () => {
          throw new Error("The Graph submodule is empty");
        },
      });
      if (kind !== "matching") {
        await expect(placed).rejects.toThrow(
          "git submodule update --init apps/neuve-graph",
        );
        expect(await Bun.file(graph).exists()).toBe(false);
        return;
      }

      expect(await placed).toBe(graph);
      expect(await readFile(graph)).toEqual(engine);
      expect((await lstat(dirname(graph))).mode & 0o777).toBe(0o700);
      const cli = join(scratch, "bin", "neuve");
      await mkdir(dirname(cli));
      await writeFile(cli, "", { mode: 0o700 });
      expect(
        discoverSearchGraphBinary({ executable: cli, override: undefined }),
      ).toBe(graph);
      expect(
        discoverSearchGraphBinary({
          executable: process.execPath,
          override: graph,
        }),
      ).toBe(graph);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
