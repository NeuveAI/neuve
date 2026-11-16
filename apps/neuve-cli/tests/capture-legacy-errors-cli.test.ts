// Legacy inventory failures belong to one capture; a pruned source is never reported as retryable.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { Blobs, ByteStorage, storeLocationIn } from "@neuve/records-core";
import {
  captureRunDump,
  openCaptureJournal,
  readCapturedDump,
  DUMP_MEDIA_TYPE,
} from "@neuve/harness/session-dump";
import { encodeManifest } from "../../../packages/harness/src/pi/capture/archive.ts";
import {
  runIn,
  value,
  scanCaptures,
} from "../../../packages/harness/tests/pi/capture/fixture.ts";
test("audit continues after an unreadable legacy blob and reports a pruned legacy source", async () => {
  const root = mkdtempSync(join(tmpdir(), "capture-legacy-errors-"));
  const location = storeLocationIn(join(root, "store")),
    run = runIn(location);
  const legacy = async (runId: string) => {
    const journal = openCaptureJournal(join(root, runId), runId);
    journal.capture({
      type: "run.start",
      scope: { runId },
      runKind: "scored",
      sourceRevision: "a".repeat(40),
      route: "openai",
      pricing: "subscription",
    });
    journal.capture({ type: "run.end", scope: { runId }, status: "completed" });
    journal.close();
    const raw = value(
      await run(captureRunDump({ runId, journal: journal.directory })),
    );
    value(await run(scanCaptures(location)));
    const { scan, ...manifest } = value(
      await run(readCapturedDump(raw.capture)),
    ).manifest;
    const blob = value(
      await run(
        Effect.flatMap(Blobs.BlobStore, (b) =>
          b.put({
            bytes: encodeManifest(manifest),
            mediaType: DUMP_MEDIA_TYPE,
            retention: "raw-capture",
          }),
        ),
      ),
    );
    return { manifest, hash: blob.blob.hash };
  };
  try {
    const pruned = await legacy("prunedlegacy");
    const bytes = Buffer.concat([
      encodeManifest(pruned.manifest),
      Buffer.alloc(200000, 32),
    ]);
    const broken = value(
      await run(
        Effect.flatMap(Blobs.BlobStore, (b) =>
          b.put({
            bytes,
            mediaType: DUMP_MEDIA_TYPE,
            retention: "raw-capture",
          }),
        ),
      ),
    );
    rmSync(ByteStorage.blobPath(location, broken.blob.hash));
    const later = await legacy("laterlegacy");
    const file = pruned.manifest.files.find(
      (file) => file.name === "run.json",
    )!;
    value(
      await run(
        Effect.flatMap(
          SqlClient,
          (sql) =>
            sql`UPDATE blobs SET pruned_at='2026-11-02T00:00:00.000Z',content=NULL WHERE hash=${file.sha256}`,
        ),
      ),
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "../src/cli.ts"),
        "review",
        "audit",
        "--all",
        "--repair",
        "--store",
        location.directory,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, err).toBe(2);
    const results = JSON.parse(out);
    expect(results).toContainEqual(
      expect.objectContaining({
        rawCapture: broken.blob.hash,
        observed: "failed",
      }),
    );
    expect(results).toContainEqual(
      expect.objectContaining({
        rawCapture: pruned.hash,
        observed: "pruned",
        reason: "raw capture pruned on 2026-11-02T00:00:00.000Z",
        retryable: false,
      }),
    );
    expect(results).toContainEqual(
      expect.objectContaining({
        rawCapture: later.hash,
        observed: "clean",
        repaired: true,
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120000);
