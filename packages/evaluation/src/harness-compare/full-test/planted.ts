import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { KnownCase } from "./known-cases.ts";

/**
 * The planted known cases: ranges built as scratch commits in a scratch clone, never in this
 * repository's history. A separate session authors them in its own folder and never shares it with
 * the runs (2.16); what it hands over is a spec file this module reads and builds. FT11's three kinds:
 *
 * - `pure-omission`: 10.86's pure omission path. The change breaks a behaviour through code it does
 *   not touch, and the defect's lines are unchanged lines (no hunk of the range covers them). After
 *   the run, packets.ts `referencesCover` says whether a context reference covered them; the path is
 *   exercised only when none did.
 * - `mocked-test`: a test that mocks away the behaviour it claims to verify (10.63); the defect's
 *   lines are changed lines of the test.
 * - `changed-lines`: a plain defect in changed lines.
 *
 * The light kinds (12.33's guard, NEU-148's set B): a problem planted in a light file, the kinds of
 * hunk a lighter review would take. Each must sit in changed lines, and the planted commit's own
 * diff must have its class's shape (`lightShapeProblem`): only test, doc, fixture, generated or lock
 * files; only import lines, only declaration lines, or only deleted lines.
 *
 * Building uses git plumbing only (a temporary index, `hash-object`, `write-tree`, `commit-tree`),
 * so there is no checkout and no worktree; the commit is kept on `refs/heads/planted/<id>` of the
 * scratch clone. The builder checks each kind's line rule against the built diff and refuses a
 * spec that breaks it.
 */

export const LIGHT_KINDS = [
  "light-tests",
  "light-docs",
  "light-fixtures",
  "light-generated",
  "light-lockfile",
  "light-import-only",
  "light-declaration-only",
  "light-deletion-only",
] as const;
export type LightKind = (typeof LIGHT_KINDS)[number];

export const PLANTED_KINDS = [
  "pure-omission",
  "mocked-test",
  "changed-lines",
  ...LIGHT_KINDS,
] as const;
export type PlantedKind = (typeof PLANTED_KINDS)[number];

const Edit = z.union([
  z.strictObject({ path: z.string().min(1), content: z.string() }),
  z.strictObject({ path: z.string().min(1), delete: z.literal(true) }),
]);

export const PlantedSpec = z.strictObject({
  schemaVersion: z.literal(1),
  cases: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-z0-9-]{1,64}$/),
        kind: z.enum(PLANTED_KINDS),
        /** The commit the case is built on: a dev range's base, in the clone's source repository. */
        base: z.string().regex(/^[0-9a-f]{40}$/),
        message: z.string().min(1),
        edits: z.array(Edit).min(1),
        /**
         * The defect's lines, on the head side unless `side` says old (a deletion-only plant's lines
         * exist only on the old side; files the change leaves alone have one numbering).
         */
        defect: z
          .array(
            z.strictObject({
              path: z.string().min(1),
              side: z.enum(["old", "new"]).optional(),
              startLine: z.int().min(1),
              endLine: z.int().min(1),
            }),
          )
          .min(1),
        note: z.string(),
      }),
    )
    .min(1),
});
export type PlantedSpec = z.infer<typeof PlantedSpec>;

/** File classes as the light review's census names them, by path (heuristics, as there). */
const LOCKFILE =
  /(^|\/)(bun\.lockb?|yarn\.lock|package-lock\.json|pnpm-lock\.yaml|go\.sum|Cargo\.lock)$/;
const TEST_FILE =
  /(\.test\.|\.spec\.|-test\.[jt]sx?$|_test\.go$|(^|\/)__tests__\/|(^|\/)tests?\/)/;
const FIXTURE_FILE =
  /((^|\/)(fixtures?|__fixtures__|testdata|__snapshots__)\/|\.expect\.md$|\.snap$|\.golden$)/;
const DOC_FILE = /\.(md|mdx|rst|txt)$/i;
const IMPORT_LINE =
  /^\s*(import\b.*|export\s+(\*|\{[^}]*\})\s+from\s+['"].*|\}?\s*from\s+['"][^'"]+['"];?|"[^"]+"|[A-Za-z_.]+\s+"[^"]+"|import\s*\(|\)|[A-Za-z_$][\w$]*,?)\s*$/;
const DECLARATION_LINE =
  /^\s*(export\s+)?(declare\s+)?(type|interface|enum|namespace)\b|^\s*export\s+(\*|\{[^}]*\})\s*(from\s+['"].*)?;?\s*$|^\s*[A-Za-z_$][\w$]*\??\s*:\s*[^=]+[;,]?\s*$|^\s*[|&]\s*|^\s*[}\]);,]*\s*$/;
/** A generated file's own marker, as Go and React tools write it near the top. */
export const GENERATED_MARKER = /(Code generated .* DO NOT EDIT|@generated)/;

/** One file of a planted commit's own diff: its path, its added and deleted lines' text. */
export interface PlantFile {
  readonly path: string;
  readonly added: ReadonlyArray<string>;
  readonly deleted: ReadonlyArray<string>;
  /** The file's first lines at the planted head, for the generated marker. */
  readonly head?: string | undefined;
}

/** Why a planted commit's own diff does not have its light class's shape; null when it does. */
export const lightShapeProblem = (
  kind: LightKind,
  files: ReadonlyArray<PlantFile>,
): string | null => {
  if (files.length === 0) return "the planted commit changes nothing";
  const bad = (what: string, paths: ReadonlyArray<string>) =>
    paths.length === 0 ? null : `${what}: ${paths.join(", ")}`;
  const changed = (file: PlantFile) => [...file.added, ...file.deleted];
  switch (kind) {
    case "light-tests":
      return bad(
        "not a test file",
        files.filter((f) => !TEST_FILE.test(f.path)).map((f) => f.path),
      );
    case "light-docs":
      return bad(
        "not a doc file",
        files.filter((f) => !DOC_FILE.test(f.path)).map((f) => f.path),
      );
    case "light-fixtures":
      return bad(
        "not a fixture file",
        files.filter((f) => !FIXTURE_FILE.test(f.path)).map((f) => f.path),
      );
    case "light-lockfile":
      return bad(
        "not a lockfile",
        files.filter((f) => !LOCKFILE.test(f.path)).map((f) => f.path),
      );
    case "light-generated":
      return bad(
        "no generated marker at its head",
        files
          .filter((f) => !GENERATED_MARKER.test(f.head ?? ""))
          .map((f) => f.path),
      );
    case "light-deletion-only":
      return bad(
        "adds lines",
        files.filter((f) => f.added.length > 0).map((f) => f.path),
      );
    case "light-import-only":
      return bad(
        "changes lines that are not imports",
        files
          .filter((f) =>
            changed(f).some(
              (line) => line.trim() !== "" && !IMPORT_LINE.test(line),
            ),
          )
          .map((f) => f.path),
      );
    case "light-declaration-only":
      return bad(
        "changes lines that are not declarations",
        files
          .filter(
            (f) =>
              !/\.d\.ts$/.test(f.path) &&
              changed(f).some(
                (line) => line.trim() !== "" && !DECLARATION_LINE.test(line),
              ),
          )
          .map((f) => f.path),
      );
  }
};

const git = (
  repository: string,
  args: ReadonlyArray<string>,
  options: { env?: Record<string, string>; stdin?: string } = {},
) => {
  const result = Bun.spawnSync(["git", "-C", repository, ...args], {
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "full-test planted case",
      GIT_AUTHOR_EMAIL: "planted@full-test.invalid",
      GIT_COMMITTER_NAME: "full-test planted case",
      GIT_COMMITTER_EMAIL: "planted@full-test.invalid",
      GIT_AUTHOR_DATE: "2026-10-21T00:00:00Z",
      GIT_COMMITTER_DATE: "2026-10-21T00:00:00Z",
      ...options.env,
    },
    ...(options.stdin === undefined
      ? {}
      : { stdin: new TextEncoder().encode(options.stdin) }),
  });
  if (result.exitCode !== 0)
    throw new Error(
      `git ${args.slice(0, 3).join(" ")} failed: ${result.stderr.toString()}`,
    );
  return result.stdout.toString().trim();
};

/** The head-side lines each hunk of `base..head` changes, per path (`git diff -U0`). */
export const changedHeadLines = (
  repository: string,
  base: string,
  head: string,
) => {
  const text = git(repository, [
    "diff",
    "--no-color",
    "--no-renames",
    "-U0",
    base,
    head,
  ]);
  const changed = new Map<string, Array<[number, number]>>();
  let path: string | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("+++ ")) {
      path = line === "+++ /dev/null" ? null : line.slice("+++ b/".length);
      continue;
    }
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header === null || path === null) continue;
    const start = Number(header[1]);
    const count = header[2] === undefined ? 1 : Number(header[2]);
    if (count === 0) continue;
    changed.set(path, [
      ...(changed.get(path) ?? []),
      [start, start + count - 1],
    ]);
  }
  return changed;
};

/** The base-side lines each hunk of `base..head` deletes or replaces, per path (`git diff -U0`). */
export const changedBaseLines = (
  repository: string,
  base: string,
  head: string,
) => {
  const text = git(repository, [
    "diff",
    "--no-color",
    "--no-renames",
    "-U0",
    base,
    head,
  ]);
  const changed = new Map<string, Array<[number, number]>>();
  let path: string | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("--- ")) {
      path = line === "--- /dev/null" ? null : line.slice("--- a/".length);
      continue;
    }
    const header = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
    if (header === null || path === null) continue;
    const start = Number(header[1]);
    const count = header[2] === undefined ? 1 : Number(header[2]);
    if (count === 0) continue;
    changed.set(path, [
      ...(changed.get(path) ?? []),
      [start, start + count - 1],
    ]);
  }
  return changed;
};

const touches = (
  changed: ReadonlyMap<string, ReadonlyArray<[number, number]>>,
  defect: { path: string; startLine: number; endLine: number },
) =>
  (changed.get(defect.path) ?? []).some(
    ([start, end]) => start <= defect.endLine && defect.startLine <= end,
  );

/** The kind's line rule over the built diff: an omission lies wholly outside it, the others inside. */
export const checkKind = (
  kind: PlantedSpec["cases"][number]["kind"],
  changed: ReadonlyMap<string, ReadonlyArray<[number, number]>>,
  defect: ReadonlyArray<{
    path: string;
    side?: "old" | "new" | undefined;
    startLine: number;
    endLine: number;
  }>,
  /** The base-side changed lines, which an old-side defect range is judged against. */
  changedBase: ReadonlyMap<string, ReadonlyArray<[number, number]>> = new Map(),
) => {
  const on = (range: (typeof defect)[number]) =>
    touches(range.side === "old" ? changedBase : changed, range);
  if (kind === "pure-omission") {
    const inside = defect.filter(on);
    return inside.length === 0
      ? null
      : `a pure omission's lines must be unchanged, but ${inside.map((r) => `${r.path}:${r.startLine}-${r.endLine}`).join(", ")} lie in the change`;
  }
  const outside = defect.filter((range) => !on(range));
  return outside.length === 0
    ? null
    : `a ${kind} defect's lines must be changed lines, but ${outside.map((r) => `${r.path}:${r.startLine}-${r.endLine}`).join(", ")} are not`;
};

/** Who a planted commit says made it, and when: fixed, so building twice gives the same commit. */
export interface PlantIdentity {
  readonly name: string;
  readonly email: string;
  /** ISO time for both author and committer. */
  readonly date: string;
}

const identityEnv = (identity: PlantIdentity | undefined) =>
  identity === undefined
    ? {}
    : {
        GIT_AUTHOR_NAME: identity.name,
        GIT_AUTHOR_EMAIL: identity.email,
        GIT_COMMITTER_NAME: identity.name,
        GIT_COMMITTER_EMAIL: identity.email,
        GIT_AUTHOR_DATE: identity.date,
        GIT_COMMITTER_DATE: identity.date,
      };

/**
 * One commit on `parent` in `clone` holding `edits`, by plumbing only (a temporary index): the
 * working tree and refs are untouched; the caller names the ref.
 */
export const plantCommit = (
  clone: string,
  options: {
    readonly parent: string;
    readonly edits: ReadonlyArray<z.infer<typeof Edit>>;
    readonly message: string;
    readonly indexName: string;
    readonly identity?: PlantIdentity | undefined;
  },
) => {
  const gitDirectory = git(clone, ["rev-parse", "--absolute-git-dir"]);
  const index = join(gitDirectory, `${options.indexName}.index`);
  const env = { GIT_INDEX_FILE: index };
  try {
    git(clone, ["read-tree", options.parent], { env });
    for (const edit of options.edits) {
      if ("delete" in edit) {
        git(clone, ["update-index", "--force-remove", "--", edit.path], {
          env,
        });
        continue;
      }
      // An existing file keeps its mode (an executable script stays executable).
      const mode =
        git(clone, ["ls-tree", options.parent, "--", edit.path]).split(
          " ",
        )[0] || "100644";
      const blob = git(clone, ["hash-object", "-w", "--stdin"], {
        stdin: edit.content,
      });
      git(
        clone,
        [
          "update-index",
          "--add",
          "--cacheinfo",
          `${mode},${blob},${edit.path}`,
        ],
        { env },
      );
    }
    const tree = git(clone, ["write-tree"], { env });
    return git(
      clone,
      ["commit-tree", tree, "-p", options.parent, "-m", options.message],
      { env: identityEnv(options.identity) },
    );
  } finally {
    Bun.spawnSync(["rm", "-f", index]);
  }
};

/** A planted commit's own diff against its parent, per file, for `lightShapeProblem`. */
export const plantFiles = (
  clone: string,
  parent: string,
  commit: string,
): Array<PlantFile> => {
  const text = git(clone, [
    "diff",
    "--no-color",
    "--no-renames",
    "-U0",
    parent,
    commit,
  ]);
  const files: Array<{ path: string; added: string[]; deleted: string[] }> = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      files.push({ path: "", added: [], deleted: [] });
      continue;
    }
    const file = files.at(-1);
    if (file === undefined) continue;
    if (line.startsWith("+++ ")) {
      if (line !== "+++ /dev/null") file.path = line.slice("+++ b/".length);
      continue;
    }
    if (line.startsWith("--- ")) {
      if (line !== "--- /dev/null" && file.path === "")
        file.path = line.slice("--- a/".length);
      continue;
    }
    if (line.startsWith("+")) file.added.push(line.slice(1));
    else if (line.startsWith("-")) file.deleted.push(line.slice(1));
  }
  return files.map((file) => {
    const shown = Bun.spawnSync([
      "git",
      "-C",
      clone,
      "show",
      `${commit}:${file.path}`,
    ]);
    return {
      ...file,
      head:
        shown.exitCode === 0
          ? shown.stdout.toString().split("\n").slice(0, 12).join("\n")
          : undefined,
    };
  });
};

/**
 * Builds every case of the spec as one commit on its base in `clone` (a scratch clone that already
 * holds the base), and returns the known-case entries to record. Building twice gives the same
 * commits (fixed identities and dates).
 */
export const buildPlanted = (clone: string, spec: PlantedSpec) => {
  const entries: Array<KnownCase> = [];
  for (const entry of spec.cases) {
    const commit = plantCommit(clone, {
      parent: entry.base,
      edits: entry.edits,
      message: entry.message,
      indexName: `planted-${entry.id}`,
    });
    git(clone, ["update-ref", `refs/heads/planted/${entry.id}`, commit]);
    const problem =
      checkKind(
        entry.kind,
        changedHeadLines(clone, entry.base, commit),
        entry.defect,
        changedBaseLines(clone, entry.base, commit),
      ) ??
      ((LIGHT_KINDS as ReadonlyArray<string>).includes(entry.kind)
        ? lightShapeProblem(
            entry.kind as LightKind,
            plantFiles(clone, entry.base, commit),
          )
        : null);
    if (problem !== null) throw new Error(`${entry.id}: ${problem}`);
    entries.push({
      id: `planted:${entry.id}`,
      kind: "planted",
      planted: entry.kind,
      source: clone,
      base: entry.base,
      head: commit,
      defectLines: entry.defect.map(({ side, ...range }) => ({
        ...range,
        side: side ?? "new",
      })),
      inSample: false,
      copyProofs: false,
      proofSource: null,
      catch: "defect-lines",
      note: entry.note,
    });
  }
  return entries;
};

export const readPlantedSpec = (path: string) => {
  if (!existsSync(path)) throw new Error(`no planted spec at ${path}`);
  return PlantedSpec.parse(JSON.parse(readFileSync(path, "utf8")));
};

/**
 * The authoring lane's delivery (FT11): one folder per case holding `spec.json` (the defect's path,
 * side, lines and kind), `range.bundle` (the case's commits on a dev range's base) and `range.patch`.
 * Each bundle is fetched into one scratch clone per source repository (`git clone --shared
 * --no-checkout`, no worktree), so the clone holds the planted commits and nothing of the spec:
 * the spec text never reaches a harness agent, which reads only the clone's git objects at the
 * range's revisions. The head must be the spec's, the base its ancestor, and each kind's line rule
 * must hold on the built diff; the returned entries are what known-cases.json records.
 */
export const DeliveredSpec = z.looseObject({
  caseId: z.string().min(1),
  kind: z.string().min(1),
  repository: z.enum(["neuve", "neuve_effect"]),
  base: z.string().regex(/^[0-9a-f]{40}$/),
  head: z.string().regex(/^[0-9a-f]{40}$/),
  bundle: z.string().min(1),
  bundleRef: z.string().regex(/^refs\/heads\/[A-Za-z0-9._/-]+$/),
  defect: z.looseObject({
    path: z.string().min(1),
    startLine: z.int().min(1),
    endLine: z.int().min(1),
  }),
  devRangeAtBase: z.string().optional(),
});

/** The delivered kind's words to the three kinds of FT11. */
export const kindOf = (kind: string): PlantedSpec["cases"][number]["kind"] => {
  if (/omission/.test(kind)) return "pure-omission";
  if (/mock/.test(kind)) return "mocked-test";
  if (/changed|plain/.test(kind)) return "changed-lines";
  throw new Error(`unknown planted kind ${kind}`);
};

export const plantFromBundles = (
  folder: string,
  scratchRoot: string,
  sources: Readonly<Record<"neuve" | "neuve_effect", string>>,
): Array<KnownCase> => {
  const entries: Array<KnownCase> = [];
  const cases = readdirSync(folder)
    .filter((name) => existsSync(join(folder, name, "spec.json")))
    .sort();
  for (const name of cases) {
    const spec = DeliveredSpec.parse(
      JSON.parse(readFileSync(join(folder, name, "spec.json"), "utf8")),
    );
    const clone = join(scratchRoot, `planted-${spec.repository}`);
    if (!existsSync(join(clone, "HEAD")) && !existsSync(join(clone, ".git")))
      Bun.spawnSync([
        "git",
        "clone",
        "--quiet",
        "--shared",
        "--no-checkout",
        sources[spec.repository],
        clone,
      ]);
    git(clone, [
      "fetch",
      "--quiet",
      join(folder, name, spec.bundle),
      `+${spec.bundleRef}:refs/heads/planted/${spec.caseId}`,
    ]);
    const head = git(clone, ["rev-parse", `refs/heads/planted/${spec.caseId}`]);
    if (head !== spec.head)
      throw new Error(
        `${spec.caseId}: the bundle's head is ${head}, not ${spec.head}`,
      );
    const ancestor = Bun.spawnSync([
      "git",
      "-C",
      clone,
      "merge-base",
      "--is-ancestor",
      spec.base,
      spec.head,
    ]);
    if (ancestor.exitCode !== 0)
      throw new Error(
        `${spec.caseId}: ${spec.base} is not an ancestor of the head`,
      );
    const kind = kindOf(spec.kind);
    const defect = [
      {
        path: spec.defect.path,
        startLine: spec.defect.startLine,
        endLine: spec.defect.endLine,
      },
    ];
    const problem = checkKind(
      kind,
      changedHeadLines(clone, spec.base, spec.head),
      defect,
    );
    if (problem !== null) throw new Error(`${spec.caseId}: ${problem}`);
    entries.push({
      id: `planted:${spec.caseId}`,
      kind: "planted",
      planted: kind,
      // Recorded under the run's own scratch folder, never as a machine path (phases.ts sourceOf).
      source: `scratch:planted-${spec.repository}`,
      base: spec.base,
      head: spec.head,
      // Head-side lines: an omission's lines are unchanged and numbered alike on both sides.
      defectLines: defect.map((range) => ({ ...range, side: "new" as const })),
      inSample: false,
      copyProofs: false,
      proofSource: null,
      catch: "defect-lines",
      note: `Planted by the authoring lane (${name}${spec.devRangeAtBase === undefined ? "" : `, on ${spec.devRangeAtBase}'s base`}); its spec stays in results/full-test/known-cases/ and never in a clone.`,
    });
  }
  return entries;
};
