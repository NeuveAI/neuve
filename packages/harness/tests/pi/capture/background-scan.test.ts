// A close files immutable source bytes; only an immutable content verdict permits export.
import { afterAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SqlClient } from "effect/sql/SqlClient";
import { Effect, Exit } from "effect";
import {
  Log,
  Ingest,
  Spool,
  mintUlid,
  storeLocationIn,
} from "@neuve/records-core";
import {
  captureRunDump,
  exportCapturedDump,
  readCapturedDump,
} from "../../../src/pi/capture/export.ts";
import { readRawCapture } from "../../../src/pi/capture/raw.ts";
import * as CaptureRecords from "../../../src/pi/capture/records.ts";
import { auditCapture } from "../../../src/pi/capture/audit.ts";
import { ScanMachineBudget } from "../../../src/pi/capture/process.ts";
import {
  scanMemoryGrant,
  machineInspectionInputs,
} from "../../../src/pi/capture/inspection-pool.ts";
import { openCaptureJournal } from "../../../src/pi/capture/journal.ts";
import { runIn, value, scanCaptures } from "./fixture.ts";
const root = mkdtempSync(join(tmpdir(), "background-capture-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const command = [
  process.execPath,
  "--no-env-file",
  fileURLToPath(
    new URL("../../../../../apps/neuve-cli/src/cli.ts", import.meta.url),
  ),
];
const source = (id: string) => {
  const folder = join(root, id, "capture");
  const journal = openCaptureJournal(folder, id);
  journal.capture({
    type: "run.start",
    scope: { runId: id },
    runKind: "scored",
    sourceRevision: "a".repeat(40),
    route: "openai",
    pricing: "subscription",
  });
  journal.capture({
    type: "run.end",
    scope: { runId: id },
    status: "completed",
  });
  journal.close();
  return folder;
};

test("close files malformed raw bytes exactly and queues without inspecting", async () => {
  const location = storeLocationIn(join(root, "invalid-store"));
  const run = runIn(location);
  const folder = source("invalid");
  writeFileSync(join(folder, "events.jsonl"), "synthetic malformed frame\n", {
    mode: 0o600,
  });
  const exact = readFileSync(join(folder, "events.jsonl"));
  const first = value(
    await run(captureRunDump({ runId: "invalid", journal: folder })),
  );
  const again = value(
    await run(captureRunDump({ runId: "invalid", journal: folder })),
  );
  expect(again.capture).toBe(first.capture);
  expect(
    value(await run(readRawCapture(first.capture))).files.get(
      "capture/events.jsonl",
    ),
  ).toEqual(new Uint8Array(exact));
  expect(
    value(await run(CaptureRecords.scanStatus(first.capture))).status,
  ).toBe("pending");
  expect(Exit.isFailure(await run(readCapturedDump(first.capture)))).toBe(true);
}, 120000);

test("the isolated child scans after source removal; exports read its mark and audit repairs by superseding", async () => {
  const location = storeLocationIn(join(root, "clean-store"));
  const run = runIn(location);
  const folder = source("clean");
  const raw = value(
    await run(
      captureRunDump({ runId: "clean", journal: folder, close: "ended" }),
    ),
  );
  const datasets = join(root, "datasets");
  mkdirSync(datasets);
  expect(
    Exit.isFailure(
      await run(
        exportCapturedDump({
          capture: raw.capture,
          root: datasets,
          retention: { policy: "synthetic" },
        }),
      ),
    ),
  ).toBe(true);
  rmSync(join(root, "clean"), { recursive: true });
  value(await run(scanCaptures(location)));
  const mark = value(await run(CaptureRecords.markFor(raw.capture)));
  expect(mark?.payload.outcome).toBe("clean");
  expect(
    value(await run(readCapturedDump(raw.capture))).manifest.scan?.rawCapture,
  ).toBe(raw.capture);
  const exported = value(
    await run(
      exportCapturedDump({
        capture: raw.capture,
        root: datasets,
        redaction: "portable",
        retention: { policy: "synthetic" },
      }),
    ),
  );
  expect(exported.run.runId).toBe("clean");
  if (mark === undefined) throw new Error("missing mark");
  value(
    await run(
      CaptureRecords.appendMark(
        {
          ...mark.payload,
          outcome: "refused",
          reason:
            "credential exposure in exact source; source retained privately, export refused",
        },
        mark.id,
      ),
    ),
  );
  const falseMark = value(await run(CaptureRecords.markFor(raw.capture)));
  expect(
    value(await run(CaptureRecords.scanStatus(mark.payload.record))).status,
  ).toBe("refused");
  for (const identity of [raw.capture, mark.payload.record]) {
    expect(Exit.isFailure(await run(readCapturedDump(identity)))).toBe(true);
    expect(
      Exit.isFailure(
        await run(
          exportCapturedDump({
            capture: identity,
            root: datasets,
            retention: { policy: "synthetic" },
          }),
        ),
      ),
    ).toBe(true);
  }
  const replay = {
    ...mark,
    id: mintUlid(),
    idempotencyKey: "synthetic-replayed-clean",
  };
  const filingRow = value(await run(CaptureRecords.rawCaptures()))[0]!;
  if (filingRow._tag === "Invalid") throw new Error(filingRow.reason);
  const filing = filingRow.event;
  for (const event of [
    replay,
    { ...mark, kind: "capture.sealed@1" as const },
    filing,
  ])
    value(
      await run(
        Spool.writeSpoolLine(location.spool, {
          ...event,
          id: mintUlid(),
          idempotencyKey: `synthetic-spool-${event.kind}`,
        }),
      ),
    );
  const spooled = value(await run(Ingest.ingestSpool(location)));
  expect(spooled.appended).toBe(0);
  expect(spooled.rejected).toHaveLength(3);
  value(
    await run(
      Log.append([
        {
          ...replay,
          id: mintUlid(),
          idempotencyKey: "synthetic-direct-replayed-clean",
        },
      ]),
    ),
  );
  expect(
    value(await run(CaptureRecords.markFor(mark.payload.record)))?.id,
  ).toBe(falseMark?.id);
  expect(Exit.isFailure(await run(readCapturedDump(mark.payload.record)))).toBe(
    true,
  );

  const eventRow = value(await run(CaptureRecords.rawCaptures()))[0]!;
  if (eventRow._tag === "Invalid") throw new Error(eventRow.reason);
  const event = eventRow.event;
  const audit = (repair: boolean) =>
    auditCapture({ location, event, command, repair }).pipe(
      Effect.provideService(ScanMachineBudget, (sizes) =>
        scanMemoryGrant(sizes, {
          ...machineInspectionInputs(),
          available: 8 * 1024 ** 3,
        }),
      ),
    );
  const blobRows = Effect.flatMap(
    SqlClient,
    (sql) => sql`SELECT hash,captured_at,pruned_at FROM blobs ORDER BY hash`,
  );
  const beforeAudit = value(await run(blobRows));
  expect(value(await run(audit(false)))).toMatchObject({
    observed: "clean",
    disagrees: true,
    repaired: false,
  });
  expect(value(await run(blobRows))).toEqual(beforeAudit);
  expect(value(await run(CaptureRecords.markFor(raw.capture)))?.id).toBe(
    falseMark?.id,
  );
  const repairs = value(
    await run(Effect.all([audit(true), audit(true)], { concurrency: 2 })),
  );
  expect(repairs.filter((result) => result.repaired)).toHaveLength(1);
  expect(repairs.find((result) => !result.repaired)).toMatchObject({
    repaired: false,
    reason: "capture mark changed during audit; repair not applied",
  });
  const repaired = value(await run(CaptureRecords.markFor(raw.capture)));
  expect(repaired?.payload.outcome).toBe("clean");
  expect(repaired?.causation?.supersedes).toBe(falseMark?.id);
}, 120000);

test("filing freezes the authority by receipt, scans after deletion, and prunes checkpoint with raw capture", async () => {
  const { SourceOwnership } =
    await import("../../../src/pi/source-ownership.ts");
  const { PrivateInspection } =
    await import("../../../src/pi/capture/private-inspection.ts");
  const { openNodeSqliteStorage } =
    await import("@earendil-works/pi-durable/storage/sqlite/node");
  const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
  const { existsSync, realpathSync } = await import("node:fs");
  const { SqlClient } = await import("effect/sql/SqlClient");
  const { Blobs } = await import("@neuve/records-core");
  const { captureCheckpointSweep } =
    await import("../../../src/pi/capture/retention.ts");
  const location = storeLocationIn(join(root, "checkpoint-store"));
  const run = runIn(location);
  const journal = source("checkpoint");
  const sourceDirectory = realpathSync(join(journal, ".."));
  const ownership = SourceOwnership.acquire(sourceDirectory);
  const authority = PrivateInspection.create({
    ownership,
    source: sourceDirectory,
    directory: join(root, "authority"),
    excludedRoots: [sourceDirectory],
  });
  const native = join(sourceDirectory, "pi.sqlite");
  const storage = await openNodeSqliteStorage(native);
  let raw;
  try {
    raw = value(
      await run(
        captureRunDump({
          runId: "checkpoint",
          journal,
          nativeDatabase: native,
          credentialInspection: authority,
          close: "ended",
        }),
      ),
    );
    const again = value(
      await run(
        captureRunDump({
          runId: "checkpoint",
          journal,
          nativeDatabase: native,
          credentialInspection: authority,
          close: "ended",
        }),
      ),
    );
    expect(again.capture).toBe(raw.capture);
    expect(again.raw.checkpoint).toEqual(raw.raw.checkpoint);
    const files = (await import("node:fs")).readdirSync(
      join(location.directory, "capture-authorities"),
    );
    expect(files).toHaveLength(1);
  } finally {
    await storage.close(BACKGROUND_CONTEXT);
    authority.close();
    ownership.release();
  }
  expect(raw.raw.checkpoint).not.toBeNull();
  const path = join(
    location.directory,
    "capture-authorities",
    raw.raw.checkpoint!.id,
  );
  expect(existsSync(path)).toBe(true);
  rmSync(sourceDirectory, { recursive: true });
  value(await run(scanCaptures(location)));
  expect(value(await run(CaptureRecords.scanStatus(raw.capture))).status).toBe(
    "clean",
  );
  const sweep = captureCheckpointSweep(location);
  expect(value(await run(sweep.wanted))).toBe(false);
  const TestClock = await import("effect/testing/TestClock");
  const future = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.andThen(
      TestClock.setTime(Date.now() + 31 * 24 * 60 * 60 * 1000),
      effect,
    ).pipe(Effect.provide(TestClock.layer()));
  expect(value(await run(future(sweep.wanted)))).toBe(false);
  value(
    await run(
      future(
        Effect.flatMap(Blobs.BlobStore, (blobs) =>
          blobs.prune({
            cutoff: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
            limit: 128,
          }),
        ),
      ),
    ),
  );
  expect(value(await run(future(sweep.wanted)))).toBe(true);
  value(await run(future(sweep.sweep)));
  expect(existsSync(path)).toBe(false);
  expect(value(await run(CaptureRecords.scanStatus(raw.capture))).status).toBe(
    "pruned",
  );
}, 120000);

test("retention clears abandoned private staging immediately and preserves owned work", async () => {
  const { utimesSync, existsSync } = await import("node:fs");
  const { captureCheckpointSweep } =
    await import("../../../src/pi/capture/retention.ts");
  const location = storeLocationIn(join(root, "orphan-store"));
  const run = runIn(location);
  const expired = join(location.directory, "capture-jobs", "job-expired");
  const recent = join(location.directory, "capture-jobs", "job-recent");
  mkdirSync(expired, { recursive: true, mode: 0o700 });
  mkdirSync(recent, { mode: 0o700 });
  const { writeCaptureOwner } =
    await import("../../../src/pi/capture/staging.ts");
  writeCaptureOwner(recent);
  writeFileSync(join(expired, "synthetic-raw"), "synthetic bytes", {
    mode: 0o600,
  });
  utimesSync(expired, new Date(0), new Date(0));
  const sweep = captureCheckpointSweep(location);
  expect(value(await run(sweep.wanted))).toBe(true);
  value(await run(sweep.sweep));
  expect(existsSync(expired)).toBe(false);
  expect(existsSync(recent)).toBe(true);
}, 120000);

test("capture mark wording and persisted scan defects exclude private messages", async () => {
  const { CaptureMarked } = await import("@neuve/records-schema");
  const { Blobs, JobQueue, JOB_POLICIES, Worker } =
    await import("@neuve/records-core");
  const { captureScanHandler } = await import("../../../src/pi/capture/job.ts");
  const location = storeLocationIn(join(root, "defect-store"));
  const run = runIn(location);
  value(
    await run(captureRunDump({ runId: "defect", journal: source("defect") })),
  );
  const failed = value(
    await run(
      Effect.gen(function* () {
        const queue = yield* JobQueue.JobQueue;
        const job = yield* queue.take(["capture.scan"]);
        if (job._tag === "None") throw new Error("missing synthetic job");
        const blobs = yield* Blobs.BlobStore;
        const exit = yield* Effect.exit(
          captureScanHandler({ location, command })(job.value).pipe(
            Effect.provideService(Blobs.BlobStore, {
              ...blobs,
              inspect: () =>
                Effect.die(new Error("synthetic private defect body")),
            }),
          ),
        );
        if (exit._tag === "Success") throw new Error("expected failed scan");
        yield* queue.fail(
          job.value.seq,
          job.value.attempts,
          Worker.describeFailure(exit.cause, JOB_POLICIES["capture.scan"]),
        );
        const recorded = yield* queue.inspect(job.value.seq);
        if (recorded._tag === "None") throw new Error("missing failed job");
        return recorded.value;
      }).pipe(Effect.provide(JobQueue.layer)),
    ),
  );
  expect(JSON.stringify(failed.lastError)).not.toContain("synthetic private");
  expect(failed.lastError?.message).toBe(
    "capture close failed (private details suppressed)",
  );
  expect(
    CaptureMarked.safeParse({
      id: mintUlid(),
      idempotencyKey: "synthetic-invalid-reason",
      actor: "a".repeat(64),
      occurredAt: new Date().toISOString(),
      kind: "capture.marked@1",
      payload: {
        rawCapture: "a".repeat(64),
        detectorVersion: "capture-scan-v1",
        outcome: "refused",
        record: "b".repeat(64),
        reason: "synthetic private reason",
      },
    }).success,
  ).toBe(true);
}, 120000);

test("capture key squatting is rejected at the spool and log, and an old squatted repair fails closed", async () => {
  const { commitEvent } =
    await import("../../../../records-core/tests/support.ts");
  const location = storeLocationIn(join(root, "squatted-key-store"));
  const run = runIn(location);
  const raw = value(
    await run(
      captureRunDump({ runId: "squatted", journal: source("squatted") }),
    ),
  );
  value(await run(scanCaptures(location)));
  const mark = value(await run(CaptureRecords.markFor(raw.capture)))!;
  const refused = {
    ...mark.payload,
    outcome: "refused" as const,
    record: "b".repeat(64),
    reason:
      "credential exposure in exact source; source retained privately, export refused",
  };
  const key = `capture.sealed:audit:${mark.id}:${refused.record}`;
  const commit = { ...commitEvent("7".repeat(40)), idempotencyKey: key };
  const { RecordEvent } = await import("@neuve/records-schema");
  const event = RecordEvent.parse(commit);
  value(await run(Spool.writeSpoolLine(location.spool, event)));
  expect(value(await run(Ingest.ingestSpool(location)))).toMatchObject({
    appended: 0,
    rejected: [{ reason: expect.any(String) }],
  });
  expect(Exit.isFailure(await run(Log.append([event])))).toBe(true);
  value(await run(CaptureRecords.appendMark(refused, mark.id)));
  expect(value(await run(CaptureRecords.scanStatus(raw.capture))).status).toBe(
    "refused",
  );
  expect(Exit.isFailure(await run(readCapturedDump(mark.payload.record)))).toBe(
    true,
  );
  // A pre-fix store may already contain a different-kind row under a future repair key.
  const refusedMark = value(await run(CaptureRecords.markFor(raw.capture)))!;
  value(await run(CaptureRecords.appendMark(mark.payload, refusedMark.id)));
  const current = value(await run(CaptureRecords.markFor(raw.capture)))!;
  expect(current.payload.outcome).toBe("clean");
  const historical = RecordEvent.parse({
    ...commitEvent("8".repeat(40)),
    idempotencyKey: "synthetic-pre-fix-key",
  });
  value(await run(Log.append([historical])));
  value(
    await run(
      Effect.flatMap(
        SqlClient,
        (sql) =>
          sql`INSERT INTO events (id,kind,idempotency_key,fingerprint,actor_id,occurred_at,recorded_at,envelope) SELECT ${mintUlid()},kind,${`capture.sealed:audit:${current.id}:${refused.record}`},fingerprint,actor_id,occurred_at,recorded_at,envelope FROM events WHERE id=${historical.id}`,
      ),
    ),
  );
  expect(
    value(await run(CaptureRecords.scanStatus(raw.capture))),
  ).toMatchObject({
    status: "refused",
    reason: "capture scan mark has an idempotency conflict",
  });
  expect(
    Exit.isFailure(await run(CaptureRecords.appendMark(refused, current.id))),
  ).toBe(true);
  expect(Exit.isFailure(await run(readCapturedDump(mark.payload.record)))).toBe(
    true,
  );
}, 120000);

test("an old-shape sealed audit refusal supersedes the clean mark", async () => {
  const location = storeLocationIn(join(root, "old-shape-store"));
  const run = runIn(location);
  const raw = value(
    await run(
      captureRunDump({ runId: "old-shape", journal: source("old-shape") }),
    ),
  );
  value(await run(scanCaptures(location)));
  const current = value(await run(CaptureRecords.markFor(raw.capture)))!;
  const { causation: _, ...base } = current;
  const payload = {
    ...current.payload,
    outcome: "refused" as const,
    record: "b".repeat(64),
    reason:
      "credential exposure in exact source; source retained privately, export refused",
  };
  const key = `audit:${current.id}:${payload.record}`,
    id = mintUlid();
  value(
    await run(
      Log.append([
        {
          ...base,
          id: mintUlid(),
          kind: "capture.sealed@1",
          idempotencyKey: `capture.sealed:${key}`,
          payload,
        },
        {
          ...base,
          id,
          idempotencyKey: `capture.marked:${key}`,
          payload,
          causation: { supersedes: current.id },
        },
      ]),
    ),
  );
  expect(
    value(await run(CaptureRecords.markFor(current.payload.record)))?.id,
  ).toBe(id);
  expect(value(await run(CaptureRecords.scanStatus(raw.capture))).status).toBe(
    "refused",
  );
  expect(
    Exit.isFailure(await run(readCapturedDump(current.payload.record))),
  ).toBe(true);
}, 120000);

test("a matching-kind audit key squat from another writer also fails closed", async () => {
  const location = storeLocationIn(join(root, "same-kind-store")),
    run = runIn(location);
  const raw = value(
    await run(
      captureRunDump({ runId: "same-kind", journal: source("same-kind") }),
    ),
  );
  value(await run(scanCaptures(location)));
  const mark = value(await run(CaptureRecords.markFor(raw.capture)))!;
  const { causation: _, ...base } = mark;
  value(
    await run(
      Log.append([
        {
          ...base,
          id: mintUlid(),
          actor: "d".repeat(64),
          kind: "capture.sealed@1",
          idempotencyKey: `capture.sealed:audit:${mark.id}:${"b".repeat(64)}`,
          payload: {
            ...mark.payload,
            record: "b".repeat(64),
            outcome: "refused",
            reason:
              "credential exposure in exact source; source retained privately, export refused",
          },
        },
      ]),
    ),
  );
  expect(
    value(await run(CaptureRecords.scanStatus(raw.capture))),
  ).toMatchObject({
    status: "refused",
    reason: "capture scan mark has an idempotency conflict",
  });
  expect(Exit.isFailure(await run(readCapturedDump(mark.payload.record)))).toBe(
    true,
  );
}, 120000);

test("an old sealed clean mark with a private reason stays readable but refuses status and export", async () => {
  const { Admin, canonicalJson } = await import("@neuve/records-core");
  const { fingerprintOf } =
    await import("../../../../records-core/src/codec.ts");
  const location = storeLocationIn(join(root, "legacy-reason-store")),
    run = runIn(location);
  const raw = value(
    await run(
      captureRunDump({
        runId: "legacyreason",
        journal: source("legacyreason"),
      }),
    ),
  );
  value(await run(scanCaptures(location)));
  const old = value(await run(CaptureRecords.markFor(raw.capture)))!;
  const payload = {
    ...old.payload,
    reason: "synthetic older-build private reason",
  };
  const seal = {
    id: mintUlid(),
    kind: "capture.sealed@1",
    actor: old.actor,
    idempotencyKey: `capture.sealed:audit:${old.id}:${old.payload.record}`,
    occurredAt: new Date().toISOString(),
    payload,
  };
  const mark = {
    ...seal,
    id: mintUlid(),
    kind: "capture.marked@1",
    idempotencyKey: `capture.marked:audit:${old.id}:${old.payload.record}`,
    causation: { causedBy: seal.id, supersedes: old.id },
  };
  const { RecordEvent } = await import("@neuve/records-schema");
  value(
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        for (const item of [seal, mark]) {
          const event = RecordEvent.parse(item);
          yield* sql`INSERT INTO events (id,kind,idempotency_key,fingerprint,actor_id,occurred_at,recorded_at,envelope) VALUES (${event.id},${event.kind},${event.idempotencyKey},${fingerprintOf(event)},${event.actor},${event.occurredAt},${event.occurredAt},${canonicalJson(event)})`;
        }
        yield* Log.history({});
        yield* Admin.rebuild;
      }),
    ),
  );
  expect(
    value(await run(CaptureRecords.scanStatus(raw.capture))),
  ).toMatchObject({
    status: "refused",
    reason: "capture scan has not passed; export refused",
  });
  expect(Exit.isFailure(await run(readCapturedDump(raw.capture)))).toBe(true);
}, 120000);

test("filing count admission is typed and follows an idempotent existing filing", async () => {
  const { RecordEvent } = await import("@neuve/records-schema");
  const { canonicalJson } = await import("@neuve/records-core");
  const { fingerprintOf } =
    await import("../../../../records-core/src/codec.ts");
  const location = storeLocationIn(join(root, "typed-filing-store")),
    run = runIn(location);
  const payload = {
    rawCapture: "d".repeat(64),
    runId: "overbound",
    checkpoint: null,
    counts: { records: Number.MAX_SAFE_INTEGER, bytes: 1, calls: 0, frames: 1 },
    sizes: { total: 1, largest: 1 },
  };
  const event = CaptureRecords.captureFiledEvent(payload);
  const refused = value(await run(Log.append([event]).pipe(Effect.result)));
  expect(refused).toMatchObject({
    _tag: "Failure",
    failure: {
      _tag: "InvalidEvent",
      message: "invalid capture scan counts; filing refused",
    },
  });
  value(
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient;
        const stored = RecordEvent.parse(event);
        yield* sql`INSERT INTO events (id,kind,idempotency_key,fingerprint,actor_id,occurred_at,recorded_at,envelope) VALUES (${stored.id},${stored.kind},${stored.idempotencyKey},${fingerprintOf(stored)},${stored.actor},${stored.occurredAt},${stored.occurredAt},${canonicalJson(stored)})`;
      }),
    ),
  );
  expect(
    value(await run(Log.append([CaptureRecords.captureFiledEvent(payload)])))[0]
      ?.status,
  ).toBe("existing");
}, 120000);

test("the scan child refuses a sealed manifest re-presented as a legacy raw capture", async () => {
  const { runScanProcess } = await import("../../../src/pi/capture/process.ts");
  const location = storeLocationIn(join(root, "sealed-as-legacy-store")),
    run = runIn(location);
  const raw = value(
    await run(
      captureRunDump({
        runId: "sealedlegacy",
        journal: source("sealedlegacy"),
      }),
    ),
  );
  value(await run(scanCaptures(location)));
  const sealed = value(await run(CaptureRecords.markFor(raw.capture)))!.payload
    .record;
  const verdict = value(
    await run(
      runScanProcess({
        location,
        command,
        observe: true,
        event: CaptureRecords.captureFiledEvent({
          rawCapture: sealed,
          runId: "sealedlegacy",
          checkpoint: null,
          counts: { records: 1, bytes: 1, calls: 0, frames: 1 },
          sizes: { total: 1, largest: 1 },
        }),
      }).pipe(
        Effect.provideService(ScanMachineBudget, (sizes) =>
          scanMemoryGrant(sizes, {
            ...machineInspectionInputs(),
            available: 8 * 1024 ** 3,
          }),
        ),
      ),
    ),
  );
  expect(verdict).toMatchObject({
    outcome: "refused",
    reason: "invalid raw capture manifest",
  });
  expect(value(await run(CaptureRecords.scanStatus(raw.capture))).status).toBe(
    "clean",
  );
}, 120000);
