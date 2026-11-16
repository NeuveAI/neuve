// Real held-review recovery must still run when private checkpoint cleanup fails or defects.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { storeLocationIn } from "@neuve/records-core";
import { onClaim } from "../../../src/handler.ts";
import { heldReviewsPath, readHeldReviews } from "../../../src/held-reviews.ts";
import { captureStartupRecovery } from "../../../src/pi/capture/retention.ts";
import { runIn, value } from "./fixture.ts";
const root = mkdtempSync(join(tmpdir(), "capture-startup-recovery-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
for (const defect of [false, true])
  test(`checkpoint ${defect ? "defect" : "failure"} does not skip real harness claim recovery`, async () => {
    const location = storeLocationIn(join(root, defect ? "defect" : "failure"));
    const path = heldReviewsPath(location);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify([
        {
          seq: 1,
          pid: process.pid,
          at: "2026-11-02T00:00:00Z",
          provider: "openai",
          route: "synthetic",
          credential: "synthetic",
        },
      ]),
    );
    expect(readHeldReviews(location)).toHaveLength(1);
    const fault = new Error("PRIVATE-CHECKPOINT-IO");
    value(
      await runIn(location)(
        captureStartupRecovery(
          defect ? Effect.die(fault) : Effect.fail(fault),
          onClaim(location),
        ),
      ),
    );
    expect(readHeldReviews(location)).toEqual([]);
  }, 120000);
