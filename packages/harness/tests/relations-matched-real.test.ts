// This runs against the real engine's `snapshot --commit`, where it is built (`bun run build:graph`),
// on the shared relations fixture.
import { expect, test } from "bun:test";
import {
  RELATIONS_FIXTURE_TIMEOUT_MS,
  findRow,
  relation,
  relationsGraph,
  shownCallers,
  sliceSymbol,
  useRelationsFixture,
} from "./fixtures/relations-real-fixture.ts";

const fixture = useRelationsFixture();

// Why: the match class is read from the engine's own resolution, so it must be proved on what the
// engine really gives: one call it resolves through an import, one it matches by the receiver's
// type, and one it matches by name alone, each into a changed symbol. And the support rule's one
// name-only exclusion, a TypeScript receiver call matched to a method of the caller's own file,
// must hold on a match the engine really makes: not kept, and counted.
test.skipIf(relationsGraph.skip)(
  "on the real engine, a resolved, a receiver-type and a name-only call into changed symbols each say how they were matched, and a same-file name-only method match is counted, not kept",
  async () => {
    relationsGraph.require();
    const slices = await fixture.slices();
    const rows = (subject: string, side: "base" | "head", id: string) =>
      shownCallers(sliceSymbol(slices, subject, side, relation(id).target)).map(
        (caller) => [caller.caller.path, caller.matched, caller.support],
      );
    for (const side of ["base", "head"] as const) {
      // `total`: resolved through an import, and by name only through a dynamic import.
      expect(
        rows("total", side, "summary-total").filter(
          ([path]) =>
            path === "packages/direct/src/report.ts" ||
            path === "packages/direct/src/late.ts",
        ),
      ).toEqual([
        ["packages/direct/src/report.ts", "resolved", "resolved"],
        ["packages/direct/src/late.ts", "name-only", "import-backed"],
      ]);
      expect(
        sliceSymbol(slices, "total", side, relation("summary-total").target)
          ?.callers,
      ).toMatchObject({ total: 5, trusted: 4 });
      // `bump`: by the receiver's type from another file and from its own class.
      const bump = sliceSymbol(
        slices,
        "bump",
        side,
        relation("tally-bump").target,
      );
      expect(rows("bump", side, "tally-bump")).toEqual([
        ["packages/direct/src/counter.ts", "receiver-type", "import-backed"],
        ["packages/direct/src/report.ts", "receiver-type", "import-backed"],
      ]);
      expect(bump?.callers).toMatchObject({ total: 2, trusted: 2 });
      // The receiver-type caller in its own class changes too, so its edge is a changed edge.
      expect(
        bump?.changedEdges.map((edge) => [edge.direction, edge.matched]),
      ).toEqual([["in", "receiver-type"]]);
      // `other.bump()` on an untyped receiver in the same file: matched by name only, not kept.
      expect(findRow(slices, relation("peek-bump"), side)).toBeUndefined();
      expect(bump?.unsupportedMatchesNotUsed).toBe(1);
    }
  },
  RELATIONS_FIXTURE_TIMEOUT_MS,
);
