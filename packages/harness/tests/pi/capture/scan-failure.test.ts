// Retryability follows boundary metadata, even when diagnostic text resembles a transient error.
import { expect, test } from "bun:test";
import { scanFailureKind } from "../../../src/pi/capture/scan-failure.ts";
import { ScanReply } from "../../../src/pi/capture/process.ts";
import { DumpFailed } from "../../../src/pi/capture/sources.ts";
import { PrivateInspectionBusy } from "../../../src/pi/capture/private-inspection.ts";

test("scan failure classification uses typed fields and ignores diagnostic wording", () => {
  expect(
    scanFailureKind(
      new DumpFailed({
        reason: "synthetic content mentions worker cancelled EIO ENOSPC",
      }),
    ),
  ).toBeUndefined();
  expect(
    scanFailureKind(
      new DumpFailed({ reason: "synthetic", failureKind: "worker" }),
    ),
  ).toBe("worker");
  expect(scanFailureKind(new PrivateInspectionBusy())).toBe("authority-busy");
  expect(
    scanFailureKind(Object.assign(new Error("synthetic"), { code: "EIO" })),
  ).toBe("storage");
  expect(scanFailureKind(new DOMException("synthetic", "AbortError"))).toBe(
    "cancelled",
  );
  expect(
    ScanReply.parse({
      type: "failure",
      failureKind: "worker",
      reason: "capture scan failed; retry later",
      retryable: true,
    }),
  ).toEqual({
    type: "failure",
    failureKind: "worker",
    reason: "capture scan failed; retry later",
    retryable: true,
  });
  expect(() =>
    ScanReply.parse({
      type: "failure",
      reason: "capture scan failed; retry later",
      retryable: true,
    }),
  ).toThrow();
});

test("a scan's changed-mark reason remains public without calling it an audit", async () => {
  const { PublicRefusal } = await import("@neuve/records-schema");
  expect(
    PublicRefusal.parse("capture mark changed during scan; seal not applied"),
  ).toBe("capture mark changed during scan; seal not applied");
});
