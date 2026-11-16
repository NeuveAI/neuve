// Why: the readers lane will hand the publisher entries judged by a code rule, entries that carry
// another section's judgement as members of its pattern, and import-only changes kept as context of
// their file's unit. The publisher decides nothing: it must refuse whole, with a gap in a reader's
// words, a batch whose entries contradict themselves or their representative, keep a context
// change's lower lane out of its unit's lane, and store every legitimate treatment so the read
// model returns it whole. An agent's approval must still never be recorded on a human-required
// unit, whatever lane a context change in it sits at.
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { PublishedPackets, sha256Hex } from "@neuve/records-core";
import {
  publishSettled,
  type SettledBatch,
  type SettledSection,
} from "../src/publish-sections.ts";
import {
  batchOf,
  inputOf,
  lines,
  scratch,
  section,
  threeBatches,
  unit,
} from "./publish-sections-fixtures.ts";

type Entry = SettledSection["entry"];
type Lane = Entry["lane"]["applied"];

const rule = (name: string) => ({
  rule: name,
  version: 1,
  inputs: { facts: [name] },
  result: "holds",
  reason: `The rule ${name} holds.`,
  statement: name === "imports-only" ? "imports only" : `${name} change`,
});

/** A section of `path` at `lane`, its entry changed by `entry`. */
const treated = (
  label: string,
  path: string,
  lane: Lane,
  from: number,
  entry: (base: Entry) => Entry = (base) => base,
): SettledSection => {
  const base = section({
    label,
    path,
    name: label,
    where: { startLine: from, endLine: from + 9 },
    ranges: lines(path, from, 2),
    lane,
  });
  return { ...base, entry: entry(base.entry) };
};

const FAMILY = sha256Hex("family:parse");
const READING = `computation:${sha256Hex("reading:rep")}`;

/**
 * Every legitimate treatment, in one batch of two files. `src/k.ts`, agentic: a representative,
 * its member and an import-only change kept as context at static automation. `src/k.test.ts`,
 * static automation: one reading beside a rule, a rule alone, and a member whose representative
 * is in another batch.
 */
const kinds = () => {
  const rep = treated("rep", "src/k.ts", "agentic", 1, (e) => ({
    ...e,
    origin: { assess: "model", review: "model" },
    family: {
      key: FAMILY,
      representative: e.key,
      reading: READING,
      members: 2,
    },
  }));
  const member = treated("member", "src/k.ts", "agentic", 20, (e) => ({
    ...e,
    assess: rep.entry.assess,
    review: rep.entry.review,
    origin: { assess: "model", review: "family" },
    family: { key: FAMILY, representative: rep.identity.key, reading: READING },
  }));
  const context = treated(
    "imports",
    "src/k.ts",
    "static-automation",
    40,
    (e) => ({
      ...e,
      assess: null,
      review: null,
      lane: {
        ...e.lane,
        judged: "static-automation",
        surfaced: "static-automation",
      },
      rules: [rule("imports-only")],
      context: true,
    }),
  );
  const oneReading = treated(
    "test",
    "src/k.test.ts",
    "static-automation",
    1,
    (e) => ({
      ...e,
      origin: { assess: "rule", review: "model" },
      rules: [rule("test-only")],
    }),
  );
  const ruled = treated(
    "spacing",
    "src/k.test.ts",
    "static-automation",
    20,
    (e) => ({
      ...e,
      review: null,
      origin: { assess: "rule", review: "none" },
      rules: [rule("whitespace-only")],
    }),
  );
  const lone = treated(
    "lone",
    "src/k.test.ts",
    "static-automation",
    40,
    (e) => ({
      ...e,
      origin: { assess: "model", review: "family" },
      family: {
        key: sha256Hex("family:other"),
        representative: sha256Hex("section:elsewhere"),
      },
    }),
  );
  const sections = { rep, member, context, oneReading, ruled, lone };
  const batch = batchOf(
    "Kinds",
    ["src/k.ts", "src/k.test.ts"],
    Object.values(sections),
    [
      unit("src/k.ts", "agentic", [rep, member, context], {
        verdict: "approve",
        disposition: "approve",
      }),
      unit("src/k.test.ts", "static-automation", [oneReading, ruled, lone]),
    ],
  );
  return { batch, sections };
};

/** Publishes `a`, `batch` and `c`; the summary and the standing packet read back. */
const publishWith = (batch: SettledBatch, sections: number) => {
  const store = scratch();
  const { a, c } = threeBatches();
  return store.run(
    Effect.gen(function* () {
      const ctx = store.ctx();
      const summary = yield* publishSettled(
        ctx,
        inputOf([a, batch, c], {
          ending: true,
          totals: { batches: 3, sections: 3 + sections },
        }),
      );
      const read = yield* PublishedPackets.readStanding(ctx.cycleId);
      if (read?.kind !== "packet.published@2") throw new Error("no packet");
      return { summary, read };
    }),
  );
};

/** Batch `kinds` (or `b`) broken one way per rule. */
const broken = (): ReadonlyArray<readonly [string, SettledBatch, number]> => {
  const { b } = threeBatches();
  const [b1, b2] = b.sections as [SettledSection, SettledSection];
  const withB = (
    one: Partial<Entry>,
    two: Partial<Entry> = {},
  ): SettledBatch => ({
    ...b,
    sections: [
      { ...b1, entry: { ...b1.entry, ...one } },
      { ...b2, entry: { ...b2.entry, ...two } },
    ],
  });
  const { batch, sections } = kinds();
  const withKinds = (
    change: Partial<Record<keyof typeof sections, (e: Entry) => Entry>>,
    units = batch.units,
  ): SettledBatch => ({
    ...batch,
    sections: Object.entries(sections).map(([name, s]) => {
      const edit = change[name as keyof typeof sections];
      return edit === undefined ? s : { ...s, entry: edit(s.entry) };
    }),
    units,
  });
  const excluded = { reason: "lockfile" as const };
  return [
    // Not decided, and also context, a rule's alone, or another change's judgement.
    ["undecided-context", withB({ context: true }), 2],
    [
      "undecided-ruled",
      withB({
        origin: { assess: "rule", review: "none" },
        rules: [rule("whitespace-only")],
      }),
      2,
    ],
    [
      "undecided-pattern",
      withB({ family: { key: FAMILY, representative: b2.identity.key } }),
      2,
    ],
    // A file not read that carries a rule's judgement or a pattern's.
    [
      "excluded-judged",
      withB({}, { excluded, rules: [rule("imports-only")] }),
      2,
    ],
    [
      "excluded-judged",
      withB(
        {},
        { excluded, family: { key: FAMILY, representative: b1.identity.key } },
      ),
      2,
    ],
    // Judged by a rule that it does not name.
    [
      "rule-unnamed",
      withB({}, { origin: { assess: "rule", review: "none" } }),
      2,
    ],
    [
      "rule-unnamed",
      withB({}, { origin: { assess: "rule", review: "model" }, rules: [] }),
      2,
    ],
    // Judged with another change of its pattern that it does not name.
    [
      "pattern-unnamed",
      withB({}, { origin: { assess: "model", review: "family" } }),
      2,
    ],
    [
      "pattern-unnamed",
      withB(
        {},
        {
          origin: { assess: "model", review: "family" },
          family: { key: FAMILY, representative: b2.identity.key },
        },
      ),
      2,
    ],
    // A member and its representative in one batch that disagree on the key or the judgement.
    [
      "pattern-disagrees",
      withKinds({
        rep: (e) => ({
          ...e,
          family: { ...e.family!, key: sha256Hex("other") },
        }),
      }),
      6,
    ],
    [
      "pattern-disagrees",
      withKinds({
        member: (e) => ({ ...e, review: { verdict: "request-changes" } }),
      }),
      6,
    ],
    [
      "pattern-disagrees",
      withKinds({
        member: (e) => ({
          ...e,
          assess: { ...e.assess!, complexity: { level: "high", factors: [] } },
        }),
      }),
      6,
    ],
    // A context change above its unit's lane, and a unit of context alone.
    [
      "context-lane",
      withKinds({
        context: (e) => ({
          ...e,
          lane: { ...e.lane, applied: "human-suggested" },
        }),
      }),
      6,
    ],
    [
      "context-only",
      withKinds({}, [
        unit("src/k.ts", "agentic", [sections.rep, sections.member]),
        unit("src/k.ts", "static-automation", [sections.context]),
        batch.units[1]!,
      ]),
      6,
    ],
    // Without its mark, a change below its unit's lane is refused as it always was.
    ["unit-lane", withKinds({ context: ({ context: _mark, ...e }) => e }), 6],
  ];
};

test.each(
  broken().map(
    ([check, batch, sections], n) =>
      [`${check} (${n + 1})`, check, batch, sections] as const,
  ),
)(
  "a batch failing %s stays pending with a gap",
  async (_label, check, batch, sections) => {
    const { summary, read } = await publishWith(batch, sections);
    expect(summary.refused).toEqual([
      { batch: expect.stringMatching(/^b\./), check },
    ]);
    expect(read.batches.map((b) => b.recorded?.payload.title)).toEqual([
      "Retry policy",
      "Lookup table",
    ]);
    expect(read.counts.pending).toEqual({ batches: 1, sections });
    const gap = read.gaps.find((g) => g.payload.kind === "batch-not-published");
    expect(gap?.payload.detail).toStartWith(
      `The changes in "${batch.title}" aren't in this review yet, because`,
    );
    expect(gap?.payload.detail).not.toMatch(/[0-9a-f]{16}/);
    // The new reasons name no working word; the unit-lane reason is today's, unchanged.
    if (check !== "unit-lane")
      expect(gap?.payload.detail).not.toMatch(/section|family/);
  },
);

test("every legitimate treatment is published and read back whole, a context change counted and not raised", async () => {
  const { batch, sections } = kinds();
  const { summary, read } = await publishWith(batch, 6);
  expect(summary.refused).toEqual([]);
  expect(read.counts.pending).toEqual({ batches: 0, sections: 0 });
  const published = read.batches.find(
    (b) => b.recorded?.payload.title === "Kinds",
  );
  if (published === undefined) throw new Error("the kinds batch is missing");
  const byKey = new Map(
    published.units.flatMap((u) => u.sections).map((s) => [s.key, s]),
  );
  for (const s of Object.values(sections)) {
    const { key: _key, ...entry } = s.entry;
    expect(byKey.get(s.identity.key)).toMatchObject(entry);
  }
  const of = (path: string) =>
    published.units.find(
      (u) =>
        u.recorded?.kind === "unit.recorded@3" &&
        u.recorded.payload.path === path,
    );
  const [file, tests] = [of("src/k.ts"), of("src/k.test.ts")];
  expect(file?.assessment?.payload).toMatchObject({
    lane: "agentic",
    sections: { count: 3, raised: 0, undecided: {} },
  });
  expect(tests?.assessment?.payload).toMatchObject({
    lane: "static-automation",
    sections: { count: 3, raised: 0 },
  });
  // The agentic unit's own approval stands; the context change below it took no part.
  expect(file?.disposition?.payload.verdict).toBe("approve");
  expect(read.undecoded).toEqual([]);
});

test("a context change at a lower lane in a human-required unit leaves an agent's approval unrecorded", async () => {
  const held = treated("guard", "src/h.ts", "human-required", 1);
  const context = treated("imports", "src/h.ts", "agentic", 30, (e) => ({
    ...e,
    assess: null,
    review: null,
    lane: { ...e.lane, judged: "agentic", surfaced: "agentic" },
    rules: [rule("imports-only")],
    context: true,
  }));
  const batch = batchOf(
    "Held",
    ["src/h.ts"],
    [held, context],
    [
      unit("src/h.ts", "human-required", [held, context], {
        verdict: "approve",
        disposition: "approve",
      }),
    ],
  );
  const { summary, read } = await publishWith(batch, 2);
  expect(summary.refused).toEqual([]);
  const published = read.batches.find(
    (b) => b.recorded?.payload.title === "Held",
  );
  const only = published?.units[0];
  expect(only?.assessment?.payload.lane).toBe("human-required");
  expect(only?.sections.map((s) => [s.lane?.applied, s.context])).toEqual(
    expect.arrayContaining([
      ["human-required", undefined],
      ["agentic", true],
    ]),
  );
  expect(only?.disposition).toBeUndefined();
  expect(only?.judgement.closed).toBe(false);
  expect(
    published?.gaps.some((g) => g.payload.kind === "approval-withheld") ||
      read.gaps.some((g) => g.payload.kind === "approval-withheld"),
  ).toBe(true);
});
