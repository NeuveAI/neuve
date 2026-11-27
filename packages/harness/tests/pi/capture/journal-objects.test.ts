import { captureAuthority } from "./fixture.ts";
// Why: a restricted dump must reconstruct the same calls after reopening an inline journal,
// and credential inspection must cover object bytes even when the journal holds only references.
import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { readDump } from "../../../src/pi/capture/archive.ts";
import {
  CredentialDetectors,
  CredentialEpochId,
  InspectionBudget,
} from "../../../src/pi/capture/credential-detectors.ts";
import {
  JOURNAL_FILE,
  OBJECTS_DIRECTORY,
  journalObjectFrames,
  openCaptureJournal,
  readCaptureJournal,
} from "../../../src/pi/capture/journal.ts";
import { credentialSources } from "../../../src/pi/capture/safety.ts";
import {
  CAPTURE_VERSION,
  RETAINED_SDK_PIN,
  type JournalLine,
} from "../../../src/pi/capture/types.ts";
import {
  exportPortableSnapshot,
  readSessionDump,
} from "../../../src/session-dump.ts";
import { exportWhileOpen } from "./open-source.ts";

const runId = "shared-content";
const scope = { runId };
const message = {
  role: "user",
  content: "Read the worktree. ".repeat(32),
  timestamp: 1,
};
const instructions = "Summarize findings in order. ".repeat(32);
const tools = [{ name: "read", type: "function", description: "Read a file." }];
const request = (
  callId: string,
  later = false,
): Extract<JournalLine["event"], { type: "model.request" }> => ({
  type: "model.request",
  scope,
  callId,
  route: "chatgpt",
  provider: "openai",
  model: "fixture",
  headerNames: [],
  credentialCoverage: "none",
  body: {
    status: "sent",
    json: {
      model: "fixture",
      stream: true,
      input: later
        ? [message, { role: "user", content: "Continue." }]
        : [message],
      tools,
      instructions,
    },
  },
  sdkContext: {
    version: 1,
    sdkPin: RETAINED_SDK_PIN,
    callId,
    stage: "provider-input",
    model: {
      id: "fixture",
      provider: "openai",
      api: "openai-responses",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    invocation: {
      version: 1,
      api: "openai-responses",
      options: { cacheRetention: "none" },
    },
    messages: [message],
  },
});

test("mixed journals preserve calls and restricted dumps carry only the referenced objects", async () => {
  const root = mkdtempSync(join(tmpdir(), "capture-objects-"));
  try {
    const source = join(root, "channel");
    mkdirSync(source);
    const mixed = join(source, "mixed");
    const inline = join(source, "inline");
    const nativeDatabase = join(source, "pi.sqlite");
    const storage = await openNodeSqliteStorage(nativeDatabase);
    const harness = await Harness.open(
      storage,
      { models: createModels(), registry: createRegistry() },
      context,
    );
    const conversation = await harness.root(context);
    await harness.close(context);
    mkdirSync(mixed);
    mkdirSync(inline);
    const prefix: JournalLine["event"][] = [
      { type: "journal.open", scope },
      {
        type: "run.start",
        scope,
        runKind: "coding",
        sourceRevision: {
          status: "not-applicable",
          reason: "synthetic coding run",
        },
        route: "chatgpt",
        pricing: "subscription",
      },
      {
        type: "session.bind",
        scope: { runId, conversationId: conversation.id },
      },
      request("legacy"),
      { type: "model.end", scope, callId: "legacy", outcome: "failed" },
      { type: "journal.close", scope },
    ];
    const before = prefix
      .map(
        (event, index) =>
          JSON.stringify({ v: CAPTURE_VERSION, seq: index + 1, at: 1, event }) +
          "\n",
      )
      .join("");
    writeFileSync(join(mixed, JOURNAL_FILE), before);
    const journal = openCaptureJournal(mixed, runId);
    journal.capture(request("one"));
    journal.capture(request("two", true));
    journal.capture({
      type: "model.response",
      scope,
      callId: "two",
      status: 200,
    });
    journal.capture({
      type: "model.event",
      scope,
      callId: "two",
      name: "response.created",
      data: {
        type: "response.created",
        response: {
          id: "fixture",
          status: "in_progress",
          instructions,
          tools,
          output: [],
        },
      },
    });
    journal.capture({
      type: "model.event",
      scope,
      callId: "two",
      name: "response.completed",
      data: {
        type: "response.completed",
        response: {
          id: "fixture",
          status: "completed",
          instructions,
          tools,
          output: [],
        },
      },
    });
    journal.capture({
      type: "model.event",
      scope,
      callId: "two",
      name: "sdk_invocation_end",
      data: {
        version: 1,
        callId: "two",
        callbacks: 2,
        abort: { status: "not-aborted" },
      },
    });
    journal.capture({
      type: "model.end",
      scope,
      callId: "one",
      outcome: "failed",
    });
    journal.capture({
      type: "model.end",
      scope,
      callId: "two",
      outcome: "completed",
    });
    journal.close();

    const raw = readFileSync(join(mixed, JOURNAL_FILE), "utf8");
    expect(raw.startsWith(before)).toBe(true);
    expect(raw.slice(before.length)).not.toContain(instructions);
    expect(raw.slice(before.length)).not.toContain(message.content);
    expect(readdirSync(join(mixed, OBJECTS_DIRECTORY))).toHaveLength(4);
    const captured = readCaptureJournal(mixed);
    if (captured._tag !== "Read") throw new Error(captured._tag);
    const requests = captured.lines.filter(
      ({ event }) => event.type === "model.request",
    );
    expect(requests.map(({ event }) => event)).toEqual([
      request("legacy"),
      request("one"),
      request("two", true),
    ]);
    const snapshots = captured.lines.flatMap(({ event }) =>
      event.type === "model.event" &&
      ["response.created", "response.completed"].includes(event.name)
        ? [event.data]
        : [],
    );
    expect(snapshots).toEqual([
      {
        type: "response.created",
        response: {
          id: "fixture",
          status: "in_progress",
          instructions,
          tools,
          output: [],
        },
      },
      {
        type: "response.completed",
        response: {
          id: "fixture",
          status: "completed",
          instructions,
          tools,
          output: [],
        },
      },
    ]);
    writeFileSync(
      join(inline, JOURNAL_FILE),
      captured.lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
    );

    const dataset = join(root, "datasets");
    mkdirSync(dataset);
    using authority = captureAuthority(source);
    const restricted = await Promise.all(
      [inline, mixed].map((journal) =>
        exportWhileOpen({
          credentialInspection: authority.inspection,
          runId,
          journal,
          nativeDatabase,
          root: dataset,
          retention: { policy: "test" },
        }),
      ),
    );
    const [oldDump, newDump] = await Promise.all(
      restricted.map(({ directory }) =>
        Effect.runPromise(readSessionDump(directory)),
      ),
    );
    if (!oldDump || !newDump || !restricted[0] || !restricted[1])
      throw new Error("Both dumps must restore");
    const { journal: oldStorage, ...oldRun } = oldDump.run;
    const { journal: newStorage, ...newRun } = newDump.run;
    expect(oldStorage.status).toBe("captured");
    expect(newStorage.status).toBe("captured");
    expect(newRun).toEqual(oldRun);
    expect(newDump.sessions).toHaveLength(1);
    expect(newDump.sessions).toEqual(oldDump.sessions);
    expect(newDump.unjoined).toEqual(oldDump.unjoined);
    const carried = await readDump(restricted[1].directory);
    const original = await readDump(restricted[0].directory);
    for (const name of [
      "calls/unjoined.json",
      ...newDump.run.sessions.map(({ file }) => file),
    ])
      expect(carried.files.get(name)).toEqual(original.files.get(name));
    expect(
      [...carried.files.keys()].filter((name) =>
        name.startsWith("journal/objects/"),
      ),
    ).toHaveLength(4);
    const portable = await exportPortableSnapshot({
      directory: restricted[1].directory,
      root: dataset,
      retention: { policy: "test" },
    });
    expect(
      [...(await readDump(portable.directory)).files.keys()].filter((name) =>
        name.startsWith("journal/"),
      ),
    ).toEqual([]);
    console.log(
      JSON.stringify({
        sessionFilesEqual: newDump.sessions.length,
        unjoinedCallFileEqual: true,
        restrictedJournalObjects: 4,
        portableJournalObjects: 0,
      }),
    );

    const [object] = captured.objects.keys();
    if (!object) throw new Error("Expected journal objects");
    const journalBytes = Buffer.byteLength(raw);
    const uniqueBytes = [...captured.objects.values()].reduce(
      (total, { bytes }) => total + bytes.byteLength,
      0,
    );
    expect(
      readCaptureJournal(mixed, {
        journalBytes,
        totalBytes: journalBytes + uniqueBytes - 1,
        objectBytes: 16384,
        manifestBytes: 4096,
      })._tag,
    ).toBe("Corrupt");
    unlinkSync(join(mixed, OBJECTS_DIRECTORY, object));
    expect(readCaptureJournal(mixed)._tag).toBe("Corrupt");
    const archivedObject = join(
      restricted[1].directory,
      OBJECTS_DIRECTORY,
      object,
    );
    unlinkSync(archivedObject);
    await expect(
      Effect.runPromise(readSessionDump(restricted[1].directory)),
    ).rejects.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("credential source enumeration scans the exact bytes that left the frame", async () => {
  const root = mkdtempSync(join(tmpdir(), "capture-object-inspection-"));
  const detector = CredentialDetectors.empty(Buffer.alloc(32, 7));
  try {
    const secret = "synthetic-object-only-secret";
    const epoch = CredentialEpochId.parse("registered");
    const budget = new InspectionBudget();
    const registered = await detector.register({
      epoch,
      headers: new Headers({ "x-api-key": secret }),
      budget,
    });
    expect(registered.status).toBe("registered");
    const journal = openCaptureJournal(root, runId);
    const event = request("one");
    journal.capture({
      ...event,
      body: { status: "sent", json: { instructions: secret } },
    });
    journal.close();
    const read = readCaptureJournal(root);
    if (read._tag !== "Read") throw new Error(read._tag);
    expect(readFileSync(join(root, JOURNAL_FILE), "utf8")).not.toContain(
      secret,
    );
    const sources = await credentialSources(
      { conversations: [], session: [] },
      undefined,
      read.lines,
      [],
      read.frames,
      budget,
      journalObjectFrames(read.objects),
    );
    const exposures = [];
    for (const source of sources.values()) {
      if (source.kind !== "json") continue;
      const result = await detector.inspectJson({ json: source.json, budget });
      if (result.status === "complete" && result.matches.length > 0)
        exposures.push(source.json.contents());
    }
    expect(exposures).toEqual([JSON.stringify(secret)]);
  } finally {
    detector.destroy();
    rmSync(root, { recursive: true, force: true });
  }
});
