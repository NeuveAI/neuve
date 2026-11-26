import type { AuthorityCloseFailure } from "./authority-close.ts";
import { scanFailureKind } from "./scan-failure.ts";
import { measuredCloseInventory, nativeRecordCount } from "./inventory.ts";
import { inspectionBudgetRefusal } from "./inspection-refusal.ts";
import { StopInventory } from "./inspection-pool.ts";
import {
  checkedCount,
  closeCeiling,
  NO_PROGRESS_REASON,
  type CloseInventory,
} from "./watchdog.ts";
import {
  CloseDiagnostic,
  PublicRefusal,
  type CloseDiagnostic as Diagnostic,
  renderCloseDiagnostic,
} from "./close-diagnostic.ts";
import {
  CredentialSourceUnavailable,
  credentialGuards,
  credentialLossEpochs,
  credentialFrameIdentity,
  credentialInspection,
  credentialSourceHash,
  credentialSources,
  visitCredentialSources,
  credentialBackupCertified,
  credentialSourceText,
  administrativeFrame,
  inspectCredentialSource,
  closeInspectionBudget,
  credentialAdministrationHash,
  credentialFramesAdministrationHash,
} from "./safety.ts";
import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rename,
  writeFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { NativeHistoryUncertified } from "./private-inspection.ts";
import type { PrivateInspection } from "./private-inspection.ts";
import {
  CredentialJson,
  type InspectionBudget,
  inspectionFailure,
  type InspectionResult,
  type InspectionUnavailable,
} from "./credential-detectors.ts";
import { join, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Context } from "@earendil-works/chord";
import {
  NATIVE_BACKUP_FILE,
  NATIVE_BACKUP_MEDIA_TYPE,
  RAW_JOURNAL_FILE,
  RAW_JOURNAL_MEDIA_TYPE,
  journalObjectFile,
  type RunDump,
  type BackupStatus,
  type CloseMode,
  type PriceRate,
  type RawJournal,
} from "./dump.ts";
import {
  JOURNAL_FILE,
  OBJECTS_DIRECTORY,
  journalObjectFrames,
  openCaptureJournal,
  readCaptureJournal,
  readCaptureLosses,
  retainedPrefixProof,
  sha256Of,
} from "./journal.ts";
import {
  captureFileLimit,
  DEFAULT_LIMITS,
  type CapturedEvent,
  type CredentialCertificate,
  type DumpLimits,
  type JournalLine,
} from "./types.ts";
/**
 * Builds one run's restricted session dump from pi's native storage and the run's capture journal.
 * It reads pi's records through pi's own `Storage` scans, so the dump has every conversation,
 * task-owned children included, and joins only what the journal holds; it copies pi's database
 * whole with SQLite's `serialize`, so the exact state can be opened again, and carries the
 * journal's own bytes as they were read. It writes nothing back to pi. Every gap it finds is listed;
 * it fails only when the journal, pi's records or pi's database cannot be read as they must be, so
 * nothing partial is ever filed as if whole. Masking runs over the finished dump's content fields
 * (mask.ts), and each file is checked against its schema after it.
 */

export { DumpFailed, type NativeReads } from "./sources.ts";
import {
  DumpFailed,
  readNative,
  readBackup,
  ProjectionRecipe,
  RECIPE_FILE,
  encode,
  retainedDeclarations,
  type NativeReads,
} from "./sources.ts";
import {
  cannotOpen,
  openPrivateCopy,
  walWithoutLog,
} from "@neuve/records-core/read-only";
import { deriveCapture } from "./canonical.ts";

export interface DumpContent {
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface BuildInput {
  readonly authorityFailure?: AuthorityCloseFailure | undefined;
  readonly runId: string;
  readonly signal?: AbortSignal | undefined;
  readonly progress?: (() => void) | undefined;
  readonly capturedBackup?: {
    readonly status: BackupStatus;
    readonly bytes?: Uint8Array;
  };

  readonly credentialInspection?: PrivateInspection | undefined;
  /** The run's capture journal folder. */
  readonly journal: string;
  /** pi's storage, open; absent when the run folder holds no pi database. */
  readonly native?:
    { readonly reads: NativeReads; readonly context: Context } | undefined;
  /** pi's SQLite file, copied whole into the dump; without one the backup is reported unavailable. */
  readonly nativeDatabase?: string | undefined;
  /** A named rate for estimates; without one, a subscription run's cost stays unknown and unestimated. */
  readonly rate?: PriceRate | undefined;
  /** Identifiers fetched sources declare, masked with the rest (masking.ts). */
  readonly declared?: ReadonlyArray<string> | undefined;
  /** The close this capture is taken at, recorded in the dump; absent outside a close. */
  readonly close?: CloseMode | undefined;
  /** The byte budgets the journal, each artifact, the native backup and the built dump must fit. */
  readonly limits?: DumpLimits | undefined;
}

export interface BuiltDump {
  readonly run: RunDump;
  readonly retainedPrefixCalls: readonly string[];
  readonly contents: ReadonlyArray<DumpContent>;
  readonly inspection?: CloseInspection;
}

export interface CloseInspection {
  readonly budget: InspectionBudget;
  readonly complete: () => Promise<void>;
  readonly failure: (error: unknown) => Promise<void>;
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * A WAL image with no WAL may have closed cleanly, or been carried without its WAL, or have lost it.
 * Direct exports of restored credential backups still reach this path. Only a credential certificate
 * of these exact bytes authorizes it. Ended-run removal never reads the closed image.
 */
const certifiedClosedImage = async (
  path: string,
  runId: string,
  lines: ReadonlyArray<JournalLine>,
  limit: number,
  administrationHash?: string,
) => {
  const hasWal = async () =>
    (await lstat(`${path}-wal`).catch(() => undefined)) !== undefined;
  if (await hasWal())
    throw new Error("restored backup has a WAL; exact source retained");
  const info = await lstat(path);
  if (info.size > limit)
    throw new Error(
      `the copy is ${info.size} bytes, over the ${limit}-byte object limit`,
    );
  const bytes = new Uint8Array(await readFile(path));
  if (await hasWal())
    throw new Error("restored backup has a WAL; exact source retained");
  if (!credentialBackupCertified(runId, lines, bytes, administrationHash))
    throw new Error(
      "closed source with no WAL matches no credential certificate; source retained",
    );
  const staging = await mkdtemp(join(tmpdir(), "neuve-restored-backup-"));
  try {
    const isolated = join(staging, "pi.sqlite");
    await writeFile(isolated, bytes, { mode: 0o600 });
    const database = openPrivateCopy(isolated);
    let snapshot: Uint8Array;
    try {
      database.exec("BEGIN");
      database.prepare("SELECT count(*) FROM sqlite_schema").get();
      snapshot = database.serialize();
    } finally {
      database.exec("ROLLBACK");
      database.close();
    }
    if (
      sha256Of(snapshot) !== sha256Of(bytes) ||
      (await hasWal()) ||
      sha256Of(new Uint8Array(await readFile(path))) !== sha256Of(bytes)
    )
      throw new Error(
        "restored backup source changed while copying; source retained",
      );
    return snapshot;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
};

/** Copy committed pages on a live connection in one read transaction, without rebuilding them. */
export const backupOnConnection = (database: DatabaseSync, limit: number) => {
  let metadata: { records: number; workInFlight: boolean } | undefined;
  try {
    database.exec("BEGIN");
    database.prepare("SELECT count(*) FROM sqlite_schema").get();
    const pages = database.prepare("PRAGMA page_count").get()?.["page_count"];
    const pageSize = database.prepare("PRAGMA page_size").get()?.["page_size"];
    if (
      typeof pages !== "number" ||
      typeof pageSize !== "number" ||
      pages * pageSize > limit
    )
      throw new Error(
        `the copy is ${typeof pages === "number" && typeof pageSize === "number" ? pages * pageSize : "unknown"} bytes, over the ${limit}-byte object limit`,
      );
    try {
      const records = nativeRecordCount(database);
      const running = database
        .prepare("SELECT count(*) AS n FROM tasks WHERE status <> 'terminal'")
        .get()?.["n"];
      const live = database
        .prepare(
          `SELECT count(*) AS n FROM documents d JOIN document_revisions r ON r.document_id=d.id
      WHERE d.kind='pi.live' AND d.retired_at IS NULL AND r.seq=(SELECT max(seq) FROM document_revisions WHERE document_id=d.id)
      AND (r.kind <> 'base' OR json_type(r.content, '$.run') IS NOT NULL OR json_type(r.content, '$.generation') IS NOT NULL OR json_type(r.content, '$.tools') IS NOT NULL)`,
        )
        .get()?.["n"];
      if (
        typeof records === "number" &&
        typeof running === "number" &&
        typeof live === "number"
      )
        metadata = { records, workInFlight: running + live > 0 };
    } catch {
      /* Unknown metadata never authorizes folder disposal. */
    }
    const bytes = database.serialize();
    if (bytes.byteLength > limit)
      throw new Error(
        `the copy is ${bytes.byteLength} bytes, over the ${limit}-byte object limit`,
      );
    return {
      status: {
        status: "captured",
        format: "sqlite",
        file: NATIVE_BACKUP_FILE,
        sha256: sha256Of(bytes),
        size: bytes.byteLength,
      } satisfies BackupStatus,
      bytes,
      ...(metadata === undefined ? {} : { metadata }),
    };
  } finally {
    database.exec("ROLLBACK");
  }
};

/** A read transaction serializes the committed pages, including WAL, without rebuilding the database. */
export const nativeBackup = async (
  path: string | undefined,
  limit: number,
  runId: string,
  lines: ReadonlyArray<JournalLine>,
  administrationHash?: string,
): Promise<{
  status: BackupStatus;
  bytes?: Uint8Array;
  metadata?: { records: number; workInFlight: boolean };
}> => {
  if (path === undefined)
    return {
      status: {
        status: "unavailable",
        reason: "no native SQLite database was named for this capture",
      },
    };
  const info = await lstat(path).catch(() => undefined);
  if (info === undefined)
    return {
      status: { status: "unavailable", reason: `${path} does not exist` },
    };
  if (!info.isFile())
    throw new DumpFailed({ reason: `${path} is not a regular file` });
  try {
    let bytes: Uint8Array;
    let metadata: { records: number; workInFlight: boolean } | undefined;
    const closedImage = () =>
      certifiedClosedImage(path, runId, lines, limit, administrationHash);
    if (walWithoutLog(path)) bytes = await closedImage();
    else
      try {
        const database = new DatabaseSync(path, {
          readOnly: true,
          timeout: 5_000,
        });
        try {
          const snapshot = backupOnConnection(database, limit);
          bytes = snapshot.bytes;
          metadata = snapshot.metadata;
        } finally {
          database.close();
        }
      } catch (error) {
        if (!cannotOpen(error)) throw error;
        bytes = await closedImage();
      }
    return {
      status: {
        status: "captured",
        format: "sqlite",
        file: NATIVE_BACKUP_FILE,
        sha256: sha256Of(bytes),
        size: bytes.byteLength,
      },
      bytes,
      ...(metadata === undefined ? {} : { metadata }),
    };
  } catch (error) {
    throw new DumpFailed({
      reason: `native backup of ${path}: ${message(error)}`,
    });
  }
};

/**
 * An artifact's bytes from the journal, refused unless they are a regular file inside it of the
 * size its event recorded, within the object limit, and match their hash. The size is checked
 * before anything is read, so a tampered or oversized object never reaches memory.
 */
const artifactBytes = async (
  journal: string,
  artifact: { readonly sha256: string; readonly size: number },
  limit: number,
) => {
  const { sha256 } = artifact;
  const root = await realpath(journal);
  const path = join(root, OBJECTS_DIRECTORY, sha256);
  const info = await lstat(path).catch(() => undefined);
  if (info === undefined || !info.isFile())
    throw new DumpFailed({
      reason: `artifact ${sha256} is not in the journal`,
    });
  if (!(await realpath(path)).startsWith(`${root}${sep}`))
    throw new DumpFailed({
      reason: `artifact ${sha256} is outside the journal`,
    });
  if (info.size > limit)
    throw new DumpFailed({
      reason: `artifact ${sha256} is ${info.size} bytes, over the ${limit}-byte object limit`,
    });
  if (info.size !== artifact.size)
    throw new DumpFailed({
      reason: `artifact ${sha256} is ${info.size} bytes where ${artifact.size} were recorded`,
    });
  const bytes = new Uint8Array(await readFile(path));
  if (sha256Of(bytes) !== sha256)
    throw new DumpFailed({ reason: `artifact ${sha256}: checksum mismatch` });
  return bytes;
};

type Event<T extends CapturedEvent["type"]> = Extract<
  CapturedEvent,
  { type: T }
>;

const build = async (
  input: BuildInput,
  started: number,
  progress: {
    phase: Diagnostic["phase"];
    phases: Diagnostic["phases"];
    inventory: CloseInventory;
    budget?: InspectionBudget;
    inspection?: Diagnostic["inspection"];
  },
): Promise<BuiltDump> => {
  const phase = (name: Diagnostic["phase"]) => {
    progress.phases[progress.phase] = Math.ceil(performance.now() - started);
    progress.phase = name;
    input.progress?.();
  };
  input.credentialInspection?.assertExportable();
  const rate = input.rate ?? null;
  const declared = input.declared ?? [];

  const limits = input.limits ?? DEFAULT_LIMITS;
  const losses = readCaptureLosses(input.journal, limits);
  let journal = readCaptureJournal(input.journal, limits);
  const rawLines = journal._tag === "Read" ? journal.lines : [];
  const withholdSource = async () => {
    const reason = "Capture loss prevents certification of the original source";
    const recipe = ProjectionRecipe.parse({
      version: 1,
      maskVersion: 1,
      sourceValidationVersion: 6,
      tornLines: 0,
      captureLosses: losses,
      captureLossRunKind: rawLines.flatMap(({ event }) =>
        event.type === "run.start" ? [event.runKind] : [],
      )[0],
      declared: [],
      close: input.close ?? null,
      rate,
    });
    const budget =
      progress.budget ??
      closeInspectionBudget(progress.inventory, started, input.signal);
    progress.budget = budget;
    phase("projection");
    const projection = await deriveCapture(
      input.runId,
      {
        native: { conversations: [], session: [] },
        lines: [],
        tornLines: 0,
        backup: { status: "unavailable", reason },
        journal: { status: "unavailable", reason },
        artifacts: [],
      },
      recipe,
      "original",
      budget,
    );
    phase("finalization");
    return sealProjection(projection, recipe, [], limits);
  };
  if (losses.length > 0 && journal._tag !== "Read") return withholdSource();
  if (journal._tag === "TooLarge")
    throw new DumpFailed({
      reason: `capture journal is ${journal.size} bytes, over the ${journal.limit}-byte limit`,
    });
  if (journal._tag === "Corrupt")
    throw new DumpFailed({
      reason: `capture journal line ${journal.line}: ${journal.reason}`,
    });
  let { lines } = journal;
  const objectFrames = journalObjectFrames(journal.objects);
  if (lines.some(({ event }) => event.type === "native.import"))
    throw new NativeHistoryUncertified();
  const registrations = new Map(
    lines.flatMap(({ event }) =>
      event.type === "credential.registration"
        ? [[event.callId, event.epochId] as const]
        : [],
    ),
  );
  const lossEpochs = credentialLossEpochs(losses, registrations);
  const authority = input.credentialInspection;
  if (lossEpochs.size > 0 && authority === undefined) return withholdSource();
  const safety = credentialGuards(
    lines,
    authority === undefined ? "certificates-only" : "inspect-retained-prefix",
    { epochs: lossEpochs },
  );
  if (safety.refusal !== null) throw new DumpFailed({ reason: safety.refusal });
  const backup =
    input.capturedBackup ??
    input.native?.reads.captureBackup?.(limits.objectBytes) ??
    (await nativeBackup(
      input.nativeDatabase,
      limits.objectBytes,
      input.runId,
      lines,
      credentialAdministrationHash(lines, journal.frames),
    ));
  const events = lines.map((line) => line.event);
  const stray = events.find((event) => event.scope.runId !== input.runId);
  if (stray !== undefined)
    throw new DumpFailed({
      reason: `${stray.type} belongs to run ${stray.scope.runId}, not ${input.runId}`,
    });
  const of = <T extends CapturedEvent["type"]>(type: T) =>
    events.filter((event): event is Event<T> => event.type === type);
  const native =
    backup.bytes !== undefined
      ? await readBackup(backup.bytes)
      : input.native === undefined
        ? { conversations: [], session: [] }
        : await readNative(input.native.reads, input.native.context);
  progress.inventory = measuredCloseInventory(
    lines,
    [...journal.objects.values()].reduce(
      (total, object) => checkedCount(total, object.bytes.byteLength),
      checkedCount(
        journal.bytes?.byteLength ?? 0,
        backup.bytes?.byteLength ?? 0,
      ),
    ),
    checkedCount(
      native.session.length,
      ...native.conversations.map((conversation) =>
        checkedCount(
          1,
          conversation.entries.length,
          conversation.tasks.length,
          conversation.documents.length,
          ...conversation.taskDocuments.map((item) => item.documents.length),
        ),
      ),
    ),
    losses,
  );
  const { records, bytes, calls } = progress.inventory;
  const budget = closeInspectionBudget(
    progress.inventory,
    started,
    input.signal,
  );
  progress.budget = budget;
  budget.onProgress = () => input.progress?.();
  budget.charge("units", 0);
  phase("source-census");
  if (safety.requiresInspection && journal.tornLines > 0)
    throw new DumpFailed({
      reason:
        "credential inspection cannot certify a torn journal; source retained privately, export refused",
    });
  if (safety.requiresInspection && backup.status.status !== "captured") {
    if (lossEpochs.size > 0) return withholdSource();
    throw new DumpFailed({
      reason:
        "credential inspection requires an exact native backup; source retained privately, export refused",
    });
  }
  type CheckedSource = {
    readonly kind: import("./safety.ts").CredentialSource["kind"];
    readonly result: InspectionResult;
  };
  const scannedSources = new Map<string, CheckedSource>();
  let scanned:
    Awaited<ReturnType<PrivateInspection["inspectSources"]>> | undefined;
  let censusFailure: { readonly error: unknown } | undefined;
  const censusRefusal = (error: unknown): never => {
    if (error instanceof DumpFailed) throw error;
    const failure = inspectionFailure(error);
    if (failure.reason === "budget" || failure.reason === "cancelled")
      throw inspectionBudgetRefusal(failure, budget, "source-census");
    throw new DumpFailed({
      failureKind: scanFailureKind(error),
      reason:
        error instanceof CredentialSourceUnavailable
          ? `call ${error.callIndex}: ${error.diagnostic.reason}; frame ${error.diagnostic.frameIndex} ${error.diagnostic.expectedFrameType}/${error.diagnostic.frameType}; callbacks ${error.diagnostic.callbacks}/${error.diagnostic.originalCallbacks ?? "unknown"} (${error.reason}); unavailable credential source census; source retained privately, export refused`
          : "invalid, unsupported or unavailable credential source census or artifact text representation; source retained privately, export refused",
    });
  };
  const artifacts = async function* () {
    for (const artifact of of("artifact"))
      yield {
        mediaType: artifact.mediaType,
        bytes: await artifactBytes(input.journal, artifact, limits.objectBytes),
      };
  };
  let sources: ReadonlyMap<
    string,
    import("./safety.ts").CredentialSource | CheckedSource
  >;
  let inventoryFinished = false;
  const kinds: Array<{ identity: string; kind: CheckedSource["kind"] }> = [];
  if (authority !== undefined && safety.requiresInspection) {
    const sourceFrames = journal.frames;
    scanned = await authority.inspectSources({
      progress: (value) => {
        progress.inspection = value;
      },
      sources: async (consume) => {
        try {
          await visitCredentialSources(
            native,
            backup.bytes,
            lines,
            artifacts(),
            sourceFrames,
            budget,
            async (identity, source) => {
              kinds.push({ identity, kind: source.kind });
              await consume(source);
            },
            objectFrames,
          );
          inventoryFinished = true;
        } catch (error) {
          if (!(error instanceof StopInventory)) censusFailure = { error };
          throw error;
        }
      },
      requiredEpochs: [
        ...new Set([...registrations.values(), ...lossEpochs.values()]),
      ],
      budget,
    });
    if (scanned.status === "inspected") {
      const inspectedEpochs = new Set<string>(scanned.epochs);
      if ([...lossEpochs.values()].some((epoch) => !inspectedEpochs.has(epoch)))
        return withholdSource();
      for (const [index, result] of scanned.results.entries()) {
        const item = kinds[index];
        if (item === undefined)
          throw new DumpFailed({
            reason:
              "credential inspection inventory contradicted; export refused",
          });
        scannedSources.set(item.identity, { kind: item.kind, result });
      }
    }
    sources = scannedSources;
  } else {
    sources = await credentialSources(
      native,
      backup.bytes,
      lines,
      artifacts(),
      journal.frames,
      budget,
      objectFrames,
    ).catch(censusRefusal);
  }
  phase("inventory");
  const sourceHashes = [...sources.keys()].toSorted();
  const preliminary = !safety.requiresInspection
    ? { status: "certified" as const }
    : credentialInspection(
        input.runId,
        lines,
        sourceHashes,
        credentialAdministrationHash(lines, journal.frames),
      );
  const managed = registrations.size > 0;
  const requiredCalls = new Set([
    ...safety.guards.keys(),
    ...lossEpochs.keys(),
  ]);
  const groups = new Map<string, string[]>();
  for (const callId of requiredCalls) {
    const epoch = lossEpochs.get(callId) ?? registrations.get(callId) ?? callId;
    const calls = groups.get(epoch) ?? [];
    calls.push(callId);
    groups.set(epoch, calls);
  }
  let lossCertificates: CredentialCertificate[] | undefined;
  let exposed = false;
  let inspectionRecord = 0;
  const unavailableInspection = (
    result: InspectionUnavailable,
    record: number,
    kind: import("./safety.ts").CredentialSource["kind"] | "authority",
  ) =>
    new DumpFailed({
      failureKind:
        result.reason === "worker" || result.reason === "cancelled"
          ? result.reason
          : undefined,
      reason: `durable credential inspection unavailable (${result.reason}${result.reason === "budget" ? `:${progress.inspection?.exhausted ?? budget.exhausted ?? "unknown"}` : result.reason === "private-store" ? `:${authority?.inspectionFailureCheck ?? "unknown"}` : ""}); inspection record ${record} (${kind}), required epochs ${groups.size}; source retained privately, export refused`,
    });
  const inspect = async (
    source: import("./safety.ts").CredentialSource | CheckedSource,
  ) => {
    const record = ++inspectionRecord;
    if (authority !== undefined) {
      const result =
        "result" in source
          ? source.result
          : await inspectCredentialSource(authority, source, budget);
      budget.progress();
      const observed =
        result.status === "complete"
          ? result.matches.map((match) => match.epoch)
          : result.exposedEpochs;
      if (observed.length > 0) exposed = true;
      if (result.status !== "complete")
        throw unavailableInspection(result, record, source.kind);
      const missing = [...groups.keys()].findIndex(
        (epoch) => !result.epochs.some((id) => id === epoch),
      );
      if (missing !== -1) {
        const epoch = [...groups.keys()][missing];
        const registration = lines.find(
          ({ event }) =>
            event.type === "credential.registration" && event.epochId === epoch,
        );
        throw new DumpFailed({
          reason: `durable credential inspection missing epoch ${missing + 1}${registration === undefined ? " (registration absent)" : ` (registration line ${registration.seq})`}; inspection record ${record} (${source.kind}); source retained privately, export refused`,
        });
      }
      if (result.matches.length > 0)
        throw new DumpFailed({
          reason:
            "credential exposure in exact source; source retained privately, export refused",
        });
    } else if (!managed && preliminary.status === "inspect") {
      const result =
        "result" in source
          ? source.result
          : await preliminary.inspect(source, budget);
      if (result.status !== "complete") {
        if (result.exposedEpochs.length > 0) exposed = true;
        throw new DumpFailed({
          reason:
            "ephemeral credential inspection is unavailable; export refused",
        });
      }
      if (result.matches.length > 0) {
        exposed = true;
        throw new DumpFailed({
          reason:
            "credential exposure in exact source; source retained privately, export refused",
        });
      }
    } else if (managed || preliminary.status === "unavailable")
      throw new DumpFailed({
        reason:
          "historical credential authority is unavailable; source retained privately, export refused",
      });
  };
  if (
    safety.requiresInspection &&
    (preliminary.status !== "certified" || scanned !== undefined)
  ) {
    try {
      if (scanned !== undefined && scanned.exposedEpochs.length > 0)
        exposed = true;
      if (
        managed &&
        [...requiredCalls].some(
          (call) => !lossEpochs.has(call) && !registrations.has(call),
        )
      )
        throw new DumpFailed({
          reason: "historical calls lack durable registration; export refused",
        });
      if (scanned !== undefined) {
        if (censusFailure !== undefined) censusRefusal(censusFailure.error);
        if (scanned.status === "unavailable")
          throw unavailableInspection(scanned, scanned.record, "authority");
        for (const source of sources.values()) await inspect(source);
        if (!inventoryFinished || scanned.results.length !== kinds.length)
          throw new DumpFailed({
            reason:
              "credential inspection inventory unfinished; export refused",
          });
      }
      if (scanned === undefined)
        for (const source of sources.values()) await inspect(source);
      const inlineLimit = captureFileLimit(JOURNAL_FILE, limits);
      let inlineBytes = journal.compacted.reduce(
        (bytes, { size }) => bytes - size,
        journal.bytes?.byteLength ?? 0,
      );
      for (const { line } of journal.compacted) {
        inlineBytes += Buffer.byteLength(JSON.stringify(line));
        if (inlineBytes > inlineLimit) break;
        await budget.checkpoint(4096);
      }
      if (inlineBytes <= inlineLimit) {
        for (const { line } of journal.compacted) {
          const frame = CredentialJson.serialize(line);
          await inspect({ kind: "json", json: frame });
          sourceHashes.push(credentialFrameIdentity(frame.contents()));
        }
      }
      const sourceHash = credentialSourceHash(sourceHashes);
      phase("administration");
      for (const [index, line] of lines.entries())
        if (administrativeFrame(line)) {
          const frame = journal.frames[index];
          if (frame === undefined || frame.contents() !== JSON.stringify(line))
            throw new DumpFailed({
              reason: "noncanonical credential administration; export refused",
            });
          await inspect({ kind: "json", json: frame });
        }
      const certify = (administrationHash: string): CredentialCertificate[] =>
        [...groups].map(([epochId, calls]) => {
          const callId = calls[0];
          if (callId === undefined)
            throw new DumpFailed({
              reason: "credential epoch has no dispatch",
            });
          return {
            type: "credential.inspection",
            scope: { runId: input.runId },
            callId,
            version: 3,
            epochId,
            calls,
            retainedPrefixCalls: calls.filter((call) =>
              safety.retainedPrefixCalls.includes(call),
            ),
            administration: "canonical-inspected-v1",
            administrationHash,
            sourceHash,
            sourceHashes,
            safe: true,
          };
        });
      if (lossEpochs.size > 0) {
        // A full or unwritable journal may be the reason for the loss.
        await inspect({ kind: "json", json: CredentialJson.serialize(losses) });
        lossCertificates = certify(
          credentialAdministrationHash(lines, journal.frames, losses),
        );
        for (const certificate of lossCertificates)
          await inspect({
            kind: "json",
            json: CredentialJson.serialize(certificate),
          });
      } else {
        const capture = openCaptureJournal(input.journal, input.runId, {
          limits,
        });
        const newlyOpened = readCaptureJournal(input.journal, limits);
        if (newlyOpened._tag !== "Read")
          throw new DumpFailed({
            reason: "certificate journal cannot be read",
          });
        for (const frame of newlyOpened.frames.slice(lines.length))
          await inspect({ kind: "json", json: frame });
        await capture.certifyAll(
          groups.size,
          async (closing) => {
            const admin = newlyOpened.lines.flatMap((line, index) =>
              administrativeFrame(line) &&
              line.event.type !== "credential.inspection"
                ? [newlyOpened.frames[index]].filter(
                    (frame): frame is CredentialJson => frame !== undefined,
                  )
                : [],
            );
            return certify(
              credentialFramesAdministrationHash([...admin, ...closing]),
            );
          },
          (frame) => inspect({ kind: "json", json: frame }),
        );
      }
    } catch (error) {
      if (exposed && lossEpochs.size === 0) {
        const capture = openCaptureJournal(input.journal, input.runId, {
          limits,
        });
        try {
          for (const callId of requiredCalls)
            capture.capture({
              type: "credential.guard",
              scope: { runId: input.runId },
              callId,
              status: "exposed",
            });
        } finally {
          capture.close();
        }
      }
      throw error;
    }
    if (lossCertificates === undefined) {
      journal = readCaptureJournal(input.journal, limits);
      if (journal._tag !== "Read")
        throw new DumpFailed({
          reason: "credential certificate journal did not read back",
        });
      lines = journal.lines;
    }
  }
  const rawJournal: RawJournal =
    journal.bytes === null
      ? { status: "unavailable", reason: "the run kept no capture journal" }
      : {
          status: "captured",
          file: RAW_JOURNAL_FILE,
          sha256: sha256Of(journal.bytes),
          size: journal.bytes.byteLength,
          ...(journal.objects.size === 0
            ? {}
            : {
                objects: [...journal.objects].map(([sha256, { bytes }]) => ({
                  sha256,
                  size: bytes.byteLength,
                })),
              }),
        };
  const originals = await Promise.all(
    of("artifact").map(async (event) => ({
      event,
      bytes: await artifactBytes(input.journal, event, limits.objectBytes),
    })),
  );
  const recipe = ProjectionRecipe.parse({
    version: 1,
    maskVersion: 1,
    sourceValidationVersion: 6,
    tornLines: journal.tornLines,
    ...(losses.length === 0 ? {} : { captureLosses: losses }),
    ...(lossCertificates === undefined
      ? {}
      : { captureLossCertificates: lossCertificates }),
    declared: retainedDeclarations(
      declared,
      native,
      lines,
      originals.map((source) => ({
        mediaType: source.event.mediaType,
        bytes: source.bytes,
      })),
    ),
    close: input.close ?? null,
    rate,
  });
  phase("projection");
  const projection = await deriveCapture(
    input.runId,
    {
      native,
      lines,
      tornLines: journal.tornLines,
      backup: backup.status,
      journal: rawJournal,
      artifacts: originals,
    },
    recipe,
    "original",
    budget,
  )
    .then((projection) => {
      budget.charge("units", 0);
      return projection;
    })
    .catch((error: unknown) => {
      const failure = inspectionFailure(error);
      if (failure.reason === "budget" || failure.reason === "cancelled")
        throw inspectionBudgetRefusal(failure, budget, "projection");
      throw error;
    });
  phase("finalization");
  return sealProjection(
    projection,
    recipe,
    [
      ...(journal.bytes === null
        ? []
        : [
            {
              name: RAW_JOURNAL_FILE,
              mediaType: RAW_JOURNAL_MEDIA_TYPE,
              bytes: journal.bytes,
            },
          ]),
      ...Array.from(journal.objects, ([sha256, { bytes }]) => ({
        name: journalObjectFile(sha256),
        mediaType: "application/json",
        bytes,
      })),
      ...(backup.bytes === undefined
        ? []
        : [
            {
              name: NATIVE_BACKUP_FILE,
              mediaType: NATIVE_BACKUP_MEDIA_TYPE,
              bytes: backup.bytes,
            },
          ]),
    ],
    limits,
    retainedPrefixProof(lines, lossCertificates),
  );
};

const sealProjection = (
  projection: Awaited<ReturnType<typeof deriveCapture>>,
  recipe: ProjectionRecipe,
  originals: ReadonlyArray<DumpContent>,
  limits: DumpLimits,
  retainedPrefixCalls: readonly string[] = [],
): BuiltDump => {
  const { run } = projection;
  const contents: Array<DumpContent> = [
    { name: "run.json", mediaType: "application/json", bytes: encode(run) },
    { name: RECIPE_FILE, mediaType: "application/json", bytes: encode(recipe) },
    ...projection.sessions.map((session) => ({
      name: `sessions/${session.conversationId}.json`,
      mediaType: "application/json",
      bytes: encode(session),
    })),
    {
      name: "calls/unjoined.json",
      mediaType: "application/json",
      bytes: encode(projection.unjoined),
    },
    ...projection.artifacts,
    ...originals,
  ];
  // What the dump's readers would refuse is refused here, before anything is stored.
  let total = 0;
  for (const content of contents) {
    const limit = captureFileLimit(content.name, limits);
    if (content.bytes.byteLength > limit)
      throw new DumpFailed({
        reason: `${content.name} is ${content.bytes.byteLength} bytes, over the ${limit}-byte object limit`,
      });
    total += content.bytes.byteLength;
  }
  if (total > limits.totalBytes)
    throw new DumpFailed({
      reason: `the dump is ${total} bytes, over the ${limits.totalBytes}-byte limit`,
    });
  return { run, contents, retainedPrefixCalls };
};

export const buildDump = async (
  input: BuildInput,
  deferCompletion = false,
): Promise<BuiltDump> => {
  const started = performance.now();
  const root = await realpath(input.journal).catch(() => undefined);
  const identity =
    root === undefined ? undefined : await lstat(root).catch(() => undefined);
  const persist = async (value: Diagnostic) => {
    if (root === undefined || identity === undefined || !identity.isDirectory())
      return;
    const temporary = join(root, `.close-diagnostic-${randomUUID()}`);
    try {
      const current = await lstat(root);
      if (
        !current.isDirectory() ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino
      )
        return;
      await writeFile(temporary, JSON.stringify(value), {
        mode: 0o600,
        flag: "wx",
      });
      const unchanged = await lstat(root);
      if (
        !unchanged.isDirectory() ||
        unchanged.dev !== identity.dev ||
        unchanged.ino !== identity.ino
      )
        return;
      await rename(temporary, join(root, "close-diagnostic.json"));
    } catch {
      // Public telemetry must not turn a valid read-only capture into a refusal.
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  };
  const progress: {
    phase: Diagnostic["phase"];
    phases: Diagnostic["phases"];
    inventory: CloseInventory;
    budget?: InspectionBudget;
    inspection?: Diagnostic["inspection"];
  } = {
    phase: "read",
    phases: {},
    inventory: { records: 0, bytes: 0, calls: 0, frames: 0 },
  };
  const diagnostic = (outcome: Diagnostic["outcome"], error?: unknown) => {
    const refusal = PublicRefusal.safeParse(
      error instanceof Error ? error.message : undefined,
    );
    return CloseDiagnostic.parse({
      version: 1,
      phase: progress.phase,
      outcome,
      ...(refusal.success ? { refusal: refusal.data } : {}),
      inventory: progress.inventory,
      inspection: progress.inspection,
      ceilingMs: closeCeiling(progress.inventory),
      elapsedMs: Math.ceil(performance.now() - started),
      phases: {
        ...progress.phases,
        [progress.phase]: Math.ceil(performance.now() - started),
      },
      usage: progress.budget?.usage ?? {},
      limits: progress.budget?.limits ?? {},
    });
  };
  const failure = async (error: unknown) => {
    const noProgress =
      input.signal?.aborted &&
      input.signal.reason instanceof Error &&
      input.signal.reason.message === NO_PROGRESS_REASON;
    let refusal = noProgress ? input.signal?.reason : error;
    try {
      progress.budget?.charge("units", 0);
    } catch (expired) {
      if (progress.budget !== undefined && !noProgress)
        refusal = inspectionBudgetRefusal(
          inspectionFailure(expired),
          progress.budget,
          progress.phase === "source-census" || progress.phase === "projection"
            ? progress.phase
            : "finalization",
        );
    }
    progress.budget?.dispose();
    const closeDiagnostic = diagnostic("refused", refusal);
    await persist(closeDiagnostic);
    if (error instanceof Error) Object.assign(error, { closeDiagnostic });
    return closeDiagnostic;
  };
  try {
    const result = await build(input, started, progress);
    const budget = progress.budget;
    if (budget === undefined)
      throw new Error("close inspection budget missing");
    const inspection: CloseInspection = {
      budget,
      complete: async () => {
        budget.charge("units", 0);
        budget.dispose();
        await persist(diagnostic("complete"));
      },
      failure: async (error) => {
        await failure(error);
      },
    };
    if (!deferCompletion) await inspection.complete();
    return { ...result, inspection };
  } catch (error) {
    const closeDiagnostic = await failure(error);
    if (
      closeDiagnostic.refusal !== undefined ||
      inspectionFailure(error).reason === "cancelled" ||
      inspectionFailure(error).reason === "budget"
    ) {
      throw Object.assign(
        error instanceof DumpFailed
          ? error
          : new DumpFailed({
              reason:
                error instanceof Error
                  ? error.message
                  : renderCloseDiagnostic(closeDiagnostic),
            }),
        { closeDiagnostic },
      );
    }
    if (error instanceof Error) Object.assign(error, { closeDiagnostic });
    throw error;
  }
};
