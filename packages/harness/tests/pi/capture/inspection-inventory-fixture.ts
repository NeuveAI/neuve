import { join } from "node:path";
import { readCaptureJournal } from "../../../src/pi/capture/journal.ts";
import { PrivateInspection } from "../../../src/pi/capture/private-inspection.ts";
import { StopInventory } from "../../../src/pi/capture/inspection-pool.ts";
import { keepaliveFixture } from "./keepalive-fixture.ts";

const root = process.argv[2];
const variant = process.argv[3];
if (!root) throw new Error("synthetic root missing");
const original = PrivateInspection.prototype.inspectSources;
PrivateInspection.prototype.inspectSources = async function (input) {
  const produce = input.sources;
  const result = await original.call(
    this,
    variant === "unfinished" && typeof produce === "function"
      ? {
          ...input,
          sources: async (consume) => {
            await produce(async (source) => {
              await consume(source);
              throw new StopInventory();
            });
          },
        }
      : input,
  );
  return variant === "missing-result" && result.status === "inspected"
    ? { ...result, results: result.results.slice(0, -1) }
    : result;
};
try {
  const result = await keepaliveFixture(root, "projection-cancelled");
  const journal = readCaptureJournal(
    join(root, ".git/neuve/runs/01HQ0000000000000000000000/capture"),
  );
  console.log(
    JSON.stringify({
      ...result,
      certificates:
        journal._tag === "Read"
          ? journal.lines.filter(
              (line) => line.event.type === "credential.inspection",
            ).length
          : -1,
    }),
  );
} finally {
  PrivateInspection.prototype.inspectSources = original;
}
