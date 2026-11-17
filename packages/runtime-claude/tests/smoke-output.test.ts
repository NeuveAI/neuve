import { expect, test } from "bun:test";
import { join } from "node:path";
import { privateValues } from "./smoke-open-fixture.ts";

async function run(diagnose: boolean, mode: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--preload",
      join(import.meta.dirname, "smoke-open-preload.ts"),
      join(import.meta.dirname, "../src/smoke.ts"),
      "--live",
      "/test",
      ...(diagnose ? ["--diagnose"] : []),
      mode,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stdout.trim().split("\n")).toHaveLength(1);
    for (const secret of privateValues) {
      expect(stdout).not.toContain(secret);
      expect(stderr).not.toContain(secret);
    }
    return { code, line: JSON.parse(stdout), stderr };
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}
for (const diagnose of [false, true]) {
  // Reason: ignored provider frames must log to stderr while the smoke prints one JSON result.
  test(`smoke stdout is one line in ${diagnose ? "diagnose" : "full"} mode`, async () => {
    const { stderr } = await run(diagnose, "logging");
    expect(stderr).toContain("command_lifecycle");
  });
}
// Reason: a genuine final-start failure must preserve the runtime's typed reason without its message.
test("full smoke prints typed final start failure", async () => {
  const { code, line, stderr } = await run(false, "fullFailure");
  expect(code).toBe(1);
  expect(line).toMatchObject({
    outcome: "failed",
    step: "finalTurn",
    causeKind: "fail",
    errorTag: "RuntimeUnavailable",
    reason: "start-failed",
    expectedRequests: 12,
  });
  expect(stderr).toBe("");
  expect(line).not.toHaveProperty("message");
});
// Reason: run the real production SDK layer against raw SDK rejections in an isolated process, without launching Claude.
test("production sdkError copies only validated exit fields", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dirname, "smoke-production-fixture.ts"),
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ passed: 9 });
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
});

// Reason: stderr split at every character must expose only fixed markers and tags in the actual printed line and logs.
test("diagnose printed stderr classification stays private", async () => {
  const { line, stderr } = await run(true, "privacy");
  expect(stderr).toBe("");
  expect(line.turns.freshFinal.opens.at(-1).child).toMatchObject({
    marker: "noConversation",
    errorToken: "FixtureError",
    stderrLines: 5,
  });
});
