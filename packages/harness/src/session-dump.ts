/**
 * The session dump's public leaf (`@neuve/harness/session-dump`, NEU-54): what evaluation and the
 * CLI need to read a run's restricted capture from Records or a dataset folder, file it as a
 * restricted or portable dataset, and check what it says. It loads only the capture modules and
 * Records, never the harness's index, its model loop or credential discovery. Records readers and
 * exporters are Effects needing `Blobs.BlobStore` and the store SQL client; the folder
 * exporters are Promises for the same reason.
 */

export {
  CAPTURE_VERSION,
  DEFAULT_LIMITS,
  RunKind,
  SourceRevision,
  type DumpLimits,
} from "./pi/capture/types.ts";
export {
  DUMP_FORMAT,
  EXPORT_FILE,
  MANIFEST_FILE,
  DatasetRetention,
  DumpFile,
  DumpManifest,
  DumpRejected,
  ExportRecord,
  RedactionRecord,
  type Redaction,
} from "./pi/capture/archive.ts";
export {
  ArtifactRecord,
  BackupStatus,
  CallRecord,
  CallRole,
  EXECUTION_GAPS,
  Gap,
  GapCode,
  NATIVE_BACKUP_FILE,
  NATIVE_BACKUP_MEDIA_TYPE,
  PriceRate,
  RunDump,
  SessionDump,
} from "./pi/capture/dump.ts";
export { DumpFailed, type BuildInput } from "./pi/capture/build.ts";
export {
  fullOutputPath,
  openCaptureJournal,
  type CaptureJournal,
  type JournalOptions,
} from "./pi/capture/journal.ts";
export { PORTABLE_WITHHELD } from "./pi/capture/mask.ts";
export type { CloseMode, CloseReceipt } from "./pi/capture/close.ts";
export {
  DUMP_MEDIA_TYPE,
  DumpRefused,
  captureRunDump,
  legacyCaptures,
  exportCapturedDump,
  exportPortableSnapshot,
  exportSnapshot,
  readCapturedDump,
  readSessionDump,
  type ExportOptions,
  type RestoredDump,
  type SnapshotExport,
} from "./pi/capture/export.ts";

export { inspectRawCapture } from "./pi/capture/export.ts";
export {
  readRawCapture,
  readRawManifest,
  rawInventory,
} from "./pi/capture/raw.ts";

export * as CaptureRecords from "./pi/capture/records.ts";

export { captureScanHandler } from "./pi/capture/job.ts";
export { runScanChild } from "./pi/capture/child.ts";
export { runScanProcess } from "./pi/capture/process.ts";
export {
  captureCheckpointSweep,
  captureStartupRecovery,
  capturePruneHandler,
} from "./pi/capture/retention.ts";
export { auditCapture } from "./pi/capture/audit.ts";

export { CaptureMarked } from "@neuve/records-schema";
