import { createHash } from "node:crypto";
import {
  GRAPH_REQUEST_BINDING,
  OutlineSourceChanged,
  type OutlineSource,
} from "../graph-outline.ts";
import { Effect, Option } from "effect";
import { z } from "zod";
import type { Computations } from "@neuve/records-core";
import { Gap } from "./capability.ts";
import { stackIndexRecipeKey } from "./index-store.ts";
import { jsonComputation } from "../search-index.ts";
import { readGit, stackStateAt, type StackEntryState } from "./reads.ts";
import {
  STACK_LIMITS,
  StackSettings,
  resolveStackSettings,
  type ResolvedStackSettings,
  type StackToolsConfig,
} from "./settings.ts";
import {
  activeHolds,
  readCatalog,
  readHolds,
  recordHold,
  stackStorePath,
} from "./store.ts";
import type { StackRun } from "./tools.ts";

/**
 * The stack state a review cycle reads (proposal SC8, conflict X11): which entries the range's base
 * and head pin, which of them were ready in the store, with their tree OIDs, source levels and
 * whether each tree was indexed, recorded at the cycle's first run with the stack tools on. It is a
 * computation keyed by the cycle and the range's two commits, so every rerun in the cycle reads
 * exactly that state and cached results stay valid (5.4); the next cycle takes the store as it is
 * then. Nothing here exists, and nothing is frozen, while the stack tools are off.
 *
 * Each run also records the cycle's hold in the store (`holds.json`), so eviction keeps what the
 * frozen state names until the cycle has had no run for 7 days (10.79).
 */

/** Whether the user's settings turn the stack tools on: off unless `stack.tools` is true. */
export const stackToolsOn = (settings: StackSettings | undefined) =>
  settings?.tools === true;

const stackToolsIndex = (source: OutlineSource) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        recipe: stackIndexRecipeKey(),
        source: source.key,
        sourceBinding: GRAPH_REQUEST_BINDING,
      }),
    )
    .digest("hex")
    .slice(0, 32);

/** What a review request freezes (config.ts): absent while the stack tools are off. */
export const stackToolsConfig = (
  settings: Option.Option<{ readonly stack?: StackSettings | undefined }>,
  source: OutlineSource,
): StackToolsConfig | undefined =>
  stackToolsOn(Option.getOrUndefined(settings)?.stack)
    ? { tools: true, index: stackToolsIndex(source) }
    : undefined;

export const StackSourceLevel = z.enum([
  "package contents",
  "attested upstream",
  "registry-stated upstream",
]);
export type StackSourceLevel = z.infer<typeof StackSourceLevel>;

/** One tree an entry can be read from. */
export const FrozenTree = z.strictObject({
  tree: z.string().min(1),
  /** The commit a handle names: the store's commit for package contents, the upstream commit. */
  commit: z.string().min(1),
  level: StackSourceLevel,
  indexed: z.boolean(),
  files: z.int().min(0),
  fetchedAt: z.string(),
});
export type FrozenTree = z.infer<typeof FrozenTree>;

export const FrozenEntry = z.strictObject({
  key: z.string().min(1),
  ecosystem: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  integrity: z.string().min(1),
  lockfile: z.string().min(1),
  /** The revisions that pin it. */
  at: z.array(z.enum(["base", "head"])).min(1),
  status: z.enum(["ready", "gap", "pending"]),
  gap: Gap.optional(),
  rank: z.int().min(0).optional(),
  contents: FrozenTree.optional(),
  upstream: FrozenTree.extend({
    /** `<host>/<path>@<commit>`, the store's key. */
    key: z.string().min(1),
    url: z.string().min(1),
    /** The package's own folder in the tree, when the registry names one. */
    directory: z.string().optional(),
  }).optional(),
  upstreamGap: Gap.optional(),
});
export type FrozenEntry = z.infer<typeof FrozenEntry>;

export const FrozenStackState = z.strictObject({
  version: z.literal(1),
  cycleId: z.string().min(1),
  frozenAt: z.string().min(1),
  revisions: z.strictObject({
    base: z.string().min(1),
    head: z.string().min(1),
  }),
  /** `neuve setup stack` ran in this repository, and stack sources are on here and for the user. */
  setUp: z.boolean(),
  enabled: z.boolean(),
  entries: z.array(FrozenEntry),
  /** Detection gaps at either revision, each once. */
  gaps: z.array(Gap),
});
export type FrozenStackState = z.infer<typeof FrozenStackState>;

/** The frozen state's computation: one per cycle and range, never recomputed (5.4). */
export const frozenStackSpec = (
  cycleId: string,
  range: { readonly baseOid: string; readonly headOid: string },
  source: OutlineSource,
): Computations.ComputationSpec => ({
  op: "harness.stack-state",
  opVersion: 1,
  inputs: {
    cycle: `cycle:${cycleId}`,
    base: `git-commit:${range.baseOid}`,
    head: `git-commit:${range.headOid}`,
  },
  config: { index: stackToolsIndex(source) } as never,
});

const frozenTree = (
  tree: string,
  commit: string,
  level: StackSourceLevel,
  indexed: boolean,
  files: number,
  fetchedAt: string,
): FrozenTree => ({ tree, commit, level, indexed, files, fetchedAt });

/**
 * Reads the stack state of the range's two revisions from the repository's pins and the store's
 * catalog. Pure reads: nothing is fetched, indexed or written.
 */
export const readStackState = async (options: {
  readonly repository: string;
  readonly source: OutlineSource;
  readonly storeDirectory: string;
  readonly storeRoot: string;
  readonly cycleId: string;
  readonly range: { readonly baseOid: string; readonly headOid: string };
  readonly settings: ResolvedStackSettings;
  readonly now?: Date;
}): Promise<FrozenStackState> => {
  const at = async (commit: string) =>
    stackStateAt({
      repository: options.repository,
      source: options.source,
      storeDirectory: options.storeDirectory,
      storeRoot: options.storeRoot,
      commit,
      settings: options.settings,
    });
  const base = await at(options.range.baseOid);
  const head =
    options.range.headOid === options.range.baseOid
      ? base
      : await at(options.range.headOid);
  const catalog = await readCatalog(options.storeRoot);
  const entries = new Map<string, FrozenEntry>();
  const add = (entry: StackEntryState, revision: "base" | "head") => {
    const held = entries.get(entry.pin.key);
    if (held !== undefined) {
      if (!held.at.includes(revision)) held.at.push(revision);
      return;
    }
    const record = catalog.packages[entry.pin.key];
    const upstreamRecord =
      entry.upstream === undefined
        ? undefined
        : catalog.upstream[entry.upstream.key];
    entries.set(entry.pin.key, {
      key: entry.pin.key,
      ecosystem: entry.pin.ecosystem,
      name: entry.pin.name,
      version: entry.pin.version,
      integrity: entry.pin.integrity,
      lockfile: entry.pin.lockfile,
      at: [revision],
      status: entry.status,
      ...(entry.gap === undefined ? {} : { gap: entry.gap }),
      ...(entry.rank === undefined ? {} : { rank: entry.rank }),
      ...(entry.contents === undefined
        ? {}
        : {
            contents: frozenTree(
              entry.contents.tree,
              entry.contents.commit,
              "package contents",
              entry.contents.indexed,
              entry.contents.files,
              record?.fetchedAt ?? "",
            ),
          }),
      ...(entry.upstream === undefined
        ? {}
        : {
            upstream: {
              ...frozenTree(
                entry.upstream.tree,
                entry.upstream.commit,
                entry.upstream.level === "attested"
                  ? "attested upstream"
                  : "registry-stated upstream",
                entry.upstream.indexed,
                upstreamRecord?.files ?? 0,
                upstreamRecord?.fetchedAt ?? "",
              ),
              key: entry.upstream.key,
              url: entry.upstream.url,
              ...(entry.upstream.directory === undefined
                ? {}
                : { directory: entry.upstream.directory }),
            },
          }),
      ...(entry.upstreamGap === undefined
        ? {}
        : { upstreamGap: entry.upstreamGap }),
    });
  };
  for (const entry of base.entries) add(entry, "base");
  for (const entry of head.entries) add(entry, "head");
  const gaps = new Map<string, z.infer<typeof Gap>>();
  for (const gap of [...base.gaps, ...head.gaps])
    gaps.set(`${gap.reason}\0${gap.key ?? ""}\0${gap.path ?? ""}`, gap);
  return {
    version: 1,
    cycleId: options.cycleId,
    frozenAt: (options.now ?? new Date()).toISOString(),
    revisions: { base: options.range.baseOid, head: options.range.headOid },
    setUp: base.setUp,
    enabled: base.enabled,
    entries: [...entries.values()].sort((a, b) =>
      a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
    ),
    gaps: [...gaps.values()],
  };
};

/**
 * The cycle's hold on what its frozen state names, refreshed by every run (10.79's 7 days count
 * from the last run). Returns how many holds are in force in the store after it.
 */
export const holdFrozenState = async (options: {
  readonly storeRoot: string;
  readonly storeDirectory: string;
  readonly state: FrozenStackState;
  readonly now?: Date;
}) => {
  const now = options.now ?? new Date();
  await recordHold(options.storeRoot, {
    store: options.storeDirectory,
    cycleId: options.state.cycleId,
    packages: options.state.entries
      .filter((entry) => entry.contents !== undefined)
      .map((entry) => entry.key),
    upstream: [
      ...new Set(
        options.state.entries.flatMap((entry) =>
          entry.upstream === undefined ? [] : [entry.upstream.key],
        ),
      ),
    ],
    lastRunAt: now.toISOString(),
  });
  return activeHolds(await readHolds(options.storeRoot), now.getTime()).length;
};

/** The stack settings a run reads (for detection only: the private-default-registry switch). */
export const runStackSettings = (
  settings: Option.Option<{ readonly stack?: StackSettings | undefined }>,
) => resolveStackSettings(Option.getOrUndefined(settings)?.stack);

/** The hold window, for messages. */
export const HOLD_DAYS = STACK_LIMITS.holdMs / (24 * 60 * 60 * 1000);

/**
 * The run's stack tools context (pipeline.ts, only while the stack tools are on): the cycle's frozen
 * stack state, computed at its first run and read back by every rerun, and the cycle's hold on it.
 * A state that cannot be read is a disclosed gap for this run, never stored, so the next run tries
 * again; the tools then say so. Nothing is fetched or indexed here.
 */
export const freezeStackRun = (options: {
  readonly repository: string;
  readonly source: OutlineSource;
  readonly storeDirectory: string;
  readonly cycleId: string;
  readonly range: { readonly baseOid: string; readonly headOid: string };
  readonly config: StackToolsConfig;
  readonly settings: ResolvedStackSettings;
  /** Tests: a scratch store in place of the user's. */
  readonly storeRoot?: string;
}) =>
  Effect.gen(function* () {
    const root = options.storeRoot ?? stackStorePath();
    const git = readGit();
    const frozen = yield* Effect.result(
      Effect.andThen(
        Effect.try(() => {
          if (options.config.index !== stackToolsIndex(options.source))
            throw new OutlineSourceChanged();
        }),
        jsonComputation(
          frozenStackSpec(options.cycleId, options.range, options.source),
          FrozenStackState,
          Effect.tryPromise({
            try: () =>
              readStackState({
                repository: options.repository,
                source: options.source,
                storeDirectory: options.storeDirectory,
                storeRoot: root,
                cycleId: options.cycleId,
                range: options.range,
                settings: options.settings,
              }),
            catch: (cause) =>
              new Error(
                String((cause as { message?: unknown }).message ?? cause),
              ),
          }),
        ),
      ),
    );
    if (frozen._tag === "Failure")
      return {
        root,
        git,
        state: undefined,
        unavailable: String(
          (frozen.failure as { message?: unknown }).message ?? frozen.failure,
        ).slice(0, 300),
      } satisfies StackRun;
    const state = frozen.success.value;
    // The hold is the store's, not the computation's: refreshed by every run of the cycle.
    const held = yield* Effect.promise(() =>
      state.entries.length === 0
        ? Promise.resolve(undefined)
        : holdFrozenState({
            storeRoot: root,
            storeDirectory: options.storeDirectory,
            state,
          }).catch(() => undefined),
    );
    const ready = state.entries.filter((entry) => entry.contents !== undefined);
    yield* Effect.annotateCurrentSpan({
      "harness.stack.status": frozen.success.status,
      "harness.stack.entries": state.entries.length,
      "harness.stack.ready": ready.length,
      "harness.stack.upstream": ready.filter(
        (entry) => entry.upstream !== undefined,
      ).length,
      "harness.stack.indexed": ready.filter(
        (entry) => entry.contents?.indexed === true,
      ).length,
      // Holds in force after this run's, or 0 when it could not be recorded.
      "harness.stack.holds": held ?? 0,
    });
    return {
      root,
      git,
      state,
      key: frozen.success.key,
    } satisfies StackRun;
  });
