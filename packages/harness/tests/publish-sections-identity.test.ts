import { expect, test } from "bun:test";
import { Effect } from "effect";
import { PublishedPackets, mintUlid } from "@neuve/records-core";
import type { SettledBatch } from "../src/publish-sections.ts";
import { publishSettled } from "../src/publish-sections.ts";
import {
  atTime,
  inputOf,
  keyedOf,
  reordered,
  scratch,
  threeBatches,
} from "./publish-sections-fixtures.ts";

const T = Date.UTC(2026, 10, 12, 10, 0, 0);
const cycleId = mintUlid();
const runId = mintUlid();

/** One review published from these batches into a fresh store, at one fixed time and run. */
const publishIn = (batches: ReadonlyArray<SettledBatch>) => {
  const store = scratch({ cycleId });
  return store.run(
    atTime(T)(
      Effect.gen(function* () {
        const ctx = store.ctx({ runId, startedAt: T - 1_000 });
        const summary = yield* publishSettled(
          ctx,
          inputOf(batches, { ending: true }),
        );
        const read = yield* PublishedPackets.readStanding(cycleId);
        return {
          summary,
          keyed: yield* keyedOf(cycleId, ctx.runKey),
          read: read?.kind === "packet.published@2" ? read : undefined,
        };
      }),
    ),
  );
};

const withoutPacket = (keyed: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(keyed).filter(([key]) => !key.includes(":packet:")),
  );

// Why: identity must not follow arrival order. The same review handed in with its units,
// sections, section keys and ranges in another order is the same review, byte for byte; batches
// and comments handed in another order keep every ID, and only the manifest's order follows them.
test("arrival order changes no unit, batch or event ID, and units and sections no manifest byte", async () => {
  const { a, b, c } = threeBatches();
  const reference = await publishIn([a, b, c]);
  const shuffled = await publishIn([reordered(a), reordered(b), reordered(c)]);
  expect(shuffled.summary.manifest).toBe(reference.summary.manifest!);
  expect(shuffled.summary.packetEventId).toBe(reference.summary.packetEventId!);
  expect(shuffled.keyed).toEqual(reference.keyed);

  const moved = await publishIn([
    reordered(c, { comments: true }),
    b,
    reordered(a, { comments: true }),
  ]);
  expect(withoutPacket(moved.keyed)).toEqual(withoutPacket(reference.keyed));
  const idsOf = (read: typeof reference.read) =>
    Object.fromEntries(
      (read?.batches ?? []).flatMap((batch) => [
        [batch.local, batch.batchId],
        ...batch.units.map((unit) => [unit.local, unit.unitId]),
      ]),
    );
  expect(idsOf(moved.read)).toEqual(idsOf(reference.read));
  // The manifest lists batches and comments in the order they were handed in.
  expect(
    moved.read?.batches.map((batch) => batch.recorded?.payload.title),
  ).toEqual(["Lookup table", "Guards", "Retry policy"]);
  const commentsOf = (read: typeof reference.read) =>
    read?.batches
      .find((batch) => batch.recorded?.payload.title === "Retry policy")
      ?.units[0]?.comments.map((comment) => comment.id);
  expect(commentsOf(moved.read)).toEqual(
    [...commentsOf(reference.read)!].reverse(),
  );
});

// Why: two units of one file are different units, and no file is cut at today's 1,024 ranges.
test("two units of one file have their own IDs and titles, and a large file keeps every range", async () => {
  const { a, b, c } = threeBatches();
  const { read } = await publishIn([a, b, c]);
  const [first, second] = read!.batches[0]!.units;
  expect(first!.unitId).not.toBe(second!.unitId);
  expect(first!.local).not.toBe(second!.local);
  expect(first!.recorded?.payload.title).not.toBe(
    second!.recorded?.payload.title,
  );
  // Told apart by their parts, never by their lane.
  expect(first!.recorded?.payload.title).toBe("a.ts: The retry change");
  expect(second!.recorded?.payload.title).toBe("a.ts: The exported change");
  const large = read!.batches[2]!.units[0]!;
  expect(large.recorded?.payload.ownedRanges).toHaveLength(1_100);
  if (large.recorded?.kind === "unit.recorded@3")
    expect(large.recorded.payload.ranges).toEqual({
      count: 1_100,
      lines: 1_100,
    });
});
