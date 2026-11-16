import {
  cpSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { repositories } from "../../retrieval-bench/scoring-inputs.ts";
import { ensureDir, root, runDir, sha256 } from "../common.ts";
import type { SeedInput } from "../harness-side.ts";
import {
  baseEnv,
  cli,
  ensureCommit,
  inputTokens,
  log,
  request,
  run,
  runLogsOf,
  scratch,
  show,
  snapshot,
  workerRun,
  type Lane,
  type RunMode,
  type Tokens,
} from "../runner.ts";
import { SOL } from "../sticky.ts";
import {
  CYCLE_WINDOW_MS,
  FULL_TEST_RESULTS,
  KNOWN_CASE_PHASES,
  MAX_REREQUESTS,
  PHASES,
  PHASE_IDS,
  PROOF_RANGE_PHASES,
  SYSTEMATIC_FAILURES,
  type LeadsArm,
  type Phase,
  type PhaseId,
} from "./config.ts";
import { readKnownCases, readProofRanges } from "./known-cases.ts";
import {
  leadsPresent,
  readLeads,
  rowsForRange,
  type LeadsRow,
} from "./leads-file.ts";
import { extraLeadsFile, leadsFile } from "./config.ts";
import { readFullTestSelection, type FullTestSelection } from "./select.ts";

/**
 * The full test's runner (T1): phases A, C, A′, U′ and B in that order, each across every range
 * before the next (FT14 rule 3), on Sol through `--route openai` (FT7), at one pinned harness
 * snapshot (FT8), built on the 9.57 runner's primitives (runner.ts).
 *
 * Stores and copies (FT15). Each range has a *pristine* clone (`git clone --shared --no-checkout`
 * of its repository) made once, before any model call: proof records are copied into it where the
 * range has them, then the review is requested in it with no credential visible, which opens the
 * range's cycle and queues its job. Every phase's store is a copy of the pristine clone, so all
 * phases share the cycle and its request. Phase A computes Understand; once A's outputs are written
 * its Understand, merge pass and scope snapshot are exported to a small bundle file and A's clone is
 * deleted. A′, C and B import the whole bundle; U′ imports only the scope snapshot, so its
 * Understand is recomputed (and its request carries `--stub-hold investigate=…`, so it is a run of
 * its own in the same cycle). Each phase's clone is deleted once its outputs are written, except B's,
 * which its pre-registered continuation needs. A range's pristine clone and bundle are deleted once
 * every phase planned for it is stored and B's continuation is decided. No worktree, no
 * node_modules copy (the snapshot links them).
 *
 * Runs. A, C and A′ run the whole pipeline; a run that times out (10.42) is requested again up to
 * twice, each generation reusing every stored stage, and the final generation is what is compared;
 * generation 0's outcome is stored beside it (`<phase>.gen0.json.gz`) as the product's outcome. B is
 * stopped once every Investigate partition is done, U′ once Understand is (runner.ts
 * `understandDone`). The scale probe runs generation 0 only.
 *
 * Stops (FT14, with 10.89's change: no token cap). The plan's usage-limit error stops the
 * invocation; the next resumes from the next run on the same snapshot. The same failure on 3 runs in
 * a row (no model call, no receipt, no packet) stops it. A range whose pristine clone is older than
 * 10.79's 7-day window stops it, since its phases would no longer share a scope copy. Every run's
 * tokens, by stage and generation, are recorded in `spend.json`.
 */

export type RangeKind = "dev" | "probe" | "known" | "proof";

export interface PlannedRange {
  /** Short and file-system safe: names the scratch folders, whose socket path must stay short. */
  readonly key: string;
  readonly order: number;
  readonly caseId: string;
  readonly kind: RangeKind;
  readonly family: string;
  /** The repository the clones are made from. */
  readonly source: string;
  readonly base: string;
  readonly head: string;
  readonly phases: ReadonlyArray<PhaseId>;
  readonly gen0Only: boolean;
  readonly copyProofs: boolean;
  /** Where its proof records come from (absolute), or null to use the run's `--proof-source`. */
  readonly proofSource: string | null;
  readonly named: boolean;
  readonly pilot: boolean;
}

export interface PlannedRun {
  readonly phase: Phase;
  readonly range: PlannedRange;
}

/**
 * The repository a range's clones come from: a corpus by name, a planted case's clone under the
 * run's own scratch folder (`scratch:<name>`, built by `full-test plant`), or an absolute path.
 */
export const sourceOf = (source: string) => {
  if (source === "neuve" || source === "neuve_effect")
    return repositories[source];
  if (source.startsWith("scratch:")) {
    const path = join(scratch(), "ft", source.slice("scratch:".length));
    if (!existsSync(path))
      throw new Error(
        `${path} does not exist: run \`full-test plant\` in this scratch folder first`,
      );
    return path;
  }
  if (isAbsolute(source)) return source;
  throw new Error(
    `a known case's source must be neuve, neuve_effect, scratch:<name> or an absolute path: ${source}`,
  );
};

/** Every range of the full test with the phases it runs in (FT2, FT9, FT11). */
export const planRanges = (
  selection: FullTestSelection,
  known: ReturnType<typeof readKnownCases>,
  proofs: ReturnType<typeof readProofRanges>,
): Array<PlannedRange> => [
  ...selection.selected.map((entry) => ({
    key: `d${entry.order}`,
    order: entry.order,
    caseId: entry.caseId,
    kind: "dev" as const,
    family: entry.family,
    source: repositories[entry.repository as "neuve" | "neuve_effect"],
    base: entry.base,
    head: entry.head,
    phases: PHASE_IDS,
    gen0Only: false,
    copyProofs: false,
    proofSource: null,
    named: entry.named,
    pilot: entry.pilot,
  })),
  ...selection.probe.map((entry, index) => ({
    key: `s${index + 1}`,
    order: 100 + index,
    caseId: entry.caseId,
    kind: "probe" as const,
    family: entry.family,
    source: repositories[entry.repository as "neuve" | "neuve_effect"],
    base: entry.base,
    head: entry.head,
    phases: ["A"] as ReadonlyArray<PhaseId>,
    gen0Only: true,
    copyProofs: false,
    proofSource: null,
    named: false,
    pilot: false,
  })),
  ...known.map((entry, index) => ({
    key: `k${index + 1}`,
    order: 200 + index,
    caseId: entry.id,
    kind: "known" as const,
    family: `known:${entry.kind}`,
    source: entry.source,
    base: entry.base,
    head: entry.head,
    phases: KNOWN_CASE_PHASES,
    gen0Only: false,
    copyProofs: entry.copyProofs,
    proofSource:
      entry.proofSource === null
        ? null
        : join(FULL_TEST_RESULTS, entry.proofSource),
    named: false,
    pilot: false,
  })),
  ...proofs.map((entry, index) => ({
    key: `p${index + 1}`,
    order: 300 + index,
    caseId: entry.id,
    kind: "proof" as const,
    family: "proof",
    source: entry.source,
    base: entry.base,
    head: entry.head,
    phases: PROOF_RANGE_PHASES,
    gen0Only: false,
    copyProofs: true,
    proofSource:
      entry.proofSource === null
        ? null
        : join(FULL_TEST_RESULTS, entry.proofSource),
    named: false,
    pilot: false,
  })),
];

/**
 * The runs of an invocation in order: phase by phase, each across its ranges in run order. The
 * pilot (FT14 rule 1) is the first 3 dev ranges through every phase; `kinds` narrows the ranges.
 */
export const planRuns = (
  ranges: ReadonlyArray<PlannedRange>,
  options: {
    readonly phases?: ReadonlyArray<PhaseId> | undefined;
    readonly pilot?: boolean | undefined;
    readonly kinds?: ReadonlyArray<RangeKind> | undefined;
    readonly only?: ReadonlyArray<string> | undefined;
  } = {},
): Array<PlannedRun> => {
  const wanted = PHASES.filter(
    (phase) =>
      options.phases === undefined || options.phases.includes(phase.id),
  );
  const chosen = ranges
    .filter((range) => options.pilot !== true || range.pilot)
    .filter(
      (range) =>
        options.kinds === undefined || options.kinds.includes(range.kind),
    )
    .filter(
      (range) =>
        options.only === undefined ||
        options.only.includes(range.key) ||
        options.only.includes(range.caseId),
    )
    .sort((a, b) => a.order - b.order);
  return wanted.flatMap((phase) =>
    chosen
      .filter((range) => range.phases.includes(phase.id))
      .map((range) => ({ phase, range })),
  );
};

// Files

export const runsDir = (caseId: string) => runDir(caseId, FULL_TEST_RESULTS);
export const storedFile = (caseId: string, phase: PhaseId, suffix = "") =>
  join(runsDir(caseId), `${phase}${suffix}.json.gz`);
export const isStored = (caseId: string, phase: PhaseId) =>
  existsSync(storedFile(caseId, phase));

export const readStored = <T = Record<string, unknown>>(
  caseId: string,
  phase: PhaseId,
  suffix = "",
): T | undefined => {
  const path = storedFile(caseId, phase, suffix);
  return existsSync(path)
    ? (JSON.parse(gunzipSync(readFileSync(path)).toString("utf8")) as T)
    : undefined;
};

const writeStored = (path: string, value: unknown) =>
  writeFileSync(path, gzipSync(Buffer.from(JSON.stringify(value))));

/**
 * Writes a run's stored file, after `before` succeeds when given: the value goes to a pending file
 * first, `before` reads it, and only then is it renamed into place. If `before` fails, the pending
 * file is removed and nothing is stored, so the run is redone.
 */
export const storeAfter = async (
  path: string,
  value: unknown,
  before?: (pending: string) => Promise<void>,
) => {
  if (before === undefined) {
    writeStored(path, value);
    return;
  }
  const pending = path.replace(/\.json\.gz$/, ".pending.json.gz");
  writeStored(pending, value);
  try {
    await before(pending);
  } catch (error) {
    rmSync(pending, { force: true });
    throw error;
  }
  renameSync(pending, path);
};

const ftScratch = () => join(scratch(), "ft");
const pristineDir = (range: PlannedRange) => join(ftScratch(), "p", range.key);
const cloneDir = (range: PlannedRange, phase: PhaseId) =>
  join(ftScratch(), "w", `${phase}-${range.key}`);
const bundleFile = (range: PlannedRange) =>
  join(ftScratch(), "b", `${range.key}.json`);
const homeDir = () => join(ftScratch(), "home");

interface Pristine {
  readonly caseId: string;
  readonly baseOid: string;
  readonly headOid: string;
  readonly runId: string;
  readonly job: string;
  readonly cycleId: string | null;
  readonly createdAt: string;
  readonly proofs: unknown;
}

const pristineRecord = (range: PlannedRange): Pristine | undefined => {
  const path = join(runsDir(range.caseId), "pristine.json");
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as Pristine)
    : undefined;
};

// Spend

export interface FullTestRun {
  readonly phase: PhaseId;
  readonly caseId: string;
  readonly kind: RangeKind;
  readonly order: number;
  readonly route: string;
  /** Each generation's run ID, generation 0 first. */
  readonly runIds: ReadonlyArray<string>;
  readonly gen0Outcome: string;
  readonly outcome: string;
  readonly tokens: Tokens;
  readonly tokensByGeneration: ReadonlyArray<Tokens>;
  readonly tokensByStage: Readonly<Record<string, Tokens>>;
  readonly modelCalls: number;
  readonly wallMs: number | null;
  readonly understand: string;
  readonly stoppedByWatcher: boolean;
  readonly usageLimit: string | null;
  readonly stored: boolean;
  readonly failure: string | null;
  readonly leads: string;
  readonly at: string;
}

const spendFile = () => join(FULL_TEST_RESULTS, "spend.json");

/**
 * Each run's latest entry: an aborted or retried attempt at a phase and range leaves earlier entries
 * in `spend.runs` (kept as the record of what was spent), and only the latest is reported. B's
 * continuation is a run of its own.
 */
export const latestRuns = <
  T extends {
    readonly phase: string;
    readonly caseId: string;
    readonly gen0Outcome: string;
  },
>(
  runs: ReadonlyArray<T>,
): Array<T> => {
  const latest = new Map<string, T>();
  for (const run of runs)
    latest.set(
      `${run.phase}\u0000${run.caseId}\u0000${run.gen0Outcome === "continuation" ? "continued" : "run"}`,
      run,
    );
  return [...latest.values()];
};

interface SpendFile {
  readonly note: string;
  readonly route: string;
  readonly snapshotCommit: string | null;
  readonly invocations: ReadonlyArray<Record<string, unknown>>;
  readonly stops: ReadonlyArray<Record<string, unknown>>;
  readonly runs: ReadonlyArray<FullTestRun>;
}

export const readFullTestSpend = (): SpendFile =>
  existsSync(spendFile())
    ? (JSON.parse(readFileSync(spendFile(), "utf8")) as SpendFile)
    : {
        note: "Measured: each run's tokens from its run logs, by stage and generation. The route has no USD price (the owner's ChatGPT sign-in, 10.85); 10.89 sets no token cap, so runs stop only on the plan's usage limit and the proposal's other stop rules.",
        route: SOL.name,
        snapshotCommit: null,
        invocations: [],
        stops: [],
        runs: [],
      };

const writeFullTestSpend = (spend: SpendFile) => {
  ensureDir(FULL_TEST_RESULTS);
  writeFileSync(spendFile(), `${JSON.stringify(spend, null, 2)}\n`);
};

const zero = (): Tokens => ({
  input: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
  output: 0,
});
const minus = (a: Tokens, b: Tokens): Tokens => ({
  input: a.input - b.input,
  cacheWrite5m: a.cacheWrite5m - b.cacheWrite5m,
  cacheWrite1h: a.cacheWrite1h - b.cacheWrite1h,
  cacheRead: a.cacheRead - b.cacheRead,
  output: a.output - b.output,
});

// Snapshot

/** Text the pinned snapshot must hold: 10.84's seeding and 10.88's lead-drop checks. */
export const SNAPSHOT_MUST_HOLD: ReadonlyArray<{
  readonly path: string;
  readonly text: string;
  readonly why: string;
  /** Required only when frozen leads go through the seam (`--leads-via seam`). */
  readonly when?: "seam";
}> = [
  {
    path: "packages/harness/src/frozen.ts",
    text: "export const frozenRetriever",
    why: "the frozen-candidate seam",
    when: "seam",
  },
  {
    path: "packages/harness/src/pipeline.ts",
    text: "export const understandBasis",
    why: "Understand's key independent of the leads retriever, so phases share A's Understand through the seam",
    when: "seam",
  },
  {
    path: "packages/harness/src/lookups.ts",
    text: 'name: "semantic_search"',
    why: "Investigate's semantic_search tool (10.89)",
  },
  {
    path: "packages/harness/src/lookups.ts",
    text: 'name: "graph_search"',
    why: "Investigate's graph_search tool (10.89)",
  },
  {
    path: "packages/harness/src/investigate.ts",
    text: "export const investigatePromptVersion",
    why: "10.84's seeded leads",
  },
  {
    path: "packages/harness/src/investigate.ts",
    text: "export const SeededDropInput",
    why: "10.88's lead-drop checks",
  },
];

const git = (...args: Array<string>) => {
  const result = Bun.spawnSync(["git", "-C", root, ...args]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};

/** The snapshot: pinned in `snapshot.json` on the first real run, then reused (FT8). */
export const pinnedFullTestSnapshot = (
  requested: string | undefined,
  dry: boolean,
  leadsVia: LeadsVia = DEFAULT_LEADS_VIA,
) => {
  const file = join(FULL_TEST_RESULTS, "snapshot.json");
  const pinned = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as { commit: string }).commit
    : undefined;
  const commit =
    pinned ?? git("rev-parse", "--verify", `${requested ?? "HEAD"}^{commit}`);
  if (requested !== undefined && pinned !== undefined) {
    const asked = git("rev-parse", "--verify", `${requested}^{commit}`);
    if (asked !== pinned)
      throw new Error(
        `the full test is pinned to ${pinned}; a fix changes the snapshot, so the affected phase is rerun (FT14 rule 6): remove ${file} and that phase's runs first`,
      );
  }
  for (const need of SNAPSHOT_MUST_HOLD) {
    if (need.when === "seam" && leadsVia !== "seam") continue;
    const held = Bun.spawnSync([
      "git",
      "-C",
      root,
      "show",
      `${commit}:${need.path}`,
    ]);
    if (held.exitCode !== 0 || !held.stdout.toString().includes(need.text))
      throw new Error(`${commit} does not hold ${need.why} (${need.text})`);
  }
  if (pinned === undefined && !dry) {
    ensureDir(FULL_TEST_RESULTS);
    writeFileSync(
      file,
      `${JSON.stringify({ commit, pinnedAt: new Date().toISOString() }, null, 2)}\n`,
    );
  }
  return commit;
};

const modeFor = (phase: Phase, snapshotCommit: string): RunMode => ({
  lanes: [],
  snapshotCommit,
  route: SOL,
  results: FULL_TEST_RESULTS,
  stopUsd: null,
  reserveUsd: () => 0,
  scratchSuffix: "-ft",
  stopAfterInvestigate: phase.stop === "after-investigate",
  stopAfterUnderstand: phase.stop === "after-understand",
  requireUnderstandReused: phase.copy === "understand",
  workerTimeoutMs: 40 * 60_000,
  linkNodeModules: true,
});

const laneFor = (phase: Phase): Lane =>
  ({ slug: phase.id, candidate: "R(H3-E1)", env: {} }) as Lane;

const harnessSide = (snap: string) => [
  process.execPath,
  join(snap, "packages/evaluation/src/harness-compare/harness-side.ts"),
];

// Leads

/** A leads row's ID in a seed input: M4's hunk ID where the row is one of M4's, else a stable hash. */
const rowId = (row: LeadsRow) =>
  `row:${sha256(`${row.caseId}\u0000${row.path}\u0000${row.diffText}`).slice(0, 16)}`;

export const seedInputFor = (
  arm: LeadsArm,
  base: string,
  head: string,
  rows: ReadonlyArray<LeadsRow>,
): SeedInput => ({
  candidate: arm,
  base,
  head,
  hunks: rows.map((row) => ({
    hunkId: rowId(row),
    path: row.path,
    oldPath: row.oldPath ?? row.path,
    old: row.old,
    new: row.new,
    queryText: row.queryText,
    regions: row.regions.slice(0, 10),
    diffText: row.diffText,
  })),
});

/**
 * How frozen leads reach the harness. `seam` (the default): the frozen-candidate seam in
 * packages/harness (`frozen.ts`), configured as `search.leads.frozen = { candidate, file }` in the
 * user settings of the phase's own scratch HOME, so the phase requests its own run (its
 * configuration names the candidate and the file's SHA-256) in the range's cycle; the seam reads
 * the labelling side's rows as produced, and Understand's key does not depend on the leads
 * retriever (pipeline.ts `understandBasis`), so A, C and B still share A's Understand. `bm25-key`:
 * the 9.57 workaround, each hunk's leads stored as its leads computation under the BM25 key
 * (harness-side.ts `seed`), kept only as a disclosed fallback.
 */
export type LeadsVia = "seam" | "bm25-key";
export const DEFAULT_LEADS_VIA: LeadsVia = "seam";

const settingsFile = (home: string) =>
  process.platform === "darwin"
    ? join(home, "Library", "Application Support", "Neuve", "settings.json")
    : join(home, ".config", "neuve", "settings.json");

/** Writes a scratch HOME's Neuve settings: the search template, and the leads source if any. */
export const writeHomeSettings = (
  home: string,
  search: Record<string, unknown> | undefined,
  leads: { readonly candidate: string; readonly file: string } | undefined,
) => {
  const path = settingsFile(home);
  // The check's search tools are semantic_search and graph_search; the template's own leads
  // setting never applies, since each phase names its leads here (or none, for BM25).
  const { leads: _templateLeads, ...tools } = search ?? {};
  const block = {
    ...tools,
    ...(leads === undefined ? {} : { leads: { frozen: leads } }),
  };
  ensureDir(join(path, ".."));
  writeFileSync(
    path,
    `${JSON.stringify({ version: 1, ...(Object.keys(block).length === 0 ? {} : { search: block }) }, null, 2)}\n`,
  );
  return path;
};

/**
 * The one place frozen leads enter a phase. Returns the disclosure the run records, the scratch
 * HOME the phase's request and worker use, and whether the phase needs a request of its own.
 */
export const feedFrozenLeads = async (
  ctx: {
    readonly snap: string;
    readonly home: string;
    readonly leadsVia: LeadsVia;
    readonly searchSettings: Record<string, unknown> | undefined;
    readonly leads: Partial<Record<LeadsArm, Map<string, Array<LeadsRow>>>>;
  },
  options: {
    readonly clone: string;
    readonly arm: LeadsArm;
    readonly baseOid: string;
    readonly headOid: string;
    readonly rows: ReadonlyArray<LeadsRow>;
    readonly report: string;
    readonly env: Record<string, string>;
  },
) => {
  if (ctx.leadsVia === "seam") {
    // The extra ranges' rows are in their own file; the seam reads one file per candidate, so each
    // file has its own HOME (and so its own request configuration, keyed on the file's hash).
    const extra =
      options.rows.length > 0 &&
      options.rows.every((row) => row.file === "extra");
    const home = join(
      ftScratch(),
      `home-${options.arm.replace(/[^A-Za-z0-9-]/g, "_")}${extra ? "-extra" : ""}`,
    );
    ensureDir(home);
    if (
      existsSync(join(ctx.home, ".config", "neuve")) &&
      !existsSync(join(home, ".config", "neuve"))
    )
      SOL.credential(home);
    writeHomeSettings(home, ctx.searchSettings, {
      candidate: options.arm,
      file: extra ? extraLeadsFile(options.arm) : leadsFile(options.arm),
    });
    return {
      note: `${options.arm} frozen leads through the frozen-candidate seam (search.leads.frozen), under the candidate's own name`,
      home,
      ownRequest: true,
    };
  }
  const input = join(
    options.clone,
    "..",
    `seed-input-${sha256(options.clone).slice(0, 8)}.json`,
  );
  writeFileSync(
    input,
    JSON.stringify(
      seedInputFor(options.arm, options.baseOid, options.headOid, options.rows),
    ),
  );
  await run(
    [
      ...harnessSide(ctx.snap),
      "seed",
      "--repo",
      options.clone,
      "--input",
      input,
      "--out",
      options.report,
    ],
    { env: options.env },
  );
  rmSync(input, { force: true });
  return {
    note: `${options.arm} frozen leads, stored under the BM25 key (the disclosed fallback path, chosen with --leads-via bm25-key; every result names its real retriever)`,
    home: ctx.home,
    ownRequest: false,
  };
};

// One run

interface RunContext {
  readonly snap: string;
  readonly commit: string;
  readonly home: string;
  readonly leadsVia: LeadsVia;
  readonly searchSettings: Record<string, unknown> | undefined;
  readonly proofSource: string | undefined;
  readonly leads: Partial<Record<LeadsArm, Map<string, Array<LeadsRow>>>>;
  readonly dry: boolean;
}

const routeArgs = () => [...SOL.requestArgs];

/**
 * Proof records for a range's commits from `source`, which is one of: a bundle file already
 * exported (`.json`, as kept from a scratch store that may be cleaned), a store folder (holding
 * `records.sqlite`), or a repository. Each is read only; a bundle is narrowed to the commits here.
 */
const exportProofsFrom = async (
  ctx: RunContext,
  source: string,
  commitsFile: string,
  out: string,
  env: Record<string, string>,
) => {
  if (source.endsWith(".json")) {
    const commits = new Set(
      readFileSync(commitsFile, "utf8").split("\n").filter(Boolean),
    );
    const held = JSON.parse(readFileSync(source, "utf8")) as {
      events: ReadonlyArray<{
        payload: { revision: string };
        attribution?: { range?: { headOid?: string } };
        refs: ReadonlyArray<{ ref: string }>;
      }>;
      blobs: ReadonlyArray<{ hash: string }>;
    };
    const events = held.events.filter(
      (event) =>
        commits.has(event.payload.revision) ||
        commits.has(event.attribution?.range?.headOid ?? ""),
    );
    const hashes = new Set(
      events.map((event) => event.refs[0]!.ref.slice("blob:".length)),
    );
    writeFileSync(
      out,
      JSON.stringify({
        events,
        blobs: held.blobs.filter((blob) => hashes.has(blob.hash)),
      }),
    );
    return;
  }
  const store = existsSync(join(source, "records.sqlite"));
  await run(
    [
      ...harnessSide(ctx.snap),
      "export-proofs",
      store ? "--source-store" : "--source",
      source,
      "--commits",
      commitsFile,
      "--out",
      out,
    ],
    { env },
  );
};

/** The range's pristine clone with its request queued; made once, before any model call. */
const ensurePristine = async (range: PlannedRange, ctx: RunContext) => {
  const dir = pristineDir(range);
  const held = pristineRecord(range);
  if (held !== undefined && existsSync(dir)) {
    const age = Date.now() - Date.parse(held.createdAt);
    if (age > CYCLE_WINDOW_MS)
      return {
        stop: `the range's cycle was opened ${Math.round(age / 3_600_000)} h ago, past 10.79's 7-day window; its phases would not share a scope copy`,
      } as const;
    return { pristine: held, dir } as const;
  }
  if (held !== undefined && !existsSync(dir))
    return {
      stop: `the range's pristine clone is gone but ${join(runsDir(range.caseId), "pristine.json")} remains: phases already run on its cycle cannot be joined; move that range's outputs aside to start it again`,
    } as const;
  const env = baseEnv(ctx.home);
  rmSync(dir, { recursive: true, force: true });
  ensureDir(join(ftScratch(), "p"));
  const source = sourceOf(range.source);
  await run(
    ["git", "clone", "--quiet", "--shared", "--no-checkout", source, dir],
    { env },
  );
  await ensureCommit(dir, source, range.base, env).catch(() => undefined);
  await ensureCommit(dir, source, range.head, env);
  const resolve = async (rev: string) =>
    (
      await run(
        ["git", "-C", dir, "rev-parse", "--verify", `${rev}^{commit}`],
        { env },
      )
    ).stdout.trim();
  const baseOid = await resolve(range.base);
  const headOid = await resolve(range.head);
  let proofs: unknown = null;
  const proofSource = range.proofSource ?? ctx.proofSource;
  if (range.copyProofs && proofSource === undefined)
    // The range runs without its proof records; its proof measures then read "not measured".
    proofs = {
      copied: false,
      note: "not measured: no --proof-source named the store holding this range's proof records",
    };
  if (range.copyProofs && proofSource !== undefined) {
    const commits = (
      await run(["git", "-C", dir, "rev-list", `${baseOid}..${headOid}`], {
        env,
      })
    ).stdout;
    const work = join(ftScratch(), "b");
    ensureDir(work);
    const list = join(work, `${range.key}-commits.txt`);
    writeFileSync(list, commits);
    const bundle = join(work, `${range.key}-proofs.json`);
    await exportProofsFrom(ctx, proofSource, list, bundle, env);
    ensureDir(runsDir(range.caseId));
    const report = join(runsDir(range.caseId), "proofs-copied.json");
    await run(
      [
        ...harnessSide(ctx.snap),
        "import-proofs",
        "--bundle",
        bundle,
        "--to",
        dir,
        "--out",
        report,
      ],
      { env },
    );
    proofs = JSON.parse(readFileSync(report, "utf8"));
    rmSync(bundle, { force: true });
  }
  const requested = await request(
    ctx.snap,
    dir,
    `${baseOid}..${headOid}`,
    routeArgs(),
    ctx.home,
  );
  ensureDir(runsDir(range.caseId));
  writeFileSync(join(runsDir(range.caseId), "request.txt"), requested.text);
  const record: Pristine = {
    caseId: range.caseId,
    baseOid,
    headOid,
    runId: requested.runId,
    job: requested.job,
    cycleId:
      /(?:opened|joined) cycle ([0-9A-Z]{26})/.exec(requested.text)?.[1] ??
      null,
    createdAt: new Date().toISOString(),
    proofs,
  };
  writeFileSync(
    join(runsDir(range.caseId), "pristine.json"),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  return { pristine: record, dir } as const;
};

/** What `runOne` returns to the loop: the stored entry, or why the invocation stops. */
type RunOutcome =
  | { readonly kind: "skipped" }
  | { readonly kind: "ran"; readonly entry: FullTestRun }
  | { readonly kind: "stop"; readonly reason: string; readonly detail: string };

/**
 * How a run failed, for FT14 rule 6's systematic stop (the same failure on 3 runs in a row), or
 * null for a run that ended as its phase intends. Any terminal outcome other than the intended one
 * counts: a full run that neither completed nor timed out (stopped, failed, no receipt), a completed
 * run that published no packet, and a B or U′ run that ended before its stage was done. A run that
 * recomputed a shared Understand is its own failure, and stops the invocation at once.
 */
export const failureOf = (entry: {
  readonly modelCalls: number;
  readonly outcome: string;
  readonly stoppedByWatcher: boolean;
  readonly packetPublished: boolean;
  readonly stop: Phase["stop"];
  readonly finished: boolean;
  readonly understandRecomputed?: boolean;
}) => {
  if (entry.understandRecomputed === true) return "understand-not-shared";
  if (entry.modelCalls === 0) return "no-model-call";
  if (entry.stop === "full") {
    if (entry.outcome === "completed")
      return entry.packetPublished ? null : "no-packet";
    if (entry.outcome === "timed-out") return null;
    return entry.outcome === "no receipt"
      ? "no-receipt"
      : `outcome:${entry.outcome}`;
  }
  return entry.finished
    ? null
    : entry.stop === "after-investigate"
      ? "investigate-unfinished"
      : "understand-unfinished";
};

/**
 * Exports A's Understand, merge pass and scope snapshot to the range's bundle, which A′, C, U′ and
 * B import. A bundle without Understand would let a later phase recompute it silently: refuse it.
 */
const shareUnderstand = async (
  range: PlannedRange,
  clone: string,
  ctx: RunContext,
) => {
  ensureDir(join(ftScratch(), "b"));
  await run(
    [
      ...harnessSide(ctx.snap),
      "export",
      "--ops",
      "understand",
      "--from",
      clone,
      "--out",
      bundleFile(range),
    ],
    { env: baseEnv(ctx.home) },
  );
  const ops = new Set(
    (
      JSON.parse(readFileSync(bundleFile(range), "utf8")) as {
        entries: ReadonlyArray<{ op: string }>;
      }
    ).entries.map((entry) => entry.op),
  );
  if (!ops.has("harness.understand") || !ops.has("harness.scope-snapshot")) {
    rmSync(bundleFile(range), { force: true });
    log(
      `A ${range.caseId}: the stored run holds no Understand or scope snapshot to share`,
    );
  }
};

const runOne = async (
  { phase, range }: PlannedRun,
  ctx: RunContext,
): Promise<RunOutcome> => {
  if (isStored(range.caseId, phase.id)) {
    // An invocation that stopped after storing A but before sharing its Understand left A's clone:
    // finish what it left, so the range's later phases still share A's Understand.
    const clone = cloneDir(range, phase.id);
    if (
      phase.id === "A" &&
      !existsSync(bundleFile(range)) &&
      existsSync(clone)
    ) {
      log(
        `A ${range.caseId}: stored; sharing its Understand from the clone left behind`,
      );
      await shareUnderstand(range, clone, ctx);
      keepRunLogs(clone, storedFile(range.caseId, phase.id, ".runlogs"));
      rmSync(clone, { recursive: true, force: true });
    }
    return { kind: "skipped" };
  }
  // A new attempt: an earlier attempt's generation-0 file must never be read as this one's.
  rmSync(storedFile(range.caseId, phase.id, ".gen0"), { force: true });
  const env = baseEnv(ctx.home);
  // Leads first: a frozen phase never runs without its arm's file.
  let leadRows: Array<LeadsRow> | null = null;
  if (phase.leads.kind === "frozen") {
    const byCase = ctx.leads[phase.leads.arm];
    if (byCase === undefined)
      return {
        kind: "stop",
        reason: "no-leads-file",
        detail: `${phase.leads.arm}'s all-hunks leads file has not landed`,
      };
  }
  if (phase.copy !== "none" && !existsSync(bundleFile(range))) {
    // Phase A did not store a whole run here, so this range has no Understand to share: it is
    // reported incomplete for this phase, and the phase goes on with the other ranges.
    log(
      `${phase.label} ${range.caseId}: skipped, phase A stored no Understand for this range`,
    );
    ensureDir(runsDir(range.caseId));
    writeFileSync(
      join(runsDir(range.caseId), `${phase.id}.skipped.txt`),
      `${new Date().toISOString()}: phase A stored no whole run, so there is no Understand to share\n`,
    );
    return { kind: "skipped" };
  }
  const prepared = await ensurePristine(range, ctx);
  if ("stop" in prepared)
    return { kind: "stop", reason: "pristine", detail: prepared.stop };
  const { pristine } = prepared;
  // The range's rows by its resolved revisions, as the seam selects them (a known case's name is
  // not a case ID).
  if (phase.leads.kind === "frozen") {
    leadRows = rowsForRange(ctx.leads[phase.leads.arm]!, {
      baseOid: pristine.baseOid,
      headOid: pristine.headOid,
    });
    if (leadRows.length === 0 && range.kind === "dev")
      return {
        kind: "stop",
        reason: "no-leads-rows",
        detail: `${phase.leads.arm}'s leads file has no row for ${range.caseId}`,
      };
  }
  const out = runsDir(range.caseId);
  const clone = cloneDir(range, phase.id);
  rmSync(clone, { recursive: true, force: true });
  ensureDir(join(ftScratch(), "w"));
  cpSync(prepared.dir, clone, { recursive: true });
  const rangeText = `${pristine.baseOid}..${pristine.headOid}`;
  const args = [...routeArgs(), ...phase.requestArgs];
  let runId = pristine.runId;
  // The job this phase's run belongs to: the pristine request's, or its own request's.
  let job = pristine.job;
  let leadsNote = "harness BM25 (the harness as shipped)";
  let home = ctx.home;
  let ownRequest = phase.requestArgs.length > 0;
  if (leadRows !== null && phase.leads.kind === "frozen") {
    if (leadRows.length === 0) {
      leadsNote = `harness BM25: ${phase.leads.arm}'s leads file has no row for this range (disclosed, FT11)`;
    } else {
      const fed = await feedFrozenLeads(ctx, {
        clone,
        arm: phase.leads.arm,
        baseOid: pristine.baseOid,
        headOid: pristine.headOid,
        rows: leadRows,
        report: join(out, `seed-${phase.id}.json`),
        env,
      });
      leadsNote = fed.note;
      home = fed.home;
      ownRequest ||= fed.ownRequest;
    }
  }
  if (ownRequest) {
    const own = await request(ctx.snap, clone, rangeText, args, home);
    if (!/joined cycle/.test(own.text))
      throw new Error(
        `${phase.label}'s request did not join the range's cycle: ${own.text}`,
      );
    writeFileSync(join(out, `request-${phase.id}.txt`), own.text);
    await run(
      [...cli(ctx.snap), "jobs", "drop", pristine.job, "--repo", clone],
      { env },
    );
    runId = own.runId;
    job = own.job;
  }
  /** Every job this phase's generations ran under, the latest last. */
  let jobs: ReadonlyArray<string> = [job];
  if (phase.copy !== "none")
    await run(
      [
        ...harnessSide(ctx.snap),
        "import",
        "--ops",
        phase.copy,
        "--bundle",
        bundleFile(range),
        "--to",
        clone,
        "--out",
        join(out, `copied-into-${phase.id}.json`),
      ],
      { env },
    );
  if (ctx.dry) {
    rmSync(clone, { recursive: true, force: true });
    log(`${phase.label} ${range.caseId}: prepared (dry run, no worker)`);
    return { kind: "skipped" };
  }
  const mode = modeFor(phase, ctx.commit);
  const lane = laneFor(phase);
  log(`${phase.label} ${range.caseId}: worker started`);
  let worker = await workerRun(ctx.snap, clone, home, 0, mode, lane, 0);
  const runIds: Array<string> = [worker.latestRunId ?? runId];
  const perGeneration: Array<Tokens> = [worker.live.tokens];
  let shown = await show(ctx.snap, clone, home, runIds.at(-1)!);
  const gen0Outcome = String(shown["outcome"] ?? "no receipt");
  const healthy = () =>
    !worker.stopped && worker.usageLimit === null && worker.live.calls > 0;
  const again = () => {
    if (!healthy() || range.gen0Only || runIds.length > MAX_REREQUESTS)
      return false;
    if (phase.stop === "full")
      return String(shown["outcome"] ?? "") === "timed-out";
    if (phase.stop === "after-investigate") return !worker.finishedInvestigate;
    return !worker.finishedUnderstand;
  };
  while (again()) {
    if (runIds.length === 1 && phase.stop === "full")
      writeStored(storedFile(range.caseId, phase.id, ".gen0"), shown);
    log(
      `${phase.label} ${range.caseId}: generation ${runIds.length - 1} ended short; requesting generation ${runIds.length} (10.42)`,
    );
    // The re-request may queue a new job; the stopped worker's job is then that one.
    ({ job, jobs } = afterReRequest(
      jobs,
      await request(ctx.snap, clone, rangeText, args, home),
    ));
    const before = worker.live.tokens;
    worker = await workerRun(ctx.snap, clone, home, 0, mode, lane, 0);
    runIds.push(worker.latestRunId ?? runIds.at(-1)!);
    perGeneration.push(minus(worker.live.tokens, before));
    shown = await show(ctx.snap, clone, home, runIds.at(-1)!);
  }
  const outcome = String(
    shown["outcome"] ??
      (worker.stopped
        ? "stopped"
        : phase.stop === "after-investigate" && worker.finishedInvestigate
          ? "investigate-complete"
          : phase.stop === "after-understand" && worker.finishedUnderstand
            ? "understand-complete"
            : "no receipt"),
  );
  const whole =
    healthy() &&
    (phase.stop === "full"
      ? // A run still timed out after its two re-requests is final and reported incomplete (FT14
        // rule 5); it is stored, so a later invocation never spends on it again.
        outcome === "completed" ||
        (outcome === "timed-out" &&
          (range.gen0Only || runIds.length > MAX_REREQUESTS))
      : phase.stop === "after-investigate"
        ? worker.finishedInvestigate
        : worker.finishedUnderstand);
  const stored = {
    ...shown,
    measurement: {
      phase: phase.id,
      range: range.caseId,
      kind: range.kind,
      cycleId: pristine.cycleId,
      requestedRun: runId,
      runIds,
      gen0Outcome,
      stoppedAfterInvestigate:
        phase.stop === "after-investigate" && worker.finishedInvestigate,
      stoppedAfterUnderstand:
        phase.stop === "after-understand" && worker.finishedUnderstand,
      understand: worker.understand,
      leads: leadsNote,
      leadsVia: ctx.leadsVia,
      /** The phase's latest job, which B's continuation drops before it requests again. */
      job,
      jobs,
      /** The range's revisions, so a citation's revision can be read as a side. */
      baseOid: pristine.baseOid,
      headOid: pristine.headOid,
      /** The scratch HOME whose settings froze this phase's request (B's continuation reuses it). */
      home,
    },
  };
  // FT4's served top 3, as the harness's own chunks at the range's base, read while the clone
  // (and so its index) is still here; B's rule compares A's and B's. The run is stored only once
  // its served file is written, so a failing `served` leaves the run to be redone, never stored
  // without it.
  let servedFailure = null as string | null;
  await storeAfter(
    storedFile(range.caseId, phase.id, whole ? "" : ".incomplete"),
    stored,
    whole && (phase.id === "A" || phase.id === "B")
      ? async (shown) => {
          await run(
            [
              ...harnessSide(ctx.snap),
              "served",
              "--repo",
              clone,
              "--shown",
              shown,
              "--out",
              join(out, `served-${phase.id}.json`),
            ],
            { env: baseEnv(ctx.home) },
          );
        }
      : undefined,
  ).catch((error: unknown) => {
    // Kept apart for inspection and counted as spent; the run is redone by a later invocation.
    servedFailure =
      error instanceof Error ? error.message.slice(0, 300) : String(error);
    writeStored(storedFile(range.caseId, phase.id, ".incomplete"), stored);
    log(
      `${phase.label} ${range.caseId}: served failed, so the run is not stored: ${servedFailure}`,
    );
  });
  const entry: FullTestRun = {
    phase: phase.id,
    caseId: range.caseId,
    kind: range.kind,
    order: range.order,
    route: SOL.name,
    runIds,
    gen0Outcome,
    outcome,
    tokens: worker.live.tokens,
    tokensByGeneration: perGeneration,
    tokensByStage: worker.byStage,
    modelCalls: worker.live.calls,
    wallMs: ((shown["timing"] ?? {}) as { wallMs?: number }).wallMs ?? null,
    understand: worker.understand,
    stoppedByWatcher: worker.stopped,
    usageLimit: worker.usageLimit,
    stored: whole && servedFailure === null,
    failure:
      servedFailure !== null
        ? "served-failed"
        : failureOf({
            modelCalls: worker.live.calls,
            outcome,
            stoppedByWatcher: worker.stopped,
            packetPublished:
              shown["packet"] !== null && shown["packet"] !== undefined,
            stop: phase.stop,
            finished:
              phase.stop === "after-investigate"
                ? worker.finishedInvestigate
                : worker.finishedUnderstand,
            understandRecomputed:
              phase.copy === "understand" && worker.understandRecomputed,
          }),
    leads: leadsNote,
    at: new Date().toISOString(),
  };
  const spend = readFullTestSpend();
  writeFullTestSpend({ ...spend, runs: [...spend.runs, entry] });
  log(
    `${phase.label} ${range.caseId}: ${outcome} after ${runIds.length} generation(s), ${inputTokens(entry.tokens).toLocaleString("en")} input tokens, ${entry.modelCalls} calls`,
  );
  if (phase.id === "A" && whole && servedFailure === null)
    await shareUnderstand(range, clone, ctx);
  // The run logs (no prompt or source text, 10.16) are kept for per-turn latency, calls in flight
  // and the receipts' other telemetry, since the clone goes.
  keepRunLogs(clone, storedFile(range.caseId, phase.id, ".runlogs"));
  // B's clone stays for its pre-registered continuation; every other phase's goes now.
  if (phase.id !== "B") rmSync(clone, { recursive: true, force: true });
  return { kind: "ran", entry };
};

/** Every run log of a clone, gzipped as one JSON array of `{ file, text }`. */
const keepRunLogs = (clone: string, path: string) =>
  writeStored(
    path,
    runLogsOf(clone).map((file) => ({
      file: file.split("/").at(-1),
      text: readFileSync(file, "utf8"),
    })),
  );

/**
 * Whether FT4's rule for B has been decided on complete phases (cli `continue-b` writes the file
 * only then). B's clones are never released before, so its continuation stays possible.
 */
export const bDecisionComplete = () => {
  const path = join(FULL_TEST_RESULTS, "b-continuation.json");
  if (!existsSync(path)) return false;
  const decision = JSON.parse(readFileSync(path, "utf8")) as {
    measured?: boolean;
    incomplete?: ReadonlyArray<string>;
  };
  return decision.measured === true && (decision.incomplete ?? []).length === 0;
};

/** Deletes a range's pristine clone and bundle once every planned phase is stored and B is decided. */
const releaseRange = (range: PlannedRange) => {
  const done = range.phases.every((phase) => isStored(range.caseId, phase));
  const bDecided = !range.phases.includes("B") || bDecisionComplete();
  if (!done || !bDecided) return false;
  rmSync(pristineDir(range), { recursive: true, force: true });
  rmSync(bundleFile(range), { force: true });
  rmSync(cloneDir(range, "B"), { recursive: true, force: true });
  return true;
};

export interface FullTestOptions {
  readonly phases?: ReadonlyArray<PhaseId> | undefined;
  readonly pilot?: boolean | undefined;
  readonly kinds?: ReadonlyArray<RangeKind> | undefined;
  readonly only?: ReadonlyArray<string> | undefined;
  readonly dry?: boolean | undefined;
  readonly snapshot?: string | undefined;
  readonly proofSource?: string | undefined;
  readonly leadsVia?: LeadsVia | undefined;
  /** A settings template for the search tools (`search.graph`, `search.e0`), copied into each HOME. */
  readonly searchSettings?: string | undefined;
}

export const runFullTest = async (options: FullTestOptions) => {
  const dry = options.dry === true;
  const selection = readFullTestSelection();
  const ranges = planRanges(selection, readKnownCases(), readProofRanges());
  const runs = planRuns(ranges, options);
  const present = leadsPresent();
  const leads: RunContext["leads"] = {};
  for (const arm of Object.keys(present) as Array<LeadsArm>)
    if (present[arm]) leads[arm] = readLeads(arm)!;
  if (dry)
    log(
      `dry run: ${runs.length} run(s); leads files: ${JSON.stringify(present)}`,
    );
  const leadsVia = options.leadsVia ?? DEFAULT_LEADS_VIA;
  const commit = pinnedFullTestSnapshot(options.snapshot, dry, leadsVia);
  const searchSettings =
    options.searchSettings === undefined
      ? undefined
      : ((
          JSON.parse(readFileSync(options.searchSettings, "utf8")) as {
            search?: Record<string, unknown>;
          }
        ).search ??
        (JSON.parse(readFileSync(options.searchSettings, "utf8")) as Record<
          string,
          unknown
        >));
  if (!dry) {
    const spend = readFullTestSpend();
    writeFullTestSpend({
      ...spend,
      snapshotCommit: commit,
      invocations: [
        ...spend.invocations,
        {
          at: new Date().toISOString(),
          phases: options.phases ?? PHASE_IDS,
          pilot: options.pilot === true,
          kinds: options.kinds ?? null,
          only: options.only ?? null,
          stopInputTokens: null,
          leadsVia,
          note: "10.89: no token cap; the plan's usage limit stops the invocation",
        },
      ],
    });
  }
  const snap = await snapshot({ ...modeFor(PHASES[0]!, commit) });
  const home = homeDir();
  ensureDir(home);
  // A dry run calls no model, so it needs no sign-in.
  if (!dry) SOL.credential(home);
  // The default HOME (the pristine requests, C, U′ and, on the fallback path, every phase) holds
  // the search template only; a seam phase's HOME adds its leads source.
  writeHomeSettings(home, searchSettings, undefined);
  const ctx: RunContext = {
    snap,
    commit,
    home,
    leadsVia,
    searchSettings,
    proofSource: options.proofSource,
    leads,
    dry,
  };
  const stopWith = (reason: string, caseId: string, detail: string) => {
    if (!dry) {
      const spend = readFullTestSpend();
      writeFullTestSpend({
        ...spend,
        stops: [
          ...spend.stops,
          {
            at: new Date().toISOString(),
            by: "runner",
            reason,
            caseId,
            detail,
          },
        ],
      });
    }
    log(`stop (${reason}) at ${caseId}: ${detail}`);
    return { stopped: true, reason, caseId, detail };
  };
  let streak = null as { failure: string; count: number } | null;
  for (const planned of runs) {
    const outcome = await runOne(planned, ctx);
    if (outcome.kind === "stop")
      return stopWith(outcome.reason, planned.range.caseId, outcome.detail);
    if (outcome.kind === "skipped") continue;
    const { entry } = outcome;
    if (entry.usageLimit !== null)
      return stopWith("usage-limit", entry.caseId, entry.usageLimit);
    if (entry.failure === "understand-not-shared")
      return stopWith(
        "understand-not-shared",
        entry.caseId,
        `${entry.phase} computed its own Understand instead of reusing phase A's (FT5 rests on the shared Understand); the run is kept as incomplete`,
      );
    if (entry.failure === null) streak = null;
    else {
      streak =
        streak?.failure === entry.failure
          ? { failure: entry.failure, count: streak.count + 1 }
          : { failure: entry.failure, count: 1 };
      if (streak.count >= SYSTEMATIC_FAILURES)
        return stopWith(
          "systematic-failure",
          entry.caseId,
          `${streak.failure} on ${streak.count} runs in a row (FT14 rule 6)`,
        );
    }
    releaseRange(planned.range);
  }
  return { stopped: false, runs: runs.length };
};

/**
 * The job B's continuation drops before it requests again: B's own (on the seam path B requested
 * its own run, so the pristine request's job was already dropped in its clone), else the pristine
 * request's, which B ran on the BM25-key path.
 */
/** After a re-request, the job its generation runs under is the one the request queued. */
export const afterReRequest = (
  jobs: ReadonlyArray<string>,
  requested: { readonly job: string },
) => ({ job: requested.job, jobs: [...jobs, requested.job] });

export const jobToDrop = (
  stored: { readonly measurement?: { readonly job?: unknown } } | undefined,
  pristine: { readonly job: string },
) =>
  typeof stored?.measurement?.job === "string"
    ? stored.measurement.job
    : pristine.job;

/**
 * FT4's continuation of B, once its rule has fired (measures.ts `bContinuation`): in each range's
 * kept B store, B's held job is dropped and the range requested again as a new generation, which
 * reuses B's stored Understand and Investigate and has a fresh lifetime for Assemble and Dispose
 * alone; timeouts are re-requested up to twice. Stored as `B.continued.json.gz`, compared with A's
 * and C's final generations only.
 */
export const continueB = async (options: { readonly go: boolean }) => {
  const selection = readFullTestSelection();
  const ranges = planRanges(
    selection,
    readKnownCases(),
    readProofRanges(),
  ).filter((range) => range.phases.includes("B"));
  ensureDir(FULL_TEST_RESULTS);
  if (!bDecisionComplete())
    throw new Error(
      "FT4's rule for B is not decided on complete phases (b-continuation.json); B's clones are kept",
    );
  if (!options.go) {
    for (const range of ranges) releaseRange(range);
    return { continued: 0 };
  }
  const commit = pinnedFullTestSnapshot(undefined, false);
  const phase = PHASES.find((entry) => entry.id === "B")!;
  const snap = await snapshot(modeFor(phase, commit));
  const home = homeDir();
  SOL.credential(home);
  const full: Phase = { ...phase, stop: "full" };
  const mode = modeFor(full, commit);
  let continued = 0;
  for (const range of ranges) {
    const clone = cloneDir(range, "B");
    const pristine = pristineRecord(range);
    if (
      !existsSync(clone) ||
      pristine === undefined ||
      existsSync(storedFile(range.caseId, "B", ".continued"))
    )
      continue;
    await run(
      [
        ...cli(snap),
        "jobs",
        "drop",
        jobToDrop(readStored(range.caseId, "B"), pristine),
        "--repo",
        clone,
      ],
      {
        env: baseEnv(home),
        allowFailure: true,
      },
    );
    const rangeText = `${pristine.baseOid}..${pristine.headOid}`;
    // The same HOME as B's run, so the new generation's request has B's configuration and reuses
    // B's stored Understand and Investigate.
    const bHome =
      readStored<{ measurement?: { home?: string } }>(range.caseId, "B")
        ?.measurement?.home ?? home;
    const runIds: Array<string> = [];
    let shown: Record<string, unknown> = {};
    let worker: Awaited<ReturnType<typeof workerRun>> | undefined;
    for (let generation = 0; generation <= MAX_REREQUESTS; generation++) {
      await request(snap, clone, rangeText, routeArgs(), bHome);
      worker = await workerRun(snap, clone, bHome, 0, mode, laneFor(full), 0);
      runIds.push(worker.latestRunId ?? "");
      shown = await show(snap, clone, bHome, runIds.at(-1)!);
      if (
        worker.usageLimit !== null ||
        String(shown["outcome"] ?? "") !== "timed-out"
      )
        break;
    }
    // Final only when it completed, or still timed out after its two re-requests (as runOne
    // stores a phase's run); a usage-limited or stopped continuation is kept apart and run again.
    const outcome = String(shown["outcome"] ?? "no receipt");
    const whole =
      worker !== undefined &&
      worker.usageLimit === null &&
      !worker.stopped &&
      worker.live.calls > 0 &&
      (outcome === "completed" ||
        (outcome === "timed-out" && runIds.length > MAX_REREQUESTS));
    keepRunLogs(clone, storedFile(range.caseId, "B", ".continued.runlogs"));
    writeStored(
      storedFile(
        range.caseId,
        "B",
        whole ? ".continued" : ".continued.incomplete",
      ),
      {
        ...shown,
        measurement: {
          phase: "B",
          continued: true,
          runIds,
          cycleId: pristine.cycleId,
        },
      },
    );
    const spend = readFullTestSpend();
    writeFullTestSpend({
      ...spend,
      runs: [
        ...spend.runs,
        {
          phase: "B",
          caseId: range.caseId,
          kind: range.kind,
          order: range.order,
          route: SOL.name,
          runIds,
          gen0Outcome: "continuation",
          outcome: String(shown["outcome"] ?? "no receipt"),
          tokens: worker?.live.tokens ?? zero(),
          tokensByGeneration: [],
          tokensByStage: worker?.byStage ?? {},
          modelCalls: worker?.live.calls ?? 0,
          wallMs: null,
          understand: worker?.understand ?? "",
          stoppedByWatcher: worker?.stopped ?? false,
          usageLimit: worker?.usageLimit ?? null,
          stored: whole,
          failure: null,
          leads: "continuation of B (R(H1-E0))",
          at: new Date().toISOString(),
        },
      ],
    });
    if (!whole) {
      log(
        `B ${range.caseId}: continuation ended ${outcome}${worker?.usageLimit == null ? "" : ` at the usage limit (${worker.usageLimit})`}; kept apart, run again later`,
      );
      if (worker?.usageLimit != null) break;
      continue;
    }
    continued++;
    releaseRange(range);
  }
  return { continued };
};

/** The scratch folders' sizes, for the disk rule: what the full test holds on disk now. */
export const scratchUse = () => {
  const base = ftScratch();
  if (!existsSync(base)) return { bytes: 0 };
  const du = Bun.spawnSync(["du", "-sk", base]);
  return {
    bytes: Number(du.stdout.toString().split("\t")[0] ?? 0) * 1024,
    at: statSync(base).mtime.toISOString(),
  };
};
