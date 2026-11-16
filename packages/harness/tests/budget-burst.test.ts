// Why: hundreds of readings ask for a slot in the same instant; the accept queue holds 128.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostBudget, localBudget } from "../src/budget/local.ts";
import type { Grant } from "../src/budget/scheduler.ts";
import { reviewPriority } from "../src/pi/priority.ts";

const until = async (done: () => Promise<boolean>) => {
  for (let n = 0; n < 3_000 && !(await done()); n++) await Bun.sleep(10);
};

test("1,000 admissions in one tick all reach the host, and aborting them empties its queue", async () => {
  const directory = mkdtempSync(join(tmpdir(), "budget-burst-"));
  const host = await hostBudget({ directory, threads: 2, fixed: 8 });
  if (!host) throw new Error("scratch budget host was already claimed");
  const client = localBudget(directory);
  const abort = new AbortController();
  const granted: Grant[] = [];
  const failures: unknown[] = [];
  try {
    const admissions = Array.from({ length: 1_000 }, (_, n) =>
      client
        .admit(
          {
            owner: "run-1",
            priority: reviewPriority("assess", false, n),
            resource: { kind: "provider", account: "a".repeat(64) },
          },
          abort.signal,
        )
        .then(
          (grant) => granted.push(grant),
          (cause: unknown) => failures.push(cause),
        ),
    );
    // Four of the eight slots: a run that has not started leaves four free for its first steps.
    await until(async () => (await host.scheduler.observe()).waiting === 996);
    expect(await host.scheduler.observe()).toMatchObject({
      waiting: 996,
      providerHeld: 4,
    });
    expect(granted).toHaveLength(4);
    expect(failures).toHaveLength(0);
    abort.abort();
    await Promise.all(admissions);
    expect(failures).toHaveLength(996);
    await until(async () => (await host.scheduler.observe()).waiting === 0);
    expect((await host.scheduler.observe()).waiting).toBe(0);
  } finally {
    abort.abort();
    for (const grant of granted) await grant.release();
    await host.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
