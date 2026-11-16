import { randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { isSharedPrefix } from "../src/install-source.ts";
import { deskManifestSchema } from "../src/review-desk-config.ts";
import { hashDesk } from "../src/review-desk-files.ts";

/**
 * Builds the review desk once, for any repository: the web app built for the base `/`, its server
 * bundled into one self-contained `server/server.js`, and `desk.json` written last:
 *
 *   <out>/client/          the browser's files
 *   <out>/server/server.js the web app's server, with every package inside it
 *   <out>/desk.json        { schemaVersion, base, version, sha256 } (review-desk-config.ts)
 *
 * The compiled CLI serves it in-process (`neuve review desk`), so a desk needs no Bun and no
 * build at run time. `bun run install:cli` builds it into its private build folder and installs it
 * under its install lock; the release build builds it into its own staging folder. Each output
 * belongs to one caller, so nothing here is shared work: `out` must not exist, it is created only
 * by renaming the finished folder into place, and a desk without its `desk.json` is never served.
 */

export type DeskRunner = (
  command: readonly string[],
  cwd: string,
  env: Record<string, string>,
) => Promise<{ readonly code: number }>;

export type BuildDeskInput = Readonly<{
  /** The desk folder to create. It must not exist; its parent is created if needed. */
  out: string;
  /** The Neuve checkout to build from; this script's own by default. */
  source?: string;
  /** The CLI version the desk belongs to; the CLI package's version by default. */
  version?: string;
  /** Runs the web app's build; the install passes its own, which it stops on a signal. */
  run?: DeskRunner;
  /** Where the build's scratch folder goes: the system's temporary folder by default. */
  scratch?: string;
  /**
   * Checked again just before the desk's folder is first written and before it is renamed into
   * place, since the build takes minutes and the output's folders can change meanwhile.
   */
  guard?: (out: string) => void;
}>;

const spawnRunner: DeskRunner = async (command, cwd, env) => {
  const child = Bun.spawn([...command], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  const stop = () => child.kill("SIGTERM");
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    return { code: await child.exited };
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
};

/** The build sees only these variables, so a person's environment can't change the desk. */
const compilerEnvironment = (home: string): Record<string, string> => ({
  PATH: process.env["PATH"] ?? "",
  HOME: home,
  NODE_ENV: "production",
  BROWSERSLIST_ENV: "production",
  TZ: "UTC",
  LANG: "C",
  LC_ALL: "C",
});

const present = (path: string) =>
  lstat(path).then(
    () => true,
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return false;
      throw error;
    },
  );

/** The CLI package's version, which the compiled CLI reports (cli.ts). */
export const cliVersion = async (source: string) =>
  z
    .object({ version: z.string() })
    .parse(await Bun.file(join(source, "apps/neuve-cli/package.json")).json())
    .version;

/**
 * The desk goes to other machines, so it must not name this one's folders. The web build writes
 * each route's absolute source path into TanStack Start's manifest (`filePath`); those become paths
 * relative to the checkout. Any file still holding the checkout, the build folder, the temporary
 * folder or the home folder stops the build.
 */
const withoutMachinePaths = async (
  staging: string,
  source: string,
  work: string,
) => {
  const roots = [...new Set([source, await realpath(source)])];
  const server = join(staging, "server/server.js");
  let text = await readFile(server, "utf8");
  for (const root of roots) text = text.replaceAll(`${root}/`, "");
  await writeFile(server, text);
  const named = [
    ...roots,
    work,
    await realpath(work),
    tmpdir(),
    await realpath(tmpdir()),
    homedir(),
  ]
    .filter((path) => path.length > 1)
    .map((path) => new TextEncoder().encode(path));
  const visit = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const bytes = new Uint8Array(await readFile(path));
        const found = named.find((needle) => indexOf(bytes, needle) !== -1);
        if (found !== undefined)
          throw new Error(
            `The review desk's ${path.slice(staging.length + 1)} names this machine's ${new TextDecoder().decode(found)}; it can't ship.`,
          );
      }
    }
  };
  await visit(staging);
};

/** Where `needle` first appears in `bytes`, or -1. */
const indexOf = (bytes: Uint8Array, needle: Uint8Array) =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).indexOf(
    Buffer.from(needle.buffer, needle.byteOffset, needle.byteLength),
  );

export const buildDesk = async (input: BuildDeskInput) => {
  const out = resolve(input.out);
  const source = resolve(input.source ?? join(import.meta.dir, "../../.."));
  const web = join(source, "apps/neuve-web/apps/web");
  const version = input.version ?? (await cliVersion(source));
  const run = input.run ?? spawnRunner;
  if (await present(out))
    throw new Error(
      `${out} already exists. Remove it, or build the review desk into a new folder.`,
    );
  await mkdir(dirname(out), { recursive: true });
  const work = await mkdtemp(
    join(input.scratch ?? tmpdir(), "neuve-desk-build-"),
  );
  // Assembled beside the output, so the last step is one rename on the same disk.
  const staging = `${out}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const home = join(work, "home");
    await mkdir(home);
    // The web build's output imports the web app's packages; the bundle step finds them here.
    await symlink(join(web, "node_modules"), join(work, "node_modules"), "dir");
    const config = join(work, "vite.config.ts");
    await writeFile(
      config,
      `import config from ${JSON.stringify(join(web, "vite.config.ts"))};\nexport default {...config, base: "/", envDir: false, cacheDir: ${JSON.stringify(join(work, "cache"))}, build: {...config.build, outDir: ${JSON.stringify(join(work, "dist"))}, emptyOutDir: true}};\n`,
    );
    const vite = join(
      dirname(Bun.resolveSync("vite/package.json", web)),
      "bin/vite.js",
    );
    const built = await run(
      [
        process.execPath,
        "--no-env-file",
        vite,
        "build",
        "--config",
        config,
        "--configLoader",
        "native",
      ],
      web,
      compilerEnvironment(home),
    );
    if (built.code !== 0)
      throw new Error(`The review desk's web build exited ${built.code}.`);
    // The server build leaves Neuve's packages as imports of the checkout; bundle them in.
    const entry = join(work, "server-entry.ts");
    await writeFile(
      entry,
      `export { default } from ${JSON.stringify(join(work, "dist/server/server.js"))};\n`,
    );
    input.guard?.(out);
    await mkdir(join(staging, "server"), { recursive: true });
    const bundle = await Bun.build({
      entrypoints: [entry],
      target: "bun",
      format: "esm",
      conditions: ["production"],
      // No module-path comments: unminified, Bun names each module's file (the build folder).
      minify: { whitespace: true },
      outdir: join(staging, "server"),
      naming: "server.js",
      define: {
        "process.env.NODE_ENV": '"production"',
        "process.env.WS_NO_BUFFER_UTIL": '"1"',
        "process.env.WS_NO_UTF_8_VALIDATE": '"1"',
      },
      plugins: [
        {
          name: "desk-ws",
          setup(build) {
            // Bun takes `ws` for its own built-in before any resolve hook runs, so Effect's socket
            // adapter imports the pinned package by path and the bundle carries it.
            build.onLoad({ filter: /[/\\]NodeSocket\.js$/ }, async (args) => {
              const manifest = Bun.resolveSync(
                "ws/package.json",
                dirname(args.path),
              );
              const main = z
                .object({ main: z.string() })
                .parse(await Bun.file(manifest).json()).main;
              const contents = (await Bun.file(args.path).text()).replaceAll(
                'from "ws"',
                `from ${JSON.stringify(resolve(dirname(manifest), main))}`,
              );
              return { contents, loader: "js" };
            });
          },
        },
      ],
    });
    if (!bundle.success)
      throw new AggregateError(
        bundle.logs,
        "The review desk's server bundle failed.",
      );
    await cp(join(work, "dist/client"), join(staging, "client"), {
      recursive: true,
    });
    await withoutMachinePaths(staging, source, work);
    const sha256 = await hashDesk(staging);
    await writeFile(
      join(staging, "desk.json"),
      JSON.stringify(
        deskManifestSchema.parse({
          schemaVersion: 1,
          base: "/",
          version,
          sha256,
        }),
        null,
        2,
      ) + "\n",
    );
    input.guard?.(out);
    // A folder that appeared at `out` meanwhile makes this fail rather than be replaced.
    await rename(staging, out).catch(async (error: unknown) => {
      if (await present(out))
        throw new Error(
          `${out} appeared while the review desk was built. Remove it, or build into a new folder.`,
        );
      throw error;
    });
    return { path: out, version, sha256 };
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true });
  }
};

/** No standalone build writes the shared installed copy (12.24): `bun run install:cli` does. */
export const refuseSharedOutput = (out: string) => {
  for (let at = resolve(out); ; at = dirname(at)) {
    if (isSharedPrefix(at))
      throw new Error(
        `Refusing to build the review desk inside the shared copy at ${at}. Run bun run install:cli from a Neuve checkout instead.`,
      );
    if (dirname(at) === at) return;
  }
};

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      args: Bun.argv.slice(2),
      strict: true,
      options: { out: { type: "string" }, version: { type: "string" } },
    });
    if (values.out === undefined)
      throw new Error(
        "Usage: bun apps/neuve-cli/scripts/build-desk.ts --out <folder> [--version <v>]",
      );
    refuseSharedOutput(values.out);
    const desk = await buildDesk({
      out: values.out,
      guard: refuseSharedOutput,
      ...(values.version === undefined ? {} : { version: values.version }),
    });
    await Bun.write(
      Bun.stdout,
      `Built the review desk for neuve ${desk.version} at ${desk.path} (${desk.sha256}).\n`,
    );
  } catch (error) {
    const details =
      error instanceof AggregateError
        ? error.errors.map((entry: unknown) => `\n  ${String(entry)}`).join("")
        : "";
    await Bun.write(
      Bun.stderr,
      `build-desk: ${error instanceof Error ? error.message : String(error)}${details}\n`,
    );
    process.exitCode = 1;
  }
}
