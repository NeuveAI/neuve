import type { BenchChunkVariant } from "./graph-chunk.ts";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { Effect, Option } from "effect";
import type { Case } from "./corpus.ts";
import {
  GRAPH_ANSWER_RECIPE,
  GRAPH_DEEP_LIMITS,
  GRAPH_LIMITS,
  INSPECT_TIMEOUT_MS,
  SREF,
  changedSymbols,
  engineIdentity,
  ensureClone,
  inspect,
  prepareFull,
  prepareSyntax,
  type GraphAnswer,
  type InspectInput,
} from "./graph.ts";
import type { CorpusKey } from "./policy.ts";
import type { HunkQuery } from "./queries.ts";
import { readStoredJson, storedJson } from "./stored.ts";

/**
 * Runs the Graph arms over the dev hunks. Each answer is a computation keyed by the engine's
 * SHA-256, the read mode, the exact commit, the query text and the limits, so a rerun reuses it
 * (5.4); `fresh` answers again without storing, for the determinism check.
 */

export const GRAPH_ARMS = [
  "G-fork",
  "G-fork-syntax",
  "G-base",
  "S-ref",
] as const;

export interface GraphSetup {
  readonly variant?: BenchChunkVariant | undefined;
  readonly work: string;
  readonly forkEngine: string;
  readonly baseEngine: string;
  readonly repositories: Record<CorpusKey, string>;
  /** Inspection timeout for answers computed in this run (default INSPECT_TIMEOUT_MS). */
  readonly timeoutMs?: number;
}

/**
 * Stored answers by version. Version 4 is current: answers straight from graph-client, which
 * normalizes the baseline's end-line-past-EOF ranges itself, stored only when usable (no error),
 * keyed by the answer recipe and the depth's limits. Earlier versions hold pool answers only and are
 * read only where they cannot differ from version 4 (the recipe at version 3 is graph-answer-v1):
 * version 3, and version 2 or 1 answers without an error and without the benchmark's former receipt
 * recovery (version 2's G-base key carried a `recovery` setting; version 1 also stored failures).
 * Recovered and failed answers are answered again through the boundary.
 */
type Version = 1 | 2 | 3 | 4;
const graphSpec = (
  engine: string,
  input: InspectInput,
  opVersion: Version = 4,
) => ({
  op: "bench.graph",
  opVersion,
  inputs: {
    commit: `git-commit:${input.commit}`,
    query: `blob:${input.query.sha256}`,
  },
  config: {
    engine,
    mode: input.mode,
    limits: input.depth === "deep" ? GRAPH_DEEP_LIMITS : GRAPH_LIMITS,
    symbols: [...(input.symbols ?? [])],
    symbolPath: input.symbolPath ?? null,
    sref: SREF,
    ...(opVersion === 4 ? { recipe: GRAPH_ANSWER_RECIPE } : {}),
    ...(opVersion === 2 && input.mode === "refresh-full"
      ? { recovery: "baseline-eof-clamp-v2" }
      : {}),
  },
});

export interface Plan {
  readonly arm: "G-fork" | "G-fork-syntax" | "G-base";
  readonly depth: "pool" | "deep";
  readonly input: InspectInput;
  readonly engine: string;
}

export const graphPlans = (
  setup: GraphSetup,
  entry: Case,
  query: HunkQuery,
  symbols: ReadonlyArray<string>,
  symbolPath: string,
) =>
  Effect.gen(function* () {
    const clone = join(setup.work, "clones", entry.repository);
    const temporaryParent = join(setup.work, "graph-views");
    mkdirSync(temporaryParent, { recursive: true });
    const fork = yield* engineIdentity(setup.forkEngine);
    const base = yield* engineIdentity(setup.baseEngine);
    const common = {
      clone,
      commit: entry.base,
      query,
      temporaryParent,
      ...(setup.timeoutMs === undefined ? {} : { timeoutMs: setup.timeoutMs }),
    };
    const engines = {
      "G-fork": {
        engine: fork,
        executable: setup.forkEngine,
        mode: "prepared-full",
        cacheDirectory: join(setup.work, "graph-cache-fork"),
      },
      "G-fork-syntax": {
        engine: fork,
        executable: setup.forkEngine,
        mode: "prepared-syntax",
        cacheDirectory: join(setup.work, "graph-cache-fork"),
      },
      "G-base": {
        engine: base,
        executable: setup.baseEngine,
        mode: "refresh-full",
        cacheDirectory: join(setup.work, "graph-cache-base"),
      },
    } as const;
    return (["pool", "deep"] as const).flatMap((depth) =>
      (["G-fork", "G-fork-syntax", "G-base"] as const).map((arm) => {
        const { engine, ...rest } = engines[arm];
        return {
          arm,
          depth,
          engine,
          input: {
            ...common,
            ...rest,
            depth,
            // S-ref's relationships ride on G-fork's pool answer only.
            ...(arm === "G-fork" && depth === "pool"
              ? { symbols, symbolPath }
              : {}),
          },
        };
      }),
    ) satisfies ReadonlyArray<Plan>;
  });

export interface StoredGraphAnswer {
  readonly arm: Plan["arm"];
  readonly depth: Plan["depth"];
  readonly hunkId: string;
  readonly answer: GraphAnswer;
}

/**
 * A plan with no usable answer after this run: the cause (the engine's error with its command exit
 * and stderr, or the timeout), the timeout it ran under and how long it took. Failures are never
 * stored as answers; the run's log keeps them and `pools` folds them into arms.dev.json.
 */
export interface GraphFailureRecord {
  readonly arm: Plan["arm"];
  readonly depth: Plan["depth"];
  readonly hunkId: string;
  readonly cause: string;
  readonly timeoutMs: number;
  readonly seconds: number;
  readonly at: string;
}

/**
 * Graph failures by plan (`arm:depth:hunkId`), every attempt kept in order: the log directory's
 * graph-failures.json. A plan answered later leaves the file.
 */
export type GraphFailures = Record<
  string,
  Array<Omit<GraphFailureRecord, "arm" | "depth" | "hunkId">>
>;
export const failureKey = (arm: string, depth: string, hunkId: string) =>
  `${arm}:${depth}:${hunkId}`;

/**
 * Answers (or reads) every Graph arm for the given cases' hunks, preparing each base once when
 * needed. `include` limits which plans run (a targeted retry); the rest are neither read nor
 * answered. `onFailure` sees each failure as it happens, so a caller can record it before the run
 * ends (a crash then keeps it).
 */
export const runGraph = (
  setup: GraphSetup,
  cases: ReadonlyArray<Case>,
  queries: ReadonlyMap<string, HunkQuery>,
  log: (line: string) => void,
  include: (plan: Plan, hunkId: string) => boolean = () => true,
  onFailure: (failure: GraphFailureRecord) => void = () => {},
) =>
  Effect.gen(function* () {
    for (const key of ["neuve", "neuve_effect"] as const)
      yield* ensureClone(
        setup.repositories[key],
        join(setup.work, "clones", key),
      );
    const byBase = new Map<string, Array<Case>>();
    for (const entry of cases) {
      const key = `${entry.repository}:${entry.base}`;
      byBase.set(key, [...(byBase.get(key) ?? []), entry]);
    }
    const preparation: Array<Record<string, unknown>> = [];
    const answers: Array<StoredGraphAnswer> = [];
    const failures: Array<GraphFailureRecord> = [];
    for (const [key, entries] of [...byBase.entries()].sort(([a], [b]) =>
      a < b ? -1 : 1,
    )) {
      const first = entries[0] as Case;
      const work: Array<{ plan: Plan; hunkId: string }> = [];
      for (const entry of entries)
        for (const hunk of entry.hunks) {
          const query = queries.get(hunk.id);
          if (query === undefined)
            return yield* Effect.die(new Error(`no query for ${hunk.id}`));
          const symbols = yield* changedSymbols(
            setup.repositories[entry.repository],
            entry,
            hunk,
            setup.variant,
          );
          for (const plan of yield* graphPlans(
            setup,
            entry,
            query,
            symbols,
            hunk.oldPath,
          ))
            if (include(plan, hunk.id)) work.push({ plan, hunkId: hunk.id });
        }
      let missing = 0;
      for (const { plan } of work)
        if (Option.isNone(yield* storedAnswer(plan))) missing++;
      if (missing > 0) {
        const clone = join(setup.work, "clones", first.repository);
        const full = yield* prepareFull(
          setup.forkEngine,
          clone,
          first.base,
          join(setup.work, "graph-cache-fork"),
        );
        const syntax = yield* prepareSyntax(
          setup.forkEngine,
          clone,
          first.base,
          join(setup.work, "graph-cache-fork"),
        );
        preparation.push({
          base: key,
          forkFullMillis: Math.round(full.millis),
          forkFullCache: full.cache.status,
          forkFullCounts: full.counts,
          forkSyntaxMillis: Math.round(syntax.millis),
          syntaxWork: syntax.work,
        });
        log(
          `${key}: prepared fork full in ${(full.millis / 1000).toFixed(1)} s (${full.cache.status}), syntax in ${(syntax.millis / 1000).toFixed(1)} s (${missing} answers to compute)`,
        );
      }
      for (const { plan, hunkId } of work) {
        const started = performance.now();
        const result = yield* answerPlan(plan).pipe(
          Effect.catchTag("GraphFailed", (error) =>
            Effect.succeed({
              value: undefined,
              status: `failed: ${error.message}`,
            }),
          ),
        );
        const failed =
          result.value === undefined
            ? result.status.slice("failed: ".length)
            : result.status === "failed (not stored)"
              ? (result.value.error ?? "unknown")
              : null;
        if (failed !== null) {
          const failure: GraphFailureRecord = {
            arm: plan.arm,
            depth: plan.depth,
            hunkId,
            cause: failed,
            timeoutMs: plan.input.timeoutMs ?? INSPECT_TIMEOUT_MS,
            seconds: Math.round((performance.now() - started) / 100) / 10,
            at: new Date().toISOString(),
          };
          failures.push(failure);
          onFailure(failure);
        }
        if (result.value === undefined) {
          log(
            `${key} ${hunkId} ${plan.arm}${plan.depth === "deep" ? " deep" : ""}: ${result.status}`,
          );
          continue;
        }
        const { value, status } = result;
        answers.push({
          arm: plan.arm,
          depth: plan.depth,
          hunkId,
          answer: value,
        });
        log(
          `${key} ${hunkId} ${plan.arm}${plan.depth === "deep" ? " deep" : ""}: ${status} ${value.regions.length} regions${value.neighbors.length > 0 ? `, ${value.neighbors.length} neighbors` : ""} in ${(value.totalMillis / 1000).toFixed(1)} s${value.error === null ? "" : ` error ${value.error}`}${value.normalizations.length === 0 ? "" : ` (graph-client normalized ${value.normalizations.length} end lines past EOF)`}`,
        );
      }
    }
    return { answers, preparation, failures };
  });

/** Answers one plan again without the store (determinism check). */
export const freshAnswer = (plan: Plan) => inspect(plan.input);
const usable = (answer: GraphAnswer) => answer.error === null;
/** Version 1 and 2 answers carry `recovered` when the benchmark parsed a receipt. */
const legacyUsable = (answer: GraphAnswer & { readonly recovered?: unknown }) =>
  answer.error === null && answer.recovered == null;

export const storedAnswer = (plan: Plan) =>
  Effect.gen(function* () {
    const current = yield* readStoredJson<GraphAnswer>(
      graphSpec(plan.engine, plan.input, 4),
    );
    if (Option.isSome(current) || plan.depth === "deep") return current;
    const third = yield* readStoredJson<GraphAnswer>(
      graphSpec(plan.engine, plan.input, 3),
    );
    if (Option.isSome(third)) return third;
    for (const version of [2, 1] as const) {
      const legacy = yield* readStoredJson<GraphAnswer>(
        graphSpec(plan.engine, plan.input, version),
      );
      if (Option.isSome(legacy) && legacyUsable(legacy.value))
        return Option.some({ ...legacy.value, normalizations: [] });
    }
    return Option.none<GraphAnswer>();
  });

/** Answers a plan unless a usable answer is stored; stores only usable answers. */
const answerPlan = (plan: Plan) =>
  Effect.gen(function* () {
    const stored = yield* storedAnswer(plan);
    if (Option.isSome(stored))
      return { value: stored.value, status: "reused" as const };
    const fresh = yield* inspect(plan.input);
    if (!usable(fresh))
      return { value: fresh, status: "failed (not stored)" as const };
    const { value } = yield* storedJson(
      graphSpec(plan.engine, plan.input),
      Effect.succeed(fresh),
    );
    return { value, status: "computed" as const };
  });
