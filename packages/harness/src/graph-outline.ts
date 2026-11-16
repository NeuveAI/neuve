import { createHash } from "node:crypto";
import { readFileSync, statSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Effect, Option } from "effect";
import { Computations } from "@neuve/records-core";
import {
  sharedPublication,
  PublicationPolicy,
  PublicationTooLarge,
  PublicationCapacity,
  PublicationHostGone,
  inlinePublicationFailure,
  createPublicationFailure,
} from "./shared-publication.ts";
import { CpuWork, cpuPool } from "./budget/cpu.ts";
import {
  InsideSharedWorkGrant,
  SharedWorkError,
} from "@neuve/records-core/shared-work-effect";
import { budgetDirectory } from "@neuve/records-core/shared-work-socket";
import { SymbolObservation } from "@neuve/graph-client/symbol-observation";
import { SharedWork, KeyHeld } from "@neuve/records-core/shared-work";
import { GraphSymbolsError, readGraphSymbols } from "@neuve/graph-client";
import { isCompiled } from "./compiled.ts";
import {
  graphFallback,
  retryableFallback,
  type GraphChunkContext,
} from "./chunker.ts";

/** Outline parsing is always local and independent of optional semantic search settings. */
export const outlineExecutable = () => {
  const configured =
    process.env.NEUVE_GRAPH_OUTLINE_EXECUTABLE ??
    (isCompiled()
      ? resolve(
          dirname(realpathSync(process.execPath)),
          "../lib/neuve/entire-graph",
        )
      : resolve(import.meta.dir, "../../../apps/neuve-graph/entire-graph"));
  return configured.includes("/")
    ? resolve(configured)
    : (Bun.which(configured) ?? resolve(configured));
};

let held: { stamp: string; sha256: string } | undefined;
/** The exact executable, including recovery from absence, invalidates all index recipes. */
const outlineSourceKey = (
  executable: string,
): { sha256: string } | { unavailable: string } => {
  try {
    const stat = statSync(executable);
    const stamp = `${executable}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (held?.stamp !== stamp)
      held = {
        stamp,
        sha256: createHash("sha256")
          .update(readFileSync(executable))
          .digest("hex"),
      };
    return { sha256: held.sha256 };
  } catch {
    return { unavailable: executable };
  }
};

// Older cache entries did not verify the engine that actually produced the observation.
export const GRAPH_SOURCE_BINDING = "graph-source-bound-v1";
export const GRAPH_REQUEST_BINDING = "graph-source-request-v2";
export type OutlineSource = Readonly<{
  executable: string;
  key: ReturnType<typeof outlineSourceKey>;
}>;
export const captureOutlineSource = (): OutlineSource => {
  const executable = outlineExecutable();
  return { executable, key: outlineSourceKey(executable) };
};
export class OutlineSourceChanged extends Error {
  constructor() {
    super("Graph engine changed during index build");
  }
}
export const assertOutlineSource = (source: OutlineSource) => {
  const key = JSON.stringify(source.key);
  if (JSON.stringify(outlineSourceKey(source.executable)) !== key)
    throw new OutlineSourceChanged();
};

export type OutlineBatch = Readonly<{
  context: (path: string) => GraphChunkContext;
  /**
   * Tokens were asked for and the engine does not declare them (`GraphSymbolsError` with reason
   * `unsupported`): the same engine refuses again, so this is stable, never "Graph unavailable".
   * Every path's context is then unavailable. Always false without the option.
   */
  tokensUnsupported: boolean;
}>;

/** What a read asks Graph for beyond the outline. Without `tokens`, a read is what it was before. */
export type OutlineReadOptions = Readonly<{
  /** Also read each file's syntax leaves and import bindings (`readGraphSymbols({ tokens: true })`). */
  tokens?: boolean;
  /**
   * How many of the read's parts run at once (`outlineParts`); 1 when absent. Never part of the
   * read's key. `readOutlinesWithBudget` sets it, since its CPU budget bounds every part.
   */
  concurrency?: number;
}>;

const Observation = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("unavailable") }),
  // Only with tokens asked: the engine does not declare them. Stable for the engine's identity.
  z.strictObject({ kind: z.literal("unsupported") }),
  z.strictObject({
    kind: z.literal("available"),
    observation: SymbolObservation,
  }),
]);
const Publication = z.strictObject({
  publication: z.uuid(),
  outcome: z.strictObject({ kind: z.literal("succeeded"), value: Observation }),
});
type Observation = z.infer<typeof Observation>;
const context = (result: Observation, path: string): GraphChunkContext =>
  result.kind !== "available"
    ? { kind: "unavailable" }
    : {
        kind: "available",
        provider: result.observation.provider,
        observation: result.observation.files.get(path),
      };

/** graph-client owns execution, validation, bounded batches and cleanup. */
const readOutlineBatch = async (
  files: readonly Readonly<{ path: string; bytes: Uint8Array }>[],
  signal: AbortSignal,
  execute: <A>(
    run: (permits: number) => Promise<A>,
    signal: AbortSignal,
  ) => Promise<A>,
  source: OutlineSource,
  tokens: boolean,
): Promise<Observation> => {
  assertOutlineSource(source);
  let observation;
  try {
    observation = await readGraphSymbols({
      executable: source.executable,
      temporaryParent: process.env.TMPDIR ?? tmpdir(),
      files,
      signal,
      execute,
      // Absent, not false, without the option: the input is what it was before tokens existed.
      ...(tokens ? { tokens: true } : {}),
    });
  } catch (error) {
    signal.throwIfAborted();
    assertOutlineSource(source);
    // The engine does not declare tokens: it will refuse again, so this is no retryable outage.
    if (
      tokens &&
      error instanceof GraphSymbolsError &&
      error.reason === "unsupported"
    )
      return { kind: "unsupported" };
    return { kind: "unavailable" };
  }
  const result = { kind: "available", observation } as const;
  assertObservationSource(source, result);
  return result;
};

const assertObservationSource = (
  source: OutlineSource,
  result: Observation,
) => {
  assertOutlineSource(source);
  if (
    result.kind === "available" &&
    (!("sha256" in source.key) ||
      result.observation.provider.executable.sha256 !== source.key.sha256)
  )
    throw new OutlineSourceChanged();
};

type OutlineFile = Readonly<{ path: string; bytes: Uint8Array }>;
type Execute = <A>(
  run: (permits: number) => Promise<A>,
  signal: AbortSignal,
) => Promise<A>;
const sha256 = (data: Uint8Array | string) =>
  createHash("sha256").update(data).digest("hex");
type Inputs = ReadonlyArray<readonly [path: string, sha256: string]>;
const keyOf = (inputs: Inputs, source: OutlineSource, tokens: boolean) =>
  sha256(
    JSON.stringify({
      recipe: "graph-outline@3",
      source: source.key,
      binding: GRAPH_SOURCE_BINDING,
      ...(tokens ? { tokens: true } : {}),
      files: inputs,
    }),
  );
const sortedInputs = (inputs: Inputs) =>
  [...inputs].sort(([a], [b]) => a.localeCompare(b));

/**
 * The shared publication key of one outline read. Without tokens it is the key every read had
 * before the option existed (`graph-outline@3`); with tokens it also names them, so a read with
 * tokens and one without never share a key or a publication. A part of a read is an outline read
 * of its own files, so it has the key any read of exactly those files had and has.
 */
export const outlineReadKey = (
  files: readonly OutlineFile[],
  source: OutlineSource,
  options: OutlineReadOptions = {},
) => {
  const inputs = sortedInputs(
    files.map((file) => [file.path, sha256(file.bytes)] as const),
  );
  return { key: keyOf(inputs, source, options.tokens === true), inputs };
};

/**
 * Published bytes per source byte, measured on this repository's head tree (4,356 text files,
 * 177 MB, 13 November). Without tokens: the 99th-percentile file 9.0, the densest 18.5, the median
 * 2.4, the tree as a whole 0.57. With tokens: 28.1, 36.0, 3.1 and 2.5. The estimate takes every
 * file at the 99th percentile, rounded up, and a part's estimate stays within half the publication
 * limit: a part that dense all through publishes at most half the limit, and one made wholly of
 * the densest file measured still fits (0.92 of it without tokens, 0.6 with).
 */
const PUBLISHED_PER_SOURCE_BYTE = { outline: 10, tokens: 30 } as const;
/** An empty or tiny file still publishes its record: at most 2.4 KB measured. */
const PUBLISHED_PER_FILE = 4 * 1024;
/** Parts in flight per read, when the caller's CPU budget bounds them (`readOutlinesWithBudget`). */
export const OUTLINE_PART_CONCURRENCY = 2;
const expected = (file: OutlineFile, tokens: boolean) =>
  PUBLISHED_PER_FILE +
  file.bytes.byteLength *
    PUBLISHED_PER_SOURCE_BYTE[tokens ? "tokens" : "outline"];

/**
 * Splits one read's files into parts whose expected publication is at most half the publication
 * limit (`PUBLISHED_PER_SOURCE_BYTE`). A read within that is one part: the read it always was, with
 * its key. A file over it alone is a part of its own. Otherwise parts follow path order and are cut
 * by the files themselves: once a part holds half its bound, a file ends it when its own digest
 * says so, with a chance in proportion to its estimate (one cut per half bound on average), and a
 * part that would pass its bound ends before the file that would pass it. The same files give the
 * same parts, and two reads that hold a common run of files mostly cut it at the same files, so
 * they share those parts' work even when their reads differ elsewhere (on this repository's head
 * tree, 29 of blob structure's 43 parts are the index builder's). A read that names a path twice
 * stays one part, as it was: Graph refuses it whole.
 */
export const outlineParts = <F extends OutlineFile>(
  files: readonly F[],
  options: OutlineReadOptions = {},
  maximumBytes: number = PublicationPolicy.defaultValue().maximumBytes,
): ReadonlyArray<ReadonlyArray<{ file: F; sha256: string }>> => {
  const hashed = files.map((file) => ({ file, sha256: sha256(file.bytes) }));
  if (new Set(files.map((file) => file.path)).size !== files.length)
    return [hashed];
  const tokens = options.tokens === true,
    bound = maximumBytes / 2;
  if (
    hashed.reduce((sum, { file }) => sum + expected(file, tokens), 0) <= bound
  )
    return [hashed];
  const parts: Array<Array<(typeof hashed)[number]>> = [];
  let part: Array<(typeof hashed)[number]> = [],
    held = 0;
  for (const item of hashed.sort((a, b) =>
    a.file.path < b.file.path ? -1 : a.file.path > b.file.path ? 1 : 0,
  )) {
    const estimate = expected(item.file, tokens);
    if (part.length && held + estimate > bound) {
      parts.push(part);
      part = [];
      held = 0;
    }
    part.push(item);
    held += estimate;
    const draw =
      parseInt(sha256(`${item.file.path}\0${item.sha256}`).slice(0, 12), 16) /
      2 ** 48;
    if (held >= bound / 2 && draw < estimate / (bound / 2)) {
      parts.push(part);
      part = [];
      held = 0;
    }
  }
  if (part.length) parts.push(part);
  return parts;
};

const outlineWork = new SharedWork<
  Observation,
  Computations.SharedAttemptFailed
>();
/**
 * The value a holder computed but could not publish, by the failure it recorded for subscribers.
 * Subscribers in this process await the same run and receive that failure object; they share the
 * value with the holder instead, since no publication stands between them. Other processes read
 * the recorded failure.
 */
const unpublished = new WeakMap<
  Computations.SharedAttemptFailed,
  Observation
>();

/** One part: one key, one shared run, one publication. */
const readOutlinePart = async (
  part: ReadonlyArray<{ file: OutlineFile; sha256: string }>,
  source: OutlineSource,
  signal: AbortSignal | undefined,
  execute: Execute,
  insideGrant: boolean,
  policy: ReturnType<typeof PublicationPolicy.defaultValue>,
  tokens: boolean,
): Promise<Observation> => {
  const files = part.map(({ file }) => file);
  const inputs = sortedInputs(
    part.map((item) => [item.file.path, item.sha256]),
  );
  const key = keyOf(inputs, source, tokens);
  const directory = join(budgetDirectory(), "shared-outlines-v4");
  const copies = sharedPublication({
    namespace: "shared-outlines-v4",
    scope: directory,
    key,
    group: JSON.stringify(inputs),
    schema: Publication,
    // An engine that does not declare tokens refuses again: stable, so reusable.
    reusable: (stored) =>
      stored.outcome.value.kind === "unsupported" ||
      !files.some((file) =>
        retryableFallback(
          graphFallback(file.path, context(stored.outcome.value, file.path)),
        ),
      ),
    ...policy,
  });
  const read = async (publication?: string) => {
    const failure = inlinePublicationFailure(publication, key);
    if (failure && publication !== undefined)
      return {
        publication,
        outcome: { kind: "failed" as const, error: failure },
      };
    try {
      const stored = await copies.read(publication);
      return stored
        ? { publication: stored.publication, outcome: stored.outcome }
        : undefined;
    } catch (error) {
      if (!(error instanceof PublicationHostGone) || publication === undefined)
        throw error;
      return {
        publication,
        outcome: {
          kind: "failed" as const,
          error: createPublicationFailure(
            error.attemptId,
            "PublicationHostGone",
            key,
          ).failure,
        },
      };
    }
  };
  let floor = false;
  const publish = async (value: Observation) => {
    const id = randomUUID();
    try {
      const stored = await copies.publish({
        publication: id,
        outcome: { kind: "succeeded", value },
      });
      return { publication: stored.publication, outcome: stored.outcome };
    } catch (error) {
      const tag =
        error instanceof PublicationTooLarge
          ? "PublicationTooLarge"
          : error instanceof PublicationCapacity
            ? "PublicationCapacity"
            : "PublicationFailed";
      const recorded = createPublicationFailure(
        id,
        tag,
        key,
        error instanceof Error ? error.message : String(error),
      );
      // Subscribers receive the recorded failure; the holder keeps its value.
      unpublished.set(recorded.failure, value);
      console.warn(
        JSON.stringify({
          type: "graph-outline.publication-failed",
          tag,
          bytes: error instanceof PublicationTooLarge ? error.bytes : null,
          maximum: policy.maximumBytes,
          files: files.length,
          message: "the holder keeps its outline; subscribers get the failure",
        }),
      );
      return {
        publication: recorded.publication,
        outcome: { kind: "failed" as const, error: recorded.failure },
      };
    }
  };
  const result = await outlineWork.run({
    insideGrant,
    scope: directory,
    key,
    ...(signal ? { signal } : {}),
    onEvent: (event) => {
      if (event.role === "floor") floor = true;
    },
    crossProcess: {
      store: directory,
      transport: copies.transport,
      read,
      acceptDeliveryFailure: true,
      local: {
        read: async () => undefined,
        publish: async (value) => publish(value),
      },
    },
    run: async (signal) => {
      const id = randomUUID();
      try {
        const value = await readOutlineBatch(
          files,
          signal,
          execute,
          source,
          tokens,
        );
        signal.throwIfAborted();
        assertObservationSource(source, value);
        if (floor)
          return {
            publication: id,
            outcome: { kind: "succeeded" as const, value },
          };
        return await publish(value);
      } catch (error) {
        signal.throwIfAborted();
        return {
          publication: createPublicationFailure(
            id,
            "OutlineFailed",
            key,
            String(error),
          ).publication,
          outcome: {
            kind: "failed" as const,
            error: new Computations.SharedAttemptFailed({
              key,
              attemptId: id,
              tag: "OutlineFailed",
              message: String(error),
            }),
          },
        };
      }
    },
  });
  const value =
    result.outcome.kind === "succeeded"
      ? result.outcome.value
      : unpublished.get(result.outcome.error);
  if (value === undefined)
    throw result.outcome.kind === "failed"
      ? result.outcome.error
      : new Error("Outline part has no value");
  assertObservationSource(source, value);
  return value;
};

/**
 * Runs the parts at most `concurrency` at a time, in order. The first failure, or the caller's
 * cancellation, stops the parts not yet started and unsubscribes from those in flight; a part
 * another caller also waits on keeps running for it (record 0016).
 */
const readPartsAtMost = async <P, A>(
  parts: ReadonlyArray<P>,
  concurrency: number,
  signal: AbortSignal | undefined,
  read: (part: P, signal: AbortSignal) => Promise<A>,
): Promise<ReadonlyArray<A>> => {
  const controller = new AbortController();
  const stop = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", stop, { once: true });
  const values: A[] = [];
  let next = 0,
    failure: { error: unknown } | undefined;
  const worker = async () => {
    while (!failure && !controller.signal.aborted && next < parts.length) {
      const index = next++;
      try {
        values[index] = await read(parts[index]!, controller.signal);
      } catch (error) {
        failure ??= { error };
        controller.abort(error);
      }
    }
  };
  try {
    await Promise.all(
      Array.from({ length: Math.min(concurrency, parts.length) }, worker),
    );
  } finally {
    signal?.removeEventListener("abort", stop);
  }
  signal?.throwIfAborted();
  if (failure) throw failure.error;
  return values;
};

/** The read, and how many parts it took. */
const readOutlineParts = async (
  files: readonly OutlineFile[],
  source: OutlineSource,
  signal: AbortSignal | undefined,
  execute: Execute,
  insideGrant: boolean,
  policy: ReturnType<typeof PublicationPolicy.defaultValue>,
  options: OutlineReadOptions,
): Promise<{ batch: OutlineBatch; parts: number }> => {
  signal?.throwIfAborted();
  assertOutlineSource(source);
  if (!files.length)
    return {
      batch: {
        context: () => ({ kind: "unavailable" }),
        tokensUnsupported: false,
      },
      parts: 0,
    };
  const tokens = options.tokens === true;
  const parts = outlineParts(files, options, policy.maximumBytes);
  const values = await readPartsAtMost(
    parts,
    Math.max(1, Math.floor(options.concurrency ?? 1)),
    signal,
    (part, signal) =>
      readOutlinePart(
        part,
        source,
        signal,
        execute,
        insideGrant,
        policy,
        tokens,
      ),
  );
  const answers = new Map<string, Observation>();
  parts.forEach((part, index) => {
    for (const { file } of part) answers.set(file.path, values[index]!);
  });
  // One engine answers every part, so one part's refusal is every part's.
  const unsupported = values.some((value) => value.kind === "unsupported");
  const first = values[0]!;
  return {
    batch: {
      // A path outside the read sees the first part's answer, as it saw the one read's.
      context: (path) =>
        unsupported
          ? { kind: "unavailable" }
          : context(answers.get(path) ?? first, path),
      tokensUnsupported: unsupported,
    },
    parts: parts.length,
  };
};

/**
 * All processes subscribe through the budget host. Unreachable hosts disclose the shared-work floor.
 * The files are read in parts (`outlineParts`), each its own shared work and publication, and the
 * parts' answers are merged; a read that fits one part is the read it always was.
 */
export const readOutlines = async (
  files: readonly OutlineFile[],
  source: OutlineSource,
  signal?: AbortSignal,
  execute: Execute = (run) => run(1),
  insideGrant = false,
  policy = PublicationPolicy.defaultValue(),
  options: OutlineReadOptions = {},
): Promise<OutlineBatch> =>
  (
    await readOutlineParts(
      files,
      source,
      signal,
      execute,
      insideGrant,
      policy,
      options,
    )
  ).batch;

/** Join before CPU admission; only the holder spends its existing worker permits. */
export const readOutlinesWithBudget = (
  files: Parameters<typeof readOutlines>[0],
  owner: string,
  source: OutlineSource,
  options: OutlineReadOptions = {},
) =>
  Effect.gen(function* () {
    const environment = yield* Effect.context<never>();
    const insideGrant = yield* InsideSharedWorkGrant;
    const policy = yield* PublicationPolicy;
    // Inside an inherited grant every part would spend the same permits: one part at a time.
    const cpu = yield* Effect.serviceOption(CpuWork);
    const concurrency =
      Option.isSome(cpu) && cpu.value.inherited ? 1 : OUTLINE_PART_CONCURRENCY;
    const { batch, parts } = yield* Effect.tryPromise({
      try: (signal) =>
        readOutlineParts(
          files,
          source,
          signal,
          (run, signal) =>
            Effect.runPromiseWith(environment)(
              cpuPool(owner, 1024, (permits) =>
                Effect.promise(() => run(permits)),
              ),
              { signal },
            ),
          insideGrant,
          policy,
          { ...options, concurrency },
        ),
      catch: (error) =>
        error instanceof KeyHeld ? error : new SharedWorkError(error),
    });
    yield* Effect.annotateCurrentSpan({
      "harness.graph.outline.files": files.length,
      "harness.graph.outline.parts": parts,
    });
    return batch;
  }).pipe(Effect.withSpan("harness.graph.outline"));
