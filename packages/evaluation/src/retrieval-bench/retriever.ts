import { gunzipSync, gzipSync } from "node:zlib";
import { z } from "zod";
import { byCodepoint } from "./policy.ts";
import {
  KINDS,
  type BaseCorpus,
  type Occurrence,
  type SourceKind,
} from "./corpus.ts";

/**
 * The one retriever interface every B2 arm answers through. A query is a Q1 hunk query
 * (queries.ts); an answer is a ranked list of regions of the case base: path, 1-based inclusive
 * line span, the shared chunk it is (null for Graph's own regions), its source kind, its size in
 * counting-tokenizer tokens and the arm's score, plus the arm's timing for that hunk.
 *
 * Each arm's top-50 per hunk is frozen as data (`pools/dev/<arm>.jsonl.gz`) for labelling (B3) and
 * scoring (B4); chunk and Graph arms also store their deeper ranking, up to the largest allowance,
 * in the benchmark store so B4 can read budgets past the pool without re-running anything.
 */

export const POOL_DEPTH = 50;
/**
 * The largest allowance on the 9.14 curve: deep rankings are kept up to this many tokens. Raised
 * from 256k to 512k on 18 October 2026 so every dev hunk's Opus real share fits (the largest is
 * about 457k); the 256k rankings stay in the store under their own key.
 */
export const DEEP_TOKENS = 512_000;
/**
 * The depth each input list of an RRF fusion (H1, H2, H3) is cut at before fusing: B2's deep cap,
 * which the frozen fusion pools were built from. Kept at 256k so the fused order of those items, and
 * so the pools, never change with DEEP_TOKENS; deeper input items extend the fusion as a tail
 * (fusion.ts, `layeredRrf`).
 */
export const FUSION_INPUT_TOKENS = 256_000;

export interface Region {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly chunkId: string | null;
  readonly kind: SourceKind;
  readonly tokens: number;
  readonly score: number;
}

export interface Timing {
  /** Wall time for this hunk's answer, split where the arm has separable stages. */
  readonly millis: number;
  readonly stages: Readonly<Record<string, number>>;
  /** First answer on a freshly loaded base or model; the rest are warm. */
  readonly cold: boolean;
}

export interface ArmAnswer {
  readonly arm: string;
  readonly caseId: string;
  readonly hunkId: string;
  readonly regions: ReadonlyArray<Region>;
  readonly timing: Timing;
  readonly note?: string;
}

export interface ArmDescription {
  readonly arm: string;
  readonly family:
    "graph" | "lexical" | "dense" | "fusion" | "rerank" | "reference";
  readonly label: string;
  readonly config: unknown;
}

/** The frozen row: regions as [path, start, end, chunkId, kind, tokens, score]. */
export const PoolRow = z.strictObject({
  arm: z.string(),
  caseId: z.string(),
  hunkId: z.string(),
  regions: z.array(
    z.tuple([
      z.string(),
      z.int(),
      z.int(),
      z.string().nullable(),
      z.enum(KINDS),
      z.int(),
      z.number(),
    ]),
  ),
});
export type PoolRow = z.infer<typeof PoolRow>;

const round = (score: number) => Number(score.toPrecision(9));

export const poolRow = (answer: ArmAnswer, depth = POOL_DEPTH): PoolRow => ({
  arm: answer.arm,
  caseId: answer.caseId,
  hunkId: answer.hunkId,
  regions: answer.regions
    .slice(0, depth)
    .map((region) => [
      region.path,
      region.startLine,
      region.endLine,
      region.chunkId,
      region.kind,
      region.tokens,
      round(region.score),
    ]),
});

export const regionsFromRow = (row: PoolRow): Array<Region> =>
  row.regions.map(
    ([path, startLine, endLine, chunkId, kind, tokens, score]) => ({
      path,
      startLine,
      endLine,
      chunkId,
      kind,
      tokens,
      score,
    }),
  );

/** A ranked chunk list as regions, cut at `maxTokens` cumulative tokens (at least `minItems`). */
export const chunkRegions = (
  ranked: ReadonlyArray<{
    readonly occurrence: Occurrence;
    readonly score: number;
  }>,
  tokensOf: (occurrence: Occurrence) => number,
  maxTokens: number,
  minItems = POOL_DEPTH,
): Array<Region> => {
  const out: Array<Region> = [];
  let total = 0;
  for (const { occurrence, score } of ranked) {
    if (out.length >= minItems && total >= maxTokens) break;
    const tokens = tokensOf(occurrence);
    total += tokens;
    out.push({
      path: occurrence.path,
      startLine: occurrence.startLine,
      endLine: occurrence.endLine,
      chunkId: occurrence.chunkId,
      kind: occurrence.kind,
      tokens,
      score,
    });
  }
  return out;
};

/** Occurrences of a base by path, for projecting other regions onto the shared chunks. */
export const byPath = (base: BaseCorpus) => {
  const map = new Map<string, Array<Occurrence>>();
  for (const occurrence of base.occurrences) {
    const list = map.get(occurrence.path) ?? [];
    list.push(occurrence);
    map.set(occurrence.path, list);
  }
  for (const list of map.values())
    list.sort((a, b) => a.startLine - b.startLine);
  return map;
};

/**
 * Projects ranked regions (Graph's own spans) onto the shared chunks they overlap, keeping the
 * regions' order and each region's chunks in line order; a chunk keeps its first position. Used
 * only to fuse Graph with chunk arms.
 */
export const projectToChunks = (
  regions: ReadonlyArray<Pick<Region, "path" | "startLine" | "endLine">>,
  index: ReadonlyMap<string, ReadonlyArray<Occurrence>>,
) => {
  const seen = new Set<string>();
  const out: Array<Occurrence> = [];
  for (const region of regions)
    for (const occurrence of index.get(region.path) ?? [])
      if (
        occurrence.startLine <= region.endLine &&
        occurrence.endLine >= region.startLine &&
        !seen.has(occurrence.chunkId)
      ) {
        seen.add(occurrence.chunkId);
        out.push(occurrence);
      }
  return out;
};

export const sortRows = (rows: ReadonlyArray<PoolRow>) =>
  [...rows].sort(
    (a, b) =>
      byCodepoint(a.caseId, b.caseId) || byCodepoint(a.hunkId, b.hunkId),
  );

/**
 * Frozen pools are gzipped JSONL, `pools/<split>/<arm>.jsonl.gz`, and so are the leads files
 * (leads.ts): any rows given here. Node's gzip header carries no file name and a zero modification
 * time, the level is fixed and the OS byte is set to "unknown", so the same rows always give the
 * same bytes on any platform and a rerun can be checked byte for byte.
 */
export const poolFile = (directory: string, arm: string) =>
  `${directory}/${arm}.jsonl.gz`;

export const encodePool = (rows: ReadonlyArray<unknown>) => {
  const bytes = gzipSync(
    Buffer.from(rows.map((row) => JSON.stringify(row)).join("\n") + "\n"),
    { level: 9 },
  );
  // The header's OS byte depends on the platform zlib was built for; 255 means unknown everywhere.
  bytes[9] = 0xff;
  return bytes;
};

export const decodePool = (bytes: Uint8Array): Array<PoolRow> =>
  gunzipSync(bytes)
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => PoolRow.parse(JSON.parse(line)));
