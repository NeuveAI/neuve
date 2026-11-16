// Why: the readers lane will store four new keys on a section's judgement entry (what produced it,
// the code rules it rests on, the pattern it shares, that it is context of its file's unit), and
// Records decodes every stored entry with this one schema. Each must be kept as stored, an entry
// written before them must read exactly as it did, and a value that would make a read costly or
// is not one of these shapes must make that one entry undecoded rather than be counted or printed.
import { expect, test } from "bun:test";
import { AssessedSection, MAX_ENTRY_RULES } from "@neuve/records-schema";

const entry = {
  key: "a".repeat(64),
  assess: null,
  review: null,
  lane: {
    judged: "static-automation",
    surfaced: "static-automation",
    floors: [],
    applied: "static-automation",
  },
  lineage: "fresh",
};

const rule = {
  rule: "imports-only",
  version: 1,
  inputs: { imports: [2, { nested: null }] },
  result: { holds: true },
  reason: "Only import lines change.",
  statement: "imports only",
  by: "sections",
};

test("an entry keeps origin, rules, family and context as stored, and one without them reads unchanged", () => {
  const treated = {
    ...entry,
    origin: { assess: "rule", review: "none", note: "kept" },
    rules: [rule, { rule: "whitespace-only", version: 3 }],
    family: {
      key: "f".repeat(64),
      representative: "b".repeat(64),
      reading: `computation:${"c".repeat(64)}`,
      members: 4,
      extra: [1],
    },
    context: true,
  };
  const read = AssessedSection.safeParse(treated);
  expect(read.success).toBe(true);
  expect(read.data as unknown).toEqual(treated);

  // The family's optional keys may be absent, as on a member written without them.
  expect(
    AssessedSection.safeParse({
      ...entry,
      family: { key: "k", representative: "r" },
    }).success,
  ).toBe(true);

  const plain = AssessedSection.safeParse(entry);
  expect(plain.success).toBe(true);
  expect(plain.data as unknown).toEqual(entry);
  for (const name of ["origin", "rules", "family", "context"])
    expect(name in plain.data!).toBe(false);
});

test("a value outside the four shapes, or past the bound on rules, refuses the entry", () => {
  const reads = (extra: Record<string, unknown>) =>
    AssessedSection.safeParse({ ...entry, ...extra }).success;
  // A rule name is an open lower-case name of at most 32 characters, as a cause is.
  expect(reads({ rules: [{ ...rule, rule: "Imports Only" }] })).toBe(false);
  expect(reads({ rules: [{ ...rule, rule: `a${"b".repeat(32)}` }] })).toBe(
    false,
  );
  expect(reads({ rules: [{ ...rule, rule: `a${"b".repeat(31)}` }] })).toBe(
    true,
  );
  // A version is a whole number from 1.
  expect(reads({ rules: [{ ...rule, version: 0 }] })).toBe(false);
  expect(reads({ rules: [{ ...rule, version: 1.5 }] })).toBe(false);
  expect(reads({ rules: [{ rule: "imports-only" }] })).toBe(false);
  // At most MAX_ENTRY_RULES rules, each printed and counted wherever the entry is read.
  expect(reads({ rules: Array(MAX_ENTRY_RULES).fill(rule) })).toBe(true);
  expect(reads({ rules: Array(MAX_ENTRY_RULES + 1).fill(rule) })).toBe(false);
  // The origin's words are open names too, and both are given.
  expect(reads({ origin: { assess: "rule" } })).toBe(false);
  expect(reads({ origin: { assess: "Rule!", review: "none" } })).toBe(false);
  // A family names its key and representative; members is a whole number from 1.
  expect(reads({ family: { key: "k" } })).toBe(false);
  expect(reads({ family: { key: "k", representative: "r", members: 0 } })).toBe(
    false,
  );
  // Context is only ever true; false is not a stored value.
  expect(reads({ context: false })).toBe(false);
  expect(reads({ context: "yes" })).toBe(false);
});

test("combinations only the publisher refuses still read, so a stored entry keeps its trail", () => {
  // Not decided and kept as context, or excluded with a rule: a writer's error the publisher
  // refuses; on read the entry is kept as stored.
  expect(
    AssessedSection.safeParse({
      ...entry,
      lane: { ...entry.lane, applied: "human-required" },
      undecided: { cause: "failed", reading: "assess" },
      context: true,
      origin: { assess: "rule", review: "none" },
    }).success,
  ).toBe(true);
  expect(
    AssessedSection.safeParse({
      ...entry,
      excluded: { reason: "lockfile" },
      rules: [rule],
      family: { key: "k", representative: "r" },
    }).success,
  ).toBe(true);
});
