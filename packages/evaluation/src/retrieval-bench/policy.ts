import { createHash } from "node:crypto";

/**
 * The B1 selection and index rules as data, so the manifest can record exactly what produced it.
 * File formats appear here only to exclude documents, data, lockfiles and generated output from the
 * changed-line count, as the accepted proposal's window rule requires (section 2). No programming
 * language is selected or excluded: every text file counts as code unless it is one of those.
 */

export const SEED = "neuve-m4-b1-2026-10-17";

export const CORPORA = {
  neuve_effect: {
    role: "primary",
    /** Pinned so a rerun reads the same history even if the repository moves on. */
    head: "b5a1cde916c56eaea0a5b4e362c213b94a43b6ba",
    rangeTarget: 35,
  },
  neuve: {
    role: "secondary",
    /** Bases and heads at or before this commit (proposal, benchmark self-leakage). */
    head: "3ea3659b961923f9777d9f59b03f52aaa8ba31be",
    rangeTarget: 15,
  },
} as const;
export type CorpusKey = keyof typeof CORPORA;

export const WINDOW = { min: 1, max: 1500 } as const;
export const SIZE = { S: 50, M: 300 } as const;
export const FAMILY_CAP = 4;
export const HUNKS_PER_RANGE = 4;
export const DEV_FRACTION = 1 / 3;
export const RUN_MAX_COMMITS = 8;

/**
 * 9.24: strata quotas, filled first. Each category's quota is this number per corpus, capped by the
 * number of families in the eligible pool that have a range in the category, so it stays reachable.
 */
export const STRATA_QUOTA: Readonly<Record<"neuve_effect" | "neuve", number>> =
  {
    neuve_effect: 4,
    neuve: 2,
  };
export const STRATA_CATEGORIES = [
  "changeType:fix",
  "changeType:test-adding",
  "scopeSource:plan-at-base",
  "scopeSource:plan-in-range",
  "scopeSource:commit-text",
  "scopeSource:none",
  "kind:direct",
] as const;

/**
 * PROVISIONAL, pending the owner's confirmation of the merged HCP family (coordinator, 17 October
 * 2026): the forced-dev family holding the Graph tuning ranges may give up to this many dev cases,
 * chosen by the same strata rule and added beyond the corpus target. Set it to 1 to revert.
 */
export const MERGED_HCP_FAMILY_DEV_CASES = 8;
/**
 * 9.29: a scope document touched by at least this many raw (pre-join) families, counted over the
 * eligible-or-not commit history, is a hub and joins nothing. Handover directories always join
 * (9.28, 9.29: "feature-specific plans and handover directories still join").
 */
export const HUB_FAMILY_THRESHOLD = 4;
/** 9.26: corpora whose families are also joined through shared scope plan documents. */
export const JOIN_ON_SCOPE_DOCS: ReadonlyArray<CorpusKey> = ["neuve"];

/**
 * 9.17, 9.23, 9.27: real share = max(minimum, window × working share × hunk changed lines ÷ range
 * review lines), where review lines are every changed line except generated files and lockfiles.
 */
export const REAL_SHARE = {
  formula:
    "max(minimum, floor(window × workingShare × hunkChangedLines ÷ rangeReviewLines))",
  denominator:
    "rangeReviewLines: every changed line (added plus deleted) the harness would review, documents and data included, excluding generated files (by path or content marker), lockfiles, binary files, Pen design files (encrypted, not reviewable as text) and benchmark paths (9.27)",
  minimum: 4_000,
  minimumStatus: "9.23: applied after the 9.17 share, for Opus and Sol",
  workingShare: 0.5,
  workingShareStatus: "pre-registered; re-read when M3 fixes it (9.17)",
  windows: { opus: 1_000_000, sol: 475_000 },
} as const;

const DOC_OR_DATA =
  /\.(md|mdx|mdc|markdown|rst|txt|adoc|json|jsonc|json5|jsonl|ndjson|ya?ml|toml|ini|csv|tsv|log|lock|snap|patch|diff|base64|pen|svg|png|jpe?g|gif|ico|webp|avif|bmp|woff2?|ttf|otf|eot|pdf|gz|zip|tgz|mp4|webm|mov|mp3|wav|sha1|sha256|sha512|md5|sum|sig|asc)$/i;
/** Extensionless checksum, manifest and notice files are data, not code. */
const DATA_NAME =
  /(^|\/)(SHA\d*SUMS|MD5SUMS|CHECKSUMS?|MANIFEST|LICEN[CS]E|NOTICE|AUTHORS|CONTRIBUTORS|CODEOWNERS|CHANGELOG|README|COPYING|VERSION)$/i;
const LOCKFILE =
  /(^|\/)(bun\.lockb?|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock|Gemfile\.lock|composer\.lock)$/;
const MIGRATION = /(^|\/)(migrations?|drizzle)\//i;
const GENERATED =
  /(^|\/)(dist|build|out|\.output|\.next|node_modules|vendor|__generated__|_generated|generated|design-export)\/|(^|\/)meta\/(_journal|\d+_snapshot)\.json$|\.gen\.[^/]+$|\.min\.[^/]+$|\.map$/i;
/** Dotfiles without an extension (.gitignore, .gitmodules, .prettierrc, .editorconfig) and .env files. */
const DOTFILE_ONLY = /(^|\/)\.[^/.]+$|(^|\/)\.env[^/]*$/;
/** Extensionless files under an evidence directory are captured output, not code. */
const EVIDENCE_DATA = /(^|\/)evidence\/(?:[^/]+\/)*[^/.]+$/;
/** 9.27: not reviewable as text, so excluded from the share denominator like binary files. */
export const NOT_REVIEWABLE = /\.pen$/i;
const BUILD =
  /(^|\/)(Dockerfile[^/]*|docker-compose[^/]*|Makefile|\.github\/.*|\.circleci\/.*|[^/]*\.config\.[cm]?[jt]s|vercel\.json|turbo\.json|nitro\.config[^/]*)$/i;
const TEST = /(^|\/)(__tests__|tests?)\/|[._-](test|spec)\.[^./]+$/i;

/** Markdown for documentation classes; documents are never counted as code lines. */
export const DOC = /\.(md|mdx|mdc|markdown)$/i;
/** Scope sources (decision 1.8, 9.13): plans, tickets, task briefs, proposals and decision records. */
const SCOPE_DOC =
  /(^|\/)(plans?|prompts|tasks?|briefs?|decisions?|proposals?|process)\/|(^|[/_-])(plan|proposal|brief|dispatch|decisions?|spec|task-[^/]*|round-\d+[^/]*|prd|rfc)[^/]*\.(md|mdx|mdc|markdown)$/i;
/** Hindsight: diaries, reviews, audits, research and analysis written during or after a change. */
const HINDSIGHT_DOC =
  /(^|\/)(diary|diaries|reviews?|audits?|research|analysis|evidence|findings)\/|(^|[/_-])(diary|review|audit|retro|postmortem|findings|summary|report)[^/]*\.(md|mdx|mdc|markdown)$/i;
const HANDOVER_DIR = /^docs\/handovers?\/([^/]+)\//;

export const BENCHMARK_PATHS = [
  "validation/benchmarks/",
  "packages/evaluation/src/retrieval-bench/",
] as const;

/** Files the external suite tuned the Graph fork's ranking on (proposal, leakage rules). */
export const GRAPH_TUNED_FILES = [
  "apps/embeds/server/services/browsing-session.service.ts",
  "apps/embeds/server/services/browsing-agent-loop.ts",
  "apps/embeds/server/services/runner-loop-kernel.ts",
  "apps/browser-service/server/services/agent-browser-executor.service.ts",
  "apps/browser-service/server/services/agent-browser-runner-adapter.service.ts",
] as const;
/** The external suite's three tuning ranges, named by their head commits (proposal, leakage rules). */
export const GRAPH_TUNING_HEADS = [
  "a75644f83d6cec8e8555caddbce6d363861db05d",
  "51961d1a055ea01ae1a6e331957481d10dc8ceaa",
  "6e98e699a32109c1c5b2e64ebbfe3d41f0ec455b",
] as const;
/** Files seen by the phase 2 adapters; Neuve ranges touching them are dev only. */
export const PHASE2_FILES = [
  "scripts/setup-graph-workspace.ts",
  "scripts/install-cli-local.ts",
  "apps/neuve-cli/scripts/install-local.ts",
] as const;
/** The single dev stress case (proposal, section 2), exempt from the window and the cap. */
export const STRESS_COMMITS = {
  neuve: ["8b430f6531d5c621f2ed217b1b485dc40d7aa9b5"],
} as const;

export type FileClass =
  "code" | "doc" | "data" | "lockfile" | "migration" | "generated" | "dotfile";

export const classifyPath = (path: string): FileClass => {
  if (LOCKFILE.test(path)) return "lockfile";
  if (GENERATED.test(path)) return "generated";
  if (DOC.test(path)) return "doc";
  if (
    DOC_OR_DATA.test(path) ||
    DATA_NAME.test(path) ||
    EVIDENCE_DATA.test(path)
  )
    return "data";
  if (MIGRATION.test(path)) return "migration";
  if (DOTFILE_ONLY.test(path)) return "dotfile";
  return "code";
};

/** Code-point order, so every sort that shapes output is independent of locale. */
/** The index policy's generated marker, tested on a blob's first scan bytes. */
export const hasGeneratedMarker = (bytes: Uint8Array) =>
  INDEX_POLICY.generatedMarker.test(
    new TextDecoder().decode(
      bytes.subarray(0, INDEX_POLICY.generatedMarkerScanBytes),
    ),
  );

export const byCodepoint = (a: string, b: string) =>
  a < b ? -1 : a > b ? 1 : 0;

export const isBenchmarkPath = (path: string) =>
  BENCHMARK_PATHS.some((prefix) => path.startsWith(prefix));
export const isBuildFile = (path: string) => BUILD.test(path);
export const isTestFile = (path: string) => TEST.test(path);
export const isTunedFile = (path: string) =>
  (GRAPH_TUNED_FILES as ReadonlyArray<string>).includes(path);
export const isPhase2File = (path: string) =>
  (PHASE2_FILES as ReadonlyArray<string>).includes(path);

export type DocClass = "scope" | "hindsight" | "other";
/** Hindsight wins over scope: a review of a plan is hindsight. */
export const classifyDoc = (path: string): DocClass =>
  HINDSIGHT_DOC.test(path)
    ? "hindsight"
    : SCOPE_DOC.test(path)
      ? "scope"
      : "other";
export const handoverDir = (path: string) => HANDOVER_DIR.exec(path)?.[1];

/** The workspace package a path belongs to: `apps/x`, `packages/x`, or a nested `apps/x/packages/y`. */
export const areaOf = (path: string) => {
  const parts = path.split("/");
  if (parts.length < 2) return "(root)";
  if (parts[0] === "apps" || parts[0] === "packages") {
    if (parts.length > 3 && (parts[2] === "apps" || parts[2] === "packages"))
      return parts.slice(0, 4).join("/");
    return parts.slice(0, 2).join("/");
  }
  return parts[0] ?? "(root)";
};

/** Index policy: what enters a base view. Content checks run on the blob itself. */
export const INDEX_POLICY = {
  id: "neuve-bench-index-v1",
  maxFileBytes: 1_048_576,
  maxLineBytes: 10_000,
  maxMeanLineBytes: 1_000,
  generatedMarker:
    /@generated|do not edit|auto-?generated|automatically generated/i,
  generatedMarkerScanBytes: 1_024,
} as const;

/**
 * A hash of every path and content rule, part of every chunk and view computation key, so editing a
 * rule can never reuse results computed under the old one (5.4).
 */
export const POLICY_HASH = createHash("sha256")
  .update(
    JSON.stringify({
      docOrData: DOC_OR_DATA.source,
      dataName: DATA_NAME.source,
      lockfile: LOCKFILE.source,
      migration: MIGRATION.source,
      generated: GENERATED.source,
      dotfile: DOTFILE_ONLY.source,
      evidenceData: EVIDENCE_DATA.source,
      notReviewable: NOT_REVIEWABLE.source,
      doc: DOC.source,
      benchmarkPaths: BENCHMARK_PATHS,
      hubFamilyThreshold: HUB_FAMILY_THRESHOLD,
      index: {
        ...INDEX_POLICY,
        generatedMarker: INDEX_POLICY.generatedMarker.source,
      },
    }),
  )
  .digest("hex");

/** The rules, as text, for the manifest and for review. */
export const RULES = {
  window: `${WINDOW.min}–${WINDOW.max} changed code lines (added plus deleted, git numstat with rename detection), tests included`,
  codeLines:
    "every changed text file counts except documents and data formats, lockfiles, migrations, generated paths and dotfiles; binary files never count",
  docOrData: DOC_OR_DATA.source,
  dataName: DATA_NAME.source,
  lockfile: LOCKFILE.source,
  migration: MIGRATION.source,
  generated: GENERATED.source,
  dotfile: DOTFILE_ONLY.source,
  evidenceData: EVIDENCE_DATA.source,
  generatedContent:
    "a changed file is also generated when its blob carries the index policy's generated marker in its first scan bytes; selection and the index use the same check",
  notReviewable: NOT_REVIEWABLE.source,
  build: BUILD.source,
  test: TEST.source,
  scopeDoc: SCOPE_DOC.source,
  hindsightDoc: HINDSIGHT_DOC.source,
  exclusions:
    "docs-only (no code lines), build-only (every counted file matches the build pattern) and over-window ranges; the stress case is kept as dev only",
  size: `S under ${SIZE.S}, M ${SIZE.S}–${SIZE.M}, L above ${SIZE.M} changed code lines`,
  ranges: [
    "merge: each first-parent PR merge M with two parents gives M^1..M",
    "slice: a PR whose merge range is over the window is cut into runs of its own first-parent commits (run rule below), each prevRunEnd..runEnd",
    "run: consecutive commits with the same run key form one run, closed after a docs(handover) commit and capped at 8 commits; documentation-only commits join the open run; the key is the single docs/handover/<dir> a commit touches, else its conventional-commit scope, else the commit itself",
    "direct: first-parent non-merge commits are cut into runs the same way; merges break runs",
  ],
  family: [
    "a PR's merge and slices: the PR branch name from the merge subject",
    "a direct run: the single docs/handover/<dir> its commits touch, else the workspace area holding most of its code lines (coarse on purpose: commit scopes fragment one feature across families that would straddle the split)",
    "the stress case is its own family",
    "this repository's families also join through a shared scope plan document (9.26); a run with no code lines is never a case and gets its own family, so documentation-only runs are not pooled",
    `9.29: a scope document touched by ${HUB_FAMILY_THRESHOLD} or more raw families (pre-join, eligible or not, documentation-only runs counted as their own families) is a hub and joins nothing; handover directories always join (9.28); hubs are listed in the summary`,
    "families joined through a shared docs/handover/<dir> merge (union-find over every family's commits, eligible or not) before selection and the split; the merged family is named by its first member in branch, handover, area, then code-point order",
  ],
  changeType:
    "test-adding when test files carry at least 60% of code lines; else fix when any commit in the range is a fix (by the type rules below); else docs-plus-code when non-hindsight Markdown lines in documents that still exist at the head reach 50% of code lines; otherwise the commit type weighted by code lines (feat → feature, fix → fix, refactor/perf/chore/style/build → refactor, test → test-adding, docs → docs-plus-code); unconventional subjects map by their first word (fix, correct, repair, resolve, guard, prevent, restore, handle → fix; refactor, move, extract, rename, simplify, split, consolidate, remove, drop, delete, clean, tidy, unify, collapse, replace, migrate → refactor; anything else → feature); ties go to the earliest commit",
  scopeSource:
    "plan-at-base when a scope document exists at the base in a docs/handover/<dir> that the family touches, or was touched by an earlier commit of the same family that is not one of the range's own commits, or is edited by the range; else plan-in-range when the range adds or edits a scope document; else commit-text when any commit has a subject of at least four words or a body; else none (9.13)",
  area: "the workspace area (apps/x, packages/x, apps/x/packages/y) holding most of the range's code lines",
  cap: `at most ${FAMILY_CAP} ranges per family (the provisional MERGED_HCP_FAMILY_DEV_CASES setting lifts this for the HCP dev family)`,
  selection:
    "9.24, per corpus: (1) quotas first, in category order; for each category, while fewer chosen ranges are in it than its quota, take the first range in seeded order that is in the category from a family not yet chosen, else from a chosen family under the cap; (2) then one range per unchosen family, families in seeded order, each family's ranges in seeded order, until the corpus target; (3) then further rounds of one more range per family under the cap; (4) the HCP dev family then gets extra ranges up to MERGED_HCP_FAMILY_DEV_CASES by the same quota rule within the family, beyond the target; the proposal's example ranges are not force-included (9.25)",
  period: "the UTC year and quarter of the head commit's committer date",
  split:
    "family-grouped: forced-dev families first, then per corpus the remaining selected families ordered by the sorted strata categories of their chosen ranges and a seeded hash, and every k-th one goes to dev so that dev holds one third of the corpus's families",
  forcedDev: [
    "the family holding the Graph tuning ranges (a75644f8, 51961d1a, 6e98e699): the HCP harness-consolidation work, with every family merged into it",
    "Neuve families with a range touching a phase 2 training file",
    "the stress case",
  ],
  hunks: `up to ${HUNKS_PER_RANGE} hunks per range from counted code files: one per file in order of the file's changed lines (then path), the largest hunk first, then further hunks round-robin when fewer than ${HUNKS_PER_RANGE} files changed; build files (the build pattern) are never picked, though their lines still count toward the range`,
  adjacency: [
    "graph-tuning-adjacent: a case whose merged family shares a hub (a handover directory or scope document filtered out of the joins by 9.29) with a merged family holding a Graph-tuning range; the G-fork vs G-base comparison excludes these whole cases, as well as tuned-file hunks everywhere",
    "adapter-training-adjacent: a case whose merged family shares a hub with a merged family holding a range that touches a phase 2 training file; the E1 vs E0 comparison excludes these whole cases",
    "both are decided at family level from the eligible-or-not commit history, for every case; only held-out cases matter for the comparisons",
  ],
  tuned:
    "a hunk is tagged when its file is a Graph-tuned file; gold in tuned files is tagged at labelling (B3)",
  inRangeDocs:
    "documents added or edited in the range are listed with their class; scope documents may be read by the scope stage; hindsight documents only by labellers; neither is indexed",
} as const;
