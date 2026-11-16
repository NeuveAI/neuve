// Why: a file Linguist's lists mark (the `linguist` reader's suggestions, which carry `standard`)
// skips the model readings (decision 14.18), so Map must exclude it with the right reason and the
// `by` that decided it, below a lockfile name and a repository declaration; the decision must carry
// that `by` into the entry it writes, with today's lane for an excluded file; and the change facts
// must not say the repository declared what only Linguist marked.
import { expect, test } from "bun:test";
import { changeFacts } from "../src/change-facts.ts";
import type { Suggestion } from "../src/declarations.ts";
import { decideSection, OUTCOMES } from "../src/readings/decide.ts";
import { buildMapManifest, mapExclusion } from "../src/review-map.ts";
import { inputFor } from "./fixtures/readings.ts";
import { hunk, manifest } from "./fixtures/map-manifest.ts";

const REPOSITORY: Suggestion = {
  kind: "generated",
  by: "gitattributes: linguist-generated=true",
};
const LINGUIST_GENERATED: Suggestion = {
  kind: "generated",
  by: "linguist v9.7.0 generated: minified_files?",
  standard: "linguist-generated",
};
const LINGUIST_VENDORED: Suggestion = {
  kind: "generated",
  by: "linguist v9.7.0 vendored: (^|/)dist/",
  standard: "linguist-vendored",
};

const declared = (path: string, list: ReadonlyArray<Suggestion>) => ({
  ...hunk(path),
  declared: [...list],
});

test("mapExclusion: a lockfile name first, then the repository's declaration, then Linguist's generated list before its vendored list", () => {
  // A lockfile that Linguist also marks stays a lockfile.
  expect(
    mapExclusion("bun.lock", [declared("bun.lock", [LINGUIST_GENERATED])]),
  ).toBe("lockfile");
  // A repository declaration wins over Linguist's marks, in either order.
  expect(
    mapExclusion("dist/app.js", [
      declared("dist/app.js", [
        LINGUIST_VENDORED,
        LINGUIST_GENERATED,
        REPOSITORY,
      ]),
    ]),
  ).toBe("declared-generated");
  expect(
    mapExclusion("dist/app.js", [
      declared("dist/app.js", [LINGUIST_VENDORED, LINGUIST_GENERATED]),
    ]),
  ).toBe("linguist-generated");
  expect(
    mapExclusion("dist/out.txt", [
      declared("dist/out.txt", [LINGUIST_VENDORED]),
    ]),
  ).toBe("linguist-vendored");
  // A test or documentation declaration excludes nothing.
  expect(
    mapExclusion("src/a.ts", [
      declared("src/a.ts", [
        { kind: "test", by: "package-scripts-bun-test: x" },
      ]),
    ]),
  ).toBeUndefined();
});

test("buildMapManifest: the two new reasons with the `by` of the suggestion that decided; a lockfile keeps the repository's `by` or its name, never Linguist's", () => {
  const m = buildMapManifest(
    manifest([
      declared("bun.lock", [LINGUIST_GENERATED]),
      declared("nested/bun.lock", [REPOSITORY, LINGUIST_GENERATED]),
      declared("dist/app.js", [
        LINGUIST_VENDORED,
        LINGUIST_GENERATED,
        REPOSITORY,
      ]),
      declared("dist/out.txt", [LINGUIST_VENDORED]),
      declared("web/app.js", [LINGUIST_VENDORED, LINGUIST_GENERATED]),
      hunk("src/a.ts"),
    ]),
  );
  expect(
    m.excluded.map((entry) => [entry.path, entry.reason, entry.by]),
  ).toEqual([
    ["bun.lock", "lockfile", "lockfile name"],
    ["dist/app.js", "declared-generated", REPOSITORY.by],
    ["dist/out.txt", "linguist-vendored", LINGUIST_VENDORED.by],
    ["nested/bun.lock", "lockfile", REPOSITORY.by],
    ["web/app.js", "linguist-generated", LINGUIST_GENERATED.by],
  ]);
  expect(m.entries.map((entry) => entry.path)).toEqual(["src/a.ts"]);
});

test("decide: an excluded file of either new reason is settled with no reading and today's lane; `by` is carried into the entry when given, and left out when not", () => {
  for (const reason of ["linguist-generated", "linguist-vendored"] as const) {
    expect(OUTCOMES.some((row) => row.excluded === reason)).toBe(true);
    const withBy = decideSection(
      inputFor({ excluded: reason, excludedBy: LINGUIST_VENDORED.by }),
    );
    const without = decideSection(inputFor({ excluded: reason }));
    if (!withBy.settled || !without.settled)
      throw new Error("expected a settled section");
    expect(withBy.entry.excluded).toEqual({ reason, by: LINGUIST_VENDORED.by });
    expect(without.entry.excluded).toEqual({ reason });
    for (const entry of [withBy.entry, without.entry]) {
      expect(entry.assess).toBeNull();
      expect(entry.review).toBeNull();
      expect(entry.verdict).toBeNull();
      expect(entry.undecided).toBeUndefined();
      expect(entry.lane.applied).toBe("human-suggested");
    }
  }
});

const factsOf = (byPath: ReadonlyMap<string, ReadonlyArray<Suggestion>>) => {
  const hunks = [...byPath.keys()].map((path) => hunk(path));
  return changeFacts(hunks, { byPath }, 4);
};
const statementOf = (
  facts: ReturnType<typeof factsOf>,
  id: string,
): string | undefined => facts.find((fact) => fact.id === id)?.statement;

test("change facts: the repository's declaration keeps its words; a file only Linguist marks is Linguist's; one with both says both", () => {
  const facts = factsOf(
    new Map<string, ReadonlyArray<Suggestion>>([
      ["own.ts", [REPOSITORY]],
      ["web/app.js", [LINGUIST_GENERATED]],
      ["dist/app.js", [LINGUIST_GENERATED, LINGUIST_VENDORED]],
      ["both.js", [REPOSITORY, LINGUIST_VENDORED]],
    ]),
  );
  expect(statementOf(facts, "file:own.ts.declared-generated")).toBe(
    `the repository declares it generated (${REPOSITORY.by})`,
  );
  expect(statementOf(facts, "file:web/app.js.declared-generated")).toBe(
    `GitHub Linguist's generated list marks it (${LINGUIST_GENERATED.by})`,
  );
  expect(statementOf(facts, "file:dist/app.js.declared-generated")).toBe(
    `GitHub Linguist's generated and vendored lists mark it (${LINGUIST_GENERATED.by}; ${LINGUIST_VENDORED.by})`,
  );
  expect(statementOf(facts, "file:both.js.declared-generated")).toBe(
    `the repository declares it generated (${REPOSITORY.by}), and GitHub Linguist's vendored list marks it (${LINGUIST_VENDORED.by})`,
  );
  // The value still cites every suggestion, as before.
  expect(
    facts.find((fact) => fact.id === "file:both.js.declared-generated")?.value,
  ).toEqual([REPOSITORY.by, LINGUIST_VENDORED.by]);
  // The range: the count says how many only Linguist's lists mark.
  expect(statementOf(facts, "range.declared-generated-files")).toBe(
    "4 changed files declared generated by the repository or marked by GitHub Linguist's lists (2 by Linguist's lists alone)",
  );
});

test("change facts: with no Linguist mark the range's words are what they were", () => {
  const facts = factsOf(
    new Map<string, ReadonlyArray<Suggestion>>([["own.ts", [REPOSITORY]]]),
  );
  expect(statementOf(facts, "range.declared-generated-files")).toBe(
    "1 changed file declared generated by the repository",
  );
});
