import { dumpJournalLines } from "./fixture.ts";
import { z } from "zod";
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { credentialSourceHash } from "../../../src/pi/capture/safety.ts";
import { sha256Of } from "../../../src/pi/capture/journal.ts";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  Harness,
  UsageDoc,
  createRegistry,
  defineExtension,
  defineTool,
} from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Effect } from "effect";
import {
  exportSnapshot,
  readSessionDump,
  exportPortableSnapshot,
} from "@neuve/harness/session-dump";
import { openCaptureJournal } from "../../../src/pi/capture/journal.ts";
import {
  deriveCapture,
  type RawCaptureSources,
} from "../../../src/pi/capture/canonical.ts";
import {
  readBackup,
  ProjectionRecipe,
} from "../../../src/pi/capture/sources.ts";
import { PiUsageDoc } from "../../../src/pi/capture/usage.ts";
import { Json } from "../../../src/pi/capture/types.ts";
import { readDump } from "../../../src/pi/capture/archive.ts";
import { createRouteModels } from "../../../src/pi/providers/agent-route-provider.ts";
import { SOL_ROUTE, OPUS_ROUTE } from "../../../src/route.ts";
import {
  openEndpoint,
  tokenCommand,
  sse,
  created,
  functionCallItem,
  messageItem,
  completed,
} from "../providers/fixture.ts";

const usage = (n: number) => ({
  input: n,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: n,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

test("native tool accounting reconciles every conversation, tool, counter and cost without hiding equal-total changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "usage-accounting-"));
  const runId = "usage-accounting";
  const journal = openCaptureJournal(join(root, "capture"), runId);
  journal.capture({
    type: "run.start",
    scope: { runId },
    runKind: "coding",
    sourceRevision: "synthetic",
    route: "chatgpt",
    pricing: "subscription",
  });
  const endpoint = openEndpoint();
  const token = tokenCommand(root, "lease");
  const tools = defineExtension({
    name: "accounting",
    tools: [
      defineTool({
        name: "echo",
        description: "echo",
        parameters: Type.Object({}),
        execute: async () => ({
          content: [{ type: "text", text: "safe" }],
          usage: usage(10),
        }),
      }),
      defineTool({
        name: "meter",
        description: "meter",
        parameters: Type.Object({}),
        execute: async () => ({
          content: [{ type: "text", text: "safe error" }],
          isError: true,
          usage: usage(20),
        }),
      }),
      defineTool({
        name: "unmetered",
        description: "unmetered",
        parameters: Type.Object({}),
        execute: async () => ({
          content: [{ type: "text", text: "unknown usage" }],
        }),
      }),
    ],
  });
  const registry = createRegistry();
  registry.install(tools);
  const database = join(root, "pi.sqlite");
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
      registry,
      settings: { retry: { enabled: false }, compaction: { enabled: false } },
    },
    context,
  );
  const ownedConversations: Array<
    Awaited<ReturnType<typeof harness.createConversation>>
  > = [];
  try {
    for (let index = 0; index < 2; index++) {
      const conversation = await harness.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent: {
            model: { provider: "openai", modelId: SOL_ROUTE.model },
            extensions: [tools],
          },
        },
        context,
      );
      ownedConversations.push(conversation);
      journal.capture({
        type: "session.bind",
        scope: { runId, conversationId: conversation.id, stage: "investigate" },
      });
      const names = index === 0 ? ["echo", "meter", "unmetered"] : ["echo"];
      endpoint.respond(
        () =>
          sse([
            created(`tools-${index}`),
            ...names.flatMap((name, i) =>
              functionCallItem(i, {
                id: `item-${index}-${i}`,
                callId: `call-${index}-${i}`,
                name,
                arguments: "{}",
              }),
            ),
            completed(`tools-${index}`, {
              input_tokens: 10,
              output_tokens: 5,
              total_tokens: 15,
            }),
          ]),
        () =>
          sse([
            created(`answer-${index}`),
            ...messageItem(0, `answer-item-${index}`, "final_answer", "safe"),
            completed(`answer-${index}`, {
              input_tokens: 20,
              output_tokens: 9,
              total_tokens: 29,
            }),
          ]),
      );
      await (
        await conversation.submit(
          { type: "input", content: "safe accounting test" },
          context,
        )
      ).wait(context);
    }
    const requestsBeforeCompaction = endpoint.received.length;
    const noop = await ownedConversations[0]!.compact(undefined, context);
    await harness.waitForTask(noop, context);
    expect(endpoint.received.length).toBe(requestsBeforeCompaction);
    journal.capture({
      type: "stage.end",
      scope: { runId, stage: "investigate" },
      status: "completed",
    });
    journal.capture({ type: "run.end", scope: { runId }, status: "completed" });
    journal.close();
    await mkdir(join(root, "datasets"));
    const input = {
      runId,
      journal: journal.directory,
      nativeDatabase: database,
      root: join(root, "datasets"),
      retention: { policy: "synthetic accounting" },
    };
    const snapshot = await exportSnapshot(input);
    const read = await Effect.runPromise(readSessionDump(snapshot.directory));
    expect(read.run.complete).toBe(true);
    expect(
      read.sessions.map((s) => s.totals.ledger?.tokens.totalTokens),
    ).toEqual([74, 54]);
    expect(read.run.stages[0]?.totals.tokens.totalTokens).toBe(128);
    const portable = await exportPortableSnapshot({
      directory: snapshot.directory,
      root: input.root,
      retention: input.retention,
    });
    expect(
      (await Effect.runPromise(readSessionDump(portable.directory))).run
        .complete,
    ).toBe(true);
    const archive = await readDump(snapshot.directory);
    const file = (name: string) => {
      const bytes = archive.files.get(name);
      if (bytes === undefined) throw new Error(name);
      return bytes;
    };
    const native = await readBackup(file("native/pi.sqlite"));
    expect(
      Object.fromEntries(
        Object.entries(
          PiUsageDoc.parse(
            native.conversations[0]!.documents.find(
              (d) => d.kind === "pi.usage",
            )!.value,
          ).tools,
        ).map(([name, usage]) => [name, usage.totalTokens]),
      ),
    ).toEqual({ echo: 10, meter: 20 });
    expect(
      Object.fromEntries(
        Object.entries(
          PiUsageDoc.parse(
            native.conversations[1]!.documents.find(
              (d) => d.kind === "pi.usage",
            )!.value,
          ).tools,
        ).map(([name, usage]) => [name, usage.totalTokens]),
      ),
    ).toEqual({ echo: 10 });
    const lines = dumpJournalLines(archive.files);
    const recipe = ProjectionRecipe.parse(
      JSON.parse(new TextDecoder().decode(file("source/projection.json"))),
    );
    const raw: RawCaptureSources = {
      native,
      lines,
      tornLines: 0,
      backup: read.run.backup,
      journal: read.run.journal,
      artifacts: [],
    };
    const rows: Array<{ name: string; result: string }> = [];
    const mutateLedger = (
      source: RawCaptureSources,
      change: (ledger: PiUsageDoc) => void,
      index = 0,
    ) => {
      const doc = source.native.conversations[index]?.documents.find(
        (d) => d.kind === "pi.usage",
      );
      if (doc === undefined) throw new Error("ledger");
      const ledger = PiUsageDoc.parse(doc.value);
      change(ledger);
      doc.value = Json.parse(ledger);
    };
    const cases: Array<[string, (source: RawCaptureSources) => void]> = [
      [
        "tool tokens",
        (s) =>
          mutateLedger(s, (l) => {
            l.tools["echo"]!.input += 11;
            l.tools["echo"]!.totalTokens += 11;
          }),
      ],
      [
        "tool cost total",
        (s) =>
          mutateLedger(s, (l) => {
            l.tools["echo"]!.cost.total = 3;
          }),
      ],
      [
        "tool cost component",
        (s) =>
          mutateLedger(s, (l) => {
            l.tools["echo"]!.cost.input = 3;
          }),
      ],
      [
        "tool absent",
        (s) =>
          mutateLedger(s, (l) => {
            delete l.tools["echo"];
          }),
      ],
      [
        "tool key",
        (s) =>
          mutateLedger(s, (l) => {
            l.tools["other"] = l.tools["echo"]!;
            delete l.tools["echo"];
          }),
      ],
      [
        "global same total",
        (s) => {
          mutateLedger(s, (l) => {
            l.tools["echo"]!.input += 1;
            l.tools["echo"]!.totalTokens += 1;
          });
          mutateLedger(
            s,
            (l) => {
              l.tools["echo"]!.input -= 1;
              l.tools["echo"]!.totalTokens -= 1;
            },
            1,
          );
        },
      ],
      [
        "multi tool same total",
        (s) =>
          mutateLedger(s, (l) => {
            l.tools["echo"]!.input += 1;
            l.tools["echo"]!.totalTokens += 1;
            l.tools["meter"]!.input -= 1;
            l.tools["meter"]!.totalTokens -= 1;
          }),
      ],
      [
        "reasoning",
        (s) =>
          mutateLedger(s, (l) => {
            l.tools["echo"]!.reasoning = 7;
          }),
      ],
      [
        "cacheWrite1h",
        (s) =>
          mutateLedger(s, (l) => {
            l.tools["echo"]!.cacheWrite1h = 7;
          }),
      ],
      [
        "result usage",
        (s) => {
          const entry = s.native.conversations[0]!.entries.find(
            (e) => e.kind === "pi.tool-result",
          )!;
          const message = Json.parse(entry.model?.[0]);
          if (
            message !== null &&
            typeof message === "object" &&
            !Array.isArray(message)
          )
            entry.model = [{ ...message, usage: Json.parse(usage(99)) }];
        },
      ],
      [
        "result name",
        (s) => {
          const entry = s.native.conversations[0]!.entries.find(
            (e) => e.kind === "pi.tool-result",
          )!;
          const message = Json.parse(entry.model?.[0]);
          if (
            message !== null &&
            typeof message === "object" &&
            !Array.isArray(message)
          )
            entry.model = [{ ...message, toolName: "different" }];
        },
      ],
    ];
    for (const [name, mutate] of cases) {
      const changed = structuredClone(raw);
      mutate(changed);
      await expect(deriveCapture(runId, changed, recipe)).rejects.toThrow(
        "contradicts",
      );
      rows.push({ name, result: "refused" });
    }
    for (const state of ["completed", "failed", "unrelated"] as const) {
      for (const field of [
        "input",
        "output",
        "cacheRead",
        "cacheWrite",
        "total",
        "cacheWrite1h",
      ] as const) {
        const changed = structuredClone(raw);
        const task = changed.native.conversations[0]!.tasks.find(
          (t) => t.kind === "pi.compaction",
        )!;
        task.state = { status: "terminal", outcome: { status: state } };
        mutateLedger(changed, (ledger) => {
          const key = Object.keys(ledger.models)[0]!;
          const item = ledger.models[key]!;
          if (field === "cacheWrite1h") item.cacheWrite1h = 999;
          else item.cost[field] = 123;
        });
        await expect(deriveCapture(runId, changed, recipe)).rejects.toThrow(
          "native model ledger contradicts",
        );
        rows.push({
          name: `no-model-compaction-${state}-${field}`,
          result: "refused",
        });
      }
    }
    const missing = structuredClone(raw);
    missing.native.conversations[0]!.documents =
      missing.native.conversations[0]!.documents.filter(
        (d) => d.kind !== "pi.usage",
      );
    await expect(deriveCapture(runId, missing, recipe)).rejects.toThrow(
      "ledger contradicts",
    );
    const restore = async (name: string, changedLines = lines) => {
      const directory = join(root, name);
      await mkdir(join(directory, "capture"), { recursive: true });
      await mkdir(join(directory, "datasets"));
      await writeFile(join(directory, "pi.sqlite"), file("native/pi.sqlite"));
      await writeFile(
        join(directory, "capture", "events.jsonl"),
        changedLines.map((line) => JSON.stringify(line)).join("\n") + "\n",
      );
      return {
        ...input,
        journal: join(directory, "capture"),
        nativeDatabase: join(directory, "pi.sqlite"),
        root: join(directory, "datasets"),
      };
    };
    // A live process may re-inspect with its ephemeral detectors. These cases
    // prove reopening with certificates alone, independent of garbage collection.
    const exportFresh = async (source: typeof input) => {
      const child = Bun.spawn(
        [
          process.execPath,
          "--no-env-file",
          "--eval",
          `import { exportSnapshot } from ${JSON.stringify(import.meta.resolve("@neuve/harness/session-dump"))};
try { await exportSnapshot(${JSON.stringify(source)}); console.log(JSON.stringify({ exported: true })); }
catch (error) { console.log(JSON.stringify({ exported: false, reason: error.reason ?? error.message })); }`,
        ],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: root,
            TMPDIR: tmpdir(),
            NEUVE_MODE: "check",
          },
        },
      );
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      return z
        .discriminatedUnion("exported", [
          z.strictObject({ exported: z.literal(true) }),
          z.strictObject({
            exported: z.literal(false),
            reason: z.string().min(1).max(4096),
          }),
        ])
        .parse(JSON.parse(stdout));
    };
    const uncertifiedSource = {
      exported: false,
      reason: expect.stringMatching(
        /(?:closed source with no WAL matches no credential certificate; source retained|historical credential authority is unavailable; source retained privately, export refused)$/,
      ),
    };
    const restored = await restore("restored");
    expect(await exportFresh(restored)).toEqual({ exported: true });
    const idle = await exportSnapshot(restored);
    expect(
      (await Effect.runPromise(readSessionDump(idle.directory))).run.complete,
    ).toBe(true);
    expect(
      sha256Of(new Uint8Array(await readFile(restored.nativeDatabase))),
    ).toBe(sha256Of(file("native/pi.sqlite")));
    expect(
      (await readDump(idle.directory)).files.get("native/pi.sqlite"),
    ).toEqual(file("native/pi.sqlite"));
    const missingCertificate = structuredClone(lines);
    for (const line of missingCertificate)
      if (line.event.type === "credential.inspection")
        line.event = {
          type: "credential.guard",
          scope: line.event.scope,
          callId: line.event.callId,
          status: "pending",
        };
    expect(
      await exportFresh(
        await restore("missing-certificate", missingCertificate),
      ),
    ).toMatchObject(uncertifiedSource);
    const foreignCertificate = structuredClone(lines);
    for (const line of foreignCertificate)
      if (line.event.type === "credential.inspection") {
        line.event.sourceHashes = [];
        line.event.sourceHash = credentialSourceHash([]);
      }
    expect(
      await exportFresh(
        await restore("foreign-certificate", foreignCertificate),
      ),
    ).toMatchObject(uncertifiedSource);
    const changedMain = await restore("changed-main");
    const changedDatabase = new DatabaseSync(changedMain.nativeDatabase);
    changedDatabase.exec("PRAGMA user_version = 41");
    changedDatabase.close();
    expect(await exportFresh(changedMain)).toMatchObject(uncertifiedSource);
    const walSource = await restore("introduced-wal");
    const walDatabase = new DatabaseSync(walSource.nativeDatabase);
    try {
      walDatabase.exec(
        "PRAGMA wal_autocheckpoint=0; CREATE TABLE committed_wal_probe(value TEXT); INSERT INTO committed_wal_probe VALUES ('committed WAL')",
      );
      const child = Bun.spawn({
        cmd: [
          process.execPath,
          "--eval",
          `import { exportSnapshot } from ${JSON.stringify(import.meta.resolve("@neuve/harness/session-dump"))}; try { await exportSnapshot(${JSON.stringify(walSource)}); process.exitCode=2; } catch(error) { console.log(error.message); }`,
        ],
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stdout).text()).toContain(
        "historical credential authority is unavailable",
      );
    } finally {
      walDatabase.close();
    }
    const changedConversation = ownedConversations[0];
    if (changedConversation === undefined)
      throw new Error("native conversation missing");
    await changedConversation.commit(async (tx) => {
      const ledger = await tx.doc(UsageDoc, changedConversation.id);
      ledger.tools["echo"]!.input += 11;
      ledger.tools["echo"]!.totalTokens += 11;
    }, context);
    await expect(exportSnapshot(input)).rejects.toThrow(
      "native tool ledger contradicts",
    );
    await writeFile(
      join(root, "matrix.json"),
      JSON.stringify({ totals: [74, 54, 128], rows }, null, 2),
    );
    console.log(
      JSON.stringify({ usageAccountingFixture: root, rows: rows.length }),
    );
  } finally {
    await harness.close(context);
    endpoint.stop();
  }
}, 60_000);

test("a nonzero completed SDK receipt aborted before native compaction commit stays unjoined with its observed usage", async () => {
  const root = await mkdtemp(join(tmpdir(), "uncommitted-sdk-usage-"));
  const runId = "uncommitted-sdk-usage";
  const journal = openCaptureJournal(join(root, "capture"), runId);
  const endpoint = openEndpoint();
  const token = tokenCommand(root, "lease");
  const base = createRouteModels({
    credentialInspection: "ephemeral" as const,
    route: SOL_ROUTE,
    runId,
    sessionAffinity: runId,
    auth: { tokenCommand: token.path },
    fetch: endpoint.fetch,
    capture: journal.capture,
  });
  let interrupt:
    ((signal: AbortSignal | undefined) => Promise<void>) | undefined;
  const complete: typeof base.completeSimple = async (
    model,
    transcript,
    options,
  ) => {
    const message = await base.completeSimple(model, transcript, options);
    await interrupt?.(options?.signal);
    return message;
  };
  const models = new Proxy(base, {
    get(target, key) {
      return key === "completeSimple" ? complete : Reflect.get(target, key);
    },
  });
  const database = join(root, "pi.sqlite");
  const harness = await Harness.open(
    await openNodeSqliteStorage(database),
    {
      models,
      registry: createRegistry(),
      settings: {
        retry: { enabled: false },
        compaction: { enabled: false, keepRecentTokens: 1 },
      },
    },
    context,
  );
  try {
    const conversation = await harness.root(context, {
      agent: { model: { provider: "openai", modelId: SOL_ROUTE.model } },
    });
    journal.capture({
      type: "run.start",
      scope: { runId },
      runKind: "coding",
      sourceRevision: "synthetic",
      route: "chatgpt",
      pricing: "subscription",
    });
    journal.capture({
      type: "session.bind",
      scope: { runId, conversationId: conversation.id },
    });
    endpoint.respond(() =>
      sse([
        created("native"),
        ...messageItem(0, "native-item", "final_answer", "safe original turn"),
        completed("native"),
      ]),
    );
    await (
      await conversation.submit(
        { type: "input", content: "safe original input" },
        context,
      )
    ).wait(context);
    let task: Awaited<ReturnType<typeof conversation.compact>> | undefined;
    let abortion: Promise<unknown> | undefined;
    interrupt = async (signal) => {
      if (task === undefined || signal === undefined)
        throw new Error("compaction task or signal missing");
      const aborted = new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      abortion = harness.abortTask(task, context);
      await aborted;
    };
    endpoint.respond(() =>
      sse([
        created("uncommitted"),
        ...messageItem(
          0,
          "uncommitted-item",
          "final_answer",
          "uncommitted summary",
        ),
        completed("uncommitted"),
      ]),
    );
    task = await conversation.compact(undefined, context);
    await harness.waitForTask(task, context);
    await abortion;
    journal.close();
    await mkdir(join(root, "datasets"));
    const snapshot = await exportSnapshot({
      runId,
      journal: journal.directory,
      nativeDatabase: database,
      root: join(root, "datasets"),
      retention: { policy: "uncommitted SDK observation" },
    });
    const read = await Effect.runPromise(readSessionDump(snapshot.directory));
    expect(read.run.complete).toBe(false);
    expect(read.sessions[0]!.totals.ledger!.tokens.totalTokens).toBe(15);
    const orphan = read.unjoined.find(
      (call) => call.end?.responseId === "uncommitted",
    );
    expect(orphan?.role).toBe("unjoined");
    expect(orphan?.end?.sdkUsage?.totalTokens).toBe(15);
    expect(orphan?.end?.usage?.totalTokens).toBe(15);
    expect(read.run.gaps.map((gap) => gap.code)).toContain("calls-unjoined");
    await writeFile(
      join(root, "observation.json"),
      JSON.stringify(
        {
          committedTokens: 15,
          observedUncommittedTokens: orphan?.end?.sdkUsage?.totalTokens,
          complete: read.run.complete,
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({
        uncommittedSdkFixture: root,
        committedTokens: 15,
        observedUncommittedTokens: 15,
      }),
    );
  } finally {
    interrupt = undefined;
    await harness.close(context);
    endpoint.stop();
  }
}, 10_000);

test("actual compaction preserves SDK component costs and one-hour cache counters", async () => {
  const root = await mkdtemp(join(tmpdir(), "priced-compaction-"));
  const runId = "priced-compaction";
  const journal = openCaptureJournal(join(root, "capture"), runId);
  const endpoint = openEndpoint();
  const variable = "NEUVE_TEST_CAPTURE_COMPACTION_KEY";
  process.env[variable] = "synthetic-local-compaction-key";
  const route = { ...OPUS_ROUTE, credentialVariable: variable };
  const database = join(root, "pi.sqlite");
  const harness = await Harness.open(
    await openNodeSqliteStorage(database),
    {
      models: createRouteModels({
        credentialInspection: "ephemeral" as const,
        route,
        runId,
        sessionAffinity: runId,
        fetch: endpoint.fetch,
        capture: journal.capture,
      }),
      registry: createRegistry(),
      settings: {
        retry: { enabled: false },
        compaction: { enabled: false, keepRecentTokens: 1 },
      },
    },
    context,
  );
  const answer = (id: string, text: string) =>
    sse([
      {
        type: "message_start",
        message: {
          id,
          type: "message",
          role: "assistant",
          model: route.model,
          content: [],
          stop_reason: null,
          usage: {
            input_tokens: 10,
            cache_creation_input_tokens: 200,
            cache_read_input_tokens: 0,
            cache_creation: {
              ephemeral_5m_input_tokens: 0,
              ephemeral_1h_input_tokens: 200,
            },
            output_tokens: 1,
          },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 12 },
      },
      { type: "message_stop" },
    ]);
  try {
    const conversation = await harness.root(context, {
      agent: { model: { provider: route.provider, modelId: route.model } },
    });
    journal.capture({
      type: "run.start",
      scope: { runId },
      runKind: "coding",
      sourceRevision: "synthetic",
      route: route.provider,
      pricing: "metered",
    });
    journal.capture({
      type: "session.bind",
      scope: { runId, conversationId: conversation.id },
    });
    endpoint.respond(
      () => answer("turn", "safe original answer"),
      () => answer("summary", "safe compacted summary"),
    );
    await (
      await conversation.submit(
        { type: "input", content: "safe original input" },
        context,
      )
    ).wait(context);
    await harness.waitForTask(
      await conversation.compact(undefined, context),
      context,
    );
    journal.close();
    await mkdir(join(root, "datasets"));
    const snapshot = await exportSnapshot({
      runId,
      journal: journal.directory,
      nativeDatabase: database,
      root: join(root, "datasets"),
      retention: { policy: "synthetic SDK pricing" },
    });
    const read = await Effect.runPromise(readSessionDump(snapshot.directory));
    expect(read.run.complete).toBe(true);
    expect(endpoint.received).toHaveLength(2);
    const summary = read.unjoined.find(
      (call) => call.end?.responseId === "summary",
    );
    expect(summary?.role).toBe("non-turn");
    expect(summary?.end?.sdkUsage).toMatchObject({
      input: 10,
      output: 12,
      cacheWrite: 200,
      cacheWrite1h: 200,
      totalTokens: 222,
    });
    expect(summary?.end?.sdkUsage?.cost.input).toBeCloseTo(0.00004, 12);
    expect(summary?.end?.sdkUsage?.cost.output).toBeCloseTo(0.00024, 12);
    expect(summary?.end?.sdkUsage?.cost.cacheWrite).toBeCloseTo(0.0016, 12);
    expect(summary?.end?.sdkUsage?.cost.total).toBeCloseTo(0.00188, 12);
    const ledger = PiUsageDoc.parse(
      read.sessions[0]!.documents.find(
        (document) => document.kind === "pi.usage",
      )!.value,
    ).models[`${route.provider}/${route.model}`]!;
    expect(ledger.cacheWrite1h).toBe(400);
    expect(ledger.totalTokens).toBe(444);
    expect(ledger.cost.total).toBeCloseTo(0.00376, 12);
    await writeFile(
      join(root, "sdk-accounting.json"),
      JSON.stringify({ summary: summary?.end?.sdkUsage, ledger }, null, 2),
    );
    console.log(
      JSON.stringify({
        pricedCompactionFixture: root,
        requests: 2,
        summaryTokens: 222,
        ledgerTokens: 444,
        ledgerCacheWrite1h: 400,
        sdkCost: ledger.cost.total,
      }),
    );
  } finally {
    await harness.close(context);
    endpoint.stop();
    delete process.env[variable];
  }
}, 10_000);
