// Why: the defect the independent review found in round 4. A repeat of an ending call must append
// nothing, whatever the review's state, so the ending call's check and the packet's completeness
// must be one rule; and a held refusal whose files can no longer be read must still clear once
// its batch is published.
import { expect, test } from "bun:test";
import { Effect } from "effect";
import {
  Log,
  PublishedPackets,
  mintUlid,
  sha256Hex,
} from "@neuve/records-core";
import type { RecordEvent } from "@neuve/records-schema";
import type { PublishContext } from "../src/publish.ts";
import {
  batchKeyOf,
  publishSettled,
  type SettledBatch,
  type SettledInput,
} from "../src/publish-sections.ts";
import {
  comment,
  eventsOf,
  inputOf,
  scratch,
  threeBatches,
} from "./publish-sections-fixtures.ts";

type Packet = Extract<RecordEvent, { kind: "packet.published@2" }>;

const ALL = { batches: 3, sections: 5 };

const packetsOf = (cycleId: string) =>
  Effect.map(eventsOf(cycleId, "packet.published@2"), (events) =>
    (events as Array<Packet>).sort((x, y) => (x.id < y.id ? -1 : 1)),
  );

const refusalsNamed = (packetId: string) =>
  Effect.map(PublishedPackets.readExact(packetId), (read) =>
    read?.kind === "packet.published@2"
      ? read.gaps
          .filter((g) => g.payload.kind === "batch-not-published")
          .map((g) => g.payload.detail)
      : [],
  );

/** Repeats an ending call `times` times; how many events each repeat appended. */
const repeatEnding = (
  ctx: PublishContext,
  input: SettledInput,
  times: number,
) =>
  Effect.gen(function* () {
    const grew: Array<number> = [];
    for (let n = 0; n < times; n++) {
      const before = (yield* eventsOf(ctx.cycleId)).length;
      yield* publishSettled(ctx, input);
      grew.push((yield* eventsOf(ctx.cycleId)).length - before);
    }
    return grew;
  });

// R4-1, the reviewer's probe: a named held refusal with nothing pending, and three repeats.
test("an ending call repeated while a refusal is named and nothing is pending appends nothing", async () => {
  const store = scratch();
  const { a, b, c } = threeBatches();
  const refusedWide: SettledBatch = {
    ...b,
    paths: ["src/b.ts", "src/x.ts"],
    units: [{ ...b.units[0]!, comments: [comment("has space")] }],
  };
  const result = await store.run(
    Effect.gen(function* () {
      const ctx = store.ctx();
      yield* publishSettled(ctx, inputOf([a], { totals: ALL }));
      yield* publishSettled(ctx, inputOf([refusedWide], { totals: ALL }));
      yield* publishSettled(
        ctx,
        inputOf([b, c], { ending: true, totals: ALL }),
      );
      const grew = yield* repeatEnding(
        ctx,
        inputOf([], { ending: true, totals: ALL }),
        3,
      );
      const packets = yield* packetsOf(ctx.cycleId);
      return { grew, packets, named: yield* refusalsNamed(packets.at(-1)!.id) };
    }),
  );
  expect(result.packets).toHaveLength(2);
  const last = result.packets.at(-1)!;
  expect(last.payload.complete).toBe(false);
  expect(last.payload.counts.pending).toEqual({ batches: 0, sections: 0 });
  expect(result.named).toHaveLength(1);
  expect(result.named[0]).toContain('"Guards"');
  expect(result.grew).toEqual([0, 0, 0]);
}, 30_000);

// R4-1, the general rule: in every ending scenario the tests build, a repeat appends nothing.
test("in every ending scenario, a repeat of the ending call appends nothing", async () => {
  const { a, b, c } = threeBatches();
  const laneRefused: SettledBatch = {
    ...c,
    units: [{ ...c.units[0]!, lane: "human-required" }],
  };
  const idRefused: SettledBatch = {
    ...b,
    units: [{ ...b.units[0]!, comments: [comment("has space")] }],
  };
  const wider: SettledBatch = { ...b, paths: [...b.paths, "src/b-extra.ts"] };
  const ONE = { batches: 1, sections: 2 };
  const TWO = { batches: 2, sections: 3 };
  const scenarios: ReadonlyArray<{
    readonly name: string;
    readonly run: (
      store: ReturnType<typeof scratch>,
    ) => Effect.Effect<
      { ctx: PublishContext; ending: SettledInput },
      unknown,
      never
    >;
  }> = [
    {
      name: "three calls",
      run: (store) =>
        Effect.gen(function* () {
          const ctx = store.ctx();
          yield* publishSettled(ctx, inputOf([a]));
          yield* publishSettled(ctx, inputOf([b]));
          const ending = inputOf([c], { ending: true });
          yield* publishSettled(ctx, ending);
          return { ctx, ending };
        }) as never,
    },
    {
      name: "an ending call with no batch",
      run: (store) =>
        Effect.gen(function* () {
          const ctx = store.ctx();
          yield* publishSettled(ctx, inputOf([a], { totals: ONE }));
          const ending = inputOf([], { ending: true, totals: ONE });
          yield* publishSettled(ctx, ending);
          return { ctx, ending };
        }) as never,
    },
    {
      name: "a refusal held, then the ending call",
      run: (store) =>
        Effect.gen(function* () {
          const ctx = store.ctx();
          yield* publishSettled(ctx, inputOf([a], { totals: TWO }));
          yield* publishSettled(ctx, inputOf([laneRefused], { totals: TWO }));
          const ending = inputOf([], { ending: true, totals: TWO });
          yield* publishSettled(ctx, ending);
          return { ctx, ending };
        }) as never,
    },
    {
      name: "a refused batch published with an extra file",
      run: (store) =>
        Effect.gen(function* () {
          const ctx = store.ctx();
          yield* publishSettled(ctx, inputOf([a], { totals: ALL }));
          yield* publishSettled(ctx, inputOf([idRefused], { totals: ALL }));
          const ending = inputOf([wider, c], { ending: true, totals: ALL });
          yield* publishSettled(ctx, ending);
          return { ctx, ending };
        }) as never,
    },
    {
      name: "a later sequence in the cycle",
      run: (store) =>
        Effect.gen(function* () {
          yield* publishSettled(
            store.ctx(),
            inputOf([a, b, c], { ending: true }),
          );
          const ctx = store.ctx({ runKey: "d".repeat(64) });
          yield* publishSettled(ctx, inputOf([a]));
          yield* publishSettled(ctx, inputOf([b]));
          const ending = inputOf([c], { ending: true });
          yield* publishSettled(ctx, ending);
          return { ctx, ending };
        }) as never,
    },
  ];
  const results: Array<[string, ReadonlyArray<number>]> = [];
  for (const scenario of scenarios) {
    const store = scratch();
    const grew = await store.run(
      Effect.gen(function* () {
        const { ctx, ending } = yield* scenario.run(store);
        return [
          ...(yield* repeatEnding(ctx, ending, 2)),
          ...(yield* repeatEnding(ctx, { ...ending, batches: [] }, 2)),
        ];
      }),
    );
    results.push([scenario.name, grew]);
  }
  expect(results).toEqual(scenarios.map((s) => [s.name, [0, 0, 0, 0]]));
}, 60_000);

// Note: a held refusal whose files cannot be read falls back to its batch's key.
test("a held refusal with no stored files clears once a batch of its key is published", async () => {
  const store = scratch();
  const { a, b, c } = threeBatches();
  const result = await store.run(
    Effect.gen(function* () {
      const ctx = store.ctx();
      yield* publishSettled(ctx, inputOf([a], { totals: ALL }));
      // A held refusal of `b` whose files were never stored (as after a prune).
      const key = `review:${ctx.cycleId}:${ctx.runKey}:gap:refused:${batchKeyOf(b.paths)}:01`;
      yield* Log.append([
        {
          id: mintUlid(),
          kind: "gap.disclosed@1",
          idempotencyKey: key,
          actor: sha256Hex("planted"),
          occurredAt: new Date().toISOString(),
          attribution: {
            cycleId: ctx.cycleId,
            range: ctx.range,
            runId: ctx.runId,
            stage: "publish",
          },
          payload: {
            kind: "batch-not-published",
            detail: 'The changes in "Guards" aren\'t in this review yet.',
          },
        },
      ]);
      yield* publishSettled(ctx, inputOf([c], { totals: ALL }));
      const whileMissing = yield* refusalsNamed(
        (yield* packetsOf(ctx.cycleId)).at(-1)!.id,
      );
      yield* publishSettled(ctx, inputOf([b], { ending: true, totals: ALL }));
      const last = (yield* packetsOf(ctx.cycleId)).at(-1)!;
      return { whileMissing, last, named: yield* refusalsNamed(last.id) };
    }),
  );
  expect(result.whileMissing).toHaveLength(1);
  expect(result.named).toEqual([]);
  expect(result.last.payload.complete).toBe(true);
}, 30_000);

// Why: the summary is what a caller writes into its stage record, so a refusal it reports must
// be this call's, not the one an earlier plan stored for the same batch.
test("a call's summary names its own refusal of a batch, not an earlier call's", async () => {
  const store = scratch();
  const { a, b } = threeBatches();
  const byLane: SettledBatch = {
    ...b,
    units: [{ ...b.units[0]!, lane: "agentic" }],
  };
  const byId: SettledBatch = {
    ...b,
    units: [{ ...b.units[0]!, comments: [comment("has space")] }],
  };
  const result = await store.run(
    Effect.gen(function* () {
      const ctx = store.ctx();
      const first = yield* publishSettled(
        ctx,
        inputOf([a, byLane], { totals: ALL }),
      );
      const second = yield* publishSettled(
        ctx,
        inputOf([a, byId], { totals: ALL }),
      );
      const alone = yield* publishSettled(
        ctx,
        inputOf([byLane], { totals: ALL }),
      );
      return { first, second, alone };
    }),
  );
  expect(result.first.refused.map((r) => r.check)).toEqual([
    "undecided-not-for-person",
  ]);
  expect(result.second.refused.map((r) => r.check)).toEqual(["comment-id"]);
  expect(result.alone.refused.map((r) => r.check)).toEqual([
    "undecided-not-for-person",
  ]);
}, 30_000);
