import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readInstalledManifest } from "./installed-copy.ts";
import { sha256Of } from "./skill-bundle.ts";

const graphSource = "apps/neuve-graph";

export async function placeWorkspaceGraph(input: {
  lane: string;
  scratch: string;
  installed: string | null;
  env: NodeJS.ProcessEnv;
  build: (command: string[]) => Promise<void>;
}): Promise<string> {
  const { lane, scratch, installed, env, build } = input;
  const source = join(lane, graphSource);
  const folder = join(scratch, "lib", "neuve");
  const destination = join(folder, "entire-graph");
  if (existsSync(join(source, ".git"))) {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    try {
      await build([
        "go",
        "-C",
        source,
        "build",
        "-o",
        destination,
        "./cmd/entire-graph",
      ]);
    } finally {
      if (env.GOMODCACHE && existsSync(env.GOMODCACHE)) {
        // Use the local Go toolchain even if the build failed to download a newer one.
        const cleaned = Bun.spawnSync(["go", "clean", "-modcache"], {
          cwd: scratch,
          env: { ...env, GOTOOLCHAIN: "local" },
        });
        if (!cleaned.success)
          throw new Error(
            `Neuve Graph module cache cleanup failed: ${cleaned.stderr.toString().trim()}`,
          );
      }
    }
    return destination;
  }

  const pin = Bun.spawnSync(["git", "ls-tree", "HEAD", "--", graphSource], {
    cwd: lane,
    env,
  });
  const revision = /^160000 commit ([0-9a-f]+)\t/.exec(
    pin.stdout.toString(),
  )?.[1];
  if (!pin.success || revision === undefined)
    throw new Error("The work lane does not pin a Neuve Graph commit.");

  const cli =
    installed === null
      ? undefined
      : await realpath(installed).catch(() => undefined);
  if (cli !== undefined) {
    const lib = resolve(dirname(cli), "../lib/neuve");
    const manifest = readInstalledManifest(join(lib, "install.json"));
    if (
      typeof manifest !== "string" &&
      manifest.graph.workspaceRevision === revision
    ) {
      const bytes = await readFile(join(lib, "entire-graph")).catch(
        () => undefined,
      );
      if (bytes !== undefined && sha256Of(bytes) === manifest.graph.sha256) {
        await mkdir(folder, { recursive: true, mode: 0o700 });
        await writeFile(destination, bytes, { mode: 0o500 });
        return destination;
      }
    }
  }
  throw new Error(
    `No installed Neuve Graph engine could be verified for ${revision}. Run \`git submodule update --init ${graphSource}\` in the work lane, then try again.`,
  );
}
