import { createHash } from "node:crypto";
import { Effect } from "effect";
import {
  commits,
  gitText,
  numstat,
  parseNumstatZ,
  pathsAt,
  readBlobs,
  type CommitInfo,
  type NumstatEntry,
} from "./git.ts";
import {
  CORPORA,
  DEV_FRACTION,
  FAMILY_CAP,
  HUB_FAMILY_THRESHOLD,
  JOIN_ON_SCOPE_DOCS,
  NOT_REVIEWABLE,
  hasGeneratedMarker,
  MERGED_HCP_FAMILY_DEV_CASES,
  STRATA_CATEGORIES,
  STRATA_QUOTA,
  GRAPH_TUNING_HEADS,
  RUN_MAX_COMMITS,
  SEED,
  SIZE,
  STRESS_COMMITS,
  WINDOW,
  areaOf,
  byCodepoint,
  classifyDoc,
  classifyPath,
  handoverDir,
  isBenchmarkPath,
  isBuildFile,
  isPhase2File,
  isTestFile,
  isTunedFile,
  type CorpusKey,
} from "./policy.ts";

export type RangeKind = "merge" | "slice" | "direct" | "stress";
export type ChangeType =
  "feature" | "fix" | "refactor" | "test-adding" | "docs-plus-code";
export type SizeClass = "S" | "M" | "L";
export type ScopeSource =
  "plan-at-base" | "plan-in-range" | "commit-text" | "none";
export type Exclusion = "docs-only" | "build-only" | "over-window";

/** Seeded order: the same seed and keys always sort the same way. */
export const seeded = (key: string) =>
  createHash("sha256").update(`${SEED}\u0000${key}`).digest("hex");

interface CommitChanges {
  readonly paths: ReadonlyArray<string>;
  readonly codeLines: number;
}

interface Candidate {
  readonly corpus: CorpusKey;
  readonly kind: RangeKind;
  readonly base: string;
  readonly head: string;
  /** Oldest first. */
  readonly commits: ReadonlyArray<CommitInfo>;
  readonly family: string;
  /** Global position of the first commit, oldest first, so "earlier in the family" is decidable. */
  readonly order: number;
}

export interface InRangeDoc {
  readonly path: string;
  readonly class: "scope" | "hindsight" | "other";
  readonly status: "added" | "edited" | "deleted";
}

export interface Range {
  readonly id: string;
  readonly corpus: CorpusKey;
  readonly kind: RangeKind;
  readonly base: string;
  readonly head: string;
  readonly commits: ReadonlyArray<string>;
  readonly subjects: ReadonlyArray<string>;
  readonly family: string;
  readonly changedLines: number;
  /** 9.27: the share denominator, every reviewable changed line (documents included). */
  readonly reviewLines: number;
  /** Review lines in data files (JSON, YAML and the like). */
  readonly dataLines: number;
  /** Year and quarter of the head commit (UTC committer date). */
  readonly period: string;
  readonly codeFiles: ReadonlyArray<string>;
  /** Code paths on both sides of a rename, so a path-limited diff still detects the rename. */
  readonly diffPaths: ReadonlyArray<string>;
  readonly strata: {
    readonly changeType: ChangeType;
    readonly size: SizeClass;
    readonly scopeSource: ScopeSource;
    readonly area: string;
  };
  readonly scopeDocsAtBase: ReadonlyArray<string>;
  readonly inRangeDocs: ReadonlyArray<InRangeDoc>;
  readonly tunedFiles: ReadonlyArray<string>;
  readonly phase2Files: ReadonlyArray<string>;
  readonly graphTuningRange: boolean;
  /**
   * Case-level leakage tags: `graph-tuning-adjacent` or `adapter-training-adjacent` when the case's
   * family shares a hub document with a family holding a Graph-tuning or phase 2 training range.
   */
  readonly leakageTags: ReadonlyArray<string>;
}

/**
 * Blobs whose content carries the generated marker, so selection and the index agree. Keyed by blob
 * OID (content), so the cache is the same whatever order candidates are read in.
 */
const markedGenerated = new Set<string>();
const checkedBlobs = new Set<string>();

/** Reads the not-yet-checked code blobs of `entries` and records the ones marked generated. */
const markGenerated = (
  repository: string,
  entries: ReadonlyArray<NumstatEntry>,
) =>
  Effect.gen(function* () {
    const oids = [
      ...new Set(
        entries
          .filter(
            (entry) =>
              !entry.binary &&
              entry.oid !== undefined &&
              classifyPath(entry.path) === "code",
          )
          .map((entry) => entry.oid!),
      ),
    ].filter((oid) => !checkedBlobs.has(oid));
    for (let start = 0; start < oids.length; start += 500) {
      const batch = oids.slice(start, start + 500);
      const blobs = yield* readBlobs(repository, batch);
      for (const oid of batch) {
        checkedBlobs.add(oid);
        const bytes = blobs.get(oid);
        if (bytes !== undefined && hasGeneratedMarker(bytes))
          markedGenerated.add(oid);
      }
    }
  });

const isMarkedGenerated = (entry: NumstatEntry) =>
  entry.oid !== undefined && markedGenerated.has(entry.oid);
const countsAsCode = (entry: NumstatEntry) =>
  !entry.binary &&
  !isBenchmarkPath(entry.path) &&
  classifyPath(entry.path) === "code" &&
  !isMarkedGenerated(entry);
const reviewable = (entry: NumstatEntry) => {
  const kind = classifyPath(entry.path);
  return (
    !entry.binary &&
    !isBenchmarkPath(entry.path) &&
    !NOT_REVIEWABLE.test(entry.path) &&
    kind !== "generated" &&
    kind !== "lockfile" &&
    !isMarkedGenerated(entry)
  );
};
/** 9.27: every changed line the harness would review. */
const reviewLinesOf = (entries: ReadonlyArray<NumstatEntry>) =>
  entries
    .filter(reviewable)
    .reduce((sum, entry) => sum + entry.added + entry.deleted, 0);
/** Reviewable lines in data files, to flag cases whose denominator is mostly data. */
export const dataLinesOf = (entries: ReadonlyArray<NumstatEntry>) =>
  entries
    .filter((entry) => reviewable(entry) && classifyPath(entry.path) === "data")
    .reduce((sum, entry) => sum + entry.added + entry.deleted, 0);
const codeLinesOf = (entries: ReadonlyArray<NumstatEntry>) =>
  entries
    .filter(countsAsCode)
    .reduce((sum, entry) => sum + entry.added + entry.deleted, 0);

/** Per-commit touched paths and code lines for every non-merge commit reachable from `head`. */
const commitChanges = (repository: string, head: string) =>
  Effect.flatMap(
    gitText(repository, [
      "log",
      "-z",
      "--raw",
      "--no-abbrev",
      "--numstat",
      "-M",
      "--ignore-submodules=all",
      "--no-merges",
      "--format=\u001e%H",
      head,
    ]),
    (out) =>
      Effect.gen(function* () {
        const perCommit = new Map<string, ReadonlyArray<NumstatEntry>>();
        for (const record of out.split("\u001e")) {
          const end = record.indexOf("\0");
          const sha = (end === -1 ? record : record.slice(0, end)).trim();
          if (!sha) continue;
          perCommit.set(
            sha,
            end === -1 ? [] : parseNumstatZ(record.slice(end + 1)),
          );
        }
        yield* markGenerated(repository, [...perCommit.values()].flat());
        const changes = new Map<string, CommitChanges>();
        for (const [sha, entries] of perCommit)
          changes.set(sha, {
            paths: entries.flatMap((entry) =>
              entry.from === undefined
                ? [entry.path]
                : [entry.from, entry.path],
            ),
            codeLines: codeLinesOf(entries),
          });
        return changes;
      }),
  );

const scopeOf = (subject: string) =>
  /^[a-z]+(?:\(([^)]+)\))?!?:/i.exec(subject)?.[1]?.toLowerCase();
const handoverDirsOf = (paths: ReadonlyArray<string>) =>
  [
    ...new Set(
      paths.map(handoverDir).filter((dir): dir is string => dir !== undefined),
    ),
  ].sort();

/**
 * Cuts a linear commit list (oldest first) into runs. Merges break runs and never sit inside one.
 * Documentation-only commits join the open run; a run closes after a `docs(handover)` commit, when
 * the next code commit has another key, or at the commit cap.
 */
const segment = (
  list: ReadonlyArray<CommitInfo>,
  changes: ReadonlyMap<string, CommitChanges>,
) => {
  const runs: Array<{ base: string; commits: Array<CommitInfo> }> = [];
  let open:
    | { base: string; commits: Array<CommitInfo>; key: string | undefined }
    | undefined;
  const close = () => {
    if (open !== undefined)
      runs.push({ base: open.base, commits: open.commits });
    open = undefined;
  };
  for (const commit of list) {
    if (commit.parents.length !== 1) {
      close();
      continue;
    }
    const change = changes.get(commit.sha) ?? { paths: [], codeLines: 0 };
    const dirs = handoverDirsOf(change.paths);
    const key =
      change.codeLines === 0
        ? undefined
        : dirs.length === 1
          ? `handover:${dirs[0]}`
          : (scopeOf(commit.subject) ?? `commit:${commit.sha}`);
    const joins =
      open !== undefined &&
      open.commits.length < RUN_MAX_COMMITS &&
      (key === undefined || open.key === undefined || open.key === key);
    if (!joins) {
      close();
      open = { base: commit.parents[0] ?? "", commits: [], key: undefined };
    }
    if (open === undefined) continue;
    open.commits.push(commit);
    open.key ??= key;
    if (/^docs\(handovers?\)/i.test(commit.subject)) close();
  }
  close();
  return runs;
};

const enumerate = (corpus: CorpusKey, repository: string) =>
  Effect.gen(function* () {
    const head = CORPORA[corpus].head;
    const changes = yield* commitChanges(repository, head);
    const firstParent = [
      ...(yield* commits(repository, ["--first-parent", head])),
    ].reverse();
    const order = new Map(
      firstParent.map((commit, index) => [commit.sha, index * 1000]),
    );
    const candidates: Array<Candidate> = [];
    const stress = new Set<string>(
      (STRESS_COMMITS as Record<string, ReadonlyArray<string>>)[corpus] ?? [],
    );
    let directs: Array<CommitInfo> = [];
    const flushDirect = () => {
      for (const run of segment(directs, changes)) {
        const first = run.commits[0];
        if (first === undefined) continue;
        candidates.push({
          corpus,
          kind: "direct",
          base: run.base,
          head: run.commits.at(-1)?.sha ?? "",
          commits: run.commits,
          family: "",
          order: order.get(first.sha) ?? 0,
        });
      }
      directs = [];
    };
    for (const commit of firstParent) {
      if (stress.has(commit.sha)) {
        flushDirect();
        candidates.push({
          corpus,
          kind: "stress",
          base: commit.parents[0] ?? "",
          head: commit.sha,
          commits: [commit],
          family: `${corpus}/stress`,
          order: order.get(commit.sha) ?? 0,
        });
        continue;
      }
      if (commit.parents.length === 0) continue;
      if (commit.parents.length === 1) {
        directs.push(commit);
        continue;
      }
      flushDirect();
      const branch =
        /Merge pull request #\d+ from [^/\s]+\/(\S+)/.exec(
          commit.subject,
        )?.[1] ??
        /Merge branch '([^']+)'/.exec(commit.subject)?.[1] ??
        `merge-${commit.sha.slice(0, 8)}`;
      const family = `${corpus}/branch:${branch}`;
      const [first, second] = commit.parents;
      if (first === undefined || second === undefined) continue;
      const inside = [
        ...(yield* commits(repository, [
          "--first-parent",
          second,
          "--not",
          first,
        ])),
      ].reverse();
      const at = order.get(commit.sha) ?? 0;
      candidates.push({
        corpus,
        kind: "merge",
        base: first,
        head: commit.sha,
        commits: inside,
        family,
        order: at,
      });
      for (const run of segment(inside, changes))
        candidates.push({
          corpus,
          kind: "slice",
          base: run.base,
          head: run.commits.at(-1)?.sha ?? "",
          commits: run.commits,
          family,
          order: at - 999 + inside.indexOf(run.commits[0]!),
        });
    }
    flushDirect();
    const dates = new Map(
      (yield* gitText(repository, ["log", "--format=%H %ct", head]))
        .trim()
        .split("\n")
        .map((line) => line.split(" ") as [string, string]),
    );
    return { candidates, changes, dates };
  });

const changeTypeOf = (
  range: Candidate,
  entries: ReadonlyArray<NumstatEntry>,
  changes: ReadonlyMap<string, CommitChanges>,
  docs: ReadonlyArray<InRangeDoc>,
): ChangeType => {
  const code = codeLinesOf(entries);
  const testLines = entries
    .filter((entry) => countsAsCode(entry) && isTestFile(entry.path))
    .reduce((sum, entry) => sum + entry.added + entry.deleted, 0);
  if (testLines >= 0.6 * code) return "test-adding";
  const weights = new Map<ChangeType, number>();
  const firstSeen = new Map<ChangeType, number>();
  range.commits.forEach((commit, index) => {
    const type = typeOfSubject(commit.subject);
    weights.set(
      type,
      (weights.get(type) ?? 0) + (changes.get(commit.sha)?.codeLines ?? 0),
    );
    if (!firstSeen.has(type)) firstSeen.set(type, index);
  });
  const weighted =
    [...weights.entries()].sort(
      (a, b) =>
        b[1] - a[1] || (firstSeen.get(a[0]) ?? 0) - (firstSeen.get(b[0]) ?? 0),
    )[0]?.[0] ?? "feature";
  // A fix keeps its type even when its code sits in another commit or docs dominate the range.
  if (range.commits.some((commit) => typeOfSubject(commit.subject) === "fix"))
    return "fix";
  // Documents that survive the range and are not hindsight; a deleted scratch file is not docs work.
  const kept = new Set(
    docs
      .filter((doc) => doc.status !== "deleted" && doc.class !== "hindsight")
      .map((doc) => doc.path),
  );
  const docLines = entries
    .filter((entry) => kept.has(entry.path))
    .reduce((sum, entry) => sum + entry.added + entry.deleted, 0);
  if (docLines >= 0.5 * code) return "docs-plus-code";
  return weighted;
};

const typeOfSubject = (subject: string): ChangeType => {
  const conventional = /^([a-z]+)(?:\([^)]*\))?!?:/i
    .exec(subject)?.[1]
    ?.toLowerCase();
  if (conventional !== undefined) {
    if (conventional === "fix" || conventional === "hotfix") return "fix";
    if (
      ["refactor", "perf", "chore", "style", "build", "ci"].includes(
        conventional,
      )
    )
      return "refactor";
    if (conventional === "test") return "test-adding";
    if (conventional === "docs") return "docs-plus-code";
    return "feature";
  }
  const word = subject.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (/^(fix|correct|repair|resolve|guard|prevent|restore|handle)/.test(word))
    return "fix";
  if (
    /^(refactor|move|extract|rename|simplify|split|consolidate|remove|drop|delete|clean|tidy|unify|collapse|replace|migrate)/.test(
      word,
    )
  )
    return "refactor";
  return "feature";
};

const sizeOf = (lines: number): SizeClass =>
  lines < SIZE.S ? "S" : lines <= SIZE.M ? "M" : "L";

/** Assigns families to direct runs: the handover directory they touch, else their dominant area. */
const directFamily = (
  candidate: Candidate,
  entries: ReadonlyArray<NumstatEntry>,
  changes: ReadonlyMap<string, CommitChanges>,
) => {
  for (const commit of candidate.commits) {
    const dirs = handoverDirsOf(changes.get(commit.sha)?.paths ?? []);
    if (dirs.length === 1) return `${candidate.corpus}/handover:${dirs[0]}`;
  }
  // A run with no code lines is never a case; it gets its own family so unrelated documentation
  // runs are not pooled into one pseudo-family that would join everything they touched.
  if (codeLinesOf(entries) === 0)
    return `${candidate.corpus}/docs-run:${candidate.head.slice(0, 12)}`;
  return `${candidate.corpus}/area:${dominantArea(entries)}`;
};

const dominantArea = (entries: ReadonlyArray<NumstatEntry>) => {
  const areas = new Map<string, number>();
  for (const entry of entries.filter(countsAsCode))
    areas.set(
      areaOf(entry.path),
      (areas.get(areaOf(entry.path)) ?? 0) + entry.added + entry.deleted,
    );
  return (
    [...areas.entries()].sort(
      (a, b) => b[1] - a[1] || byCodepoint(a[0], b[0]),
    )[0]?.[0] ?? "(none)"
  );
};

export interface Selection {
  readonly ranges: ReadonlyArray<Range>;
  readonly families: ReadonlyArray<{
    readonly id: string;
    readonly corpus: CorpusKey;
    readonly eligible: number;
    readonly selected: number;
    readonly split: "dev" | "held-out";
    readonly forcedDev: string | undefined;
    readonly members: ReadonlyArray<string>;
  }>;
  readonly quotas: Readonly<Record<CorpusKey, ReadonlyArray<QuotaRecord>>>;
  /** 9.29: link keys (`<corpus>/handover:<dir>` or `<corpus>/scope-doc:<path>`) that join nothing. */
  readonly hubs: ReadonlyArray<{
    readonly key: string;
    readonly families: number;
  }>;
  readonly excluded: Readonly<
    Record<
      CorpusKey,
      Readonly<
        Record<Exclusion | "superseded-by-merge" | "over-cap-or-target", number>
      >
    >
  >;
}

/** Selects the benchmark ranges from both corpora. Pure apart from read-only git calls. */
export const selectRanges = (
  repositories: Readonly<Record<CorpusKey, string>>,
) =>
  Effect.gen(function* () {
    const ranges: Array<Range & { readonly order: number }> = [];
    const familyCommits = new Map<
      string,
      Array<{ sha: string; order: number; paths: ReadonlyArray<string> }>
    >();
    const excluded = {} as Record<
      CorpusKey,
      Record<Exclusion | "superseded-by-merge" | "over-cap-or-target", number>
    >;
    for (const corpus of Object.keys(CORPORA) as Array<CorpusKey>) {
      const repository = repositories[corpus];
      const counts = {
        "docs-only": 0,
        "build-only": 0,
        "over-window": 0,
        "superseded-by-merge": 0,
        "over-cap-or-target": 0,
      };
      excluded[corpus] = counts;
      const { candidates, changes, dates } = yield* enumerate(
        corpus,
        repository,
      );
      const periodOf = (sha: string) => {
        const date = new Date(Number(dates.get(sha) ?? 0) * 1000);
        return `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
      };
      const evaluated: Array<{
        candidate: Candidate;
        entries: ReadonlyArray<NumstatEntry>;
        family: string;
        lines: number;
      }> = [];
      // Merges first, so a PR whose merge range fits the window is not also sliced.
      const ordered = [...candidates].sort(
        (a, b) => (a.kind === "merge" ? 0 : 1) - (b.kind === "merge" ? 0 : 1),
      );
      const stats = yield* Effect.forEach(
        ordered,
        (candidate) => numstat(repository, candidate.base, candidate.head),
        { concurrency: 8 },
      );
      yield* markGenerated(repository, stats.flat());
      for (const [index, candidate] of ordered.entries()) {
        const entries = stats[index] ?? [];
        const family =
          candidate.kind === "direct"
            ? directFamily(candidate, entries, changes)
            : candidate.family;
        for (const commit of candidate.commits) {
          const list = familyCommits.get(family) ?? [];
          list.push({
            sha: commit.sha,
            order: candidate.order,
            paths: changes.get(commit.sha)?.paths ?? [],
          });
          familyCommits.set(family, list);
        }
        const lines = codeLinesOf(entries);
        if (candidate.kind === "stress") {
          evaluated.push({ candidate, entries, family, lines });
          continue;
        }
        const exclusion: Exclusion | undefined =
          lines < WINDOW.min
            ? "docs-only"
            : lines > WINDOW.max
              ? "over-window"
              : entries
                    .filter(countsAsCode)
                    .every((entry) => isBuildFile(entry.path))
                ? "build-only"
                : undefined;
        if (
          candidate.kind === "slice" &&
          sliceSuperseded(candidate, evaluated)
        ) {
          counts["superseded-by-merge"]++;
          continue;
        }
        if (exclusion !== undefined) {
          counts[exclusion]++;
          continue;
        }
        evaluated.push({ candidate, entries, family, lines });
      }
      for (const { candidate, entries, family, lines } of evaluated) {
        const baseTree = yield* pathsAt(repository, candidate.base);
        const headTree = yield* pathsAt(repository, candidate.head);
        const docs: Array<InRangeDoc> = entries
          .filter((entry) => classifyPath(entry.path) === "doc")
          .map((entry) => ({
            path: entry.path,
            class: classifyDoc(entry.path),
            status: (!baseTree.has(entry.from ?? entry.path)
              ? "added"
              : headTree.has(entry.path)
                ? "edited"
                : "deleted") as InRangeDoc["status"],
          }))
          .sort((a, b) => byCodepoint(a.path, b.path));
        const codeFiles = entries
          .filter(countsAsCode)
          .map((entry) => entry.path)
          .sort();
        const touched = entries.flatMap((entry) =>
          entry.from === undefined ? [entry.path] : [entry.from, entry.path],
        );
        ranges.push({
          id: `${corpus}:${candidate.base.slice(0, 8)}..${candidate.head.slice(0, 8)}`,
          corpus,
          kind: candidate.kind,
          base: candidate.base,
          head: candidate.head,
          commits: candidate.commits
            .filter((commit) => commit.parents.length === 1)
            .map((commit) => commit.sha),
          subjects: candidate.commits
            .filter((commit) => commit.parents.length === 1)
            .map((commit) => commit.subject),
          family,
          changedLines: lines,
          reviewLines: reviewLinesOf(entries),
          dataLines: dataLinesOf(entries),
          period: periodOf(candidate.head),
          codeFiles,
          diffPaths: [
            ...new Set(
              entries
                .filter(countsAsCode)
                .flatMap((entry) =>
                  entry.from === undefined
                    ? [entry.path]
                    : [entry.from, entry.path],
                ),
            ),
          ].sort(),
          strata: {
            changeType: changeTypeOf(candidate, entries, changes, docs),
            size: sizeOf(lines),
            scopeSource: "none",
            area: dominantArea(entries),
          },
          scopeDocsAtBase: [],
          inRangeDocs: docs,
          tunedFiles: [...new Set(touched.filter(isTunedFile))].sort(),
          phase2Files: [...new Set(touched.filter(isPhase2File))].sort(),
          leakageTags: [],
          graphTuningRange: candidate.commits.some((commit) =>
            (GRAPH_TUNING_HEADS as ReadonlyArray<string>).includes(commit.sha),
          ),
          order: candidate.order,
        });
      }
    }
    // Families joined through a shared handover directory are one family (no straddling the split).
    const {
      names: merged,
      hubs,
      keysOf,
      hubKeys,
    } = mergeFamilies(familyCommits);
    // Hub documents filtered out of the joins can still sit beside tuned or training work. A case
    // whose (merged) family shares a hub with a family holding a Graph-tuning range, or a phase 2
    // training range, is tagged so the comparison that the exposure could bias excludes it whole.
    const hubsOfMerged = (target: string) =>
      new Set(
        [...merged.entries()]
          .filter(([, name]) => name === target)
          .flatMap(([raw]) => keysOf.get(raw) ?? [])
          .filter((key) => hubKeys.has(key)),
      );
    const exposedHubs = (exposed: (range: Range) => boolean) => {
      const families = new Set(
        ranges
          .filter(exposed)
          .map((range) => merged.get(range.family) ?? range.family),
      );
      return {
        families,
        hubs: new Set(
          [...families].flatMap((family) => [...hubsOfMerged(family)]),
        ),
      };
    };
    const tuning = exposedHubs((range) => range.graphTuningRange);
    const training = exposedHubs((range) => range.phase2Files.length > 0);
    const adjacency = (family: string) => {
      const own = hubsOfMerged(family);
      const tags: Array<string> = [];
      if (
        !tuning.families.has(family) &&
        [...own].some((key) => tuning.hubs.has(key))
      )
        tags.push("graph-tuning-adjacent");
      if (
        !training.families.has(family) &&
        [...own].some((key) => training.hubs.has(key))
      )
        tags.push("adapter-training-adjacent");
      return tags;
    };
    const mergedCommits = new Map<
      string,
      Array<{ sha: string; order: number; paths: ReadonlyArray<string> }>
    >();
    for (const [family, list] of familyCommits) {
      const target = merged.get(family) ?? family;
      mergedCommits.set(target, [
        ...(mergedCommits.get(target) ?? []),
        ...list,
      ]);
    }
    const members = new Map<string, Array<string>>();
    for (const [family, target] of merged)
      members.set(target, [...(members.get(target) ?? []), family]);
    // Scope sources (9.13), now that every family's commits are known.
    const withScope: Array<Range & { readonly order: number }> = [];
    for (const original of ranges) {
      const family = merged.get(original.family) ?? original.family;
      const range = { ...original, family, leakageTags: adjacency(family) };
      const repository = repositories[range.corpus];
      const baseTree = yield* pathsAt(repository, range.base);
      const familyHistory = mergedCommits.get(range.family) ?? [];
      const dirs = new Set(
        handoverDirsOf(familyHistory.flatMap((commit) => commit.paths)),
      );
      // Earlier in the family, and never one of the range's own commits: a merge range's commits
      // also appear in its superseded slices with smaller orders.
      const own = new Set(range.commits);
      const earlier = new Set(
        familyHistory
          .filter(
            (commit) => commit.order < range.order && !own.has(commit.sha),
          )
          .flatMap((commit) => commit.paths),
      );
      const edited = new Set(
        range.inRangeDocs
          .filter((doc) => doc.status === "edited")
          .map((doc) => doc.path),
      );
      const atBase = [...baseTree]
        .filter(
          (path) =>
            classifyPath(path) === "doc" && classifyDoc(path) === "scope",
        )
        .filter((path) => {
          const dir = handoverDir(path);
          return (
            (dir !== undefined && dirs.has(dir)) ||
            earlier.has(path) ||
            edited.has(path)
          );
        })
        .sort();
      const inRange = range.inRangeDocs.some(
        (doc) => doc.class === "scope" && doc.status !== "deleted",
      );
      const commitText = range.subjects.some(
        (subject) => subject.trim().split(/\s+/).length >= 4,
      );
      withScope.push({
        ...range,
        scopeDocsAtBase: atBase,
        strata: {
          ...range.strata,
          scopeSource:
            atBase.length > 0
              ? "plan-at-base"
              : inRange
                ? "plan-in-range"
                : commitText
                  ? "commit-text"
                  : "none",
        },
      });
    }
    const eligible = new Map<string, number>();
    for (const range of withScope)
      if (range.kind !== "stress")
        eligible.set(range.family, (eligible.get(range.family) ?? 0) + 1);
    return { ...pickAndSplit(withScope, eligible, excluded, members), hubs };
  });

const familyRank = (family: string) =>
  /\/branch:/.test(family)
    ? 0
    : /\/handover:/.test(family)
      ? 1
      : /\/area:/.test(family)
        ? 2
        : 3;

/**
 * What joins families: the handover directories their commits touch, and for this repository also
 * the scope plan documents they touch (9.26).
 */
const linkKeys = (corpus: string, paths: ReadonlyArray<string>) => [
  ...handoverDirsOf(paths).map((dir) => `${corpus}/handover:${dir}`),
  ...(JOIN_ON_SCOPE_DOCS.includes(corpus as CorpusKey)
    ? [
        ...new Set(
          paths.filter(
            (path) =>
              classifyPath(path) === "doc" && classifyDoc(path) === "scope",
          ),
        ),
      ].map((path) => `${corpus}/scope-doc:${path}`)
    : []),
];

/**
 * Union-find over families and the link keys of their commits (eligible or not).
 * Returns each family's merged name: its component's first member in branch, handover, area, then
 * code-point order.
 */
const mergeFamilies = (
  familyCommits: ReadonlyMap<
    string,
    ReadonlyArray<{ paths: ReadonlyArray<string> }>
  >,
) => {
  const parent = new Map<string, string>();
  const find = (node: string): string => {
    const up = parent.get(node) ?? node;
    if (up === node) return node;
    const root = find(up);
    parent.set(node, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
  };
  const keysOf = new Map<string, ReadonlyArray<string>>();
  const touching = new Map<string, number>();
  for (const [family, list] of familyCommits) {
    const keys = [
      ...new Set(
        linkKeys(
          family.slice(0, family.indexOf("/")),
          list.flatMap((commit) => commit.paths),
        ),
      ),
    ];
    keysOf.set(family, keys);
    for (const key of keys) touching.set(key, (touching.get(key) ?? 0) + 1);
  }
  // 9.29: hot scope documents are filtered, not followed; handover directories always join (9.28).
  const hubs = [...touching.entries()]
    .filter(
      ([key, families]) =>
        key.includes("/scope-doc:") && families >= HUB_FAMILY_THRESHOLD,
    )
    .map(([key, families]) => ({ key, families }))
    .sort((a, b) => b.families - a.families || byCodepoint(a.key, b.key));
  const hubKeys = new Set(hubs.map((hub) => hub.key));
  for (const [family, keys] of keysOf) {
    parent.set(family, find(family));
    for (const key of keys) if (!hubKeys.has(key)) union(family, key);
  }
  const components = new Map<string, Array<string>>();
  for (const family of familyCommits.keys())
    components.set(find(family), [
      ...(components.get(find(family)) ?? []),
      family,
    ]);
  const names = new Map<string, string>();
  for (const list of components.values()) {
    const name = [...list].sort(
      (a, b) => familyRank(a) - familyRank(b) || byCodepoint(a, b),
    )[0]!;
    for (const family of list) names.set(family, name);
  }
  return { names, hubs, keysOf, hubKeys };
};

/** A slice is superseded when its PR's merge range was itself eligible. */
const sliceSuperseded = (
  slice: Candidate,
  evaluated: ReadonlyArray<{ candidate: Candidate }>,
) =>
  evaluated.some(
    ({ candidate }) =>
      candidate.kind === "merge" &&
      candidate.family === slice.family &&
      candidate.commits.some((commit) => commit.sha === slice.head),
  );

type Pooled = Range & { readonly order: number };

const categoriesOf = (range: Range) => [
  `changeType:${range.strata.changeType}`,
  `scopeSource:${range.strata.scopeSource}`,
  `kind:${range.kind}`,
];
const inCategory = (range: Range, category: string) =>
  categoriesOf(range).includes(category);

export interface QuotaRecord {
  readonly category: string;
  readonly quota: number;
  /** Families in the eligible pool with a range in the category. */
  readonly familiesInPool: number;
  readonly reachable: number;
  /** Ranges in the category once the quota step finished. */
  readonly filledByQuota: number;
  /** Ranges in the category in the final selection. */
  readonly selected: number;
}

/** 9.24: quotas first, then one range per family by seed, then further rounds under the cap. */
const pickByStrata = (corpus: CorpusKey, pool: ReadonlyArray<Pooled>) => {
  const target = CORPORA[corpus].rangeTarget;
  const seededRanges = [...pool].sort((a, b) =>
    byCodepoint(seeded(a.id), seeded(b.id)),
  );
  const familyOrder = [...new Set(pool.map((range) => range.family))].sort(
    (a, b) => byCodepoint(seeded(a), seeded(b)),
  );
  const chosen: Array<Pooled> = [];
  const used = new Map<string, number>();
  const take = (range: Pooled) => {
    chosen.push(range);
    used.set(range.family, (used.get(range.family) ?? 0) + 1);
  };
  const free = (range: Pooled, cap: number) =>
    !chosen.includes(range) && (used.get(range.family) ?? 0) < cap;
  const fillQuotas = (
    candidates: ReadonlyArray<Pooled>,
    quotaOf: (category: string) => number,
    cap: number,
    limit: number,
    within: (range: Pooled) => boolean,
  ) => {
    for (const category of STRATA_CATEGORIES)
      while (
        chosen.filter((range) => within(range) && inCategory(range, category))
          .length < quotaOf(category) &&
        chosen.length < limit
      ) {
        const next =
          candidates.find(
            (range) => inCategory(range, category) && !used.has(range.family),
          ) ??
          candidates.find(
            (range) => inCategory(range, category) && free(range, cap),
          );
        if (next === undefined) break;
        take(next);
      }
  };
  const familiesWith = (category: string) =>
    new Set(
      pool
        .filter((range) => inCategory(range, category))
        .map((range) => range.family),
    ).size;
  const reachable = (category: string) =>
    Math.min(STRATA_QUOTA[corpus], familiesWith(category));
  fillQuotas(seededRanges, reachable, FAMILY_CAP, target, () => true);
  const filledByQuota = new Map(
    STRATA_CATEGORIES.map((category) => [
      category,
      chosen.filter((range) => inCategory(range, category)).length,
    ]),
  );
  for (const family of familyOrder) {
    if (chosen.length >= target) break;
    const first = seededRanges.find((range) => range.family === family);
    if (!used.has(family) && first !== undefined) take(first);
  }
  for (let round = 1; round < FAMILY_CAP; round++)
    for (const family of familyOrder) {
      if (chosen.length >= target) break;
      if (used.get(family) !== round) continue;
      const next = seededRanges.find(
        (range) => range.family === family && !chosen.includes(range),
      );
      if (next !== undefined) take(next);
    }
  // Provisional: the HCP dev family gives up to MERGED_HCP_FAMILY_DEV_CASES cases, by the same rule.
  const hcp = pool.find((range) => range.graphTuningRange)?.family;
  if (hcp !== undefined) {
    const own = seededRanges.filter((range) => range.family === hcp);
    const limit =
      chosen.length -
      (used.get(hcp) ?? 0) +
      Math.min(MERGED_HCP_FAMILY_DEV_CASES, own.length);
    const atLeastOne = (category: string) =>
      own.some((range) => inCategory(range, category)) ? 1 : 0;
    fillQuotas(
      own,
      atLeastOne,
      MERGED_HCP_FAMILY_DEV_CASES,
      limit,
      (range) => range.family === hcp,
    );
    for (const range of own)
      if (chosen.length < limit && free(range, MERGED_HCP_FAMILY_DEV_CASES))
        take(range);
  }
  const quotas: Array<QuotaRecord> = STRATA_CATEGORIES.map((category) => ({
    category,
    quota: STRATA_QUOTA[corpus],
    familiesInPool: familiesWith(category),
    reachable: reachable(category),
    filledByQuota: filledByQuota.get(category) ?? 0,
    selected: chosen.filter((range) => inCategory(range, category)).length,
  }));
  return { chosen, quotas };
};

const pickAndSplit = (
  ranges: ReadonlyArray<Pooled>,
  eligibleByFamily: ReadonlyMap<string, number>,
  excluded: Record<
    CorpusKey,
    Record<Exclusion | "superseded-by-merge" | "over-cap-or-target", number>
  >,
  members: ReadonlyMap<string, ReadonlyArray<string>>,
): Omit<Selection, "hubs"> => {
  const picked: Array<Range> = [];
  const families: Array<Selection["families"][number]> = [];
  const quotas = {} as Record<CorpusKey, ReadonlyArray<QuotaRecord>>;
  for (const corpus of Object.keys(CORPORA) as Array<CorpusKey>) {
    const pool = ranges.filter((range) => range.corpus === corpus);
    const stress = pool.filter((range) => range.kind === "stress");
    const regular = pool.filter((range) => range.kind !== "stress");
    const picks = pickByStrata(corpus, regular);
    const chosen = picks.chosen;
    quotas[corpus] = picks.quotas;
    excluded[corpus]["over-cap-or-target"] = regular.length - chosen.length;
    // Forced dev is decided over every eligible range of a (merged) family, not just the chosen ones.
    const forced = new Map<string, string>();
    for (const range of pool) {
      if (range.graphTuningRange)
        forced.set(range.family, "holds the Graph tuning ranges (HCP)");
      else if (range.phase2Files.length > 0 && !forced.has(range.family))
        forced.set(range.family, "touches a phase 2 training file");
    }
    const chosenFamilies = new Set(chosen.map((range) => range.family));
    for (const family of [...forced.keys()])
      if (!chosenFamilies.has(family)) forced.delete(family);
    for (const range of stress) forced.set(range.family, "stress case");
    const selectedFamilies = [
      ...new Set([...chosen, ...stress].map((range) => range.family)),
    ];
    const devTarget = Math.round(selectedFamilies.length * DEV_FRACTION);
    const signature = (family: string) =>
      [
        ...new Set(
          chosen
            .filter((range) => range.family === family)
            .flatMap(categoriesOf),
        ),
      ]
        .sort(byCodepoint)
        .join("|");
    const open = selectedFamilies
      .filter((family) => !forced.has(family))
      .sort(
        (a, b) =>
          byCodepoint(signature(a), signature(b)) ||
          byCodepoint(seeded(a), seeded(b)),
      );
    const slots = Math.max(0, devTarget - forced.size);
    const dev = new Set(forced.keys());
    for (let index = 0; index < slots; index++) {
      const family = open[Math.floor(((index + 0.5) * open.length) / slots)];
      if (family !== undefined) dev.add(family);
    }
    for (const family of [...selectedFamilies].sort(byCodepoint)) {
      families.push({
        id: family,
        corpus,
        eligible:
          eligibleByFamily.get(family) ??
          (forced.get(family) === "stress case" ? 1 : 0),
        selected: [...chosen, ...stress].filter(
          (range) => range.family === family,
        ).length,
        split: dev.has(family) ? "dev" : "held-out",
        forcedDev: forced.get(family),
        members: [...(members.get(family) ?? [family])].sort(byCodepoint),
      });
    }
    for (const { order: _order, ...range } of [...chosen, ...stress])
      picked.push(range);
  }
  picked.sort(
    (a, b) => byCodepoint(a.corpus, b.corpus) || byCodepoint(a.id, b.id),
  );
  return { ranges: picked, families, excluded, quotas };
};
