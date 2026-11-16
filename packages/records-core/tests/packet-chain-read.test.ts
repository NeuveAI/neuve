// Why: the silent failures the impact map and its check found, read over a hand-built new-shape
// cycle beside an old-shape one in the same store: a unit with no lines (over 1,024 ranges, held
// in a blob), an assessment read as none, gaps of an earlier publication shown as current, unit
// citations that resolve to nothing, and an old unit link that reads as unknown. The old readers
// must return nothing for the new shape and exactly what they returned before for the old one.
import { afterAll, expect, test } from "bun:test";
import { Effect } from "effect";
import { UNDECIDED_GAP_PREFIX } from "@neuve/records-schema";
import {
  Blobs,
  Lineage,
  Log,
  PublishedPackets,
  ReviewList,
  ReviewStats,
  canonicalJson,
  mintUlid,
  sha256Hex,
} from "../src/index.ts";
import { contentLayer, storeContent } from "./new-shape-support.ts";
import { newShapeReview, reviewEvents } from "./review-fixtures.ts";
import {
  agent,
  freshLocation,
  headOid,
  removeTemporaryDirectories,
  runOn,
} from "./support.ts";

afterAll(removeTemporaryDirectories);

const range = { baseRef: "refs/heads/main", baseOid: "b".repeat(40), headOid };

/** The old-shape review with a manifest Records holds, naming its batch, units and their events. */
const oldShape = () => {
  const fixture = reviewEvents();
  const events = [...fixture.structure, ...Object.values(fixture.comments)];
  const onUnit = (unitId: string) =>
    events
      .filter((e) =>
        (
          e.attribution as { unitIds?: ReadonlyArray<string> } | undefined
        )?.unitIds?.includes(unitId),
      )
      .map((e) => ({ kind: e.kind, id: e.id }));
  const manifest = canonicalJson({
    batches: [
      {
        batch: "b1",
        batchId: fixture.batchId,
        units: fixture.units.map((unitId, index) => ({
          unit: `b1.u${index + 1}`,
          unitId,
          events: onUnit(unitId),
        })),
        events: [],
      },
    ],
  });
  return { fixture, manifest };
};

/** A store holding both reviews, everything their refs name, and the proof record the checkpoints name. */
const bothShapes = async () => {
  const location = freshLocation();
  const old = oldShape();
  const fixture = newShapeReview({
    earlier: { unitId: old.fixture.units[1], cycleId: old.fixture.cycleId },
  });
  const ids = await runOn(
    location,
    Effect.gen(function* () {
      const blobs = yield* Blobs.BlobStore;
      const held = yield* blobs.put({
        bytes: new TextEncoder().encode(old.manifest),
        mediaType: "application/json",
        retention: "durable",
      });
      const oldPacket = {
        ...old.fixture.packet,
        refs: [{ ref: `blob:${held.blob.hash}`, role: "manifest" }],
      };
      const artefact = new TextEncoder().encode("2 pass\n0 fail\n");
      const stored = yield* blobs.put({
        bytes: artefact,
        mediaType: "text/plain; charset=utf-8",
        retention: "raw-capture",
      });
      yield* storeContent(fixture);
      yield* Log.append([
        ...old.fixture.registrations,
        ...old.fixture.structure,
        ...Object.values(old.fixture.comments),
        oldPacket,
        ...fixture.all.filter((e) => e.kind !== "actor.registered@1"),
        {
          id: fixture.namedProof,
          kind: "proof.recorded@1",
          idempotencyKey: `proof:${fixture.namedProof}`,
          actor: agent,
          occurredAt: "2026-10-19T10:00:00.000Z",
          attribution: { range, sessionId: "session-1" },
          refs: [{ ref: `blob:${stored.blob.hash}`, role: "artefact" }],
          payload: {
            kind: "test-run",
            revision: headOid,
            claim: "The retry test passes.",
            requirement: { text: "The retry loop keeps retrying" },
            artefact: {
              mediaType: "text/plain; charset=utf-8",
              bytes: artefact.byteLength,
            },
            worktree: { head: headOid, scope: "tracked-tree", dirty: false },
          },
        },
      ]);
      return { oldPacket: oldPacket.id };
    }).pipe(Effect.provide(contentLayer(location))),
  );
  return { location, old: old.fixture, fixture, ...ids };
};

test("the standing packet of a new-shape cycle reads whole: every range, joined sections, the impact finding, lineage and resolved unit citations", async () => {
  const { location, fixture } = await bothShapes();
  const packet = await runOn(
    location,
    PublishedPackets.readStanding(fixture.cycleId).pipe(
      Effect.provide(contentLayer(location)),
    ),
  );
  if (packet?.kind !== "packet.published@2")
    throw new Error("expected the second packet of the chain");
  expect(packet).toMatchObject({
    eventId: fixture.events.second.id,
    supersedes: fixture.events.first.id,
    requestedPacket: fixture.events.second.id,
    ordinal: 2,
    complete: true,
    counts: { pending: { batches: 0, sections: 0 }, undecided: { failed: 1 } },
    added: { units: 1, undecided: { failed: 1 } },
    sequence: { ordinal: 2, base: fixture.events.first.id },
  });
  expect(packet.unmatched).toHaveLength(1);
  expect(packet.batches.map((batch) => batch.local)).toEqual(["b1", "b2"]);
  const [large] = packet.batches[0]!.units;
  const [small] = packet.batches[1]!.units;
  if (large === undefined || small === undefined)
    throw new Error("expected both units");

  // Every one of the 1,100 ranges, in path, side and line order, in today's owned-range form.
  if (large.recorded?.kind !== "unit.recorded@3")
    throw new Error("expected a version 3 unit");
  const ranges = large.recorded.payload.ownedRanges;
  expect(ranges).toHaveLength(1_100);
  expect(large.recorded.payload.title).toBe("Large file");
  expect(ranges.filter((r) => r.side === "old")).toHaveLength(550);
  // The old side first, then the new, each by line.
  expect([
    ranges[0],
    (ranges[549] as { startLine?: number } | undefined)?.startLine,
    ranges[550],
  ]).toEqual([
    {
      kind: "lines",
      path: "src/large.ts",
      side: "old",
      startLine: 3,
      endLine: 3,
    },
    2_399,
    {
      kind: "lines",
      path: "src/large.ts",
      side: "new",
      startLine: 1,
      endLine: 1,
    },
  ]);

  // Sections from the blob, each joined with its judgement by key.
  expect(
    large.sections.map((s) => [s.key, s.title, s.ownedRanges.length]),
  ).toEqual([
    [fixture.sectionKeys.k1, "The retry loop", 600],
    [fixture.sectionKeys.k2, "The exported entry point", 500],
  ]);
  expect(large.sections[0]).toMatchObject({
    parts: { kind: "function", name: "retry", future: "kept" },
    where: { startLine: 1, endLine: 1_300 },
    renamedFrom: null,
    lane: { applied: "human-suggested", floors: [] },
    assess: { complexity: { level: "high" } },
    review: { verdict: "approve" },
    lineage: "fresh",
    impact: [{ effect: "narrowed" }],
  });
  expect(large.sections[1]).toMatchObject({
    renamedFrom: "src/old-large.ts",
    lane: {
      judged: "static-automation",
      surfaced: "human-suggested",
      floors: [],
      applied: "human-suggested",
    },
  });
  // Round 3: a section's own content is joined as the blob holds it, and a section whose blob
  // entry has none has no content key, so the desk never guesses a briefing from titles. The side
  // its lines are on reads where the blob gives it, and a blob entry written before it still reads.
  expect(large.sections[0]?.content).toEqual({
    facts: { text: "The retry loop stops sooner.", cites: ["p1.e3"] },
    briefed: "The [retry loop](u.large) now gives up after two attempts.",
    explained: {
      before: "It retried five times.",
      after: "It retries twice.",
      terms: [],
      cites: ["p1.e3"],
    },
  });
  expect("content" in large.sections[1]!).toBe(false);
  // What the floors read is returned unchanged, so the lanes eval can run them again.
  expect(large.sections[0]?.floorInputs).toEqual({
    facts: {
      removesDeclaration: false,
      removesPublicName: false,
      effects: ["narrowed"],
    },
    options: { removal: false },
  });
  expect(large.sections[1]?.floorInputs).toEqual({
    facts: { removesDeclaration: false, removesPublicName: false, effects: [] },
    options: { removal: false },
  });
  // A section the map excluded is not one of these units'; its key is absent on each.
  for (const section of large.sections)
    expect("excluded" in section).toBe(false);
  expect(large.sections[0]?.parts.side).toBe("new");
  expect("side" in large.sections[1]!.parts).toBe(false);
  expect(large.assessment).toMatchObject({
    kind: "assessment.recorded@4",
    payload: { lane: "human-suggested", sections: { count: 2, raised: 1 } },
  });
  expect(large.judgement).toMatchObject({
    lane: "human-suggested",
    assessed: true,
  });
  expect(large.comments.map((c) => [c.kind, c.id])).toEqual([
    ["comment.recorded@3", fixture.events.impact.id],
  ]);
  expect(large.lineage?.id).toBe(fixture.events.lineage.id);
  // A section's own Briefed's links cite as the unit's Briefed stop: it links u.large. Its
  // Explained's cites list (p1.e3) stays the section's.
  expect(large.citations.cited).toEqual([
    {
      id: "u.large",
      stops: ["facts", "briefed"],
      resolution: {
        kind: "unit",
        local: "b1.u1",
        unitId: fixture.units.large,
        eventId: fixture.events.units.large.id,
      },
      unresolved: undefined,
      detail: undefined,
    },
  ]);

  // The section no agent decided keeps its cause, and the unit its human-required lane.
  expect(small.sections).toHaveLength(1);
  expect(small.sections[0]).toMatchObject({
    parts: { side: "none" },
    where: null,
    assess: null,
    undecided: { cause: "failed", reading: "assess" },
    lane: { applied: "human-required" },
  });
  expect("content" in small.sections[0]!).toBe(false);
  // Round 3: the unit's one not-decided gap is returned attributed to that unit, with its kind
  // the shared prefix and the cause, by which readers hide it from a person.
  const undecided = packet.gaps.filter((gap) =>
    gap.payload.kind.startsWith(UNDECIDED_GAP_PREFIX),
  );
  expect(
    undecided.map((gap) => [gap.id, gap.payload.kind, gap.attribution.unitIds]),
  ).toEqual([
    [
      fixture.events.gaps.second.id,
      `${UNDECIDED_GAP_PREFIX}failed`,
      [fixture.units.small],
    ],
  ]);
  expect(small.judgement).toMatchObject({
    lane: "human-required",
    needs: "a-human-disposition",
  });
  expect(small.lineage).toBeUndefined();
});

test("each packet's gaps are its manifest's, and a gap Records does not hold is disclosed", async () => {
  const { location, fixture } = await bothShapes();
  const read = await runOn(
    location,
    Effect.gen(function* () {
      return {
        second: yield* PublishedPackets.readStanding(fixture.cycleId),
        first: yield* PublishedPackets.readExact(fixture.events.first.id),
      };
    }).pipe(Effect.provide(contentLayer(location))),
  );
  const { gaps } = fixture.events;
  expect(read.second?.gaps.map((gap) => gap.id)).toEqual([
    gaps.second.id,
    gaps.batch.id,
  ]);
  expect(read.second?.undecoded).toEqual([
    {
      what: `gap ${fixture.notHeld} named by the manifest`,
      ref: `event:${fixture.notHeld}`,
      issue: "Records holds no gap with this ID",
      part: "gap",
    },
  ]);
  if (read.second?.kind !== "packet.published@2")
    throw new Error("expected version 2");
  expect(read.second.batches.map((b) => b.gaps.map((g) => g.id))).toEqual([
    [gaps.batch.id],
    [],
  ]);
  // The first publication, read exactly, keeps its own gaps and its one batch.
  expect(read.first).toMatchObject({
    kind: "packet.published@2",
    eventId: fixture.events.first.id,
    ordinal: 1,
    complete: false,
    undecoded: [],
  });
  expect(read.first?.gaps.map((gap) => gap.id)).toEqual([
    gaps.firstOnly.id,
    gaps.batch.id,
  ]);
  expect(read.first?.batches).toHaveLength(1);
});

test("a run's own packet is its newest; the version 1 readers read nothing of the new shape and the old shape exactly as before", async () => {
  const { location, fixture, old, oldPacket } = await bothShapes();
  const read = await runOn(
    location,
    Effect.gen(function* () {
      return {
        run: yield* PublishedPackets.readRun(fixture.runId),
        standing: yield* PublishedPackets.standingPacket(fixture.cycleId),
        exactSecond: yield* PublishedPackets.exactPacket(
          fixture.events.second.id,
        ),
        exactFirst: yield* PublishedPackets.exactPacket(
          fixture.events.first.id,
        ),
        runOld: yield* PublishedPackets.runPacket(fixture.runId),
        oldStanding: yield* PublishedPackets.standingPacket(old.cycleId),
        oldExact: yield* PublishedPackets.exactPacket(oldPacket),
        oldRun: yield* PublishedPackets.runPacket(old.runId),
        newStandingOld: yield* PublishedPackets.readStanding(old.cycleId),
        newExactOld: yield* PublishedPackets.readExact(oldPacket),
        newRunOld: yield* PublishedPackets.readRun(old.runId),
        manifest: yield* PublishedPackets.standingManifest(fixture.cycleId),
        units: yield* PublishedPackets.standingUnits(fixture.cycleId),
        newest: yield* PublishedPackets.newestPacketCycle,
      };
    }).pipe(Effect.provide(contentLayer(location))),
  );
  expect(read.run).toMatchObject({
    kind: "packet.published@2",
    eventId: fixture.events.second.id,
    requestedPacket: fixture.events.second.id,
  });
  expect(read.standing).toBeUndefined();
  expect(read.exactSecond).toBeUndefined();
  expect(read.exactFirst).toBeUndefined();
  expect(read.runOld).toBeUndefined();
  expect(read.oldStanding?.eventId).toBe(oldPacket);
  expect(read.oldStanding?.batches[0]?.units).toHaveLength(3);
  expect(read.newStandingOld).toEqual({
    kind: "packet.published@1",
    ...read.oldStanding!,
  });
  expect(read.newExactOld).toEqual({
    kind: "packet.published@1",
    ...read.oldExact!,
  });
  expect(read.newRunOld).toEqual({
    kind: "packet.published@1",
    ...read.oldRun!,
  });
  // The packet of record is the newest of either kind: the chain's second packet.
  expect(read.manifest?.packetId).toBe(fixture.events.second.id);
  expect(read.units).toEqual([fixture.units.large, fixture.units.small]);
  expect(read.newest).toBe(fixture.cycleId);
});

test("checkpoints come from each section's requirements with their line anchors and a state set by code", async () => {
  const { location, fixture } = await bothShapes();
  const packet = await runOn(
    location,
    PublishedPackets.readStanding(fixture.cycleId).pipe(
      Effect.provide(contentLayer(location)),
    ),
  );
  if (packet?.kind !== "packet.published@2")
    throw new Error("expected version 2");
  const large = packet.batches[0]!.units[0]!;
  expect(large.checkpoints).toHaveLength(2);
  // The rule saw `proven`; read now, with no repository to check currency, the record is Out of date.
  expect(large.checkpoints[0]).toEqual({
    number: 1,
    section: fixture.sectionKeys.k1,
    requirement: `The ${fixture.sectionKeys.k1.slice(0, 4)} change keeps retrying.`,
    proof: "out-of-date",
    note: "Out of date: whether a proof record it rests on is still current couldn't be checked.",
    kinds: ["test-run", "log"],
    records: [
      {
        eventId: fixture.namedProof,
        kind: "test-run",
        held: true,
        currency: { status: "unchecked" },
      },
    ],
    anchors: [{ path: "src/large.ts", side: "new", startLine: 3, endLine: 5 }],
    sources: [],
    cites: ["p1.e4"],
  });
  expect(large.checkpoints[1]).toMatchObject({
    number: 2,
    section: fixture.sectionKeys.k2,
    anchors: [
      { path: "src/large.ts", side: "new", startLine: 1_401, endLine: 1_403 },
    ],
  });
  expect(large.proofCurrency).toEqual({
    [fixture.namedProof]: { status: "unchecked" },
  });
  // A section no agent assessed contributes none.
  expect(packet.batches[1]!.units[0]!.checkpoints).toEqual([]);
});

test("stats read the new-shape cycle's pending and undecided counts, its manifest's gaps and its sections' 10.55 case", async () => {
  const { location, fixture, old } = await bothShapes();
  const read = await runOn(
    location,
    Effect.gen(function* () {
      return {
        cycle: yield* ReviewStats.reviewStats({ cycleId: fixture.cycleId }),
        old: yield* ReviewStats.reviewStats({ cycleId: old.cycleId }),
        store: yield* ReviewStats.reviewStats(),
      };
    }).pipe(Effect.provide(contentLayer(location))),
  );
  expect(read.cycle.pending).toEqual({ batches: 0, sections: 0 });
  expect(read.cycle.undecided).toEqual({ failed: 1 });
  expect(read.cycle.unread).toBeUndefined();
  expect(read.cycle.gaps).toEqual([
    { kind: "scope-missing", stage: null, gaps: 1 },
    { kind: "undecided-failed", stage: null, gaps: 1 },
  ]);
  expect(read.cycle.highComplexityValidationGapHumanSuggested).toBe(1);
  expect(read.cycle.proofs.coverage).toEqual([
    { coverage: "solid", requirements: 2 },
  ]);
  expect(read.cycle.lanes).toEqual([
    { batchId: fixture.batches[0], lane: "human-suggested", units: 1 },
    { batchId: fixture.batches[1], lane: "human-required", units: 1 },
  ]);
  // An old-shape cycle gains none of the new fields.
  expect(read.old.pending).toBeUndefined();
  expect(read.old.undecided).toBeUndefined();
  expect(read.store.undecided).toEqual({ failed: 1 });
  // Without a blob store the manifest and the judgements cannot be read, and the stats say so.
  const bare = await runOn(
    location,
    ReviewStats.reviewStats({ cycleId: fixture.cycleId }),
  );
  expect(bare.unread).toEqual({ manifests: 1, judgements: 2 });
  expect(bare.pending).toEqual({ batches: 0, sections: 0 });
});

test("an earlier unit resolves to the unit that now holds its sections", async () => {
  const { location, fixture, old } = await bothShapes();
  const read = await runOn(
    location,
    Effect.gen(function* () {
      return {
        earlier: yield* Lineage.successors(old.units[1]),
        itself: yield* Lineage.successors(fixture.units.large),
        unknown: yield* Lineage.successors(mintUlid()),
      };
    }),
  );
  expect(read.earlier).toEqual([
    {
      unitId: fixture.units.large,
      cycleId: fixture.cycleId,
      relation: "changed",
      eventId: fixture.events.lineage.id,
    },
  ]);
  expect(read.itself).toEqual([]);
  expect(read.unknown).toEqual([]);
});

test("the review list gives a new-shape review's pending counts from its packet of record, and 0 for a cycle with no such packet", async () => {
  const location = freshLocation();
  const old = oldShape();
  const fixture = newShapeReview();
  const request = (cycleId: string) => ({
    id: mintUlid(),
    kind: "review.requested@1",
    idempotencyKey: `request:${mintUlid()}`,
    actor: agent,
    occurredAt: "2026-11-12T10:00:00.000Z",
    attribution: { cycleId, range },
    payload: {
      runKey: sha256Hex(`request:${cycleId}`),
      generation: 0,
      pipeline: { version: 10, config: {} },
    },
  });
  const listed = await runOn(
    location,
    Effect.gen(function* () {
      yield* storeContent(fixture);
      // Only the first publication: its packet of record still has a batch being judged.
      yield* Log.append([
        ...old.fixture.registrations,
        ...old.fixture.structure,
        request(old.fixture.cycleId),
        ...fixture.all.filter(
          (e) =>
            e.kind !== "actor.registered@1" &&
            e.id !== fixture.events.second.id,
        ),
        request(fixture.cycleId),
      ]);
      return yield* ReviewList.reviews({ limit: 10 });
    }).pipe(Effect.provide(contentLayer(location))),
  );
  const byCycle = new Map(listed.reviews.map((r) => [r.cycleId, r]));
  expect(byCycle.get(fixture.cycleId)).toMatchObject({
    pendingBatches: 1,
    pendingSections: 1,
  });
  expect(byCycle.get(fixture.cycleId)?.batches.map((b) => b.batchId)).toEqual([
    fixture.batches[0],
  ]);
  expect(byCycle.get(old.fixture.cycleId)).toMatchObject({
    pendingBatches: 0,
    pendingSections: 0,
  });
});
