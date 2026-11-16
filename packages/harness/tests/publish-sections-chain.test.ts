import { expect, test } from "bun:test";
import { Effect } from "effect";
import { Blobs, PublishedPackets, mintUlid } from "@neuve/records-core";
import type { RecordEvent } from "@neuve/records-schema";
import type { PublishContext } from "../src/publish.ts";
import {
  publishSettled,
  publishSettledForTest,
  unpublishedBatches,
  type PublicationStop,
  type SettledBatch,
} from "../src/publish-sections.ts";
import {
  atTime,
  eventsOf,
  inputOf,
  keyedOf,
  scratch,
  threeBatches,
} from "./publish-sections-fixtures.ts";

type Packet = Extract<RecordEvent, { kind: "packet.published@2" }>;

const packetsOf = (cycleId: string) =>
  Effect.map(eventsOf(cycleId, "packet.published@2"), (events) =>
    (events as Array<Packet>).sort((x, y) => (x.id < y.id ? -1 : 1)),
  );

const manifestOf = (packet: Packet) =>
  Effect.gen(function* () {
    const blobs = yield* Blobs.BlobStore;
    const read = yield* blobs.get(packet.refs[0].ref.slice("blob:".length));
    if (read._tag === "Pruned") throw new Error("pruned");
    return JSON.parse(new TextDecoder().decode(read.bytes)) as {
      batches: Array<Record<string, unknown>>;
      gaps: Array<{ id: string; kind: string }>;
      sequence: { ordinal: number; base: string | null };
    };
  });

// Why: cumulative publication. Each call's packet is the one before plus a suffix, supersedes it,
// counts what is still pending, is complete only at the end, and names only its own gaps and its
// batches'.
test("three calls give three packets, each the previous one plus its batch", async () => {
  const store = scratch();
  const { a, b, c } = threeBatches();
  const result = await store.run(
    Effect.gen(function* () {
      const ctx = store.ctx();
      const summaries = [
        yield* publishSettled(ctx, inputOf([a])),
        yield* publishSettled(
          ctx,
          inputOf([b], {
            gaps: [
              {
                key: "graph",
                kind: "graph-unavailable",
                detail: "Graph was not reachable.",
              },
            ],
          }),
        ),
        yield* publishSettled(ctx, inputOf([c], { ending: true })),
      ];
      const packets = yield* packetsOf(ctx.cycleId);
      const manifests = [];
      for (const packet of packets) manifests.push(yield* manifestOf(packet));
      const reads = [];
      for (const packet of packets)
        reads.push(yield* PublishedPackets.readExact(packet.id));
      return { summaries, packets, manifests, reads };
    }),
  );
  const { summaries, packets, manifests, reads } = result;
  expect(packets).toHaveLength(3);
  expect(packets.map((p) => p.payload.ordinal)).toEqual([1, 2, 3]);
  expect(packets.map((p) => p.causation?.supersedes ?? null)).toEqual([
    null,
    packets[0]!.id,
    packets[1]!.id,
  ]);
  expect(manifests.map((m) => m.sequence.base)).toEqual([
    null,
    packets[0]!.id,
    packets[1]!.id,
  ]);
  expect(manifests[1]!.batches.slice(0, 1)).toEqual(manifests[0]!.batches);
  expect(manifests[2]!.batches.slice(0, 2)).toEqual(manifests[1]!.batches);
  expect(packets.map((p) => p.payload.counts.pending)).toEqual([
    { batches: 2, sections: 3 },
    { batches: 1, sections: 1 },
    { batches: 0, sections: 0 },
  ]);
  expect(packets.map((p) => p.payload.complete)).toEqual([false, false, true]);
  expect(
    summaries.map((s) => [s.ordinal, s.complete, s.packetEventId]),
  ).toEqual([
    [1, false, packets[0]!.id],
    [2, false, packets[1]!.id],
    [3, true, packets[2]!.id],
  ]);
  // Packet 2 names its run gap; packet 3 names its batches' gaps and not packet 2's run gap.
  const kinds = reads.map((read) =>
    read?.kind === "packet.published@2"
      ? read.gaps.map((g) => g.payload.kind).sort()
      : [],
  );
  expect(kinds[1]).toContain("graph-unavailable");
  expect(kinds[2]).not.toContain("graph-unavailable");
  expect(kinds[2]).toContain("undecided-failed");
  expect(manifests[2]!.gaps).toEqual([]);
});

/** The whole chain's observable output: packets, their manifests' bytes and every keyed ID. */
const observed = (ctx: PublishContext) =>
  Effect.gen(function* () {
    const packets = yield* packetsOf(ctx.cycleId);
    return {
      packets: packets.map((p) => ({
        id: p.id,
        manifest: p.refs[0].ref,
        supersedes: p.causation?.supersedes ?? null,
        ordinal: p.payload.ordinal,
      })),
      keyed: yield* keyedOf(ctx.cycleId, ctx.runKey),
    };
  });

const T = Date.UTC(2026, 10, 12, 11, 0, 0);

// Why: a replayed run must publish byte-identical packets in the same order. A call repeated after
// it succeeded appends nothing and answers the same; a call stopped at any point inside its
// publication and run again, later, writes the same packets, IDs and manifest bytes.
test("a call repeated after it succeeded appends nothing and gives the same summary", async () => {
  const store = scratch();
  const { a, b, c } = threeBatches();
  const result = await store.run(
    Effect.gen(function* () {
      const ctx = store.ctx();
      const repeats: Array<[unknown, unknown, number, number]> = [];
      for (const input of [
        inputOf([a]),
        inputOf([b]),
        inputOf([c], { ending: true }),
      ]) {
        const first = yield* publishSettled(ctx, input);
        const before = (yield* eventsOf(ctx.cycleId)).length;
        const again = yield* publishSettled(ctx, input);
        const after = (yield* eventsOf(ctx.cycleId)).length;
        repeats.push([first, again, before, after]);
      }
      return repeats;
    }),
  );
  for (const [first, again, before, after] of result) {
    expect(again).toEqual(first);
    expect(after).toBe(before);
  }
});

test.each(["plan", "batches", "manifest"] as const)(
  "a publication stopped after its %s and run again later writes the same packets and bytes",
  async (stop: PublicationStop) => {
    const cycleId = mintUlid();
    const runId = mintUlid();
    const { a, b, c } = threeBatches();
    const first = scratch({ cycleId });
    const expected = await first.run(
      Effect.gen(function* () {
        const ctx = first.ctx({ runId, startedAt: T - 1_000 });
        yield* atTime(T)(publishSettled(ctx, inputOf([a])));
        yield* atTime(T + 10)(publishSettled(ctx, inputOf([b])));
        yield* atTime(T + 20)(
          publishSettled(ctx, inputOf([c], { ending: true })),
        );
        return yield* observed(ctx);
      }),
    );
    const store = scratch({ cycleId });
    const replayed = await store.run(
      Effect.gen(function* () {
        const ctx = store.ctx({ runId, startedAt: T - 1_000 });
        yield* atTime(T)(publishSettled(ctx, inputOf([a])));
        const stopped = yield* Effect.exit(
          atTime(T + 10)(publishSettledForTest(ctx, inputOf([b]), stop)),
        );
        // Run again at another time: what the stored plan fixed does not move with the clock.
        yield* atTime(T + 15)(publishSettled(ctx, inputOf([b])));
        yield* atTime(T + 20)(
          publishSettled(ctx, inputOf([c], { ending: true })),
        );
        return { stopped: stopped._tag, ...(yield* observed(ctx)) };
      }),
    );
    expect(replayed.stopped).toBe("Failure");
    expect(replayed.packets).toEqual(expected.packets);
    expect(replayed.keyed).toEqual(expected.keyed);
  },
);

// Why: the interrupted-publish check is the only thing that tells a dropped review what it left
// unpublished. Stopped at each point inside a publication, it names exactly the batches no packet
// of the sequence holds: none before the batch is appended or once the packet stands, the new
// batch between; and a later sequence's staged batches before its ending.
test.each([
  ["plan", []],
  ["batches", ["Guards"]],
  ["manifest", ["Guards"]],
  ["packet", []],
  ["staged", ["Retry policy", "Guards"]],
] as const)(
  "after a stop at %s the interrupted-publish check names %p",
  async (point, titles) => {
    const store = scratch();
    const { a, b, c } = threeBatches();
    const result = await store.run(
      Effect.gen(function* () {
        let ctx = store.ctx();
        let stopped: string | undefined;
        yield* publishSettled(
          ctx,
          point === "staged"
            ? inputOf([a, b, c], { ending: true })
            : inputOf([a]),
        );
        if (point === "staged") {
          ctx = store.ctx({ runKey: "d".repeat(64) });
          yield* publishSettled(ctx, inputOf([a]));
          yield* publishSettled(ctx, inputOf([b]));
        } else
          stopped = (yield* Effect.exit(
            publishSettledForTest(ctx, inputOf([b]), point),
          ))._tag;
        const named = yield* unpublishedBatches({
          cycleId: ctx.cycleId,
          runKey: ctx.runKey,
          runId: ctx.runId,
        });
        const recorded = (yield* eventsOf(
          ctx.cycleId,
          "batch.recorded@1",
        )) as Array<Extract<RecordEvent, { kind: "batch.recorded@1" }>>;
        const titleOf = new Map(recorded.map((e) => [e.id, e.payload.title]));
        return { stopped, titles: named.map((n) => titleOf.get(n.eventId)) };
      }),
    );
    expect(result.stopped).toBe(point === "staged" ? undefined : "Failure");
    expect(result.titles).toEqual([...titles]);
  },
);

// Why: what a stored plan fixed is published first; batches a replay adds go to the next one.
test("a replay holding more batches than its stored plan publishes the plan's first", async () => {
  const store = scratch();
  const { a, b, c } = threeBatches();
  const result = await store.run(
    Effect.gen(function* () {
      const ctx = store.ctx();
      yield* publishSettled(ctx, inputOf([a]));
      yield* Effect.exit(publishSettledForTest(ctx, inputOf([b]), "plan"));
      const summary = yield* publishSettled(
        ctx,
        inputOf([b, c], { ending: true }),
      );
      const packets = yield* packetsOf(ctx.cycleId);
      const manifests = [];
      for (const packet of packets) manifests.push(yield* manifestOf(packet));
      return { summary, packets, manifests };
    }),
  );
  const titles = result.manifests.map((m) =>
    m.batches.map((batch) => batch["batch"]),
  );
  expect(result.packets.map((p) => p.payload.ordinal)).toEqual([1, 2, 3]);
  expect(titles[1]).toHaveLength(2);
  expect(titles[2]).toHaveLength(3);
  expect(titles[2]!.slice(0, 2)).toEqual(titles[1]!);
  expect(result.packets.map((p) => p.payload.complete)).toEqual([
    false,
    false,
    true,
  ]);
  expect(result.summary.publications.map((p) => p.ordinal)).toEqual([2, 3]);
  expect(result.summary.packetEventId).toBe(result.packets[2]!.id);
});

// Why: nothing changes under a person who is reading. A published batch handed in again is frozen.
test("a frozen batch handed in again is not written again", async () => {
  const store = scratch();
  const { a, b } = threeBatches();
  const changed: SettledBatch = { ...a, title: "Retry policy, renamed" };
  const result = await store.run(
    Effect.gen(function* () {
      const ctx = store.ctx();
      yield* publishSettled(ctx, inputOf([a]));
      const summary = yield* publishSettled(ctx, inputOf([changed, b]));
      return {
        summary,
        batches: yield* eventsOf(ctx.cycleId, "batch.recorded@1"),
        read: yield* PublishedPackets.readStanding(ctx.cycleId),
      };
    }),
  );
  expect(result.batches).toHaveLength(2);
  expect(result.summary.frozen).toHaveLength(1);
  if (result.read?.kind === "packet.published@2")
    expect(
      result.read.batches.map((batch) => batch.recorded?.payload.title),
    ).toEqual(["Retry policy", "Guards"]);
});

// Why: record 0016. Two callers on one base share one publication; neither writes its own.
test("two concurrent callers on the same base write one packet", async () => {
  const store = scratch();
  const { a, b, c } = threeBatches();
  const result = await store.run(
    Effect.gen(function* () {
      const ctx = store.ctx();
      yield* publishSettled(ctx, inputOf([a]));
      const [one, two] = yield* Effect.all(
        [publishSettled(ctx, inputOf([b])), publishSettled(ctx, inputOf([b]))],
        { concurrency: 2 },
      );
      const afterSame = yield* packetsOf(ctx.cycleId);
      // Different batches on one base: one shared plan, then the other caller's batch next; no
      // manifest misses a batch another packet holds.
      const [three, four] = yield* Effect.all(
        [
          publishSettled(ctx, inputOf([c])),
          publishSettled(ctx, inputOf([a, c])),
        ],
        { concurrency: 2 },
      );
      const packets = yield* packetsOf(ctx.cycleId);
      const manifests = [];
      for (const packet of packets) manifests.push(yield* manifestOf(packet));
      return { one, two, afterSame, three, four, packets, manifests };
    }),
  );
  expect(result.afterSame).toHaveLength(2);
  expect(result.one).toEqual(result.two);
  expect(result.packets).toHaveLength(3);
  for (const [i, manifest] of result.manifests.entries())
    if (i > 0)
      expect(
        manifest.batches.slice(0, result.manifests[i - 1]!.batches.length),
      ).toEqual(result.manifests[i - 1]!.batches);
  expect(result.manifests[2]!.batches).toHaveLength(3);
});

// Why: nothing changes under a person who is reading. Another configuration's review of the same
// cycle stages its batches and publishes one packet when it ends, superseding the standing one.
test("a later sequence in the cycle writes no packet until its ending call", async () => {
  const store = scratch();
  const { a, b, c } = threeBatches();
  const result = await store.run(
    Effect.gen(function* () {
      const first = store.ctx();
      yield* publishSettled(first, inputOf([a, b, c], { ending: true }));
      const standing = yield* PublishedPackets.standingPacketId(first.cycleId);
      const later = store.ctx({ runKey: "d".repeat(64) });
      const staged = [
        yield* publishSettled(later, inputOf([a])),
        yield* publishSettled(later, inputOf([b])),
      ];
      const between = yield* PublishedPackets.standingPacketId(first.cycleId);
      const packetsBetween = (yield* packetsOf(first.cycleId)).length;
      const unpublished = yield* unpublishedBatches({
        cycleId: later.cycleId,
        runKey: later.runKey,
        runId: later.runId,
      });
      const ending = yield* publishSettled(
        later,
        inputOf([c], { ending: true }),
      );
      const packets = yield* packetsOf(first.cycleId);
      const read = yield* PublishedPackets.readStanding(first.cycleId);
      return {
        standing,
        staged,
        between,
        packetsBetween,
        unpublished,
        ending,
        packets,
        read,
      };
    }),
  );
  expect(result.between).toBe(result.standing!);
  expect(result.packetsBetween).toBe(1);
  expect(result.staged.map((s) => s.packetEventId)).toEqual([null, null]);
  expect(result.unpublished).toHaveLength(2);
  expect(result.packets).toHaveLength(2);
  const last = result.packets[1]!;
  expect(last.causation?.supersedes).toBe(result.standing!);
  expect(last.payload.ordinal).toBe(1);
  expect(last.payload.added.batches).toBe(3);
  expect(result.ending.packetEventId).toBe(last.id);
  expect(result.read?.eventId).toBe(last.id);
  expect(result.read?.complete).toBe(true);
});

// Why: a follow-on run continues its sequence: its first packet starts with the earlier run's
// batches, verbatim, published by that run.
test("a follow-on run with the same run key continues the chain", async () => {
  const store = scratch();
  const { a, b, c } = threeBatches();
  const result = await store.run(
    Effect.gen(function* () {
      const earlier = store.ctx();
      yield* publishSettled(earlier, inputOf([a]));
      yield* publishSettled(earlier, inputOf([b]));
      const before = yield* packetsOf(earlier.cycleId);
      const next = store.ctx();
      yield* publishSettled(next, inputOf([c], { ending: true }));
      const packets = yield* packetsOf(earlier.cycleId);
      const manifests = [];
      for (const packet of packets) manifests.push(yield* manifestOf(packet));
      return { earlier, next, before, packets, manifests };
    }),
  );
  const [, second, third] = result.manifests;
  expect(third!.batches.slice(0, 2)).toEqual(second!.batches);
  expect(
    third!.batches.map(
      (batch) => (batch["publishedBy"] as { runId: string }).runId,
    ),
  ).toEqual([result.earlier.runId, result.earlier.runId, result.next.runId]);
  expect(result.packets[2]!.causation?.supersedes).toBe(result.before[1]!.id);
  expect(result.packets[2]!.attribution.runId).toBe(result.next.runId);
  expect(result.packets[2]!.payload.complete).toBe(true);
});
