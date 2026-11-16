import { join } from "node:path";
import { Clock, Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { declareGraphCache } from "@neuve/graph-client";
import type { StoreLocation } from "@neuve/records-core";
import { git } from "./git.ts";
import { mergeBase } from "./git-objects.ts";
import { GRAPH_POLITE } from "./graph-search.ts";
import { searchRuntimeFrom } from "./search-config.ts";
import { readSettings } from "./settings.ts";

/**
 * The bases the store's one Graph cache keeps whatever their last use (10.115, Graph's `cache
 * declare`), declared from the worker. `cache declare` replaces the whole set, so every
 * declaration names all of them:
 * - each review still waiting or running: the merge base of its range, where it prepares Graph;
 * - each active branch (a local branch with a commit in the last `ACTIVE_BRANCH_DAYS`): its merge
 *   base with the default branch, or for the default branch with its upstream, the base its next
 *   review is likely to have;
 * - each commit preparation still waiting or running, or ended within `PREPARED_PARENT_KEEP_MS`:
 *   the first parent, where it searched for leads.
 *
 * `ACTIVE_BRANCH_DAYS` and `PREPARED_PARENT_KEEP_MS` are starting values, to be tuned from what the
 * store-usage spans show each declared set costs (`harness.graph.declare`, `harness.graph.store.*`).
 */
export const ACTIVE_BRANCH_DAYS = 14;
export const PREPARED_PARENT_KEEP_MS = 24 * 60 * 60_000;
/** Turns between two looks at Records and git are at least this far apart. */
export const DECLARE_INTERVAL_MS = 30_000;
/** With nothing changed in Records, the bases are looked at again this often (branch tips move). */
export const DECLARE_REFRESH_MS = 10 * 60_000;
/** A look (its git reads and Graph's declaration) past this is stopped, so it never holds the loop. */
export const DECLARE_TIMEOUT_MS = 60_000;

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** What changes in Records when a base may have: a new event or a job's state. */
const recordsSignature = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const cutoff = new Date(
    (yield* Clock.currentTimeMillis) - PREPARED_PARENT_KEEP_MS,
  ).toISOString();
  const [row] = yield* sql<{ events: number | null; jobs: string | null }>`
    SELECT (SELECT max(seq) FROM events) AS events,
      (SELECT group_concat(job_seq || ':' || state) FROM jobs
        WHERE kind IN ('review.run', 'review.run@2', 'commit.prepare', 'commit.prepare@2')
          AND (state IN ('waiting', 'delayed', 'active') OR finished_at >= ${cutoff})) AS jobs`;
  return `${row?.events ?? 0}\0${row?.jobs ?? ""}`;
});

const reviewRanges = Effect.gen(function* () {
  const sql = yield* SqlClient;
  return yield* sql<{ base: string | null; head: string | null }>`
    SELECT json_extract(e.envelope, '$.attribution.range.baseOid') AS base,
      json_extract(e.envelope, '$.attribution.range.headOid') AS head
    FROM jobs j JOIN events e ON e.id = j.event_id
    WHERE j.kind IN ('review.run', 'review.run@2') AND j.state IN ('waiting', 'delayed', 'active')`;
});

const preparedParents = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const cutoff = new Date(
    (yield* Clock.currentTimeMillis) - PREPARED_PARENT_KEEP_MS,
  ).toISOString();
  return yield* sql<{
    parent: string | null;
    base: string | null;
    head: string | null;
  }>`
    SELECT CASE WHEN j.kind = 'commit.prepare'
        THEN json_extract(e.envelope, '$.payload.parents[0]')
        ELSE json_extract(j.payload, '$.commit.parents[0]') END AS parent,
      coalesce(json_extract(j.payload, '$.range.baseOid'),
        json_extract(e.envelope, '$.attribution.range.baseOid')) AS base,
      coalesce(json_extract(j.payload, '$.range.headOid'),
        json_extract(e.envelope, '$.attribution.range.headOid')) AS head
    FROM jobs j LEFT JOIN events e ON e.id = j.event_id
    WHERE j.kind IN ('commit.prepare', 'commit.prepare@2')
      AND (j.state IN ('waiting', 'delayed', 'active') OR j.finished_at >= ${cutoff})`;
});

const lines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

/** The repository's default branch: origin's HEAD, else a local main or master. */
export const defaultBranch = (repository: string) =>
  Effect.gen(function* () {
    const remote = yield* git(repository, [
      "symbolic-ref",
      "--quiet",
      "refs/remotes/origin/HEAD",
    ]).pipe(Effect.orElseSucceed(() => ""));
    if (remote.trim() !== "") return remote.trim();
    for (const name of ["refs/heads/main", "refs/heads/master"]) {
      const found = yield* git(repository, [
        "rev-parse",
        "--verify",
        "--quiet",
        `${name}^{commit}`,
      ]).pipe(Effect.orElseSucceed(() => ""));
      if (found.trim() !== "") return name;
    }
    return undefined;
  });

const activeBranchBases = (repository: string) =>
  Effect.gen(function* () {
    const target = yield* defaultBranch(repository);
    // The default branch's local name: origin's `refs/remotes/origin/<name>` is `refs/heads/<name>`.
    const local =
      target?.startsWith("refs/remotes/origin/") === true
        ? `refs/heads/${target.slice("refs/remotes/origin/".length)}`
        : target;
    const since =
      Math.floor((yield* Clock.currentTimeMillis) / 1000) -
      ACTIVE_BRANCH_DAYS * 24 * 60 * 60;
    const refs = lines(
      yield* git(repository, [
        "for-each-ref",
        "--format=%(refname) %(committerdate:unix) %(upstream)",
        "refs/heads/",
      ]),
    );
    const bases: string[] = [];
    for (const line of refs) {
      const [ref, date, upstream] = line.split(" ");
      if (ref === undefined || Number(date) < since) continue;
      // The default branch's own base is its upstream; any other branch's, the default branch.
      const against = ref === local ? upstream || undefined : target;
      if (against === undefined) continue;
      const base = yield* mergeBase(repository, against, ref).pipe(
        Effect.orElseSucceed(() => ""),
      );
      if (OID.test(base)) bases.push(base);
    }
    return bases;
  });

/** Every base the store's Graph cache must keep now, sorted and without repeats. */
export const graphBases = (repository: string) =>
  Effect.gen(function* () {
    const bases = new Set<string>();
    for (const range of yield* reviewRanges) {
      if (range.base === null || range.head === null) continue;
      const base = yield* mergeBase(repository, range.base, range.head).pipe(
        Effect.orElseSucceed(() => ""),
      );
      if (OID.test(base)) bases.add(base);
    }
    for (const base of yield* activeBranchBases(repository)) bases.add(base);
    // Graph refuses the whole declaration for one commit it cannot find (a parent gone with a
    // rewritten history), so a parent is declared only while the repository has it.
    for (const prepared of yield* preparedParents) {
      const parent =
        prepared.parent ??
        (prepared.base !== null && prepared.head !== null
          ? yield* mergeBase(repository, prepared.base, prepared.head).pipe(
              Effect.orElseSucceed(() => ""),
            )
          : null);
      if (parent === null || !OID.test(parent) || bases.has(parent)) continue;
      const present = yield* git(repository, [
        "cat-file",
        "-e",
        `${parent}^{commit}`,
      ]).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (present) bases.add(parent);
    }
    return [...bases].sort();
  });

/**
 * One worker turn's look at the bases (`WorkerOptions.eachTurn`): at most every
 * `DECLARE_INTERVAL_MS`, and only when Records changed or `DECLARE_REFRESH_MS` passed; Graph is
 * asked only when the set differs from the one it last declared. Nothing is declared when the
 * settings name no Graph engine. A look is stopped past `DECLARE_TIMEOUT_MS`; a look that fails or
 * is stopped is logged by the worker and tried again at the next interval. The worker keeps no
 * spans, so each declaration's account (what it keeps, the store's size) is its log line.
 */
export const graphBasesTurn = (
  location: StoreLocation,
  repository: string,
  settings = () => readSettings(),
) => {
  const last = {
    lookedAt: 0,
    signature: "",
    declared: undefined as string | undefined,
  };
  const look = Effect.gen(function* () {
    const graph = searchRuntimeFrom(
      yield* Effect.try(settings),
      location.directory,
    ).graph;
    if (graph === undefined) return;
    const commits = yield* graphBases(repository);
    const cacheDirectory =
      graph.cacheDirectory ?? join(graph.workDirectory, "cache");
    const key = `${graph.executable}\0${cacheDirectory}\0${commits.join(",")}`;
    if (key === last.declared) return;
    const declared = yield* declareGraphCache(
      { executable: graph.executable, repository, commits },
      { cacheDirectory, reuseIdentity: true, niceness: GRAPH_POLITE.niceness },
    );
    last.declared = key;
    const mib = (bytes: number) => `${Math.round(bytes / 2 ** 20)} MiB`;
    const usage = declared.usage;
    yield* Effect.logInfo(
      `Graph cache declared ${declared.commits.length} base(s) (${declared.trees.length} tree(s), ${mib(usage.declaredBytes)} kept for them); the store holds ${mib(usage.bytes)} of ${mib(usage.capBytes)}, ${usage.freeBytes === undefined ? "free space unknown" : `${mib(usage.freeBytes)} free`}, ${usage.evictedEntries} artifact(s) evicted last (${mib(usage.evictedBytes)})`,
    );
  });
  return Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (now - last.lookedAt < DECLARE_INTERVAL_MS) return;
    const signature = yield* recordsSignature;
    if (
      signature === last.signature &&
      now - last.lookedAt < DECLARE_REFRESH_MS
    )
      return;
    last.lookedAt = now;
    last.signature = signature;
    yield* look.pipe(
      Effect.timeoutOrElse({
        duration: DECLARE_TIMEOUT_MS,
        orElse: () =>
          Effect.fail(
            new Error(
              `the Graph cache's bases were not declared within ${DECLARE_TIMEOUT_MS / 1000} s`,
            ),
          ),
      }),
      // Forgetting what was seen makes the next interval look again.
      Effect.onError(() =>
        Effect.sync(() => {
          last.signature = "";
        }),
      ),
    );
  });
};
