import { captureAuthority, dumpJournalLines } from "./fixture.ts";
import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { exportSnapshot } from "@neuve/harness/session-dump";
import { exportWhileOpen } from "./open-source.ts";
import { createRouteModels } from "../../../src/pi/providers/agent-route-provider.ts";
import { SOL_ROUTE } from "../../../src/route.ts";
import {
  JOURNAL_FILE,
  openCaptureJournal,
  readCaptureJournal,
  sha256Of,
} from "../../../src/pi/capture/journal.ts";
import {
  readDump,
  writeDump,
  encodeManifest,
} from "../../../src/pi/capture/archive.ts";
import { RunDump } from "../../../src/pi/capture/dump.ts";
import {
  created,
  completed,
  messageItem,
  openEndpoint,
  sse,
  tokenCommand,
} from "../providers/fixture.ts";

const encode = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));

test("authenticated source coverage survives fresh readers and refuses every missing obligation before export", async () => {
  const root = await mkdtemp(join(tmpdir(), "source-coverage-"));
  const runId = "source-coverage";
  const database = join(root, "pi.sqlite");
  const journalPath = join(root, "capture");
  const journal = openCaptureJournal(journalPath, runId);
  const endpoint = openEndpoint();
  const token = tokenCommand(root, "synthetic-lease");
  let active = "";
  journal.capture({
    type: "run.start",
    scope: { runId },
    runKind: "reading",
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
      settings: { retry: { enabled: false }, compaction: { enabled: false } },
    },
    context,
  );
  try {
    const conversation = await harness.root(context, {
      agent: { model: { provider: "openai", modelId: SOL_ROUTE.model } },
    });
    journal.capture({
      type: "session.bind",
      scope: { runId, conversationId: conversation.id },
    });
    for (let index = 0; index < 2; index++) {
      endpoint.respond((request) => {
        active = request.headers.get("authorization")!.replace(/^Bearer /, "");
        return sse([
          created(`safe-${index}`),
          ...messageItem(0, `item-${index}`, "final_answer", "safe answer"),
          completed(`safe-${index}`),
        ]);
      });
      await (
        await conversation.submit(
          { type: "input", content: "safe input" },
          context,
        )
      ).wait(context);
    }
  } finally {
    await harness.close(context);
    journal.close();
    endpoint.stop();
  }
  const inline = readCaptureJournal(journalPath);
  if (inline._tag !== "Read") throw new Error("Fixture journal is unreadable");
  await writeFile(
    join(journalPath, JOURNAL_FILE),
    inline.lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
  );
  await mkdir(join(root, "datasets"));
  const input = {
    runId,
    journal: journalPath,
    nativeDatabase: database,
    root: join(root, "datasets"),
    retention: { policy: "synthetic coverage" },
  };
  const snapshot = await exportWhileOpen(input);
  const held = await readDump(snapshot.directory);
  const original = dumpJournalLines(held.files);
  const calls = original.flatMap(({ event }) =>
    event.type === "model.request" ? [event.callId] : [],
  );
  expect(calls).toHaveLength(2);
  const first = calls[0]!;
  const driver = join(root, "fresh.ts");
  await writeFile(
    driver,
    `
import { Effect } from ${JSON.stringify(import.meta.resolve("effect"))};
import { storeLocationIn } from ${JSON.stringify(import.meta.resolve("@neuve/records-core"))};
import { runIn, value, scanCaptures } from ${JSON.stringify(import.meta.resolve("./fixture.ts"))};
import { exportSnapshot, exportPortableSnapshot, readSessionDump, captureRunDump, readCapturedDump } from ${JSON.stringify(import.meta.resolve("@neuve/harness/session-dump"))};
const [mode, path] = process.argv.slice(2);
try {
 if(mode === "read") await Effect.runPromise(readSessionDump(path));
 else {
 const input = JSON.parse(await Bun.file(path).text());
 if(mode === "records") { const location = storeLocationIn(input.root + "/new-records"); const run = runIn(location); const raw = value(await run(captureRunDump(input))); value(await run(scanCaptures(location))); value(await run(readCapturedDump(raw.capture))); }
 else { const snapshot = await exportSnapshot(input); await Effect.runPromise(readSessionDump(snapshot.directory)); await exportPortableSnapshot({directory:snapshot.directory,root:input.root,retention:input.retention}); }
 }
 console.log(JSON.stringify({accepted:true}));
} catch(error) { console.log(JSON.stringify({accepted:false,reason:error.reason ?? error.message})); }
`,
  );
  const fresh = async (mode: string, path: string) => {
    const child = Bun.spawn([process.execPath, driver, mode, path], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const result = await new Response(child.stdout).text();
    const errors = await new Response(child.stderr).text();
    expect(await child.exited, errors).toBe(0);
    return JSON.parse(result);
  };
  expect(await fresh("read", snapshot.directory)).toEqual({ accepted: true });
  const cases = [
    "all-safety",
    "all-guards",
    "one-pending",
    "one-observed",
    "one-inspection",
    "all-inspections",
    "one-declaration",
    "anonymous-contradiction",
  ] as const;
  const rows: Array<{
    name: string;
    producer: boolean;
    reader: boolean;
    records: boolean;
  }> = [];
  for (const name of cases) {
    let lines = structuredClone(original).filter(({ event }) => {
      if (name === "all-safety")
        return (
          !event.type.startsWith("credential.") &&
          !(
            event.type === "model.event" && event.name.startsWith("credential_")
          )
        );
      if (name === "all-guards")
        return (
          event.type !== "credential.guard" &&
          !(event.type === "model.event" && event.name === "credential_guard")
        );
      if (name === "one-inspection")
        return event.type !== "credential.inspection" || event.callId !== first;
      if (name === "all-inspections")
        return event.type !== "credential.inspection";
      if (
        event.type === "model.event" &&
        event.name === "credential_guard" &&
        event.callId === first
      ) {
        const data = event.data;
        return !(
          data !== null &&
          typeof data === "object" &&
          "status" in data &&
          data.status ===
            (name === "one-pending"
              ? "pending"
              : name === "one-observed"
                ? "observed"
                : "")
        );
      }
      return true;
    });
    for (const { event } of lines)
      if (event.type === "model.request" && event.callId === first) {
        if (name === "one-declaration") delete event.credentialCoverage;
        if (name === "anonymous-contradiction")
          event.credentialCoverage = "none";
      }
    lines = lines.map((line, index) => ({ ...line, seq: index + 1 }));
    const directory = join(root, name);
    await mkdir(directory);
    await cp(database, join(directory, "pi.sqlite"));
    await cp(journalPath, join(directory, "capture"), { recursive: true });
    await writeFile(
      join(directory, "capture", "events.jsonl"),
      lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
    );
    await mkdir(join(directory, "datasets"));
    const source = {
      ...input,
      nativeDatabase: join(directory, "pi.sqlite"),
      journal: join(directory, "capture"),
      root: join(directory, "datasets"),
    };
    const sourceFile = join(directory, "input.json");
    await writeFile(sourceFile, JSON.stringify(source));
    const unchangedProducer = await fresh("export", sourceFile);
    expect(unchangedProducer.accepted, name).toBe(false);
    const later = openCaptureJournal(source.journal, runId, {
      spillRoots: [directory],
    });
    const spill = join(directory, "spill.txt");
    await writeFile(spill, active);
    await later.ingest({
      scope: { runId },
      name: "spill.txt",
      mediaType: "text/plain",
      path: spill,
    });
    later.capture({
      type: "artifact",
      scope: { runId },
      name: "new.txt",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode(active),
    });
    later.capture({
      type: "model.request",
      scope: { runId },
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
      scope: { runId },
      callId: "later-clean",
      outcome: "completed",
    });
    later.close();
    expect((await fresh("export", sourceFile)).accepted, name).toBe(false);
    const records = await fresh("records", sourceFile);
    expect(records.accepted, name).toBe(false);
    expect(sha256Of(await readFile(source.nativeDatabase))).toBe(
      sha256Of(await readFile(database)),
    );
    const files = new Map(held.files);
    const bytes = new TextEncoder().encode(
      lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
    );
    files.set("journal/events.jsonl", bytes);
    const run = RunDump.parse(
      JSON.parse(new TextDecoder().decode(files.get("run.json"))),
    );
    if (run.journal.status !== "captured") throw new Error("journal missing");
    run.journal.sha256 = sha256Of(bytes);
    run.journal.size = bytes.length;
    files.set("run.json", encode(run));
    const manifest = {
      ...held.manifest,
      files: held.manifest.files.map((file) => ({
        ...file,
        sha256: sha256Of(files.get(file.name)!),
        size: files.get(file.name)!.length,
      })),
    };
    const manifestBytes = encodeManifest(manifest);
    const hash = sha256Of(manifestBytes);
    const written = await writeDump({
      root: source.root,
      files,
      manifest,
      manifestBytes,
      record: { ...held.record, snapshotId: hash, manifest: hash },
    });
    const reader = await fresh("read", written.directory);
    expect(reader.accepted, name).toBe(false);
    rows.push({
      name,
      producer: unchangedProducer.accepted,
      reader: reader.accepted,
      records: records.accepted,
    });
  }
  expect(Number(await readFile(token.path + ".count", "utf8"))).toBe(1);
  await writeFile(join(root, "matrix.json"), JSON.stringify(rows, null, 2));
  console.log(
    JSON.stringify({
      sourceCoverageFixture: root,
      rows: rows.length,
      httpRequests: 2,
      leases: 1,
    }),
  );
}, 120000);

test("native code without model generation stays complete while native-only assistants disclose absent wire history", async () => {
  const { createModels } = await import("@earendil-works/pi-ai");
  const { fauxAssistantMessage } =
    await import("@earendil-works/pi-ai/providers/faux");
  const { UsageDoc } = await import("@earendil-works/pi-durable");
  const { Effect } = await import("effect");
  const { readSessionDump } = await import("@neuve/harness/session-dump");
  const root = await mkdtemp(join(tmpdir(), "native-coverage-"));
  const runId = "native-coverage";
  const source = join(root, "channel");
  const database = join(source, "pi.sqlite");
  const journal = openCaptureJournal(join(source, "capture"), runId);
  using authority = captureAuthority(source);
  const harness = await Harness.open(
    await openNodeSqliteStorage(database),
    { models: createModels(), registry: createRegistry() },
    context,
  );
  try {
    const conversation = await harness.createConversation(
      { ownership: { kind: "ownerless" } },
      context,
    );
    await conversation.commit(
      (tx) =>
        tx.appendEntry(conversation.id, {
          kind: "local-code",
          data: { result: "safe native code" },
        }),
      context,
    );
    journal.capture({
      type: "run.start",
      scope: { runId },
      runKind: "coding",
      sourceRevision: "synthetic",
      route: "local",
      pricing: "subscription",
    });
    journal.capture({
      type: "session.bind",
      scope: { runId, conversationId: conversation.id },
    });
    journal.capture({ type: "run.end", scope: { runId }, status: "completed" });
    journal.close();
    await mkdir(join(root, "datasets"));
    const input = {
      credentialInspection: authority.inspection,
      runId,
      journal: journal.directory,
      nativeDatabase: database,
      root: join(root, "datasets"),
      retention: { policy: "native coverage" },
    };
    const code = await Effect.runPromise(
      readSessionDump((await exportSnapshot(input)).directory),
    );
    expect(code.run.complete).toBe(true);
    expect(code.sessions[0]!.turns).toEqual([]);
    const message = fauxAssistantMessage("safe native assistant");
    await conversation.commit(async (tx) => {
      await tx.appendEntry(conversation.id, {
        kind: "pi.assistant",
        data: {},
        model: [message],
      });
      const ledger = await tx.doc(UsageDoc, conversation.id);
      ledger.models[`${message.provider}/${message.model}`] = message.usage;
    }, context);
    const native = await Effect.runPromise(
      readSessionDump((await exportSnapshot(input)).directory),
    );
    expect(native.run.complete).toBe(false);
    expect(native.run.gaps.map((gap) => gap.code)).toContain(
      "turns-uncaptured",
    );
    expect(native.sessions[0]!.turns[0]!.callId).toBeNull();
    expect(native.sessions[0]!.turns[0]!.cost.recorded.status).toBe("unknown");
  } finally {
    await harness.close(context);
  }
});
