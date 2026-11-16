// The real pi adapter and journal guard the publication boundary without a network listener.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SOL_ROUTE } from "../../../src/route.ts";
import { SourceOwnership } from "../../../src/pi/source-ownership.ts";
import { createPrivateInspection } from "../../../src/pi/capture/private-inspection.ts";
import {
  CredentialEpochId,
  CredentialJson,
  InspectionBudget,
} from "../../../src/pi/capture/credential-detectors.ts";
import { openCaptureJournal } from "../../../src/pi/capture/journal.ts";
import { createRouteModels } from "../../../src/pi/providers/agent-route-provider.ts";
import {
  created,
  completed,
  functionCallItem,
  messageItem,
  sse,
  tokenCommand,
} from "./fixture.ts";

for (const kind of ["text", "tool"] as const) {
  // An earlier credential echoed across deltas must be labelled before pi sees it.
  test(`${kind} split credential is observed before publication and absent from the journal`, async () => {
    const root = mkdtempSync(join(tmpdir(), "credential-stream-"));
    const source = join(root, "source");
    mkdirSync(source, { mode: 0o700 });
    const ownership = SourceOwnership.acquire(source);
    const authority = createPrivateInspection({
      ownership,
      source,
      directory: join(root, "private"),
      excludedRoots: [source],
    });
    const journal = openCaptureJournal(join(source, "journal"), "stream");
    const key = "synthetic-historical-echo";
    let observed = false;
    try {
      expect(
        (
          await authority.register({
            epoch: CredentialEpochId.parse("earlier"),
            headers: new Headers({ "x-api-key": key }),
            budget: new InspectionBudget(),
          })
        ).status,
      ).toBe("registered");
      const text = kind === "text" ? key : JSON.stringify({ path: key });
      const items =
        kind === "text"
          ? messageItem(0, "item", "final_answer", text)
          : functionCallItem(0, {
              id: "item",
              callId: "tool",
              name: "read",
              arguments: text,
            });
      const delta = items[1];
      if (delta === undefined) throw new Error("fixture missing delta");
      const split = text.indexOf("historical") + 4;
      const frames = [
        created("response"),
        items[0]!,
        { ...delta, delta: text.slice(0, split) },
        { ...delta, delta: text.slice(split) },
        items[2]!,
        completed("response"),
      ];
      const syntheticFetch = Object.assign(async () => sse(frames), {
        preconnect: () => undefined,
      });
      const models = createRouteModels({
        route: SOL_ROUTE,
        runId: "stream",
        sessionAffinity: "stream",
        auth: { tokenCommand: tokenCommand(root, "lease").path },
        fetch: syntheticFetch,
        credentialInspection: authority,
        capture: (event) => {
          journal.capture(event);
          if (
            event.type === "credential.guard" &&
            event.callId === "earlier" &&
            event.status === "exposed"
          )
            observed = true;
        },
      });
      const model = models.getModel("openai", SOL_ROUTE.model);
      if (model === undefined) throw new Error("fixture model missing");
      const stream = models.stream(model, {
        messages: [{ role: "user", content: "Continue.", timestamp: 1 }],
      });
      let published = 0;
      let observedAtPublication = true;
      for await (const event of stream) {
        const message =
          event.type === "done"
            ? event.message
            : event.type === "error"
              ? event.error
              : event.partial;
        if (JSON.stringify(message).includes(key)) {
          observedAtPublication &&= observed;
          published++;
        }
      }
      const result = await stream.result();
      expect(result.stopReason).toBe(kind === "text" ? "stop" : "toolUse");
      expect(published).toBeGreaterThan(0);
      expect(observedAtPublication).toBe(true);
      expect(observed).toBe(true);
      expect(
        readFileSync(join(journal.directory, "events.jsonl"), "utf8"),
      ).not.toContain(key);
    } finally {
      journal.close();
      authority.close();
      ownership.release();
      rmSync(root, { recursive: true, force: true });
    }
  });
}
