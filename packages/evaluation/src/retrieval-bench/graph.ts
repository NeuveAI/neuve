import { defaultGraphVariant } from "./graph-chunk.ts";
import { createHash } from "node:crypto";
import {
  planGraphPreparation,
  prepareGraphGeneration,
  prepareGraphSnapshot,
  GRAPH_ENGINE_GO_MAX_PROCS,
  runGraphInspection,
  type GraphCommandReceipt,
  type GraphDiagnostic,
  type GraphInspectionRequest,
  type GraphLocationNormalization,
  type GraphQueryObservation,
  type GraphRelationshipOutcome,
} from "@neuve/graph-client";
import { Data, Effect } from "effect";
import { chunkFile } from "../../../harness/src/chunker.ts";
import type { BenchChunkVariant } from "./graph-chunk.ts";
import type { Case, Hunk } from "./corpus.ts";
import { gitText } from "./git.ts";
import type { HunkQuery } from "./queries.ts";

/**
 * The Graph arms, all through packages/graph-client:
 * - G-fork: the fork (apps/neuve-graph at f89d58a) answering `query` with exact-commit prepared
 *   reads of a complete full-profile snapshot of the case base.
 * - G-fork-syntax: the same engine on its incremental syntax-only generation (DEFINES and CONTAINS
 *   only, no call graph), the preparation graph-client exposes for products.
 * - G-base: the Entire baseline (5637039f), which has no prepared reads; graph-client's `refresh`
 *   mode builds a complete full-profile index of the exact base before each query, so both engines
 *   rank over a complete full-profile view of the same tree.
 * - S-ref: Graph `neighbors` at depth 1 from the hunk's changed symbols (fork, prepared full), a
 *   reference line that is not a candidate.
 * Graph reads a disposable clone of each corpus under the work directory, never the corpora.
 */

export class GraphFailed extends Data.TaggedError("GraphFailed")<{
  readonly message: string;
}> {}

export const GRAPH_LIMITS = {
  topK: 50,
  maxContextBytes: 8 * 1024 * 1024,
} as const;
/**
 * Deep answers for the allowance curve (9.14): enough results to pass DEEP_TOKENS where the engine
 * has them. The engine returns at most the units that match the query (about 800 on the probes),
 * so a deep answer can still end short of DEEP_TOKENS; that depth is measured and reported.
 */
export const GRAPH_DEEP_LIMITS = {
  topK: 2000,
  maxContextBytes: 64 * 1024 * 1024,
} as const;
/** Bump when the shaping of a stored answer changes (regions, neighbors, normalizations). */
export const GRAPH_ANSWER_RECIPE = "graph-answer-v1";
/**
 * Politeness on a developer machine (6.10): Graph runs one query at a time, its `git grep` uses at
 * most `grepThreads` threads (repository-local config of the clone, which graph-client keeps) and
 * the engine at most `goMaxProcs` OS threads (graph-client's fixed engine environment sets it for
 * every inspection; this process's own environment carries it to the engine it runs itself). Part
 * of each Graph arm's
 * description. B2's answers ran at 4 and 4; lowered to 2 and 2 on 18 October 2026 for the retries
 * (thread counts change timing, never an answer, so answers are not keyed by them).
 */
export const POLITE = {
  grepThreads: 2,
  goMaxProcs: GRAPH_ENGINE_GO_MAX_PROCS,
  concurrency: 1,
} as const;
process.env["GOMAXPROCS"] = String(POLITE.goMaxProcs);
export const SREF = { maxSymbols: 6, limit: 25 } as const;
/**
 * An inspection that runs longer than this is aborted, reported and not stored. A retry may pass a
 * longer `timeoutMs` (InspectInput); the timeout is recorded with the failure, never in the answer.
 */
export const INSPECT_TIMEOUT_MS = 6 * 60 * 1000;

/**
 * The engine runs as its own process group (graph-client), so a terminal's Ctrl-C no longer reaches
 * it. `installShutdown` (called by the benchmark CLI) aborts the running inspection on SIGINT or
 * SIGTERM, which makes graph-client end the engine's group, and exits after a grace longer than
 * graph-client's SIGTERM-to-SIGKILL escalation.
 */
const shutdown = new AbortController();
export const graphShutdownSignal = shutdown.signal;
export const installShutdown = (log: (line: string) => void) => {
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      if (shutdown.signal.aborted) return;
      log(`${signal}: stopping the running Graph command`);
      shutdown.abort();
      setTimeout(() => process.exit(signal === "SIGINT" ? 130 : 143), 3_000);
    });
};

export interface GraphRegion {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly kind: string;
  readonly symbol: string | null;
}

export interface GraphAnswer {
  readonly regions: ReadonlyArray<GraphRegion>;
  readonly queryMillis: number;
  readonly totalMillis: number;
  readonly cache: GraphQueryObservation["cache"] | null;
  readonly indexedFileCount: number | null;
  readonly coverage: string | null;
  readonly budget: GraphQueryObservation["budget"] | null;
  readonly error: string | null;
  /** S-ref only: neighbor definitions of the changed symbols, in request order. */
  readonly neighbors: ReadonlyArray<GraphRegion & { readonly via: string }>;
  readonly relationships: ReadonlyArray<{
    readonly id: string;
    readonly outcome: string;
    readonly observations: number;
  }>;
  /**
   * Result ranges graph-client normalized (GraphLocationNormalization): the Entire baseline
   * reports a symbol ending at a file's last line as ending one line past it, and the boundary
   * clamps exactly that case and says so.
   */
  readonly normalizations: ReadonlyArray<GraphLocationNormalization>;
  /**
   * The engine's warning codes for this query, present only when it reported any. Answers stored
   * before 21 October 2026 never carry it.
   */
  readonly warningCodes?: ReadonlyArray<string>;
}

/**
 * 65f609a's grep deadline (W_GIT_GREP_DEADLINE): the engine stopped its tree grep and answered from
 * a fallback file selection, so the answer is not the engine's complete answer. It is kept as a
 * failure with this cause, never stored as a usable answer.
 */
export const GREP_DEADLINE = "W_GIT_GREP_DEADLINE";

/** The warning codes an observation reports, and the error a grep deadline makes of the answer. */
export const warningOutcome = (warnings: ReadonlyArray<GraphDiagnostic>) => {
  const codes = warnings.map((warning) =>
    warning.kind === "provider" ? warning.code : "message",
  );
  return {
    codes,
    error: codes.includes(GREP_DEADLINE)
      ? `${GREP_DEADLINE}: the engine's tree grep stopped at its deadline; the answer came from a fallback file selection`
      : null,
  };
};

const run = <A>(label: string, action: () => Promise<A>) =>
  Effect.tryPromise({
    try: action,
    catch: (cause) =>
      new GraphFailed({
        message: `${label}: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });

const spawn = (argv: ReadonlyArray<string>, env?: Record<string, string>) =>
  run(argv.slice(0, 3).join(" "), async () => {
    const child = Bun.spawn([...argv], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...env },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0)
      throw new Error(`exit ${code}: ${stderr.trim().slice(0, 500)}`);
    return stdout;
  });

/** A local clone of a corpus (hardlinked objects, no checkout); the corpus itself is only read. */
export const ensureClone = (source: string, target: string) =>
  Effect.gen(function* () {
    if (
      !(yield* Effect.promise(() => Bun.file(`${target}/.git/HEAD`).exists()))
    )
      yield* spawn([
        "git",
        "clone",
        "--quiet",
        "--no-checkout",
        source,
        target,
      ]);
    yield* spawn([
      "git",
      "-C",
      target,
      "config",
      "grep.threads",
      String(POLITE.grepThreads),
    ]);
    return target;
  });

const sha256 = (path: string) =>
  Effect.promise(async () =>
    createHash("sha256")
      .update(new Uint8Array(await Bun.file(path).arrayBuffer()))
      .digest("hex"),
  );

export const engineIdentity = (executable: string) => sha256(executable);

/**
 * Prepares G-fork's complete full-profile snapshot for `commit` through graph-client
 * (`prepareGraphSnapshot`). The engine indexes the committed tree at HEAD, so the clone's HEAD is
 * pointed at the commit first (a git ref update; no files are checked out). Exact-commit prepared
 * reads then find it by commit. Returns the preparation time and graph-client's observation.
 */
export const prepareFull = (
  executable: string,
  clone: string,
  commit: string,
  cacheDirectory: string,
) =>
  Effect.gen(function* () {
    yield* spawn([
      "git",
      "-C",
      clone,
      "update-ref",
      "--no-deref",
      "HEAD",
      commit,
    ]);
    const started = performance.now();
    const prepared = yield* prepareGraphSnapshot(
      { executable, repository: clone, revision: commit },
      { cacheDirectory },
    ).pipe(
      Effect.mapError(
        (error) =>
          new GraphFailed({
            message: `snapshot ${commit}: ${error.reason} ${error.message}`,
          }),
      ),
    );
    return {
      millis: performance.now() - started,
      cache: prepared.cache,
      counts: prepared.counts,
    };
  });

/** Prepares G-fork-syntax's immutable syntax-only generation through graph-client. */
export const prepareSyntax = (
  executable: string,
  clone: string,
  commit: string,
  cacheDirectory: string,
) =>
  Effect.gen(function* () {
    const started = performance.now();
    const plan = yield* planGraphPreparation(
      { executable, repository: clone, revision: commit },
      { cacheDirectory },
    ).pipe(
      Effect.mapError(
        (error) =>
          new GraphFailed({
            message: `plan ${commit}: ${error.reason} ${error.message}`,
          }),
      ),
    );
    const prepared = yield* prepareGraphGeneration(
      {
        executable,
        repository: clone,
        revision: commit,
        expectedGeneration: plan.selection.generationId,
      },
      { cacheDirectory },
    ).pipe(
      Effect.mapError(
        (error) =>
          new GraphFailed({
            message: `prepare ${commit}: ${error.reason} ${error.message}`,
          }),
      ),
    );
    return {
      millis: performance.now() - started,
      work: prepared.work,
      coverage: prepared.coverage,
    };
  });

/** Changed symbols at the base: the shared chunker's symbols overlapping the hunk's pre-image. */
export const changedSymbols = (
  repository: string,
  entry: Case,
  hunk: Hunk,
  variant?: BenchChunkVariant,
) =>
  Effect.gen(function* () {
    const content = yield* gitText(repository, [
      "cat-file",
      "blob",
      `${entry.base}:${hunk.oldPath}`,
    ]).pipe(Effect.orElseSucceed(() => undefined));
    if (content === undefined) return [];
    const selected = variant ?? (yield* Effect.tryPromise(defaultGraphVariant));
    const graphChunks = yield* Effect.tryPromise((signal) =>
      selected.chunk(
        [{ path: hunk.oldPath, bytes: new TextEncoder().encode(content) }],
        signal,
      ),
    );
    const start = Math.max(1, hunk.old.start);
    const end = start + Math.max(1, hunk.old.lines) - 1;
    return [
      ...new Set(
        (
          graphChunks?.get(hunk.oldPath) ??
          chunkFile(hunk.oldPath, content, { kind: "unavailable" })
        ).chunks
          .filter(
            (chunk) =>
              chunk.kind === "symbol" &&
              chunk.startLine <= end &&
              chunk.endLine >= start,
          )
          .flatMap((chunk) => (chunk.symbol ?? "").split(",")),
      ),
    ]
      .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name))
      .slice(0, SREF.maxSymbols);
  });

const regionOf = (
  source: { path: string; startLine: number; endLine: number },
  kind: string,
  symbol: string | null,
): GraphRegion => ({
  path: source.path,
  startLine: source.startLine,
  endLine: source.endLine,
  kind,
  symbol,
});

export interface InspectInput {
  readonly executable: string;
  readonly clone: string;
  readonly commit: string;
  readonly query: HunkQuery;
  readonly mode: "prepared-full" | "prepared-syntax" | "refresh-full";
  /** "pool": the frozen top 50 (with S-ref relationships); "deep": the allowance curve. */
  readonly depth: "pool" | "deep";
  readonly cacheDirectory: string;
  readonly temporaryParent: string;
  /** S-ref: changed symbols in `symbolPath` at the base. */
  readonly symbols?: ReadonlyArray<string>;
  readonly symbolPath?: string;
  /** Abort after this long (default INSPECT_TIMEOUT_MS). */
  readonly timeoutMs?: number;
}

/**
 * graph-client reports a failed query only as "observation unavailable". Its command evidence hook
 * carries each command's exit code and output: the query command's, then the Git reads that qualify
 * each result's source range (`query:source:<path>:metadata|content`). The last of those is kept as
 * the failure's cause: a refused result names its path there.
 */
const commandCause = (
  query: GraphCommandReceipt | undefined,
  last: GraphCommandReceipt | undefined,
) => {
  if (query === undefined) return "the query command did not run";
  const stderr = (receipt: GraphCommandReceipt) =>
    receipt.stderr.trim() === ""
      ? "no stderr"
      : `stderr ${receipt.stderr.trim().slice(-400)}`;
  const head = `query command exit ${query.exitCode}, ${stderr(query)}`;
  if (last === undefined || last === query) return head;
  const output = last.stage.endsWith(":metadata")
    ? `, output ${JSON.stringify(last.stdout.slice(0, 200))}`
    : "";
  return `${head}; last step ${last.stage} exit ${last.exitCode}, ${stderr(last)}${output}`;
};

/** One graph-client inspection: the Q1 query and, for S-ref, depth-1 call neighbors. */
export const inspect = (input: InspectInput) =>
  Effect.suspend(() => {
    const timeoutMs = input.timeoutMs ?? INSPECT_TIMEOUT_MS;
    const started = performance.now();
    return run(
      `inspect ${input.query.hunkId}`,
      async (): Promise<GraphAnswer> => {
        const relationships: Array<
          GraphInspectionRequest["relationships"][number]
        > = (input.symbols ?? []).flatMap((name, index) =>
          (["in", "out"] as const).map((direction) => ({
            id: `${index}-${direction}-${name}`,
            focus: { name, path: input.symbolPath ?? "" },
            relation: "CALLS",
            selection: "family" as const,
            direction,
            depth: 1 as const,
            limit: SREF.limit,
          })),
        );
        let queryMillis = 0;
        let observation: GraphQueryObservation | undefined;
        let error: string | null = null;
        let queryReceipt: GraphCommandReceipt | undefined;
        let lastReceipt: GraphCommandReceipt | undefined;
        const outcomes: Array<{
          id: string;
          outcome: GraphRelationshipOutcome;
        }> = [];
        await runGraphInspection(
          {
            executable: input.executable,
            repository: input.clone,
            revision: input.commit,
            question: input.query.text,
            limits: input.depth === "deep" ? GRAPH_DEEP_LIMITS : GRAPH_LIMITS,
            relationships,
            cache: input.mode === "refresh-full" ? "refresh" : "prepared",
            profile: input.mode === "prepared-syntax" ? "syntax-only" : "full",
          },
          {
            cacheDirectory: input.cacheDirectory,
            temporaryParent: input.temporaryParent,
            signal: AbortSignal.any([
              AbortSignal.timeout(timeoutMs),
              shutdown.signal,
            ]),
            onCommand: (receipt) => {
              if (receipt.stage === "query") queryReceipt = receipt;
              if (receipt.stage.startsWith("query")) lastReceipt = receipt;
            },
            emit: async (event) => {
              if (event.kind === "retrieval") {
                queryMillis = performance.now() - started;
                if (event.outcome.kind === "success")
                  observation = event.outcome.value;
                else
                  error = `${event.outcome.error.message} (${commandCause(queryReceipt, lastReceipt)})`;
              } else if (event.kind === "relationship")
                outcomes.push({ id: event.requestId, outcome: event.outcome });
            },
          },
        );
        const neighbors: Array<GraphRegion & { via: string }> = [];
        const seen = new Set<string>();
        for (const { id, outcome } of outcomes) {
          if (outcome.kind !== "success") continue;
          for (const relation of outcome.value.observations) {
            const endpoint =
              relation.direction === "in" ? relation.from : relation.to;
            const location = endpoint.location;
            if (endpoint.external || location.kind !== "range") continue;
            const key = `${location.path}:${location.startLine}-${location.endLine}`;
            if (seen.has(key)) continue;
            seen.add(key);
            neighbors.push({
              ...regionOf(
                location,
                endpoint.symbolKind ?? "symbol",
                endpoint.name,
              ),
              via: id,
            });
          }
        }
        const warned = warningOutcome(observation?.warnings ?? []);
        return {
          regions: (observation?.results ?? []).map((result) =>
            regionOf(
              result.source,
              result.kind,
              "symbol" in result && typeof result.symbol === "string"
                ? result.symbol
                : null,
            ),
          ),
          queryMillis,
          totalMillis: performance.now() - started,
          cache: observation?.cache ?? null,
          indexedFileCount: observation?.indexedFileCount ?? null,
          coverage: observation?.coverage ?? null,
          budget: observation?.budget ?? null,
          error: error ?? warned.error,
          neighbors,
          relationships: outcomes.map(({ id, outcome }) => ({
            id,
            outcome:
              outcome.kind === "success"
                ? outcome.value.focus.kind
                : outcome.kind,
            observations:
              outcome.kind === "success"
                ? outcome.value.observations.length
                : 0,
          })),
          normalizations: observation?.normalizations ?? [],
          ...(warned.codes.length > 0 ? { warningCodes: warned.codes } : {}),
        };
      },
    ).pipe(
      Effect.mapError((failure) =>
        failure.message.endsWith("Graph inspection aborted.")
          ? new GraphFailed({
              message: `${failure.message} Timed out after ${Math.round((performance.now() - started) / 1000)} s (limit ${timeoutMs / 60000} min).`,
            })
          : failure,
      ),
    );
  });
