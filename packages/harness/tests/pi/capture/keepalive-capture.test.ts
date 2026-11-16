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
import { keepaliveFixture, type Variant } from "./keepalive-fixture.ts";

for (const variant of [
  "safe",
  "credential",
  "bad-count",
  "bad-frame",
] satisfies Variant[]) {
  test(`keepalive capture through a symlinked case mount: ${variant}`, async () => {
    const root = mkdtempSync(
      join(realpathSync(tmpdir()), "keepalive-capture-"),
    );
    const physical = join(
      root,
      "volume",
      "cases",
      "go",
      "293649",
      "replay-candidate-7",
    );
    mkdirSync(physical, { recursive: true });
    const alias = join(root, "case");
    symlinkSync(physical, alias);
    try {
      const result = await keepaliveFixture(alias, variant);
      expect(result.callbacks).toBe(6);
      if (variant === "safe") {
        expect(result).toMatchObject({
          refused: false,
          complete: true,
          execution: "ended",
          nativeMatchesManifest: true,
          journalMatchesSource: true,
          keepalives: 1,
        });
        if (result.refused) throw new Error("safe capture refused");
        expect(result.nativeBytes).toBeGreaterThan(0);
      } else {
        expect(result).toMatchObject({ refused: true, nativeUnchanged: true });
        if (!result.refused) throw new Error("unsafe capture exported");
        if (variant === "bad-count") {
          expect(result.reason).toContain(
            "call 1: SDK callback count contradicts original invocation",
          );
          expect(result.reason).toContain("callbacks 6/5");
        }
        if (variant === "bad-frame") {
          expect(result.reason).toContain(
            "call 1: SDK keepalive framing invalid",
          );
          expect(result.reason).toContain(
            "keepalive/response.output_text.delta",
          );
        }
        expect(result.reason).toContain(
          variant === "credential"
            ? "credential exposure"
            : "retained-stream-prefix",
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
}
