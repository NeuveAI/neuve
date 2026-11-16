import { encodeManifest } from "../../../src/pi/capture/archive.ts";
// Why: the session dump is the dataset hill climbs and evaluations read (10.148, NEU-54), and
// record 0004 makes it the only copy of a review run's pi state once the run folder goes. These run
// a real pi Harness on its SQLite storage at the run folder's `pi.sqlite`, through a route that
// emits capture where the provider does, and check what crosses each boundary: the removal that
// captures before it deletes, the raw capture in Records, and the dataset folder copied from it.
import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  realpathSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Option } from "effect";
import { Blobs, storeLocationIn } from "@neuve/records-core";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Type } from "@earendil-works/pi-ai";
import {
  Harness,
  createRegistry,
  defineExtension,
  defineTool,
  type Extension,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  exportCapturedDump,
  exportSnapshot,
  readCapturedDump as readMarkedDump,
  readSessionDump,
} from "../../../src/pi/capture/export.ts";
import {
  openCaptureJournal,
  sha256Of,
} from "../../../src/pi/capture/journal.ts";
import type { PriceRate } from "../../../src/pi/capture/dump.ts";
import {
  captureFolder,
  ensureRunFolder,
  piDatabase,
  removeRunFolder,
  runFolder,
} from "../../../src/run-folder.ts";
import {
  ENCRYPTED,
  Lab,
  MODEL,
  route,
  runIn,
  scanCaptures,
  usage,
  value,
} from "./fixture.ts";

const context = BACKGROUND_CONTEXT;
const directory = realpathSync(
  mkdtempSync(join(tmpdir(), "harness-capture-run-")),
);
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const location = storeLocationIn(join(directory, "store"));
const run = runIn(location);
const readCapturedDump = (...args: Parameters<typeof readMarkedDump>) =>
  Effect.andThen(scanCaptures(location), readMarkedDump(...args));

const RATE: PriceRate = {
  name: "openai-list",
  version: 1,
  currency: "USD",
  source: "test rate",
  perMillionTokens: { input: 2, cacheRead: 0.1, cacheWrite: 2, output: 10 },
};

const manifest = (runId: string) => ({
  runId,
  runKey: `key-${runId}`,
  pipelineVersion: 1,
  range: { baseRef: "main", baseOid: "a".repeat(40), headOid: "b".repeat(40) },
  jobSeq: 1,
});

/** Opens a run folder with pi's SQLite storage and a journal in it, as the runtime will. */
const openRun = async (
  runId: string,
  extension: Extension = Lab,
  retry: { enabled: boolean; maxRetries?: number; baseDelayMs?: number } = {
    enabled: false,
  },
) => {
  value(await run(ensureRunFolder(location, manifest(runId))));
  const journal = openCaptureJournal(captureFolder(location, runId), runId);
  const scope = { runId };
  const routed = route(journal.capture, { runId, agent: "investigate" });
  const registry = createRegistry();
  registry.install(extension);
  const harness = await Harness.open(
    await openNodeSqliteStorage(piDatabase(location, runId)),
    {
      models: routed.models,
      registry,
      settings: {
        retry,
        compaction: { enabled: false, keepRecentTokens: 1 },
      },
    },
    context,
  );
  return { journal, scope, routed, harness };
};

test("a finished run's pi state is captured into Records before its folder is removed, whole and joined", async () => {
  const RUN = "01RUNCAPTURE0000000000000A";
  const { journal, scope, routed, harness } = await openRun(RUN);
  const capture = journal.capture;
  capture({
    type: "run.start",
    scope,
    runKind: "scored",
    sourceRevision: "abc123",
    route: "chatgpt",
    pricing: "subscription",
  });
  routed.faux.setResponses([
    routed.step(
      fauxAssistantMessage(
        fauxToolCall("read_file", { path: "a.ts" }, { id: "fc_1" }),
        {
          stopReason: "toolUse",
          responseId: "r1",
        },
      ),
      usage(1000, 200, 500),
    ),
    routed.step(
      fauxAssistantMessage(
        fauxToolCall("delegate", { task: "check a.ts" }, { id: "fc_2" }),
        {
          stopReason: "toolUse",
          responseId: "r2",
        },
      ),
      usage(3000, 100),
    ),
    routed.step(
      fauxAssistantMessage("child answer", { responseId: "r3" }),
      usage(400, 50),
    ),
    routed.step(
      fauxAssistantMessage("done", { responseId: "r4" }),
      usage(3500, 80),
    ),
    routed.step(
      fauxAssistantMessage("summary of the work so far", { responseId: "r5" }),
      usage(2000, 300),
    ),
  ]);

  const root = await harness.root(context, {
    agent: { model: MODEL, extensions: [Lab] },
  });
  capture({
    type: "session.bind",
    scope: {
      ...scope,
      stage: "investigate",
      agent: "investigate.p1",
      conversationId: root.id,
    },
    computationId: "comp-1",
  });
  expect(
    (
      await (
        await root.submit({ type: "input", content: "review" }, context)
      ).wait(context)
    ).status,
  ).toBe("done");
  await harness.waitForTask(await root.compact(undefined, context), context);
  capture({
    type: "stage.end",
    scope: { ...scope, stage: "investigate" },
    status: "completed",
  });

  const dispose = await harness.createConversation(
    { ownership: { kind: "ownerless" }, agent: { model: MODEL } },
    context,
  );
  capture({
    type: "session.bind",
    scope: {
      ...scope,
      stage: "dispose",
      agent: "dispose.u1",
      conversationId: dispose.id,
    },
  });
  routed.failNext();
  await (
    await dispose.submit({ type: "input", content: "judge" }, context)
  ).wait(context);
  capture({
    type: "stage.end",
    scope: { ...scope, stage: "dispose" },
    status: "failed",
    reason: "upstream 500",
  });

  const assemble = await harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent: { model: { provider: "openai-slow", modelId: "gpt-5.5" } },
    },
    context,
  );
  capture({
    type: "session.bind",
    scope: {
      ...scope,
      stage: "assemble",
      agent: "assemble.u1",
      conversationId: assemble.id,
    },
  });
  routed.slow.setResponses([
    routed.step(
      fauxAssistantMessage(fauxText("partial words ".repeat(400)), {
        responseId: "r7",
      }),
      usage(900, 0),
    ),
  ]);
  await assemble.submit({ type: "input", content: "assemble" }, context);
  await Bun.sleep(1200);
  await assemble.abort(context);
  capture({
    type: "stage.end",
    scope: { ...scope, stage: "assemble" },
    status: "cutoff",
    reason: "time limit",
  });

  const fate = (
    leadId: string,
    handoff: "investigate" | "rank" | "assemble" | "dispose" | "publish",
    fate: "handed-on" | "attached" | "dropped" | "below-cut" | "published",
    extra: Record<string, string | number> = {},
  ) =>
    capture({
      type: "lead.fate",
      scope: { ...scope, stage: handoff },
      leadId,
      handoff,
      fate,
      ...extra,
    });
  fate("L1", "investigate", "handed-on");
  fate("L1", "rank", "handed-on", { rank: 1, cut: 5 });
  fate("L1", "assemble", "attached", { unitId: "u1" });
  fate("L1", "dispose", "handed-on", { findId: "f1" });
  fate("L1", "publish", "published", { publicationId: "p1" });
  fate("L2", "investigate", "handed-on");
  fate("L2", "rank", "below-cut", { rank: 7, cut: 5 });
  fate("L3", "investigate", "dropped", { reason: "irrelevant" });
  capture({
    type: "artifact",
    scope: { ...scope, stage: "publish" },
    name: "review.md",
    mediaType: "text/markdown",
    bytes: new TextEncoder().encode("# Review\nby ann@example.com\n"),
  });
  capture({ type: "run.end", scope, status: "completed", publicationId: "p1" });
  journal.close();
  await harness.close(context);

  const removed = value(
    await run(removeRunFolder(location, RUN, { rate: RATE })),
  );
  expect(existsSync(runFolder(location, RUN))).toBe(false);
  expect(Option.getOrThrow(removed.dump)).toMatchObject({
    complete: false,
    pendingScan: true,
  });
  const hash = Option.getOrThrow(removed.dump).capture;
  expect(removed.captures).toEqual([hash]);

  const dump = value(await run(readCapturedDump(hash)));
  expect(dump.run.gaps).toEqual([]);
  expect(
    dump.run.stages.map((stage) => [
      stage.stage,
      stage.status,
      stage.sessions.length,
      stage.totals.tokens.totalTokens,
    ]),
  ).toEqual([
    ["investigate", "completed", 2, 11130],
    ["dispose", "failed", 1, 0],
    ["assemble", "cutoff", 1, 1480],
  ]);
  expect(dump.run.totals).toEqual({
    tokens: {
      input: 9980,
      output: 2130,
      cacheRead: 500,
      cacheWrite: 0,
      totalTokens: 12610,
    },
    cost: {
      recorded: {
        status: "unknown",
        reason: "subscription route: no per-token price",
      },
      estimate: { rate: "openai-list@1", total: 0.04131 },
    },
  });
  const session = (id: number) =>
    dump.sessions.find((s) => s.conversationId === id)!;
  const turns = (id: number) =>
    session(id).turns.map((turn) => [
      turn.responseId ?? null,
      turn.stopReason,
      turn.tokens.totalTokens,
      turn.join,
      turn.requestedAt !== null &&
        turn.endedAt !== null &&
        turn.requestedAt <= turn.endedAt,
      turn.toolCalls.map((call) => [call.name, call.resultEntryId !== null]),
    ]);
  expect(turns(root.id)).toEqual([
    ["r1", "toolUse", 1700, "response-id", true, [["read_file", true]]],
    ["r2", "toolUse", 3100, "response-id", true, [["delegate", true]]],
    ["r4", "stop", 3580, "response-id", true, []],
  ]);
  expect(session(root.id).totals.ledger?.tokens.totalTokens).toBe(10680);
  expect(session(root.id).compactions).toMatchObject([{ reason: "manual" }]);
  expect(
    session(root.id).offeredTools.map((o) =>
      o.added.map((tool) => (tool as { name: string }).name),
    ),
  ).toEqual([["read_file", "delegate"]]);
  const child = dump.sessions.find((s) => s.owner?.conversationId === root.id)!;
  expect(child.binding).toEqual({
    stage: "investigate",
    agent: "investigate.p1",
    computationId: "comp-1",
    inheritedFrom: root.id,
  });
  expect(turns(child.conversationId)).toEqual([
    ["r3", "stop", 450, "response-id", true, []],
  ]);
  expect(turns(dispose.id)).toEqual([
    [null, "error", 0, "message-timestamp", true, []],
  ]);
  expect(turns(assemble.id)).toEqual([
    ["r7", "aborted", 1480, "response-id", true, []],
  ]);
  expect(
    session(assemble.id).calls.map((call) => [
      call.end?.outcome,
      call.end?.usage ?? null,
    ]),
  ).toEqual([["aborted", null]]);
  expect(
    dump.unjoined.map((call) => [
      call.callId,
      call.role,
      call.end?.usage?.totalTokens,
    ]),
  ).toEqual([[expect.any(String), "non-turn", 2300]]);
  const firstCall = session(root.id).calls[0]!;
  expect(firstCall.credentialCoverage).toBe("none");
  expect(firstCall.events).toMatchObject([
    {
      name: "response.output_item.done",
      data: {
        type: "function_call",
        call_id: "fc_1",
        name: "read_file",
        arguments: '{\n "path": "a.ts"\n}',
      },
    },
  ]);
  expect(firstCall.headerNames).toEqual(["content-type", "session-id"]);
  expect(
    firstCall.body.status === "sent" &&
      (firstCall.body.json as { input: Array<unknown> }).input[0],
  ).toEqual({ type: "reasoning", encrypted_content: ENCRYPTED, summary: [] });
  const toolResult = session(root.id).entries.find(
    (entry) => (entry as { kind: string }).kind === "pi.tool-result",
  ) as { model: Array<{ content: Array<{ text: string }> }> };
  expect(toolResult.model[0]!.content[0]!.text).toBe(
    'owner: "<email>"\nsecond line\n<email>',
  );
  expect(new TextDecoder().decode(dump.artifacts.get("artifacts/0"))).toBe(
    "# Review\nby <email>\n",
  );
  expect(dump.run.artifacts).toEqual([
    {
      scope: { ...scope, stage: "publish" },
      name: "review.md",
      mediaType: "text/markdown",
      sanitization: "sanitized",
      file: "artifacts/0",
      sha256: sha256Of(new TextEncoder().encode("# Review\nby <email>\n")),
      size: 20,
      original: {
        sha256: sha256Of(
          new TextEncoder().encode("# Review\nby ann@example.com\n"),
        ),
        size: 28,
        file: "artifacts/0.original",
      },
    },
  ]);
  expect(dump.unverifiableOriginals).toEqual([]);
  expect(dump.run.backup).toMatchObject({
    status: "captured",
    format: "sqlite",
  });
  expect(dump.run.leads.handoffs).toEqual({
    find: 0,
    verify: 0,
    investigate: 3,
    rank: 2,
    assemble: 1,
    dispose: 1,
    publish: 1,
  });
  expect(dump.run.leads.open).toEqual([]);

  const stored = value(
    await run(
      Effect.gen(function* () {
        const blobs = yield* Blobs.BlobStore;
        const rows = yield* Effect.forEach(
          [hash, ...dump.manifest.files.map((f) => f.sha256)],
          (h) => blobs.inspect(h),
        );
        const texts = yield* Effect.forEach(dump.manifest.files, (f) =>
          Effect.map(blobs.get(f.sha256), (blob) => [
            f.name,
            blob._tag === "Present" ? new TextDecoder().decode(blob.bytes) : "",
          ]),
        );
        return {
          retentions: [
            ...new Set(rows.map((row) => Option.getOrThrow(row).retention)),
          ],
          texts,
        };
      }),
    ),
  );
  expect(stored.retentions).toEqual(["raw-capture"]);
  // The masked files carry no identifier but keep the continuation; the original artifact, pi's
  // native backup and the raw journal are the exact restricted bytes.
  expect(
    stored.texts
      .filter(([, text]) => text!.includes("example.com"))
      .map(([name]) => name),
  ).toEqual([
    "artifacts/0.original",
    "journal/events.jsonl",
    "native/pi.sqlite",
  ]);
  expect(
    stored.texts
      .filter(([, text]) => text!.includes(ENCRYPTED))
      .map(([name]) => name)
      .toSorted(),
  ).toEqual(
    [
      ...dump.run.sessions.map((s) => s.file),
      "calls/unjoined.json",
      "journal/events.jsonl",
    ].toSorted(),
  );

  const datasets = join(directory, "datasets");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(datasets);
  const retention = {
    policy:
      "pr-bench treatment runs, kept until the port's comparison is published",
  };
  const sealedHash = sha256Of(encodeManifest(dump.manifest));
  const exported = value(
    await run(
      exportCapturedDump({
        capture: hash,
        root: datasets,
        retention,
        now: () => new Date("2026-10-28T12:00:00.000Z"),
      }),
    ),
  );
  expect(exported).toMatchObject({
    directory: join(datasets, "restricted", "scored", RUN, sealedHash),
    snapshotId: sealedHash,
    reused: false,
  });
  const restored = value(await run(readSessionDump(exported.directory)));
  expect(restored.run).toEqual(dump.run);
  expect(restored.record).toMatchObject({
    format: "neuve.session-dump.export",
    snapshotId: sealedHash,
    manifest: sealedHash,
    source: `records:${sealedHash}`,
    exportedAt: "2026-10-28T12:00:00.000Z",
    retention,
    redaction: { mode: "restricted" },
  });
  const again = value(
    await run(exportCapturedDump({ capture: hash, root: datasets, retention })),
  );
  expect(again).toMatchObject({ directory: exported.directory, reused: true });

  const rejected = async () => {
    const exit = await run(readSessionDump(exported.directory));
    return Exit.isFailure(exit)
      ? (Cause.squash(exit.cause) as { reason: string }).reason
      : "read";
  };
  const object = join(
    exported.directory,
    "objects",
    dump.manifest.files[1]!.sha256,
  );
  const original = await Bun.file(object).bytes();
  writeFileSync(object, new Uint8Array(original).fill(0x20));
  expect(await rejected()).toBe(
    `${dump.manifest.files[1]!.name}: checksum mismatch`,
  );
  unlinkSync(object);
  writeFileSync(join(directory, "elsewhere"), original);
  symlinkSync(join(directory, "elsewhere"), object);
  expect(await rejected()).toBe(`not a regular file: ${object}`);
  unlinkSync(object);
  expect(await rejected()).toBe(`missing ${object}`);
  writeFileSync(object, original);
  writeFileSync(join(exported.directory, "objects", "f".repeat(64)), "stray");
  expect(await rejected()).toBe(`unnamed object ${"f".repeat(64)}`);
  unlinkSync(join(exported.directory, "objects", "f".repeat(64)));
  expect(await rejected()).toBe("read");

  // Records' 30-day limit prunes the raw capture; the dataset keeps its own retention.
  const pruned = value(
    await run(
      Effect.flatMap(Blobs.BlobStore, (blobs) =>
        blobs.prune({ cutoff: "2999-01-01T00:00:00.000Z", limit: 1000 }),
      ),
    ),
  );
  expect(pruned.map((blob) => blob.hash)).toContain(hash);
  const gone = await run(readCapturedDump(hash));
  expect(
    Exit.isFailure(gone) &&
      (Cause.squash(gone.cause) as { reason: string }).reason,
  ).toContain("export refused");
  expect(await rejected()).toBe("read");
});

test("a failed run keeps its gaps; corrupt source bytes are filed privately and never exported", async () => {
  const RUN = "01RUNCAPTURE0000000000000B";
  const { journal, scope, routed, harness } = await openRun(RUN);
  journal.capture({
    type: "run.start",
    scope,
    runKind: "scored",
    sourceRevision: "abc123",
    route: "chatgpt",
    pricing: "subscription",
  });
  routed.faux.setResponses([
    routed.step(
      fauxAssistantMessage("half", { responseId: "f1" }),
      usage(10, 5),
    ),
  ]);
  const conversation = await harness.createConversation(
    { ownership: { kind: "ownerless" }, agent: { model: MODEL } },
    context,
  );
  journal.capture({
    type: "session.bind",
    scope: {
      ...scope,
      stage: "understand",
      agent: "understand",
      conversationId: conversation.id,
    },
  });
  await (
    await conversation.submit({ type: "input", content: "understand" }, context)
  ).wait(context);
  // The job's last attempt fails here: no stage.end, no run.end, and the process never closes the journal.
  await harness.close(context);
  const removed = value(await run(removeRunFolder(location, RUN)));
  expect(existsSync(runFolder(location, RUN))).toBe(false);
  const failedDump = value(
    await run(readCapturedDump(Option.getOrThrow(removed.dump).capture)),
  );
  expect({
    complete: failedDump.run.complete,
    gaps: failedDump.run.gaps.map((gap) => gap.code),
  }).toMatchObject({
    complete: false,
    gaps: ["journal-interrupted", "run-end-missing", "stage-end-missing"],
  });

  const CORRUPT = "01RUNCAPTURE0000000000000C";
  const second = await openRun(CORRUPT);
  second.journal.capture({
    type: "artifact",
    scope: { runId: CORRUPT },
    name: "review.json",
    mediaType: "application/json",
    bytes: new TextEncoder().encode('{"by":"ann@example.com"}'),
  });
  second.journal.close();
  await second.harness.close(context);
  const objects = join(captureFolder(location, CORRUPT), "objects");
  writeFileSync(
    join(objects, readdirSync(objects)[0]!),
    '{"by":"someone else"}',
  );
  const preserved = value(await run(removeRunFolder(location, CORRUPT)));
  expect(preserved.removed).toBe(true);
  expect(Option.getOrThrow(preserved.dump).pendingScan).toBe(true);
  expect(existsSync(piDatabase(location, CORRUPT))).toBe(false);
  const blocked = await run(
    readCapturedDump(Option.getOrThrow(preserved.dump).capture),
  );
  expect(Exit.isFailure(blocked)).toBe(true);
});

/** A run whose first response is cut off inside a tool call's arguments, retried as pi retries it. */
const runWithCutOffCall = async (RUN: string) => {
  const { journal, scope, routed, harness } = await openRun(RUN, Lab, {
    enabled: true,
    maxRetries: 1,
    baseDelayMs: 0,
  });
  journal.capture({
    type: "run.start",
    scope,
    runKind: "scored",
    sourceRevision: "abc123",
    route: "chatgpt",
    pricing: "subscription",
  });
  routed.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("read_file", { path: "cut" }, { id: "fc_cut" }),
      {
        stopReason: "error",
        errorMessage: "the stream failed or ended without a terminal event",
        responseId: "cut",
      },
    ),
    routed.step(
      fauxAssistantMessage(
        fauxToolCall("read_file", { path: "a.ts" }, { id: "fc_ran" }),
        { stopReason: "toolUse", responseId: "ran" },
      ),
      usage(10, 5),
    ),
    routed.step(
      fauxAssistantMessage("done", { responseId: "done" }),
      usage(20, 5),
    ),
  ]);
  const root = await harness.root(context, {
    agent: { model: MODEL, extensions: [Lab] },
  });
  journal.capture({
    type: "session.bind",
    scope: {
      ...scope,
      stage: "investigate",
      agent: "investigate.p1",
      conversationId: root.id,
    },
  });
  expect(
    (
      await (
        await root.submit({ type: "input", content: "review" }, context)
      ).wait(context)
    ).status,
  ).toBe("done");
  journal.capture({
    type: "stage.end",
    scope: { ...scope, stage: "investigate" },
    status: "completed",
  });
  journal.capture({ type: "run.end", scope, status: "completed" });
  journal.close();
  await harness.close(context);
};

test("a tool call in a failed turn never ran and owes no result; a dispatched call still does", async () => {
  const CUT = "01RUNCAPTURE0000000000000P";
  await runWithCutOffCall(CUT);
  const removed = value(await run(removeRunFolder(location, CUT)));
  const dump = value(
    await run(readCapturedDump(Option.getOrThrow(removed.dump).capture)),
  );
  expect({
    complete: dump.run.complete,
    gaps: dump.run.gaps.map((gap) => gap.code),
  }).toEqual({ complete: true, gaps: [] });
  expect(
    dump.sessions[0]!.turns.map((turn) => [
      turn.stopReason,
      turn.toolCalls.map((call) => [call.id, call.resultEntryId !== null]),
    ]),
  ).toEqual([
    ["error", [["fc_cut", false]]],
    ["toolUse", [["fc_ran", true]]],
    ["stop", []],
  ]);

  const LOST = "01RUNCAPTURE0000000000000Q";
  await runWithCutOffCall(LOST);
  const native = new Database(piDatabase(location, LOST));
  native.run(
    "DELETE FROM entries WHERE json_extract(record, '$.model[0].toolCallId') = 'fc_ran'",
  );
  native.close();
  const lost = value(await run(removeRunFolder(location, LOST)));
  const lostDump = value(
    await run(readCapturedDump(Option.getOrThrow(lost.dump).capture)),
  );
  expect(lostDump.run.complete).toBe(false);
  expect(lostDump.run.gaps.map((gap) => [gap.code, gap.count])).toContainEqual([
    "tool-results-missing",
    1,
  ]);
  expect(
    lostDump.run.gaps.find((gap) => gap.code === "tool-results-missing")!
      .detail,
  ).toContain("fc_ran");
  // Two real pi runs, each with a retry and a capture scan, take 8 to 16 s under load.
}, 60_000);

test("a request whose capture fails is never dispatched, and the run's dump discloses the loss", async () => {
  const RUN = "01RUNCAPTURE0000000000000D";
  const { journal, scope, routed, harness } = await openRun(RUN);
  journal.capture({
    type: "run.start",
    scope,
    runKind: "scored",
    sourceRevision: "abc123",
    route: "chatgpt",
    pricing: "subscription",
  });
  const conversation = await harness.createConversation(
    { ownership: { kind: "ownerless" }, agent: { model: MODEL } },
    context,
  );
  const invalid = (() => {
    try {
      journal.capture({
        type: "session.bind",
        scope: {
          ...scope,
          stage: "dispose",
          agent: "dispose.u1",
          conversationId: -1,
        },
      });
      return "kept";
    } catch (error) {
      return error;
    }
  })();
  expect(invalid).toMatchObject({
    _tag: "CaptureFailed",
    kind: "invalid",
    event: "session.bind",
  });
  routed.faux.setResponses([
    routed.step(
      fauxAssistantMessage("never", { responseId: "n1" }),
      usage(1, 1),
    ),
  ]);
  await (
    await conversation.submit({ type: "input", content: "judge" }, context)
  ).wait(context);
  expect(routed.faux.state.callCount).toBe(0);
  expect(() => journal.close()).toThrow();
  await harness.close(context);

  const removed = value(await run(removeRunFolder(location, RUN)));
  const dump = value(
    await run(readCapturedDump(Option.getOrThrow(removed.dump).capture)),
  );
  expect(dump.run.gaps.map((gap) => [gap.code, gap.count])).toEqual([
    ["journal-failed", 1],
    ["journal-interrupted", 1],
    ["run-end-missing", 1],
    ["session-unbound", 1],
    ["turns-uncaptured", 1],
  ]);
  expect(dump.run.gaps[0]!.detail).toMatch(
    /^session\.bind: scope\.conversationId /,
  );
  expect(
    dump.sessions[0]!.turns.map((turn) => [turn.stopReason, turn.callId]),
  ).toEqual([["error", null]]);
  expect(dump.sessions[0]!.turns[0]!.errorMessage).toMatch(
    /^capture failed before dispatch: /,
  );
});

test("a capture taken while a turn streams keeps the live partial and calls it in flight", async () => {
  const RUN = "01RUNCAPTURE0000000000000E";
  const { journal, scope, routed, harness } = await openRun(RUN);
  journal.capture({
    type: "run.start",
    scope,
    runKind: "scored",
    sourceRevision: "abc123",
    route: "chatgpt",
    pricing: "subscription",
  });
  const conversation = await harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent: { model: { provider: "openai-slow", modelId: "gpt-5.5" } },
    },
    context,
  );
  journal.capture({
    type: "session.bind",
    scope: {
      ...scope,
      stage: "assemble",
      agent: "assemble.u1",
      conversationId: conversation.id,
    },
  });
  journal.capture({
    type: "lead.fate",
    scope: { ...scope, stage: "investigate" },
    leadId: "L1",
    handoff: "investigate",
    fate: "handed-on",
  });
  routed.slow.setResponses([
    routed.step(
      fauxAssistantMessage(fauxText("streaming words ".repeat(400)), {
        responseId: "s1",
      }),
      usage(50, 1600),
    ),
  ]);
  await conversation.submit({ type: "input", content: "assemble" }, context);
  await Bun.sleep(900);

  const { captureNativeRun } = await import("../../../src/run-folder.ts");
  const live = value(await run(captureNativeRun(location, RUN)));
  const dump = value(
    await run(readCapturedDump(Option.getOrThrow(live).capture)),
  );
  expect(dump.run.gaps.map((gap) => gap.code)).toEqual([
    "journal-interrupted",
    "run-end-missing",
    "stage-end-missing",
    "work-in-flight",
    "leads-open",
  ]);
  const inFlight = dump.sessions[0]!.inFlight as {
    generation: {
      message: { responseId: string; content: Array<{ text: string }> };
    };
  };
  expect(inFlight.generation.message.responseId).toBe("s1");
  expect(
    inFlight.generation.message.content[0]!.text.startsWith("streaming words"),
  ).toBe(true);
  expect(
    dump.unjoined.map((call) => [
      call.role,
      call.response?.responseId,
      call.end,
    ]),
  ).toEqual([["in-flight", "s1", null]]);
  await conversation.abort(context);
  await harness.close(context);
});

/** A tool whose name, schema and description carry the declared identifiers below as protocol and prose. */
const Desk = defineExtension({
  name: "desk",
  tools: [
    defineTool({
      name: "send_report",
      description: "Send the scored report to the session art red team.",
      parameters: Type.Object({
        sessionKey: Type.String({ description: "the session key" }),
      }),
      execute: async () => ({
        content: [{ type: "text", text: "sent to the red team" }],
      }),
    }),
  ],
});

// D1 and R1: masking ran over every string of the finished dump, so a declared identifier equal to
// part of a structural token (`scored`, `ended`, `sessions/`, `artifacts/`, `captured`) left a capture
// no reader accepts, and removal then deleted the run folder behind it; and a raw function-call
// `arguments` string with an escaped newline before an email lost its escape and stopped parsing.
test("declared identifiers matching the dump's own tokens mask only content, and the capture stays readable before its folder goes", async () => {
  const RUN = "01RUNCAPTURE0000000000000F";
  const declared = ["scored", "end", "ses", "art", "red"];
  const { journal, scope, routed, harness } = await openRun(RUN, Desk);
  journal.capture({
    type: "run.start",
    scope,
    runKind: "scored",
    sourceRevision: "abc123",
    route: "chatgpt",
    pricing: "subscription",
  });
  const args = { sessionKey: "scored\nann@example.com" };
  routed.faux.setResponses([
    routed.step(
      fauxAssistantMessage(
        fauxToolCall("send_report", args, { id: "fc_scored" }),
        { stopReason: "toolUse", responseId: "d1" },
      ),
      usage(100, 10),
    ),
    routed.step(
      fauxAssistantMessage("done", { responseId: "d2" }),
      usage(120, 2),
    ),
  ]);
  const root = await harness.root(context, {
    agent: { model: MODEL, extensions: [Desk] },
  });
  journal.capture({
    type: "session.bind",
    scope: {
      ...scope,
      stage: "investigate",
      agent: "investigate.p1",
      conversationId: root.id,
    },
    computationId: "comp-session-art",
  });
  await (
    await root.submit(
      {
        type: "input",
        content:
          "review the scored session art for red ends, ask ann@example.com",
      },
      context,
    )
  ).wait(context);
  journal.capture({
    type: "lead.fate",
    scope: { ...scope, stage: "investigate" },
    leadId: "lead-scored-1",
    handoff: "investigate",
    fate: "dropped",
    reason: "red herring",
  });
  journal.capture({
    type: "stage.end",
    scope: { ...scope, stage: "investigate" },
    status: "completed",
  });
  journal.capture({
    type: "artifact",
    scope,
    name: "report.txt",
    mediaType: "text/plain",
    bytes: new TextEncoder().encode("the scored report\n"),
  });
  journal.capture({
    type: "run.end",
    scope,
    status: "completed",
    publicationId: "p-red",
  });
  journal.close();
  await harness.close(context);
  const raw = new Uint8Array(
    readFileSync(join(captureFolder(location, RUN), "events.jsonl")),
  );

  const datasets = join(directory, "declared-datasets");
  mkdirSync(datasets);
  const retention = { policy: "declared fixture" };
  const storage = await openNodeSqliteStorage(piDatabase(location, RUN));
  const direct = await exportSnapshot({
    runId: RUN,
    journal: captureFolder(location, RUN),
    native: { reads: storage, context },
    nativeDatabase: piDatabase(location, RUN),
    declared,
    root: datasets,
    retention,
  }).finally(() => storage.close(context));
  expect(value(await run(readSessionDump(direct.directory))).run).toMatchObject(
    {
      runKind: "scored",
      execution: "ended",
    },
  );

  const removed = value(
    await run(removeRunFolder(location, RUN, { declared })),
  );
  expect(removed.removed).toBe(true);
  const capture = Option.getOrThrow(removed.dump).capture;
  const dump = value(await run(readCapturedDump(capture)));
  const [session] = dump.sessions;
  expect(dump.run).toMatchObject({
    runId: RUN,
    runKind: "scored",
    status: "completed",
    execution: "ended",
    close: "ended",
    publicationId: "p-red",
    backup: { status: "captured", file: "native/pi.sqlite" },
    journal: {
      status: "captured",
      file: "journal/events.jsonl",
      sha256: sha256Of(raw),
      size: raw.byteLength,
    },
    stages: [{ stage: "investigate", status: "completed" }],
    sessions: [{ file: `sessions/${root.id}.json` }],
    artifacts: [
      {
        name: "report.txt",
        sanitization: "sanitized",
        file: "artifacts/0",
        original: { file: "artifacts/0.original" },
      },
    ],
    gaps: [],
    complete: true,
  });
  expect(dump.run.leads.ledger).toEqual([
    {
      leadId: "lead-scored-1",
      fates: [
        {
          seq: expect.any(Number),
          stage: "investigate",
          handoff: "investigate",
          fate: "dropped",
          reason: "<masked> herring",
        },
      ],
      targets: [],
      terminal: ["dropped"],
      final: "dropped",
    },
  ]);
  expect(session!.binding).toEqual({
    stage: "investigate",
    agent: "investigate.p1",
    computationId: "comp-session-art",
  });
  expect(new TextDecoder().decode(dump.artifacts.get("artifacts/0"))).toBe(
    "the <masked> report\n",
  );

  const assistant = session!.entries.find(
    (entry) => (entry as { kind: string }).kind === "pi.assistant",
  ) as { model: Array<Record<string, unknown>> };
  expect(assistant.model[0]).toMatchObject({
    role: "assistant",
    api: "faux",
    provider: "openai",
    stopReason: "toolUse",
    responseId: "d1",
    content: [
      {
        type: "toolCall",
        id: "fc_scored",
        name: "send_report",
        arguments: { sessionKey: "<masked>\n<email>" },
      },
    ],
  });
  const sessionText = JSON.stringify(session);
  expect(sessionText).toContain(
    "review the <masked> <masked>sion <masked> for <masked> <masked>s, ask <email>",
  );
  expect(sessionText).not.toContain("example.com");
  expect(session!.offeredTools[0]!.added).toEqual([
    expect.objectContaining({
      name: "send_report",
      description:
        "S<masked> the <masked> report to the <masked>sion <masked> <masked> team.",
      parameters: expect.objectContaining({
        type: "object",
        required: ["sessionKey"],
        properties: {
          sessionKey: { type: "string", description: "the <masked>sion key" },
        },
      }),
    }),
  ]);
  expect(session!.turns[0]!.toolCalls).toEqual([
    { id: "fc_scored", name: "send_report", resultEntryId: expect.any(Number) },
  ]);

  const [event] = session!.calls[0]!.events;
  expect(event).toMatchObject({
    name: "response.output_item.done",
    data: { type: "function_call", call_id: "fc_scored", name: "send_report" },
  });
  const sent = (event!.data as { arguments: string }).arguments;
  expect(JSON.parse(sent)).toEqual({ sessionKey: "<masked>\n<email>" });
  expect(session!.calls[0]).toMatchObject({
    route: "chatgpt",
    api: "faux",
    path: "/backend-api/codex/responses",
  });

  // The sanitized arguments are a new serialization; the raw journal keeps the model's own bytes.
  const original = JSON.stringify(args, null, 1);
  expect(sent).not.toBe(original);
  const stored = value(
    await run(
      Effect.flatMap(Blobs.BlobStore, (blobs) => blobs.get(sha256Of(raw))),
    ),
  );
  expect(stored._tag === "Present" && stored.bytes).toEqual(raw);
  expect(new TextDecoder().decode(raw)).toContain(
    JSON.stringify(original).slice(1, -1),
  );

  for (const redaction of ["restricted", "portable"] as const) {
    const filed = value(
      await run(
        exportCapturedDump({
          capture,
          root: datasets,
          retention,
          redaction,
        }),
      ),
    );
    const read = value(await run(readSessionDump(filed.directory)));
    expect([
      read.manifest.redaction,
      read.run.runKind,
      read.run.journal.status,
    ]).toEqual([
      redaction,
      "scored",
      redaction === "portable" ? "withheld" : "captured",
    ]);
  }
});
