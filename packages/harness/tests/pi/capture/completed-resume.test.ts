import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { readSessionDump } from "../../../src/session-dump.ts";
import {
  encodeManifest,
  readDump,
  writeDump,
  SourceValidation,
} from "../../../src/pi/capture/archive.ts";
import { sha256Of } from "../../../src/pi/capture/journal.ts";

test("a completed review closes across fresh claims without changing its certified native source", async () => {
  const root = mkdtempSync(join(tmpdir(), "completed-review-capture-"));
  const driver = fileURLToPath(
    new URL("../../fixtures/pi-completed-capture.ts", import.meta.url),
  );
  const run = async (directory: string, phase: string) => {
    const child = Bun.spawn([process.execPath, driver, directory, phase], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code !== 0)
      throw new Error(`completed capture fixture exited ${code}: ${err}`);
    writeFileSync(join(root, `${phase}-${Date.now()}.json`), out);
    return JSON.parse(out);
  };
  try {
    const safe = join(root, "safe");
    const first = await run(safe, "first");
    expect(first).toMatchObject({
      ok: true,
      receipt: {
        complete: true,
        execution: "ended",
        backup: { status: "captured" },
      },
      stages: 1,
      requests: 0,
    });
    const bundle = await readDump(first.receipt.portable.directory);
    const files = new Map(bundle.files);
    const certificate = SourceValidation.parse(
      JSON.parse(new TextDecoder().decode(files.get("source/validation.json"))),
    );
    files.set(
      "source/validation.json",
      new TextEncoder().encode(
        JSON.stringify({
          ...certificate,
          version: 7,
          basis: "nested-stream-error-coherence-v1",
        }),
      ),
    );
    const manifest = {
      ...bundle.manifest,
      files: bundle.manifest.files.map((file) => ({
        ...file,
        sha256: sha256Of(files.get(file.name)!),
        size: files.get(file.name)!.byteLength,
      })),
    };
    const manifestBytes = encodeManifest(manifest);
    const legacyRoot = join(root, "legacy-policy");
    mkdirSync(legacyRoot);
    const legacy = await writeDump({
      root: legacyRoot,
      manifest,
      manifestBytes,
      files,
      record: { ...bundle.record, manifest: sha256Of(manifestBytes) },
    });
    await expect(
      Effect.runPromise(readSessionDump(legacy.directory)),
    ).rejects.toThrow("policy is insufficient");
    for (let cycle = 0; cycle < 2; cycle++) {
      const resumed = await run(safe, "resume");
      expect(resumed).toMatchObject({
        ok: true,
        admission: { taskId: first.admission.taskId, admitted: "continued" },
        resume: "none",
        receipt: {
          complete: true,
          execution: "ended",
          backup: first.receipt.backup,
        },
        ended: first.ended,
        scheduling: "paused",
        stages: 0,
        restored: 0,
        requests: 0,
      });
      expect(resumed.before).toBe(resumed.after);
    }
    expect(await run(safe, "rotated-safe")).toMatchObject({
      ok: true,
      receipt: {
        complete: true,
        portable: { containsHistoricalSecret: false },
      },
      stages: 0,
      restored: 0,
      requests: 0,
    });
    for (const phase of [
      "document",
      "message",
      "physical",
      "artifact",
      "unsafe",
      "unsafe-rotated",
      "stale",
      "rotated",
    ]) {
      const changed = join(root, phase);
      mkdirSync(changed);
      cpSync(safe, changed, { recursive: true });
      expect(await run(changed, phase)).toMatchObject({
        ok: false,
        error: expect.stringContaining(
          phase.startsWith("unsafe")
            ? "credential exposure"
            : "source retained",
        ),
        stages: 0,
        restored: 0,
        requests: 0,
      });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
