import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SourceOwnership } from "../../../src/pi/source-ownership.ts";
import { createPrivateInspection } from "../../../src/pi/capture/private-inspection.ts";
import {
  CredentialEpochId,
  InspectionBudget,
  type CredentialSource,
} from "../../../src/pi/capture/credential-detectors.ts";
import { closeInspectionBudget } from "../../../src/pi/capture/safety.ts";

const root = process.argv[2];
if (!root) throw new Error("synthetic root missing");
const source = join(root, "source");
mkdirSync(source, { mode: 0o700 });
const ownership = SourceOwnership.acquire(source);
const authority = createPrivateInspection({
  ownership,
  source,
  directory: join(root, "authority"),
  excludedRoots: [source],
});
try {
  for (const epoch of ["original", "current"]) {
    const result = await authority.register({
      epoch: CredentialEpochId.parse(epoch),
      headers: new Headers({ authorization: `Bearer synthetic-${epoch}` }),
      budget: new InspectionBudget(),
    });
    if (result.status !== "registered")
      throw new Error("synthetic registration failed");
  }
  let count = Number(process.argv[3] ?? 0);
  if (count === 0) {
    const sample = new InspectionBudget();
    const start = performance.now();
    for (let i = 0; i < 5000; i++) {
      const r = await authority.inspectText({
        text: `safe-sample-${i}`,
        budget: sample,
      });
      if (r.status !== "complete")
        throw new Error("synthetic calibration refused");
    }
    count = Math.min(
      400000,
      Math.max(10000, Math.ceil((40000 / (performance.now() - start)) * 5000)),
    );
  }
  const sources: ReadonlyArray<CredentialSource> = Array.from(
    { length: count },
    (_, i) => ({ kind: "text", text: `safe-record-${i}` }),
  );
  const budget = closeInspectionBudget();
  const start = performance.now();
  let inspected = 0,
    refusal: string | undefined;
  if (typeof authority.inspectSources === "function") {
    const r = await authority.inspectSources({
      sources,
      requiredEpochs: ["original", "current"],
      budget,
    });
    if (r.status === "unavailable") refusal = r.reason;
    else {
      inspected = r.results.length;
      if (
        r.results.some(
          (r) =>
            r.status !== "complete" ||
            r.matches.length !== 0 ||
            r.epochs.length !== 2,
        )
      )
        throw new Error("synthetic batch incomplete");
    }
  } else {
    for (const source of sources) {
      if (source.kind !== "text") throw new Error("fixture type");
      const r = await authority.inspectText({ text: source.text, budget });
      if (r.status !== "complete") {
        refusal = r.reason;
        break;
      }
      if (r.matches.length || r.epochs.length !== 2)
        throw new Error("synthetic history changed");
      inspected++;
    }
  }
  console.log(
    JSON.stringify({
      count,
      inspected,
      refusal: refusal ?? null,
      elapsedMs: performance.now() - start,
      usage: budget.usage,
    }),
  );
} finally {
  authority.close();
  ownership.release();
}
