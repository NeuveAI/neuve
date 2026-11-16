import type { Occurrence } from "./corpus.ts";

/**
 * L: BM25 over the shared chunks, path plus body, k1 = 1.2 and b = 0.75 (proposal, section 4; the
 * MAX diagnostic's lexical baseline). Rewritten small rather than imported from research code.
 * Terms are lowercase alphanumeric runs, plus the parts of camelCase and snake_case identifiers.
 */

export const BM25 = {
  k1: 1.2,
  b: 0.75,
  recipe: "bm25-path-body-identifier-parts-v1",
} as const;

export const terms = (text: string): Array<string> => {
  const out: Array<string> = [];
  for (const word of text.match(/[A-Za-z0-9_]+/g) ?? []) {
    const lower = word.toLowerCase();
    out.push(lower);
    const parts = word
      .split("_")
      .flatMap((piece) =>
        piece.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/),
      )
      .map((part) => part.toLowerCase())
      .filter((part) => part !== "");
    if (parts.length > 1) for (const part of parts) out.push(part);
  }
  return out;
};

export interface Bm25Index {
  readonly documents: number;
  readonly averageLength: number;
  readonly lengths: Uint32Array;
  readonly postings: ReadonlyMap<
    string,
    { docs: Uint32Array; tfs: Uint32Array }
  >;
}

/** Builds the index over `texts`, which are aligned with the base's occurrences. */
export const buildIndex = (texts: ReadonlyArray<string>): Bm25Index => {
  const lengths = new Uint32Array(texts.length);
  const lists = new Map<string, { docs: Array<number>; tfs: Array<number> }>();
  texts.forEach((text, doc) => {
    const counts = new Map<string, number>();
    const list = terms(text);
    lengths[doc] = list.length;
    for (const term of list) counts.set(term, (counts.get(term) ?? 0) + 1);
    for (const [term, tf] of counts) {
      let posting = lists.get(term);
      if (posting === undefined)
        lists.set(term, (posting = { docs: [], tfs: [] }));
      posting.docs.push(doc);
      posting.tfs.push(tf);
    }
  });
  const postings = new Map<string, { docs: Uint32Array; tfs: Uint32Array }>();
  for (const [term, posting] of lists)
    postings.set(term, {
      docs: Uint32Array.from(posting.docs),
      tfs: Uint32Array.from(posting.tfs),
    });
  const total = lengths.reduce((sum, length) => sum + length, 0);
  return {
    documents: texts.length,
    averageLength: texts.length === 0 ? 0 : total / texts.length,
    lengths,
    postings,
  };
};

export const indexBytes = (index: Bm25Index) => {
  let bytes = index.lengths.byteLength;
  for (const [term, posting] of index.postings)
    bytes += term.length * 2 + posting.docs.byteLength + posting.tfs.byteLength;
  return bytes;
};

/** Scores every document for the query's distinct terms; best first, ties by chunk id. */
export const bm25Ranking = (
  index: Bm25Index,
  occurrences: ReadonlyArray<Occurrence>,
  query: string,
) => {
  const scores = new Float64Array(index.documents);
  for (const term of [...new Set(terms(query))].sort()) {
    const posting = index.postings.get(term);
    if (posting === undefined) continue;
    const df = posting.docs.length;
    const idf = Math.log(1 + (index.documents - df + 0.5) / (df + 0.5));
    for (let at = 0; at < df; at++) {
      const doc = posting.docs[at] ?? 0;
      const tf = posting.tfs[at] ?? 0;
      const norm =
        1 - BM25.b + (BM25.b * (index.lengths[doc] ?? 0)) / index.averageLength;
      scores[doc] =
        (scores[doc] ?? 0) + (idf * tf * (BM25.k1 + 1)) / (tf + BM25.k1 * norm);
    }
  }
  return [...occurrences.keys()]
    .filter((row) => (scores[row] ?? 0) > 0)
    .sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0) || a - b)
    .map((row) => ({
      occurrence: occurrences[row] as Occurrence,
      score: scores[row] ?? 0,
    }));
};
