// Why: per-message usage can differ from the authoritative runtime ledger. Receipts must
// preserve the ledger's snapshot/request semantics and retain model.call only for call counts.
import { expect, test } from "bun:test";
import { RunReceipt } from "@neuve/records-schema";
import {
  buildReceipt,
  formatReceipt,
  legacyStageTelemetry,
} from "../src/receipt.ts";
import { setup, submit, usage } from "./pi/stages/contract-fixture.ts";

for (const scope of ["turn", "request"] as const) {
  test(`a contract receipt uses the ${scope} ledger, with unknown subscription cost`, async () => {
    const w = await setup(`receipt-${scope}`, [
      async (turn) => {
        await turn.charge({ ...usage, input: 10 }, scope, "model-a");
        await turn.charge({ ...usage, input: 20 }, scope, "model-a");
        await turn.charge({ ...usage, input: 5 }, scope, "model-b");
        const answer = submit("receipt-submit", 1);
        await turn.message([answer], { usage: { ...usage, input: 1000 } });
        await turn.invoke(answer);
      },
    ]);
    try {
      expect((await w.start()).status).toBe("completed");
      const records = w.run.ctx.log.read();
      expect(records.filter((r) => r.type === "model.call")).toMatchObject([
        { usage: { input: 1000 } },
      ]);
      const receipt = buildReceipt({
        ...w.run.ctx,
        generation: 0,
        jobSeq: 1,
        enqueuedAt: new Date(w.run.ctx.startedAt).toISOString(),
        endedAt: Date.now(),
        records,
        stages: [
          { stage: "frame", agent: "frame", status: "computed", wallMs: 1 },
        ],
      });
      const expected = {
        input: scope === "turn" ? 25 : 35,
        output: scope === "turn" ? 6 : 9,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        cacheRead: 0,
      };
      expect(receipt.totals.usage).toEqual(expected);
      expect(receipt.stages[0]?.usage).toEqual(expected);
      expect(receipt.totals.modelCalls).toBe(1);
      expect(receipt.stages[0]?.modelCalls).toBe(1);
      expect(receipt.totals.costUsd).toBeNull();
      expect(receipt.stages[0]?.costUsd).toBeNull();
      expect(receipt.route.account).toEqual(w.run.ctx.config.route.account);
      expect(receipt.route).not.toHaveProperty("credentialSource");
      expect(receipt.route).not.toHaveProperty("credentialVariable");
      const {
        type: _type,
        runId: _id,
        range: _range,
        cycleId: _cycle,
        ...payload
      } = receipt;
      const {
        failedModelCalls: _failed,
        abortedModelCalls: _aborted,
        ...totals
      } = payload.totals;
      const stored = {
        ...payload,
        totals,
        stages: payload.stages.map(legacyStageTelemetry),
      };
      expect(RunReceipt.parse(stored)).toEqual(stored);
      expect(formatReceipt(receipt)).toContain(
        "the Claude Code sign-in of account fake-claude",
      );
      // A Claude subscription is unpriced, and its receipt names Claude's plan, never ChatGPT's.
      expect(formatReceipt(receipt)).toContain(
        "USD unknown (Claude plan usage)",
      );
      expect(formatReceipt(receipt)).not.toContain("ChatGPT plan usage");
    } finally {
      await w.close();
    }
  });
}
