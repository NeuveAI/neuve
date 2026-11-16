import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { Effect } from "effect";
import { kindOf, type Case, type Hunk } from "../corpus.ts";
import { gitText } from "../git.ts";
import { parseHunks, type DiffHunk } from "../hunks.ts";
import { byCodepoint, CORPORA, type CorpusKey } from "../policy.ts";
import { decodePool, POOL_DEPTH, type PoolRow } from "../retriever.ts";
import {
  LABEL_SCHEMA_VERSION,
  type CandidateSource,
  type HunkPool,
  type PoolCandidate,
} from "./schema.ts";

/**
 * Pooling (proposal section 3, option B′ with history as a candidate generator): per hunk, the union
 * of every arm's frozen top-`depth` regions, merged where line spans overlap on the same path, plus
 * history candidates (earlier commits that shaped the hunk's base lines, later commits that changed
 * its new lines) and `path:line` citations from the range's hindsight documents. Each candidate keeps
 * every source that produced it, so B4 can attribute it to arms; labellers never see those sources.
 */

export const HISTORY_EARLIER_MAX = 3;
export const HISTORY_LATER_MAX = 5;

/** Every frozen pool file in the directory, keyed by hunk. */
export const readPools = (directory: string) => {
  const byHunk = new Map<string, Array<PoolRow>>();
  const arms: Array<string> = [];
  for (const file of readdirSync(directory).sort(byCodepoint)) {
    if (!file.endsWith(".jsonl.gz")) continue;
    arms.push(file.slice(0, -".jsonl.gz".length));
    for (const row of decodePool(readFileSync(`${directory}/${file}`))) {
      const key = `${row.caseId}\u0000${row.hunkId}`;
      const list = byHunk.get(key) ?? [];
      list.push(row);
      byHunk.set(key, list);
    }
  }
  return { arms, byHunk };
};

/** The range's own changes with no context lines: exact changed base lines and line mapping. */
export const rangeHunks = (repository: string, entry: Case) =>
  Effect.map(
    gitText(repository, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "-U0",
      "--ignore-submodules=all",
      "-M",
      entry.base,
      entry.head,
    ]),
    parseHunks,
  );

/** Base line spans the range changes, per pre-image path. */
export const changedBaseSpans = (hunks: ReadonlyArray<DiffHunk>) => {
  const spans = new Map<string, Array<[number, number]>>();
  for (const hunk of hunks) {
    if (hunk.oldLines === 0) continue;
    const list = spans.get(hunk.oldPath) ?? [];
    list.push([hunk.oldStart, hunk.oldStart + hunk.oldLines - 1]);
    spans.set(hunk.oldPath, list);
  }
  return spans;
};

const overlapLines = (
  spans: ReadonlyArray<[number, number]> | undefined,
  start: number,
  end: number,
) => {
  let total = 0;
  for (const [a, b] of spans ?? []) {
    const lo = Math.max(a, start);
    const hi = Math.min(b, end);
    if (hi >= lo) total += hi - lo + 1;
  }
  return total;
};

/**
 * Maps a head line to the base: unchanged lines shift by the hunks before them; a line inside a
 * changed hunk maps to that hunk's base span (same-batch), or to nothing when the hunk only adds.
 */
export const headToBase = (
  hunks: ReadonlyArray<DiffHunk>,
  path: string,
  line: number,
): { oldPath: string; start: number; end: number } | null => {
  const own = hunks
    .filter((hunk) => hunk.path === path)
    .sort((a, b) => a.newStart - b.newStart);
  const oldPath = own[0]?.oldPath ?? path;
  let shift = 0;
  for (const hunk of own) {
    const newEnd = hunk.newStart + hunk.newLines - 1;
    if (hunk.newLines > 0 && line >= hunk.newStart && line <= newEnd)
      return hunk.oldLines === 0
        ? null
        : {
            oldPath,
            start: hunk.oldStart,
            end: hunk.oldStart + hunk.oldLines - 1,
          };
    const after = hunk.newLines === 0 ? hunk.newStart : newEnd;
    if (line > after) shift = hunk.oldLines - hunk.newLines + shift;
    else break;
  }
  return { oldPath, start: line + shift, end: line + shift };
};

const CITATION =
  /([A-Za-z0-9_@.\-][A-Za-z0-9_@.\-/]*\.[A-Za-z0-9]+)(?::|#L)(\d+)(?:\s*[-–]\s*L?(\d+))?/g;

export interface Citation {
  readonly doc: string;
  readonly path: string;
  readonly start: number;
  readonly end: number;
}

/** `path:line` and `path#Lline` citations in the range's hindsight documents, mapped to the base. */
export const reviewCitations = (
  repository: string,
  entry: Case,
  hunks: ReadonlyArray<DiffHunk>,
  basePaths: ReadonlyArray<string>,
  lineCount: (path: string) => Effect.Effect<number, unknown>,
) =>
  Effect.gen(function* () {
    const out: Array<Citation> = [];
    const renamedFrom = new Map(hunks.map((hunk) => [hunk.path, hunk.oldPath]));
    for (const doc of entry.inRangeDocs) {
      if (doc.class !== "hindsight" || doc.status === "deleted") continue;
      const text = yield* gitText(repository, [
        "cat-file",
        "blob",
        `${entry.head}:${doc.path}`,
      ]);
      for (const match of text.matchAll(CITATION)) {
        const cited = match[1] ?? "";
        const first = Number(match[2]);
        const last = match[3] === undefined ? first : Number(match[3]);
        if (!(first > 0) || last < first || last - first > 400) continue;
        const resolved = basePaths.filter(
          (path) =>
            path === cited ||
            path.endsWith(`/${cited}`) ||
            renamedFrom.get(cited) === path,
        );
        if (resolved.length !== 1) continue;
        const headPath = [...renamedFrom.entries()].find(
          ([, from]) => from === resolved[0],
        )?.[0];
        const a = headToBase(hunks, headPath ?? resolved[0]!, first);
        const b = headToBase(hunks, headPath ?? resolved[0]!, last);
        if (a === null || b === null) continue;
        const lines = yield* lineCount(a.oldPath);
        const start = Math.min(a.start, b.start);
        const end = Math.min(Math.max(a.end, b.end), lines);
        if (start < 1 || start > lines) continue;
        out.push({ doc: doc.path, path: a.oldPath, start, end });
      }
    }
    return out;
  });

export interface HistoryCommit {
  readonly sha: string;
  readonly subject: string;
  readonly date: string;
  readonly timing: "earlier" | "later";
  /** The commit's patch restricted to the tracked lines (earlier) or to the file (later). */
  readonly patch: string;
}

const RECORD = "\u001e";
const FIELD = "\u001f";

const lineCount = (repository: string, revision: string, path: string) =>
  gitText(repository, ["cat-file", "blob", `${revision}:${path}`]).pipe(
    Effect.map((text) =>
      text === ""
        ? 0
        : text.endsWith("\n")
          ? text.split("\n").length - 1
          : text.split("\n").length,
    ),
    Effect.orElseSucceed(() => undefined),
  );

/**
 * Earlier history: commits at or before the base that last shaped the hunk's base lines. A hunk that
 * only inserts tracks the base lines around the insertion point, including an insertion at the top
 * of an existing file; a file new in the range has no earlier history.
 */
export const earlierHistory = (repository: string, entry: Case, hunk: Hunk) =>
  Effect.gen(function* () {
    const lines = yield* lineCount(repository, entry.base, hunk.oldPath);
    if (lines === undefined || lines === 0) return [] as Array<HistoryCommit>;
    const start =
      hunk.old.lines === 0 ? Math.max(1, hunk.old.start - 1) : hunk.old.start;
    const end = Math.min(
      lines,
      hunk.old.lines === 0
        ? hunk.old.start + 2
        : hunk.old.start + hunk.old.lines - 1,
    );
    const text = yield* gitText(repository, [
      "log",
      `--max-count=${HISTORY_EARLIER_MAX}`,
      `--format=${RECORD}%H${FIELD}%cI${FIELD}%s${FIELD}`,
      `-L${start},${end}:${hunk.oldPath}`,
      entry.base,
    ]);
    return text
      .split(RECORD)
      .filter((record) => record.trim() !== "")
      .map((record): HistoryCommit => {
        const [sha = "", date = "", subject = "", patch = ""] =
          record.split(FIELD);
        return { sha, date, subject, timing: "earlier", patch: patch.trim() };
      });
  });

/**
 * Later history (hindsight only, 9.12): `git blame --reverse` from the head to the corpus head gives,
 * for each of the hunk's new lines, the last commit in which it still existed and its line number
 * there. The commit that changed it is the child of that commit, on the ancestry path, whose diff
 * removes or rewrites that line. Ordered by committer date.
 */
export const laterHistory = (
  repository: string,
  corpus: CorpusKey,
  entry: Case,
  hunk: Hunk,
) =>
  Effect.gen(function* () {
    if (hunk.new.lines === 0) return [] as Array<HistoryCommit>;
    const tip = CORPORA[corpus].head;
    if (tip === entry.head) return [] as Array<HistoryCommit>;
    const end = hunk.new.start + hunk.new.lines - 1;
    const porcelain = yield* gitText(repository, [
      "blame",
      "--reverse",
      "--porcelain",
      `-L${hunk.new.start},${end}`,
      `${entry.head}..${tip}`,
      "--",
      hunk.path,
    ]);
    const lastSeen = new Map<string, Set<number>>();
    for (const line of porcelain.split("\n")) {
      const match = /^([0-9a-f]{40}) (\d+) \d+/.exec(line);
      if (match === null || match[1] === tip) continue;
      const set = lastSeen.get(match[1]!) ?? new Set<number>();
      set.add(Number(match[2]));
      lastSeen.set(match[1]!, set);
    }
    if (lastSeen.size === 0) return [] as Array<HistoryCommit>;
    const graph = yield* gitText(repository, [
      "rev-list",
      "--ancestry-path",
      "--parents",
      `${entry.head}..${tip}`,
    ]);
    const children = new Map<string, Array<string>>();
    const merges = new Set<string>();
    for (const row of graph.split("\n").filter(Boolean)) {
      const [child = "", ...parents] = row.split(" ");
      if (parents.length > 1) merges.add(child);
      for (const parent of parents) {
        const list = children.get(parent) ?? [];
        list.push(child);
        children.set(parent, list);
      }
    }
    const isAncestor = (a: string, b: string) =>
      gitText(repository, ["merge-base", "--is-ancestor", a, b]).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
    const changers = new Set<string>();
    for (const [seen, lines] of lastSeen)
      for (const child of children.get(seen) ?? []) {
        const diff = yield* gitText(repository, [
          "diff",
          "--no-color",
          "--no-ext-diff",
          "-U0",
          seen,
          child,
          "--",
          hunk.path,
        ]);
        const touching = parseHunks(diff).filter(
          (change) =>
            change.oldLines > 0 &&
            [...lines].some(
              (line) =>
                line >= change.oldStart &&
                line < change.oldStart + change.oldLines,
            ),
        );
        if (touching.length === 0) continue;
        if (!merges.has(child)) {
          changers.add(child);
          continue;
        }
        // A merge brought the change in: blame the replacing lines in the merge to find the commits
        // on the merged branch; a pure deletion falls back to that branch's commits on the file.
        for (const change of touching) {
          const found: Array<string> = [];
          if (change.newLines > 0) {
            const blame = yield* gitText(repository, [
              "blame",
              "--porcelain",
              `-L${change.newStart},${change.newStart + change.newLines - 1}`,
              child,
              "--",
              hunk.path,
            ]);
            for (const line of blame.split("\n")) {
              const sha = /^([0-9a-f]{40}) \d+ \d+/.exec(line)?.[1];
              if (sha !== undefined && !found.includes(sha)) found.push(sha);
            }
          } else {
            const log = yield* gitText(repository, [
              "log",
              "--no-merges",
              "--max-count=2",
              "--format=%H",
              `${seen}..${child}`,
              "--",
              hunk.path,
            ]);
            found.push(...log.split("\n").filter(Boolean));
          }
          for (const sha of found)
            if (!(yield* isAncestor(sha, seen))) changers.add(sha);
        }
      }
    const out: Array<HistoryCommit> = [];
    for (const sha of changers) {
      const text = yield* gitText(repository, [
        "show",
        `--format=%H${FIELD}%cI${FIELD}%s${FIELD}`,
        "--no-color",
        "-U3",
        sha,
        "--",
        hunk.path,
      ]);
      const [full = "", date = "", subject = "", patch = ""] =
        text.split(FIELD);
      if (full === "")
        throw new Error(
          `no commit header from git show ${sha} -- ${hunk.path}`,
        );
      out.push({
        sha: full,
        date,
        subject,
        timing: "later",
        patch: patch.trim(),
      });
    }
    return out
      .sort((a, b) => byCodepoint(a.date, b.date) || byCodepoint(a.sha, b.sha))
      .slice(0, HISTORY_LATER_MAX);
  });

interface Entry {
  readonly path: string;
  readonly start: number;
  readonly end: number;
  readonly source: CandidateSource;
}

/** Merges overlapping spans per path (transitively); touching but disjoint spans stay apart. */
export const mergeEntries = (entries: ReadonlyArray<Entry>) => {
  const byPath = new Map<string, Array<Entry>>();
  for (const entry of entries) {
    const list = byPath.get(entry.path) ?? [];
    list.push(entry);
    byPath.set(entry.path, list);
  }
  const merged: Array<{
    path: string;
    start: number;
    end: number;
    sources: Array<CandidateSource>;
  }> = [];
  for (const path of [...byPath.keys()].sort(byCodepoint)) {
    const list = byPath
      .get(path)!
      .sort((a, b) => a.start - b.start || a.end - b.end);
    let current: (typeof merged)[number] | undefined;
    for (const entry of list) {
      if (current !== undefined && entry.start <= current.end) {
        current.end = Math.max(current.end, entry.end);
        current.sources.push(entry.source);
      } else {
        current = {
          path,
          start: entry.start,
          end: entry.end,
          sources: [entry.source],
        };
        merged.push(current);
      }
    }
  }
  return merged;
};

const sourceOrder = (a: CandidateSource, b: CandidateSource) =>
  byCodepoint(a.source, b.source) ||
  (a.rank ?? 0) - (b.rank ?? 0) ||
  (a.startLine ?? 0) - (b.startLine ?? 0) ||
  byCodepoint(a.ref ?? "", b.ref ?? "");

export interface PoolInputs {
  readonly entry: Case;
  readonly hunk: Hunk;
  readonly rows: ReadonlyArray<PoolRow>;
  readonly arms: ReadonlyArray<string>;
  readonly depth: number;
  readonly rangeHunks: ReadonlyArray<DiffHunk>;
  readonly citations: ReadonlyArray<Citation>;
  readonly history: ReadonlyArray<HistoryCommit>;
}

/** Pure: the hunk's pool from the frozen rows and the generated candidates. */
export const buildPool = (inputs: PoolInputs): HunkPool => {
  const { entry, hunk, rows, depth } = inputs;
  const answered = rows.map((row) => row.arm).sort(byCodepoint);
  const expected = [...inputs.arms].sort(byCodepoint);
  if (answered.join("\u0000") !== expected.join("\u0000"))
    throw new Error(
      `${entry.id}#${hunk.id}: frozen rows cover arms [${answered.join(", ")}], expected [${expected.join(", ")}]`,
    );
  const entries: Array<Entry> = [];
  for (const row of rows)
    row.regions.slice(0, depth).forEach(([path, start, end], index) =>
      entries.push({
        path,
        start,
        end,
        source: {
          source: row.arm,
          rank: index + 1,
          startLine: start,
          endLine: end,
          ref: null,
        },
      }),
    );
  for (const citation of inputs.citations)
    entries.push({
      path: citation.path,
      start: citation.start,
      end: citation.end,
      source: {
        source: "review-citation",
        rank: null,
        startLine: citation.start,
        endLine: citation.end,
        ref: citation.doc,
      },
    });
  const changed = changedBaseSpans(inputs.rangeHunks);
  const regions = mergeEntries(entries).map((region) => {
    const changedBaseLines = overlapLines(
      changed.get(region.path),
      region.start,
      region.end,
    );
    const lines = region.end - region.start + 1;
    const ranks = region.sources
      .map((source) => source.rank)
      .filter((rank): rank is number => rank !== null);
    return {
      type: "region" as const,
      path: region.path,
      startLine: region.start,
      endLine: region.end,
      kind: kindOf(region.path),
      commit: null,
      historyTiming: null,
      rangeStatus:
        changedBaseLines === 0
          ? ("committed" as const)
          : changedBaseLines >= lines
            ? ("same-batch" as const)
            : ("partly-same-batch" as const),
      changedBaseLines,
      bestRank: ranks.length === 0 ? null : Math.min(...ranks),
      sources: region.sources.sort(sourceOrder),
    };
  });
  const commits = [...inputs.history]
    .sort(
      (a, b) =>
        byCodepoint(a.timing, b.timing) ||
        byCodepoint(a.date, b.date) ||
        byCodepoint(a.sha, b.sha),
    )
    .map((commit) => ({
      type: "commit" as const,
      path: null,
      startLine: null,
      endLine: null,
      kind: "history" as const,
      commit: commit.sha,
      historyTiming: commit.timing,
      rangeStatus: null,
      changedBaseLines: 0,
      bestRank: null,
      sources: [
        {
          source: `history:${commit.timing}`,
          rank: null,
          startLine: null,
          endLine: null,
          ref: commit.sha,
        },
      ],
    }));
  const candidates: Array<PoolCandidate> = [...regions, ...commits].map(
    (candidate, index) => ({
      id: `c${String(index + 1).padStart(3, "0")}`,
      ...candidate,
    }),
  );
  return {
    schemaVersion: LABEL_SCHEMA_VERSION,
    caseId: entry.id,
    hunkId: hunk.id,
    repository: entry.repository,
    base: entry.base,
    head: entry.head,
    depth,
    arms: [...inputs.arms],
    candidates,
  };
};

export const DEFAULT_DEPTH = POOL_DEPTH;

/** A stable key for a pool, so label files can refuse a pool they were not made against. */
export const poolDigest = (pool: HunkPool) =>
  createHash("sha256").update(JSON.stringify(pool)).digest("hex");
