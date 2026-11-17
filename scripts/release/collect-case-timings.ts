// Usage: bun scripts/release/collect-case-timings.ts <downloaded GitHub job logs...>
// Prints the per-runner census and refreshes the installer estimates from passing cases.
import { resolve } from "node:path";

const logs = Bun.argv.slice(2);
if (logs.length === 0) throw new Error("Provide GitHub job log paths");
const output = resolve(
  import.meta.dir,
  "../../tests/release/installer-case-timings.json",
);
const estimates: Record<string, number> = await Bun.file(output).json();
console.log("log\tdistribution_ms\tsystemd_ms\tmeasured_cases");
for (const log of logs) {
  let file = "";
  let distribution = 0;
  let systemd = 0;
  let count = 0;
  for (const line of (await Bun.file(log).text()).split("\n")) {
    const header = line.match(/tests\/release\/([^:]+\.test\.ts):/);
    if (header) file = header[1]!;
    if (file !== "distribution.test.ts" && file !== "systemd-installer.test.ts")
      continue;
    const result = line.match(/\(pass\) (.*?) \[([\d.]+)ms\]/);
    if (!result) continue;
    const name = result[1]!.replace(/^native release distribution .*? > /, "");
    const milliseconds = Math.round(Number(result[2]));
    estimates[name] = milliseconds;
    count++;
    if (file === "distribution.test.ts") distribution += milliseconds;
    else systemd += milliseconds;
  }
  console.log(`${log}\t${distribution}\t${systemd}\t${count}`);
}
await Bun.write(
  output,
  JSON.stringify(
    Object.fromEntries(
      Object.entries(estimates).sort(([a], [b]) => a.localeCompare(b)),
    ),
    null,
    2,
  ) + "\n",
);
