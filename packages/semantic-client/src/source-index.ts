import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import * as Schema from "effect/Schema";
import {
  fingerprintBaseRole,
  formatSemanticInput,
  matchesDeclaredVectorPair,
  qualifySupportedBaseEvidencePair,
  scorePool,
  validateRecordedBaseVector,
  validateRegisteredBasePairRef,
  validBaseVector,
  type BatchResult,
  type Encoded,
  type RegisteredBasePairRef,
  type SemanticClient,
  type SemanticInput,
} from "./index.ts";

export const SEGMENTATION_RECIPE = "utf8-line-window-4k-v1";
export const EVIDENCE_PROBE_RECIPE = "semantic-evidence-probe-v1";
const MAX_FRAGMENT_TEXT_BYTES = 4 * 1024;
const MAX_BATCH_ITEMS = 32;
const MAX_BATCH_FORMATTED_BYTES = 256 * 1024;
const NUMERICAL_TIE = 0.000001;
const RetainedVectorBlockSchema = Schema.Struct({
  id: Schema.String,
  encoded: Schema.Unknown,
});
const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown) => JSON.stringify(value);
const fragmentOccurrenceId = (
  input: Readonly<{
    policyId: string;
    sourceId: string;
    origin: SourceOrigin;
    startLine: number;
    endLine: number;
    startByte: number;
    endByte: number;
    textSha256: string;
  }>,
) =>
  sha256(
    canonical([
      SEGMENTATION_RECIPE,
      input.policyId,
      input.sourceId,
      input.origin,
      input.startLine,
      input.endLine,
      input.startByte,
      input.endByte,
      input.textSha256,
    ]),
  );

export type SourceOrigin =
  | Readonly<{
      kind: "git-blob";
      repository: string;
      revision: string;
      tree: string;
      path: string;
      blobOid: string;
      side: "new";
    }>
  | Readonly<{
      kind: "records-original";
      sourceId: string;
      version: string;
      contentSha256: string;
      originatingSystem: string;
      attributedActor: string | null;
    }>;

/** A body already admitted for BASE by Records and read by its source owner. */
export type QualifiedTextSource = Readonly<{
  sourceId: string;
  origin: SourceOrigin;
  purpose:
    | "implementation-context"
    | "requirement"
    | "technical-contract"
    | "validation-instruction"
    | "prior-correction";
  policyId: string;
  policySourceSha256: string;
  qualification: "base-inference-admitted";
  /** Excerpts are retained as omissions until exact original offsets exist. */
  bodyScope: "complete-original" | "retained-excerpt";
  text: string;
  textSha256: string;
  title?: string;
}>;

export type SourceFragment = Readonly<{
  occurrenceId: string;
  sourceId: string;
  origin: SourceOrigin;
  purpose: QualifiedTextSource["purpose"];
  bodyScope: QualifiedTextSource["bodyScope"];
  policyId: string;
  policySourceSha256: string;
  sourceTextSha256: string;
  startLine: number;
  endLine: number;
  startByte: number;
  endByte: number;
  text: string;
  textSha256: string;
  documentInputSha256: string;
  title?: string;
}>;

export type SourceOmission = Readonly<{
  sourceId: string;
  reason:
    | "empty-source"
    | "invalid-source-body"
    | "unsupported-retained-excerpt"
    | "original-digest-mismatch"
    | "line-exceeds-fragment-limit"
    | "source-budget-exhausted"
    | "source-count-exhausted"
    | "fragment-count-exhausted";
  startLine: number | null;
  endLine: number | null;
}>;

export type SegmentedSource = Readonly<{
  fragments: readonly SourceFragment[];
  omissions: readonly SourceOmission[];
  sourceBytes: number;
}>;

export type SourceEntry = Readonly<{
  sourceId: string;
  origin: SourceOrigin;
  purpose: QualifiedTextSource["purpose"];
  bodyScope: QualifiedTextSource["bodyScope"];
  policyId: string;
  policySourceSha256: string;
  sourceTextSha256: string;
  byteLength: number;
  countedSourceBytes: number;
  title: string | null;
}>;

const sourceTitle = (source: QualifiedTextSource) => {
  const value = source.title;
  if (
    value === undefined ||
    !value ||
    value.includes("\n") ||
    Buffer.byteLength(value) > 1024
  )
    return undefined;
  return value;
};

/** Segment complete supplied text without reading a repository or hiding long lines. */
export const segmentQualifiedSource = (
  source: QualifiedTextSource,
): SegmentedSource => {
  const sourceBytes = Buffer.byteLength(source.text);
  const invalid =
    !source.sourceId ||
    !source.policyId ||
    !source.policySourceSha256 ||
    source.qualification !== "base-inference-admitted" ||
    sha256(source.text) !== source.textSha256 ||
    Buffer.from(source.text, "utf8").toString("utf8") !== source.text;
  if (invalid)
    return {
      fragments: [],
      omissions: [
        {
          sourceId: source.sourceId,
          reason: "invalid-source-body",
          startLine: null,
          endLine: null,
        },
      ],
      sourceBytes,
    };
  if (source.bodyScope === "retained-excerpt")
    return {
      fragments: [],
      omissions: [
        {
          sourceId: source.sourceId,
          reason: "unsupported-retained-excerpt",
          startLine: null,
          endLine: null,
        },
      ],
      sourceBytes,
    };
  if (
    source.origin.kind === "records-original" &&
    source.origin.contentSha256 !== source.textSha256
  )
    return {
      fragments: [],
      omissions: [
        {
          sourceId: source.sourceId,
          reason: "original-digest-mismatch",
          startLine: null,
          endLine: null,
        },
      ],
      sourceBytes,
    };
  const lines = source.text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  if (lines.length === 0)
    return {
      fragments: [],
      omissions: [
        {
          sourceId: source.sourceId,
          reason: "empty-source",
          startLine: null,
          endLine: null,
        },
      ],
      sourceBytes,
    };
  const fragments: SourceFragment[] = [];
  const omissions: SourceOmission[] = [];
  const title = sourceTitle(source);
  let windowText = "";
  let windowStartLine = 1;
  let windowStartByte = 0;
  let cursorByte = 0;
  const flush = (endLine: number) => {
    if (!windowText) return;
    const textSha256 = sha256(windowText);
    const documentInputSha256 = sha256(
      formatSemanticInput({
        role: "document",
        text: windowText,
        ...(title === undefined ? {} : { title }),
      }),
    );
    fragments.push({
      occurrenceId: fragmentOccurrenceId({
        policyId: source.policyId,
        sourceId: source.sourceId,
        origin: source.origin,
        startLine: windowStartLine,
        endLine,
        startByte: windowStartByte,
        endByte: cursorByte,
        textSha256,
      }),
      sourceId: source.sourceId,
      origin: source.origin,
      purpose: source.purpose,
      bodyScope: source.bodyScope,
      policyId: source.policyId,
      policySourceSha256: source.policySourceSha256,
      sourceTextSha256: source.textSha256,
      startLine: windowStartLine,
      endLine,
      startByte: windowStartByte,
      endByte: cursorByte,
      text: windowText,
      textSha256,
      documentInputSha256,
      ...(title === undefined ? {} : { title }),
    });
    windowText = "";
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line === undefined) continue;
    const lineBytes = Buffer.byteLength(line);
    if (lineBytes > MAX_FRAGMENT_TEXT_BYTES) {
      flush(index);
      omissions.push({
        sourceId: source.sourceId,
        reason: "line-exceeds-fragment-limit",
        startLine: index + 1,
        endLine: index + 1,
      });
      cursorByte += lineBytes;
      windowStartLine = index + 2;
      windowStartByte = cursorByte;
      continue;
    }
    if (Buffer.byteLength(windowText) + lineBytes > MAX_FRAGMENT_TEXT_BYTES) {
      flush(index);
      windowStartLine = index + 1;
      windowStartByte = cursorByte;
    }
    windowText += line;
    cursorByte += lineBytes;
  }
  flush(lines.length);
  return { fragments, omissions, sourceBytes };
};

export type UnpublishedSourceGeneration = Readonly<{
  kind: "unpublished";
  schemaVersion: 1;
  generationId: string;
  policyId: string;
  policySourceSha256: string;
  runSource: Readonly<{ repository: string; revision: string; tree: string }>;
  segmentationRecipe: typeof SEGMENTATION_RECIPE;
  sourceManifestSha256: string;
  sourceEntries: readonly SourceEntry[];
  pairRegistration: RegisteredBasePairRef;
  producerFingerprint: string;
  occurrences: readonly Readonly<{
    fragment: SourceFragment;
    vectorBlockId: string;
  }>[];
  vectorBlocks: readonly Readonly<{ id: string; encoded: Encoded }>[];
  omissions: readonly SourceOmission[];
  population: Readonly<{
    suppliedSources: number;
    admittedFragments: number;
    indexedFragments: number;
    omitted: number;
    coverage: "complete-supplied-population" | "limited-supplied-population";
  }>;
  usage: Readonly<{
    retainedVectorHits: number;
    cacheHits: number;
    generated: number;
    encodeCalls: number;
    encodeMillis: number | null;
    loadMillis: number | null;
    nativeForwardCalls: null;
    sourceBytes: number;
    vectorValueBytes: number;
    vectorArtifactBytes: number;
    vectorReuseOccurrences: number;
  }>;
}>;

/** Records must verify and publish this state; source-index never creates it. */
export type ReadySourceGeneration = Omit<UnpublishedSourceGeneration, "kind"> &
  Readonly<{
    kind: "ready";
    recordsArtifactId: string;
    recordsManifestSha256: string;
    admittedCensusSha256: string;
    admittedPopulationCoverage: "complete" | "limited";
  }>;

export type GenerationProgressReceipt = Readonly<{
  kind: "generation-progress";
  sourceManifestSha256: string;
  pairRegistration: RegisteredBasePairRef;
  completedUniqueDocuments: number;
  totalUniqueDocuments: number;
  vectorBlocks: readonly Readonly<{ id: string; encoded: Encoded }>[];
  usage: UnpublishedSourceGeneration["usage"];
  omissions: readonly SourceOmission[];
}>;

export type SourceIndexRefusal = Readonly<{
  kind: "refusal";
  reason: string;
  omissions?: readonly SourceOmission[];
  partial?: GenerationProgressReceipt;
}>;

const vectorBlockId = (encoded: Encoded) =>
  sha256(
    canonical([
      encoded.role,
      encoded.formattedSha256,
      encoded.encoderFingerprint,
      encoded.values,
    ]),
  );

const sourceGenerationDigest = (
  value: Pick<
    UnpublishedSourceGeneration,
    | "policyId"
    | "policySourceSha256"
    | "runSource"
    | "segmentationRecipe"
    | "sourceManifestSha256"
    | "sourceEntries"
    | "pairRegistration"
    | "producerFingerprint"
    | "occurrences"
    | "vectorBlocks"
    | "omissions"
    | "population"
  >,
) =>
  sha256(
    canonical([
      value.policyId,
      value.policySourceSha256,
      value.runSource,
      value.segmentationRecipe,
      value.sourceManifestSha256,
      value.sourceEntries,
      value.pairRegistration,
      value.producerFingerprint,
      value.occurrences.map((entry) => [
        entry.fragment.occurrenceId,
        entry.vectorBlockId,
      ]),
      value.vectorBlocks.map((block) => block.id),
      value.omissions,
      value.population,
    ]),
  );

/** Exact ready-manifest payload; vector bodies remain separate content-addressed blocks. */
export const readySourceManifestBody = (value: ReadySourceGeneration) => ({
  schemaVersion: value.schemaVersion,
  generationId: value.generationId,
  policyId: value.policyId,
  policySourceSha256: value.policySourceSha256,
  runSource: value.runSource,
  segmentationRecipe: value.segmentationRecipe,
  sourceManifestSha256: value.sourceManifestSha256,
  sourceEntries: value.sourceEntries,
  pairRegistration: value.pairRegistration,
  producerFingerprint: value.producerFingerprint,
  occurrences: value.occurrences.map((item) => ({
    occurrenceId: item.fragment.occurrenceId,
    sourceId: item.fragment.sourceId,
    origin: item.fragment.origin,
    purpose: item.fragment.purpose,
    bodyScope: item.fragment.bodyScope,
    policyId: item.fragment.policyId,
    policySourceSha256: item.fragment.policySourceSha256,
    startLine: item.fragment.startLine,
    endLine: item.fragment.endLine,
    startByte: item.fragment.startByte,
    endByte: item.fragment.endByte,
    sourceTextSha256: item.fragment.sourceTextSha256,
    textSha256: item.fragment.textSha256,
    documentInputSha256: item.fragment.documentInputSha256,
    vectorBlockId: item.vectorBlockId,
  })),
  vectorBlockIds: value.vectorBlocks.map((block) => block.id),
  omissions: value.omissions,
  population: value.population,
  usage: value.usage,
  recordsArtifactId: value.recordsArtifactId,
  admittedCensusSha256: value.admittedCensusSha256,
  admittedPopulationCoverage: value.admittedPopulationCoverage,
});

/** Records must persist this payload and bind the returned digest atomically. */
export const fingerprintReadySourceManifest = (value: ReadySourceGeneration) =>
  sha256(canonical(readySourceManifestBody(value)));

const Sha256Pattern = /^[a-f0-9]{64}$/;
const SourceOriginSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("git-blob"),
    repository: Schema.String,
    revision: Schema.String,
    tree: Schema.String,
    path: Schema.String,
    blobOid: Schema.String,
    side: Schema.Literal("new"),
  }),
  Schema.Struct({
    kind: Schema.Literal("records-original"),
    sourceId: Schema.String,
    version: Schema.String,
    contentSha256: Schema.String,
    originatingSystem: Schema.String,
    attributedActor: Schema.NullOr(Schema.String),
  }),
]);
const SourcePurposeSchema = Schema.Union([
  Schema.Literal("implementation-context"),
  Schema.Literal("requirement"),
  Schema.Literal("technical-contract"),
  Schema.Literal("validation-instruction"),
  Schema.Literal("prior-correction"),
]);
const SourceBodyScopeSchema = Schema.Union([
  Schema.Literal("complete-original"),
  Schema.Literal("retained-excerpt"),
]);
const SourceEntrySchema = Schema.Struct({
  sourceId: Schema.String,
  origin: SourceOriginSchema,
  purpose: SourcePurposeSchema,
  bodyScope: SourceBodyScopeSchema,
  policyId: Schema.String,
  policySourceSha256: Schema.String,
  sourceTextSha256: Schema.String,
  byteLength: Schema.Number,
  countedSourceBytes: Schema.Number,
  title: Schema.NullOr(Schema.String),
});
const SourceOmissionSchema = Schema.Struct({
  sourceId: Schema.String,
  reason: Schema.Union([
    Schema.Literal("empty-source"),
    Schema.Literal("invalid-source-body"),
    Schema.Literal("unsupported-retained-excerpt"),
    Schema.Literal("original-digest-mismatch"),
    Schema.Literal("line-exceeds-fragment-limit"),
    Schema.Literal("source-budget-exhausted"),
    Schema.Literal("source-count-exhausted"),
    Schema.Literal("fragment-count-exhausted"),
  ]),
  startLine: Schema.NullOr(Schema.Number),
  endLine: Schema.NullOr(Schema.Number),
});
const ReadySourceManifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  generationId: Schema.String,
  policyId: Schema.String,
  policySourceSha256: Schema.String,
  runSource: Schema.Struct({
    repository: Schema.String,
    revision: Schema.String,
    tree: Schema.String,
  }),
  segmentationRecipe: Schema.Literal(SEGMENTATION_RECIPE),
  sourceManifestSha256: Schema.String,
  sourceEntries: Schema.Array(SourceEntrySchema),
  pairRegistration: Schema.Unknown,
  producerFingerprint: Schema.String,
  occurrences: Schema.Array(
    Schema.Struct({
      occurrenceId: Schema.String,
      sourceId: Schema.String,
      origin: SourceOriginSchema,
      purpose: SourcePurposeSchema,
      bodyScope: SourceBodyScopeSchema,
      policyId: Schema.String,
      policySourceSha256: Schema.String,
      startLine: Schema.Number,
      endLine: Schema.Number,
      startByte: Schema.Number,
      endByte: Schema.Number,
      sourceTextSha256: Schema.String,
      textSha256: Schema.String,
      documentInputSha256: Schema.String,
      vectorBlockId: Schema.String,
    }),
  ),
  vectorBlockIds: Schema.Array(Schema.String),
  omissions: Schema.Array(SourceOmissionSchema),
  population: Schema.Struct({
    suppliedSources: Schema.Number,
    admittedFragments: Schema.Number,
    indexedFragments: Schema.Number,
    omitted: Schema.Number,
    coverage: Schema.Union([
      Schema.Literal("complete-supplied-population"),
      Schema.Literal("limited-supplied-population"),
    ]),
  }),
  usage: Schema.Struct({
    retainedVectorHits: Schema.Number,
    cacheHits: Schema.Number,
    generated: Schema.Number,
    encodeCalls: Schema.Number,
    encodeMillis: Schema.NullOr(Schema.Number),
    loadMillis: Schema.NullOr(Schema.Number),
    nativeForwardCalls: Schema.Null,
    sourceBytes: Schema.Number,
    vectorValueBytes: Schema.Number,
    vectorArtifactBytes: Schema.Number,
    vectorReuseOccurrences: Schema.Number,
  }),
  recordsArtifactId: Schema.String,
  admittedCensusSha256: Schema.String,
  admittedPopulationCoverage: Schema.Union([
    Schema.Literal("complete"),
    Schema.Literal("limited"),
  ]),
});

/** Reopen a first-ready generation from Records-supplied originals and blocks. */
export const restoreReadySourceGeneration = (
  input: Readonly<{
    manifest: unknown;
    recordsManifestSha256: string;
    registeredPair: RegisteredBasePairRef;
    vectorBlocks: readonly unknown[];
    originals: readonly Readonly<{
      sourceId: string;
      origin: SourceOrigin;
      bytes: Uint8Array;
    }>[];
  }>,
): ReadySourceGeneration | SourceIndexRefusal => {
  const refuse = (reason: string): SourceIndexRefusal => ({
    kind: "refusal",
    reason,
  });
  let manifest: typeof ReadySourceManifestSchema.Type;
  try {
    manifest = Schema.decodeUnknownSync(ReadySourceManifestSchema, {
      onExcessProperty: "error",
    })(input.manifest);
  } catch {
    return refuse("invalid-ready-source-manifest");
  }
  const pair = validateRegisteredBasePairRef(manifest.pairRegistration);
  const registeredPair = validateRegisteredBasePairRef(input.registeredPair);
  if (
    !pair ||
    !registeredPair ||
    pair.pair.operation !== "retrieval" ||
    !isDeepStrictEqual(pair, registeredPair) ||
    manifest.producerFingerprint !== pair.pair.modelFingerprint
  )
    return refuse("ready-source-pair-mismatch");
  if (
    !Sha256Pattern.test(input.recordsManifestSha256) ||
    !Sha256Pattern.test(manifest.generationId) ||
    !Sha256Pattern.test(manifest.sourceManifestSha256) ||
    !Sha256Pattern.test(manifest.admittedCensusSha256) ||
    !manifest.recordsArtifactId ||
    !manifest.policyId ||
    !manifest.policySourceSha256 ||
    !manifest.runSource.repository ||
    !manifest.runSource.revision ||
    !manifest.runSource.tree ||
    sha256(canonical(manifest)) !== input.recordsManifestSha256
  )
    return refuse("ready-source-manifest-integrity");
  const nonnegativeInteger = (value: number) =>
    Number.isSafeInteger(value) && value >= 0;
  const sourceById = new Map<
    string,
    {
      entry: SourceEntry;
      bytes: Uint8Array;
      lineOffsets: number[];
    }
  >();
  if (manifest.sourceEntries.length !== input.originals.length)
    return refuse("ready-source-original-set-mismatch");
  const originals = new Map(
    input.originals.map((item) => [item.sourceId, item]),
  );
  if (originals.size !== input.originals.length)
    return refuse("ready-source-original-set-mismatch");
  for (const entry of manifest.sourceEntries) {
    const original = originals.get(entry.sourceId);
    if (
      !entry.sourceId ||
      sourceById.has(entry.sourceId) ||
      !original ||
      !isDeepStrictEqual(original.origin, entry.origin) ||
      !(original.bytes instanceof Uint8Array) ||
      !nonnegativeInteger(entry.byteLength) ||
      !nonnegativeInteger(entry.countedSourceBytes) ||
      (entry.countedSourceBytes !== 0 &&
        entry.countedSourceBytes !== entry.byteLength) ||
      (entry.bodyScope === "retained-excerpt" &&
        entry.countedSourceBytes !== 0) ||
      (entry.origin.kind === "records-original" &&
        entry.origin.contentSha256 !== entry.sourceTextSha256 &&
        entry.countedSourceBytes !== 0) ||
      original.bytes.byteLength !== entry.byteLength ||
      sha256(original.bytes) !== entry.sourceTextSha256 ||
      entry.policyId !== manifest.policyId ||
      entry.policySourceSha256 !== manifest.policySourceSha256 ||
      (entry.title !== null &&
        (!entry.title ||
          entry.title.includes("\n") ||
          Buffer.byteLength(entry.title) > 1024)) ||
      (entry.origin.kind === "git-blob" &&
        (entry.origin.repository !== manifest.runSource.repository ||
          entry.origin.revision !== manifest.runSource.revision ||
          entry.origin.tree !== manifest.runSource.tree))
    )
      return refuse("ready-source-original-integrity");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        original.bytes,
      );
    } catch {
      return refuse("ready-source-original-integrity");
    }
    const lineOffsets = [0];
    for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? [])
      lineOffsets.push(
        lineOffsets[lineOffsets.length - 1]! + Buffer.byteLength(line),
      );
    if (lineOffsets[lineOffsets.length - 1] !== entry.byteLength)
      return refuse("ready-source-original-integrity");
    sourceById.set(entry.sourceId, {
      entry,
      bytes: original.bytes,
      lineOffsets,
    });
  }
  const order = new Map(
    manifest.sourceEntries.map((entry, index) => [entry.sourceId, index]),
  );
  const occurrences: { fragment: SourceFragment; vectorBlockId: string }[] = [];
  let lastSource = -1;
  let lastEndByte = 0;
  for (const item of manifest.occurrences) {
    const source = sourceById.get(item.sourceId);
    const sourceOrder = order.get(item.sourceId);
    if (
      !source ||
      sourceOrder === undefined ||
      source.entry.countedSourceBytes !== source.entry.byteLength ||
      sourceOrder < lastSource ||
      (sourceOrder === lastSource && item.startByte < lastEndByte) ||
      !isDeepStrictEqual(item.origin, source.entry.origin) ||
      item.purpose !== source.entry.purpose ||
      item.bodyScope !== source.entry.bodyScope ||
      item.policyId !== source.entry.policyId ||
      item.policySourceSha256 !== source.entry.policySourceSha256 ||
      item.sourceTextSha256 !== source.entry.sourceTextSha256 ||
      !Number.isSafeInteger(item.startLine) ||
      !Number.isSafeInteger(item.endLine) ||
      item.startLine < 1 ||
      item.endLine < item.startLine ||
      source.lineOffsets[item.startLine - 1] !== item.startByte ||
      source.lineOffsets[item.endLine] !== item.endByte ||
      item.endByte - item.startByte > MAX_FRAGMENT_TEXT_BYTES ||
      item.endByte <= item.startByte
    )
      return refuse("ready-source-fragment-integrity");
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(source.bytes.subarray(item.startByte, item.endByte));
    const fragment: SourceFragment = {
      occurrenceId: item.occurrenceId,
      sourceId: item.sourceId,
      origin: item.origin,
      purpose: item.purpose,
      bodyScope: item.bodyScope,
      policyId: item.policyId,
      policySourceSha256: item.policySourceSha256,
      sourceTextSha256: item.sourceTextSha256,
      startLine: item.startLine,
      endLine: item.endLine,
      startByte: item.startByte,
      endByte: item.endByte,
      text,
      textSha256: item.textSha256,
      documentInputSha256: item.documentInputSha256,
      ...(source.entry.title === null ? {} : { title: source.entry.title }),
    };
    if (
      sha256(text) !== item.textSha256 ||
      fragmentOccurrenceId(fragment) !== item.occurrenceId ||
      sha256(
        formatSemanticInput({
          role: "document",
          text,
          ...(fragment.title === undefined ? {} : { title: fragment.title }),
        }),
      ) !== item.documentInputSha256
    )
      return refuse("ready-source-fragment-integrity");
    occurrences.push({ fragment, vectorBlockId: item.vectorBlockId });
    lastSource = sourceOrder;
    lastEndByte = item.endByte;
  }
  if (
    occurrences.length === 0 ||
    new Set(occurrences.map((item) => item.fragment.occurrenceId)).size !==
      occurrences.length
  )
    return refuse("ready-source-fragment-integrity");
  const distinctInputs = new Set(
    occurrences.map((item) => item.fragment.documentInputSha256),
  );
  const vectorBlocks: { id: string; encoded: Encoded }[] = [];
  for (const raw of input.vectorBlocks) {
    let block: typeof RetainedVectorBlockSchema.Type;
    try {
      block = Schema.decodeUnknownSync(RetainedVectorBlockSchema, {
        onExcessProperty: "error",
      })(raw);
    } catch {
      return refuse("ready-source-vector-integrity");
    }
    const encoded = validateRecordedBaseVector(block.encoded);
    if (
      !encoded ||
      block.id !== vectorBlockId(encoded) ||
      encoded.role !== "document" ||
      encoded.encoderFingerprint !== pair.pair.modelFingerprint ||
      fingerprintBaseRole(encoded.identity, encoded.role) !==
        pair.pair.documentRoleFingerprint ||
      !distinctInputs.has(encoded.formattedSha256)
    )
      return refuse("ready-source-vector-integrity");
    vectorBlocks.push({ id: block.id, encoded });
  }
  const blockByInput = new Map(
    vectorBlocks.map((block) => [block.encoded.formattedSha256, block.id]),
  );
  if (
    vectorBlocks.length !== distinctInputs.size ||
    blockByInput.size !== distinctInputs.size ||
    !isDeepStrictEqual(
      vectorBlocks.map((block) => block.id),
      manifest.vectorBlockIds,
    ) ||
    !isDeepStrictEqual(
      [...distinctInputs].map((key) => blockByInput.get(key)),
      manifest.vectorBlockIds,
    ) ||
    occurrences.some(
      (item) =>
        blockByInput.get(item.fragment.documentInputSha256) !==
        item.vectorBlockId,
    )
  )
    return refuse("ready-source-vector-set-mismatch");
  const omissions: readonly SourceOmission[] = manifest.omissions;
  if (
    omissions.some((item) => {
      const source = sourceById.get(item.sourceId);
      return (
        !source ||
        (item.startLine === null) !== (item.endLine === null) ||
        (item.startLine !== null &&
          (!Number.isSafeInteger(item.startLine) ||
            !Number.isSafeInteger(item.endLine) ||
            item.startLine < 1 ||
            item.endLine === null ||
            item.endLine < item.startLine ||
            item.endLine >= source.lineOffsets.length ||
            source.entry.countedSourceBytes !== source.entry.byteLength ||
            (item.reason !== "line-exceeds-fragment-limit" &&
              item.reason !== "fragment-count-exhausted"))) ||
        (item.startLine === null &&
          ((source.entry.countedSourceBytes !== 0 &&
            item.reason !== "empty-source") ||
            (item.reason === "empty-source" && source.entry.byteLength !== 0) ||
            (item.reason === "unsupported-retained-excerpt" &&
              source.entry.bodyScope !== "retained-excerpt") ||
            (item.reason === "original-digest-mismatch" &&
              (source.entry.origin.kind !== "records-original" ||
                source.entry.origin.contentSha256 ===
                  source.entry.sourceTextSha256)))) ||
        (item.reason === "line-exceeds-fragment-limit" &&
          item.startLine !== null &&
          item.endLine !== null &&
          (item.startLine !== item.endLine ||
            source.lineOffsets[item.endLine]! -
              source.lineOffsets[item.startLine - 1]! <=
              MAX_FRAGMENT_TEXT_BYTES)) ||
        (item.reason === "fragment-count-exhausted" &&
          item.startLine !== null &&
          item.endLine !== null &&
          source.lineOffsets[item.endLine]! -
            source.lineOffsets[item.startLine - 1]! >
            MAX_FRAGMENT_TEXT_BYTES)
      );
    }) ||
    manifest.sourceEntries.some((entry) => {
      const hasOccurrence = occurrences.some(
        (item) => item.fragment.sourceId === entry.sourceId,
      );
      const hasOmission = omissions.some(
        (item) => item.sourceId === entry.sourceId,
      );
      return (
        (!hasOccurrence && !hasOmission) ||
        (entry.countedSourceBytes === 0 && hasOccurrence)
      );
    })
  )
    return refuse("ready-source-omission-integrity");
  const population = manifest.population;
  const usage = manifest.usage;
  const expectedSourceManifestSha256 = sha256(
    canonical([
      manifest.sourceEntries.map((entry) => [
        entry.sourceId,
        entry.origin,
        entry.sourceTextSha256,
        entry.purpose,
        entry.bodyScope,
      ]),
      occurrences.map((item) => [
        item.fragment.occurrenceId,
        item.fragment.textSha256,
        item.fragment.documentInputSha256,
      ]),
      omissions,
    ]),
  );
  if (
    expectedSourceManifestSha256 !== manifest.sourceManifestSha256 ||
    population.suppliedSources !== manifest.sourceEntries.length ||
    population.indexedFragments !== occurrences.length ||
    population.omitted !== omissions.length ||
    population.admittedFragments !==
      occurrences.length +
        omissions.filter((item) => item.startLine !== null).length ||
    population.coverage !==
      (omissions.length === 0
        ? "complete-supplied-population"
        : "limited-supplied-population") ||
    (manifest.admittedPopulationCoverage === "complete" &&
      omissions.length > 0) ||
    Object.values(usage).some(
      (value) =>
        typeof value === "number" && (!Number.isFinite(value) || value < 0),
    ) ||
    !nonnegativeInteger(usage.retainedVectorHits) ||
    !nonnegativeInteger(usage.cacheHits) ||
    !nonnegativeInteger(usage.generated) ||
    !nonnegativeInteger(usage.encodeCalls) ||
    !nonnegativeInteger(usage.sourceBytes) ||
    !nonnegativeInteger(usage.vectorValueBytes) ||
    !nonnegativeInteger(usage.vectorArtifactBytes) ||
    !nonnegativeInteger(usage.vectorReuseOccurrences) ||
    usage.sourceBytes !==
      manifest.sourceEntries.reduce(
        (sum, entry) => sum + entry.countedSourceBytes,
        0,
      ) ||
    usage.vectorValueBytes !==
      vectorBlocks.reduce(
        (sum, block) => sum + block.encoded.values.length * 4,
        0,
      ) ||
    usage.vectorArtifactBytes !== Buffer.byteLength(canonical(vectorBlocks)) ||
    usage.vectorReuseOccurrences !== occurrences.length - distinctInputs.size ||
    usage.retainedVectorHits + usage.cacheHits + usage.generated !==
      distinctInputs.size
  )
    return refuse("ready-source-accounting-integrity");
  const ready: ReadySourceGeneration = {
    kind: "ready",
    schemaVersion: 1,
    generationId: manifest.generationId,
    policyId: manifest.policyId,
    policySourceSha256: manifest.policySourceSha256,
    runSource: manifest.runSource,
    segmentationRecipe: SEGMENTATION_RECIPE,
    sourceManifestSha256: manifest.sourceManifestSha256,
    sourceEntries: manifest.sourceEntries,
    pairRegistration: pair,
    producerFingerprint: manifest.producerFingerprint,
    occurrences,
    vectorBlocks,
    omissions,
    population,
    usage,
    recordsArtifactId: manifest.recordsArtifactId,
    recordsManifestSha256: input.recordsManifestSha256,
    admittedCensusSha256: manifest.admittedCensusSha256,
    admittedPopulationCoverage: manifest.admittedPopulationCoverage,
  };
  if (
    ready.generationId !== sourceGenerationDigest(ready) ||
    ready.recordsManifestSha256 !== fingerprintReadySourceManifest(ready)
  )
    return refuse("ready-source-identity-mismatch");
  for (const entry of manifest.sourceEntries) {
    const source = sourceById.get(entry.sourceId);
    if (!source) return refuse("ready-source-original-set-mismatch");
    const ranges = [
      ...occurrences
        .filter((item) => item.fragment.sourceId === entry.sourceId)
        .map((item) => ({
          startLine: item.fragment.startLine,
          endLine: item.fragment.endLine,
        })),
      ...omissions
        .filter(
          (item) => item.sourceId === entry.sourceId && item.startLine !== null,
        )
        .flatMap((item) =>
          item.startLine === null || item.endLine === null
            ? []
            : [{ startLine: item.startLine, endLine: item.endLine }],
        ),
    ].sort(
      (left, right) =>
        left.startLine - right.startLine || left.endLine - right.endLine,
    );
    if (entry.countedSourceBytes === 0) {
      if (ranges.length > 0) return refuse("ready-source-coverage-integrity");
      continue;
    }
    let nextLine = 1;
    for (const range of ranges) {
      if (range.startLine !== nextLine)
        return refuse("ready-source-coverage-integrity");
      nextLine = range.endLine + 1;
    }
    if (nextLine !== source.lineOffsets.length)
      return refuse("ready-source-coverage-integrity");
  }
  return ready;
};

export const buildBaseSourceGeneration = async (
  input: Readonly<{
    client: SemanticClient;
    policyId: string;
    policySourceSha256: string;
    pairRegistration: RegisteredBasePairRef;
    runSource: Readonly<{ repository: string; revision: string; tree: string }>;
    sources: readonly QualifiedTextSource[];
    retainedVectorBlocks?: readonly unknown[];
    limits: Readonly<{
      maxSources: number;
      maxFragments: number;
      maxSourceBytes: number;
    }>;
    onProgress?: (receipt: GenerationProgressReceipt) => Promise<void> | void;
    signal?: AbortSignal;
  }>,
): Promise<UnpublishedSourceGeneration | SourceIndexRefusal> => {
  const { limits } = input;
  if (
    !validateRegisteredBasePairRef(input.pairRegistration) ||
    input.pairRegistration.pair.operation !== "retrieval" ||
    !input.policyId ||
    !input.policySourceSha256 ||
    !input.runSource.repository ||
    !input.runSource.revision ||
    !input.runSource.tree ||
    Object.values(limits).some(
      (value) => !Number.isSafeInteger(value) || value < 1,
    )
  )
    return { kind: "refusal", reason: "invalid-generation-input" };
  const fragments: SourceFragment[] = [];
  const sourceEntries: SourceEntry[] = [];
  const omissions: SourceOmission[] = [];
  const seenSources = new Set<string>();
  let sourceBytes = 0;
  for (const [index, source] of input.sources.entries()) {
    if (seenSources.has(source.sourceId))
      return { kind: "refusal", reason: "duplicate-source-id" };
    seenSources.add(source.sourceId);
    if (
      !source.sourceId ||
      source.policyId !== input.policyId ||
      source.policySourceSha256 !== input.policySourceSha256 ||
      source.qualification !== "base-inference-admitted" ||
      sha256(source.text) !== source.textSha256 ||
      Buffer.from(source.text, "utf8").toString("utf8") !== source.text ||
      (source.origin.kind === "git-blob" &&
        (source.origin.repository !== input.runSource.repository ||
          source.origin.revision !== input.runSource.revision ||
          source.origin.tree !== input.runSource.tree))
    )
      return { kind: "refusal", reason: "source-qualification-mismatch" };
    const size = Buffer.byteLength(source.text);
    const countedSourceBytes =
      index < limits.maxSources &&
      source.bodyScope === "complete-original" &&
      (source.origin.kind !== "records-original" ||
        source.origin.contentSha256 === source.textSha256) &&
      sourceBytes + size <= limits.maxSourceBytes
        ? size
        : 0;
    sourceEntries.push({
      sourceId: source.sourceId,
      origin: source.origin,
      purpose: source.purpose,
      bodyScope: source.bodyScope,
      policyId: source.policyId,
      policySourceSha256: source.policySourceSha256,
      sourceTextSha256: source.textSha256,
      byteLength: size,
      countedSourceBytes,
      title: sourceTitle(source) ?? null,
    });
    if (index >= limits.maxSources) {
      omissions.push({
        sourceId: source.sourceId,
        reason: "source-count-exhausted",
        startLine: null,
        endLine: null,
      });
      continue;
    }
    if (source.bodyScope === "retained-excerpt") {
      omissions.push({
        sourceId: source.sourceId,
        reason: "unsupported-retained-excerpt",
        startLine: null,
        endLine: null,
      });
      continue;
    }
    if (
      source.origin.kind === "records-original" &&
      source.origin.contentSha256 !== source.textSha256
    ) {
      omissions.push({
        sourceId: source.sourceId,
        reason: "original-digest-mismatch",
        startLine: null,
        endLine: null,
      });
      continue;
    }
    if (sourceBytes + size > limits.maxSourceBytes) {
      omissions.push({
        sourceId: source.sourceId,
        reason: "source-budget-exhausted",
        startLine: null,
        endLine: null,
      });
      continue;
    }
    sourceBytes += size;
    const segmented = segmentQualifiedSource(source);
    omissions.push(...segmented.omissions);
    for (const fragment of segmented.fragments) {
      if (fragments.length >= limits.maxFragments)
        omissions.push({
          sourceId: source.sourceId,
          reason: "fragment-count-exhausted",
          startLine: fragment.startLine,
          endLine: fragment.endLine,
        });
      else fragments.push(fragment);
    }
  }
  if (fragments.length === 0)
    return { kind: "refusal", reason: "empty-admitted-source", omissions };
  if (
    new Set(fragments.map((item) => item.occurrenceId)).size !==
    fragments.length
  )
    return { kind: "refusal", reason: "duplicate-fragment-occurrence" };

  const distinct = new Map<string, SemanticInput>();
  for (const fragment of fragments) {
    if (!distinct.has(fragment.documentInputSha256))
      distinct.set(fragment.documentInputSha256, {
        role: "document",
        text: fragment.text,
        ...(fragment.title === undefined ? {} : { title: fragment.title }),
      });
  }
  const sourceManifestSha256 = sha256(
    canonical([
      input.sources.map((source) => [
        source.sourceId,
        source.origin,
        source.textSha256,
        source.purpose,
        source.bodyScope,
      ]),
      fragments.map((item) => [
        item.occurrenceId,
        item.textSha256,
        item.documentInputSha256,
      ]),
      omissions,
    ]),
  );
  const population: UnpublishedSourceGeneration["population"] = {
    suppliedSources: input.sources.length,
    admittedFragments:
      fragments.length +
      omissions.filter((item) => item.startLine !== null).length,
    indexedFragments: fragments.length,
    omitted: omissions.length,
    coverage:
      omissions.length === 0
        ? "complete-supplied-population"
        : "limited-supplied-population",
  };
  const encodedByInput = new Map<string, Encoded>();
  const retainedByInput = new Map<string, Encoded>();
  for (const raw of input.retainedVectorBlocks ?? []) {
    let block: typeof RetainedVectorBlockSchema.Type;
    try {
      block = Schema.decodeUnknownSync(RetainedVectorBlockSchema, {
        onExcessProperty: "error",
      })(raw);
    } catch {
      return { kind: "refusal", reason: "invalid-retained-vector-block" };
    }
    const encoded = validateRecordedBaseVector(block.encoded);
    if (!encoded || block.id !== vectorBlockId(encoded))
      return { kind: "refusal", reason: "invalid-retained-vector-block" };
    if (
      encoded.role !== "document" ||
      encoded.encoderFingerprint !==
        input.pairRegistration.pair.modelFingerprint ||
      fingerprintBaseRole(encoded.identity, encoded.role) !==
        input.pairRegistration.pair.documentRoleFingerprint
    )
      return { kind: "refusal", reason: "retained-vector-pair-mismatch" };
    if (!distinct.has(encoded.formattedSha256))
      return { kind: "refusal", reason: "retained-vector-out-of-corpus" };
    const prior = retainedByInput.get(encoded.formattedSha256);
    if (prior && vectorBlockId(prior) !== block.id)
      return { kind: "refusal", reason: "retained-vector-conflict" };
    retainedByInput.set(encoded.formattedSha256, encoded);
  }
  for (const [key, encoded] of retainedByInput)
    encodedByInput.set(key, encoded);
  const usage = {
    retainedVectorHits: retainedByInput.size,
    cacheHits: 0,
    generated: 0,
    encodeCalls: 0,
    encodeMillis: null as number | null,
    loadMillis: null as number | null,
    nativeForwardCalls: null as null,
    sourceBytes,
    vectorValueBytes: 0,
    vectorArtifactBytes: 0,
    vectorReuseOccurrences: fragments.length - distinct.size,
  };
  const orderedVectorBlocks = () =>
    [...distinct.keys()].flatMap((key) => {
      const encoded = encodedByInput.get(key);
      return encoded ? [{ id: vectorBlockId(encoded), encoded }] : [];
    });
  const pending = [...distinct.entries()].filter(
    ([key]) => !encodedByInput.has(key),
  );
  const progress = (): GenerationProgressReceipt => {
    const vectorBlocks = orderedVectorBlocks();
    return {
      kind: "generation-progress",
      sourceManifestSha256,
      pairRegistration: input.pairRegistration,
      completedUniqueDocuments: encodedByInput.size,
      totalUniqueDocuments: distinct.size,
      vectorBlocks,
      usage: {
        ...usage,
        vectorValueBytes: vectorBlocks.reduce(
          (sum, block) => sum + block.encoded.values.length * 4,
          0,
        ),
        vectorArtifactBytes: Buffer.byteLength(canonical(vectorBlocks)),
        vectorReuseOccurrences:
          fragments.filter((item) =>
            encodedByInput.has(item.documentInputSha256),
          ).length - encodedByInput.size,
      },
      omissions,
    };
  };
  const failed = (reason: string): SourceIndexRefusal => ({
    kind: "refusal",
    reason,
    omissions,
    ...(encodedByInput.size === 0 ? {} : { partial: progress() }),
  });
  if (retainedByInput.size > 0 && input.onProgress) {
    try {
      await input.onProgress(progress());
    } catch {
      return failed("progress-retention-failed");
    }
  }
  for (let offset = 0; offset < pending.length;) {
    const batch: SemanticInput[] = [];
    const keys: string[] = [];
    let batchBytes = 0;
    while (offset < pending.length && batch.length < MAX_BATCH_ITEMS) {
      const item = pending[offset];
      if (!item) break;
      let bytes: number;
      try {
        bytes = Buffer.byteLength(formatSemanticInput(item[1]));
      } catch {
        return failed("invalid-document-input");
      }
      if (batch.length > 0 && batchBytes + bytes > MAX_BATCH_FORMATTED_BYTES)
        break;
      if (bytes > MAX_BATCH_FORMATTED_BYTES)
        return failed("document-input-exceeds-batch");
      keys.push(item[0]);
      batch.push(item[1]);
      batchBytes += bytes;
      offset++;
    }
    let result: Awaited<ReturnType<SemanticClient["encodeBatch"]>>;
    try {
      result = await input.client.encodeBatch(batch, input.signal);
    } catch {
      return failed("encoder-execution-failed");
    }
    if (result.kind === "refusal") return failed(result.reason);
    if (result.items.length !== keys.length)
      return failed("incomplete-encoding-batch");
    if (
      result.items.some(
        (item) =>
          !validBaseVector(item) ||
          item.role !== "document" ||
          item.encoderFingerprint !==
            input.pairRegistration.pair.modelFingerprint ||
          fingerprintBaseRole(item.identity, item.role) !==
            input.pairRegistration.pair.documentRoleFingerprint,
      )
    )
      return failed("document-encoder-pair-mismatch");
    result.items.forEach((item, index) => {
      const key = keys[index];
      if (key) encodedByInput.set(key, item);
    });
    usage.cacheHits += result.usage.cacheHits;
    usage.generated += result.usage.generated;
    usage.encodeCalls += result.usage.encodeCalls;
    if (result.usage.encodeMillis !== null)
      usage.encodeMillis =
        (usage.encodeMillis ?? 0) + result.usage.encodeMillis;
    usage.loadMillis ??= result.usage.loadMillis;
    if (input.onProgress) {
      try {
        await input.onProgress(progress());
      } catch {
        return failed("progress-retention-failed");
      }
    }
  }
  if (encodedByInput.size !== distinct.size)
    return failed("incomplete-encoding");
  const vectorBlocks = orderedVectorBlocks();
  const blockByInput = new Map(
    [...encodedByInput.entries()].map(([key, encoded]) => [
      key,
      vectorBlockId(encoded),
    ]),
  );
  const occurrences = fragments.map((fragment) => ({
    fragment,
    vectorBlockId: blockByInput.get(fragment.documentInputSha256) ?? "",
  }));
  if (occurrences.some((item) => !item.vectorBlockId))
    return failed("incomplete-vector-reference");
  const producerFingerprint = vectorBlocks[0]?.encoded.encoderFingerprint;
  if (
    !producerFingerprint ||
    producerFingerprint !== input.pairRegistration.pair.modelFingerprint ||
    vectorBlocks.some(
      (block) => block.encoded.encoderFingerprint !== producerFingerprint,
    )
  )
    return failed("mixed-producer-generation");
  usage.vectorValueBytes = vectorBlocks.reduce(
    (sum, block) => sum + block.encoded.values.length * 4,
    0,
  );
  usage.vectorArtifactBytes = Buffer.byteLength(canonical(vectorBlocks));
  const body: Pick<
    UnpublishedSourceGeneration,
    | "policyId"
    | "policySourceSha256"
    | "runSource"
    | "segmentationRecipe"
    | "sourceManifestSha256"
    | "sourceEntries"
    | "pairRegistration"
    | "producerFingerprint"
    | "occurrences"
    | "vectorBlocks"
    | "omissions"
    | "population"
  > = {
    policyId: input.policyId,
    policySourceSha256: input.policySourceSha256,
    runSource: input.runSource,
    segmentationRecipe: SEGMENTATION_RECIPE,
    sourceManifestSha256,
    sourceEntries,
    pairRegistration: input.pairRegistration,
    producerFingerprint,
    occurrences,
    vectorBlocks,
    omissions,
    population,
  };
  return {
    kind: "unpublished",
    schemaVersion: 1,
    generationId: sourceGenerationDigest(body),
    ...body,
    usage,
  };
};

export type SemanticLead = Readonly<{
  occurrenceId: string;
  fragment: SourceFragment;
  score: number;
  vectorBlockId: string;
}>;

/** Search only a Records-published ready generation, rechecking every block. */
export const searchReadySourceGeneration = async (
  input: Readonly<{
    client: SemanticClient;
    readyGeneration: ReadySourceGeneration;
    registeredPair: RegisteredBasePairRef;
    query: string;
    role: "code-query" | "document-query";
    limit: number;
    onQueryReceipt?: (receipt: BatchResult) => Promise<void> | void;
    signal?: AbortSignal;
  }>,
): Promise<
  | SourceIndexRefusal
  | Readonly<{
      kind: "leads";
      generationId: string;
      queryInputSha256: string;
      queryEncoderFingerprint: string;
      queryEncoded: Encoded;
      leads: readonly SemanticLead[];
      population: number;
      omittedByLimit: number;
      admittedPopulationCoverage: "complete" | "limited";
      interpretation: "indexed-corpus-cosine-leads-only";
      usage: Extract<BatchResult, { kind: "encoded" }>["usage"];
    }>
> => {
  const generation = input.readyGeneration;
  const registeredPair = validateRegisteredBasePairRef(input.registeredPair);
  const retainedPair = validateRegisteredBasePairRef(
    generation.pairRegistration,
  );
  if (
    !registeredPair ||
    !retainedPair ||
    registeredPair.pair.operation !== "retrieval" ||
    registeredPair.artifactId !== retainedPair.artifactId ||
    registeredPair.recordId !== retainedPair.recordId ||
    registeredPair.pair.pairId !== retainedPair.pair.pairId ||
    input.role !== registeredPair.pair.queryRole
  )
    return { kind: "refusal", reason: "query-pair-generation-mismatch" };
  const population = generation.population;
  const actualOmitted = generation.omissions.length;
  const actualIndexed = generation.occurrences.length;
  const actualAdmittedFragments =
    actualIndexed +
    generation.omissions.filter((item) => item.startLine !== null).length;
  if (
    generation.kind !== "ready" ||
    !generation.recordsArtifactId ||
    !/^[a-f0-9]{64}$/.test(generation.recordsManifestSha256) ||
    !/^[a-f0-9]{64}$/.test(generation.admittedCensusSha256) ||
    actualIndexed === 0 ||
    !Number.isSafeInteger(population.suppliedSources) ||
    population.suppliedSources < 1 ||
    population.indexedFragments !== actualIndexed ||
    population.omitted !== actualOmitted ||
    population.admittedFragments !== actualAdmittedFragments ||
    (actualOmitted === 0 &&
      population.coverage !== "complete-supplied-population") ||
    (actualOmitted > 0 &&
      population.coverage !== "limited-supplied-population") ||
    (generation.admittedPopulationCoverage === "complete" &&
      actualOmitted > 0) ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 1024 ||
    generation.generationId !== sourceGenerationDigest(generation) ||
    generation.recordsManifestSha256 !==
      fingerprintReadySourceManifest(generation)
  )
    return { kind: "refusal", reason: "unqualified-ready-generation" };
  const blocks = new Map(
    generation.vectorBlocks.map((block) => [block.id, block.encoded]),
  );
  const validFragment = (fragment: SourceFragment, encoded: Encoded) => {
    try {
      return (
        sha256(fragment.text) === fragment.textSha256 &&
        fragment.occurrenceId === fragmentOccurrenceId(fragment) &&
        sha256(
          formatSemanticInput({
            role: "document",
            text: fragment.text,
            ...(fragment.title === undefined ? {} : { title: fragment.title }),
          }),
        ) === fragment.documentInputSha256 &&
        encoded.formattedSha256 === fragment.documentInputSha256 &&
        validBaseVector(encoded) &&
        encoded.role === "document" &&
        encoded.encoderFingerprint === generation.producerFingerprint &&
        fingerprintBaseRole(encoded.identity, encoded.role) ===
          registeredPair.pair.documentRoleFingerprint
      );
    } catch {
      return false;
    }
  };
  if (
    blocks.size !== generation.vectorBlocks.length ||
    generation.vectorBlocks.some(
      (block) => block.id !== vectorBlockId(block.encoded),
    ) ||
    generation.occurrences.some((item) => {
      const encoded = blocks.get(item.vectorBlockId);
      return !encoded || !validFragment(item.fragment, encoded);
    })
  )
    return { kind: "refusal", reason: "vector-artifact-integrity" };
  const result = await input.client.encodeBatch(
    [{ role: input.role, text: input.query }],
    input.signal,
  );
  if (input.onQueryReceipt) {
    try {
      await input.onQueryReceipt(structuredClone(result));
    } catch {
      return { kind: "refusal", reason: "query-receipt-retention-failed" };
    }
  }
  if (result.kind === "refusal") return result;
  const query = result.items[0];
  if (
    !query ||
    !validBaseVector(query) ||
    query.role !== input.role ||
    query.encoderFingerprint !== generation.producerFingerprint ||
    !matchesDeclaredVectorPair(
      registeredPair.pair,
      {
        role: query.role,
        fingerprint: fingerprintBaseRole(query.identity, query.role),
        dimension: query.values.length,
        normalization: "l2-unit-1e-4",
      },
      {
        role: "document",
        fingerprint: registeredPair.pair.documentRoleFingerprint,
        dimension: registeredPair.pair.dimension,
        normalization: "l2-unit-1e-4",
      },
    )
  )
    return { kind: "refusal", reason: "query-encoder-generation-mismatch" };
  const scored: SemanticLead[] = [];
  for (let offset = 0; offset < generation.occurrences.length; offset += 1024) {
    const slice = generation.occurrences.slice(offset, offset + 1024);
    const ranked = scorePool({
      query,
      candidates: slice.flatMap((item) => {
        const encoded = blocks.get(item.vectorBlockId);
        return encoded === undefined
          ? []
          : [
              {
                occurrenceId: item.fragment.occurrenceId,
                reference: item,
                encoded,
              },
            ];
      }),
      limit: input.limit,
    });
    if (ranked.kind === "refusal") return ranked;
    scored.push(
      ...ranked.selected.map((item) => ({
        occurrenceId: item.occurrenceId,
        fragment: item.reference.fragment,
        vectorBlockId: item.reference.vectorBlockId,
        score: item.score,
      })),
    );
  }
  scored.sort(
    (left, right) =>
      right.score - left.score ||
      left.occurrenceId.localeCompare(right.occurrenceId),
  );
  return {
    kind: "leads",
    generationId: generation.generationId,
    queryInputSha256: query.formattedSha256,
    queryEncoderFingerprint: query.encoderFingerprint,
    queryEncoded: query,
    leads: scored.slice(0, input.limit),
    population: generation.occurrences.length,
    omittedByLimit: Math.max(0, generation.occurrences.length - input.limit),
    admittedPopulationCoverage: generation.admittedPopulationCoverage,
    interpretation: "indexed-corpus-cosine-leads-only",
    usage: result.usage,
  };
};

export const EVIDENCE_ROLE_DESCRIPTIONS = {
  addresses: "The source directly addresses the stated review need.",
  challenges:
    "The source presents a condition that challenges the stated review need.",
  background:
    "The source gives background context without resolving the stated review need.",
} as const;
export type EvidenceCandidateRole = keyof typeof EVIDENCE_ROLE_DESCRIPTIONS;

export type SemanticEvidenceProbeV1 = Readonly<{
  kind: "semantic-evidence-probe";
  schemaVersion: 1;
  recipe: typeof EVIDENCE_PROBE_RECIPE;
  needId: string;
  occurrenceId: string;
  sourceTextSha256: string;
  encoderFingerprint: string;
  pairId: string;
  inputRole: "classification";
  sourceInputSha256: string;
  scores: readonly Readonly<{
    candidateRole: EvidenceCandidateRole;
    templateInputSha256: string;
    cosine: number;
  }>[];
  provisionalRole: EvidenceCandidateRole | null;
  abstention: "numerical-tie" | null;
  qualification: "advisory-unvalidated";
  usage: Readonly<{
    cacheHits: number;
    generated: number;
    encodeCalls: number;
    encodeMillis: number | null;
    loadMillis: number | null;
    nativeForwardCalls: null;
  }>;
}>;

/** Prototype evidence-role probe; it cannot establish support or a review lane. */
export const probeSemanticEvidenceV1 = async (
  input: Readonly<{
    client: SemanticClient;
    needId: string;
    needStatement: string;
    fragment: SourceFragment;
    signal?: AbortSignal;
  }>,
): Promise<SemanticEvidenceProbeV1 | SourceIndexRefusal> => {
  const roles = [
    "addresses",
    "background",
    "challenges",
  ] satisfies readonly EvidenceCandidateRole[];
  const sourceText = canonical({
    v: 1,
    need: input.needStatement,
    source: input.fragment.text,
  });
  const templates = roles.map((role) =>
    canonical({
      v: 1,
      need: input.needStatement,
      role: EVIDENCE_ROLE_DESCRIPTIONS[role],
    }),
  );
  if (!input.needId || !input.needStatement || !input.fragment.occurrenceId)
    return { kind: "refusal", reason: "invalid-evidence-probe-input" };
  if (
    sha256(input.fragment.text) !== input.fragment.textSha256 ||
    fragmentOccurrenceId(input.fragment) !== input.fragment.occurrenceId
  )
    return { kind: "refusal", reason: "fragment-integrity" };
  const result = await input.client.encodeBatch(
    [sourceText, ...templates].map((text) => ({
      role: "classification",
      text,
    })),
    input.signal,
  );
  if (result.kind === "refusal") return result;
  const query = result.items[0];
  if (!query || result.items.length !== 4)
    return { kind: "refusal", reason: "incomplete-evidence-probe" };
  const pair = qualifySupportedBaseEvidencePair(query);
  if (pair.kind === "refusal") return pair;
  if (
    result.items.some(
      (item) =>
        !validBaseVector(item) ||
        item.role !== "classification" ||
        fingerprintBaseRole(item.identity, item.role) !==
          pair.documentRoleFingerprint,
    )
  )
    return { kind: "refusal", reason: "evidence-role-pair-mismatch" };
  const ranked = scorePool({
    query,
    candidates: roles.flatMap((role, index) => {
      const encoded = result.items[index + 1];
      return encoded === undefined
        ? []
        : [{ occurrenceId: role, reference: role, encoded }];
    }),
    limit: 3,
  });
  if (ranked.kind === "refusal" || ranked.selected.length !== 3)
    return { kind: "refusal", reason: "incomplete-evidence-probe" };
  const scores = ranked.selected.map((item) => ({
    candidateRole: item.reference,
    templateInputSha256: item.encoded.formattedSha256,
    cosine: item.score,
  }));
  const top = scores[0];
  const second = scores[1];
  const tie = !top || !second || top.cosine - second.cosine <= NUMERICAL_TIE;
  return {
    kind: "semantic-evidence-probe",
    schemaVersion: 1,
    recipe: EVIDENCE_PROBE_RECIPE,
    needId: input.needId,
    occurrenceId: input.fragment.occurrenceId,
    sourceTextSha256: input.fragment.textSha256,
    encoderFingerprint: query.encoderFingerprint,
    pairId: pair.pairId,
    inputRole: "classification",
    sourceInputSha256: query.formattedSha256,
    scores,
    provisionalRole: tie ? null : top.candidateRole,
    abstention: tie ? "numerical-tie" : null,
    qualification: "advisory-unvalidated",
    usage: result.usage,
  };
};
