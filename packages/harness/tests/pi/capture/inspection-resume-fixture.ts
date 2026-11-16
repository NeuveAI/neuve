import { mock } from "bun:test";
import * as threads from "node:worker_threads";
import { randomBytes } from "node:crypto";
import {
  CredentialDetectors,
  CredentialEpochId,
  InspectionBudget,
  DEFAULT_INSPECTION_LIMITS,
} from "../../../src/pi/capture/credential-detectors.ts";

const workers: threads.Worker[] = [];
class TrackedWorker extends threads.Worker {
  constructor(...args: ConstructorParameters<typeof threads.Worker>) {
    super(...args);
    workers.push(this);
  }
}
mock.module("node:worker_threads", () => ({
  ...threads,
  Worker: TrackedWorker,
}));
const { inspectInventory } =
  await import("../../../src/pi/capture/inspection-pool.ts");
const key = randomBytes(32);
const engine = CredentialDetectors.empty(key);
await engine.register({
  epoch: CredentialEpochId.parse("synthetic-epoch"),
  headers: new Headers({ authorization: "Bearer synthetic-value" }),
  budget: new InspectionBudget(),
});
const state = engine.encodePrivate();
const controller = new AbortController();
const { promise: entered, resolve: enter } = Promise.withResolvers<void>();
const { promise: gate, resolve: resume } = Promise.withResolvers<void>();
try {
  const pending = inspectInventory({
    engine,
    key,
    state,
    width: 4,
    budget: new InspectionBudget(DEFAULT_INSPECTION_LIMITS, controller.signal),
    requiredEpochs: ["synthetic-epoch"],
    observe() {},
    produce: async (consume) => {
      for (let i = 0; i < 4; i++)
        await consume({ kind: "text", text: "synthetic pending input" });
      enter();
      await gate;
    },
  });
  await entered;
  controller.abort();
  const refused = await pending.then(
    () => false,
    () => true,
  );
  const beforeResume = workers.length;
  resume();
  // Let the interrupted producer return and attempt its final flush.
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
  console.log(
    JSON.stringify({ refused, beforeResume, afterResume: workers.length }),
  );
} finally {
  resume();
  await Promise.all(workers.map((worker) => worker.terminate()));
  engine.destroy();
  key.fill(0);
  state.fill(0);
}
