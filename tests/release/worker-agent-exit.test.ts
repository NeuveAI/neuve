import { expect, test } from "bun:test";
import { resolve } from "node:path";
import * as Systemd from "../../packages/records-core/src/systemd.ts";

// Exercise the Linux CLI arm on either host. Another identified prefix is a successful no-op.
for (const outcome of [
  Systemd.FOREIGN,
  Systemd.UNSAFE,
  Systemd.ROLLBACK_REFUSED,
  Systemd.otherOwnerMessage("/another/install"),
  "missing-manager",
  "Removed the systemd timer for this install.",
  "There's no /scratch/systemd/user/dev.neuve.worker.service, so there was nothing to remove.",
])
  test(`Linux uninstall-agent exit status: ${outcome}`, async () => {
    const root = resolve(import.meta.dir, "../..");
    const source = `
import { mock } from "bun:test";
const core = await import("./packages/records-core/src/index.ts");
const outcome = process.env.NEUVE_TEST_AGENT_OUTCOME;
mock.module("./packages/records-core/src/index.ts", () => ({
  ...core,
  Starter: { ...core.Starter, currentCliCommand: () => ["/scratch/bin/neuve"] },
  Systemd: { ...core.Systemd, uninstallAgent: async () => {
    if (outcome === "missing-manager") throw new Error("There's no user systemd here, so the systemd timer can't be disabled.");
    return outcome;
  } },
}));
Object.defineProperty(process, "platform", { value: "linux" });
const { runWorkerCli } = await import("./apps/neuve-cli/src/worker-cli.ts");
try { process.exitCode = await runWorkerCli(["uninstall-agent"]); }
catch (error) { console.error(String(error)); process.exitCode = 1; }
`;
    const child = Bun.spawn([process.execPath, "--no-env-file", "-e", source], {
      cwd: root,
      env: { ...process.env, NEUVE_TEST_AGENT_OUTCOME: outcome },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code, stdout + stderr).toBe(
      outcome === Systemd.otherOwnerMessage("/another/install") ||
        outcome.startsWith("Removed ") ||
        outcome.startsWith("There's no /")
        ? 0
        : 1,
    );
    expect(stdout + stderr).toContain(
      outcome === "missing-manager" ? "can't be disabled" : outcome,
    );
  }, 15_000);
