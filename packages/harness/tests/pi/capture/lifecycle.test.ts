// Why: record 0004 makes the capture the only copy of a run's pi state once its folder goes, and a
// held review reopens under the same run ID, so every close must leave its own immutable snapshot
// with pi's exact state in it. These run real pi Harnesses on SQLite through a route that captures
// where the provider does, close them at the raw `Storage.close` boundary the runtime uses, and
// check each home of the dump: Records, the direct folder of a coding session, and the portable
// copy. Reasoning here is synthetic; real summaries are never printed.
import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  realpathSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit, Option } from "effect";
import { storeLocationIn } from "@neuve/records-core";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  Harness,
  createRegistry,
  type ConversationId,
  type EntryRecord,
  type Storage,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { CloseMode, CloseReceipt } from "../../../src/pi/capture/close.ts";
import {
  exportCapturedDump,
  exportPortableSnapshot,
  exportSnapshot,
  readCapturedDump as readMarkedDump,
  readSessionDump,
} from "../../../src/pi/capture/export.ts";
import {
  fullOutputPath,
  openCaptureJournal,
  sha256Of,
} from "../../../src/pi/capture/journal.ts";
import {
  captureFolder,
  ensureRunFolder,
  exportOnClose,
  piDatabase,
  removeRunFolder,
  runFolder,
  type OpenNativeStorage,
} from "../../../src/run-folder.ts";
import {
  captureAuthority,
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
const parentDirectory = realpathSync(
  mkdtempSync(join(tmpdir(), "harness-capture-lifecycle-")),
);
afterAll(() => rmSync(parentDirectory, { recursive: true, force: true }));
const retention = { policy: "lifecycle fixture" };
const SETTINGS = {
  retry: { enabled: false },
  compaction: { enabled: false, keepRecentTokens: 1 },
};

const manifest = (runId: string) => ({
  runId,
  runKey: `key-${runId}`,
  pipelineVersion: 1,
  range: { baseRef: "main", baseOid: "a".repeat(40), headOid: "b".repeat(40) },
  jobSeq: 1,
});

const failure = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : "succeeded";

/**
 * The runtime's close barrier as these tests stand it up: pi's Harness seals its Session, joins its
 * scheduler and closes this storage, whose close runs the capture hook over the raw storage and then
 * closes the real database, failing when either failed.
 */
const closingAt = (
  storage: Storage,
  onClose: (context: Context) => Promise<void>,
): Storage =>
  new Proxy(storage, {
    get: (target, key) => {
      if (key === "close")
        return async (closeContext: Context) => {
          try {
            await onClose(closeContext);
          } finally {
            await target.close(closeContext);
          }
        };
      const field: unknown = Reflect.get(target, key, target);
      return typeof field === "function" ? field.bind(target) : field;
    },
  });

const lab = () => {
  const directory = mkdtempSync(join(parentDirectory, "test-"));
  const location = storeLocationIn(join(directory, "store"));
  const run = runIn(location);
  const readCapturedDump = (...args: Parameters<typeof readMarkedDump>) =>
    Effect.andThen(scanCaptures(location), readMarkedDump(...args));
  const datasets = join(directory, "datasets");
  mkdirSync(datasets);

  /** One claim of a review run: its journal session, route and harness, closed with a mode at the end. */
  const claim = async (runId: string, agent: string) => {
    const journal = openCaptureJournal(captureFolder(location, runId), runId);
    const routed = route(journal.capture, { runId, agent });
    const registry = createRegistry();
    registry.install(Lab);
    const raw = await openNodeSqliteStorage(piDatabase(location, runId));
    const hook = exportOnClose({ location, runId, journal });
    let mode: CloseMode = "interrupted";
    let receipt: CloseReceipt | undefined;
    const harness = await Harness.open(
      closingAt(raw, async (closeContext) => {
        receipt = value(
          await run(hook({ runId, mode, reads: raw, context: closeContext })),
        );
      }),
      { models: routed.models, registry, settings: SETTINGS },
      context,
    );
    return {
      journal,
      routed,
      harness,
      close: async (closeMode: CloseMode) => {
        mode = closeMode;
        await harness.close(context);
        return receipt!;
      },
    };
  };

  const kinds = (receipt: { readonly capture: string }) =>
    run(readCapturedDump(receipt.capture)).then((exit) =>
      value(exit).run.gaps.map((gap) => [gap.code, gap.kind]),
    );

  /** What the run resumes from: its database and its journal's bytes. */
  const resumable = (runId: string) => ({
    database: existsSync(piDatabase(location, runId)),
    journal: sha256Of(
      readFileSync(join(captureFolder(location, runId), "events.jsonl")),
    ),
  });

  return {
    directory,
    location,
    run,
    readCapturedDump,
    claim,
    kinds,
    datasets,
    resumable,
  };
};

test("a coding session with pi's CodingTools and a child is dumped straight to a folder, its bash spill archived whole", async () => {
  const { directory, run, datasets } = lab();
  const RUN = "coding-channel-1";
  const folder = join(directory, "coding-project-state", RUN);
  const journalFolder = join(folder, "capture");
  const database = join(folder, "pi.sqlite");
  const project = mkdtempSync(join(directory, "plain-project-"));
  const journal = openCaptureJournal(journalFolder, RUN, {
    spillRoots: [tmpdir()],
  });
  const scope = { runId: RUN };
  journal.capture({
    type: "run.start",
    scope,
    runKind: "coding",
    sourceRevision: {
      status: "not-applicable",
      reason: "the project is not a Git repository",
    },
    route: "chatgpt",
    pricing: "subscription",
  });
  const routed = route(journal.capture, scope);
  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(Lab);
  routed.faux.setResponses([
    routed.step(
      fauxAssistantMessage(
        fauxToolCall("bash", { command: "seq 1 30000" }, { id: "fc_bash" }),
        { stopReason: "toolUse", responseId: "k1" },
      ),
      usage(100, 20),
    ),
    routed.step(
      fauxAssistantMessage(
        fauxToolCall("delegate", { task: "look again" }, { id: "fc_child" }),
        { stopReason: "toolUse", responseId: "k2" },
      ),
      usage(200, 10),
    ),
    routed.step(
      fauxAssistantMessage("child looked", { responseId: "k3" }),
      usage(40, 5),
    ),
    routed.step(
      fauxAssistantMessage("counted", { responseId: "k4" }),
      usage(300, 6),
    ),
  ]);
  const harness = await Harness.open(
    await openNodeSqliteStorage(database),
    {
      models: routed.models,
      registry,
      env: () => new NodeExecutionEnv({ cwd: project }),
      settings: SETTINGS,
    },
    context,
  );
  const root = await harness.root(context, {
    agent: { model: MODEL, extensions: [CodingTools, Lab] },
  });
  journal.capture({
    type: "session.bind",
    scope: { ...scope, conversationId: root.id },
  });
  expect(
    (
      await (
        await root.submit({ type: "input", content: "count" }, context)
      ).wait(context)
    ).status,
  ).toBe("done");

  const entries = (await root.entries({}, 100, undefined, context)).items;
  const bash = entries.find(
    (entry: EntryRecord) =>
      entry.kind === "pi.tool-result" &&
      (entry.model?.[0] as { toolCallId: string }).toolCallId === "fc_bash",
  )!;
  const spill = fullOutputPath(
    (bash.data as { diagnostics: Array<{ code: string; message: string }> })
      .diagnostics,
  )!;
  const full = new Uint8Array(readFileSync(spill));
  const retained = (bash.model?.[0] as { content: Array<{ text: string }> })
    .content[0]!.text;
  expect(full.byteLength).toBe(
    Array.from({ length: 30000 }, (_, i) => `${i + 1}\n`).join("").length,
  );
  expect(retained.length).toBeLessThan(full.byteLength);
  await journal.ingest({
    scope: { ...scope, conversationId: root.id },
    name: "bash full output",
    mediaType: "text/plain",
    path: spill,
  });
  unlinkSync(spill);
  journal.close();
  await harness.close(context);

  const storage = await openNodeSqliteStorage(database);
  using authority = captureAuthority(folder);
  const exported = await exportSnapshot({
    credentialInspection: authority.inspection,
    runId: RUN,
    journal: journalFolder,
    native: { reads: storage, context },
    nativeDatabase: database,
    root: datasets,
    retention,
  }).finally(() => storage.close(context));
  expect(exported.directory).toBe(
    join(datasets, "restricted", "coding", RUN, exported.snapshotId),
  );
  const dump = value(await run(readSessionDump(exported.directory)));
  expect(dump.run).toMatchObject({
    runKind: "coding",
    sourceRevision: {
      status: "not-applicable",
      reason: "the project is not a Git repository",
    },
    execution: "open",
    complete: true,
    backup: { status: "captured", format: "sqlite" },
  });
  expect(dump.run.gaps.map((gap) => [gap.code, gap.kind])).toEqual([
    ["run-end-missing", "execution"],
  ]);
  const child = dump.sessions.find((s) => s.owner?.conversationId === root.id)!;
  expect(
    dump.sessions.map((s) => [s.conversationId, s.binding, s.turns.length]),
  ).toEqual([
    [root.id, {}, 3],
    [child.conversationId, { inheritedFrom: root.id }, 1],
  ]);
  expect(
    dump.sessions
      .flatMap((s) => s.calls)
      .map((call) => [call.scope, call.role, call.end?.responseId]),
  ).toEqual([
    [scope, "turn", "k1"],
    [scope, "turn", "k2"],
    [scope, "turn", "k4"],
    [scope, "turn", "k3"],
  ]);
  const [artifact] = dump.run.artifacts;
  expect(artifact).toMatchObject({
    name: "bash full output",
    sanitization: "sanitized",
    original: { sha256: sha256Of(full), size: full.byteLength },
  });
  expect(existsSync(spill)).toBe(false);
  expect(dump.artifacts.get(artifact!.file!)).toEqual(full);

  const again = await exportSnapshot({
    credentialInspection: authority.inspection,
    runId: RUN,
    journal: journalFolder,
    native: {
      reads: await openNodeSqliteStorage(database),
      context,
    },
    nativeDatabase: database,
    root: datasets,
    retention,
  });
  expect(again).toMatchObject({
    directory: exported.directory,
    snapshotId: exported.snapshotId,
    reused: true,
  });
  // Alone 0.23-0.38 s; 10x slowest, at least 30 s; SQLite and capture I/O under load.
}, 30_000);

test("a spill outside the tool-generated roots or through a link is refused, never read", async () => {
  const { directory } = lab();
  const roots = mkdtempSync(join(directory, "spill-root-"));
  const outside = join(directory, "outside.log");
  writeFileSync(outside, "secret\n");
  symlinkSync(outside, join(roots, "linked.log"));
  const refused = async (path: string) => {
    const journal = openCaptureJournal(
      mkdtempSync(join(directory, "spill-journal-")),
      "R",
      { spillRoots: [roots] },
    );
    return journal
      .ingest({
        scope: { runId: "R" },
        name: "x",
        mediaType: "text/plain",
        path,
      })
      .then(
        () => "kept",
        (error: { kind: string; detail: string }) => [error.kind, error.detail],
      );
  };
  expect(await refused(join(roots, "..", "outside.log"))).toEqual([
    "invalid",
    `x: ${join(roots, "..", "outside.log")} is outside the tool-generated roots`,
  ]);
  expect(await refused(join(roots, "linked.log"))).toEqual([
    "invalid",
    `x: ${join(roots, "linked.log")} goes through a link`,
  ]);
});

test("a held close, a reopen of the same run and its final close leave distinct snapshots that coexist", async () => {
  const { location, run, claim, readCapturedDump, kinds, datasets } = lab();
  const RUN = "01LIFECYCLEHELD00000000000";
  value(await run(ensureRunFolder(location, manifest(RUN))));
  const first = await claim(RUN, "understand");
  const scope = { runId: RUN };
  first.journal.capture({
    type: "run.start",
    scope,
    runKind: "scored",
    sourceRevision: "abc123",
    route: "chatgpt",
    pricing: "subscription",
  });
  const conversation = await first.harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent: { model: { provider: "openai-slow", modelId: "gpt-5.5" } },
    },
    context,
  );
  first.journal.capture({
    type: "session.bind",
    scope: {
      ...scope,
      stage: "understand",
      agent: "understand",
      conversationId: conversation.id,
    },
  });
  first.routed.slow.setResponses([
    first.routed.step(
      fauxAssistantMessage(fauxText("streaming words ".repeat(400)), {
        responseId: "h1",
      }),
      usage(50, 1600),
    ),
  ]);
  await conversation.submit({ type: "input", content: "understand" }, context);
  await Bun.sleep(900);
  const held = await first.close("held");
  expect(held).toMatchObject({
    runId: RUN,
    mode: "held",
    execution: "open",
    backup: { status: "captured" },
  });
  expect(held.snapshotId).toBe(held.capture);
  const heldDump = value(await run(readCapturedDump(held.capture)));
  const partial = heldDump.sessions[0]!.inFlight as {
    generation: {
      message: { responseId: string; content: Array<{ text: string }> };
    };
  };
  expect(partial.generation.message.responseId).toBe("h1");
  expect(
    partial.generation.message.content[0]!.text.startsWith("streaming words"),
  ).toBe(true);
  expect(await kinds(held)).toEqual([
    ["run-end-missing", "execution"],
    ["stage-end-missing", "execution"],
    ["work-in-flight", "execution"],
  ]);
  expect(held).toMatchObject({ complete: false, pendingScan: true });
  expect(
    heldDump.unjoined.map((call) => [call.role, call.response?.responseId]),
  ).toEqual([["in-flight", "h1"]]);

  const second = await claim(RUN, "understand");
  second.routed.slow.setResponses([
    second.routed.step(
      fauxAssistantMessage("understood", { responseId: "h2" }),
      usage(60, 5),
    ),
  ]);
  second.harness.resume();
  await (await second.harness.conversation(
    conversation.id,
    context,
  ))!.waitForIdle(context);
  second.journal.capture({
    type: "lead.fate",
    scope: { ...scope, stage: "investigate" },
    leadId: "L1",
    handoff: "investigate",
    fate: "dropped",
    reason: "fixture",
  });
  second.journal.capture({
    type: "stage.end",
    scope: { ...scope, stage: "understand" },
    status: "completed",
  });
  second.journal.capture({ type: "run.end", scope, status: "completed" });
  const ended = await second.close("ended");
  expect(ended.snapshotId).not.toBe(held.snapshotId);
  expect(ended).toMatchObject({
    execution: "ended",
    complete: false,
    pendingScan: true,
    gaps: [],
  });
  const final = value(await run(readCapturedDump(ended.capture)));
  expect(
    final.sessions[0]!.turns.map((turn) => [turn.responseId, turn.stopReason]),
  ).toEqual([
    ["h1", "aborted"],
    ["h2", "stop"],
  ]);
  expect(value(await run(readCapturedDump(held.capture))).run).toEqual(
    heldDump.run,
  );

  const filed = async (receipt: CloseReceipt) =>
    run(
      exportCapturedDump({
        capture: receipt.capture,
        root: datasets,
        retention,
      }),
    );
  const heldFolder = value(await filed(held));
  const endedFolder = value(await filed(ended));
  expect([heldFolder.directory, endedFolder.directory]).toEqual([
    join(datasets, "restricted", "scored", RUN, heldFolder.snapshotId),
    join(datasets, "restricted", "scored", RUN, endedFolder.snapshotId),
  ]);
  expect(value(await filed(held)).reused).toBe(true);
  const record = join(endedFolder.directory, "export.json");
  const filedRecord = readFileSync(record, "utf8");
  writeFileSync(record, filedRecord.replace("lifecycle fixture", "rewritten"));
  expect(failure(await filed(ended))).toMatchObject({
    _tag: "DumpRejected",
    reason: "the folder was filed with another source, retention or redaction",
  });
  writeFileSync(record, filedRecord);
  const runJson = final.manifest.files[0]!;
  const object = join(endedFolder.directory, "objects", runJson.sha256);
  const tampered = new Uint8Array(readFileSync(object)).fill(0x20);
  writeFileSync(object, tampered);
  expect(failure(await filed(ended))).toMatchObject({
    _tag: "DumpRejected",
    reason: `${runJson.name}: checksum mismatch`,
  });
  expect(new Uint8Array(readFileSync(object))).toEqual(tampered);

  expect(
    failure(
      await run(
        removeRunFolder(location, RUN, {
          receipt: { ...ended, runId: "other" },
        }),
      ),
    ),
  ).toMatchObject({ _tag: "ReceiptMismatch" });
  expect(existsSync(piDatabase(location, RUN))).toBe(true);
  const removed = value(
    await run(removeRunFolder(location, RUN, { receipt: ended })),
  );
  expect(removed).toMatchObject({ removed: true, captures: [ended.capture] });
  expect(Option.getOrThrow(removed.dump)).toBe(ended);
  expect(existsSync(runFolder(location, RUN))).toBe(false);
});

test("a native close that fails keeps the run folder and its database", async () => {
  const { location, run, claim } = lab();
  const RUN = "01LIFECYCLECLOSEFAIL000000";
  value(await run(ensureRunFolder(location, manifest(RUN))));
  const { journal, close } = await claim(RUN, "understand");
  journal.capture({
    type: "run.start",
    scope: { runId: RUN },
    runKind: "scored",
    sourceRevision: "abc123",
    route: "chatgpt",
    pricing: "subscription",
  });
  await close("interrupted");
  const refused = await run(
    removeRunFolder(location, RUN, {
      openNative: async (path) => {
        const storage = await openNodeSqliteStorage(path);
        return new Proxy(storage, {
          get: (target, key) =>
            key === "close"
              ? async (closeContext: Context) => {
                  await target.close(closeContext);
                  throw new Error("disk went away");
                }
              : Reflect.get(target, key, target),
        });
      },
    }),
  );
  expect(failure(refused)).toMatchObject({
    _tag: "NativeStorageFailed",
    reason: "disk went away",
  });
  expect(existsSync(piDatabase(location, RUN))).toBe(true);
});

/** Removal by a receipt never opens pi's database; this fails the test if it does. */
const unopened: OpenNativeStorage = async () => {
  throw new Error("removal reopened pi's database");
};

// R3: removal accepted any receipt of the run, so a held close's, an ended close's of a run with no
// run.end, or one from before a reopen deleted the database the next claim resumes from.
test("a held, open, forged or stale receipt never removes the folder a run resumes from; the final ended receipt does without reopening pi", async () => {
  const { location, run, claim, readCapturedDump, resumable } = lab();
  const RUN = "01LIFECYCLERECEIPTS0000000";
  value(await run(ensureRunFolder(location, manifest(RUN))));
  const scope = { runId: RUN };
  const refused = async (receipt: CloseReceipt) => {
    const before = resumable(RUN);
    const exit = await run(
      removeRunFolder(location, RUN, { receipt, openNative: unopened }),
    );
    expect(resumable(RUN)).toEqual(before);
    return failure(exit);
  };
  const answer = async (
    claimed: Awaited<ReturnType<typeof claim>>,
    conversationId: ConversationId,
    responseId: string,
  ) => {
    claimed.routed.faux.setResponses([
      claimed.routed.step(
        fauxAssistantMessage(`answer ${responseId}`, { responseId }),
        usage(10, 2),
      ),
    ]);
    const handle = await claimed.harness.conversation(conversationId, context);
    await (
      await handle!.submit({ type: "input", content: responseId }, context)
    ).wait(context);
  };

  const first = await claim(RUN, "understand");
  first.journal.capture({
    type: "run.start",
    scope,
    runKind: "scored",
    sourceRevision: "abc123",
    route: "chatgpt",
    pricing: "subscription",
  });
  const conversation = await first.harness.createConversation(
    { ownership: { kind: "ownerless" }, agent: { model: MODEL } },
    context,
  );
  first.journal.capture({
    type: "session.bind",
    scope: {
      ...scope,
      stage: "understand",
      agent: "understand",
      conversationId: conversation.id,
    },
  });
  await answer(first, conversation.id, "a1");
  const held = await first.close("held");
  expect(await refused(held)).toMatchObject({
    _tag: "ReceiptMismatch",
    reason: "the receipt is a held close's",
  });
  expect(await refused({ ...held, mode: "ended" })).toMatchObject({
    _tag: "ReceiptMismatch",
    reason: `capture ${held.capture} was taken at a held close`,
  });

  const second = await claim(RUN, "understand");
  await answer(second, conversation.id, "a2");
  const open = await second.close("ended");
  expect(open).toMatchObject({ mode: "ended", execution: "open" });
  expect(await refused(open)).toMatchObject({
    _tag: "ReceiptMismatch",
    reason: `capture ${open.capture} has no run.end: the run's execution is open`,
  });
  expect(await refused({ ...held, mode: "ended" })).toMatchObject({
    _tag: "ReceiptMismatch",
  });

  const third = await claim(RUN, "understand");
  await answer(third, conversation.id, "a3");
  third.journal.capture({
    type: "lead.fate",
    scope: { ...scope, stage: "investigate" },
    leadId: "L1",
    handoff: "investigate",
    fate: "dropped",
  });
  third.journal.capture({
    type: "stage.end",
    scope: { ...scope, stage: "understand" },
    status: "completed",
  });
  third.journal.capture({ type: "run.end", scope, status: "completed" });
  const ended = await third.close("ended");
  expect(ended).toMatchObject({
    execution: "ended",
    complete: false,
    pendingScan: true,
  });

  const fourth = await claim(RUN, "understand");
  expect(await refused(ended)).toMatchObject({
    _tag: "ReceiptMismatch",
    reason: `the run's capture journal changed after capture ${ended.capture}`,
  });
  await answer(fourth, conversation.id, "a4");
  const final = await fourth.close("ended");
  expect(
    value(
      await run(
        removeRunFolder(location, RUN, {
          receipt: final,
          openNative: unopened,
        }),
      ),
    ),
  ).toMatchObject({ removed: true, captures: [final.capture] });
  expect(existsSync(runFolder(location, RUN))).toBe(false);

  value(await run(scanCaptures(location)));
  const snapshots = await Promise.all(
    [held, open, ended, final].map(async (receipt) => {
      const dump = value(await run(readCapturedDump(receipt.capture)));
      return [
        dump.run.close,
        dump.run.execution,
        dump.sessions[0]!.turns.map((turn) => turn.responseId),
      ];
    }),
  );
  expect(snapshots).toEqual([
    ["held", "open", ["a1"]],
    ["ended", "open", ["a1", "a2"]],
    ["ended", "ended", ["a1", "a2", "a3"]],
    ["ended", "ended", ["a1", "a2", "a3", "a4"]],
  ]);
  // Alone 2.17-3.58 s, 6.16 s in its file, and 2 of 5 runs over 5 s at load 26; 10x slowest seen; SQLite and capture I/O under load.
}, 65_000);

// D1 follow-on: removal stored a capture without reading it back, so a capture Records cannot
// return whole still let the folder, pi's only exact state, be deleted.
test("a capture Records cannot read back whole never removes the folder, by receipt or by the removal's own capture", async () => {
  const { location, run, claim } = lab();
  const RUN = "01LIFECYCLEREADBACK0000000";
  value(await run(ensureRunFolder(location, manifest(RUN))));
  const { journal, close } = await claim(RUN, "understand");
  const scope = { runId: RUN };
  journal.capture({
    type: "run.start",
    scope,
    runKind: "coding",
    sourceRevision: { status: "not-applicable", reason: "fixture" },
    route: "chatgpt",
    pricing: "subscription",
  });
  // Over Records' inline limit, so its bytes are a file of their own in the blob store.
  const output = new TextEncoder().encode("line of output\n".repeat(20_000));
  journal.capture({
    type: "artifact",
    scope,
    name: "output.log",
    mediaType: "text/plain",
    bytes: output,
  });
  journal.capture({ type: "run.end", scope, status: "completed" });
  const ended = await close("ended");
  const hash = sha256Of(output);
  const blob = join(location.blobs, "sha256", hash.slice(0, 2), hash.slice(2));
  writeFileSync(blob, new Uint8Array(output.byteLength).fill(0x20));
  const corrupt = /^stored bytes \(300000\) do not hash to the blob's name$/;
  expect(
    failure(
      await run(
        removeRunFolder(location, RUN, {
          receipt: ended,
          openNative: unopened,
        }),
      ),
    ),
  ).toMatchObject({
    _tag: "BlobCorrupt",
    message: expect.stringMatching(corrupt),
  });
  expect(existsSync(piDatabase(location, RUN))).toBe(true);
  expect(failure(await run(removeRunFolder(location, RUN)))).toMatchObject({
    _tag: "BlobCorrupt",
    message: expect.stringMatching(corrupt),
  });
  expect(existsSync(piDatabase(location, RUN))).toBe(true);

  writeFileSync(blob, output);
  expect(
    value(
      await run(
        removeRunFolder(location, RUN, {
          receipt: ended,
          openNative: unopened,
        }),
      ),
    ),
  ).toMatchObject({ removed: true });
  expect(existsSync(runFolder(location, RUN))).toBe(false);
});

const OPAQUE = "synthetic-opaque-signature-ann@example.com";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xfe, 0xff]);

test("the restricted capture keeps continuation and pi's exact state, restored without a model; the portable copy withholds as it declares", async () => {
  const { directory, location, run, claim, kinds, readCapturedDump, datasets } =
    lab();
  const RUN = "01LIFECYCLERESTRICTED00000";
  value(await run(ensureRunFolder(location, manifest(RUN))));
  const { journal, routed, harness, close } = await claim(RUN, "investigate");
  const scope = { runId: RUN };
  routed.body["reasoning"] = { effort: "high", summary: "auto" };
  journal.capture({
    type: "run.start",
    scope,
    runKind: "reading",
    sourceRevision: "abc123",
    route: "chatgpt",
    pricing: "subscription",
  });
  routed.faux.setResponses([
    routed.step(
      fauxAssistantMessage(
        [
          { ...fauxThinking("synthetic plan"), thinkingSignature: OPAQUE },
          fauxText("answer for ann@example.com"),
        ],
        { responseId: "x1" },
      ),
      usage(10, 4),
    ),
  ]);
  const conversation = await harness.createConversation(
    { ownership: { kind: "ownerless" }, agent: { model: MODEL } },
    context,
  );
  const stray = await harness.createConversation(
    { ownership: { kind: "ownerless" }, agent: { model: MODEL } },
    context,
  );
  journal.capture({
    type: "session.bind",
    scope: {
      ...scope,
      stage: "investigate",
      agent: "investigate.p1",
      conversationId: conversation.id,
    },
  });
  journal.capture({
    type: "session.bind",
    scope: { ...scope, conversationId: stray.id },
  });
  await (
    await conversation.submit({ type: "input", content: "look" }, context)
  ).wait(context);
  const artifact = (name: string, mediaType: string, bytes: Uint8Array) =>
    journal.capture({ type: "artifact", scope, name, mediaType, bytes });
  const text = new TextEncoder().encode("by ann@example.com\n");
  const json = new TextEncoder().encode(
    '{"by":"ann@example.com","token":"t-1"}',
  );
  artifact("notes.txt", "text/plain", text);
  artifact("result.json", "application/json", json);
  artifact("shot.png", "image/png", PNG);
  journal.capture({
    type: "lead.fate",
    scope: { ...scope, stage: "investigate" },
    leadId: "L1",
    handoff: "investigate",
    fate: "dropped",
  });
  journal.capture({
    type: "stage.end",
    scope: { ...scope, stage: "investigate" },
    status: "completed",
  });
  journal.capture({ type: "run.end", scope, status: "completed" });
  const receipt = await close("ended");
  expect(receipt).toMatchObject({ execution: "ended", complete: false });
  expect(await kinds(receipt)).toEqual([["session-unattributed", "capture"]]);

  const restricted = value(await run(readCapturedDump(receipt.capture)));
  const assistant = (entries: ReadonlyArray<unknown>) =>
    (
      entries as Array<{
        kind: string;
        model: Array<{ content: Array<Record<string, unknown>> }>;
      }>
    ).find((entry) => entry.kind === "pi.assistant")!.model[0]!.content;
  const session = restricted.sessions.find(
    (s) => s.conversationId === conversation.id,
  )!;
  const thinking = assistant(session.entries)[0]!;
  expect(thinking["thinkingSignature"]).toBe(OPAQUE);
  expect(thinking["thinking"]).toBe("synthetic plan");
  expect(assistant(session.entries)[1]!["text"]).toBe("answer for <email>");
  const body = session.calls[0]!.body;
  expect(
    body.status === "sent" && (body.json as { input: Array<unknown> }).input[0],
  ).toEqual({ type: "reasoning", encrypted_content: ENCRYPTED, summary: [] });
  expect(
    restricted.run.artifacts.map((a) => [
      a.name,
      a.sanitization,
      a.sha256,
      a.original.sha256,
      a.original.file !== null,
    ]),
  ).toEqual([
    [
      "notes.txt",
      "sanitized",
      sha256Of(new TextEncoder().encode("by <email>\n")),
      sha256Of(text),
      true,
    ],
    [
      "result.json",
      "sanitized",
      sha256Of(new TextEncoder().encode('{"by":"<email>","token":"<masked>"}')),
      sha256Of(json),
      true,
    ],
    ["shot.png", "raw-uninspected", sha256Of(PNG), sha256Of(PNG), true],
  ]);

  const backup = restricted.run.backup;
  if (backup.status !== "captured") throw new Error("no native backup");
  const isolated = join(mkdtempSync(join(directory, "restore-")), "pi.sqlite");
  const restoredBytes = (
    await run(
      exportCapturedDump({
        capture: receipt.capture,
        root: datasets,
        retention,
      }),
    ).then(value)
  ).directory;
  writeFileSync(
    isolated,
    readFileSync(join(restoredBytes, "objects", backup.sha256)),
  );
  expect(sha256Of(readFileSync(isolated))).toBe(backup.sha256);
  const offline = route(() => {
    throw new Error("a restored backup never calls a model");
  }, scope);
  const reopened = await Harness.open(
    await openNodeSqliteStorage(isolated),
    { models: offline.models, registry: createRegistry(), settings: SETTINGS },
    context,
  );
  const restoredEntries = (
    await (await reopened.conversation(conversation.id, context))!.entries(
      {},
      100,
      undefined,
      context,
    )
  ).items;
  const restoredThinking = (
    restoredEntries.find((entry) => entry.kind === "pi.assistant")!
      .model![0] as unknown as { content: Array<Record<string, unknown>> }
  ).content[0]!;
  expect(restoredThinking["thinkingSignature"]).toBe(OPAQUE);
  await reopened.close(context);
  expect(offline.faux.state.callCount).toBe(0);

  const portable = value(
    await run(
      exportCapturedDump({
        capture: receipt.capture,
        root: datasets,
        retention,
        redaction: "portable",
      }),
    ),
  );
  expect(portable.directory).toBe(
    join(datasets, "portable", "reading", RUN, portable.snapshotId),
  );
  const copy = value(await run(readSessionDump(portable.directory)));
  expect(copy.record.redaction).toEqual({
    mode: "portable",
    inspectionOnly: true,
    withheld: [
      "encrypted-continuation",
      "reasoning-summaries",
      "native-backup",
      "raw-journal",
      "projection-recipe",
      "original-artifacts",
      "raw-artifacts",
    ],
    restrictedFiles: restricted.manifest.files,
  });
  expect(copy.run.backup.status).toBe("withheld");
  expect(copy.unverifiableOriginals).toEqual([
    "notes.txt",
    "result.json",
    "shot.png",
  ]);
  expect(copy.run.artifacts.map((a) => [a.name, a.file !== null])).toEqual([
    ["notes.txt", true],
    ["result.json", true],
    ["shot.png", false],
  ]);
  const portableText = [...copy.manifest.files]
    .map((file) =>
      new TextDecoder().decode(
        readFileSync(join(portable.directory, "objects", file.sha256)),
      ),
    )
    .join("\n");
  for (const kept of [OPAQUE, ENCRYPTED, "synthetic plan", "example.com"])
    expect(portableText.includes(kept)).toBe(false);
  expect(portableText).toContain("<withheld: encrypted reasoning, ");
  expect(portableText).toContain("<withheld: reasoning summary, ");

  const folderPortable = await exportPortableSnapshot({
    directory: restoredBytes,
    root: datasets,
    retention,
  });
  expect(folderPortable).toMatchObject({
    directory: portable.directory,
    reused: true,
  });
  expect(value(await run(readCapturedDump(receipt.capture))).manifest).toEqual(
    restricted.manifest,
  );
});
