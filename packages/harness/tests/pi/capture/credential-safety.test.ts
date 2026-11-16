// Why: a safe event copy does not certify pi's exact native assistant, live state or backup.
// Exercise local authenticated SSE, real SQLite and public export refusal without changing replies.
import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SOL_ROUTE } from "../../../src/route.ts";
import { createRouteModels } from "../../../src/coding.ts";
import { DumpFailed } from "../../../src/pi/capture/build.ts";
import { exportSnapshot } from "../../../src/session-dump.ts";
import { openCaptureJournal } from "../../../src/pi/capture/journal.ts";
import {
  completed,
  created,
  functionCallItem,
  messageItem,
  openEndpoint,
  sse,
  tokenCommand,
} from "../providers/fixture.ts";

const directory = mkdtempSync(join(tmpdir(), "native-credential-safety-"));
const endpoint = openEndpoint();
afterAll(() => {
  endpoint.stop();
  if (process.env["NEUVE_CAPTURE_INTEGRITY_KEEP"] === "1")
    console.log(`Synthetic capture integrity evidence: ${directory}`);
  else rmSync(directory, { recursive: true, force: true });
});
const settings = { retry: { enabled: false }, compaction: { enabled: false } };

for (const variant of [
  "success",
  "split",
  "encoded",
  "partial",
  "tool",
  "auxiliary",
  "tool-result",
  "artifact",
  "artifact-utf16le",
  "artifact-utf16be",
  "json-utf16le",
  "spill-utf16be",
  "spill",
  "backup-only",
] as const) {
  // The limit ends a hang only: these cases write and scan real stores, slowly on a busy disk.
  test(`${variant} active credential echo keeps exact native data and refuses export after reopen`, async () => {
    const root = join(directory, variant);
    mkdirSync(root);
    mkdirSync(join(root, "datasets"));
    const token = tokenCommand(root, "lease");
    const database = join(root, "pi.sqlite");
    const journalPath = join(root, "journal");
    const journal = openCaptureJournal(journalPath, variant, {
      spillRoots: [root],
    });
    journal.capture({
      type: "run.start",
      scope: { runId: variant },
      runKind: "coding",
      sourceRevision: "synthetic",
      route: "chatgpt",
      pricing: "subscription",
    });
    const options = {
      credentialInspection: "ephemeral" as const,
      route: SOL_ROUTE,
      runId: variant,
      sessionAffinity: variant,
      auth: { tokenCommand: token.path },
      fetch: endpoint.fetch,
      capture: journal.capture,
    };
    const models = createRouteModels(options);
    const raw = await openNodeSqliteStorage(database);
    const harness = await Harness.open(
      raw,
      { models, registry: createRegistry(), settings },
      context,
    );
    const conversation = await harness.root(context, {
      agent: { model: { provider: "openai", modelId: SOL_ROUTE.model } },
    });
    journal.capture({
      type: "session.bind",
      scope: { runId: variant, conversationId: conversation.id },
    });
    let active = "";
    let expected = "";
    endpoint.respond((request) => {
      active = request.headers.get("authorization")!.replace(/^Bearer /, "");
      expected =
        variant === "encoded"
          ? JSON.stringify({ value: active }).replace("t", "\\u0074")
          : active;
      if (
        [
          "auxiliary",
          "tool-result",
          "artifact",
          "artifact-utf16le",
          "artifact-utf16be",
          "json-utf16le",
          "spill-utf16be",
          "spill",
          "backup-only",
        ].includes(variant)
      )
        return sse([
          created("native"),
          ...messageItem(0, "native", "final_answer", "safe native answer"),
          completed("native"),
        ]);
      if (variant === "tool")
        return sse([
          created(variant),
          ...functionCallItem(0, {
            id: "item",
            callId: "tool-call",
            name: "missing",
            arguments: JSON.stringify({ text: active }),
          }),
          completed(variant),
        ]);
      if (variant === "split" || variant === "partial") {
        const frames = messageItem(0, "message", "final_answer", active);
        return sse([
          created(variant),
          frames[0]!,
          { ...frames[1]!, delta: active.slice(0, 2) },
          { ...frames[1]!, delta: active.slice(2) },
          ...(variant === "split" ? [completed(variant)] : []),
        ]);
      }
      return sse([
        created(variant),
        ...messageItem(0, "message", "final_answer", expected),
        completed(variant),
      ]);
    });
    if (variant === "tool")
      endpoint.respond(() =>
        sse([
          created("after-tool"),
          ...messageItem(0, "after-tool", "final_answer", "done"),
          completed("after-tool"),
        ]),
      );
    await (
      await conversation.submit(
        { type: "input", content: "synthetic local probe" },
        context,
      )
    ).wait(context);
    if (variant === "tool-result") {
      await conversation.commit(
        (tx) =>
          tx.appendEntry(conversation.id, {
            kind: "pi.tool-result",
            data: {},
            model: [
              {
                role: "toolResult",
                toolCallId: "standalone-tool",
                toolName: "local",
                content: [{ type: "text", text: active }],
                isError: false,
                timestamp: Date.now(),
              },
            ],
          }),
        context,
      );
    } else if (
      [
        "artifact-utf16le",
        "artifact-utf16be",
        "json-utf16le",
        "spill-utf16be",
      ].includes(variant)
    ) {
      const be = variant.endsWith("be");
      const bytes = Buffer.from(
        variant.startsWith("json") ? JSON.stringify({ value: active }) : active,
        "utf16le",
      );
      if (be) bytes.swap16();
      const mediaType = `${variant.startsWith("json") ? "application/json" : "text/plain"}; charset="${be ? "UTF-16BE" : "UTF-16LE"}"`;
      if (variant.startsWith("spill")) {
        const path = join(root, "encoded-spill.txt");
        writeFileSync(path, bytes);
        await journal.ingest({
          scope: { runId: variant },
          name: "encoded-spill.txt",
          mediaType,
          path,
        });
      } else
        journal.capture({
          type: "artifact",
          scope: { runId: variant },
          name: "encoded.txt",
          mediaType,
          bytes,
        });
    } else if (variant === "artifact") {
      journal.capture({
        type: "artifact",
        scope: { runId: variant },
        name: "output.txt",
        mediaType: "text/plain",
        bytes: new TextEncoder().encode(active),
      });
    } else if (variant === "spill") {
      const path = join(root, "spill.txt");
      writeFileSync(path, active);
      await journal.ingest({
        scope: { runId: variant },
        name: "spill.txt",
        mediaType: "text/plain",
        path,
      });
    }
    if (variant === "auxiliary") {
      endpoint.respond((request) => {
        active = request.headers.get("authorization")!.replace(/^Bearer /, "");
        return sse([
          created("caption"),
          ...messageItem(0, "caption", "final_answer", active),
          completed("caption"),
        ]);
      });
      const direct = createRouteModels({
        ...options,
        purpose: "caption",
        conversationId: conversation.id,
      });
      const model = direct.getModel("openai", SOL_ROUTE.model)!;
      const answer = await direct.complete(model, {
        messages: [{ role: "user", content: "caption", timestamp: 1 }],
      });
      expect(answer.content).toContainEqual(
        expect.objectContaining({ type: "text", text: active }),
      );
    } else if (
      ![
        "artifact",
        "artifact-utf16le",
        "artifact-utf16be",
        "json-utf16le",
        "spill-utf16be",
      ].includes(variant) &&
      variant !== "spill" &&
      variant !== "backup-only"
    ) {
      const entries = await raw.scanEntries(
        { conversationId: conversation.id },
        256,
        undefined,
        context,
      );
      expect(
        JSON.stringify(entries.items).includes(
          variant === "encoded" ? "\\\\u0074" : active,
        ),
      ).toBe(true);
      if (variant === "success" || variant === "split") {
        const message = entries.items.find(
          (entry) => entry.kind === "pi.assistant",
        )?.model?.[0];
        expect(message).toMatchObject({
          content: [expect.objectContaining({ type: "text", text: expected })],
        });
      }
    }
    await harness.close(context);
    journal.close();
    if (variant === "backup-only") {
      const historical = new DatabaseSync(database);
      try {
        historical.exec(
          "CREATE TABLE synthetic_historical_output (value TEXT)",
        );
        historical
          .prepare("INSERT INTO synthetic_historical_output VALUES (?)")
          .run("prefix".repeat(2000) + active + "suffix".repeat(2000));
        // A held statement can delay this connection's close, so settle the file as pi's close does.
        historical.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      } finally {
        historical.close();
      }
    }
    const before = readFileSync(database);
    const reopened = openCaptureJournal(journalPath, variant);
    reopened.close();
    const storage = await openNodeSqliteStorage(database);
    try {
      await expect(
        exportSnapshot({
          runId: variant,
          journal: journalPath,
          native: { reads: storage, context },
          nativeDatabase: database,
          root: join(root, "datasets"),
          retention: { policy: "test" },
        }),
      ).rejects.toBeInstanceOf(DumpFailed);
      expect(readdirSync(join(root, "datasets"))).toEqual([]);
      expect(existsSync(database)).toBe(true);
      expect(readFileSync(database)).toEqual(before);
      expect(
        readFileSync(join(journalPath, "events.jsonl"), "utf8").includes(
          active,
        ),
      ).toBe(false);
      // A later clean journal process cannot clear exposure certified from independent native/artifact data.
      const later = openCaptureJournal(journalPath, variant);
      later.capture({
        type: "model.request",
        scope: { runId: variant },
        callId: "later-clean",
        route: "local",
        provider: "local",
        model: "local",
        credentialCoverage: "none",
        headerNames: [],
        body: { status: "sent", json: {} },
      });
      later.capture({
        type: "model.end",
        scope: { runId: variant },
        callId: "later-clean",
        outcome: "completed",
      });
      later.close();
      await expect(
        exportSnapshot({
          runId: variant,
          journal: journalPath,
          native: { reads: storage, context },
          nativeDatabase: database,
          root: join(root, "datasets"),
          retention: { policy: "test" },
        }),
      ).rejects.toBeInstanceOf(DumpFailed);
    } finally {
      await storage.close(context);
    }
  }, 30_000);
}

test("pending authenticated observation refuses across reopen without any credential registry", async () => {
  const root = join(directory, "pending");
  mkdirSync(root);
  const journalPath = join(root, "journal");
  const journal = openCaptureJournal(journalPath, "pending");
  journal.capture({
    type: "model.request",
    scope: { runId: "pending" },
    callId: "unfinished",
    route: "local",
    provider: "local",
    model: "local",
    credentialCoverage: "required",
    headerNames: ["authorization"],
    body: { status: "sent", json: {} },
  });
  journal.capture({
    type: "model.event",
    scope: { runId: "pending" },
    callId: "unfinished",
    name: "credential_guard",
    data: { status: "pending" },
  });
  journal.close();
  const reopened = openCaptureJournal(journalPath, "pending");
  reopened.close();
  await expect(
    exportSnapshot({
      runId: "pending",
      journal: journalPath,
      root,
      retention: { policy: "test" },
    }),
  ).rejects.toMatchObject({
    _tag: "DumpFailed",
    reason: expect.stringContaining("source retained"),
  });
});

test("exact certified source reopens without credentials, while changed source refuses in a fresh process", async () => {
  const root = join(directory, "certified-reopen");
  mkdirSync(root);
  mkdirSync(join(root, "datasets"));
  const runId = "certified-reopen";
  const database = join(root, "pi.sqlite");
  const journalPath = join(root, "journal");
  const journal = openCaptureJournal(journalPath, runId);
  const token = tokenCommand(root, "lease");
  journal.capture({
    type: "run.start",
    scope: { runId },
    runKind: "coding",
    sourceRevision: "synthetic",
    route: "chatgpt",
    pricing: "subscription",
  });
  const harness = await Harness.open(
    await openNodeSqliteStorage(database),
    {
      models: createRouteModels({
        credentialInspection: "ephemeral" as const,
        route: SOL_ROUTE,
        runId,
        sessionAffinity: runId,
        auth: { tokenCommand: token.path },
        fetch: endpoint.fetch,
        capture: journal.capture,
      }),
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
  endpoint.respond(() =>
    sse([
      created("safe"),
      ...messageItem(0, "safe", "final_answer", "safe answer"),
      completed("safe"),
    ]),
  );
  await (
    await conversation.submit({ type: "input", content: "safe input" }, context)
  ).wait(context);
  await harness.close(context);
  journal.close();
  const storage = await openNodeSqliteStorage(database);
  try {
    await exportSnapshot({
      runId,
      journal: journalPath,
      native: { reads: storage, context },
      nativeDatabase: database,
      root: join(root, "datasets"),
      retention: { policy: "test" },
    });
  } finally {
    await storage.close(context);
  }
  const driver = join(root, "reopen.ts");
  writeFileSync(
    driver,
    `
import { BACKGROUND_CONTEXT as context } from ${JSON.stringify(import.meta.resolve("@earendil-works/chord/context"))};
import { openNodeSqliteStorage } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-durable/storage/sqlite/node"))};
import { exportSnapshot } from ${JSON.stringify(import.meta.resolve("../../../src/session-dump.ts"))};
const storage = await openNodeSqliteStorage(${JSON.stringify(database)});
try {
 await exportSnapshot({ runId: ${JSON.stringify(runId)}, journal: ${JSON.stringify(journalPath)}, native: { reads: storage, context }, nativeDatabase: ${JSON.stringify(database)}, root: ${JSON.stringify(join(root, "datasets"))}, retention: { policy: "test" } });
 console.log(JSON.stringify({ exported: true }));
} catch (error) { console.log(JSON.stringify({ exported: false, tag: error._tag, reason: error.reason })); }
finally { await storage.close(context); }
`,
  );
  const fresh = async () => {
    const child = Bun.spawn([process.execPath, driver], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    return JSON.parse(text);
  };
  expect(await fresh()).toEqual({ exported: true });
  const changed = openCaptureJournal(journalPath, runId);
  changed.capture({
    type: "artifact",
    scope: { runId },
    name: "new-output.txt",
    mediaType: "text/plain",
    bytes: new TextEncoder().encode("new output after certification"),
  });
  changed.close();
  expect(await fresh()).toMatchObject({
    exported: false,
    tag: "DumpFailed",
    reason: expect.stringContaining("source retained"),
  });
  expect(existsSync(database)).toBe(true);
}, 60_000);
