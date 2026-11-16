import { afterAll } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Clock, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import {
  Blobs,
  Computations,
  Log,
  Store,
  mintUlid,
  sha256Hex,
  storeLocationIn,
} from "@neuve/records-core";
import { defaultConfig } from "../src/config.ts";
import type { PublishContext } from "../src/publish.ts";
import type {
  SettledBatch,
  SettledComment,
  SettledInput,
  SettledSection,
  SettledUnit,
} from "../src/publish-sections.ts";
import { openRunLog } from "../src/run-log.ts";

/**
 * Settled batches for the new publisher's tests, and a scratch store per test. Three files, one
 * batch each: `src/a.ts` split across two lanes (an agentic unit whose request for changes rests on
 * two comments, beside an impact comment and one below the cut; a human-required unit), `src/b.ts`
 * with one section no agent decided, and `src/c.ts`, one section of 1,100 owned ranges.
 */

const directories: Array<string> = [];
afterAll(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const layerAt = (directory: string) => {
  const location = storeLocationIn(directory);
  return {
    location,
    layer: Computations.layer.pipe(
      Layer.provideMerge(Blobs.layer(location)),
      Layer.provideMerge(Store.layer(location, { create: true })),
      Layer.provideMerge(BunFileSystem.layer),
    ),
  };
};
type Services = Layer.Success<ReturnType<typeof layerAt>["layer"]>;

/** A store in `directory`, and contexts in one cycle and run key unless a test names others. */
const storeIn = (directory: string, cycleId: string) => {
  const { location, layer } = layerAt(directory);
  const run = <A, E>(program: Effect.Effect<A, E, Services>) =>
    Effect.runPromise(
      Effect.andThen(Store.prepareForWrite, program).pipe(
        Effect.provide(layer),
      ),
    );
  const ctx = (
    overrides: Partial<
      Pick<
        PublishContext,
        "cycleId" | "runKey" | "runId" | "range" | "startedAt"
      >
    > = {},
  ): PublishContext => {
    const runId = overrides.runId ?? mintUlid();
    return {
      repository: directory,
      runId,
      runKey: overrides.runKey ?? "c".repeat(64),
      range: overrides.range ?? {
        baseRef: "main",
        baseOid: "1".repeat(40),
        headOid: "2".repeat(40),
      },
      cycleId: overrides.cycleId ?? cycleId,
      config: defaultConfig(),
      log: openRunLog(location, runId),
      startedAt: overrides.startedAt ?? Date.now(),
    };
  };
  return { directory, location, cycleId, run, ctx };
};

/**
 * A fresh store, and contexts in one cycle and run key unless a test names others. `copy()` gives
 * a second store holding what this one holds now (call it between runs).
 */
export const scratch = (shared: { readonly cycleId?: string } = {}) => {
  const directory = mkdtempSync(join(tmpdir(), "publish-sections-"));
  directories.push(directory);
  const store = storeIn(directory, shared.cycleId ?? mintUlid());
  const copy = () => {
    const twin = mkdtempSync(join(tmpdir(), "publish-sections-"));
    directories.push(twin);
    cpSync(directory, twin, { recursive: true });
    return storeIn(twin, store.cycleId);
  };
  return { ...store, copy };
};

/** Runs `program` with a clock that says `at`, and sleeps as the real one does. */
export const atTime =
  (at: number) =>
  <A, E, R>(program: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const real = yield* Clock.Clock;
      const fixed: Clock.Clock = {
        currentTimeMillisUnsafe: () => at,
        currentTimeMillis: Effect.succeed(at),
        currentTimeNanosUnsafe: () => BigInt(at) * 1_000_000n,
        currentTimeNanos: Effect.succeed(BigInt(at) * 1_000_000n),
        monotonicTimeNanosUnsafe: () => real.monotonicTimeNanosUnsafe(),
        monotonicTimeNanos: real.monotonicTimeNanos,
        sleep: (duration) => real.sleep(duration),
      };
      return yield* Effect.provideService(program, Clock.Clock, fixed);
    });

/** Every event of a cycle, by kind. */
export const eventsOf = (cycleId: string, kind?: string) =>
  Effect.map(Log.history({ cycleId, limit: 100_000 }), (rows) =>
    rows
      .map((row) => row.event)
      .filter((event) => kind === undefined || event.kind === kind),
  );

/** The ID Records holds at each idempotency key under a review's namespace. */
export const keyedOf = (cycleId: string, runKey: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const prefix = `review:${cycleId}:${runKey}:`;
    const rows = yield* sql<{
      id: string;
      key: string;
    }>`SELECT id, idempotency_key AS key
      FROM events WHERE idempotency_key >= ${prefix} AND idempotency_key < ${`${prefix}\u{10FFFF}`}
      ORDER BY idempotency_key`;
    return Object.fromEntries(rows.map((row) => [row.key, row.id]));
  });

export const key = (label: string) => sha256Hex(`section:${label}`);

/** Line ranges on one side, two lines apart. */
export const lines = (path: string, from: number, count: number) =>
  Array.from({ length: count }, (_, index) => ({
    kind: "lines" as const,
    path,
    side: "new" as const,
    startLine: from + index * 2,
    endLine: from + index * 2,
  }));

type Lane = SettledUnit["lane"];

/** A section as the readers lane settles it: identity whole, its judgement entry, its facts. */
export const section = (options: {
  readonly label: string;
  readonly path: string;
  readonly kind?: string;
  readonly name: string | null;
  readonly where: { startLine: number; endLine: number };
  readonly ranges: SettledSection["ownedRanges"];
  readonly lane: Lane;
  readonly judged?: Lane | null;
  readonly undecided?: string;
  readonly keyOverride?: string;
}): SettledSection => {
  const sectionKey = options.keyOverride ?? key(options.label);
  const decided = options.undecided === undefined;
  return {
    identity: {
      key: sectionKey,
      parts: {
        path: options.path,
        side: "new",
        kind: options.kind ?? "function",
        name: options.name,
        spanSha256: sha256Hex(`span:${options.label}`),
      },
      where: options.where,
      renamedFrom: null,
    },
    title: `The ${options.name ?? "block"} change`,
    ownedRanges: options.ranges,
    entry: {
      key: sectionKey,
      facts: { changed: options.ranges.length },
      assess: decided
        ? {
            complexity: { level: "low", factors: [] },
            easeOfValidation: { level: "easy", requirements: [] },
            movement: [],
            lean: null,
            gaps: [],
          }
        : null,
      review: decided ? { verdict: "approve" } : null,
      lane: {
        judged: decided ? (options.judged ?? options.lane) : null,
        surfaced: decided ? (options.judged ?? options.lane) : null,
        floors:
          decided &&
          options.judged !== undefined &&
          options.judged !== options.lane
            ? [{ rule: "public-surface", to: options.lane }]
            : [],
        applied: options.lane,
      },
      ...(decided
        ? {}
        : { undecided: { cause: options.undecided!, reading: "assess" } }),
      lineage: "fresh",
    },
    content: {
      facts: { text: `${options.name ?? "A block"} changes.`, cites: [] },
      briefed: null,
      explained: null,
    },
  };
};

export const comment = (
  id: string,
  overrides: Partial<SettledComment> = {},
): SettledComment => ({
  id,
  section: null,
  kind: "defect",
  about: "code",
  body: `Comment ${id}.`,
  evidence: [],
  shown: true,
  restedOn: false,
  ...overrides,
});

export const batchOf = (
  title: string,
  paths: ReadonlyArray<string>,
  sections: ReadonlyArray<SettledSection>,
  units: ReadonlyArray<SettledUnit>,
): SettledBatch => ({
  title,
  focus: `Focus of ${title}`,
  paths: [...paths],
  sections: [...sections],
  units: [...units],
  digest: { text: `${title}: what changed.` },
});

export const unit = (
  path: string,
  lane: Lane,
  sections: ReadonlyArray<SettledSection>,
  overrides: Partial<SettledUnit> = {},
): SettledUnit => ({
  path,
  lane,
  sectionKeys: sections.map((s) => s.identity.key),
  verdict: null,
  proof: [],
  comments: [],
  ...overrides,
});

/** The three batches. `salt` gives other section keys, as a later commit would. */
export const threeBatches = () => {
  const a1 = section({
    label: "a1",
    path: "src/a.ts",
    name: "retry",
    where: { startLine: 1, endLine: 20 },
    ranges: lines("src/a.ts", 3, 3),
    lane: "agentic",
  });
  const a2 = section({
    label: "a2",
    path: "src/a.ts",
    name: "exported",
    where: { startLine: 30, endLine: 50 },
    ranges: lines("src/a.ts", 31, 2),
    lane: "human-required",
    judged: "agentic",
  });
  const b1 = section({
    label: "b1",
    path: "src/b.ts",
    kind: "block",
    name: null,
    where: { startLine: 1, endLine: 9 },
    ranges: lines("src/b.ts", 4, 2),
    lane: "human-required",
    undecided: "failed",
  });
  const b2 = section({
    label: "b2",
    path: "src/b.ts",
    name: "guard",
    where: { startLine: 20, endLine: 30 },
    ranges: lines("src/b.ts", 21, 1),
    lane: "human-required",
    judged: "human-suggested",
  });
  const c1 = section({
    label: "c1",
    path: "src/c.ts",
    name: "table",
    where: { startLine: 1, endLine: 2_400 },
    ranges: lines("src/c.ts", 1, 1_100),
    lane: "agentic",
  });
  const a = batchOf(
    "Retry policy",
    ["src/a.ts"],
    [a1, a2],
    [
      unit("src/a.ts", "agentic", [a1], {
        verdict: "request-changes",
        disposition: "request-changes",
        message: "Two defects need fixing.",
        comments: [
          comment("claim:defect-1", {
            section: a1.identity.key,
            restedOn: true,
            anchor: { path: "src/a.ts", side: "new", startLine: 3, endLine: 3 },
          }),
          comment("claim:impact", {
            kind: "impact",
            effect: "narrowed",
            summary: "Retries stop after two attempts instead of five.",
            anchor: { path: "src/a.ts", side: "new", startLine: 5, endLine: 5 },
          }),
          comment("claim:defect-2", {
            section: a1.identity.key,
            restedOn: true,
            shown: false,
          }),
          comment("claim:below", { kind: "risk", shown: false }),
        ],
      }),
      unit("src/a.ts", "human-required", [a2]),
    ],
  );
  const b = batchOf(
    "Guards",
    ["src/b.ts"],
    [b1, b2],
    [unit("src/b.ts", "human-required", [b1, b2])],
  );
  const c = batchOf(
    "Lookup table",
    ["src/c.ts"],
    [c1],
    [
      unit("src/c.ts", "agentic", [c1], {
        verdict: "approve",
        disposition: "approve",
      }),
    ],
  );
  return { a, b, c, sections: { a1, a2, b1, b2, c1 } };
};

/** The review's totals over the three batches. */
export const TOTALS = { batches: 3, sections: 5 };

export const inputOf = (
  batches: ReadonlyArray<SettledBatch>,
  options: Partial<Omit<SettledInput, "batches">> = {},
): SettledInput => ({
  batches: [...batches],
  totals: options.totals ?? TOTALS,
  ending: options.ending ?? false,
  gaps: options.gaps ?? [],
  stages: options.stages ?? [{ stage: "find", status: "computed" }],
});

/**
 * A batch as it might arrive in another order: its units, sections, each unit's section keys, each
 * section's owned ranges and, with `comments`, each unit's comments, reversed.
 */
export const reordered = (
  batch: SettledBatch,
  options: { readonly comments?: boolean } = {},
): SettledBatch => ({
  ...batch,
  paths: [...batch.paths].reverse(),
  sections: [...batch.sections].reverse().map((s) => ({
    ...s,
    ownedRanges: [...s.ownedRanges].reverse(),
  })),
  units: [...batch.units].reverse().map((u) => ({
    ...u,
    sectionKeys: [...u.sectionKeys].reverse(),
    comments:
      options.comments === true ? [...u.comments].reverse() : u.comments,
  })),
});
