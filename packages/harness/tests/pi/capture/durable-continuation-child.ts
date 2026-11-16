import { exportWhileOpen } from "./open-source.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  Harness,
  createRegistry,
  defineExtension,
  defineTool,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SourceOwnership } from "../../../src/pi/source-ownership.ts";
import { openManagedCredentialInspection } from "../../../src/pi/capture/safety.ts";
import { createRouteModels } from "../../../src/coding.ts";
import { Type } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { SOL_ROUTE } from "../../../src/route.ts";
import {
  exportPortableSnapshot,
  readSessionDump,
} from "../../../src/session-dump.ts";
import { openCaptureJournal } from "../../../src/pi/capture/journal.ts";
import {
  created,
  completed,
  messageItem,
  functionCallItem,
  sse,
} from "../providers/fixture.ts";
const [mode, root, variant = "safe"] = process.argv.slice(2);
if (!root || !mode) throw new Error("fixture arguments missing");
const source = join(root, "source"),
  journalPath = join(source, "capture"),
  database = join(source, "pi.sqlite");
mkdirSync(source, { recursive: true, mode: 0o700 });
mkdirSync(join(root, "datasets"), { recursive: true });
const owner = SourceOwnership.acquire(source);
const inspection = openManagedCredentialInspection({
  ownership: owner,
  source,
  directory: join(root, "private"),
  journal: journalPath,
  nativeDatabase: database,
  excludedRoots: [source, join(root, "datasets")],
});
const journal = openCaptureJournal(journalPath, "durable-fixture");
const first =
  mode === "first" ||
  mode === "first-clean" ||
  mode.startsWith("first-partial") ||
  mode === "crash-before-registration" ||
  mode === "crash-after-registration";
if (
  mode === "crash-before-registration" ||
  mode === "crash-after-registration"
) {
  const register = inspection.register.bind(inspection);
  inspection.register = async (input) => {
    if (mode === "crash-before-registration")
      process.kill(process.pid, "SIGKILL");
    const result = await register(input);
    process.kill(process.pid, "SIGKILL");
    return result;
  };
}
let conversationId = first
  ? undefined
  : JSON.parse(readFileSync(join(root, "meta.json"), "utf8")).conversationId;
let partialDeltas = 0;
const capture: typeof journal.capture = (event) => {
  const result = journal.capture(
    event.type === "model.request" ||
      event.type === "model.response" ||
      event.type === "model.event" ||
      event.type === "model.end"
      ? { ...event, scope: { ...event.scope, conversationId } }
      : event,
  );
  if (
    mode.startsWith("first-partial") &&
    requests === 2 &&
    event.type === "model.event" &&
    [
      "response.output_text.delta",
      "response.function_call_arguments.delta",
    ].includes(event.name)
  ) {
    partialDeltas++;
    if (partialDeltas >= (mode.includes("split") ? 2 : 1))
      writeFileSync(
        join(root, "ready.json"),
        JSON.stringify({ pid: process.pid, requests }),
      );
  }
  return result;
};
let requests = 0;
writeFileSync(join(root, mode + "-requests.json"), "0");
const fetch = Object.assign(
  async (_input: unknown, init?: RequestInit) => {
    requests++;
    writeFileSync(join(root, mode + "-requests.json"), String(requests));
    if (mode === "second" && variant === "safe" && requests === 1)
      return sse([
        created("new-tool"),
        ...functionCallItem(0, {
          id: "new-tool-item",
          callId: "new-tool-call",
          name: "synthetic_child",
          arguments: "{}",
        }),
        completed("new-tool"),
      ]);
    if (mode.startsWith("first-partial") && requests === 2) {
      if (mode.includes("arguments")) {
        const prefix = mode.includes("invalid")
          ? '{"value":"safe \\u00'
          : mode.includes("split")
            ? '{"value":"\\u0073ynthetic-lease-'
            : '{"value":"safe incomplete arguments';
        const events = functionCallItem(0, {
          id: "partial-arguments",
          callId: "partial-arguments-call",
          name: "synthetic_child",
          arguments: prefix,
        }).slice(0, 2);
        if (mode.includes("split"))
          events.push({
            type: "response.function_call_arguments.delta",
            output_index: 0,
            delta: "first",
          });
        return sse([created("partial"), ...events], { hold: true });
      }
      const prefix = mode.includes("split")
        ? "synthetic-lease-"
        : "safe partial assistant bytes";
      const events = messageItem(0, "partial-item", "commentary", prefix).slice(
        0,
        2,
      );
      if (mode.includes("split"))
        events.push({
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          delta: "first",
        });
      return sse([created("partial"), ...events], { hold: true });
    }
    const active = new Headers(init?.headers)
      .get("authorization")
      ?.replace(/^Bearer /, "");
    const answer =
      variant === "old"
        ? "new output old synthetic-lease-first"
        : variant === "current"
          ? `new output ${active}`
          : "safe genuinely new assistant output";
    return sse([
      created(`${mode}-${requests}`),
      ...messageItem(0, `${mode}-message-${requests}`, "final_answer", answer),
      completed(`${mode}-${requests}`),
    ]);
  },
  {
    preconnect: () => {
      throw new Error("fixture network disabled");
    },
  },
);
const command = join(root, "lease.sh");
writeFileSync(
  command,
  `#!/bin/sh\nprintf '%s' '{"access_token":"synthetic-lease-${first ? "first" : "second"}","expires_at":${Date.now() + 3600000}}'\n`,
  { mode: 0o700 },
);
const registry = createRegistry();
const extension = defineExtension({
  name: "synthetic-child",
  tools: [
    defineTool({
      name: "synthetic_child",
      description: "Write synthetic retained child history.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async (_args, api, ctx) => {
        const childId = await api.commit(
          async (tx) =>
            (
              await tx.createConversation({
                ownership: { kind: "task", taskId: api.taskId },
              })
            ).id,
          ctx,
        );
        const child = await api.conversation(childId, ctx);
        if (child === undefined) throw new Error("synthetic child missing");
        await api.details(
          { conversationId: childId, note: "safe child data after restart" },
          ctx,
        );
        journal.capture({
          type: "artifact",
          scope: { runId: "durable-fixture" },
          name: "safe-after-restart.txt",
          mediaType: "text/plain",
          bytes: new TextEncoder().encode("safe artifact after restart"),
        });
        return {
          content: [{ type: "text", text: "safe tool result after restart" }],
        };
      },
    }),
  ],
});
registry.install(extension);
const raw = await openNodeSqliteStorage(database);
const harness = await Harness.open(
  raw,
  {
    models: createRouteModels({
      route: SOL_ROUTE,
      runId: "durable-fixture",
      sessionAffinity: "durable-fixture",
      auth: { tokenCommand: command },
      capture,
      credentialInspection: inspection,
      fetch,
    }),
    registry,
    settings: { retry: { enabled: false }, compaction: { enabled: false } },
  },
  context,
);
const conversation = first
  ? await harness.root(context, {
      agent: {
        model: { provider: "openai", modelId: SOL_ROUTE.model },
        extensions: [extension],
      },
    })
  : await harness.conversation(conversationId, context);
if (!conversation) throw new Error("fixture conversation missing");
conversationId = conversation.id;
if (first) {
  writeFileSync(join(root, "meta.json"), JSON.stringify({ conversationId }));
  journal.capture({
    type: "run.start",
    scope: { runId: "durable-fixture" },
    runKind: "coding",
    sourceRevision: "synthetic",
    route: "openai",
    pricing: "subscription",
  });
  journal.capture({
    type: "session.bind",
    scope: { runId: "durable-fixture", conversationId },
  });
}
if (mode !== "native-only")
  for (
    let n = 0;
    n < (variant === "large" ? 50 : mode.startsWith("first-partial") ? 2 : 1);
    n++
  )
    await (
      await conversation.submit(
        {
          type: "input",
          content: first
            ? `first synthetic input ${n}`
            : "new input after genuine process death",
        },
        context,
      )
    ).wait(context);
else
  await conversation.commit(
    (tx) =>
      tx.appendEntry(conversation.id, {
        kind: "synthetic.note",
        data: { value: "new safe native data without a model call" },
      }),
    context,
  );
if (variant === "large")
  await conversation.commit(
    (tx) =>
      tx.appendEntry(conversation.id, {
        kind: "synthetic.large",
        data: { value: "x".repeat(10 * 1024 * 1024) },
      }),
    context,
  );
if (mode === "first") {
  writeFileSync(
    join(root, "ready.json"),
    JSON.stringify({ pid: process.pid, requests }),
  );
  await new Promise(() => {});
}
await harness.close(context);
if (variant === "duplicate") {
  const path = join(journalPath, "events.jsonl");
  const saved = readFileSync(path, "utf8");
  let altered = false;
  const changed =
    saved
      .trimEnd()
      .split("\n")
      .map((line) => {
        const event = JSON.parse(line).event;
        if (
          !altered &&
          event.type === "model.event" &&
          event.name !== "credential_guard" &&
          event.data !== null &&
          typeof event.data === "object" &&
          !Array.isArray(event.data)
        ) {
          altered = true;
          return line.replace(
            '"data":{',
            '"data":{"earlier":"\\u0073ynthetic-lease-first","earlier":"safe",',
          );
        }
        return line;
      })
      .join("\n") + "\n";
  if (!altered) throw new Error("fixture missing original event frame");
  writeFileSync(path, changed);
}
const admittedBuffer =
  variant === "buffer"
    ? new TextEncoder().encode("safe admitted artifact".padEnd(128, " "))
    : undefined;
if (admittedBuffer !== undefined)
  journal.capture({
    type: "artifact",
    scope: { runId: "durable-fixture" },
    name: "owned-buffer.txt",
    mediaType: "text/plain",
    bytes: admittedBuffer,
  });
journal.capture({
  type: "run.end",
  scope: { runId: "durable-fixture" },
  status: "completed",
});
journal.close();
let result;
try {
  const exporting = exportWhileOpen({
    runId: "durable-fixture",
    journal: journalPath,
    nativeDatabase: database,
    credentialInspection: inspection,
    root: join(root, "datasets"),
    retention: { policy: "synthetic" },
  });
  let mutatedDuringExport = false;
  if (admittedBuffer !== undefined) {
    admittedBuffer.fill(32);
    admittedBuffer.set(new TextEncoder().encode("synthetic-lease-first"));
    await new Promise<void>((resolve) =>
      setTimeout(() => {
        admittedBuffer.fill(32);
        admittedBuffer.set(new TextEncoder().encode("synthetic-lease-first"));
        mutatedDuringExport = true;
        resolve();
      }, 0),
    );
  }
  const snapshot = await exporting;
  const restored = await Effect.runPromise(readSessionDump(snapshot.directory));
  const portable = await exportPortableSnapshot({
    directory: snapshot.directory,
    root: join(root, "datasets"),
    retention: { policy: "synthetic" },
  });
  const portableRead = await Effect.runPromise(
    readSessionDump(portable.directory),
  );
  const bufferArtifact = restored.run.artifacts.find(
    (artifact) => artifact.name === "owned-buffer.txt",
  );
  const admittedArtifact =
    bufferArtifact?.file === null || bufferArtifact?.file === undefined
      ? undefined
      : restored.artifacts.get(bufferArtifact.file);
  result = {
    exported: true,
    portableRead: true,
    portableDirectory: portable.directory,
    portableComplete: portableRead.run.complete,
    mutatedDuringExport,
    callerBuffer:
      admittedBuffer === undefined
        ? null
        : new TextDecoder().decode(admittedBuffer).trimEnd(),
    admittedArtifact:
      admittedArtifact === undefined
        ? null
        : new TextDecoder().decode(admittedArtifact).trimEnd(),
    requests,
    directory: snapshot.directory,
    complete: restored.run.complete,
    gaps: restored.run.gaps,
    turns: restored.sessions.reduce((n, s) => n + s.turns.length, 0),
    children: restored.sessions.filter((s) => s.owner !== undefined).length,
    retainedPrefixCertificates: readFileSync(
      join(journalPath, "events.jsonl"),
      "utf8",
    )
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line).event)
      .filter(
        (event) =>
          event.type === "credential.inspection" &&
          event.retainedPrefixCalls?.length > 0,
      ).length,
    hasPartialPrefix: JSON.stringify(restored).includes(
      "safe partial assistant bytes",
    ),
    hasHistoricalInput: JSON.stringify(restored).includes(
      "first synthetic input",
    ),
    hasNewToolResult: JSON.stringify(restored).includes(
      "safe tool result after restart",
    ),
    artifacts: restored.run.artifacts.map((a) => a.name),
  };
} catch (error) {
  result = {
    exported: false,
    requests,
    reason: error instanceof Error ? error.message : "unknown",
  };
}
inspection.close();
owner.release();
writeFileSync(join(root, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
