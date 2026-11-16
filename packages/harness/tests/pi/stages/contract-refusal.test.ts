// Why: a rolled-back preservation refusal must hold through pi settlement, without retiring context.
import { expect, test } from "bun:test";
import { defineDoc, type TaskId } from "@earendil-works/pi-durable";
import { Database } from "bun:sqlite";
import { copyJson } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { readData } from "@neuve/records-core";
import { admitResume, RunControlDoc } from "../../../src/pi/control.ts";
import {
  ContractContextDoc,
  ContractPartialsDoc,
} from "../../../src/pi/stages/docs.ts";
import { z } from "zod";
import { heldFailure } from "../../../src/pi/failure-policy.ts";
import { ContractState } from "../../../src/pi/stages/contract-state.ts";
import {
  setup,
  route,
  waitHeld,
  probe,
  submit,
  type Script,
} from "./contract-fixture.ts";

const failedTurn: Script = async (turn) => {
  await turn.message();
  return {
    status: "failed",
    disposition: "broken",
    failure: {
      _tag: "TurnFailed",
      account: route.account.name,
      reason: "provider-failed",
    },
  };
};

const RawControlDoc = defineDoc<{
  resumeNonce: string | null;
  held: Record<string, z.infer<ReturnType<typeof z.json>>>;
}>({
  kind: "neuve.run-control",
  version: 1,
  scope: "session",
  initial: () => ({ resumeNonce: null, held: {} }),
});

type World = Awaited<ReturnType<typeof setup>>;
async function waitRefused(w: World) {
  await w.opened.harness.commit(async (tx) => {
    await tx.doc(RunControlDoc);
  }, context);
  const watch = await w.opened.harness.watchDoc(RunControlDoc, context);
  if (watch === undefined) throw new Error("No run control");
  try {
    await new Promise<void>((resolve) => {
      const observe = (value: typeof watch.value) => {
        if (
          Object.values(value?.held ?? {}).some(
            (held) => held.engine === "contract" && held.writeRefused,
          )
        )
          resolve();
      };
      observe(watch.value);
      watch.start(async (value) => observe(value));
    });
  } finally {
    await watch.stop();
  }
}

async function retained(w: World, id: TaskId) {
  const live = await w.opened.harness.snapshot(ContractContextDoc, id, context);
  const partials = await w.opened.harness.snapshot(
    ContractPartialsDoc,
    context,
  );
  return { live, partials };
}
async function assertHeld(
  w: World,
  id: TaskId,
  before: Awaited<ReturnType<typeof retained>>,
  opaque = false,
) {
  if (!opaque) await waitRefused(w);
  expect(await retained(w, id)).toEqual(before);
  expect((await w.opened.harness.getTask(id, context))?.state.status).toBe(
    "running",
  );
  const control = await w.opened.harness.snapshot(RunControlDoc, context);
  expect(heldFailure(Object.values(control?.held ?? {})).retryable).toBe(false);
  expect(
    await admitResume(w.opened.harness, "blocked-next-claim", context, {
      runtimes: w.fake.registry,
    }),
  ).toBe("blocked");
  expect(await w.opened.harness.snapshot(RunControlDoc, context)).toEqual(
    control,
  );
  const db = new Database(w.run.database, { readonly: true });
  try {
    const row = z
      .object({ retired: z.null(), revisions: z.number().positive() })
      .parse(
        db
          .query(
            "SELECT d.retired_at AS retired, count(r.document_id) AS revisions FROM documents d LEFT JOIN document_revisions r ON r.document_id=d.id WHERE json_extract(d.record,'$.kind')='neuve.contract-context' AND json_extract(d.record,'$.scope.taskId')=? GROUP BY d.id",
          )
          .get(id),
      );
    expect(row.retired).toBeNull();
    expect(row.revisions).toBeGreaterThan(0);
  } finally {
    db.close();
  }
  const probes = w.fake.probes();
  await w.opened.harness.close(context);
  await w.reopen();
  expect(await retained(w, id)).toEqual(before);
  expect(await w.opened.harness.snapshot(RunControlDoc, context)).toEqual(
    control,
  );
  expect((await w.opened.harness.getTask(id, context))?.state.status).not.toBe(
    "terminal",
  );
  expect(w.fake.turns).toHaveLength(1);
  expect(w.fake.probes()).toBe(probes);
}

test("provider-resume refusal retains the newer outcome and existing partials", async () => {
  const w = await setup("resume-refusal", [failedTurn]);
  w.fake.onClose(async () => {});
  try {
    const id = await w.begin();
    await waitHeld(w.opened.harness);
    await w.opened.harness.commit(async (tx) => {
      const doc = await tx.doc(ContractContextDoc, id);
      const state = readData(ContractState, doc.data);
      const round = state.rounds[0];
      if (round?.outcome?.status !== "failed")
        throw new Error("No failed outcome");
      doc.data = copyJson({
        ...state,
        rounds: [
          {
            ...round,
            outcome: { ...round.outcome, futureOutcome: "keep-this" },
          },
        ],
      });
      (await tx.doc(ContractPartialsDoc)).contexts.previous = copyJson(
        doc.data,
      );
    }, context);
    const before = await retained(w, id);
    await w.opened.harness.close(context);
    await w.reopen();
    expect(
      await admitResume(w.opened.harness, "next-claim", context, {
        runtimes: w.fake.registry,
      }),
    ).toBe("committed");
    const probes = w.fake.probes();
    await assertHeld(w, id, before);
    expect(w.fake.probes()).toBe(probes);
  } finally {
    await w.close();
  }
}, 15000);

test("active event refusal holds before deleting a newer announcement", async () => {
  let before: Awaited<ReturnType<typeof retained>> | undefined;
  let seeded = false;
  let release = () => {};
  const injected = new Promise<void>((resolve) => {
    release = resolve;
  });
  const w = await setup(
    "active-refusal",
    [
      async (turn) => {
        await turn.send({
          type: "tool.started",
          turnId: turn.turnId,
          at: new Date().toISOString(),
          callId: "announced",
          toolName: "probe",
          input: { n: 1 },
        });
        await injected;
        await turn.message([probe("announced", 1)]);
      },
    ],
    {
      afterCommit: async (port) => {
        if (seeded) return;
        const saved = await port.snapshot(
          ContractContextDoc,
          port.taskId,
          context,
        );
        if (saved?.data == null) return;
        const state = readData(ContractState, saved.data);
        const round = state.rounds[0];
        const announcement = round?.announced.announced;
        if (round === undefined || announcement === undefined) return;
        seeded = true;
        await port.commit(async (tx) => {
          (await tx.doc(ContractContextDoc, port.taskId)).data = copyJson({
            ...state,
            rounds: [
              {
                ...round,
                announced: {
                  announced: {
                    ...announcement,
                    futureAnnouncement: "keep-this",
                  },
                },
              },
            ],
          });
          (await tx.doc(ContractPartialsDoc)).contexts.previous =
            copyJson(state);
        }, context);
        before = await retained(w, port.taskId);
        release();
      },
    },
  );
  w.fake.onClose(async () => {});
  try {
    const id = await w.begin();
    await waitRefused(w);
    if (before === undefined) throw new Error("Did not seed announcement");
    await assertHeld(w, id, before);
    expect(w.fake.probes()).toBe(0);
  } finally {
    release();
    await w.close();
  }
}, 15000);

// The failure snapshot can precede a newer context revision. The copy must refuse rather than erase it.
for (const ending of ["completed", "failed", "aborted", "opaque"] as const) {
  test(`${ending} terminal-copy refusal retains the live context and existing partials`, async () => {
    let before: Awaited<ReturnType<typeof retained>> | undefined;
    let seeded = false;
    let started = () => {};
    const executing = new Promise<void>((resolve) => {
      started = resolve;
    });
    let caught = () => {};
    const refusalCaught = new Promise<void>((resolve) => {
      caught = resolve;
    });
    let savedControl: string | undefined;
    const w = await setup(
      `terminal-refusal-${ending}`,
      [
        async (turn) => {
          if (ending === "completed") {
            const call = submit("accepted", 2);
            await turn.message([call]);
            await turn.invoke(call, turn.signal);
            return;
          }
          await turn.message();
          if (ending === "aborted") {
            started();
            await new Promise<void>((resolve) => {
              if (turn.signal.aborted) resolve();
              else
                turn.signal.addEventListener("abort", () => resolve(), {
                  once: true,
                });
            });
            return { status: "interrupted" };
          }
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
      ],
      {
        beforeCommit: async (port) => {
          if (seeded || w.fake.closes() === 0) return;
          seeded = true;
          await port.commit(async (tx) => {
            const doc = await tx.doc(ContractContextDoc, port.taskId);
            const state = readData(ContractState, doc.data);
            doc.data = copyJson({
              ...state,
              toolState: { reading: { used: 0, futureReading: "keep-this" } },
            });
            (await tx.doc(ContractPartialsDoc)).contexts.previous =
              copyJson(state);
            if (ending === "opaque") {
              const control = await tx.doc(RawControlDoc);
              control.held[String(port.taskId)] = z.json().parse({
                engine: "contract",
                account: state.account,
                continuation: state.continuation,
                savedPhase: "running",
                mode: "running",
                round: null,
                native: state.native,
                reason: "future",
                detail: null,
                nonceAtHold: "older-claim",
                recovery: { kind: "future-policy" },
                failure: { _tag: "FutureFailure", account: state.account },
                futureHold: { nested: "byte-for-byte" },
              });
              savedControl = JSON.stringify(control);
            }
          }, context);
          before = await retained(w, port.taskId);
        },
        afterCommit: async () => {
          // The refused copy has no publication. This is the subsequent hold commit.
          if (ending === "opaque" && seeded) caught();
        },
      },
    );
    w.fake.onClose(async () => {});
    try {
      const id = await w.begin();
      if (ending === "aborted") {
        await executing;
        await w.opened.harness.abortTask(id, context);
      }
      if (ending === "opaque") await refusalCaught;
      else await waitRefused(w);
      if (before === undefined)
        throw new Error("Did not seed terminal context");
      await assertHeld(w, id, before, ending === "opaque");
      if (ending === "opaque")
        expect(
          JSON.stringify(
            await w.opened.harness.snapshot(RawControlDoc, context),
          ),
        ).toBe(savedControl ?? "");
      expect(w.fake.probes()).toBe(0);
    } finally {
      await w.close();
    }
  }, 15000);
}

// Restart resets an active round before opening a session; refusal must hold at that boundary too.
test("restart retry refusal holds before reopening or dispatching", async () => {
  let reached = () => {};
  const savedMessage = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const w = await setup(
    "restart-refusal",
    [
      async (turn) => {
        await turn.message();
        await new Promise<void>((resolve) => {
          if (turn.signal.aborted) resolve();
          else
            turn.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
        });
        return { status: "interrupted" };
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
          readData(ContractState, snapshot.data).events.some(
            (event) => event.type === "message.finished",
          )
        )
          reached();
      },
    },
  );
  w.fake.onClose(async () => {});
  try {
    const id = await w.begin();
    await savedMessage;
    await w.opened.harness.close(context);
    // A crash can leave an active round with a newer outcome that retry cannot reset to null.
    const opened = await w.run.open();
    try {
      await opened.harness.commit(async (tx) => {
        const doc = await tx.doc(ContractContextDoc, id);
        const state = readData(ContractState, doc.data);
        const round = state.rounds[0];
        if (round === undefined) throw new Error("No round");
        doc.data = copyJson({
          ...state,
          rounds: [
            {
              ...round,
              state: "active",
              outcome: {
                status: "failed",
                disposition: "broken",
                failure: {
                  _tag: "TurnFailed",
                  account: route.account.name,
                  reason: "provider-failed",
                },
                futureOutcome: "keep-this",
              },
            },
          ],
        });
        (await tx.doc(ContractPartialsDoc)).contexts.previous = copyJson(state);
      }, context);
    } finally {
      await opened.harness.close(context);
    }
    await w.reopen();
    const before = await retained(w, id);
    await assertHeld(w, id, before);
    expect(w.fake.opens()).toBe(1);
    expect(w.fake.probes()).toBe(0);
  } finally {
    await w.close();
  }
}, 15000);

// Failure recording and tool promises can replace the original error. The durable refusal must win.
for (const source of ["failure-bookkeeping", "wrapped-tool"] as const) {
  test(`${source} refusal holds after joining the session`, async () => {
    let before: Awaited<ReturnType<typeof retained>> | undefined;
    let seeded = false;
    let release = () => {};
    const injected = new Promise<void>((resolve) => {
      release = resolve;
    });
    const w = await setup(
      `refusal-${source}`,
      [
        async (turn) => {
          if (source === "wrapped-tool") {
            const call = probe("wrapped", 1);
            await turn.message([call]);
            try {
              await turn.invoke(call);
            } catch {
              throw new Error("The runtime wrapped its tool rejection");
            }
          } else {
            await turn.send({
              type: "tool.started",
              turnId: turn.turnId,
              at: new Date().toISOString(),
              callId: "announced",
              toolName: "probe",
              input: { n: 1 },
            });
            await injected;
            await turn.send({
              type: "turn.started",
              turnId: "wrong-turn",
              at: new Date().toISOString(),
            });
          }
        },
      ],
      {
        afterCommit: async (port) => {
          if (seeded) return;
          const snapshot = await port.snapshot(
            ContractContextDoc,
            port.taskId,
            context,
          );
          if (snapshot?.data == null) return;
          const state = readData(ContractState, snapshot.data);
          const round = state.rounds[0];
          if (
            round === undefined ||
            (source === "wrapped-tool"
              ? state.calls.wrapped?.status !== "started"
              : round.announced.announced === undefined)
          )
            return;
          seeded = true;
          await port.commit(async (tx) => {
            (await tx.doc(ContractContextDoc, port.taskId)).data = copyJson(
              source === "wrapped-tool"
                ? {
                    ...state,
                    toolState: {
                      ...state.toolState,
                      reading: { used: 0, futureReading: "keep-this" },
                    },
                  }
                : {
                    ...state,
                    rounds: [
                      {
                        ...round,
                        outcome: {
                          status: "failed",
                          disposition: "broken",
                          failure: {
                            _tag: "SignInRequired",
                            account: route.account.name,
                            hint: {
                              kind: "settings",
                              entry: "accounts",
                              futureHint: "keep-this",
                            },
                          },
                        },
                      },
                    ],
                  },
            );
            (await tx.doc(ContractPartialsDoc)).contexts.previous =
              copyJson(state);
          }, context);
          before = await retained(w, port.taskId);
          release();
        },
      },
    );
    w.fake.onClose(async () => {});
    try {
      const id = await w.begin();
      await waitRefused(w);
      if (before === undefined)
        throw new Error("Did not seed a refused update");
      await assertHeld(w, id, before);
      expect(w.fake.probes()).toBe(0);
    } finally {
      release();
      await w.close();
    }
  }, 15000);
}
