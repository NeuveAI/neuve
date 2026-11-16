import { writeSync } from "node:fs";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { openCaptureJournal } from "../../src/pi/capture/journal.ts";

const [database, journalPath, runId] = process.argv.slice(2);
if (!database || !journalPath || !runId)
  throw new Error("missing capture fixture paths");
const storage = await openNodeSqliteStorage(database, {
  walAutoCheckpointPages: 0,
});
const harness = await Harness.open(
  storage,
  { registry: createRegistry(), models: createModels() },
  context,
);
await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
const journal = openCaptureJournal(journalPath, runId);
journal.capture({ type: "run.end", scope: { runId }, status: "completed" });
journal.close();
writeSync(
  1,
  JSON.stringify({ event: "pi.writer-exited-without-close", conversations: 1 }),
);
// SIGKILL skips runtime destructors as well as Harness.close, preserving committed WAL frames.
process.kill(process.pid, "SIGKILL");
