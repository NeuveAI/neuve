import { Data } from "effect";
import { z } from "zod";
import {
  GRAPH_CALL_SITE_KINDS,
  type GraphLocation,
  type GraphProviderObservation,
  type GraphSnapshotCoverage,
  type GraphSnapshotEvidence,
  type GraphSnapshotFile,
  type GraphSnapshotRelation,
  type GraphSnapshotSymbol,
  type SourcePath,
} from "./domain.ts";
import { graphRefusesSourcePath } from "./symbols.ts";

/**
 * The decoder of Graph's compact snapshot (`snapshot --format compact-ndjson`, "Compact snapshot
 * NDJSON v1" in `apps/neuve-graph/docs/snapshot-format.md`, encoded by `CompactSnapshotEncoder` and
 * loaded by `DecodeCompactSnapshot` in `apps/neuve-graph/internal/sem/compact_snapshot.go`). It is
 * fed one line at a time and keeps only the string dictionary and one bit per dictionary entry, so
 * the caller's sink decides what of the stream is kept. `readGraphSnapshot` in `index.ts` runs the
 * engine and feeds it.
 */

export class GraphSnapshotError extends Data.TaggedError("GraphSnapshotError")<{
  readonly reason:
    | "executable-unavailable"
    | "command"
    | "invalid-output"
    | "incomplete"
    | "cancelled"
    | "deadline"
    | "input"
    | "unsupported-provider"
    /** The caller's sink threw while a record was delivered. */
    | "sink";
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** The engine's capability key for `--commit` on `snapshot`, `symbols` and `edges`. */
export const GRAPH_EXACT_COMMIT_STREAMS = "exact_commit_bulk_streams";
/** The engine's capability key for the compact snapshot format. */
export const GRAPH_COMPACT_SNAPSHOT = "compact_snapshot_ndjson_v1";
/** The compact envelope's own version, the second field of the header row. */
export const COMPACT_SNAPSHOT_FORMAT_VERSION = 1;
/** The record schema this decoder knows: major 1 through minor 4 (Graph's `SchemaVersion`). */
const KNOWN_SCHEMA = { major: 1, minor: 4 } as const;
/** The minor that added an evidence entry's optional sixth element, `form`. */
const FORM_SCHEMA_MINOR = 4;
/** Every line but the summary, as the engine's decoder bounds it. */
export const SNAPSHOT_RECORD_LINE_BYTES = 16 * 1024 * 1024;
/** The summary's allowance, which the engine's encoder also refuses to pass. */
export const SNAPSHOT_SUMMARY_LINE_BYTES = 128 * 1024 * 1024;

export const GRAPH_SUBMODULE_NOT_READ = "W_SUBMODULE_NOT_READ";
export const GRAPH_GO_BUILD_EXCLUDED = "W_GO_BUILD_EXCLUDED";

export type GraphSnapshotSink = Readonly<{
  file?: (file: GraphSnapshotFile) => void;
  symbol: (symbol: GraphSnapshotSymbol) => void;
  relation: (relation: GraphSnapshotRelation) => void;
}>;

const strings = z
  .array(z.string())
  .nullable()
  .transform((value) => value ?? []);
const count = z.int().nonnegative();
const Warning = z.looseObject({
  code: z.string().min(1),
  file_path: z.string().optional(),
  detail: z.string().optional(),
});
const Failure = z.looseObject({
  code: z.string().min(1),
  file_path: z.string().optional(),
});
// Provider payloads: known fields validated, additive ones ignored (schema 1.x is additive only).
const snapshotSchemas = {
  header: z.looseObject({
    schema_version: z.string(),
    provider: z.string(),
    provider_version: z.string(),
    identity_revision: z.string().optional(),
    repo_root: z.string(),
    repo_key: z.string(),
    commit: z.string(),
    tree: z.string(),
    profile: z.string(),
    relation_set: strings,
    skipped_relation_families: strings,
  }),
  summary: z.looseObject({
    record_type: z.literal("summary"),
    languages: strings,
    language_tiers: z.record(z.string(), z.string()).optional(),
    warnings: z.array(Warning).nullable(),
    partial_failures: z.array(Failure).nullable(),
    stats: z.looseObject({
      files: count,
      parsed_files: count,
      symbols: count,
      relations: count,
      partial_failures: count,
      completeness_level: z.string(),
    }),
    completeness: z.looseObject({
      health: z.looseObject({ status: z.string() }).optional(),
    }),
  }),
};

const OBJECT_ID = /\b(?:[0-9a-f]{40}|[0-9a-f]{64})\b/;
const FULL_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

class Malformed extends Error {}
const malformed = (message: string): never => {
  throw new Malformed(message);
};

const integer = (value: unknown, label: string, minimum = 0): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
    ? value
    : malformed(`${label} must be an integer of at least ${minimum}.`);

const safePath = (path: string, label: string): string =>
  graphRefusesSourcePath(path)
    ? malformed(`${label} is not a safe path.`)
    : path;

export type CompactSnapshotExpectation = Readonly<{
  provider: GraphProviderObservation;
  /** The exact commit asked for; the header must name it. */
  revision: string;
  profile: "full";
  /** The repository path given to the engine; the header's `repo_root` must equal it. */
  repository: string;
  /**
   * The languages of `import_target_classification`, or null when the engine does not declare it:
   * then no relation may carry an import target entry.
   */
  importTargetLanguages?: readonly string[] | null;
  /**
   * The languages of `call_site_lines`, or null (or absent) when the engine does not declare it:
   * then no evidence entry may carry a `form`.
   */
  callSiteLineLanguages?: readonly string[] | null;
}>;

/** The engine's capability key for import targets on `IMPORTS` relations. */
export const GRAPH_IMPORT_TARGETS = "import_target_classification";
/**
 * The engine's capability key for call lines: a call relation's call-site entry carries the line
 * where the target's name is written in the caller, and `form: "reference"` where that line hands
 * the target over by name ("Call-site evidence" in Graph's `docs/snapshot-format.md`).
 */
export const GRAPH_CALL_SITE_LINES = "call_site_lines";
/** The forms schema 1.4 defines for a call-site entry. */
const CALL_SITE_FORMS = new Set(["reference"]);
const CALL_SITE_KINDS = new Set<string>(GRAPH_CALL_SITE_KINDS);
const CALL_RELATIONS = new Set(["CALLS", "CONSTRUCTS", "ASYNC_CALLS"]);

const IMPORT_TARGET_KINDS = {
  import_target_file: "file",
  import_target_declared_package: "declared-package",
  import_target_builtin: "builtin",
  import_target_unresolved: "unresolved",
  import_target_not_classified: "not-classified",
} as const;
const isImportTargetKind = (
  kind: string,
): kind is keyof typeof IMPORT_TARGET_KINDS => kind in IMPORT_TARGET_KINDS;

/**
 * A declared package's name, as Graph's import target rules match it (`classifyJS`,
 * `classifyPython` in `internal/sem/importtargets.go`): the package part of the specifier, by the
 * manifest that declared it. Go's rule is the required module that prefixes the path, which the
 * stream does not carry, so it has none.
 */
const declaredPackageName = (
  specifier: string,
  manifest: string,
): string | null => {
  const base = manifest.slice(manifest.lastIndexOf("/") + 1);
  if (base === "package.json") {
    const [first = "", second = ""] = specifier.split("/");
    if (!first.startsWith("@")) return first === "" ? null : first;
    return first.length > 1 && second !== "" ? `${first}/${second}` : null;
  }
  if (base === "pyproject.toml" || /^requirements[^/]*\.txt$/.test(base)) {
    const top = specifier.split(".")[0] ?? "";
    return top === "" ? null : top;
  }
  return null;
};

/**
 * Validates and decodes a compact snapshot as it arrives. `line` takes one line without its line
 * ending and delivers each decoded record to the sink before it returns; `finish` returns the
 * coverage once the summary validated, and refuses a stream that ended without one.
 *
 * A relation's endpoints must be ids the stream declares, before or after the relation (an external
 * endpoint follows the relations that name it). Ids are dictionary strings, so this is one bit per
 * dictionary entry and a set of the ids referenced but not yet declared; the summary is refused
 * while that set is not empty. No second pass and nothing of the stream is kept for it.
 */
export class CompactSnapshotDecoder {
  private readonly dictionary: string[] = [""];
  private readonly known = new Set<string>([""]);
  private declared = new Uint8Array(1024);
  private readonly forward = new Set<number>();
  /** Dictionary indices of the ids of Python file records, for the relative-module exception. */
  private readonly pythonFiles = new Set<number>();
  private header: z.infer<typeof snapshotSchemas.header> | undefined;
  private coverage: GraphSnapshotCoverage | undefined;
  private newerMinor = false;
  /** The header's schema minor. */
  private minor = 0;
  private skippedRows = 0;
  private lines = 0;
  private readonly rows = { files: 0, externals: 0, symbols: 0, relations: 0 };

  constructor(
    private readonly expected: CompactSnapshotExpectation,
    private readonly sink: GraphSnapshotSink,
  ) {}

  /** Lines read so far, the header and dictionary rows included. */
  get linesRead(): number {
    return this.lines;
  }

  line(text: string): void {
    try {
      this.read(text);
    } catch (cause) {
      if (cause instanceof GraphSnapshotError) throw cause;
      throw new GraphSnapshotError({
        reason: "invalid-output",
        message: `Invalid Graph compact snapshot at line ${this.lines}.`,
        cause,
      });
    }
  }

  finish(): GraphSnapshotCoverage {
    if (this.coverage === undefined)
      throw new GraphSnapshotError({
        reason: "incomplete",
        message: "Graph compact snapshot ended without its summary.",
      });
    return this.coverage;
  }

  private read(text: string): void {
    this.lines++;
    if (this.coverage !== undefined) malformed("Record after the summary.");
    if (text.length === 0) malformed("Blank line.");
    const row: unknown = JSON.parse(text);
    if (!Array.isArray(row) || typeof row[0] !== "string")
      return malformed("A line must be an array that starts with its tag.");
    const tag = row[0];
    if (this.header === undefined) {
      if (tag !== "h" || this.lines !== 1)
        malformed("The header must be the first line.");
      return this.readHeader(row);
    }
    switch (tag) {
      case "h":
        return malformed("A second header.");
      case "d":
        return this.readDictionary(row);
      case "f":
        return this.readFile(row);
      case "x":
        return this.readExternal(row);
      case "s":
        return this.readSymbol(row);
      case "r":
        return this.readRelation(row);
      case "m":
        return this.readSummary(row);
      default:
        // A newer minor may add record kinds; their rows are skipped and counted.
        if (this.newerMinor && tag !== "") {
          this.skippedRows++;
          return;
        }
        return malformed(`Unknown tag ${JSON.stringify(tag)}.`);
    }
  }

  private readHeader(row: unknown[]): void {
    if (row.length !== 3) malformed("Header arity must be 3.");
    if (row[1] !== COMPACT_SNAPSHOT_FORMAT_VERSION)
      malformed(`Unsupported compact format version ${String(row[1])}.`);
    const header = snapshotSchemas.header.parse(row[2]);
    const version = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(header.schema_version);
    if (version === null || Number(version[1]) !== KNOWN_SCHEMA.major)
      malformed(`Unsupported schema version ${header.schema_version}.`);
    const { provider } = this.expected;
    if (
      header.provider !== provider.name ||
      header.provider_version !== provider.version ||
      header.identity_revision !== provider.identityRevision ||
      header.schema_version !== provider.capabilities.schemaVersion
    )
      malformed("Header identity differs from the qualified executable.");
    if (header.repo_root !== this.expected.repository)
      malformed("Header names another repository.");
    if (header.commit !== this.expected.revision)
      malformed("Header names another commit.");
    if (!FULL_OBJECT_ID.test(header.tree)) malformed("Header tree is invalid.");
    if (header.profile !== this.expected.profile)
      malformed("Header names another profile.");
    this.minor = Number(version?.[2]);
    this.newerMinor = this.minor > KNOWN_SCHEMA.minor;
    this.header = header;
  }

  private readDictionary(row: unknown[]): void {
    if (row.length !== 3) malformed("Dictionary arity must be 3.");
    if (row[1] !== this.dictionary.length)
      malformed("Dictionary base does not continue the dictionary.");
    const values = row[2];
    if (!Array.isArray(values) || values.length === 0)
      return malformed("Dictionary update must add strings.");
    for (const value of values) {
      if (typeof value !== "string" || value === "")
        malformed("Dictionary values must be non-empty strings.");
      if (this.known.has(value)) malformed("Dictionary repeats a string.");
      this.known.add(value);
      this.dictionary.push(value);
    }
    if (this.dictionary.length > this.declared.length) {
      const grown = new Uint8Array(
        Math.max(this.dictionary.length, this.declared.length * 2),
      );
      grown.set(this.declared);
      this.declared = grown;
    }
  }

  private arity(row: unknown[], fields: number, label: string, alt = fields) {
    if (
      row.length < fields ||
      (!this.newerMinor && row.length !== fields && row.length !== alt)
    )
      malformed(`${label} arity ${row.length}.`);
  }

  /** A dictionary index, validated. */
  private index(value: unknown, label: string): number {
    const at = integer(value, label);
    if (at >= this.dictionary.length)
      malformed(`${label} is outside the dictionary.`);
    return at;
  }

  private text(value: unknown, label: string): string {
    return this.dictionary[this.index(value, label)] ?? "";
  }

  private required(value: unknown, label: string): string {
    const text = this.text(value, label);
    return text === "" ? malformed(`${label} is missing.`) : text;
  }

  private declare(value: unknown, label: string): string {
    const at = this.index(value, label);
    if (at === 0) malformed(`${label} is missing.`);
    this.declared[at] = 1;
    this.forward.delete(at);
    return this.dictionary[at] ?? "";
  }

  private endpoint(value: unknown, label: string): string {
    const at = this.index(value, label);
    if (at === 0) malformed(`${label} is missing.`);
    if (this.declared[at] !== 1) this.forward.add(at);
    return this.dictionary[at] ?? "";
  }

  private deliver(run: () => void): void {
    try {
      run();
    } catch (cause) {
      throw new GraphSnapshotError({
        reason: "sink",
        message: "The snapshot sink failed.",
        cause,
      });
    }
  }

  private readFile(row: unknown[]): void {
    this.arity(row, 6, "File");
    const id = this.declare(row[1], "File id");
    const path = safePath(this.required(row[2], "File path"), "File path");
    this.text(row[3], "File blob");
    const language = this.text(row[4], "File language");
    if (language === "Python")
      this.pythonFiles.add(this.index(row[1], "File id"));
    const bytes = integer(row[5], "File bytes");
    this.rows.files++;
    const sink = this.sink.file;
    if (sink !== undefined)
      this.deliver(() =>
        sink({ id, path, language: language === "" ? null : language, bytes }),
      );
  }

  private readExternal(row: unknown[]): void {
    this.arity(row, 12, "External");
    this.declare(row[1], "External id");
    for (const position of [2, 3, 7, 8, 10, 11])
      this.text(row[position], "External field");
    const path = this.text(row[4], "External path");
    if (path !== "") safePath(path, "External path");
    const start = integer(row[5], "External start line");
    const end = integer(row[6], "External end line");
    if (start > 0 && end > 0 && end < start)
      malformed("External line range is reversed.");
    if (typeof row[9] !== "boolean") malformed("External flag is not boolean.");
    this.rows.externals++;
  }

  private readSymbol(row: unknown[]): void {
    this.arity(row, 14, "Symbol");
    const id = this.declare(row[1], "Symbol id");
    this.text(row[2], "Symbol id version");
    const kind = this.required(row[3], "Symbol kind");
    const name = this.text(row[4], "Symbol name");
    const qualifiedName = this.text(row[5], "Symbol qualified name");
    const path = safePath(this.required(row[6], "Symbol path"), "Symbol path");
    const startLine = integer(row[7], "Symbol start line", 1);
    const endLine = integer(row[8], "Symbol end line", 1);
    if (endLine < startLine) malformed("Symbol line range is reversed.");
    const signature = this.text(row[9], "Symbol signature");
    this.text(row[10], "Symbol body hash");
    const language = this.text(row[11], "Symbol language");
    const container = this.text(row[12], "Symbol container");
    const aliases = row[13];
    if (!Array.isArray(aliases)) return malformed("Symbol aliases.");
    for (const alias of aliases) this.index(alias, "Symbol alias");
    this.rows.symbols++;
    this.deliver(() =>
      this.sink.symbol({
        id,
        name,
        qualifiedName,
        kind,
        language,
        path,
        startLine,
        endLine,
        containerId: container === "" ? null : container,
        signature: signature === "" ? null : signature,
      }),
    );
  }

  private location(
    pathValue: unknown,
    startValue: unknown,
    endValue: unknown,
  ): GraphLocation {
    const path = this.text(pathValue, "Evidence path");
    const start = integer(startValue, "Evidence start line");
    const end = integer(endValue, "Evidence end line");
    if (path === "")
      return start === 0 && end === 0
        ? { kind: "absent" }
        : malformed("Evidence lines without a path.");
    const source = safePath(path, "Evidence path") as SourcePath;
    if (start === 0)
      return end === 0
        ? { kind: "path", path: source }
        : malformed("Evidence end line without a start.");
    if (end === 0) return { kind: "point", path: source, line: start };
    if (end < start) malformed("Evidence line range is reversed.");
    return { kind: "range", path: source, startLine: start, endLine: end };
  }

  /**
   * An evidence entry's sixth element, `form`, checked against what the engine promises with it: a
   * schema from 1.4, an engine that declares `call_site_lines`, a call relation's call-site entry,
   * and a line. Through 1.4 `reference` is the one value and any other refuses the stream, as an
   * unknown import target kind does; under a newer minor another value is passed as written (never
   * dropped, which would make the entry read as a call). A slot that names no string is a malformed
   * known field in every minor.
   */
  private form(
    value: unknown,
    relation: string,
    entry: Readonly<{ kind: string; location: GraphLocation }>,
  ): string {
    const form = this.required(value, "Evidence form");
    if (this.minor < FORM_SCHEMA_MINOR)
      malformed("An evidence form before schema 1.4.");
    if (this.expected.callSiteLineLanguages == null)
      malformed("An evidence form from an engine that declares no call lines.");
    if (!CALL_RELATIONS.has(relation) || !CALL_SITE_KINDS.has(entry.kind))
      malformed("An evidence form outside a call relation's call site.");
    if (entry.location.kind !== "point" && entry.location.kind !== "range")
      malformed("An evidence form without a line.");
    if (!CALL_SITE_FORMS.has(form) && !this.newerMinor)
      malformed(`Unknown evidence form ${JSON.stringify(form)}.`);
    return form;
  }

  private readRelation(row: unknown[]): void {
    this.arity(row, 11, "Relation", 12);
    const fromId = this.endpoint(row[1], "Relation source");
    const toId = this.endpoint(row[2], "Relation target");
    const relation = this.required(row[3], "Relation type");
    const confidence = row[4];
    if (typeof confidence !== "number" || !Number.isFinite(confidence))
      malformed("Relation confidence.");
    this.text(row[5], "Relation reason");
    const scope = this.text(row[6], "Relation scope");
    const resolution = this.text(row[7], "Relation resolution");
    const targetKind = this.text(row[8], "Relation target kind");
    const rawEvidence = row[9];
    if (!Array.isArray(rawEvidence)) return malformed("Relation evidence.");
    let importTargetKind: string | undefined;
    // Files precede relations, so the source's language is known here.
    const fromPython = this.pythonFiles.has(
      this.index(row[1], "Relation source"),
    );
    const relativeModules = new Set<string>();
    const evidence: GraphSnapshotEvidence[] = rawEvidence.map(
      (item: unknown) => {
        // Five fields, or six from schema 1.4 (the entry's `form`); more only under a newer minor,
        // which may add trailing fields this reader ignores.
        if (
          !Array.isArray(item) ||
          item.length < 5 ||
          (!this.newerMinor && item.length > 6)
        )
          return malformed("Evidence arity.");
        const detail = this.text(item[4], "Evidence detail");
        const kind = this.text(item[0], "Evidence kind");
        const location = this.location(item[1], item[2], item[3]);
        const plain = {
          kind,
          location,
          detail: detail === "" ? null : detail,
        };
        if (item.length >= 6)
          return { ...plain, form: this.form(item[5], relation, plain) };
        if (!kind.startsWith("import_target_")) return plain;
        if (relation !== "IMPORTS")
          return malformed("An import target outside an IMPORTS relation.");
        if (this.expected.importTargetLanguages == null)
          return malformed(
            "An import target from an engine that declares none.",
          );
        if (!isImportTargetKind(kind))
          return this.newerMinor
            ? plain
            : malformed(`Unknown import target ${JSON.stringify(kind)}.`);
        // One kind per relation. The one exception, as the engine's docs state it: on a relation from
        // a Python file, the entry for a relative `from` module (`.`, `..`) rides on the relation of
        // its first imported name with a kind of its own, `import_target_file` for the package's
        // `__init__.py` or `import_target_unresolved`. With no name (`from . import *`) the module is
        // a specifier of its own, and other specifiers reaching its file join its relation, so one
        // relation may carry several relative modules (`.`, `..`), each once; any other dot-only
        // entry (a TypeScript `"."`) falls under the ordinary rule.
        if (fromPython && /^\.+$/.test(detail)) {
          if (relativeModules.has(detail))
            malformed("A relation carries one relative module twice.");
          if (
            kind !== "import_target_file" &&
            kind !== "import_target_unresolved"
          )
            malformed(
              "A relative module's import target is a file or unresolved.",
            );
          relativeModules.add(detail);
        } else {
          if (importTargetKind !== undefined && importTargetKind !== kind)
            malformed("Import targets of one relation differ in kind.");
          importTargetKind = kind;
        }
        const target = IMPORT_TARGET_KINDS[kind];
        if (target === "file" || target === "declared-package") {
          if (location.kind !== "path")
            return malformed("An import target must name its path alone.");
          return {
            ...plain,
            importTarget: {
              specifier: detail,
              target:
                target === "file"
                  ? { kind: target, path: location.path }
                  : {
                      kind: target,
                      name: declaredPackageName(detail, location.path),
                      manifest: location.path,
                    },
            },
          };
        }
        if (location.kind !== "absent")
          return malformed("This import target names no path.");
        return {
          ...plain,
          importTarget: { specifier: detail, target: { kind: target } },
        };
      },
    );
    const rawWarnings = row[10];
    if (rawWarnings !== null && !Array.isArray(rawWarnings))
      malformed("Relation warnings.");
    const warningCodes = (Array.isArray(rawWarnings) ? rawWarnings : []).map(
      (code: unknown) => this.text(code, "Relation warning"),
    );
    const evidenceDropped =
      row.length >= 12 ? integer(row[11], "Relation evidence dropped") : 0;
    this.rows.relations++;
    this.deliver(() =>
      this.sink.relation({
        relation,
        fromId,
        toId,
        targetKind: targetKind === "" ? null : targetKind,
        resolution: resolution === "" ? null : resolution,
        confidence: typeof confidence === "number" ? confidence : 0,
        scope: scope === "" ? null : scope,
        evidence,
        warningCodes,
        evidenceDropped,
      }),
    );
  }

  private readSummary(row: unknown[]): void {
    if (row.length !== 2) malformed("Summary arity must be 2.");
    const summary = snapshotSchemas.summary.parse(row[1]);
    const header = this.header;
    if (header === undefined) return malformed("Summary before header.");
    if (this.forward.size > 0)
      malformed(
        `${this.forward.size} relation endpoint(s) were never declared.`,
      );
    const { stats } = summary;
    if (
      stats.files !== this.rows.files ||
      stats.symbols !== this.rows.symbols ||
      stats.relations !== this.rows.relations
    )
      malformed("Summary counts differ from the records read.");
    const failures = new Map<string | null, string[]>();
    for (const failure of summary.partial_failures ?? []) {
      const path =
        failure.file_path === undefined || failure.file_path === ""
          ? null
          : safePath(failure.file_path, "Partial failure path");
      const codes = failures.get(path) ?? [];
      if (!codes.includes(failure.code)) codes.push(failure.code);
      failures.set(path, codes);
    }
    const warningCounts = new Map<string, number>();
    const gitlinks: { path: string; commit: string | null }[] = [];
    const excluded: { path: string }[] = [];
    for (const warning of summary.warnings ?? []) {
      warningCounts.set(
        warning.code,
        (warningCounts.get(warning.code) ?? 0) + 1,
      );
      const path =
        warning.file_path === undefined || warning.file_path === ""
          ? undefined
          : safePath(warning.file_path, "Warning path");
      if (path === undefined) continue;
      if (warning.code === GRAPH_SUBMODULE_NOT_READ)
        gitlinks.push({
          path,
          commit: OBJECT_ID.exec(warning.detail ?? "")?.[0] ?? null,
        });
      else if (warning.code === GRAPH_GO_BUILD_EXCLUDED)
        excluded.push({ path });
    }
    const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    const { provider } = this.expected;
    this.coverage = {
      provider: {
        name: provider.name,
        version: provider.version,
        identityRevision: provider.identityRevision,
        executable: { ...provider.executable },
      },
      repoKey: header.repo_key,
      schema: {
        version: header.schema_version,
        newerMinor: this.newerMinor,
        skippedRows: this.skippedRows,
      },
      commit: header.commit,
      tree: header.tree,
      profile: this.expected.profile,
      relationSet: [...header.relation_set],
      skippedRelationFamilies: [...header.skipped_relation_families],
      languageTiers: Object.fromEntries(
        Object.entries(summary.language_tiers ?? {}).sort(([a], [b]) =>
          byText(a, b),
        ),
      ),
      counts: {
        files: stats.files,
        parsedFiles: stats.parsed_files,
        symbols: stats.symbols,
        relations: stats.relations,
        externals: this.rows.externals,
      },
      partialFailures: [...failures]
        .sort(([a], [b]) => (a === null ? -1 : b === null ? 1 : byText(a, b)))
        .map(([path, codes]) => ({ path, codes })),
      warnings: [...warningCounts]
        .sort(([a], [b]) => byText(a, b))
        .map(([code, count]) => ({ code, count })),
      gitlinksNotRead: gitlinks.sort((a, b) => byText(a.path, b.path)),
      goBuildExcluded: excluded.sort((a, b) => byText(a.path, b.path)),
      health: summary.completeness.health?.status ?? null,
      completenessLevel: stats.completeness_level,
      importTargets:
        this.expected.importTargetLanguages == null
          ? { status: "not-declared" }
          : {
              status: "classified",
              languages: [...this.expected.importTargetLanguages],
            },
      callSiteLineLanguages: [...(this.expected.callSiteLineLanguages ?? [])],
    };
  }
}

/** Whether a line's first bytes are the summary's tag: only it gets the larger allowance. */
export const summaryLinePrefix = (head: Uint8Array): boolean =>
  /^\s*\[\s*"m"\s*,/.test(
    new TextDecoder().decode(head.subarray(0, Math.min(head.byteLength, 64))),
  );
