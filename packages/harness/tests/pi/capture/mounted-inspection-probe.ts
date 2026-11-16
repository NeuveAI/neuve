import { inspectionFilesystemProbe } from "./inspection-filesystem-probe.ts";
const [root, countText = "14170", delayText = "0", preparationText = "0"] =
  process.argv.slice(2);
if (!root) throw new Error("synthetic case root missing");
const profile = inspectionFilesystemProbe(Number(delayText));
const { mkdirSync } = await import("node:fs");
const { join } = await import("node:path");
const { SourceOwnership } = await import("../../../src/pi/source-ownership.ts");
const { createPrivateInspection } =
  await import("../../../src/pi/capture/private-inspection.ts");
const { CredentialEpochId, InspectionBudget } =
  await import("../../../src/pi/capture/credential-detectors.ts");
const { closeInspectionBudget } =
  await import("../../../src/pi/capture/safety.ts");
const source = join(root, ".git/neuve/runs/synthetic");
mkdirSync(source, { recursive: true, mode: 0o700 });
mkdirSync(join(root, ".git/neuve/credential-inspections"), {
  recursive: true,
  mode: 0o700,
});
const ownership = SourceOwnership.acquire(source);
const authority = createPrivateInspection({
  ownership,
  source,
  directory: join(root, ".git/neuve/credential-inspections/synthetic"),
  excludedRoots: [source, "/tmp"],
});
try {
  const registered = await authority.register({
    epoch: CredentialEpochId.parse("original"),
    headers: new Headers({ authorization: "Bearer synthetic-original" }),
    budget: new InspectionBudget(),
  });
  if (registered.status !== "registered")
    throw new Error("synthetic registration failed");
  const sources = Array.from({ length: Number(countText) }, (_, i) => ({
    kind: "text" as const,
    text: `safe-record-${i}`,
  }));
  const budget = closeInspectionBudget();
  const started = performance.now();
  await Bun.sleep(Number(preparationText));
  profile.start();
  const result = await authority.inspectSources({
    sources,
    requiredEpochs: ["original"],
    budget,
  });
  const filesystem = profile.stop();
  const elapsedMs = performance.now() - started;
  if (
    result.status === "inspected" &&
    result.results.some(
      (r) =>
        r.status !== "complete" ||
        r.matches.length ||
        r.epochs.join() !== "original",
    )
  )
    throw new Error("synthetic inspection invalid");
  console.log(
    JSON.stringify({
      count: sources.length,
      inspected:
        result.status === "inspected" ? result.results.length : result.record,
      refusal: result.status === "unavailable" ? result.reason : null,
      elapsedMs,
      preparationMs: Number(preparationText),
      filesystem,
      usage: budget.usage,
    }),
  );
} finally {
  authority.close();
  ownership.release();
}
