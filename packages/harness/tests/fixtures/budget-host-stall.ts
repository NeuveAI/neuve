// A budget host in its own process. Each line on stdin blocks its event loop for 300 ms, as a host
// busy with its own review does; it says "blocking" synchronously first, so the caller knows when.
import { writeSync } from "node:fs";
import { hostBudget } from "../../src/budget/local.ts";

const directory = Bun.argv[2];
if (!directory) throw new Error("Missing the budget directory");
const host = await hostBudget({ directory, threads: 2, fixed: 8 });
if (!host) throw new Error("The scratch budget directory already has a host");
writeSync(1, "ready\n");
process.stdin.on("data", () => {
  writeSync(1, "blocking\n");
  const until = performance.now() + 300;
  while (performance.now() < until);
});
process.stdin.on("end", () => void host.close().then(() => process.exit(0)));
