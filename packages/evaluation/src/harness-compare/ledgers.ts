import {
  spanKey,
  type Item,
  type Ranking,
} from "../retrieval-bench/ranking.ts";

/**
 * Step 4: Investigate's ledgers as the B4 scorer's rankings, one per M4 hunk.
 *
 * Which entries: every kept ledger entry (`entries`, after the harness trimmed it to the hunk's
 * allowance) anchored to the harness hunk that is the M4 hunk (seed report, matched on path and
 * header). Look-alikes and dropped entries are not context and are left out. Entries the backstop
 * entered ungraded (a failed or interrupted partition) stay in and are counted.
 *
 * Where: gold targets are base spans (score/gold.ts), so each entry's region is put on the base:
 * - read at base (`rev` base, or a lead read in the base tree): as it is;
 * - read at head in a file the range does not change: the same lines;
 * - read at head in a changed file: each end is carried through the range's hunks on that path
 *   (lines after a hunk shift by its size; an end inside a hunk snaps to the hunk's old lines), and a
 *   renamed file takes its old path;
 * - lost: a file added in the range (no base lines), and scope sections (no repository region).
 *
 * Order: the order composeLedger trims in, necessary before useful, then seeded leads (10.84) before
 * the agent's own entries, then the retrieval rank, then the entry's place in the ledger (rank
 * absent = 1,000 + entry number). Ledgers from before 10.84 have no seeded leads. The ledger is already cut
 * to the hunk's allowance, so the scorer serves all of it ("coverage at depth"); the order only
 * matters for rank views, which this comparison does not headline.
 */

export interface ManifestHunkLite {
  readonly hunkId: string;
  readonly kind: string;
  readonly path: string;
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
}

export interface LedgerEntryLite {
  readonly id: string;
  readonly anchors: ReadonlyArray<{ readonly hunk: string }>;
  readonly source:
    | {
        readonly origin: "repository" | "same-batch";
        readonly rev: string;
        readonly path: string;
        readonly startLine: number;
        readonly endLine: number;
      }
    | { readonly origin: "scope"; readonly sectionId: string };
  readonly retrieval: {
    readonly rank: number | null;
    readonly retriever: string | null;
  };
  readonly lineage: { readonly lookup: string };
  readonly grade: "necessary" | "useful";
  readonly tokens: number;
  readonly ungraded: boolean;
  /** A seeded lead (10.84); absent in ledgers from before it. */
  readonly seed?: "default" | "regraded" | null;
}

export interface LedgerLite {
  readonly partition: {
    readonly id: string;
    readonly hunkIds: ReadonlyArray<string>;
  };
  readonly status: string;
  readonly entries: ReadonlyArray<LedgerEntryLite>;
  /** Each hunk's allowance and the tokens its kept entries use (composeLedger). */
  readonly allowances?: ReadonlyArray<{
    readonly hunk: string;
    readonly tokens: number;
    readonly used: number;
  }>;
  readonly dropped?: ReadonlyArray<{
    readonly entry: string;
    readonly reason: string;
    readonly note: string;
    readonly seeded?: boolean;
    readonly region?: string;
  }>;
}

export type Placement =
  | "base"
  | "head-unchanged-file"
  | "head-through-diff"
  | "lost-added-file"
  | "lost-scope";

/** Head lines of a changed file onto its base lines through the range's hunks on that path. */
const headToBase = (
  hunks: ReadonlyArray<ManifestHunkLite>,
  line: number,
  end: "start" | "end",
) => {
  let offset = 0;
  for (const hunk of [...hunks].sort((a, b) => a.newStart - b.newStart)) {
    const last = hunk.newStart + Math.max(hunk.newLines, 1) - 1;
    if (hunk.newLines > 0 && line < hunk.newStart) break;
    if (hunk.newLines === 0 && line <= hunk.newStart) break;
    if (hunk.newLines > 0 && line <= last)
      return end === "start"
        ? Math.max(1, hunk.oldStart)
        : Math.max(1, hunk.oldStart + Math.max(hunk.oldLines, 1) - 1);
    // The first line after the hunk on each side. A side with no lines names the line before the
    // change in its header (`@@ -4,0 +5,2 @@`), so the next line is start + 1, not start + 0.
    const oldAfter =
      hunk.oldLines > 0 ? hunk.oldStart + hunk.oldLines : hunk.oldStart + 1;
    const newAfter =
      hunk.newLines > 0 ? hunk.newStart + hunk.newLines : hunk.newStart + 1;
    offset = oldAfter - newAfter;
  }
  return Math.max(1, line + offset);
};

export const placeEntry = (
  entry: LedgerEntryLite,
  manifestHunks: ReadonlyArray<ManifestHunkLite>,
): {
  readonly placement: Placement;
  readonly region?: { path: string; startLine: number; endLine: number };
} => {
  const source = entry.source;
  if (source.origin === "scope") return { placement: "lost-scope" };
  if (source.rev !== "head")
    return {
      placement: "base",
      region: {
        path: source.path,
        startLine: source.startLine,
        endLine: source.endLine,
      },
    };
  const onPath = manifestHunks.filter(
    (hunk) => hunk.newPath === source.path && hunk.kind === "text",
  );
  const touched = manifestHunks.filter((hunk) => hunk.newPath === source.path);
  if (touched.length === 0)
    return {
      placement: "head-unchanged-file",
      region: {
        path: source.path,
        startLine: source.startLine,
        endLine: source.endLine,
      },
    };
  const oldPath =
    touched.find((hunk) => hunk.oldPath !== null)?.oldPath ?? null;
  if (oldPath === null) return { placement: "lost-added-file" };
  const startLine = headToBase(onPath, source.startLine, "start");
  const endLine = Math.max(
    startLine,
    headToBase(onPath, source.endLine, "end"),
  );
  return {
    placement: "head-through-diff",
    region: { path: oldPath, startLine, endLine },
  };
};

export interface HunkRanking {
  readonly ranking: Ranking;
  readonly entries: number;
  readonly placements: Readonly<Record<Placement, number>>;
  readonly ungraded: number;
  readonly fromLeads: number;
  /** Seeded leads still in the ledger (10.84), and those of them the agent regraded. */
  readonly seeded: number;
  readonly regraded: number;
  readonly tokens: number;
  readonly partitions: ReadonlyArray<string>;
  readonly partitionStatus: ReadonlyArray<string>;
}

/** The ranking of one M4 hunk from the run's ledgers, or null when its harness hunk had no ledger. */
export const rankingFor = (
  harnessHunkId: string,
  ledgers: ReadonlyArray<LedgerLite>,
  manifestHunks: ReadonlyArray<ManifestHunkLite>,
): HunkRanking | null => {
  const owning = ledgers.filter((ledger) =>
    ledger.partition.hunkIds.includes(harnessHunkId),
  );
  if (owning.length === 0) return null;
  const entries = owning
    .flatMap((ledger) => ledger.entries)
    .filter((entry) =>
      entry.anchors.some((anchor) => anchor.hunk === harnessHunkId),
    );
  const rankOf = (entry: LedgerEntryLite) =>
    entry.retrieval.rank ?? 1_000 + Number(entry.id.slice(1));
  const ordered = [...entries].sort(
    (a, b) =>
      (a.grade === "necessary" ? 0 : 1) - (b.grade === "necessary" ? 0 : 1) ||
      ((a.seed ?? null) === null ? 1 : 0) -
        ((b.seed ?? null) === null ? 1 : 0) ||
      rankOf(a) - rankOf(b) ||
      Number(a.id.slice(1)) - Number(b.id.slice(1)),
  );
  const placements: Record<Placement, number> = {
    base: 0,
    "head-unchanged-file": 0,
    "head-through-diff": 0,
    "lost-added-file": 0,
    "lost-scope": 0,
  };
  const items: Array<Item> = [];
  for (const entry of ordered) {
    const placed = placeEntry(entry, manifestHunks);
    placements[placed.placement]++;
    if (placed.region === undefined) continue;
    items.push({
      key: spanKey(
        placed.region.path,
        placed.region.startLine,
        placed.region.endLine,
      ),
      path: placed.region.path,
      startLine: placed.region.startLine,
      endLine: placed.region.endLine,
      kind: "code",
      tokens: entry.tokens,
      chunkId: null,
      hash: null,
    });
  }
  return {
    ranking: { items, scores: items.map((_, rank) => 1 / (rank + 1)) },
    entries: entries.length,
    placements,
    ungraded: entries.filter((entry) => entry.ungraded).length,
    fromLeads: entries.filter(
      (entry) => entry.lineage.lookup === "preloaded-lead",
    ).length,
    seeded: entries.filter((entry) => (entry.seed ?? null) !== null).length,
    regraded: entries.filter((entry) => entry.seed === "regraded").length,
    tokens: entries.reduce((sum, entry) => sum + entry.tokens, 0),
    partitions: owning.map((ledger) => ledger.partition.id),
    partitionStatus: owning.map((ledger) => ledger.status),
  };
};
