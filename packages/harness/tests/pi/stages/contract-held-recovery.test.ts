import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
// Why: pre-change provider holds must be reclassified before a reopened run can spend usage.
import { expect, spyOn, test } from "bun:test";
import { defineDoc } from "@earendil-works/pi-durable";
import { z } from "zod";
import { Database } from "bun:sqlite";
import { CorruptRecord } from "@neuve/records-core";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  AccountNeedsNewerBuild,
  AccountStoreRefused,
  runtimeErrorToFailure,
  AccountNotFound,
  type RuntimeFailure,
} from "@neuve/runtime";
import { admitResume, RunControlDoc } from "../../../src/pi/control.ts";
import {
  heldFailure,
  contractHoldNeedsNewerBuild,
  contractHoldCorruption,
  runtimeFailurePolicy,
} from "../../../src/pi/failure-policy.ts";
import {
  route,
  setup,
  submit,
  waitHeld,
  type Script,
} from "./contract-fixture.ts";

const failures = [
  {
    _tag: "TurnFailed",
    account: route.account.name,
    reason: "provider-failed",
  },
  {
    _tag: "TurnFailed",
    account: route.account.name,
    reason: "provider-unavailable",
  },
  {
    _tag: "RuntimeUnavailable",
    account: route.account.name,
    reason: "start-failed",
  },
] satisfies RuntimeFailure[];

const accountRefusals = [
  new AccountNeedsNewerBuild({ account: route.account.name }),
  new AccountStoreRefused({
    account: route.account.name,
    folder: "/temporary/Neuve",
    problem: { kind: "writable-by-others" },
  }),
];

for (const failure of failures) {
  for (const capability of [
    "internal-retries",
    "lookup-failed",
    "no-internal-retries",
  ] as const) {
    test(`saved ${failure.reason} hold reopens with ${capability}`, async () => {
      const w = await setup(`saved-${failure.reason}-${capability}`, [
        async (turn) => {
          await turn.message();
          return { status: "failed", disposition: "broken", failure };
        },
        async (turn) => {
          const call = submit(`accepted-${turn.turnId}`, 2);
          await turn.message([call]);
          await turn.invoke(call, turn.signal);
        },
      ]);
      try {
        const id = await w.begin();
        await waitHeld(w.opened.harness);
        await w.opened.harness.commit(async (tx) => {
          const doc = await tx.doc(RunControlDoc);
          const held = doc.held[String(id)];
          if (held?.engine !== "contract")
            throw new Error("Expected contract hold");
          doc.held[String(id)] = {
            ...held,
            recovery: { kind: "provider-policy" },
          };
        }, context);
        await w.opened.harness.close(context);
        // Seed the old checkpoint too, while SQLite has no open harness or scheduled tasks.
        const db = new Database(w.run.database);
        try {
          db.query(
            `UPDATE tasks SET record = json_set(
            json_remove(record, '$.state.checkpoint.from.internalRetries'),
            '$.state.checkpoint.held.recovery.kind', 'provider-policy') WHERE id = ?`,
          ).run(id);
        } finally {
          db.close();
        }
        if (capability === "lookup-failed")
          w.fake.capabilityError(
            new AccountNotFound({ account: route.account.name }),
          );
        w.fake.internalRetries(capability !== "no-internal-retries");
        await w.reopen();
        const held = await waitHeld(w.opened.harness);
        const automatic = capability === "no-internal-retries";
        expect(held.recovery.kind).toBe(
          automatic ? "provider-policy" : "explicit-account",
        );
        expect(heldFailure([held]).retryable).toBe(automatic);
        expect(
          await admitResume(w.opened.harness, "automatic-next-claim", context),
        ).toBe(automatic ? "committed" : "blocked");
        if (automatic) await w.opened.harness.waitForTask(id, context);
        expect(w.fake.turns).toHaveLength(automatic ? 2 : 1);
        expect(w.fake.probes()).toBe(0);
        if (!automatic) {
          // Restore with the opposite capability to prove the explicit hold was persisted.
          await w.opened.harness.close(context);
          w.fake.capabilityError();
          w.fake.internalRetries(false);
          await w.reopen();
          expect((await waitHeld(w.opened.harness)).recovery.kind).toBe(
            "explicit-account",
          );
          expect(
            await admitResume(w.opened.harness, "another-claim", context),
          ).toBe("blocked");
          expect(w.fake.turns).toHaveLength(1);
          expect(w.fake.probes()).toBe(0);
        }
      } finally {
        await w.close();
      }
    }, 15000);
  }
}

const FutureControlDoc = defineDoc<{
  resumeNonce: string | null;
  held: Record<string, z.infer<ReturnType<typeof z.json>>>;
}>({
  kind: "neuve.run-control",
  version: 1,
  scope: "session",
  initial: () => ({ resumeNonce: null, held: {} }),
});

for (const change of [
  { failure: { _tag: "TurnFailed", account: 17, reason: "future" } },
  { failure: { _tag: "RuntimeUnavailable", reason: "future" } },
  { failure: { _tag: "AccountRejected", account: 17, reason: "future" } },
  { failure: { _tag: "AccountNotFound" }, writeRefused: true },
  {
    failure: { _tag: "AccountNotFound" },
    recovery: { kind: "future-recovery" },
  },
  ...[
    { _tag: "AccountNotFound" },
    { _tag: "AccountNotFound", account: 17, futureFailure: true },
    { _tag: "TurnFailed", account: route.account.name, reason: 17 },
    { _tag: "RuntimeUnavailable", account: route.account.name },
  ].map((failure) => ({ failure })),
]) {
  // Why: corruption must reject admission and restore before any capability lookup, probe or send.
  test(`corrupt held failure refuses recovery: ${JSON.stringify(change)}`, async () => {
    // Named by a hash of the change: the name is in the step's operation name, which a computation
    // key checks.
    const w = await setup(
      `corrupt-hold-${Bun.hash(JSON.stringify(change)).toString(36)}`,
      [
        async (turn) => {
          await turn.message();
          return {
            status: "failed",
            disposition: "broken",
            failure: failures[0]!,
          };
        },
      ],
    );
    const capabilities = spyOn(w.fake.registry, "capabilities");
    try {
      const id = await w.begin();
      const held = await waitHeld(w.opened.harness);
      const corrupt = z
        .json()
        .parse({ ...held, recovery: { kind: "explicit-account" }, ...change });
      await w.opened.harness.commit(async (tx) => {
        (await tx.doc(FutureControlDoc)).held[String(id)] = corrupt;
      }, context);
      const saved = await w.opened.harness.snapshot(RunControlDoc, context);
      const restored = saved?.held[String(id)];
      if (restored === undefined) throw new Error("No saved hold");
      expect(contractHoldNeedsNewerBuild(restored)).toBe(false);
      expect(contractHoldCorruption(restored)).toMatchObject({
        _tag: "CorruptRecord",
        retryable: false,
      });
      expect(heldFailure([restored])).toEqual({
        tag: "CorruptRecord",
        retryable: false,
      });
      await expect(
        admitResume(w.opened.harness, "automatic", context),
      ).rejects.toThrow(CorruptRecord);
      await expect(
        admitResume(w.opened.harness, "explicit", context, {
          runtimes: w.fake.registry,
        }),
      ).rejects.toThrow(CorruptRecord);
      expect(await w.opened.harness.snapshot(RunControlDoc, context)).toEqual(
        saved,
      );
      const storedControl = () => {
        const db = new Database(w.run.database, { readonly: true });
        try {
          return db
            .query<{ record: string }, []>(
              "SELECT record FROM documents WHERE json_extract(record, '$.kind') = 'neuve.run-control' AND retired_at IS NULL",
            )
            .all();
        } finally {
          db.close();
        }
      };
      const persisted = storedControl();
      expect(persisted).toHaveLength(1);
      const lookups = capabilities.mock.calls.length;
      await expect(
        w.opened.kinds.restore(w.opened.harness, context),
      ).rejects.toMatchObject({
        _tag: "CorruptRecord",
        retryable: false,
      });
      expect(storedControl()).toEqual(persisted);
      expect(capabilities.mock.calls.length).toBe(lookups);
      expect(w.fake.probes()).toBe(0);
      expect(w.fake.turns).toHaveLength(1);
    } finally {
      capabilities.mockRestore();
      await w.close();
    }
  }, 15000);
}

for (const change of [
  { writeRefused: true },
  { recovery: { kind: "explicit-person" } },
  {
    failure: { _tag: "FutureFailure", account: route.account.name },
    recovery: { kind: "provider-policy" },
  },
  {
    failure: { _tag: "FutureFailure", account: route.account.name },
    recovery: { kind: "explicit-account" },
  },
  {
    failure: {
      _tag: "TurnFailed",
      account: route.account.name,
      reason: "future-reason",
    },
  },
  {
    failure: {
      _tag: "RuntimeUnavailable",
      account: route.account.name,
      reason: "future-reason",
    },
  },
]) {
  // Why: a saved future hold must survive restore and explicit/automatic admission without spending usage.
  test(`future hold stays unchanged: ${JSON.stringify(change)}`, async () => {
    // Named by a hash of the change: the name is in the step's operation name, which a computation
    // key checks.
    const w = await setup(
      `future-hold-${Bun.hash(JSON.stringify(change)).toString(36)}`,
      [
        async (turn) => {
          await turn.message();
          return {
            status: "failed",
            disposition: "broken",
            failure: failures[0]!,
          };
        },
      ],
    );
    const capabilities = spyOn(w.fake.registry, "capabilities");
    try {
      const id = await w.begin();
      const held = await waitHeld(w.opened.harness);
      const future = z
        .json()
        .parse({ ...held, ...change, futureHold: { keep: "exactly" } });
      await w.opened.harness.commit(async (tx) => {
        (await tx.doc(FutureControlDoc)).held[String(id)] = future;
      }, context);
      const saved = JSON.stringify(future);
      await w.opened.harness.close(context);
      const lookups = capabilities.mock.calls.length;
      await w.reopen();
      const restored = await waitHeld(w.opened.harness);
      expect(JSON.stringify(restored)).toBe(saved);
      expect(contractHoldNeedsNewerBuild(restored)).toBe(true);
      expect(contractHoldCorruption(restored)).toBeUndefined();
      expect(heldFailure([restored])).toEqual({
        tag:
          "writeRefused" in change
            ? "ContractWriteRefused"
            : "ContractHoldUnknown",
        retryable: false,
      });
      expect(runtimeFailurePolicy({ _tag: "FutureFailure" })).toEqual({
        action: "hold",
        retryable: false,
      });
      expect(await admitResume(w.opened.harness, "automatic", context)).toBe(
        "blocked",
      );
      expect(
        await admitResume(w.opened.harness, "explicit", context, {
          runtimes: w.fake.registry,
        }),
      ).toBe("blocked");
      expect(
        JSON.stringify(
          (await w.opened.harness.snapshot(RunControlDoc, context))?.held[
            String(id)
          ],
        ),
      ).toBe(saved);
      expect(capabilities.mock.calls.length).toBe(lookups);
      expect(w.fake.probes()).toBe(0);
      expect(w.fake.turns).toHaveLength(1);
    } finally {
      capabilities.mockRestore();
      await w.close();
    }
  }, 15000);
}

for (const refusal of accountRefusals) {
  for (const recovery of ["provider-policy", "explicit-account"] as const) {
    // Why: a known hold whose account becomes refused must not be rewritten, probed or admitted automatically.
    test(`${refusal._tag} refused account retains its saved ${recovery} hold through restore and both admissions`, async () => {
      const w = await setup(
        `refused-${refusal._tag.toLowerCase()}-${recovery}`,
        [
          async (turn) => {
            await turn.message();
            return {
              status: "failed",
              disposition: "broken",
              failure: failures[0]!,
            };
          },
        ],
      );
      try {
        const id = await w.begin();
        const held = await waitHeld(w.opened.harness);
        await w.opened.harness.commit(async (tx) => {
          (await tx.doc(FutureControlDoc)).held[String(id)] = z.json().parse({
            ...held,
            recovery: { kind: recovery },
            futureHold: "keep byte for byte",
          });
        }, context);
        const storedControl = () => {
          const db = new Database(w.run.database, { readonly: true });
          try {
            return db
              .query<{ record: string }, []>(
                "SELECT record FROM documents WHERE json_extract(record, '$.kind') = 'neuve.run-control' AND retired_at IS NULL",
              )
              .all();
          } finally {
            db.close();
          }
        };
        const saved = storedControl();
        expect(saved).toHaveLength(1);
        w.fake.capabilityError(refusal);
        await w.opened.kinds.restore(w.opened.harness, context);
        expect(storedControl()).toEqual(saved);
        expect(await admitResume(w.opened.harness, "automatic", context)).toBe(
          "blocked",
        );
        expect(storedControl()).toEqual(saved);
        expect(
          await admitResume(w.opened.harness, "explicit", context, {
            runtimes: w.fake.registry,
          }),
        ).toBe("blocked");
        expect(storedControl()).toEqual(saved);
        expect(w.fake.probes()).toBe(0);
        expect(w.fake.turns).toHaveLength(1);
      } finally {
        await w.close();
      }
    }, 15000);
  }
}

// Why: refusal before a stage opens has no continuation identity, and must survive reopening.
test("an unopened refused-account hold survives restore and both admissions without an identity", async () => {
  const w = await setup("refused-before-stage-open", []);
  try {
    w.fake.capabilityError(
      new AccountNeedsNewerBuild({ account: route.account.name }),
    );
    await w.begin();
    expect(await waitHeld(w.opened.harness)).toMatchObject({
      failure: { _tag: "AccountNeedsNewerBuild", account: route.account.name },
      savedPhase: "open",
      continuation: null,
      native: null,
    });
    const saved = JSON.stringify(
      await w.opened.harness.snapshot(RunControlDoc, context),
    );
    await w.opened.harness.close(context);
    await w.reopen();
    await w.opened.kinds.restore(w.opened.harness, context);
    expect(
      JSON.stringify(await w.opened.harness.snapshot(RunControlDoc, context)),
    ).toBe(saved);
    expect(await admitResume(w.opened.harness, "automatic", context)).toBe(
      "blocked",
    );
    expect(
      await admitResume(w.opened.harness, "explicit", context, {
        runtimes: w.fake.registry,
      }),
    ).toBe("blocked");
    expect(
      JSON.stringify(await w.opened.harness.snapshot(RunControlDoc, context)),
    ).toBe(saved);
    expect(w.fake.probes()).toBe(0);
    expect(w.fake.opens()).toBe(0);
    expect(w.fake.turns).toHaveLength(0);
  } finally {
    await w.close();
  }
}, 15000);

for (const refusal of accountRefusals) {
  for (const phase of ["open", "running", "final"] as const) {
    for (const recovery of ["provider-policy", "explicit-account"] as const) {
      for (const admission of ["automatic", "explicit"] as const) {
        // Why: every saved phase, including holds written by cf0fe480, must recover without a probe or repeated completed turn.
        test(`${refusal._tag} ${phase} account refusal with ${recovery} recovers through ${admission} admission`, async () => {
          const refuse: Script = async (turn) => {
            w.fake.capabilityError(refusal);
            await turn.message();
            return {
              status: "failed",
              disposition: "broken",
              failure: runtimeErrorToFailure(refusal),
            };
          };
          const accept: Script = async (turn) => {
            expect(turn.final).toBe(phase === "final");
            if (phase !== "open") {
              const state = await w.state();
              expect(state.continuation as unknown).toEqual(savedContinuation);
              expect(state.rounds.at(-1)?.attempt).toBe(2);
              expect(turn.turnId).toBe(`${failedTurn}:attempt:2`);
            }
            if (turn.final)
              return { status: "completed", structuredOutput: { answer: 2 } };
            const call = submit(`accepted-${turn.turnId}`, 2);
            await turn.message([call]);
            await turn.invoke(call, turn.signal);
          };
          const w = await setup(
            `readable-${refusal._tag.toLowerCase()}-${phase}-${recovery}-${admission}`,
            phase === "open"
              ? [accept]
              : phase === "running"
                ? [refuse, accept]
                : [
                    async (turn) => {
                      await turn.message();
                    },
                    refuse,
                    accept,
                  ],
            { limit: phase === "final" ? 1 : 6 },
          );
          let savedContinuation: unknown;
          let failedTurn: string | undefined;
          const cutoffAt = Date.now() + 60_000;
          try {
            if (phase === "open") w.fake.capabilityError(refusal);
            const id = await w.begin(cutoffAt);
            const held = await waitHeld(w.opened.harness);
            expect(contractHoldNeedsNewerBuild(held)).toBe(false);
            expect(held).toMatchObject({
              savedPhase: phase,
              recovery: { kind: "provider-policy" },
            });
            expect(held.continuation).toEqual(
              phase === "open"
                ? null
                : { runtime: "claude-code", key: "fake-account-identity" },
            );
            expect(w.fake.turns).toHaveLength(
              phase === "open" ? 0 : phase === "running" ? 1 : 2,
            );
            failedTurn = w.fake.turns.at(-1)?.turnId;
            savedContinuation = held.continuation;
            await w.opened.harness.commit(async (tx) => {
              (await tx.doc(RunControlDoc)).held[String(id)] = {
                ...held,
                recovery: { kind: recovery },
              };
            }, context);
            const saved = JSON.stringify(
              (await w.opened.harness.snapshot(RunControlDoc, context))?.held,
            );
            await w.opened.harness.close(context);
            const db = new Database(w.run.database);
            try {
              db.query(
                "UPDATE tasks SET record = json_set(record, '$.state.checkpoint.held.recovery.kind', ?) WHERE id = ?",
              ).run(recovery, id);
            } finally {
              db.close();
            }
            await w.reopen();
            expect(
              JSON.stringify(
                (await w.opened.harness.snapshot(RunControlDoc, context))?.held,
              ),
            ).toBe(saved);
            expect(
              await admitResume(
                w.opened.harness,
                "still-refused-auto",
                context,
              ),
            ).toBe("blocked");
            expect(
              await admitResume(
                w.opened.harness,
                "still-refused-explicit",
                context,
                { runtimes: w.fake.registry },
              ),
            ).toBe("blocked");
            expect(w.fake.probes()).toBe(0);
            await w.opened.harness.close(context);
            w.fake.capabilityError();
            await w.reopen();
            expect(
              JSON.stringify(
                (await w.opened.harness.snapshot(RunControlDoc, context))?.held,
              ),
            ).toBe(saved);
            expect(
              await admitResume(
                w.opened.harness,
                "readable",
                context,
                admission === "explicit"
                  ? { runtimes: w.fake.registry }
                  : undefined,
              ),
            ).toBe("committed");
            const task = await w.opened.harness.waitForTask(id, context);
            expect(task.state.outcome).toMatchObject({
              status: "completed",
              result: { agentResult: { turnsUsed: phase === "open" ? 1 : 2 } },
            });
            expect(task.input).toMatchObject({ cutoffAt });
            expect(w.fake.turns).toHaveLength(
              phase === "open" ? 1 : phase === "running" ? 2 : 3,
            );
            expect(
              (await w.state()).rounds.map((round) => round.attempt),
            ).toEqual(
              phase === "open" ? [1] : phase === "running" ? [2] : [1, 2],
            );
            expect(w.fake.probes()).toBe(0);
            expect(w.fake.opens()).toBe(w.fake.closes());
            expect(w.run.probes).toEqual([]);
          } finally {
            await w.close();
          }
        }, 15000);
      }
    }
  }
}

// Why: a known account refusal must obey the run's cut-off while still refused.
test("a refused account hold reaches its cut-off without opening or probing", async () => {
  const w = await setup("readable-hold-cutoff", []);
  try {
    w.fake.capabilityError(
      new AccountNeedsNewerBuild({ account: route.account.name }),
    );
    const id = await w.begin(Date.now() + 100);
    await waitHeld(w.opened.harness);
    expect(
      (await w.opened.harness.waitForTask(id, context)).state.outcome.status,
    ).toBe("aborted");
    expect(w.fake.turns).toHaveLength(0);
    expect(w.fake.opens()).toBe(0);
    expect(w.fake.probes()).toBe(0);
  } finally {
    await w.close();
  }
});

// Why: cf0fe480 must retain a newly written refusal as an opaque hold, with both admissions blocked and no probe.
test("cf0fe480 reads AccountStoreRefused as an opaque hold and keeps the persisted bytes", async () => {
  const w = await setup("store-refusal-older-reader", []);
  const extracted = join(import.meta.dir, `.r48-reader-${randomUUID()}`);
  mkdirSync(extracted);
  const repository = resolve(import.meta.dir, "../../../../..");
  const extract = (
    file: string,
    target: string,
    replacements: Readonly<Record<string, string>>,
  ) => {
    // The file as cf0fe480 had it, kept beside this test: a checkout may have no history (a
    // shallow CI clone, or the public repository, whose history starts after cf0fe480).
    const kept = readFileSync(
      join(import.meta.dir, "fixtures/cf0fe480", `${basename(file)}.fixture`),
      "utf8",
    );
    const original = pathToFileURL(join(repository, file));
    const source = kept.replace(
      /(from\s+|import\s*)["']([^"']+)["']/g,
      (whole, prefix: string, specifier: string) => {
        const replacement =
          replacements[specifier] ??
          (specifier.startsWith(".")
            ? new URL(specifier, original).href
            : specifier);
        return `${prefix}${JSON.stringify(replacement)}`;
      },
    );
    const output = join(extracted, target);
    writeFileSync(output, source);
    return pathToFileURL(output).href;
  };
  try {
    const refusal = new AccountStoreRefused({
      account: route.account.name,
      folder: "/temporary/Neuve",
      problem: { kind: "writable-by-others" },
    });
    w.fake.capabilityError(refusal);
    const id = await w.begin();
    const held = await waitHeld(w.opened.harness);
    expect(held).toMatchObject({
      failure: runtimeErrorToFailure(refusal),
      recovery: { kind: "provider-policy" },
      continuation: null,
    });
    expect(contractHoldNeedsNewerBuild(held)).toBe(false);
    const oldErrors = extract(
      "packages/runtime/src/errors.ts",
      "errors.ts",
      {},
    );
    const oldPolicy = extract(
      "packages/harness/src/pi/failure-policy.ts",
      "failure-policy.ts",
      { "@neuve/runtime": oldErrors },
    );
    const oldControl = extract(
      "packages/harness/src/pi/control.ts",
      "control.ts",
      { "@neuve/runtime": oldErrors, "./failure-policy.ts": oldPolicy },
    );
    const reader: typeof import("../../../src/pi/failure-policy.ts") =
      await import(oldPolicy);
    const control: typeof import("../../../src/pi/control.ts") = await import(
      oldControl
    );
    const capabilities = spyOn(w.fake.registry, "capabilities");
    try {
      expect(reader.contractHoldNeedsNewerBuild(held)).toBe(true);
      expect(reader.contractHoldCorruption(held)).toBeUndefined();
      control.registerResumeRuntimes(w.opened.harness, w.fake.registry);
      const before = readFileSync(w.run.database);
      const saved = JSON.stringify(
        (await w.opened.harness.snapshot(RunControlDoc, context))?.held[
          String(id)
        ],
      );
      expect(
        await control.admitResume(w.opened.harness, "older-auto", context),
      ).toBe("blocked");
      expect(
        await control.admitResume(w.opened.harness, "older-explicit", context, {
          runtimes: w.fake.registry,
        }),
      ).toBe("blocked");
      expect(
        JSON.stringify(
          (await w.opened.harness.snapshot(RunControlDoc, context))?.held[
            String(id)
          ],
        ),
      ).toBe(saved);
      expect(readFileSync(w.run.database)).toEqual(before);
      expect(capabilities.mock.calls).toHaveLength(0);
      expect(w.fake.probes()).toBe(0);
      expect(w.fake.turns).toHaveLength(0);
    } finally {
      capabilities.mockRestore();
    }
  } finally {
    await w.close();
    rmSync(extracted, { recursive: true, force: true });
  }
}, 15000);
