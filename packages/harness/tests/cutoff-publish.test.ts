// Why: code fill must retain every owned range after cutoff, including excluded lockfiles,
// while disclosure counts grow with batches instead of units on a 420-commit-sized map.
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { Log } from "@neuve/records-core";
import { AssembledBatch } from "../src/compose.ts";
import { fill, link } from "../src/link.ts";
import { storedOutput } from "../src/pipeline.ts";
import { publishPacket } from "../src/publish.ts";
import { FINDERS } from "../src/find.ts";
import {
  hunk,
  frame,
  mapOf,
  manifestOf,
  put,
  storeFixture,
} from "./fixtures/link.ts";
const store = storeFixture("code-fill-scale-");
test("1,484 hunks across 975 files and a lockfile publish after cutoff with seven batch gaps", async () => {
  const result = await store.run(
    Effect.gen(function* () {
      const ctx = yield* store.ctx(true);
      const hunks = Array.from({ length: 974 }, (_, i) =>
        hunk(`h${i}`, `src/file-${i}.ts`),
      );
      for (let i = 0; i < 509; i++)
        hunks.push(hunk(`later-${i}`, `src/file-${i}.ts`, 300));
      hunks.push(hunk("lock", "bun.lock"));
      const frameKey = yield* put("test.frame", frame);
      const mapKey = yield* put("test.map", {
        ...mapOf(hunks, 6),
        frame: frameKey,
      });
      const manifestKey = yield* put("test.manifest", manifestOf(hunks));
      const setup = {
        precompute: "unused",
        scopeKey: null,
        refreshKey: null,
        pins: [],
        disclosures: [],
      };
      const filled = yield* fill(ctx, { mapKey, manifestKey, setup });
      const linked = yield* link(ctx, {
        frameKey,
        mapKey,
        manifestKey,
        fill: filled,
        finders: [],
        setup,
      });
      const batches: AssembledBatch[] = [];
      for (const candidate of linked.candidates)
        batches.push(
          yield* storedOutput(ctx, candidate.assembledKey, AssembledBatch),
        );
      const summary = yield* publishPacket(ctx, {
        candidates: linked.candidates,
        stages: [
          filled.record,
          ...FINDERS.map((lens) => ({
            stage: "find" as const,
            agent: `find.${lens}`,
            status: "skipped" as const,
            wallMs: 0,
          })),
          linked.record,
        ],
        sources: {
          manifest: manifestKey,
          changeMap: linked.changeMapKey,
          scope: null,
        },
        strongestStratum: frame.stratum,
        disclosures: linked.disclosures,
      });
      return {
        batches,
        summary,
        history: yield* Log.history({ cycleId: ctx.cycleId, limit: 10000 }),
        hunks,
      };
    }),
  );
  const units = result.batches.flatMap((batch) => batch.units);
  expect(result.hunks).toHaveLength(1484);
  expect(units).toHaveLength(1484);
  expect([...new Set(units.flatMap((unit) => unit.hunkIds))].sort()).toEqual(
    result.hunks.map((hunk) => hunk.hunkId).sort(),
  );
  expect(
    units.every(
      (unit) =>
        unit.assessment.status === "not-assessed" &&
        unit.assessment.lane === "human-suggested",
    ),
  ).toBe(true);
  expect(
    result.batches.find((batch) => batch.candidate === "generated")?.batches[0]
      ?.title,
  ).toBe("Lockfiles and generated files");
  expect(result.summary.counts).toMatchObject({
    batches: 7,
    units: 1484,
    dispositions: 0,
    gaps: 7,
  });
  expect(result.summary.complete).toBe(false);
  const recorded = result.history.flatMap((row) =>
    row.event.kind === "unit.recorded@2" ? row.event.payload.ownedRanges : [],
  );
  expect(recorded).toHaveLength(1484);
  const keyOf = (path: string, side: string, start: number, end: number) =>
    `${path}:${side}:${start}-${end}`;
  expect(
    recorded
      .map((range) =>
        range.kind === "lines"
          ? keyOf(range.path, range.side, range.startLine, range.endLine)
          : "nontext",
      )
      .sort(),
  ).toEqual(
    result.hunks
      .flatMap((hunk) =>
        hunk.ownedRanges.map((range) =>
          keyOf(
            hunk.path,
            range.side,
            range.startLine,
            range.startLine + range.lineCount - 1,
          ),
        ),
      )
      .sort(),
  );
  expect(
    recorded.every(
      (range) => range.kind === "lines" && range.startLine === range.endLine,
    ),
  ).toBe(true);
  const gaps = result.history.flatMap((row) =>
    row.event.kind === "gap.disclosed@1" ? [row.event.payload] : [],
  );
  expect(gaps).toHaveLength(7);
  expect(
    gaps.every(
      (gap) =>
        gap.kind === "not-assessed" && !gap.detail.includes("didn't finish"),
    ),
  ).toBe(true);
}, 120_000);
