import { PacketPublished } from "@neuve/records-schema";
// A review card must keep its own packet counts and decoding gaps after its cycle publishes another run.
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
import { freshLocation, removeTemporaryDirectories, runOn } from "./support.ts";

afterAll(removeTemporaryDirectories);

test("exact packet reads retain the original counts and undecoded content after supersession", async () => {
  const location = freshLocation();
  const fixture = reviewEvents();
  const read = await runOn(
    location,
    Effect.gen(function* () {
      const blobs = yield* Blobs.BlobStore;
      const original = yield* blobs.put({
        bytes: new TextEncoder().encode("{}"),
        mediaType: "application/json",
        retention: "durable",
      });
      const newer = yield* blobs.put({
        bytes: new TextEncoder().encode('{"batches":[]}'),
        mediaType: "application/json",
        retention: "durable",
      });
      const packet = PacketPublished.parse({
        ...fixture.packet,
        refs: [{ ref: `blob:${original.blob.hash}`, role: "manifest" }],
      });
      const replacement = {
        ...packet,
        id: mintUlid(),
        idempotencyKey: `replacement:${fixture.runId}`,
        causation: { supersedes: packet.id },
        attribution: { ...packet.attribution, runId: mintUlid() },
        payload: {
          ...packet.payload,
          counts: { ...packet.payload.counts, units: 9 },
        },
        refs: [{ ref: `blob:${newer.blob.hash}`, role: "manifest" }],
      };
      yield* Log.append([
        ...fixture.registrations,
        ...fixture.structure,
        packet,
        replacement,
      ]);
      return {
        original: yield* PublishedPackets.exactPacket(packet.id),
        current: yield* PublishedPackets.runPacket(fixture.runId),
        missing: yield* PublishedPackets.exactPacket(mintUlid()),
        otherKind: yield* PublishedPackets.exactPacket(
          fixture.structure[0]!.id,
        ),
        packet: packet.id,
        replacement: replacement.id,
      };
    }).pipe(
      Effect.provide(
        Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
      ),
    ),
  );
  expect(read.original).toMatchObject({
    eventId: read.packet,
    requestedPacket: read.packet,
    counts: { units: 3 },
  });
  expect(read.original?.undecoded.map((value) => value.part)).toEqual([
    "manifest",
  ]);
  expect(read.current).toMatchObject({
    eventId: read.replacement,
    requestedPacket: read.packet,
    counts: { units: 9 },
    undecoded: [],
  });
  expect(read.missing).toBeUndefined();
  expect(read.otherKind).toBeUndefined();
});

// Packet manifests and immutable computation outputs can come from a newer publisher.
test("newer packet, assembled-batch and Dispose fields read through the packet and retain their stored bytes", async () => {
  const { AssembledBatch } = await import("@neuve/records-schema");
  const location = freshLocation();
  const fixture = reviewEvents();
  const base = AssembledBatch.parse({
    candidate: "candidate",
    confirmation: {
      decision: "confirm",
      reason: "fixture",
      source: "code",
      changes: [],
    },
    batches: [],
    units: [],
    references: [],
    proofs: [],
    pins: [],
    citations: {},
    counts: {
      at10: 0,
      at20: 0,
      at40: 0,
      defaultUnits: 0,
      units: 0,
      merges: 0,
      splits: 0,
      lanes: {},
      highComplexityValidationGap: 0,
      coverage: { missing: 0, shallow: 0, solid: 0 },
      checkpoints: {
        missing: 0,
        outOfDate: 0,
        conflicting: 0,
        proven: 0,
        thin: 0,
        wholeUnit: 0,
      },
      notAssessed: 0,
      uncited: 0,
      verdictWords: 0,
      laneWords: 0,
    },
    turns: {
      limit: 1,
      confirm: 0,
      groups: 0,
      groupTurns: 1,
      digests: 0,
      digestTurns: 1,
      overrun: false,
    },
    gaps: [],
  });
  const assembled = {
    ...base,
    future: true,
    counts: { ...base.counts, future: true },
    citations: {
      newer: { kind: "unit", ref: null, entry: "b1.u1", future: true },
    },
  };
  const dispose = {
    future: true,
    citations: {
      another: { kind: "unit", ref: null, entry: "b1.u1", future: true },
    },
  };
  const bytes = (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value));
  const read = await runOn(
    location,
    Effect.gen(function* () {
      const store = yield* Computations.ComputationStore;
      const blobs = yield* Blobs.BlobStore;
      const put = (op: string, value: unknown) =>
        store.run(
          { op, opVersion: 1, inputs: { test: mintUlid() } },
          Effect.succeed({
            bytes: bytes(value),
            mediaType: "application/json",
          }),
        );
      const stored = yield* put("test.newer-assembled", assembled);
      const reviewed = yield* put("test.newer-dispose", dispose);
      const manifest = {
        future: true,
        batches: [
          {
            batch: "b1",
            batchId: fixture.batchId,
            future: true,
            assembled: `computation:${stored.computation.key}`,
            units: fixture.units.map((unitId, index) => ({
              unit: `b1.u${index + 1}`,
              unitId,
              dispose: reviewed.computation.key,
              future: true,
            })),
            events: [],
          },
        ],
      };
      const held = yield* blobs.put({
        bytes: bytes(manifest),
        mediaType: "application/json",
        retention: "durable",
      });
      const packet = PacketPublished.parse({
        ...fixture.packet,
        refs: [{ ref: `blob:${held.blob.hash}`, role: "manifest" }],
      });
      yield* Log.append([
        ...fixture.registrations,
        ...fixture.structure,
        packet,
      ]);
      const result = yield* PublishedPackets.exactPacket(packet.id);
      const immutable = [];
      for (const [hash, original] of [
        [held.blob.hash, manifest],
        [stored.computation.outputHash, assembled],
        [reviewed.computation.outputHash, dispose],
      ] as const) {
        const after = yield* blobs.get(hash);
        immutable.push(
          after._tag === "Present" &&
            new TextDecoder().decode(after.bytes) === JSON.stringify(original),
        );
      }
      return { result, immutable };
    }).pipe(
      Effect.provide(
        Computations.layer.pipe(Layer.provideMerge(Blobs.layer(location))),
      ),
    ),
  );
  expect(read.result?.undecoded).toEqual([]);
  expect(read.result?.batches[0]?.units).toHaveLength(3);
  expect(read.immutable).toEqual([true, true, true]);
});
