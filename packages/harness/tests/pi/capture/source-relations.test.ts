import { captureSdk } from "./sdk-fixture.ts";
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, UsageDoc, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Effect } from "effect";
import {
  exportSnapshot,
  exportPortableSnapshot,
  readSessionDump,
} from "@neuve/harness/session-dump";
import { sha256Of } from "../../../src/pi/capture/journal.ts";
import { SOURCE_VALIDATION_FILE } from "../../../src/pi/capture/archive.ts";
import { openCaptureJournal } from "../../../src/pi/capture/journal.ts";
import {
  deriveCapture,
  type RawCaptureSources,
} from "../../../src/pi/capture/canonical.ts";
import {
  readBackup,
  NativeSnapshot,
  ProjectionRecipe,
} from "../../../src/pi/capture/sources.ts";
import {
  readDump,
  writeDump,
  encodeManifest,
} from "../../../src/pi/capture/archive.ts";
import { createRouteModels } from "../../../src/pi/providers/agent-route-provider.ts";
import { SOL_ROUTE } from "../../../src/route.ts";
import {
  created,
  completed,
  messageItem,
  functionCallItem,
  openEndpoint,
  sse,
  tokenCommand,
} from "../providers/fixture.ts";
import { Json, JournalLine } from "../../../src/pi/capture/types.ts";
import { providerOutput } from "../../../src/pi/capture/provider-output.ts";
import { PiUsageDoc } from "../../../src/pi/capture/usage.ts";
import { CallRecord } from "../../../src/pi/capture/dump.ts";

const decode = (bytes: Uint8Array | undefined) =>
  JSON.parse(new TextDecoder().decode(bytes));

test("conversation and model source matrix refuses ownership and output contradictions through the canonical derivation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "source-relations-"));
  const endpoint = openEndpoint();
  const runId = "source-relations";
  let journal = openCaptureJournal(join(directory, "journal"), runId);
  journal.capture({
    type: "run.start",
    scope: { runId },
    runKind: "coding",
    sourceRevision: "synthetic",
    route: "chatgpt",
    pricing: "subscription",
  });
  const database = join(directory, "pi.sqlite");
  const token = tokenCommand(directory, "synthetic-offline-lease");
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
        capture: (event) => journal.capture(event),
      }),
      registry: createRegistry(),
      settings: {
        retry: { enabled: false },
        compaction: { enabled: false, keepRecentTokens: 1 },
      },
    },
    context,
  );
  const a = await harness.root(context, {
    agent: { model: { provider: "openai", modelId: SOL_ROUTE.model } },
  });
  const b = await harness.createConversation(
    {
      ownership: { kind: "ownerless" },
      agent: { model: { provider: "openai", modelId: SOL_ROUTE.model } },
    },
    context,
  );
  const root = join(directory, "datasets");
  await mkdir(root);
  try {
    for (const [conversation, stage, input, output] of [
      [a, "understand", 10, 5],
      [b, "investigate", 30, 12],
    ] as const) {
      journal.capture({
        type: "session.bind",
        scope: {
          runId,
          conversationId: conversation.id,
          stage,
          agent: "source-test",
        },
      });
      const id = `response-${conversation.id}`;
      endpoint.respond(() =>
        sse([
          created(id),
          ...messageItem(
            0,
            `item-${conversation.id}`,
            "final_answer",
            "alice@example.com",
          ),
          completed(id, {
            input_tokens: input,
            output_tokens: output,
            total_tokens: input + output,
          }),
        ]),
      );
      expect(
        (
          await (
            await conversation.submit(
              { type: "input", content: "synthetic input" },
              context,
            )
          ).wait(context)
        ).status,
      ).toBe("done");
      journal.capture({
        type: "stage.end",
        scope: { runId, stage },
        status: "completed",
      });
    }
    journal.capture({ type: "run.end", scope: { runId }, status: "completed" });
    journal.close();
    const input = {
      runId,
      journal: journal.directory,
      nativeDatabase: database,
      root,
      retention: { policy: "synthetic source matrix" },
    };
    const snapshot = await exportSnapshot(input);
    const read = await Effect.runPromise(readSessionDump(snapshot.directory));
    expect(read.run.complete).toBe(true);
    expect(read.run.stages.map((s) => s.totals.tokens.totalTokens)).toEqual([
      15, 42,
    ]);
    const portable = await exportPortableSnapshot({
      directory: snapshot.directory,
      root,
      retention: input.retention,
    });
    expect(
      (await Effect.runPromise(readSessionDump(portable.directory))).run
        .complete,
    ).toBe(true);
    const portableBundle = await readDump(portable.directory);
    const insufficient = new Map(portableBundle.files);
    insufficient.delete(SOURCE_VALIDATION_FILE);
    const oldManifest = {
      ...portableBundle.manifest,
      files: portableBundle.manifest.files.filter(
        (file) => file.name !== SOURCE_VALIDATION_FILE,
      ),
    };
    const oldBytes = encodeManifest(oldManifest);
    const oldRoot = join(directory, "old-portable");
    await mkdir(oldRoot);
    const old = await writeDump({
      root: oldRoot,
      manifest: oldManifest,
      manifestBytes: oldBytes,
      files: insufficient,
      record: { ...portableBundle.record, manifest: sha256Of(oldBytes) },
    });
    await expect(
      Effect.runPromise(readSessionDump(old.directory)),
    ).rejects.toThrow("portable source validation is unavailable");
    const bundle = await readDump(snapshot.directory);
    const raw: RawCaptureSources = {
      native: await readBackup(bundle.files.get("native/pi.sqlite")!),
      lines: new TextDecoder()
        .decode(bundle.files.get("journal/events.jsonl"))
        .trim()
        .split("\n")
        .map((line) => JournalLine.parse(JSON.parse(line))),
      tornLines: 0,
      backup: read.run.backup,
      journal: read.run.journal,
      artifacts: [],
    };
    const recipe = ProjectionRecipe.parse(
      decode(bundle.files.get("source/projection.json")),
    );
    const rows: Array<{ name: string; result: string }> = [];
    const probe = async (
      name: string,
      mutate: (sources: RawCaptureSources) => void,
    ) => {
      const changed = structuredClone(raw);
      mutate(changed);
      const result = await deriveCapture(runId, changed, recipe).then(
        () => "accepted",
        () => "refused",
      );
      rows.push({ name, result });
      expect(result, name).toBe("refused");
    };
    const reproductions = [];
    for (const family of ["email", "end-scope"]) {
      const changed = structuredClone(raw);
      if (family === "email") {
        const assistant = changed.native.conversations[0]!.entries.find(
          (entry) => entry.kind === "pi.assistant",
        )!;
        assistant.model =
          NativeSnapshot.shape.conversations.element.shape.entries.element.shape.model.parse(
            JSON.parse(
              JSON.stringify(assistant.model).replaceAll(
                "alice@example.com",
                "bob@example.net",
              ),
            ),
          );
      } else {
        const line = changed.lines.find(
          (line) => line.event.type === "model.end",
        )!;
        line.event.scope = { ...line.event.scope, taskId: 999999 };
      }
      reproductions.push({
        family,
        result: await deriveCapture(runId, changed, recipe).then(
          () => "accepted",
          () => "refused",
        ),
      });
    }
    console.log(JSON.stringify({ rawReproductions: reproductions }));
    for (const type of [
      "model.request",
      "model.response",
      "model.event",
      "model.end",
    ] as const) {
      await probe(`raw-scope-nonexistent-task-${type}`, (sources) => {
        const line = sources.lines.find((line) => line.event.type === type)!;
        line.event.scope = { ...line.event.scope, taskId: 999999 };
      });
    }
    await probe("raw-email-collision", (sources) => {
      const assistant = sources.native.conversations[0]!.entries.find(
        (entry) => entry.kind === "pi.assistant",
      )!;
      assistant.model =
        NativeSnapshot.shape.conversations.element.shape.entries.element.shape.model.parse(
          JSON.parse(
            JSON.stringify(assistant.model).replaceAll(
              "alice@example.com",
              "bob@example.net",
            ),
          ),
        );
    });
    const assistantModel =
      NativeSnapshot.shape.conversations.element.shape.entries.element.shape
        .model;
    const firstCall = raw.lines.find(
      (line) => line.event.type === "model.request",
    )!.event;
    if (firstCall.type !== "model.request")
      throw new Error("missing request fixture");
    for (const [family, events] of [
      [
        "text",
        messageItem(0, "text-item", "final_answer", "alice@example.com"),
      ],
      [
        "parsed-text",
        messageItem(
          0,
          "text-item",
          "final_answer",
          JSON.stringify({ nested: "alice@example.com" }),
        ),
      ],
      [
        "tool-arguments",
        functionCallItem(0, {
          id: "tool-item",
          callId: "tool-call",
          name: "unavailable",
          arguments: JSON.stringify({ nested: { value: "alice@example.com" } }),
        }),
      ],
      [
        "tool-id",
        functionCallItem(0, {
          id: "alice@example.com",
          callId: "tool-call",
          name: "unavailable",
          arguments: "{}",
        }),
      ],
      [
        "continuation",
        [
          {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              type: "reasoning",
              id: "reasoning-item",
              summary: [],
              encrypted_content: "alice@example.com",
            },
          },
        ],
      ],
      [
        "thinking",
        [
          {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              type: "reasoning",
              id: "reasoning-item",
              summary: [{ type: "summary_text", text: "alice@example.com" }],
              encrypted_content: "opaque",
            },
          },
        ],
      ],
    ] as const) {
      const coherent = {
        ...structuredClone(raw),
        lines: [...structuredClone(raw.lines)],
      };
      const firstEvent = coherent.lines.findIndex(
        (line) =>
          line.event.type === "model.event" &&
          line.event.callId === firstCall.callId,
      );
      const template = coherent.lines[firstEvent]!;
      coherent.lines = coherent.lines.filter(
        (line) =>
          !(
            line.event.type === "model.event" &&
            line.event.callId === firstCall.callId
          ),
      );
      const callEvents = [
        created("response-" + a.id),
        ...events,
        completed("response-" + a.id),
      ];
      coherent.lines.splice(
        coherent.lines.findIndex(
          (line) =>
            line.event.type === "model.response" &&
            line.event.callId === firstCall.callId,
        ) + 1,
        0,
        ...callEvents.map((event, index) =>
          JournalLine.parse({
            ...template,
            seq: template.seq + index,
            event: {
              type: "model.event",
              scope: template.event.scope,
              callId: firstCall.callId,
              name: event.type,
              data: event,
            },
          }),
        ),
      );
      const capturedCall = await captureSdk(
        CallRecord.parse({
          ...read.sessions[0]!.calls[0]!,
          events: callEvents.map((event) => ({
            at: 0,
            name: event.type,
            data: event,
          })),
        }),
      );
      const ending = capturedCall.events.find(
        ({ name }) => name === "sdk_invocation_end",
      )!;
      coherent.lines.splice(
        coherent.lines.findIndex(
          ({ event }) =>
            event.type === "model.end" && event.callId === firstCall.callId,
        ),
        0,
        JournalLine.parse({
          ...template,
          event: {
            type: "model.event",
            scope: template.event.scope,
            callId: firstCall.callId,
            name: ending.name,
            data: ending.data,
          },
        }),
      );
      const decoded = await providerOutput(capturedCall);
      const assistant = coherent.native.conversations[0]!.entries.find(
        (entry) => entry.kind === "pi.assistant",
      )!;
      const model = assistant.model![0]!;
      if (model === null || typeof model !== "object" || !("content" in model))
        throw new Error("missing assistant fixture");
      if (decoded === null) throw new Error("missing decoded fixture");
      assistant.model = assistantModel.parse(
        JSON.parse(
          JSON.stringify([
            {
              ...model,
              content: decoded.content,
              rawStopReason: decoded.finish?.rawStopReason,
              stopReason: decoded.finish?.stopReason,
            },
          ]),
        ),
      );
      for (const line of coherent.lines)
        if (
          line.event.type === "model.end" &&
          line.event.callId === firstCall.callId
        ) {
          line.event.stopReason = decoded.finish?.stopReason ?? "stop";
        }
      for (const declared of [[], ["alice@example.com", "bob@example.net"]]) {
        const masking = { ...recipe, declared };
        await deriveCapture(runId, coherent, masking);
        const changed = structuredClone(coherent);
        const changedAssistant = changed.native.conversations[0]!.entries.find(
          (entry) => entry.kind === "pi.assistant",
        )!;
        changedAssistant.model = assistantModel.parse(
          JSON.parse(
            JSON.stringify(changedAssistant.model).replaceAll(
              "alice@example.com",
              "bob@example.net",
            ),
          ),
        );
        await expect(deriveCapture(runId, changed, masking)).rejects.toThrow(
          "contradicts native assistant output",
        );
        rows.push({
          name: `${family}-${declared.length === 0 ? "default" : "custom"}-mask-collision`,
          result: "refused",
        });
      }
    }
    for (const type of [
      "model.request",
      "model.response",
      "model.event",
      "model.end",
    ] as const) {
      for (const field of [
        "conversationId",
        "entryId",
        "stage",
        "agent",
      ] as const) {
        await probe(`raw-scope-${type}-${field}`, (sources) => {
          for (const fact of sources.lines)
            if (
              "callId" in fact.event &&
              fact.event.callId === firstCall.callId
            )
              fact.event.scope = {
                ...fact.event.scope,
                stage: "understand",
                agent: "source-test",
              };
          const line = sources.lines.find((line) => line.event.type === type)!;
          line.event.scope = {
            ...line.event.scope,
            [field]:
              field === "conversationId"
                ? b.id
                : field === "entryId"
                  ? 999999
                  : "other",
          };
        });
      }
      await probe(`raw-scope-${type}-wrong-existing-task`, (sources) => {
        const line = sources.lines.find((line) => line.event.type === type)!;
        const other = sources.native.conversations[1]!.entries.find(
          (entry) => entry.kind === "pi.assistant",
        )!;
        line.event.scope = { ...line.event.scope, taskId: other.byTaskId };
      });
      const enriched = structuredClone(raw);
      const event = enriched.lines.find(
        (line) => line.event.type === type,
      )!.event;
      const assistant = enriched.native.conversations[0]!.entries.find(
        (entry) => entry.kind === "pi.assistant",
      )!;
      event.scope = {
        ...event.scope,
        conversationId: a.id,
        taskId: assistant.byTaskId,
      };
      expect((await deriveCapture(runId, enriched, recipe)).run.complete).toBe(
        true,
      );
      rows.push({
        name: `raw-scope-${type}-optional-enrichment`,
        result: "accepted",
      });
    }
    for (const index of [0, 1]) {
      await probe(`native-output-${index}`, (sources) => {
        const assistant = sources.native.conversations[index]!.entries.find(
          (e) => e.kind === "pi.assistant",
        )!;
        const message = Json.parse(assistant.model![0]);
        if (
          message !== null &&
          !Array.isArray(message) &&
          typeof message === "object" &&
          "content" in message
        )
          assistant.model = [
            {
              ...message,
              content: [{ type: "text", text: "contradictory output" }],
            },
          ];
      });
      await probe(`provider-output-${index}`, (sources) => {
        const done = sources.lines.filter(
          (l) =>
            l.event.type === "model.event" &&
            l.event.name === "response.output_item.done",
        )[index]!;
        const event = done.event;
        if (
          event.type === "model.event" &&
          event.data !== null &&
          typeof event.data === "object" &&
          "item" in event.data
        ) {
          const item = event.data["item"];
          if (item !== null && typeof item === "object" && "content" in item)
            event.data = {
              ...event.data,
              item: {
                ...item,
                content: [
                  {
                    type: "output_text",
                    text: "contradictory output",
                    annotations: [],
                  },
                ],
              },
            };
        }
      });
      await probe(`call-conversation-${index}`, (sources) => {
        const request = sources.lines.filter(
          (l) => l.event.type === "model.request",
        )[index]!;
        if (request.event.type === "model.request")
          request.event.scope.conversationId =
            sources.native.conversations[1 - index]!.id;
      });
      await probe(`call-model-${index}`, (sources) => {
        const request = sources.lines.filter(
          (l) => l.event.type === "model.request",
        )[index]!.event;
        if (request.type === "model.request") request.model = "different-model";
      });
    }
    await probe("cross-conversation-ledger-swap", (sources) => {
      const documents = sources.native.conversations.map((c) =>
        c.documents.find((d) => d.kind === "pi.usage")!,
      );
      const first = documents[0]!.value;
      documents[0]!.value = documents[1]!.value;
      documents[1]!.value = first;
    });
    for (const index of [0, 1])
      await probe(`ledger-model-${index}`, (sources) => {
        const doc = sources.native.conversations[index]!.documents.find(
          (d) => d.kind === "pi.usage",
        )!;
        const value = doc.value;
        if (value !== null && typeof value === "object" && "models" in value) {
          const models = value["models"];
          if (
            models !== null &&
            typeof models === "object" &&
            !Array.isArray(models)
          )
            doc.value = {
              ...value,
              models: { "openai/different-model": Object.values(models)[0]! },
            };
        }
      });
    for (const index of [0, 1])
      await probe(`ledger-cost-${index}`, (sources) => {
        const doc = sources.native.conversations[index]!.documents.find(
          (d) => d.kind === "pi.usage",
        )!;
        const value = doc.value;
        if (value !== null && typeof value === "object" && "models" in value) {
          const models = value["models"];
          if (
            models !== null &&
            typeof models === "object" &&
            !Array.isArray(models)
          )
            doc.value = {
              ...value,
              models: Object.fromEntries(
                Object.entries(models).map(([key, usage]) => [
                  key,
                  usage !== null && typeof usage === "object"
                    ? { ...usage, cost: { total: 1 } }
                    : usage,
                ]),
              ),
            };
        }
      });
    const multiModel = structuredClone(raw);
    const secondConversation = multiModel.native.conversations[1]!;
    const secondAssistant = secondConversation.entries.find(
      (e) => e.kind === "pi.assistant",
    )!;
    const oldMessage = secondAssistant.model![0]!;
    if (
      oldMessage !== null &&
      typeof oldMessage === "object" &&
      "model" in oldMessage
    )
      secondAssistant.model = [{ ...oldMessage, model: "second-model" }];
    const secondLedger = secondConversation.documents.find(
      (d) => d.kind === "pi.usage",
    )!;
    const oldLedger = secondLedger.value;
    if (
      oldLedger !== null &&
      typeof oldLedger === "object" &&
      "models" in oldLedger
    ) {
      const models = oldLedger["models"];
      if (models !== null && typeof models === "object")
        secondLedger.value = {
          ...oldLedger,
          models: { "openai/second-model": Object.values(models)[0]! },
        };
    }
    const secondRequest = multiModel.lines.filter(
      (l) => l.event.type === "model.request",
    )[1]!.event;
    if (secondRequest.type === "model.request") {
      secondRequest.model = "second-model";
      if (
        secondRequest.body.status !== "sent" ||
        secondRequest.body.json === null ||
        typeof secondRequest.body.json !== "object" ||
        Array.isArray(secondRequest.body.json)
      )
        throw new Error("missing model request body");
      secondRequest.body = {
        status: "sent",
        json: Json.parse({ ...secondRequest.body.json, model: "second-model" }),
      };
      if (secondRequest.sdkContext !== undefined)
        secondRequest.sdkContext.model.id = "second-model";
    }
    expect((await deriveCapture(runId, multiModel, recipe)).run.complete).toBe(
      true,
    );
    const ledgers = multiModel.native.conversations.map((c) =>
      c.documents.find((d) => d.kind === "pi.usage")!,
    );
    [ledgers[0]!.value, ledgers[1]!.value] = [
      ledgers[1]!.value,
      ledgers[0]!.value,
    ];
    await expect(deriveCapture(runId, multiModel, recipe)).rejects.toThrow(
      "native model ledger contradicts",
    );
    rows.push({ name: "cross-model-same-global-total", result: "refused" });
    const edited = structuredClone(raw);
    const originalAssistant = edited.native.conversations[0]!.entries.find(
      (e) => e.kind === "pi.assistant",
    )!;
    edited.native.conversations[0]!.entries.push({
      id: 10000,
      conversationId: a.id,
      kind: "synthetic.edit",
      edits: [
        {
          target: originalAssistant.id,
          action: "replace",
          messages: [
            {
              role: "assistant",
              content: [
                { type: "text", text: "legitimate visible replacement" },
              ],
            },
          ],
        },
      ],
    });
    expect((await deriveCapture(runId, edited, recipe)).run.complete).toBe(
      true,
    );
    const nativeOnly = structuredClone(raw);
    await expect(
      deriveCapture(
        runId,
        {
          ...nativeOnly,
          lines: nativeOnly.lines.filter(
            (line) => line.event.type !== "model.event",
          ),
        },
        recipe,
      ),
    ).rejects.toThrow("lacks required original provider output");
    for (const line of nativeOnly.lines)
      if (line.event.type === "model.request") line.event.api = "native-only";
    for (const conversation of nativeOnly.native.conversations)
      for (const entry of conversation.entries)
        if (entry.kind === "pi.assistant" && entry.model)
          entry.model = entry.model.map((message) =>
            message !== null &&
            !Array.isArray(message) &&
            typeof message === "object"
              ? { ...message, api: "native-only" }
              : message,
          );
    expect(
      (
        await deriveCapture(
          runId,
          {
            ...nativeOnly,
            lines: nativeOnly.lines.filter(
              (line) => line.event.type !== "model.event",
            ),
          },
          recipe,
        )
      ).run.complete,
    ).toBe(true);
    journal = openCaptureJournal(journal.directory, runId);
    endpoint.respond(
      () =>
        sse([
          created("structured"),
          ...functionCallItem(0, {
            id: "structured-item",
            callId: "structured-call",
            name: "unavailable",
            arguments: '{"nested":{"optional":null,"values":[1,"two"]}}',
          }),
          completed("structured", {
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
          }),
        ]),
      () =>
        sse([
          created("structured-final"),
          ...messageItem(
            0,
            "structured-final-item",
            "final_answer",
            "synthetic final",
          ),
          completed("structured-final", {
            input_tokens: 0,
            output_tokens: 0,
            total_tokens: 0,
          }),
        ]),
    );
    expect(
      (
        await (
          await a.submit(
            { type: "input", content: "synthetic structured turn" },
            context,
          )
        ).wait(context)
      ).status,
    ).toBe("done");
    endpoint.respond(() =>
      sse([
        created("compaction"),
        ...messageItem(
          0,
          "compaction-item",
          "final_answer",
          "alice@example.com",
        ),
        completed("compaction", {
          input_tokens: 5,
          output_tokens: 2,
          total_tokens: 7,
        }),
      ]),
    );
    await harness.waitForTask(await a.compact(undefined, context), context);
    journal.capture({
      type: "model.request",
      callId: "caption",
      purpose: "caption",
      scope: { runId, conversationId: a.id },
      route: "chatgpt",
      provider: "openai",
      model: SOL_ROUTE.model,
      credentialCoverage: "none",
      headerNames: [],
      body: { status: "sent", json: {} },
    });
    journal.capture({
      type: "model.end",
      callId: "caption",
      scope: { runId, conversationId: a.id },
      outcome: "completed",
      usage: {
        input: 3,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 5,
      },
    });
    journal.close();
    const withCompaction = await exportSnapshot(input);
    const compactionRead = await Effect.runPromise(
      readSessionDump(withCompaction.directory),
    );
    expect(compactionRead.run.complete).toBe(true);
    expect(compactionRead.sessions[0]!.totals.ledger!.tokens.totalTokens).toBe(
      22,
    );
    expect(
      compactionRead.sessions[0]!.totals.auxiliary!.tokens.totalTokens,
    ).toBe(5);
    const compactionBundle = await readDump(withCompaction.directory);
    const compactionRaw: RawCaptureSources = {
      ...raw,
      native: await readBackup(compactionBundle.files.get("native/pi.sqlite")!),
      lines: new TextDecoder()
        .decode(compactionBundle.files.get("journal/events.jsonl"))
        .trim()
        .split("\n")
        .map((line) => JournalLine.parse(JSON.parse(line))),
    };
    for (const field of [
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
      "total",
      "cacheWrite1h",
    ] as const) {
      const changed = structuredClone(compactionRaw);
      const document = changed.native.conversations[0]!.documents.find(
        (d) => d.kind === "pi.usage",
      )!;
      const ledger = PiUsageDoc.parse(document.value);
      const key = Object.keys(ledger.models)[0]!;
      if (field === "cacheWrite1h") ledger.models[key]!.cacheWrite1h = 999;
      else ledger.models[key]!.cost[field] = 123;
      document.value = Json.parse(ledger);
      await expect(deriveCapture(runId, changed, recipe)).rejects.toThrow(
        "native model ledger contradicts",
      );
      rows.push({ name: `actual-compaction-${field}`, result: "refused" });
    }
    const changedTool = structuredClone(compactionRaw);
    const toolAssistant = changedTool.native.conversations[0]!.entries.find(
      (entry) =>
        entry.kind === "pi.assistant" &&
        JSON.stringify(entry.model).includes("structured-call"),
    )!;
    const toolMessage = toolAssistant.model![0]!;
    if (
      toolMessage !== null &&
      typeof toolMessage === "object" &&
      "content" in toolMessage &&
      Array.isArray(toolMessage["content"])
    )
      toolAssistant.model = [
        {
          ...toolMessage,
          content: toolMessage["content"].map((part) =>
            part !== null &&
            typeof part === "object" &&
            "type" in part &&
            part["type"] === "toolCall"
              ? { ...part, arguments: { changed: true } }
              : part,
          ),
        },
      ];
    await expect(deriveCapture(runId, changedTool, recipe)).rejects.toThrow(
      "contradicts native assistant output",
    );
    rows.push({ name: "structured-native-output", result: "refused" });
    for (const type of [
      "model.request",
      "model.response",
      "model.event",
      "model.end",
    ] as const) {
      const changed = structuredClone(compactionRaw);
      const request = changed.lines.find(
        (line) =>
          line.event.type === "model.request" &&
          line.event.callId !== "caption" &&
          changed.lines.some(
            (candidate) =>
              candidate.event.type === "model.end" &&
              "callId" in line.event &&
              candidate.event.callId === line.event.callId &&
              candidate.event.responseId === "compaction",
          ),
      )!.event;
      if (!("callId" in request)) throw new Error("missing compaction request");
      const fact = changed.lines.find(
        (line) =>
          line.event.type === type &&
          "callId" in line.event &&
          line.event.callId === request.callId,
      )!;
      const generation = changed.native.conversations[0]!.tasks.find(
        (task) => task.kind === "pi.generation",
      )!;
      fact.event.scope = { ...fact.event.scope, taskId: generation.id };
      await expect(deriveCapture(runId, changed, recipe)).rejects.toThrow(
        "compaction capture scope contradicts native task",
      );
      rows.push({
        name: `compaction-${type}-generation-crossover`,
        result: "refused",
      });
    }
    const auxiliaryScope = structuredClone(compactionRaw);
    const captionEnd = auxiliaryScope.lines.find(
      (line) =>
        line.event.type === "model.end" && line.event.callId === "caption",
    )!;
    const otherTask = auxiliaryScope.native.conversations[1]!.tasks[0]!;
    captionEnd.event.scope = { runId, taskId: otherTask.id };
    await expect(deriveCapture(runId, auxiliaryScope, recipe)).rejects.toThrow(
      "capture scope contradicts native ownership",
    );
    rows.push({
      name: "auxiliary-optional-scope-wrong-task-conversation",
      result: "refused",
    });
    const changedSummary = structuredClone(compactionRaw);
    const summaryDone = changedSummary.lines.find(
      (line) =>
        line.event.type === "model.event" &&
        line.event.name === "response.output_item.done" &&
        JSON.stringify(line.event.data).includes("compaction-item"),
    )!.event;
    if (
      summaryDone.type === "model.event" &&
      summaryDone.data !== null &&
      typeof summaryDone.data === "object" &&
      "item" in summaryDone.data
    ) {
      const item = summaryDone.data["item"];
      if (item !== null && typeof item === "object")
        summaryDone.data = {
          ...summaryDone.data,
          item: {
            ...item,
            content: [{ type: "output_text", text: "contradictory summary" }],
          },
        };
    }
    await expect(deriveCapture(runId, changedSummary, recipe)).rejects.toThrow(
      "native model ledger contradicts",
    );
    rows.push({
      name: "compaction-output-contradiction",
      result: "refused",
    });
    const compactionCollision = structuredClone(compactionRaw);
    const summaryEntry =
      compactionCollision.native.conversations[0]!.entries.find(
        (entry) => entry.kind === "pi.compaction",
      )!;
    summaryEntry.model = assistantModel.parse(
      JSON.parse(
        JSON.stringify(summaryEntry.model).replaceAll(
          "alice@example.com",
          "bob@example.net",
        ),
      ),
    );
    await expect(
      deriveCapture(runId, compactionCollision, recipe),
    ).rejects.toThrow("native model ledger contradicts");
    rows.push({ name: "compaction-raw-email-collision", result: "refused" });
    const swappedCompaction = structuredClone(compactionRaw);
    const compactionLedgers = swappedCompaction.native.conversations.map((c) =>
      c.documents.find((d) => d.kind === "pi.usage")!,
    );
    [compactionLedgers[0]!.value, compactionLedgers[1]!.value] = [
      compactionLedgers[1]!.value,
      compactionLedgers[0]!.value,
    ];
    await expect(
      deriveCapture(runId, swappedCompaction, recipe),
    ).rejects.toThrow("native model ledger contradicts");
    rows.push({
      name: "compaction-cross-conversation-ledger",
      result: "refused",
    });
    const ambiguous = structuredClone(compactionRaw);
    ambiguous.native.conversations[1]!.tasks.push({
      id: 10001,
      conversationId: b.id,
      kind: "pi.compaction",
      state: { status: "terminal" },
    });
    const nativeCompaction = ambiguous.native.conversations[0]!.entries.find(
      (entry) => entry.kind === "pi.compaction",
    )!;
    ambiguous.native.conversations[1]!.entries.push(
      NativeSnapshot.shape.conversations.element.shape.entries.element.parse({
        ...nativeCompaction,
        id: 10002,
        conversationId: b.id,
      }),
    );
    await expect(deriveCapture(runId, ambiguous, recipe)).rejects.toThrow(
      "native model ledger contradicts",
    );
    rows.push({ name: "ambiguous-compaction-ownership", result: "refused" });
    const failedCompaction = structuredClone(compactionRaw);
    const summaryEnd = failedCompaction.lines.find(
      (line) =>
        line.event.type === "model.end" &&
        line.event.responseId === "compaction",
    )!.event;
    if (summaryEnd.type === "model.end") {
      delete summaryEnd.usage;
      delete summaryEnd.sdkUsage;
      summaryEnd.outcome = "failed";
    }
    await expect(
      deriveCapture(runId, failedCompaction, recipe),
    ).rejects.toThrow("outcome contradicts its terminal stop reason");
    rows.push({
      name: "failed-compaction-without-usage",
      result: "refused",
    });
    const storedAssistant = (
      await a.entries({}, 100, undefined, context)
    ).items.find((entry) => entry.kind === "pi.assistant")!;
    const storedMessage = storedAssistant.model![0]!;
    if (storedMessage.role !== "assistant")
      throw new Error("assistant fixture missing");
    const edit = await a.commit(
      (tx) =>
        tx.appendEntry(a.id, {
          kind: "synthetic.edit",
          edits: [
            {
              target: storedAssistant.id,
              action: "replace",
              messages: [
                {
                  ...storedMessage,
                  content: [{ type: "text", text: "visible replacement" }],
                },
              ],
            },
          ],
        }),
      context,
    );
    await a.fork(edit.id, { ownership: { kind: "ownerless" } }, context);
    expect(
      (
        await Effect.runPromise(
          readSessionDump((await exportSnapshot(input)).directory),
        )
      ).run.complete,
    ).toBe(true);
    await a.commit(
      (tx) =>
        tx.appendEntry(a.id, {
          kind: "synthetic.omit",
          edits: [{ target: storedAssistant.id, action: "omit" }],
        }),
      context,
    );
    expect(
      (
        await Effect.runPromise(
          readSessionDump((await exportSnapshot(input)).directory),
        )
      ).run.complete,
    ).toBe(true);
    await a.commit(async (tx) => {
      const ua = await tx.doc(UsageDoc, a.id);
      const ub = await tx.doc(UsageDoc, b.id);
      const first = JSON.parse(JSON.stringify(ua.models));
      ua.models = JSON.parse(JSON.stringify(ub.models));
      ub.models = first;
    }, context);
    await expect(exportSnapshot(input)).rejects.toThrow(
      "native model ledger contradicts",
    );
    await writeFile(
      join(directory, "matrix.json"),
      JSON.stringify(
        {
          controlComplete: read.run.complete,
          stageTokens: [15, 42],
          httpRequests: endpoint.received.length,
          rows,
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({
        sourceRelationsFixture: directory,
        cases: rows.length,
        refused: rows.filter((r) => r.result === "refused").length,
        httpRequests: endpoint.received.length,
      }),
    );
  } finally {
    await harness.close(context);
    endpoint.stop();
  }
}, 60_000);

test("offline pinned decoders retain text, tools, refusal, reasoning, empty and partial semantics without ambient network", async () => {
  const contentOutput = async (...args: Parameters<typeof providerOutput>) =>
    (await providerOutput(...args))?.content;
  const original = globalThis.fetch;
  let network = 0;
  globalThis.fetch = Object.assign(
    async () => {
      network += 1;
      throw new Error("network forbidden");
    },
    { preconnect: () => undefined },
  );
  const call = async (api: string, events: ReadonlyArray<unknown>) =>
    captureSdk(
      CallRecord.parse({
        callId: "offline",
        role: "turn",
        scope: { runId: "offline" },
        route: "synthetic",
        provider: api === "anthropic-messages" ? "anthropic" : "openai",
        model: "synthetic-model",
        api,
        credentialCoverage: "none",
        headerNames: [],
        body: { status: "sent", json: {} },
        requestedAt: 1,
        response: null,
        events: events.map((value) => {
          const data = Json.parse(value);
          return {
            at: 1,
            name:
              data !== null && typeof data === "object" && "type" in data
                ? data["type"]
                : "unknown",
            data,
          };
        }),
        end: null,
      }),
    );
  try {
    expect(
      await contentOutput(
        await call("openai-responses", [created("empty"), completed("empty")]),
      ),
    ).toEqual([]);
    expect(
      await contentOutput(
        await call("openai-responses", [
          created("refusal"),
          {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              type: "message",
              id: "refusal-item",
              content: [{ type: "refusal", refusal: "declined" }],
            },
          },
          completed("refusal"),
        ]),
      ),
    ).toEqual([
      {
        type: "text",
        text: "declined",
        textSignature: '{"v":1,"id":"refusal-item"}',
      },
    ]);
    expect(
      await contentOutput(
        await call("anthropic-messages", [
          {
            type: "message_start",
            message: {
              id: "partial",
              model: "synthetic-model",
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "partial" },
          },
        ]),
      ),
    ).toEqual([{ type: "text", text: "partial" }]);
    expect(
      await contentOutput(
        await call("anthropic-messages", [
          {
            type: "message_start",
            message: { id: "tool", model: "synthetic-model", usage: {} },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "tool",
              name: "echo",
              input: {},
            },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"text":"ok"}' },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "tool_use" },
            usage: {},
          },
          { type: "message_stop" },
        ]),
      ),
    ).toEqual([
      { type: "toolCall", id: "tool", name: "echo", arguments: { text: "ok" } },
    ]);
    expect(
      await contentOutput(
        await call("openai-responses", [
          created("tool"),
          ...functionCallItem(0, {
            id: "item",
            callId: "call",
            name: "echo",
            arguments: '{"nullable":null,"items":[1,"two"]}',
          }),
          completed("tool"),
        ]),
      ),
    ).toEqual([
      {
        type: "toolCall",
        id: "call|item",
        name: "echo",
        namespace: "neuve",
        arguments: { nullable: null, items: [1, "two"] },
      },
    ]);
    const reasoning = {
      type: "reasoning",
      id: "reasoning",
      summary: [{ type: "summary_text", text: "synthetic summary" }],
      encrypted_content: "synthetic-opaque",
    };
    expect(
      await contentOutput(
        await call("openai-responses", [
          created("reasoning"),
          {
            type: "response.output_item.done",
            output_index: 0,
            item: reasoning,
          },
          completed("reasoning"),
        ]),
      ),
    ).toEqual([
      {
        type: "thinking",
        thinking: "synthetic summary",
        thinkingSignature: JSON.stringify(reasoning),
      },
    ]);
    expect(
      await contentOutput(
        await call("anthropic-messages", [
          {
            type: "message_start",
            message: { id: "redacted", model: "synthetic-model", usage: {} },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "redacted_thinking",
              data: "synthetic-opaque",
            },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: {},
          },
          { type: "message_stop" },
        ]),
      ),
    ).toEqual([
      {
        type: "thinking",
        thinking: "[Reasoning redacted]",
        thinkingSignature: "synthetic-opaque",
        redacted: true,
      },
    ]);
    expect(network).toBe(0);
  } finally {
    globalThis.fetch = original;
  }
});
