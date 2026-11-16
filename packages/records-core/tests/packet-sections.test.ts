// Why (10.109): the desk marks a unit's separate changes from the sections its assembled batch
// holds, read through the published packet. A unit with sections must carry them in order, and a
// unit with none, or with a list the read schema refuses, must read as one change rather than drop
// the unit or fail the packet; the batch's strict decode already discloses the malformed list.
import { afterAll, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import {
  Blobs,
  Computations,
  Log,
  PublishedPackets,
  mintUlid,
} from "../src/index.ts";
import { reviewEvents } from "./review-fixtures.ts";
import {
  agent,
  envelope,
  freshLocation,
  removeTemporaryDirectories,
  runOn,
} from "./support.ts";

afterAll(removeTemporaryDirectories);

const json = (value: unknown) => ({
  bytes: new TextEncoder().encode(JSON.stringify(value)),
  mediaType: "application/json",
});

const lines = (startLine: number, endLine: number) => ({
  kind: "lines" as const,
  hunkId: "h1",
  path: "src/a.ts",
  side: "new" as const,
  startLine,
  endLine,
});

test("a unit's sections read in file order from its assembled batch; none, or a list that doesn't decode, reads as one change", async () => {
  const location = freshLocation();
  const fixture = reviewEvents();
  const [u1, u2, u3] = fixture.units;
  const sections = [
    { id: "b1.s1", title: "The reader", ownedRanges: [lines(1, 2)] },
    { id: "b1.s3", title: "The writer", ownedRanges: [lines(9, 10)] },
  ];
  const assembled = {
    citations: {},
    references: [],
    units: [
      { id: "b1.u1", ownedRanges: [lines(1, 2), lines(9, 10)], sections },
      // ownedRanges missing: the read schema refuses the list
      {
        id: "b1.u2",
        ownedRanges: [lines(5, 30)],
        sections: [{ id: "b1.s2", title: "No lines" }],
      },
      { id: "b1.u3", ownedRanges: [] },
    ],
  };
  const read = await runOn(
    location,
    Effect.gen(function* () {
      const computations = yield* Computations.ComputationStore;
      const blobs = yield* Blobs.BlobStore;
      const stored = yield* computations.run(
        { op: "test.assembled", opVersion: 1, inputs: { test: mintUlid() } },
        Effect.succeed(json(assembled)),
      );
      const manifest = yield* blobs.put({
        ...json({
          batches: [
            {
              batch: "b1",
              batchId: fixture.batchId,
              assembled: `computation:${stored.computation.key}`,
              units: [
                { unit: "b1.u1", unitId: u1 },
                { unit: "b1.u2", unitId: u2 },
                { unit: "b1.u3", unitId: u3 },
              ],
              events: [],
            },
          ],
        }),
        retention: "durable",
      });
      const packet = {
        ...envelope(
          "packet.published@1",
          `review:${fixture.runId}:packet`,
          agent,
          fixture.packet.attribution,
          fixture.packet.payload,
        ),
        refs: [{ ref: `blob:${manifest.blob.hash}`, role: "manifest" }],
      };
      yield* Log.append([...fixture.registrations, ...fixture.structure]);
      yield* Log.append([packet]);
      return yield* PublishedPackets.standingPacket(fixture.cycleId);
    }).pipe(
      Effect.provide(
        Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
      ),
    ),
  );
  const units = read?.batches[0]?.units ?? [];
  expect(units.map((unit) => unit.local)).toEqual(["b1.u1", "b1.u2", "b1.u3"]);
  expect(units[0]?.sections).toEqual(sections);
  expect(units[1]?.sections).toBeUndefined();
  expect(units[2]?.sections).toBeUndefined();
  expect(read?.undecoded.map((u) => u.part)).toContain("assembled-batch");
});
