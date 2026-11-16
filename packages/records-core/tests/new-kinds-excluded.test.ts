// Why: the readers lane stores an entry for a lockfile, a declared-generated file or a file
// Linguist's lists mark with `excluded` and no reading, and Records decodes every stored entry with
// this one schema. It must keep `excluded`, its `by` and its unknown keys, still read an entry
// without it or without `by` (stored before decision 14.18), read a reason a later build may add
// (the name is open, so an older build still decodes it) while refusing one that is not a name,
// and not refuse an entry that also holds `undecided`, which only the publisher may refuse: on
// read it would cost the section its trail.
import { expect, test } from "bun:test";
import { AssessedSection } from "@neuve/records-schema";

const entry = {
  key: "a".repeat(64),
  assess: null,
  review: null,
  lane: {
    judged: null,
    surfaced: null,
    floors: [],
    applied: "human-suggested",
  },
  lineage: "fresh",
};

test("a judgement entry reads with `excluded`, with and without `by`, without it, and with a reason the comment does not list", () => {
  const excluded = AssessedSection.safeParse({
    ...entry,
    excluded: { reason: "declared-generated", by: "gitattributes" },
  });
  expect(excluded.success).toBe(true);
  expect(excluded.data?.excluded).toEqual({
    reason: "declared-generated",
    by: "gitattributes",
  });
  expect(
    AssessedSection.safeParse({ ...entry, excluded: { reason: "lockfile" } })
      .success,
  ).toBe(true);

  const plain = AssessedSection.safeParse(entry);
  expect(plain.success).toBe(true);
  expect(plain.data !== undefined && "excluded" in plain.data).toBe(false);

  // The two reasons of Linguist's lists, each with the rule or pattern that fired.
  for (const [reason, by] of [
    [
      "linguist-generated",
      "linguist v9.7.0 generated: generated_protocol_buffer?",
    ],
    ["linguist-vendored", "linguist v9.7.0 vendored: (^|/)node_modules/"],
  ] as const) {
    const parsed = AssessedSection.safeParse({
      ...entry,
      excluded: { reason, by },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.excluded).toEqual({ reason, by });
  }

  // An open name: a reason no build writes today still reads; one that is not a name does not.
  expect(
    AssessedSection.safeParse({ ...entry, excluded: { reason: "vendored" } })
      .success,
  ).toBe(true);
  expect(
    AssessedSection.safeParse({ ...entry, excluded: { reason: "Not A Name" } })
      .success,
  ).toBe(false);
  expect(
    AssessedSection.safeParse({
      ...entry,
      excluded: { reason: "lockfile", by: 7 },
    }).success,
  ).toBe(false);
  expect(AssessedSection.safeParse({ ...entry, excluded: {} }).success).toBe(
    false,
  );

  // Both at once is a writer's error the read schema keeps as stored.
  expect(
    AssessedSection.safeParse({
      ...entry,
      lane: { ...entry.lane, applied: "human-required" },
      excluded: { reason: "lockfile" },
      undecided: { cause: "failed", reading: "assess" },
    }).success,
  ).toBe(true);
});
