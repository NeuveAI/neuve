import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clientBudget, hostBudget } from "../../src/budget/local.ts";
import type { Request } from "../../src/budget/scheduler.ts";

const directory = mkdtempSync(join(tmpdir(), "budget-retry-profile-"));
const count = 2_000;
const request: Request = {
  owner: "budget-retry-profile",
  priority: { class: "interactive", position: "new", stage: 0 },
  resource: { kind: "cpu", permits: 2 },
};
const budget = await clientBudget(directory);
let host: Awaited<ReturnType<typeof hostBudget>>;
try {
  const start = performance.now();
  let floor = 0;
  for (let index = 0; index < count; index++) {
    const grant = await budget.admit(request);
    if (grant.permits !== 1 || !grant.floor)
      throw new Error("Unavailable host must use the one-thread floor");
    floor++;
    await grant.release();
  }
  const elapsedMs = performance.now() - start;
  const cappedRejoin = Bun.argv.includes("--capped-rejoin");
  if (cappedRejoin) {
    // Exercise host return after repeated failures have reached the 1 s cap.
    await (await budget.admit(request)).release();
    for (const delay of [105, 205, 405, 805, 1005]) {
      await Bun.sleep(delay);
      await (await budget.admit(request)).release();
    }
  }
  host = await hostBudget({ directory, threads: 4, fixed: 4 });
  if (!host) throw new Error("Private host did not start");
  const ready = performance.now();
  let rejoinFloor = 0;
  for (;;) {
    const grant = await budget.admit(request);
    await grant.release();
    if (!grant.floor) break;
    rejoinFloor++;
    if (performance.now() - ready > 2_000)
      throw new Error("Client did not rejoin within two seconds");
    await Bun.sleep(5);
  }
  const rejoinMs = performance.now() - ready;
  const liveStart = performance.now();
  for (let index = 0; index < count; index++) {
    const grant = await budget.admit(request);
    if (grant.floor || grant.permits !== 2)
      throw new Error("Live host must grant its normal share");
    await grant.release();
  }
  const liveMs = performance.now() - liveStart;
  console.log(
    JSON.stringify({
      count,
      floor,
      elapsedMs,
      perAdmissionMs: elapsedMs / count,
      rejoinMs,
      rejoinFloor,
      cappedRejoin,
      liveMs,
      livePerAdmissionMs: liveMs / count,
    }),
  );
} finally {
  await host?.close();
  rmSync(directory, { recursive: true, force: true });
}
