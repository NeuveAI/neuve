import { existsSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import { KINDS } from "../../retrieval-bench/corpus.ts";
import { matchHunks } from "../harness-side.ts";
import {
  LEADS_ARMS,
  extraLeadsFile,
  leadsFile,
  type LeadsArm,
} from "./config.ts";

/**
 * The labelling side's all-hunks leads files (FT6, FT15): one row per text hunk of the 22 dev
 * ranges per arm, written by M4's leads-file mode into the full test's own folder, never into M4's
 * pools. This module is the one reader: the runner feeds them to the harness and the scorer reads
 * retrieval from them. Nothing here knows how the file was produced.
 *
 * Row (as the labelling side states it): the range (`caseId`), the hunk's path, old path and its
 * old and new spans, its exact diff text (for matching), M4's query text, the top 50 reranked
 * regions in the pools' tuple format, and whether Graph answered (on a failure H3 fuses without
 * Graph, and the row says so). Binary, submodule and pure-rename hunks have no row; the receipt
 * (`leads.json`) lists them.
 *
 * Matching to harness hunks is on diff text (the `@@` line and body as git printed them, which the
 * harness keeps as `HunkRecord.text`): the same path and the same text. When the texts differ only
 * by a trailing newline they still match; when no text matches, the same path and header spans do,
 * and the match says which rule held.
 */

const Span = z.strictObject({
  start: z.int().min(0),
  lines: z.int().min(0),
});

export const Region = z.tuple([
  z.string(),
  z.int(),
  z.int(),
  z.string().nullable(),
  z.enum(KINDS),
  z.int(),
  z.number(),
]);
export type Region = z.infer<typeof Region>;

/**
 * A row as the leads file writes it (`leads.json` `rowFormat`): the range (`caseId`,
 * `corpus:base..head`), the hunk's ID from describeHunks, path, old path, spans and counts, its
 * exact diff text (`diff`, from the -U3 diff `diffTrees` uses), the Q1 query (`query.text`),
 * each source's status (`sources.graph.status`: answered, failed, timeout, or not-used for
 * R(H1-E0)) and the reranked top 50. Earlier drafts named the fields `diffText`, `queryText` and
 * `graph`; both spellings read the same.
 */
const RawRow = z.looseObject({
  caseId: z.string().regex(/^[^:]+:[0-9a-f]{7,40}\.\.[0-9a-f]{7,40}$/),
  hunkId: z.string().optional(),
  path: z.string(),
  oldPath: z.string().nullable(),
  old: Span,
  new: Span,
  diff: z.string().min(1).optional(),
  diffText: z.string().min(1).optional(),
  query: z.looseObject({ text: z.string() }).optional(),
  queryText: z.string().optional(),
  sources: z
    .looseObject({ graph: z.looseObject({ status: z.string() }).optional() })
    .optional(),
  graph: z.string().optional(),
  regions: z.array(Region).max(50),
});

/** A row as the runner and the scorer read it: one spelling of each field. */
export const LeadsRow = z.strictObject({
  caseId: z.string(),
  hunkId: z.string().nullable(),
  path: z.string(),
  oldPath: z.string().nullable(),
  old: Span,
  new: Span,
  diffText: z.string().min(1),
  queryText: z.string(),
  regions: z.array(Region).max(50),
  graph: z.string(),
  /** Which file the row came from: the 22 ranges' (`main`) or the extra ranges' (`extra`). */
  file: z.enum(["main", "extra"]),
});
export type LeadsRow = z.infer<typeof LeadsRow>;

export const normaliseRow = (
  raw: unknown,
  file: LeadsRow["file"] = "main",
): LeadsRow => {
  const row = RawRow.parse(raw);
  const diffText = row.diffText ?? row.diff;
  if (diffText === undefined)
    throw new Error(`${row.caseId} ${row.path}: a row has no diff text`);
  return LeadsRow.parse({
    caseId: row.caseId,
    hunkId: row.hunkId ?? null,
    path: row.path,
    oldPath: row.oldPath,
    old: row.old,
    new: row.new,
    diffText,
    queryText: row.queryText ?? row.query?.text ?? "",
    regions: row.regions,
    graph: row.graph ?? row.sources?.graph?.status ?? "unknown",
    file,
  });
};

/** Parses a gzipped JSON-lines leads file; a malformed row is an error, never skipped. */
export const decodeLeads = (
  bytes: Uint8Array,
  file: LeadsRow["file"] = "main",
): Array<LeadsRow> =>
  gunzipSync(bytes)
    .toString("utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      try {
        return normaliseRow(JSON.parse(line), file);
      } catch (error) {
        throw new Error(
          `leads row ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });

/**
 * One arm's rows by range, from the 22 ranges' file and, beside it, the extra ranges' file (the
 * probe, the known cases and the proof ranges); undefined when the main file has not landed.
 */
export const readLeads = (
  arm: LeadsArm,
  path: string = leadsFile(arm),
  extra: string | null = extraLeadsFile(arm),
): Map<string, Array<LeadsRow>> | undefined => {
  if (!existsSync(path)) return undefined;
  const byCase = new Map<string, Array<LeadsRow>>();
  const add = (rows: ReadonlyArray<LeadsRow>) => {
    for (const row of rows)
      byCase.set(row.caseId, [...(byCase.get(row.caseId) ?? []), row]);
  };
  add(decodeLeads(new Uint8Array(readFileSync(path)), "main"));
  if (extra !== null && existsSync(extra))
    add(decodeLeads(new Uint8Array(readFileSync(extra)), "extra"));
  return byCase;
};

/**
 * A range's rows by its revisions, as the seam selects them (frozen.ts `rowsForRange`): the row's
 * case names base and head prefixes of the range's base (or merge base) and head. A known case
 * named `planted:…` or `…~1` is found by its resolved OIDs, never by its name.
 */
export const rowsForRange = (
  byCase: ReadonlyMap<string, ReadonlyArray<LeadsRow>>,
  range: {
    readonly baseOid: string;
    readonly headOid: string;
    readonly mergeBase?: string;
  },
) =>
  [...byCase.entries()].flatMap(([caseId, rows]) => {
    const span = caseId.split(":")[1] ?? "";
    const [base, head] = span.split("..") as [string, string];
    return range.headOid.startsWith(head) &&
      (range.baseOid.startsWith(base) ||
        (range.mergeBase ?? "").startsWith(base))
      ? rows
      : [];
  });

/** Which arms' leads files are present: the runner refuses a frozen phase without its file. */
export const leadsPresent = () =>
  Object.fromEntries(
    LEADS_ARMS.map((arm) => [arm, existsSync(leadsFile(arm))]),
  ) as Record<LeadsArm, boolean>;

/** What leads matching needs of a harness hunk (HunkRecord's fields). */
export interface HarnessHunkLite {
  readonly hunkId: string;
  readonly kind: string;
  readonly path: string;
  readonly oldPath: string | null;
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly text: string;
}

export interface LeadsMatch {
  readonly harnessHunkId: string;
  readonly row: LeadsRow | null;
  readonly how: "text" | "exact" | "overlap" | "none";
}

/**
 * Each text harness hunk's leads row, by the one matcher the seed step uses (harness-side.ts
 * `matchHunks`: diff text, then the exact header, then overlapping lines, and never two rows on
 * one harness hunk).
 */
export const matchLeads = (
  harness: ReadonlyArray<HarnessHunkLite>,
  rows: ReadonlyArray<LeadsRow>,
): Array<LeadsMatch> => {
  const matches = matchHunks(
    rows.map((row, index) => ({
      hunkId: String(index),
      path: row.path,
      oldPath: row.oldPath ?? row.path,
      old: row.old,
      new: row.new,
      queryText: row.queryText,
      regions: [],
      diffText: row.diffText,
    })),
    harness.map((hunk) => ({
      ...hunk,
      kind: hunk.kind === "text" ? ("text" as const) : ("metadata" as const),
    })),
  );
  const rowOf = new Map(
    matches.flatMap((match) =>
      match.harnessHunkId === null
        ? []
        : [
            [
              match.harnessHunkId,
              { row: rows[Number(match.m4HunkId)]!, how: match.how },
            ] as const,
          ],
    ),
  );
  return harness
    .filter((hunk) => hunk.kind === "text")
    .map((hunk) => {
      const found = rowOf.get(hunk.hunkId);
      return found === undefined
        ? { harnessHunkId: hunk.hunkId, row: null, how: "none" as const }
        : { harnessHunkId: hunk.hunkId, row: found.row, how: found.how };
    });
};

const regionKey = (region: Region) => `${region[0]}:${region[1]}-${region[2]}`;

/**
 * The lead-difference counts (FT15): per hunk, whether the two arms' top 3 and top 10 differ, as
 * sets of regions. The served-top-3 form of FT4's rule uses `servedTop3Differ` on the harness's
 * chunks instead (seed reports), since that is what the harness actually serves.
 */
export const leadDifferences = (
  a: ReadonlyMap<string, ReadonlyArray<LeadsRow>>,
  b: ReadonlyMap<string, ReadonlyArray<LeadsRow>>,
) => {
  const rowsKey = (row: LeadsRow) =>
    `${row.caseId}\u0000${row.path}\u0000${row.diffText}`;
  const bRows = new Map(
    [...b.values()].flat().map((row) => [rowsKey(row), row]),
  );
  const perHunk: Array<{
    caseId: string;
    path: string;
    top3Differ: boolean;
    top10Differ: boolean;
    top3Overlap: number;
    top10Overlap: number;
  }> = [];
  const unpaired: Array<string> = [];
  for (const row of [...a.values()].flat()) {
    const other = bRows.get(rowsKey(row));
    if (other === undefined) {
      unpaired.push(`${row.caseId} ${row.path}`);
      continue;
    }
    const top = (regions: ReadonlyArray<Region>, k: number) =>
      new Set(regions.slice(0, k).map(regionKey));
    const compare = (k: number) => {
      const x = top(row.regions, k);
      const y = top(other.regions, k);
      const shared = [...x].filter((key) => y.has(key)).length;
      const size = Math.max(x.size, y.size);
      return {
        differ: x.size !== y.size || shared !== x.size,
        overlap: size === 0 ? 1 : shared / size,
      };
    };
    const three = compare(3);
    const ten = compare(10);
    perHunk.push({
      caseId: row.caseId,
      path: row.path,
      top3Differ: three.differ,
      top10Differ: ten.differ,
      top3Overlap: three.overlap,
      top10Overlap: ten.overlap,
    });
  }
  const mean = (values: ReadonlyArray<number>) =>
    values.length === 0
      ? null
      : values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    hunks: perHunk.length,
    top3Differ: perHunk.filter((entry) => entry.top3Differ).length,
    top10Differ: perHunk.filter((entry) => entry.top10Differ).length,
    meanTop3Overlap: mean(perHunk.map((entry) => entry.top3Overlap)),
    meanTop10Overlap: mean(perHunk.map((entry) => entry.top10Overlap)),
    unpaired,
    perHunk,
  };
};

/**
 * FT4's first condition, on what the harness serves: the share of harness hunks whose top 3 handles
 * (after mapping each region to the harness's own chunk, seed.ts) differ between two arms. Hunks
 * either arm left unseeded count as differing only when exactly one arm seeded them.
 */
export const servedTop3Differ = (
  a: ReadonlyMap<string, ReadonlyArray<string> | null>,
  b: ReadonlyMap<string, ReadonlyArray<string> | null>,
) => {
  const hunks = new Set([...a.keys(), ...b.keys()]);
  let differ = 0;
  for (const hunk of hunks) {
    const x = a.get(hunk) ?? null;
    const y = b.get(hunk) ?? null;
    if (x === null && y === null) continue;
    if (x === null || y === null) {
      differ++;
      continue;
    }
    const left = new Set(x);
    const right = new Set(y);
    if (left.size !== right.size || [...left].some((key) => !right.has(key)))
      differ++;
  }
  return {
    hunks: hunks.size,
    differ,
    share: hunks.size === 0 ? 0 : differ / hunks.size,
  };
};
