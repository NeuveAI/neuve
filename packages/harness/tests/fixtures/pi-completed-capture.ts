import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineDoc,
  defineExtension,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Effect } from "effect";
import { defaultConfig } from "../../src/config.ts";
import { openReviewHost } from "../../src/pi/host.ts";
import { SourceOwnership } from "../../src/pi/source-ownership.ts";
import { callSlots } from "../../src/pi/call-slots.ts";
import {
  openCaptureJournal,
  readCaptureJournal,
} from "../../src/pi/capture/journal.ts";
import {
  credentialSourceHash,
  rememberEphemeralCredentials,
  openManagedCredentialInspection,
} from "../../src/pi/capture/safety.ts";
import {
  exportSnapshot,
  exportPortableSnapshot,
  readSessionDump,
} from "../../src/session-dump.ts";

const root = process.argv[2]!;
const phase = process.argv[3]!;
mkdirSync(root, { recursive: true, mode: 0o700 });
mkdirSync(join(root, "datasets"), { recursive: true });
mkdirSync(join(root, "portable"), { recursive: true });
const database = join(root, "pi.sqlite");
const runId = "fixture-completed-capture";
const scope = { runId };
const journalPath = join(root, "journal");
if (phase === "stale") {
  const path = join(journalPath, "events.jsonl");
  const journal = readCaptureJournal(journalPath);
  if (journal._tag !== "Read") throw new Error("Fixture journal is unreadable");
  const lines = journal.lines;
  writeFileSync(
    path,
    lines
      .map((line) =>
        JSON.stringify(
          line.event.type === "credential.inspection"
            ? {
                ...line,
                event: {
                  ...line.event,
                  sourceHashes: [],
                  sourceHash: credentialSourceHash([]),
                },
              }
            : line,
        ),
      )
      .join("\n") + "\n",
  );
}
const ownership = SourceOwnership.acquire(root);
const privateDirectory = join(dirname(root), `private-${basename(root)}`);
const inspection =
  phase === "first" || existsSync(privateDirectory)
    ? openManagedCredentialInspection({
        ownership,
        source: root,
        directory: privateDirectory,
        journal: journalPath,
        nativeDatabase: database,
        excludedRoots: [root],
      })
    : undefined;
const register = async (callId: string, key: string) => {
  if (inspection === undefined)
    return rememberEphemeralCredentials(
      journal.capture,
      runId,
      callId,
      new Headers({ "x-api-key": key }),
    );
  const { CredentialEpochId, InspectionBudget } =
    await import("../../src/pi/capture/credential-detectors.ts");
  const result = await inspection.register({
    epoch: CredentialEpochId.parse(callId),
    headers: new Headers({ "x-api-key": key }),
    budget: new InspectionBudget(),
    deduplicate: true,
  });
  if (result.status !== "registered")
    throw new Error("fixture registration unavailable");
  journal.capture({
    type: "credential.registration",
    scope,
    callId,
    epochId: result.epoch,
    policy: "whole-source-credential-epochs-v1",
  });
};
const journal = openCaptureJournal(journalPath, runId);
const secret = "fixture-only-secret-a9ef";
const history = defineDoc<{ message: string }>({
  kind: "fixture.history",
  version: 1,
  scope: "session",
  initial: () => ({ message: "safe input" }),
});
if (phase === "first") {
  journal.capture({
    type: "run.start",
    scope,
    runKind: "scored",
    sourceRevision: "synthetic",
    route: "chatgpt",
    pricing: "subscription",
  });
  journal.capture({
    type: "credential.guard",
    scope,
    callId: "fixture-call",
    status: "pending",
  });
  journal.capture({
    type: "credential.guard",
    scope,
    callId: "fixture-call",
    status: "observed",
  });
  await register("fixture-call", secret);
}
if (phase === "artifact")
  journal.capture({
    type: "artifact",
    scope,
    name: "changed.txt",
    mediaType: "text/plain",
    bytes: new TextEncoder().encode(secret),
  });
if (phase === "unsafe" || phase === "unsafe-rotated")
  journal.capture({
    type: "credential.guard",
    scope,
    callId: "fixture-call",
    status: "exposed",
  });
if (phase === "unsafe-rotated") {
  const read = readCaptureJournal(journalPath);
  if (read._tag !== "Read") throw new Error("fixture journal missing");
  for (const { event } of read.lines)
    if (
      event.type === "credential.inspection" &&
      event.callId === "fixture-call"
    )
      journal.capture(event);
}
if (
  phase === "rotated" ||
  phase === "rotated-safe" ||
  phase === "unsafe-rotated"
) {
  journal.capture({
    type: "credential.guard",
    scope,
    callId: "rotated-call",
    status: "pending",
  });
  journal.capture({
    type: "credential.guard",
    scope,
    callId: "rotated-call",
    status: "observed",
  });
  await register("rotated-call", "new-fixture-key");
}
if (["document", "physical", "rotated", "message"].includes(phase)) {
  const changed = new DatabaseSync(database);
  try {
    if (phase === "physical") changed.exec("PRAGMA user_version = 41");
    else if (phase === "message")
      changed
        .prepare(
          "UPDATE entries SET record = json_set(record, '$.model[0].content', ?) WHERE json_extract(record, '$.kind') = 'fixture.message'",
        )
        .run(secret);
    else
      changed
        .prepare(
          "UPDATE document_revisions SET content = ? WHERE document_id IN (SELECT id FROM documents WHERE kind = ?)",
        )
        .run(
          JSON.stringify({ message: secret }),
          JSON.stringify("fixture.history"),
        );
  } finally {
    changed.close();
  }
}
const hash = () =>
  createHash("sha256").update(readFileSync(database)).digest("hex");
const before = phase === "first" ? null : hash();
let stages = 0;
let restored = 0;
let requests = 0;
try {
  const storage = await openNodeSqliteStorage(database);
  const host = await openReviewHost(
    {
      storage,
      ownership,
      models: createModels(),
      registry: createRegistry(),
      createRouteProvider: () => {
        requests++;
        throw new Error("fixture must not request a model");
      },
      slots: callSlots(1, (effect, signal) =>
        Effect.runPromise(
          effect,
          signal === undefined ? undefined : { signal },
        ),
      ),
      claim: {
        jobSeq: 7,
        attempt: phase === "first" ? 1 : 2,
        claimedAt: phase === "first" ? "first" : "second",
      },
      run: {
        runId,
        runKey: "fixture",
        generation: 1,
        cycleId: "fixture",
        range: {
          baseRef: "main",
          baseOid: "a".repeat(40),
          headOid: "b".repeat(40),
        },
        config: defaultConfig(),
        cutoffAt: Date.now() + 60000,
      },
      stages: ({ harness }) => ({
        extension: defineExtension({ name: "fixture" }),
        restore: async () => {
          restored++;
        },
        port: {
          link: async () => {
            throw new Error("no link");
          },
          front: async () => {
            throw new Error("no understand");
          },
          finder: async () => {
            throw new Error("no batch");
          },
          precompute: async () => {
            stages++;
            const conversation = await harness.root(context);
            journal.capture({
              type: "session.bind",
              scope: {
                ...scope,
                conversationId: conversation.id,
                stage: "understand",
                agent: "fixture",
              },
            });
            await harness.commit(async (tx) => {
              const doc = await tx.doc(history);
              doc.message = "safe result";
              await tx.appendEntry(conversation.id, {
                kind: "fixture.message",
                model: [{ role: "user", content: "safe input", timestamp: 0 }],
              });
            }, context);
            return {
              record: {
                stage: "precompute",
                agent: "fixture",
                status: "computed",
                wallMs: 1,
              },
            };
          },
          fill: async () => {
            throw new Error("no plan");
          },
          publish: async () => [],
        },
      }),
      onClose: async ({ mode, reads, context }) => {
        journal.close();
        const snapshot = await exportSnapshot({
          runId,
          journal: journalPath,
          native: { reads, context },
          nativeDatabase: database,
          credentialInspection: inspection,
          close: mode,
          root: join(root, "datasets"),
          retention: { policy: "test" },
        });
        const read = await Effect.runPromise(
          readSessionDump(snapshot.directory),
        );
        const portable = await exportPortableSnapshot({
          directory: snapshot.directory,
          root: join(root, "portable"),
          retention: { policy: "test" },
        });
        const publicRead = await Effect.runPromise(
          readSessionDump(portable.directory),
        );
        return {
          portable: {
            directory: portable.directory,
            containsHistoricalSecret:
              JSON.stringify(publicRead).includes(secret),
          },
          complete: read.run.complete,
          execution: read.run.execution,
          snapshotId: snapshot.snapshotId,
          backup: read.run.backup,
        };
      },
    },
    context,
  );
  const scheduling = (await host.harness.inspect(context)).scheduling;
  const ended = await host.ended(context);
  if (phase === "first") {
    journal.capture({
      type: "stage.end",
      scope: { ...scope, stage: "understand" },
      status: "completed",
    });
    journal.capture({
      type: "lead.fate",
      scope: { ...scope, stage: "publish" },
      leadId: "fixture-lead",
      handoff: "publish",
      fate: "withheld",
      reason: "fixture has no finding",
    });
    journal.capture({ type: "run.end", scope, status: "completed" });
  }
  const receipt = await host.close("ended", context);
  console.log(
    JSON.stringify({
      ok: true,
      admission: host.admission,
      resume: host.resume,
      ended,
      receipt,
      scheduling,
      stages,
      restored,
      requests,
      before,
      after: hash(),
    }),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      stages,
      restored,
      requests,
      before,
      after: hash(),
    }),
  );
} finally {
  journal.close();
  inspection?.close();
  ownership.release();
}
