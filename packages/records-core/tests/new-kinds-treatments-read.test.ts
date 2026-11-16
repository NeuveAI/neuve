// Why: the desk, the gates and `review show --json` read a section's judgement only through the read
// model, and the owner's cost changes are measured through `review stats`. Over a stored review
// holding one entry of each treatment, each section must come back with exactly the keys its entry
// stores (and none it does not), and the stats must count sections by what produced them, by rule
// and by pattern member, from the same entries they already place, and add nothing for a review
// written before these keys.
import { afterAll, expect, test } from "bun:test";
import { Effect } from "effect";
import { Log, PublishedPackets, ReviewStats } from "../src/index.ts";
import { contentLayer, storeContent } from "./new-shape-support.ts";
import { newShapeReview } from "./review-fixtures.ts";
import { freshLocation, removeTemporaryDirectories, runOn } from "./support.ts";

afterAll(removeTemporaryDirectories);

const stored = async (options: Parameters<typeof newShapeReview>[0]) => {
  const location = freshLocation();
  const fixture = newShapeReview(options);
  const read = await runOn(
    location,
    Effect.gen(function* () {
      yield* storeContent(fixture);
      yield* Log.append(fixture.all);
      return {
        packet: yield* PublishedPackets.readRun(fixture.runId),
        stats: yield* ReviewStats.reviewStats({ cycleId: fixture.cycleId }),
      };
    }).pipe(Effect.provide(contentLayer(location))),
  );
  return { fixture, ...read };
};

const TREATMENT_KEYS = ["origin", "rules", "family", "context"] as const;

test("each section carries the treatment keys its entry stores, and the stats count them", async () => {
  const { fixture, packet, stats } = await stored({ kinds: true });
  if (packet?.kind !== "packet.published@2" || fixture.kinds === undefined)
    throw new Error("expected the kinds batch in a new-shape packet");
  // The fixture names one gap Records does not hold; nothing else is left undecoded.
  expect(packet.undecoded.filter((u) => u.part !== "gap")).toEqual([]);
  const units = packet.batches.flatMap((batch) => batch.units);
  const unit = (unitId: string) => units.find((u) => u.unitId === unitId)!;
  const keys = fixture.kinds.sectionKeys;
  const byKey = new Map(
    [unit(fixture.kinds.units.kinds), unit(fixture.kinds.units.tests)]
      .flatMap((u) => u.sections)
      .map((section) => [section.key, section]),
  );
  const present = (key: string) =>
    TREATMENT_KEYS.filter((name) => name in byKey.get(key)!);

  expect(present(keys.representative)).toEqual(["origin", "family"]);
  expect(byKey.get(keys.representative)?.family).toMatchObject({
    representative: keys.representative,
    members: 2,
  });
  expect(present(keys.member)).toEqual(["origin", "family"]);
  expect(byKey.get(keys.member)?.origin).toEqual({
    assess: "model",
    review: "family",
  });
  expect(byKey.get(keys.member)?.family?.representative).toBe(
    keys.representative,
  );
  expect(byKey.get(keys.member)?.family?.key).toBe(
    byKey.get(keys.representative)?.family?.key,
  );
  expect(present(keys.context)).toEqual(["rules", "context"]);
  expect(byKey.get(keys.context)?.context).toBe(true);
  expect(byKey.get(keys.context)?.lane?.applied).toBe("static-automation");
  expect(present(keys.oneReading)).toEqual(["origin", "rules"]);
  expect(byKey.get(keys.oneReading)?.review).toEqual({ verdict: "approve" });
  expect(present(keys.ruled)).toEqual(["origin", "rules"]);
  // A code rule's judgement comes back whole, its inputs and result as stored.
  expect(byKey.get(keys.ruled)?.rules).toEqual([
    {
      rule: "whitespace-only",
      version: 1,
      inputs: { tokensEqual: true },
      result: "holds",
      reason: "The rule whitespace-only holds.",
      statement: "whitespace only",
    },
  ]);
  expect(byKey.get(keys.ruled)?.review).toBeNull();
  // A context change counts among its unit's changes and is not raised by sitting lower.
  expect(unit(fixture.kinds.units.kinds).assessment?.payload).toMatchObject({
    lane: "agentic",
    sections: { count: 3, raised: 0 },
  });
  // The sections written before these keys carry none of them.
  for (const section of unit(fixture.units.large).sections)
    for (const name of TREATMENT_KEYS) expect(name in section).toBe(false);

  expect(stats.judgedBy).toEqual({
    assess: { model: 2, rule: 2 },
    review: { model: 2, family: 1, none: 1 },
    rules: { "imports-only": 1, "test-only": 1, "whitespace-only": 1 },
    familyMembers: 1,
  });
  expect(stats.unread).toBeUndefined();
});

test("a review whose entries hold no treatment keys gains no judgedBy count, and a lone member still reads", async () => {
  const plain = await stored({});
  expect(plain.stats.judgedBy).toBeUndefined();

  // A member whose representative is in no batch of this review reads whole and counts as one.
  const lone = await stored({ kinds: "lone-member" });
  if (
    lone.packet?.kind !== "packet.published@2" ||
    lone.fixture.kinds === undefined
  )
    throw new Error("expected the kinds batch");
  expect(lone.packet.undecoded.filter((u) => u.part !== "gap")).toEqual([]);
  const member = lone.packet.batches
    .flatMap((batch) => batch.units)
    .flatMap((u) => u.sections)
    .find((section) => section.key === lone.fixture.kinds!.sectionKeys.member);
  expect(member?.family?.representative).not.toBe(
    lone.fixture.kinds.sectionKeys.representative,
  );
  expect(lone.stats.judgedBy?.familyMembers).toBe(1);
});
