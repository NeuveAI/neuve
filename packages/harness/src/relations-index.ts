import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { Cause, Data, Deferred, Effect, Exit, Option } from "effect";
import { z } from "zod";
import { Blobs, Computations, type Store } from "@neuve/records-core";
import { SharedWork } from "@neuve/records-core/shared-work";
import {
  InsideSharedWorkGrant,
  sharedWorkEffect,
} from "@neuve/records-core/shared-work-effect";
import type { KeyHeld } from "@neuve/records-core/shared-work";
import {
  GRAPH_CALL_SITE_KINDS,
  GraphSnapshotCoverage,
  GraphSnapshotError,
  readGraphSnapshot,
  type GraphImportTarget,
  type GraphSnapshotFile,
  type GraphSnapshotRelation,
  type GraphSnapshotSymbol,
} from "@neuve/graph-client";
import { cpuWork } from "./budget/cpu.ts";
import {
  GRAPH_SOURCE_BINDING,
  assertOutlineSource,
  type OutlineSource,
} from "./graph-outline.ts";
import { GraphUnavailable, graphClone, withGraphSlot } from "./graph-search.ts";
import { GRAPH_DEADLINE_MS } from "./search-config.ts";
import { decodeJson } from "./search-index.ts";
import { step } from "./telemetry.ts";

/**
 * One relations index per commit (NEU-148 WP11): the call-family edges into every symbol of a
 * semantic language at that commit, read in one bulk Graph read (graph-client's
 * `readGraphSnapshot`) and stored as one computation, so every review of the commit shares it and a
 * base is read once. The read's measurements and the support rule are in the Graph relations
 * measures report (`neu-148/reports/graph-relations-measures.md`).
 *
 * Only supported edges are kept. Supported means Graph resolved the call (`exact`,
 * `import_resolved`, `package`) or matched it by name or receiver type (`name_only`,
 * `type_inferred`) with the caller's file being the target's file or importing it directly, except
 * a name-only match to a method in the caller's own file in a language of
 * `NAME_ONLY_SAME_FILE_METHODS_NOT_KEPT`. Every other call-family edge into a kept symbol is counted
 * on its target and not kept. A symbol with no
 * kept edge has no evidence; the index never says it has no callers.
 *
 * Each kept edge keeps the engine's resolution, which the slices give every row as its match class
 * (`MATCH_CLASSES`: `resolved`, `receiver-type`, `name-only`). Only the first two may count as
 * evidence; a `name-only` row is context and never lifts a gap.
 */

/**
 * v2 added `imports`; v3 reads through the store's private Graph clone instead of the repository.
 * The engine takes `.graphignore` from the directory it serves, which in the clone holds no
 * checked-out files, so a v2 index (read on the repository, with its working tree's ignore file)
 * is not the same answer. v4 no longer keeps a TypeScript name-only match to a method of the
 * caller's own file (`NAME_ONLY_SAME_FILE_METHODS_NOT_KEPT`), so the same engine output gives
 * another index. v5 stores what each edge's site shows (`edges.siteShows`, `SITE_SHOWS`) and the
 * languages the engine declared for call lines (`coverage.callSiteLineLanguages`), so no index
 * stored before is ever read as saying it. The recipe is in the computation's key and the stored
 * `format`, so an index stored under an earlier recipe is not found and the next round computes it
 * again; an earlier payload read under this key would be refused by `format` too.
 */
export const RELATIONS_RECIPE = "neuve-graph-relations-v5";
/**
 * Where an import resolves, by its index in the stored imports' `kind`, as graph-client normalizes
 * Graph's import targets. `unresolved` means Graph looked and found nothing.
 */
export const IMPORT_TARGET_KINDS = [
  "file",
  "declared-package",
  "builtin",
  "unresolved",
  "not-classified",
] as const;
export type ImportTargetKind = (typeof IMPORT_TARGET_KINDS)[number];
/** The families whose edges are kept, by their index in the stored edges' `family`. */
export const CALL_FAMILIES = ["CALLS", "CONSTRUCTS", "ASYNC_CALLS"] as const;
export type CallFamily = (typeof CALL_FAMILIES)[number];
/** Why a kept edge is evidence, by its index in the stored edges' `support`. */
export const SUPPORT_CLASSES = ["resolved", "import-backed"] as const;
export type SupportClass = (typeof SUPPORT_CLASSES)[number];

/**
 * What a kept edge's site line shows, by its index in the stored edges' `siteShows`, decided once
 * when the index is built, from the snapshot's own declaration (`coverage.callSiteLineLanguages`,
 * which the engine that wrote it lists for `call_site_lines`) and the language of the caller's file:
 * - `call`: the language is listed, the edge's call-site entry has a line in the caller's file, and
 *   no `form`: a call or construction of the target is written at that line;
 * - `reference`: the same with `form: "reference"`: that line hands the target over by name
 *   (`xs.map(double)`), and the caller never calls it;
 * - `caller`: anything else (a language not listed, an engine that declares no call lines, an entry
 *   with no line or another form, a site outside the caller's file). Its line, when there is one, is
 *   the calling symbol's first line, never the call's.
 */
export const SITE_SHOWS = ["call", "reference", "caller"] as const;
export type SiteShows = (typeof SITE_SHOWS)[number];
const SHOWS_CALLER = SITE_SHOWS.indexOf("caller");
const CALL_SITE_KINDS = new Set<string>(GRAPH_CALL_SITE_KINDS);
const RESOLVED = new Set(["exact", "import_resolved", "package"]);
const MATCHED = new Set(["name_only", "type_inferred"]);

/**
 * Name-only matches the support rule does not keep although the caller's file is the target's: a
 * call matched by name alone to a method (`kind` `method`) declared in the caller's own file, in
 * these languages. Graph gives this match for a receiver call whose type it does not know, by the
 * method names of the caller's own file; checked by hand on this repository it was right 2 times
 * of 10 (wrong: a DOM element's method, a `super` call, a `Headers` or WebSocket method of the same
 * name). Go's same-file name-only method matches were right 3 of 3 and stay; no other language was
 * measured, so none other is listed. A match not kept is counted in the target's dropped count, as
 * every other one the rule does not keep.
 */
export const NAME_ONLY_SAME_FILE_METHODS_NOT_KEPT = {
  kind: "method",
  languages: ["TypeScript"],
} as const;

/**
 * How a kept edge was matched, read from the engine's resolution the index keeps
 * (`edges.resolution`), so no stored index changes for it:
 * - `resolved`: the engine resolved the call (`exact`, `import_resolved` or `package`);
 * - `receiver-type`: matched by the receiver's type (`type_inferred`), kept by the import-path rule;
 * - `name-only`: matched by name alone (`name_only`), kept by the import-path rule, less the
 *   same-file methods of `NAME_ONLY_SAME_FILE_METHODS_NOT_KEPT`.
 *
 * What each may be used to conclude: a `resolved` or `receiver-type` row may count as caller or
 * test evidence. A `name-only` row is context only: it may be shown, and must never count as
 * evidence that lifts a gap. `support` mixes the last two (both are `import-backed`), so a
 * consumer that decides on evidence reads `matched`.
 */
export const MATCH_CLASSES = [
  "resolved",
  "receiver-type",
  "name-only",
] as const;
export type MatchClass = (typeof MATCH_CLASSES)[number];
/**
 * The match class of a kept edge's resolution. The support rule keeps only the five resolutions
 * named above; anything else (which no kept edge has) reads as `name-only`, the class that is never
 * evidence, so an unknown resolution can never lift a gap.
 */
export const matchClassOf = (resolution: string): MatchClass =>
  RESOLVED.has(resolution)
    ? "resolved"
    : resolution === "type_inferred"
      ? "receiver-type"
      : "name-only";
/** Items worked between two yields to the event loop while the index is finished. */
const BUILD_YIELD_ITEMS = 4_096;

const ref = z.int().min(0);
const optionalRef = z.int().min(-1);

/**
 * The stored index. Strings are kept once in `strings`; every other field is an integer, in
 * columns. Ids are compared whole; nothing here splits one.
 */
export const RelationsIndex = z
  .strictObject({
    format: z.literal(RELATIONS_RECIPE),
    coverage: GraphSnapshotCoverage,
    strings: z.array(z.string()),
    /** Every path with a file record, and its language (a string, or -1). */
    files: z.strictObject({
      path: z.array(ref),
      language: z.array(optionalRef),
    }),
    /** The symbols of languages whose tier is semantic. `container` is the container's id, or -1. */
    symbols: z.strictObject({
      id: z.array(ref),
      name: z.array(ref),
      qualifiedName: z.array(ref),
      kind: z.array(ref),
      language: z.array(ref),
      path: z.array(ref),
      startLine: z.array(z.int().positive()),
      endLine: z.array(z.int().positive()),
      container: z.array(optionalRef),
    }),
    /**
     * Supported call-family edges into a kept symbol, in stream order. `target` and `sourceSymbol`
     * are ids (`sourceSymbol` -1 when the caller is a file); `sourcePath` is the caller's file;
     * `site` is the first call-site evidence entry's location, or the first entry's when none is a
     * call-site kind (`sitePath` -1 when absent, `siteLine` 0 when the evidence names no line);
     * `siteShows` is what that line shows (`SITE_SHOWS`), and is `call` or `reference` only with a
     * line in the caller's own file.
     */
    edges: z.strictObject({
      target: z.array(ref),
      sourceSymbol: z.array(optionalRef),
      sourcePath: z.array(ref),
      family: z.array(
        z
          .int()
          .min(0)
          .max(CALL_FAMILIES.length - 1),
      ),
      resolution: z.array(ref),
      support: z.array(
        z
          .int()
          .min(0)
          .max(SUPPORT_CLASSES.length - 1),
      ),
      sitePath: z.array(optionalRef),
      siteLine: z.array(z.int().min(0)),
      siteShows: z.array(
        z
          .int()
          .min(0)
          .max(SITE_SHOWS.length - 1),
      ),
    }),
    /** Per target id, the call-family edges into it that the support rule did not keep. */
    dropped: z.strictObject({
      target: z.array(ref),
      count: z.array(z.int().positive()),
    }),
    /**
     * Every import specifier Graph classified, once per importing file and specifier, in stream
     * order. `target` is the resolved file or the declaring manifest (-1 for the other kinds);
     * `name` is a declared package's name (-1 when there is none or Graph's rule gives none).
     */
    imports: z.strictObject({
      path: z.array(ref),
      specifier: z.array(ref),
      kind: z.array(
        z
          .int()
          .min(0)
          .max(IMPORT_TARGET_KINDS.length - 1),
      ),
      target: z.array(optionalRef),
      name: z.array(optionalRef),
    }),
  })
  .superRefine((index, context) => {
    const strings = index.strings.length;
    const columns = (
      label: string,
      table: Readonly<Record<string, readonly number[]>>,
      refs: readonly string[],
    ) => {
      const lengths = new Set(
        Object.values(table).map((column) => column.length),
      );
      if (lengths.size > 1)
        context.addIssue({
          code: "custom",
          message: `${label} columns differ in length`,
        });
      for (const name of refs)
        if ((table[name] ?? []).some((value) => value >= strings))
          context.addIssue({
            code: "custom",
            message: `${label}.${name} outside strings`,
          });
    };
    columns("files", index.files, ["path", "language"]);
    columns("symbols", index.symbols, [
      "id",
      "name",
      "qualifiedName",
      "kind",
      "language",
      "path",
      "container",
    ]);
    columns("edges", index.edges, [
      "target",
      "sourceSymbol",
      "sourcePath",
      "resolution",
      "sitePath",
    ]);
    columns("dropped", index.dropped, ["target"]);
    columns("imports", index.imports, ["path", "specifier", "target", "name"]);
    index.imports.kind.forEach((kind, at) => {
      const target = index.imports.target[at] ?? -1;
      const name = index.imports.name[at] ?? -1;
      const withPath =
        IMPORT_TARGET_KINDS[kind] === "file" ||
        IMPORT_TARGET_KINDS[kind] === "declared-package";
      if (
        withPath !== (target !== -1) ||
        (name !== -1 && IMPORT_TARGET_KINDS[kind] !== "declared-package")
      )
        context.addIssue({
          code: "custom",
          message: "import target does not fit its kind",
        });
    });
    index.symbols.startLine.forEach((start, at) => {
      if ((index.symbols.endLine[at] ?? 0) < start)
        context.addIssue({ code: "custom", message: "symbol range reversed" });
    });
    index.edges.siteShows.forEach((shows, at) => {
      if (
        shows !== SHOWS_CALLER &&
        ((index.edges.siteLine[at] ?? 0) === 0 ||
          index.edges.sitePath[at] !== index.edges.sourcePath[at])
      )
        context.addIssue({
          code: "custom",
          message: "a site that shows a place has no line in the caller's file",
        });
    });
  });
export type RelationsIndex = z.infer<typeof RelationsIndex>;

/** The key of one commit's index: the commit, the recipe, the profile and format, and the engine. */
export const relationsSpec = (
  commit: string,
  source: OutlineSource,
): Computations.ComputationSpec => ({
  op: "harness.graph-relations",
  opVersion: 1,
  inputs: { commit: `git-commit:${commit}` },
  config: {
    recipe: RELATIONS_RECIPE,
    profile: "full",
    format: "compact-ndjson-v1",
    source: source.key,
    sourceBinding: GRAPH_SOURCE_BINDING,
  },
});

type RawCall = {
  readonly fromId: string;
  readonly toId: string;
  readonly family: number;
  readonly resolution: string | null;
  readonly sitePath: string | null;
  readonly siteLine: number;
  /** The site is a call-site entry (`GRAPH_CALL_SITE_KINDS`), and its `form`, if any. */
  readonly callSite: boolean;
  readonly form: string | null;
};

/**
 * Gathers what the index needs from a snapshot read as its records arrive, and finishes the index
 * once the read's coverage is known: which languages are semantic is in the summary, and import
 * edges can follow the calls they support, so the support rule is applied at the end. Kept while
 * reading: file paths, every symbol (filtered by tier at the end), the file-to-file `IMPORTS` pairs,
 * each import specifier's target and the call-family edges. Import edges are not stored: no slice
 * needs them once support is set; where each specifier resolves is.
 */
export class RelationsIndexBuilder {
  private readonly fileIds = new Map<string, string>();
  private readonly files: GraphSnapshotFile[] = [];
  private readonly symbols: GraphSnapshotSymbol[] = [];
  private readonly symbolPaths = new Map<string, string>();
  private readonly imports: [string, string][] = [];
  private readonly importTargets: [
    fromId: string,
    specifier: string,
    target: GraphImportTarget,
  ][] = [];
  private readonly calls: RawCall[] = [];

  readonly file = (file: GraphSnapshotFile): void => {
    this.fileIds.set(file.id, file.path);
    this.files.push(file);
  };

  readonly symbol = (symbol: GraphSnapshotSymbol): void => {
    if (!this.symbolPaths.has(symbol.id))
      this.symbolPaths.set(symbol.id, symbol.path);
    this.symbols.push(symbol);
  };

  readonly relation = (relation: GraphSnapshotRelation): void => {
    if (relation.relation === "IMPORTS") {
      this.imports.push([relation.fromId, relation.toId]);
      for (const { importTarget } of relation.evidence)
        if (importTarget !== undefined)
          this.importTargets.push([
            relation.fromId,
            importTarget.specifier,
            importTarget.target,
          ]);
      return;
    }
    const family = CALL_FAMILIES.indexOf(relation.relation as CallFamily);
    if (family === -1) return;
    // The call-site entry is the one a call line is promised on; an edge with none keeps its first
    // entry's location, as before, and shows no place.
    const entry =
      relation.evidence.find((item) => CALL_SITE_KINDS.has(item.kind)) ??
      relation.evidence[0];
    const site = entry?.location;
    this.calls.push({
      fromId: relation.fromId,
      toId: relation.toId,
      family,
      resolution: relation.resolution,
      sitePath: site === undefined || site.kind === "absent" ? null : site.path,
      siteLine:
        site === undefined || site.kind === "absent" || site.kind === "path"
          ? 0
          : site.kind === "point"
            ? site.line
            : site.startLine,
      callSite: entry !== undefined && CALL_SITE_KINDS.has(entry.kind),
      form: entry?.form ?? null,
    });
  };

  async finish(coverage: GraphSnapshotCoverage): Promise<RelationsIndex> {
    const strings: string[] = [];
    const interned = new Map<string, number>();
    const intern = (value: string) => {
      let at = interned.get(value);
      if (at === undefined) {
        at = strings.length;
        strings.push(value);
        interned.set(value, at);
      }
      return at;
    };
    let worked = 0;
    const pace = async () => {
      if (++worked % BUILD_YIELD_ITEMS === 0) await setImmediate();
    };
    const semantic = new Set(
      Object.entries(coverage.languageTiers)
        .filter(([, tier]) => tier === "semantic")
        .map(([language]) => language),
    );
    const files: RelationsIndex["files"] = { path: [], language: [] };
    const fileLanguages = new Map<string, string | null>();
    for (const file of this.files) {
      await pace();
      files.path.push(intern(file.path));
      files.language.push(file.language === null ? -1 : intern(file.language));
      if (!fileLanguages.has(file.path))
        fileLanguages.set(file.path, file.language);
    }
    // The languages whose call lines this snapshot's engine declared: only these show a place.
    const callLines = new Set(coverage.callSiteLineLanguages ?? []);
    const showsOf = (call: RawCall, sourcePath: string) => {
      const language = fileLanguages.get(sourcePath) ?? null;
      if (
        language === null ||
        !callLines.has(language) ||
        !call.callSite ||
        call.siteLine === 0 ||
        call.sitePath !== sourcePath
      )
        return SHOWS_CALLER;
      return call.form === null
        ? SITE_SHOWS.indexOf("call")
        : call.form === "reference"
          ? SITE_SHOWS.indexOf("reference")
          : SHOWS_CALLER;
    };
    const symbols: RelationsIndex["symbols"] = {
      id: [],
      name: [],
      qualifiedName: [],
      kind: [],
      language: [],
      path: [],
      startLine: [],
      endLine: [],
      container: [],
    };
    const kept = new Set<string>();
    // Symbols a same-file name-only match to is not kept (`NAME_ONLY_SAME_FILE_METHODS_NOT_KEPT`).
    const sameFileNameOnlyNotKept = new Set<string>();
    for (const symbol of this.symbols) {
      await pace();
      if (!semantic.has(symbol.language)) continue;
      kept.add(symbol.id);
      if (
        symbol.kind === NAME_ONLY_SAME_FILE_METHODS_NOT_KEPT.kind &&
        (
          NAME_ONLY_SAME_FILE_METHODS_NOT_KEPT.languages as readonly string[]
        ).includes(symbol.language)
      )
        sameFileNameOnlyNotKept.add(symbol.id);
      symbols.id.push(intern(symbol.id));
      symbols.name.push(intern(symbol.name));
      symbols.qualifiedName.push(intern(symbol.qualifiedName));
      symbols.kind.push(intern(symbol.kind));
      symbols.language.push(intern(symbol.language));
      symbols.path.push(intern(symbol.path));
      symbols.startLine.push(symbol.startLine);
      symbols.endLine.push(symbol.endLine);
      symbols.container.push(
        symbol.containerId === null ? -1 : intern(symbol.containerId),
      );
    }
    const imported = new Set<string>();
    for (const [from, to] of this.imports) {
      await pace();
      const fromPath = this.fileIds.get(from);
      const toPath = this.fileIds.get(to);
      if (fromPath !== undefined && toPath !== undefined)
        imported.add(`${fromPath}\0${toPath}`);
    }
    const edges: RelationsIndex["edges"] = {
      target: [],
      sourceSymbol: [],
      sourcePath: [],
      family: [],
      resolution: [],
      support: [],
      sitePath: [],
      siteLine: [],
      siteShows: [],
    };
    const dropped = new Map<string, number>();
    const seen = new Set<string>();
    // Every call-family edge into a kept symbol is kept or counted as dropped, except an exact
    // repeat (same source, target and family): that is the same fact twice, one caller, so only the
    // first is classified and the repeat is neither kept nor counted.
    for (const call of this.calls) {
      await pace();
      if (!kept.has(call.toId)) continue;
      const fact = `${call.fromId}\0${call.toId}\0${call.family}`;
      if (seen.has(fact)) continue;
      seen.add(fact);
      const targetPath = this.symbolPaths.get(call.toId);
      // A source that is neither a file nor a symbol (an external) has no file to judge support by.
      const sourcePath =
        this.fileIds.get(call.fromId) ?? this.symbolPaths.get(call.fromId);
      const support =
        targetPath === undefined || sourcePath === undefined
          ? -1
          : call.resolution !== null && RESOLVED.has(call.resolution)
            ? 0
            : call.resolution !== null &&
                MATCHED.has(call.resolution) &&
                (sourcePath === targetPath ||
                  imported.has(`${sourcePath}\0${targetPath}`)) &&
                !(
                  call.resolution === "name_only" &&
                  sourcePath === targetPath &&
                  sameFileNameOnlyNotKept.has(call.toId)
                )
              ? 1
              : -1;
      if (support === -1 || sourcePath === undefined) {
        dropped.set(call.toId, (dropped.get(call.toId) ?? 0) + 1);
        continue;
      }
      edges.target.push(intern(call.toId));
      edges.sourceSymbol.push(
        this.symbolPaths.has(call.fromId) ? intern(call.fromId) : -1,
      );
      edges.sourcePath.push(intern(sourcePath));
      edges.family.push(call.family);
      edges.resolution.push(intern(call.resolution ?? ""));
      edges.support.push(support);
      edges.sitePath.push(call.sitePath === null ? -1 : intern(call.sitePath));
      edges.siteLine.push(call.siteLine);
      edges.siteShows.push(showsOf(call, sourcePath));
    }
    const droppedTargets = [...dropped]
      .map(([id, count]) => [intern(id), count] as const)
      .sort(([a], [b]) => a - b);
    const imports: RelationsIndex["imports"] = {
      path: [],
      specifier: [],
      kind: [],
      target: [],
      name: [],
    };
    // One answer per importing file and specifier: Graph classifies a specifier by the file and
    // the specifier alone, so a repeat is the same fact and only the first is kept.
    const classified = new Set<string>();
    for (const [fromId, specifier, target] of this.importTargets) {
      await pace();
      const path = this.fileIds.get(fromId);
      if (path === undefined) continue;
      const key = `${path}\0${specifier}`;
      if (classified.has(key)) continue;
      classified.add(key);
      imports.path.push(intern(path));
      imports.specifier.push(intern(specifier));
      imports.kind.push(IMPORT_TARGET_KINDS.indexOf(target.kind));
      imports.target.push(
        target.kind === "file"
          ? intern(target.path)
          : target.kind === "declared-package"
            ? intern(target.manifest)
            : -1,
      );
      imports.name.push(
        target.kind === "declared-package" && target.name !== null
          ? intern(target.name)
          : -1,
      );
    }
    return {
      format: RELATIONS_RECIPE,
      coverage,
      strings,
      files,
      symbols,
      edges,
      dropped: {
        target: droppedTargets.map(([target]) => target),
        count: droppedTargets.map(([, count]) => count),
      },
      imports,
    };
  }
}

/**
 * Reads one commit's snapshot and builds its index. A rejected read leaves nothing: the builder is
 * discarded with whatever it gathered.
 */
export const readRelationsIndex = async (
  request: Parameters<typeof readGraphSnapshot>[0],
): Promise<RelationsIndex> => {
  const builder = new RelationsIndexBuilder();
  const coverage = await readGraphSnapshot(request, builder);
  return builder.finish(coverage);
};

/** No engine, or one without the exact-commit capability. Not stored: the next request asks again. */
export class RelationsUnavailable extends Data.TaggedError(
  "RelationsUnavailable",
)<{ readonly message: string }> {}

/**
 * The read failed. `reason` is graph-client's reason, `source-changed`, or `clone` when the store's
 * private Graph clone could not be made. Not stored either.
 */
export class RelationsReadFailed extends Data.TaggedError(
  "RelationsReadFailed",
)<{ readonly reason: string; readonly message: string }> {}

const relationsFailure = (cause: unknown) =>
  cause instanceof GraphSnapshotError &&
  (cause.reason === "executable-unavailable" ||
    cause.reason === "unsupported-provider")
    ? new RelationsUnavailable({ message: cause.message })
    : new RelationsReadFailed({
        reason:
          cause instanceof GraphSnapshotError ? cause.reason : "unexpected",
        message: cause instanceof Error ? cause.message : String(cause),
      });

/**
 * Rounds now inside their bounded wait for a read, by computation key. A read is waited on while
 * any is; once every wait has ended it falls behind waited-on Graph work in the slot (record 0013).
 */
const waiting = new Map<string, number>();
const waitedOn = (key: string) => () => (waiting.get(key) ?? 0) > 0;
/**
 * Counts `key`'s read as waited on, as a round's bounded wait does, until the returned release is
 * called (once; later calls do nothing): for a durable consumer's wait, the head gate's
 * (`pi/stages/relations-task.ts`).
 */
export const holdWaitedOn = (key: string) => {
  waiting.set(key, (waiting.get(key) ?? 0) + 1);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    const left = (waiting.get(key) ?? 1) - 1;
    if (left > 0) waiting.set(key, left);
    else waiting.delete(key);
  };
};

/**
 * The engine runs in Graph's slot (`withGraphSlot`), the one Graph searches and preparations in
 * this process take, past the heavy-work gate the slot passes: a relations read, a search and the
 * other side's read never hold an engine at once while the slot has one place.
 */
const engineRun = <A, E, R>(
  urgent: () => boolean,
  effect: Effect.Effect<A, E, R>,
) => withGraphSlot(urgent)(cpuWork("graph.relations", effect));

/**
 * Relations reads running in this process that no caller waits for: a round's detached reads, and
 * the review's read its cut-off left running (`holdReadInFlight`). The worker stays up while any
 * runs (`detachedWork`).
 */
let inFlight = 0;
export const relationsReadsInFlight = Effect.sync(() => inFlight);
/**
 * Counts one more read in flight, as a round's detached read counts, until the returned release is
 * called (once; later calls do nothing): for the review's read that goes on past its cut-off
 * (`pi/stages/relations-task.ts`), so the worker does not exit under it.
 */
export const holdReadInFlight = () => {
  inFlight++;
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    inFlight--;
  };
};

/** How a side's index was had, or the gap in its place. */
export type RelationsOutcome =
  | "stored"
  | "computed"
  | "shared"
  | "over-bound"
  | "graph-unavailable"
  | "failed";

/**
 * A side with no index: the wait ended first (`over-bound`; the read goes on and stores its
 * answer), there is no engine or it lacks the capability (`graph-unavailable`), or the read failed
 * (`failed`, with the failure's tag, never its text). The stored-only lookup (`storedRelations`)
 * gives a side that is not stored as `over-bound` with the tag `not-stored` (`NOT_STORED`): what a
 * round with no wait would give, except that no read was started for it.
 */
export type RelationsGap = Readonly<{
  gap: "over-bound" | "graph-unavailable" | "failed";
  tag: string | null;
}>;
export type RelationsSide = RelationsIndex | RelationsGap;
export const isRelationsGap = (side: RelationsSide): side is RelationsGap =>
  "gap" in side;

type ReadResult = Readonly<{
  index: RelationsIndex;
  status: Computations.RunResult["status"];
  bytes: number;
}>;

/** Records the read covered, for telemetry. */
export const relationsRecords = (index: RelationsIndex) =>
  index.coverage.counts.files +
  index.coverage.counts.symbols +
  index.coverage.counts.relations +
  index.coverage.counts.externals;

/**
 * The store's Graph folder, `<store>/graph`: the search runtime's `workDirectory`
 * (`searchRuntimeFrom`), so every relations read (the review's task, a consumer's round and commit
 * preparation's) and Graph search share one private clone per repository.
 */
export const relationsGraphDirectory = (
  location: Readonly<{ directory: string }>,
) => join(location.directory, "graph");

/**
 * The store's private Graph clone of the repository, the one Graph search reads (`graphClone`):
 * the engine refuses to start Git on a repository whose Git directory holds a socket of its own,
 * which the worker's is. `graphDirectory` is the store's Graph folder, `<store>/graph`, the search
 * runtime's `workDirectory` (`searchRuntimeFrom`), so a repository has one clone per store. The
 * clone reads the repository's objects through alternates, so every commit of the repository is
 * readable there; an exact-commit read never reads the clone's HEAD, which searches move.
 */
const relationsClone = (
  repository: string,
  source: OutlineSource,
  graphDirectory: string,
) =>
  graphClone(repository, {
    executable: source.executable,
    workDirectory: graphDirectory,
  }).pipe(
    // `GraphUnavailable`, or `KeyHeld` when the clone's key is held inside a grant: either way
    // there is no clone to read now, and the next request asks again.
    Effect.mapError(
      (cause: GraphUnavailable | KeyHeld) =>
        new RelationsReadFailed({ reason: "clone", message: cause.message }),
    ),
  );

/**
 * One commit's index through the store: found, computed here, or shared with a run another caller
 * started (record 0016's one run per key; every other caller subscribes). A failure is not stored
 * under the key, so the next request runs again. A caller that stops waiting interrupts it, so
 * a review's consumers reach it through `relationsRound`, which runs it detached; the review's
 * relations task (`pi/stages/relations-task.ts`) subscribes directly, so its stop or published
 * packet withdraws a read no other caller wants, while at its cut-off a read in flight goes on to a
 * bound of its own (`CONTINUED_READ_BOUND_MS`). The engine reads the
 * store's private clone (`relationsClone`), made only when the index is computed here.
 */
export const relationsComputation = (
  repository: string,
  commit: string,
  source: OutlineSource,
  graphDirectory: string,
) =>
  computeRelations(
    commit,
    source,
    relationsClone(repository, source, graphDirectory),
  );

/**
 * Records may evict the oldest stored indexes past this many bytes (1 GiB, about 130 indexes of
 * this repository's size); an evicted index reads as not stored and is computed again under the
 * same key (records lane, `records-evictable-outputs`). A store that holds another cap takes this
 * one at the next computation: a new cap is an update (`declareKind`).
 */
export const RELATIONS_CAP_BYTES = 2 ** 30;

const computeRelations = (
  commit: string,
  source: OutlineSource,
  clone: Effect.Effect<string, RelationsReadFailed>,
) =>
  Effect.gen(function* () {
    const store = yield* Computations.ComputationStore;
    const started = performance.now();
    // The index this call computed and the bytes it gave the store, if it computed one.
    let built: RelationsIndex | undefined;
    let produced: Uint8Array | undefined;
    const spec = relationsSpec(commit, source);
    const compute = Effect.gen(function* () {
      if (!("sha256" in source.key))
        return yield* new RelationsUnavailable({
          message: "Graph engine unavailable.",
        });
      const engine = source.key.sha256;
      yield* Effect.try({
        try: () => assertOutlineSource(source),
        catch: () =>
          new RelationsReadFailed({
            reason: "source-changed",
            message: "Graph engine changed before the read.",
          }),
      });
      // Before the slot, as a search's preparation makes it: the clone is not engine work.
      const repository = yield* clone;
      const index = yield* engineRun(
        waitedOn(Computations.computationKey(spec).key),
        Effect.tryPromise({
          try: (signal) =>
            readRelationsIndex({
              repository,
              revision: commit,
              profile: "full",
              executable: source.executable,
              signal,
            }),
          catch: relationsFailure,
        }),
      );
      if (index.coverage.provider.executable.sha256 !== engine)
        return yield* new RelationsReadFailed({
          reason: "source-changed",
          message: "Graph engine changed during the read.",
        });
      built = index;
      produced = new TextEncoder().encode(JSON.stringify(index));
      return { bytes: produced, mediaType: "application/json" };
    });
    // Every process that computes an index passes here; the same cap again only reads, a new one
    // updates the store's. A declaration that fails leaves the cap as it was; the read still runs,
    // and the failure is said once, by its tag.
    yield* store
      .declareKind({ op: spec.op, capBytes: RELATIONS_CAP_BYTES })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            `harness.graph-relations: the cap of ${RELATIONS_CAP_BYTES} bytes was not declared: ${tagOf(error) ?? "error"}`,
          ),
        ),
      );
    // A failure published by a run another caller held (`SharedAttemptFailed`; a run this caller
    // held fails with its own cause) is asked once more: a holder that is stopped while others
    // are joined, as the worker stops its preparation child, publishes its own stop as the run's
    // failure, and the joined callers would keep that gap although nothing is wrong with the
    // read. The second ask holds or joins a fresh run. Exactly once, at once: a second failure is
    // returned as it is. When the other holder's failure was real, this costs one more engine run.
    // Every caller (the review's task, a consumer's round, commit preparation) comes through here.
    const result = yield* store
      .run(spec, compute)
      .pipe(
        Effect.catchTag("SharedAttemptFailed", () => store.run(spec, compute)),
      );
    // What a caller gets is what the store holds. The computed object is that only when the store
    // bound the very bytes this call produced: at the floor of shared work another process may
    // have bound its own output for the key first, and the store answers this run with that
    // output, still as `computed`. Then the stored output is decoded like any stored read.
    const own =
      result.status === "computed" &&
      built !== undefined &&
      produced !== undefined &&
      Buffer.from(
        produced.buffer,
        produced.byteOffset,
        produced.byteLength,
      ).equals(
        Buffer.from(
          result.output.buffer,
          result.output.byteOffset,
          result.output.byteLength,
        ),
      )
        ? built
        : undefined;
    if (own !== undefined)
      holdRelationsIndex(
        result.computation.key,
        result.computation.outputHash,
        own,
      );
    const blobs = yield* Effect.serviceOption(Blobs.BlobStore);
    const index =
      own !== undefined
        ? own
        : yield* loadRelationsIndex(
            loadScope(Option.getOrUndefined(blobs)),
            result.computation.key,
            result.computation.outputHash,
            Effect.succeed(result.output),
          ).pipe(
            // Joined to a lookup's load of the same output, this read meets that load's failure.
            Effect.mapError((failure) =>
              failure instanceof RelationsReadFailed
                ? failure
                : new RelationsReadFailed({
                    reason: failure._tag,
                    message: failure.message,
                  }),
            ),
            Effect.flatMap((loaded) =>
              Option.isSome(loaded)
                ? Effect.succeed(loaded.value)
                : Effect.fail(
                    new RelationsReadFailed({
                      reason: "invalid-stored-output",
                      message: "The stored output is gone.",
                    }),
                  ),
            ),
          );
    const read: ReadResult = {
      index,
      status: result.status,
      bytes: result.output.byteLength,
    };
    return { read, wallMs: performance.now() - started };
  }).pipe((effect) =>
    step("harness.graph.relations.read", effect, ({ read, wallMs }) => ({
      "harness.graph.relations.status": read.status,
      "harness.graph.relations.wall_ms": Math.round(wallMs),
      "harness.graph.relations.records": relationsRecords(read.index),
      "harness.graph.relations.index_bytes": read.bytes,
    })),
  );

const tagOf = (value: unknown): string | null =>
  typeof value === "object" && value !== null && "_tag" in value
    ? String(value._tag)
    : null;

/** The gap a failed read leaves (`relationsComputation`'s cause), with its tag, never its text. */
export const relationsGapOf = <E>(cause: Cause.Cause<E>): RelationsGap => {
  const error = Cause.findErrorOption(cause);
  if (Option.isNone(error))
    return {
      gap: "failed",
      tag: Cause.hasInterruptsOnly(cause) ? "Interrupted" : "Defect",
    };
  const failure = error.value;
  if (failure instanceof RelationsUnavailable)
    return { gap: "graph-unavailable", tag: null };
  if (failure instanceof RelationsReadFailed)
    return { gap: "failed", tag: failure.reason };
  if (failure instanceof Computations.SharedAttemptFailed)
    return failure.tag === "RelationsUnavailable"
      ? { gap: "graph-unavailable", tag: null }
      : { gap: "failed", tag: failure.tag };
  return { gap: "failed", tag: tagOf(failure) ?? "Error" };
};

/**
 * How many indexes this process keeps: two, what one review needs. A review reads its head and its
 * merge base and nothing else (the review's relations task, `relationsRound` for the sections'
 * rules, the readers' `storedRelations`), and the worker runs one review at a time; commit
 * preparation reads its commit and merge base in a process of its own. Measured at this
 * repository's 420-commit head (7.9 MB stored): a held index is about 12 MB of heap, and once
 * sliced it keeps its view, about 29 MB more, so two cost about 82 MB. An index evicted is only
 * decoded again (about 0.3 s at this size).
 */
export const DECODED_RELATIONS_HELD = 2;

/**
 * Indexes by computation key and stored output hash, least recently used first: each one decoded
 * from the store, or computed in this process when the store bound exactly the bytes it produced
 * (the computed object is equal to what decoding those bytes gives, so it is held rather than
 * decoded again; when the store bound another process's output instead, that output is decoded). A
 * computation's key names the commit, the recipe, the engine's identity and its source binding
 * (`relationsSpec`), so another engine or recipe never meets an entry; the hash keeps apart two
 * stores that hold different bytes under one key (two clones' repository keys, say), and both are
 * held at once within the bound. A load that fails is never held.
 *
 * One answer differs from reading the store each time: the computation's row is always read
 * first, but while its index is held the blob is not, so a blob that was removed or damaged after
 * the index was held still gives the held index, which is equal to what the blob held. Once the
 * index is evicted, or in another process, that side is a gap again, as before (`failed` with the
 * store's error, or not stored).
 *
 * The held indexes are not frozen: freezing a real index's arrays cost about 190 ms and 29 MB of
 * heap at this size, more than half a decode, so no caller may change an index it was given (none
 * does). The slicing view freezes the few arrays it shares with its index (`relations-slices.ts`).
 */
const decoded = new Map<string, RelationsIndex>();
const heldKey = (key: string, hash: string) => `${key}\0${hash}`;
/** Decodes this process attempted (tests observe it, never a time). */
let decodes = 0;
export const relationsIndexDecodes = Effect.sync(() => decodes);

/** The index held decoded for this key and output hash, now the most recently used; or none. */
const heldRelationsIndex = (
  key: string,
  hash: string,
): RelationsIndex | undefined => {
  const at = heldKey(key, hash);
  const index = decoded.get(at);
  if (index === undefined) return undefined;
  decoded.delete(at);
  decoded.set(at, index);
  return index;
};

/** Holds an index, evicting the least recently used past `DECODED_RELATIONS_HELD`. */
const holdRelationsIndex = (
  key: string,
  hash: string,
  index: RelationsIndex,
) => {
  const at = heldKey(key, hash);
  decoded.delete(at);
  decoded.set(at, index);
  for (const oldest of decoded.keys()) {
    if (decoded.size <= DECODED_RELATIONS_HELD) break;
    decoded.delete(oldest);
  }
};

/**
 * Drops every index held decoded, so the next lookup of a key reads and decodes its stored bytes
 * again. The review task calls it when the last review running in this process ends
 * (`pi/review-task.ts`), so a worker holds no relations index between reviews.
 *
 * What stays: an index, with the slicing view it keeps (`relations-slices.ts`), lives while a
 * caller holds it; a load already running gives its callers its index and holds it when it ends;
 * the store and its stored outputs are not touched. It is synchronous and cannot throw.
 */
export const releaseRelationsCache = (): void => {
  decoded.clear();
};

/** Why loading a stored index failed: the store's read of its bytes, or bytes that do not decode. */
type RelationsLoadFailure =
  | RelationsReadFailed
  | Store.StoreError
  | Blobs.BlobMissing
  | Blobs.BlobCorrupt;

/**
 * Loads of a stored index running in this process, one per store, key and output hash (record
 * 0016, in process only: the stored blob is already the result every process shares). Lookups
 * (`storedRelations`, the round's stored read) that ask together subscribe to one run, so they
 * read the bytes once, decode once and get the same index object. The computation's stored read
 * has its bytes already, read by the store's `run` for each caller before it joins, so for it the
 * shared part is the decode, not the read. A subscriber that stops leaves the run to the others;
 * the run stops when the last one leaves. A failed run is not kept: the next caller runs again.
 * A run is shared only within one store (`loadScope`), so a caller never meets another store's
 * read of its bytes; decoded indexes are still shared across stores by key and hash (`decoded`).
 */
const relationsLoads = new SharedWork<
  RelationsIndex | undefined,
  RelationsLoadFailure
>();

/**
 * The run's scope: the store whose blobs it reads, by the identity of its blob service in this
 * process (one per opened store). No blob service (never, beside a computation store) is one
 * scope of its own.
 */
const storeScopes = new WeakMap<object, string>();
let storesSeen = 0;
const loadScope = (blobs: object | undefined) => {
  if (blobs === undefined) return "harness.graph-relations.decoded";
  let scope = storeScopes.get(blobs);
  if (scope === undefined) {
    scope = `harness.graph-relations.decoded/${++storesSeen}`;
    storeScopes.set(blobs, scope);
  }
  return scope;
};

/**
 * The index stored under `key` with output `hash`, always through `relationsLoads`: held, else read
 * and decoded.
 * `bytes` reads the stored output, or gives none when it is gone; it runs once per load, in the run
 * of whichever caller started it. None when the output is gone. Bytes that do not decode are
 * `RelationsReadFailed` (`invalid-stored-output`).
 */
const loadRelationsIndex = <R>(
  scope: string,
  key: string,
  hash: string,
  bytes: Effect.Effect<Uint8Array | undefined, RelationsLoadFailure, R>,
) =>
  sharedWorkEffect(relationsLoads, {
    scope,
    key: heldKey(key, hash),
    run: () =>
      Effect.gen(function* () {
        // The one look at the held indexes, inside the run: a caller never checks outside it,
        // so no load can end between a caller's look and its joining a run.
        const held = heldRelationsIndex(key, hash);
        if (held !== undefined)
          return { kind: "succeeded" as const, value: held };
        const read = yield* bytes;
        if (read === undefined)
          return { kind: "succeeded" as const, value: undefined };
        decodes++;
        const index = yield* Effect.try({
          try: () => decodeJson(read, RelationsIndex),
          catch: (cause) =>
            new RelationsReadFailed({
              reason: "invalid-stored-output",
              message: String(cause),
            }),
        });
        holdRelationsIndex(key, hash, index);
        return { kind: "succeeded" as const, value: index };
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed({ kind: "failed" as const, error }),
        ),
      ),
  }).pipe(
    // A load holds no claim and waits on no other shared work, so joining one from inside a
    // grant (commit preparation's computation read) cannot deadlock: never refuse it as held.
    Effect.provideService(InsideSharedWorkGrant, false),
    Effect.catchTag(["KeyHeld", "SharedWorkError"], Effect.die),
    Effect.map(({ value }) => Option.fromUndefinedOr(value)),
  );

/**
 * One commit's index as stored under its key (`relationsSpec`), or none: never a read, a clone or
 * an engine. A stored output that does not decode is `RelationsReadFailed` (`invalid-stored-output`).
 * Its bytes are read and decoded once per key and output hash while the index is held, and once for
 * every caller of this store asking at the same time (`loadRelationsIndex`). Bytes missing or
 * damaged because Records evicted the index after its row was read (`evictedMeanwhile`, the
 * records lane's contract for a kind declared recomputable) are none, a miss; any other missing or
 * damaged bytes stay the store's error.
 */
const storedRelationsIndex = (commit: string, source: OutlineSource) =>
  Effect.gen(function* () {
    const store = yield* Computations.ComputationStore;
    const blobs = yield* Blobs.BlobStore;
    const key = Computations.computationKey(relationsSpec(commit, source)).key;
    const computation = (yield* store.lookupMany([key])).get(key);
    if (computation === undefined) return Option.none<RelationsIndex>();
    const hash = computation.outputHash;
    const evictedOr = (
      error: Blobs.BlobMissing | Blobs.BlobCorrupt,
    ): Effect.Effect<undefined, RelationsLoadFailure> =>
      Effect.flatMap(store.evictedMeanwhile(computation), (evicted) =>
        evicted ? Effect.succeed(undefined) : Effect.fail(error),
      );
    return yield* loadRelationsIndex(
      loadScope(blobs),
      key,
      hash,
      blobs.getMany([hash]).pipe(
        Effect.map((reads) => {
          const read = reads.get(hash);
          return read === undefined || read._tag === "Pruned"
            ? undefined
            : read.bytes;
        }),
        Effect.catchTags({ BlobMissing: evictedOr, BlobCorrupt: evictedOr }),
      ),
    );
  }).pipe(
    Effect.catchDefect((cause) =>
      Effect.fail(
        new RelationsReadFailed({
          reason: "invalid-stored-output",
          message: String(cause),
        }),
      ),
    ),
  );

export type RelationsRound = Readonly<{
  base: RelationsSide;
  head: RelationsSide;
  outcomes: Readonly<{ base: RelationsOutcome; head: RelationsOutcome }>;
}>;

/**
 * The relations of a review's base and head commits. Stored answers are read first; each side not
 * stored starts its read detached, head first, and the round waits once for both, up to `waitMs`
 * (the harness's Graph wait by default). A side the wait did not see finish is `over-bound`: its
 * read keeps running and stores its answer for the next request, and the worker stays up for it
 * (`relationsReadsInFlight`). A caller that stops waiting does not stop a read either. It never
 * fails: what it could not read is a gap. The engine reads the store's private clone of
 * `repository`, never the repository itself; a clone that cannot be made is the gap `failed` with
 * tag `clone`.
 */
export const relationsRound = (
  input: Readonly<{
    repository: string;
    /** The store's Graph folder, `<store>/graph`: the search runtime's `workDirectory`. */
    graphDirectory: string;
    base: string;
    head: string;
    source: OutlineSource;
    waitMs?: number;
  }>,
) =>
  Effect.gen(function* () {
    const waitMs = input.waitMs ?? GRAPH_DEADLINE_MS;
    const begun = performance.now();
    const sides = [
      ["head", input.head],
      ["base", input.base],
    ] as const;
    const found = new Map<
      string,
      Readonly<{
        side: RelationsSide;
        outcome: RelationsOutcome;
        wallMs: number;
      }>
    >();
    if (!("sha256" in input.source.key)) {
      for (const [, commit] of sides)
        found.set(commit, {
          side: { gap: "graph-unavailable", tag: null },
          outcome: "graph-unavailable",
          wallMs: 0,
        });
    } else
      for (const [, commit] of sides) {
        if (found.has(commit)) continue;
        const stored = yield* Effect.exit(
          storedRelationsIndex(commit, input.source),
        );
        if (Exit.isSuccess(stored) && Option.isSome(stored.value))
          found.set(commit, {
            side: stored.value.value,
            outcome: "stored",
            wallMs: performance.now() - begun,
          });
      }
    const completed = new Map<
      string,
      Exit.Exit<
        Effect.Success<ReturnType<typeof relationsComputation>>,
        Effect.Error<ReturnType<typeof relationsComputation>>
      >
    >();
    const finishedAt = new Map<string, number>();
    const pending: string[] = [];
    const ended: Deferred.Deferred<void>[] = [];
    const waited: string[] = [];
    // Uninterruptible, so every key counted as waited on is released below and every read counted
    // in flight ends. One detached starter finds or makes the store's private clone once for the
    // round's reads, then forks them, head first, so head still asks for the slot first.
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        for (const [, commit] of sides) {
          if (found.has(commit) || pending.includes(commit)) continue;
          pending.push(commit);
          const key = Computations.computationKey(
            relationsSpec(commit, input.source),
          ).key;
          waiting.set(key, (waiting.get(key) ?? 0) + 1);
          waited.push(key);
          inFlight++;
          ended.push(Deferred.makeUnsafe<void>());
        }
        if (pending.length === 0) return;
        const end = (at: number) => {
          inFlight--;
          const done = ended[at];
          if (done !== undefined) Deferred.doneUnsafe(done, Exit.void);
        };
        // Reads the starter forked; one it never forked (it was interrupted first) ends with it.
        let forked = 0;
        yield* Effect.forkDetach(
          Effect.gen(function* () {
            // The clone's answer, success or failure; a read uses it only if it computes.
            const clone = yield* Effect.exit(
              relationsClone(
                input.repository,
                input.source,
                input.graphDirectory,
              ),
            );
            for (const [at, commit] of pending.entries()) {
              yield* Effect.forkDetach(
                Effect.exit(computeRelations(commit, input.source, clone)).pipe(
                  Effect.flatMap((exit) =>
                    Effect.sync(() => {
                      completed.set(commit, exit);
                      finishedAt.set(commit, performance.now() - begun);
                    }),
                  ),
                  Effect.ensuring(Effect.sync(() => end(at))),
                ),
              );
              forked++;
            }
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                for (let at = forked; at < pending.length; at++) end(at);
              }),
            ),
          ),
        );
      }),
    );
    // The wait ends, by time, by both reads ending or by the caller stopping: this round no longer
    // waits on them, and a read nobody waits on falls behind waited-on Graph work.
    yield* (
      ended.length > 0
        ? Effect.asVoid(
            Effect.forEach(ended, Deferred.await).pipe(
              Effect.timeoutOption(waitMs),
            ),
          )
        : Effect.void
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          for (const key of waited) {
            const left = (waiting.get(key) ?? 1) - 1;
            if (left > 0) waiting.set(key, left);
            else waiting.delete(key);
          }
        }),
      ),
    );
    const sideOf = (commit: string) => {
      const known = found.get(commit);
      if (known !== undefined) return known;
      const exit = completed.get(commit);
      const wallMs = finishedAt.get(commit) ?? performance.now() - begun;
      if (exit === undefined)
        return {
          side: { gap: "over-bound", tag: null } as const,
          outcome: "over-bound" as const,
          wallMs,
        };
      if (Exit.isSuccess(exit))
        return {
          side: exit.value.read.index,
          outcome:
            exit.value.read.status === "reused"
              ? ("stored" as const)
              : exit.value.read.status,
          wallMs,
          bytes: exit.value.read.bytes,
        };
      const gap = relationsGapOf(exit.cause);
      return { side: gap, outcome: gap.gap, wallMs };
    };
    const head = sideOf(input.head);
    const base = sideOf(input.base);
    for (const [name, side] of [
      ["head", head],
      ["base", base],
    ] as const)
      yield* step("harness.graph.relations.side", Effect.void, () => ({
        "harness.graph.relations.side": name,
        "harness.graph.relations.outcome": side.outcome,
        "harness.graph.relations.wall_ms": Math.round(side.wallMs),
        ...(isRelationsGap(side.side)
          ? side.side.tag === null
            ? {}
            : { "harness.graph.relations.failure": side.side.tag }
          : {
              "harness.graph.relations.records": relationsRecords(side.side),
              ...("bytes" in side
                ? { "harness.graph.relations.index_bytes": side.bytes }
                : {}),
            }),
      }));
    return {
      base: base.side,
      head: head.side,
      outcomes: { base: base.outcome, head: head.outcome },
    };
  }).pipe((effect) =>
    step("harness.graph.relations.round", effect, (round) => ({
      "harness.graph.relations.wait_ms": input.waitMs ?? GRAPH_DEADLINE_MS,
      "harness.graph.relations.head.outcome": round.outcomes.head,
      "harness.graph.relations.base.outcome": round.outcomes.base,
    })),
  );

/** The tag of a side `storedRelations` found not stored (gap `over-bound`): no read was started. */
export const NOT_STORED = "not-stored";

/**
 * Both sides of a range from the store only, the shape `relationSlices` takes: each side is its
 * stored index, or a gap. It never starts a read, a clone or an engine, and never waits; it reads
 * the same keys as a round (`relationsSpec`), so an index stored under an older recipe is not
 * found. A side not stored is `{ gap: "over-bound", tag: "not-stored" }`; with no engine, or one
 * whose identity is unknown, both sides are `graph-unavailable`, as in a round; a store that cannot
 * be read, or a stored output that does not decode, is `failed` with its tag. Never fails.
 */
export const storedRelations = (
  input: Readonly<{
    base: string;
    head: string;
    source: OutlineSource;
  }>,
) =>
  Effect.gen(function* () {
    if (!("sha256" in input.source.key)) {
      const unavailable: RelationsGap = {
        gap: "graph-unavailable",
        tag: null,
      };
      return { base: unavailable, head: unavailable };
    }
    const side = (commit: string) =>
      Effect.map(
        Effect.exit(storedRelationsIndex(commit, input.source)),
        (exit): RelationsSide =>
          Exit.isFailure(exit)
            ? relationsGapOf(exit.cause)
            : Option.isSome(exit.value)
              ? exit.value.value
              : { gap: "over-bound", tag: NOT_STORED },
      );
    const head = yield* side(input.head);
    const base = input.base === input.head ? head : yield* side(input.base);
    return { base, head };
  }).pipe((effect) =>
    step(
      "harness.graph.relations.lookup",
      effect,
      (sides: Readonly<{ base: RelationsSide; head: RelationsSide }>) => {
        const outcome = (side: RelationsSide) =>
          isRelationsGap(side)
            ? side.tag === NOT_STORED
              ? NOT_STORED
              : side.gap
            : "stored";
        return {
          "harness.graph.relations.head.outcome": outcome(sides.head),
          "harness.graph.relations.base.outcome": outcome(sides.base),
        };
      },
    ),
  );
