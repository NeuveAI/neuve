// Why: a lane must never become unexplained without a word. A unit whose sections blob is
// missing, a judgement body that is missing, a body whose section keys do not match the blob's,
// and an undecided cause that is not a cause name are each disclosed in `undecoded`, never thrown,
// and the unit is still listed with its recorded lane.
import { afterAll, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  Log,
  PublishedPackets,
  ReviewStats,
  UnitRanges,
} from "../src/index.ts";
import { contentLayer, storeContent } from "./new-shape-support.ts";
import { newShapeReview } from "./review-fixtures.ts";
import { freshLocation, removeTemporaryDirectories, runOn } from "./support.ts";

afterAll(removeTemporaryDirectories);

/** Stores a new-shape review without the content labelled in `skip`, and reads its standing packet. */
const readWith = async (
  fixture: ReturnType<typeof newShapeReview>,
  skip: ReadonlyArray<string> = [],
) => {
  const location = freshLocation();
  return runOn(
    location,
    Effect.gen(function* () {
      yield* storeContent(fixture, skip);
      yield* Log.append(fixture.all);
      const packet = yield* PublishedPackets.readStanding(fixture.cycleId);
      if (packet?.kind !== "packet.published@2")
        throw new Error("expected version 2");
      const ranges = yield* UnitRanges.unitRanges(
        fixture.events.units.large as never,
      );
      return {
        packet,
        stats: yield* ReviewStats.reviewStats({ cycleId: fixture.cycleId }),
        large: packet.batches[0]!.units[0]!,
        small: packet.batches[1]!.units[0]!,
        // The manifest's gap Records does not hold is disclosed in every case; set it aside.
        undecoded: packet.undecoded.filter((item) => item.part !== "gap"),
        ranges,
      };
    }).pipe(Effect.provide(contentLayer(location))),
  );
};

test("a missing sections blob leaves the unit listed with its lane and no lines, and says so", async () => {
  const fixture = newShapeReview();
  const read = await readWith(fixture, ["sections:Large file"]);
  expect(read.undecoded).toEqual([
    {
      what: "sections of b1.u1",
      ref: fixture.events.units.large.refs[0]!.ref,
      issue: "the sections blob is not in this store",
      part: "unit-sections",
      batch: "b1",
      unit: "b1.u1",
    },
    // Fixes: with no section to join them to, the unit's judgements give no checkpoint, and that
    // is said, so nothing is shown on lines nobody can check.
    {
      what: "judgements of b1.u1",
      ref: fixture.events.assessments.large.refs[0]!.ref,
      issue:
        "none of its 2 judgements can be joined to a section, since the unit's sections could not be read, so they give no checkpoints",
      part: "judgements",
      batch: "b1",
      unit: "b1.u1",
    },
  ]);
  expect(read.large.checkpoints).toEqual([]);
  // The stats leave the unit's judgements out the same way, and count the unit as unread.
  expect(read.stats.highComplexityValidationGapHumanSuggested).toBe(0);
  expect(read.stats.proofs.coverage).toEqual([]);
  expect(read.stats.unread).toEqual({
    manifests: 0,
    judgements: 0,
    sections: 1,
  });
  expect(read.ranges).toMatchObject({ _tag: "Unreadable", reason: "missing" });
  expect(read.large.recorded?.payload.ownedRanges).toEqual([]);
  expect(read.large.sections).toEqual([]);
  expect(read.large.assessment?.payload.lane).toBe("human-suggested");
  expect(read.large.judgement.lane).toBe("human-suggested");
});

test("a missing judgement body leaves the sections without judgements and the unit with its lane, and says so", async () => {
  const fixture = newShapeReview();
  const read = await readWith(fixture, ["judgements:large"]);
  expect(read.undecoded).toEqual([
    {
      what: "judgements of b1.u1",
      ref: fixture.events.assessments.large.refs[0]!.ref,
      issue: "not held in this store",
      part: "judgements",
      batch: "b1",
      unit: "b1.u1",
    },
  ]);
  expect(read.large.sections.map((s) => [s.key, s.lane])).toEqual([
    [fixture.sectionKeys.k1, undefined],
    [fixture.sectionKeys.k2, undefined],
  ]);
  expect(read.large.checkpoints).toEqual([]);
  expect(read.large.judgement.lane).toBe("human-suggested");
});

test("a body whose section keys do not match the blob's joins what matches and says what does not", async () => {
  const fixture = newShapeReview({ mismatch: true });
  const read = await readWith(fixture);
  expect(read.undecoded).toEqual([
    {
      what: "judgements of b1.u1",
      ref: fixture.events.assessments.large.refs[0]!.ref,
      issue:
        "1 of its 2 sections have no judgement, and 1 judgements name no section of the unit",
      part: "judgements",
      batch: "b1",
      unit: "b1.u1",
    },
  ]);
  expect(read.large.sections.map((s) => [s.key, s.lane?.applied])).toEqual([
    [fixture.sectionKeys.k1, "human-suggested"],
    [fixture.sectionKeys.k2, undefined],
  ]);
  expect(read.large.judgement.lane).toBe("human-suggested");
  // Fixes: the stray judgement gives no checkpoint, and the stats neither count its requirement
  // nor stay silent about leaving it out.
  expect(
    read.large.checkpoints.map((c) => ("section" in c ? c.section : undefined)),
  ).toEqual([fixture.sectionKeys.k1]);
  expect(read.stats.highComplexityValidationGapHumanSuggested).toBe(1);
  expect(read.stats.proofs.coverage).toEqual([
    { coverage: "solid", requirements: 1 },
  ]);
  expect(read.stats.unread).toEqual({ manifests: 0, judgements: 0, stray: 1 });
});

// Why: the packet read discloses each judgement entry that does not decode, and the stats used to
// skip it and say everything read. An entry with a lane a newer build writes reaches this with no
// corruption, so each such entry is counted in the stats' `unread`.
test("a judgement entry that does not decode is disclosed by the packet read and counted unread by the stats", async () => {
  const baseline = await readWith(newShapeReview());
  expect(baseline.stats.highComplexityValidationGapHumanSuggested).toBe(1);
  expect(baseline.stats.proofs.coverage).toEqual([
    { coverage: "solid", requirements: 2 },
  ]);
  expect(baseline.stats.unread).toBeUndefined();

  const lane = newShapeReview({ badJudgements: "lane" });
  const bogus = await readWith(lane);
  expect(bogus.undecoded).toMatchObject([
    {
      what: "judgement 1 of b1.u1",
      part: "judgements",
      unit: "b1.u1",
      section: lane.sectionKeys.k1,
    },
  ]);
  expect(bogus.undecoded[0]?.issue).toContain("lane.applied");
  expect(
    bogus.large.checkpoints.map((c) =>
      "section" in c ? c.section : undefined,
    ),
  ).toEqual([lane.sectionKeys.k2]);
  expect(bogus.stats.highComplexityValidationGapHumanSuggested).toBe(0);
  expect(bogus.stats.proofs.coverage).toEqual([
    { coverage: "solid", requirements: 1 },
  ]);
  expect(bogus.stats.unread).toEqual({
    manifests: 0,
    judgements: 0,
    entries: 1,
  });

  const numbers = await readWith(newShapeReview({ badJudgements: "numbers" }));
  expect(numbers.undecoded.map((item) => item.what)).toEqual([
    "judgement 1 of b1.u1",
    "judgement 2 of b1.u1",
    // Neither entry names a section, so both of the unit's sections are unjudged, which is said.
    "judgements of b1.u1",
  ]);
  expect(numbers.large.checkpoints).toEqual([]);
  expect(numbers.stats.highComplexityValidationGapHumanSuggested).toBe(0);
  expect(numbers.stats.proofs.coverage).toEqual([]);
  expect(numbers.stats.unread).toEqual({
    manifests: 0,
    judgements: 0,
    entries: 2,
  });
});

test("an undecided cause that is not a cause name leaves that section unjudged and says which", async () => {
  const fixture = newShapeReview({ badCause: true });
  const read = await readWith(fixture);
  expect(read.undecoded).toMatchObject([
    {
      what: "judgement 1 of b2.u1",
      part: "judgements",
      batch: "b2",
      unit: "b2.u1",
      section: fixture.sectionKeys.k3,
    },
  ]);
  expect(read.undecoded[0]?.issue).toContain("undecided.cause");
  expect(read.small.sections.map((s) => [s.key, s.lane])).toEqual([
    [fixture.sectionKeys.k3, undefined],
  ]);
  expect(read.small.assessment?.payload.lane).toBe("human-required");
  expect(read.small.judgement.lane).toBe("human-required");
});

// Why: a section's content is optional briefing text; a decode failure in it must never remove what
// the unit owns. Only that section's content is left off, and it is said once, naming the section.
test("a section content that does not decode leaves only that content off, and says which section", async () => {
  const fixture = newShapeReview({ badContent: true });
  const read = await readWith(fixture);
  const { k1, k2 } = fixture.sectionKeys;
  expect(read.undecoded).toEqual([
    {
      what: `content of section ${k2} of b1.u1`,
      ref: fixture.events.units.large.refs[0]!.ref,
      issue: expect.stringContaining("facts.text"),
      part: "unit-sections",
      batch: "b1",
      unit: "b1.u1",
      section: k2,
    },
  ]);
  // Every range, both sections and their judgements, the first section's content and the lane.
  expect(read.large.recorded?.payload.ownedRanges).toHaveLength(1_100);
  expect(read.large.sections.map((s) => [s.key, s.ownedRanges.length])).toEqual(
    [
      [k1, 600],
      [k2, 500],
    ],
  );
  expect(read.large.sections[0]?.content?.facts.text).toBe(
    "The retry loop stops sooner.",
  );
  expect("content" in read.large.sections[1]!).toBe(false);
  expect(read.large.sections[1]?.lane?.applied).toBe("human-suggested");
  expect(read.large.assessment?.payload.lane).toBe("human-suggested");
  expect(read.large.judgement.lane).toBe("human-suggested");
});

// Why: a section's side is a word the desk reads to place its lines; one this build does not know
// must cost only that word, never the unit's lines or sections, as content does.
test("a section side that is not one reads as absent, and says which section", async () => {
  const fixture = newShapeReview({ badSide: true });
  const read = await readWith(fixture);
  const { k1, k2 } = fixture.sectionKeys;
  expect(read.undecoded).toEqual([
    {
      what: `side of section ${k1} of b1.u1`,
      ref: fixture.events.units.large.refs[0]!.ref,
      issue: expect.stringContaining("(root)"),
      part: "unit-sections",
      batch: "b1",
      unit: "b1.u1",
      section: k1,
    },
  ]);
  expect(read.large.recorded?.payload.ownedRanges).toHaveLength(1_100);
  expect(read.large.sections.map((s) => [s.key, s.ownedRanges.length])).toEqual(
    [
      [k1, 600],
      [k2, 500],
    ],
  );
  // The other parts and the section's content are kept; only the side is left off.
  expect(read.large.sections[0]?.parts).toEqual({
    path: "src/large.ts",
    kind: "function",
    name: "retry",
    future: "kept",
  });
  expect(read.large.sections[0]?.content?.facts.text).toBe(
    "The retry loop stops sooner.",
  );
  expect(read.large.sections[0]?.lane?.applied).toBe("human-suggested");
  expect(read.large.judgement.lane).toBe("human-suggested");
});
