import {
  accessSync,
  chmodSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { loadScoringInputs } from "../retrieval-bench/scoring-inputs.ts";
import {
  CANDIDATES,
  RESULTS,
  SLUG,
  ensureDir,
  root,
  runDir,
  type Candidate,
} from "./common.ts";
import type { SeedInput } from "./harness-side.ts";
import { readSelection } from "./select.ts";

/**
 * Steps 2–5: each chosen range through the harness at a pinned commit, once per lane. A lane is a
 * candidate's leads with the worker environment it runs in: the comparison's lanes are R(H3-E1)
 * and R(H3-E3); the 10.84 re-run's (sticky.ts) are R(H3-E1) with and without seeded leads.
 *
 * Isolation. The harness runs from a pinned snapshot of the repository at the mode's commit (`git
 * archive`, with the workspace's installed node_modules linked in), so another lane's edits to
 * packages/harness never reach a run. Each lane has its own scratch clone (a plain local
 * `git clone --no-checkout` of the M4 corpus, which never writes to it) and so its own Records store under the
 * clone's `.git/neuve`; HOME is a scratch folder, so no user settings, integrations or registry are
 * read or written (a route signed in through Neuve sees only its own credential folder, linked in).
 * The live `.git/neuve` store is never opened.
 *
 * Sharing Understand. The review is requested once, in the first clone, before any model call; the
 * other clones are copies of the first at that point, so all hold the same cycle, request and job.
 * Precompute's and Understand's computation keys depend only on the range, the cycle and the
 * configuration, never on the leads or Investigate, so after the first lane's run its Understand,
 * merge and scope-snapshot computations are copied into the next store (harness-side.ts `copy`) and
 * that run reuses them. Understand's task and tools never show leads, so its inputs are the same for
 * every lane. Precompute, the plan and Investigate are computed in each store from that store's
 * leads. Which lane goes first alternates with the run order.
 *
 * Spend. On a priced route, cost is the receipt's (usage times the route's frozen price table,
 * 10.32); before each run the total so far plus the mode's reserve must stay under the stop, and
 * during a run a watcher reads the run log's model calls and stops the worker when the total
 * reaches the stop (50 USD for the comparison, 10.81). Every run also records its tokens. A route
 * with no USD price (a plan sign-in, 10.85) has no USD stop; a run that hits the plan's usage limit
 * stops the invocation, and so does a run that made no model call at all (the route could not run).
 */

export const SNAPSHOT_COMMIT = "06f5cde9377372f2fd09ae01067c3f9ebd8319d2";
export const STOP_USD = 50;
const FIRST_RESERVE_USD = 5;
const WORKER_TIMEOUT_MS = 25 * 60_000;

/** USD per million tokens, as the run log's usage fields name them. */
export interface TokenPrice {
  readonly input: number;
  readonly cacheWrite5m: number;
  readonly cacheWrite1h: number;
  readonly cacheRead: number;
  readonly output: number;
}

/** The model route a mode's runs use, as the runner drives it. */
export interface RouteSpec {
  readonly name: string;
  /** Arguments to `neuve review` that choose the route; none for the harness's default route. */
  readonly requestArgs: ReadonlyArray<string>;
  /** The worker's credential: environment to add, after the scratch home is prepared. */
  readonly credential: (home: string) => Record<string, string>;
  /** The route's price table, or null when it has no USD price (cost is reported in tokens). */
  readonly price: TokenPrice | null;
}

/** The repository's configured Anthropic key, read from `.env.local`; never printed. */
const anthropicKey = () => {
  const text = readFileSync(join(root, ".env.local"), "utf8");
  const line = text
    .split("\n")
    .find((entry) => entry.startsWith("ANTHROPIC_API_KEY="));
  const value = line?.slice("ANTHROPIC_API_KEY=".length).trim();
  if (value === undefined || value === "")
    throw new Error("ANTHROPIC_API_KEY is not set in .env.local");
  return value.replace(/^["']|["']$/g, "");
};

/** Opus 5.5 on the Anthropic API key (2.12), at the route's frozen price table (10.32). */
export const OPUS: RouteSpec = {
  name: "opus",
  requestArgs: [],
  credential: () => ({ ANTHROPIC_API_KEY: anthropicKey() }),
  price: {
    input: 4,
    cacheWrite5m: 5,
    cacheWrite1h: 8,
    cacheRead: 0.2,
    output: 20,
  },
};

/** One lane of a mode: whose leads it is seeded with, and the worker environment it runs in. */
export interface Lane {
  /** File-system-safe; names the run file (`<slug>.json.gz`) and the scratch clone. */
  readonly slug: string;
  readonly candidate: Candidate;
  readonly env: Readonly<Record<string, string>>;
  /**
   * Extra `neuve review` arguments (a `--stub-*` setting, with NEUVE_DEV_STUBS=1) that make this
   * lane's request a run of its own; lanes without them share the first lane's request.
   */
  readonly requestArgs?: ReadonlyArray<string>;
}

/**
 * What one invocation runs: its lanes, at which harness snapshot and route, where its outputs go
 * and the spend stop. The comparison is the default; the 10.84 re-run (sticky.ts) is another mode
 * with its own results folder, spend file and scratch folders, so it never overwrites committed
 * outputs.
 */
export interface RunMode {
  readonly lanes: ReadonlyArray<Lane>;
  readonly snapshotCommit: string;
  readonly route: RouteSpec;
  /** The results root: spend.json and runs/<case>/ live here. */
  readonly results: string;
  /** The USD stop, or null for a route without a USD price. */
  readonly stopUsd: number | null;
  /** The spend a range's next run is assumed to need before it may start. */
  readonly reserveUsd: (
    caseId: string,
    spend: ReadonlyArray<SpendEntry>,
  ) => number;
  /** A suffix for the scratch folders (home, work), empty for the comparison. */
  readonly scratchSuffix: string;
  /** Stop each run once Investigate is done: the 10.84 score reads only the ledgers. */
  readonly stopAfterInvestigate?: boolean;
  /** Stop each run once Understand is done (the full test's U′, which measures only Understand). */
  readonly stopAfterUnderstand?: boolean;
  /**
   * The run must reuse a copied Understand (the full test's C, A′ and B): the worker is stopped as
   * soon as an Understand stage is computed instead, before it spends more.
   */
  readonly requireUnderstandReused?: boolean;
  /** A stop on input tokens (uncached, cache reads and writes) over every run of the mode. */
  readonly stopInputTokens?: number;
  /** `neuve review` arguments every lane's request carries (a `--stub-*` setting, for example). */
  readonly requestArgs?: ReadonlyArray<string>;
  /** The worker's timeout; 25 minutes when absent. */
  readonly workerTimeoutMs?: number;
  /** Link each package's node_modules into the snapshot instead of copying them. */
  readonly linkNodeModules?: boolean;
}

export const COMPARISON: RunMode = {
  lanes: CANDIDATES.map((candidate) => ({
    slug: SLUG[candidate],
    candidate,
    env: {},
  })),
  snapshotCommit: SNAPSHOT_COMMIT,
  route: OPUS,
  results: RESULTS,
  stopUsd: STOP_USD,
  reserveUsd: (_caseId, spend) =>
    spend.length === 0
      ? FIRST_RESERVE_USD
      : Math.max(...spend.map((entry) => entry.costUsd ?? 0)),
  scratchSuffix: "",
};

export const scratch = () => {
  const base = process.env["HARNESS_COMPARE_SCRATCH"];
  if (base === undefined || base === "")
    throw new Error(
      "HARNESS_COMPARE_SCRATCH must name a scratch folder outside the repository",
    );
  return resolve(base);
};

const spendFile = (mode: RunMode) => join(mode.results, "spend.json");

/** Tokens of a run's model calls, by the run log's usage fields. */
export interface Tokens {
  readonly input: number;
  readonly cacheWrite5m: number;
  readonly cacheWrite1h: number;
  readonly cacheRead: number;
  readonly output: number;
}

export interface SpendEntry {
  readonly caseId: string;
  readonly candidate: Candidate;
  /** The lane; absent in the comparison's spend file, where the candidate names it. */
  readonly lane?: string;
  readonly route?: string;
  readonly order: number;
  /** Null on a route without a USD price. */
  readonly costUsd: number | null;
  /** Absent in the comparison's spend file, which predates it. */
  readonly tokens?: Tokens;
  readonly modelCalls: number;
  readonly outcome: string;
  readonly understand: string;
  readonly wallMs: number | null;
  readonly at: string;
  readonly stoppedByWatcher: boolean;
  /** The first run-log or worker-log line that names the plan's usage limit, if any. */
  readonly usageLimit?: string | null;
  /** Whether the run was whole and stored as the lane's run (absent in the comparison's file). */
  readonly stored?: boolean;
  /** Set when a later attempt at the range moved this run's file aside (runs/<case>/superseded/). */
  readonly superseded?: boolean;
  /** Tokens by pipeline stage, from the run logs' model calls. */
  readonly tokensByStage?: Readonly<Record<string, Tokens>>;
}

export const readSpend = (mode: RunMode = COMPARISON): Array<SpendEntry> =>
  existsSync(spendFile(mode))
    ? (JSON.parse(readFileSync(spendFile(mode), "utf8"))
        .runs as Array<SpendEntry>)
    : [];

const sumTokens = (runs: ReadonlyArray<SpendEntry>): Tokens => {
  const total = {
    input: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0,
    output: 0,
  };
  for (const run of runs)
    for (const key of Object.keys(total) as Array<keyof Tokens>)
      total[key] += run.tokens?.[key] ?? 0;
  return total;
};

/** How an invocation ended before its last range: by a runner stop, or by hand. */
export interface StopRecord {
  readonly at: string;
  readonly by: "runner" | "manual";
  readonly reason: string;
  readonly caseId?: string | undefined;
  readonly detail?: string | undefined;
}

const readStops = (mode: RunMode): Array<StopRecord> =>
  existsSync(spendFile(mode))
    ? ((JSON.parse(readFileSync(spendFile(mode), "utf8")).stops ??
        []) as Array<StopRecord>)
    : [];

/** One invocation of the runner, with the budget it ran under. */
export interface InvocationRecord {
  readonly at: string;
  readonly from: number;
  readonly to: number;
  readonly stopUsd: number | null;
  /** Null when the invocation ran without an input-token stop. */
  readonly stopInputTokens: number | null;
  readonly note?: string | undefined;
}

const readInvocations = (mode: RunMode): Array<InvocationRecord> =>
  existsSync(spendFile(mode))
    ? ((JSON.parse(readFileSync(spendFile(mode), "utf8")).invocations ??
        []) as Array<InvocationRecord>)
    : [];

const writeSpend = (
  mode: RunMode,
  runs: ReadonlyArray<SpendEntry>,
  stops: ReadonlyArray<StopRecord> = readStops(mode),
  invocations: ReadonlyArray<InvocationRecord> = readInvocations(mode),
) => {
  const priced = mode.route.price !== null;
  const total = runs.reduce((sum, run) => sum + (run.costUsd ?? 0), 0);
  writeFileSync(
    spendFile(mode),
    `${JSON.stringify(
      {
        note: priced
          ? "Measured: each run's receipt cost (usage times the route's frozen price table) and its tokens. The total is the API spend of these runs."
          : "Measured: each run's tokens from its run log. The route has no USD price (a plan sign-in), so cost is reported in tokens only.",
        route: mode.route.name,
        snapshotCommit: mode.snapshotCommit,
        stopUsd: mode.stopUsd,
        totalUsd: priced ? Number(total.toFixed(4)) : null,
        totalTokens: sumTokens(runs),
        invocations,
        stops,
        runs,
      },
      null,
      2,
    )}\n`,
  );
};

export const log = (line: string) =>
  console.error(`${new Date().toISOString()} ${line}`);

/** Records how an invocation stopped, beside its runs in spend.json. */
export const recordStop = (mode: RunMode, stop: StopRecord) =>
  writeSpend(mode, readSpend(mode), [...readStops(mode), stop]);

export const baseEnv = (home: string) => {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && name !== "ANTHROPIC_API_KEY") env[name] = value;
  env["HOME"] = home;
  env["GIT_CONFIG_GLOBAL"] = "/dev/null";
  env["GIT_CONFIG_NOSYSTEM"] = "1";
  return env;
};

export const run = async (
  command: ReadonlyArray<string>,
  options: {
    readonly env: Record<string, string>;
    readonly cwd?: string;
    readonly allowFailure?: boolean;
  },
) => {
  const child = Bun.spawn([...command], {
    env: options.env,
    cwd: options.cwd ?? scratch(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0 && options.allowFailure !== true)
    throw new Error(
      `${command.slice(0, 4).join(" ")} exited ${code}: ${stderr.slice(-2_000)}`,
    );
  return { stdout, stderr, code };
};

/**
 * A package's node_modules for the snapshot, as a real folder that copies no package (the owner's
 * disk rule): every entry is a link, and a link into the workspace (a `@neuve/*` package) points at
 * the snapshot's copy of that package, so a run never executes the working tree; every other entry
 * points, absolutely, at its target in the shared store. Scope folders (`@effect`, `@neuve`) are
 * recreated one level down the same way.
 */
export const linkModules = (source: string, target: string, snap: string) => {
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(source)) {
    const from = join(source, name);
    const to = join(target, name);
    const stat = lstatSync(from);
    if (stat.isSymbolicLink()) {
      const resolved = resolve(dirname(from), readlinkSync(from));
      const inWorkspace =
        resolved.startsWith(`${root}/`) &&
        !resolved.startsWith(`${join(root, "node_modules")}/`) &&
        !resolved.includes("/node_modules/");
      symlinkSync(
        inWorkspace ? join(snap, resolved.slice(root.length + 1)) : resolved,
        to,
      );
    } else if (stat.isDirectory() && name.startsWith("@"))
      linkModules(from, to, snap);
    else symlinkSync(from, to);
  }
};

/**
 * Refuses a snapshot whose CLI would load a workspace package from outside it: `@neuve/harness`,
 * records-core and records-schema must resolve inside the snapshot from the packages that import
 * them. Checked before any model call.
 */
export const assertPinned = (snap: string) => {
  const probes: ReadonlyArray<readonly [string, string]> = [
    ["@neuve/harness", "apps/neuve-cli/src"],
    ["@neuve/records-core", "apps/neuve-cli/src"],
    ["@neuve/records-core", "packages/harness/src"],
    ["@neuve/records-schema", "packages/harness/src"],
    ["@neuve/records-schema", "packages/records-core/src"],
  ];
  const real = realpathSync(snap);
  for (const [name, from] of probes) {
    if (!existsSync(join(snap, from))) continue;
    const at = realpathSync(Bun.resolveSync(name, join(snap, from)));
    if (!at.startsWith(`${real}/`))
      throw new Error(
        `the snapshot is not pinned: ${name} from ${from} resolves to ${at}, outside ${snap}; remove the snapshot folder and run again`,
      );
  }
};

/** The pinned harness snapshot: the mode's commit's packages and CLI, with this folder synced in. */
export const snapshot = async (mode: RunMode) => {
  const snap = join(
    scratch(),
    mode.snapshotCommit === SNAPSHOT_COMMIT
      ? "snap"
      : `snap-${mode.snapshotCommit.slice(0, 12)}`,
  );
  if (!existsSync(join(snap, "package.json"))) {
    mkdirSync(snap, { recursive: true });
    const archive = Bun.spawn(
      [
        "git",
        "-C",
        root,
        "archive",
        mode.snapshotCommit,
        "apps/neuve-cli",
        "packages",
        // The review skills Dispose and Assemble read as text (dispose.ts), at the same commit.
        ".agents",
        "package.json",
        "tsconfig.json",
        "tsconfig.base.json",
        "bun.lock",
        "bunfig.toml",
      ],
      { stdout: "pipe" },
    );
    const tar = Bun.spawn(["tar", "-x", "-C", snap], { stdin: archive.stdout });
    if ((await tar.exited) !== 0 || (await archive.exited) !== 0)
      throw new Error("git archive of the snapshot failed");
    Bun.spawnSync(["ln", "-s", join(root, "node_modules"), "node_modules"], {
      cwd: snap,
    });
    for (const dir of [
      "apps/neuve-cli",
      ...readdirSync(join(root, "packages")).map((name) => `packages/${name}`),
    ])
      if (
        existsSync(join(root, dir, "node_modules")) &&
        existsSync(join(snap, dir))
      )
        if (mode.linkNodeModules === true)
          linkModules(
            join(root, dir, "node_modules"),
            join(snap, dir, "node_modules"),
            snap,
          );
        else
          Bun.spawnSync(
            ["cp", "-R", join(root, dir, "node_modules"), join(snap, dir)],
            { stdout: "ignore" },
          );
  }
  assertPinned(snap);
  // Only this comparison's own files are synced in; the harness and every other package stay at
  // the snapshot commit.
  const target = join(snap, "packages/evaluation/src/harness-compare");
  rmSync(target, { recursive: true, force: true });
  cpSync(import.meta.dir, target, { recursive: true });
  return snap;
};

export const cli = (snap: string) => [
  process.execPath,
  join(snap, "apps/neuve-cli/src/cli.ts"),
];

/** Every input token of a run: uncached, written to and read from the cache. */
export const inputTokens = (tokens: Tokens | undefined) =>
  tokens === undefined
    ? 0
    : tokens.input +
      tokens.cacheWrite5m +
      tokens.cacheWrite1h +
      tokens.cacheRead;

/** A clone's run logs: one per generation of its run (a timed-out run retries as a new one, 10.42). */
export const runLogsOf = (clone: string) => {
  const directory = join(clone, ".git/neuve/run-logs");
  return existsSync(directory)
    ? readdirSync(directory)
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => join(directory, name))
    : [];
};

export const recordsOf = (paths: ReadonlyArray<string>) =>
  paths.flatMap((path) =>
    readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line) => {
        if (line === "") return [];
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      }),
  );

/** The run logs' model calls so far: their count, tokens, and cost at the route's price, if any. */
export const liveUsage = (
  paths: ReadonlyArray<string>,
  price: TokenPrice | null,
) => {
  const tokens = {
    input: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0,
    output: 0,
  };
  let calls = 0;
  for (const record of recordsOf(paths)) {
    if (record["type"] !== "model.call") continue;
    const u = (record["usage"] ?? {}) as Record<string, number | undefined>;
    calls++;
    for (const key of Object.keys(tokens) as Array<keyof Tokens>)
      tokens[key] += u[key] ?? 0;
  }
  const usd =
    price === null
      ? null
      : (Object.keys(tokens) as Array<keyof Tokens>).reduce(
          (sum, key) => sum + tokens[key] * price[key],
          0,
        ) / 1_000_000;
  return { usd, calls, tokens };
};

/**
 * Whether Investigate is done in the run logs: every partition of the latest plan has a stage
 * record that computed or reused its ledger. An interrupted partition (the run's cut-off) is not
 * done; the run's next generation resumes it.
 */
export const investigateDone = (
  records: ReadonlyArray<Record<string, unknown>>,
) => {
  const plan = records
    .filter((record) => record["type"] === "investigate.plan")
    .at(-1) as { partitions?: ReadonlyArray<{ id: string }> } | undefined;
  if (plan?.partitions === undefined || plan.partitions.length === 0)
    return false;
  const done = new Set(
    records
      .filter(
        (record) =>
          record["type"] === "stage" &&
          record["stage"] === "investigate" &&
          (record["status"] === "computed" || record["status"] === "reused"),
      )
      .map((record) => String(record["agent"])),
  );
  return plan.partitions.every((partition) =>
    done.has(`investigate.${partition.id}`),
  );
};

/**
 * Whether Understand is done in the run logs: the partition plan is recorded. The plan is code over
 * Understand's stored change map (pipeline.ts), computed just before Investigate starts and never
 * delayed by a stub hold, so it exists exactly when the change map does.
 */
export const understandDone = (
  records: ReadonlyArray<Record<string, unknown>>,
) => records.some((record) => record["type"] === "investigate.plan");

/**
 * Understand's code steps: stage records under `understand` that are not its agents. The change
 * map is code over the agents' stored output and is computed in every run, shared or not.
 */
export const UNDERSTAND_CODE_STEPS: ReadonlySet<string> = new Set([
  "understand.change-map",
]);

/**
 * Whether any of Understand's agents (its partitions, `understand` or `understand.<part>`, and
 * `understand.merge`) computed its output in this run, rather than reusing a stored one.
 */
export const understandComputed = (
  records: ReadonlyArray<Record<string, unknown>>,
) =>
  records.some(
    (record) =>
      record["type"] === "stage" &&
      record["stage"] === "understand" &&
      record["status"] === "computed" &&
      !UNDERSTAND_CODE_STEPS.has(String(record["agent"])),
  );

/**
 * The first line of the run log or the worker's output naming the plan's usage limit by its typed
 * failure, cut to 300 characters; null when none does. The OpenAI route (openai-route.ts) maps the
 * provider's `subscription_sharing_usage_limit_exceeded` to effect/ai's non-retryable
 * `QuotaExhaustedError`, and a stage that fails on it names that tag or the provider's code. Only
 * those two names match, never free text. The run log holds no prompt or source text (10.16).
 */
export const usageLimitLine = (texts: ReadonlyArray<string>) => {
  const pattern =
    /QuotaExhaustedError|subscription_sharing_usage_limit_exceeded/;
  for (const text of texts)
    for (const line of text.split("\n"))
      if (pattern.test(line)) return line.slice(0, 300);
  return null;
};

/**
 * One lane's worker run, stopped early when the spend would cross the stop, when a plan route hits
 * its usage limit, at the timeout, or (in a mode that measures Investigate only) once every
 * Investigate partition is done, so no quota is spent on stages the score does not read.
 */
export const workerRun = async (
  snap: string,
  clone: string,
  home: string,
  spentBefore: number,
  mode: RunMode,
  lane: Lane,
  inputBefore = 0,
) => {
  const env = {
    ...baseEnv(home),
    ...mode.route.credential(home),
    ...lane.env,
  };
  const child = Bun.spawn(
    [...cli(snap), "worker", "run", "--repo", clone, "--idle-seconds", "15"],
    { env, cwd: scratch(), stdout: "pipe", stderr: "pipe" },
  );
  let stopped = false;
  let finishedInvestigate = false;
  let finishedUnderstand = false;
  let understandRecomputed = false;
  let usageLimit: string | null = null;
  const started = Date.now();
  const timeout = mode.workerTimeoutMs ?? WORKER_TIMEOUT_MS;
  const stop = (why: string) => {
    log(why);
    child.kill("SIGTERM");
  };
  const watch = setInterval(() => {
    if (stopped || finishedInvestigate || finishedUnderstand) return;
    const logs = runLogsOf(clone);
    const live = liveUsage(logs, mode.route.price);
    if (
      mode.stopUsd !== null &&
      live.usd !== null &&
      spentBefore + live.usd >= mode.stopUsd
    ) {
      stopped = true;
      stop(
        `spend reached ${(spentBefore + live.usd).toFixed(2)} USD: stopping the worker (${mode.stopUsd} USD stop)`,
      );
      return;
    }
    if (
      mode.stopInputTokens !== undefined &&
      inputBefore + inputTokens(live.tokens) >= mode.stopInputTokens
    ) {
      stopped = true;
      stop(
        `input tokens reached ${(inputBefore + inputTokens(live.tokens)).toLocaleString("en")}: stopping the worker (${mode.stopInputTokens.toLocaleString("en")} stop)`,
      );
      return;
    }
    // Only a plan route has a usage limit to stop at; a priced route's spend stop does that job.
    if (mode.route.price === null) {
      usageLimit = usageLimitLine(
        logs.map((path) => readFileSync(path, "utf8")),
      );
      if (usageLimit !== null) {
        stopped = true;
        stop(`usage limit: stopping the worker at once (${usageLimit})`);
        return;
      }
    }
    if (
      mode.stopAfterInvestigate === true &&
      investigateDone(recordsOf(logs))
    ) {
      finishedInvestigate = true;
      stop(
        "Investigate is done in every partition: stopping the worker before Assemble",
      );
      return;
    }
    if (
      mode.requireUnderstandReused === true &&
      understandComputed(recordsOf(logs))
    ) {
      stopped = true;
      understandRecomputed = true;
      stop(
        "Understand was computed, not reused from the copied store: stopping the worker",
      );
      return;
    }
    if (mode.stopAfterUnderstand === true && understandDone(recordsOf(logs))) {
      finishedUnderstand = true;
      stop(
        "Understand is done (the partition plan over its change map is stored): stopping the worker before Investigate",
      );
      return;
    }
    if (Date.now() - started > timeout) {
      stopped = true;
      stop("worker exceeded its timeout; stopping it");
    }
  }, 3_000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearInterval(watch);
  writeFileSync(
    join(clone, "..", `worker-${clone.split("/").at(-1)}.log`),
    `${stdout}\n${stderr}`,
  );
  const logs = runLogsOf(clone);
  if (mode.route.price === null && usageLimit === null)
    usageLimit = usageLimitLine([
      ...logs.map((path) => readFileSync(path, "utf8")),
      stderr,
      stdout,
    ]);
  // The latest generation's run: a timed-out run's retry has a run ID of its own.
  const latest = logs
    .map((path) => ({ path, at: statSync(path).mtimeMs }))
    .sort((a, b) => b.at - a.at)[0]?.path;
  const records = recordsOf(logs);
  const byStage: Record<string, Tokens> = {};
  for (const record of records) {
    if (record["type"] !== "model.call") continue;
    const u = (record["usage"] ?? {}) as Record<string, number | undefined>;
    const stage = String(record["stage"] ?? "unknown");
    const held = (byStage[stage] ??= {
      input: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: 0,
      output: 0,
    }) as Record<keyof Tokens, number>;
    for (const key of Object.keys(held) as Array<keyof Tokens>)
      held[key] += u[key] ?? 0;
  }
  return {
    code,
    stopped,
    // Each Understand agent's stage status: "reused" where this lane took the first lane's.
    understand: records
      .filter(
        (record) =>
          record["type"] === "stage" && record["stage"] === "understand",
      )
      .map((record) => `${String(record["agent"])}:${String(record["status"])}`)
      .join(","),
    byStage,
    finishedInvestigate:
      finishedInvestigate || investigateDone(recordsOf(logs)),
    finishedUnderstand: finishedUnderstand || understandDone(records),
    understandRecomputed: understandRecomputed || understandComputed(records),
    live: liveUsage(logs, mode.route.price),
    usageLimit,
    latestRunId:
      latest === undefined
        ? undefined
        : latest
            .split("/")
            .at(-1)!
            .replace(/\.jsonl$/, ""),
  };
};

/**
 * A range's first clone: a plain local clone, which hardlinks the source's objects on the same
 * filesystem and has no alternates, which the Graph engine's check in `neuve setup` refuses.
 */
export const cloneRange = (
  source: string,
  clone: string,
  env: Record<string, string>,
) => run(["git", "clone", "--quiet", "--no-checkout", source, clone], { env });

export const ensureCommit = async (
  clone: string,
  source: string,
  sha: string,
  env: Record<string, string>,
) => {
  const has = await run(
    ["git", "-C", clone, "cat-file", "-e", `${sha}^{commit}`],
    {
      env,
      allowFailure: true,
    },
  );
  if (has.code === 0) return;
  await run(["git", "-C", clone, "fetch", "--quiet", source, sha], { env });
};

const seedInput = (
  inputs: Awaited<ReturnType<typeof loadScoringInputs>>,
  caseId: string,
  candidate: Candidate,
): SeedInput => {
  const entry = inputs.cases.find((item) => item.id === caseId)!;
  const pool = inputs.pools.get(candidate);
  if (pool === undefined) throw new Error(`no frozen pool for ${candidate}`);
  return {
    candidate,
    base: entry.base,
    head: entry.head,
    hunks: entry.hunks.map((hunk) => {
      const row = pool.get(hunk.id);
      if (row === undefined)
        throw new Error(`${candidate} has no frozen ranking for ${hunk.id}`);
      return {
        hunkId: hunk.id,
        path: hunk.path,
        oldPath: hunk.oldPath,
        old: hunk.old,
        new: hunk.new,
        queryText: inputs.queries.get(hunk.id)?.text ?? "",
        regions: row.regions.slice(0, 10),
      };
    }),
  };
};

export const show = async (
  snap: string,
  clone: string,
  home: string,
  runId: string,
) => {
  const shown = await run(
    [...cli(snap), "review", "show", "--run", runId, "--json", "--repo", clone],
    { env: baseEnv(home) },
  );
  return JSON.parse(shown.stdout) as Record<string, unknown>;
};

/**
 * The variables that hand Neuve a sign-in besides the config folder: a sign-in folder, or a program
 * that leases access tokens (the cloud's machines, 10.131).
 */
const SIGN_IN_VARIABLES = [
  "NEUVE_OPENAI_AUTH_DIR",
  "NEUVE_OPENAI_TOKEN_COMMAND",
] as const;

/**
 * The request's environment, with no sign-in visible: an empty config folder for openai-auth.ts and
 * neither sign-in variable, so the request only queues the job and never starts a worker of its own.
 */
export const requestEnv = (home: string, stubs: boolean) => {
  const env: Record<string, string> = {
    ...baseEnv(home),
    ...(stubs ? { NEUVE_DEV_STUBS: "1" } : {}),
    XDG_CONFIG_HOME: join(home, "..", "request-config"),
  };
  for (const name of SIGN_IN_VARIABLES) delete env[name];
  return env;
};

/**
 * Sets a new clone up before its first review request, on the builds that need it. A build that
 * refuses to review a repository never set up is a build that also offers `neuve doctor`, so the
 * clone is set up exactly on those builds; an older build has no doctor, and its setup wrote a
 * folder into the working tree, so it is never set up. `--no-skills` only where setup lists it, so
 * setup never asks about skills. Setup indexes nothing and needs no credential. Returns whether it
 * ran; a failed setup throws with its exit code only.
 *
 * Setup records the `neuve` it was run as and checks it answers `--version` as Neuve. Run from
 * source, that would be Bun, so setup is handed the snapshot's own executable (`snapCli`). It also
 * records the Graph engine (`graphEngine`): beside Bun there is none to discover.
 */
export const setUp = async (snap: string, clone: string, home: string) => {
  const env = requestEnv(home, false);
  const doctor = await run([...cli(snap), "doctor", "--help"], {
    env,
    allowFailure: true,
  });
  if (doctor.code !== 0) return false;
  const help = await run([...cli(snap), "setup", "--help"], {
    env,
    allowFailure: true,
  });
  const lists = (flag: string) => `${help.stdout}${help.stderr}`.includes(flag);
  const engine = graphEngine(snap);
  const done = await run(
    [
      ...cli(snap),
      "setup",
      "--repo",
      clone,
      ...(lists("--cli-binary") ? ["--cli-binary", snapCli(snap)] : []),
      ...(lists("--graph-binary") ? ["--graph-binary", engine] : []),
      ...(lists("--no-skills") ? ["--no-skills"] : []),
    ],
    { env: { ...env, NEUVE_GRAPH_BINARY: engine }, allowFailure: true },
  );
  if (done.code !== 0) throw new Error(`neuve setup exited ${done.code}`);
  return true;
};

/**
 * An executable `neuve` for the snapshot, in the snapshot's folder (the runner's own, outside the
 * repository): it runs the snapshot's CLI with this Bun, so it answers `--version` as Neuve.
 */
export const snapCli = (snap: string) => {
  const path = join(snap, "bin", "neuve");
  const quoted = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;
  const script = `#!/bin/sh\nexec ${quoted(process.execPath)} ${quoted(join(snap, "apps/neuve-cli/src/cli.ts"))} "$@"\n`;
  if (!existsSync(path) || readFileSync(path, "utf8") !== script) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, script);
  }
  chmodSync(path, 0o755);
  return path;
};

const isExecutable = (path: string) => {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * The Graph engine setup records: NEUVE_GRAPH_BINARY when the operator names one (the workers
 * inherit it the same way), else the engine where the snapshot's harness looks for it from source,
 * else the workspace's own build.
 */
export const graphEngine = (snap: string) => {
  const named = process.env["NEUVE_GRAPH_BINARY"];
  if (named !== undefined && named !== "") return named;
  const found = [
    join(snap, "apps/neuve-graph/entire-graph"),
    join(root, "apps/neuve-graph/entire-graph"),
  ].find(isExecutable);
  if (found === undefined)
    throw new Error(
      "no Graph engine for neuve setup: build apps/neuve-graph or set NEUVE_GRAPH_BINARY",
    );
  return found;
};

/** Requests the range's review in a clone, with no credential in the environment: no model call. */
export const request = async (
  snap: string,
  clone: string,
  range: string,
  args: ReadonlyArray<string>,
  home: string,
) => {
  const stubs = args.some((arg) => arg.startsWith("--stub-"));
  const requested = await run(
    [...cli(snap), "review", range, ...args, "--repo", clone, "--detach"],
    // The runner's worker runs the job.
    { env: requestEnv(home, stubs) },
  );
  const runId = /run ([0-9A-Z]{26})/.exec(requested.stdout)?.[1];
  const job = /job (\d+) review\.run/.exec(requested.stdout)?.[1];
  if (runId === undefined || job === undefined)
    throw new Error(
      `no run ID or job in the request's output: ${requested.stdout}`,
    );
  return { runId, job, text: requested.stdout };
};

/** Whether every lane of a range has a whole run stored: the range is done. */
export const rangeStored = (out: string, lanes: ReadonlyArray<Lane>) =>
  lanes.every((lane) => existsSync(join(out, `${lane.slug}.json.gz`)));

/**
 * Starts a range's attempt. Each attempt opens its own cycle and shares one Understand across its
 * lanes, so a lane file from an earlier attempt must never be paired with this one's: every lane's
 * whole and incomplete file is moved to `superseded/<stamp>/` (kept for inspection, never read by
 * the scorer). Returns the files moved.
 */
export const startAttempt = (
  out: string,
  lanes: ReadonlyArray<Lane>,
  stamp: string,
) => {
  const moved: Array<string> = [];
  for (const lane of lanes)
    for (const name of [
      `${lane.slug}.json.gz`,
      `${lane.slug}.incomplete.json.gz`,
    ]) {
      if (!existsSync(join(out, name))) continue;
      const aside = join(out, "superseded", stamp);
      mkdirSync(aside, { recursive: true });
      renameSync(join(out, name), join(aside, name));
      moved.push(name);
    }
  return moved;
};

/** Steps 2–5 for the chosen ranges in run order, from `from` (1-based) up to `to`. */
export const runRanges = async (options: {
  readonly from: number;
  readonly to: number;
  /** Prepare clones, request and leads only; no worker, no model call. */
  readonly dry?: boolean;
  readonly mode?: RunMode;
}) => {
  const mode = options.mode ?? COMPARISON;
  // Each real invocation records the budget it ran under, beside the runs it adds.
  if (options.dry !== true) {
    ensureDir(mode.results);
    writeSpend(mode, readSpend(mode), readStops(mode), [
      ...readInvocations(mode),
      {
        at: new Date().toISOString(),
        from: options.from,
        to: options.to,
        stopUsd: mode.stopUsd,
        stopInputTokens: mode.stopInputTokens ?? null,
      },
    ]);
  }
  const total = () =>
    readSpend(mode).reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0);
  /** Ends the invocation early, and records why in spend.json. */
  const stopWith = (reason: string, caseId: string, detail?: string) => {
    if (options.dry !== true)
      recordStop(mode, {
        at: new Date().toISOString(),
        by: "runner",
        reason,
        caseId,
        detail,
      });
    return {
      stopped: true,
      reason,
      ...(detail === undefined ? {} : { detail }),
      total: total(),
    };
  };
  const selection = await readSelection();
  const inputs = await loadScoringInputs();
  const snap = await snapshot(mode);
  const home = join(scratch(), `home${mode.scratchSuffix}`);
  ensureDir(home);
  ensureDir(mode.results);
  for (const chosen of selection.selected) {
    if (chosen.order < options.from || chosen.order > options.to) continue;
    const out = runDir(chosen.caseId, mode.results);
    ensureDir(out);
    const order: ReadonlyArray<Lane> =
      chosen.order % 2 === 1 ? mode.lanes : [...mode.lanes].reverse();
    if (rangeStored(out, order)) {
      log(`${chosen.caseId}: every lane already stored; skipped`);
      continue;
    }
    if (options.dry !== true) {
      const moved = startAttempt(
        out,
        order,
        new Date().toISOString().replace(/[:.]/g, "-"),
      );
      if (moved.length > 0) {
        log(
          `${chosen.caseId}: a new attempt; moved the earlier attempt's ${moved.join(", ")} to superseded/`,
        );
        writeSpend(
          mode,
          readSpend(mode).map((entry) =>
            entry.caseId === chosen.caseId
              ? { ...entry, superseded: true }
              : entry,
          ),
        );
      }
    }
    // Short paths: the worker socket sits beside the store only while its path fits in sun_path.
    const work = join(
      scratch(),
      `w${mode.scratchSuffix}`,
      String(chosen.order),
    );
    rmSync(work, { recursive: true, force: true });
    ensureDir(work);
    const env = baseEnv(home);
    const source = inputs.deepInputs(() => {}).repositories[
      chosen.repository as "neuve" | "neuve_effect"
    ];
    const first = order[0]!;
    const cloneOf = (lane: Lane) => join(work, lane.slug);
    log(`${chosen.order}. ${chosen.caseId}: cloning; ${first.slug} runs first`);
    await cloneRange(source, cloneOf(first), env);
    await ensureCommit(cloneOf(first), source, chosen.base, env);
    await ensureCommit(cloneOf(first), source, chosen.head, env);
    await setUp(snap, cloneOf(first), home);
    // The first lane's request opens the cycle and queues its job. The other lanes' clones are
    // copies made then, so they share the cycle; a lane with request arguments of its own requests
    // its own run in its copy (joining that cycle) and drops the first lane's job there.
    const range = `${chosen.base}..${chosen.head}`;
    const argsOf = (lane: Lane) => [
      ...mode.route.requestArgs,
      ...(mode.requestArgs ?? []),
      ...(lane.requestArgs ?? []),
    ];
    const firstRequest = await request(
      snap,
      cloneOf(first),
      range,
      argsOf(first),
      home,
    );
    writeFileSync(join(out, "request.txt"), firstRequest.text);
    const cycleId = /(?:opened|joined) cycle ([0-9A-Z]{26})/.exec(
      firstRequest.text,
    )?.[1];
    const runIds = new Map<string, string>([[first.slug, firstRequest.runId]]);
    for (const other of order.slice(1)) {
      cpSync(cloneOf(first), cloneOf(other), { recursive: true });
      // The copy is a clone of its own, at its own path, and a later generation requests in it.
      await setUp(snap, cloneOf(other), home);
      if (JSON.stringify(argsOf(other)) === JSON.stringify(argsOf(first))) {
        runIds.set(other.slug, firstRequest.runId);
        continue;
      }
      const own = await request(
        snap,
        cloneOf(other),
        range,
        argsOf(other),
        home,
      );
      if (!/joined cycle/.test(own.text))
        throw new Error(
          `${other.slug}'s request did not join the first lane's cycle: ${own.text}`,
        );
      writeFileSync(join(out, `request-${other.slug}.txt`), own.text);
      await run(
        [
          ...cli(snap),
          "jobs",
          "drop",
          firstRequest.job,
          "--repo",
          cloneOf(other),
        ],
        { env },
      );
      runIds.set(other.slug, own.runId);
    }
    for (const lane of order) {
      const inputFile = join(work, `seed-${lane.slug}.json`);
      writeFileSync(
        inputFile,
        JSON.stringify(seedInput(inputs, chosen.caseId, lane.candidate)),
      );
      await run(
        [
          process.execPath,
          join(snap, "packages/evaluation/src/harness-compare/harness-side.ts"),
          "seed",
          "--repo",
          cloneOf(lane),
          "--input",
          inputFile,
          "--out",
          join(out, `seed-${lane.slug}.json`),
        ],
        { env },
      );
    }
    if (options.dry === true) {
      log(`${chosen.caseId}: prepared (dry run, no worker)`);
      continue;
    }
    for (const [index, lane] of order.entries()) {
      const spend = readSpend(mode);
      const spent = total();
      const inputSoFar = spend.reduce(
        (sum, entry) => sum + inputTokens(entry.tokens),
        0,
      );
      if (
        mode.stopInputTokens !== undefined &&
        inputSoFar >= mode.stopInputTokens
      ) {
        log(
          `stop: ${inputSoFar.toLocaleString("en")} input tokens spent, at the ${mode.stopInputTokens.toLocaleString("en")} stop`,
        );
        return stopWith(
          "input-tokens",
          chosen.caseId,
          `${inputSoFar} input tokens spent, at the ${mode.stopInputTokens} stop`,
        );
      }
      if (mode.stopUsd !== null) {
        const reserve = mode.reserveUsd(chosen.caseId, spend);
        if (spent + reserve >= mode.stopUsd) {
          log(
            `stop: ${spent.toFixed(2)} USD spent, the next run could cross ${mode.stopUsd} USD (reserve ${reserve.toFixed(2)})`,
          );
          return stopWith(
            "spend",
            chosen.caseId,
            `${spent.toFixed(2)} USD spent, reserve ${reserve.toFixed(2)}`,
          );
        }
      }
      if (index > 0) {
        await run(
          [
            process.execPath,
            join(
              snap,
              "packages/evaluation/src/harness-compare/harness-side.ts",
            ),
            "copy",
            "--from",
            cloneOf(first),
            "--to",
            cloneOf(lane),
            "--out",
            join(out, `copied-into-${lane.slug}.json`),
          ],
          { env },
        );
      }
      log(
        `${chosen.caseId}: ${lane.slug} worker started on ${mode.route.name}${mode.route.price === null ? "" : ` (spent so far ${spent.toFixed(2)} USD)`}`,
      );
      const runId = runIds.get(lane.slug)!;
      let worker = await workerRun(
        snap,
        cloneOf(lane),
        home,
        spent,
        mode,
        lane,
        inputSoFar,
      );
      // A run that reached its cut-off before Investigate was done is requested again: the new
      // generation reuses every stored stage (10.42). At most three more generations.
      for (
        let generation = 1;
        mode.stopAfterInvestigate === true &&
        !worker.finishedInvestigate &&
        !worker.stopped &&
        worker.usageLimit === null &&
        worker.live.calls > 0 &&
        generation <= 3;
        generation++
      ) {
        log(
          `${chosen.caseId}: ${lane.slug} ended before Investigate was done; requesting a new generation (${generation} of at most 3)`,
        );
        await request(snap, cloneOf(lane), range, argsOf(lane), home);
        worker = await workerRun(
          snap,
          cloneOf(lane),
          home,
          spent,
          mode,
          lane,
          inputSoFar,
        );
      }
      const shownRun = worker.latestRunId ?? runId;
      const shown: Record<string, unknown> = {
        ...(await show(snap, cloneOf(lane), home, shownRun)),
        // What the runner saw, beside what Records shows: the cycle the lanes share, and whether
        // the run was stopped once Investigate was done (it then has no receipt).
        measurement: {
          cycleId,
          requestedRun: runId,
          shownRun,
          stoppedAfterInvestigate: worker.finishedInvestigate,
          understand: worker.understand,
        },
      };
      const totals = (shown["totals"] ?? {}) as {
        costUsd?: number | null;
        modelCalls?: number;
      };
      const stages = (shown["stages"] ?? []) as ReadonlyArray<{
        stage: string;
        agent: string;
        status: string;
      }>;
      const understand = stages
        .filter((stage) => stage.stage === "understand")
        .map((stage) => `${stage.agent}:${stage.status}`)
        .join(",");
      const costUsd =
        mode.route.price === null
          ? null
          : Number((totals.costUsd ?? worker.live.usd ?? 0).toFixed(4));
      const entry: SpendEntry = {
        caseId: chosen.caseId,
        candidate: lane.candidate,
        lane: lane.slug,
        route: mode.route.name,
        order: chosen.order,
        costUsd,
        tokens: worker.live.tokens,
        modelCalls: totals.modelCalls ?? worker.live.calls,
        outcome: String(
          shown["outcome"] ??
            (worker.stopped
              ? "stopped"
              : worker.finishedInvestigate && mode.stopAfterInvestigate === true
                ? "investigate-complete"
                : "no receipt"),
        ),
        understand: understand === "" ? worker.understand : understand,
        tokensByStage: worker.byStage,
        wallMs: ((shown["timing"] ?? {}) as { wallMs?: number }).wallMs ?? null,
        at: new Date().toISOString(),
        stoppedByWatcher: worker.stopped,
        usageLimit: worker.usageLimit,
      };
      // Only a whole run is stored as the lane's run; a truncated one is kept beside it for
      // inspection, so a later invocation runs the range again (every lane, so the lanes still
      // share one Understand) and the scorer never reads it.
      const whole =
        (mode.stopAfterInvestigate === true
          ? worker.finishedInvestigate
          : entry.outcome === "completed") &&
        !worker.stopped &&
        worker.usageLimit === null &&
        worker.live.calls > 0;
      writeFileSync(
        join(out, `${lane.slug}${whole ? "" : ".incomplete"}.json.gz`),
        gzipSync(Buffer.from(JSON.stringify(shown))),
      );
      writeSpend(mode, [...readSpend(mode), { ...entry, stored: whole }]);
      const tokenTotal = Object.values(worker.live.tokens).reduce(
        (sum, value) => sum + value,
        0,
      );
      log(
        `${chosen.caseId}: ${lane.slug} ${entry.outcome}, ${costUsd === null ? "" : `${costUsd} USD, `}${tokenTotal.toLocaleString("en")} tokens, ${entry.modelCalls} calls, understand ${understand}`,
      );
      if (worker.usageLimit !== null) {
        log(`stop: the run hit a usage limit: ${worker.usageLimit}`);
        return stopWith("usage-limit", chosen.caseId, worker.usageLimit);
      }
      if (worker.live.calls === 0) {
        log(
          `stop: ${lane.slug} made no model call (outcome ${entry.outcome}); the route could not run, see the worker log in ${work}`,
        );
        return stopWith("no-model-call", chosen.caseId, lane.slug);
      }
      if (worker.stopped) return stopWith("watcher", chosen.caseId, lane.slug);
    }
  }
  return { stopped: false, reason: null, total: total() };
};
