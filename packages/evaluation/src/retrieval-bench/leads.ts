import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { loadBases, type BaseCorpus, type Case, type Hunk } from "./corpus.ts";
import { importQueryVector, queryVectorStored } from "./dense.ts";
import {
  EncoderProcess,
  fetchCounter,
  modalEncode,
  modalRerank,
} from "./encoder.ts";
import { gitText } from "./git.ts";
import {
  INSPECT_TIMEOUT_MS,
  POLITE,
  changedSymbols,
  engineIdentity,
  type GraphAnswer,
} from "./graph.ts";
import {
  computedShare,
  describeHunk,
  parseHunks,
  realShare,
  type DiffHunk,
} from "./hunks.ts";
import type { Manifest } from "./manifest.ts";
import { encodePendingChunks } from "./modal-chunks.ts";
import { HARDWARE, MODELS, modelIdentity } from "./models.ts";
import { REAL_SHARE, byCodepoint, type CorpusKey } from "./policy.ts";
import { QUERY_RECIPE, buildQuery, type HunkQuery } from "./queries.ts";
import {
  poolDocuments,
  rerankRow,
  storedPairScore,
  storePairScores,
} from "./rerank.ts";
import {
  POOL_DEPTH,
  decodePool,
  encodePool,
  poolFile,
  poolRow,
  type PoolRow,
} from "./retriever.ts";
import {
  failureKey,
  graphPlans,
  storedAnswer,
  type GraphFailures,
  type GraphSetup,
} from "./run-graph.ts";
import { buildPools } from "./run-pools.ts";
import { benchStoreLayer } from "./views.ts";

/**
 * What the leads mode takes from the benchmark CLI (arms.ts): its options, paths and log, the
 * manifest's dev cases, base loading, the Graph setup and recorded Graph run, and the pinned fork.
 */
export interface LeadsContext {
  readonly signal?: AbortSignal;
  readonly flag: (name: string) => string | undefined;
  readonly flags: (name: string) => ReadonlyArray<string>;
  readonly has: (name: string) => boolean;
  /** Benchmark output directory; captured runs are kept in the private archive. */
  readonly output: string;
  readonly work: string;
  readonly storeDir: string;
  readonly logDir: string;
  readonly repositories: Record<CorpusKey, string>;
  readonly devCases: (manifest: Manifest) => ReadonlyArray<Case>;
  readonly readManifest: () => Promise<Manifest>;
  readonly log: (line: string) => void;
  readonly record: (name: string, value: unknown) => Promise<unknown>;
  readonly graphSetup: () => GraphSetup;
  readonly recordedGraphRun: (
    cases: ReadonlyArray<Case>,
    queries: ReadonlyMap<string, HunkQuery>,
    include: (plan: { arm: string; depth: string }) => boolean,
    writeAnswers: boolean,
  ) => Promise<void>;
  readonly graphFailuresPath: () => string;
  /** The benchmark's pinned Graph fork revision (arms.ts ENGINES.fork). */
  readonly pinnedFork: string;
  /** Modal cost per reranker pair, to estimate a job before it runs. */
  readonly rerankPairUsd: number;
}

const readJson = async <T>(path: string): Promise<T | undefined> =>
  (await Bun.file(path).exists())
    ? (JSON.parse(await Bun.file(path).text()) as T)
    : undefined;

/**
 * 10.89: the full test's leads. Every text hunk of the 22 dev ranges (all dev cases but the
 * largest, run apart as a scale probe) is ranked by R(H3-E0) and R(H1-E0) with the committed
 * arms' frozen settings, and written as unlabelled leads to results/full-test/leads/, never to the
 * pools, queries or arms files. Hunks are the range's `git diff -U3 -M --ignore-submodules=all`,
 * the diff M4's picked hunks come from and the harness counts; each row carries the hunk's exact
 * diff text so the harness can match its own hunks. The M4-picked hunks are ranked the same way and
 * must equal their committed dev pool rows (the consistency check in leads.json).
 *   leads --stage plan     enumerate hunks and queries; leads-plan.json (ids per base, skips)
 *   leads --stage encode   E0 query encodings on Modal for unstored queries
 *   leads --stage graph [--only h-…] [--timeout-minutes 30]
 *                          G-fork's pool answer per hunk (H3's Graph input), failures recorded
 *                          in the log directory's graph-failures.json
 *   leads --stage rank [--failures f.json]… [--stored-only] [--fresh] [--max-usd 4]
 *                          fuse, rerank on Modal (pairs not yet stored), write the leads files
 *                          and leads.json; --fresh rescores every pair and compares, writing
 *                          nothing else
 * If Graph has no answer for a hunk, H3 fuses keyword search and E0 without it and the row says
 * graph failed or timed out; nothing falls back to anything else and no hunk is dropped.
 */
export const LEADS_EXCLUDED: Record<string, string> = {
  "neuve:27ffd6bc..8b430f65":
    "10.89: the largest dev range (neuve/stress, 96,031 review lines), run once apart as a scale probe",
};
export const LEADS_ARMS = [
  { arm: "R(H3-E0)", candidates: "H3-E0", graph: true },
  { arm: "R(H1-E0)", candidates: "H1-E0", graph: false },
] as const;
/**
 * `--ranges f.json` ranks other ranges than the 22, `[{repository, base, head, note}]` with full
 * commit ids (the full test's extra ranges); a range that is a manifest case keeps its id and its
 * picked hunks. `--out` names the leads folder, which may never be the benchmark's pools.
 */
export interface LeadRange {
  readonly repository: CorpusKey;
  readonly base: string;
  readonly head: string;
  readonly note?: string;
}
const LEADS_DIFF = [
  "diff",
  "--no-color",
  "--no-ext-diff",
  "-U3",
  "--ignore-submodules=all",
  "-M",
] as const;

export interface LeadHunk {
  readonly entry: Case;
  readonly hunk: Hunk;
  /** The hunk's exact diff text: its `@@` header and body lines. */
  readonly diff: string;
  readonly picked: boolean;
}
export interface LeadSkip {
  readonly path: string;
  readonly oldPath: string;
  readonly reason: string;
}

/** Each `@@` hunk's exact text, in diff order, with the parsed hunk it belongs to. */
export const hunkTexts = (diff: string) => {
  const texts: Array<string> = [];
  let current: Array<string> | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (current !== undefined) texts.push(current.join("\n"));
      current = undefined;
    } else if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) {
      if (current !== undefined) texts.push(current.join("\n"));
      current = [line];
    } else if (current !== undefined && /^[ +\-\\]/.test(line))
      current.push(line);
    else if (current !== undefined && line !== "") {
      texts.push(current.join("\n"));
      current = undefined;
    }
  }
  if (current !== undefined) texts.push(current.join("\n"));
  return texts;
};

/** Changed entries that have no text hunk, each with why (`git diff --raw -z`). */
export const skippedEntries = (
  raw: string,
  diff: string,
  hunks: ReadonlyArray<DiffHunk>,
) => {
  const fields = raw.split("\0");
  const withHunks = new Set(hunks.flatMap((hunk) => [hunk.path, hunk.oldPath]));
  const skipped: Array<LeadSkip> = [];
  for (let index = 0; index < fields.length;) {
    const meta = fields[index++] ?? "";
    if (!meta.startsWith(":")) continue;
    const [oldMode = "", newMode = "", oldSha = "", newSha = "", status = ""] =
      meta.slice(1).split(" ");
    const two = status.startsWith("R") || status.startsWith("C");
    const oldPath = fields[index++] ?? "";
    const path = two ? (fields[index++] ?? "") : oldPath;
    if (withHunks.has(path) || withHunks.has(oldPath)) continue;
    const reason =
      oldMode === "160000" || newMode === "160000"
        ? "submodule"
        : status === "R100"
          ? "pure rename"
          : oldSha === newSha
            ? "mode change only"
            : diff.includes(`\nBinary files `) &&
                (diff.includes(` b/${path} differ`) ||
                  diff.includes(` a/${oldPath} and`))
              ? "binary"
              : `no text hunk (status ${status})`;
    skipped.push({ path, oldPath, reason });
  }
  return skipped.sort(
    (a, b) => byCodepoint(a.path, b.path) || byCodepoint(a.oldPath, b.oldPath),
  );
};

const leadsCases = (
  manifest: Manifest,
  ranges: ReadonlyArray<LeadRange> | undefined,
  devCases: (manifest: Manifest) => ReadonlyArray<Case>,
): Array<Case> => {
  if (ranges === undefined)
    return devCases(manifest).filter(
      (entry) => !Object.hasOwn(LEADS_EXCLUDED, entry.id),
    );
  const template = devCases(manifest)[0] as Case;
  return ranges.map((range) => {
    if (
      !/^[0-9a-f]{40}$/.test(range.base) ||
      !/^[0-9a-f]{40}$/.test(range.head)
    )
      throw new Error(
        `--ranges needs full commit ids: ${JSON.stringify(range)}`,
      );
    const id = `${range.repository}:${range.base.slice(0, 8)}..${range.head.slice(0, 8)}`;
    // Not a manifest case: the case fields the leads never read are the template's, emptied
    // where they could mislead (no picked hunks, no commits, no leakage data).
    return (
      manifest.cases.find((entry) => entry.id === id) ??
      ({
        ...template,
        id,
        repository: range.repository,
        base: range.base,
        head: range.head,
        commits: [],
        subjects: [],
        family: "full-test extra range",
        reviewLines: 0,
        tunedFiles: [],
        phase2Files: [],
        leakageTags: [],
        graphTuningRange: false,
        hunks: [],
      } as Case)
    );
  });
};

/** Every lead hunk of the 22 ranges with its query, and the skipped entries per range. */
const leadsPlan = (
  manifest: Manifest,
  ranges: ReadonlyArray<LeadRange> | undefined,
  context: LeadsContext,
) =>
  Effect.gen(function* () {
    const hunks: Array<LeadHunk> = [];
    const skipped: Record<string, ReadonlyArray<LeadSkip>> = {};
    const queries = new Map<string, HunkQuery>();
    for (const entry of leadsCases(manifest, ranges, context.devCases)) {
      const repository = context.repositories[entry.repository];
      const diff = yield* gitText(repository, [
        ...LEADS_DIFF,
        entry.base,
        entry.head,
      ]);
      const parsed = parseHunks(diff);
      const texts = hunkTexts(diff);
      // The harness matches its hunks by this text: each text must be its own hunk's header and
      // exactly its added and deleted lines.
      const mismatch = parsed.findIndex((hunk, index) => {
        const lines = (texts[index] ?? "").split("\n");
        const header = `@@ -${hunk.oldStart}${hunk.oldLines === 1 ? "" : `,${hunk.oldLines}`} +${hunk.newStart}${hunk.newLines === 1 ? "" : `,${hunk.newLines}`} @@`;
        return (
          !(lines[0] ?? "").startsWith(header) ||
          lines.filter((line) => line.startsWith("+")).length !== hunk.added ||
          lines.filter((line) => line.startsWith("-")).length !== hunk.deleted
        );
      });
      if (texts.length !== parsed.length || mismatch !== -1)
        return yield* Effect.die(
          new Error(
            `${entry.id}: hunk texts do not match the parsed hunks (${texts.length} texts, ${parsed.length} hunks, first mismatch ${mismatch})`,
          ),
        );
      const raw = yield* gitText(repository, [
        "diff",
        "--raw",
        "-z",
        "-M",
        "--no-abbrev",
        entry.base,
        entry.head,
      ]);
      skipped[entry.id] = skippedEntries(raw, diff, parsed);
      const picked = new Set(entry.hunks.map((hunk) => hunk.id));
      const seen = new Set<string>();
      // Shares are not part of a lead; a range outside the manifest uses its own changed lines.
      const reviewLines =
        entry.reviewLines > 0
          ? entry.reviewLines
          : Math.max(
              1,
              parsed.reduce((sum, hunk) => sum + hunk.added + hunk.deleted, 0),
            );
      for (const [index, diffHunk] of parsed.entries()) {
        const described = describeHunk(entry.id, diffHunk);
        const computed = computedShare(described.changedLines, reviewLines);
        const hunk: Hunk = {
          ...described,
          computedShare: computed,
          realShare: realShare(described.changedLines, reviewLines),
          raisedToMinimum: {
            opus: computed.opus < REAL_SHARE.minimum,
            sol: computed.sol < REAL_SHARE.minimum,
          },
        };
        if (seen.has(hunk.id))
          return yield* Effect.die(
            new Error(`${entry.id}: two hunks share id ${hunk.id}`),
          );
        seen.add(hunk.id);
        hunks.push({
          entry,
          hunk,
          diff: texts[index] ?? "",
          picked: picked.has(hunk.id),
        });
        queries.set(hunk.id, yield* buildQuery(repository, entry, hunk));
      }
      const missing = entry.hunks.filter((hunk) => !seen.has(hunk.id));
      if (missing.length > 0)
        return yield* Effect.die(
          new Error(
            `${entry.id}: picked hunks ${missing.map((hunk) => hunk.id).join(", ")} are not hunks of the range diff`,
          ),
        );
    }
    return { hunks, skipped, queries };
  });

/** The lead hunks grouped back into their cases, for the Graph runner and buildPools. */
export const leadCases = (hunks: ReadonlyArray<LeadHunk>) => {
  const byCase = new Map<string, Case>();
  for (const { entry, hunk } of hunks) {
    const current = byCase.get(entry.id) ?? { ...entry, hunks: [] };
    byCase.set(entry.id, { ...current, hunks: [...current.hunks, hunk] });
  }
  return [...byCase.values()];
};

const leadsFailures = async (paths: ReadonlyArray<string>) => {
  const merged: GraphFailures = {};
  for (const path of paths)
    for (const [key, attempts] of Object.entries(
      (await readJson<GraphFailures>(resolve(path))) ?? {},
    ))
      (merged[key] ??= []).push(...attempts);
  for (const attempts of Object.values(merged))
    attempts.sort((a, b) => byCodepoint(a.at, b.at));
  return merged;
};

/**
 * The hunks the graph stage may ask: never a picked hunk, whose Graph state is the benchmark's own
 * (its stored answer or recorded failure is frozen in pools/dev), even when `--only` names it.
 */
export const graphHunks = (
  hunks: ReadonlyArray<LeadHunk>,
  only: ReadonlyArray<string>,
) =>
  hunks.filter(
    (lead) =>
      !lead.picked && (only.length === 0 || only.includes(lead.hunk.id)),
  );

export const leadsCommand = async (context: LeadsContext) => {
  const {
    signal,
    flag,
    flags,
    has,
    output,
    work,
    storeDir,
    logDir,
    repositories,
    readManifest,
    log,
    record,
    graphSetup,
    recordedGraphRun,
    graphFailuresPath,
    pinnedFork,
    rerankPairUsd,
  } = context;
  const leadsDir = resolve(
    flag("--out") ?? resolve(output, "results/full-test/leads"),
  );
  if (leadsDir.startsWith(resolve(output, "pools")))
    throw new Error("leads are never written into the benchmark's pools");
  const stage = flag("--stage") ?? "";
  const manifest = await readManifest();
  const rangesFile = flag("--ranges");
  const ranges =
    rangesFile === undefined
      ? undefined
      : (JSON.parse(
          await Bun.file(resolve(rangesFile)).text(),
        ) as Array<LeadRange>);
  const plan = await Effect.runPromise(leadsPlan(manifest, ranges, context), {
    signal,
  });
  const cases = leadCases(plan.hunks);
  if (stage === "plan") {
    await record("leads-plan.json", {
      ranges: cases.map((entry) => ({
        caseId: entry.id,
        base: `${entry.repository}:${entry.base}`,
        hunks: entry.hunks.map((hunk) => hunk.id),
        skipped: plan.skipped[entry.id],
      })),
      ...(ranges === undefined
        ? { excluded: LEADS_EXCLUDED }
        : { inputRanges: ranges }),
    });
    log(
      `leads plan: ${cases.length} ranges, ${plan.hunks.length} hunks (${plan.hunks.filter((lead) => lead.picked).length} picked), ${Object.values(plan.skipped).flat().length} skipped entries`,
    );
    return;
  }
  if (stage === "encode") {
    const model = MODELS.E0;
    const options = {
      gpu: flag("--gpu") ?? HARDWARE.gpu,
      containers: Math.min(10, Number(flag("--containers") ?? "4")),
      scratch: join(work, "scratch"),
      batchTokens: Number(flag("--batch-tokens") ?? "65536"),
    };
    mkdirSync(options.scratch, { recursive: true });
    const python = resolve(flag("--python") ?? join(work, "venv/bin/python"));
    const report = await Effect.runPromise(
      Effect.gen(function* () {
        // Bases without E0 chunk vectors (ranges outside the benchmark) are encoded first, as
        // modal-encode does.
        const chunks = yield* encodePendingChunks({
          model,
          bases: yield* loadBases(cases, repositories),
          python,
          work,
          options,
          shard: Number(flag("--shard") ?? "8000"),
          label: "leads encode E0",
          log,
        });
        const chunkUnits = chunks.encoded;
        const chunkReceipts = chunks.shards;
        const missing: Array<HunkQuery> = [];
        for (const query of plan.queries.values())
          if (!(yield* queryVectorStored(model, query))) missing.push(query);
        if (missing.length === 0)
          return {
            chunkUnits,
            chunkReceipts,
            encoded: 0,
            receipt: null,
          };
        const { vectors, receipt } = yield* modalEncode(
          model,
          missing.map((query) => ({
            id: query.hunkId,
            text: model.format.query(query.text),
          })),
          options,
        );
        for (const query of missing)
          yield* importQueryVector(
            model,
            query,
            vectors.get(query.hunkId) as Float32Array,
          );
        return {
          chunkUnits,
          chunkReceipts,
          encoded: missing.length,
          receipt,
        };
      }).pipe(Effect.provide(benchStoreLayer(storeDir))),
      { signal },
    );
    await record("leads-encode-E0.json", {
      identity: modelIdentity(model),
      hardware: HARDWARE,
      queries: plan.queries.size,
      ...report,
    });
    log(
      `leads encode: ${report.chunkUnits} chunk units and ${report.encoded} E0 queries encoded on Modal`,
    );
    return;
  }
  if (stage === "graph") {
    const only = (flag("--only") ?? "").split(",").filter(Boolean);
    const asked = graphHunks(plan.hunks, only);
    log(
      `leads graph: ${asked.length} hunks to ask; ${plan.hunks.filter((lead) => lead.picked).length} picked hunks keep the benchmark's own Graph state and are never asked`,
    );
    await recordedGraphRun(
      leadCases(asked),
      plan.queries,
      (graphPlan) => graphPlan.arm === "G-fork" && graphPlan.depth === "pool",
      false,
    );
    return;
  }
  if (stage !== "rank")
    throw new Error("leads needs --stage plan|encode|graph|rank");
  const fresh = has("--fresh");
  const storedOnly = has("--stored-only");
  const maxUsd = Number(flag("--max-usd") ?? "4");
  const fixedEngine =
    flag("--fixed-fork-engine") === undefined
      ? undefined
      : resolve(flag("--fixed-fork-engine") as string);
  const fixedRevision = flag("--fixed-fork-revision") ?? "unknown";
  if (fixedEngine !== undefined && fixedRevision === "unknown")
    throw new Error("--fixed-fork-engine needs --fixed-fork-revision");
  const fixedFailures = await leadsFailures(flags("--fixed-failures"));
  const allowedWarnings = (flag("--allowed-warnings") ?? "")
    .split(",")
    .filter(Boolean);
  // --graph-notes f.json: how the Graph run went (retries, timeout evidence, orphans), kept in the receipt.
  const graphNotesFile = flag("--graph-notes");
  const graphNotes =
    graphNotesFile === undefined
      ? null
      : (JSON.parse(await Bun.file(resolve(graphNotesFile)).text()) as unknown);
  const failures = await leadsFailures([
    graphFailuresPath(),
    ...flags("--failures"),
  ]);
  const model = MODELS.R;
  const python = resolve(flag("--python") ?? join(work, "venv/bin/python"));
  const options = {
    gpu: flag("--gpu") ?? HARDWARE.gpu,
    containers: Math.min(10, Number(flag("--containers") ?? "4")),
    scratch: join(work, "scratch"),
  };
  mkdirSync(options.scratch, { recursive: true });
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const setup = graphSetup();
      const engines = {
        fork: yield* engineIdentity(setup.forkEngine),
        base: yield* engineIdentity(setup.baseEngine),
      };
      // --fixed-fork-engine: a leads-only engine (10.89, Graph 65f609a) for hunks the pinned fork
      // could not answer; its answers and failures are its own (--fixed-failures).
      const fixedSetup =
        fixedEngine === undefined
          ? undefined
          : { ...setup, forkEngine: fixedEngine };
      const fixedSha =
        fixedSetup === undefined
          ? undefined
          : yield* engineIdentity(fixedSetup.forkEngine);
      const warningCounts: Record<string, number> = {};
      const pickedIds = new Set(
        plan.hunks.filter((lead) => lead.picked).map((lead) => lead.hunk.id),
      );
      // H3's Graph input: G-fork's stored pool answer (the pinned fork's, else the fixed engine's),
      // or an empty answer with its recorded cause. The other Graph arms are not inputs to either
      // lead arm and get the same empty stand-in.
      const graph = new Map<string, GraphAnswer>();
      const status = new Map<
        string,
        {
          status: "answered" | "failed" | "timeout";
          /** The Graph engine that answered or failed: its revision and SHA-256. */
          revision: string;
          engine: string;
          millis: number | null;
          cause: string | null;
        }
      >();
      const empty = (error: string): GraphAnswer => ({
        regions: [],
        queryMillis: 0,
        totalMillis: 0,
        cache: null,
        indexedFileCount: null,
        coverage: null,
        budget: null,
        error,
        neighbors: [],
        relationships: [],
        normalizations: [],
      });
      for (const entry of cases)
        for (const hunk of entry.hunks) {
          const query = plan.queries.get(hunk.id) as HunkQuery;
          const symbols = yield* changedSymbols(
            repositories[entry.repository],
            entry,
            hunk,
          );
          const plans = yield* graphPlans(
            setup,
            entry,
            query,
            symbols,
            hunk.oldPath,
          );
          const pool = plans.find(
            (item) => item.arm === "G-fork" && item.depth === "pool",
          );
          const stored =
            pool === undefined ? undefined : yield* storedAnswer(pool);
          const fixedPool =
            fixedSetup === undefined
              ? undefined
              : (yield* graphPlans(
                  fixedSetup,
                  entry,
                  query,
                  symbols,
                  hunk.oldPath,
                )).find(
                  (item) => item.arm === "G-fork" && item.depth === "pool",
                );
          // A picked hunk keeps the pinned fork's answer or failure, so its row stays its pool row.
          const picked = pickedIds.has(hunk.id);
          const fixedStored =
            fixedPool === undefined ||
            picked ||
            (stored?._tag ?? "None") === "Some"
              ? undefined
              : yield* storedAnswer(fixedPool);
          const fixedFailure = picked
            ? undefined
            : fixedFailures[failureKey("G-fork", "pool", hunk.id)]?.at(-1);
          if (stored !== undefined && stored._tag === "Some") {
            graph.set(`G-fork:${hunk.id}`, stored.value);
            status.set(hunk.id, {
              status: "answered",
              revision: pinnedFork.slice(0, 8),
              engine: engines.fork,
              millis: Math.round(stored.value.queryMillis),
              cause: null,
            });
          } else if (fixedStored !== undefined && fixedStored._tag === "Some") {
            for (const code of fixedStored.value.warningCodes ?? []) {
              warningCounts[code] = (warningCounts[code] ?? 0) + 1;
              if (!allowedWarnings.includes(code))
                return yield* Effect.die(
                  new Error(
                    `${hunk.id}: the fixed engine reported warning ${code}, not in --allowed-warnings; stop and report`,
                  ),
                );
            }
            graph.set(`G-fork:${hunk.id}`, fixedStored.value);
            status.set(hunk.id, {
              status: "answered",
              revision: fixedRevision,
              engine: fixedSha as string,
              millis: Math.round(fixedStored.value.queryMillis),
              cause: null,
            });
          } else if (fixedFailure !== undefined) {
            // The fixed engine's last attempt: a timeout or a second grep deadline counts as timed out.
            const timeout = /Timed out after|W_GIT_GREP_DEADLINE/.test(
              fixedFailure.cause,
            );
            graph.set(`G-fork:${hunk.id}`, empty(fixedFailure.cause));
            status.set(hunk.id, {
              status: timeout ? "timeout" : "failed",
              revision: fixedRevision,
              engine: fixedSha as string,
              millis: null,
              cause: fixedFailure.cause,
            });
          } else {
            const last =
              failures[failureKey("G-fork", "pool", hunk.id)]?.at(-1);
            if (last === undefined)
              return yield* Effect.die(
                new Error(
                  `${hunk.id}: Graph has neither an answer nor a recorded failure; run --stage graph`,
                ),
              );
            const timeout = /Timed out after/.test(last.cause);
            graph.set(`G-fork:${hunk.id}`, empty(last.cause));
            status.set(hunk.id, {
              status: timeout ? "timeout" : "failed",
              revision: pinnedFork.slice(0, 8),
              engine: engines.fork,
              millis: null,
              cause: last.cause,
            });
          }
          for (const key of [
            "G-fork-syntax",
            "G-base",
            "deep:G-fork",
            "deep:G-fork-syntax",
            "deep:G-base",
          ])
            graph.set(`${key}:${hunk.id}`, empty("not a lead input"));
        }
      const bases = yield* loadBases(cases, repositories);
      const counter = yield* EncoderProcess.start(python);
      yield* counter.counter(yield* fetchCounter(work));
      const built = yield* buildPools(
        {
          bases,
          cases,
          queries: plan.queries,
          graph,
          repositories,
          dense: ["E0"],
          queryMillis: new Map(),
          graphEngines: engines,
        },
        counter,
        log,
      );
      yield* counter.close();
      const baseOf = new Map(
        cases.map((entry) => [
          entry.id,
          bases.find(
            (base) =>
              base.repository === entry.repository &&
              base.commit === entry.base,
          ) as BaseCorpus,
        ]),
      );
      const rows = new Map<string, Map<string, PoolRow>>();
      for (const { candidates } of LEADS_ARMS)
        rows.set(
          candidates,
          new Map(
            (built.answers.get(candidates) ?? []).map((answer) => [
              answer.hunkId,
              poolRow(answer),
            ]),
          ),
        );
      // One Modal request per hunk over the documents of both arms' top 50 (pairs are keyed by
      // query and document, so a document in both pools is scored once).
      const pending: Array<{
        id: string;
        query: string;
        documents: Array<string>;
        hunk: HunkQuery;
      }> = [];
      let pairs = 0;
      for (const { hunk } of plan.hunks) {
        const query = plan.queries.get(hunk.id) as HunkQuery;
        const documents = new Set<string>();
        const missing = new Set<string>();
        for (const { candidates } of LEADS_ARMS) {
          const row = rows.get(candidates)?.get(hunk.id) as PoolRow;
          const scored = yield* poolDocuments(
            model,
            row,
            query,
            baseOf.get(row.caseId) as BaseCorpus,
          );
          scored.documents.forEach((document, index) => {
            documents.add(document);
            if (fresh || scored.missing.includes(index)) missing.add(document);
          });
        }
        pairs += documents.size;
        if (missing.size > 0)
          pending.push({
            id: hunk.id,
            query: model.format.query(query.text),
            documents: [...missing],
            hunk: query,
          });
      }
      const newPairs = pending.reduce(
        (sum, item) => sum + item.documents.length,
        0,
      );
      let receipt: unknown = null;
      let maxDifference = 0;
      const truncated: Record<string, number> = {};
      if (newPairs > 0) {
        if (storedOnly)
          return yield* Effect.die(
            new Error(
              `--stored-only: ${newPairs} reranker pairs are not stored; not calling Modal`,
            ),
          );
        const estimate = newPairs * rerankPairUsd;
        log(
          `leads: ${pending.length} hunks with ${newPairs} pairs to score on Modal (estimate ${estimate.toFixed(3)} USD)`,
        );
        if (estimate > maxUsd)
          return yield* Effect.die(
            new Error(
              `leads: estimate ${estimate.toFixed(2)} USD exceeds --max-usd ${maxUsd}; not calling Modal`,
            ),
          );
        const scored = yield* modalRerank(
          model,
          pending.map(({ id, query, documents }) => ({ id, query, documents })),
          options,
        );
        receipt = scored.receipt;
        for (const item of pending) {
          const result = scored.scores.get(item.id);
          if (
            result === undefined ||
            result.scores.length !== item.documents.length
          )
            return yield* Effect.die(new Error(`no scores for ${item.id}`));
          const count = result.truncated.filter(Boolean).length;
          if (count > 0) truncated[item.id] = count;
          if (fresh)
            for (const [index, document] of item.documents.entries()) {
              const stored = yield* storedPairScore(model, item.hunk, document);
              maxDifference = Math.max(
                maxDifference,
                stored._tag === "Some"
                  ? Math.abs(
                      stored.value - (result.scores[index] ?? Number.NaN),
                    )
                  : Number.POSITIVE_INFINITY,
              );
            }
          else
            yield* storePairScores(
              model,
              item.hunk,
              item.documents,
              result.scores,
            );
        }
      }
      if (fresh)
        return {
          fresh: true as const,
          pairs,
          newPairs,
          maxDifference,
          truncated,
          receipt,
        };
      const out = new Map<string, Array<unknown>>();
      const consistency: Record<
        string,
        { picked: number; equal: number; differing: Array<string> }
      > = {};
      for (const { arm, candidates, graph: usesGraph } of LEADS_ARMS) {
        const committed = new Map(
          decodePool(
            new Uint8Array(
              yield* Effect.promise(() =>
                Bun.file(
                  poolFile(resolve(output, "pools/dev"), arm),
                ).arrayBuffer(),
              ),
            ),
          ).map((row) => [row.hunkId, row]),
        );
        const check = { picked: 0, equal: 0, differing: [] as Array<string> };
        const list: Array<unknown> = [];
        for (const lead of plan.hunks) {
          const query = plan.queries.get(lead.hunk.id) as HunkQuery;
          const row = rows.get(candidates)?.get(lead.hunk.id) as PoolRow;
          const reranked = poolRow(
            yield* rerankRow(
              model,
              arm,
              row,
              query,
              baseOf.get(row.caseId) as BaseCorpus,
              undefined,
            ),
          );
          if (lead.picked) {
            check.picked++;
            const frozen = committed.get(lead.hunk.id);
            if (
              frozen !== undefined &&
              JSON.stringify(frozen.regions) ===
                JSON.stringify(reranked.regions)
            )
              check.equal++;
            else check.differing.push(lead.hunk.id);
          }
          const graphStatus = status.get(lead.hunk.id);
          list.push({
            caseId: lead.entry.id,
            hunkId: lead.hunk.id,
            picked: lead.picked,
            path: lead.hunk.path,
            oldPath: lead.hunk.oldPath,
            old: lead.hunk.old,
            new: lead.hunk.new,
            added: lead.hunk.added,
            deleted: lead.hunk.deleted,
            diff: lead.diff,
            query: {
              text: query.text,
              sha256: query.sha256,
              side: query.side,
              startLine: query.startLine,
              endLine: query.endLine,
            },
            sources: {
              graph: usesGraph ? graphStatus : { status: "not-used" },
              keyword: { status: "answered" },
              embedding: { status: "answered" },
            },
            regions: reranked.regions,
          });
        }
        consistency[arm] = check;
        out.set(arm, list);
      }
      return {
        fresh: false as const,
        out,
        consistency,
        status,
        pairs,
        newPairs,
        truncated,
        receipt,
        engines,
        fixedSha,
        warningCounts,
      };
    }).pipe(Effect.provide(benchStoreLayer(storeDir))),
    { signal },
  );
  if (result.fresh) {
    await record("leads-rerank-fresh.json", {
      pairs: result.pairs,
      rescored: result.newPairs,
      maxScoreDifference: result.maxDifference,
      truncated: result.truncated,
    });
    log(
      `leads fresh rescore: ${result.newPairs} pairs, max absolute score difference ${result.maxDifference}`,
    );
    return;
  }
  if (result.receipt !== null)
    await record("leads-rerank.json", {
      identity: modelIdentity(model),
      hardware: HARDWARE,
      pairs: result.newPairs,
      truncated: result.truncated,
    });
  mkdirSync(leadsDir, { recursive: true });
  const files: Record<string, string> = {};
  for (const [arm, list] of result.out) {
    const bytes = encodePool(list);
    await Bun.write(join(leadsDir, `${arm}.jsonl.gz`), bytes);
    files[`${arm}.jsonl.gz`] = createHash("sha256").update(bytes).digest("hex");
  }
  const truncation =
    (await readJson<{ truncated: Record<string, number> }>(
      join(logDir, "leads-rerank-fresh.json"),
    )) ?? null;
  const perRange = Object.fromEntries(
    cases.map((entry) => {
      const statuses = entry.hunks.map(
        (hunk) => result.status.get(hunk.id)?.status,
      );
      return [
        entry.id,
        {
          family: entry.family,
          ranked: entry.hunks.length,
          picked: entry.hunks.filter((hunk) =>
            plan.hunks.some((lead) => lead.hunk.id === hunk.id && lead.picked),
          ).length,
          skipped: plan.skipped[entry.id],
          graph: {
            answered: statuses.filter((value) => value === "answered").length,
            failed: statuses.filter((value) => value === "failed").length,
            timeout: statuses.filter((value) => value === "timeout").length,
            answeredBy: Object.fromEntries(
              [
                ...new Set(
                  entry.hunks.flatMap((hunk) => {
                    const item = result.status.get(hunk.id);
                    return item?.status === "answered" ? [item.revision] : [];
                  }),
                ),
              ]
                .sort(byCodepoint)
                .map((revision) => [
                  revision,
                  entry.hunks.filter((hunk) => {
                    const item = result.status.get(hunk.id);
                    return (
                      item?.status === "answered" && item.revision === revision
                    );
                  }).length,
                ]),
            ),
          },
        },
      ];
    }),
  );
  await Bun.write(
    join(leadsDir, "leads.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        decision: "10.89",
        note:
          ranges === undefined
            ? "Unlabelled leads for the full test, not benchmark pools: every text hunk of the 22 dev ranges, ranked by each arm with the committed arms' frozen settings. Nothing here enters pools/, queries.*.json or arms.*.json."
            : "Unlabelled leads for the full test's extra ranges, not benchmark pools: every text hunk of each range below, ranked by each arm with the committed arms' frozen settings, computed in a separate store. Nothing here enters the benchmark's store, pools/, queries.*.json or arms.*.json.",
        split: "dev",
        ...(ranges === undefined
          ? { excluded: LEADS_EXCLUDED }
          : { inputRanges: ranges }),
        diff: `git ${LEADS_DIFF.join(" ")} <base> <head>: the diff M4's picked hunks come from (path-limited there), at default context as the harness counts hunks; binary files, submodules and pure renames have no text hunk and are listed per range under skipped`,
        rowFormat: {
          caseId: "the range",
          hunkId:
            "describeHunk's id (equal to the manifest's for picked hunks)",
          picked: "an M4-picked hunk",
          "path, oldPath, old, new, added, deleted":
            "the hunk (spans are {start, lines})",
          diff: "the hunk's exact diff text: its @@ header and body lines",
          query:
            "the Q1 query (queries.ts), the same builder as queries.*.json",
          sources:
            "graph: answered | failed | timeout (with millis or cause; not-used for R(H1-E0)); keyword and embedding answered",
          regions:
            "the reranked top 50 in the pools' region format [path, startLine, endLine, chunkId, kind, tokens, score]",
        },
        arms: Object.fromEntries(
          LEADS_ARMS.map(({ arm, candidates }) => [
            arm,
            {
              candidates,
              label: `Qwen3-Reranker-0.6B over the top ${POOL_DEPTH} of ${candidates}`,
            },
          ]),
        ),
        settings: {
          poolDepth: POOL_DEPTH,
          queryRecipe: QUERY_RECIPE,
          embedding: modelIdentity(MODELS.E0),
          reranker: modelIdentity(model),
          hardware: HARDWARE,
          graph: {
            engine: "fork",
            sha256: result.engines.fork,
            engines: {
              [pinnedFork.slice(0, 8)]: {
                revision: pinnedFork,
                sha256: result.engines.fork,
                role: "the benchmark's pinned fork; every hunk was asked with it first",
              },
              ...(result.fixedSha === undefined
                ? {}
                : {
                    [fixedRevision]: {
                      sha256: result.fixedSha,
                      role: "leads only: answers the hunks the pinned fork left without an answer (never a picked hunk)",
                      warningCodes: result.warningCounts,
                    },
                  }),
            },
            plan: "G-fork, prepared full profile, pool depth (H3's Graph input)",
            polite: POLITE,
            firstTimeoutMinutes: INSPECT_TIMEOUT_MS / 60_000,
            onFailure:
              "H3 fuses keyword search and E0 without Graph; the row records graph failed or timeout",
            runRecord:
              "what this run's Graph stage did (retries, re-runs, deadlines) is graphRun, the run's own notes",
          },
        },
        hunks: plan.hunks.length,
        pickedHunks: plan.hunks.filter((lead) => lead.picked).length,
        ranges: perRange,
        graphRun: graphNotes,
        consistency: result.consistency,
        rerank: {
          distinctPairs: result.pairs,
          truncatedPairsPerHunk: truncation?.truncated ?? null,
        },
        files,
      },
      null,
      2,
    )}\n`,
  );
  log(
    `leads: wrote ${result.out.size} leads files and leads.json to ${leadsDir}; consistency ${JSON.stringify(Object.fromEntries(Object.entries(result.consistency).map(([arm, check]) => [arm, `${check.equal}/${check.picked}`])))}`,
  );
};
