import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

for (const [scenario, reason] of [
  [
    "status-source",
    "a bad read must not disconnect a long-lived status subscriber",
  ],
  [
    "watch-statuses",
    "an initially malformed snapshot must heal and only watch failures end the stream",
  ],
  [
    "status-logger-failure",
    "a logger failure must not end a subscriber's status updates",
  ],
  ["malformed-record", "a malformed record must not disable session removal"],
  ["duplicate-record", "two files in a claim must not disable session removal"],
  [
    "record-logger-failure",
    "a logger failure after a malformed record must not disable session removal",
  ],
] as const) {
  test(`${scenario}: ${reason}`, async () => {
    // Isolate node:fs's controlled watch from the other store tests' module cache.
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        fileURLToPath(new URL("./watch-recovery-child.ts", import.meta.url)),
        scenario,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    try {
      const code = await child.exited;
      expect({ code, stdout: await stdout, stderr: await stderr }).toEqual({
        code: 0,
        stdout: "",
        stderr: "",
      });
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      await Promise.all([stdout, stderr]);
    }
  });
}
