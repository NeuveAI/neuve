// The shared relations fixture's own proof, on the real engine (`bun run build:graph`): every
// expectation it records is what the engine gives.
import { expect, test } from "bun:test";
import {
  DELETIONS,
  EXPECTED_RELATIONS,
  FIXTURE_FILES,
  OLDER_RELATIONS_ENGINE,
  RELATIONS_FIXTURE_TIMEOUT_MS,
  UNCALLED,
  callSiteLineLanguages,
  callSitesToday,
  declarationSpan,
  declarationsIn,
  expectCallLine,
  findRow,
  relation,
  relationsGraph,
  shownCallers,
  sliceSymbol,
  subjects,
  useRelationsFixture,
  type Side,
} from "./fixtures/relations-real-fixture.ts";

const fixture = useRelationsFixture();
const sides = ["base", "head"] as const;

/** The changed lines of the diff, per side and path, from `git diff -U0`. */
const diffLines = () => {
  const found = {
    old: new Map<string, number[]>(),
    new: new Map<string, number[]>(),
  };
  let oldPath = "";
  let newPath = "";
  for (const line of fixture
    .git("diff", "-U0", "--no-renames", fixture.base, fixture.head)
    .split("\n")) {
    if (line.startsWith("--- ")) oldPath = line.slice(6);
    else if (line.startsWith("+++ ")) newPath = line.slice(6);
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk === null) continue;
    const add = (
      side: "old" | "new",
      path: string,
      start: number,
      count: number,
    ) => {
      const list = found[side].get(path) ?? [];
      for (let at = 0; at < count; at++) list.push(start + at);
      found[side].set(path, list);
    };
    add("old", oldPath, Number(hunk[1]), Number(hunk[2] ?? 1));
    add("new", newPath, Number(hunk[3]), Number(hunk[4] ?? 1));
  }
  return found;
};

// Why: a consumer asserts on these shapes without reading the engine; they must hold of the
// repository as committed, so the fixture cannot drift from its own data.
test("the fixture's repository: a merge base behind the base branch's tip, subjects that are exactly the diff, and test files by the repository's own declarations", async () => {
  expect(fixture.base).not.toBe(fixture.baseTip);
  expect(fixture.git("merge-base", fixture.baseTip, fixture.head)).toBe(
    fixture.base,
  );
  expect(fixture.git("rev-parse", "HEAD")).toBe(fixture.baseTip);
  expect(fixture.git("rev-parse", `${fixture.head}^{tree}`)).toBe(
    fixture.headTree,
  );
  for (const side of sides)
    for (const [path, text] of Object.entries(FIXTURE_FILES[side]))
      expect(
        fixture.git(
          "show",
          `${side === "base" ? fixture.base : fixture.head}:${path}`,
        ),
      ).toBe(text.trimEnd());

  const fromSubjects = {
    old: new Map<string, number[]>(),
    new: new Map<string, number[]>(),
  };
  for (const subject of subjects) {
    expect(subject.ranges.length).toBeGreaterThan(0);
    for (const range of subject.ranges) {
      const list = fromSubjects[range.side].get(range.path) ?? [];
      for (let at = 0; at < range.lineCount; at++)
        list.push(range.startLine + at);
      fromSubjects[range.side].set(range.path, list);
    }
  }
  const sorted = (map: Map<string, number[]>) =>
    Object.fromEntries(
      [...map]
        .map(([path, list]) => [path, [...list].sort((a, b) => a - b)] as const)
        .filter(([, list]) => list.length > 0)
        .sort(([a], [b]) => (a < b ? -1 : 1)),
    );
  const diff = diffLines();
  expect(sorted(fromSubjects.old)).toEqual(sorted(diff.old));
  expect(sorted(fromSubjects.new)).toEqual(sorted(diff.new));
  // Each removal is its own hunk on the old side only.
  for (const { subject } of Object.values(DELETIONS)) {
    const ranges = subjects.find((entry) => entry.key === subject)?.ranges;
    expect(ranges?.map((range) => range.side)).toEqual(["old"]);
  }

  const tests = await fixture.tests();
  for (const side of sides) {
    expect(tests[side]("packages/direct/tests/math.test.ts")).toBe(true);
    expect(tests[side]("packages/wrapped/tests/wrapped.test.ts")).toBe(false);
    expect(tests[side]("packages/direct/src/math.ts")).toBe(false);
  }
  for (const expected of EXPECTED_RELATIONS)
    for (const side of expected.sides)
      expect([expected.id, tests[side](expected.callerPath)]).toEqual([
        expected.id,
        expected.test,
      ]);

  // Every marked call line names its callee, called there (or passed by name, for a reference), and
  // lies inside its caller: a symbol caller's own lines, or, for a file-level caller, outside every
  // declaration of its file. Without this a marker moved to a wrong line would pass, and every
  // call-line assertion on the engine would check the wrong number.
  for (const expected of EXPECTED_RELATIONS)
    for (const side of expected.sides) {
      const line = expected.lines[side]?.call ?? 0;
      const text = (FIXTURE_FILES[side][expected.callerPath] ?? "")
        .split("\n")
        [line - 1]?.replace(/\s(?:\/\/|#)\s*[a-z-]+:[\w.-]+.*$/, "");
      const name = expected.target.name;
      const called = new RegExp(`\\b${name}\\s*\\(`).test(text ?? "");
      const passed = new RegExp(`\\(\\s*${name}\\s*\\)`).test(text ?? "");
      const named: boolean =
        expected.shows === "call" ? called : passed && !called;
      expect([expected.id, side, named]).toEqual([expected.id, side, true]);
      if (expected.caller.kind === "symbol") {
        const span = declarationSpan(side, expected.caller.def);
        expect([expected.id, side, span.path]).toEqual([
          expected.id,
          side,
          expected.callerPath,
        ]);
        expect([
          expected.id,
          side,
          span.start <= line && line <= span.end,
        ]).toEqual([expected.id, side, true]);
      } else
        for (const def of declarationsIn(side, expected.callerPath)) {
          const span = declarationSpan(side, def);
          expect([
            expected.id,
            side,
            def,
            span.start <= line && line <= span.end,
          ]).toEqual([expected.id, side, def, false]);
        }
    }
});

// Why: the fixture's whole value is that its recorded answers are the engine's, so a consumer's
// test on it says something true; each kept edge must be a row and no other row may appear.
test.skipIf(relationsGraph.skip)(
  "on the real engine, every expected relation is the row the slice gives, with its match class, test flag and site, and no other row appears",
  async () => {
    relationsGraph.require();
    const prepared = await fixture.prepared();
    expect(["computed", "stored"]).toContain(prepared.outcomes.base);
    expect(["computed", "stored"]).toContain(prepared.outcomes.head);
    expect(prepared.base.coverage.commit).toBe(fixture.base);
    expect(prepared.head.coverage.commit).toBe(fixture.head);
    expect(prepared.head.coverage.tree).toBe(fixture.headTree);
    for (const language of ["TypeScript", "Python", "Go"])
      expect(prepared.head.coverage.languageTiers[language]).toBe("semantic");
    expect(prepared.head.coverage.partialFailures).toEqual([]);
    // The index keeps what the read's engine declared, the same as the engine says directly, and
    // this engine places calls in all three languages of the fixture.
    for (const side of [prepared.base, prepared.head])
      expect(side.coverage.callSiteLineLanguages).toEqual([
        ...callSiteLineLanguages(),
      ]);
    expect(callSiteLineLanguages()).toEqual(
      expect.arrayContaining(["TypeScript", "Python", "Go"]),
    );
    const slices = await fixture.slices();
    const claims: Record<string, string> = {};
    for (const expected of EXPECTED_RELATIONS)
      for (const side of expected.sides) {
        const target = sliceSymbol(
          slices,
          expected.subject,
          side,
          expected.target,
        );
        expect([expected.id, side, target?.symbol.name]).toEqual([
          expected.id,
          side,
          expected.target.name,
        ]);
        const row = findRow(slices, expected, side);
        if (expected.engine.edge === "none") {
          expect([expected.id, side, row]).toEqual([
            expected.id,
            side,
            undefined,
          ]);
          continue;
        }
        expect([
          expected.id,
          side,
          row?.matched,
          row?.test,
          row?.family,
        ]).toEqual([
          expected.id,
          side,
          expected.engine.matched,
          expected.test,
          expected.family,
        ]);
        claims[`${expected.id}@${side}`] = expectCallLine(row, expected, side);
      }
    // Every shown row of every expected target is an expectation.
    const targets = new Map<string, (typeof EXPECTED_RELATIONS)[number]>();
    for (const expected of EXPECTED_RELATIONS)
      for (const side of expected.sides)
        targets.set(
          `${expected.subject}\0${expected.target.def}\0${side}`,
          expected,
        );
    for (const [key, expected] of targets) {
      const side = key.split("\0")[2] as Side;
      const rows = shownCallers(
        sliceSymbol(slices, expected.subject, side, expected.target),
      ).map(
        (row) =>
          `${row.caller.path}:${row.caller.kind === "file" ? "file" : row.caller.symbol?.name}`,
      );
      const wanted = EXPECTED_RELATIONS.filter(
        (other) =>
          other.target.def === expected.target.def &&
          other.engine.edge === "kept" &&
          other.sides.includes(side),
      ).map(
        (other) =>
          `${other.callerPath}:${other.caller.kind === "file" ? "file" : other.caller.name}`,
      );
      expect([key, rows.sort()]).toEqual([key, wanted.sort()]);
    }
    console.info(
      JSON.stringify({
        relationsFixtureRead: {
          wallMs: Math.round(prepared.wallMs),
          outcomes: prepared.outcomes,
          callSiteLineLanguages: callSiteLineLanguages(),
          claims,
          sites: callSitesToday(),
        },
      }),
    );
  },
  RELATIONS_FIXTURE_TIMEOUT_MS,
);

// Why: the sections lane's deletion rules and the readers lane's evidence read these exact states,
// so each is pinned on the engine's answer.
test.skipIf(relationsGraph.skip)(
  "on the real engine, the three removals, the symbols with no caller, the counterparts, two members of one name, the counts and the changed edges are as recorded",
  async () => {
    relationsGraph.require();
    const slices = await fixture.slices();
    const at = (subject: string, side: Side, name: string, def: string) =>
      sliceSymbol(slices, subject, side, { name, def });
    const pointing = (entry: ReturnType<typeof at>) =>
      entry?.stillPointingOnBase === undefined
        ? undefined
        : entry.stillPointingOnBase.evidence === "none"
          ? "none"
          : entry.stillPointingOnBase.shown.map((row) => [
              row.caller.path,
              row.matched,
            ]);

    const stays = at(DELETIONS.callerStays.subject, "base", "old", "old");
    expect(stays?.counterpart.rule).toBe("none");
    expect(pointing(stays)).toEqual([
      ["packages/direct/src/keep.ts", "resolved"],
    ]);
    // Its other caller was removed with it, so it is changed, not still pointing.
    expect(findRow(slices, relation("useOld-old"), "base")?.changedIn).toEqual([
      "drop-old-caller",
    ]);
    const nameOnly = at(
      DELETIONS.onlyNameOnly.subject,
      "base",
      "ghost",
      "ghost",
    );
    expect(nameOnly?.counterpart.rule).toBe("none");
    expect(pointing(nameOnly)).toEqual([
      ["packages/direct/src/keep.ts", "name-only"],
    ]);
    expect(nameOnly?.stillPointingOnBase).toMatchObject({
      total: 1,
      trusted: 0,
    });
    const none = at(DELETIONS.noCaller.subject, "base", "lonely", "lonely");
    expect(none?.counterpart.rule).toBe("none");
    expect(pointing(none)).toBe("none");
    for (const { subject } of Object.values(DELETIONS))
      expect(
        slices.find((entry) => entry.key === subject)?.head.symbols,
      ).toEqual([]);

    for (const uncalled of UNCALLED)
      for (const side of uncalled.sides)
        expect([
          uncalled.def,
          side,
          at(uncalled.subject, side, uncalled.name, uncalled.def)?.callers,
        ]).toEqual([uncalled.def, side, { evidence: "none" }]);

    expect(at("total", "head", "total", "total")?.counterpart.rule).toBe(
      "same-id",
    );
    expect(at("bump", "head", "bump", "Counter.bump")?.counterpart.rule).toBe(
      "same-id",
    );
    expect(at("bump", "base", "reset", "Counter.reset")?.counterpart.rule).toBe(
      "none",
    );
    expect(at("rename", "base", "before", "before")?.counterpart.rule).toBe(
      "none",
    );
    expect(at("rename", "head", "after", "after")?.counterpart.rule).toBe(
      "none",
    );
    expect(at("add-fresh", "head", "fresh", "fresh")?.counterpart.rule).toBe(
      "none",
    );
    // The removed method and the changed one are one hunk block, so one range.
    expect(
      slices
        .find((entry) => entry.key === "bump")
        ?.base.ranges.map((range) => range.match),
    ).toEqual(["symbol"]);

    // A getter and a setter of one name: the setter is changed and is the only one listed.
    for (const side of sides) {
      const named = slices
        .find((entry) => entry.key === "size")
        ?.[side].symbols.filter((entry) => entry.symbol.name === "size");
      expect(named?.length).toBe(1);
      expect(named?.[0]?.symbol.startLine).toBe(
        at("size", side, "size", "Counter.size-set")?.symbol.startLine,
      );
    }

    for (const side of sides) {
      // Every trusted caller here shows its place: the call in a test callback and the Python call
      // under `__main__` included.
      const total = at("total", side, "total", "total");
      expect(total?.callers).toMatchObject({
        evidence: "supported",
        total: 5,
        trusted: 4,
        placed: 4,
      });
      expect(total?.testCallers).toEqual({
        evidence: "supported",
        total: 2,
        trusted: 2,
        placed: 2,
      });
      expect(total?.unsupportedMatchesNotUsed).toBe(1);
      const fact = at("fact", side, "fact", "fact");
      expect(fact?.callers).toMatchObject({
        evidence: "supported",
        total: 2,
        trusted: 2,
        placed: 2,
      });
      expect(fact?.testCallers).toEqual({
        evidence: "supported",
        total: 1,
        trusted: 1,
        placed: 1,
      });
      const double = at("double", side, "double", "double");
      expect(double?.callers).toMatchObject({
        evidence: "supported",
        total: 1,
        trusted: 1,
        placed: 1,
      });
      const bump = at("bump", side, "bump", "Counter.bump");
      expect(bump?.unsupportedMatchesNotUsed).toBe(1);
      expect(
        bump?.changedEdges.map((edge) => [
          edge.direction,
          edge.matched,
          edge.other.subjects,
        ]),
      ).toEqual([["in", "receiver-type", ["twice"]]]);
      const push = at("Push", side, "Push", "Acc.Push");
      expect(push?.callers).toMatchObject({
        evidence: "supported",
        total: 2,
        trusted: 1,
      });
    }
    expect(
      at("add-fresh", "head", "fresh", "fresh")?.changedEdges.map((edge) => [
        edge.direction,
        edge.matched,
        edge.other.subjects,
      ]),
    ).toEqual([["in", "resolved", ["add-fresh-call"]]]);
    // A file-level caller with its call line is changed only by a range over that line, and none
    // covers `run()` under `__main__`; the two ranges in its file (`step`, `run`) do not.
    for (const side of sides)
      expect(findRow(slices, relation("main-run"), side)?.changedIn).toEqual(
        [],
      );
  },
  RELATIONS_FIXTURE_TIMEOUT_MS,
);

// Why: an engine from before call lines must never have its lines read as calls: every row of the
// same fixture shows `caller`, with the calling function's first line or none, no count says a
// place is shown, and a file-level caller's change falls back to any range in its file.
test.skipIf(relationsGraph.skip || OLDER_RELATIONS_ENGINE === null)(
  "read by an engine without call lines, every row shows the caller and no place",
  async () => {
    relationsGraph.require();
    const older = OLDER_RELATIONS_ENGINE;
    if (older === null) throw new Error("no older engine");
    const prepared = await fixture.prepared(older);
    expect(prepared.base.coverage.callSiteLineLanguages).toEqual([]);
    expect(prepared.head.coverage.callSiteLineLanguages).toEqual([]);
    expect(prepared.head.coverage.provider.executable.sha256).not.toBe(
      (await fixture.prepared()).head.coverage.provider.executable.sha256,
    );
    const slices = await fixture.slices(older);
    let rows = 0;
    for (const slice of slices)
      for (const side of sides)
        for (const symbol of slice[side].symbols) {
          for (const callers of [symbol.callers, symbol.stillPointingOnBase])
            if (callers?.evidence === "supported") {
              expect(callers.placed).toBe(0);
              for (const row of callers.shown) {
                rows++;
                expect(row.site?.shows).toBe("caller");
              }
            }
          if (symbol.testCallers.evidence === "supported")
            expect(symbol.testCallers.placed).toBe(0);
        }
    expect(rows).toBeGreaterThan(0);
    for (const expected of EXPECTED_RELATIONS)
      for (const side of expected.sides) {
        if (expected.engine.edge === "none") continue;
        const row = findRow(slices, expected, side);
        expect(expectCallLine(row, expected, side, [])).toBe(
          "no-call-line-claimed",
        );
      }
    // With no line, any range in its file marks the `__main__` caller changed.
    expect(findRow(slices, relation("main-run"), "head")?.changedIn).toEqual([
      "step",
      "run",
    ]);
  },
  RELATIONS_FIXTURE_TIMEOUT_MS,
);
