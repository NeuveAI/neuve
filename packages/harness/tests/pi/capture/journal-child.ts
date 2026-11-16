// A journal session in its own process, for the cases only a real process can show: a write the
// disk refuses (run under a file-size limit) and a crash mid-stream (killed with SIGKILL). Run by
// journal.test.ts and journal-descriptor.test.ts; it prints one JSON line of observations.
import { statSync } from "node:fs";
import { join } from "node:path";
import {
  JOURNAL_FILE,
  openCaptureJournal,
} from "../../../src/pi/capture/journal.ts";

const [mode, folder] = process.argv.slice(2);
if (folder === undefined)
  throw new Error("usage: journal-child.ts <mode> <folder>");
const path = join(folder, JOURNAL_FILE);
const runId = "R";
const outcome = (run: () => void) => {
  try {
    run();
    return "kept";
  } catch (error) {
    const { kind, event } = error as { kind?: string; event?: string };
    return `${kind}:${event}`;
  }
};

const journal = openCaptureJournal(folder, runId);
journal.capture({
  type: "run.start",
  scope: { runId },
  runKind: "scored",
  sourceRevision: "abc123",
  route: "chatgpt",
  pricing: "subscription",
});

if (mode === "refuse") {
  // One line larger than the size limit the parent set: the disk takes what fits, then refuses.
  const before = statSync(path).size;
  const refused = outcome(() =>
    journal.capture({
      type: "model.request",
      scope: { runId },
      callId: "c1",
      route: "chatgpt",
      provider: "openai",
      model: "fixture",
      credentialCoverage: "none",
      headerNames: [],
      body: { status: "sent", json: { input: "x".repeat(65_536) } },
    }),
  );
  const afterRefusal = statSync(path).size;
  const next = outcome(() =>
    journal.capture({ type: "run.end", scope: { runId }, status: "completed" }),
  );
  const closed = outcome(() => journal.close());
  console.log(
    JSON.stringify({
      before,
      refused,
      afterRefusal,
      next,
      closed,
      afterClose: statSync(path).size,
    }),
  );
} else if (mode === "stream") {
  // Streams calls until it is killed; the parent kills it once the file has grown.
  for (let call = 0; ; call++) {
    const callId = `c${call}`;
    journal.capture({
      type: "model.request",
      scope: { runId },
      callId,
      route: "chatgpt",
      provider: "openai",
      model: "fixture",
      credentialCoverage: "none",
      headerNames: [],
      body: { status: "sent", json: { input: "x".repeat(call % 4_000) } },
    });
    for (let event = 0; event < 50; event++)
      journal.capture({
        type: "model.event",
        scope: { runId },
        callId,
        name: "response.output_text.delta",
        data: { delta: "y".repeat(event * 40) },
      });
    journal.capture({
      type: "model.end",
      scope: { runId },
      callId,
      outcome: "completed",
    });
  }
} else throw new Error(`unknown mode ${mode}`);
