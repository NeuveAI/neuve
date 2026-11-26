// Why: accepting Claude receipts must not change stored or printed pi receipts, including old
// routes without account metadata. The original hashes came from receipt.ts at 8a29d1f8.
import { expect, test } from "bun:test";
import { canonicalJson, sha256Hex } from "@neuve/records-core";
import { RunReceipt } from "@neuve/records-schema";
import { defaultConfig } from "../src/config.ts";
import { buildReceipt, formatReceipt } from "../src/receipt.ts";
import { OPUS_ROUTE, SOL_ROUTE } from "../src/route.ts";

for (const [named, jsonHash, textHash] of [
  [
    OPUS_ROUTE,
    "c598cbbb54298c28457003d9df457d43933a1053c261682856fb5113dd345707",
    "a1dbbd1601304721446365ccd6d427271feba8e0bcdfaa66f50fb0ff66eaab2b",
  ],
  [
    SOL_ROUTE,
    // Sol's frozen review window moved to 475,000 tokens, changing the recorded ceiling.
    "ae641bdb3893e07daf79d1e0a6a061691142d7dad093ca95db95b7f03a626de4",
    "8754d26b2c4f25a8a921183e14e1573b43cf9772c038d59bb7f4f59d21d5d171",
  ],
] as const) {
  const { account: _account, ...legacy } = named;
  for (const route of [named, legacy]) {
    test(`${route.provider} ${Object.hasOwn(route, "account") ? "named" : "legacy"} receipt stays byte-identical`, () => {
      const receipt = buildReceipt({
        runId: "run",
        runKey: "f".repeat(64),
        generation: 0,
        jobSeq: 1,
        range: {
          baseRef: "main",
          baseOid: "a".repeat(40),
          headOid: "b".repeat(40),
        },
        cycleId: "cycle",
        config: defaultConfig(undefined, route),
        enqueuedAt: new Date(1000).toISOString(),
        startedAt: 2000,
        endedAt: 3000,
        stages: [
          { stage: "frame", agent: "frame", status: "computed", wallMs: 100 },
        ],
        records: [
          {
            type: "model.call",
            agent: "frame",
            stage: "frame",
            finishReason: "toolUse",
            usage: {
              input: 10,
              output: 5,
              cacheRead: 2,
              cacheWrite5m: 3,
              cacheWrite1h: 4,
            },
          },
        ],
      });
      expect(sha256Hex(canonicalJson(receipt))).toBe(jsonHash);
      expect(sha256Hex(formatReceipt(receipt))).toBe(textHash);
      const {
        type: _type,
        runId: _run,
        range: _range,
        cycleId: _cycle,
        ...payload
      } = receipt;
      expect(RunReceipt.parse(payload)).toEqual(payload);
      const { account: _named, ...oldRoute } = payload.route;
      const old = { ...payload, route: oldRoute };
      expect(RunReceipt.parse(old)).toEqual(old);
      expect(formatReceipt({ ...receipt, route: oldRoute })).toBe(
        formatReceipt(receipt),
      );
    });
  }
}
