import { expect, test } from "bun:test";
import {
  readdirSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { CloseDiagnostic } from "../../../src/pi/capture/close-diagnostic.ts";

const Result = z.object({
  refused: z.literal(true),
  reason: z.string(),
  closeError: z.string(),
  closeDiagnostic: CloseDiagnostic,
  nativeUnchanged: z.boolean(),
  jobs: z.number(),
  certifiedAtCancellation: z.boolean(),
  filesystem: z.object({ count: z.number() }),
});

test.each([
  { job: 2, failure: "cancelled" },
  { job: 3, failure: "cancelled" },
  { job: 3, failure: "budget" },
])(
  "SDK job $job $failure refuses projection or sealing with the original close budget on a slow symlinked mount",
  async ({ job: cancelAt, failure }) => {
    const root = mkdtempSync(
      join(realpathSync(tmpdir()), "projection-cancel-"),
    );
    const physical = join(root, "volume/cases/go/293649/replay-candidate-11");
    const alias = join(root, "case");
    mkdirSync(physical, { recursive: true });
    symlinkSync(physical, alias);
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          fileURLToPath(
            new URL("./projection-cancel-fixture.ts", import.meta.url),
          ),
          alias,
          String(cancelAt),
          failure,
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, NEUVE_MODE: "check" },
        },
      );
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
      const result = Result.parse(JSON.parse(stdout));
      expect(result).toMatchObject({
        refused: true,
        nativeUnchanged: true,
        jobs: cancelAt,
        certifiedAtCancellation: true,
      });
      expect(result.filesystem.count).toBeGreaterThan(0);
      const reason = result.reason;
      expect(result.closeDiagnostic.refusal).toBe(reason);
      expect(result.closeError).toContain(reason);
      expect(reason).toStartWith(
        `credential inspection unavailable (${failure === "budget" ? "budget:units" : "cancelled"}); phase ${cancelAt === 2 ? "projection" : "finalization"}; usage units=`,
      );
      expect(reason).toContain("; limits units=34359738368");
      expect(reason).toEndWith("; source retained privately, export refused");
      expect(reason?.length).toBeGreaterThan(300);
      expect(reason).not.toContain("synthetic-lease");
      expect(readdirSync(join(alias, ".git/neuve/datasets"))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  20_000,
);
