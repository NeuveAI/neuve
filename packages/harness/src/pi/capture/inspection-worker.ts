import { relayChargedProgress } from "./progress-relay.ts";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import {
  CredentialDetectors,
  CredentialJson,
  InspectionBudget,
  inspectionFailure,
  type CredentialEpochId,
} from "./credential-detectors.ts";
import { Job, Recognition } from "./inspection-protocol.ts";

export const runInspectionWorker = () => {
  if (isMainThread || parentPort === null) return;
  const parsedRecognition = Recognition.safeParse(workerData);
  if (!parsedRecognition.success) return;
  const port = parentPort;
  const recognition = parsedRecognition.data;
  let engine: CredentialDetectors | undefined;
  let busy = false;
  let expected = 1;
  port.on("message", async (raw: unknown) => {
    if (
      raw !== null &&
      typeof raw === "object" &&
      "type" in raw &&
      raw.type === "close"
    ) {
      engine?.destroy();
      recognition.key.fill(0);
      recognition.state.fill(0);
      port.postMessage({ type: "closed" });
      port.close();
      return;
    }
    const parsed = Job.safeParse(raw);
    if (!parsed.success || busy || parsed.data.id !== expected) {
      port.close();
      return;
    }
    busy = true;
    const job = parsed.data;
    const observed = new Set<CredentialEpochId>();
    const budget = new InspectionBudget(
      job.limits,
      undefined,
      performance.now() + Math.max(0, job.deadlineEpochMs - Date.now()),
    );
    const reportProgress = relayChargedProgress((units) =>
      port.postMessage({ type: "progress", id: job.id, units }),
    );
    budget.onProgress = () =>
      reportProgress(
        Object.values(budget.usage).reduce((sum, n) => sum + n, 0),
      );
    budget.onExposure = (epoch) => {
      if (observed.has(epoch)) return;
      observed.add(epoch);
      port.postMessage({ type: "observed", id: job.id, epoch });
    };
    const results = [];
    try {
      if (engine === undefined) {
        engine = CredentialDetectors.restorePrivate(
          recognition.key,
          recognition.state,
          budget,
        );
        recognition.key.fill(0);
        recognition.state.fill(0);
      }
      for (const item of job.sources) {
        const source = item.source;
        let result;
        try {
          result =
            source.kind === "json"
              ? await engine.inspectJson({
                  json: CredentialJson.parse(source.text).source,
                  budget,
                })
              : source.kind === "text"
                ? await engine.inspectText({ text: source.text, budget })
                : await engine.inspectArtifact({
                    bytes: source.bytes,
                    mediaType: source.mediaType,
                    budget,
                  });
        } catch (error) {
          result = inspectionFailure(error, [...observed]);
        }
        results.push({ identity: item.identity, result });
      }
    } catch (error) {
      for (const item of job.sources)
        results.push({
          identity: item.identity,
          result: inspectionFailure(error, [...observed]),
        });
    }
    busy = false;
    expected++;
    port.postMessage({
      type: "done",
      id: job.id,
      results,
      usage: budget.usage,
      exhausted: budget.exhausted,
    });
  });
  port.on("close", () => {
    engine?.destroy();
    recognition.key.fill(0);
    recognition.state.fill(0);
  });
};
