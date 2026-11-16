import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Why: a safe prefix must never count as a finished credential inventory.
test.each(["unfinished", "missing-result"])(
  "%s inventory refuses before certificates or publication",
  async (variant) => {
    const root = mkdtempSync(
      join(realpathSync(tmpdir()), "inspection-inventory-"),
    );
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          fileURLToPath(
            new URL("./inspection-inventory-fixture.ts", import.meta.url),
          ),
          root,
          variant,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
      const result = z
        .object({
          refused: z.boolean(),
          reason: z.string(),
          nativeUnchanged: z.boolean(),
          certificates: z.number(),
        })
        .parse(JSON.parse(stdout));
      expect(result).toEqual({
        refused: true,
        reason: "credential inspection inventory unfinished; export refused",
        nativeUnchanged: true,
        certificates: 0,
      });
      expect(readdirSync(join(root, ".git/neuve/datasets"))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  20_000,
);
