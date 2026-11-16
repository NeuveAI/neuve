import type { SourceKind } from "./corpus.ts";

/**
 * An arm's ranking as B4 reads it. A ranking is an arm's ordered answer for one hunk: the frozen top 50
 * followed by the deep ranking up to the largest allowance (DEEP_TOKENS, 512k), as regions of the case
 * base. Items are shared between rankings of the same base, so many arms over 71 hunks stay small.
 */

export interface Item {
  /** `path#Lstart-Lend`: the span key, equal to the chunk id for shared chunks. */
  readonly key: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly kind: SourceKind;
  readonly tokens: number;
  /** The shared chunk this is, or null for Graph's own regions. */
  readonly chunkId: string | null;
  /** SHA-256 of the chunk text in the benchmark store (chunks only). */
  readonly hash: string | null;
}

export interface Ranking {
  readonly items: ReadonlyArray<Item>;
  /** The arm's score per item, best first; rank-derived (1 / (rank + 1)) where an arm has none. */
  readonly scores: ReadonlyArray<number>;
}

export const spanKey = (path: string, start: number, end: number) =>
  `${path}#L${start}-L${end}`;
