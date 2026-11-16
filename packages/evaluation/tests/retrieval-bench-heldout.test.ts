import { expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  buildHunkGold,
  keepCrossFamily,
  type RawGoldItem,
} from "../src/retrieval-bench/score/gold.ts";
import {
  frozenFromDevReport,
  frozenSetting,
} from "../src/retrieval-bench/score/frozen.ts";

const devReportPath = resolve(
  import.meta.dir,
  "fixtures/frozen-dev-choices.json",
);

// Held-out (9.58) must select and tune nothing: every dev choice is read back from the committed dev
// report. A held-out run that re-selected an arm or re-tuned a variant would still produce plausible
// numbers, so the regression would be silent. These tests pin that the reader returns dev's recorded
// choices exactly and refuses a report it cannot read them from, rather than falling back.

test("the frozen configuration is dev's recorded selection and settings", async () => {
  const text = await Bun.file(devReportPath).text();
  const report = JSON.parse(text);
  const frozen = frozenFromDevReport(text, devReportPath);
  expect(frozen.selection).toEqual({
    bestDense: report.selection.bestDense,
    bestFusion: report.selection.bestFusion,
    bestTopology: report.selection.bestTopology,
  });
  expect(frozen.settings).toEqual(report.settings);
  expect(frozen.variants.size).toBe(report.variants.list.length);
  for (const entry of report.variants.list)
    expect(frozenSetting(frozen, entry.arm, entry.of)).toEqual(
      entry.tuning?.chosen ?? null,
    );
});

test("a dev report without a readable choice is refused, never re-derived", async () => {
  const report = JSON.parse(await Bun.file(devReportPath).text());
  const without = (mutate: (copy: typeof report) => void) => {
    const copy = structuredClone(report);
    mutate(copy);
    return JSON.stringify(copy);
  };
  expect(() =>
    frozenFromDevReport(
      without((copy) => delete copy.selection.bestFusion),
      "x",
    ),
  ).toThrow(/cannot read back|does not record/);
  expect(() =>
    frozenFromDevReport(
      without((copy) => {
        copy.variants.list[0].tuning.chosen = { alpha: 0.25 };
      }),
      "x",
    ),
  ).toThrow(/chosen setting cannot be read back/);
  expect(() =>
    frozenFromDevReport(
      without((copy) => {
        copy.split = "held-out";
      }),
      "x",
    ),
  ).toThrow();
  const frozen = frozenFromDevReport(JSON.stringify(report), "x");
  expect(() => frozenSetting(frozen, "V1(E9)", "E9")).toThrow(
    /held-out never tunes one/,
  );
  expect(() =>
    frozenSetting(frozen, report.variants.list[0].arm, "some other base"),
  ).toThrow(/dev ran it over/);
});

// The cross-family subset is a sensitivity whose definition the owner's coordinator fixed: which
// statuses stand, and that a council decision stands only when both Sol members voted the decided
// grade in the final round. A looser or stricter rule, or a dropped target counted as irrelevant
// instead of unjudged, would shift the sensitivity without any error.

const item = (overrides: Partial<RawGoldItem>): RawGoldItem => ({
  id: "c1",
  source: "pool",
  region: "src/a.ts:1-10",
  kind: "code",
  grade: "necessary",
  status: "agreed",
  availability: "base-committed",
  retrievalTarget: true,
  ...overrides,
});
const council = (
  grade: RawGoldItem["grade"],
  rounds: ReadonlyArray<Record<string, string>>,
) =>
  item({
    grade,
    status: "council-decided",
    owner: { council: { votes: rounds.map((votes) => ({ votes })) } },
  });

test("the cross-family rule keeps agreed, owner and Sol-backed council targets", () => {
  expect(keepCrossFamily(item({}))).toBe(true);
  expect(keepCrossFamily(item({ status: "owner-decided" }))).toBe(true);
  expect(keepCrossFamily(item({ status: "lower-grade" }))).toBe(false);
  expect(keepCrossFamily(item({ status: "council-tie-rule" }))).toBe(false);
  const both = { "sol-medium": "useful", "sol-high": "useful" };
  expect(keepCrossFamily(council("useful", [both]))).toBe(true);
  expect(
    keepCrossFamily(
      council("useful", [{ "sol-medium": "useful", "sol-high": "necessary" }]),
    ),
  ).toBe(false);
  // Only the final round counts.
  expect(
    keepCrossFamily(
      council("useful", [
        both,
        { "sol-medium": "necessary", "sol-high": "useful" },
      ]),
    ),
  ).toBe(false);
  expect(
    keepCrossFamily(
      council("useful", [
        { "sol-medium": "irrelevant", "sol-high": "x" },
        both,
      ]),
    ),
  ).toBe(true);
  expect(keepCrossFamily(item({ status: "council-decided" }))).toBe(false);
  // The rule applies to relevant retrieval targets only.
  expect(
    keepCrossFamily(item({ grade: "misleading", status: "lower-grade" })),
  ).toBe(true);
  expect(
    keepCrossFamily(item({ retrievalTarget: false, status: "lower-grade" })),
  ).toBe(true);
});

test("a dropped target is unjudged, not irrelevant", () => {
  const kept = item({ id: "c1", region: "src/a.ts:1-10" });
  const dropped = council("necessary", [
    { "sol-medium": "useful", "sol-high": "useful" },
  ]);
  const items = [kept, { ...dropped, id: "c2", region: "src/b.ts:1-10" }];
  const gold = buildHunkGold("case", "h", items.filter(keepCrossFamily));
  expect(gold.necessary.map((span) => span.path)).toEqual(["src/a.ts"]);
  expect([...gold.judged.keys()].some((key) => key.includes("src/b.ts"))).toBe(
    false,
  );
});
