import { expect, test } from "bun:test";
import { join } from "node:path";
import { cpuChildSettings } from "../packages/harness/src/budget/local.ts";
import { Scheduler } from "../packages/harness/src/budget/scheduler.ts";

test.skipIf(process.platform !== "darwin")(
  "macOS starts a real preparation child at nice 19, with no background class",
  async () => {
    const budget = new Scheduler(4, 4, 4);
    const priority = {
      class: "preparation",
      position: "new",
      stage: 0,
    } as const;
    const grant = await budget.admit({
      owner: "mac-preparation",
      priority,
      resource: { kind: "cpu", permits: 1 },
    });
    try {
      const settings = cpuChildSettings(grant, priority);
      const preparation = join(
        import.meta.dir,
        "../packages/harness/src/commit-prepare.ts",
      );
      const child = Bun.spawn(
        [
          ...settings.prefix,
          process.execPath,
          "-e",
          `
          import { getPriority } from "node:os";
          import { requirePreparationPriority } from ${JSON.stringify(preparation)};
          requirePreparationPriority();
          process.stdout.write(String(getPriority()));
        `,
        ],
        {
          env: { ...process.env, ...settings.env },
          stdout: "pipe",
          stderr: "ignore",
        },
      );
      expect(grant.floor).toBeFalsy();
      expect(await child.exited).toBe(0);
      // The prefix itself lowers the child to 19, so the child's own guard (10) has nothing to do.
      expect(
        Number(await new Response(child.stdout).text()),
      ).toBeGreaterThanOrEqual(19);
      expect(settings.prefix).toEqual(["/usr/bin/nice", "-n", "19"]);
    } finally {
      await grant.release();
    }
    expect((await budget.observe()).held).toBe(0);
  },
  // The limit ends a hang only: a nice-19 child on a busy machine is not one.
  30_000,
);
