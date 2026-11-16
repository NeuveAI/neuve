// Why: a contract session has durable observations but no pi model calls. Real close,
// scan, export and audit must retain that distinction across terminal and resumed work.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
  setup,
  submit,
  probe,
  usage,
  waitHeld,
  route,
  type Script,
} from "../stages/contract-fixture.ts";
import { admitResume } from "../../../src/pi/control.ts";
import {
  openCaptureJournal,
  type CaptureJournal,
} from "../../../src/pi/capture/journal.ts";
import {
  captureRunDump,
  readCapturedDump,
  exportCapturedDump,
  readSessionDump,
} from "../../../src/pi/capture/export.ts";
import { auditCapture } from "../../../src/pi/capture/audit.ts";
import { rawCaptures } from "../../../src/pi/capture/records.ts";
import { ScanMachineBudget } from "../../../src/pi/capture/process.ts";
import {
  machineInspectionInputs,
  scanMemoryGrant,
} from "../../../src/pi/capture/inspection-pool.ts";
import { runIn, value, scanCaptures } from "./fixture.ts";
import type { CloseMode } from "../../../src/pi/capture/dump.ts";
import { deriveCapture } from "../../../src/pi/capture/canonical.ts";
import { readBackup } from "../../../src/pi/capture/sources.ts";
import { ContractState } from "../../../src/pi/stages/contract-state.ts";
import { readDump } from "../../../src/pi/capture/archive.ts";

const command = [
  process.execPath,
  "--no-env-file",
  fileURLToPath(
    new URL("../../../../../apps/neuve-cli/src/cli.ts", import.meta.url),
  ),
];
const charged = { ...usage, cacheRead: 7, cacheWrite5m: 2, cacheWrite1h: 3 };
const accepted: Script = async (turn) => {
  const call = submit(`submit-${turn.turnId}`, 2);
  await turn.message([call], { usage: charged });
  await turn.charge(charged);
  await turn.invoke(call, turn.signal);
};

async function captured(
  name: string,
  scripts: Script[],
  configure?: NonNullable<Parameters<typeof setup>[2]>["configure"],
) {
  let journal: CaptureJournal;
  let mode: CloseMode = "interrupted";
  const snapshots: string[] = [];
  const w = await setup(`capture-${name}`, scripts, {
    ...(configure === undefined ? {} : { configure }),
    capture: (event) => journal.capture(event),
    onClose: async ({ reads, context: closeContext }) => {
      // This is the real storage barrier, after Harness.close joined the stage scheduler.
      expect(w.fake.closes()).toBe(w.fake.opens());
      journal.close();
      const filed = value(
        await runIn(w.run.ctx.location)(
          captureRunDump({
            runId: w.run.ctx.runId,
            journal: join(w.run.root, "declared-capture"),
            nativeDatabase: w.run.database,
            native: { reads, context: closeContext },
            close: mode,
            declared: [
              "no-wire-capture",
              "claude-subscription",
              "tool-use",
              "SYSTEM-MARK-7f3",
            ],
          }),
        ),
      );
      snapshots.push(filed.capture);
    },
  });
  const openJournal = () => {
    journal = openCaptureJournal(
      join(w.run.root, "declared-capture"),
      w.run.ctx.runId,
    );
    journal.capture({
      type: "run.start",
      scope: { runId: w.run.ctx.runId },
      runKind: "scored",
      sourceRevision: "2".repeat(40),
      route: "claude/fake",
      pricing: "subscription",
    });
  };
  openJournal();
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    runIn(w.run.ctx.location)(
      effect.pipe(Effect.mapError((error) => JSON.stringify(error))),
    );
  return {
    w,
    run,
    close: async (
      closing: CloseMode,
      status: "completed" | "aborted" | "failed" = "completed",
    ) => {
      mode = closing;
      if (mode === "ended")
        journal.capture({
          type: "run.end",
          scope: { runId: w.run.ctx.runId },
          status,
        });
      await w.opened.harness.close(context);
      const capture = snapshots.at(-1);
      if (capture === undefined) throw new Error("No close capture");
      value(await run(scanCaptures(w.run.ctx.location)));
      return { capture, dump: value(await run(readCapturedDump(capture))) };
    },
    reopen: async () => {
      openJournal();
      await w.reopen();
    },
  };
}

// Why: terminal task documents are retired; captures must still retain bounded, masked
// results, usage and native continuation without inventing a request or model text.
test("a completed contract run exports and audits its declared observations", async () => {
  const c = await captured(
    "completed",
    [
      async (turn) => {
        const calls = [probe("read", 1), submit("answer", 2)];
        turn.native("native-final");
        await turn.send({
          type: "text",
          turnId: turn.turnId,
          at: new Date().toISOString(),
          text: "UNCAPTURED-MODEL-TEXT",
        });
        await turn.message(calls, { usage: charged });
        await turn.charge(charged);
        for (const call of calls) await turn.invoke(call, turn.signal);
      },
    ],
    (step) => ({
      ...step,
      spec: {
        ...step.spec,
        tools: step.spec.tools.map((tool) => ({
          ...tool,
          handle: () =>
            Effect.succeed({ text: `ann@example.com ${"x".repeat(100_000)}` }),
        })),
      },
    }),
  );
  try {
    expect((await c.w.start()).status).toBe("completed");
    const { capture, dump } = await c.close("ended");
    expect(dump.run.complete).toBe(true);
    expect(dump.run.gaps).toEqual([]);
    expect(dump.unjoined).toEqual([]);
    expect(
      dump.sessions.every((s) => s.calls.length === 0 && s.turns.length === 0),
    ).toBe(true);
    const declared = dump.run.contractContexts?.[0];
    expect(declared).toMatchObject({
      coverage: "no-wire-capture",
      costUsd: null,
      usage: charged,
      state: {
        account: "fake-claude",
        accountKind: "claude-subscription",
        continuation: { runtime: "claude-code", key: "fake-account-identity" },
        native: { sessionId: "native-final", resumePoint: "carrier-1" },
      },
      callDispositions: { read: "completed", answer: "completed" },
    });
    expect(declared?.state.rounds).toHaveLength(1);
    const result = declared?.state.calls["read"];
    if (result?.status !== "completed")
      throw new Error("Missing completed result");
    expect(result.outcome.text.length).toBeLessThan(100_000);
    expect(result.outcome.text).not.toContain("ann@example.com");
    expect(JSON.stringify(dump.run)).not.toContain("UNCAPTURED-MODEL-TEXT");
    expect(JSON.stringify(declared)).not.toContain("requestedAt");
    expect(JSON.stringify(declared)).not.toContain('"body"');
    expect(dump.run.totals.tokens).toEqual({
      input: 12,
      output: 3,
      cacheRead: 7,
      cacheWrite: 5,
      totalTokens: 27,
    });
    expect(dump.run.totals.cost.recorded.status).toBe("unknown");
    await mkdir(join(c.w.run.root, "datasets"), { recursive: true });
    await mkdir(join(c.w.run.root, "dataset"), { recursive: true });
    const exported = value(
      await c.run(
        exportCapturedDump({
          capture,
          retention: { policy: "test only" },
          root: join(c.w.run.root, "datasets"),
        }),
      ),
    );
    const reread = value(await c.run(readSessionDump(exported.directory)));
    expect(reread.run.contractContexts).toEqual(dump.run.contractContexts);
    const portable = value(
      await c.run(
        exportCapturedDump({
          capture,
          retention: { policy: "test only" },
          root: join(c.w.run.root, "datasets"),
          redaction: "portable",
        }),
      ),
    );
    expect(
      value(await c.run(readSessionDump(portable.directory))).run
        .contractContexts,
    ).toEqual(dump.run.contractContexts);
    const row = value(await c.run(rawCaptures())).find(
      (r) => r._tag !== "Invalid" && r.event.payload.rawCapture === capture,
    );
    if (row === undefined || row._tag === "Invalid")
      throw new Error("No raw capture event");
    const audit = auditCapture({
      location: c.w.run.ctx.location,
      event: row.event,
      command,
    }).pipe(
      Effect.provideService(ScanMachineBudget, (sizes) =>
        scanMemoryGrant(sizes, {
          ...machineInspectionInputs(),
          available: 8 * 1024 ** 3,
        }),
      ),
    );
    expect(value(await c.run(audit))).toMatchObject({
      observed: "clean",
      disagrees: false,
    });
  } finally {
    await c.w.close();
  }
}, 120_000);

// Why: a hold retries one logical round, and must retain both physical outcomes and
// usage when the same owning task reopens at its saved native point.
test("a held contract run reopens and closes with both attempt settlements", async () => {
  const c = await captured("held", [
    async (turn) => {
      const call = probe("before-hold", 1);
      await turn.message([call], { usage: charged });
      await turn.charge(charged);
      await turn.invoke(call, turn.signal);
      return {
        status: "failed",
        disposition: "broken",
        failure: {
          _tag: "SignInRequired",
          account: route.account.name,
          hint: {
            kind: "command",
            command: "claude auth login",
            environment: {
              CLAUDE_CONFIG_DIR: "/accounts/ann@example.com/config",
            },
          },
        },
      };
    },
    accepted,
  ]);
  try {
    const id = await c.w.begin();
    await waitHeld(c.w.opened.harness);
    const held = await c.close("held");
    expect(held.dump.run.complete).toBe(true);
    expect(held.dump.run.execution).toBe("open");
    expect(held.dump.run.contractContexts?.[0]?.callDispositions).toEqual({
      "before-hold": "completed",
    });
    await mkdir(join(c.w.run.root, "datasets"), { recursive: true });
    for (const redaction of ["restricted", "portable"] as const) {
      const exported = value(
        await c.run(
          exportCapturedDump({
            capture: held.capture,
            retention: { policy: "test only" },
            root: join(c.w.run.root, "datasets"),
            redaction,
          }),
        ),
      );
      const reread = value(await c.run(readSessionDump(exported.directory)));
      expect(JSON.stringify(reread.run)).not.toContain("ann@example.com");
      expect(reread.run.contractContexts?.[0]?.settlements).toEqual({
        [c.w.fake.turns[0]!.turnId]: {
          status: "failed",
          disposition: "broken",
          failure: {
            _tag: "SignInRequired",
            account: route.account.name,
            hint: {
              kind: "command",
              command: "claude auth login",
              environment: { CLAUDE_CONFIG_DIR: "/accounts/<email>/config" },
            },
          },
        },
      });
    }
    await c.reopen();
    await waitHeld(c.w.opened.harness);
    expect(
      await admitResume(
        c.w.opened.harness,
        "capture-explicit-resume",
        context,
        { runtimes: c.w.fake.registry },
      ),
    ).toBe("committed");
    expect(
      (await c.w.opened.harness.waitForTask(id, context)).state.outcome.status,
    ).toBe("completed");
    const ended = await c.close("ended");
    expect(ended.dump.run.complete).toBe(true);
    const declared = ended.dump.run.contractContexts?.[0];
    expect(declared?.state.rounds.map((round) => round.attempt)).toEqual([2]);
    expect(
      Object.values(declared?.settlements ?? {}).map(
        (outcome) => outcome.status,
      ),
    ).toEqual(["failed", "completed"]);
    expect(declared?.usage.input).toBe(24);
    expect(c.w.fake.opens()).toBe(2);
  } finally {
    await c.w.close();
  }
}, 120_000);

// Why: abort must retain unknown effects and explicitly cancel undispatched calls,
// after joining every handler and before the terminal task document is retired.
test("an aborted contract run exports unknown and cancelled calls", async () => {
  let reached = () => {};
  const executing = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const c = await captured(
    "aborted",
    [
      async (turn) => {
        const calls = [probe("unknown", 1), probe("cancelled", 2)];
        await turn.message(calls, { usage: charged });
        await turn.charge(charged);
        await turn.invoke(calls[0]!, turn.signal);
      },
    ],
    (step) => ({
      ...step,
      spec: {
        ...step.spec,
        tools: step.spec.tools.map((tool) => ({
          ...tool,
          handle: () => Effect.andThen(Effect.sync(reached), Effect.never),
        })),
      },
    }),
  );
  try {
    const id = await c.w.begin();
    await executing;
    await c.w.opened.harness.abortTask(id, context);
    expect(
      (await c.w.opened.harness.waitForTask(id, context)).state.outcome.status,
    ).toBe("aborted");
    const { dump } = await c.close("ended", "aborted");
    expect(dump.run.complete).toBe(true);
    expect(dump.run.contractContexts?.[0]?.callDispositions).toEqual({
      unknown: "unknown",
      cancelled: "cancelled",
    });
    expect(
      Object.values(dump.run.contractContexts?.[0]?.settlements ?? {}).map(
        (outcome) => outcome.status,
      ),
    ).toEqual(["interrupted"]);
  } finally {
    await c.w.close();
  }
}, 120_000);

// Why: the declared exception must never waive pi's native-call obligation. Rebuild
// the same source with a genuine pi assistant entry that has no journal call.
test("pi turns without native calls remain uncaptured beside declared contract work", async () => {
  const c = await captured("pi-gap", [accepted]);
  try {
    await c.w.start();
    const { capture } = await c.close("ended");
    await mkdir(join(c.w.run.root, "datasets"), { recursive: true });
    await mkdir(join(c.w.run.root, "dataset"), { recursive: true });
    const exported = value(
      await c.run(
        exportCapturedDump({
          capture,
          retention: { policy: "test only" },
          root: join(c.w.run.root, "dataset"),
        }),
      ),
    );
    const archive = await readDump(exported.directory);
    const database = archive.files.get("native/pi.sqlite");
    if (database === undefined) throw new Error("No native backup");
    const native = await readBackup(database);
    const conversation = native.conversations[0];
    if (conversation === undefined)
      throw new Error("No orchestration conversation");
    conversation.entries.push({
      id: 999_999,
      conversationId: conversation.id,
      kind: "pi.assistant",
      model: [
        {
          role: "assistant",
          provider: "anthropic",
          model: "pi-model",
          stopReason: "stop",
          timestamp: 1,
          content: [],
          usage: {
            input: 12,
            output: 3,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 15,
            cost: { total: 0 },
          },
        },
      ],
    });
    conversation.documents = conversation.documents.filter(
      (doc) => doc.kind !== "pi.usage",
    );
    conversation.documents.push({
      kind: "pi.usage",
      version: 1,
      value: {
        models: {
          "anthropic/pi-model": {
            input: 12,
            output: 3,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 15,
            cost: { total: 0 },
          },
        },
        tools: {},
      },
    });
    const projection = await deriveCapture(
      c.w.run.ctx.runId,
      {
        native,
        lines: [],
        tornLines: 0,
        backup: { status: "unavailable", reason: "fixture" },
        journal: { status: "unavailable", reason: "fixture" },
        artifacts: [],
      },
      {
        version: 1,
        maskVersion: 1,
        declared: [],
        tornLines: 0,
        close: "ended",
        rate: null,
      },
    );
    expect(projection.run.gaps).toContainEqual(
      expect.objectContaining({ code: "turns-uncaptured", count: 1 }),
    );
    expect(projection.run.complete).toBe(false);
    expect(
      String(
        ContractState.parse(projection.run.contractContexts?.[0]?.state)
          .account,
      ),
    ).toBe("fake-claude");
  } finally {
    await c.w.close();
  }
}, 120_000);

// Why: a failed task loses its task document too; its retained partial must remain
// attributable and complete when the runtime reported the turn's failure.
test("a failed contract step exports its retained partial", async () => {
  const c = await captured("failed", [
    async (turn) => {
      const call = probe("before-failure", 1);
      await turn.message([call, probe("undispatched", 2)], { usage: charged });
      await turn.charge(charged);
      await turn.invoke(call, turn.signal);
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
  try {
    expect((await c.w.start()).status).toBe("failed");
    const { dump } = await c.close("ended", "failed");
    expect(dump.run.complete).toBe(true);
    expect(dump.run.contractContexts?.[0]?.callDispositions).toEqual({
      "before-failure": "completed",
      undispatched: "cancelled",
    });
    expect(
      Object.values(dump.run.contractContexts?.[0]?.settlements ?? {}).map(
        (outcome) => outcome.status,
      ),
    ).toEqual(["failed"]);
  } finally {
    await c.w.close();
  }
}, 120_000);

// Why: declaring coverage must not hide missing terminal outcomes, call results or
// authoritative usage. Derive each refusal from a real completed task's records.
test("declared contract coverage still reports missing observations", async () => {
  const c = await captured("gaps", [accepted]);
  try {
    await c.w.start();
    const { capture } = await c.close("ended");
    const dump = value(await c.run(readCapturedDump(capture)));
    const source = dump.run.sessionDocuments.find(
      (document) => document.kind === "neuve.contract-partials",
    );
    if (source === undefined) throw new Error("No retained contract context");
    const native = {
      conversations: dump.sessions.map((session) => ({
        id: session.conversationId,
        record: { id: session.conversationId },
        entries: [],
        tasks: session.tasks,
        documents: [],
        taskDocuments: [],
      })),
      session: [source],
    };
    const { NativeSnapshot } =
      await import("../../../src/pi/capture/sources.ts");
    const original = NativeSnapshot.parse(native);
    const { contractContexts, contractContextGaps } =
      await import("../../../src/pi/capture/contract-context.ts");
    const declared = contractContexts(original);
    const context = declared[0];
    if (context === undefined) throw new Error("No declared context");
    expect(contractContextGaps(declared, original, c.w.run.ctx.runId)).toEqual(
      [],
    );
    const noTerminal = structuredClone(context);
    noTerminal.settlements = {};
    expect(
      contractContextGaps([noTerminal], original, c.w.run.ctx.runId),
    ).toContainEqual([
      "calls-unended",
      1,
      `contract context ${context.state.contextKey}: started turns have no terminal outcome`,
    ]);
    const noResult = structuredClone(context);
    const callId = Object.keys(noResult.callDispositions)[0];
    if (callId === undefined) throw new Error("No call disposition");
    noResult.callDispositions[callId] = "pending";
    expect(
      contractContextGaps([noResult], original, c.w.run.ctx.runId).some(
        ([code]) => code === "tool-results-missing",
      ),
    ).toBe(true);
    const noUsage = structuredClone(context);
    noUsage.state.events = noUsage.state.events.filter(
      (event) => event.type !== "usage",
    );
    expect(
      contractContextGaps([noUsage], original, c.w.run.ctx.runId).some(
        ([code]) => code === "ledger-unreconciled",
      ),
    ).toBe(true);
    const lowUsage = structuredClone(context);
    for (const event of lowUsage.state.events)
      if (event.type === "usage") event.usage.input = 0;
    expect(
      contractContextGaps([lowUsage], original, c.w.run.ctx.runId).some(
        ([code]) => code === "usage-mismatch",
      ),
    ).toBe(true);
  } finally {
    await c.w.close();
  }
}, 120_000);
