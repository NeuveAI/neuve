import { expect, test } from "bun:test";
import { Effect } from "effect";
import { z } from "zod";
import { Blobs, PublishedPackets } from "@neuve/records-core";
import { UnitSections } from "@neuve/records-schema";
import { describePacket } from "../src/packet-view.ts";
import {
  SettledBatch,
  publishSettled,
  type SettledSection,
} from "../src/publish-sections.ts";
import {
  batchHandle,
  batchKeyOf,
  unitHandle,
  unitKeyOf,
  unitSections,
} from "../src/publish-sections-input.ts";
import {
  atTime,
  eventsOf,
  inputOf,
  scratch,
  threeBatches,
} from "./publish-sections-fixtures.ts";

/**
 * What the readers' settler hands the publisher for its briefing: each owned range's hunk ID
 * (`SettledSection.rangeHunks`), so a hunk links to its own lines, and a unit's lead
 * (`SettledUnit.briefed`), written as the unit's Briefed stop.
 */

const T = Date.UTC(2026, 10, 14, 10, 0, 0);
const CYCLE = "01KA0Z5V3Q8D2N4M6P7R9S0T3Y";
const RUN = "01KA0Z5V3Q8D2N4M6P7R9S0T4Z";

const [h1, h2, h4, h5] = [
  "h1a1a1a1a1a1a1a1",
  "h2a2a2a2a2a2a2a2",
  "h4a1a1a1a1a1a1a1",
  "h5a2a2a2a2a2a2a2",
];

/** A section whose code Facts cite `cites` and whose ranges name `rangeHunks`, when given. */
const withHunks = (
  section: SettledSection,
  cites: ReadonlyArray<string>,
  rangeHunks?: ReadonlyArray<string>,
): SettledSection => ({
  ...section,
  ...(rangeHunks === undefined ? {} : { rangeHunks: [...rangeHunks] }),
  content: {
    facts: { text: `${section.title} changes.`, cites: [...cites] },
    briefed: null,
    explained: null,
  },
});

const linesOf = (path: string, ...starts: ReadonlyArray<number>) => ({
  kind: "hunk",
  path,
  ranges: starts.map((line) => ({
    side: "new",
    startLine: line,
    endLine: line,
  })),
});

const outcome = (
  citations: PublishedPackets.Citations,
): Record<string, unknown> =>
  Object.fromEntries(
    citations.cited.map((cited) => [
      cited.id,
      cited.resolution ?? cited.unresolved,
    ]),
  );

const published = () =>
  Effect.gen(function* () {
    const read = yield* PublishedPackets.readStanding(CYCLE);
    if (read?.kind !== "packet.published@2") throw new Error("no packet");
    return read;
  });

// Why: a section of several hunks kept its lines without their hunk IDs, so none of its hunks
// could be placed, and code's Facts cite only a section's first six hunks, so a seventh named
// nothing. With each range's hunk ID in the blob, a hunk resolves to exactly its own lines,
// wherever it is cited. The boundary is the publisher to Records' packet read on a fresh store,
// and the text `review show` prints from it.
test("a hunk of a section of several, and its seventh hunk, resolve to their own lines", async () => {
  const store = scratch({ cycleId: CYCLE });
  const { a, c } = threeBatches();
  const [a1, a2] = a.sections as [SettledSection, SettledSection];
  const c1 = c.sections[0]!;
  // a1 owns lines 3 and 5 in h1 and line 7 in h4; c1 owns 1,100 ranges across seven hunks.
  const seven = Array.from(
    { length: 7 },
    (_, n) => `h${String(n + 1).repeat(15)}`,
  );
  const cHunks = c1.ownedRanges.map(
    (_, at) => seven[Math.floor((at * 7) / c1.ownedRanges.length)]!,
  );
  const agentic = unitHandle(unitKeyOf(a.units[0]!));
  const batchA: SettledBatch = {
    ...a,
    sections: [withHunks(a1, [h1, h4], [h1, h1, h4]), withHunks(a2, [h2])],
    units: [
      {
        ...a.units[0]!,
        briefed: `Retries [stop at two](${h1}) and [log the last](${h4}).`,
      },
      a.units[1]!,
    ],
  };
  const batchC: SettledBatch = {
    ...c,
    sections: [withHunks(c1, seven.slice(0, 6), cHunks)],
    units: [
      {
        ...c.units[0]!,
        briefed: `The table [starts here](${seven[0]}) and [ends here](${seven[6]}).`,
      },
    ],
  };
  const read = await store.run(
    atTime(T)(
      Effect.gen(function* () {
        const ctx = store.ctx({ runId: RUN, startedAt: T - 1_000 });
        yield* publishSettled(ctx, inputOf([batchA, batchC]));
        return yield* published();
      }),
    ),
  );
  const unitA = read.batches[0]!.units.find((unit) => unit.local === agentic)!;
  // Without range hunks, both stayed `not-published`: a1 holds two hunks.
  expect(outcome(unitA.citations)).toEqual({
    [h1]: linesOf("src/a.ts", 3, 5),
    [h4]: linesOf("src/a.ts", 7),
  });
  expect(unitA.citations.cited.map((cited) => cited.stops)).toEqual([
    ["facts", "briefed"],
    ["facts", "briefed"],
  ]);
  expect(unitA.sections[0]!.rangeHunks).toEqual([h1, h1, h4]);
  const unitC = read.batches[1]!.units[0]!;
  const rangesOf = (id: string) =>
    c1.ownedRanges
      .filter((_, at) => cHunks[at] === id)
      .map((range) => (range.kind === "lines" ? range.startLine : 0));
  const citedC = outcome(unitC.citations);
  expect(citedC[seven[0]!]).toEqual(
    linesOf("src/c.ts", ...rangesOf(seven[0]!)),
  );
  // The seventh, which code's Facts never cite: before, `unknown`.
  expect(citedC[seven[6]!]).toEqual(
    linesOf("src/c.ts", ...rangesOf(seven[6]!)),
  );
  expect(unitC.citations.unresolved).toBe(0);
  const text = describePacket(read).join("\n");
  expect(text).toContain(
    `${h1} [facts, briefed] -> hunk a.ts new 3-3, new 5-5`,
  );
  expect(text).toContain(`${h4} [facts, briefed] -> hunk a.ts new 7-7`);
  expect(read.undecoded).toEqual([]);
});

// Why: a hunk held by a section that names its ranges' hunks and by one that names none takes
// the second's lines by today's rule (all of them, when its Facts cite that hunk alone), so the
// link covers every line the packet knows for it. When that section's Facts cite several hunks,
// its lines for this hunk are unknown, and a link to part of the hunk would mislead: it stays
// unresolved.
test("a hunk split between a section naming its ranges' hunks and one naming none", async () => {
  const { a } = threeBatches();
  const [a1, a2] = a.sections as [SettledSection, SettledSection];
  const run = async (a2Cites: ReadonlyArray<string>) => {
    const store = scratch({ cycleId: CYCLE });
    const batch: SettledBatch = {
      ...a,
      sections: [withHunks(a1, [h1, h2], [h1, h1, h2]), withHunks(a2, a2Cites)],
      digest: { text: `Retries [stop](${h2}).` },
    };
    const read = await store.run(
      atTime(T)(
        Effect.gen(function* () {
          const ctx = store.ctx({ runId: RUN, startedAt: T - 1_000 });
          yield* publishSettled(ctx, inputOf([batch]));
          return yield* published();
        }),
      ),
    );
    return read.batches[0]!.digestCitations;
  };
  expect(outcome(await run([h2]))).toEqual({
    [h2]: {
      kind: "hunk",
      path: "src/a.ts",
      ranges: [7, 31, 33].map((line) => ({
        side: "new",
        startLine: line,
        endLine: line,
      })),
    },
  });
  const several = await run([h2, h5]);
  expect(outcome(several)).toEqual({ [h2]: "not-published" });
  expect(several.cited[0]!.detail).toContain("several hunks");
});

// Why: the blob keeps ranges in file order whatever order they arrive in; each range's hunk ID
// must move with its range, or a hunk would link to another's lines.
test("each range's hunk ID moves with its range into file order", () => {
  const { a } = threeBatches();
  const a1 = withHunks(a.sections[0]!, [h1, h4], [h1, h1, h4]);
  const reversed: SettledSection = {
    ...a1,
    ownedRanges: [...a1.ownedRanges].reverse(),
    rangeHunks: [...a1.rangeHunks!].reverse(),
  };
  const blobOf = (section: SettledSection) =>
    unitSections(
      { sectionKeys: [section.identity.key] },
      new Map([[section.identity.key, section]]),
    );
  expect(blobOf(reversed)).toEqual(blobOf(a1));
  expect(blobOf(a1).sections[0]!.rangeHunks).toEqual([h1, h1, h4]);
  expect(UnitSections.safeParse(blobOf(a1)).success).toBe(true);
});

/** Publishes `bad` beside batch b and returns what the call refused and the gaps' details. */
const refusedWith = async (bad: SettledBatch) => {
  const store = scratch();
  const { b } = threeBatches();
  return store.run(
    Effect.gen(function* () {
      const ctx = store.ctx();
      const summary = yield* publishSettled(ctx, inputOf([bad, b]));
      const gaps = yield* eventsOf(ctx.cycleId, "gap.disclosed@1");
      return {
        refused: summary.refused,
        batches: summary.counts.batches,
        details: gaps.map((gap) => (gap.payload as { detail: string }).detail),
      };
    }),
  );
};

// Why: a hunk ID per range that does not line up with the ranges, or is not a hunk's, would link
// a hunk to the wrong lines; the batch is refused with its reason, and the other batch publishes.
test("range hunks of the wrong length, or not a hunk's ID, refuse their batch alone", async () => {
  const { a } = threeBatches();
  const [a1, a2] = a.sections as [SettledSection, SettledSection];
  const cases = [
    {
      rangeHunks: [h1, h4],
      reason:
        "a section doesn't name one hunk for each of its changed line ranges",
    },
    {
      rangeHunks: [h1, h1, "h4A1A1A1A1A1A1A1"],
      reason: "a section names a hunk with an ID that isn't a hunk's",
    },
    {
      rangeHunks: [h1, h1, "h4a1a1a1a1a1a1"],
      reason: "a section names a hunk with an ID that isn't a hunk's",
    },
  ];
  for (const { rangeHunks, reason } of cases) {
    const result = await refusedWith({
      ...a,
      sections: [withHunks(a1, [h1], rangeHunks), a2],
    });
    expect(result.refused).toEqual([
      { batch: batchHandle(batchKeyOf(a.paths)), check: "range-hunks" },
    ]);
    expect(result.batches).toBe(1);
    expect(result.details.some((detail) => detail.includes(reason))).toBe(true);
  }
});

// Why: the readers' settler writes the unit's lead; it is published as the unit's Briefed stop,
// whose links resolve as every stop's do. A unit without one is written as before, record for
// record. A lead over 600 code points (not UTF-16 units), or empty once trimmed, refuses its batch.
test("a unit's lead is its Briefed stop; a unit without one is written as before", async () => {
  const { a, b } = threeBatches();
  const lead = `Retries [stop at two](${h1}).`;
  const run = async (withLead: boolean) => {
    const store = scratch({ cycleId: CYCLE });
    const batch: SettledBatch = {
      ...a,
      sections: [withHunks(a.sections[0]!, [h1]), a.sections[1]!],
      units: [
        withLead ? { ...a.units[0]!, briefed: lead } : a.units[0]!,
        a.units[1]!,
      ],
    };
    return store.run(
      atTime(T)(
        Effect.gen(function* () {
          const ctx = store.ctx({ runId: RUN, startedAt: T - 1_000 });
          yield* publishSettled(ctx, inputOf([batch, b]));
          const read = yield* published();
          const events = yield* eventsOf(CYCLE);
          const deliveries = events.filter(
            (event) => event.kind === "delivery.recorded@1",
          );
          const content = deliveries.find(
            (event) =>
              (event.payload as { content: string }).content === "briefed",
          );
          return { read, events, content };
        }),
      ),
    );
  };
  const led = await run(true);
  const plain = await run(false);
  const unitA = led.read.batches[0]!.units[0]!;
  expect(unitA.content.briefed).toEqual({ text: lead });
  expect(led.content?.payload).toEqual({ content: "briefed", verdictWords: 0 });
  expect(outcome(unitA.citations)).toEqual({
    [h1]: linesOf("src/a.ts", 3, 5, 7),
  });
  expect(unitA.citations.cited[0]!.stops).toEqual(["facts", "briefed"]);
  expect(plain.content).toBeUndefined();
  expect(plain.read.batches[0]!.units[0]!.content.briefed).toBeUndefined();
  // Every record but the lead's, the manifest and the packet is the same in both.
  const others = (events: typeof led.events) =>
    events
      .filter(
        (event) =>
          event.id !== led.content?.id && event.kind !== "packet.published@2",
      )
      .map((event) => JSON.stringify(event));
  expect(others(led.events)).toEqual(others(plain.events));
  const unitB = (read: typeof led.read) => read.batches[1]!.units[0]!;
  expect(JSON.stringify(unitB(led.read))).toBe(
    JSON.stringify(unitB(plain.read)),
  );
  expect(led.read.undecoded).toEqual([]);
});

test("a lead over 600 code points, or empty, refuses its batch alone", async () => {
  const { a } = threeBatches();
  const withLead = (briefed: string): SettledBatch => ({
    ...a,
    units: [{ ...a.units[0]!, briefed }, a.units[1]!],
  });
  // 600 code points of two UTF-16 units each publish: the bound counts code points.
  const fits = await refusedWith(withLead("\u{1F600}".repeat(600)));
  expect(fits.refused).toEqual([]);
  expect(fits.batches).toBe(2);
  for (const [briefed, reason] of [
    ["\u{1F600}".repeat(601), "a unit's lead is longer than 600 characters"],
    [" \n\t ", "a unit's lead is empty"],
  ] as const) {
    const result = await refusedWith(withLead(briefed));
    expect(result.refused).toEqual([
      { batch: batchHandle(batchKeyOf(a.paths)), check: "unit-briefed" },
    ]);
    expect(result.batches).toBe(1);
    expect(result.details.some((detail) => detail.includes(reason))).toBe(true);
  }
});

/**
 * `UnitSectionsRead` as the installed build (`e0ebb64d`, whose records schema `6c10cb3b` keeps
 * unchanged) declares it, copied whole, so the test reads a new blob as that build does.
 */
const OwnedRangeReadE0 = z.discriminatedUnion("kind", [
  z.looseObject({
    kind: z.literal("lines"),
    path: z.string(),
    side: z.enum(["old", "new"]),
    startLine: z.int().min(1),
    endLine: z.int().min(1),
  }),
  z.looseObject({
    kind: z.literal("whole-nontext"),
    path: z.string(),
    side: z.enum(["old", "new"]),
  }),
]);
const UnitSectionsReadE0 = z.looseObject({
  sections: z
    .array(
      z.looseObject({
        key: z.string(),
        parts: z.looseObject({
          path: z.string(),
          side: z.unknown().optional(),
          kind: z.string(),
          name: z.string().nullable(),
        }),
        where: z
          .looseObject({ startLine: z.number(), endLine: z.number() })
          .nullable(),
        renamedFrom: z.string().nullable(),
        title: z.string(),
        ownedRanges: z.array(OwnedRangeReadE0).min(1),
        content: z.unknown().optional(),
      }),
    )
    .min(1),
});

// Why: the installed build reads every blob this one writes. A blob with range hunks must decode
// with its schema, ranges and all, or that build's desk would show the unit with no lines.
test("a blob with range hunks decodes with the installed build's schema", async () => {
  const store = scratch({ cycleId: CYCLE });
  const { a } = threeBatches();
  const [a1, a2] = a.sections as [SettledSection, SettledSection];
  const batch: SettledBatch = {
    ...a,
    sections: [
      withHunks(a1, [h1, h4], [h1, h1, h4]),
      withHunks(a2, [h2], [h2, h2]),
    ],
  };
  const blobs = await store.run(
    atTime(T)(
      Effect.gen(function* () {
        const ctx = store.ctx({ runId: RUN, startedAt: T - 1_000 });
        yield* publishSettled(ctx, inputOf([batch]));
        const units = yield* eventsOf(CYCLE, "unit.recorded@3");
        const held = yield* Blobs.BlobStore;
        const read: Array<unknown> = [];
        for (const unit of units) {
          const got = yield* held.get(unit.refs![0]!.ref.slice("blob:".length));
          if (got._tag !== "Present") throw new Error(`blob ${got._tag}`);
          read.push(JSON.parse(new TextDecoder().decode(got.bytes)));
        }
        return read;
      }),
    ),
  );
  expect(blobs).toHaveLength(2);
  for (const blob of blobs) {
    expect(JSON.stringify(blob)).toContain('"rangeHunks"');
    const old = UnitSectionsReadE0.safeParse(blob);
    expect(old.success).toBe(true);
    expect(old.data!.sections[0]!.ownedRanges.length).toBeGreaterThan(0);
  }
});
