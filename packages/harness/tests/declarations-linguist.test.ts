// Why: decision 14.18 lets files GitHub Linguist's generated or vendored list marks skip the model
// readings, with the repository's own attributes winning in both directions, and the map's
// exclusion (fed by the `linguist` reader) must never disagree with the `generated` rule's judgement
// on whether a file is marked. These tests hold the reader to each list's rule and pattern kinds,
// to the attributes in both directions, to the unsure read and the read bound (the safe direction:
// no mark, so the file is read), to its `by` text, and to the rule run on the same commit.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer } from "effect";
import {
  Blobs,
  Computations,
  Store,
  storeLocationIn,
} from "@neuve/records-core";
import { CpuWork } from "../src/budget/cpu.ts";
import { Scheduler } from "../src/budget/scheduler.ts";
import { CodeWork } from "../src/code-work.ts";
import {
  DECLARATION_GAPS,
  DECLARATION_READERS,
  DECLARATIONS_RECIPE,
  LINGUIST_GAP,
  LINGUIST_READER_RECIPE,
  readDeclarations,
  type Suggestion,
} from "../src/declarations.ts";
import { lsTree } from "../src/git-objects.ts";
import { captureOutlineSource } from "../src/graph-outline.ts";
import {
  CONTROL_FILES,
  CONTROL_FILES_RECIPE,
  READ_BOUND_BYTES,
  linguistListMarks,
  linguistMarkOf,
  allUnspecified,
} from "../src/linguist-lists.ts";
import type { ManifestHunk } from "../src/manifest.ts";
import { INDEX_BOUNDS } from "../src/search-index.ts";
import {
  SECTION_RULE_VERSIONS,
  storedSectionRules,
  type SectionRuleJudgement,
} from "../src/section-rules.ts";
import { diff } from "./section-fixtures.ts";

const root = mkdtempSync(join(tmpdir(), "declarations-linguist-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

const scratchRepository = (name: string) => {
  const repository = join(root, name);
  const run = (...args: Array<string>) => {
    const done = Bun.spawnSync(["git", "-C", repository, ...args], {
      env: GIT_ENV,
    });
    if (done.exitCode !== 0) throw new Error(done.stderr.toString());
    return done.stdout.toString().trim();
  };
  Bun.spawnSync(["git", "init", "-q", repository], { env: GIT_ENV });
  const commit = (files: Readonly<Record<string, string>>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repository, path)), { recursive: true });
      writeFileSync(join(repository, path), text);
    }
    run("add", "-A");
    run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "c");
    return run("rev-parse", "HEAD");
  };
  const blobOf = (text: string) =>
    Bun.spawnSync(["git", "-C", repository, "hash-object", "-w", "--stdin"], {
      stdin: new TextEncoder().encode(text),
      env: GIT_ENV,
    })
      .stdout.toString()
      .trim();
  return { repository, run, commit, blobOf };
};

const declarationsAt = async (
  repository: string,
  revision: string,
  paths: ReadonlyArray<string>,
  linguist = true,
) => {
  const tree = await Effect.runPromise(lsTree(repository, revision));
  return Effect.runPromise(
    readDeclarations({ repository, revision, tree, paths, linguist }),
  );
};

/** The `linguist` reader's suggestions per path, as `[standard, by]`. */
const linguistOf = (byPath: ReadonlyMap<string, ReadonlyArray<Suggestion>>) =>
  Object.fromEntries(
    [...byPath]
      .map(
        ([path, list]) =>
          [
            path,
            list
              .filter((entry) => entry.standard !== undefined)
              .map((entry) => [entry.standard, entry.by]),
          ] as const,
      )
      .filter(([, list]) => list.length > 0),
  );

// A minified script: one line far above Linguist's average of 110 characters, no marker words.
const minified = (bytes: number) => `var a=${"1+".repeat(bytes / 2 - 6)}1;\n`;
const PLAIN = "export const one = 1;\n";

const FILES = {
  // A generated rule by path.
  "htmlcov/report.txt": "coverage\n",
  // A generated rule by content.
  "web/app.js": minified(600),
  // A vendor pattern.
  "dist/out.txt": "bundle\n",
  // Over Linguist's Git reader's 131,072 bytes and within the read bound: both views agree.
  "web/mid.js": minified(300_000),
  // Over the read bound: only a content rule could mark it.
  "web/big.js": minified(READ_BOUND_BYTES + 4_096),
  // No rule marks these.
  "src/plain.ts": PLAIN,
  "src/other.ts": PLAIN,
  "src/unsure.ts": PLAIN,
};
const PATHS = Object.keys(FILES);

test("the read bound is the index's size bound, which the rule reads to", () => {
  // Why: the reader and the rule must read the same bytes; the bound is held equal, not imported.
  expect(READ_BOUND_BYTES).toBe(INDEX_BOUNDS.maxFileBytes);
});

test("linguist: a path rule, a content rule (within and above Linguist's 131,072 bytes) and a vendor pattern mark; a content rule over the read bound does not; by names the version, the list and what fired", async () => {
  const repo = scratchRepository("marks");
  const revision = repo.commit(FILES);
  const declarations = await declarationsAt(repo.repository, revision, PATHS);
  expect(linguistOf(declarations.byPath)).toEqual({
    "htmlcov/report.txt": [
      ["linguist-generated", "linguist v9.7.0 generated: htmlcov?"],
    ],
    "web/app.js": [
      ["linguist-generated", "linguist v9.7.0 generated: minified_files?"],
    ],
    "web/mid.js": [
      ["linguist-generated", "linguist v9.7.0 generated: minified_files?"],
    ],
    "dist/out.txt": [
      ["linguist-vendored", "linguist v9.7.0 vendored: (^|/)dist/"],
    ],
  });
  // Every mark is of kind generated; the reader is listed and its gap disclosed.
  for (const list of declarations.byPath.values())
    for (const entry of list) expect(entry.kind).toBe("generated");
  expect(declarations.readers).toEqual([...DECLARATION_READERS]);
  expect(declarations.gaps).toEqual([...DECLARATION_GAPS, LINGUIST_GAP]);
}, 120_000);

test("linguist: the repository's attributes win in both directions: false takes each list's mark away; set or any string but false marks a file no rule marks, by naming the attribute; an unsure read gives none", async () => {
  const repo = scratchRepository("attributes");
  const revision = repo.commit({
    ...FILES,
    ".gitattributes": [
      "htmlcov/** linguist-generated=false",
      "web/app.js linguist-generated=false",
      "web/mid.js -linguist-generated",
      "dist/** linguist-vendored=false",
      "src/plain.ts linguist-generated",
      "src/other.ts linguist-vendored=yes",
      // A literal word Git prints like the state: the read cannot be sure.
      "src/unsure.ts linguist-vendored=unset",
      "",
    ].join("\n"),
    // The same for a file the vendored list marks: taking the printed word as the state
    // (unspecified) would let the pattern mark it; the unsure read gives none. In a nested file,
    // so that only `dist/` is unsure (the scan refuses every path under a file holding the word).
    "dist/.gitattributes": "unsure.txt linguist-vendored=unspecified\n",
    "dist/unsure.txt": "bundle\n",
  });
  const declarations = await declarationsAt(repo.repository, revision, [
    ...PATHS,
    "dist/unsure.txt",
  ]);
  expect(linguistOf(declarations.byPath)).toEqual({
    "src/plain.ts": [
      [
        "linguist-generated",
        "linguist v9.7.0 generated: gitattributes: linguist-generated=set",
      ],
    ],
    "src/other.ts": [
      [
        "linguist-vendored",
        "linguist v9.7.0 vendored: gitattributes: linguist-vendored=yes",
      ],
    ],
  });
  // The repository's own reader still gives its declaration of `src/plain.ts`, with no standard.
  expect(declarations.byPath.get("src/plain.ts")).toContainEqual({
    kind: "generated",
    by: "gitattributes: linguist-generated=set",
  });
}, 120_000);

test("linguist: off unless asked, so every other caller reads as before; the declarations recipe is unchanged", async () => {
  const repo = scratchRepository("off");
  const revision = repo.commit(FILES);
  const declarations = await declarationsAt(
    repo.repository,
    revision,
    PATHS,
    false,
  );
  expect(linguistOf(declarations.byPath)).toEqual({});
  expect(declarations.readers).toEqual(
    DECLARATION_READERS.filter((reader) => reader !== "linguist"),
  );
  expect(declarations.gaps).toEqual([...DECLARATION_GAPS]);
  // v4 is the undecided round's move (declared tests for bare words, file roots and a linked bunfig.toml); the linguist reader leaves it as it is.
  expect(DECLARATIONS_RECIPE).toBe("neuve-declarations-v4");
}, 120_000);

test("linguist: an attribute read that cannot see the revision's .gitattributes marks nothing and says so in a gap", async () => {
  // Why: the `generated` rule fails on such a read; the reader takes the safe direction instead.
  const repo = scratchRepository("unreadable");
  const revision = repo.commit({
    ...FILES,
    ".gitattributes": "dist/** linguist-vendored=false\n",
  });
  const oid = repo.run("rev-parse", `${revision}:.gitattributes`);
  rmSync(
    join(repo.repository, ".git", "objects", oid.slice(0, 2), oid.slice(2)),
  );
  const declarations = await declarationsAt(repo.repository, revision, PATHS);
  expect(linguistOf(declarations.byPath)).toEqual({});
  expect(
    declarations.gaps.filter((gap) =>
      gap.startsWith("linguist: The attribute"),
    ),
  ).toHaveLength(1);
  expect(declarations.gaps.at(-1)).toContain("cannot see .gitattributes");
}, 120_000);

// --- One decision -------------------------------------------------------------------------------

const storedRulesIn = (
  name: string,
  repository: string,
  revision: string,
  hunks: ReadonlyArray<ManifestHunk>,
) => {
  const location = storeLocationIn(join(root, name));
  const layer = Computations.layer.pipe(
    Layer.provideMerge(Blobs.layer(location)),
    Layer.provideMerge(
      Layer.effectDiscard(Store.prepareForWrite).pipe(
        Layer.provideMerge(Store.layer(location, { create: true })),
      ),
    ),
    Layer.provideMerge(BunFileSystem.layer),
  );
  return Effect.runPromise(
    storedSectionRules(
      repository,
      revision,
      hunks,
      captureOutlineSource(),
    ).pipe(
      Effect.provideService(CpuWork, {
        budget: new Scheduler(1),
        priority: { class: "interactive", position: "understand", stage: 0 },
        inherited: true,
      }),
      Effect.provideService(CodeWork, undefined),
      Effect.provide(layer),
    ),
  );
};

/** Whether the rule's holding judgement rests on a list: a rule, a pattern, or a list's attribute. */
const heldByLists = (judgement: SectionRuleJudgement) => {
  const inputs = judgement.inputs as {
    readonly lists?: ReadonlyArray<unknown>;
    readonly readers?: ReadonlyArray<string>;
  };
  return (
    judgement.result === "holds" &&
    ((inputs.lists?.length ?? 0) > 0 ||
      (inputs.readers ?? []).some((reader) =>
        /^gitattributes: linguist-(generated|vendored)=/.test(reader),
      ))
  );
};

test("one decision: on the same commit, the reader marks exactly the files whose generated judgement holds by Linguist's lists, at every size, and the rule does not read the reader's suggestions as the repository's", async () => {
  const repo = scratchRepository("one-decision");
  const before = Object.fromEntries(
    PATHS.map((path) => [path, `${FILES[path as keyof typeof FILES]}// a\n`]),
  );
  repo.commit(before);
  for (const attributes of [
    "",
    [
      "htmlcov/** linguist-generated=false",
      "web/mid.js -linguist-generated",
      "dist/** linguist-vendored=false",
      "src/plain.ts linguist-generated",
      "src/other.ts linguist-vendored=yes",
      "src/unsure.ts linguist-vendored=unset",
      "",
    ].join("\n"),
  ]) {
    const revision = repo.commit({
      ...FILES,
      ".gitattributes": attributes === "" ? "# none\n" : attributes,
    });
    const declarations = await declarationsAt(repo.repository, revision, PATHS);
    const marked = Object.keys(linguistOf(declarations.byPath)).sort();
    // The hunks carry the reader's suggestions, as the range manifest's do.
    const hunks = PATHS.flatMap((path) =>
      diff(path, before[path]!, FILES[path as keyof typeof FILES]).map(
        (hunk) => ({
          ...hunk,
          oldOid: repo.blobOf(before[path]!),
          newOid: repo.blobOf(FILES[path as keyof typeof FILES]),
          declared: [...(declarations.byPath.get(path) ?? [])].filter(
            (entry) => entry.standard !== undefined,
          ),
        }),
      ),
    );
    const stored = await storedRulesIn(
      "one-decision-store",
      repo.repository,
      revision,
      hunks,
    );
    const generated = stored.rules.filter(
      (judgement) => judgement.rule === "generated",
    );
    const held = [
      ...new Set(
        generated.filter(heldByLists).map((judgement) => judgement.about.path),
      ),
    ].sort();
    expect(marked).toEqual(held);
    expect(marked.length).toBeGreaterThan(0);
    // The reader's suggestions are never the rule's declared readers.
    for (const judgement of generated)
      expect(
        (judgement.inputs as { declared?: ReadonlyArray<string> }).declared ??
          [],
      ).toEqual([]);
  }
}, 240_000);

// --- Well-known control files (the owner's ruling of 13 November 2026, amending 14.18) ---------

// A VCR cassette's last line but one: Linguist's generated list marks such a `.yml` (`vcr_cassette?`).
const VCR = "---\nhttp_interactions: []\nrecorded_with: VCR 6.0.0\n";

/** Each kept file, with the entry that keeps it; each near miss, with the pattern that excludes it. */
const KEPT = {
  ".github/workflows/ci.yml": "github-actions-workflow",
  ".github/workflows/cassette.yaml": "github-actions-workflow",
  ".github/workflows/recorded.yml": "github-actions-workflow",
  Jenkinsfile: "jenkins-pipeline",
  ".teamcity/settings.kts": "teamcity-versioned-settings",
  ".gitmodules": "git-submodules",
  ".gitignore": "git-ignore",
  "sub/.gitignore": "git-ignore",
  "sub/.gitattributes": "git-attributes",
} as const;
const NEAR_MISSES = {
  ".github/workflows/sub/x.yml": "linguist v9.7.0 vendored: (^|/)\\.github/",
  "docs/.github/workflows/x.yml": "linguist v9.7.0 vendored: (^|/)\\.github/",
  ".github/dependabot.yml": "linguist v9.7.0 vendored: (^|/)\\.github/",
  ".github/workflows/x.json": "linguist v9.7.0 vendored: (^|/)\\.github/",
  "ci/Jenkinsfile": "linguist v9.7.0 vendored: (^|/)Jenkinsfile$",
  "sub/.gitmodules": "linguist v9.7.0 vendored: (^|/)\\.gitmodules$",
  "sub/.teamcity/x.kts": "linguist v9.7.0 vendored: (^|/)\\.teamcity/",
} as const;
const CONTROL_TEXT = "one\n";
const controlFiles = (): Record<string, string> =>
  Object.fromEntries(
    [...Object.keys(KEPT), ...Object.keys(NEAR_MISSES), ".teamcity2/x.kts"].map(
      (path) => [
        path,
        path === ".github/workflows/recorded.yml" ? VCR : CONTROL_TEXT,
      ],
    ),
  );

test("control files: the list is the six pinned entries and its recipe, which the manifest's Linguist recipe and the rule's version carry", () => {
  // Why: a change to the list must change every key that rests on it.
  expect(CONTROL_FILES.map((entry) => entry.id)).toEqual([
    "github-actions-workflow",
    "jenkins-pipeline",
    "teamcity-versioned-settings",
    "git-submodules",
    "git-ignore",
    "git-attributes",
  ]);
  expect(CONTROL_FILES_RECIPE).toBe(
    "neuve-control-files:sha256:5a04c6eefa35741f7f4f33904dd6d41b9b194da46b6ed22234b23018372022b6",
  );
  expect(LINGUIST_READER_RECIPE.controlFiles).toBe(CONTROL_FILES_RECIPE);
  expect(SECTION_RULE_VERSIONS.generated).toBe(6);
});

test("control files: the generated list can mark one (a VCR cassette as a workflow), and the keep covers both lists; the decision's result carries the entry", () => {
  // Why: the keep applies whatever rule marks the file, and the record says why per file.
  const path = ".github/workflows/recorded.yml";
  const mark = linguistMarkOf(path, new TextEncoder().encode(VCR));
  expect(mark?.generated?.rule).toBe("vcr_cassette?");
  expect(mark?.vendored?.pattern).toBe("(^|/)\\.github/");
  expect(
    linguistListMarks({ attributes: allUnspecified(), mark }, path),
  ).toEqual({
    marks: [],
    kept: {
      entry: "github-actions-workflow",
      by: "kept: control file (github-actions-workflow)",
      lists: [
        { standard: "linguist-generated", match: "vcr_cassette?" },
        { standard: "linguist-vendored", match: "(^|/)\\.github/" },
      ],
    },
  });
  // A near miss is marked and not kept.
  const near = linguistListMarks(
    {
      attributes: allUnspecified(),
      mark: linguistMarkOf(".github/workflows/sub/x.yml"),
    },
    ".github/workflows/sub/x.yml",
  );
  expect([near.marks.length, near.kept]).toEqual([1, null]);
});

test("control files: each entry keeps a file the lists mark, each near miss stays excluded, and the rule run on the same commit agrees on every one", async () => {
  // Why: the owner's list must be exactly what is kept, and the reader and the rule stay one decision.
  const repo = scratchRepository("control-files");
  const files = controlFiles();
  const before = Object.fromEntries(
    Object.keys(files).map((path) => [path, "zero\n"]),
  );
  repo.commit({ ...before, ".gitattributes": "# none\n" });
  const revision = repo.commit({ ...files, ".gitattributes": "# none\n" });
  const paths = Object.keys(files);
  const declarations = await declarationsAt(repo.repository, revision, paths);
  const marked = linguistOf(declarations.byPath);
  // The kept files get no suggestion; each near miss is excluded by its pattern; `.teamcity2/` is
  // marked by nothing.
  expect(Object.keys(marked).sort()).toEqual(Object.keys(NEAR_MISSES).sort());
  for (const [path, by] of Object.entries(NEAR_MISSES))
    expect(marked[path]).toEqual([["linguist-vendored", by]]);
  const hunks = paths.flatMap((path) =>
    diff(path, before[path]!, files[path]!).map((hunk) => ({
      ...hunk,
      oldOid: repo.blobOf(before[path]!),
      newOid: repo.blobOf(files[path]!),
      declared: [...(declarations.byPath.get(path) ?? [])],
    })),
  );
  const stored = await storedRulesIn(
    "control-files-store",
    repo.repository,
    revision,
    hunks,
  );
  const generated = new Map(
    stored.rules
      .filter((judgement) => judgement.rule === "generated")
      .map((judgement) => [judgement.about.path, judgement]),
  );
  for (const [path, entry] of Object.entries(KEPT)) {
    const judgement = generated.get(path);
    expect([path, judgement?.result, judgement?.reason]).toEqual([
      path,
      "not-held",
      "control-file",
    ]);
    expect(judgement?.inputs.kept).toEqual({
      entry,
      by: `kept: control file (${entry})`,
    });
  }
  for (const path of Object.keys(NEAR_MISSES))
    expect([path, generated.get(path)?.result]).toEqual([path, "holds"]);
  expect(generated.get(".teamcity2/x.kts")).toBeUndefined();
  // One decision: the reader's marks are the rule's holdings by the lists.
  const held = [...generated.values()]
    .filter(heldByLists)
    .map((judgement) => judgement.about.path)
    .sort();
  expect(Object.keys(marked).sort()).toEqual(held);
}, 240_000);

test("control files: the repository still wins: an attribute set marks a control file; one that unmarks it changes nothing (it stays read)", async () => {
  // Why: the repository's own declaration is not the lists, so the keep never overrides it.
  const repo = scratchRepository("control-attributes");
  const before = { ".gitignore": "zero\n", ".gitmodules": "zero\n" };
  repo.commit({ ...before, ".gitattributes": "# none\n" });
  const revision = repo.commit({
    ".gitignore": CONTROL_TEXT,
    ".gitmodules": CONTROL_TEXT,
    ".gitattributes":
      ".gitignore linguist-vendored\n.gitmodules -linguist-vendored\n",
  });
  const paths = [".gitignore", ".gitmodules"];
  const declarations = await declarationsAt(repo.repository, revision, paths);
  expect(linguistOf(declarations.byPath)).toEqual({
    ".gitignore": [
      [
        "linguist-vendored",
        "linguist v9.7.0 vendored: gitattributes: linguist-vendored=set",
      ],
    ],
  });
  const hunks = paths.flatMap((path) =>
    diff(path, before[path as keyof typeof before], CONTROL_TEXT).map(
      (hunk) => ({
        ...hunk,
        oldOid: repo.blobOf(before[path as keyof typeof before]),
        newOid: repo.blobOf(CONTROL_TEXT),
      }),
    ),
  );
  const stored = await storedRulesIn(
    "control-attributes-store",
    repo.repository,
    revision,
    hunks,
  );
  const outcome = (path: string) => {
    const judgement = stored.rules.find(
      (entry) => entry.rule === "generated" && entry.about.path === path,
    );
    return [judgement?.result, judgement?.reason];
  };
  expect(outcome(".gitignore")).toEqual(["holds", null]);
  // Not held either way: the repository's word is read first, as for any file.
  expect(outcome(".gitmodules")).toEqual([
    "not-held",
    "repository-declares-not-vendored",
  ]);
}, 240_000);
