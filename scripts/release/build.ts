import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  PROJECTOR_VERSION,
  SCHEMA_VERSION,
  WRITER_VERSION,
} from "../../packages/records-core/src/index.ts";
import { buildDesk } from "../../apps/neuve-cli/scripts/build-desk.ts";
import { installLayout } from "../../apps/neuve-cli/scripts/install-local.ts";
import { installManifestSchema } from "../../apps/neuve-cli/src/install-manifest.ts";
import {
  RELEASE_TARGETS,
  releaseSchema,
  releaseVersionSchema,
  type Release,
} from "../../apps/neuve-cli/src/release-metadata.ts";
import { readDeskMetadata } from "../../apps/neuve-cli/src/review-desk-config.ts";
import {
  readSharedSkill,
  readSkillTemplate,
  writeSkillShare,
} from "../../apps/neuve-cli/src/skill-bundle.ts";
import { writeNotices } from "./notices.ts";

/**
 * Builds the release archive `neuve-<target>.tar.gz` into `--out`, where the target is
 * darwin-arm64, linux-x64 or linux-arm64 and must be this host's. For darwin-arm64:
 *
 *   neuve-darwin-arm64/bin/neuve                      the compiled CLI, stamped with the version
 *   neuve-darwin-arm64/lib/neuve/entire-graph         the Neuve Graph engine, built from the pin
 *   neuve-darwin-arm64/lib/neuve/semantic/            the semantic client's Python workers
 *   neuve-darwin-arm64/lib/neuve/desk/                the review desk `neuve review desk` serves
 *   neuve-darwin-arm64/lib/neuve/release.json         version, commit and Graph revision
 *   neuve-darwin-arm64/lib/neuve/install.json.in      the install manifest, with the prefix left blank
 *   neuve-darwin-arm64/share/neuve/notices/           Neuve's MIT LICENSE, third-party notices and license texts
 *   neuve-darwin-arm64/share/neuve/skills/            the `neuve` agent skill the installer offers
 *
 * The CLI, the skill's `metadata.version` and the desk's `desk.json` all carry the one release
 * version. It refuses a target other than this host's, and rechecks those three versions in the
 * extracted archive.
 */

const root = resolve(import.meta.dir, "../..");

/** The Mac target `bun run release` builds on this Mac; Linux archives come from CI runners. */
export const RELEASE_TARGET = "darwin-arm64";
export const archiveName = (target = RELEASE_TARGET) =>
  `neuve-${target}.tar.gz`;

const run = async (
  command: ReadonlyArray<string>,
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) => {
  const child = Bun.spawn([...command], {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    stdout: "pipe",
    stderr: "inherit",
  });
  const stop = () => child.kill("SIGTERM");
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    const [stdout, code] = await Promise.all([
      new Response(child.stdout).text(),
      child.exited,
    ]);
    if (code !== 0) throw new Error(`${command[0]} exited with ${code}.`);
    return stdout.trim();
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
};

const hash = async (path: string) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");

/**
 * The review desk, built once into `<stage>/lib/neuve/desk` (build-desk.ts) for this release's
 * version. Returns `["lib/neuve/desk"]`, which release.json lists and the installer replaces as a
 * folder.
 */
export const addReviewDesk = async (
  stage: string,
  version: string,
  scratch: string,
): Promise<ReadonlyArray<string>> => {
  await buildDesk({
    out: join(stage, "lib/neuve/desk"),
    source: root,
    version,
    scratch,
  });
  return ["lib/neuve/desk"];
};

/** The `neuve` skill's template, whose SKILL.md the release fills with its version. */
export const SKILL_TEMPLATE = join(root, "apps/neuve-cli/skills/neuve");

export const buildArchive = async (
  input: Readonly<{
    version: string;
    out: string;
    target?: string;
    /** A built engine to ship instead of building one from `apps/neuve-graph`. */
    graph?: string;
    repository?: string;
  }>,
) => {
  const target = input.target ?? RELEASE_TARGET;
  if (!(RELEASE_TARGETS as ReadonlyArray<string>).includes(target))
    throw new Error(
      `Releases are built for ${RELEASE_TARGETS.join(", ")}, not ${target}.`,
    );
  if (target !== `${process.platform}-${process.arch}`)
    throw new Error(
      `Target ${target} needs a native host; this host is ${process.platform}-${process.arch}.`,
    );
  const version = releaseVersionSchema.parse(input.version);
  const repository = input.repository ?? "NeuveAI/neuve";
  const output = resolve(input.out);
  await mkdir(output, { recursive: true });
  const temporary = await mkdtemp(join(tmpdir(), "neuve-release-"));
  try {
    const name = `neuve-${target}`;
    const stage = join(temporary, name);
    const layout = installLayout(stage);
    await mkdir(dirname(layout.graph), { recursive: true });
    await mkdir(dirname(layout.cli), { recursive: true });
    const graphSource = join(root, "apps/neuve-graph");
    const graph =
      input.graph === undefined
        ? join(temporary, "entire-graph")
        : resolve(input.graph);
    if (input.graph === undefined)
      await run(
        // -trimpath: no path of this machine (its module cache, its checkout) in the engine.
        [
          "go",
          "-C",
          graphSource,
          "build",
          "-trimpath",
          "-o",
          graph,
          "./cmd/entire-graph",
        ],
        {
          env: { ...process.env, CGO_ENABLED: "1" },
        },
      );
    const graphVersion = await run([graph, "version"]);
    await copyFile(graph, layout.graph);
    await chmod(layout.graph, 0o755);
    const metafile = join(temporary, "cli-metafile.json");
    await run([
      process.execPath,
      join(root, "apps/neuve-cli/scripts/build.ts"),
      "--outfile",
      layout.cli,
      "--version",
      version,
      "--metafile",
      metafile,
    ]);
    await mkdir(dirname(layout.semantic.encoder), { recursive: true });
    await copyFile(
      join(root, "packages/semantic-client/src/worker.py"),
      layout.semantic.encoder,
    );
    await copyFile(
      join(root, "packages/semantic-client/src/reranker_worker.py"),
      layout.semantic.reranker,
    );
    const desk = await addReviewDesk(stage, version, temporary);

    const git = (args: ReadonlyArray<string>) =>
      run(["git", "--no-optional-locks", ...args]).catch(() => null);
    const commit = await git(["rev-parse", "HEAD"]);
    const dirty =
      (await git(["status", "--porcelain", "--untracked-files=normal"])) !== "";
    const graphRevision =
      (await git(["ls-tree", "HEAD", "apps/neuve-graph"]))?.match(
        /^160000 commit ([0-9a-f]{40,64})\s/,
      )?.[1] ?? null;

    const share = join(stage, "share/neuve");
    const goEnv = (
      await run(["go", "-C", graphSource, "env", "GOMODCACHE", "GOROOT"])
    ).split("\n");
    const notices = await writeNotices({
      root,
      notices: join(share, "notices"),
      version,
      commit,
      dirty,
      graphRevision,
      bunVersion: Bun.version,
      metafile,
      goModules: await run(["go", "version", "-m", graph]),
      goModuleCache: goEnv[0] ?? "",
      goRoot: goEnv[1] ?? "",
    });
    const skills = await readSkillTemplate(SKILL_TEMPLATE, version);
    const skillFiles = await writeSkillShare({
      bundle: skills,
      shareDirectory: join(share, "skills"),
    });

    const release: Release = releaseSchema.parse({
      schemaVersion: 1,
      version,
      target,
      repository,
      cliSha256: await hash(layout.cli),
      commit,
      dirty,
      graphRevision,
      files: [
        "bin/neuve",
        "lib/neuve",
        "share/neuve/notices",
        "share/neuve/skills",
        ...desk,
      ],
    });
    await writeFile(
      join(dirname(layout.graph), "release.json"),
      `${JSON.stringify(release, null, 2)}\n`,
    );
    const path = (file: string) => `@NEUVE_PREFIX@/${relative(stage, file)}`;
    const manifest = installManifestSchema.parse({
      schemaVersion: 1,
      installedAt: "@NEUVE_INSTALLED_AT@",
      cli: { path: path(layout.cli), sha256: await hash(layout.cli) },
      graph: {
        path: path(layout.graph),
        sha256: await hash(layout.graph),
        version: graphVersion,
        workspaceRevision: graphRevision,
      },
      records: {
        schemaVersion: SCHEMA_VERSION,
        writerVersion: WRITER_VERSION,
        projectorVersion: PROJECTOR_VERSION,
      },
      source: { commit, dirty },
      skills: {
        path: path(join(share, "skills")),
        version: skills.version,
        files: [...skillFiles],
      },
      semantic: {
        encoder: {
          path: path(layout.semantic.encoder),
          sha256: await hash(layout.semantic.encoder),
        },
        reranker: {
          path: path(layout.semantic.reranker),
          sha256: await hash(layout.semantic.reranker),
        },
      },
    });
    await writeFile(
      `${layout.manifest}.in`,
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    const archive = join(output, archiveName(target));
    // No extended attributes or AppleDouble files: the archive carries only its files' bytes and modes.
    await run(["tar", "--no-xattrs", "-czf", archive, "-C", temporary, name], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    const verify = join(temporary, "verify");
    await mkdir(verify);
    await run(["tar", "-xzf", archive, "-C", verify]);
    const extracted = installLayout(join(verify, name));
    // One version: the CLI, the skill and the desk in the archive all say this release's.
    if ((await run([extracted.cli, "--version"])) !== `neuve ${version}`)
      throw new Error(
        "The extracted CLI's version does not match the release.",
      );
    const shipped = join(verify, name);
    if (
      (await readSharedSkill(join(shipped, "share/neuve/skills"))).version !==
      version
    )
      throw new Error(
        "The extracted skill's version does not match the release.",
      );
    if (
      (await readDeskMetadata(join(shipped, "lib/neuve/desk"))).version !==
      version
    )
      throw new Error(
        "The extracted review desk's version does not match the release.",
      );
    await run([extracted.graph, "version"]);
    return { archive, release, notices };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      target: { type: "string" },
      version: { type: "string" },
      out: { type: "string" },
      graph: { type: "string" },
      repository: { type: "string" },
    },
  });
  if (values.out === undefined || values.version === undefined)
    throw new Error(
      "Usage: bun scripts/release/build.ts --version <x.y.z> --out <folder> [--graph <engine>]",
    );
  const { archive } = await buildArchive({
    version: values.version,
    out: values.out,
    ...(values.target === undefined ? {} : { target: values.target }),
    ...(values.graph === undefined ? {} : { graph: values.graph }),
    ...(values.repository === undefined
      ? {}
      : { repository: values.repository }),
  });
  await Bun.write(Bun.stdout, `${archive}\n`);
}
