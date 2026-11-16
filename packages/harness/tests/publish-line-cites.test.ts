import { expect, test } from "bun:test";
import { Effect } from "effect";
import { PublishedPackets } from "@neuve/records-core";
import { describePacket } from "../src/packet-view.ts";
import { publishSettled, type SettledBatch } from "../src/publish-sections.ts";
import {
  atTime,
  batchOf,
  inputOf,
  scratch,
  section,
  unit,
} from "./publish-sections-fixtures.ts";

/**
 * Line cites inside a hunk, `[phrase](h<15 hex>@<start>-<end>)` or `@<line>`: the readers' briefing
 * cites the lines a phrase is about, not the hunk's first line. Records resolves one to the bare
 * hunk's resolution with its ranges narrowed to the cited lines, on the hunk's new side, or its old
 * side when it has no new-side lines, and leaves a cite outside the hunk's lines, or a malformed
 * one, unresolved with why.
 */

const T = Date.UTC(2026, 10, 14, 22, 0, 0);
const CYCLE = "01KA1B5V3Q8D2N4M6P7R9S0T3Y";
const RUN = "01KA1B5V3Q8D2N4M6P7R9S0T4Z";

/** A modification hunk (old 5-8, new 10-20) and a removal-only hunk (old 40-45). */
const hM = "h0a0a0a0a0a0a0a0";
const hR = "h0b0b0b0b0b0b0b0";
/** A hunk no section holds. */
const hX = `h${"f".repeat(15)}`;

const lead = `Retries [stop at two](${hM}@12-14) and [log once](${hM}@20).`;
const sectionBriefed = `The [old guard is gone](${hR}@41-43); [the loop](${hM}) is shorter.`;
const digest = `The [cap](${hM}@10-20) moves; [the old count](${hM}@6-7) and [a lost hunk](${hX}@1-2) do not link.`;

const batch = (): SettledBatch => {
  const base = section({
    label: "d1",
    path: "src/d.ts",
    name: "retry",
    where: { startLine: 1, endLine: 50 },
    ranges: [
      {
        kind: "lines",
        path: "src/d.ts",
        side: "old",
        startLine: 5,
        endLine: 8,
      },
      {
        kind: "lines",
        path: "src/d.ts",
        side: "new",
        startLine: 10,
        endLine: 20,
      },
      {
        kind: "lines",
        path: "src/d.ts",
        side: "old",
        startLine: 40,
        endLine: 45,
      },
    ],
    lane: "agentic",
  });
  const d1 = {
    ...base,
    rangeHunks: [hM, hM, hR],
    content: {
      facts: { text: "The retry loop changes.", cites: [hM, hR] },
      briefed: sectionBriefed,
      explained: {
        before: `It [checked past the end](${hM}@19-21).`,
        after: `It [stops](${hM}@9-3), [nowhere](${hM}@0) and [anywhere](${hM}@x).`,
        terms: [],
        cites: [],
      },
    },
  };
  return {
    ...batchOf(
      "Retry policy",
      ["src/d.ts"],
      [d1],
      [unit("src/d.ts", "agentic", [d1], { briefed: lead })],
    ),
    digest: { text: digest },
  };
};

const narrowed = (
  side: string,
  startLine: number,
  endLine: number,
): PublishedPackets.Resolution => ({
  kind: "hunk",
  path: "src/d.ts",
  ranges: [{ side, startLine, endLine }],
});

const read = () => {
  const store = scratch({ cycleId: CYCLE });
  return store.run(
    atTime(T)(
      Effect.gen(function* () {
        const ctx = store.ctx({ runId: RUN, startedAt: T - 1_000 });
        yield* publishSettled(
          ctx,
          inputOf([batch()], { totals: { batches: 1, sections: 1 } }),
        );
        const packet = yield* PublishedPackets.readStanding(CYCLE);
        if (packet?.kind !== "packet.published@2") throw new Error("no packet");
        return packet;
      }),
    ),
  );
};

const byId = (citations: PublishedPackets.Citations) =>
  new Map(citations.cited.map((cited) => [cited.id, cited]));

// Why: every phrase landed on its hunk's first line because Records resolved only a bare hunk ID;
// an `@` cite read as `unknown`. The boundary is the publisher to Records' packet read on a fresh
// store, a version-2 packet whose sections name each range's hunk, and the text `review show`
// prints from it. One packet holds every case, so the bare hunk is checked beside its line cites.
test("a line cite resolves to exactly its lines on the hunk's side; outside or malformed stays unresolved with why", async () => {
  const packet = await read();
  expect(packet.undecoded).toEqual([]);
  const [readBatch] = packet.batches;
  const [readUnit] = readBatch!.units;

  // Nothing strips or refuses the links: the unit's lead, the section's Briefed and Explained and
  // the digest hold them as written.
  expect(readUnit!.content.briefed).toEqual({ text: lead });
  expect(readUnit!.sections[0]!.content?.briefed).toBe(sectionBriefed);
  expect(readUnit!.sections[0]!.content?.explained?.after).toContain(
    `(${hM}@9-3)`,
  );
  expect(readBatch!.digest?.digest).toBe(digest);

  const cited = byId(readUnit!.citations);
  // The bare hunk is unchanged: both its ranges, each side.
  expect(cited.get(hM)?.resolution).toEqual({
    kind: "hunk",
    path: "src/d.ts",
    ranges: expect.arrayContaining([
      { side: "old", startLine: 5, endLine: 8 },
      { side: "new", startLine: 10, endLine: 20 },
    ]),
  });
  expect(
    (cited.get(hM)?.resolution as { ranges: ReadonlyArray<unknown> }).ranges,
  ).toHaveLength(2);
  expect(cited.get(hR)?.resolution).toEqual(narrowed("old", 40, 45));
  // New side inside the hunk, a range and a single line at its last line.
  expect(cited.get(`${hM}@12-14`)?.resolution).toEqual(narrowed("new", 12, 14));
  expect(cited.get(`${hM}@20`)?.resolution).toEqual(narrowed("new", 20, 20));
  expect(cited.get(`${hM}@12-14`)?.stops).toEqual(["briefed"]);
  // Old side, on a removal-only hunk, cited from a section's Briefed only.
  expect(cited.get(`${hR}@41-43`)?.resolution).toEqual(narrowed("old", 41, 43));
  expect(cited.get(`${hR}@41-43`)?.stops).toEqual(["briefed"]);
  // Past the end of the hunk's new lines: unresolved, with why.
  const outside = cited.get(`${hM}@19-21`)!;
  expect(outside.resolution).toBeUndefined();
  expect(outside.unresolved).toBe("not-published");
  expect(outside.detail).toBe(
    `lines 19-21 are outside hunk ${hM}'s lines on its new side (10-20)`,
  );
  expect(outside.stops).toEqual(["explained"]);
  // Malformed: backwards, zero, not digits.
  for (const [id, why] of [
    [`${hM}@9-3`, "it starts at line 9, after its end at line 3"],
    [`${hM}@0`, `"0" after the hunk ID is not a line`],
    [`${hM}@x`, `"x" after the hunk ID is not a line`],
  ] as const) {
    const bad = cited.get(id)!;
    expect(bad.resolution).toBeUndefined();
    expect(bad.unresolved).toBe("unknown");
    expect(bad.detail).toContain(`line cite ${id} is malformed: ${why}`);
  }
  expect(readUnit!.citations.resolved).toBe(5);
  expect(readUnit!.citations.unresolved).toBe(4);

  // The digest: the hunk's whole new range; the old side of a hunk with new lines is outside it;
  // a hunk that does not resolve leaves its line cite unresolved with the hunk's reason.
  const fromDigest = byId(readBatch!.digestCitations);
  expect(fromDigest.get(`${hM}@10-20`)?.resolution).toEqual(
    narrowed("new", 10, 20),
  );
  expect(fromDigest.get(`${hM}@6-7`)?.detail).toBe(
    `lines 6-7 are outside hunk ${hM}'s lines on its new side (10-20)`,
  );
  const lost = fromDigest.get(`${hX}@1-2`)!;
  expect(lost.resolution).toBeUndefined();
  expect(lost.unresolved).toBe("unknown");
  expect(lost.detail).toContain(`its hunk ${hX} does not resolve`);

  // `review show` prints the narrowed lines and the reasons.
  const text = describePacket(packet).join("\n");
  expect(text).toContain(`${hM}@12-14 [briefed] -> hunk d.ts new 12-14`);
  expect(text).toContain(`${hR}@41-43 [briefed] -> hunk d.ts old 41-43`);
  expect(text).toContain(
    `${hM}@19-21 [explained] -> UNRESOLVED (not-published: lines 19-21 are outside`,
  );
});
