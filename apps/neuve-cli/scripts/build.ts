import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { releaseVersionSchema } from "../src/release-metadata.ts";

const run = async (command: readonly string[]): Promise<void> => {
  const child = Bun.spawn([...command], {
    stdout: "inherit",
    stderr: "inherit",
  });
  // A stopped release build stops its compiler too, rather than leaving it writing the output.
  const stop = () => child.kill("SIGTERM");
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    const exitCode = await child.exited;
    if (exitCode !== 0) {
      throw new Error(
        `${command[0] ?? "command"} exited with code ${exitCode}.`,
      );
    }
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
};

// `--outfile <path>` builds somewhere other than ./dist/neuve, so tests and the
// local install never write the build output another process may be running.
// `--version <v>` stamps the version `neuve --version` reports (the release build's), and
// `--metafile <path>` writes the bundle's inputs, from which the release lists the packages it carries.
const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    outfile: { type: "string" },
    version: { type: "string" },
    metafile: { type: "string" },
  },
});
if (
  values.version !== undefined &&
  !releaseVersionSchema.safeParse(values.version).success
)
  throw new Error("--version must be a semantic version without a leading v.");
const packageRoot = resolve(import.meta.dir, "..");
const outfile = resolve(values.outfile ?? resolve(packageRoot, "dist/neuve"));

// The Bun running this script compiles the CLI, so its runtime is the one a release's notices are
// written for (scripts/release/notices.ts reads Bun.version), never another `bun` on PATH.
await run([
  process.execPath,
  "build",
  resolve(packageRoot, "src/cli.ts"),
  resolve(
    packageRoot,
    "../../packages/harness/src/pi/capture/retained-sdk-worker.ts",
  ),
  resolve(packageRoot, "../../packages/harness/src/parent-guard-worker.ts"),
  "--compile",
  "--entry-naming",
  "[name].js",
  // The binary runs as hooks and the worker inside users' repositories, so it
  // must not load their .env files or bunfig.toml (whose preload runs code).
  "--no-compile-autoload-dotenv",
  "--no-compile-autoload-bunfig",
  ...(values.version === undefined
    ? []
    : ["--define", `NEUVE_BUILD_VERSION=${JSON.stringify(values.version)}`]),
  ...(values.metafile === undefined
    ? []
    : [`--metafile=${resolve(values.metafile)}`]),
  "--outfile",
  outfile,
]);

if (process.platform === "darwin") {
  await run(["codesign", "--force", "--sign", "-", outfile]);
}
