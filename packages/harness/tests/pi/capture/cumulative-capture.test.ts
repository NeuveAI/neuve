import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { keepaliveFixture } from "./keepalive-fixture.ts";

for (const variant of [
  "cumulative",
  "cumulative-credential",
  "cumulative-bound",
] as const) {
  test(`cumulative SDK state through a symlinked cloud mount: ${variant}`, async () => {
    const root = mkdtempSync(
      join(realpathSync(tmpdir()), "cumulative-capture-"),
    );
    const physical = join(
      root,
      "volume",
      "cases",
      "go",
      "293649",
      "replay-candidate-8",
    );
    mkdirSync(physical, { recursive: true });
    const alias = join(root, "case");
    symlinkSync(physical, alias);
    try {
      const result = await keepaliveFixture(alias, variant);
      if (variant === "cumulative") {
        expect(result.callbacks).toBe(270);
        expect(result).toMatchObject({
          refused: false,
          complete: true,
          execution: "ended",
          nativeMatchesManifest: true,
          journalMatchesSource: true,
        });
      } else {
        expect(result).toMatchObject({ refused: true, nativeUnchanged: true });
        if (!result.refused) throw new Error("unsafe capture exported");
        if (variant === "cumulative-credential")
          expect(result.reason).toContain("credential exposure");
        else {
          expect(result.reason).toContain(
            "call 1: SDK generated scalar bound exceeded",
          );
          expect(result.reason).toContain(
            "response.function_call_arguments.delta/response.function_call_arguments.delta",
          );
          expect(result.reason).toContain("retained-stream-prefix");
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
}
