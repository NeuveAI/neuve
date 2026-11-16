import { preserveUnknown } from "@neuve/records-schema";
import { closeInspectionBudget } from "./safety.ts";
import { scanFailureKind } from "./scan-failure.ts";
import { FILING_TIMEOUT_MS } from "./filing.ts";
import * as CaptureRecords from "./records.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CloseDiagnostic } from "./close-diagnostic.ts";
import { fileRawCapture, scanRawCapture, RawCapturePruned } from "./raw.ts";
import { joinedScan, withProgressWatchdog } from "./watchdog.ts";
import { inspectionBudgetRefusal } from "./inspection-refusal.ts";
import {
  ARTIFACT_TEXT_POLICY,
  artifactRepresentation,
  encodeArtifactText,
} from "./representation.ts";
import { Cause, Data, Effect, Option } from "effect";
import { z } from "zod";
import { SqlClient } from "effect/sql/SqlClient";
import { Blobs } from "@neuve/records-core";
import {
  DEFAULT_LIMITS,
  SourceValidation,
  SOURCE_VALIDATION_FILE,
  DUMP_FORMAT,
  DumpRejected,
  decodeManifest,
  encodeManifest,
  readDump,
  validatePortableMetadata,
  writeDump,
  type DatasetRetention,
  type DumpLimits,
  DumpManifest,
  type ExportRecord,
  type Redaction,
  type RedactionRecord,
} from "./archive.ts";
import {
  buildDump,
  DumpFailed,
  type BuildInput,
  type BuiltDump,
  type CloseInspection,
  type DumpContent,
} from "./build.ts";
import {
  CallRecord,
  RunDump,
  SessionDump,
  type ArtifactRecord,
} from "./dump.ts";
import { sha256Of } from "./journal.ts";
import { validateProvenance, validateProjection } from "./provenance.ts";
import { RECIPE_FILE, ProjectionRecipe } from "./sources.ts";
import {
  PORTABLE_WITHHELD,
  withholdReasoning,
  withholdReasoningText,
} from "./mask.ts";
import { providerOutputAvailable } from "./provider-output.ts";
import {
  CredentialJson,
  inspectionFailure,
  type InspectionBudget,
} from "./credential-detectors.ts";
import {
  CAPTURE_VERSION,
  CREDENTIAL_INSPECTION_POLICY,
  RETAINED_SDK_ASSEMBLY_POLICY,
  RETAINED_SDK_PIN,
  JournalLine,
  type Json,
} from "./types.ts";

/**
 * A run's session dump in its homes. The restricted capture is what `buildDump` makes: identifiers
 * masked, provider continuation and reasoning kept exactly, original artifact bytes and pi's native
 * SQLite backup included. It is kept in Records as `raw-capture` blobs (`captureRunDump`), where the
 * 30-day limit, pruning and tombstones apply, or written straight to a folder where no Records
 * service exists (`exportSnapshot`). A dataset folder copies one restricted snapshot byte for byte
 * (`exportCapturedDump`), or derives a portable copy from it for inspection only. Every home reads
 * back whole or not at all, under the snapshot's one identity: the restricted manifest's hash. The
 * reader that every home answers to checks a dump's exact bytes before they are stored or filed,
 * and a capture in Records is read back through it before its hash is handed on, so a hash that
 * may authorize deleting a run folder always names a capture the reader accepts.
 */

export const DUMP_MEDIA_TYPE = "application/vnd.neuve.session-dump+json";

const retainedPrefixProof = (
  bytes: Uint8Array | undefined,
): ReadonlyArray<string> => {
  if (bytes === undefined) return [];
  const calls = new Set<string>();
  const rows = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
    .decode(bytes)
    .split("\n")
    .slice(0, -1);
  for (const row of rows) {
    const parsed = JournalLine.safeParse(CredentialJson.parse(row).value);
    if (!parsed.success)
      throw new DumpRefused({
        capture: "source",
        reason: "restricted prefix evidence invalid",
      });
    const event = parsed.data.event;
    if (event.type === "credential.inspection" && event.version === 3)
      for (const call of event.retainedPrefixCalls) calls.add(call);
  }
  return [...calls].toSorted();
};

const manifestOf = (
  run: RunDump,
  redaction: Redaction,
  contents: ReadonlyArray<DumpContent>,
  retainedPrefixCalls?: ReadonlyArray<string>,
): DumpManifest => ({
  format: DUMP_FORMAT,
  version: CAPTURE_VERSION,
  runId: run.runId,
  runKind: run.runKind,
  redaction,
  inspectionPolicy: CREDENTIAL_INSPECTION_POLICY,
  retainedAssemblyPolicy: RETAINED_SDK_ASSEMBLY_POLICY,
  retainedSdkPin: RETAINED_SDK_PIN,
  retainedPrefixCalls: [
    ...(retainedPrefixCalls ??
      retainedPrefixProof(
        run.journal.status === "captured"
          ? contents.find(
              (content) =>
                run.journal.status === "captured" &&
                content.name === run.journal.file,
            )?.bytes
          : undefined,
      )),
  ].toSorted(),
  files: contents.map((content) => ({
    name: content.name,
    mediaType: content.mediaType,
    sha256: sha256Of(content.bytes),
    size: content.bytes.byteLength,
  })),
});

/** A built dump named and checked by the reader over the exact bytes it would store. */
const sealed = async (
  dump: BuiltDump,
  source: string,
  scan?: DumpManifest["scan"],
) => {
  const manifest = {
    ...manifestOf(dump.run, "restricted", dump.contents),
    ...(scan === undefined ? {} : { scan }),
  };
  const manifestBytes = encodeManifest(manifest);
  const files = new Map(dump.contents.map((c) => [c.name, c.bytes]));
  return {
    contents: dump.contents,
    manifest,
    manifestBytes,
    snapshotId: sha256Of(manifestBytes),
    files,
    restored: await parseDump(
      source,
      manifest,
      files,
      undefined,
      dump.inspection?.budget,
    ),
  };
};

const failedBuild = (error: unknown) =>
  error instanceof DumpFailed || error instanceof DumpRejected
    ? error
    : new DumpFailed({
        failureKind: scanFailureKind(error),
        reason: error instanceof Error ? error.message : String(error),
      });

/** Files immutable raw bytes and queues inspection. The close never waits for a scan. */
export const captureRunDump = (input: BuildInput) =>
  withProgressWatchdog((progress, signal) =>
    Effect.map(
      fileRawCapture({
        ...input,
        signal:
          input.signal === undefined
            ? signal
            : AbortSignal.any([signal, input.signal]),
        progress: () => {
          progress();
          input.progress?.();
        },
      }),
      ({ rawCapture, manifest }) => ({
        capture: rawCapture,
        snapshotId: rawCapture,
        raw: manifest,
      }),
    ),
  ).pipe(
    Effect.timeoutOrElse({
      duration: FILING_TIMEOUT_MS,
      orElse: () =>
        Effect.fail(
          new DumpFailed({
            reason: "raw capture filing exceeded its byte-cap allowance",
          }),
        ),
    }),
  );

export const sealCapturedDump = (
  input: BuildInput,
  scan: NonNullable<DumpManifest["scan"]>,
  persist = true,
) =>
  Effect.suspend(() => {
    let inspection: CloseInspection | undefined;
    return Effect.gen(function* () {
      const blobs = yield* Blobs.BlobStore;
      const dump = yield* joinedScan(async (signal) => {
        const built = await buildDump(
          {
            ...input,
            signal:
              input.signal === undefined
                ? signal
                : AbortSignal.any([signal, input.signal]),
          },
          true,
        );
        inspection = built.inspection;
        return sealed(built, "built", scan);
      }).pipe(Effect.mapError(failedBuild));
      if (!persist) {
        yield* Effect.promise(async () => inspection?.complete());
        return {
          capture: dump.snapshotId,
          snapshotId: dump.snapshotId,
          run: dump.restored.run,
        };
      }
      const put = (request: Blobs.PutRequest) =>
        Effect.gen(function* () {
          const raw = yield* blobs.inspect(scan.rawCapture);
          if (Option.isNone(raw) || raw.value.prunedAt !== null)
            return yield* Effect.fail(
              new DumpRefused({
                capture: scan.rawCapture,
                reason: "raw capture was pruned",
              }),
            );
          return yield* blobs.put({ ...request, restore: "never" });
        });
      for (const content of dump.contents) {
        yield* put({
          bytes: content.bytes,
          mediaType: content.mediaType,
          retention: "raw-capture",
        });
        input.progress?.();
      }
      yield* put({
        bytes: dump.manifestBytes,
        mediaType: DUMP_MEDIA_TYPE,
        retention: "raw-capture",
      });
      input.progress?.();
      const stored = yield* Effect.flatMap(
        readCapturedFiles(dump.snapshotId, input.limits ?? DEFAULT_LIMITS),
        ({ source, manifest, files }) =>
          Effect.tryPromise({
            try: () =>
              parseDump(source, manifest, files, undefined, inspection?.budget),
            catch: asRejection(source),
          }),
      );
      yield* Effect.tryPromise({
        try: async () => inspection?.complete(),
        catch: failedBuild,
      });
      const diagnostic = yield* Effect.tryPromise({
        try: async () => {
          const value = CloseDiagnostic.parse(
            JSON.parse(
              await readFile(
                join(input.journal, "close-diagnostic.json"),
                "utf8",
              ),
            ),
          );
          return new TextEncoder().encode(JSON.stringify(value));
        },
        catch: failedBuild,
      }).pipe(Effect.option);
      const diagnosticHash = Option.isSome(diagnostic)
        ? yield* put({
            bytes: diagnostic.value,
            mediaType: "application/vnd.neuve.capture-scan-diagnostic+json",
            retention: "raw-capture",
          }).pipe(Effect.as(sha256Of(diagnostic.value)), Effect.option)
        : Option.none<string>();
      return {
        capture: dump.snapshotId,
        snapshotId: dump.snapshotId,
        run: stored.run,
        ...(Option.isSome(diagnosticHash)
          ? { diagnostic: diagnosticHash.value }
          : {}),
      };
    }).pipe(
      Effect.tapError((error) =>
        Effect.promise(async () => inspection?.failure(error)),
      ),
      Effect.onInterrupt(() =>
        Effect.promise(async () => {
          await inspection?.failure(
            input.signal?.reason ??
              new Error("Credential inspection unavailable (cancelled)"),
          );
        }),
      ),
      Effect.ensuring(Effect.sync(() => inspection?.budget.dispose())),
    );
  });

export interface RestoredDump {
  /** The folder it was read from, or `records:<manifest hash>`. */
  readonly source: string;
  readonly manifest: DumpManifest;
  readonly run: RunDump;
  readonly sessions: ReadonlyArray<SessionDump>;
  readonly unjoined: ReadonlyArray<CallRecord>;
  /** The bytes each artifact carries here, by its `run.artifacts[].file`, each checked against its hash. */
  readonly artifacts: ReadonlyMap<string, Uint8Array>;
  /** Artifacts whose original bytes are not here, so their `original.sha256` only the restricted capture can recompute. */
  readonly unverifiableOriginals: ReadonlyArray<string>;
}

/** Every file an artifact, the native backup or the raw journal puts in the dump, each with the hash it must have. */
const carried = (run: RunDump) => {
  const files = new Map<
    string,
    { readonly sha256: string; readonly size: number | null }
  >();
  for (const artifact of run.artifacts) {
    if (artifact.file !== null && artifact.sha256 !== null)
      files.set(artifact.file, {
        sha256: artifact.sha256,
        size: artifact.size,
      });
    if (artifact.original.file !== null)
      files.set(artifact.original.file, {
        sha256: artifact.original.sha256,
        size: artifact.original.size,
      });
  }
  if (run.backup.status === "captured")
    files.set(run.backup.file, {
      sha256: run.backup.sha256,
      size: run.backup.size,
    });
  if (run.journal.status === "captured")
    files.set(run.journal.file, {
      sha256: run.journal.sha256,
      size: run.journal.size,
    });
  return files;
};

/**
 * Parses a dump's files against their schemas and against each other: run.json must name exactly
 * the files the manifest lists, agree with the manifest's run and redaction, and claim completeness
 * only as its gaps allow; every artifact and backup file must hash as run.json says. Any mismatch
 * rejects the whole dump.
 */
const parseContents = async (
  source: string,
  manifest: DumpManifest,
  files: ReadonlyMap<string, Uint8Array>,
  snapshotId?: string,
  budget?: InspectionBudget,
  verified = false,
): Promise<RestoredDump> => {
  budget?.charge("units", 0);
  const reject = (reason: string): never => {
    throw new DumpRejected({ source, reason });
  };
  const json = <T>(schema: z.ZodType<T>, name: string): T => {
    const bytes = files.get(name) ?? reject(`missing ${name}`);
    let value: unknown;
    try {
      value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
    } catch (error) {
      reject(`${name} is not JSON: ${String(error)}`);
    }
    const parsed = schema.safeParse(value);
    return parsed.success
      ? parsed.data
      : reject(
          `${name} does not match its schema: ${parsed.error.issues[0]?.message ?? ""}`,
        );
  };
  const run = json(RunDump, "run.json");
  if (run.runId !== manifest.runId || run.runKind !== manifest.runKind)
    reject("run.json disagrees with the manifest");
  if (run.complete !== run.gaps.every((g) => g.kind === "execution"))
    reject("run.json claims completeness its gaps contradict");
  if (run.execution === "ended" && run.gaps.some((g) => g.kind === "execution"))
    reject("an ended run cannot owe execution");
  const portable = manifest.redaction === "portable";
  if (portable !== (run.backup.status === "withheld"))
    reject("the native backup's status disagrees with the redaction");
  if (portable !== (run.journal.status === "withheld"))
    reject("the raw journal's status disagrees with the redaction");
  if (
    portable
      ? run.artifacts.some(
          (a) =>
            a.original.file !== null ||
            (a.sanitization === "raw-uninspected" && a.file !== null),
        )
      : run.artifacts.some((a) => a.file === null || a.original.file === null)
  )
    reject("the artifacts carried disagree with the redaction");
  const expected = carried(run);
  const names = [
    "run.json",
    "calls/unjoined.json",
    ...(portable
      ? files.has(SOURCE_VALIDATION_FILE)
        ? [SOURCE_VALIDATION_FILE]
        : []
      : [RECIPE_FILE]),
    ...run.sessions.map((s) => s.file),
    ...expected.keys(),
  ].toSorted();
  if (JSON.stringify(names) !== JSON.stringify([...files.keys()].toSorted()))
    reject("the manifest's files are not the ones run.json names");
  for (const [name, metadata] of expected)
    if (
      sha256Of(files.get(name)!) !== metadata.sha256 ||
      files.get(name)!.byteLength !== metadata.size
    )
      reject(`${name} does not match its recorded checksum`);
  const artifacts = new Map<string, Uint8Array>();
  for (const artifact of run.artifacts)
    if (artifact.file !== null)
      artifacts.set(artifact.file, files.get(artifact.file)!);
  const sessions = run.sessions.map((s) => json(SessionDump, s.file));
  const unjoined = json(z.array(CallRecord), "calls/unjoined.json");
  if (!verified) {
    const journalLines: Array<JournalLine> = [];
    const journalFrames: CredentialJson[] = [];
    let tornLines = 0;
    if (run.journal.status === "captured") {
      const text = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(files.get(run.journal.file));
      const rows = text.split("\n");
      for (const [index, row] of rows.entries()) {
        if (row === "" && index === rows.length - 1) continue;
        let value: unknown;
        let frame: CredentialJson | undefined;
        try {
          const parsed = CredentialJson.parse(row);
          value = parsed.value;
          frame = parsed.source;
        } catch {
          if (
            index === rows.length - 1 &&
            run.gaps.some((gap) => gap.code === "journal-torn")
          ) {
            tornLines += 1;
            continue;
          }
          reject("raw journal contains an invalid line");
        }
        const parsed = JournalLine.safeParse(value);
        if (!parsed.success)
          reject("raw journal line does not match its schema");
        else {
          if (parsed.data.seq !== journalLines.length + 1)
            reject("raw journal sequence is not contiguous");
          journalLines.push(parsed.data);
          if (frame === undefined) reject("raw journal source witness missing");
          else journalFrames.push(frame);
        }
      }
    }
    if (
      !portable &&
      JSON.stringify(manifest.retainedPrefixCalls ?? []) !==
        JSON.stringify(
          retainedPrefixProof(
            run.journal.status === "captured"
              ? files.get(run.journal.file)
              : undefined,
          ),
        )
    )
      reject(
        "restricted retained-prefix proof disagrees with original journal",
      );
    await validateProjection({
      budget,
      source,
      run,
      sessions,
      unjoined,
      journal: journalLines,
      journalFrames,
      files,
      portable,
      snapshotId,
      recipe: portable ? undefined : json(ProjectionRecipe, RECIPE_FILE),
      tornLines: Math.max(
        tornLines,
        run.gaps.find((gap) => gap.code === "journal-torn")?.count ?? 0,
      ),
    });
    validateProvenance(source, run, sessions, unjoined, journalLines);
  }
  budget?.charge("units", 0);
  return {
    source,
    manifest,
    run,
    sessions,
    unjoined,
    artifacts,
    unverifiableOriginals: run.artifacts
      .filter((artifact) => artifact.original.file === null)
      .map((artifact) => artifact.name),
  };
};

const parseDump = async (
  ...args: Parameters<typeof parseContents>
): Promise<RestoredDump> => {
  try {
    return await parseContents(...args);
  } catch (error) {
    const budget = args[4];
    const failure = inspectionFailure(error);
    if (
      budget !== undefined &&
      (failure.reason === "budget" || failure.reason === "cancelled")
    )
      throw inspectionBudgetRefusal(failure, budget, "finalization");
    throw error;
  }
};

const asRejection = (source: string) => (error: unknown) =>
  error instanceof DumpRejected
    ? error
    : new DumpRejected({
        source,
        failureKind: scanFailureKind(error),
        reason: error instanceof Error ? error.message : String(error),
      });

/** A capture's manifest and files read from Records, each blob checked against its size and hash. */
const readCapturedFiles = (
  capture: string,
  limits: DumpLimits,
  progress: () => void = () => {},
) =>
  Effect.gen(function* () {
    const source = `records:${capture}`;
    const reject = (reason: string) =>
      Effect.fail(new DumpRejected({ source, reason }));
    const blobs = yield* Blobs.BlobStore;
    const read = (hash: string, maximum: number, size?: number) =>
      Effect.gen(function* () {
        const metadata = yield* blobs
          .inspect(hash)
          .pipe(Effect.mapError(asRejection(source)));
        if (Option.isNone(metadata))
          return yield* reject(`blob ${hash} is missing`);
        if (metadata.value.prunedAt !== null)
          return yield* new RawCapturePruned({
            reason: `raw capture pruned on ${metadata.value.prunedAt}`,
          });
        if (metadata.value.size > maximum)
          return yield* reject(`blob ${hash} over its size limit`);
        if (size !== undefined && metadata.value.size !== size)
          return yield* reject(`blob ${hash}: size mismatch`);
        const blob = yield* blobs
          .get(hash)
          .pipe(Effect.mapError(asRejection(source)));
        if (blob._tag === "Pruned")
          return yield* new RawCapturePruned({
            reason: `raw capture pruned on ${blob.blob.prunedAt}`,
          });
        if (
          blob.bytes.byteLength > maximum ||
          blob.bytes.byteLength !== metadata.value.size
        )
          return yield* reject(`blob ${hash}: size mismatch`);
        return blob.bytes;
      });
    const manifestBytes = yield* read(capture, limits.manifestBytes);
    if (sha256Of(manifestBytes) !== capture)
      return yield* reject("manifest checksum mismatch");
    const manifest = decodeManifest(manifestBytes, limits);
    if (typeof manifest === "string") return yield* reject(manifest);
    if (manifest.redaction !== "restricted")
      return yield* reject("Records holds only restricted captures");
    const files = new Map<string, Uint8Array>();
    for (const file of manifest.files) {
      const content = yield* read(file.sha256, limits.objectBytes, file.size);
      if (content.byteLength !== file.size || sha256Of(content) !== file.sha256)
        return yield* reject(`${file.name}: checksum mismatch`);
      files.set(file.name, content);
      progress();
    }
    return { source, manifest, manifestBytes, files };
  });

/** Reads a restricted capture back from Records by its manifest's hash; a pruned one is refused by name. */
export const readCapturedDump = (
  capture: string,
  limits: DumpLimits = DEFAULT_LIMITS,
  budget?: InspectionBudget,
) =>
  Effect.gen(function* () {
    const mark = yield* CaptureRecords.scanStatus(capture);
    if (mark.status !== "clean")
      return yield* Effect.fail(
        new DumpRefused({
          capture,
          reason:
            mark.status === "refused"
              ? (mark.reason ?? "capture scan refused; export refused")
              : "capture scan has not passed; export refused",
        }),
      );
    const held = yield* readCapturedFiles(mark.capture, limits);
    if (held.manifest.scan?.rawCapture !== mark.rawCapture)
      return yield* Effect.fail(
        new DumpRefused({
          capture,
          reason:
            "capture clean mark disagrees with its sealed record; export refused",
        }),
      );
    return yield* Effect.tryPromise({
      try: () =>
        parseDump(
          held.source,
          held.manifest,
          held.files,
          undefined,
          budget,
          true,
        ),
      catch: asRejection(held.source),
    });
  });

/** Reads a dataset folder back: every file checked against its size and hash, then its schema. */
export const readSessionDump = (
  directory: string,
  limits: DumpLimits = DEFAULT_LIMITS,
) =>
  Effect.tryPromise({
    try: async () => {
      const dump = await readDump(directory, limits);
      if (
        dump.record.source.startsWith("records:") &&
        (dump.manifest.scan === undefined ||
          dump.record.captureMark?.payload.outcome !== "clean" ||
          dump.record.captureMark.payload.record !== dump.record.snapshotId ||
          dump.record.captureMark.payload.rawCapture !==
            dump.manifest.scan.rawCapture ||
          dump.record.captureMark.payload.detectorVersion !==
            dump.manifest.scan.policy)
      )
        throw new DumpRejected({
          source: directory,
          reason: "capture scan has not passed; export refused",
        });
      return {
        ...(await parseDump(
          dump.directory,
          dump.manifest,
          dump.files,
          dump.record.snapshotId,
          undefined,
          false,
        )),
        record: dump.record,
      };
    },
    catch: asRejection(directory),
  });

/** A capture a dataset may not hold: it names no run kind, or is a scored run that asked for summaries. */
export class DumpRefused extends Data.TaggedError("DumpRefused")<{
  readonly capture: string;
  readonly reason: string;
}> {}

export interface SnapshotExport {
  readonly directory: string;
  readonly runId: string;
  /** The restricted manifest's hash, which names the folder. */
  readonly snapshotId: string;
  readonly redaction: Redaction;
  /** True when the folder already held this snapshot and verified. */
  readonly reused: boolean;
  readonly run: RunDump;
}

const unfileable = (run: RunDump) => {
  if (run.runKind === null)
    return "no run.start was captured, so the run has no kind to file it under";
  if (run.gaps.some((g) => g.code === "scored-with-summaries"))
    return "a scored run whose requests asked for reasoning summaries";
  return undefined;
};

const encodeJson = (value: unknown) =>
  new TextEncoder().encode(`${JSON.stringify(value)}\n`);

/**
 * The portable copy of a restricted snapshot: every JSON file with provider continuation and
 * reasoning withheld (its identifiers were masked already), artifact originals and raw artifacts
 * dropped, and the native backup and raw journal withheld. It declares what it withholds and names the restricted
 * files it came from. It is for inspection only and never an executable backup.
 */
const derivePortable = (
  restricted: RestoredDump,
  files: ReadonlyMap<string, Uint8Array>,
  manifestBytes: Uint8Array,
  source: ExportRecord["source"],
) => {
  const recipe = ProjectionRecipe.parse(
    JSON.parse(new TextDecoder().decode(files.get(RECIPE_FILE))),
  );
  if (recipe.sourceValidationVersion === undefined)
    throw new DumpRefused({
      capture: sha256Of(manifestBytes),
      reason:
        "portable source validation requires re-exporting original sources with retained lifecycle scopes",
    });
  const withheld = (value: unknown) => withholdReasoning(value as Json);
  const artifactContents: Array<DumpContent> = [];
  const artifacts: Array<ArtifactRecord> = restricted.run.artifacts.map(
    (artifact) => {
      if (artifact.sanitization === "raw-uninspected")
        return {
          ...artifact,
          file: null,
          sha256: null,
          size: null,
          original: { ...artifact.original, file: null },
        };
      const original = files.get(artifact.file!)!;
      const representation = artifactRepresentation({
        mediaType: artifact.mediaType,
        bytes: original,
      });
      if (representation._tag !== "Text")
        throw new Error(
          "sanitized artifact has no supported text representation",
        );
      const bytes = encodeArtifactText(
        representation.json
          ? JSON.stringify(withheld(JSON.parse(representation.text))) + "\n"
          : withholdReasoningText(representation.text),
        representation,
      );
      artifactContents.push({
        name: artifact.file!,
        mediaType: artifact.mediaType,
        bytes,
      });
      return {
        ...artifact,
        sha256: sha256Of(bytes),
        size: bytes.byteLength,
        original: { ...artifact.original, file: null },
      };
    },
  );
  const run = RunDump.parse({
    ...restricted.run,
    backup: {
      status: "withheld",
      reason:
        restricted.run.backup.status === "captured"
          ? "a portable copy never carries pi's native state"
          : `a portable copy never carries pi's native state; the restricted capture had none: ${restricted.run.backup.reason}`,
    },
    journal: {
      status: "withheld",
      reason:
        restricted.run.journal.status === "captured"
          ? "a portable copy never carries the raw capture journal"
          : `a portable copy never carries the raw capture journal; the restricted capture had none: ${restricted.run.journal.reason}`,
    },
    artifacts,
  });
  const contents: Array<DumpContent> = [
    {
      name: "run.json",
      mediaType: "application/json",
      bytes: encodeJson(withheld(run)),
    },
    ...restricted.run.sessions.map((session, index) => ({
      name: session.file,
      mediaType: "application/json",
      bytes: encodeJson(withheld(restricted.sessions[index])),
    })),
    {
      name: "calls/unjoined.json",
      mediaType: "application/json",
      bytes: encodeJson(withheld(restricted.unjoined)),
    },
    ...artifactContents,
  ];
  const retainedPrefixCalls = restricted.manifest.retainedPrefixCalls ?? [];
  contents.push({
    name: SOURCE_VALIDATION_FILE,
    mediaType: "application/json",
    bytes: encodeJson(
      SourceValidation.parse({
        version: 10,
        basis: CREDENTIAL_INSPECTION_POLICY,
        restrictedSnapshot: sha256Of(manifestBytes),
        restrictedManifest: new TextDecoder("utf-8", { fatal: true }).decode(
          manifestBytes,
        ),
        source,
        retainedPrefixCalls: [...retainedPrefixCalls].toSorted(),
        unavailableProviderOutputCalls: [
          ...restricted.sessions.flatMap((session) => session.calls),
          ...restricted.unjoined,
        ]
          .filter((call) => !providerOutputAvailable(call))
          .map((call) => call.callId)
          .toSorted(),
        projections: contents
          .map((content) => ({
            name: content.name,
            mediaType: content.mediaType,
            sha256: sha256Of(content.bytes),
            size: content.bytes.byteLength,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      }),
    ),
  });
  const manifest = {
    ...manifestOf(run, "portable", contents, retainedPrefixCalls),
    ...(restricted.manifest.scan === undefined
      ? {}
      : { scan: restricted.manifest.scan }),
  };
  const redaction: RedactionRecord = {
    mode: "portable",
    inspectionOnly: true,
    withheld: [...PORTABLE_WITHHELD],
    restrictedFiles: restricted.manifest.files,
  };
  return {
    manifest,
    manifestBytes: encodeManifest(manifest),
    files: new Map(contents.map((content) => [content.name, content.bytes])),
    redaction,
    run,
  };
};

interface FileInput {
  readonly root: string;
  readonly retention: DatasetRetention;
  readonly now?: (() => Date) | undefined;
}

/**
 * Files one verified restricted snapshot in its restricted or portable form and reads the folder
 * back whole. The same snapshot filed again verifies and reuses its folder.
 */
const fileSnapshot = async (
  input: FileInput & {
    readonly source: ExportRecord["source"];
    readonly snapshotId: string;
    readonly redaction: Redaction;
    readonly manifest: DumpManifest;
    readonly manifestBytes: Uint8Array;
    readonly files: ReadonlyMap<string, Uint8Array>;
    readonly restored: RestoredDump;
    readonly budget?: InspectionBudget | undefined;
    readonly captureMark?: ExportRecord["captureMark"];
  },
): Promise<SnapshotExport> => {
  const refused = unfileable(input.restored.run);
  if (refused !== undefined)
    throw new DumpRefused({ capture: input.snapshotId, reason: refused });
  const target =
    input.redaction === "restricted"
      ? {
          manifest: input.manifest,
          manifestBytes: input.manifestBytes,
          files: input.files,
          redaction: { mode: "restricted" } as const,
          run: input.restored.run,
        }
      : derivePortable(
          input.restored,
          input.files,
          input.manifestBytes,
          input.source,
        );
  await parseDump(
    "derived",
    target.manifest,
    target.files,
    input.snapshotId,
    input.budget,
    false,
  );
  const record: ExportRecord = {
    format: `${DUMP_FORMAT}.export`,
    snapshotId: input.snapshotId,
    manifest: sha256Of(target.manifestBytes),
    source: input.source,
    exportedAt: (input.now ?? (() => new Date()))().toISOString(),
    retention: input.retention,
    redaction: target.redaction,
    ...(input.captureMark === undefined
      ? {}
      : { captureMark: input.captureMark }),
  };
  validatePortableMetadata(
    target.manifest,
    record,
    target.files,
    DEFAULT_LIMITS,
    (reason) => {
      throw new DumpRejected({ source: input.root, reason });
    },
  );
  const written = await writeDump({
    root: input.root,
    manifest: target.manifest,
    manifestBytes: target.manifestBytes,
    files: target.files,
    record,
  });
  const read = await readDump(written.directory);
  await parseDump(
    read.directory,
    read.manifest,
    read.files,
    read.record.snapshotId,
    input.budget,
    false,
  );
  return {
    directory: written.directory,
    runId: target.run.runId,
    snapshotId: input.snapshotId,
    redaction: input.redaction,
    reused: written.reused,
    run: target.run,
  };
};

const asFilingError = (capture: string) => (error: unknown) =>
  error instanceof DumpRejected
    ? error
    : new DumpRefused({
        capture,
        reason:
          error instanceof DumpRefused
            ? error.reason
            : error instanceof Error
              ? error.message
              : String(error),
      });

/**
 * Builds the restricted dump straight from pi's storage and the journal and files it in
 * `<root>/restricted/<runKind>/<runId>/<snapshotId>/`, with no Records service: the coding
 * environment's dump of an arbitrary project. Same builder and validator as `captureRunDump`, so
 * the same state has the same snapshot ID in both homes. The source must be open or certified: a
 * closed one with no WAL is refused, since nothing here records that it is whole.
 */
export const exportSnapshot = async (
  input: BuildInput & FileInput,
): Promise<SnapshotExport> => {
  const built = await buildDump(input, true);
  try {
    const dump = await sealed(built, "direct");
    const result = await fileSnapshot({
      ...input,
      source: "direct",
      redaction: "restricted",
      ...dump,
      budget: built.inspection?.budget,
    });
    await built.inspection?.complete();
    return result;
  } catch (error) {
    await built.inspection?.failure(error);
    throw error;
  }
};

export interface ExportOptions extends FileInput {
  /** The restricted capture's manifest hash, as `captureRunDump` and the close receipt give it. */
  readonly capture: string;
  /** `restricted` (the default) copies the capture byte for byte; `portable` derives the inspection copy. */
  readonly redaction?: Redaction | undefined;
  readonly limits?: DumpLimits | undefined;
}

/**
 * Files one restricted capture from Records as a dataset folder, after every check
 * `readCapturedDump` makes. Scored, reading and coding runs go to separate folders, and a capture
 * whose scored label its own requests contradict is refused. Exporting never changes the raw
 * capture's age; the dataset keeps the caller's stated retention.
 */
export const exportCapturedDump = (options: ExportOptions) =>
  Effect.gen(function* () {
    const restored = yield* readCapturedDump(options.capture, options.limits);
    const mark = yield* CaptureRecords.scanStatus(options.capture);
    if (mark.status !== "clean")
      return yield* Effect.fail(
        new DumpRefused({
          capture: options.capture,
          reason: "capture scan has not passed; export refused",
        }),
      );
    const captureMark = yield* CaptureRecords.markFor(options.capture);
    const captured = yield* readCapturedFiles(
      mark.capture,
      options.limits ?? DEFAULT_LIMITS,
    );

    return yield* Effect.tryPromise({
      try: () =>
        fileSnapshot({
          ...options,
          source: `records:${mark.capture}`,
          snapshotId: mark.capture,
          redaction: options.redaction ?? "restricted",
          manifest: captured.manifest,
          manifestBytes: captured.manifestBytes,
          files: captured.files,
          restored,
          captureMark,
        }),
      catch: asFilingError(options.capture),
    });
  });

/** Derives the portable copy of a restricted snapshot folder into `<root>/portable/...`. */
export const exportPortableSnapshot = async (
  input: FileInput & { readonly directory: string },
): Promise<SnapshotExport> => {
  const held = await readDump(input.directory);
  if (
    held.record.source.startsWith("records:") &&
    held.record.captureMark?.payload.outcome !== "clean"
  )
    throw new DumpRejected({
      source: held.directory,
      reason: "capture scan has not passed; export refused",
    });
  if (held.manifest.redaction !== "restricted")
    throw new DumpRejected({
      source: held.directory,
      reason: "a portable copy is derived only from a restricted snapshot",
    });
  return fileSnapshot({
    ...input,
    source: held.record.source,
    captureMark: held.record.captureMark,
    snapshotId: held.record.snapshotId,
    redaction: "portable",
    manifest: held.manifest,
    manifestBytes: held.manifestBytes,
    files: held.files,
    restored: await parseDump(
      held.directory,
      held.manifest,
      held.files,
      undefined,
      undefined,
      false,
    ),
  });
};

/** Child-only scan. The Records worker owns the deadline, progress watchdog and mark append. */
export const inspectRawCapture = (
  location: import("@neuve/records-core").StoreLocation,
  rawCapture: string,
  progress: () => void,
  workDirectory?: string,
  persist = true,
) =>
  Effect.gen(function* () {
    const blobs = yield* Blobs.BlobStore;
    const metadata = yield* blobs.inspect(rawCapture);
    if (
      metadata._tag === "Some" &&
      metadata.value.mediaType === DUMP_MEDIA_TYPE
    ) {
      const held = yield* readCapturedFiles(
        rawCapture,
        DEFAULT_LIMITS,
        progress,
      );
      if (held.manifest.scan !== undefined)
        return yield* new DumpRejected({
          source: held.source,
          reason: "invalid raw capture manifest",
        });
      const total = held.manifest.files.reduce(
        (sum, file) => sum + file.size,
        held.manifestBytes.byteLength,
      );
      // Legacy inventories conservatively bound record/frame counts by their recorded bytes.
      const budget = closeInspectionBudget({
        records: total,
        frames: total,
        bytes: total,
        calls: 0,
      });
      budget.onProgress = progress;
      yield* Effect.tryPromise({
        try: () =>
          parseDump(held.source, held.manifest, held.files, undefined, budget),
        catch: asRejection(held.source),
      }).pipe(Effect.ensuring(Effect.sync(() => budget.dispose())));
      progress();
      const manifest: DumpManifest = {
        ...held.manifest,
        scan: { rawCapture, policy: CaptureRecords.DETECTOR_VERSION },
      };
      const bytes = new TextEncoder().encode(
        `${JSON.stringify(preserveUnknown(DumpManifest, JSON.parse(new TextDecoder().decode(held.manifestBytes)), manifest))}\n`,
      );
      if (persist)
        yield* blobs.put({
          bytes,
          mediaType: DUMP_MEDIA_TYPE,
          retention: "raw-capture",
          restore: "never",
        });
      return { record: sha256Of(bytes), basis: "legacy-certificates" as const };
    }
    return yield* scanRawCapture({
      location,
      rawCapture,
      progress,
      ...(workDirectory === undefined ? {} : { workDirectory }),
      seal: (input, scan) =>
        Effect.map(
          sealCapturedDump({ ...input, progress }, scan, persist),
          (sealed) => ({
            record: sealed.capture,
            basis: "source-scan" as const,
            ...(sealed.diagnostic === undefined
              ? {}
              : { diagnostic: sealed.diagnostic }),
          }),
        ),
    });
  });

/** Legacy manifests are inventory only here. The same isolated child performs their scan. */
export const legacyCaptures = (after = 0, runId?: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const blobs = yield* Blobs.BlobStore;
    const rows = yield* sql<{
      cursor: number;
      hash: string;
      prunedAt: string | null;
    }>`SELECT rowid AS cursor,hash,pruned_at FROM blobs b WHERE rowid>${after} AND media_type=${DUMP_MEDIA_TYPE}
    AND NOT EXISTS (SELECT 1 FROM events e WHERE e.kind='capture.filed@1' AND json_extract(CASE WHEN json_valid(e.envelope) THEN e.envelope ELSE '{}' END,'$.payload.rawCapture')=b.hash)
    AND NOT EXISTS (SELECT 1 FROM events e WHERE e.kind='capture.sealed@1' AND json_extract(CASE WHEN json_valid(e.envelope) THEN e.envelope ELSE '{}' END,'$.payload.record')=b.hash) ORDER BY rowid LIMIT 128`;
    const captures = [];
    for (const row of rows) {
      if (row.prunedAt !== null) {
        if (runId === undefined)
          captures.push({
            ...row,
            _tag: "Pruned" as const,
            rawCapture: row.hash,
          });
        continue;
      }
      const result = yield* Effect.exit(blobs.get(row.hash));
      if (result._tag === "Failure") {
        if (Cause.hasInterrupts(result.cause))
          return yield* Effect.failCause(result.cause);
        captures.push({
          ...row,
          _tag: "Invalid" as const,
          seq: row.cursor,
          rawCapture: row.hash,
          reason: "capture scan failed; retry later",
        });
        continue;
      }
      const read = result.value;
      if (read._tag === "Pruned") {
        captures.push({
          ...row,
          _tag: "Pruned" as const,
          rawCapture: row.hash,
          prunedAt: read.blob.prunedAt,
        });
        continue;
      }
      const manifest = decodeManifest(read.bytes, DEFAULT_LIMITS);
      if (
        typeof manifest === "string" ||
        manifest.scan !== undefined ||
        manifest.redaction !== "restricted"
      )
        continue;
      if (runId !== undefined && manifest.runId !== runId) continue;
      const total = manifest.files.reduce(
        (sum, file) => sum + file.size,
        read.bytes.byteLength,
      );
      const event = CaptureRecords.captureFiledEvent({
        rawCapture: row.hash,
        runId: manifest.runId,
        checkpoint: null,
        counts: { records: total, frames: total, bytes: total, calls: 0 },
        sizes: {
          total,
          largest: Math.max(
            read.bytes.byteLength,
            ...manifest.files.map((file) => file.size),
          ),
        },
      });
      captures.push({
        ...row,
        _tag: "Filed" as const,
        seq: row.cursor,
        rawCapture: row.hash,
        event,
      });
    }
    return {
      captures,
      after: rows.at(-1)?.cursor ?? after,
      more: rows.length === 128,
    };
  });

/** Receipt verification checks ownership and source hashes; it does not grant export permission. */
export const readLegacyReceiptCapture = (capture: string) =>
  Effect.gen(function* () {
    const held = yield* readCapturedFiles(capture, DEFAULT_LIMITS);
    return yield* Effect.tryPromise({
      try: () =>
        parseDump(
          held.source,
          held.manifest,
          held.files,
          undefined,
          undefined,
          true,
        ),
      catch: asRejection(held.source),
    });
  });
