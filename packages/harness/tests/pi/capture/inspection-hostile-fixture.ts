import { mock } from "bun:test";
import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { readCaptureJournal } from "../../../src/pi/capture/journal.ts";
import { Job } from "../../../src/pi/capture/inspection-protocol.ts";
const actualPool = {
  ...(await import("../../../src/pi/capture/inspection-pool.ts")),
};
mock.module("../../../src/pi/capture/inspection-pool.ts", () => ({
  ...actualPool,
  inspectInventory: (
    input: Parameters<typeof actualPool.inspectInventory>[0],
  ) => actualPool.inspectInventory({ ...input, width: 4 }),
}));
const { PrivateInspection } =
  await import("../../../src/pi/capture/private-inspection.ts");
const root = process.argv[2];
const variant = process.argv[3];
if (!root) throw new Error("synthetic root missing");
const epochs = new Set<string>();
const register = PrivateInspection.prototype.register;
PrivateInspection.prototype.register = async function (input) {
  epochs.add(input.epoch);
  return register.call(this, input);
};
const original = Worker.prototype.postMessage;
const workers = new Set<Worker>();
const exited = new Set<Worker>();
let replies = 0;
Worker.prototype.postMessage = function (
  this: Worker,
  ...args: Parameters<typeof original>
) {
  if (!workers.has(this)) {
    workers.add(this);
    this.once("exit", () => exited.add(this));
  }
  const parsed = Job.safeParse(args[0]);
  if (!parsed.success) return original.apply(this, args);
  const job = parsed.data;
  replies++;
  if (variant === "crash") {
    void this.terminate();
    return;
  }
  const results = job.sources.map((source) => ({
    identity: source.identity,
    result: { status: "complete", epochs: [...epochs], matches: [] },
  }));
  const reply = {
    type: "done",
    id: job.id,
    results,
    usage: {
      units: 0,
      fullChecks: 0,
      fullBytes: 0,
      matches: 0,
      parseUnits: 0,
      decodeUnits: 0,
    },
  };
  queueMicrotask(() => {
    if (variant === "foreign-observation") {
      this.emit("message", {
        type: "observed",
        id: job.id,
        epoch: "synthetic-foreign",
      });
      return;
    }
    if (variant === "observed-then-hostile")
      this.emit("message", {
        type: "observed",
        id: job.id,
        epoch: [...epochs][0],
      });
    if (variant === "wrong-id") reply.id++;
    if (variant === "wrong-identity" || variant === "observed-then-hostile")
      for (const item of results) item.identity = "0".repeat(64);
    if (variant === "foreign-result")
      for (const item of results) item.result.epochs = ["synthetic-foreign"];
    if (variant === "over-lease") reply.usage.units = job.limits.units + 1;
    if (variant === "missing-result") results.pop();
    this.emit(
      "message",
      variant === "malformed"
        ? { ...reply, private: "synthetic-private-response" }
        : reply,
    );
  });
};
try {
  const { keepaliveFixture } = await import("./keepalive-fixture.ts");
  const result = await keepaliveFixture(root, "hostile-worker");
  const journal = readCaptureJournal(
    join(root, ".git/neuve/runs/01HQ0000000000000000000000/capture"),
  );
  if (journal._tag !== "Read") throw new Error("synthetic journal unavailable");
  console.log(
    JSON.stringify({
      ...result,
      replies,
      joined: workers.size === exited.size,
      certificates: journal.lines.filter(
        (line) => line.event.type === "credential.inspection",
      ).length,
      exposed: journal.lines.some(
        (line) =>
          line.event.type === "credential.guard" &&
          line.event.status === "exposed",
      ),
    }),
  );
} finally {
  Worker.prototype.postMessage = original;
  PrivateInspection.prototype.register = register;
  await Promise.all([...workers].map((worker) => worker.terminate()));
}
