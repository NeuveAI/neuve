import { setImmediate } from "node:timers/promises";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Data } from "effect";
import { z } from "zod";
import type { GraphProviderObservation } from "./domain.ts";
import {
  GRAPH_IMPORT_BINDINGS_FEATURE,
  GRAPH_INDENTATION_SIGNIFICANT_FEATURE,
  GRAPH_TOKEN_DIRECTIVES_FEATURE,
  GRAPH_TOKENS_FEATURE,
  TokensWire,
  fileTokensRecord,
  fileTokensValue,
  type GraphFileTokens,
  type GraphTokenCoverage,
} from "./tokens.ts";

export class GraphSymbolsError extends Data.TaggedError("GraphSymbolsError")<{
  readonly reason:
    | "executable-unavailable"
    | "command"
    | "invalid-output"
    | "cancelled"
    | "deadline"
    | "input"
    /** The engine does not declare what the read asked for (tokens); it will refuse again. */
    | "unsupported";
  readonly message: string;
  readonly cause?: unknown;
}> {}

const line = z.int().positive();
const text = z.string();
const nullableText = text.nullable().optional();
const failure = z.object({
  code: text,
  file_path: text.optional(),
  language: text.optional(),
});
const symbol = z.object({
  record_type: z.literal("symbol"),
  id: text,
  kind: text,
  name: text,
  qualified_name: text,
  signature: text.optional(),
  file_path: text,
  start_line: line,
  end_line: line,
  language: text,
  container_id: nullableText,
});
type OutlineWire = Readonly<{
  start_line: number;
  end_line: number;
  type: string;
  imports?: boolean | undefined;
  children?: readonly OutlineWire[] | undefined;
}>;
// The provider emits at most sixteen child edges below a top-level node.
const outlineNode = (depth: number): z.ZodType<OutlineWire> =>
  z.object({
    start_line: line,
    end_line: line,
    type: text,
    imports: z.boolean().optional(),
    children: z
      .array(depth < 16 ? outlineNode(depth + 1) : z.never())
      .optional(),
  });
const outline = z.object({
  record_type: z.literal("file_outline"),
  file_path: text,
  language: text,
  top_level: z.array(outlineNode(0)),
  identifiers: z.array(z.tuple([line], text)),
});
const summary = z.object({
  record_type: z.literal("summary"),
  partial_failures: z.array(failure).nullable(),
});
// Provider payloads use schema validation without the stored-record compatibility policy.
const streamSchemas = {
  header: z.object({
    record_type: z.never().optional(),
    schema_version: text,
    provider: text,
    provider_version: text,
    identity_revision: text.optional(),
    repo_root: text,
    profile: z.literal("syntax-only"),
  }),
  envelope: z.looseObject({
    record_type: z.enum(["symbol", "file_outline", "summary"]),
    file_path: text.optional(),
  }),
  /** Only a read that asked for tokens accepts their records. */
  tokensEnvelope: z.looseObject({
    record_type: z.enum(["symbol", "file_outline", "file_tokens", "summary"]),
    file_path: text.optional(),
  }),
  record: z.union([symbol, outline, summary]),
  /** The engine's `file_tokens` record, read once the tokens envelope admitted it. */
  tokens: TokensWire,
};

export type GraphFileSymbol = Readonly<{
  id: string;
  kind: string;
  name: string;
  qualifiedName: string;
  signature?: string | undefined;
  startLine: number;
  endLine: number;
  containerId: string | null;
}>;
export type GraphOutlineNode = Readonly<{
  startLine: number;
  endLine: number;
  type: string;
  imports: boolean;
  children?: readonly GraphOutlineNode[] | undefined;
}>;

const normalizeOutline = (node: OutlineWire): GraphOutlineNode => {
  if (node.end_line < node.start_line)
    throw new Error("Invalid outline range.");
  for (const child of node.children ?? [])
    if (child.start_line < node.start_line || child.end_line > node.end_line)
      throw new Error("Outline child outside parent.");
  return {
    startLine: node.start_line,
    endLine: node.end_line,
    type: node.type,
    imports: node.imports ?? false,
    ...(node.children === undefined
      ? {}
      : { children: node.children.map(normalizeOutline) }),
  };
};

export type GraphFileObservation = Readonly<{
  language: string | null;
  symbols: readonly GraphFileSymbol[];
  outline: Readonly<{
    topLevel: readonly GraphOutlineNode[];
    identifiers: readonly (readonly [number, ...string[]])[];
  }> | null;
  partialFailure: string | null;
  /** All reported codes, so a later syntax error cannot hide an earlier timeout or limit. */
  partialFailures?: readonly string[] | undefined;
  /** Present on every file, and only, when the read asked for tokens. */
  tokens?: GraphFileTokens | undefined;
}>;
export type GraphSymbolsObservation = Readonly<{
  provider: GraphProviderObservation;
  outlinesAvailable: boolean;
  files: ReadonlyMap<string, GraphFileObservation>;
  batchOutputBytes?: readonly number[];
  /** Present, and only, when the read asked for tokens: the languages the engine declared. */
  tokenCoverage?: GraphTokenCoverage | undefined;
}>;
export type GraphSymbolsInput = Readonly<{
  executable: string;
  files: readonly Readonly<{ path: string; bytes: Uint8Array }>[];
  /**
   * Also read each file's syntax leaves and import bindings (`--tokens`). Without it the command,
   * the observation and its publication are what they were before tokens existed.
   */
  tokens?: boolean;
  temporaryParent: string;
  /** Stable engine store; defaults to graph/cache under the durable budget directory. */
  cacheDirectory?: string;
  /** Admit provider and symbol commands after executable preparation; never admit key claims here. */
  execute?: <A>(
    run: (permits: number) => Promise<A>,
    signal: AbortSignal,
  ) => Promise<A>;
  signal?: AbortSignal;
  deadlineMs?: number;
  /** CPU permits already held by the caller, never a new admission pool. */
  concurrency?: number;
}>;

// Source: sem/provider.go callableTargetKind and sem/types.go typeLikeKind.
export const isGraphCallable = (kind: string) =>
  /^(function|method|class|interface|struct|trait|type|enum|record|object|protocol)$/.test(
    kind,
  );

export const graphReadsPath = (
  provider: GraphProviderObservation,
  path: string,
) => {
  return provider.capabilities.supportedFileExtensions.some((extension) =>
    path
      .toLowerCase()
      .endsWith(
        (extension.startsWith(".") ? extension : `.${extension}`).toLowerCase(),
      ),
  );
};

/**
 * Whether Graph refuses a repository-relative path: it is empty, holds a NUL, a backslash or a
 * drive letter, or has an empty, `.`, `..` or `.git` segment. Every read refuses such a path, so a
 * caller keeps it out of a read with this one rule.
 */
export const graphRefusesSourcePath = (path: string): boolean =>
  !path ||
  path.includes("\0") ||
  path.includes("\\") ||
  /^[A-Za-z]:/.test(path) ||
  path
    .split("/")
    .some(
      (part) =>
        !part || part === "." || part === ".." || part.toLowerCase() === ".git",
    );

export const validateSymbolPaths = (files: GraphSymbolsInput["files"]) => {
  const paths = new Set<string>();
  for (const { path } of files) {
    if (graphRefusesSourcePath(path) || paths.has(path))
      throw new GraphSymbolsError({
        reason: "input",
        message: `Invalid or duplicate source path: ${JSON.stringify(path)}`,
      });
    paths.add(path);
  }
  for (const path of paths) {
    const parts = path.split("/");
    for (let length = 1; length < parts.length; length++)
      if (paths.has(parts.slice(0, length).join("/")))
        throw new GraphSymbolsError({
          reason: "input",
          message: "Source paths include a file and its descendant.",
        });
  }
};

/** What a stream that carries tokens is checked against: the bytes given and the declared languages. */
export type SymbolStreamTokens = Readonly<{
  bytes: ReadonlyMap<string, Uint8Array>;
  coverage: GraphTokenCoverage;
}>;

export const parseSymbolStream = async (
  stdout: string,
  paths: readonly string[],
  provider: GraphProviderObservation,
  repo: string,
  signal?: AbortSignal,
  tokens?: SymbolStreamTokens,
): Promise<GraphSymbolsObservation> => {
  try {
    const tokenRecords = new Map<string, GraphFileTokens | "over-limit">();
    let previousOutline: string | undefined;
    const files = new Map<
      string,
      Omit<GraphFileObservation, "symbols"> & { symbols: GraphFileSymbol[] }
    >(
      paths.map((path) => [
        path,
        { language: null, symbols: [], outline: null, partialFailure: null },
      ]),
    );
    signal?.throwIfAborted();
    const rows = stdout.trim().split("\n");
    const first = streamSchemas.header.parse(JSON.parse(rows.shift() ?? ""));
    if (
      first.repo_root !== repo ||
      first.provider !== provider.name ||
      first.schema_version !== provider.capabilities.schemaVersion ||
      first.provider_version !== provider.version ||
      first.identity_revision !== provider.identityRevision
    )
      throw new Error("Symbols header identity mismatch.");
    let finished = false;
    const fileBytes = new Map<string, number>();
    let processed = 0;
    for (const row of rows) {
      if (++processed % 128 === 0) await setImmediate();
      signal?.throwIfAborted();
      if (finished) throw new Error("Record after symbols summary.");
      const raw: unknown = JSON.parse(row);
      const envelope: z.infer<typeof streamSchemas.tokensEnvelope> =
        tokens === undefined
          ? streamSchemas.envelope.parse(raw)
          : streamSchemas.tokensEnvelope.parse(raw);
      if (envelope.record_type === "file_tokens" && tokens !== undefined) {
        // One record right after its file's outline, from the same tree.
        const path = envelope.file_path;
        if (path === undefined || path !== previousOutline)
          throw new Error("Tokens record does not follow its file's outline.");
        previousOutline = undefined;
        const file = files.get(path);
        if (!file || tokenRecords.has(path))
          throw new Error("Tokens record outside input or repeated.");
        // A file already over its outline allowance keeps that failure; its tokens are not read.
        if (file.partialFailures?.includes("symbols-output-limit")) continue;
        if (Buffer.byteLength(row) + 1 > SYMBOL_FILE_TOKENS_BYTES) {
          tokenRecords.set(path, "over-limit");
          continue;
        }
        const record = streamSchemas.tokens.parse(raw);
        const bytes = tokens.bytes.get(path);
        if (bytes === undefined || record.language !== file.language)
          throw new Error("Tokens record language differs from its outline.");
        tokenRecords.set(
          path,
          fileTokensRecord(record, bytes, tokens.coverage),
        );
        continue;
      }
      previousOutline =
        envelope.record_type === "file_outline"
          ? envelope.file_path
          : undefined;
      if (
        envelope.record_type !== "summary" &&
        envelope.file_path !== undefined
      ) {
        const path = envelope.file_path;
        const file = files.get(path);
        if (!file) throw new Error("Graph record outside input.");
        const count = (fileBytes.get(path) ?? 0) + Buffer.byteLength(row) + 1;
        fileBytes.set(path, count);
        if (count > SYMBOL_FILE_OUTPUT_BYTES) {
          files.set(path, {
            language: file.language,
            symbols: [],
            outline: null,
            partialFailure: "symbols-output-limit",
            partialFailures: [
              ...new Set([
                ...(file.partialFailures ??
                  (file.partialFailure ? [file.partialFailure] : [])),
                "symbols-output-limit",
              ]),
            ],
          });
          continue;
        }
      }
      const item = streamSchemas.record.parse(raw);
      if (item.record_type === "summary") {
        finished = true;
        for (const problem of item.partial_failures ?? []) {
          if (problem.file_path !== undefined && !files.has(problem.file_path))
            throw new Error("Failure outside input.");
          for (const [path, file] of files)
            if (!problem.file_path || problem.file_path === path)
              files.set(path, {
                ...file,
                language: file.language ?? problem.language ?? null,
                partialFailure: problem.code,
                partialFailures: [
                  ...new Set([
                    ...(file.partialFailures ??
                      (file.partialFailure ? [file.partialFailure] : [])),
                    problem.code,
                  ]),
                ],
              });
        }
        continue;
      }
      const file = files.get(item.file_path);
      if (!file) throw new Error("Graph record outside input.");
      if (file.language !== null && file.language !== item.language)
        throw new Error("Inconsistent file language.");
      if (item.record_type === "symbol") {
        if (item.end_line < item.start_line)
          throw new Error(
            `Invalid symbol range: ${item.file_path}:${item.start_line}-${item.end_line}`,
          );
        file.symbols.push({
          id: item.id,
          kind: item.kind,
          name: item.name,
          qualifiedName: item.qualified_name,
          ...(item.signature === undefined
            ? {}
            : { signature: item.signature }),
          startLine: item.start_line,
          endLine: item.end_line,
          containerId: item.container_id || null,
        });
        files.set(item.file_path, { ...file, language: item.language });
      } else {
        if (
          file.outline !== null ||
          item.top_level.some((node) => node.end_line < node.start_line)
        )
          throw new Error("Invalid or duplicate outline.");
        files.set(item.file_path, {
          ...file,
          language: item.language,
          outline: {
            topLevel: item.top_level.map(normalizeOutline),
            identifiers: item.identifiers,
          },
        });
      }
    }
    if (!finished) throw new Error("Missing symbols summary.");
    if (tokens !== undefined)
      for (const [path, file] of files) {
        const read = tokenRecords.get(path);
        // Every outline is followed by its tokens record, whatever its language.
        if (read === undefined && file.outline !== null)
          throw new Error("An outline has no tokens record.");
        files.set(path, {
          ...file,
          tokens: fileTokensValue(file, read, tokens.coverage),
        });
      }
    return {
      provider,
      outlinesAvailable:
        provider.capabilities.optionalLocalOnlyFeatures["symbols_outline"] ===
        true,
      files,
      ...(tokens === undefined ? {} : { tokenCoverage: tokens.coverage }),
    };
  } catch (cause) {
    throw new GraphSymbolsError({
      reason: signal?.aborted ? "cancelled" : "invalid-output",
      message: "Invalid Graph symbols stream.",
      cause,
    });
  }
};

export type SymbolsRuntime = Readonly<{
  provider: GraphProviderObservation;
  /** `feature_languages` of the same engine; required only by a read that asks for tokens. */
  featureLanguages?: Readonly<Record<string, readonly string[]>>;
  run: (
    repo: string,
    outlines: boolean,
    signal: AbortSignal,
    tokens: boolean,
  ) => Promise<string>;
  init: (repo: string, signal: AbortSignal) => Promise<void>;
}>;

// A batch also has a byte bound, so a set of large files cannot grow a view without limit.
export const SYMBOL_BATCH_FILES = 512;
// Normal trees amortize process startup over 4 MiB. The command still enforces
// 64 MiB output; an overflow splits the batch until the offending file is isolated.
export const SYMBOL_BATCH_BYTES = 4 * 1024 * 1024;
/**
 * With tokens the stream runs to about 10 bytes per source byte (outline and symbols about 3.7,
 * tokens about 6.7, the densest file measured 9), so a batch takes half the source and its output
 * stays near a third of the 64 MiB command bound instead of brushing it.
 */
export const SYMBOL_TOKENS_BATCH_BYTES = 2 * 1024 * 1024;
export const SYMBOL_FILE_OUTPUT_BYTES = 8 * 1024 * 1024;
/** One file's tokens record, counted apart from its outline and symbols: about 1.1 MB of source. */
export const SYMBOL_FILE_TOKENS_BYTES = 8 * 1024 * 1024;
const outputBoundFailure = (error: unknown): boolean =>
  error instanceof Error &&
  (error.message.includes("output byte bound") ||
    ("cause" in error && outputBoundFailure(error.cause)));

/** What the engine declares for tokens, or `unsupported`: the same engine would refuse again. */
const tokenCoverageOf = (runtime: SymbolsRuntime): GraphTokenCoverage => {
  const features = runtime.provider.capabilities.optionalLocalOnlyFeatures;
  const languages = runtime.featureLanguages?.[GRAPH_TOKENS_FEATURE];
  if (
    features["symbols_outline"] !== true ||
    features[GRAPH_TOKENS_FEATURE] !== true ||
    languages === undefined
  )
    throw new GraphSymbolsError({
      reason: "unsupported",
      message: "Graph engine does not declare syntax leaves on its outline.",
    });
  return {
    languages,
    importBindingLanguages:
      features[GRAPH_IMPORT_BINDINGS_FEATURE] === true
        ? (runtime.featureLanguages?.[GRAPH_IMPORT_BINDINGS_FEATURE] ?? [])
        : [],
    directiveLanguages:
      features[GRAPH_TOKEN_DIRECTIVES_FEATURE] === true
        ? (runtime.featureLanguages?.[GRAPH_TOKEN_DIRECTIVES_FEATURE] ?? [])
        : [],
    // Null, not empty: an engine from before the key says nothing about any language.
    indentationSignificantLanguages:
      features[GRAPH_INDENTATION_SIGNIFICANT_FEATURE] === true
        ? (runtime.featureLanguages?.[GRAPH_INDENTATION_SIGNIFICANT_FEATURE] ??
          [])
        : null,
  };
};

export const readSymbolBatches = async (
  input: GraphSymbolsInput,
  runtime: SymbolsRuntime,
): Promise<GraphSymbolsObservation> => {
  validateSymbolPaths(input.files);
  const tokenCoverage =
    input.tokens === true ? tokenCoverageOf(runtime) : undefined;
  const batchBytes =
    tokenCoverage === undefined
      ? SYMBOL_BATCH_BYTES
      : SYMBOL_TOKENS_BATCH_BYTES;
  const concurrency = z
    .int()
    .min(1)
    .max(1024)
    .parse(input.concurrency ?? 1);
  const controller = new AbortController();
  const signal = AbortSignal.any([
    controller.signal,
    ...(input.signal ? [input.signal] : []),
  ]);
  /** Adds the tokens value a file without a tokens record of its own has, when tokens were asked. */
  const withTokens = (
    file: GraphFileObservation,
    read?: "over-limit",
  ): GraphFileObservation =>
    tokenCoverage === undefined
      ? file
      : { ...file, tokens: fileTokensValue(file, read, tokenCoverage) };
  const batches: Array<Array<GraphSymbolsInput["files"][number]>> = [];
  const oversized = new Map<string, GraphFileObservation>();
  let batch: Array<GraphSymbolsInput["files"][number]> = [];
  let bytes = 0;
  for (const file of [...input.files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  )) {
    signal.throwIfAborted();
    if (file.bytes.byteLength > 4 * 1024 * 1024) {
      oversized.set(
        file.path,
        withTokens({
          language: null,
          symbols: [],
          outline: null,
          partialFailure: "symbols-input-limit",
        }),
      );
      continue;
    }
    if (
      batch.length &&
      (batch.length >= SYMBOL_BATCH_FILES ||
        bytes + file.bytes.byteLength > batchBytes)
    ) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(file);
    bytes += file.bytes.byteLength;
  }
  if (batch.length) batches.push(batch);
  const outlinesAvailable =
    runtime.provider.capabilities.optionalLocalOnlyFeatures[
      "symbols_outline"
    ] === true;
  const results: GraphSymbolsObservation[] = [];
  let next = 0;
  const runBatch = async (
    batch: GraphSymbolsInput["files"],
    tokens: boolean,
  ): Promise<GraphSymbolsObservation> => {
    signal.throwIfAborted();
    const temporary = await mkdtemp(
      join(resolve(input.temporaryParent), "neuve-graph-symbols-"),
    );
    // Graph's local symbol namespace includes the repository basename. Keep it stable
    // for the same source bytes, independent of scheduling or the private parent.
    const identity = createHash("sha256");
    for (const file of batch)
      identity.update(
        JSON.stringify([
          file.path,
          createHash("sha256").update(file.bytes).digest("hex"),
        ]),
      );
    const repo = join(temporary, `source-${identity.digest("hex")}`);
    try {
      await mkdir(repo);
      await runtime.init(repo, signal);
      for (const file of batch) {
        signal.throwIfAborted();
        const path = join(repo, file.path);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, file.bytes, { flag: "wx" });
      }
      let stdout: string;
      try {
        stdout = await runtime.run(repo, outlinesAvailable, signal, tokens);
      } catch (error) {
        signal.throwIfAborted();
        if (!outputBoundFailure(error)) throw error;
        if (batch.length > 1) {
          // Split recursively without taking new permits. Good files remain available.
          const middle = Math.ceil(batch.length / 2);
          const left = await runBatch(batch.slice(0, middle), tokens);
          const right = await runBatch(batch.slice(middle), tokens);
          return {
            provider: runtime.provider,
            outlinesAvailable,
            files: new Map([...left.files, ...right.files]),
            batchOutputBytes: [
              ...(left.batchOutputBytes ?? []),
              ...(right.batchOutputBytes ?? []),
            ],
          };
        }
        if (tokens) {
          // One file whose tokens overflow the command: read it again without them, so its
          // outline and symbols survive and its tokens say why they are missing.
          const plain = await runBatch(batch, false);
          return {
            ...plain,
            files: new Map(
              [...plain.files].map(([path, file]) => [
                path,
                withTokens(file, "over-limit"),
              ]),
            ),
          };
        }
        return {
          provider: runtime.provider,
          outlinesAvailable,
          files: new Map(
            batch.map((file) => [
              file.path,
              withTokens({
                language: null,
                symbols: [],
                outline: null,
                partialFailure: "symbols-output-limit",
              }),
            ]),
          ),
          batchOutputBytes: [],
        };
      }
      signal.throwIfAborted();
      const parsed = await parseSymbolStream(
        stdout,
        batch.map((file) => file.path),
        runtime.provider,
        repo,
        signal,
        tokens && tokenCoverage !== undefined
          ? {
              bytes: new Map(batch.map((file) => [file.path, file.bytes])),
              coverage: tokenCoverage,
            }
          : undefined,
      );
      return { ...parsed, batchOutputBytes: [Buffer.byteLength(stdout)] };
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  };
  const worker = async () => {
    try {
      while (next < batches.length) {
        signal.throwIfAborted();
        const index = next++;
        const batch = batches[index];
        if (batch)
          results[index] = await runBatch(batch, tokenCoverage !== undefined);
      }
    } catch (error) {
      controller.abort(error);
      throw error;
    }
  };
  const settled = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, batches.length) }, worker),
  );
  const failed = settled.find((result) => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
  signal.throwIfAborted();
  const files = new Map(oversized);
  const batchOutputBytes: number[] = [];
  for (const result of results) {
    for (const [path, file] of result.files) files.set(path, file);
    batchOutputBytes.push(...(result.batchOutputBytes ?? []));
  }
  return {
    provider: runtime.provider,
    outlinesAvailable,
    files,
    batchOutputBytes,
    ...(tokenCoverage === undefined ? {} : { tokenCoverage }),
  };
};
