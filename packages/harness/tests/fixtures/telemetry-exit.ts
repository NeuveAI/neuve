import { storeLocationIn } from "@neuve/records-core";
import { openRunLog, enqueueTelemetry } from "../../src/run-log.ts";
const [directory, mode] = Bun.argv.slice(2);
if (!directory) throw new Error("Missing fixture directory");
const log = openRunLog(storeLocationIn(directory), "r");
enqueueTelemetry(log, { type: "model.call.start", call: "c" });
enqueueTelemetry(log, {
  type: "model.call",
  call: "c",
  finishReason: "aborted",
});
if (mode === "kill") process.kill(process.pid, "SIGKILL");
if (mode === "exit") process.exit(0);
if (mode === "failure") throw new Error("synthetic fixture failure");
