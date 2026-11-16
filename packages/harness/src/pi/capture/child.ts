import { scanFailureKind } from "./scan-failure.ts";
import { monitorParent } from "../../parent-guard.ts";
import { PrivateInspectionError } from "./private-inspection.ts";
import { setPriority } from "node:os";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import { Effect, Layer } from "effect";
import { Blobs, Store, type StoreLocation } from "@neuve/records-core";
import { inspectRawCapture, DUMP_MEDIA_TYPE } from "./export.ts";
import { publicCloseReason } from "./close-diagnostic.ts";
import { RawCapturePruned } from "./raw.ts";
import { type ScanVerdict } from "./process.ts";
import { sha256Of } from "./journal.ts";
import { DETECTOR_VERSION } from "./records.ts";

/** The child emits closed public metadata only. Its caller never forwards stderr. */
export const runScanChild = async (input: {
  location: StoreLocation;
  rawCapture: string;
  parentPid: number;
  observe?: boolean;
  workDirectory: string;
}) => {
  const stopGuard = monitorParent(input.parentPid);
  try {
    setPriority(10);
  } catch {
    /* The parent already attempted nice 10. */
  }
  const emit = (value: unknown) => {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  };
  let counter = 0,
    sentAt = -Infinity;
  const progress = () => {
    counter++;
    if (performance.now() - sentAt < 1000) return;
    sentAt = performance.now();
    emit({ type: "progress", counter });
  };
  const program = Effect.gen(function* () {
    progress();
    const blobs = yield* Blobs.BlobStore;
    const metadata = yield* blobs.inspect(input.rawCapture);
    const basis =
      metadata._tag === "Some" && metadata.value.mediaType === DUMP_MEDIA_TYPE
        ? ("legacy-certificates" as const)
        : ("source-scan" as const);
    const result = yield* Effect.result(
      inspectRawCapture(
        input.location,
        input.rawCapture,
        progress,
        input.workDirectory,
        input.observe !== true,
      ),
    );
    if (result._tag === "Success")
      return {
        type: "verdict",
        outcome: "clean",
        ...result.success,
        rss: process.memoryUsage.rss(),
      } satisfies ScanVerdict;
    const reason =
      result.failure instanceof PrivateInspectionError
        ? "historical credential authority is unavailable; source retained privately, export refused"
        : publicCloseReason(result.failure);
    if (
      result.failure instanceof RawCapturePruned ||
      result.failure instanceof Blobs.BlobPruned
    )
      return {
        type: "failure" as const,
        failureKind: "pruned" as const,
        reason:
          result.failure instanceof RawCapturePruned
            ? result.failure.reason
            : `raw capture pruned on ${result.failure.prunedAt}`,
        retryable: false,
      };
    const failureKind = scanFailureKind(result.failure);
    if (failureKind !== undefined)
      return {
        type: "failure" as const,
        failureKind,
        reason:
          reason === "capture close failed (private details suppressed)"
            ? "capture scan failed; retry later"
            : reason,
        retryable: true,
      };
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        format: "neuve.capture-verdict",
        rawCapture: input.rawCapture,
        detectorVersion: DETECTOR_VERSION,
        outcome: "refused",
        reason,
      }),
    );
    const stored =
      input.observe === true
        ? undefined
        : yield* blobs.put({
            restore: "never",
            bytes,
            mediaType: "application/vnd.neuve.capture-verdict+json",
            retention: "raw-capture",
          });
    return {
      type: "verdict",
      outcome: "refused",
      basis,
      record: stored?.blob.hash ?? sha256Of(bytes),
      reason,
      rss: process.memoryUsage.rss(),
    } satisfies ScanVerdict;
  }).pipe(
    Effect.provide(Blobs.layer(input.location)),
    Effect.provide(Store.layer(input.location, { create: false })),
    Effect.provide(BunFileSystem.layer),
  );
  try {
    emit(await Effect.runPromise(program));
    return 0;
  } catch (error) {
    const pruned =
      error instanceof RawCapturePruned || error instanceof Blobs.BlobPruned;
    emit({
      type: "failure",
      failureKind: pruned ? "pruned" : (scanFailureKind(error) ?? "execution"),
      reason:
        error instanceof RawCapturePruned
          ? error.reason
          : error instanceof Blobs.BlobPruned
            ? `raw capture pruned on ${error.prunedAt}`
            : publicCloseReason(error),
      retryable: !pruned,
    });
    return 2;
  } finally {
    await stopGuard();
  }
};
