// The caller boundary matters: a direct startChild test cannot prove that contractTools
// forwards a returned ChildRequest in the transaction that records its tool answer and state.
import { expect, test } from "bun:test";
import { copyJson } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
  Harness,
  createRegistry,
  defineExtension,
  defineTask,
} from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { Effect } from "effect";
import { z } from "zod";
import {
  ClaimSettlementDoc,
  initializeClaimSettlement,
} from "../src/pi/claim-settlement.ts";
import { ChildrenDoc, ContractContextDoc } from "../src/pi/stages/docs.ts";
import {
  ContractState,
  contractStore,
  type ContractStore,
} from "../src/pi/stages/contract-state.ts";
import { contractTools } from "../src/pi/stages/contract-tools.ts";
import { declarationOf, type ResolvedAgent } from "../src/pi/stages/tools.ts";
import type { StageServices } from "../src/pi/stages/services.ts";
import { RECORDS, type ToolSpec } from "../src/toolkit.ts";
import { zeroUsage } from "../src/route.ts";

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const fixture = async (rollbackCompleted: boolean) => {
  const task = defineTask<{}, { phase: "run" }, {}>({
    name: "test.contract-claim",
    version: 1,
    initial: () => ({ phase: "run" }),
    phases: {
      run: async (_task, runtime, context) => {
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result: {} },
          }),
          context,
        );
      },
    },
    abort: async (_task, runtime, context) =>
      runtime.commit(
        () => ({
          status: "terminal",
          outcome: { status: "aborted", reason: "stopped" },
        }),
        context,
      ),
  });
  const registry = createRegistry();
  registry.install(
    defineExtension({ name: "test.contract-claims", tasks: [task] }),
  );
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: createModels(), registry },
    context,
  );
  const root = await harness.root(context);
  const review = await harness.commit(
    (tx) =>
      tx.createTask(
        task,
        {},
        { ownership: { kind: "conversation" }, conversationId: root.id },
      ),
    context,
  );
  const producer = await harness.commit(
    (tx) =>
      tx.createTask(task, {}, { ownership: { kind: "task", taskId: review } }),
    context,
  );
  const step = await harness.commit(
    (tx) =>
      tx.createTask(
        task,
        {},
        { ownership: { kind: "task", taskId: producer } },
      ),
    context,
  );
  const claim = {
    assignment: "assignment-a",
    claim: {
      key: "a".repeat(64),
      anchor: {
        path: "caller.ts",
        side: "new" as const,
        startLine: 5,
        endLine: 5,
      },
      report: {
        text: "The call can skip authorization.",
        fails: "authorization boundary",
      },
      basis: { source: "manifest", evidence: ["caller.ts:new:5-5"] },
    },
  };
  let calls = 0;
  let used = 0;
  const tool: ToolSpec = {
    name: "record_claim",
    description: "Retain an exact supported claim.",
    input: z.strictObject({}),
    hints: RECORDS,
    handle: () =>
      Effect.sync(() => {
        calls++;
        used++;
        return {
          text: "Claim recorded for verification.",
          child: {
            owner: producer,
            name: `claim.${claim.claim.key}`,
            task: task.definition.name,
            input: { claim: claim.claim.key },
            attributes: {},
            kind: "verify-claim",
            inputs: {},
            claimRegistration: claim,
          },
        };
      }),
  };
  const declaration = declarationOf(tool, false);
  const initial = ContractState.parse({
    contextKey: "context",
    agent: "lane-review.assignment-a",
    stage: "verify",
    kind: "lane-review",
    account: "test-account",
    continuation: { runtime: "claude-code", key: "test-continuation" },
    startedAt: Date.now(),
    system: "Review the assigned source.",
    outputSchema: {},
    declarations: [declaration],
    model: { id: "test-model", effort: "medium" },
    native: null,
    rounds: [
      {
        id: "turn-1",
        prompt: "Investigate.",
        final: false,
        state: "active",
        outcome: null,
      },
    ],
    events: [
      {
        type: "message.finished",
        turnId: "turn-1",
        at: new Date().toISOString(),
        messageId: "message-1",
        stopReason: "tool-use",
        usage: zeroUsage,
        toolCalls: [
          { callId: "claim-call", toolName: "record_claim", input: {} },
        ],
      },
    ],
    calls: { "claim-call": { status: "observed", eligible: false } },
    toolState: { reading: { used: 0 } },
    reminder: false,
    endedMessages: [],
  });
  await harness.commit(async (tx) => {
    await initializeClaimSettlement(tx, review, {
      source: { manifest: "manifest", cycle: "cycle", run: "run" },
      unread: [],
      assignments: [
        {
          assignmentId: "assignment-a",
          batchId: "batch-a",
          task: producer,
          sections: [
            {
              key: "section-a",
              path: "caller.ts",
              renamedFrom: null,
              owned: [{ side: "new", startLine: 5, endLine: 5 }],
            },
          ],
        },
      ],
    });
    (await tx.doc(ContractContextDoc, step)).data = copyJson(initial);
  }, context);
  const native = contractStore(
    {
      taskId: step,
      snapshot: harness.snapshot.bind(harness),
      commit: async (change, context) => {
        await harness.commit(change, context);
      },
    },
    context,
  );
  const store: ContractStore = {
    get refusal() {
      return native.refusal;
    },
    read: native.read,
    subscribe: native.subscribe,
    update: (change) =>
      native.update(async (state, tx) => {
        await change(state, tx);
        if (
          rollbackCompleted &&
          state.calls["claim-call"]?.status === "completed"
        )
          throw new Error("crash before completed call commits");
      }),
  };
  const agent: ResolvedAgent = {
    step: {
      spec: {
        stage: "verify",
        agent: initial.agent,
        turnLimit: 6,
        system: initial.system,
        task: "Review.",
        tools: [tool],
        submit: { description: "Submit review.", schema: z.strictObject({}) },
        backstop: () => ({}),
        state: {
          load: (state) => {
            used = state?.reading?.used ?? 0;
          },
          save: () => ({ reading: { used } }),
        },
      },
      op: "test.claim",
      opVersion: 1,
      inputs: {},
      compose: () => ({}),
      schema: z.strictObject({}),
    },
    vent: {
      name: "vent",
      description: "Record an execution limitation.",
      hints: RECORDS,
      handle: () => Effect.succeed({ text: "retained" }),
    },
  };
  // Only these three services are reached by contractTools. There is no provider, runtime loop,
  // computation fake or startChild mock: documents, registry, tasks and commits are native.
  const services = {
    registry,
    ctx: { log: { write: () => {} } },
    run: <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect),
  } as unknown as StageServices;
  const open = () =>
    contractTools({
      agent,
      frozen: [declaration],
      store,
      services,
      ceiling: 100_000,
    });
  const invoke = async (tools: ReturnType<typeof open>) => {
    // A real contractStore publication wakes the handler's message/ordering gate.
    await store.update(() => {});
    return Effect.runPromise(
      tools.definitions[0]!.handle(
        {},
        { callId: "claim-call", signal: new AbortController().signal },
      ),
    );
  };
  const snapshot = async () => ({
    state: await native.read(),
    ...(await harness.commit(
      async (tx) => ({
        claims: copy(
          (await tx.doc(ClaimSettlementDoc)).reviews[String(review)]!.claims,
        ),
        children: copy((await tx.doc(ChildrenDoc, producer)).children),
      }),
      context,
    )),
  });
  return {
    harness,
    open,
    invoke,
    snapshot,
    calls: () => calls,
    key: claim.claim.key,
  };
};

test("contractTools commits a returned Verify child and claim, then replays the retained answer", async () => {
  const world = await fixture(false);
  const first = world.open();
  let reopened: ReturnType<typeof world.open> | undefined;
  try {
    const answer = await world.invoke(first);
    expect(answer.text).toContain("Claim recorded for verification.");
    const committed = await world.snapshot();
    const child = committed.children[`claim.${world.key}`];
    expect(child).toBeNumber();
    expect(Object.values(committed.claims)).toHaveLength(1);
    expect(Object.values(committed.claims)[0]!.verificationTask).toBe(child!);
    expect(committed.state.calls["claim-call"]?.status).toBe("completed");
    expect(committed.state.toolState?.reading?.used).toBe(1);
    first.close(new Error("reopen tool adapter"));
    reopened = world.open();
    expect(await world.invoke(reopened)).toEqual({ text: answer.text });
    expect(world.calls()).toBe(1);
    expect(await world.snapshot()).toEqual(committed);
  } finally {
    first.close(new Error("test ended"));
    reopened?.close(new Error("test ended"));
    await world.harness.close(context);
  }
});

test("contractTools rolls back child, claim, answer and tool state together before commit", async () => {
  const world = await fixture(true);
  const first = world.open();
  let reopened: ReturnType<typeof world.open> | undefined;
  try {
    await expect(world.invoke(first)).rejects.toThrow(
      "crash before completed call commits",
    );
    const retained = await world.snapshot();
    expect(retained.children).toEqual({});
    expect(retained.claims).toEqual({});
    expect(retained.state.toolState?.reading?.used).toBe(0);
    // The earlier started marker remains an explicit uncertain call, never a recorded success.
    expect(retained.state.calls["claim-call"]).toEqual({
      status: "started",
      eligible: true,
    });
    first.close(new Error("reopen tool adapter"));
    reopened = world.open();
    await expect(world.invoke(reopened)).rejects.toThrow("protocol-error");
    expect(world.calls()).toBe(1);
    expect(await world.snapshot()).toEqual(retained);
  } finally {
    first.close(new Error("test ended"));
    reopened?.close(new Error("test ended"));
    await world.harness.close(context);
  }
});
