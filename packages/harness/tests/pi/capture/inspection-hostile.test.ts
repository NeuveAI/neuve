import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Why: fixed workers are trusted only after their IPC replies pass the actual parent boundary.
test.each([
  "malformed",
  "wrong-id",
  "wrong-identity",
  "foreign-observation",
  "foreign-result",
  "over-lease",
  "missing-result",
  "crash",
  "observed-then-hostile",
])(
  "%s detector reply refuses the build and joins every worker",
  async (variant) => {
    const root = mkdtempSync(
      join(realpathSync(tmpdir()), "inspection-hostile-"),
    );
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          fileURLToPath(
            new URL("./inspection-hostile-fixture.ts", import.meta.url),
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
          replies: z.number(),
          joined: z.boolean(),
          certificates: z.number(),
          exposed: z.boolean(),
        })
        .parse(JSON.parse(stdout));
      expect(result).toMatchObject({
        refused: true,
        nativeUnchanged: true,
        joined: true,
        certificates: 0,
        exposed: variant === "observed-then-hostile",
      });
      expect(result.replies).toBeGreaterThan(0);
      expect(result.reason).toStartWith(
        "durable credential inspection unavailable (",
      );
      expect(result.reason).not.toContain("synthetic-private-response");
      expect(readdirSync(join(root, ".git/neuve/datasets"))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);
