// Why: loop-owning stages must preserve stage policy and durable tool ordering without a model or Claude process.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { TurnFailed, type TurnOutcome } from "@neuve/runtime";
import { Effect } from "effect";
import { z } from "zod";
import {
  ContractState,
  contractFacts,
} from "../../../src/pi/stages/contract-state.ts";
import { emitContractTelemetry } from "../../../src/pi/stages/contract-step.ts";
import { recoveryText } from "../../../src/pi/stages/contract-recovery.ts";
import { ContractContextDoc } from "../../../src/pi/stages/docs.ts";
import {
  FINAL_TOOLS_UNAVAILABLE,
  ROUND_ENDED,
} from "../../../src/pi/stages/contract-tools.ts";
import { TOOL_RESULT_BYTES } from "../../../src/budget.ts";
import { findStep } from "../../../src/pi/stages/find-steps.ts";
import { withTelemetry } from "../../../src/run-log.ts";
import type { ToolSpec } from "../../../src/toolkit.ts";
import { finding, frame, hunk, view } from "../../find-fixture.ts";

import {
  setup,
  fakeRuntime,
  waitHeld,
  call,
  submit,
  probe,
  usage,
  route,
  type Script,
} from "./contract-fixture.ts";
import { settled, world } from "./fixture.ts";

const accept: Script = async (turn) => {
  const item = submit("valid", 2);
  await turn.message([item]);
  await turn.charge(usage);
  expect((await turn.invoke(item)).endTurn).toBe(true);
  turn.native("native-after-turn");
};
const final: Script = async (turn) => {
  expect(turn.final).toBe(true);
  await turn.message();
  await turn.charge(usage);
  return { status: "completed", structuredOutput: { answer: 5 } };
};
const summary = (
  outcome: Awaited<ReturnType<Awaited<ReturnType<typeof setup>>["start"]>>,
) => {
  expect(outcome.status).toBe("completed");
  if (outcome.status !== "completed")
    throw new Error("Expected a completed task");
  return outcome.result.agentResult;
};

// The contract runtime owns dispatch, so pi tests cannot catch failures on this path.
test("contract find tools apply defaults, teach refusals and log starts with telemetry off", async () => {
  let reviewTools: ReadonlyArray<ToolSpec> = [];
  const { signal: _signal, ...withoutSignal } = finding;
  const fake = fakeRuntime(
    [
      async (turn) => {
        const names = turn.policy.tools.map((tool) => tool.name);
        expect(names).toContain("record_finding");
        expect(names).not.toContain("scope_section");
        expect(names).not.toContain("proofs");
        expect(
          turn.policy.tools.find((tool) => tool.name === "log")!.inputSchema[
            "required"
          ] ?? [],
        ).not.toContain("format");
        const log = call("log-default", "log", {});
        const tree = call("tree-default", "tree", {});
        const invalid = call("log-invalid", "log", { format: "full" });
        const record = call("missing-signal", "record_finding", withoutSignal);
        const end = submit("done", 2);
        await turn.message([log, tree, invalid, record, end]);
        expect((await turn.invoke(log)).text).toContain("22222222 change");
        expect((await turn.invoke(tree)).text).toContain("new.ts 12 B");
        expect((await turn.invoke(invalid)).text).toStartWith(
          'log format accepts "oneline" or "message" and received "full".',
        );
        expect((await turn.invoke(record)).text).toStartWith(
          'record_finding signal accepts "forged" or "test-bloat" or "untested" or "stale-proof" or null and received no value.',
        );
        await turn.invoke(end);
        await turn.charge(usage);
      },
    ],
    false,
  );
  const run = await world(
    "contract-review-tools",
    6,
    false,
    false,
    "faux",
    undefined,
    false,
    undefined,
    {
      runtimes: fake.registry,
      configure: (step) => ({
        ...step,
        spec: { ...step.spec, tools: reviewTools },
      }),
    },
  );
  run.ctx.config.route = route;
  run.ctx.log = withTelemetry(run.ctx.log, false);
  const range = view();
  const step = await Effect.runPromise(
    findStep(
      run.ctx,
      {
        ...range,
        head: {
          ...range.head,
          entries: new Map([
            [
              "new.ts",
              {
                path: "new.ts",
                type: "blob",
                mode: "100644",
                oid: hunk.newOid!,
                size: 12,
              },
            ],
          ]),
        },
        commits: [
          { oid: range.head.commit, subject: "change", body: "message" },
        ],
      },
      {
        lens: "correctness",
        frame,
        keys: { frame: "frame", manifest: "manifest" },
      },
    ).pipe(Effect.provide(run.ctx.records)),
  );
  reviewTools = step.spec.tools.map((tool) =>
    tool.name !== "log"
      ? tool
      : {
          ...tool,
          handle: (input) =>
            Effect.sync(() => {
              expect(
                run.ctx.log
                  .read()
                  .filter((row) => row["callId"] === "log-default"),
              ).toEqual([
                {
                  at: expect.any(String),
                  type: "tool.started",
                  stage: "frame",
                  agent: expect.stringMatching(/^frame(?:\.\d+)?$/),
                  turn: 1,
                  tool: "log",
                  callId: "log-default",
                },
              ]);
            }).pipe(Effect.andThen(tool.handle(input))),
        },
  );
  const opened = await run.open();
  try {
    const id = await run.start(opened);
    await opened.harness.resume();
    expect((await settled(opened.harness, id)).agentResult?.status).toBe(
      "submitted",
    );
    expect(
      run.ctx.log
        .read()
        .filter((row) => row["callId"] === "log-invalid")
        .map((row) => [row.type, row["error"]]),
    ).toEqual([
      ["tool.started", undefined],
      ["tool.call", "InvalidInput"],
    ]);
  } finally {
    await opened.harness.close(context);
  }
});

test("round-one submission is accepted, committed and closed without pi generation", async () => {
  const w = await setup("accept", [accept]);
  try {
    expect(summary(await w.start())).toMatchObject({
      status: "submitted",
      turnsUsed: 1,
      costUsd: null,
    });
    const state = await w.state();
    expect(state.native).toEqual({
      sessionId: "native-after-turn",
      resumePoint: "carrier-1",
    });
    expect(state.rounds[0]).toMatchObject({ state: "settled", final: false });
    expect(w.run.sent).toHaveLength(0);
    expect(w.fake.closes()).toBe(1);
  } finally {
    await w.close();
  }
});

for (const scenario of [
  "invalid-valid",
  "invalid-exhausted",
  "advice",
] as const) {
  test(`${scenario} uses the existing submission policy`, async () => {
    const scripts: Script[] = [];
    const answers =
      scenario === "invalid-valid"
        ? [null, 2]
        : scenario === "advice"
          ? [2, 2]
          : [null, null, null];
    scripts.push(async (turn) => {
      for (const [i, answer] of answers.entries()) {
        const item = submit(`s${i}`, answer);
        await turn.message([item]);
        const result = await turn.invoke(item);
        expect(result.endTurn === true).toBe(i === answers.length - 1);
        if (scenario === "advice" && i === 0)
          expect(result.error).toBe("Advised");
      }
      await turn.charge(usage);
    });
    const w = await setup(scenario, scripts, {
      configure: (step) => ({
        ...step,
        spec: {
          ...step.spec,
          ...(scenario === "advice"
            ? { advise: () => ["consider a better answer"] }
            : {}),
        },
      }),
    });
    try {
      expect(summary(await w.start())).toMatchObject({
        status: scenario === "invalid-exhausted" ? "backstop" : "submitted",
        turnsUsed: answers.length,
      });
      expect(w.fake.closes()).toBe(1);
    } finally {
      await w.close();
    }
  });
}

for (const reason of ["turn-limit", "ceiling", "timeout"] as const) {
  test(`${reason} ends tools and requests the bounded final turn`, async () => {
    const w = await setup(
      reason,
      [
        async (turn) => {
          const item = probe("read", 1);
          await turn.message([item], {
            usage:
              reason === "ceiling"
                ? { ...usage, input: 1, cacheRead: 2_000_000 }
                : usage,
          });
          expect((await turn.invoke(item)).endTurn).toBe(true);
          await turn.charge(usage);
        },
        final,
      ],
      { limit: reason === "turn-limit" ? 1 : 6 },
    );
    try {
      expect(
        summary(
          await w.start(
            undefined,
            reason === "timeout" ? Date.now() - 1 : undefined,
          ),
        ),
      ).toMatchObject({
        endedBy: reason,
        status: "final-generation",
        finalGeneration: true,
      });
      expect(w.fake.closes()).toBe(1);
    } finally {
      await w.close();
    }
  });
}

for (const result of [
  "valid",
  "missing",
  "invalid",
  "repairable",
  "structured-output-missing",
  "structured-output-invalid",
] as const) {
  test(`final ${result} follows the refusal allowance and closes`, async () => {
    const w = await setup(
      `final-${result}`,
      [
        async (turn) => {
          await turn.message();
        },
        async (turn) => {
          expect(turn.final).toBe(false); // A text-only round receives today's continuation first.
          expect(turn.prompt).toContain("[harness: open items]");
          await turn.message();
        },
        async (turn) => {
          expect(turn.final).toBe(true);
          await turn.message();
          if (
            result === "structured-output-missing" ||
            result === "structured-output-invalid"
          )
            return {
              status: "failed",
              disposition: "reusable",
              failure: {
                _tag: "TurnFailed",
                account: route.account.name,
                reason: result,
              },
            };
          return {
            status: "completed",
            ...(result === "missing"
              ? {}
              : {
                  structuredOutput:
                    result === "invalid"
                      ? { answer: "bad" }
                      : {
                          answer: result === "repairable" ? -1 : 3,
                          note: null,
                        },
                }),
          };
        },
      ],
      { limit: 2, retries: 0 },
    );
    try {
      const record = summary(await w.start());
      expect(record).toMatchObject({
        status: ["valid", "repairable"].includes(result)
          ? "final-generation"
          : "backstop",
        turnsUsed: 3,
      });
      if (result === "repairable")
        expect(
          w.run.ctx.log
            .read()
            .some(
              (record) =>
                record.type === "gap" && record["kind"] === "output-repaired",
            ),
        ).toBe(true);
      expect(w.fake.closes()).toBe(1);
    } finally {
      await w.close();
    }
  });
}

test("final handler refuses before running even a valid submit or stateful tool", async () => {
  const w = await setup(
    "final-tools",
    [
      async (turn) => {
        await turn.message();
      },
      async (turn) => {
        const calls = [probe("forbidden", 9), submit("forbidden-submit", 8)];
        await turn.message(calls);
        for (const item of calls)
          expect(await turn.invoke(item)).toMatchObject({
            text: FINAL_TOOLS_UNAVAILABLE,
            endTurn: true,
          });
      },
    ],
    { limit: 1, retries: 0 },
  );
  try {
    expect(summary(await w.start())).toMatchObject({ status: "backstop" });
    expect(w.run.probes).toEqual([]);
    expect(contractFacts(await w.state()).calls).toEqual([]);
    expect(w.fake.closes()).toBe(1);
  } finally {
    await w.close();
  }
});

test("handler waits for the committed message and uses its original arguments", async () => {
  const w = await setup("barrier", [
    async (turn) => {
      const item = probe("early", 1);
      const pending = turn.invoke({ ...item, input: { n: 99 } });
      await Promise.resolve();
      expect(w.run.probes).toEqual([]);
      const message = await turn.message([item]);
      expect((await pending).endTurn).toBeUndefined();
      expect(w.run.probes).toEqual([{ n: 1 }]);
      await turn.send(message); // A native replay is one committed message.
      const end = submit("done", 2);
      await turn.message([end]);
      await turn.invoke(end);
    },
  ]);
  try {
    expect(summary(await w.start())).toMatchObject({ turnsUsed: 2 });
  } finally {
    await w.close();
  }
});

test("reverse parallel handler arrival preserves model order without waiting for the whole batch", async () => {
  const w = await setup("order", [
    async (turn) => {
      const calls = [
        probe("first", 1),
        probe("second", 2),
        submit("third", 3),
      ] as const;
      await turn.message(calls);
      const third = turn.invoke(calls[2]);
      const second = turn.invoke(calls[1]);
      await Promise.resolve();
      expect(w.run.probes).toEqual([]);
      await turn.invoke(calls[0]);
      await Promise.all([second, third]);
    },
  ]);
  try {
    expect(summary(await w.start())).toMatchObject({ status: "submitted" });
    expect(w.run.probes).toEqual([{ n: 1 }, { n: 2 }]);
  } finally {
    await w.close();
  }
});

test("a call following endTurn is answered without running and cannot alter the accepted output", async () => {
  const w = await setup("after-end", [
    async (turn) => {
      const first = submit("accept", 3);
      const later = probe("suppressed", 4);
      await turn.message([first, later, submit("suppressed-submit", 7)]);
      await turn.invoke(first);
      expect(await turn.invoke(later)).toEqual({
        text: ROUND_ENDED,
        endTurn: true,
      });
      expect(await turn.invoke(submit("suppressed-submit", 7))).toEqual({
        text: ROUND_ENDED,
        endTurn: true,
      });
    },
  ]);
  try {
    expect(summary(await w.start())).toMatchObject({ status: "submitted" });
    expect(w.run.probes).toEqual([]);
    expect(contractFacts(await w.state()).calls.map((c) => c.id)).toEqual([
      "accept",
    ]);
  } finally {
    await w.close();
  }
});

for (const scope of ["turn", "request"] as const) {
  test(`${scope} usage ledger excludes message usage and retains each model`, async () => {
    const w = await setup(`usage-${scope}`, [
      async (turn) => {
        await turn.charge({ ...usage, input: 10 }, scope, "model-a");
        await turn.charge({ ...usage, input: 20 }, scope, "model-a");
        await turn.charge({ ...usage, input: 5 }, scope, "model-b");
        const item = submit("usage-submit", 1);
        await turn.message([item], { usage: { ...usage, input: 1_000 } });
        await turn.invoke(item);
      },
    ]);
    try {
      expect(summary(await w.start())?.usage.input).toBe(
        scope === "turn" ? 25 : 35,
      );
      const state = await w.state();
      const before = w.run.ctx.log
        .read()
        .filter((r) => r.type === "model.call");
      expect(before).toHaveLength(1);
      expect(before[0]).toMatchObject({
        responseId: state.events.find((e) => e.type === "message.finished")
          ?.messageId,
        costUsd: null,
      });
      emitContractTelemetry(state, w.run.ctx.log, route);
      expect(
        w.run.ctx.log.read().filter((r) => r.type === "model.call"),
      ).toEqual(before);
    } finally {
      await w.close();
    }
  });
}

for (const failure of [
  "open",
  "start",
  "outcome",
  "startup-result",
  "usage",
  "resume-point",
  "mixed-usage",
] as const) {
  test(`${failure} follows the native failure policy and closes any acquired session`, async () => {
    const w = await setup(`failure-${failure}`, [
      async (turn) => {
        if (failure === "startup-result") {
          await turn.message();
          return {
            status: "failed",
            disposition: "broken",
            failure: {
              _tag: "RuntimeUnavailable",
              account: route.account.name,
              reason: "start-failed",
            },
          };
        }
        if (failure === "mixed-usage") {
          await turn.charge(usage, "turn");
          await turn.charge(usage, "request");
        } else if (failure === "usage")
          await turn.message([], { usage: undefined });
        // A stage's runtime resumes inside a turn, so a message without its point is a protocol error.
        else if (failure === "resume-point")
          await turn.message([], { resumePoint: undefined });
        return {
          status: "failed",
          disposition: "broken",
          failure: {
            _tag: "TurnFailed",
            account: route.account.name,
            reason: "provider-unavailable",
          },
        };
      },
    ]);
    if (failure === "open") w.fake.openError();
    if (failure === "start") w.fake.startError();
    try {
      if (["open", "start", "outcome", "startup-result"].includes(failure)) {
        await w.begin();
        const held = await waitHeld(w.opened.harness);
        expect(held.failure._tag).toBe(
          failure === "open" || failure === "startup-result"
            ? "RuntimeUnavailable"
            : "TurnFailed",
        );
        expect(held.recovery.kind).toBe("explicit-account");
        expect(w.fake.closes()).toBe(failure === "open" ? 0 : 1);
        return;
      }
      const result = await w.start();
      expect(result.status).toBe("failed");
      if (result.status === "failed")
        expect(result.error.detail).toMatchObject({
          retryable: false,
          tag:
            failure === "open"
              ? "RuntimeUnavailable"
              : failure === "mixed-usage"
                ? "ContractProtocolFailure"
                : "TurnFailed",
        });
      expect(w.fake.closes()).toBe(failure === "open" ? 0 : 1);
    } finally {
      await w.close();
    }
  });
}

test("cut-off closes an in-flight contract session", async () => {
  const w = await setup("cutoff", [
    async (turn) => {
      await untilAborted(turn.signal);
    },
  ]);
  try {
    expect((await w.start(Date.now() + 40)).status).toBe("aborted");
    expect(w.fake.closes()).toBe(1);
  } finally {
    await w.close();
  }
});

test("runtime interruption closes the session and preserves an interrupted record", async () => {
  const w = await setup("interrupt", [
    async () => ({ status: "interrupted", reason: "stop" }),
  ]);
  try {
    expect((await w.start()).status).toBe("aborted");
    expect(w.fake.closes()).toBe(1);
  } finally {
    await w.close();
  }
});

function untilAborted(signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

// Why: stopping the owner must close the session even when no tool or runtime event arrives.
test("owner abort closes an in-flight session and releases a message-barrier waiter", async () => {
  let started = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const w = await setup("owner-abort", [
    async (turn) => {
      const waiting = turn
        .invoke(probe("never-published", 1), turn.signal)
        .catch(() => {});
      started();
      await untilAborted(turn.signal);
      await waiting;
    },
  ]);
  try {
    const id = await w.begin();
    await ready;
    await w.opened.harness.abortTask(id, context);
    expect(
      (await w.opened.harness.waitForTask(id, context)).state.outcome.status,
    ).toBe("aborted");
    expect(w.fake.closes()).toBe(1);
    expect(w.run.probes).toEqual([]);
  } finally {
    await w.close();
  }
});

// Why: refusal retries must remain final turns and retain today's prompt and allowance.
test("a refused final output gets the existing refusal prompt, then can succeed", async () => {
  const w = await setup(
    "final-retry",
    [
      async (turn) => {
        await turn.message();
      },
      async (turn) => {
        expect(turn.final).toBe(true);
        await turn.message();
      },
      async (turn) => {
        expect(turn.prompt).toContain("[harness: output refused]");
        return final(turn);
      },
    ],
    { limit: 1 },
  );
  try {
    expect(summary(await w.start())).toMatchObject({
      status: "final-generation",
      turnsUsed: 3,
    });
    expect(w.fake.closes()).toBe(1);
  } finally {
    await w.close();
  }
});

// Why: a reminder must survive result clipping and only be delivered once per context.
test("the 85-percent reminder is appended once to an eligible tool result", async () => {
  const w = await setup(
    "reminder",
    [
      async (turn) => {
        for (let i = 1; i <= 5; i++) {
          const item = probe(`p${i}`, i);
          await turn.message([item]);
          const result = await turn.invoke(item);
          expect(result.text.includes("[harness: reminder]")).toBe(i === 5);
          expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(
            TOOL_RESULT_BYTES,
          );
        }
        const end = submit("finish", 1);
        await turn.message([end]);
        await turn.invoke(end);
      },
    ],
    {
      configure: (step) => ({
        ...step,
        spec: {
          ...step.spec,
          tools: step.spec.tools.map((tool) => ({
            ...tool,
            handle: (input, call) =>
              tool.handle(input, call).pipe(
                Effect.map((outcome) => ({
                  ...outcome,
                  text: "result".repeat(4_000),
                })),
              ),
          })),
        },
      }),
    },
  );
  try {
    expect(summary(await w.start())).toMatchObject({ status: "submitted" });
    expect((await w.state()).reminder).toBe(true);
  } finally {
    await w.close();
  }
});

// Why: a dead stream or a failed final outcome must close the same scope as a successful turn.
for (const failure of ["stream-ended", "final-provider"] as const) {
  test(`${failure} cannot leave a contract session open`, async () => {
    const scripts: Script[] =
      failure === "stream-ended"
        ? [
            async (turn) => {
              turn.endStream();
              await untilAborted(turn.signal);
            },
          ]
        : [
            async (turn) => {
              await turn.message();
            },
            async () => ({
              status: "failed",
              disposition: "broken",
              failure: {
                _tag: "TurnFailed",
                account: route.account.name,
                reason: "provider-failed",
              },
            }),
          ];
    const w = await setup(failure, scripts, { limit: 1 });
    try {
      if (failure === "final-provider") {
        await w.begin();
        expect(await waitHeld(w.opened.harness)).toMatchObject({
          mode: "final",
          failure: { _tag: "TurnFailed", reason: "provider-failed" },
        });
        expect(w.fake.closes()).toBe(1);
        return;
      }
      const outcome = await w.start();
      expect(outcome.status).toBe("failed");
      if (outcome.status === "failed")
        expect(outcome.error.detail).toMatchObject({
          tag: "TurnFailed",
          retryable: false,
        });
      expect(w.fake.closes()).toBe(1);
    } finally {
      await w.close();
    }
  });
}

// Why: a native refusal is a completed stage turn, not a zero-turn transport failure.
test("a native refusal counts as a message and continues with the existing prompt", async () => {
  const w = await setup("refusal", [
    async (turn) => {
      await turn.message([], { stopReason: "refusal" });
    },
    async (turn) => {
      expect(turn.prompt).toContain("[harness: open items]");
      return accept(turn);
    },
  ]);
  try {
    expect(summary(await w.start())).toMatchObject({
      turnsUsed: 2,
      status: "submitted",
    });
    expect(
      w.run.ctx.log
        .read()
        .filter((r) => r.type === "gap" && r["kind"] === "refusal"),
    ).toHaveLength(1);
  } finally {
    await w.close();
  }
});

// Why: the effect must see its started marker, and a duplicate callback must return the committed result.
test("started and completed tool markers surround a single stateful effect", async () => {
  const w = await setup(
    "started-marker",
    [
      async (turn) => {
        const item = probe("once", 1);
        await turn.message([item]);
        const first = await turn.invoke(item);
        expect(await turn.invoke(item)).toEqual(first);
        const end = submit("after-once", 1);
        await turn.message([end]);
        await turn.invoke(end);
      },
    ],
    {
      configure: (step) => ({
        ...step,
        spec: {
          ...step.spec,
          tools: step.spec.tools.map((tool) => ({
            ...tool,
            handle: (input, call) =>
              Effect.gen(function* () {
                const state = yield* Effect.promise(() => w.state());
                expect(state.calls[call?.callId ?? ""]).toEqual({
                  status: "started",
                  eligible: true,
                });
                return yield* tool.handle(input, call);
              }),
          })),
        },
      }),
    },
  );
  try {
    expect(summary(await w.start())).toMatchObject({ status: "submitted" });
    expect(w.run.probes).toEqual([{ n: 1 }]);
    expect((await w.state()).calls["once"]).toMatchObject({
      status: "completed",
      eligible: true,
    });
    expect((await w.state()).toolState?.handles?.seen).toEqual([
      [
        "p1",
        [
          {
            turn: 1,
            lookup: "probe",
            args: { n: 1 },
            parent: null,
            retrieval: null,
          },
        ],
      ],
    ]);
  } finally {
    await w.close();
  }
});

// Why: endTurn permits runtimes to cancel uninvoked siblings without invalidating an accepted submit.
test("cancelled siblings after an accepted submission remain ineligible", async () => {
  let acceptedOutput: unknown;
  const w = await setup(
    "cancelled-sibling",
    [
      async (turn) => {
        const accepted = submit("accepted", 2);
        await turn.message([
          accepted,
          probe("cancelled-probe", 9),
          submit("cancelled-submit", 7),
        ]);
        expect((await turn.invoke(accepted)).endTurn).toBe(true);
      },
    ],
    {
      configure: (step) => ({
        ...step,
        compose: (result) => {
          acceptedOutput = result.output;
          return step.compose(result);
        },
      }),
    },
  );
  try {
    expect(summary(await w.start())).toMatchObject({ status: "submitted" });
    expect(acceptedOutput).toEqual({ answer: 2 });
    const state = await w.state();
    expect(state.calls["cancelled-probe"]).toEqual({
      status: "cancelled",
      eligible: false,
    });
    expect(state.calls["cancelled-submit"]).toEqual({
      status: "cancelled",
      eligible: false,
    });
    expect(contractFacts(state).calls.map((c) => c.id)).toEqual(["accepted"]);
    expect(w.run.probes).toEqual([]);
  } finally {
    await w.close();
  }
});

// Why: an explicit runtime cancellation must release the ordered handler barrier before turn end.
test("an errored settlement releases a later sibling waiting on an observed call", async () => {
  const w = await setup("settled-barrier", [
    async (turn) => {
      const later = submit("later", 2);
      await turn.message([probe("cancelled", 1), later]);
      const waiting = turn.invoke(later, turn.signal);
      await turn.send({
        type: "tool.finished",
        turnId: turn.turnId,
        at: new Date().toISOString(),
        callId: "cancelled",
        toolName: "probe",
        errored: true,
      });
      expect((await waiting).endTurn).toBe(true);
    },
  ]);
  try {
    expect(summary(await w.start())).toMatchObject({ status: "submitted" });
    expect((await w.state()).calls.cancelled).toEqual({
      status: "cancelled",
      eligible: false,
    });
    expect(w.run.probes).toEqual([]);
  } finally {
    await w.close();
  }
});

// Why: the runtime can publish a held cancellation before collecting the call's message.
for (const status of ["completed", "interrupted", "failed"] as const) {
  test(`a cancelled announcement's message preserves the ${status} turn`, async () => {
    const outcome: TurnOutcome =
      status === "failed"
        ? {
            status: "failed",
            disposition: "broken",
            failure: {
              _tag: "TurnFailed",
              account: route.account.name,
              reason: "provider-failed",
            },
          }
        : { status };
    const w = await setup(
      `held-cancellation-${status}`,
      [
        async (turn) => {
          for (const item of [
            probe("cancelled-probe", 1),
            submit("cancelled-submit", 7),
          ]) {
            await turn.send({
              type: "tool.started",
              turnId: turn.turnId,
              at: new Date().toISOString(),
              ...item,
            });
            await turn.send({
              type: "tool.finished",
              turnId: turn.turnId,
              at: new Date().toISOString(),
              callId: item.callId,
              toolName: item.toolName,
              errored: true,
            });
            const message = await turn.message([item]);
            await turn.send(message); // Exact redelivery must preserve the cancellation too.
          }
          return outcome;
        },
        ...(status === "completed" ? [final] : []),
      ],
      { limit: 1 },
    );
    try {
      if (status === "failed") {
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
      } else if (status === "completed") {
        expect(summary(await w.start())).toMatchObject({
          status: "final-generation",
          endedBy: "turn-limit",
        });
      } else {
        expect(await w.start()).toMatchObject({
          status: "aborted",
          result: {
            status: "interrupted",
            agentResult: { status: "interrupted", endedBy: "timeout" },
          },
        });
      }
      const state = await w.state();
      expect(state.rounds[0]).toMatchObject({
        state: "settled",
        outcome,
        announced: {},
      });
      expect(state.calls).toEqual({
        "cancelled-probe": { status: "cancelled", eligible: false },
        "cancelled-submit": { status: "cancelled", eligible: false },
      });
      expect(contractFacts(state).calls).toEqual([]);
      const messages = state.events
        .filter((event) => event.type === "message.finished")
        .filter((event) => event.turnId === state.rounds[0]?.id);
      const point = messages.at(-1)?.resumePoint;
      expect(point).toBeDefined();
      expect(
        recoveryText({
          ...state,
          events: messages,
          native: { sessionId: "native-open", resumePoint: point ?? null },
        }),
      ).toBe("");
      expect(w.run.probes).toEqual([]);
      expect(w.run.sent).toEqual([]);
      expect(w.fake.outcomes).toEqual([]);
      expect(
        w.run.ctx.log.read().filter((event) => event.type === "tool.call"),
      ).toEqual([]);
    } finally {
      await w.close();
    }
  });
}

// Why: announcements must not authorize effects or accept malformed runtime identities and settlements.
for (const scenario of [
  "successful",
  "undeclared",
  "repeated",
  "cancelled-mismatched-message",
  "cancelled-ledger-call",
  "mismatched-message",
] as const) {
  test(`${scenario} announcement stays a protocol error`, async () => {
    const w = await setup(`announcement-${scenario}`, [
      async (turn) => {
        const item = probe("announced", 1);
        const event = {
          type: "tool.started" as const,
          turnId: turn.turnId,
          at: new Date().toISOString(),
          ...item,
          ...(scenario === "undeclared" ? { toolName: "not-frozen" } : {}),
        };
        await turn.send(event);
        if (scenario === "repeated") await turn.send(event);
        else if (
          scenario === "successful" ||
          scenario === "cancelled-mismatched-message" ||
          scenario === "cancelled-ledger-call"
        ) {
          await turn.send({
            type: "tool.finished",
            turnId: turn.turnId,
            at: new Date().toISOString(),
            callId: item.callId,
            toolName: item.toolName,
            errored: scenario !== "successful",
          });
          if (scenario === "cancelled-mismatched-message")
            await turn.message([submit(item.callId, 2)]);
          else if (scenario === "cancelled-ledger-call") {
            await turn.message([item]);
            await turn.message([item]);
          }
        } else if (scenario === "mismatched-message")
          await turn.message([submit(item.callId, 2)]);
      },
    ]);
    try {
      expect(await w.start()).toMatchObject({
        status: "failed",
        error: {
          detail: {
            tag: "TurnFailed",
            reason: "protocol-error",
            retryable: false,
          },
        },
      });
      expect(w.run.probes).toEqual([]);
      expect(w.fake.outcomes).toEqual([]);
      if (scenario === "cancelled-mismatched-message")
        expect((await w.state()).rounds[0]?.announced.announced).toEqual({
          toolName: "probe",
          status: "cancelled",
        });
    } finally {
      await w.close();
    }
  });
}

// Why: an announcement is durable before acknowledgement, but only a finished message permits execution.
test("an announced call waits for its finished message and then follows the existing path", async () => {
  const published = Promise.withResolvers<void>();
  const w = await setup(
    "announced-observed",
    [
      async (turn) => {
        const item = submit("announced-submit", 2);
        await turn.send({
          type: "tool.started",
          turnId: turn.turnId,
          at: new Date().toISOString(),
          ...item,
        });
        await published.promise;
        const state = await w.state();
        expect(state.rounds[0]?.announced).toEqual({
          "announced-submit": { toolName: "submit_frame", status: "announced" },
        });
        expect(state.calls[item.callId]).toBeUndefined();
        const pending = turn.invoke(item);
        expect((await w.state()).calls[item.callId]).toBeUndefined();
        expect(w.fake.outcomes).toEqual([]);
        await turn.message([item]);
        expect((await pending).endTurn).toBe(true);
        await turn.send({
          type: "tool.finished",
          turnId: turn.turnId,
          at: new Date().toISOString(),
          callId: item.callId,
          toolName: item.toolName,
          errored: false,
        });
      },
    ],
    {
      afterCommit: async (port) => {
        const snapshot = await port.snapshot(
          ContractContextDoc,
          port.taskId,
          context,
        );
        if (
          snapshot?.data != null &&
          ContractState.parse(snapshot.data).rounds[0]?.announced[
            "announced-submit"
          ] !== undefined
        )
          published.resolve();
      },
    },
  );
  try {
    expect(summary(await w.start())).toMatchObject({ status: "submitted" });
    expect((await w.state()).calls["announced-submit"]).toMatchObject({
      status: "completed",
      eligible: true,
    });
    expect(w.fake.outcomes).toHaveLength(1);
  } finally {
    await w.close();
  }
});

// Why: older persisted rounds have no announcements and must keep their saved point and call ledger.
test("historical stage documents default to no announced calls", async () => {
  const w = await setup("historical-announcements", [accept]);
  try {
    await w.start();
    const state = await w.state();
    const legacy = {
      ...state,
      rounds: state.rounds.map(({ announced, ...round }) => round),
    };
    expect(ContractState.parse(legacy)).toEqual({
      ...state,
      rounds: state.rounds.map((round) => ({ ...round, announced: {} })),
    });
  } finally {
    await w.close();
  }
});

// Why: only an errored settlement of an observed or announced call can cancel it without a committed outcome.
for (const status of ["observed", "started", "unknown"] as const) {
  test(`${status} call with an invalid tool settlement stays a protocol error`, async () => {
    const w = await setup(
      `invalid-settlement-${status}`,
      [
        async (turn) => {
          const item = probe("unsettled", 1);
          await turn.message(status === "unknown" ? [] : [item]);
          if (status === "started")
            await turn.invoke(item, turn.signal).catch(() => {});
          await turn.send({
            type: "tool.finished",
            turnId: turn.turnId,
            at: new Date().toISOString(),
            callId: item.callId,
            toolName: item.toolName,
            errored: status !== "observed",
          });
        },
      ],
      {
        configure: (step) => ({
          ...step,
          spec: {
            ...step.spec,
            tools: step.spec.tools.map((tool) => ({
              ...tool,
              handle: () => Effect.die(new Error("No committed outcome")),
            })),
          },
        }),
      },
    );
    try {
      const result = await w.start();
      expect(result.status).toBe("failed");
      if (result.status === "failed")
        expect(result.error.detail).toMatchObject({
          tag: "TurnFailed",
          reason: "protocol-error",
        });
      expect(w.run.probes).toEqual([]);
    } finally {
      await w.close();
    }
  });
}

// Why: absent an explicit settlement, only policy-ended messages and final-turn calls may be cancelled.
for (const finalTurn of [false, true]) {
  test(`undelivered calls in a ${finalTurn ? "final" : "non-ending"} message`, async () => {
    const script: Script = async (turn) => {
      await turn.message([probe("undelivered", 1)]);
      return {
        status: "completed",
        ...(finalTurn ? { structuredOutput: { answer: 4 } } : {}),
      };
    };
    let acceptedOutput: unknown;
    const w = await setup(
      `undelivered-${finalTurn}`,
      finalTurn
        ? [
            async (turn) => {
              await turn.message();
            },
            script,
          ]
        : [script],
      {
        limit: 1,
        configure: (step) => ({
          ...step,
          compose: (result) => {
            acceptedOutput = result.output;
            return step.compose(result);
          },
        }),
      },
    );
    try {
      const result = await w.start();
      if (finalTurn) {
        expect(summary(result)).toMatchObject({ status: "final-generation" });
        expect(acceptedOutput).toEqual({ answer: 4 });
        expect((await w.state()).calls["undelivered"]).toEqual({
          status: "cancelled",
          eligible: false,
        });
      } else {
        expect(result.status).toBe("failed");
        if (result.status === "failed")
          expect(result.error.detail).toMatchObject({
            tag: "TurnFailed",
            reason: "protocol-error",
          });
      }
      expect(w.run.probes).toEqual([]);
    } finally {
      await w.close();
    }
  });
}

// Why: a failed terminal event or dead stream must release handlers waiting for missing earlier calls, before cutoff.
for (const failure of ["terminal", "dead-stream"] as const) {
  test(`${failure} releases an undelivered handler and preserves the failure`, async () => {
    let released = false;
    const w = await setup(`failed-waiter-${failure}`, [
      async (turn) => {
        await turn.message([
          probe("never-delivered", 1),
          probe("waiting-sibling", 2),
        ]);
        const waiting = turn.invoke(probe("waiting-sibling", 2)).then(
          () => {
            throw new Error("Waiting tool must fail");
          },
          () => {
            released = true;
          },
        );
        if (failure === "terminal")
          await turn.send({
            type: "turn.finished",
            turnId: turn.turnId,
            at: new Date().toISOString(),
            outcome: {
              status: "failed",
              disposition: "reusable",
              failure: {
                _tag: "TurnFailed",
                account: route.account.name,
                reason: "provider-failed",
              },
            },
          });
        else turn.endStream();
        await waiting;
      },
    ]);
    try {
      if (failure === "terminal") {
        await w.begin();
        expect(await waitHeld(w.opened.harness)).toMatchObject({
          failure: { reason: "provider-failed" },
        });
        expect(released).toBe(true);
        expect(w.fake.closes()).toBe(1);
        expect(w.run.probes).toEqual([]);
        return;
      }
      const result = await w.start(Date.now() + 250);
      expect(result.status).toBe("failed");
      if (result.status === "failed")
        expect(result.error.detail).toMatchObject({
          tag: "TurnFailed",
          reason: "protocol-error",
          retryable: false,
        });
      expect(released).toBe(true);
      expect(w.run.probes).toEqual([]);
      expect(w.fake.closes()).toBe(1);
      expect((await w.state()).rounds[0]).toMatchObject({
        state: "settled",
        outcome: {
          status: "failed",
          failure: {
            reason: "protocol-error",
          },
        },
      });
    } finally {
      await w.close();
    }
  });
}

// Why: neither unexpected provider prose nor an incidental message on a typed failure may reach durable task, capture or log records.
for (const known of [false, true]) {
  test(`${known ? "typed" : "unexpected"} runtime errors retain only safe failure fields`, async () => {
    const marker = "SYNTHETIC_PROVIDER_SECRET_7f3";
    const w = await setup(`safe-error-${known}`, []);
    const error = known
      ? new TurnFailed({
          account: route.account.name,
          reason: "provider-failed",
        })
      : new Error(marker);
    Object.defineProperty(error, "message", { value: marker });
    w.fake.openDefect(error);
    try {
      if (known) {
        await w.begin();
        const held = await waitHeld(w.opened.harness);
        expect(held.failure).toEqual({
          _tag: "TurnFailed",
          account: route.account.name,
          reason: "provider-failed",
        });
        expect(
          JSON.stringify([held, w.run.events, w.run.ctx.log.read()]),
        ).not.toContain(marker);
        return;
      }
      const result = await w.start();
      expect(result.status).toBe("failed");
      if (result.status === "failed")
        expect(result.error.detail).toEqual(
          known
            ? {
                _tag: "TurnFailed",
                account: route.account.name,
                reason: "provider-failed",
                tag: "TurnFailed",
                message: "Turn failed: provider-failed.",
                retryable: false,
              }
            : {
                tag: "ContractProtocolFailure",
                message: "the runtime failed unexpectedly",
                retryable: false,
              },
        );
      expect(
        JSON.stringify([result, w.run.events, w.run.ctx.log.read()]),
      ).not.toContain(marker);
      expect(w.run.events).toContainEqual(
        expect.objectContaining({
          type: "stage.end",
          status: "failed",
          reason: known
            ? "TurnFailed: Turn failed: provider-failed."
            : "ContractProtocolFailure: the runtime failed unexpectedly",
        }),
      );
    } finally {
      await w.close();
    }
  });
}

// Why: streaming deltas must not turn the recovery document into a per-token write log, and the run log
// holds no prompt bodies or tool content, so streamed text is dropped and inputs are hashed.
test("text deltas cause no SQLite document writes, and the run log keeps only their metadata", async () => {
  const writes: number[] = [];
  for (const deltas of [0, 500]) {
    const w = await setup(`deltas-${deltas}`, [
      async (turn) => {
        for (let i = 0; i < deltas; i++)
          await turn.send({
            type: "text",
            turnId: turn.turnId,
            at: new Date().toISOString(),
            text: "SYNTHETIC_MODEL_TEXT_d41",
          });
        const base = { turnId: turn.turnId, at: new Date().toISOString() };
        await turn.send({
          ...base,
          type: "tool.started",
          callId: "deltas-submit",
          toolName: "submit_frame",
          input: { answer: "SYNTHETIC_TOOL_INPUT_9c2" },
        });
        if (deltas > 0) {
          await turn.send({ ...base, type: "retry", attempt: 1, delayMs: 0 });
          await turn.send({
            ...base,
            type: "rate-limit",
            window: "five-hour",
            status: "warning",
          });
          await turn.send({
            ...base,
            type: "approval.requested",
            requestId: "synthetic-approval",
            callId: "deltas-submit",
            toolName: "submit_frame",
            input: { answer: "SYNTHETIC_TOOL_INPUT_9c2" },
          });
        }
        const item = submit("deltas-submit", 1);
        await turn.message([item]);
        await turn.invoke(item);
        await turn.send({
          type: "tool.finished",
          turnId: turn.turnId,
          at: new Date().toISOString(),
          callId: item.callId,
          toolName: item.toolName,
          errored: false,
        });
        await turn.charge(usage);
      },
    ]);
    const db = new Database(w.run.database);
    db.exec(`CREATE TABLE contract_writes (value INTEGER);
      CREATE TRIGGER contract_document_write AFTER UPDATE ON documents WHEN json_extract(NEW.record, '$.kind') = 'neuve.contract-context'
      BEGIN INSERT INTO contract_writes VALUES (1); END;
      CREATE TRIGGER contract_revision_write AFTER INSERT ON document_revisions WHEN EXISTS (SELECT 1 FROM documents WHERE id = NEW.document_id AND json_extract(record, '$.kind') = 'neuve.contract-context')
      BEGIN INSERT INTO contract_writes VALUES (1); END;`);
    try {
      expect(summary(await w.start())).toMatchObject({ status: "submitted" });
      writes.push(
        z
          .object({ count: z.number() })
          .parse(
            db.query("SELECT COUNT(*) AS count FROM contract_writes").get(),
          ).count,
      );
      expect((await w.state()).events.map((e) => e.type)).toEqual([
        "message.finished",
        "tool.finished",
        "usage",
        "turn.finished",
      ]);
      const logged = w.run.ctx.log
        .read()
        .filter((r) => r.type === "runtime.event")
        .map((r) => z.object({ type: z.string() }).parse(r["event"]).type);
      expect(logged.filter((type) => type === "text")).toHaveLength(0);
      const log = JSON.stringify(w.run.ctx.log.read());
      expect(log).not.toContain("SYNTHETIC_MODEL_TEXT_d41");
      expect(log).not.toContain("SYNTHETIC_TOOL_INPUT_9c2");
      if (deltas > 0)
        expect(
          w.run.ctx.log
            .read()
            .filter((r) => r.type === "runtime.event")
            .map((r) => r["event"]),
        ).toContainEqual(
          expect.objectContaining({
            type: "tool.started",
            callId: "deltas-submit",
            argsHash: expect.stringMatching(/^[0-9a-f]{16}$/),
          }),
        );
      if (deltas > 0)
        expect(logged).toEqual(
          expect.arrayContaining([
            "tool.started",
            "retry",
            "rate-limit",
            "approval.requested",
          ]),
        );
    } finally {
      db.close();
      await w.close();
    }
  }
  expect(writes[0]).toBeGreaterThan(0);
  expect(writes[1]).toBe(writes[0]);
});

// Why: the next recovery round needs durable counters and decisions, while pre-fix documents must still parse.
test("loop state and physical attempts are persisted with backward-compatible defaults", async () => {
  const w = await setup(
    "loop-state",
    [
      async (turn) => {
        await turn.message();
      },
      async (turn) => {
        await turn.message();
      },
      async (turn) => {
        await turn.message();
      },
      final,
    ],
    { limit: 2 },
  );
  try {
    expect(summary(await w.start())).toMatchObject({
      status: "final-generation",
    });
    const state = await w.state();
    expect(state).toMatchObject({
      continuations: 1,
      refusals: 1,
      endedBy: "turn-limit",
      final: true,
    });
    expect(state.rounds.map((r) => r.attempt)).toEqual([1, 1, 1, 1]);
    const legacy = {
      ...state,
      rounds: state.rounds.map(({ attempt, ...r }) => r),
    };
    const {
      continuations,
      refusals,
      endedBy,
      final: finalFlag,
      ...old
    } = legacy;
    expect(ContractState.parse(old)).toMatchObject({
      continuations: 0,
      refusals: 0,
      endedBy: "turn-limit",
      final: false,
    });
    expect(ContractState.parse(old).rounds.map((r) => r.attempt)).toEqual([
      1, 1, 1, 1,
    ]);
  } finally {
    await w.close();
  }
});

// Why: a schema error quotes an unrecognized submitted key, so a backstop gap logs no cause, as pi's does;
// only repaired output, whose schema parsed, keeps its check messages.
for (const path of ["submissions", "final"] as const) {
  test(`a ${path} backstop logs its gap without a cause that could quote submitted keys`, async () => {
    const marker = "SYNTHETIC_SUBMITTED_KEY_b17";
    const scripts: Script[] =
      path === "submissions"
        ? [
            async (turn) => {
              for (const i of [0, 1]) {
                const item = call(`k${i}`, "submit_frame", {
                  answer: 2,
                  [marker]: 1,
                });
                await turn.message([item]);
                await turn.invoke(item);
              }
              await turn.charge(usage);
            },
          ]
        : [
            async (turn) => {
              await turn.message();
            },
            async (turn) => {
              await turn.message();
            },
            async (turn) => {
              await turn.message();
              return {
                status: "completed",
                structuredOutput: { answer: 3, [marker]: 1 },
              };
            },
          ];
    const w = await setup(`gap-${path}`, scripts, {
      limit: 2,
      retries: path === "final" ? 0 : 1,
    });
    try {
      expect(summary(await w.start())).toMatchObject({ status: "backstop" });
      const gaps = w.run.ctx.log.read().filter((r) => r.type === "gap");
      expect(gaps.length).toBeGreaterThan(0);
      for (const gap of gaps) expect(gap["cause"]).toBeUndefined();
      expect(JSON.stringify(w.run.ctx.log.read())).not.toContain(marker);
    } finally {
      await w.close();
    }
  });
}
