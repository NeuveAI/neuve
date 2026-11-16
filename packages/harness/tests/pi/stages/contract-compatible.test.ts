import { expect, test } from "bun:test";
import { copyJson } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { CorruptRecord, readData } from "@neuve/records-core";
import { z } from "zod";
import { admitResume } from "../../../src/pi/control.ts";
import {
  ContractContextDoc,
  ContractPartialsDoc,
} from "../../../src/pi/stages/docs.ts";
import {
  ContractState,
  contractStore,
} from "../../../src/pi/stages/contract-state.ts";
import { retryContractRound } from "../../../src/pi/stages/contract-recovery.ts";
import { setup, route, waitHeld, submit, probe } from "./contract-fixture.ts";

const newer = (state: ContractState) => ({
  ...state,
  futureRoot: "root",
  rounds: state.rounds.map((round) => ({ ...round, futureRound: "round" })),
  calls: {
    ...state.calls,
    c1: {
      status: "completed",
      eligible: false,
      futureCall: "call",
      outcome: { text: "saved", futureOutcome: "outcome" },
    },
  },
  events: state.events.map((event) => ({ ...event, futureEvent: "event" })),
  toolState: { ...state.toolState, futureTool: "tool" },
  continuation: { ...state.continuation, futureContinuation: "continuation" },
  declarations: state.declarations.map((declaration) => ({
    ...declaration,
    futureDeclaration: "declaration",
  })),
});

const extras = z.object({
  futureRoot: z.literal("root"),
  rounds: z.array(z.object({ futureRound: z.literal("round") })),
  calls: z.object({
    c1: z.object({
      futureCall: z.literal("call"),
      outcome: z.object({ futureOutcome: z.literal("outcome") }),
    }),
  }),
  events: z.array(z.object({ futureEvent: z.literal("event") })),
  toolState: z.object({ futureTool: z.literal("tool") }),
  continuation: z.object({ futureContinuation: z.literal("continuation") }),
  declarations: z.array(
    z.object({ futureDeclaration: z.literal("declaration") }),
  ),
});
const checkExtras = (value: unknown, seededEvents: ReadonlyArray<unknown>) => {
  // New events are appended by this build, so only the seeded prefix has newer fields.
  const raw = z.object({ events: z.array(z.json()) }).parse(value);
  expect(seededEvents.length).toBeGreaterThan(0);
  expect(raw.events.length).toBeGreaterThanOrEqual(seededEvents.length);
  for (const [index, seeded] of seededEvents.entries())
    expect(raw.events[index]).toEqual(z.json().parse(seeded));
  expect(
    extras.safeParse({
      ...z.record(z.string(), z.json()).parse(value),
      events: raw.events.slice(0, seededEvents.length),
    }).success,
  ).toBe(true);
};

const failedTurn = async (
  turn: Parameters<Parameters<typeof setup>[1][number]>[0],
) => {
  await turn.message();
  return {
    status: "failed" as const,
    disposition: "broken" as const,
    failure: {
      _tag: "TurnFailed" as const,
      account: route.account.name,
      reason: "provider-failed" as const,
    },
  };
};

// Why: restart changes a round in place and tool writes replace parsed state. Both must keep newer fields.
test("contractStore reads strict additions and preserves them through restart and tool-state updates", async () => {
  const w = await setup("compatible-store", [failedTurn]);
  w.fake.onClose(async () => {});
  try {
    const id = await w.begin();
    await waitHeld(w.opened.harness);
    let seededEvents: ReadonlyArray<unknown> = [];
    await w.opened.harness.commit(async (tx) => {
      const doc = await tx.doc(ContractContextDoc, id);
      const seeded = newer(readData(ContractState, doc.data));
      seededEvents = seeded.events;
      doc.data = copyJson(seeded);
    }, context);
    const store = contractStore(
      {
        taskId: id,
        snapshot: w.opened.harness.snapshot.bind(w.opened.harness),
        commit: async (change, ctx) => {
          await w.opened.harness.commit(change, ctx);
        },
      },
      context,
    );
    expect((await store.read()).events.length).toBeGreaterThan(0);
    await store.update(retryContractRound);
    expect((await store.read()).rounds[0]?.state).toBe("prepared");
    await store.update((state) => {
      state.toolState = { reading: { used: 17 } };
    });
    const stored = (
      await w.opened.harness.snapshot(ContractContextDoc, id, context)
    )?.data;
    checkExtras(stored, seededEvents);
    expect((await store.read()).toolState?.reading?.used).toBe(17);
  } finally {
    await w.close();
  }
});

for (const ending of ["completed", "failed", "aborted"] as const) {
  // Why: provider resume, contract-step reopen and each terminal copy must preserve the source's newer fields.
  test(`provider-held resume retains newer fields in the ${ending} partial`, async () => {
    let reached = () => {};
    const executing = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release = () => {};
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const w = await setup(`compatible-${ending}`, [
      failedTurn,
      async (turn) => {
        reached();
        await proceed;
        if (ending === "aborted") {
          await new Promise<void>((resolve) => {
            if (turn.signal.aborted) resolve();
            else
              turn.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
          });
          return { status: "interrupted" };
        }
        const call =
          ending === "completed" ? submit("accepted", 2) : probe("read", 2);
        await turn.message([call]);
        await turn.invoke(call, turn.signal);
        if (ending === "failed")
          return {
            status: "failed",
            disposition: "broken",
            failure: {
              _tag: "TurnFailed",
              account: route.account.name,
              reason: "protocol-error",
            },
          };
      },
    ]);
    w.fake.onClose(async () => {});
    try {
      const id = await w.begin();
      await waitHeld(w.opened.harness);
      let seededEvents: ReadonlyArray<unknown> = [];
      await w.opened.harness.commit(async (tx) => {
        const doc = await tx.doc(ContractContextDoc, id);
        const seeded = newer(readData(ContractState, doc.data));
        seededEvents = seeded.events;
        doc.data = copyJson(seeded);
      }, context);
      await w.opened.harness.close(context);
      await w.reopen();
      expect(
        await admitResume(w.opened.harness, "new-claim", context, {
          runtimes: w.fake.registry,
        }),
      ).toBe("committed");
      await executing;
      const resumed = (
        await w.opened.harness.snapshot(ContractContextDoc, id, context)
      )?.data;
      checkExtras(resumed, seededEvents);
      expect(readData(ContractState, resumed).rounds[0]).toMatchObject({
        state: "active",
        attempt: 2,
      });
      release();
      if (ending === "aborted") await w.opened.harness.abortTask(id, context);
      expect(
        (await w.opened.harness.waitForTask(id, context)).state.outcome.status,
      ).toBe(ending);
      const partial = (
        await w.opened.harness.snapshot(ContractPartialsDoc, context)
      )?.contexts[String(id)];
      checkExtras(partial, seededEvents);
      expect(readData(ContractState, partial).rounds[0]?.attempt).toBe(2);
    } finally {
      release();
      await w.close();
    }
  }, 15000);
}

for (const additive of [false, true]) {
  for (const field of ["agent", "toolState", "rounds"] as const) {
    // Why: invalid known fields must fail both persistent reads and updates, even beside newer fields.
    test(`malformed ${field} with additive=${additive} leaves storage unchanged`, async () => {
      // Lower case: the name is in the step's operation name, which a computation key checks.
      const w = await setup(
        `corrupt-state-${field.toLowerCase()}-${additive}`,
        [failedTurn],
      );
      w.fake.onClose(async () => {});
      try {
        const id = await w.begin();
        await waitHeld(w.opened.harness);
        await w.opened.harness.commit(async (tx) => {
          const doc = await tx.doc(ContractContextDoc, id);
          const state = readData(ContractState, doc.data);
          const raw = z
            .record(z.string(), z.json())
            .parse(additive ? newer(state) : state);
          if (field === "agent") delete raw.agent;
          else if (field === "toolState")
            raw.toolState = {
              reading: { used: "invalid" },
              ...(additive ? { futureTool: "tool" } : {}),
            };
          else
            raw.rounds = z.json().parse(
              state.rounds.map((round) => ({
                ...round,
                attempt: "invalid",
                ...(additive ? { futureRound: "round" } : {}),
              })),
            );
          doc.data = copyJson(raw);
        }, context);
        const before = await w.opened.harness.snapshot(
          ContractContextDoc,
          id,
          context,
        );
        const store = contractStore(
          {
            taskId: id,
            snapshot: w.opened.harness.snapshot.bind(w.opened.harness),
            commit: async (change, ctx) => {
              await w.opened.harness.commit(change, ctx);
            },
          },
          context,
        );
        let changed = false;
        let published = false;
        const unsubscribe = store.subscribe(() => {
          published = true;
        });
        try {
          await expect(store.read()).rejects.toThrow(CorruptRecord);
          await expect(
            store.update(() => {
              changed = true;
            }),
          ).rejects.toThrow(CorruptRecord);
          expect(changed).toBe(false);
          expect(published).toBe(false);
          expect(store.refusal).toBeUndefined();
          expect(
            await w.opened.harness.snapshot(ContractContextDoc, id, context),
          ).toEqual(before);
        } finally {
          unsubscribe();
        }
      } finally {
        await w.close();
      }
    });
  }
}

// Why: ambiguous array updates must refuse atomically, using the same exception path as pi tools.
test("an unpreservable contract update leaves the stored document unchanged", async () => {
  const w = await setup("compatible-refusal", [failedTurn]);
  w.fake.onClose(async () => {});
  try {
    const id = await w.begin();
    await waitHeld(w.opened.harness);
    await w.opened.harness.commit(async (tx) => {
      const doc = await tx.doc(ContractContextDoc, id);
      doc.data = copyJson(newer(readData(ContractState, doc.data)));
    }, context);
    const before = await w.opened.harness.snapshot(
      ContractContextDoc,
      id,
      context,
    );
    const store = contractStore(
      {
        taskId: id,
        snapshot: w.opened.harness.snapshot.bind(w.opened.harness),
        commit: async (change, ctx) => {
          await w.opened.harness.commit(change, ctx);
        },
      },
      context,
    );
    await expect(
      store.update((state) => {
        state.events = [];
      }),
    ).rejects.toThrow("leave it to a newer build");
    expect(
      await w.opened.harness.snapshot(ContractContextDoc, id, context),
    ).toEqual(before);
  } finally {
    await w.close();
  }
});
