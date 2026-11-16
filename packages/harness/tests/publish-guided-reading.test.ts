import { expect, test } from "bun:test";
import { Effect } from "effect";
import { PublishedPackets } from "@neuve/records-core";
import {
  SettledBatch,
  publishSettled,
  type SettledSection,
} from "../src/publish-sections.ts";
import { unitHandle, unitKeyOf } from "../src/publish-sections-input.ts";
import {
  atTime,
  inputOf,
  scratch,
  threeBatches,
} from "./publish-sections-fixtures.ts";

/**
 * A Guided row's reading (`reading: { text, cites }`, as the readers' settler stores it) cites from
 * every section of its file, while the row's evidence comes from the worst-status answers, so a
 * reading can cite a hunk its evidence does not. Records reads the reading's cites and the links in
 * its text into the unit's citations, as it reads the evidence.
 */

const T = Date.UTC(2026, 10, 14, 12, 0, 0);
const CYCLE = "01KA0Z5V3Q8D2N4M6P7R9S0T5A";
const RUN = "01KA0Z5V3Q8D2N4M6P7R9S0T6B";

const [h1, h2, h4] = [
  "h1a1a1a1a1a1a1a1",
  "h2a2a2a2a2a2a2a2",
  "h4a1a1a1a1a1a1a1",
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

const row = (id: string, evidence: ReadonlyArray<string>, extra = {}) => ({
  row: id,
  text: "Retries stop after two attempts.",
  basis: "done-when",
  status: "met",
  does: "The loop gives up at two tries.",
  evidence: [...evidence],
  ...extra,
});

/**
 * Publishes batch a with its agentic unit's Guided stop set to `guided` (a1 names its ranges'
 * hunks: h1 owns lines 3 and 5, h4 line 7; a2's Facts cite h2 alone) and reads the agentic unit.
 */
const agenticUnit = async (guided: unknown) => {
  const store = scratch({ cycleId: CYCLE });
  const { a } = threeBatches();
  const [a1, a2] = a.sections as [SettledSection, SettledSection];
  const batch: SettledBatch = {
    ...a,
    sections: [withHunks(a1, [h1], [h1, h1, h4]), withHunks(a2, [h2])],
    units: [{ ...a.units[0]!, guided }, a.units[1]!],
  };
  const read = await store.run(
    atTime(T)(
      Effect.gen(function* () {
        const ctx = store.ctx({ runId: RUN, startedAt: T - 1_000 });
        yield* publishSettled(ctx, inputOf([batch]));
        return yield* PublishedPackets.readStanding(CYCLE);
      }),
    ),
  );
  if (read?.kind !== "packet.published@2") throw new Error("no packet");
  expect(read.undecoded).toEqual([]);
  const handle = unitHandle(unitKeyOf(a.units[0]!));
  return read.batches[0]!.units.find((unit) => unit.local === handle)!;
};

const outcome = (citations: PublishedPackets.Citations) =>
  citations.cited.map((cited) => ({
    id: cited.id,
    stops: cited.stops,
    to: (cited.resolution ?? cited.unresolved) as unknown,
  }));

// Why: a cite only in a row's reading never entered the unit's citations, so it never resolved and
// the desk, which reads a reading's cites through the same resolutions as the evidence, dropped its
// pin. The boundary is the publisher to Records' packet read on a fresh store.
test("a Guided row's reading cites and text links enter the unit's citations, once each", async () => {
  const unit = await agenticUnit({
    rows: [
      // h1 is in the evidence and the reading's cites; h4 only in the cites; h2 only in the text.
      row("d1", [h1], {
        reading: {
          text: `The loop [passes the limit on](${h2}).`,
          cites: [h1, h4],
        },
      }),
    ],
    outside: [
      {
        item: "Logging",
        does: "The last try is logged.",
        evidence: [],
        reading: { text: "Logged once.", cites: [h4] },
      },
    ],
  });
  // On 3411aa3d: h1 alone, [facts, guided]; h4 and h2 were never cited.
  expect(outcome(unit.citations)).toEqual([
    { id: h1, stops: ["facts", "guided"], to: linesOf("src/a.ts", 3, 5) },
    { id: h4, stops: ["guided"], to: linesOf("src/a.ts", 7) },
    { id: h2, stops: ["guided"], to: linesOf("src/a.ts", 31, 33) },
  ]);
  expect(unit.citations.resolved).toBe(3);
  expect(unit.citations.unresolved).toBe(0);
});

// Why: `reading` is read from stored content whatever its shape; a row without one, or with one of
// another shape, must cite exactly what its evidence cites, and never fail the read.
test("a Guided row whose reading is missing or malformed cites only its evidence", async () => {
  const rows = (readings: ReadonlyArray<unknown>) =>
    readings.map((reading, at) =>
      row(`d${at + 1}`, [h4], reading === "absent" ? {} : { reading }),
    );
  const malformed = [
    "absent",
    null,
    `A [link](${h2}) in a bare string.`,
    7,
    [h2],
    { text: 5, cites: h2 },
    { text: null, cites: [7, null, { id: h2 }] },
    { cites: [] },
  ];
  const plain = await agenticUnit({ rows: rows(["absent"]) });
  const read = await agenticUnit({
    rows: rows(malformed),
    outside: [
      { item: "Logging", does: "Logged.", evidence: [h4], reading: "x" },
    ],
  });
  expect(outcome(read.citations)).toEqual(outcome(plain.citations));
  expect(outcome(read.citations)).toEqual([
    { id: h1, stops: ["facts"], to: linesOf("src/a.ts", 3, 5) },
    { id: h4, stops: ["guided"], to: linesOf("src/a.ts", 7) },
  ]);
});
