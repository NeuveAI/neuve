// Why (NEU-148 WP6, rounds 9 and 13): the readings lift code's missing-evidence gap on caller rows
// alone, only on a trusted row whose line is the call itself or hands the name over (`shows` `call`
// or `reference`), and only from a file a followed declaration classifies as not a test. The lift is
// the behaviour, not a switch (round 13). The coordinator's standing rule
// is that every round consuming the graph lane's data runs the real engine on a real Git repository:
// this file reads the shared real-engine fixture (`useRelationsFixture`), cuts the readings' own
// subjects from a plan of the fixture's diff, and checks each row's line against the fixture's own
// data, never against a number written here.
import { expect, test } from "bun:test";
import { relationSlices, type RelationSlice } from "../src/relations.ts";
import {
  EVIDENCE_RECIPE,
  chooseRows,
  lifts,
  relationSubjects,
  rowLifts,
  type EvidenceRow,
  type SectionEvidence,
} from "../src/readings/evidence.ts";
import { planReadings } from "../src/readings/plan.ts";
import { EVIDENCE_LEGEND, renderReading } from "../src/readings/reading.ts";
import { headTestFilesOf } from "./fixtures/head-test-files.ts";
import { diff, oidOf, symbolStructure } from "./fixtures/readings.ts";
import {
  FIXTURE_FILES,
  RELATIONS_FIXTURE_TIMEOUT_MS,
  declarationSpan,
  relation,
  relationsGraph,
  useRelationsFixture,
} from "./fixtures/relations-real-fixture.ts";

const fixture = useRelationsFixture();

const MATH = "packages/direct/src/math.ts";
const DECLARED = ["total", "double", "unused", "fact"] as const;

/** The fixture's math.ts change as the readings plan it: one section per changed function. */
const planOfMath = () => {
  const hunks = diff(
    MATH,
    FIXTURE_FILES.base[MATH]!,
    FIXTURE_FILES.head[MATH]!,
  );
  const spans = (side: "base" | "head") =>
    [...DECLARED, ...(side === "head" ? (["fresh"] as const) : [])].map(
      (id) => {
        const span = declarationSpan(side, id);
        return {
          start: span.start,
          end: span.end,
          kind: "declaration" as const,
          name: id,
        };
      },
    );
  const structures = new Map(
    (["base", "head"] as const).map((side) => [
      oidOf(FIXTURE_FILES[side][MATH]!),
      symbolStructure(FIXTURE_FILES[side][MATH]!, spans(side)),
    ]),
  );
  const plan = planReadings({ hunks, structures });
  return {
    plan,
    hunks: new Map(hunks.map((hunk) => [hunk.hunkId, hunk])),
    structures,
  };
};

/** A line's text at the head commit, from the fixture's committed sources. */
const lineAt = (path: string, line: number) =>
  FIXTURE_FILES.head[path]?.split("\n")[line - 1] ?? null;

// Reason: the one path that moves work from a person (round 13's lift table), on the real engine
// through the shared fixture, with the test files read as a decision reads them (`testFilesOf`): a
// trusted call from a declared not-test file lifts, a trusted reference lifts, and a `caller` row, a
// name-only row, a test row and an undecided file's trusted call lift nothing. Each row's line is
// checked against the fixture's own data, never against a number written here.
test.skipIf(relationsGraph.skip)(
  "the lift table on the real engine: a trusted call or reference from a declared not-test file lifts; a caller row, a name-only row, a test row and an undecided file's trusted call do not",
  async () => {
    relationsGraph.require();
    const { plan, hunks, structures } = planOfMath();
    const group = plan.groups.find((g) =>
      g.keys.some(
        (key) => plan.sections.find((s) => s.key === key)?.path === MATH,
      ),
    )!;
    const sectionNamed = (name: string) =>
      plan.sections.find((s) => s.path === MATH && s.name === name)!;
    const prepared = await fixture.prepared();
    // The head's files by test status, read as a decision reads them.
    const { files } = await headTestFilesOf(fixture.repository, fixture.head);
    const summary = relation("summary-total");
    const wrapped = relation("wrapped-test-total");
    const direct = relation("check-total");
    expect(files.tests.has(direct.callerPath)).toBe(true);
    expect(files.tests.has(summary.callerPath)).toBe(false);
    expect(files.undecided.has(summary.callerPath)).toBe(false);
    // The wrapper package's script runs another runner: its test-named file is undecided.
    expect(files.undecided.has(wrapped.callerPath)).toBe(true);
    const slices = new Map(
      relationSlices(prepared.round, relationSubjects(plan, hunks), {
        base: () => false,
        head: (path) => files.tests.has(path),
      }).map((slice): [string, RelationSlice] => [slice.key, slice]),
    );
    const sections = chooseRows(
      plan,
      group.id,
      slices,
      lineAt,
      hunks,
      files.undecided,
    );
    const of = (name: string, from = sections): SectionEvidence =>
      from.find((s) => s.key === sectionNamed(name).key)!;

    // total: its caller row is a trusted call from a declared not-test file (report.ts; the
    // undecided wrapped test file is tried after it), at the call's own line, and it lifts.
    const total = of("total");
    const caller = total.rows.find((row) => row.kind === "caller")!;
    expect(caller).toMatchObject({
      symbol: "total",
      path: summary.callerPath,
      shows: "call",
      line: summary.lines.head!.call,
      text: lineAt(caller.path, summary.lines.head!.call)!.trim().slice(0, 160),
      confirmed: true,
    });
    expect(caller.undecided).toBeUndefined();
    expect(rowLifts(caller)).toBe(true);
    expect(total.relations).toBe("shown");
    // Its test row is a declared test file's, context only.
    const testRow = total.rows.find((row) => row.kind === "test")!;
    expect(testRow.path).toBe(direct.callerPath);
    expect(testRow.confirmed).toBe(true);
    expect(rowLifts(testRow)).toBe(false);

    // double: the one trusted caller hands it over by name (`xs.map(double)`): a reference, at the
    // line the fixture marks, which lifts as a call does.
    const double = of("double");
    const reference = relation("summary-double");
    const used = double.rows.find((row) => row.kind === "caller")!;
    expect(used).toMatchObject({
      path: reference.callerPath,
      shows: "reference",
      line: reference.lines.head!.call,
      confirmed: true,
    });
    expect(rowLifts(used)).toBe(true);
    expect(double.relations).toBe("shown");

    // fact: its own recursive call is no caller, and its only other caller is a test file's call
    // outside every function: a test row alone, which keeps the gap.
    const fact = of("fact");
    expect(fact.rows.map((row) => row.kind)).toEqual(["test"]);
    expect(fact.rows[0]!.path).toBe(relation("direct-test-fact").callerPath);
    expect(fact.rows[0]!.shows).toBe("call");
    expect(fact.relations).toBe("partial");

    // A name-only row: the engine's own name-only caller of total (a dynamic import), shown as a
    // row would show it, is unconfirmed and lifts nothing.
    const late = relation("later-total");
    const totalSlice = slices.get(sectionNamed("total").key)!;
    const nameOnly = totalSlice.head.symbols
      .flatMap((entry) =>
        entry.callers.evidence === "supported" ? entry.callers.shown : [],
      )
      .find((one) => one.caller.path === late.callerPath)!;
    expect(nameOnly.matched).toBe("name-only");
    expect(lifts(nameOnly)).toBe(false);
    const nameOnlyRow: EvidenceRow = {
      kind: "caller",
      symbol: "total",
      path: late.callerPath,
      shows: nameOnly.site!.shows,
      line: nameOnly.site!.line,
      text: lineAt(late.callerPath, nameOnly.site!.line!)!.trim(),
      from: "later",
      confirmed: lifts(nameOnly),
    };
    expect(rowLifts(nameOnlyRow)).toBe(false);
    // A `caller` row (what a language without call lines gives: the calling function's first line,
    // or none). The pinned engine gives call lines for every language of the fixture, so it is the
    // real trusted row with only its place changed; it lifts nothing, with a line or without.
    expect(rowLifts({ ...caller, shows: "caller" })).toBe(false);
    expect(
      rowLifts({ ...caller, shows: "caller", line: null, text: null }),
    ).toBe(false);

    // An undecided file's trusted call: were report.ts under a script the reader cannot follow too,
    // total's every trusted not-test caller would be undecided. Its row is shown, marked, and lifts
    // nothing; the section keeps its gap.
    const undecided = new Set([...files.undecided, summary.callerPath]);
    const withheld = chooseRows(
      plan,
      group.id,
      slices,
      lineAt,
      hunks,
      undecided,
    );
    const held = of("total", withheld);
    const heldRow = held.rows.find((row) => row.kind === "caller")!;
    expect([summary.callerPath, wrapped.callerPath]).toContain(heldRow.path);
    expect(heldRow.confirmed).toBe(true);
    expect(heldRow.undecided).toBe(true);
    expect(rowLifts(heldRow)).toBe(false);
    expect(held.relations).toBe("partial");
    // Test rows are never marked undecided.
    expect(
      withheld
        .flatMap((s) => s.rows)
        .some((row) => row.kind === "test" && row.undecided !== undefined),
    ).toBe(false);

    // The reading says so, row by row, and its legend explains the mark only when one is shown.
    const reading = (from: ReadonlyArray<SectionEvidence>) =>
      renderReading(plan, group.id, {
        for: "assess",
        hunks,
        structures,
        evidence: {
          recipe: EVIDENCE_RECIPE,
          group: group.id,
          outcome: "read",
          relations: { head: "head", base: null },
          sections: [...from],
        },
      }).text;
    const rowsOf = (text: string) =>
      text.split("\n").filter((line) => /^(caller|test) of /.test(line));
    const shown = reading(sections);
    expect(rowsOf(shown)).toContain(
      `caller of total, called here: ${caller.path} line ${caller.line}\t${caller.text}`,
    );
    expect(rowsOf(shown)).toContain(
      `caller of double, used here: ${used.path} line ${used.line}\t${used.text}`,
    );
    expect(shown).not.toContain(EVIDENCE_LEGEND.undecided);
    const marked = reading(withheld);
    expect(rowsOf(marked)).toContain(
      `caller of total, may be a test, called here: ${heldRow.path} line ${heldRow.line}\t${heldRow.text}`,
    );
    expect(marked).toContain(EVIDENCE_LEGEND.undecided);
  },
  RELATIONS_FIXTURE_TIMEOUT_MS,
);
