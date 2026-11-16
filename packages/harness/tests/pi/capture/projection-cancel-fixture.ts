import { mock } from "bun:test";
import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { inspectionFilesystemProbe } from "./inspection-filesystem-probe.ts";

const filesystem = inspectionFilesystemProbe(0.0235);
const safety = { ...(await import("../../../src/pi/capture/safety.ts")) };
const { InspectionBudget } =
  await import("../../../src/pi/capture/credential-detectors.ts");
const { readCaptureJournal } =
  await import("../../../src/pi/capture/journal.ts");
const controller = new AbortController();
let activeBudget: InstanceType<typeof InspectionBudget> | undefined;
mock.module("../../../src/pi/capture/safety.ts", () => ({
  ...safety,
  closeInspectionBudget: () =>
    (activeBudget = new InspectionBudget(
      safety.closeInspectionBudget().limits,
      AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
    )),
}));
const root = process.argv[2];
if (!root) throw new Error("synthetic case root missing");
let jobs = 0;
const cancelAt = Number(process.argv[3] ?? 2);
let certifiedAtCancellation = false;
const original = Worker.prototype.postMessage;
Worker.prototype.postMessage = function (
  this: Worker,
  ...args: Parameters<typeof original>
) {
  if (++jobs === cancelAt) {
    const journal = readCaptureJournal(
      join(root, ".git/neuve/runs/01HQ0000000000000000000000/capture"),
    );
    certifiedAtCancellation =
      journal._tag === "Read" &&
      journal.lines.some(
        (line) =>
          line.event.type === "credential.inspection" &&
          line.event.version === 3 &&
          line.event.safe,
      );
    if (process.argv[4] === "budget") {
      if (activeBudget === undefined) throw new Error("close budget missing");
      try {
        activeBudget.charge("units", activeBudget.limits.units + 1);
      } catch {
        /* Mark exhaustion before the worker reply is charged. */
      }
    } else controller.abort();
  }
  return original.apply(this, args);
};
filesystem.start();
try {
  const { keepaliveFixture } = await import("./keepalive-fixture.ts");
  console.log(
    JSON.stringify({
      ...(await keepaliveFixture(root, "projection-cancelled")),
      jobs,
      certifiedAtCancellation,
      filesystem: filesystem.stop(),
    }),
  );
} finally {
  Worker.prototype.postMessage = original;
}
