// Why: restart safety depends on the committed task and Records stores, including the window between an effect and its outcome.
import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { copyJson } from "@earendil-works/chord";
import { Effect, Exit, Scope } from "effect";
import {
  RuntimeFailure,
  TurnFailureReason,
  RuntimeUnavailableReason,
  runtimeFailureToError,
} from "@neuve/runtime";
import {
  ContractContextDoc,
  ContractPartialsDoc,
} from "../../../src/pi/stages/docs.ts";
import { ContractState } from "../../../src/pi/stages/contract-state.ts";
import {
  runtimeFailurePolicy,
  heldFailure,
} from "../../../src/pi/failure-policy.ts";
import { admitResume } from "../../../src/pi/control.ts";
import {
  contractSessionSlots,
  continuationAccountKey,
} from "../../../src/pi/session-slots.ts";
import {
  Scheduler,
  type Budget,
  type Grant,
  type Request,
} from "../../../src/budget/scheduler.ts";
import {
  setup,
  submit,
  probe,
  usage,
  route,
  waitHeld,
  type Script,
} from "./contract-fixture.ts";

const untilAbort = (signal: AbortSignal) =>
  signal.aborted
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
const accepted: Script = async (turn) => {
  const call = submit(`accepted-${turn.turnId}`, 2);
  await turn.message([call]);
  await turn.invoke(call, turn.signal);
};

// Why: session-open failures happen before dispatch and must preserve the original attempt.
test("a transient session-open failure can explicitly resume before any dispatch", async () => {
  const w = await setup("open-resume", [
    async (turn) => {
      expect((await w.state()).rounds.at(-1)).toMatchObject({
        attempt: 1,
        dispatched: true,
      });
      await accepted(turn);
    },
  ]);
  w.fake.openError();
  try {
    const id = await w.begin();
    expect(await waitHeld(w.opened.harness)).toMatchObject({
      failure: { _tag: "RuntimeUnavailable", reason: "start-failed" },
    });
    expect(w.fake.turns).toHaveLength(0);
    expect((await w.state()).rounds.at(-1)).toMatchObject({
      attempt: 1,
      dispatched: false,
    });
    w.fake.openError(false);
    expect(
      await admitResume(w.opened.harness, "open-recovered", context, {
        runtimes: w.fake.registry,
      }),
    ).toBe("committed");
    expect(
      (await w.opened.harness.waitForTask(id, context)).state.outcome.status,
    ).toBe("completed");
    expect(w.fake.starts).toEqual([{ kind: "new" }]);
    expect(w.fake.turns).toHaveLength(1);
  } finally {
    await w.close();
  }
});

// Why: only the last message is uncertain, and preparing its retry must survive another crash.
test("round 3 recovers only its last message once across a second reopen", async () => {
  let reachedCrash = () => {};
  const crashed = new Promise<void>((resolve) => {
    reachedCrash = resolve;
  });
  let reachedRetry = () => {};
  const retried = new Promise<void>((resolve) => {
    reachedRetry = resolve;
  });
  let phase = 0;
  let retryPrompt = "";
  const settled: Script = async (turn) => {
    const call = probe(`settled-${turn.turnId}`, 1);
    await turn.message([call]);
    await turn.invoke(call, turn.signal);
    await turn.message();
    await turn.send({
      type: "turn.finished",
      turnId: turn.turnId,
      at: new Date().toISOString(),
      outcome: { status: "completed" },
    });
  };
  const w = await setup(
    "last-message-once",
    [
      settled,
      settled,
      async (turn) => {
        const earlier = probe("earlier-in-round-3", 2);
        await turn.message([earlier]);
        await turn.invoke(earlier, turn.signal);
        const last = probe("uncertain-in-round-3", 3);
        await turn.message([last]);
        await turn.invoke(last, turn.signal);
      },
      async (turn) => {
        expect(turn.prompt).toEqual(retryPrompt);
        expect(turn.prompt.match(/Call uncertain-in-round-3/g)).toHaveLength(1);
        expect(turn.prompt).not.toContain("Call settled-");
        expect(turn.prompt).not.toContain("Call earlier-in-round-3");
        expect(turn.prompt).toContain("probed 3");
        expect((await w.state()).rounds.at(-1)).toMatchObject({
          attempt: 2,
          dispatched: true,
        });
        await accepted(turn);
      },
    ],
    {
      limit: 20,
      afterCommit: async (port) => {
        const snapshot = await port.snapshot(
          ContractContextDoc,
          port.taskId,
          context,
        );
        if (snapshot?.data == null) return;
        const state = ContractState.parse(snapshot.data);
        const round = state.rounds.at(-1);
        if (
          phase === 0 &&
          state.calls["uncertain-in-round-3"]?.status === "completed"
        ) {
          phase = 1;
          reachedCrash();
          await untilAbort(port.signal);
        } else if (
          phase === 1 &&
          round?.state === "prepared" &&
          round.recovery !== null
        ) {
          phase = 2;
          retryPrompt = `${round.recovery}\n\n${round.prompt}`;
          expect(round.attempt).toBe(1);
          reachedRetry();
          await untilAbort(port.signal);
        }
      },
    },
  );
  try {
    const id = await w.begin();
    await crashed;
    expect((await w.state()).rounds.map((round) => round.state)).toEqual([
      "settled",
      "settled",
      "active",
    ]);
    await w.opened.harness.close(context);
    await w.reopen();
    await retried;
    await w.opened.harness.close(context);
    await w.reopen();
    expect(
      (await w.opened.harness.waitForTask(id, context)).state.outcome.status,
    ).toBe("completed");
    expect(w.fake.turns).toHaveLength(4);
    expect(w.run.probes).toEqual([{ n: 1 }, { n: 1 }, { n: 2 }, { n: 3 }]);
    expect(w.fake.starts.at(-1)).toEqual({
      kind: "resume",
      session: "native-open",
      at: "point-3",
      fork: true,
    });
  } finally {
    await w.close();
  }
});

for (const point of [
  "before-dispatch",
  "after-open",
  "after-message",
  "after-started",
  "after-effect",
  "after-outcome",
  "after-settlement",
] as const) {
  test(`reopening ${point} never repeats a tool and pairs the fork id before dispatch`, async () => {
    let reached = () => {};
    const boundary = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let stopped = false;
    let before: ContractState | undefined;
    const pause = async (signal: AbortSignal) => {
      stopped = true;
      reached();
      await untilAbort(signal);
    };
    const w = await setup(
      `crash-${point}`,
      [
        async (turn) => {
          if (point === "before-dispatch" || point === "after-open") {
            expect((await w.state()).rounds.at(-1)?.attempt).toBe(1);
            return accepted(turn);
          }
          const call =
            point === "after-settlement"
              ? submit("old-submit", 2)
              : probe("old-call", 1);
          await turn.message([call]);
          await turn.charge(usage);
          await turn.invoke(call, turn.signal);
        },
        async (turn) => {
          const state = await w.state();
          expect(state.native).toEqual({
            sessionId: "fork-2",
            resumePoint: "point-1",
          });
          expect(Number(turn.policy.turnLimit)).toBe(5);
          expect(typeof turn.prompt).toBe("string");
          if (point === "after-outcome") {
            expect(turn.prompt).toContain(
              "Call old-call of probe already ran. Do not call it again. Its result was:",
            );
            expect(turn.prompt).toContain("probed 1");
          } else if (point === "after-started" || point === "after-effect") {
            expect(turn.prompt).toContain("outcome is unknown");
            expect(turn.prompt).toContain("Do not call it again");
          }
          await accepted(turn);
        },
      ],
      {
        afterCommit: async (port) => {
          if (stopped || point === "after-effect") return;
          const snapshot = await port.snapshot(
            ContractContextDoc,
            port.taskId,
            context,
          );
          if (snapshot?.data == null) return;
          const state = ContractState.parse(snapshot.data);
          const last = state.rounds.at(-1);
          const call = state.calls["old-call"];
          const matches =
            point === "before-dispatch"
              ? last?.state === "prepared" && state.native === null
              : point === "after-open"
                ? last?.state === "prepared" && state.native !== null
                : point === "after-message"
                  ? call?.status === "observed"
                  : point === "after-started"
                    ? call?.status === "started"
                    : point === "after-outcome"
                      ? call?.status === "completed"
                      : last?.state === "settled";
          if (matches) {
            before = state;
            await pause(port.signal);
          }
        },
        configure: (step) =>
          point !== "after-effect"
            ? step
            : {
                ...step,
                spec: {
                  ...step.spec,
                  tools: step.spec.tools.map((tool) => ({
                    ...tool,
                    handle: (input, call) =>
                      Effect.gen(function* () {
                        const outcome = yield* tool.handle(input, call);
                        before = yield* Effect.promise(() => w.state());
                        yield* Effect.promise((signal) => pause(signal));
                        return outcome;
                      }),
                  })),
                },
              },
      },
    );
    try {
      const id = await w.begin();
      await boundary;
      expect(before).toBeDefined();
      await w.opened.harness.close(context);
      const effects =
        point === "after-effect" || point === "after-outcome" ? 1 : 0;
      expect(w.run.probes).toHaveLength(effects);
      await w.reopen();
      const result = (await w.opened.harness.waitForTask(id, context)).state
        .outcome;
      expect(result).toMatchObject({ status: "completed" });
      if (point === "after-settlement") {
        expect(w.fake.starts).toEqual([{ kind: "new" }]);
        expect(w.fake.turns).toHaveLength(1);
      } else if (point === "after-open") {
        expect(w.fake.starts).toEqual([{ kind: "new" }, { kind: "new" }]);
        expect(w.fake.turns).toHaveLength(1);
      } else if (point !== "before-dispatch") {
        expect(w.fake.starts).toEqual([
          { kind: "new" },
          { kind: "resume", session: "native-open", at: "point-1", fork: true },
        ]);
        expect(w.run.probes).toHaveLength(effects);
        if (point === "after-message")
          expect((await w.state()).calls["old-call"]).toEqual({
            status: "cancelled",
            eligible: false,
          });
        if (point === "after-started" || point === "after-effect")
          expect((await w.state()).calls["old-call"]).toEqual({
            status: "started",
            eligible: false,
          });
      }
      expect(w.fake.opens()).toBe(w.fake.closes());
    } finally {
      await w.close();
    }
  });
}

// Why: a later assistant message proves the earlier result arrived, even mid-round.
test("a saved message without calls adds no recovery text", async () => {
  let reached = () => {};
  const boundary = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let paused = false;
  const w = await setup(
    "text-safe-point",
    [
      async (turn) => {
        const call = probe("delivered-before-text", 1);
        await turn.message([call]);
        await turn.invoke(call, turn.signal);
        await turn.message([], { id: "safe-text" });
      },
      async (turn) => {
        expect(w.fake.turns[0]?.prompt).toBe(turn.prompt);
        expect(turn.prompt).not.toContain("Call delivered-before-text");
        await accepted(turn);
      },
    ],
    {
      afterCommit: async (port) => {
        if (paused) return;
        const snapshot = await port.snapshot(
          ContractContextDoc,
          port.taskId,
          context,
        );
        if (snapshot?.data == null) return;
        if (
          !ContractState.parse(snapshot.data).events.some(
            (event) =>
              event.type === "message.finished" &&
              event.messageId === "safe-text",
          )
        )
          return;
        paused = true;
        reached();
        await untilAbort(port.signal);
      },
    },
  );
  try {
    const id = await w.begin();
    await boundary;
    await w.opened.harness.close(context);
    await w.reopen();
    expect(
      (await w.opened.harness.waitForTask(id, context)).state.outcome.status,
    ).toBe("completed");
    expect(w.run.probes).toEqual([{ n: 1 }]);
  } finally {
    await w.close();
  }
});

// Why: dispatch with no message and no call marker cannot have run any tool.
test("a dispatched turn with an empty ledger restarts the same round in a new session", async () => {
  let reached = () => {};
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const w = await setup("empty-ledger", [
    async (turn) => {
      reached();
      await untilAbort(turn.signal);
    },
    async (turn) => {
      expect(w.fake.turns[0]?.prompt).toBe(turn.prompt);
      expect((await w.state()).rounds.at(-1)).toMatchObject({
        attempt: 2,
        dispatched: true,
      });
      expect(turn.turnId).toBe(`${w.fake.turns[0]?.turnId}:attempt:2`);
      await accepted(turn);
    },
  ]);
  try {
    const id = await w.begin();
    await started;
    await w.opened.harness.close(context);
    await w.reopen();
    const result = (await w.opened.harness.waitForTask(id, context)).state
      .outcome;
    expect(result).toMatchObject({ status: "completed" });
    expect(w.fake.starts).toEqual([{ kind: "new" }, { kind: "new" }]);
    expect(w.fake.closes()).toBe(2);
  } finally {
    await w.close();
  }
});

// Why: a started marker means an effect may have run, so losing its safe point must fail closed.
test("a started call without a safe point fails typed and retains its partial document", async () => {
  let reached = () => {};
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let paused = false;
  const w = await setup(
    "no-point",
    [
      async (turn) => {
        const call = probe("unsafe-call", 1);
        await turn.message([call]);
        await turn.invoke(call, turn.signal);
      },
    ],
    {
      afterCommit: async (port) => {
        if (paused) return;
        const snapshot = await port.snapshot(
          ContractContextDoc,
          port.taskId,
          context,
        );
        if (
          snapshot?.data == null ||
          ContractState.parse(snapshot.data).calls["unsafe-call"]?.status !==
            "started"
        )
          return;
        paused = true;
        reached();
        await untilAbort(port.signal);
      },
    },
  );
  try {
    const id = await w.begin();
    await started;
    await w.opened.harness.commit(async (tx) => {
      const doc = await tx.doc(ContractContextDoc, id);
      const state = ContractState.parse(doc.data);
      // Simulate a persisted started marker whose native safe point is unavailable.
      state.native = { sessionId: "native-open", resumePoint: null };
      doc.data = copyJson(state);
    }, context);
    await w.opened.harness.close(context);
    await w.reopen();
    const result = (await w.opened.harness.waitForTask(id, context)).state
      .outcome;
    expect(result).toMatchObject({ status: "failed" });
    if (result.status === "failed")
      expect(result.error.detail).toMatchObject({
        tag: "ContractRecoveryFailed",
        retryable: false,
      });
    expect(w.fake.opens()).toBe(1);
    const partial = await w.opened.harness.snapshot(
      ContractPartialsDoc,
      context,
    );
    expect(ContractState.parse(partial?.contexts[String(id)])).toMatchObject({
      native: { sessionId: "native-open", resumePoint: null },
      rounds: [{ state: "active" }],
      calls: { "unsafe-call": { status: "started" } },
    });
    expect(w.run.probes).toHaveLength(0);
  } finally {
    await w.close();
  }
});

// Why: changing the account's continuation identity must never fork an unrelated native session.
test("continuation mismatch fails typed before any reopen", async () => {
  let reached = () => {};
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const w = await setup("identity", [
    async (turn) => {
      await turn.message();
      const message = await w.opened.harness.watchDoc(
        ContractContextDoc,
        await id,
        context,
      );
      await message?.stop();
      reached();
      await untilAbort(turn.signal);
    },
  ]);
  let resolveId = (_: Awaited<ReturnType<typeof w.begin>>) => {};
  const id = new Promise<Awaited<ReturnType<typeof w.begin>>>((resolve) => {
    resolveId = resolve;
  });
  try {
    const task = await w.begin();
    resolveId(task);
    await started;
    await w.opened.harness.close(context);
    w.fake.setIdentity("different-folder-identity");
    await w.reopen();
    const result = (await w.opened.harness.waitForTask(task, context)).state
      .outcome;
    expect(result).toMatchObject({ status: "failed" });
    if (result.status === "failed")
      expect(result.error.detail).toMatchObject({
        tag: "ContractRecoveryFailed",
      });
    expect(w.fake.opens()).toBe(1);
    const partial = await w.opened.harness.snapshot(
      ContractPartialsDoc,
      context,
    );
    expect(ContractState.parse(partial?.contexts[String(task)])).toMatchObject({
      continuation: { key: "fake-account-identity" },
      native: { sessionId: "native-open" },
    });
  } finally {
    await w.close();
  }
});

// Why: policy must cover every contract tag and reason without changing the incumbent pi retry table.
const failures: RuntimeFailure[] = [
  {
    _tag: "SignInRequired",
    account: route.account.name,
    hint: { kind: "settings", entry: "accounts" },
  },
  { _tag: "AccountRejected", account: route.account.name },
  { _tag: "UsageLimitReached", account: route.account.name },
  { _tag: "AccountNotFound", account: route.account.name },
  {
    _tag: "CapabilityUnsupported",
    account: route.account.name,
    capability: "fork",
  },
  ...RuntimeUnavailableReason.options.map((reason): RuntimeFailure => ({
    _tag: "RuntimeUnavailable",
    account: route.account.name,
    reason,
  })),
  ...TurnFailureReason.options.map((reason): RuntimeFailure => ({
    _tag: "TurnFailed",
    account: route.account.name,
    reason,
  })),
];
for (const failure of failures) {
  for (const final of [false, true]) {
    test(`native policy ${failure._tag} ${"reason" in failure ? failure.reason : ""} in ${final ? "final" : "running"}`, () => {
      const policy = runtimeFailurePolicy(failure, final);
      if (
        ["SignInRequired", "AccountRejected", "UsageLimitReached"].includes(
          failure._tag,
        )
      )
        expect(policy).toEqual({ action: "hold", retryable: false });
      else if (
        (failure._tag === "RuntimeUnavailable" &&
          failure.reason === "start-failed") ||
        (failure._tag === "TurnFailed" &&
          ["provider-failed", "provider-unavailable"].includes(failure.reason))
      )
        expect(policy).toEqual({ action: "hold", retryable: true });
      else if (
        failure._tag === "TurnFailed" &&
        ["turn-limit-reached", "context-overflow"].includes(failure.reason) &&
        !final
      )
        expect(policy).toEqual({
          action: "final",
          endedBy:
            failure.reason === "context-overflow" ? "overflow" : "turn-limit",
        });
      else if (
        failure._tag === "TurnFailed" &&
        ["structured-output-missing", "structured-output-invalid"].includes(
          failure.reason,
        ) &&
        final
      )
        expect(policy).toEqual({ action: "refuse" });
      else expect(policy).toEqual({ action: "fail", retryable: false });
    });
  }
}

for (const tag of [
  "SignInRequired",
  "AccountRejected",
  "UsageLimitReached",
] as const) {
  test(`${tag} resumes only after an explicit request and a fresh signed-in probe`, async () => {
    const failure = failures.find((failure) => failure._tag === tag)!;
    const w = await setup(`resume-${tag.toLowerCase()}`, [
      async (turn) => {
        const call = probe("hold-result", 1);
        await turn.message([call]);
        await turn.invoke(call, turn.signal);
        await turn.send({
          type: "turn.finished",
          turnId: turn.turnId,
          at: new Date().toISOString(),
          outcome: { status: "failed", disposition: "reusable", failure },
        });
      },
      async (turn) => {
        expect(turn.prompt).toContain("hold-result");
        expect(turn.prompt).toContain("already ran");
        await accepted(turn);
      },
    ]);
    try {
      const id = await w.begin();
      const held = await waitHeld(w.opened.harness);
      expect(w.fake.closes()).toBe(1);
      expect(held).toMatchObject({
        engine: "contract",
        account: route.account.name,
        mode: "running",
      });
      expect(heldFailure([held])).toEqual({ tag, retryable: false });
      expect(await admitResume(w.opened.harness, "automatic", context)).toBe(
        "blocked",
      );
      expect(w.fake.probes()).toBe(0);
      for (const state of ["stale", "not-signed-in", "limited"] as const) {
        w.fake.probeState(state);
        expect(
          await admitResume(w.opened.harness, `explicit-${state}`, context, {
            runtimes: w.fake.registry,
          }),
        ).toBe("blocked");
        expect(w.fake.opens()).toBe(1);
      }
      w.fake.probeState("signed-in");
      expect(
        await admitResume(w.opened.harness, "explicit-good", context, {
          runtimes: w.fake.registry,
        }),
      ).toBe("committed");
      const result = (await w.opened.harness.waitForTask(id, context)).state
        .outcome;
      expect(result).toMatchObject({ status: "completed" });
      expect(w.fake.starts[1]).toEqual({
        kind: "resume",
        session: "native-open",
        at: "point-1",
        fork: true,
      });
      expect(w.run.probes).toEqual([{ n: 1 }]);
    } finally {
      await w.close();
    }
  });
}

// Why: a clean boundary resumes the existing session and preserves the continuation allowance.
test("a clean close between rounds resumes without a fork", async () => {
  let reached = () => {};
  const boundary = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let paused = false;
  const w = await setup(
    "clean-close",
    [
      async (turn) => {
        const call = probe("delivered-before-clean-close", 1);
        await turn.message([call]);
        await turn.invoke(call, turn.signal);
        await turn.message();
        await turn.send({
          type: "turn.finished",
          turnId: turn.turnId,
          at: new Date().toISOString(),
          outcome: { status: "completed" },
        });
      },
      async (turn) => {
        expect(turn.policy.turnLimit).toBeGreaterThan(0);
        expect(turn.prompt).toContain("[harness: open items]");
        expect(turn.prompt).not.toContain("Call delivered-before-clean-close");
        expect((await w.state()).continuations).toBe(1);
        await accepted(turn);
      },
    ],
    {
      afterCommit: async (port) => {
        if (paused) return;
        const snapshot = await port.snapshot(
          ContractContextDoc,
          port.taskId,
          context,
        );
        if (snapshot?.data == null) return;
        if (ContractState.parse(snapshot.data).rounds.length !== 2) return;
        paused = true;
        reached();
        await untilAbort(port.signal);
      },
    },
  );
  try {
    const id = await w.begin();
    await boundary;
    await w.opened.harness.close(context);
    await w.reopen();
    expect(
      (await w.opened.harness.waitForTask(id, context)).state.outcome.status,
    ).toBe("completed");
    expect(w.fake.starts).toEqual([
      { kind: "new" },
      { kind: "resume", session: "native-open", at: "point-1", fork: false },
    ]);
  } finally {
    await w.close();
  }
});

function trackedBudget() {
  const scheduler = new Scheduler(8, 8, 8);
  const requests: Request[] = [];
  let released = 0;
  let beforeRelease = () => {};
  const budget: Budget = {
    admit: async (request, signal) => {
      requests.push(request);
      const grant = await scheduler.admit(request, signal);
      return {
        ...grant,
        release: async () => {
          beforeRelease();
          released++;
          await grant.release();
        },
      };
    },
    throttle: (...args) => scheduler.throttle(...args),
    capacity: () => scheduler.capacity(),
    observe: () => scheduler.observe(),
  };
  return {
    budget,
    requests,
    released: () => released,
    beforeRelease: (check: () => void) => {
      beforeRelease = check;
    },
  };
}

// Why: every session exit must return the provider grant after its process scope closes.
for (const exit of [
  "accepted",
  "hold",
  "protocol",
  "abort",
  "cutoff",
  "open-failed",
  "final-success",
  "final-failure",
  "backstop",
] as const) {
  test(`${exit} releases session admission after closure`, async () => {
    const grants = trackedBudget();
    let reached = () => {};
    const active = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const script: Script[] =
      exit === "accepted"
        ? [accepted]
        : exit === "hold"
          ? [
              async () => ({
                status: "failed",
                disposition: "broken",
                failure: {
                  _tag: "UsageLimitReached",
                  account: route.account.name,
                },
              }),
            ]
          : exit === "abort" || exit === "cutoff"
            ? [
                async (turn) => {
                  reached();
                  await untilAbort(turn.signal);
                },
              ]
            : exit === "final-success" || exit === "final-failure"
              ? [
                  async (turn) => {
                    await turn.message();
                  },
                  async () =>
                    exit === "final-success"
                      ? { status: "completed", structuredOutput: { answer: 2 } }
                      : {
                          status: "failed",
                          disposition: "broken",
                          failure: {
                            _tag: "TurnFailed",
                            account: route.account.name,
                            reason: "context-overflow",
                          },
                        },
                ]
              : exit === "backstop"
                ? [
                    async (turn) => {
                      const call = submit("bad", null);
                      await turn.message([call]);
                      await turn.invoke(call, turn.signal);
                    },
                  ]
                : [
                    async (turn) => {
                      await turn.message([], { usage: undefined });
                    },
                  ];
    const w = await setup(`grant-${exit}`, script, {
      limit: exit.startsWith("final") ? 1 : 6,
      retries: 0,
      sessions: contractSessionSlots(grants.budget, 1, "test-run"),
    });
    grants.beforeRelease(() => {
      expect(w.fake.closes()).toBe(w.fake.opens());
    });
    if (exit === "open-failed") w.fake.openError();
    try {
      if (exit === "abort") {
        const id = await w.begin();
        await active;
        await w.opened.harness.abortTask(id, context);
        expect(
          (await w.opened.harness.waitForTask(id, context)).state.outcome
            .status,
        ).toBe("aborted");
      } else if (exit === "hold" || exit === "open-failed") {
        await w.begin();
        await waitHeld(w.opened.harness);
      } else await w.start(exit === "cutoff" ? Date.now() + 50 : undefined);
      expect(grants.requests).toHaveLength(1);
      expect(grants.requests[0]?.resource).toEqual({
        kind: "provider",
        account: continuationAccountKey({
          runtime: "claude-code",
          key: "fake-account-identity",
        }),
      });
      expect(grants.released()).toBe(1);
    } finally {
      await w.close();
    }
  });
}

// Why: an admission promise may grant after interruption; its permit must be joined and released once.
test("late cancellation releases the provider grant and leaves the run slot available", async () => {
  let deliver = (_: Grant) => {};
  let waiting = () => {};
  const queued = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  const pending = new Promise<Grant>((resolve) => {
    deliver = resolve;
  });
  let releases = 0;
  let admissions = 0;
  const budget: Budget = {
    admit: async () => {
      admissions++;
      waiting();
      return admissions === 1
        ? pending
        : {
            permits: 1,
            release: () => {
              releases++;
            },
          };
    },
    throttle: async () => {},
    capacity: async () => ({}),
    observe: async () => ({}),
  };
  const slots = contractSessionSlots(budget, 1, "late");
  const scope = await Effect.runPromise(Scope.make());
  const controller = new AbortController();
  const claim = Effect.runPromiseExit(
    Scope.provide(
      slots.acquire({ runtime: "claude-code", key: "same" }),
      scope,
    ),
    { signal: controller.signal },
  );
  await queued;
  controller.abort();
  deliver({
    permits: 1,
    release: () => {
      releases++;
    },
  });
  expect(Exit.isFailure(await claim)).toBe(true);
  await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)));
  expect(releases).toBe(1);
  await Effect.runPromise(
    Effect.scoped(slots.acquire({ runtime: "claude-code", key: "other" })),
  );
  expect(admissions).toBe(2);
  expect(releases).toBe(2);
});

// Why: run-local admission must bound simultaneous contexts even when the provider admits more.
test("the run's contract contexts share one local session bound", async () => {
  const grants = trackedBudget();
  const slots = contractSessionSlots(grants.budget, 1, "shared-run");
  const first = await Effect.runPromise(Scope.make());
  const second = await Effect.runPromise(Scope.make());
  try {
    await Effect.runPromise(
      Scope.provide(slots.acquire({ runtime: "claude-code", key: "a" }), first),
    );
    let admitted = false;
    const next = Effect.runPromise(
      Scope.provide(
        slots.acquire({ runtime: "claude-code", key: "b" }),
        second,
      ),
    ).then(() => {
      admitted = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(admitted).toBe(false);
    expect(grants.requests).toHaveLength(1);
    await Effect.runPromise(Scope.close(first, Exit.succeed(undefined)));
    await next;
    expect(admitted).toBe(true);
    expect(grants.requests).toHaveLength(2);
  } finally {
    await Effect.runPromise(Scope.close(second, Exit.succeed(undefined)));
    await Effect.runPromise(Scope.close(first, Exit.succeed(undefined)));
  }
  expect(grants.released()).toBe(2);
});

// Why: capabilities can fail before a contract document exists, and must use the same hold policy.
for (const failure of failures) {
  test(`capability lookup classifies ${failure._tag} ${"reason" in failure ? failure.reason : ""}`, async () => {
    const w = await setup(
      `capability-${failure._tag.toLowerCase()}-${"reason" in failure ? failure.reason : "none"}`,
      [],
    );
    w.fake.capabilityError(runtimeFailureToError(failure));
    try {
      if (runtimeFailurePolicy(failure).action === "hold") {
        await w.begin();
        expect(await waitHeld(w.opened.harness)).toMatchObject({
          savedPhase: "open",
          failure,
          native: null,
          round: null,
        });
      } else {
        const outcome = await w.start();
        expect(outcome.status).toBe("failed");
        if (outcome.status === "failed")
          expect(outcome.error.detail).toMatchObject({
            tag: failure._tag,
            retryable: false,
          });
      }
      expect(w.fake.opens()).toBe(0);
    } finally {
      await w.close();
    }
  });
}

// Why: provider limits during running advance to final; broken sessions close before a safe reopen.
for (const reason of ["turn-limit-reached", "context-overflow"] as const) {
  for (const disposition of ["reusable", "broken"] as const) {
    test(`${reason} in a ${disposition} session moves to final once`, async () => {
      const w = await setup(`limit-${reason}-${disposition}`, [
        async (turn) => {
          await turn.message();
          return {
            status: "failed",
            disposition,
            failure: {
              _tag: "TurnFailed",
              account: route.account.name,
              reason,
            },
          };
        },
        async (turn) => {
          expect(turn.final).toBe(true);
          return { status: "completed", structuredOutput: { answer: 3 } };
        },
      ]);
      try {
        const result = await w.start();
        expect(result).toMatchObject({ status: "completed" });
        if (result.status === "completed")
          expect(result.result.agentResult).toMatchObject({
            endedBy: reason === "context-overflow" ? "overflow" : "turn-limit",
            finalGeneration: true,
          });
        expect(w.fake.opens()).toBe(disposition === "reusable" ? 1 : 2);
        expect(w.fake.closes()).toBe(w.fake.opens());
      } finally {
        await w.close();
      }
    });
  }
}

// Why: resuming a held final round must preserve its mode and invalid-output allowance.
test("an explicit account resume preserves final mode and the original cut-off", async () => {
  const w = await setup(
    "final-hold-resume",
    [
      async (turn) => {
        await turn.message();
      },
      async (turn) => {
        expect(turn.final).toBe(true);
        await turn.message();
        return {
          status: "failed",
          disposition: "reusable",
          failure: {
            _tag: "SignInRequired",
            account: route.account.name,
            hint: { kind: "settings", entry: "accounts" },
          },
        };
      },
      async (turn) => {
        expect(turn.final).toBe(true);
        expect((await w.state()).refusals).toBe(0);
        return { status: "completed", structuredOutput: { answer: 4 } };
      },
    ],
    { limit: 1 },
  );
  const cutoffAt = Date.now() + 30_000;
  try {
    const id = await w.begin(cutoffAt);
    expect(await waitHeld(w.opened.harness)).toMatchObject({
      mode: "final",
      savedPhase: "final",
      round: { attempt: 1 },
    });
    expect(
      await admitResume(w.opened.harness, "final-explicit", context, {
        runtimes: w.fake.registry,
      }),
    ).toBe("committed");
    const task = await w.opened.harness.waitForTask(id, context);
    expect(task.state.outcome.status).toBe("completed");
    expect(task.input).toMatchObject({ cutoffAt });
    expect(w.fake.turns.map((turn) => turn.final)).toEqual([false, true, true]);
  } finally {
    await w.close();
  }
});

// Why: waiting on account recovery never extends the run or spends another request at its cut-off.
test("an account hold keeps the original cut-off without any automatic probe or reopen", async () => {
  const w = await setup("held-cutoff", [
    async () => ({
      status: "failed",
      disposition: "broken",
      failure: { _tag: "UsageLimitReached", account: route.account.name },
    }),
  ]);
  try {
    const id = await w.begin(Date.now() + 100);
    await waitHeld(w.opened.harness);
    expect(
      (await w.opened.harness.waitForTask(id, context)).state.outcome.status,
    ).toBe("aborted");
    expect(w.fake.probes()).toBe(0);
    expect(w.fake.opens()).toBe(1);
    expect(w.fake.closes()).toBe(1);
  } finally {
    await w.close();
  }
});

// Why: a runtime with internal retries requires explicit admission and a fresh probe even for overload.
test("a provider hold resumes explicitly from its saved point", async () => {
  const w = await setup("transient-resume", [
    async (turn) => {
      await turn.message();
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
    accepted,
  ]);
  try {
    const id = await w.begin();
    const held = await waitHeld(w.opened.harness);
    expect(heldFailure([held])).toEqual({
      tag: "TurnFailed",
      retryable: false,
    });
    expect(
      await admitResume(w.opened.harness, "automatic-retry", context),
    ).toBe("blocked");
    expect(w.fake.turns).toHaveLength(1);
    expect(
      await admitResume(w.opened.harness, "retry-policy", context, {
        runtimes: w.fake.registry,
      }),
    ).toBe("committed");
    expect(
      (await w.opened.harness.waitForTask(id, context)).state.outcome.status,
    ).toBe("completed");
    expect(w.fake.starts[1]).toEqual({
      kind: "resume",
      session: "native-open",
      at: "carrier-1",
      fork: false,
    });
    expect(w.fake.probes()).toBe(1);
  } finally {
    await w.close();
  }
});

// Why: an account failure during capability lookup can resume before any session or contract document existed.
test("a capability hold can explicitly resume into contract setup", async () => {
  const w = await setup("capability-resume", [accepted]);
  w.fake.capabilityError(
    runtimeFailureToError({
      _tag: "SignInRequired",
      account: route.account.name,
      hint: { kind: "settings", entry: "accounts" },
    }),
  );
  try {
    const id = await w.begin();
    expect(await waitHeld(w.opened.harness)).toMatchObject({
      savedPhase: "open",
      round: null,
      native: null,
    });
    w.fake.capabilityError();
    expect(
      await admitResume(w.opened.harness, "setup-explicit", context, {
        runtimes: w.fake.registry,
      }),
    ).toBe("committed");
    expect(
      (await w.opened.harness.waitForTask(id, context)).state.outcome.status,
    ).toBe("completed");
    expect(w.fake.opens()).toBe(1);
    expect(w.fake.closes()).toBe(1);
    expect(w.run.sent).toHaveLength(0);
  } finally {
    await w.close();
  }
});

// Why: a saved tool-result carrier already includes delivery, so recovery adds no text.
test("a carrier adds no recovery text and never repeats an uncommitted tool", async () => {
  const w = await setup(
    "unknown-with-carrier",
    [
      async (turn) => {
        const call = probe("unknown-carried", 1);
        await turn.message([call]);
        await turn.invoke(call, turn.signal).catch(() => {});
        return {
          status: "failed",
          disposition: "reusable",
          failure: { _tag: "UsageLimitReached", account: route.account.name },
        };
      },
      async (turn) => {
        expect(w.fake.turns[0]?.prompt).toBe(turn.prompt);
        expect(turn.prompt).not.toContain("Call unknown-carried");
        await accepted(turn);
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
              tool
                .handle(input, call)
                .pipe(
                  Effect.andThen(
                    Effect.die(new Error("synthetic interrupted outcome")),
                  ),
                ),
          })),
        },
      }),
    },
  );
  try {
    const id = await w.begin();
    expect(await waitHeld(w.opened.harness)).toMatchObject({
      native: { resumePoint: "carrier-1" },
    });
    expect(
      await admitResume(w.opened.harness, "unknown-explicit", context, {
        runtimes: w.fake.registry,
      }),
    ).toBe("committed");
    expect(
      (await w.opened.harness.waitForTask(id, context)).state.outcome.status,
    ).toBe("completed");
    expect(w.run.probes).toEqual([{ n: 1 }]);
    expect((await w.state()).calls["unknown-carried"]).toEqual({
      status: "started",
      eligible: false,
    });
  } finally {
    await w.close();
  }
});
