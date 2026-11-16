import { dirname } from "node:path";
import { Effect } from "effect";
import {
  JobQueue,
  Computations,
  Worker,
  storeLocationIn,
} from "@neuve/records-core";
import { captureScanHandler } from "@neuve/harness/session-dump";
import {
  runIn,
  value,
} from "../../../../packages/harness/tests/pi/capture/fixture.ts";
const location = storeLocationIn(dirname(process.argv[2] ?? ""));
const result = value(
  await runIn(location)(
    Worker.run({
      location,
      idleTimeout: "100 millis",
      pollInterval: "10 millis",
      handlers: {
        "capture.scan": captureScanHandler({
          location,
          command: [process.execPath, "--no-env-file", process.argv[3] ?? ""],
        }),
      },
    }).pipe(Effect.provide(JobQueue.layer), Effect.provide(Computations.layer)),
  ),
);
console.log(JSON.stringify({ workerExit: result.reason }));
