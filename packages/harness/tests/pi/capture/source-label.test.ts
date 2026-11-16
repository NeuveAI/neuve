// Why: reading runs ask for reasoning summaries and are never scored (10.10). The label comes from
// run.start, so these check it against the run's own requests: a scored run that asked for
// summaries is disclosed and cannot be filed as scored, and the two kinds land in separate folders.
import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Exit, Option } from "effect";
import { storeLocationIn } from "@neuve/records-core";
import {
  exportCapturedDump,
  readCapturedDump,
} from "../../../src/pi/capture/export.ts";
import { openCaptureJournal } from "../../../src/pi/capture/journal.ts";
import type { Json, RunKind } from "../../../src/pi/capture/types.ts";
import {
  captureFolder,
  ensureRunFolder,
  removeRunFolder,
} from "../../../src/run-folder.ts";
import { runIn, value, scanCaptures } from "./fixture.ts";

const directory = realpathSync(
  mkdtempSync(join(tmpdir(), "harness-capture-label-")),
);
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const location = storeLocationIn(join(directory, "store"));
const run = runIn(location);
const datasets = join(directory, "datasets");
mkdirSync(datasets);
const retention = { policy: "label separation fixture" };

/** A run folder holding only a journal with one call, captured on removal. */
const captured = async (
  runId: string,
  runKind: RunKind | null,
  reasoning: Record<string, Json>,
) => {
  value(
    await run(
      ensureRunFolder(location, {
        runId,
        runKey: runId,
        pipelineVersion: 1,
        range: {
          baseRef: "main",
          baseOid: "a".repeat(40),
          headOid: "b".repeat(40),
        },
        jobSeq: 1,
      }),
    ),
  );
  const journal = openCaptureJournal(captureFolder(location, runId), runId);
  const scope = { runId };
  if (runKind !== null)
    journal.capture({
      type: "run.start",
      scope,
      runKind,
      sourceRevision: "abc123",
      route: "chatgpt",
      pricing: "subscription",
    });
  journal.capture({
    type: "model.request",
    scope,
    callId: "c1",
    route: "chatgpt",
    provider: "openai",
    model: "gpt-5.5",
    credentialCoverage: "none",
    headerNames: ["content-type"],
    body: { status: "sent", json: { model: "gpt-5.5", reasoning } },
  });
  journal.capture({
    type: "model.end",
    scope,
    callId: "c1",
    outcome: "completed",
  });
  journal.capture({ type: "run.end", scope, status: "completed" });
  journal.close();
  const removed = value(await run(removeRunFolder(location, runId)));
  const receipt = Option.getOrThrow(removed.dump);
  value(await run(scanCaptures(location)));
  const dump = value(await run(readCapturedDump(receipt.capture)));
  const { sha256Of } = await import("../../../src/pi/capture/journal.ts");
  const { encodeManifest } = await import("../../../src/pi/capture/archive.ts");
  return {
    ...receipt,
    snapshotId: sha256Of(encodeManifest(dump.manifest)),
    complete: dump.run.complete,
    gaps: dump.run.gaps.map((gap) => gap.code),
  };
};

const exported = async (capture: string) => {
  const exit = await run(
    exportCapturedDump({ capture, root: datasets, retention }),
  );
  return Exit.isSuccess(exit) ? exit.value.directory : Cause.squash(exit.cause);
};

test("scored and reading runs are filed apart, and a scored run that asked for summaries is refused", async () => {
  const reading = await captured("RUN_READING", "reading", {
    effort: "high",
    summary: "detailed",
  });
  expect(reading.gaps).not.toContain("scored-with-summaries");
  expect(await exported(reading.capture)).toBe(
    join(datasets, "restricted", "reading", "RUN_READING", reading.snapshotId),
  );

  const scored = await captured("RUN_SCORED", "scored", { effort: "high" });
  expect(scored.gaps).not.toContain("scored-with-summaries");
  expect(await exported(scored.capture)).toBe(
    join(datasets, "restricted", "scored", "RUN_SCORED", scored.snapshotId),
  );

  const mislabelled = await captured("RUN_MISLABELLED", "scored", {
    effort: "high",
    summary: "detailed",
  });
  expect(mislabelled).toMatchObject({ complete: false });
  expect(mislabelled.gaps).toContain("scored-with-summaries");
  expect(await exported(mislabelled.capture)).toMatchObject({
    _tag: "DumpRefused",
    capture: mislabelled.capture,
    reason: "a scored run whose requests asked for reasoning summaries",
  });
  expect(
    existsSync(join(datasets, "restricted", "scored", "RUN_MISLABELLED")),
  ).toBe(false);

  const unlabelled = await captured("RUN_UNLABELLED", null, { effort: "high" });
  expect(unlabelled.gaps).toContain("run-start-missing");
  expect(await exported(unlabelled.capture)).toMatchObject({
    _tag: "DumpRefused",
    reason:
      "no run.start was captured, so the run has no kind to file it under",
  });
  // Alone 2.07-3.21 s at load 10-17; 10x slowest, at least 30 s; SQLite and capture I/O under load.
}, 40_000);
