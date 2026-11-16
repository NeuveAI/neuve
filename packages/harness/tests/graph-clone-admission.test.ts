import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { graphClone } from "../src/graph-search.ts";
import { CpuWork, cpuKeyedPool, cpuPool } from "../src/budget/cpu.ts";
import { Scheduler } from "../src/budget/scheduler.ts";

// Why: a keyed pool claims before admission, and cloning must acquire exactly once inside ownership.
for (const inherited of [false, true])
  test(`Graph clone admits CPU once, inherited=${inherited}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "clone-admission-"));
    try {
      const repository = join(root, "repo");
      expect(Bun.spawnSync(["git", "init", "-q", repository]).exitCode).toBe(0);
      const budget = new Scheduler(2, 1, 4);
      const admit = budget.admit.bind(budget);
      let admissions = 0;
      budget.admit = (...args) => {
        admissions++;
        return admit(...args);
      };
      const work = cpuKeyedPool("precompute.graph-and-keyword", 2, () =>
        graphClone(repository, {
          executable: "unused",
          workDirectory: join(root, "work"),
        }),
      );
      const clone = await Effect.runPromise(
        (inherited ? cpuPool("preparation", 1, () => work) : work).pipe(
          Effect.provideService(CpuWork, {
            budget,
            priority: { class: "interactive", position: "new", stage: 0 },
            inherited: false,
          }),
        ),
      );
      expect(existsSync(join(clone, ".git", "HEAD"))).toBe(true);
      expect(admissions).toBe(1);
      expect((await budget.observe()).held).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
