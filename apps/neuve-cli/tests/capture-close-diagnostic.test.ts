import { expect, test } from "bun:test";
import { latestSnapshot } from "../src/review-cli.ts";
import {
  closeFailureRecord,
  CloseDiagnostic,
  renderCloseDiagnostic,
} from "../../../packages/harness/src/pi/capture/close-diagnostic.ts";
import { StorageCloseFailed } from "../../../packages/harness/src/pi/storage.ts";
import { closeInspectionBudget } from "../../../packages/harness/src/pi/capture/safety.ts";

// Why: the failed close's real stored shape must survive the CLI.
test("a stored close refusal longer than 500 characters reaches latest-snapshot whole", async () => {
  const budget = closeInspectionBudget();
  const counts = Object.entries(budget.usage)
    .map(([key]) => `${key}=123456789012345`)
    .join(", ");
  const refusal = `credential inspection unavailable (cancelled); phase projection; usage ${counts}; limits ${Object.entries(
    budget.limits,
  )
    .map(([key]) => `${key}=9007199254740991`)
    .join(", ")}; source retained privately, export refused`;
  const diagnostic = CloseDiagnostic.parse({
    version: 1,
    phase: "projection",
    outcome: "refused",
    refusal,
    inventory: { records: 70000, bytes: 200000000, calls: 100, frames: 10000 },
    ceilingMs: 1200000,
    elapsedMs: 1200001,
    phases: { read: 20, projection: 1200001 },
    usage: budget.usage,
    limits: budget.limits,
  });
  const failure = Object.assign(new Error(renderCloseDiagnostic(diagnostic)), {
    closeDiagnostic: diagnostic,
  });
  const stored = JSON.parse(
    JSON.stringify(
      closeFailureRecord(
        new StorageCloseFailed("ended", failure, undefined),
        "ended",
      ),
    ),
  );
  const found = latestSnapshot([stored]);
  expect("refused" in found).toBe(true);
  if (!("refused" in found)) throw new Error("expected refusal");
  expect(found.refused.length).toBeGreaterThan(500);
  expect(found.refused).toContain(refusal);
});

for (const structured of [false, true])
  test.each([
    [
      "capture journal is 8192 bytes, over the 4096-byte limit",
      "capture journal is 8192 bytes, over the 4096-byte limit",
    ],
    [
      "capture journal line 1: journal frame schema is invalid",
      "capture journal line 1: journal frame schema is invalid",
    ],
    [
      "the dump is 8192 bytes, over the 4096-byte limit",
      "the dump is 8192 bytes, over the 4096-byte limit",
    ],
    [
      "noncanonical credential administration; export refused",
      "noncanonical credential administration; export refused",
    ],
    [
      "auxiliary purposes are only valid in coding runs",
      "auxiliary purposes are only valid in coding runs",
    ],
    [
      "call synthetic-private-content contradicts native assistant ownership",
      "contradicts native assistant ownership",
    ],
    [
      "Imported native history is not export certified",
      "Imported native history is not export certified",
    ],
    [
      "certificate journal cannot be read",
      "certificate journal cannot be read",
    ],
    [
      "credential inspection inventory contradicted; export refused",
      "credential inspection inventory contradicted; export refused",
    ],
    [
      "capture journal line 7: Unexpected token synthetic-private-content",
      "capture journal line 7: invalid JSON (private details suppressed)",
    ],
    [
      "native backup of /synthetic-private-content/pi.sqlite: the copy is 8192 bytes, over the 4096-byte object limit",
      "native backup: the copy is 8192 bytes, over the 4096-byte object limit",
    ],
  ])(
    `specific close refusal survives storage, latest-snapshot, diagnostic=${structured}: %s`,
    async (raw, expected) => {
      const diagnostic = CloseDiagnostic.parse({
        version: 1,
        phase: "read",
        outcome: "refused",
        inventory: { records: 0, bytes: 0, calls: 0, frames: 0 },
        ceilingMs: 300000,
        elapsedMs: 1,
        phases: { read: 1 },
        usage: {},
        limits: {},
      });
      const error = Object.assign(
        new Error(raw),
        structured ? { closeDiagnostic: diagnostic } : {},
      );
      const record = JSON.parse(
        JSON.stringify(
          closeFailureRecord(
            new StorageCloseFailed("ended", error, undefined),
            "ended",
          ),
        ),
      );
      expect(record.error).toContain(expected);
      const found = latestSnapshot([record]);
      if (!("refused" in found)) throw new Error("expected refusal");
      expect(found.refused).toContain(expected);
      expect(found.refused).not.toContain("synthetic-private-content");
    },
  );

test("plain historical close errors are bounded and privacy filtered without a diagnostic", async () => {
  for (const raw of [
    "Bearer synthetic-private-content",
    "synthetic-private-content".repeat(100000),
  ]) {
    const stored = closeFailureRecord(new Error(raw), "ended");
    expect(stored.error).toBe(
      "the harness did not close cleanly (ended): capture close failed (private details suppressed)",
    );
    // Historical records also pass the boundary, even if they predate the safe writer.
    const found = latestSnapshot([{ type: "run.close-failed", error: raw }]);
    if (!("refused" in found)) throw new Error("expected refusal");
    expect(found.refused).toBe(
      "its latest close failed: capture close failed (private details suppressed)",
    );
  }
});
