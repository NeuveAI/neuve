import { exportWhileOpen } from "./open-source.ts";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  closeFailureRecord,
  storedCloseDiagnostic,
} from "../../../src/pi/capture/close-diagnostic.ts";
import { Effect } from "effect";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  Harness,
  createRegistry,
  defineExtension,
  defineTool,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  CredentialEpochId,
  InspectionBudget,
} from "../../../src/pi/capture/credential-detectors.ts";
import { SourceOwnership } from "../../../src/pi/source-ownership.ts";
import { createPrivateInspection } from "../../../src/pi/capture/private-inspection.ts";
import {
  openCaptureJournal,
  readCaptureJournal,
} from "../../../src/pi/capture/journal.ts";
import { readDump } from "../../../src/pi/capture/archive.ts";
import { readSessionDump } from "../../../src/pi/capture/export.ts";
import {
  SdkInvocationEnd,
  type Capture,
} from "../../../src/pi/capture/types.ts";
import { createRouteModels } from "../../../src/pi/providers/agent-route-provider.ts";
import { SOL_ROUTE } from "../../../src/route.ts";
import {
  created,
  completed,
  messageItem,
  reasoningItem,
  functionCallItem,
  schema,
  openEndpoint,
  sse,
  tokenCommand,
} from "../providers/fixture.ts";

export type Variant =
  | "safe"
  | "credential"
  | "bad-count"
  | "bad-frame"
  | "cumulative"
  | "cumulative-credential"
  | "cumulative-bound"
  | "missing-epoch"
  | "unsupported-history"
  | "history"
  | "history-credential"
  | "projection-cancelled"
  | "hostile-worker";
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

export const keepaliveFixture = async (
  root: string,
  variant: Variant,
  outputRoot?: string,
) => {
  const runId = "01HQ0000000000000000000000";
  const store = join(root, ".git", "neuve");
  const source = join(store, "runs", runId);
  const datasets = outputRoot ?? join(store, "datasets");
  const namespace = join(store, "credential-inspections");
  for (const path of [source, datasets, namespace])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  const owner = SourceOwnership.acquire(source);
  const authority = createPrivateInspection({
    ownership: owner,
    source,
    directory: join(namespace, "a".repeat(64)),
    excludedRoots: [source, datasets],
  });
  if (
    variant === "unsupported-history" ||
    variant === "history" ||
    variant === "history-credential"
  ) {
    const registration = await authority.register({
      epoch: CredentialEpochId.parse("synthetic-prior"),
      headers: new Headers({
        "x-api-key":
          variant === "unsupported-history"
            ? 'synthetic"' + "\\".repeat(10)
            : "synthetic-prior-epoch",
      }),
      escapedUnits: 8192,
      budget: new InspectionBudget(),
    });
    if (registration.status !== "registered")
      throw new Error("synthetic history unavailable");
  }
  const journalPath = join(source, "capture");
  const journal = openCaptureJournal(journalPath, runId);
  const scope = { runId };
  journal.capture({
    type: "run.start",
    scope,
    runKind: "coding",
    sourceRevision: {
      status: "not-applicable",
      reason: "synthetic keepalive capture",
    },
    route: "chatgpt",
    pricing: "subscription",
  });
  const cumulative = variant.startsWith("cumulative");
  let callbacks: number | undefined;
  const capture: Capture = (event) => {
    if (
      variant === "missing-epoch" &&
      event.type === "credential.registration"
    ) {
      journal.capture({ ...event, epochId: "synthetic-private-unregistered" });
    } else if (
      event.type === "model.event" &&
      event.name === "sdk_invocation_end"
    ) {
      const end = SdkInvocationEnd.parse(event.data);
      callbacks = Math.max(callbacks ?? 0, end.callbacks);
      journal.capture(
        variant === "bad-count"
          ? { ...event, data: { ...end, callbacks: end.callbacks - 1 } }
          : event,
      );
    } else if (
      variant === "bad-frame" &&
      event.type === "model.event" &&
      event.name === "keepalive"
    ) {
      journal.capture({
        ...event,
        data: {
          type: "response.output_text.delta",
          output_index: 0,
          delta: "forged",
        },
      });
    } else journal.capture(event);
  };
  const endpoint = openEndpoint();
  const token = tokenCommand(root, "synthetic-lease");
  const database = join(source, "pi.sqlite");
  const storage = await openNodeSqliteStorage(database);
  let harness: Harness | undefined;
  let closed = false;
  try {
    const registry = createRegistry();
    if (cumulative)
      registry.install(
        defineExtension({
          name: "synthetic-cumulative",
          tools: [
            defineTool({
              name: "note",
              description: "Synthetic note.",
              parameters: schema({
                type: "object",
                properties: { note: { type: "string" } },
                required: ["note"],
              }),
              execute: async () => ({
                content: [{ type: "text", text: "safe" }],
              }),
            }),
          ],
        }),
      );
    harness = await Harness.open(
      storage,
      {
        models: createRouteModels({
          route: SOL_ROUTE,
          runId,
          sessionAffinity: runId,
          auth: { tokenCommand: token.path },
          fetch: endpoint.fetch,
          capture,
          credentialInspection: authority,
        }),
        registry,
        settings: { retry: { enabled: false }, compaction: { enabled: false } },
      },
      context,
    );
    const conversation = await harness.root(context, {
      agent: { model: { provider: "openai", modelId: SOL_ROUTE.model } },
    });
    journal.capture({
      type: "session.bind",
      scope: { ...scope, conversationId: conversation.id },
    });
    if (cumulative) {
      const leaked = variant === "cumulative-credential";
      const bounded = variant === "cumulative-bound";
      const partial = JSON.stringify({
        note: "x".repeat(bounded ? 65536 : 2054) + (leaked ? "tok-1" : ""),
      });
      const complete = functionCallItem(1, {
        id: "item-cumulative",
        callId: "tool-cumulative",
        name: "note",
        arguments: JSON.stringify({ note: "safe" }),
      });
      const chunks = partial.match(bounded ? /.{1,64}/g : /.{1,8}/g) ?? [];
      endpoint.respond(() =>
        sse([
          created("response-cumulative"),
          {
            type: "response.in_progress",
            response: { id: "response-cumulative", status: "in_progress" },
          },
          { type: "keepalive" },
          ...reasoningItem(0, "reasoning-large", "r".repeat(65536)),
          complete[0]!,
          ...chunks.map((delta) => ({
            type: "response.function_call_arguments.delta",
            output_index: 1,
            delta,
          })),
          {
            type: "response.function_call_arguments.done",
            output_index: 1,
            arguments: JSON.stringify({ note: "safe" }),
          },
          complete[2]!,
          ...reasoningItem(2, "reasoning-small", "small"),
          completed("response-cumulative"),
        ]),
      );
    }
    endpoint.respond(() =>
      sse([
        created("response-keepalive"),
        {
          type: "keepalive",
          ...(variant === "credential" ? { note: "tok-1" } : {}),
        },
        ...messageItem(
          0,
          "message-keepalive",
          "final_answer",
          variant === "history-credential"
            ? "synthetic-prior-epoch"
            : "safe answer",
        ),
        completed("response-keepalive"),
      ]),
    );
    await (
      await conversation.submit(
        { type: "input", content: "synthetic keepalive probe" },
        context,
      )
    ).wait(context);
    await harness.close(context);
    closed = true;
    if (variant === "hostile-worker")
      for (let index = 0; index < 256; index++)
        journal.capture({
          type: "artifact",
          scope,
          name: `synthetic-${index}.txt`,
          mediaType: "text/plain",
          bytes: new TextEncoder().encode(`ordinary source ${index}`),
        });
    journal.capture({ type: "run.end", scope, status: "completed" });
    journal.close();
    const nativeBefore = hash(readFileSync(database));
    const options = {
      runId,
      journal: journalPath,
      nativeDatabase: database,
      credentialInspection: authority,
      root: datasets,
      close: "ended" as const,
      retention: { policy: "synthetic keepalive proof" },
    };
    if (
      variant !== "safe" &&
      variant !== "cumulative" &&
      variant !== "history"
    ) {
      let reason: string | undefined;
      let closeError: string | undefined;
      let closeDiagnostic: ReturnType<typeof storedCloseDiagnostic>;
      try {
        await exportWhileOpen(options);
      } catch (error) {
        closeDiagnostic = storedCloseDiagnostic(error);
        closeError = closeFailureRecord(error, "ended").error;
        if (
          error !== null &&
          typeof error === "object" &&
          "reason" in error &&
          typeof error.reason === "string"
        )
          reason = error.reason;
        else throw error;
      }
      if (reason === undefined)
        throw new Error("unsafe capture unexpectedly exported");
      return {
        variant,
        callbacks,
        refused: true,
        reason,
        closeDiagnostic,
        closeError,
        nativeUnchanged: hash(readFileSync(database)) === nativeBefore,
      };
    }
    const snapshot = await exportWhileOpen(options);
    const read = await Effect.runPromise(readSessionDump(snapshot.directory));
    const raw = await readDump(snapshot.directory);
    const native = raw.files.get("native/pi.sqlite");
    const kept = raw.files.get("journal/events.jsonl");
    const journalRead = readCaptureJournal(journalPath);
    if (!native || !kept || journalRead._tag !== "Read")
      throw new Error("raw capture missing");
    return {
      variant,
      runId,
      callbacks,
      refused: false,
      complete: read.run.complete,
      execution: read.run.execution,
      nativeBytes: native.byteLength,
      nativeMatchesManifest:
        read.run.backup.status === "captured" &&
        read.run.backup.sha256 === hash(native),
      journalMatchesSource: Buffer.from(kept).equals(
        readFileSync(join(journalPath, "events.jsonl")),
      ),
      keepalives: journalRead.lines.filter(
        (line) =>
          line.event.type === "model.event" && line.event.name === "keepalive",
      ).length,
      directory: snapshot.directory,
    };
  } finally {
    if (!closed) {
      if (harness) await harness.close(context).catch(() => {});
      else await storage.close(context);
    }
    journal.close();
    authority.close();
    owner.release();
    endpoint.stop();
  }
};

if (import.meta.main) {
  const root = process.argv[2];
  if (root === undefined) throw new Error("synthetic case root missing");
  console.log(
    JSON.stringify(
      await keepaliveFixture(
        root,
        process.argv[4] === "cumulative" ||
          process.argv[4] === "history" ||
          process.argv[4] === "missing-epoch" ||
          process.argv[4] === "unsupported-history"
          ? process.argv[4]
          : "safe",
        process.argv[3],
      ),
    ),
  );
}
