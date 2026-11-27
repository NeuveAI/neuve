// Why: pi-ai returns zero when its model table has no price. A native zero with actual tokens
// must not become a known metered bill. Explicit estimates keep their own named/versioned rate.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { storeLocationIn } from "@neuve/records-core";
import type { Cost, PriceRate } from "../../../src/pi/capture/dump.ts";
import {
  captureRunDump,
  readCapturedDump,
} from "../../../src/pi/capture/export.ts";
import { openCaptureJournal } from "../../../src/pi/capture/journal.ts";
import {
  captureAuthority,
  MODEL,
  route,
  scanCaptures,
  runIn,
  usage,
  value,
} from "./fixture.ts";

const directory = mkdtempSync(join(tmpdir(), "harness-native-pricing-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const context = BACKGROUND_CONTEXT;
const zeroRate: PriceRate = {
  name: "explicit-free-fixture",
  version: 2,
  currency: "USD",
  source: "explicit fixture estimate; not a recorded provider bill",
  perMillionTokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const unknown: Cost["recorded"] = {
  status: "unknown",
  reason: "pi reported zero cost for non-zero usage without price provenance",
};
const cases: ReadonlyArray<{
  name: string;
  tokens: number;
  total: number;
  rate?: PriceRate;
  cost: Cost;
}> = [
  {
    name: "unpriced",
    tokens: 12,
    total: 0,
    cost: { recorded: unknown, estimate: null },
  },
  {
    name: "explicit-zero-estimate",
    tokens: 12,
    total: 0,
    rate: zeroRate,
    cost: {
      recorded: unknown,
      estimate: { rate: "explicit-free-fixture@2", total: 0 },
    },
  },
  {
    name: "recorded-positive",
    tokens: 12,
    total: 1.25,
    cost: {
      recorded: { status: "recorded", total: 1.25, currency: "USD" },
      estimate: null,
    },
  },
  {
    name: "no-tokens",
    tokens: 0,
    total: 0,
    cost: {
      recorded: { status: "recorded", total: 0, currency: "USD" },
      estimate: null,
    },
  },
];

for (const sample of cases) {
  test(`native metered pricing: ${sample.name}`, async () => {
    const runId = sample.name;
    const journalPath = join(directory, runId, "capture");
    const database = join(directory, runId, "pi.sqlite");
    const journal = openCaptureJournal(journalPath, runId);
    using authority = captureAuthority(join(directory, runId));
    const scope = { runId };
    journal.capture({
      type: "run.start",
      scope,
      runKind: "coding",
      sourceRevision: "abc123",
      route: "fixture",
      pricing: "metered",
    });
    const routed = route(journal.capture, scope);
    const tokens = usage(sample.tokens, 0);
    routed.faux.setResponses([
      routed.step(fauxAssistantMessage("done", { responseId: runId }), {
        ...tokens,
        cost: { ...tokens.cost, input: sample.total, total: sample.total },
      }),
    ]);
    const harness = await Harness.open(
      await openNodeSqliteStorage(database),
      { registry: createRegistry(), models: routed.models },
      context,
    );
    const root = await harness.root(context, { agent: { model: MODEL } });
    await (
      await root.submit({ type: "input", content: "check" }, context)
    ).wait(context);
    journal.capture({ type: "run.end", scope, status: "completed" });
    await harness.close(context);
    journal.close();
    const storage = await openNodeSqliteStorage(database);
    const location = storeLocationIn(join(directory, `${runId}-records`));
    const run = runIn(location);
    try {
      const captured = value(
        await run(
          captureRunDump({
            credentialInspection: authority.inspection,
            runId,
            journal: journalPath,
            native: { reads: storage, context },
            nativeDatabase: database,
            rate: sample.rate,
          }),
        ),
      );
      value(await run(scanCaptures(location)));
      const dump = value(await run(readCapturedDump(captured.capture)));
      const session = dump.sessions[0]!;
      expect(session.turns[0]!.cost).toEqual(sample.cost);
      expect(session.totals.turns.cost).toEqual(sample.cost);
      expect(session.totals.ledger!.cost).toEqual(sample.cost);
      expect(dump.run.totals.cost).toEqual(sample.cost);
      expect(dump.run.rate).toEqual(sample.rate ?? null);
    } finally {
      await storage.close(context);
    }
  });
}
