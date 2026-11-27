import { expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import { PublishedPackets } from "@neuve/records-core";
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
} from "../src/publish-sections-input.ts";
import {
  atTime,
  eventsOf,
  inputOf,
  scratch,
  threeBatches,
} from "./publish-sections-fixtures.ts";

/**
 * The batch digest the readers' briefing step hands in: who wrote it (`source`) and the done-when
 * rows' status across the batch's units (`obligations`, each unit named by its index in `units`),
 * and what the published digest holds of them.
 */

const T = Date.UTC(2026, 10, 14, 9, 0, 0);
// Fixed, so the packet a batch publishes can be compared with the one e0ebb64d's build wrote.
const CYCLE = "01KA0Z5V3Q8D2N4M6P7R9S0T1W";
const RUN = "01KA0Z5V3Q8D2N4M6P7R9S0T2X";

/** The retry batch's digest as the briefing step writes it. */
const briefed = (batch: SettledBatch, units: ReadonlyArray<number>) => ({
  ...batch,
  digest: {
    text: `${batch.title}: retries stop sooner.`,
    source: "agent" as const,
    uncertainty: ["Whether it looks good under load is not known."],
    limitations: ["No test was approved for the slow path."],
    obligations: [
      {
        row: "d1",
        text: "Retries stop after two attempts.",
        basis: "The ticket's second paragraph.",
        overall: "partial",
        units: units.map((unit, index) => ({
          unit,
          status: index === 0 ? "met" : "open",
          required: index === 0,
        })),
      },
      {
        row: "d2",
        text: "The exported entry point keeps its name.",
        overall: "met",
        units: [{ unit: units[0]!, status: "met", required: false }],
      },
    ],
  },
});

// Why: the readers' settler writes these fields; the input must take them, and an input without
// them must read exactly as it does today.
test("a digest with its source and obligations decodes, and one without them reads as today", () => {
  const { a } = threeBatches();
  const given = briefed(a, [1, 0]);
  const decoded = SettledBatch.safeParse(given);
  expect(decoded.success).toBe(true);
  expect(decoded.data?.digest).toEqual(given.digest);
  // Absent fields stay absent: no default is written into the stored plan or the call's signature.
  const plain = SettledBatch.parse(a);
  expect(plain.digest).toEqual({ text: a.digest.text });
  expect(Object.keys(plain.digest)).toEqual(["text"]);
  // The input stays strict.
  expect(
    SettledBatch.safeParse({
      ...a,
      digest: { ...a.digest, source: "model" },
    }).success,
  ).toBe(false);
  expect(
    SettledBatch.safeParse({
      ...given,
      digest: {
        ...given.digest,
        obligations: [{ ...given.digest.obligations[0]!, extra: true }],
      },
    }).success,
  ).toBe(false);
});

// Why: a unit index is the publisher's to turn into a handle; one that names no unit must refuse
// that batch alone, with its reason, and never the whole call.
test("an obligation naming a unit index out of range refuses its batch alone", async () => {
  const store = scratch();
  const { a, b } = threeBatches();
  const result = await store.run(
    Effect.gen(function* () {
      const ctx = store.ctx();
      const summary = yield* publishSettled(
        ctx,
        inputOf([briefed(a, [0, 2]), b]),
      );
      const gaps = yield* eventsOf(ctx.cycleId, "gap.disclosed@1");
      return { summary, gaps };
    }),
  );
  expect(result.summary.refused).toEqual([
    {
      batch: batchHandle(batchKeyOf(a.paths)),
      check: "obligation-unit",
    },
  ]);
  expect(result.summary.counts.batches).toBe(1);
  const refusal = result.gaps.find((gap) =>
    (gap.payload as { detail: string }).detail.includes("obligation"),
  );
  expect((refusal?.payload as { detail: string }).detail).toContain(
    "an obligation of its digest names a unit the batch doesn't hold",
  );
});

// Why: an obligation that names one unit twice has no single status for it; the batch is refused
// with its reason, and the other batch still publishes.
test("an obligation naming one unit index twice refuses its batch alone", async () => {
  const store = scratch();
  const { a, b } = threeBatches();
  const result = await store.run(
    Effect.gen(function* () {
      const ctx = store.ctx();
      const summary = yield* publishSettled(
        ctx,
        inputOf([briefed(a, [1, 1]), b]),
      );
      const gaps = yield* eventsOf(ctx.cycleId, "gap.disclosed@1");
      return { summary, gaps };
    }),
  );
  expect(result.summary.refused).toEqual([
    {
      batch: batchHandle(batchKeyOf(a.paths)),
      check: "obligation-unit",
    },
  ]);
  expect(result.summary.counts.batches).toBe(1);
  const refusal = result.gaps.find((gap) =>
    (gap.payload as { detail: string }).detail.includes("obligation"),
  );
  expect((refusal?.payload as { detail: string }).detail).toContain(
    "an obligation of its digest names one unit twice",
  );
});

// Why: the packet is what the overview and the desk read: who wrote the digest, its obligations
// with the published unit handles, and verdict words wherever the model wrote prose.
test("the digest holds its source, its obligations by unit handle, and verdict words over all its prose", async () => {
  const store = scratch();
  const { a } = threeBatches();
  const result = await store.run(
    Effect.gen(function* () {
      const ctx = store.ctx();
      yield* publishSettled(ctx, inputOf([briefed(a, [1, 0])]));
      const read = yield* PublishedPackets.readStanding(ctx.cycleId);
      const deliveries = yield* eventsOf(ctx.cycleId, "delivery.recorded@1");
      return { read, deliveries };
    }),
  );
  const read = result.read;
  if (read?.kind !== "packet.published@2") throw new Error("no packet");
  const [agentic, required] = a.units.map((unit) =>
    unitHandle(unitKeyOf(unit)),
  ) as [string, string];
  expect(read.batches[0]!.digest).toEqual({
    batchId: batchHandle(batchKeyOf(a.paths)),
    source: "agent",
    digest: "Retry policy: retries stop sooner.",
    verification: "",
    uncertainty: ["Whether it looks good under load is not known."],
    limitations: ["No test was approved for the slow path."],
    // "looks good" in the uncertainty and "approved" in the limitations.
    verdictWords: 2,
    obligations: [
      {
        row: "d1",
        text: "Retries stop after two attempts.",
        basis: "The ticket's second paragraph.",
        overall: "partial",
        // In the published units' order, whatever order the caller named them in.
        units: [
          { unit: agentic, status: "open", required: false },
          { unit: required, status: "met", required: true },
        ],
      },
      {
        row: "d2",
        text: "The exported entry point keeps its name.",
        overall: "met",
        units: [{ unit: required, status: "met", required: false }],
      },
    ],
  });
  const digestEvent = result.deliveries.find(
    (event) =>
      (event.payload as { content: string }).content === "batch-digest",
  );
  expect(digestEvent?.payload).toEqual({
    content: "batch-digest",
    verdictWords: 2,
  });
  expect(read.undecoded).toEqual([]);
});

// Why: a batch handed in without the new fields must publish the bytes e0ebb64d's build wrote,
// whatever its uncertainty and limitations say, so no review in flight publishes differently. The
// one move since is meant: code-built unit titles no longer name the lane (1cdaadba), and src/a.ts
// has two units here, so their titles changed. With those titles put back the bytes are e0ebb64d's
// (manifest d4b587dc…63c3, packet 01M7CMHXM0004JJ3H3PP0KS9VJ; checked in round 32).
test("a batch without the new fields publishes the packet e0ebb64d wrote", async () => {
  const { a, b, c } = threeBatches();
  const withNotes = {
    ...a,
    digest: {
      text: a.digest.text,
      uncertainty: ["It looks good."],
      limitations: ["Nothing was approved."],
    },
  };
  const store = scratch({ cycleId: CYCLE });
  const result = await store.run(
    atTime(T)(
      Effect.gen(function* () {
        const current = store.ctx({ runId: RUN, startedAt: T - 1_000 });
        const { readings: _readings, ...config } = current.config;
        const ctx = {
          ...current,
          config: {
            ...config,
            budgets: {
              ...config.budgets,
              turnLimits: { frame: 1, map: 1, find: 11, verify: 1 },
            },
          },
        };
        const summary = yield* publishSettled(
          ctx,
          inputOf([withNotes, b, c], { ending: true }),
        );
        const read = yield* PublishedPackets.readStanding(CYCLE);
        return { summary, read };
      }),
    ),
  );
  if (result.read?.kind !== "packet.published@2") throw new Error("no packet");
  expect(result.read.batches[0]!.digest).toEqual({
    batchId: batchHandle(batchKeyOf(a.paths)),
    source: "code",
    digest: a.digest.text,
    verification: "",
    uncertainty: ["It looks good."],
    limitations: ["Nothing was approved."],
    verdictWords: 0,
  });
  expect({
    manifest: result.summary.manifest,
    packet: result.summary.packetEventId,
  }).toEqual({
    manifest:
      "0c763124b62d2dc028ea245dc3ed7334a440da1015eebfe2a9613387416664fc",
    packet: "01M7CMHXM0004RVRGH3ECFFY1M",
  });
});

/** A section whose code Facts cite its hunks, and whose Briefed links one, as the readers write it. */
const citing = (
  section: SettledSection,
  hunks: ReadonlyArray<string>,
  briefedText: string | null,
): SettledSection => ({
  ...section,
  content: {
    facts: { text: `${section.title} changes.`, cites: [...hunks] },
    briefed: briefedText,
    explained: null,
  },
});

// Why: a new-shape packet has no assembled batch, so hunk IDs and unit handles resolved to nothing
// and every link read as plain text. They resolve through the units' sections and the manifest's
// unit handles. A section's blob keeps its lines without their hunk IDs, so only a hunk of a
// section that holds one hunk can be placed: a hunk of a section of several stays unresolved
// rather than opening on another hunk's lines. An ID that names nothing stays unresolved. The
// digest names no source, so the input decodes on e0ebb64d too and the counts can be compared.
test("a hunk ID and a unit handle in a digest or Facts resolve on a new-shape packet", async () => {
  const store = scratch();
  const { a } = threeBatches();
  const [a1, a2] = a.sections as [SettledSection, SettledSection];
  const [h1, h4, h2, nothing] = [
    "h1a1a1a1a1a1a1a1",
    "h4a1a1a1a1a1a1a1",
    "h2a2a2a2a2a2a2a2",
    "h999999999999999",
  ];
  // a1 owns lines 3, 5 and 7 across two hunks; a2 owns lines 31 and 33 in one hunk.
  const sections = [citing(a1, [h1, h4], null), citing(a2, [h2], null)];
  const [agentic, required] = a.units.map((unit) =>
    unitHandle(unitKeyOf(unit)),
  ) as [string, string];
  const batch: SettledBatch = {
    ...a,
    sections,
    units: [
      // The agentic unit's Guided evidence cites the other unit's hunk: it resolves only once
      // every unit's sections are read, since the agentic unit is read first.
      {
        ...a.units[0]!,
        guided: {
          rows: [
            {
              row: "d1",
              text: "Retries stop after two attempts.",
              basis: "done-when",
              status: "met",
              does: "The entry point passes the new limit on.",
              evidence: [h2],
            },
          ],
        },
      },
      a.units[1]!,
    ],
    digest: {
      text: `The [retry loop](${agentic}) gives up at [two tries](${h1}); [the entry point](${required}) [passes it on](${h2}); [elsewhere](${nothing}).`,
    },
  };
  const read = await store.run(
    Effect.gen(function* () {
      const ctx = store.ctx();
      yield* publishSettled(ctx, inputOf([batch]));
      return yield* PublishedPackets.readStanding(ctx.cycleId);
    }),
  );
  if (read?.kind !== "packet.published@2") throw new Error("no packet");
  const published = read.batches[0]!;
  expect(published.units.map((unit) => unit.local)).toEqual([
    agentic,
    required,
  ]);
  const unitOf = (handle: string) =>
    published.units.find((unit) => unit.local === handle)!;
  const outcome = (
    citations: PublishedPackets.Citations,
  ): Record<string, unknown> =>
    Object.fromEntries(
      citations.cited.map((cited) => [
        cited.id,
        cited.resolution ?? cited.unresolved,
      ]),
    );
  const detailOf = (citations: PublishedPackets.Citations, id: string) =>
    citations.cited.find((cited) => cited.id === id)?.detail;
  const a2Lines = {
    kind: "hunk",
    path: "src/a.ts",
    ranges: [31, 33].map((line) => ({
      side: "new",
      startLine: line,
      endLine: line,
    })),
  };
  // e0ebb64d resolved none of them, and none of the units' cites.
  expect(published.digestCitations.resolved).toBe(3);
  expect(published.digestCitations.unresolved).toBe(2);
  expect(outcome(published.digestCitations)).toEqual({
    [agentic]: {
      kind: "unit",
      local: agentic,
      unitId: unitOf(agentic).unitId,
      eventId: unitOf(agentic).recorded!.id,
    },
    [h1]: "not-published",
    [required]: {
      kind: "unit",
      local: required,
      unitId: unitOf(required).unitId,
      eventId: unitOf(required).recorded!.id,
    },
    [h2]: a2Lines,
    [nothing]: "unknown",
  });
  expect(detailOf(published.digestCitations, h1)).toContain("several hunks");
  // The agentic unit: its two hunks stay unresolved, and its Guided evidence reaches a2's hunk.
  const agenticCitations = unitOf(agentic).citations;
  expect(outcome(agenticCitations)).toEqual({
    [h1]: "not-published",
    [h4]: "not-published",
    [h2]: a2Lines,
  });
  expect(detailOf(agenticCitations, h4)).toContain("several hunks");
  expect(outcome(unitOf(required).citations)).toEqual({ [h2]: a2Lines });
  expect(read.undecoded).toEqual([]);
});

// Why: a batch already published is frozen; obligations handed in later are new content, which
// the frozen rule withholds like any other change, and the call says so.
test("a published batch handed in again with obligations stays as published", async () => {
  const store = scratch();
  const { a } = threeBatches();
  const result = await store.run(
    Effect.gen(function* () {
      const ctx = store.ctx();
      yield* publishSettled(ctx, inputOf([a]));
      const again = yield* Effect.exit(
        publishSettled(ctx, inputOf([briefed(a, [0, 1])])),
      );
      const read = yield* PublishedPackets.readStanding(ctx.cycleId);
      return { again, read };
    }),
  );
  expect(Exit.isSuccess(result.again)).toBe(true);
  if (Exit.isSuccess(result.again))
    expect(result.again.value.frozen).toEqual([
      batchHandle(batchKeyOf(a.paths)),
    ]);
  if (result.read?.kind !== "packet.published@2") throw new Error("no packet");
  expect(result.read.batches[0]!.digest?.obligations).toBeUndefined();
  expect(result.read.batches[0]!.digest?.source).toBe("code");
});
