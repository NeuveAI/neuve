import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Fetches the licence texts of what Bun's runtime carries, for `scripts/release/licenses/bun@<v>/`.
 * The compiled `neuve` is Bun's own binary with the bundle appended, so every library, port and
 * polyfill Bun's LICENSE.md lists ships inside it. This is a maintenance tool, run by hand when the
 * pinned Bun changes (`bun scripts/release/fetch-bun-licenses.ts`); the release build only reads
 * what it stored, and checks each file against the SHA-256 recorded here.
 *
 * Every request is a plain public fetch: no token, nothing about this project in it.
 * - Bun's own LICENSE.md and its vendored licence files: at the `bun-v<version>` tag.
 * - Libraries Bun builds from a pinned commit (`scripts/build/deps/*.ts` at that tag): at that commit.
 * - Ports whose version Bun's source names (sort-package-json, Prettier, react-refresh): that version.
 * - Other GitHub projects Bun names without a version: only those listed in AT_HEAD, a recorded
 *   decision, at the default branch when fetched with its commit recorded; any other unpinned project
 *   fails the refresh.
 * - npm packages and crates: the versions in PINS (Prettier 3.9.9's yarn.lock for the code Bun ports,
 *   else the closest match to Bun's bundled copy), recorded per entry in source.json.
 * - Projects with no text to store are skipped only for a reason in DECIDED_SKIPS.
 * `--only a,b` refreshes the named projects and keeps the rest of the store.
 */

const BUN_VERSION = "1.4.4";
const BUN_COMMIT = "38afee6c84fcf48c0edb2466aa4b27d287a59c30"; // tag bun-v1.4.4
const OUT = join(import.meta.dir, "licenses", `bun@${BUN_VERSION}`);

/** Pinned in Bun's scripts/build/deps at the tag, or a fork it builds from. */
const PINNED: Record<
  string,
  { repo: string; commit: string; paths?: Array<string>; why?: string }
> = {
  // Versions Bun's own source names for code it ports or bundles.
  "keithamus/sort-package-json": {
    repo: "keithamus/sort-package-json",
    commit: "c22cfe87e6b3712d305bec55260a4c52f237a0f8",
    why: "tag v3.7.1, the version Bun's src/format/json/sort_package_json/npm.rs says it ports",
  },
  "prettier/prettier": {
    repo: "prettier/prettier",
    commit: "cdd17f2288b28b170a76416c72dac56e3ea5daff",
    why: "tag 3.9.9, the release Bun's src/format/CLAUDE.md names as the target of its port",
  },
  "facebook/react": {
    repo: "facebook/react",
    commit: "1825990c5608f0ab0c1475b4292218a508a171c9",
    why: "the commit npm records for react-refresh 0.17.0, the version Bun's src/node-fallbacks/package.json pins",
  },
  "google/boringssl": {
    repo: "oven-sh/boringssl",
    commit: "41bf9b59c2ebf277a7aa427e1ecad5cc80dd4d4f",
  },
  "google/brotli": {
    repo: "google/brotli",
    commit: "db24a98aed38a16de78cc05ca15cdd8dc2a0d92d",
  },
  "c-ares/c-ares": {
    repo: "c-ares/c-ares",
    commit: "c7a3138dcfe3bb0eaaf10c0c24c36dc66dc790ab",
  },
  "HdrHistogram/HdrHistogram_c": {
    repo: "HdrHistogram/HdrHistogram_c",
    commit: "18c7a324383dded1451d15621cd018b0048057d0",
  },
  "google/highway": {
    repo: "google/highway",
    commit: "2607d3b5b0113992fe84d3848859eae13b3b52c1",
  },
  "libarchive/libarchive": {
    repo: "libarchive/libarchive",
    commit: "27cbc7827172698143e440801fc0ba39ccb4f1f5",
  },
  "ebiggers/libdeflate": {
    repo: "ebiggers/libdeflate",
    commit: "92e6a0db9fa848d742f9eb286c92afc60f2c3dda",
  },
  "libjpeg-turbo/libjpeg-turbo": {
    repo: "libjpeg-turbo/libjpeg-turbo",
    commit: "c85e6b905bf237038faa936dab160ebfc5da0344",
    // LICENSE.md puts the libjpeg API library under the IJG licence, "listed in README.ijg".
    paths: ["LICENSE.md", "README.ijg"],
  },
  "randy408/libspng": {
    repo: "randy408/libspng",
    commit: "fb768002d4288590083a476af628e51c3f1d47cd",
  },
  "libuv/libuv": {
    repo: "oven-sh/libuv",
    commit: "8023581113b276e7c1aee3f82da57ca0893faab1",
  },
  // Bun pins the tag object b7e29b9d (v1.6.0); raw files need the commit it points at.
  "webmproject/libwebp": {
    repo: "webmproject/libwebp",
    commit: "4fa21912338357f89e4fd51cf2368325b59e9bd9",
    paths: ["COPYING", "PATENTS"],
  },
  "cloudflare/lol-html": {
    repo: "oven-sh/lol-html",
    commit: "725ce499aa9b71e38b7a2d0a9fbb6d7294a4079e",
  },
  "litespeedtech/ls-hpack": {
    repo: "litespeedtech/ls-hpack",
    commit: "cf0f70dd10b352194c97448eb5d00b4aa484f531",
  },
  "litespeedtech/ls-qpack": {
    repo: "litespeedtech/ls-qpack",
    commit: "91567706c41c0d97ab8dc576873ecd472d7869fa",
  },
  "litespeedtech/lsquic": {
    repo: "litespeedtech/lsquic",
    commit: "f812ceb9529e26717df78c6064a2ff648b949f3e",
    paths: ["LICENSE", "LICENSE.chrome"],
  },
  "microsoft/mimalloc": {
    repo: "oven-sh/mimalloc",
    commit: "92ef6587c57b262f6e6abf513f7776a2f8d12aeb",
  },
  "h2o/picohttpparser": {
    repo: "h2o/picohttpparser",
    commit: "f4d94b48b31e0abae029ebeafcfd9ca0680ede58",
  },
  "sru-systems/rust-argon2": {
    repo: "sru-systems/rust-argon2",
    commit: "ed81866f163f0c7026aa6fd8388adf37242eb32a",
  },
  "tinycc/tinycc": {
    repo: "oven-sh/tinycc",
    commit: "05f0fafaa3be31e31d7b4b5c17dc60f62c991171",
  },
  "oven-sh/webkit": {
    repo: "oven-sh/WebKit",
    commit: "d6375c72affe0f70222cdcb45012b10f0bf3a9d5",
    paths: [
      "Source/JavaScriptCore/COPYING.LIB",
      "Source/WebCore/LICENSE-LGPL-2.1",
      "Source/WebCore/LICENSE-APPLE",
    ],
  },
  "zlib-ng/zlib-ng": {
    repo: "zlib-ng/zlib-ng",
    commit: "12731092979c6d07f42da27da673a9f6c7b13586",
  },
  "facebook/zstd": {
    repo: "facebook/zstd",
    commit: "f8745da6ff1ad1e7bab384bd1f9d742439278e99",
    paths: ["LICENSE", "COPYING"],
  },
  "tigerbeetle/tigerbeetle": {
    repo: "tigerbeetle/tigerbeetle",
    commit: "532c8b70b9142c17e07737ab6d3da68d7500cbca",
  },
  "unicode-org/icu": {
    repo: "unicode-org/icu",
    commit: "049e0d6a420629ac7db77256987d083a563287b5",
    paths: ["LICENSE"],
  }, // release-78.1
};
/**
 * The decision for projects Bun's LICENSE.md names without a version, and whose version Bun's
 * source doesn't name either: the licence file at the default branch when fetched, its commit
 * recorded. Any other unpinned project fails the refresh.
 */
const HEAD_DECISION =
  "decided: Bun names no version for it, so its licence file at the default branch when fetched, commit recorded";
export const AT_HEAD = new Set([
  "A11yance/aria-query",
  "JoshuaKGoldberg/ts-api-utils",
  "acornjs/acorn",
  "ajv-validator/ajv",
  "aklomp/base64",
  "angular/angular",
  "babel/babel",
  "biomejs/biome",
  "cvazac/eslint-plugin-react-perf",
  "eslint-community/eslint-plugin-es-x",
  "eslint-community/eslint-plugin-n",
  "eslint-community/eslint-plugin-promise",
  "eslint-community/eslint-utils",
  "eslint-community/regexpp",
  "eslint/eslint",
  "eslint/eslintrc",
  "eslint/js",
  "eslint/rewrite",
  "estools/esquery",
  "evanw/esbuild",
  "fisker/editorconfig-core-js-without-wasm",
  "fisker/git-hooks-list",
  "gkz/levn",
  "gkz/optionator",
  "glimmerjs/glimmer-vm",
  "google/diff-match-patch",
  "graphql/graphql-js",
  "gulpjs/glob-parent",
  "ianvs/prettier-plugin-sort-imports",
  "import-js/eslint-plugin-import",
  "inspect-js/is-core-module",
  "jacobsandlund/uucode",
  "jarred-sumner/uwebsockets",
  "jest-community/eslint-plugin-jest",
  "jestjs/jest",
  "jhchen/fast-diff",
  "jonschlinkert/is-extglob",
  "jsx-eslint/eslint-plugin-jsx-a11y",
  "jsx-eslint/eslint-plugin-react",
  "jsx-eslint/jsx-ast-utils",
  "kaelzhang/node-ignore",
  "litejs/natural-compare-lite",
  "mathiasbynens/emoji-regex",
  "micromark/micromark",
  "micromatch/is-glob",
  "microsoft/TypeScript",
  "microsoft/typescript-go",
  "oxc-project/oxc",
  "oxc-project/tsgolint",
  "postcss/postcss-selector-parser",
  "postcss/postcss",
  "prettier/eslint-plugin-prettier",
  "prettier/prettier-linter-helpers",
  "simdutf/simdutf",
  "sindresorhus/eslint-plugin-unicorn",
  "sindresorhus/get-east-asian-width",
  "sindresorhus/globals",
  "sveltejs/prettier-plugin-svelte",
  "sveltejs/svelte",
  "tailwindlabs/prettier-plugin-tailwindcss",
  "tildeio/simple-html-tokenizer",
  "trivago/prettier-plugin-sort-imports",
  "typescript-eslint/typescript-eslint",
  "uNetworking/uSockets",
  "v8/v8",
  "vercel/next.js",
  "vitest-dev/eslint-plugin-vitest",
]);
/** Ref and paths for upstreams whose licence isn't a root LICENSE file. */
const PATHS: Record<string, { ref?: string; paths: Array<string> }> = {
  "llvm/llvm-project": {
    ref: "refs/tags/llvmorg-19.1.0^{}",
    paths: ["libcxxabi/LICENSE.TXT"],
  },
  "acornjs/acorn": { paths: ["acorn/LICENSE", "acorn-walk/LICENSE"] },
  "estools/esquery": { paths: ["license.txt"] },
  "eslint/js": { paths: ["packages/espree/LICENSE"] },
};
/** Repositories with no licence file whose npm package ships one. */
const VIA_NPM: Record<string, string> = {
  "dryoma/postcss-media-query-parser": "postcss-media-query-parser",
  "handlebars-lang/handlebars-parser": "@handlebars/parser",
};
/**
 * The only projects left without a stored text, each for a decided reason: a credit that links a
 * person's profile, public domain, no licence text anywhere upstream after a search of the package,
 * its recorded commit and its repository, or no code of it in Bun 1.4.4. A refresh fails on any
 * other project it can't fetch.
 */
export const DECIDED_SKIPS: Record<
  string,
  {
    kind:
      "profile-link" | "public-domain" | "no-text-upstream" | "no-code-in-bun";
    reason: string;
  }
> = {
  evanw: {
    kind: "profile-link",
    reason:
      "a person's profile, linked as credit (the project is evanw/esbuild, stored)",
  },
  kipply: {
    kind: "profile-link",
    reason: "a person's profile, linked as credit for the name",
  },
  "SQLite (vendored by Bun)": {
    kind: "public-domain",
    reason: "public domain; there is no licence text",
  },
  "dryoma/postcss-media-query-parser": {
    kind: "no-text-upstream",
    reason:
      "no licence text exists upstream: npm's postcss-media-query-parser 0.2.3 (the version Prettier 3.9.9 locks), its recorded commit and its repository hold no licence file or copyright header; its README and package.json say only MIT",
  },
  "handlebars-lang/handlebars-parser": {
    kind: "no-text-upstream",
    reason:
      "no licence text exists upstream: npm's @handlebars/parser 2.2.2 (the version Prettier 3.9.9 locks) and its repository's default branch hold no licence file or copyright header, and npm records no source commit for that version; its package.json says ISC",
  },
  "npm timers-browserify": {
    kind: "no-code-in-bun",
    reason:
      "Bun 1.4.4's src/node-fallbacks/timers.js is Bun's own module over the global timers, with no code from timers-browserify",
  },
  "npm vm-browserify": {
    kind: "no-code-in-bun",
    reason: "Bun 1.4.4's src/node-fallbacks has no vm module",
  },
  "npm stream-browserify": {
    kind: "no-code-in-bun",
    reason:
      "Bun 1.4.4's src/node-fallbacks/stream.js re-exports readable-stream, not stream-browserify",
  },
};

/**
 * The version of each npm package and crate Bun's LICENSE.md names without one, with how it was
 * found. Bun's node-fallbacks lockfile pins the polyfills it lists; for the rest, a refresh with no
 * entry here fails, naming the package: there is never a fallback to the newest version.
 */
const PRETTIER =
  "Prettier 3.9.9's yarn.lock (prettier/prettier at cdd17f2288b28b170a76416c72dac56e3ea5daff), the release Bun's src/format/CLAUDE.md names as the target of its port";
export const PINS: Record<string, { version: string; why: string }> = {
  "postcss-values-parser": {
    version: "2.0.1",
    why: `${PRETTIER}; Bun's src/format/css/value_parser.rs names 2.0.1`,
  },
  yaml: { version: "2.9.0", why: PRETTIER },
  "postcss-less": { version: "6.0.0", why: PRETTIER },
  "postcss-scss": { version: "4.0.9", why: PRETTIER },
  "yaml-unist-parser": { version: "3.2.0", why: PRETTIER },
  "angular-html-parser": { version: "10.12.0", why: PRETTIER },
  "angular-estree-parser": { version: "15.5.0", why: PRETTIER },
  "narrow-emojis": { version: "0.0.3", why: PRETTIER },
  "postcss-media-query-parser": { version: "0.2.3", why: PRETTIER },
  "@handlebars/parser": { version: "2.2.2", why: PRETTIER },
  "constants-browserify": {
    version: "1.0.0",
    why: "the version whose constants.json Bun's src/node-fallbacks/constants.js is closest to (of 0.0.0, 0.0.1, 1.0.0)",
  },
  "os-browserify": {
    version: "0.3.0",
    why: "the version whose browser.js Bun's src/node-fallbacks/os.js is closest to, of all six",
  },
  "path-browserify": {
    version: "1.0.1",
    why: "Bun's src/node-fallbacks/path.js and path-browserify 1.0.x are both Node.js v8.11.1's path module; 1.0.0 and 1.0.1 have the same index.js",
  },
  url: {
    version: "0.11.0",
    why: "the version whose url.js Bun's src/node-fallbacks/url.js is closest to, of all eleven",
  },
  "tty-browserify": {
    version: "0.0.1",
    why: "the version whose index.js Bun's src/node-fallbacks/tty.js is closest to (of 0.0.0 and 0.0.1)",
  },
  "oxc-toml": {
    version: "0.15.1",
    why: "Bun names no version; the version current on crates.io when bun-v1.4.4 was tagged (22 October 2026)",
  },
  "sort-package-json": {
    version: "1.0.0",
    why: "Bun names no version; the version current on crates.io when bun-v1.4.4 was tagged (22 October 2026)",
  },
};

/** Licence notices kept inside a source file or a README rather than a licence file. */
const EXCERPTS: Record<
  string,
  Array<{ repo?: string; path: string; from: number; to: number }>
> = {
  "h2o/picohttpparser": [{ path: "picohttpparser.h", from: 1, to: 24 }],
  // libarchive's COPYING says files under other terms carry them; Bun builds this one.
  "libarchive/libarchive": [
    {
      path: "libarchive/archive_write_add_filter_compress.c",
      from: 26,
      to: 57,
    },
  ],
};
const NPM_EXCERPTS: Record<string, { path: string; from: number; to: number }> =
  {
    "constants-browserify": { path: "README.md", from: 34, to: 54 },
  };
const VENDORED_IN_BUN = [
  "packages/bun-usockets/LICENSE",
  "packages/bun-uws/LICENSE",
  "src/clap/LICENSE",
];
const CANDIDATES = [
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "LICENSE.TXT",
  "LICENCE",
  "LICENCE.md",
  "license",
  "license.md",
  "LICENSE-MIT",
  "LICENSE-MIT.txt",
  "LICENSE-APACHE",
  "LICENSE-APACHE-2.0",
  "LICENSE-BSD3",
  "COPYING",
  "COPYING.md",
  "COPYING.txt",
  "NOTICE",
  "NOTICE.md",
];

const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
const git = (args: Array<string>) => {
  const result = Bun.spawnSync(["git", ...args], {
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.toString();
};
/** Where raw files come from; a test points it at a local server. */
const RAW =
  process.env.NEUVE_LICENCE_RAW ?? "https://raw.githubusercontent.com";
const raw = async (repo: string, commit: string, path: string) => {
  const url = `${RAW}/${repo}/${commit}/${path}`;
  const response = await fetch(url);
  // Only "not there" is an answer; any other failure stops the refresh.
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}.`);
  return { url, bytes: new Uint8Array(await response.arrayBuffer()) };
};
const fetchOk = async (url: string, init?: RequestInit) => {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}.`);
  return response;
};
/** Lines `from` to `to` (1-based, inclusive) of a text. */
const lines = (bytes: Uint8Array, from: number, to: number) =>
  new TextEncoder().encode(
    `${new TextDecoder()
      .decode(bytes)
      .split("\n")
      .slice(from - 1, to)
      .join("\n")}\n`,
  );

interface Stored {
  readonly project: string;
  readonly source: string;
  readonly pin: string;
  readonly version?: string;
  readonly commit?: string;
  readonly files: Array<{ name: string; url: string; sha256: string }>;
}

const save = async (
  slug: string,
  entry: Omit<Stored, "files">,
  files: Array<{ name: string; url: string; bytes: Uint8Array }>,
) => {
  if (files.length === 0)
    throw new Error(`No licence file found for ${entry.project}`);
  const folder = join(OUT, slug);
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  const stored: Stored = { ...entry, files: [] };
  for (const file of files) {
    const name = file.name.replaceAll("/", "__");
    await writeFile(join(folder, name), file.bytes);
    stored.files.push({ name, url: file.url, sha256: sha256(file.bytes) });
  }
  await writeFile(
    join(folder, "source.json"),
    `${JSON.stringify(stored, null, 2)}\n`,
  );
  return slug;
};

const fromGitHub = async (project: string) => {
  if (!PINNED[project] && !PATHS[project]?.ref && !AT_HEAD.has(project))
    throw new Error(
      `${project} has no pinned commit and no decision to take its default branch: add it to PINNED, or to AT_HEAD if Bun names no version for it.`,
    );
  const pinned = PINNED[project];
  const special = PATHS[project];
  const repo = pinned?.repo ?? project;
  const commit =
    pinned?.commit ??
    git([
      "ls-remote",
      `https://github.com/${repo}`,
      special?.ref ?? "HEAD",
    ]).split(/\s/)[0] ??
    "";
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`No commit for ${repo}`);
  const files = [];
  const named = pinned?.paths ?? special?.paths;
  for (const path of named ?? CANDIDATES) {
    const got = await raw(repo, commit, path);
    // A file named here must exist; of the usual names, any may be absent.
    if (!got && named)
      throw new Error(`${path} is missing at ${repo}@${commit}.`);
    if (got) files.push({ name: path, ...got });
  }
  for (const excerpt of EXCERPTS[project] ?? []) {
    const got = await raw(excerpt.repo ?? repo, commit, excerpt.path);
    if (!got)
      throw new Error(`${excerpt.path} is missing at ${repo}@${commit}.`);
    files.push({
      name: `${excerpt.path}.L${excerpt.from}-L${excerpt.to}`,
      url: `${got.url}#L${excerpt.from}-L${excerpt.to}`,
      bytes: lines(got.bytes, excerpt.from, excerpt.to),
    });
  }
  return save(
    project.replace("/", "__"),
    {
      project,
      source: `https://github.com/${repo}`,
      commit,
      pin:
        pinned?.why ??
        (pinned
          ? `the commit Bun ${BUN_VERSION} builds from (scripts/build/deps at bun-v${BUN_VERSION})`
          : special?.ref
            ? `the tag Bun's LICENSE.md links (${special.ref.replace("refs/tags/", "")})`
            : HEAD_DECISION),
    },
    files,
  );
};

const untar = async (bytes: Uint8Array) => {
  const folder = await mkdtemp(join(tmpdir(), "licence-fetch-"));
  await writeFile(join(folder, "archive.tgz"), bytes);
  const result = Bun.spawnSync(["tar", "-xzf", "archive.tgz"], {
    cwd: folder,
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(String(result.stderr));
  return folder;
};
const licenceFilesIn = async (folder: string) =>
  (await readdir(folder))
    .filter((name) => /^(licen[cs]e|copying|notice)([._-].*)?$/i.test(name))
    .sort();

const fromNpm = async (
  name: string,
  locked: string | undefined,
  project = name,
) => {
  const version = locked ?? PINS[name]?.version;
  if (version === undefined)
    throw new Error(
      `No pinned version for the npm package ${name}: add the version Bun ${BUN_VERSION} carries to PINS, with how it was found.`,
    );
  const meta = (await (
    await fetchOk(`https://registry.npmjs.org/${name}`)
  ).json()) as {
    "dist-tags": { latest: string };
    versions: Record<string, { dist: { tarball: string }; gitHead?: string }>;
  };
  const record = meta.versions[version];
  if (!record) throw new Error(`npm has no ${name}@${version}`);
  const folder = await untar(
    new Uint8Array(await (await fetchOk(record.dist.tarball)).arrayBuffer()),
  );
  try {
    const packageFolder = join(
      folder,
      (await readdir(folder)).find((entry) => entry !== "archive.tgz") ??
        "package",
    );
    const names = await licenceFilesIn(packageFolder);
    const excerpt = NPM_EXCERPTS[name];
    if (names.length === 0 && excerpt !== undefined) {
      const bytes = new Uint8Array(
        await readFile(join(packageFolder, excerpt.path)),
      );
      return save(
        `npm__${name.replace("/", "__")}`,
        {
          project,
          source: record.dist.tarball,
          version,
          ...(record.gitHead ? { commit: record.gitHead } : {}),
          pin: locked
            ? `the version Bun ${BUN_VERSION}'s src/node-fallbacks/bun.lock resolves`
            : (PINS[name]?.why ?? ""),
        },
        [
          {
            name: `${excerpt.path}.L${excerpt.from}-L${excerpt.to}`,
            url: `${record.dist.tarball}#package/${excerpt.path}:L${excerpt.from}-L${excerpt.to}`,
            bytes: lines(bytes, excerpt.from, excerpt.to),
          },
        ],
      );
    }
    if (names.length === 0) {
      // No licence file in the package: its repository's, at the published commit when npm records one.
      const manifest = JSON.parse(
        await readFile(join(packageFolder, "package.json"), "utf8"),
      ) as {
        license?: string;
        repository?: string | { url?: string };
      };
      const url =
        typeof manifest.repository === "string"
          ? manifest.repository
          : (manifest.repository?.url ?? "");
      const repo = /github(?:\.com[/:]|:)([^/]+\/[^/#.]+)/.exec(url)?.[1];
      const commit =
        record.gitHead ??
        (repo
          ? git(["ls-remote", `https://github.com/${repo}`, "HEAD"]).split(
              /\s/,
            )[0]
          : undefined);
      const files = [];
      if (repo && commit)
        for (const path of CANDIDATES) {
          const got = await raw(repo, commit, path);
          if (got) files.push({ name: path, ...got });
        }
      if (files.length === 0) {
        if (DECIDED_SKIPS[project]?.kind === "no-text-upstream")
          return { skip: project };
        throw new Error(
          `npm's ${name}@${version} and its repository ship no licence file, and no decided reason covers ${project}.`,
        );
      }
      return save(
        `npm__${name.replace("/", "__")}`,
        {
          project,
          source: `https://github.com/${repo}`,
          version,
          ...(commit ? { commit } : {}),
          pin: `the repository of npm's ${name}@${version} (the package ships no licence file), at ${record.gitHead ? "the commit npm records for that version" : "its default branch when fetched"}`,
        },
        files,
      );
    }
    return save(
      `npm__${name.replace("/", "__")}`,
      {
        project,
        source: record.dist.tarball,
        version,
        ...(record.gitHead ? { commit: record.gitHead } : {}),
        pin: locked
          ? `the version Bun ${BUN_VERSION}'s src/node-fallbacks/bun.lock resolves`
          : (PINS[name]?.why ?? ""),
      },
      await Promise.all(
        names.map(async (file) => ({
          name: file,
          url: `${record.dist.tarball}#package/${file}`,
          bytes: new Uint8Array(await readFile(join(packageFolder, file))),
        })),
      ),
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
};

const fromCrate = async (name: string) => {
  const headers = { "user-agent": "licence-fetch (release notices)" };
  const version = PINS[name]?.version;
  if (version === undefined)
    throw new Error(
      `No pinned version for the crate ${name}: add the version Bun ${BUN_VERSION} carries to PINS, with how it was found.`,
    );
  const url = `https://static.crates.io/crates/${name}/${name}-${version}.crate`;
  const folder = await untar(
    new Uint8Array(await (await fetchOk(url, { headers })).arrayBuffer()),
  );
  try {
    const crateFolder = join(folder, `${name}-${version}`);
    const names = await licenceFilesIn(crateFolder);
    return save(
      `crate__${name}`,
      {
        project: name,
        source: url,
        version,
        pin: PINS[name]?.why ?? "",
      },
      await Promise.all(
        names.map(async (file) => ({
          name: file,
          url: `${url}#${name}-${version}/${file}`,
          bytes: new Uint8Array(await readFile(join(crateFolder, file))),
        })),
      ),
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
};

/**
 * Crates compiled into Bun through lol-html that Bun's LICENSE.md doesn't list. Their licence,
 * MPL-2.0, asks that whoever receives the binary can find the source of the covered files, so each
 * is named with the version Bun's Cargo.lock pins at the tag and the commit its crate records.
 */
export const MPL_CRATES = [
  "cssparser",
  "cssparser-macros",
  "dtoa-short",
  "selectors",
];

export interface MplCrate {
  readonly crate: string;
  readonly version: string;
  readonly licence: "MPL-2.0";
  readonly repository: string;
  readonly commit: string;
  readonly path: string;
  /** The stored folder that holds its MPL-2.0 text: its own, or another's when the crate ships none. */
  readonly text: string;
}

const fromMplCrates = async (cargoLock: string) => {
  const headers = { "user-agent": "licence-fetch (release notices)" };
  const found: Array<Omit<MplCrate, "text"> & { stored: string | undefined }> =
    [];
  for (const name of MPL_CRATES) {
    const versions = [
      ...cargoLock.matchAll(
        /\[\[package\]\]\nname = "([^"]+)"\nversion = "([^"]+)"/g,
      ),
    ]
      .filter((match) => match[1] === name)
      .map((match) => match[2] ?? "");
    const [version] = versions;
    if (versions.length !== 1 || version === undefined)
      throw new Error(
        `Bun ${BUN_VERSION}'s Cargo.lock should pin one version of ${name}, not ${versions.length}.`,
      );
    const url = `https://static.crates.io/crates/${name}/${name}-${version}.crate`;
    const folder = await untar(
      new Uint8Array(await (await fetchOk(url, { headers })).arrayBuffer()),
    );
    try {
      const crateFolder = join(folder, `${name}-${version}`);
      const manifest = await readFile(join(crateFolder, "Cargo.toml"), "utf8");
      const licence = /^license = "([^"]+)"$/m.exec(manifest)?.[1];
      const repository = /^repository = "([^"]+)"$/m.exec(manifest)?.[1];
      const vcs = JSON.parse(
        await readFile(join(crateFolder, ".cargo_vcs_info.json"), "utf8"),
      ) as { git?: { sha1?: string }; path_in_vcs?: string };
      const commit = vcs.git?.sha1;
      if (licence !== "MPL-2.0" || !repository || !commit)
        throw new Error(
          `${name} ${version} should say MPL-2.0, its repository and its commit; it says ${licence}, ${repository}, ${commit}.`,
        );
      const names = await licenceFilesIn(crateFolder);
      const stored =
        names.length === 0
          ? undefined
          : await save(
              `crate__${name}`,
              {
                project: name,
                source: url,
                version,
                commit,
                pin: `the version Bun ${BUN_VERSION}'s Cargo.lock pins; it arrives through lol-html`,
              },
              await Promise.all(
                names.map(async (file) => ({
                  name: file,
                  url: `${url}#${name}-${version}/${file}`,
                  bytes: new Uint8Array(
                    await readFile(join(crateFolder, file)),
                  ),
                })),
              ),
            );
      found.push({
        crate: name,
        version,
        licence: "MPL-2.0",
        repository,
        commit,
        path: vcs.path_in_vcs ?? "",
        stored,
      });
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }
  const fallback = found.find((item) => item.stored)?.stored;
  if (!fallback)
    throw new Error("None of the MPL-2.0 crates ships its licence text.");
  return found.map(({ stored, ...item }): MplCrate => ({
    ...item,
    text: stored ?? fallback,
  }));
};

const main = async () => {
  // `--only a/b,npm c`: refresh those projects and keep the rest of the stored manifest.
  const at = Bun.argv.indexOf("--only");
  const only =
    at === -1
      ? undefined
      : new Set((Bun.argv[at + 1] ?? "").split(",").filter(Boolean));
  await mkdir(OUT, { recursive: true });
  const bunLicense = await raw("oven-sh/bun", BUN_COMMIT, "LICENSE.md");
  if (!bunLicense) throw new Error("Bun's LICENSE.md is missing at the tag.");
  const text = new TextDecoder().decode(bunLicense.bytes);
  const entries: Array<string> = [];
  entries.push(
    await save(
      "oven-sh__bun",
      {
        project: "oven-sh/bun",
        source: "https://github.com/oven-sh/bun",
        commit: BUN_COMMIT,
        pin: `the tag bun-v${BUN_VERSION}`,
      },
      [
        { name: "LICENSE.md", ...bunLicense },
        ...(await Promise.all(
          VENDORED_IN_BUN.map(async (path) => {
            const got = await raw("oven-sh/bun", BUN_COMMIT, path);
            if (!got) throw new Error(`Bun's ${path} is missing at the tag.`);
            return { name: path, ...got };
          }),
        )),
      ],
    ),
  );
  const urls = [
    ...text.matchAll(/\]\((https?:\/\/[^)\s]+)\)|<(https?:\/\/[^>]+)>/g),
  ].map((match) => match[1] ?? match[2] ?? "");
  const github = new Set<string>();
  const npm = new Set<string>();
  const crates = new Set<string>();
  for (const url of urls) {
    const repo = /^https:\/\/github\.com\/([^/#]+)\/([^/#]+)/.exec(url);
    if (repo) github.add(`${repo[1]}/${repo[2]?.replace(/\.git$/, "")}`);
    const pkg =
      /^https:\/\/(?:www\.)?npmjs\.com\/package\/((?:@[^/]+\/)?[^/#]+)/.exec(
        url,
      );
    if (pkg?.[1]) npm.add(pkg[1]);
    const crate = /^https:\/\/crates\.io\/crates\/([^/#]+)/.exec(url);
    if (crate?.[1]) crates.add(crate[1]);
  }
  if (urls.some((url) => url.includes("boringssl.googlesource.com")))
    github.add("google/boringssl");
  // Libraries Bun builds from pinned commits but its LICENSE.md doesn't link.
  for (const project of [
    "HdrHistogram/HdrHistogram_c",
    "sru-systems/rust-argon2",
  ])
    github.add(project);
  // The polyfill table links npm; the ones Bun's lockfile resolves use that version.
  const lock = new TextDecoder().decode(
    (await raw("oven-sh/bun", BUN_COMMIT, "src/node-fallbacks/bun.lock"))
      ?.bytes,
  );
  const locked = (name: string) =>
    new RegExp(
      `"${name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}": \\["${name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}@([^"]+)"`,
    ).exec(lock)?.[1];
  type Skip = { project: string; kind: string; reason: string };
  const skipped: Array<Skip> = [];
  const decide = (project: string) => {
    const decided = DECIDED_SKIPS[project];
    if (decided === undefined)
      throw new Error(
        `No text stored for ${project}, and no decided reason to skip it.`,
      );
    skipped.push({ project, ...decided });
  };
  for (const project of [...github].sort()) {
    if (only && !only.has(project)) continue;
    if (DECIDED_SKIPS[project]) {
      decide(project);
      continue;
    }
    const viaNpm = VIA_NPM[project];
    if (viaNpm) {
      const got = await fromNpm(viaNpm, undefined, project);
      if (typeof got === "string") entries.push(got);
      else decide(got.skip);
    } else entries.push(await fromGitHub(project));
    console.log(project);
  }
  for (const name of [...npm].sort()) {
    if (only && !only.has(`npm ${name}`)) continue;
    if (DECIDED_SKIPS[`npm ${name}`]) {
      decide(`npm ${name}`);
      continue;
    }
    const got = await fromNpm(name, locked(name));
    if (typeof got === "string") entries.push(got);
    else decide(`npm ${got.skip}`);
    console.log(`npm ${name}`);
  }
  for (const name of [...crates].sort()) {
    if (only && !only.has(`crate ${name}`)) continue;
    entries.push(await fromCrate(name));
    console.log(`crate ${name}`);
  }
  let mpl: Array<MplCrate> | undefined;
  if (!only || only.has("mpl crates")) {
    const lock = await raw("oven-sh/bun", BUN_COMMIT, "Cargo.lock");
    if (!lock) throw new Error("Bun's Cargo.lock is missing at the tag.");
    mpl = await fromMplCrates(new TextDecoder().decode(lock.bytes));
    entries.push(
      ...new Set(
        mpl.map((item) => item.text).filter((slug) => !entries.includes(slug)),
      ),
    );
    console.log("mpl crates");
  }
  for (const project of ["evanw", "kipply", "SQLite (vendored by Bun)"])
    if (!only || only.has(project)) decide(project);
  if (only) {
    // A partial refresh: keep the other projects' entries and reasons from the stored manifest.
    const before = JSON.parse(
      await readFile(join(OUT, "manifest.json"), "utf8"),
    ) as {
      entries: Array<string>;
      skipped: Array<Skip>;
      mpl?: Array<MplCrate>;
    };
    mpl ??= before.mpl;
    const slugOf = (project: string) =>
      project.startsWith("npm ")
        ? `npm__${project.slice(4).replace("/", "__")}`
        : project.startsWith("crate ")
          ? `crate__${project.slice(6)}`
          : project.replace("/", "__");
    entries.push(
      ...before.entries.filter(
        (slug) =>
          ![...only].some((project) => slugOf(project) === slug) &&
          !entries.includes(slug),
      ),
    );
    skipped.push(
      ...before.skipped.filter(
        (item) =>
          !only.has(item.project) &&
          !only.has(item.project.replace(/^npm /, "")),
      ),
    );
  }
  // A project that is now skipped, or gone from Bun's list, leaves no folder behind.
  for (const entry of await readdir(OUT, { withFileTypes: true }))
    if (entry.isDirectory() && !entries.includes(entry.name))
      await rm(join(OUT, entry.name), { recursive: true, force: true });
  await writeFile(
    join(OUT, "manifest.json"),
    `${JSON.stringify({ bun: BUN_VERSION, tag: `bun-v${BUN_VERSION}`, commit: BUN_COMMIT, licenseSha256: sha256(bunLicense.bytes), entries: entries.sort(), skipped, mpl }, null, 2)}\n`,
  );
  console.log(`${entries.length} stored, ${skipped.length} skipped`);
};

if (import.meta.main) await main();
