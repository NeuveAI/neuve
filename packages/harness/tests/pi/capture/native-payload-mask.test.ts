// Why: custom native payloads may use the same keys as pi's envelope. Masking by key alone
// leaked identities in task input, entry data and document values; this crosses SQLite and Records.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  Harness,
  createRegistry,
  defineDoc,
  defineExtension,
  defineTask,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { storeLocationIn } from "@neuve/records-core";
import {
  captureRunDump,
  readCapturedDump,
} from "../../../src/pi/capture/export.ts";
import { openCaptureJournal } from "../../../src/pi/capture/journal.ts";
import { MODEL, route, scanCaptures, runIn, value } from "./fixture.ts";

const directory = mkdtempSync(join(tmpdir(), "harness-native-mask-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const context = BACKGROUND_CONTEXT;
const raw = {
  name: "ann@example.com",
  type: "thinking",
  thinking: "ann@example.com",
  encrypted_content: "ann@example.com",
  model: "ann@example.com",
  status: "ann@example.com",
  id: "ann@example.com",
  taskId: "ann@example.com",
  nested: { role: "ann@example.com", phase: "ann@example.com" },
};
const sanitized = {
  name: "<email>",
  type: "thinking",
  thinking: "<email>",
  encrypted_content: "<email>",
  model: "<email>",
  status: "<email>",
  id: "<email>",
  taskId: "<email>",
  nested: { role: "<email>", phase: "<email>" },
};
const PayloadDoc = defineDoc({
  kind: "capture.payload",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ ...raw }),
});
type Input = { held: boolean; name: string; payload: typeof raw };
const PayloadTask = defineTask<
  Input,
  { phase: "capture"; payload: typeof raw },
  typeof raw
>({
  name: "capture.payload",
  version: 1,
  initial: ({ payload }) => ({ phase: "capture", payload }),
  phases: {
    capture: async (task, runtime, ctx) => {
      if (task.input.held) await runtime.sleep(runtime.now() + 60_000, ctx);
      await runtime.commit(
        async () => ({
          status: "terminal",
          outcome: { status: "completed", result: task.input.payload },
        }),
        ctx,
      );
    },
  },
  abort: async (_task, runtime, ctx) => {
    await runtime.commit(
      async () => ({ status: "terminal", outcome: { status: "aborted" } }),
      ctx,
    );
  },
});
const PayloadExtension = defineExtension({
  name: "capture.extension",
  tasks: [PayloadTask],
});

test("native payloads mask protocol-looking keys without changing task, entry or agent identities", async () => {
  const runId = "NATIVE_PAYLOAD_MASK";
  const journal = openCaptureJournal(join(directory, "journal"), runId);
  const registry = createRegistry();
  registry.install(PayloadExtension);
  const database = join(directory, "pi.sqlite");
  const harness = await Harness.open(
    await openNodeSqliteStorage(database),
    { registry, models: route(journal.capture, { runId }).models },
    context,
  );
  const root = await harness.root(context, {
    agent: {
      model: MODEL,
      extensions: [PayloadExtension],
      instructions: "ann@example.com",
    },
  });
  const entry = await root.commit(async (tx) => {
    await tx.doc(PayloadDoc, root.id);
    return tx.appendEntry(root.id, { kind: "capture.payload", data: raw });
  }, context);
  const completed = await root.commit(
    (tx) =>
      tx.createTask(
        PayloadTask,
        { held: false, name: raw.name, payload: raw },
        { ownership: { kind: "conversation" } },
      ),
    context,
  );
  await harness.waitForTask(completed, context);
  const compaction = await root.compact(undefined, context);
  await harness.waitForTask(compaction, context);
  const pending = await root.commit(
    (tx) =>
      tx.createTask(
        PayloadTask,
        { held: true, name: raw.name, payload: raw },
        { ownership: { kind: "conversation" } },
      ),
    context,
  );
  // Closing leaves the second task resumable, including its input and checkpoint.
  await harness.close(context);
  journal.close();

  const storage = await openNodeSqliteStorage(database);
  const location = storeLocationIn(join(directory, "records"));
  const run = runIn(location);
  try {
    const captured = value(
      await run(
        captureRunDump({
          runId,
          journal: join(directory, "journal"),
          native: { reads: storage, context },
          nativeDatabase: database,
          // These are structural tokens in the native records, not personal data.
          declared: ["capture", "pending", "terminal", "completed", "manual"],
        }),
      ),
    );
    value(await run(scanCaptures(location)));
    const dump = value(await run(readCapturedDump(captured.capture)));
    const session = dump.sessions.find(
      (session) => session.conversationId === root.id,
    )!;
    expect(
      session.entries.find(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          "id" in item &&
          item.id === entry.id,
      ),
    ).toMatchObject({
      id: entry.id,
      conversationId: root.id,
      kind: "capture.payload",
      data: sanitized,
    });
    expect(session.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: compaction,
          kind: "pi.compaction",
          input: { reason: "manual" },
          state: {
            status: "terminal",
            outcome: { status: "completed", result: {} },
          },
        }),
        expect.objectContaining({
          id: completed,
          kind: "capture.payload",
          input: { held: false, name: "<email>", payload: sanitized },
          state: {
            status: "terminal",
            outcome: { status: "completed", result: sanitized },
          },
        }),
        expect.objectContaining({
          id: pending,
          kind: "capture.payload",
          input: { held: true, name: "<email>", payload: sanitized },
          state: {
            status: expect.stringMatching(/^(pending|running)$/),
            checkpoint: { phase: "capture", payload: sanitized },
          },
        }),
      ]),
    );
    expect(session.documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "capture.payload", value: sanitized }),
        expect.objectContaining({
          kind: "pi.agent",
          value: {
            model: MODEL,
            extensions: ["capture.extension"],
            instructions: "<email>",
          },
        }),
      ]),
    );
    expect(JSON.stringify(session)).not.toContain("example.com");
    const original = await storage.entry(entry.id, context);
    expect(original?.entry.data).toEqual(raw);
    expect((await storage.task(completed, context))?.input).toEqual({
      held: false,
      name: raw.name,
      payload: raw,
    });
    expect((await storage.task(pending, context))?.input).toEqual({
      held: true,
      name: raw.name,
      payload: raw,
    });
    expect(dump.run.backup.status).toBe("captured");
  } finally {
    await storage.close(context);
  }
});
