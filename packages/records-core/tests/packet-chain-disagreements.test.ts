// Why (round 2): stored records that disagree with themselves or with each other must never be
// read without a word. A sections blob that repeats a key, a payload whose counts contradict its
// blob, a range whose end precedes its start, and a judgements body that repeats a key are each
// disclosed with the unit still listed and its lane kept; two recordings of one unit read as the
// newest, as the projection takes it; a cause named like an object's own property counts as
// itself; and a successor reached by two lineage events is listed once.
import { afterAll, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  Computations,
  Lineage,
  Log,
  PublishedPackets,
  ReviewStats,
  canonicalJson,
  mintUlid,
  sha256Hex,
} from "../src/index.ts";
import { contentLayer, storeContent } from "./new-shape-support.ts";
import {
  newShapeReview,
  type StoredComputation,
  type StoredContent,
} from "./review-fixtures.ts";
import {
  agent,
  envelope,
  freshLocation,
  removeTemporaryDirectories,
  runOn,
} from "./support.ts";

afterAll(removeTemporaryDirectories);

type Fixture = ReturnType<typeof newShapeReview>;
type Event = Fixture["all"][number];

const blobText = (fixture: Fixture, label: string) =>
  fixture.blobs.find((blob) => blob.label === label)!.text;
const computationText = (fixture: Fixture, label: string) =>
  fixture.computations.find((c) => c.label === label)!.text;

/** A blob to store beside the fixture's, and the ref that names it. */
const extraBlob = (label: string, value: unknown) => {
  const text = canonicalJson(value);
  return {
    blob: { label, text } satisfies StoredContent,
    ref: `blob:${sha256Hex(text)}`,
  };
};

/** A computation to store beside the fixture's, and the ref that names it. */
const extraComputation = (label: string, value: unknown) => {
  const spec = {
    op: "test.new-shape",
    opVersion: 1,
    inputs: { label: `${label}:${mintUlid()}` },
  };
  return {
    computation: {
      label,
      text: canonicalJson(value),
      spec,
    } satisfies StoredComputation,
    ref: `computation:${Computations.computationKey(spec).key}`,
  };
};

/**
 * Stores the fixture with some events replaced in place (same ID, so the manifests still name
 * them) and others added, with the extra content they reference, and reads what the test asks.
 */
const readVariant = async <A>(
  fixture: Fixture,
  change: {
    readonly replace?: ReadonlyArray<Event>;
    readonly add?: ReadonlyArray<unknown>;
    readonly blobs?: ReadonlyArray<StoredContent>;
    readonly computations?: ReadonlyArray<StoredComputation>;
  },
  read: Effect.Effect<A, unknown, never>,
) => {
  const location = freshLocation();
  const replaced = new Map((change.replace ?? []).map((e) => [e.id, e]));
  return runOn(
    location,
    Effect.gen(function* () {
      yield* storeContent({
        blobs: [...fixture.blobs, ...(change.blobs ?? [])],
        computations: [...fixture.computations, ...(change.computations ?? [])],
      });
      yield* Log.append([
        ...fixture.all.map((e) => replaced.get(e.id) ?? e),
        ...(change.add ?? []),
      ]);
      return yield* read;
    }).pipe(Effect.provide(contentLayer(location))),
  );
};

const standing = (fixture: Fixture) =>
  Effect.gen(function* () {
    const packet = yield* PublishedPackets.readStanding(fixture.cycleId);
    if (packet?.kind !== "packet.published@2")
      throw new Error("expected version 2");
    return {
      large: packet.batches[0]!.units[0]!,
      undecoded: packet.undecoded.filter((item) => item.part !== "gap"),
    };
  }) as unknown as Effect.Effect<
    {
      readonly large: PublishedPackets.ReadUnit;
      readonly undecoded: ReadonlyArray<PublishedPackets.ReadUndecoded>;
    },
    unknown,
    never
  >;

const largeSections = (fixture: Fixture) =>
  JSON.parse(blobText(fixture, "sections:Large file")) as {
    sections: Array<{
      key: string;
      ownedRanges: Array<Record<string, unknown>>;
    }>;
  };

const withRef = (event: Event, ref: string, role: string) =>
  ({ ...event, refs: [{ ref, role }] }) as unknown as Event;

test("a sections blob that repeats a key keeps every range and says so", async () => {
  const fixture = newShapeReview();
  const blob = largeSections(fixture);
  blob.sections[1]!.key = blob.sections[0]!.key;
  const extra = extraBlob("sections:repeated", blob);
  const read = await readVariant(
    fixture,
    {
      replace: [withRef(fixture.events.units.large, extra.ref, "sections")],
      blobs: [extra.blob],
    },
    standing(fixture),
  );
  expect(read.large.recorded?.payload.ownedRanges).toHaveLength(1_100);
  expect(read.undecoded).toContainEqual({
    what: "sections of b1.u1",
    ref: extra.ref,
    issue: "the sections blob repeats 1 section key",
    part: "unit-sections",
    batch: "b1",
    unit: "b1.u1",
  });
  expect(read.large.judgement.lane).toBe("human-suggested");
});

test("a payload whose counts contradict its blob keeps the blob's ranges and says each disagreement", async () => {
  const fixture = newShapeReview();
  const unit = fixture.events.units.large;
  const payload = unit.payload as Record<string, unknown>;
  const read = await readVariant(
    fixture,
    {
      replace: [
        {
          ...unit,
          payload: {
            ...payload,
            sections: { count: 3 },
            ranges: { count: 1_000, lines: 5 },
          },
        } as unknown as Event,
      ],
    },
    standing(fixture),
  );
  expect(read.large.recorded?.payload.ownedRanges).toHaveLength(1_100);
  expect(
    read.undecoded
      .filter((item) => item.part === "unit-sections")
      .map((item) => item.issue),
  ).toEqual([
    "the unit counts 3 sections; its blob holds 2",
    "the unit counts 1000 ranges; its blob holds 1100",
    "the unit counts 5 lines; its blob's ranges cover 1100",
  ]);
  expect(read.large.judgement.lane).toBe("human-suggested");
});

test("a range whose end precedes its start makes the blob unreadable, never a wrong range", async () => {
  const fixture = newShapeReview();
  const blob = largeSections(fixture);
  blob.sections[0]!.ownedRanges[0] = {
    kind: "lines",
    path: "src/large.ts",
    side: "new",
    startLine: 9,
    endLine: 3,
  };
  const extra = extraBlob("sections:backwards", blob);
  const read = await readVariant(
    fixture,
    {
      replace: [withRef(fixture.events.units.large, extra.ref, "sections")],
      blobs: [extra.blob],
    },
    standing(fixture),
  );
  expect(read.large.recorded?.payload.ownedRanges).toEqual([]);
  const said = read.undecoded.find((item) => item.part === "unit-sections");
  expect(said).toMatchObject({ ref: extra.ref, unit: "b1.u1" });
  expect(said?.issue).toContain("sections.0.ownedRanges.0");
  expect(said?.issue).toContain("endLine precedes startLine");
  expect(read.large.assessment?.payload.lane).toBe("human-suggested");
  expect(read.large.judgement.lane).toBe("human-suggested");
});

test("a judgements body that repeats a key keeps the first entry and says so", async () => {
  const fixture = newShapeReview();
  const body = JSON.parse(computationText(fixture, "judgements:large")) as {
    sections: Array<Record<string, unknown>>;
  };
  const repeated = {
    ...body,
    sections: [
      body.sections[0]!,
      { ...body.sections[0]!, lineage: "carried" },
      body.sections[1]!,
    ],
  };
  const extra = extraComputation("judgements:repeated", repeated);
  const read = await readVariant(
    fixture,
    {
      replace: [
        withRef(fixture.events.assessments.large, extra.ref, "judgements"),
      ],
      computations: [extra.computation],
    },
    standing(fixture),
  );
  expect(read.undecoded).toEqual([
    {
      what: "judgement 2 of b1.u1",
      ref: extra.ref,
      issue:
        "repeats the key of an earlier judgement of the unit, so it is left out",
      part: "judgements",
      batch: "b1",
      unit: "b1.u1",
      section: fixture.sectionKeys.k1,
    },
  ]);
  expect(read.large.sections.map((s) => s.lineage)).toEqual(["fresh", "fresh"]);
  expect(read.large.judgement.lane).toBe("human-suggested");
});

test("a manifest naming two recordings of a unit reads the newest, as the projection does", async () => {
  const fixture = newShapeReview();
  const unit = fixture.events.units.large;
  const again = {
    ...unit,
    id: mintUlid(),
    idempotencyKey: `unit:${fixture.units.large}:again`,
    payload: { ...(unit.payload as object), title: "Large file, again" },
  };
  // The second packet's manifest lists the newer recording after the first.
  const manifest = JSON.parse(blobText(fixture, "manifest:2")) as {
    batches: Array<{ units: Array<{ events: Array<unknown> }> }>;
  };
  manifest.batches[0]!.units[0]!.events.push({
    kind: again.kind,
    id: again.id,
  });
  const extra = extraBlob("manifest:2:again", manifest);
  const read = await readVariant(
    fixture,
    {
      replace: [withRef(fixture.events.second, extra.ref, "manifest")],
      add: [again],
      blobs: [extra.blob],
    },
    standing(fixture),
  );
  expect(read.large.recorded?.id).toBe(again.id);
  expect(read.large.recorded?.payload.title).toBe("Large file, again");
  expect(read.large.citations.cited[0]?.resolution).toMatchObject({
    kind: "unit",
    eventId: again.id,
  });
  expect(read.undecoded).toEqual([]);
});

test("a cause named like an object's own property counts as itself", async () => {
  const fixture = newShapeReview();
  const second = fixture.events.second;
  const payload = second.payload as {
    counts: Record<string, unknown>;
    added: Record<string, unknown>;
  };
  const read = await readVariant(
    fixture,
    {
      replace: [
        {
          ...second,
          payload: {
            ...payload,
            counts: { ...payload.counts, undecided: { constructor: 1 } },
            added: { ...payload.added, undecided: { constructor: 1 } },
          },
        } as unknown as Event,
      ],
    },
    ReviewStats.reviewStats({ cycleId: fixture.cycleId }) as Effect.Effect<
      ReviewStats.ReviewStats,
      unknown,
      never
    >,
  );
  expect(read.undecided).toEqual({ constructor: 1 });
});

test("a successor two lineage events name is listed once, from the newest", async () => {
  const fixture = newShapeReview();
  const { earlier } = fixture;
  const again = envelope(
    "lineage.recorded@1",
    `lineage:${fixture.units.large}:again`,
    agent,
    {
      cycleId: fixture.cycleId,
      unitIds: [fixture.units.large, earlier.unitId],
    },
    {
      from: [
        {
          unitId: earlier.unitId,
          cycleId: earlier.cycleId,
          relation: "unchanged",
          unchanged: 2,
          changed: 0,
          lane: "agentic",
        },
      ],
    },
  );
  const read = await readVariant(
    fixture,
    { add: [again] },
    Lineage.successors(earlier.unitId) as unknown as Effect.Effect<
      ReadonlyArray<Lineage.Successor>,
      unknown,
      never
    >,
  );
  expect(read).toEqual([
    {
      unitId: fixture.units.large,
      cycleId: fixture.cycleId,
      relation: "unchanged",
      eventId: again.id,
    },
  ]);
});
