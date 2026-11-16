import { expect, test } from "bun:test";
import { join } from "node:path";

async function run(mode: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--preload",
      join(import.meta.dirname, "smoke-tools-diagnose-preload.ts"),
      join(import.meta.dirname, "../src/smoke.ts"),
      "--live",
      "/test",
      "--diagnose-tools",
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
    for (const privateValue of [
      "private-",
      "00000000-0000-4000-8000-000000000001",
      "Call note once",
      "Use steerToken as",
      "/test",
      "mcp__neuve__",
    ]) {
      expect(stdout).not.toContain(privateValue);
      expect(stderr).not.toContain(privateValue);
    }
    const warning = {
      rejected: "invalid-frame frame=user",
      unknown: "permission-unknown-tool frame=other",
      structured: "permission-unknown-tool frame=other",
      published: "published-frame-open-turn frame=stream_event/message_stop",
    }[mode];
    // Reason: protocol failures now emit exactly one fixed site warning on stderr.
    if (warning === undefined) expect(stderr).toBe("");
    else {
      expect(stderr.trim().split("\n")).toHaveLength(1);
      expect(stderr).toMatch(
        new RegExp(
          `^\\S+ WARN claude-runtime protocol-error site=${warning}\\n$`,
        ),
      );
    }
    expect(stdout).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
    return { code, line: JSON.parse(stdout) };
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}

// Reason: the real tools prompts must run alone and report ordered shapes, handler returns and child markers without content.
test("tools diagnosis records frame shapes through the production adapter", async () => {
  const { code, line } = await run("shapes");
  expect(code).toBe(0);
  expect(line).toMatchObject({
    mode: "diagnose-tools",
    probe: { requests: 0 },
    expectedRequests: 1,
    withinPlan: true,
    stoppedAtCap: false,
    requestsStarted: 2,
    requestsCompleted: 2,
    tools: {
      outcome: { status: "completed" },
      frameTotal: 6,
      handlers: {
        note: { calls: 1, returnedError: false },
        finish: { calls: 0, returnedError: false },
      },
    },
  });
  expect(
    line.tools.frames.map((frame: { type: string }) => frame.type),
  ).toEqual([
    "assistant",
    "user",
    "user",
    "stream_event",
    "assistant",
    "result",
  ]);
  expect(line.tools.frames[0]).toMatchObject({
    valid: true,
    blocks: [{ type: "tool_use", tool: "note" }],
  });
  expect(line.tools.frames[1]).toMatchObject({
    content: "string",
    isReplayPresent: true,
    isSyntheticPresent: true,
    priorityPresent: true,
    parentToolUseIdNull: true,
  });
  expect(line.tools.frames[2]).toMatchObject({
    content: ["tool_result"],
    toolUseResultPresent: true,
  });
  expect(line.tools.frames[3]).toMatchObject({
    subtype: "content_block_start",
    blocks: [{ type: "tool_use", tool: "finish" }],
  });
  expect(line.tools.frames[5]).toMatchObject({
    userMessageUuidPresent: true,
    userMessageUuidsPresent: true,
    stampsMatchOffered: true,
  });
  expect(line.tools.opens[0]).toMatchObject({
    child: { stderrLines: 1, errorPrefix: true, flag: "--resume" },
  });
});

// Reason: a rejected wire frame must preserve schema paths and the adapter's protocol-error ending.
test("tools diagnosis records rejected frame", async () => {
  const { line } = await run("rejected");
  expect(line.mode).toBe("diagnose-tools");
  expect(line.tools).toMatchObject({
    firedPath: "validFrame",
    outcome: { status: "failed", reason: "protocol-error" },
    protocolError: { site: "invalid-frame", frame: { type: "user" } },
    frameTotal: 2,
  });
  expect(line.tools.frames[1]).toMatchObject({
    valid: false,
    shapeIssues: [{ path: "parent_tool_use_id", code: "invalid_type" }],
  });
});

// Reason: permission calls must retain their decisions while hiding foreign names and all inputs.
for (const mode of ["unknown", "structured"])
  test(`tools diagnosis permission ${mode}`, async () => {
    const { line } = await run(mode);
    expect(line.mode).toBe("diagnose-tools");
    expect(line.tools).toMatchObject({
      outcome: { status: "failed", reason: "protocol-error" },
      firedPath: "canUseToolUnknown",
      protocolError: {
        site: "permission-unknown-tool",
        frame: { type: "other" },
      },
      canUseTool: [
        {
          tool: mode === "unknown" ? "other" : "StructuredOutput",
          behavior: "deny",
        },
      ],
    });
  });

// Reason: a third root request or retry must interrupt before another adapter response is processed.
for (const mode of ["cap", "retry-cap"])
  test(`tools diagnosis request cap ${mode}`, async () => {
    const { code, line } = await run(mode);
    expect(code).toBe(1);
    expect(line).toMatchObject({
      mode: "diagnose-tools",
      requestsCompleted: mode === "cap" ? 2 : 0,
      requestsStarted: 3,
      withinPlan: false,
      stoppedAtCap: true,
      tools: { outcome: { status: "interrupted", reason: "cutoff" } },
    });
  });

// Reason: recording must stay bounded while still counting every tools-turn frame.
test("tools diagnosis caps the frame list", async () => {
  const { line } = await run("frame-cap");
  expect(line.mode).toBe("diagnose-tools");
  expect(line.tools.frameTotal).toBe(211);
  expect(line.tools.frames).toHaveLength(200);
});

// Reason: handler-start publication must be mirrored so a later frame identifies the same adapter predicate.
test("tools diagnosis identifies a published response frame", async () => {
  const { line } = await run("published");
  expect(line.tools).toMatchObject({
    firedPath: "publishedFrameAfterEnding",
    outcome: { status: "failed", reason: "protocol-error" },
    faultingFrame: { type: "stream_event", subtype: "message_stop" },
  });
});

// Reason: both real smoke handlers must retain their returns and finish must still discard its held steer.
test("tools diagnosis records finish and an allowed permission", async () => {
  const { line } = await run("finish");
  expect(line.tools).toMatchObject({
    outcome: { status: "completed" },
    handlers: {
      note: { calls: 1, returnedError: false },
      finish: { calls: 1, returnedError: false },
    },
    canUseTool: [{ tool: "note", behavior: "allow" }],
    checks: {
      finishCalledOnce: true,
      finishReceivedSteerToken: true,
      discardedSteerNotOffered: true,
    },
  });
});

// Reason: an errored handler result must remain visible as a boolean without copying the error or tool output.
test("tools diagnosis records handler error results", async () => {
  const { line } = await run("handler-error");
  expect(line.tools.handlers).toEqual({
    note: { calls: 1, returnedError: true },
    finish: { calls: 0, returnedError: false },
  });
});
