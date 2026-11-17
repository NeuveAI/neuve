// Why: the archive is what a friend runs, built natively on this Mac. These cases build it once
// with the real CLI build and check what it must hold (the CLI stamped with the version, the engine,
// the workers, release.json with the commit and Graph revision, the review desk and the neuve skill
// at that same version, and the notices with every license they name and every package compiled in), then install it into a
// scratch home and run neuve with neither Bun nor Go on PATH. Set NEUVE_RELEASE_ARCHIVE to check an
// archive built elsewhere (for example by a release dry run) instead of building one.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { installManifestSchema } from "../../apps/neuve-cli/src/install-manifest.ts";
import { releaseSchema } from "../../apps/neuve-cli/src/release-metadata.ts";
import { readDeskMetadata } from "../../apps/neuve-cli/src/review-desk-config.ts";
import { readSharedSkill } from "../../apps/neuve-cli/src/skill-bundle.ts";
import { buildArchive } from "../../scripts/release/build.ts";
import { writeChecksums } from "../../scripts/release/checksums.ts";
import { relativeLinks } from "../../scripts/release/notices.ts";
import {
  fullLicences,
  licenceRowProblems,
} from "../../scripts/release/licence-text.ts";
import {
  ASSET,
  TARGET,
  install,
  linkHostGit,
  removeAllScratch,
  root,
  run,
  scratch,
  scratchDirectory,
  type Scratch,
} from "./release-fixture.ts";

const engine = join(root, "apps/neuve-graph/entire-graph");
const available =
  !!process.env.NEUVE_RELEASE_ARCHIVE || (await Bun.file(engine).exists());
const VERSION = "0.1.0-test.archive";
const NAME = `neuve-${TARGET}`;

let archive: string;
let sums: string;
let extracted: string;
let members: Array<string>;

const git = (...args: Array<string>) =>
  Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe" })
    .stdout.toString()
    .trim();

afterAll(removeAllScratch, 60_000);

describe.skipIf(!available)("the native release archive", () => {
  beforeAll(async () => {
    const out = await scratchDirectory("neuve-archive-");
    if (process.env.NEUVE_RELEASE_ARCHIVE)
      archive = resolve(process.env.NEUVE_RELEASE_ARCHIVE);
    else
      // The engine is built here as the release builds it (with -trimpath), not taken from the
      // checkout's development build, so the archive checked is the one a release ships.
      archive = (await buildArchive({ version: VERSION, out })).archive;
    const assets = join(out, "assets");
    await mkdir(assets);
    await writeFile(join(assets, ASSET), await readFile(archive));
    await writeChecksums(assets);
    sums = join(assets, "SHA256SUMS");
    archive = join(assets, ASSET);
    extracted = join(out, "extracted");
    await mkdir(extracted);
    expect(
      Bun.spawnSync(["tar", "-xzf", archive, "-C", extracted]).exitCode,
    ).toBe(0);
    members = Bun.spawnSync(["tar", "-tzf", archive], { stdout: "pipe" })
      .stdout.toString()
      .trim()
      .split("\n");
  }, 900_000);

  const inside = (path: string) => join(extracted, NAME, path);

  test("holds the CLI, engine, workers, release record, desk, skill and notices", async () => {
    for (const path of [
      "bin/neuve",
      "lib/neuve/entire-graph",
      "lib/neuve/semantic/worker.py",
      "lib/neuve/semantic/reranker_worker.py",
      "lib/neuve/release.json",
      "lib/neuve/install.json.in",
      "lib/neuve/desk/desk.json",
      "lib/neuve/desk/server/server.js",
      "share/neuve/skills/manifest.json",
      "share/neuve/skills/neuve/SKILL.md",
      "share/neuve/notices/THIRD_PARTY_NOTICES.md",
    ])
      expect(members).toContain(`${NAME}/${path}`);
    expect(members.every((member) => member.startsWith(`${NAME}/`))).toBe(true);
    expect(
      members.some(
        (member) =>
          /(^|\/)\._/.test(member) ||
          // The old parser's files; oxc's licence text in the notices is expected.
          (!member.includes("/share/neuve/notices/") &&
            member.toLowerCase().includes("oxc")),
      ),
    ).toBe(false);
    expect(members).toContain(`${NAME}/share/neuve/notices/LICENSE`);
    expect(members).toContain(
      `${NAME}/share/neuve/notices/apps/neuve-graph/LICENSE`,
    );
    const release = releaseSchema.parse(
      JSON.parse(await readFile(inside("lib/neuve/release.json"), "utf8")),
    );
    expect(release).not.toHaveProperty("terms");
    const version = process.env.NEUVE_RELEASE_ARCHIVE
      ? release.version
      : VERSION;
    expect(release.version).toBe(version);
    if (!process.env.NEUVE_RELEASE_ARCHIVE) {
      expect(release.commit).toBe(git("rev-parse", "HEAD"));
      expect(release.graphRevision).toBe(
        git("ls-tree", "HEAD", "apps/neuve-graph").split(/\s+/)[2] ?? "",
      );
    }
    const reported = await run([inside("bin/neuve"), "--version"], {
      PATH: "/usr/bin:/bin",
    });
    expect(reported.stdout).toBe(`neuve ${version}\n`);
    const manifest = installManifestSchema.parse(
      JSON.parse(await readFile(inside("lib/neuve/install.json.in"), "utf8")),
    );
    expect(manifest.graph.workspaceRevision).toBe(release.graphRevision);
    expect(manifest).not.toHaveProperty("parser");
    // One version: the CLI's, the skill's metadata.version and desk.json's all agree.
    const skill = await readSharedSkill(inside("share/neuve/skills"));
    expect(skill.version).toBe(version);
    const entry = skill.files.find((file) => file.path === "SKILL.md");
    expect(new TextDecoder().decode(entry?.bytes)).toContain(
      `version: "${version}"`,
    );
    expect((await readDeskMetadata(inside("lib/neuve/desk"))).version).toBe(
      version,
    );
    expect(release.files).toContain("lib/neuve/desk");
    expect(manifest.skills?.version).toBe(version);
    expect(manifest.skills?.path).toBe("@NEUVE_PREFIX@/share/neuve/skills");
    // The release's help leaves out the workspace, which isn't part of it.
    const help = await run([inside("bin/neuve"), "--help"], {
      PATH: "/usr/bin:/bin",
    });
    expect(help.stdout).toContain("review desk");
    expect(help.stdout).not.toContain("workspace [--profile");
  });

  // Why: the archive goes to other machines, so no member, binary or text, may name the build
  // machine's folders or account: the checkout, the temporary folder, the home folder, the user.
  test("no member names the build machine's checkout, temporary folder, home or user", async () => {
    const user = userInfo().username;
    // Every compiled CLI carries Bun's runtime, whose own build paths can name a CI account (GitHub's
    // runners build Bun as "runner"). A needle that Bun's executable already holds isn't ours.
    const runtime = await readFile(process.execPath);
    const needles = [
      root,
      await realpath(root),
      tmpdir(),
      await realpath(tmpdir()),
      homedir(),
      `/${user}/`,
    ].filter((needle) => needle.length > 2 && !runtime.includes(needle));
    const found: Array<string> = [];
    const visit = async (folder: string): Promise<void> => {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile()) {
          const bytes = await readFile(path);
          for (const needle of needles)
            if (bytes.includes(needle))
              found.push(`${path.slice(extracted.length + 1)}: ${needle}`);
        }
      }
    };
    await visit(extracted);
    expect(found).toEqual([]);
  });

  test("its notices name the Graph revision it was built from, and every link resolves inside it", async () => {
    const release = releaseSchema.parse(
      JSON.parse(await readFile(inside("lib/neuve/release.json"), "utf8")),
    );
    const notices = inside("share/neuve/notices");
    const text = await readFile(
      join(notices, "THIRD_PARTY_NOTICES.md"),
      "utf8",
    );
    expect(text).toContain(`pins Neuve Graph at \`${release.graphRevision}\``);
    expect(text.toLowerCase()).not.toContain("private preview");
    // No stale pin from an earlier copy of the notices.
    for (const stale of ["3ca479ef", "1fe686f4"])
      expect(text).not.toContain(stale);
    expect(text).toContain(
      "Neuve's own code is under the MIT license in [LICENSE](LICENSE): the repository's root `LICENSE`, which a release archive carries beside this file in `share/neuve/notices/`.",
    );
    const links = relativeLinks(text);
    expect(links.length).toBeGreaterThan(40);
    for (const link of links)
      expect(await Bun.file(join(notices, link)).exists(), link).toBe(true);
    for (const required of [
      "apps/neuve-graph/LICENSE",
      "apps/neuve-graph/internal/sem/grammars/perl/bsearch.h",
      "apps/desktop/licenses/bun.md",
      "packages/harness/src/linguist/NOTICE",
    ])
      expect(links).toContain(required);
    // The packages compiled in, each with its license file.
    for (const pattern of [
      /\| effect \| 4\.0\.0 \| MIT \| \[LICENSE\]\(bundled\/npm\/effect@4\.0\.0\/LICENSE\) \|/,
      /\| zod \| [0-9.]+ \| MIT \|/,
      /\| Go \| go1\.[0-9.]+ \| BSD-3-Clause \|/,
      /\| github\.com\/smacker\/go-tree-sitter \|/,
    ])
      expect(text).toMatch(pattern);
    expect(text).toContain("- [services/NOTICE](services/NOTICE)");
    const bundled = await readdir(join(notices, "bundled/npm"), {
      recursive: true,
    });
    expect(bundled.length).toBeGreaterThan(50);
    // Every compiled-in package carries a license text, its own or the stored upstream one.
    expect(text).not.toContain("none in the package");
    for (const name of [
      "@earendil-works/chord@1.0.0",
      "@earendil-works/pi-ai@1.0.0",
      "@earendil-works/pi-durable@1.0.0",
      "@sigstore/verify@4.1.2",
      "standardwebhooks@1.1.1",
    ]) {
      expect(
        await Bun.file(join(notices, "bundled/npm", name, "LICENSE")).exists(),
        name,
      ).toBe(true);
      expect(
        await Bun.file(
          join(notices, "bundled/npm", name, "source.json"),
        ).exists(),
        name,
      ).toBe(true);
    }
    // Neuve's MIT licence, with its holder, and the exceptions' own texts, as shipped.
    const license = await readFile(join(notices, "LICENSE"), "utf8");
    expect(license).toBe(await readFile(join(root, "LICENSE"), "utf8"));
    expect(license).toContain("Copyright (c) 2026 Neuve AI");
    expect(fullLicences(license)).toEqual(["MIT"]);
    const diffs = join(notices, "apps/neuve-web/packages/diffs");
    expect(
      fullLicences(await readFile(join(diffs, "LICENSE.md"), "utf8")),
    ).toContain("Apache-2.0");
    expect(await readFile(join(diffs, "NOTICE.md"), "utf8")).toContain(
      "are distributed under\nthe same Apache-2.0 license.",
    );
    const bun = join(notices, "bundled/bun");
    expect(
      await readFile(join(bun, "oven-sh__bun/LICENSE.md"), "utf8"),
    ).toContain(
      "Bun statically links JavaScriptCore (and WebKit) which is LGPL-2 licensed.",
    );
    expect(
      fullLicences(
        await readFile(
          join(bun, "oven-sh__webkit/Source__JavaScriptCore__COPYING.LIB"),
          "utf8",
        ),
      ),
    ).toContain("LGPL-2.0-only");
    // Every shipped Bun text is the one fetched upstream, byte for byte.
    const manifest = JSON.parse(
      await readFile(join(bun, "manifest.json"), "utf8"),
    ) as { entries: Array<string> };
    expect(manifest.entries.length).toBeGreaterThan(80);
    for (const slug of manifest.entries) {
      const source = JSON.parse(
        await readFile(join(bun, slug, "source.json"), "utf8"),
      ) as {
        files: Array<{ name: string; sha256: string }>;
      };
      for (const file of source.files)
        expect(
          new Bun.CryptoHasher("sha256")
            .update(await readFile(join(bun, slug, file.name)))
            .digest("hex"),
          `${slug}/${file.name}`,
        ).toBe(file.sha256);
    }
    // No row says a component is under a licence its shipped text isn't (no non-MIT part called MIT).
    const shippedText = async (target: string) =>
      (await Bun.file(join(notices, target)).exists())
        ? readFile(join(notices, target), "utf8")
        : undefined;
    expect(await licenceRowProblems(text, shippedText)).toEqual([]);
  });

  test("installs into a scratch home and runs neuve setup with neither Bun nor Go on PATH", async () => {
    const context: Scratch = await scratch();
    const home = context.home;
    context.env = {
      ...context.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_DATA_HOME: join(home, ".local/share"),
      XDG_STATE_HOME: join(home, ".local/state"),
      XDG_CACHE_HOME: join(home, ".cache"),
      NEUVE_BUDGET_DIRECTORY: join(home, "budget"),
      ENTIRE_GRAPH_SERVICE: "off",
    };
    // Linux runners keep go in /usr/bin. A PATH of links to /usr/bin and /bin without bun or go
    // keeps "neither Bun nor Go" true on every host. Git is the host's first one, which may not be
    // /usr/bin's (linkHostGit says why).
    const tools = await linkHostGit(join(context.directory, "tools"));
    for (const folder of ["/usr/bin", "/bin"])
      for (const name of await readdir(folder).catch(() => []))
        if (
          name !== "bun" &&
          name !== "go" &&
          name !== "gofmt" &&
          name !== "git"
        )
          await symlink(join(folder, name), join(tools, name)).catch(() => {});
    context.env = { ...context.env, PATH: tools };
    for (const tool of ["bun", "go"])
      expect(
        (
          await run(
            ["/bin/sh", "-c", `command -v ${tool} || echo none`],
            context.env,
          )
        ).stdout.trim(),
      ).toBe("none");
    const installed = await install(context, {
      directory: "",
      archive,
      sums,
      version: VERSION,
    });
    expect(installed.code, installed.output).toBe(0);
    const repository = join(context.directory, "repository");
    await mkdir(repository);
    for (const argv of [
      ["git", "init", "--quiet"],
      ["git", "config", "user.name", "Release test"],
      ["git", "config", "user.email", "release@example.test"],
    ])
      expect((await run(argv, context.env, { cwd: repository })).code).toBe(0);
    await writeFile(
      join(repository, "example.ts"),
      "export const answer = 42;\n",
    );
    expect(
      (await run(["git", "add", "."], context.env, { cwd: repository })).code,
    ).toBe(0);
    expect(
      (
        await run(["git", "commit", "--quiet", "-m", "fixture"], context.env, {
          cwd: repository,
        })
      ).code,
    ).toBe(0);
    const cli = join(await realpath(context.prefix), "bin/neuve");
    const setup = await run([cli, "setup", "--repo", repository], context.env, {
      cwd: repository,
    });
    // On a failure, show the engine's own record of why, which setup names but doesn't print.
    const observation = await readFile(
      join(repository, ".git/neuve/setup/initial-index.json"),
      "utf8",
    ).catch(() => "");
    expect(setup.code, `${setup.output}\n${observation}`).toBe(0);
    await run([cli, "worker", "stop", "--repo", repository], context.env, {
      cwd: repository,
    });
  }, 300_000);
});
