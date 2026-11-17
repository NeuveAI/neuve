import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  Account,
  RuntimeRegistry,
  inMemoryAccountDirectoryLayer,
  runtimeRegistryLayer,
  type RuntimeEvent,
} from "@neuve/runtime";
import { Client } from "../../../../runtime-claude/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { InMemoryTransport } from "../../../../runtime-claude/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js";
import { Context, Effect, Exit, Layer, Scope, Stream } from "effect";
import { makeRuntime } from "../../../../runtime-claude/src/runtime.ts";
import {
  ClaudeExecutable,
  ClaudeProcess,
} from "../../../../runtime-claude/src/services.ts";
import { TOOL_USE_ID_META } from "../../../../runtime-claude/src/tools.ts";
import {
  assistant,
  result,
  SESSION_ID,
} from "../../../../runtime-claude/tests/frames.ts";
import {
  inbound,
  out,
  replay,
  type Entry,
  type Outbound,
} from "../../../../runtime-claude/tests/replay.ts";
import { ContractContextDoc } from "../../../src/pi/stages/docs.ts";
import { heldFailure } from "../../../src/pi/failure-policy.ts";
import { ContractState } from "../../../src/pi/stages/contract-state.ts";
import { contractSessionStart } from "../../../src/pi/stages/contract-recovery.ts";
import { FINAL_TOOLS_UNAVAILABLE } from "../../../src/pi/stages/contract-tools.ts";
import type { ContractPort } from "../../../src/pi/stages/contract-step.ts";
import { route, waitHeld } from "./contract-fixture.ts";
import { world } from "./fixture.ts";

type Options = Parameters<
  NonNullable<Extract<Outbound, { type: "query.open" }>["check"]>
>[0];
interface Call {
  readonly callId: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

// Replay declares all siblings, while this MCP client dispatches only the selected ones.
function turn(
  calls: Call[],
  options: {
    invoked?: Call[];
    structured?: unknown;
    reopen?: boolean;
    cancelBeforeMessage?: { entered: Promise<void>; stopped: Promise<void> };
  } = {},
) {
  const { invoked = calls, structured, cancelBeforeMessage } = options;
  const offered = Promise.withResolvers<Options>();
  const message = assistant(undefined);
  message.message.id = crypto.randomUUID();
  message.message.stop_reason = calls.length ? "tool_use" : "end_turn";
  message.message.usage.input_tokens = 12;
  message.message.content = calls.length
    ? calls.map((call) => ({
        type: "tool_use",
        id: call.callId,
        name: `mcp__neuve__${call.name}`,
        input: call.input,
      }))
    : [{ type: "text", text: "fixture", citations: [] }];
  const carrier = {
    type: "user" as const,
    uuid: crypto.randomUUID(),
    session_id: SESSION_ID,
    parent_tool_use_id: null,
    message: {
      role: "user" as const,
      content: invoked.map((call) => ({
        type: "tool_result" as const,
        tool_use_id: call.callId,
        content: "fixture result",
      })),
    },
  };
  const results = offered.promise.then(async (options) => {
    if (invoked.length === 0) return [];
    const server = options.mcpServers?.neuve;
    if (server?.type !== "sdk") throw new Error("Missing SDK MCP server");
    const client = new Client({ name: "contract-integration", version: "1" });
    try {
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await Promise.all([
        client.connect(clientTransport),
        server.instance.connect(serverTransport),
      ]);
      const outcomes = [];
      for (const call of invoked) {
        if (cancelBeforeMessage !== undefined) {
          const controller = new AbortController();
          const pending = client
            .callTool(
              {
                name: call.name,
                arguments: call.input,
                _meta: { [TOOL_USE_ID_META]: call.callId },
              },
              undefined,
              { signal: controller.signal },
            )
            .catch(() => undefined);
          try {
            await cancelBeforeMessage.entered;
            controller.abort();
            await cancelBeforeMessage.stopped;
            outcomes.push(await pending);
          } finally {
            controller.abort();
          }
          continue;
        }
        outcomes.push(
          await client.callTool({
            name: call.name,
            arguments: call.input,
            _meta: { [TOOL_USE_ID_META]: call.callId },
          }),
        );
      }
      return outcomes;
    } finally {
      await client.close();
    }
  });
  let failure: unknown;
  // A failed dispatch must release the replay too, so cleanup can still close its query.
  const dispatched = results.then(
    () => {},
    (error: unknown) => {
      failure = error;
    },
  );
  return {
    reopen: options.reopen,
    carrier,
    results,
    entries: (getOptions: () => Options): Entry[] => [
      out({
        type: "prompt.offer",
        message: /./s,
        check: () => offered.resolve(getOptions()),
      }),
      ...(cancelBeforeMessage === undefined
        ? [inbound(message), { type: "pause" as const, until: dispatched }]
        : [{ type: "pause" as const, until: dispatched }, inbound(message)]),
      ...(invoked.length ? [inbound(carrier)] : []),
      inbound(
        result(
          structured === undefined ? {} : { structured_output: structured },
        ),
      ),
    ],
    check: async () => {
      await dispatched;
      if (failure !== undefined) throw failure;
    },
  };
}

async function setup(
  name: string,
  rounds: ReturnType<typeof turn>[],
  limit = 6,
  onCommit?: (state: ContractState, port: ContractPort) => Promise<void>,
  handleTool?: Parameters<typeof makeRuntime>[0]["handleTool"],
) {
  let options: Options | undefined;
  const getOptions = () => {
    if (options === undefined) throw new Error("Query did not open");
    return options;
  };
  const open = () =>
    out({
      type: "query.open",
      check: (value) => {
        options = value;
      },
    });
  const entries: Entry[] = [open()];
  rounds.forEach((round) => {
    if (round.reopen) entries.push(out({ type: "query.close" }), open());
    entries.push(...round.entries(getOptions));
  });
  entries.push(out({ type: "query.close" }));
  const fake = replay(entries);
  const scope = await Effect.runPromise(Scope.make());
  const dependencies = await Effect.runPromise(
    Layer.buildWithScope(
      Layer.mergeAll(
        fake.layer,
        Layer.succeed(ClaudeExecutable, {
          resolve: () => Effect.succeed("/test/claude"),
        }),
        Layer.succeed(ClaudeProcess, {
          run: () => Effect.die("No process allowed"),
        }),
      ),
      scope,
    ),
  );
  const runtime = await Effect.runPromise(
    makeRuntime({ cwd: "/test", environment: {}, handleTool }).pipe(
      Effect.provide(dependencies),
    ),
  );
  const registry = await Effect.runPromise(
    Layer.buildWithScope(
      runtimeRegistryLayer([runtime]).pipe(
        Layer.provide(
          inMemoryAccountDirectoryLayer([
            Account.parse({
              name: route.account.name,
              kind: "claude-subscription",
              runtime: "claude-code",
              credential: { kind: "claude-config-folder" },
            }),
          ]),
        ),
      ),
      scope,
    ),
  );
  const registered = Context.get(registry, RuntimeRegistry);
  const runtimeEvents: RuntimeEvent[] = [];
  const runtimes = {
    ...registered,
    openSession: (...args: Parameters<typeof registered.openSession>) =>
      registered.openSession(...args).pipe(
        Effect.map((session) => ({
          ...session,
          events: session.events.pipe(
            Stream.tap((event) =>
              Effect.sync(() => {
                runtimeEvents.push(event);
              }),
            ),
          ),
        })),
      ),
  };
  let saved: ContractState | undefined;
  const run = await world(
    `claude-runtime-${name}`,
    limit,
    false,
    false,
    "faux",
    undefined,
    false,
    undefined,
    {
      runtimes,
      afterCommit: async (port) => {
        const snapshot = await port.snapshot(
          ContractContextDoc,
          port.taskId,
          context,
        );
        if (snapshot?.data == null) return;
        saved = ContractState.parse(snapshot.data);
        await onCommit?.(saved, port);
      },
    },
  );
  run.ctx.config.route = route;
  let opened = await run.open();
  return {
    run,
    fake,
    runtimeEvents,
    get opened() {
      return opened;
    },
    state: () => {
      if (saved === undefined) throw new Error("No committed state");
      return saved;
    },
    begin: async () => {
      const id = await run.start(opened);
      await opened.harness.resume();
      return id;
    },
    reopen: async () => {
      opened = await run.open();
      await opened.harness.resume();
    },
    close: async () => {
      try {
        await opened.harness.close(context);
      } finally {
        try {
          await Effect.runPromise(Scope.close(run.scope, Exit.void));
        } finally {
          await Effect.runPromise(Scope.close(scope, Exit.void));
        }
      }
      for (const round of rounds) await round.check();
    },
  };
}

// Why: one-turn stages must run the submit in their only message before the runtime backstop acts.
test("Claude one-turn stage submits in its only message without final generation", async () => {
  const round = turn([
    { callId: "only-submit", name: "submit_frame", input: { answer: 5 } },
  ]);
  const w = await setup("one-turn-submit", [round], 1);
  try {
    const id = await w.begin();
    expect(
      (await w.opened.harness.waitForTask(id, context)).state.outcome,
    ).toMatchObject({
      status: "completed",
      result: {
        agentResult: {
          status: "submitted",
          endedBy: "submit",
          finalGeneration: false,
        },
      },
    });
    expect(w.state().ending?.output).toEqual({ answer: 5 });
    expect(w.state().calls["only-submit"]).toMatchObject({
      status: "completed",
      eligible: true,
      outcome: { endTurn: true },
    });
    expect(await round.results).toMatchObject([{ isError: false }]);
    expect(
      w.run.ctx.log
        .read()
        .filter((event) => event.type === "tool.call")
        .map((event) => event.tool),
    ).toEqual(["submit_frame"]);
    expect(w.state().rounds.map((round) => round.final)).toEqual([false]);
    expect(
      w.runtimeEvents
        .filter((event) => event.type === "turn.finished")
        .map((event) => event.outcome),
    ).toEqual([{ status: "completed" }]);
    expect(w.fake.opens).toHaveLength(1);
  } finally {
    await w.close();
  }
});

// Why: exhausting a one-turn stage with text must still allow its separate structured final generation.
test("Claude one-turn text stage returns its supplied final output", async () => {
  const first = turn([]);
  const final = turn([], { structured: { answer: 3 }, reopen: true });
  const w = await setup("one-turn-final", [first, final], 1);
  try {
    const id = await w.begin();
    expect(
      (await w.opened.harness.waitForTask(id, context)).state.outcome,
    ).toMatchObject({
      status: "completed",
      result: {
        agentResult: {
          status: "final-generation",
          endedBy: "turn-limit",
          finalGeneration: true,
        },
      },
    });
    expect(w.state().ending?.output).toEqual({ answer: 3 });
    expect(w.state().rounds.map((round) => round.final)).toEqual([false, true]);
    expect(
      w.runtimeEvents
        .filter((event) => event.type === "turn.finished")
        .map((event) => event.outcome),
    ).toEqual([
      { status: "completed" },
      { status: "completed", structuredOutput: { answer: 3 } },
    ]);
    expect(w.fake.opens).toHaveLength(2);
    // The replay ends at the final result and query close; any further request fails it.
  } finally {
    await w.close();
  }
});

// Why: a one-turn stage whose only submit fails its check ends that round from the tool. Claude Code
// ends a turn only on a result it isn't told is an error, so the refusal must reach it unflagged;
// the stage then runs its final generation instead of failing the run.
test("Claude one-turn stage with a refused submit returns its final generation", async () => {
  const first = turn([
    { callId: "refused-submit", name: "submit_frame", input: { answer: 0 } },
  ]);
  const final = turn([], { structured: { answer: 4 }, reopen: true });
  const w = await setup("one-turn-refused", [first, final], 1);
  try {
    const id = await w.begin();
    expect(
      (await w.opened.harness.waitForTask(id, context)).state.outcome,
    ).toMatchObject({
      status: "completed",
      result: {
        agentResult: {
          status: "final-generation",
          endedBy: "turn-limit",
          finalGeneration: true,
        },
      },
    });
    expect(w.state().ending?.output).toEqual({ answer: 4 });
    expect(w.state().calls["refused-submit"]).toMatchObject({
      status: "completed",
      outcome: { error: "CheckFailed", endTurn: true },
    });
    const [reply] = await first.results;
    expect(reply).toMatchObject({
      isError: false,
      _meta: { "claude/endTurn": true },
    });
    expect(JSON.stringify(reply)).toContain("answer must be positive");
    expect(
      w.runtimeEvents
        .filter((event) => event.type === "tool.finished")
        .map((event) => [event.callId, event.errored]),
    ).toEqual([["refused-submit", true]]);
    expect(
      w.run.ctx.log
        .read()
        .filter((event) => event.type === "tool.call")
        .map((event) => [event.tool, event.error]),
    ).toEqual([["submit_frame", "CheckFailed"]]);
    expect(w.state().rounds.map((round) => round.final)).toEqual([false, true]);
    expect(
      w.runtimeEvents
        .filter((event) => event.type === "turn.finished")
        .map((event) => event.outcome),
    ).toEqual([
      { status: "completed" },
      { status: "completed", structuredOutput: { answer: 4 } },
    ]);
    expect(w.fake.opens).toHaveLength(2);
  } finally {
    await w.close();
  }
});

// Why: allowing the limit's own message to settle must still reject further output and apply the final-generation policy.
test("Claude one-turn backstop rejects further output and the engine runs its final generation", async () => {
  const first = turn([]);
  const entries = first.entries;
  const extra = assistant(undefined, "past the limit");
  extra.message.id = "past-limit";
  first.entries = (options) => [
    ...entries(options).slice(0, -1),
    inbound(extra),
  ];
  const final = turn([], { structured: { answer: 8 }, reopen: true });
  const w = await setup("one-turn-backstop", [first, final], 1);
  try {
    const id = await w.begin();
    expect(
      (await w.opened.harness.waitForTask(id, context)).state.outcome,
    ).toMatchObject({
      status: "completed",
      result: {
        agentResult: {
          status: "final-generation",
          endedBy: "turn-limit",
        },
      },
    });
    expect(
      w.runtimeEvents
        .filter((event) => event.type === "turn.finished")
        .map((event) => event.outcome),
    ).toMatchObject([
      {
        status: "failed",
        disposition: "reusable",
        failure: { _tag: "TurnFailed", reason: "turn-limit-reached" },
      },
      { status: "completed", structuredOutput: { answer: 8 } },
    ]);
    expect(
      w.runtimeEvents
        .filter((event) => event.type === "message.finished")
        .map((event) => event.messageId),
    ).not.toContain("past-limit");
    expect(w.state().rounds.map((round) => round.final)).toEqual([false, true]);
    expect(w.state().rounds[0]?.outcome).toMatchObject({
      status: "failed",
      failure: { _tag: "TurnFailed", reason: "turn-limit-reached" },
    });
    expect(w.state().ending?.output).toEqual({ answer: 8 });
    expect(w.fake.opens).toHaveLength(2);
  } finally {
    await w.close();
  }
});

// Why: a streamed call can be announced before its assistant frame supplies the saved point.
test("Claude partial-stream failure requires explicit resume without running a tool", async () => {
  const round = turn([], { invoked: [] });
  const entries = round.entries;
  const partial = (
    event: Extract<
      Parameters<typeof inbound>[0],
      { type: "stream_event" }
    >["event"],
  ) =>
    inbound({
      type: "stream_event",
      parent_tool_use_id: null,
      uuid: crypto.randomUUID(),
      session_id: SESSION_ID,
      event,
    });
  round.entries = (options) => [
    ...entries(options).slice(0, 1),
    partial({
      type: "message_start",
      message: {
        ...assistant(undefined).message,
        id: "partial",
        content: [],
        stop_reason: null,
      },
    }),
    partial({
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "never-invoked",
        name: "mcp__neuve__probe",
        input: { n: 1 },
      },
    }),
    partial({ type: "content_block_stop", index: 0 }),
    { type: "stream_failure" },
  ];
  const w = await setup("partial-stream", [round]);
  try {
    const id = await w.begin();
    const held = await Promise.race([
      waitHeld(w.opened.harness),
      w.opened.harness.waitForTask(id, context).then((task) => {
        throw new Error(
          `Stage settled instead of holding: ${JSON.stringify(task.state.outcome)}`,
        );
      }),
    ]);
    expect(held).toMatchObject({
      failure: { _tag: "TurnFailed", reason: "provider-failed" },
      recovery: { kind: "explicit-account" },
    });
    expect(heldFailure([held])).toEqual({
      tag: "TurnFailed",
      retryable: false,
    });
    expect(w.state().rounds[0]?.announced["never-invoked"]).toEqual({
      toolName: "probe",
      status: "cancelled",
    });
    expect(w.state().calls).toEqual({});
    expect(w.state().events.map((event) => event.type)).toEqual([
      "tool.finished",
      "turn.finished",
    ]);
    expect(w.state().events.at(-1)).toMatchObject({
      type: "turn.finished",
      outcome: { status: "failed", failure: { reason: "provider-failed" } },
    });
    expect(w.state().native?.resumePoint).toBeNull();
    expect(contractSessionStart(w.state())).toEqual({ kind: "new" });
    expect(w.state().ending).toBeNull();
    expect(w.run.probes).toEqual([]);
    expect(w.run.sent).toEqual([]);
    expect(
      w.run.ctx.log.read().filter((event) => event.type === "tool.call"),
    ).toEqual([]);
    expect(w.run.ctx.log.read()).toContainEqual(
      expect.objectContaining({
        type: "runtime.event",
        event: expect.objectContaining({
          type: "tool.started",
          callId: "never-invoked",
        }),
      }),
    );
  } finally {
    await w.close();
  }
});

// Why: MCP cancellation before the assistant frame buffers an errored settlement in the real adapter.
for (const status of ["completed", "provider-failed"] as const) {
  test(`Claude buffered MCP cancellation keeps the ${status} turn outcome`, async () => {
    const entered = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    const round = turn(
      [{ callId: "early-cancel", name: "submit_frame", input: { answer: 7 } }],
      {
        cancelBeforeMessage: {
          entered: entered.promise,
          stopped: stopped.promise,
        },
      },
    );
    if (status === "provider-failed") {
      const entries = round.entries;
      round.entries = (options) => [
        ...entries(options).slice(0, -1),
        { type: "stream_failure" },
      ];
    }
    const w = await setup(
      `buffered-cancellation-${status}`,
      [
        round,
        ...(status === "completed"
          ? [turn([], { structured: { answer: 3 }, reopen: true })]
          : []),
      ],
      6,
      undefined,
      (definition, input, call) =>
        Effect.sync(() => entered.resolve()).pipe(
          Effect.andThen(definition.handle(input, call)),
          Effect.ensuring(Effect.sync(() => stopped.resolve())),
        ),
    );
    w.run.ctx.config.budgets.contextCeiling = 1;
    try {
      const id = await w.begin();
      if (status === "provider-failed") {
        const held = await Promise.race([
          waitHeld(w.opened.harness),
          w.opened.harness.waitForTask(id, context).then((task) => {
            throw new Error(
              `Stage settled instead of holding: ${JSON.stringify(task.state.outcome)}`,
            );
          }),
        ]);
        expect(held).toMatchObject({
          failure: { _tag: "TurnFailed", reason: "provider-failed" },
          recovery: { kind: "explicit-account" },
        });
        expect(heldFailure([held])).toEqual({
          tag: "TurnFailed",
          retryable: false,
        });
      } else {
        expect(
          (await w.opened.harness.waitForTask(id, context)).state.outcome,
        ).toMatchObject({
          status: "completed",
          result: {
            agentResult: { status: "final-generation", endedBy: "ceiling" },
          },
        });
        expect(w.state().ending?.output).toEqual({ answer: 3 });
      }
      const firstTurn = w.runtimeEvents.find(
        (event) => event.type === "turn.started",
      )?.turnId;
      expect(firstTurn).toBeDefined();
      const events = w.runtimeEvents.filter(
        (event) => event.turnId === firstTurn,
      );
      expect(
        events
          .filter((event) =>
            ["tool.started", "tool.finished", "message.finished"].includes(
              event.type,
            ),
          )
          .map((event) => event.type),
      ).toEqual(["tool.started", "tool.finished", "message.finished"]);
      expect(
        events.find((event) => event.type === "tool.finished"),
      ).toMatchObject({ callId: "early-cancel", errored: true });
      const outcome =
        status === "completed"
          ? { status: "completed" }
          : { status: "failed", failure: { reason: "provider-failed" } };
      expect(events.at(-1)).toMatchObject({ type: "turn.finished", outcome });
      expect(w.state().rounds[0]).toMatchObject({
        state: "settled",
        outcome,
        announced: {},
      });
      expect(w.state().calls).toEqual({
        "early-cancel": { status: "cancelled", eligible: false },
      });
      expect(w.run.probes).toEqual([]);
      expect(w.run.sent).toEqual([]);
      expect(
        w.run.ctx.log.read().filter((event) => event.type === "tool.call"),
      ).toEqual([]);
    } finally {
      await w.close();
    }
  });
}

// Why: Claude settles undelegated siblings before turn.finished after an accepted submission.
test("Claude submission cancels an uninvoked sibling without a protocol error", async () => {
  const submit = {
    callId: "submit",
    name: "submit_frame",
    input: { answer: 2 },
  };
  const sibling = { callId: "sibling", name: "probe", input: { n: 1 } };
  const round = turn([submit, sibling], { invoked: [submit] });
  const w = await setup("submission", [round]);
  try {
    const id = await w.begin();
    const task = await w.opened.harness.waitForTask(id, context);
    expect(task.state.outcome).toMatchObject({
      status: "completed",
      result: { agentResult: { status: "submitted" } },
    });
    expect(w.state().calls.sibling).toEqual({
      status: "cancelled",
      eligible: false,
    });
    expect(w.run.probes).toEqual([]);
    expect(w.run.sent).toEqual([]);
    expect(
      w.run.ctx.log
        .read()
        .filter((event) => event.type === "tool.call")
        .map((event) => event.tool),
    ).toEqual(["submit_frame"]);
    expect(
      w.state().events.filter((event) => event.type === "tool.finished"),
    ).toMatchObject([
      { callId: "submit", errored: false },
      { callId: "sibling", errored: true },
    ]);
    expect(w.state().ending).toMatchObject({
      endedBy: "submit",
      output: { answer: 2 },
    });
  } finally {
    await w.close();
  }
});

// Why: final generations expose tools to Claude but the engine must refuse them without effects.
test("Claude final-turn tools are refused and the turn ends cleanly", async () => {
  const first = turn([{ callId: "allowed", name: "probe", input: { n: 1 } }]);
  const final = turn([{ callId: "refused", name: "probe", input: { n: 2 } }], {
    reopen: true,
  });
  const answer = turn([], { structured: { answer: 3 } });
  const w = await setup("final", [first, final, answer]);
  w.run.ctx.config.budgets.contextCeiling = 1;
  try {
    const id = await w.begin();
    expect(
      (await w.opened.harness.waitForTask(id, context)).state.outcome,
    ).toMatchObject({
      status: "completed",
      result: { agentResult: { status: "final-generation" } },
    });
    expect(w.run.probes).toEqual([{ n: 1 }]);
    expect(
      w.run.ctx.log
        .read()
        .filter((event) => event.type === "tool.call")
        .map((event) => event.tool),
    ).toEqual(["probe"]);
    expect(w.state().ending?.output).toEqual({ answer: 3 });
    expect(w.state().calls.refused).toMatchObject({
      status: "completed",
      eligible: false,
      outcome: {
        text: FINAL_TOOLS_UNAVAILABLE,
        error: "FinalToolsUnavailable",
        endTurn: true,
      },
    });
    // The refusal ends the turn, so it reaches Claude Code unflagged: Claude Code answers a flagged
    // endTurn result with another response.
    expect(await final.results).toMatchObject([
      {
        isError: false,
        _meta: { "claude/endTurn": true },
        content: [{ text: FINAL_TOOLS_UNAVAILABLE }],
      },
    ]);
    expect(w.state().rounds.map((round) => round.final)).toEqual([
      false,
      true,
      true,
    ]);
    expect(w.state().rounds[1]?.outcome).toEqual({ status: "completed" });
  } finally {
    await w.close();
  }
});

// Why: a committed tool-result carrier is the restart boundary, so its tools must never run twice.
test("Claude resumes between rounds at the carrier without repeating a tool", async () => {
  const crashed = Promise.withResolvers<void>();
  let interrupted = false;
  const first = turn([{ callId: "once", name: "probe", input: { n: 1 } }]);
  const second = turn(
    [{ callId: "submitted", name: "submit_frame", input: { answer: 4 } }],
    { reopen: true },
  );
  const w = await setup("resume", [first, second], 6, async (state, port) => {
    if (
      interrupted ||
      state.rounds.length !== 1 ||
      state.rounds[0]?.state !== "settled"
    )
      return;
    interrupted = true;
    crashed.resolve();
    await new Promise<void>((resolve) => {
      if (port.signal.aborted) resolve();
      else
        port.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  });
  try {
    const id = await w.begin();
    await crashed.promise;
    expect(w.state().native?.resumePoint).toBe(first.carrier.uuid);
    const nativeSession = w.state().native?.sessionId;
    await w.opened.harness.close(context);
    await w.reopen();
    expect(
      (await w.opened.harness.waitForTask(id, context)).state.outcome,
    ).toMatchObject({
      status: "completed",
      result: { agentResult: { status: "submitted" } },
    });
    expect(w.run.probes).toEqual([{ n: 1 }]);
    expect(
      w.run.ctx.log
        .read()
        .filter((event) => event.type === "tool.call")
        .map((event) => event.tool),
    ).toEqual(["probe", "submit_frame"]);
    expect(w.fake.opens[1]?.resume).toBe(nativeSession);
    expect(w.fake.opens[1]?.resumeSessionAt).toBe(first.carrier.uuid);
    expect(w.fake.opens[1]?.forkSession).toBe(false);
    expect(w.fake.opens[1]?.persistSession).toBe(true);
    expect(w.state().calls.once?.status).toBe("completed");
    expect(w.state().ending?.output).toEqual({ answer: 4 });
  } finally {
    await w.close();
  }
});
