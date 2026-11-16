// An old manifest has no filing event or mark, and must enter the same isolated scan via audit.
import { expect, test, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { SqlClient } from "effect/sql/SqlClient";
import { Blobs, storeLocationIn } from "@neuve/records-core";
import {
  legacyCaptures,
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
test("audit repair scans and marks an unfiled legacy capture for export", async () => {
  const root = mkdtempSync(join(tmpdir(), "capture-legacy-audit-"));
  try {
    const location = storeLocationIn(join(root, "store")),
      run = runIn(location);
    const journal = openCaptureJournal(join(root, "journal"), "legacy");
    journal.capture({
      type: "run.start",
      scope: { runId: "legacy" },
      runKind: "scored",
      sourceRevision: "a".repeat(40),
      route: "openai",
      pricing: "subscription",
    });
    journal.capture({
      type: "run.end",
      scope: { runId: "legacy" },
      status: "completed",
    });
    journal.close();
    const raw = value(
      await run(
        captureRunDump({ runId: "legacy", journal: journal.directory }),
      ),
    );
    value(await run(scanCaptures(location)));
    const held = value(await run(readCapturedDump(raw.capture)));
    const { scan, ...legacy } = held.manifest;
    const blob = value(
      await run(
        Effect.flatMap(Blobs.BlobStore, (b) =>
          b.put({
            bytes: encodeManifest(legacy),
            mediaType: DUMP_MEDIA_TYPE,
            retention: "raw-capture",
          }),
        ),
      ),
    );
    // Exercise the same validation with an enlarged byte inventory and an advancing monotonic clock.
    const runFile = legacy.files.find((file) => file.name === "run.json")!;
    const originalRun = value(
      await run(Effect.flatMap(Blobs.BlobStore, (b) => b.get(runFile.sha256))),
    );
    if (originalRun._tag !== "Present") throw new Error("missing run file");
    const padded = Buffer.concat([
      originalRun.bytes,
      Buffer.alloc(1024 ** 2, 32),
    ]);
    const runBlob = value(
      await run(
        Effect.flatMap(Blobs.BlobStore, (b) =>
          b.put({
            bytes: padded,
            mediaType: runFile.mediaType,
            retention: "raw-capture",
          }),
        ),
      ),
    );
    const large = {
      ...legacy,
      files: legacy.files.map((file) =>
        file.name === "run.json"
          ? { ...file, sha256: runBlob.blob.hash, size: padded.byteLength }
          : file,
      ),
    };
    const largeBlob = value(
      await run(
        Effect.flatMap(Blobs.BlobStore, (b) =>
          b.put({
            bytes: encodeManifest(large),
            mediaType: DUMP_MEDIA_TYPE,
            retention: "raw-capture",
          }),
        ),
      ),
    );
    let now = 0,
      ticks = 0;
    const clock = spyOn(performance, "now").mockImplementation(
      () => (now += 15000),
    );
    try {
      const { inspectRawCapture } =
        await import("../../../packages/harness/src/pi/capture/export.ts");
      const checked = value(
        await run(
          inspectRawCapture(
            location,
            largeBlob.blob.hash,
            () => {
              ticks++;
            },
            undefined,
            false,
          ),
        ),
      );
      expect(checked.basis).toBe("legacy-certificates");
      expect(now).toBeGreaterThan(30000);
      expect(ticks).toBeGreaterThan(large.files.length + 2);
    } finally {
      clock.mockRestore();
    }
    const capture = blob.blob.hash;
    value(await run(legacyCaptures()));
    const forgedBlob = value(
      await run(
        Effect.flatMap(Blobs.BlobStore, (b) =>
          b.put({
            bytes: encodeManifest({ ...legacy, runId: "forgedlegacy" }),
            mediaType: DUMP_MEDIA_TYPE,
            retention: "raw-capture",
          }),
        ),
      ),
    );
    const counts = () =>
      run(
        Effect.flatMap(
          SqlClient,
          (sql) =>
            sql`SELECT (SELECT count(*) FROM events) AS events,(SELECT count(*) FROM jobs) AS jobs,(SELECT count(*) FROM blobs) AS blobs`,
        ),
      ).then(value);
    const before = await counts();
    const dry = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "../src/cli.ts"),
        "review",
        "audit",
        "--all",
        "--store",
        location.directory,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [dryOut, dryErr, dryCode] = await Promise.all([
      new Response(dry.stdout).text(),
      new Response(dry.stderr).text(),
      dry.exited,
    ]);
    expect(dryCode, dryErr).toBe(2);
    expect(JSON.parse(dryOut)).toContainEqual(
      expect.objectContaining({
        rawCapture: forgedBlob.blob.hash,
        observed: "refused",
        basis: "legacy-certificates",
      }),
    );
    expect(await counts()).toEqual(before);
    const repair = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        join(import.meta.dir, "../src/cli.ts"),
        "review",
        "audit",
        "--capture",
        forgedBlob.blob.hash,
        "--repair",
        "--store",
        location.directory,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [repairOut, repairErr, repairCode] = await Promise.all([
      new Response(repair.stdout).text(),
      new Response(repair.stderr).text(),
      repair.exited,
    ]);
    expect(repairCode, repairErr).toBe(2);
    expect(JSON.parse(repairOut)).toEqual([
      expect.objectContaining({ observed: "refused", repaired: true }),
    ]);
    const { Exit } = await import("effect");
    expect(
      Exit.isFailure(await run(readCapturedDump(forgedBlob.blob.hash))),
    ).toBe(true);

    for (const repair of [false, true]) {
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          join(import.meta.dir, "../src/cli.ts"),
          "review",
          "audit",
          "--capture",
          capture,
          ...(repair ? ["--repair"] : []),
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
      expect(out.length, err).toBeGreaterThan(0);
      expect(JSON.parse(out)).toEqual([
        expect.objectContaining({
          rawCapture: capture,
          observed: "clean",
          disagrees: true,
          repaired: repair,
        }),
      ]);
    }
    expect(value(await run(readCapturedDump(capture))).run.runId).toBe(
      "legacy",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 120000);
