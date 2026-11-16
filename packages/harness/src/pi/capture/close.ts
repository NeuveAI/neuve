import type { Context } from "@earendil-works/chord";
import type { NativeReads } from "./build.ts";
import type { BackupStatus, CloseMode, GapCode, RunDump } from "./dump.ts";

export type { CloseMode } from "./dump.ts";

/**
 * What the run's close hands back once its native state is captured (record 0004). The runtime
 * closes pi's harness, which seals Session admission, joins its scheduler and then closes the raw
 * `Storage`; at that boundary the capture reads the raw storage and copies pi's database, and the
 * runtime closes the real database after it. The receipt names the snapshot so the run folder can
 * go without reopening pi's database, but only once that close succeeded too. Removal trusts only the
 * snapshot it names: the mode and journal hash it checks are the ones the capture recorded.
 */

export interface CloseReceipt {
  readonly runId: string;
  readonly pendingScan?: true;
  readonly mode: CloseMode;
  /** The restricted capture's manifest hash in Records. */
  readonly capture: string;
  /** The snapshot's identity under the run: the same hash, shared by every home of this state. */
  readonly snapshotId: string;
  /** Unknown until inspection. A raw filing always reports false with pendingScan. */
  readonly complete: boolean;
  readonly gaps: ReadonlyArray<GapCode>;
  /** `ended` only with a captured `run.end`; a held, interrupted or coding snapshot is `open`. */
  readonly execution: RunDump["execution"];
  readonly backup: BackupStatus;
}

export interface CloseInput {
  readonly runId: string;
  readonly mode: CloseMode;
  /** The raw storage, still open, after the Session sealed and the scheduler joined. */
  readonly reads: NativeReads;
  /** The close's own context; the capture reads under a fresh bounded one instead, since this may be aborted. */
  readonly context: Context;
}

export const receiptOf = (
  mode: CloseMode,
  captured: {
    readonly capture: string;
    readonly snapshotId: string;
    readonly raw: import("./raw.ts").RawCapture;
  },
): CloseReceipt => ({
  runId: captured.raw.runId,
  mode,
  pendingScan: true,
  capture: captured.capture,
  snapshotId: captured.snapshotId,
  complete: false,
  gaps: [],
  execution:
    mode === "ended" &&
    captured.raw.lifecycle.runEnded &&
    !captured.raw.lifecycle.workInFlight
      ? "ended"
      : "open",
  backup: captured.raw.backup,
});
