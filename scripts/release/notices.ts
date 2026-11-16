import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { DECIDED_SKIPS } from "./fetch-bun-licenses.ts";
import { fullLicences, wholeTextProblem } from "./licence-text.ts";

/**
 * The notices a release archive carries in `share/neuve/notices/`:
 *
 *   THIRD_PARTY_NOTICES.md   the repository's index, headed by the commit and Neuve Graph revision
 *                            this release was built from, and followed by the packages compiled in
 *   <repository path>        every file the index links to, at the same relative path, so its links
 *                            resolve inside the archive
 *   bundled/npm/<name>@<v>/  the license files of each npm package compiled into `neuve`
 *   bundled/go/<module>@<v>/ the license files of each Go module linked into the engine, and Go's own
 *   bundled/bun/             Bun's LICENSE.md and the license texts of what the Bun runtime in
 *                            `neuve` links and embeds, from `licenses/bun@<version>/`
 *
 * Every list comes from the build's own inputs (the CLI bundle's metafile, the engine's module
 * table), never from a hand-kept list, so a new dependency cannot ship without its license.
 */

const LICENSE_FILE = /^(licen[cs]e|copying|notice|patents)([._-].*)?$/i;

/**
 * Upstream license texts for compiled-in packages that ship none, each in `<name>@<version>/` with
 * a `source.json` naming the repository, commit, path and SHA-256 of what was fetched; and
 * `bun@<version>/`, the texts for the Bun runtime (fetch-bun-licenses.ts writes it).
 */
export const STORED_LICENSES = join(import.meta.dir, "licenses");

const sha256Of = async (path: string) =>
  new Bun.CryptoHasher("sha256").update(await readFile(path)).digest("hex");

const storedSource = z
  .object({ sha256: z.string().regex(/^[0-9a-f]{64}$/) })
  .passthrough();
const bunEntrySource = z
  .object({
    project: z.string(),
    files: z
      .array(
        z.object({
          name: z.string(),
          url: z.string(),
          sha256: z.string().regex(/^[0-9a-f]{64}$/),
        }),
      )
      .min(1),
  })
  .passthrough();
const bunManifest = z.object({
  bun: z.string(),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  licenseSha256: z.string().regex(/^[0-9a-f]{64}$/),
  entries: z.array(z.string()).min(1),
  skipped: z.array(
    z.object({
      project: z.string(),
      kind: z.enum([
        "profile-link",
        "public-domain",
        "no-text-upstream",
        "no-code-in-bun",
      ]),
      reason: z.string(),
    }),
  ),
  mpl: z.array(
    z.object({
      crate: z.string(),
      version: z.string(),
      licence: z.literal("MPL-2.0"),
      repository: z.string().regex(/^https:\/\/github\.com\/[^/]+\/[^/]+$/),
      commit: z.string().regex(/^[0-9a-f]{40}$/),
      path: z.string(),
      text: z.string(),
    }),
  ),
});

/**
 * The stored files that are not licences by themselves, by store path, each with why it ships:
 * every other stored file must match a licence template in full.
 */
export const NOT_LICENCES: Record<string, string> = {
  "oven-sh__bun/LICENSE.md":
    "Bun's own index of what it links and embeds, with its LGPL note; the licences it names are stored beside it",
  "webmproject__libwebp/PATENTS":
    "libwebp's additional patent grant, which ships beside its BSD-3-Clause COPYING",
};

/**
 * Stored Bun files with more than one licence span (two licences, or two copies of one), longer
 * text outside their licences, or licence terms no SPDX template matches, each read by hand on
 * 14 November: its whole licences in order (`licenceSpans`), and the SHA-256 of its words outside
 * them (`uncoveredText`), so any change to either stops the build until it is read again. ICU's
 * sections with no SPDX template (its dictionary data, the time zone note, the autoconf files) and
 * README.ijg are checked only by that hash.
 */
export const REVIEWED_TEXTS: Record<
  string,
  { spans: ReadonlyArray<string>; uncovered: string; why: string }
> = {
  "google__boringssl/LICENSE": {
    spans: ["Apache-2.0", "BSD-3-Clause+BSD-3-Clause-named"],
    uncovered:
      "94b180a55020bbb888a11c6851244d0c42cb3a29f585d2c029e6ce01dc2d4e5e",
    why: "Apache-2.0, then a note on the Go-licensed test-suite code and the Go authors' BSD-3-Clause",
  },
  "google__highway/LICENSE": {
    spans: ["Apache-2.0", "BSD-3-Clause+BSD-3-Clause-named", "CC0-1.0"],
    uncovered:
      "a0e2d7842cd4f29bf0a627e9480ef000af9a1b3469a2b24eb8ddb0f6363f6dec",
    why: "a note on the dual licence and one CC0 file, then Apache-2.0, BSD-3-Clause and CC0-1.0, each under its heading",
  },
  "HdrHistogram__HdrHistogram_c/LICENSE.txt": {
    spans: ["BSD-2-Clause"],
    uncovered:
      "976d40775ec07b58864ccd316a385035fd9fa9962edc21dff199d2757e44f0b4",
    why: "a note that the code is public domain and also offered under BSD-2-Clause, then that licence",
  },
  "jacobsandlund__uucode/LICENSE.md": {
    spans: ["MIT"],
    uncovered:
      "505b5ed0701dfa5b8022d8defd55d9a2a9e990acf2d6dca51df7566fb5de5270",
    why: "MIT, then links to the licences of code it uses, stored beside it",
  },
  "libarchive__libarchive/COPYING": {
    spans: ["BSD-2-Clause-unchanged"],
    uncovered:
      "b2000b7127a7904b4b0f88451d1ed974a1bedec192c2060d6ac385d36413b842",
    why: "a summary of which files carry which licence, then the BSD-2-Clause",
  },
  "libjpeg-turbo__libjpeg-turbo/LICENSE.md": {
    spans: ["BSD-3-Clause+BSD-3-Clause-named"],
    uncovered:
      "e041e2ffb9b21745af60e1840a355f799112884e983e8e8ddc2512472b5235bf",
    why: "an explanation of its two licences and how to comply, then the modified BSD-3-Clause",
  },
  "libjpeg-turbo__libjpeg-turbo/README.ijg": {
    spans: [],
    uncovered:
      "e42b7805f9732005c06942cb5e24b3e3aae1f61bedfee49ac342f481cecaab51",
    why: "IJG's README, whose LEGAL ISSUES section is the IJG licence that LICENSE.md names for the libjpeg API library. It matches SPDX's IJG text but for the closing CompuServe GIF notice, which libjpeg-turbo's copy leaves out, so no template matches and the whole file is checked by its hash",
  },
  "llvm__llvm-project/libcxxabi__LICENSE.TXT": {
    spans: ["Apache-2.0", "LLVM-exception", "NCSA", "MIT"],
    uncovered:
      "f24f1b5c8deb2e35d79c398fcdfb4bcfad441b37ada8c1a9c7422eca611a4ec6",
    why: "Apache-2.0 with the LLVM exceptions, a note on third-party code, then the legacy NCSA and MIT",
  },
  "npm__browserify-zlib/LICENSE": {
    spans: ["MIT", "MIT", "MIT"],
    uncovered:
      "cb4f8b032468d5e3741bfa333387996664bdaee40b9277b8b9bb9656b5156920",
    why: "browserify-zlib's MIT, then Node.js's MIT for the parts it contains, then Joyent's MIT for the parts from Joyent's Node.js repository, each under its note",
  },
  "npm__domain-browser/LICENSE.md": {
    spans: ["Artistic-2.0"],
    uncovered:
      "364ad4a096c2be751bb503dcacc93444824679001bc7e144b260642333577d5f",
    why: "an HTML heading with the copyright line, then Artistic-2.0",
  },
  "npm__querystring-es3/License.md": {
    spans: ["MIT", "MIT"],
    uncovered:
      "fbb015ded3f8b2921b039bccded8abe73d8c34071c2f9d5b1d1c92ba4f23ff51",
    why: "the MIT for its src/index.js, then a pointer to Node.js v6.10.2's licence and the MIT for the rest of the repository",
  },
  "npm__string_decoder/LICENSE": {
    spans: ["MIT", "MIT"],
    uncovered:
      "748799a1892dfbd492f9dda928d26e734cea7739c2a55bf21f0a4d7a4787c3cd",
    why: "Node.js's MIT, then Joyent's MIT for the parts from Joyent's Node.js repository, each under its note",
  },
  "oven-sh__webkit/Source__JavaScriptCore__COPYING.LIB": {
    spans: ["LGPL-2.0-only"],
    uncovered:
      "d1bfee378568b4943131307f943a769abd66395a720dde7a17870a2952f1923e",
    why: "KDE's note, then LGPL-2.0 with a how-to-apply appendix worded for the later LGPL",
  },
  "tinycc__tinycc/COPYING": {
    spans: ["LGPL-2.1-only"],
    uncovered:
      "67c399c58f46222423050b55284cad6916fd61ea68e2bf04320680d4265b9d17",
    why: "LGPL-2.1, whose how-to-apply appendix differs from SPDX's in its wording",
  },
  "unicode-org__icu/LICENSE": {
    spans: [
      "Unicode-3.0",
      "BSD-3-Clause+BSD-3-Clause-named",
      "BSD-3-Clause+BSD-3-Clause-named",
      "BSD-3-Clause+BSD-3-Clause-named",
      "BSD-2-Clause",
      "BSD-3-Clause-named",
      "BSD-3-Clause+BSD-3-Clause-named",
      "MIT",
    ],
    uncovered:
      "fcf51fa7be029ba78027d5e687ac6f153f68cb258d7c1fdf14be59f592f4f0a7",
    why: "Unicode-3.0, then third-party sections: some under SPDX licences, others (ICU's old licence, the dictionary data, the time zone note, autoconf files, sorttable.js's MIT without its condition clause, as upstream has it) with no template",
  },
  "v8__v8/LICENSE": {
    spans: ["BSD-3-Clause+BSD-3-Clause-named"],
    uncovered:
      "ba2c7228bbc7a2f2abb6baf9f7ff95136a684a7ef94190f288f30d8988500769",
    why: "a list of the externally maintained libraries, then V8's BSD-3-Clause",
  },
};

/**
 * The Bun runtime's license texts for the Bun that compiled `neuve`, copied under `notices`, each
 * file checked against the SHA-256 recorded when it was fetched. A Bun without a stored folder, or
 * a missing or changed file, stops the build.
 */
export const collectBun = async (
  input: Readonly<{ bunVersion: string; notices: string; stored?: string }>,
) => {
  const folder = join(
    input.stored ?? STORED_LICENSES,
    `bun@${input.bunVersion}`,
  );
  if (!(await exists(join(folder, "manifest.json"))))
    throw new Error(
      `No license texts for Bun ${input.bunVersion}, whose runtime is compiled into neuve: run bun scripts/release/fetch-bun-licenses.ts for that version.`,
    );
  const manifest = bunManifest.parse(
    JSON.parse(await readFile(join(folder, "manifest.json"), "utf8")),
  );
  if (manifest.bun !== input.bunVersion)
    throw new Error(
      `licenses/bun@${input.bunVersion} describes Bun ${manifest.bun}.`,
    );
  const entries: Array<{
    slug: string;
    project: string;
    files: Array<string>;
  }> = [];
  for (const slug of manifest.entries) {
    const source = bunEntrySource.parse(
      JSON.parse(await readFile(join(folder, slug, "source.json"), "utf8")),
    );
    for (const file of source.files) {
      const path = join(folder, slug, file.name);
      if (!(await exists(path)) || (await sha256Of(path)) !== file.sha256)
        throw new Error(
          `The license text ${slug}/${file.name} for Bun ${input.bunVersion} is missing or changed since it was fetched.`,
        );
      await copyInto(path, join(input.notices, "bundled/bun", slug, file.name));
    }
    // Every file is whole licences from end to end, but the few recorded as not being one.
    for (const file of source.files) {
      const key = `${slug}/${file.name}`;
      if (NOT_LICENCES[key] !== undefined) continue;
      const problem = wholeTextProblem(
        await readFile(join(folder, slug, file.name), "utf8"),
        REVIEWED_TEXTS[key],
      );
      if (problem !== undefined)
        throw new Error(
          `The license text ${key} for Bun ${input.bunVersion} isn't a whole licence: ${problem}.`,
        );
    }
    await copyInto(
      join(folder, slug, "source.json"),
      join(input.notices, "bundled/bun", slug, "source.json"),
    );
    entries.push({
      slug,
      project: source.project,
      files: source.files.map((file) => join("bundled/bun", slug, file.name)),
    });
  }
  if (
    (await sha256Of(join(folder, "oven-sh__bun/LICENSE.md"))) !==
    manifest.licenseSha256
  )
    throw new Error(
      `Bun ${input.bunVersion}'s LICENSE.md differs from the one fetched at its tag.`,
    );
  await copyInto(
    join(folder, "manifest.json"),
    join(input.notices, "bundled/bun/manifest.json"),
  );
  // A skip is one of the decided reasons, word for word, never what a refresh wrote down.
  for (const item of manifest.skipped) {
    const decided = DECIDED_SKIPS[item.project];
    if (decided?.kind !== item.kind || decided.reason !== item.reason)
      throw new Error(
        `licenses/bun@${input.bunVersion} skips ${item.project} for a reason that isn't one of the decided ones: ${item.reason}`,
      );
  }
  // Each MPL-2.0 crate points at a stored folder that holds the MPL-2.0 text.
  for (const item of manifest.mpl) {
    const source = manifest.entries.includes(item.text)
      ? bunEntrySource.parse(
          JSON.parse(
            await readFile(join(folder, item.text, "source.json"), "utf8"),
          ),
        )
      : undefined;
    const texts = await Promise.all(
      (source?.files ?? []).map(async (file) =>
        fullLicences(
          await readFile(join(folder, item.text, file.name), "utf8"),
        ),
      ),
    );
    if (!texts.some((ids) => ids.includes("MPL-2.0")))
      throw new Error(
        `licenses/bun@${input.bunVersion} names ${item.crate} as MPL-2.0, but ${item.text} holds no MPL-2.0 text.`,
      );
  }
  return {
    entries,
    skipped: manifest.skipped,
    mpl: manifest.mpl.map((item) => ({
      ...item,
      files: entries.find((entry) => entry.slug === item.text)?.files ?? [],
    })),
  };
};

const exists = async (path: string) => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

const copyInto = async (source: string, destination: string) => {
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
};

const licenseFiles = async (directory: string) =>
  (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && LICENSE_FILE.test(entry.name))
    .map((entry) => entry.name)
    .sort();

const metafileSchema = z.object({ inputs: z.record(z.string(), z.unknown()) });
const packageSchema = z.object({
  name: z.string(),
  version: z.string(),
  license: z
    .union([z.string(), z.object({ type: z.string() })])
    .optional()
    .transform((value) =>
      value === undefined
        ? undefined
        : typeof value === "string"
          ? value
          : value.type,
    ),
});

export interface BundledEntry {
  readonly name: string;
  readonly version: string;
  readonly license: string | undefined;
  /** The copied license files, relative to the notices folder. */
  readonly files: ReadonlyArray<string>;
}

/** The npm packages and workspace notices a bundle's metafile names, copied under `notices`. */
export const collectNpm = async (
  input: Readonly<{
    root: string;
    metafile: string;
    notices: string;
    /** Upstream license texts for packages that ship none; this folder's `licenses/` by default. */
    stored?: string;
  }>,
) => {
  const stored = input.stored ?? STORED_LICENSES;
  const inputs = Object.keys(
    metafileSchema.parse(JSON.parse(await readFile(input.metafile, "utf8")))
      .inputs,
  );
  const packageDirectories = new Set<string>();
  const workspaceNotices = new Set<string>();
  for (const path of inputs) {
    const absolute = resolve(input.root, path);
    const marker = `node_modules${sep}`;
    const at = absolute.lastIndexOf(marker);
    if (at !== -1) {
      const rest = absolute.slice(at + marker.length).split(sep);
      const name = rest[0]?.startsWith("@")
        ? rest.slice(0, 2).join(sep)
        : rest[0];
      if (name)
        packageDirectories.add(join(absolute.slice(0, at), marker, name));
      continue;
    }
    // A workspace source: the notices of every folder above it, up to the repository root.
    if (!absolute.startsWith(`${input.root}${sep}`)) continue;
    for (
      let folder = dirname(absolute);
      folder.startsWith(`${input.root}${sep}`);
      folder = dirname(folder)
    )
      for (const name of await licenseFiles(folder).catch(() => []))
        workspaceNotices.add(join(folder, name));
  }
  const entries: Array<BundledEntry> = [];
  for (const directory of [...packageDirectories].sort()) {
    const manifest = packageSchema.parse(
      JSON.parse(await readFile(join(directory, "package.json"), "utf8")),
    );
    const files: Array<string> = [];
    for (const name of await licenseFiles(directory)) {
      const target = join(
        "bundled/npm",
        `${manifest.name}@${manifest.version}`,
        name,
      );
      await copyInto(join(directory, name), join(input.notices, target));
      files.push(target);
    }
    if (files.length === 0) {
      // The package ships no license file: the text kept from its upstream repository, or no build.
      const kept = join(stored, `${manifest.name}@${manifest.version}`);
      const names = (await licenseFiles(kept).catch(() => [])).filter(
        (name) => name !== "source.json",
      );
      if (names.length === 0)
        throw new Error(
          `${manifest.name}@${manifest.version} is compiled into neuve but ships no license file, and ${relative(input.root, kept)} holds no upstream text for it. Add the upstream license file at the matching version there, with its source.json.`,
        );
      const recorded = storedSource.parse(
        JSON.parse(await readFile(join(kept, "source.json"), "utf8")),
      );
      for (const name of names) {
        if (
          (name === "LICENSE" &&
            (await sha256Of(join(kept, name))) !== recorded.sha256) ||
          wholeTextProblem(await readFile(join(kept, name), "utf8")) !==
            undefined
        )
          throw new Error(
            `${relative(input.root, kept)}/${name} differs from the upstream text its source.json records, or isn't a whole licence.`,
          );
        const target = join(
          "bundled/npm",
          `${manifest.name}@${manifest.version}`,
          name,
        );
        await copyInto(join(kept, name), join(input.notices, target));
        files.push(target);
      }
      const target = join(
        "bundled/npm",
        `${manifest.name}@${manifest.version}`,
        "source.json",
      );
      await copyInto(join(kept, "source.json"), join(input.notices, target));
    }
    entries.push({
      name: manifest.name,
      version: manifest.version,
      license: manifest.license,
      files,
    });
  }
  const notices: Array<string> = [];
  for (const path of [...workspaceNotices].sort()) {
    const target = relative(input.root, path);
    await copyInto(path, join(input.notices, target));
    notices.push(target);
  }
  return { packages: entries, workspaceNotices: notices };
};

/** Go's module cache spells upper-case letters as `!` and the lower-case letter. */
const escapeModule = (path: string) =>
  path.replace(/[A-Z]/g, (letter) => `!${letter.toLowerCase()}`);

/** The Go modules `go version -m` lists for the engine, and Go's own license, copied under `notices`. */
export const collectGo = async (
  input: Readonly<{
    modules: string;
    moduleCache: string;
    goRoot: string;
    notices: string;
  }>,
) => {
  const lines = input.modules.split("\n").map((line) => line.trim());
  const toolchain = lines[0]?.split(/\s+/).at(-1);
  if (toolchain === undefined || !/^go[0-9]/.test(toolchain))
    throw new Error("go version -m printed no Go version for the engine.");
  const entries: Array<BundledEntry> = [];
  const goFiles: Array<string> = [];
  for (const name of await licenseFiles(input.goRoot)) {
    const target = join("bundled/go", toolchain, name);
    await copyInto(join(input.goRoot, name), join(input.notices, target));
    goFiles.push(target);
  }
  if (goFiles.length === 0)
    throw new Error(`No license file in the Go root ${input.goRoot}.`);
  entries.push({
    name: "Go",
    version: toolchain,
    license: "BSD-3-Clause",
    files: goFiles,
  });
  for (let index = 0; index < lines.length; index += 1) {
    const fields = lines[index]?.split(/\s+/) ?? [];
    if (fields[0] !== "dep") continue;
    // A replaced module is linked from its replacement, on the next line.
    const next = lines[index + 1]?.split(/\s+/) ?? [];
    const [path, version] =
      next[0] === "=>" ? [next[1], next[2]] : [fields[1], fields[2]];
    if (path === undefined || version === undefined)
      throw new Error(`Unreadable module line: ${lines[index]}`);
    const directory = join(
      input.moduleCache,
      `${escapeModule(path)}@${escapeModule(version)}`,
    );
    if (!(await exists(directory)))
      throw new Error(
        `The Go module ${path}@${version} is not in the module cache at ${input.moduleCache}, so its license can't be included.`,
      );
    const files: Array<string> = [];
    for (const name of await licenseFiles(directory)) {
      const target = join("bundled/go", `${path}@${version}`, name);
      await copyInto(join(directory, name), join(input.notices, target));
      files.push(target);
    }
    if (files.length === 0)
      throw new Error(`The Go module ${path}@${version} has no license file.`);
    entries.push({ name: path, version, license: undefined, files });
  }
  return entries;
};

const LINK = /\]\(([^)\s#]+)(#[^)]*)?\)/g;

/** The repository paths a Markdown file links to, excluding web links. */
export const relativeLinks = (markdown: string) =>
  [...markdown.matchAll(LINK)]
    .map((match) => match[1] ?? "")
    .filter((target) => target !== "" && !/^[a-z]+:/i.test(target));

const table = (entries: ReadonlyArray<BundledEntry>) =>
  [
    "| Package | Version | License | License files |",
    "| --- | --- | --- | --- |",
    ...entries.map(
      (entry) =>
        `| ${entry.name} | ${entry.version} | ${entry.license ?? "see the files"} | ${
          entry.files.length === 0
            ? "none in the package"
            : entry.files
                .map((file) => `[${file.split("/").at(-1)}](${file})`)
                .join(", ")
        } |`,
    ),
  ].join("\n");

const skipList = (
  skipped: ReadonlyArray<{ project: string; kind: string; reason: string }>,
  kind: string,
  heading: string,
) => {
  const items = skipped.filter((item) => item.kind === kind);
  return items.length === 0
    ? []
    : [
        "",
        heading,
        "",
        ...items.map((item) => `- ${item.project}: ${item.reason}`),
      ];
};

export const writeNotices = async (
  input: Readonly<{
    root: string;
    notices: string;
    version: string;
    commit: string | null;
    dirty: boolean;
    graphRevision: string | null;
    bunVersion: string;
    metafile: string;
    goModules: string;
    goModuleCache: string;
    goRoot: string;
  }>,
) => {
  await mkdir(input.notices, { recursive: true });
  const index = await readFile(
    join(input.root, "THIRD_PARTY_NOTICES.md"),
    "utf8",
  );
  for (const target of new Set(relativeLinks(index))) {
    const source = resolve(input.root, target);
    if (!(await exists(source)))
      throw new Error(
        `THIRD_PARTY_NOTICES.md links to ${target}, which doesn't exist.`,
      );
    await copyInto(source, join(input.notices, target));
  }
  const npm = await collectNpm({
    root: input.root,
    metafile: input.metafile,
    notices: input.notices,
  });
  const go = await collectGo({
    modules: input.goModules,
    moduleCache: input.goModuleCache,
    goRoot: input.goRoot,
    notices: input.notices,
  });
  const bun = await collectBun({
    bunVersion: input.bunVersion,
    notices: input.notices,
  });
  const body = index.replace(/^# Third-party notices\n+/, "");
  const header = [
    "# Third-party notices",
    "",
    `This copy comes with Neuve ${input.version}. It was built from Neuve commit \`${input.commit ?? "unknown"}\`${input.dirty ? " with local changes" : ""}, which pins Neuve Graph at \`${input.graphRevision ?? "unknown"}\`: that is the submodule pin named below, and the Neuve Graph engine in this release was built from it.`,
    "",
  ].join("\n");
  const compiled = [
    "",
    "## Compiled into this release",
    "",
    "### npm packages in `bin/neuve`",
    "",
    table(npm.packages),
    "",
    "### Notices of Neuve's own folders that carry copied code, compiled into `bin/neuve`",
    "",
    ...npm.workspaceNotices.map((path) => `- [${path}](${path})`),
    "",
    `### The Bun ${input.bunVersion} runtime in \`bin/neuve\``,
    "",
    "[Bun's license](bundled/bun/oven-sh__bun/LICENSE.md) names what it links and embeds. Their license texts, each with the commit or version it came from in its `source.json`:",
    "",
    ...bun.entries.map(
      (entry) =>
        `- ${entry.project}: ${entry.files.map((file) => `[${file.split("/").at(-1)}](${file})`).join(", ")}`,
    ),
    "",
    "This software is based in part on the work of the Independent JPEG Group: Bun's runtime includes libjpeg-turbo, whose libjpeg API library is under the IJG licence ([README.ijg](bundled/bun/libjpeg-turbo__libjpeg-turbo/README.ijg)).",
    ...skipList(
      bun.skipped,
      "no-text-upstream",
      "Named by Bun's license, with no license text anywhere upstream (only a licence name), so there is no text to ship:",
    ),
    ...skipList(
      bun.skipped,
      "public-domain",
      "Public domain, so there is no license text:",
    ),
    ...skipList(
      bun.skipped,
      "no-code-in-bun",
      `Named by Bun's license, with no code of theirs in Bun ${input.bunVersion}'s runtime:`,
    ),
    ...skipList(
      bun.skipped,
      "profile-link",
      "Linked by Bun's license as credit to a person, not a project:",
    ),
    "",
    `#### MPL-2.0 crates compiled into Bun ${input.bunVersion}`,
    "",
    "Bun's HTML rewriter, lol-html, brings in these crates, which Bun's license doesn't list. Each is under the Mozilla Public License 2.0; the source of its files is at the repository and commit named here.",
    "",
    ...bun.mpl.map(
      (item) =>
        `- ${item.crate} ${item.version}: ${item.licence} (${item.files.map((file) => `[${file.split("/").at(-1)}](${file})`).join(", ")}), source at [${item.repository.replace("https://github.com/", "")}${item.path ? `/${item.path}` : ""} \`${item.commit.slice(0, 12)}\`](${item.repository}/tree/${item.commit}${item.path ? `/${item.path}` : ""})`,
    ),
    "",
    "#### What these notices don't cover",
    "",
    `- Rust crates compiled into Bun ${input.bunVersion} that its license doesn't list, other than the MPL-2.0 ones above, aren't named here.`,
    "- The packages Bun's browser polyfills themselves depend on aren't listed separately.",
    "- Bun's license says only that Bun itself is MIT-licensed; Bun publishes no full license text or copyright line for its runtime, so none ships here.",
    "- For projects Bun says it ports or credits but names no version for, the license text is the one on the upstream default branch when it was fetched; its `source.json` records that commit.",
    "- Projects Bun's license names whose code isn't in Bun's runtime are listed above without a license text.",
    "- Parts of a license file that match no standard license text, such as ICU's sections for its dictionary data and build files, are checked against the text read when it was stored, not against a standard text.",
    "",
    "### Go modules in `lib/neuve/entire-graph`",
    "",
    table(go),
    "",
  ].join("\n");
  await writeFile(
    join(input.notices, "THIRD_PARTY_NOTICES.md"),
    `${header}\n${body.trimEnd()}\n${compiled}`,
  );
  return { npm: npm.packages, workspaceNotices: npm.workspaceNotices, go, bun };
};
