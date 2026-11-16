// Importing an operator bundle cannot add dump-typed blobs to the legacy capture inventory.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Effect } from "effect";
import { resolveStoreLocation } from "@neuve/records-core";

test("proof import rejects capture media before any write and accepts proof media", async () => {
  const root = mkdtempSync(join(tmpdir(), "proof-media-"));
  try {
    for (const [index, mediaType] of [
      "application/vnd.neuve.session-dump+json",
      "text/plain; charset=utf-8",
    ].entries()) {
      const repo = join(root, `repo-${index}`);
      expect(Bun.spawnSync(["git", "init", "-q", repo]).exitCode).toBe(0);
      const bundle = join(root, `bundle-${index}.json`);
      writeFileSync(
        bundle,
        JSON.stringify({
          events: [],
          blobs: [
            {
              hash: "b".repeat(64),
              mediaType,
              retention: "durable",
              bytes: Buffer.from("synthetic proof").toString("base64"),
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
          join(root, `out-${index}.json`),
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [error, code] = await Promise.all([
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).toBe(index === 0 ? 1 : 0);
      if (index === 0)
        expect(error).toContain(
          "proof bundle contains an unsupported artefact",
        );
      const location = await Effect.runPromise(resolveStoreLocation(repo));
      if (index === 0) {
        const database = new Database(location.database);
        expect(
          database
            .query(
              "SELECT count(*) AS n FROM sqlite_master WHERE name IN ('events','blobs')",
            )
            .get(),
        ).toEqual({ n: 0 });
        database.close();
      } else {
        expect(existsSync(join(root, `out-${index}.json`))).toBe(true);
        const database = new Database(location.database, { readonly: true });
        expect(
          database.query("SELECT media_type AS mediaType FROM blobs").all(),
        ).toEqual([{ mediaType }]);
        database.close();
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120000);
