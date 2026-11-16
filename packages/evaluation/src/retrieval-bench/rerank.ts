import { createHash } from "node:crypto";
import { Computations } from "@neuve/records-core";
import { Effect, Option } from "effect";
import { chunkText, type BaseCorpus } from "./corpus.ts";
import type { EncoderProcess } from "./encoder.ts";
import { modelIdentity, type ModelEntry } from "./models.ts";
import type { HunkQuery } from "./queries.ts";
import type { ArmAnswer, PoolRow } from "./retriever.ts";
import { regionsFromRow } from "./retriever.ts";
import { readStoredJson, storedJson } from "./stored.ts";

/**
 * R: Qwen3-Reranker-0.6B over a frozen top-50 pool (proposal, section 4). Each (query, region text)
 * score is a computation keyed by the model identity and both texts' hashes, so reranking another
 * arm's pool only scores pairs not seen before (5.4). The output order is by score, ties by the
 * pool's own rank.
 */

/** The arm B2's R reranks. R keeps its bare name; R over any other arm is `R(<arm>)` (9.57). */
export const R_CANDIDATES = "H3-E2";
export const rerankArm = (candidates: string) =>
  candidates === R_CANDIDATES ? "R" : `R(${candidates})`;

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

const pairSpec = (model: ModelEntry, query: HunkQuery, document: string) => ({
  op: "bench.rerank",
  opVersion: 1,
  inputs: { query: `blob:${query.sha256}`, document: `blob:${hash(document)}` },
  config: { model: modelIdentity(model) },
});

export const rerankPairKey = (
  model: ModelEntry,
  query: HunkQuery,
  document: string,
) => Computations.computationKey(pairSpec(model, query, document)).key;

/** The pool's documents in the model's format, and which pairs have no stored score. */
export const poolDocuments = (
  model: ModelEntry,
  row: PoolRow,
  query: HunkQuery,
  base: BaseCorpus,
) =>
  Effect.gen(function* () {
    const byId = new Map(
      base.occurrences.map((occurrence) => [occurrence.chunkId, occurrence]),
    );
    const documents: Array<string> = [];
    for (const region of regionsFromRow(row)) {
      const occurrence =
        region.chunkId === null ? undefined : byId.get(region.chunkId);
      if (occurrence === undefined)
        return yield* Effect.die(
          new Error(
            `${row.hunkId}: ${String(region.chunkId)} is not a chunk of the base`,
          ),
        );
      documents.push(
        model.format.document(
          occurrence.path,
          yield* chunkText(occurrence.hash),
        ),
      );
    }
    const missing: Array<number> = [];
    for (const [index, document] of documents.entries())
      if (
        Option.isNone(
          yield* readStoredJson<number>(pairSpec(model, query, document)),
        )
      )
        missing.push(index);
    return { documents, missing };
  });

/** One request per pair, including repeats within a pool or across identical queries. */
export const uniquePairIndices = (
  query: Pick<HunkQuery, "sha256">,
  documents: readonly string[],
  missing: readonly number[],
  seen: Set<string>,
): number[] =>
  missing.filter((index) => {
    const key = `${query.sha256}\0${documents[index]}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

/** A stored score for one (query, document) pair, if R has scored it. */
export const storedPairScore = (
  model: ModelEntry,
  query: HunkQuery,
  document: string,
) => readStoredJson<number>(pairSpec(model, query, document));

/** Stores scores computed elsewhere (the Modal transport) under the same pair keys. */
export const storePairScores = (
  model: ModelEntry,
  query: HunkQuery,
  documents: ReadonlyArray<string>,
  scores: ReadonlyArray<number>,
) =>
  Effect.forEach(
    documents,
    (document, index) =>
      storedJson(
        pairSpec(model, query, document),
        Effect.succeed(scores[index] ?? 0),
      ),
    { discard: true },
  );

export const rerankRow = (
  model: ModelEntry,
  arm: string,
  row: PoolRow,
  query: HunkQuery,
  base: BaseCorpus,
  encoder: EncoderProcess | undefined,
) =>
  Effect.gen(function* () {
    const byId = new Map(
      base.occurrences.map((occurrence) => [occurrence.chunkId, occurrence]),
    );
    const regions = regionsFromRow(row);
    const documents: Array<string> = [];
    for (const region of regions) {
      const occurrence =
        region.chunkId === null ? undefined : byId.get(region.chunkId);
      if (occurrence === undefined)
        return yield* Effect.die(
          new Error(
            `${row.hunkId}: ${String(region.chunkId)} is not a chunk of the base`,
          ),
        );
      documents.push(
        model.format.document(
          occurrence.path,
          yield* chunkText(occurrence.hash),
        ),
      );
    }
    const scores: Array<number> = [];
    const missing: Array<number> = [];
    for (const [index, document] of documents.entries()) {
      const stored = yield* readStoredJson<number>(
        pairSpec(model, query, document),
      );
      if (Option.isSome(stored)) scores[index] = stored.value;
      else missing.push(index);
    }
    let millis = 0;
    if (missing.length > 0) {
      if (encoder === undefined)
        return yield* Effect.die(
          new Error(`${row.hunkId}: reranker scores are not stored`),
        );
      const started = performance.now();
      const result = yield* encoder.rerank(
        model.format.query(query.text),
        missing.map((index) => documents[index] ?? ""),
      );
      millis = performance.now() - started;
      for (const [position, index] of missing.entries()) {
        const score = result.scores[position] ?? 0;
        scores[index] = score;
        yield* storedJson(
          pairSpec(model, query, documents[index] ?? ""),
          Effect.succeed(score),
        );
      }
    }
    const order = regions
      .map((_, index) => index)
      .sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0) || a - b);
    return {
      arm,
      caseId: row.caseId,
      hunkId: row.hunkId,
      regions: order.map((index) => ({
        ...(regions[index] as (typeof regions)[number]),
        score: scores[index] ?? 0,
      })),
      timing: {
        millis,
        stages: { rerank: millis, pairsScored: missing.length },
        cold: false,
      },
    } satisfies ArmAnswer;
  });
