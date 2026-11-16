import { codeCheckpoint } from "./code-work.ts";
import { availableParallelism } from "node:os";
import { Context, Effect, Option } from "effect";
import { z } from "zod";
import type { Computations } from "@neuve/records-core";
import type { HunkRecord } from "./hunks.ts";
import {
  type Retriever,
  type RetrieverConfig,
  SearchResult,
} from "./retriever.ts";
import { indexRecipe, jsonComputation, storedOutput } from "./search-index.ts";

/**
 * Leads belong to the file's base/head blob pair and query. Unchanged files reuse them across
 * heads and cycles. Old hunk-text keys remain readable under their original reuse rule.
 */

export const LEADS_PER_HUNK = 10;
/** Each pool admits at most four searches, sized at a quarter of the logical CPU count. */
export const LEAD_CONCURRENCY = Math.max(
  1,
  Math.min(4, Math.floor(availableParallelism() / 4)),
);

/** Internal measurement seam; callers use the machine-sized default. */
export const LeadConcurrency = Context.Reference<number>(
  "@neuve/harness/LeadConcurrency",
  {
    defaultValue: () => LEAD_CONCURRENCY,
  },
);

export const HunkLeads = z.strictObject({
  /** The tree the query was searched in. */
  tree: z.string(),
  querySha256: z.string(),
  results: z.array(SearchResult),
  millis: z.int().min(0),
  /** Why the leads are not what the retriever's name suggests (a frozen row with no usable region). */
  note: z.string().optional(),
});
export type HunkLeads = z.infer<typeof HunkLeads>;

export const legacyLeadsSpec = (
  hunk: HunkRecord,
  retriever: RetrieverConfig,
  index: ReturnType<typeof indexRecipe>,
  keyed?: Readonly<Record<string, string>> | undefined,
): Computations.ComputationSpec => ({
  op: "harness.hunk-leads",
  opVersion: 1,
  inputs: {
    hunk: hunk.textSha256,
    oldPath: hunk.oldPath,
    oldBlob: hunk.oldOid === null ? null : `git-blob:${hunk.oldOid}`,
    newPath: hunk.newPath,
  },
  config: {
    retriever,
    index,
    query: hunk.query?.recipe ?? null,
    limit: LEADS_PER_HUNK,
    ...(keyed === undefined ? {} : { keyed }),
  } as never,
});

/** A file's range queries depend on both blobs. Keep the hunk identity inside the file. */
export const leadsSpec = (
  hunk: HunkRecord,
  retriever: RetrieverConfig,
  index: ReturnType<typeof indexRecipe>,
  keyed?: Readonly<Record<string, string>> | undefined,
): Computations.ComputationSpec => ({
  ...legacyLeadsSpec(hunk, retriever, index, keyed),
  opVersion: 2,
  inputs: {
    oldBlob: hunk.oldOid,
    newBlob: hunk.newOid,
    oldPath: hunk.oldPath,
    newPath: hunk.newPath,
    query: hunk.query?.sha256 ?? null,
  },
});

/** The stored leads of a hunk, if any were computed under the same key. */
export const cachedLeads = (
  hunk: HunkRecord,
  retriever: RetrieverConfig,
  index: ReturnType<typeof indexRecipe>,
  keyed?: Readonly<Record<string, string>> | undefined,
) =>
  Effect.gen(function* () {
    const current = yield* storedOutput(
      leadsSpec(hunk, retriever, index, keyed),
      HunkLeads,
    );
    if (Option.isSome(current)) return current;
    return yield* storedOutput(
      legacyLeadsSpec(hunk, retriever, index, keyed),
      HunkLeads,
    );
  });

/** The hunk's leads: stored ones when the key matches, else searched now and stored. */
export const hunkLeads = (hunk: HunkRecord, retriever: Retriever) =>
  Effect.gen(function* () {
    yield* codeCheckpoint;
    const query = hunk.query;
    if (query === null) return undefined;
    // A retriever that ranks by hunk (a frozen candidate) serves the hunk's own leads when it has
    // them; otherwise, and for every other retriever, the hunk's query is searched.
    const searched = (note?: string) =>
      Effect.map(
        retriever
          .search({
            text: query.text,
            sha256: query.sha256,
            limit: LEADS_PER_HUNK,
          })
          .pipe(Effect.withSpan("harness.leads.search")),
        (answer): HunkLeads => {
          // A hybrid lead says what its fusion went without (Graph's answer, E0's over-long chunks).
          const told =
            note ??
            (retriever.description.family === "hybrid" &&
            (answer.gaps?.length ?? 0) > 0
              ? answer.gaps!.join("; ")
              : undefined);
          return {
            tree: retriever.tree,
            querySha256: query.sha256,
            results: [...answer.results],
            millis: answer.millis,
            ...(told === undefined ? {} : { note: told }),
          };
        },
      );
    const legacy = yield* cachedLeads(
      hunk,
      retriever.description.config,
      retriever.description.index,
      retriever.description.keyed,
    );
    if (Option.isSome(legacy))
      return { status: "reused" as const, value: legacy.value };
    const result = yield* jsonComputation(
      leadsSpec(
        hunk,
        retriever.description.config,
        retriever.description.index,
        retriever.description.keyed,
      ),
      HunkLeads,
      retriever.leadsFor === undefined
        ? searched()
        : Effect.flatMap(retriever.leadsFor(hunk), (fixed) =>
            fixed?.results === undefined
              ? searched(fixed?.note)
              : Effect.succeed<HunkLeads>({
                  tree: retriever.tree,
                  querySha256: query.sha256,
                  results: [...fixed.results],
                  millis: 0,
                  ...(fixed.note === undefined ? {} : { note: fixed.note }),
                }),
          ),
    );
    return result;
  });
