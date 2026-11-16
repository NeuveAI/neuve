// Proof bundles are an operator-controlled input, not another capture-event writer.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Effect } from "effect";
import { resolveStoreLocation, mintUlid } from "@neuve/records-core";

test("proof import refuses capture kinds and reserved keys before writing bundle blobs", async () => {
  const root = mkdtempSync(join(tmpdir(), "proof-capture-boundary-"));
  try {
    for (const [index, kind] of [
      "capture.sealed@1",
      "proof.recorded@1",
    ].entries()) {
      const repo = join(root, `repo-${index}`);
      expect(Bun.spawnSync(["git", "init", "-q", repo]).exitCode).toBe(0);
      const bundle = join(root, `bundle-${index}.json`);
      writeFileSync(
        bundle,
        JSON.stringify({
          events: [
            {
              id: mintUlid(),
              kind,
              idempotencyKey: "capture.sealed:audit:synthetic",
              actor: "a".repeat(64),
              occurredAt: new Date().toISOString(),
              attribution: {
                sessionId: "synthetic-proof",
                range: {
                  baseRef: "refs/heads/main",
                  baseOid: "a".repeat(40),
                  headOid: "c".repeat(40),
                },
              },
              refs: [{ ref: `blob:${"b".repeat(64)}`, role: "artefact" }],
              payload: {
                kind: "log",
                revision: "c".repeat(40),
                claim: "Synthetic proof",
                requirement: { text: "Synthetic boundary" },
                artefact: { mediaType: "text/plain; charset=utf-8", bytes: 19 },
                worktree: {
                  head: "c".repeat(40),
                  scope: "tracked-tree",
                  dirty: false,
                },
              },
            },
          ],
          blobs: [
            {
              hash: "b".repeat(64),
              mediaType: "application/octet-stream",
              retention: "raw-capture",
              bytes: Buffer.from("synthetic raw bytes").toString("base64"),
            },
          ],
        }),
      );
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          join(import.meta.dir, "../src/harness-compare/harness-side.ts"),
          "import-proofs",
          "--bundle",
          bundle,
          "--to",
          repo,
          "--out",
          join(root, "out.json"),
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [err, code] = await Promise.all([
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).toBe(1);
      expect(err).toContain("proof bundle contains an unsupported event");
      const location = await Effect.runPromise(resolveStoreLocation(repo));
      const db = new Database(location.database);
      try {
        expect(
          db
            .query(
              "SELECT count(*) AS n FROM sqlite_master WHERE name IN ('events','blobs')",
            )
            .get(),
        ).toEqual({ n: 0 });
      } finally {
        db.close();
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120000);
