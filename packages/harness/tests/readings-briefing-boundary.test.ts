// Why (NEU-148 round 27): the regression this round closes is a new-shape unit published with Facts
// only. From the settler, through the real publisher, to the packet Records reads, every section of
// a unit outside the generated batch has Briefed and Explained, or its unit carries a briefing gap
// that says why; the digest the briefing wrote reaches the overview with links to units.
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { PublishedPackets } from "@neuve/records-core";
import { publishSettled } from "../src/publish-sections.ts";
import { GENERATED_GROUP } from "../src/readings/settled.ts";
import { DIGEST_FAILED } from "../src/readings/briefing-settle.ts";
import type { GroupEvidence } from "../src/readings/evidence.ts";
import { briefingUsefulness } from "../../evaluation/src/harness-compare/full-test/readings-gate.ts";
import {
  HEAD,
  MAP_GROUP,
  MARKS,
  briefingsFor,
  collected,
  count,
  helper,
  settle,
} from "./fixtures/briefing.ts";
import { inputOf, scratch } from "./publish-sections-fixtures.ts";

const publishedRead = async (out: ReturnType<typeof settle>) => {
  const store = scratch();
  const read = await store.run(
    Effect.gen(function* () {
      const ctx = store.ctx();
      yield* publishSettled(
        ctx,
        inputOf(out.batches as never, { ending: true, totals: out.totals }),
      );
      return yield* PublishedPackets.readStanding(ctx.cycleId);
    }),
  );
  expect(read?.kind).toBe("packet.published@2");
  if (read?.kind !== "packet.published@2") throw new Error("no packet");
  expect(read.undecoded).toEqual([]);
  return read;
};

/** Every unit outside the generated batch: each section has both stops, or the unit a briefing gap. */
const expectNoFactsOnly = (read: Awaited<ReturnType<typeof publishedRead>>) => {
  let checked = 0;
  for (const batch of read.batches) {
    // The generated batch keeps code's digest and its limitation, by rule.
    const generated =
      batch.digest?.limitations?.includes(
        "This briefing was put together by code from each unit's facts.",
      ) === true;
    if (generated) continue;
    for (const unit of batch.units) {
      checked++;
      const gapped = batch.gaps.some(
        (gap) =>
          gap.payload.kind.startsWith("briefing-") &&
          JSON.stringify(gap).includes(unit.unitId),
      );
      for (const section of unit.sections ?? []) {
        const whole =
          section.content !== undefined &&
          section.content.briefed !== null &&
          section.content.explained !== null;
        expect(whole || gapped).toBe(true);
      }
    }
  }
  expect(checked).toBeGreaterThan(0);
};

// Reason: the Facts-only regression must not return unseen.
test("written: no unit outside the generated batch publishes Facts only, and the digest is the agent's with unit links", async () => {
  const out = settle(briefingsFor("written"));
  const read = await publishedRead(out);
  expectNoFactsOnly(read);
  const sections = read.batches
    .flatMap((b) => b.units)
    .flatMap((u) => u.sections ?? []);
  // Every read section carries the model's Briefed (round 27b).
  expect(
    sections.filter((s) => s.content?.briefed?.includes(MARKS.model)),
  ).toHaveLength(3);
  const main = read.batches.find((b) => b.digest?.source === "agent")!;
  expect(main.digest!.digest).toContain(MARKS.digest);
  // The link names a unit's handle, which the packet resolves to that unit.
  const cited = main.digestCitations.cited.filter((c) => c.id.startsWith("u."));
  expect(cited.length).toBeGreaterThan(0);
  expect(cited.every((c) => c.resolution?.kind === "unit")).toBe(true);
  expect(main.digest!.obligations!.map((o) => o.row)).toEqual(["D1"]);
  // The generated batch: code's digest, its sections with neither stop, by rule.
  const generated = read.batches.find((b) => b.digest?.source !== "agent")!;
  expect(generated.digest!.source).toBe("code");
  for (const unit of generated.units)
    for (const section of unit.sections ?? [])
      expect(section.content).toMatchObject({ briefed: null, explained: null });
  expect(out.batches.find((b) => b.title !== MAP_GROUP.label)!.title).toBe(
    GENERATED_GROUP.label as string,
  );
});

// Reason: a failed briefing is code's text and a gap the desk shows, never silent Facts.
test("failed: every affected unit carries the briefing-failed gap, and the digest says code put it together", async () => {
  const read = await publishedRead(settle(briefingsFor("failed")));
  expectNoFactsOnly(read);
  const main = read.batches.find((b) =>
    b.digest?.limitations?.includes(DIGEST_FAILED),
  )!;
  // One per unit, and one for the digest (review item 5).
  expect(
    main.gaps.filter((g) => g.payload.kind === "briefing-failed").length,
  ).toBe(main.units.length + 1);
});

// Reason: round 27b's citations. From the settler through the real publisher to what Records reads:
// code's same-batch references reach both units as markers on their lines, and every Briefed link
// resolves to the lines it names.
test("a same-batch reference by code, each range's hunk, the unit lead and the Briefed links reach Records' read resolved, and the gates' measure passes", async () => {
  // count's group saw a confirmed caller of count on helper's changed line (src/parse.ts:4); helper
  // is in another unit of the same batch.
  const helperLine = helper.owned.find((r) => r.side === "new")!.startLine;
  const evidence = [
    {
      group: "g",
      sections: [
        {
          key: count.key,
          rows: [
            {
              kind: "caller",
              symbol: "count",
              path: "src/parse.ts",
              shows: "call",
              line: helperLine,
              text: "count(items)",
              from: "helper",
              confirmed: true,
            },
          ],
        },
      ],
    },
  ] as unknown as ReadonlyArray<GroupEvidence>;
  const out = settle(briefingsFor("written"), collected(), {
    head: HEAD,
    evidence,
  });
  const main = out.batches.find((b) => b.title === MAP_GROUP.label)!;
  expect(main.references).toHaveLength(2);
  const read = await publishedRead(out);
  const batch = read.batches.find((b) => b.digest?.source === "agent")!;
  expect(batch.units.flatMap((u) => u.references).length).toBeGreaterThan(0);
  const withRefs = batch.units.filter((u) => u.references.length > 0);
  // Both units, each with both references: one on count's lines, one on helper's call site.
  expect(withRefs).toHaveLength(2);
  for (const unit of withRefs) {
    expect(unit.references).toHaveLength(2);
    // Each resolves through the batch's index to the reference whole.
    expect(Object.keys(unit.referenceDetails)).toHaveLength(2);
    for (const event of unit.references) {
      expect(event.payload.markerKind).toBe("same-batch");
      expect(event.attribution.unitIds).toHaveLength(2);
    }
    expect(
      unit.references
        .map((e) => e.payload.anchor.startLine)
        .sort((a, b) => a - b),
    ).toEqual([helperLine, count.owned[0]!.startLine]);
  }
  // No reference was left unpublished.
  expect(
    batch.units.length > 0 &&
      read.batches.every((b) =>
        b.gaps.every((g) => g.payload.kind !== "reference-not-published"),
      ),
  ).toBe(true);
  for (const unit of batch.units) {
    // Each section names each owned range's hunk (records' `rangeHunks`), and its Briefed links to
    // a hunk its own Facts cite.
    for (const section of unit.sections ?? []) {
      expect(section.rangeHunks).toHaveLength(section.ownedRanges.length);
      for (const id of section.rangeHunks ?? [])
        expect(id).toMatch(/^h[0-9a-f]{15}$/);
      const links = [
        ...(section.content?.briefed ?? "").matchAll(
          /\[[^\]]+\]\(([^)\s]+)\)/g,
        ),
      ].map((m) => m[1]!);
      expect(links.length).toBeGreaterThan(0);
      for (const id of links) {
        expect(section.content!.facts.cites).toContain(id);
        expect(section.rangeHunks).toContain(id);
      }
    }
    // Each unit leads with its lead (records' `briefed` stop), within 600 code points, and every
    // link in it resolves to the lines of the hunk it names.
    const lead = unit.content.briefed?.text;
    expect(lead).toBeDefined();
    expect([...lead!].length).toBeLessThanOrEqual(600);
    expect(lead).toContain(MARKS.model);
    const cited = unit.citations.cited.filter((c) =>
      c.stops.includes("briefed"),
    );
    expect(cited.length).toBeGreaterThan(0);
    expect(cited.every((c) => c.resolution?.kind === "hunk")).toBe(true);
  }
  // The gates' briefing measure (rubric 3.8) on this packet, as `show.json` would hold it.
  const measured = briefingUsefulness(JSON.parse(JSON.stringify(read)));
  expect(measured.citeShare).toBe(1);
  expect(measured.explainedIds).toBe(0);
  // Only the generated batch's one unit leads with its Facts, by rule; no unit of several sections.
  expect(measured.leadIsFactsOnMultiSection).toBe(0);
  expect(measured.leadIsFacts).toBe(
    read.batches
      .filter((b) => b.digest?.source !== "agent")
      .flatMap((b) => b.units).length,
  );
  expect(measured.modelByKind.lead.texts).toBeGreaterThan(0);
  expect(measured.bySource.agent.fileListTexts).toBe(0);
  expect(measured.fails).toEqual([]);
});

// Reason: the coordinator's rulings on line cites and titles. A phrase's cite of a hunk's lines
// (`h…@4`) and each section's behaviour title reach Records' read as written; each unit is titled by
// its first section's behaviour title, never by its file. Records resolves the cite.
test("a cite of a hunk's lines and the sections' behaviour titles reach Records' read, the cite resolved", async () => {
  const written = briefingsFor("written");
  const line = helper.owned.find((r) => r.side === "new")!.startLine;
  const cite = `${helper.hunkIds[0]}@${line}`;
  const sections = new Map(written.sections);
  sections.set(helper.key, {
    ...sections.get(helper.key)!,
    briefed: `${MARKS.model} callers of helper [now see the change](${cite}).`,
  });
  const out = settle({ ...written, sections });
  const read = await publishedRead(out);
  const batch = read.batches.find((b) => b.digest?.source === "agent")!;
  const all = batch.units.flatMap((u) => u.sections ?? []);
  expect(all.length).toBe(3);
  for (const section of all) expect(section.title).toContain(MARKS.title);
  const held = all.find((s) => s.key === helper.key)!;
  expect(held.content!.briefed).toContain(`(${cite})`);
  const unit = batch.units.find((u) =>
    (u.sections ?? []).some((s) => s.key === helper.key),
  )!;
  expect(unit.content.briefed?.text).toContain(`(${cite})`);
  // Records resolves the cite to exactly the one new-side line cited, side and range.
  const resolved = unit.citations.cited.find((c) => c.id === cite);
  expect(resolved?.resolution).toEqual({
    kind: "hunk",
    path: "src/parse.ts",
    ranges: [{ side: "new", startLine: line, endLine: line }],
  });
  // Every unit is titled by its sections' behaviour titles, by the briefing, never by its file.
  let titled = 0;
  for (const each of batch.units) {
    const recorded = each.recorded as
      { payload: { title: string; titleBy: string } } | undefined;
    if (recorded === undefined) continue;
    titled++;
    expect(recorded.payload.titleBy).toBe("agent");
    expect(recorded.payload.title).toContain(MARKS.title);
    expect(recorded.payload.title).not.toContain(".ts");
  }
  expect(titled).toBe(batch.units.length);
});
