// Ownership/publication races can omit a known claim from a frozen decision basis. These
// contract tests precede scheduler adoption; a transaction selects one immutable basis.
import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
  Harness,
  createRegistry,
  defineExtension,
  defineTask,
  type TaskId,
} from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import {
  ClaimSettlementDoc,
  batchClaims,
  claimDestination,
  closeInSettlement,
  initializeClaimSettlement,
  registerClaim,
  registerInSettlement,
  type ClaimRegistration,
  type ClaimSettlement,
} from "../src/pi/claim-settlement.ts";

const copyJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const section = (key: string, path: string, old = false) => ({
  key,
  path,
  renamedFrom: old ? "before.ts" : null,
  owned: [
    {
      side: old ? ("old" as const) : ("new" as const),
      startLine: 5,
      endLine: 8,
    },
  ],
});
const initial = (): ClaimSettlement => ({
  source: {
    cycle: "original-cycle",
    run: "original-run",
    manifest: "m",
    frame: "f",
    map: "b",
  },
  assignments: [
    {
      assignmentId: "a",
      batchId: "batch-a",
      task: 10,
      sections: [section("a-section", "a.ts")],
    },
    {
      assignmentId: "b",
      batchId: "batch-b",
      task: 20,
      sections: [section("b-section", "b.ts")],
    },
    {
      assignmentId: "removed",
      batchId: "batch-b",
      task: 30,
      sections: [section("old-section", "after.ts", true)],
    },
  ],
  unread: [section("excluded", "generated.ts")],
  claims: {},
  closed: {},
});
const claim = (text = "bad hook order", path = "b.ts"): ClaimRegistration => ({
  assignment: "a",
  claim: {
    key: (text === "bad hook order" ? "a" : "b").repeat(64),
    anchor: { path, side: "new", startLine: 6, endLine: 6 },
    report: { text, cites: ["b.ts:new:5-8"] },
    basis: {
      reference: "source:b.ts:new:5-8",
      text: "useHook(); if (stop) return;",
    },
  },
});

test("a cross-boundary report has one destination, never a second review or vote", () => {
  const state = initial();
  const recorded = registerInSettlement(state, 10, claim(), 42);
  expect(recorded.producer).toEqual({ assignment: "a", task: 10 });
  expect(recorded.destination).toEqual({
    status: "owned",
    assignmentId: "b",
    sectionKey: "b-section",
    batchId: "batch-b",
  });
  expect(batchClaims(state, "batch-a")).toEqual([]);
  expect(batchClaims(state, "batch-b")).toEqual([recorded]);
  expect(
    closeInSettlement(state, "batch-a", [], new Set(), { batch: "a" }).status,
  ).toBe("closed");
  expect(
    closeInSettlement(state, "batch-b", [recorded.id], new Set(), {}),
  ).toEqual({ status: "waiting", tasks: [42] });
});

test("registration invalidates a stale publication snapshot even when Verify finished", () => {
  const state = initial();
  const recorded = registerInSettlement(state, 10, claim(), 42);
  expect(
    closeInSettlement(state, "batch-b", [], new Set([42]), {}).status,
  ).toBe("changed");
  expect(state.closed["batch-b"]).toBeUndefined();
  expect(
    closeInSettlement(state, "batch-b", [recorded.id], new Set([42]), {
      original: true,
    }).status,
  ).toBe("closed");
  expect(
    closeInSettlement(state, "batch-b", [], new Set(), { replaced: true }),
  ).toEqual({
    status: "closed",
    basis: { claims: [recorded.id], input: { original: true } },
  });
});

test("late observations retain original producer and source without changing closed basis", () => {
  const state = initial();
  closeInSettlement(state, "batch-b", [], new Set(), { frozen: "package" });
  const late = registerInSettlement(state, 10, claim(), 42);
  expect(late.timing).toBe("later-review-information");
  expect(late.source).toEqual(state.source);
  expect(late.verificationTask).toBe(42);
  expect(batchClaims(state, "batch-b")).toEqual([]);
  expect(state.closed["batch-b"]).toEqual({
    claims: [],
    input: { frozen: "package" },
  });
});

test("same-line distinct failures stay distinct; exact replay stays one attributed record", () => {
  const state = initial();
  const first = registerInSettlement(state, 10, claim(), 42);
  expect(registerInSettlement(state, 10, claim(), 42)).toBe(first);
  registerInSettlement(state, 10, claim("different failure"), 43);
  expect(Object.keys(state.claims)).toHaveLength(2);
  expect(() => registerInSettlement(state, 10, claim(), 99)).toThrow(
    "cannot change",
  );
  expect(() => registerInSettlement(state, 20, claim(), 42)).toThrow(
    "does not own",
  );
});

test("unknown, unread, ambiguous and renamed old-side anchors remain explicit", () => {
  const state = initial();
  expect(
    registerInSettlement(state, 10, claim("bad hook order", "unknown.ts"), null)
      .timing,
  ).toBe("unknown-ownership");
  expect(
    claimDestination(
      state,
      claim("bad hook order", "generated.ts").claim.anchor,
    ),
  ).toEqual({
    status: "unassigned",
    reason: "unread",
    sectionKeys: ["excluded"],
  });
  expect(
    claimDestination(state, {
      path: "before.ts",
      side: "old",
      startLine: 7,
      endLine: 7,
    }),
  ).toEqual({
    status: "owned",
    assignmentId: "removed",
    sectionKey: "old-section",
    batchId: "batch-b",
  });
  const overlap = structuredClone(state);
  (overlap.assignments as Array<ClaimSettlement["assignments"][number]>).push({
    assignmentId: "other",
    task: 40,
    batchId: "batch-c",
    sections: [section("other-section", "b.ts")],
  });
  expect(claimDestination(overlap, claim().claim.anchor)).toEqual({
    status: "unassigned",
    reason: "ambiguous",
    sectionKeys: ["b-section", "other-section"],
  });
});

test("native commits serialize concurrent claim recording and publication closure", async () => {
  const registry = createRegistry();
  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models: createModels(),
      registry,
      settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
    },
    context,
  );
  const review = 1 as TaskId;
  try {
    const state = initial();
    await harness.commit(
      (tx) => initializeClaimSettlement(tx, review, state),
      context,
    );
    const results = await Promise.all([
      harness.commit(
        (tx) => registerClaim(tx, review, 10, claim(), 42),
        context,
      ),
      harness.commit(async (tx) => {
        const doc = await tx.doc(ClaimSettlementDoc);
        return copyJson(
          closeInSettlement(doc.reviews["1"]!, "batch-b", [], new Set(), {
            selected: true,
          }),
        );
      }, context),
    ]);
    const retained = await harness.commit(
      async (tx) => copyJson((await tx.doc(ClaimSettlementDoc)).reviews["1"]!),
      context,
    );
    const recorded = retained.claims[results[0].id]!;
    // Either the claim was known before close, so close refuses a stale basis, or close won
    // and the complete claim is retained as later information. No third (lost claim) outcome.
    if (results[1].status === "closed") {
      expect(recorded.timing).toBe("later-review-information");
      expect(retained.closed["batch-b"]!.claims).toEqual([]);
    } else {
      expect(results[1].status).toBe("changed");
      expect(recorded.timing).toBe("incoming");
      expect(retained.closed["batch-b"]).toBeUndefined();
    }
    await harness.commit(
      (tx) => registerClaim(tx, review, 10, claim(), 42),
      context,
    );
    expect(
      Object.keys(
        (
          await harness.commit(
            async (tx) =>
              copyJson((await tx.doc(ClaimSettlementDoc)).reviews["1"]!),
            context,
          )
        ).claims,
      ),
    ).toHaveLength(1);
  } finally {
    await harness.close(context);
  }
});

test("follow-on initialization starts already-frozen destinations closed", async () => {
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: createModels(), registry: createRegistry() },
    context,
  );
  try {
    await harness.commit(
      (tx) =>
        initializeClaimSettlement(tx, 2 as TaskId, {
          ...initial(),
          frozenBatches: ["batch-b"],
        }),
      context,
    );
    const recorded = await harness.commit(
      (tx) => registerClaim(tx, 2 as TaskId, 10, claim(), null),
      context,
    );
    expect(recorded.timing).toBe("later-review-information");
    expect(recorded.verificationTask).toBeNull();
    expect(recorded.report).toEqual(claim().claim.report);
  } finally {
    await harness.close(context);
  }
});

test("Verify child and registration commit together, and replay starts neither twice", async () => {
  const { startChild } = await import("../src/pi/stages/tools.ts");
  const { ChildrenDoc } = await import("../src/pi/stages/docs.ts");
  const task = defineTask<{}, { phase: "run" }, {}>({
    name: "test.claim-child",
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
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: "test.claims", tasks: [task] }));
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: createModels(), registry },
    context,
  );
  try {
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
    const producer = await harness.commit(async (tx) => {
      const id = await tx.createTask(
        task,
        {},
        { ownership: { kind: "task", taskId: review } },
      );
      const state = initial();
      state.assignments[0] = { ...state.assignments[0]!, task: id };
      await initializeClaimSettlement(tx, review, state);
      return id;
    }, context);
    const request = {
      owner: producer,
      name: "claim.a",
      task: task.definition.name,
      input: {},
      attributes: {},
      kind: "verify-claim",
      inputs: {},
      claimRegistration: claim(),
    };
    // A failed transaction after registration simulates a crash before the durable commit.
    await expect(
      harness.commit(async (tx) => {
        await startChild(tx, registry.snapshot(), request);
        throw new Error("before commit");
      }, context),
    ).rejects.toThrow("before commit");
    expect(
      await harness.commit(
        async (tx) =>
          Object.keys(
            (await tx.doc(ClaimSettlementDoc)).reviews[String(review)]!.claims,
          ).length,
        context,
      ),
    ).toBe(0);
    const id = await harness.commit(
      (tx) => startChild(tx, registry.snapshot(), request),
      context,
    );
    expect(id).toBeNumber();
    expect(
      await harness.commit(
        (tx) => startChild(tx, registry.snapshot(), request),
        context,
      ),
    ).toBeUndefined();
    const retained = await harness.commit(
      async (tx) => ({
        claims: copyJson(
          (await tx.doc(ClaimSettlementDoc)).reviews[String(review)]!.claims,
        ),
        children: copyJson((await tx.doc(ChildrenDoc, producer)).children),
      }),
      context,
    );
    expect(Object.values(retained.claims)).toHaveLength(1);
    expect(Object.values(retained.claims)[0]!.verificationTask).toBe(id!);
    expect(retained.children).toEqual({ "claim.a": id! });
    // A tool cannot claim another prepared assignment; the new Verify is rolled back too.
    await expect(
      harness.commit(
        (tx) =>
          startChild(tx, registry.snapshot(), {
            ...request,
            name: "claim.forged",
            claimRegistration: { ...claim(), assignment: "b" },
          }),
        context,
      ),
    ).rejects.toThrow("does not own");
    expect(
      await harness.commit(
        async (tx) => copyJson((await tx.doc(ChildrenDoc, producer)).children),
        context,
      ),
    ).toEqual({ "claim.a": id! });
  } finally {
    await harness.close(context);
  }
});
