import { captureAuthority } from "./fixture.ts";
// Direct caption/recap calls never enter pi's transcript or model ledger. Exercise the public
// route factory, actual HTTP streaming, native SQLite, immutable snapshots and parsed readers.
import { afterAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SOL_ROUTE } from "../../../src/route.ts";
import { createRouteModels } from "../../../src/pi/providers/agent-route-provider.ts";
import { CapturedEvent } from "../../../src/pi/capture/types.ts";
import { readDump } from "../../../src/pi/capture/archive.ts";
import { buildDump } from "../../../src/pi/capture/build.ts";
import {
  openCaptureJournal,
  readCaptureJournal,
} from "../../../src/pi/capture/journal.ts";
import {
  exportPortableSnapshot,
  exportSnapshot,
  readSessionDump,
} from "../../../src/pi/capture/export.ts";
import {
  created,
  completed,
  messageItem,
  openEndpoint,
  sse,
  tokenCommand,
} from "../providers/fixture.ts";

const directory = mkdtempSync(join(tmpdir(), "coding-auxiliary-"));
mkdirSync(join(directory, "datasets"));
mkdirSync(join(directory, "portable"));
const endpoint = openEndpoint();
afterAll(() => {
  endpoint.stop();
  if (process.env["NEUVE_AUX_CAPTURE_KEEP"] === "1")
    console.log(`Synthetic auxiliary capture evidence: ${directory}`);
  else rmSync(directory, { recursive: true, force: true });
});
const context = BACKGROUND_CONTEXT;
const settings = { retry: { enabled: false }, compaction: { enabled: false } };
const answer = (id: string, wait = 0) =>
  sse([
    created(id),
    wait,
    ...messageItem(0, `msg-${id}`, "final_answer", `answer ${id}`),
    completed(id),
  ]);

test("native turn plus concurrent captions and recaps are counted once across close and reopen", async () => {
  const runId = "coding-auxiliary";
  const source = join(directory, "channel");
  const journalFolder = join(source, "capture");
  const database = join(source, "pi.sqlite");
  const token = tokenCommand(directory, "synthetic-lease");
  let journal = openCaptureJournal(journalFolder, runId);
  using authority = captureAuthority(source);
  journal.capture({
    type: "run.start",
    scope: { runId },
    runKind: "coding",
    sourceRevision: "abc123",
    route: "chatgpt",
    pricing: "subscription",
  });
  const options = {
    credentialInspection: authority.inspection,
    route: SOL_ROUTE,
    runId,
    sessionAffinity: runId,
    auth: { tokenCommand: token.path },
    fetch: endpoint.fetch,
    capture: journal.capture,
  };
  let raw = await openNodeSqliteStorage(database);
  let harness = await Harness.open(
    raw,
    {
      models: createRouteModels(options),
      registry: createRegistry(),
      settings,
    },
    context,
  );
  const conversation = await harness.root(context, {
    agent: { model: { provider: "openai", modelId: SOL_ROUTE.model } },
  });
  journal.capture({
    type: "session.bind",
    scope: { runId, conversationId: conversation.id },
  });
  endpoint.respond(() => answer("turn-1"));
  expect(
    (
      await (
        await conversation.submit({ type: "input", content: "work" }, context)
      ).wait(context)
    ).status,
  ).toBe("done");
  const direct = (purpose: "caption" | "recap") => {
    const models = createRouteModels({
      ...options,
      capture: journal.capture,
      purpose,
      conversationId: conversation.id,
    });
    const model = models.getModel("openai", SOL_ROUTE.model)!;
    return models.complete(model, {
      messages: [{ role: "user", content: purpose, timestamp: 1 }],
    });
  };
  endpoint.respond(
    () => answer("caption-1", 30),
    () => answer("recap-1"),
  );
  expect(
    (await Promise.all([direct("caption"), direct("recap")])).map(
      (message) => message.stopReason,
    ),
  ).toEqual(["stop", "stop"]);
  journal.close();
  await harness.close(context);
  const snapshot = async () => {
    const storage = await openNodeSqliteStorage(database);
    try {
      return await exportSnapshot({
        credentialInspection: authority.inspection,
        runId,
        journal: journalFolder,
        native: { reads: storage, context },
        nativeDatabase: database,
        root: join(directory, "datasets"),
        retention: { policy: "test" },
        close: "interrupted",
      });
    } finally {
      await storage.close(context);
    }
  };
  const first = await snapshot();
  const firstBytes = (await readDump(first.directory)).files.get(
    `sessions/${conversation.id}.json`,
  );
  const read = (path: string) => Effect.runPromise(readSessionDump(path));
  const firstDump = await read(first.directory);
  const session = firstDump.sessions[0]!;
  expect(firstDump.run.complete).toBe(true);
  expect(firstDump.unjoined).toEqual([]);
  expect(session.turns).toHaveLength(1);
  expect(
    session.calls.map((call) => [call.role, call.purpose ?? null]),
  ).toEqual([
    ["turn", null],
    ["non-turn", "caption"],
    ["non-turn", "recap"],
  ]);
  expect(
    session.calls
      .slice(1)
      .every((call) => call.scope.conversationId === conversation.id),
  ).toBe(true);
  expect(session.totals.ledger?.tokens.totalTokens).toBe(15);
  expect(session.totals.auxiliary?.tokens.totalTokens).toBe(30);
  expect(firstDump.run.totals.tokens.totalTokens).toBe(45);
  const nativeUsage = session.documents.find((doc) => doc.kind === "pi.usage")!;
  expect(nativeUsage.value).toMatchObject({
    models: { [`openai/${SOL_ROUTE.model}`]: { totalTokens: 15 } },
    tools: {},
  });
  expect(new Set(session.calls.map((call) => call.callId)).size).toBe(3);
  expect(
    session.calls
      .slice(1)
      .every(
        (call) =>
          call.body.status === "sent" &&
          call.events.length > 0 &&
          call.response?.responseId === call.end?.responseId &&
          call.end?.usage?.totalTokens === 15,
      ),
  ).toBe(true);

  journal = openCaptureJournal(journalFolder, runId);
  raw = await openNodeSqliteStorage(database);
  harness = await Harness.open(
    raw,
    {
      models: createRouteModels({
        ...options,
        capture: journal.capture,
      }),
      registry: createRegistry(),
      settings,
    },
    context,
  );
  endpoint.respond(
    () =>
      new Response(
        JSON.stringify({
          error: {
            code: "server_error",
            message: "synthetic upstream failure",
          },
        }),
        { status: 500, headers: { "content-type": "application/json" } },
      ),
  );
  expect((await direct("caption")).stopReason).toBe("error");
  journal.close();
  await harness.close(context);
  const second = await snapshot();
  expect(second.snapshotId).not.toBe(first.snapshotId);
  expect(
    (await readDump(first.directory)).files.get(
      `sessions/${conversation.id}.json`,
    ),
  ).toEqual(firstBytes);
  const secondDump = await read(second.directory);
  expect(secondDump.run.complete).toBe(false);
  expect(secondDump.run.gaps).toContainEqual({
    code: "auxiliary-usage-missing",
    kind: "capture",
    count: 1,
    detail:
      "settled auxiliary calls without final usage; their token totals are unknown",
  });
  expect(secondDump.unjoined).toEqual([]);
  expect(secondDump.sessions[0]!.calls).toHaveLength(4);
  expect(secondDump.sessions[0]!.calls.at(-1)).toMatchObject({
    purpose: "caption",
    role: "non-turn",
    end: { outcome: "failed" },
  });
  expect(secondDump.run.totals.tokens.totalTokens).toBe(45);
  expect(secondDump.sessions[0]!.totals.ledger?.tokens.totalTokens).toBe(15);
  const portable = await exportPortableSnapshot({
    directory: second.directory,
    root: join(directory, "portable"),
    retention: { policy: "test" },
  });
  expect(
    (await read(portable.directory)).sessions[0]!.calls.map(
      (call) => call.purpose,
    ),
  ).toEqual([undefined, "caption", "recap", "caption"]);

  // A process dying after its request leaves the captured partial honest and its usage unknown.
  journal = openCaptureJournal(journalFolder, runId);
  journal.capture({
    type: "model.request",
    scope: { runId, conversationId: conversation.id },
    callId: "crashed-aux",
    purpose: "recap",
    route: "openai",
    provider: "openai",
    model: SOL_ROUTE.model,
    credentialCoverage: "none",
    headerNames: [],
    body: { status: "sent", json: {} },
  });
  journal.close();
  const partial = await snapshot();
  const partialDump = await read(partial.directory);
  expect(partialDump.run.complete).toBe(false);
  expect(partialDump.run.gaps.map((gap) => gap.code)).toContain(
    "calls-unended",
  );
  expect(partialDump.run.gaps.map((gap) => gap.code)).not.toContain(
    "ledger-unreconciled",
  );
  expect(partialDump.sessions[0]!.calls.at(-1)).toMatchObject({
    purpose: "recap",
    role: "non-turn",
    end: null,
  });
  expect(partialDump.run.totals.tokens.totalTokens).toBe(45);

  journal = openCaptureJournal(journalFolder, runId);
  journal.capture({
    type: "model.request",
    scope: { runId, conversationId: 99999 },
    callId: "wrong-session",
    purpose: "caption",
    route: "openai",
    provider: "openai",
    model: SOL_ROUTE.model,
    credentialCoverage: "none",
    headerNames: [],
    body: { status: "sent", json: {} },
  });
  journal.close();
  raw = await openNodeSqliteStorage(database);
  try {
    await expect(
      buildDump({
        credentialInspection: authority.inspection,
        runId,
        journal: journalFolder,
        native: { reads: raw, context },
        nativeDatabase: database,
      }),
    ).rejects.toThrow("names no native conversation");
  } finally {
    await raw.close(context);
  }
}, 120_000);

test("an unresolved signal-aborted recap refuses export and preserves its source and prior snapshot", async () => {
  const root = join(directory, "signal-abort");
  mkdirSync(root);
  const runId = "auxiliary-abort";
  const database = join(root, "pi.sqlite");
  const journalFolder = join(root, "capture");
  const datasets = join(root, "datasets");
  mkdirSync(datasets);
  let journal = openCaptureJournal(journalFolder, runId);
  using authority = captureAuthority(root);
  journal.capture({
    type: "run.start",
    scope: { runId },
    runKind: "coding",
    sourceRevision: "synthetic-abort",
    route: "chatgpt",
    pricing: "subscription",
  });
  const token = tokenCommand(root, "synthetic-lease");
  const options = {
    credentialInspection: authority.inspection,
    route: SOL_ROUTE,
    runId,
    sessionAffinity: runId,
    auth: { tokenCommand: token.path },
    fetch: endpoint.fetch,
    capture: journal.capture,
  };
  const harness = await Harness.open(
    await openNodeSqliteStorage(database),
    {
      models: createRouteModels(options),
      registry: createRegistry(),
      settings,
    },
    context,
  );
  const conversation = await harness.root(context, {
    agent: { model: { provider: "openai", modelId: SOL_ROUTE.model } },
  });
  journal.capture({
    type: "session.bind",
    scope: { runId, conversationId: conversation.id },
  });
  endpoint.respond(() => answer("before-abort"));
  expect(
    (
      await (
        await conversation.submit({ type: "input", content: "work" }, context)
      ).wait(context)
    ).status,
  ).toBe("done");
  await harness.close(context);
  journal.close();
  const snapshot = async () => {
    const storage = await openNodeSqliteStorage(database);
    try {
      return await exportSnapshot({
        credentialInspection: authority.inspection,
        runId,
        journal: journalFolder,
        native: { reads: storage, context },
        nativeDatabase: database,
        root: datasets,
        retention: { policy: "test" },
        close: "interrupted",
      });
    } finally {
      await storage.close(context);
    }
  };
  const first = await snapshot();
  const firstDump = await readDump(first.directory);
  journal = openCaptureJournal(journalFolder, runId);
  const abort = new AbortController();
  const seen = Promise.withResolvers<void>();
  endpoint.respond(() => {
    seen.resolve();
    return sse(
      [
        created("partial-recap"),
        ...messageItem(0, "partial-message", "final_answer", "partial"),
      ],
      { hold: true },
    );
  });
  const models = createRouteModels({
    ...options,
    capture: journal.capture,
    purpose: "recap",
    conversationId: conversation.id,
  });
  const pending = models.complete(
    models.getModel("openai", SOL_ROUTE.model)!,
    { messages: [{ role: "user", content: "recap", timestamp: 1 }] },
    { signal: abort.signal },
  );
  await seen.promise;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      readFileSync(join(journalFolder, "events.jsonl"), "utf8").includes(
        '"responseId":"partial-recap"',
      )
    )
      break;
    await Bun.sleep(5);
  }
  abort.abort();
  expect((await pending).stopReason).toBe("aborted");
  journal.close();
  const sourceBytes = readFileSync(database);
  const journalBytes = readFileSync(join(journalFolder, "events.jsonl"));
  const snapshots = readdirSync(datasets, { recursive: true });
  await expect(snapshot()).rejects.toThrow("retained-stream-prefix");
  expect(readFileSync(database)).toEqual(sourceBytes);
  expect(readFileSync(join(journalFolder, "events.jsonl"))).toEqual(
    journalBytes,
  );
  expect(readdirSync(datasets, { recursive: true })).toEqual(snapshots);
  expect((await readDump(first.directory)).files).toEqual(firstDump.files);
  expect(
    (await Effect.runPromise(readSessionDump(first.directory))).run.complete,
  ).toBe(true);
  const retained = readCaptureJournal(journalFolder);
  expect(retained._tag).toBe("Read");
  if (retained._tag !== "Read") throw new Error("aborted journal unreadable");
  expect(retained.lines.map((line) => line.event)).toContainEqual(
    expect.objectContaining({
      type: "model.end",
      outcome: "aborted",
      responseId: "partial-recap",
    }),
  );
});

test("an auxiliary request cannot omit its real conversation or invent a purpose", () => {
  const request = {
    type: "model.request",
    scope: { runId: "run" },
    callId: "call",
    route: "openai",
    provider: "openai",
    model: SOL_ROUTE.model,
    credentialCoverage: "none",
    headerNames: [],
    body: { status: "sent", json: {} },
  };
  expect(
    CapturedEvent.safeParse({ ...request, purpose: "caption" }).success,
  ).toBe(false);
  expect(
    CapturedEvent.safeParse({
      ...request,
      scope: { runId: "run", conversationId: 1 },
      purpose: "summary",
    }).success,
  ).toBe(false);
});

test("the public auxiliary factory rejects missing conversation identity before model dispatch", () => {
  const base = {
    credentialInspection: "ephemeral" as const,
    route: SOL_ROUTE,
    runId: "run",
    sessionAffinity: "session",
    capture: () => {},
  };
  expect(() => {
    // @ts-expect-error A JavaScript caller can omit the required identity.
    createRouteModels({ ...base, purpose: "caption" });
  }).toThrow();
  expect(() => {
    // @ts-expect-error A JavaScript caller can supply an unsupported purpose.
    createRouteModels({ ...base, purpose: "summary", conversationId: 1 });
  }).toThrow();
});
