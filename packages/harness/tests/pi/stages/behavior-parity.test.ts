import { expect, test } from "bun:test";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type Api,
} from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { world, settled, toolResults } from "./fixture.ts";

const submission = () =>
  fauxAssistantMessage([fauxToolCall("submit_frame", { answer: 7 })], {
    stopReason: "toolUse",
  });

test("original coercible-invalid input gets the exact Neuve budgeted result without running the tool", async () => {
  const run = await world("invalid-budget");
  run.script.push(
    () =>
      fauxAssistantMessage(
        [
          fauxToolCall("probe", { n: null }, { id: "invalid-probe" }),
          fauxToolCall(
            "submit_frame",
            { answer: null },
            { id: "invalid-submit" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
    submission,
  );
  const opened = await run.open();
  try {
    const id = await run.start(opened);
    await opened.harness.resume();
    const record = await settled(opened.harness, id);
    expect(run.probes).toEqual([]);
    expect(run.sent).toHaveLength(2);
    expect(toolResults(run.sent[1]!.messages)).toEqual([
      {
        name: "probe",
        error: true,
        text: "Invalid input for probe: ✖ Invalid input: expected number, received null\n  → at n\n\n[turn 1 / 6; results are capped at about 3,000 tokens; lookup allowance 0 / 4]",
      },
      {
        name: "submit_frame",
        error: true,
        text: "Invalid input for submit_frame: ✖ Invalid input: expected number, received null\n  → at answer\n\n[turn 1 / 6; results are capped at about 3,000 tokens; lookup allowance 0 / 4]",
      },
    ]);
    expect(record.agentResult?.turnsUsed).toBe(2);
  } finally {
    await opened.harness.close(context);
  }
});

for (const refusal of [
  {
    name: "anthropic-refusal",
    api: "anthropic-messages",
    rawStopReason: "refusal",
  },
  {
    name: "openai-filter",
    api: "openai-responses",
    rawStopReason: "incomplete.content_filter",
  },
] satisfies Array<{ name: string; api: Api; rawStopReason: string }>) {
  test(`${refusal.name} consumes turns, records gaps and reaches the final-generation turn budget`, async () => {
    const run = await world(refusal.name, 2, false, false, refusal.api);
    for (let turn = 1; turn <= 2; turn++)
      run.script.push(() => ({
        ...fauxAssistantMessage([], {
          stopReason: "error",
          responseId: `refused-${turn}`,
          errorMessage: "provider refused",
        }),
        rawStopReason: refusal.rawStopReason,
      }));
    run.script.push(() => fauxAssistantMessage('{"answer":7}'));
    const opened = await run.open();
    try {
      const id = await run.start(opened);
      await opened.harness.resume();
      const record = await settled(opened.harness, id);
      expect(run.sent).toHaveLength(3);
      expect(run.sent.map((sent) => sent.mode.kind)).toEqual([
        "normal",
        "normal",
        "final",
      ]);
      expect(JSON.stringify(run.sent[1]!.messages)).toContain("1 turn(s) left");
      expect(record.agentResult?.turnsUsed).toBe(3);
      expect(record.agentResult?.endedBy).toBe("turn-limit");
      expect(
        run.ctx.log
          .read()
          .filter(
            (entry) => entry.type === "gap" && entry["kind"] === "refusal",
          ),
      ).toHaveLength(2);
      expect(
        run.ctx.log
          .read()
          .filter((entry) => entry.type === "model.call")
          .map((entry) => entry["responseId"]),
      ).toEqual(["refused-1", "refused-2", undefined]);
    } finally {
      await opened.harness.close(context);
    }
  });
}

test("completed OpenAI refusal keeps its existing successful turn accounting", async () => {
  const run = await world("completed-refusal", 2);
  run.script.push(
    () => ({
      ...fauxAssistantMessage("I cannot answer.", { stopReason: "stop" }),
      rawStopReason: "completed",
    }),
    submission,
  );
  const opened = await run.open();
  try {
    const id = await run.start(opened);
    await opened.harness.resume();
    expect((await settled(opened.harness, id)).agentResult?.turnsUsed).toBe(2);
    expect(
      run.ctx.log
        .read()
        .filter((entry) => entry.type === "gap" && entry["kind"] === "refusal"),
    ).toHaveLength(0);
  } finally {
    await opened.harness.close(context);
  }
});

test("an oversized validation diagnostic keeps the cap and budget suffix", async () => {
  const run = await world("invalid-cap");
  run.script.push(
    () =>
      fauxAssistantMessage(
        [
          fauxToolCall("probe", {
            n: null,
            ...Object.fromEntries(
              Array.from({ length: 1600 }, (_, i) => [
                `unknown_field_${i}`,
                true,
              ]),
            ),
          }),
        ],
        { stopReason: "toolUse" },
      ),
    submission,
  );
  const opened = await run.open();
  try {
    const id = await run.start(opened);
    await opened.harness.resume();
    await settled(opened.harness, id);
    const result = toolResults(run.sent[1]!.messages)[0]!;
    expect(run.probes).toEqual([]);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(12_000);
    expect(result.text).toStartWith("Invalid input for probe:");
    expect(result.text).toEndWith(
      "[result cut at the 3,000-token cap; ask for the next page or narrow the lookup]\n\n[turn 1 / 6; results are capped at about 3,000 tokens; lookup allowance 0 / 4]",
    );
  } finally {
    await opened.harness.close(context);
  }
});

test("a close after native invalid settlement replays one budgeted result and spends no extra turn", async () => {
  const run = await world("invalid-reopen");
  let release = () => {};
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  run.pauseRound(async (signal) => {
    release();
    await new Promise<void>((_resolve, reject) =>
      signal?.addEventListener("abort", () => reject(new Error("closed")), {
        once: true,
      }),
    );
  });
  run.script.push(() =>
    fauxAssistantMessage(
      [fauxToolCall("probe", { n: null }, { id: "reopen-invalid" })],
      { stopReason: "toolUse", responseId: "reopen-bad" },
    ),
  );
  const first = await run.open();
  const id = await run.start(first);
  await first.harness.resume();
  await paused;
  await first.harness.close(context);
  run.pauseRound(undefined);
  run.script.push(submission);
  const second = await run.open();
  try {
    await second.harness.resume();
    const record = await settled(second.harness, id);
    expect(run.sent).toHaveLength(2);
    expect(run.probes).toEqual([]);
    expect(toolResults(run.sent[1]!.messages)).toEqual([
      {
        name: "probe",
        error: true,
        text: "Invalid input for probe: ✖ Invalid input: expected number, received null\n  → at n\n\n[turn 1 / 6; results are capped at about 3,000 tokens; lookup allowance 0 / 4]",
      },
    ]);
    expect(record.agentResult?.turnsUsed).toBe(2);
    expect(record.agentResult?.resumedTurns).toBe(1);
    expect(
      run.ctx.log
        .read()
        .filter(
          (entry) =>
            entry.type === "model.call" && entry["responseId"] === "reopen-bad",
        ),
    ).toHaveLength(1);
  } finally {
    await second.harness.close(context);
  }
});

import { routeFailureDiagnostic } from "../../../src/pi/providers/failure.ts";
import { transcriptFacts } from "../../../src/pi/stages/agent.ts";
import { conversationEntries } from "../../../src/pi/stages/tools.ts";
import { agentConversation } from "./fixture.ts";

for (const failure of [
  {
    name: "ordinary-stream-failure",
    rawStopReason: "incomplete.network_error",
    kind: "stream",
  },
  {
    name: "capture-failure-after-filter",
    rawStopReason: "incomplete.content_filter",
    kind: "capture",
  },
] as const)
  test(`${failure.name} remains held and does not consume an answered turn`, async () => {
    const run = await world(failure.name, 2, false, false, "openai-responses");
    run.script.push(() => ({
      ...fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "synthetic failure",
      }),
      rawStopReason: failure.rawStopReason,
      diagnostics: [routeFailureDiagnostic({ kind: failure.kind }, Date.now())],
    }));
    const opened = await run.open();
    try {
      const id = await run.start(opened);
      await opened.harness.resume();
      const watch = await opened.harness.watchTaskGraph(context);
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("No provider hold within 2 seconds")),
            2_000,
          );
          const check = () => {
            const state = watch.value?.tasks[String(id)]?.state;
            if (
              state !== undefined &&
              "phase" in state &&
              state.phase === "provider-held"
            ) {
              clearTimeout(timer);
              resolve();
            }
          };
          check();
          watch.start(async () => check());
        });
      } finally {
        await watch.stop();
      }
      const conversationId = await agentConversation(opened.harness);
      const entries = await opened.harness.commit(
        (tx) => conversationEntries(tx, conversationId),
        context,
      );
      expect(transcriptFacts(entries).turns).toBe(0);
      expect(run.sent).toHaveLength(1);
      expect(
        run.ctx.log
          .read()
          .filter(
            (entry) => entry.type === "gap" && entry["kind"] === "refusal",
          ),
      ).toHaveLength(0);
    } finally {
      await opened.harness.close(context);
    }
  });
