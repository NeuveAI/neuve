import { expect, test } from "bun:test";
import { join } from "node:path";

// Reason: acceptance must fail when either turn or final schema validation fails.
for (const [mode, code, completed, failed] of [
  ["valid", 0, 4, 0],
  // Reason: passes before, guards behaviour; every full-smoke open retains its output-format options and every expected offer reaches the fake.
  ["options-guard", 0, 4, 0],
  ["normal-failed", 1, 3, 1],
  ["final-failed", 1, 3, 1],
  ["final-invalid", 1, 3, 1],
  ["final-missing", 1, 3, 1],
  ["message-missing", 1, 4, 0],
  ["steer-missing", 1, 4, 0],
] as const) {
  test(`smoke entrypoint checks both turns and final schema: ${mode}`, async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--preload",
        join(import.meta.dirname, "smoke-preload.ts"),
        join(import.meta.dirname, "../src/smoke.ts"),
        "--live",
        "/test",
        mode,
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    );
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(stderr).toBe("");
      expect(JSON.parse(stdout)).toMatchObject({ completed, failed });
      expect(
        Object.values(JSON.parse(stdout)).every(
          (value) => typeof value === "boolean" || typeof value === "number",
        ),
      ).toBe(true);
      expect(exitCode).toBe(code);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
    }
  });
}

// Reason: running the prepared script without explicit authorization must send no request.
test("smoke entrypoint requires the live flag", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dirname, "../src/smoke.ts"),
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain(
      "Use --live followed by an existing absolute Neuve state directory.",
    );
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
});
