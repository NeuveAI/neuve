import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { checkContext, isSharedPrefix } from "../src/install-source.ts";
import { installLocalCli } from "./install-local.ts";

/**
 * The Linux install for cloud machines (10.129): what `bun run install:cli` installs, into a prefix
 * an image chooses, from a workspace on the machine that builds the image. It builds an image's
 * copy, never a machine's shared copy: `--prefix` has no default, the shared prefix under any
 * spelling is refused (`isSharedPrefix`), and so is check mode (12.24). An image installs a
 * candidate build from any commit, so it asks for no integration branch or check receipt.
 *
 *   <prefix>/bin/neuve                   the CLI, compiled for this machine's Linux
 *   <prefix>/lib/neuve/entire-graph      the Graph engine, built beforehand (it needs cgo)
 *   <prefix>/lib/neuve/install.json      what was installed, by SHA-256, with the Records versions
 *                                        and the commits the CLI and Graph were built from
 *
 * The semantic workers are left out: the replays run with `--leads bm25`. A build with no Git
 * metadata (an image's build context) is told its commits with `--commit` and `--graph-revision`.
 */

const USAGE = `Usage: bun ./apps/neuve-cli/scripts/install-linux.ts --prefix <dir> [--graph <path>]
         [--commit <sha> --dirty true|false] [--graph-revision <sha>]`;

const output = async (command: readonly string[], cwd: string) => {
  const child = Bun.spawn([...command], {
    cwd,
    stdout: "pipe",
    stderr: "inherit",
  });
  const [stdout, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  if (exitCode !== 0)
    throw new Error(`${command.join(" ")} exited with ${exitCode}.`);
  return stdout.trim();
};

const main = async () => {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      prefix: { type: "string" },
      graph: { type: "string" },
      commit: { type: "string" },
      dirty: { type: "string" },
      "graph-revision": { type: "string" },
    },
  });
  if (
    values.prefix === undefined ||
    (values.dirty !== undefined &&
      values.dirty !== "true" &&
      values.dirty !== "false") ||
    (values.dirty !== undefined) !== (values.commit !== undefined)
  )
    throw new Error(USAGE);
  if (isSharedPrefix(values.prefix))
    throw new Error(
      `Refusing to install into ${resolve(values.prefix)}: it is this machine's shared copy, which only \`bun run install:cli\` writes. An image's copy goes under its own prefix, such as /opt/neuve.`,
    );
  const context = checkContext();
  if (context !== undefined)
    throw new Error(
      `Refusing to install in check mode (${context}): checks and tests never install.`,
    );
  if (process.platform !== "linux")
    throw new Error(
      `This installs the Linux build; on ${process.platform} use bun run install:cli.`,
    );
  for (const [option, value] of [
    ["--commit", values.commit],
    ["--graph-revision", values["graph-revision"]],
  ] as const)
    if (value !== undefined && !/^[0-9a-f]{40}$/.test(value))
      throw new Error(`${option} must name a full commit, not "${value}".`);
  const workspaceRoot = resolve(import.meta.dir, "../../..");
  const graph = resolve(
    values.graph ?? join(workspaceRoot, "apps/neuve-graph/entire-graph"),
  );
  const graphVersion = await output([graph, "version"], workspaceRoot).catch(
    () => {
      throw new Error(
        `Build Neuve Graph first with bun run build:graph (expected ${graph}).`,
      );
    },
  );
  const git = (args: readonly string[]) =>
    output(
      ["git", "--no-optional-locks", "-C", workspaceRoot, ...args],
      workspaceRoot,
    ).catch(() => null);
  const commit = values.commit ?? (await git(["rev-parse", "HEAD"]));
  const dirty =
    values.dirty !== undefined
      ? values.dirty === "true"
      : commit === null ||
        (await git(["status", "--porcelain", "--untracked-files=normal"])) !==
          "";
  const graphWorkspaceRevision =
    values["graph-revision"] ??
    (await git(["-C", "apps/neuve-graph", "rev-parse", "HEAD"]));
  const buildDirectory = await mkdtemp(join(tmpdir(), "neuve-cli-linux-"));
  try {
    const cli = join(buildDirectory, "neuve");
    await output(
      ["bun", resolve(import.meta.dir, "build.ts"), "--outfile", cli],
      workspaceRoot,
    );
    const manifest = await installLocalCli({
      cli,
      graph,
      prefix: values.prefix,
      graphVersion,
      graphWorkspaceRevision,
      source: { commit, dirty },
      // Never the shared copy: refused again just before the first copy, should a folder of the
      // prefix have been linked into it during the build.
      expectShared: false,
    });
    await Bun.write(
      Bun.stdout,
      `Installed the Neuve CLI at ${manifest.cli.path} from ${commit ?? "an unknown commit"}${dirty ? " (with local changes)" : ""}, Neuve Graph ${graphWorkspaceRevision ?? graphVersion} at ${manifest.graph.path}; the manifest is ${join(resolve(values.prefix), "lib/neuve/install.json")}.\n`,
    );
  } finally {
    await rm(buildDirectory, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await Bun.write(Bun.stderr, `neuve linux install: ${message}\n`);
    process.exitCode = 1;
  }
}
