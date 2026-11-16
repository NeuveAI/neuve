import { expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keepaliveFixture } from "./keepalive-fixture.ts";

for (const variant of [
  "history",
  "history-credential",
  "missing-epoch",
  "unsupported-history",
] as const) {
  test(`historical inspection through a symlinked cloud mount: ${variant}`, async () => {
    const root = mkdtempSync(
      join(realpathSync(tmpdir()), "historical-inspection-"),
    );
    const physical = join(root, "volume/cases/go/293649/replay-candidate-9");
    mkdirSync(physical, { recursive: true });
    const alias = join(root, "case");
    symlinkSync(physical, alias);
    try {
      const result = await keepaliveFixture(alias, variant);
      if (variant === "history")
        expect(result).toMatchObject({
          refused: false,
          complete: true,
          execution: "ended",
          nativeMatchesManifest: true,
          journalMatchesSource: true,
        });
      else {
        expect(result).toMatchObject({ refused: true, nativeUnchanged: true });
        if (!result.refused) throw new Error("unsafe history exported");
        if (variant === "history-credential")
          expect(result.reason).toContain("credential exposure");
        if (variant === "missing-epoch") {
          expect(result.reason).toContain(
            "missing epoch 1 (registration line 4); inspection record 1 (text)",
          );
          expect(result.reason).not.toContain("synthetic-private-unregistered");
        }
        if (variant === "unsupported-history") {
          expect(result.reason).toContain(
            "durable credential inspection unavailable (unsupported)",
          );
          expect(result.reason).toMatch(
            /inspection record [0-9]+ \((json|text|bytes)\), required epochs 1/,
          );
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);
}
