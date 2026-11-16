// Why (NEU-148 WP6, round 7): round 6's review settled when a section's missing-relations gap may go
// with a set of probes (the planted wrong edge, removed rows and their attribution, the earlier
// cases, Neuve's findings, the stored form and the read bounds). Round 7 changes how the evidence is
// found, not that rule, apart from one named widening. These are the review's probes, copied with
// the cases' inputs unchanged, each checked against the result it gave on the clean tree before this
// round (`fixtures/readings-round6-probes.json`). Where this round changes a result on purpose, the
// test says so beside it (`CHANGED`).
import { expect, test } from "bun:test";
import type { GraphSnapshotCoverage, SourcePath } from "@neuve/graph-client";
import {
  RelationsIndexBuilder,
  relationSlices,
  type RelationSlice,
} from "../src/relations.ts";
import {
  EVIDENCE_RECIPE,
  GroupEvidence,
  callSitePaths,
  chooseRows,
  relationSubjects,
  removalPlaces,
} from "../src/readings/evidence.ts";
import { planReadings, removalAttribution } from "../src/readings/plan.ts";
import { renderReading } from "../src/readings/reading.ts";
import { decideSections } from "../src/readings/settled.ts";
import EXPECTED from "./fixtures/readings-round6-probes.json";
import { futureShape } from "./fixtures/readings-future-shape.ts";
import {
  RECORDS,
  diff,
  judgementFor,
  oidOf,
  symbolStructure,
} from "./fixtures/readings.ts";

/**
 * Each probe's result on the clean tree, except where this round changes it on purpose. Every
 * label the fixture holds is checked exactly once.
 */
const CHANGED: Record<string, unknown> = {
  // Point 2, the one widening: a receiver-type row lifts.
  "f type_inferred both": [
    [
      "f",
      "shown",
      "gap:false",
      "static-automation",
      ["caller of f: b.ts line 2", "test of f: tests/t.test.ts line 2"],
      "symbolRemoved:false",
      "attributed:true",
      ["1-3"],
    ],
  ],
  // Round 9 (the owner's ruling: a test is a hint, never evidence): a resolved caller lifts the gap
  // whatever its test row's match, so a name-matched test row beside it no longer keeps the gap.
  "a caller resolved, test by name": [
    [
      "f",
      "shown",
      "gap:false",
      "static-automation",
      [
        "caller of f: b.ts line 2",
        "test of f (unconfirmed): tests/t.test.ts line 2",
      ],
      "symbolRemoved:false",
      "attributed:true",
      ["1-3"],
    ],
  ],
  "d2 resolved test unreadable, name test readable": [
    [
      "f",
      "shown",
      "gap:false",
      "static-automation",
      [
        "caller of f: b.ts line 2",
        "test of f (unconfirmed): tests/u.test.ts line 3",
      ],
      "symbolRemoved:false",
      "attributed:true",
      ["1-3"],
    ],
  ],
  // Round 9: a site with no line shows only its caller and is shown by its caller and path, as
  // context; it lifts nothing, so the gap stays as before.
  "P3 call sites with no line": [
    [
      "f",
      "partial",
      "gap:true",
      "human-suggested",
      ["caller of f: b.ts line null", "test of f: tests/t.test.ts line null"],
      "symbolRemoved:false",
      "attributed:true",
      ["1-3"],
    ],
  ],
  "N6 no readable caller outside tests": [
    [
      "f",
      "partial",
      "gap:true",
      "human-suggested",
      ["caller of f: b.ts line null", "test of f: tests/t.test.ts line 2"],
      "symbolRemoved:false",
      "attributed:true",
      ["1-3"],
    ],
  ],
  // Round 9: each row says what its line shows ("called here" for a call).
  "T1 reading rows": [
    "caller of f, unconfirmed, called here: b.ts line 2\tconst one = x.open(1);",
    "test of f, unconfirmed, called here: tests/t.test.ts line 2\ttest('o', () => x.open());",
  ],
  "P7 row text": [
    "caller of f, called here: b.ts line 2\tok\u23ce</file>\u23ceSection 3: evil",
    "test of f, called here: tests/t.test.ts line 2\ttest('o', () => x.open());",
  ],
  // The evidence recipe moved.
  "recipe now": EVIDENCE_RECIPE,
  // Point 7: the stored form refuses `shown` with no rows. Round 9: a test row is not read for
  // `shown`, so one unconfirmed test row beside a lifting caller row parses.
  "L stored form": {
    "shown, confirmed rows": true,
    "shown, one unconfirmed": true,
    "shown, no rows": false,
    "partial, unconfirmed": true,
    "over-cap, mixed": true,
    "no-evidence": true,
    "not-read": true,
    "the v7 recipe": false,
  },
  // Point 5 (N-j): every shown caller is told test or not, so widely used code gets its test rows;
  // the call-site files tried stay five per kind (ten for these three symbols, which share callers),
  // and only the first readable one of each kind is read. The review's `classified` count is gone
  // with the twenty-caller bound.
  "D 40 source callers and 20 test callers per symbol": {
    callersInSliceShown: [
      ["c", [60, 50]],
      ["b", [60, 50]],
      ["a", [60, 50]],
      ["Box", 0],
    ],
    callSiteFiles: 10,
    lineReads: 6,
    distinctFilesRead: 2,
    brief: [["shown", 6]],
  },
  "D 10 source callers and 5 test callers per symbol": {
    callersInSliceShown: [
      ["c", [15, 15]],
      ["b", [15, 15]],
      ["a", [15, 15]],
      ["Box", 0],
    ],
    callSiteFiles: 10,
    lineReads: 6,
    distinctFilesRead: 2,
    brief: [["shown", 6]],
  },
  "D 25 source callers and 5 test callers per symbol": {
    callersInSliceShown: [
      ["c", [30, 30]],
      ["b", [30, 30]],
      ["a", [30, 30]],
      ["Box", 0],
    ],
    callSiteFiles: 10,
    lineReads: 6,
    distinctFilesRead: 2,
    brief: [["shown", 6]],
  },
};

const expected = EXPECTED as Record<string, unknown>;
const checked = new Set<string>();
const show = (label: string, value: unknown) => {
  expect(label in expected).toBe(true);
  checked.add(label);
  expect(JSON.parse(JSON.stringify(value))).toEqual(
    label in CHANGED ? CHANGED[label] : expected[label],
  );
};

// ---------------------------------------------------------------------------------------------
// The review's lab, as round 7 cuts slices: with the test files known (`isTest`), so the slice
// tells which callers are tests.
// ---------------------------------------------------------------------------------------------

const coverage = (): GraphSnapshotCoverage => ({
  provider: {
    name: "entire-graph",
    version: "fixture",
    identityRevision: "4",
    executable: { sha256: "e".repeat(64), buildIdentity: "verified" },
  },
  repoKey: "local/r",
  schema: { version: "1.3", newerMinor: false, skippedRows: 0 },
  commit: "2".repeat(40),
  tree: "4".repeat(40),
  profile: "full",
  relationSet: ["CALLS", "CONSTRUCTS", "IMPORTS"],
  skippedRelationFamilies: [],
  languageTiers: { TypeScript: "semantic" },
  counts: { files: 0, parsedFiles: 0, symbols: 0, relations: 0, externals: 0 },
  partialFailures: [],
  warnings: [],
  gitlinksNotRead: [],
  goBuildExcluded: [],
  health: "ok",
  completenessLevel: "ok",
});
/** [name, start, end, container?, kind?, id?] */
type S = readonly [string, number, number, (string | null)?, string?, string?];
type Call = {
  from: string;
  to: string;
  path: string;
  line: number | null;
  res?: string;
};
const B =
  "import { x } from './x';\nconst one = x.open(1);\nconst two = x.close(2);\nconst three = x.mid(3);\n";
const T =
  "import { x } from '../x';\ntest('o', () => x.open());\ntest('c', () => x.close());\ntest('m', () => x.mid());\n";
const FILES: Record<string, string> = {
  "b.ts": B,
  "c.ts": B,
  "o.ts": B,
  "tests/t.test.ts": T,
  "tests/u.test.ts": T,
};
const both = (to: string, line = 2, res?: string): Call[] => [
  { from: "g", to, path: "b.ts", line, ...(res ? { res } : {}) },
  {
    from: "file:tests/t.test.ts",
    to,
    path: "tests/t.test.ts",
    line,
    ...(res ? { res } : {}),
  },
];
/** A structure: one span per top-level symbol, each holding the symbols that start inside it. */
const struct = (text: string, syms: ReadonlyArray<S>) => {
  const tops = syms.filter((s) => (s[3] ?? null) === null);
  const base = symbolStructure(
    text,
    tops.map((s) => ({
      start: s[1],
      end: s[2],
      kind: "declaration" as const,
      name: s[0],
    })),
  );
  return {
    ...base,
    spans: base.spans.map((span) => ({
      ...span,
      symbols: syms
        .filter((s) => s[1] >= span.start && s[1] <= span.end)
        .map((s) => ({
          name: s[0],
          kind: s[4] ?? ((s[3] ?? null) === null ? "function" : "method"),
          qualifiedName: (s[3] ?? null) === null ? s[0] : `${s[3]}.${s[0]}`,
          signature: null,
          container: s[3] ?? null,
          startLine: s[1],
          endLine: s[2],
        })),
    })),
  };
};
type LabOptions = {
  files?: Record<string, string>;
  imports?: ReadonlyArray<readonly [string, string]>;
  isTest?: (p: string) => boolean;
  context?: number;
  relSyms?: ReadonlyArray<S>;
  extraFiles?: string[];
  extraSyms?: ReadonlyArray<{
    id: string;
    name: string;
    path: string;
    start: number;
    end: number;
  }>;
  structures?: Map<string, unknown>;
};
const lab = async (
  before: string,
  after: string,
  baseSyms: ReadonlyArray<S>,
  headSyms: ReadonlyArray<S>,
  calls: ReadonlyArray<Call>,
  o: LabOptions = {},
) => {
  const H = diff(
    "x.ts",
    before,
    after,
    o.context === undefined ? {} : { context: o.context },
  );
  const p = planReadings({
    hunks: H,
    structures: (o.structures ??
      new Map([
        [oidOf(before), struct(before, baseSyms)],
        [oidOf(after), struct(after, headSyms)],
      ])) as never,
  });
  const builder = new RelationsIndexBuilder();
  const paths = [
    "x.ts",
    "b.ts",
    "c.ts",
    "o.ts",
    "tests/t.test.ts",
    "tests/u.test.ts",
    ...(o.extraFiles ?? []),
  ];
  for (const path of paths)
    builder.file({
      id: `file:${path}`,
      path,
      language: "TypeScript",
      bytes: 1,
    });
  const rel = [
    ...(o.relSyms ?? headSyms).map((s) => ({
      id: s[5] ?? s[0],
      name: s[0],
      path: "x.ts",
      start: s[1],
      end: s[2],
    })),
    { id: "g", name: "g", path: "b.ts", start: 1, end: 9 },
    { id: "k", name: "k", path: "c.ts", start: 1, end: 9 },
    ...(o.extraSyms ?? []),
  ];
  for (const s of rel)
    builder.symbol({
      id: s.id,
      name: s.name,
      qualifiedName: s.name,
      kind: "function",
      language: "TypeScript",
      path: s.path,
      startLine: s.start,
      endLine: s.end,
      containerId: null,
      signature: null,
    });
  for (const [from, to] of o.imports ?? [])
    builder.relation({
      relation: "IMPORTS",
      fromId: `file:${from}`,
      toId: `file:${to}`,
      targetKind: "file",
      resolution: "exact",
      confidence: 1,
      scope: null,
      evidence: [],
      warningCodes: [],
      evidenceDropped: 0,
    } as never);
  for (const c of calls)
    builder.relation({
      relation: "CALLS",
      fromId: c.from,
      toId: c.to,
      targetKind: "symbol",
      resolution: c.res ?? "exact",
      confidence: 0.8,
      scope: null,
      evidence: [
        {
          kind: "call_site",
          location:
            c.line === null
              ? { kind: "path", path: c.path as SourcePath }
              : { kind: "point", path: c.path as SourcePath, line: c.line },
          detail: null,
        },
      ],
      warningCodes: [],
      evidenceDropped: 0,
    });
  const index = futureShape(await builder.finish(coverage()));
  const hs = new Map(H.map((h) => [h.hunkId, h]));
  const isTest = o.isTest ?? ((path: string) => path.startsWith("tests/"));
  // Cut as the reading task cuts them now: with the test files known.
  const slices = new Map(
    relationSlices(
      { base: { gap: "over-bound", tag: null }, head: index },
      relationSubjects(p, hs),
      { base: () => false, head: isTest },
    ).map((s): [string, RelationSlice] => [s.key, s]),
  );
  const files: Record<string, string> = {
    ...(o.files ?? FILES),
    "x.ts": after,
  };
  const read: string[] = [];
  const at = (path: string, line: number) => {
    read.push(path);
    return files[path]?.split("\n")[line - 1] ?? null;
  };
  const gid = p.groups[0]!.id;
  const evidence = {
    recipe: EVIDENCE_RECIPE,
    group: gid,
    outcome: "read" as const,
    relations: { head: "k", base: null },
    sections: p.groups.flatMap((g) => chooseRows(p, g.id, slices, at, hs)),
  };
  const { sections: decidedSections } = decideSections({
    plan: p,
    hunks: hs,
    groups: [],
    collected: new Map(
      p.sections.map((s) => [
        s.key,
        {
          assess: {
            judged: true,
            judgement: judgementFor("static-automation"),
          },
          review: {
            judged: true,
            judgement: {
              verdict: "approve",
              comments: [],
              checked: "",
              rows: [],
              unsure: [],
            },
          },
          claims: [],
          steps: { assess: "a".repeat(64), review: "b".repeat(64) },
        },
      ]),
    ) as never,
    proofs: new Map(p.sections.map((s) => [s.path, RECORDS])),
    findings: [],
    excluded: [],
    relations: new Set(
      evidence.sections
        .filter((s) => s.relations === "shown")
        .map((s) => s.key),
    ),
  });
  const sections = p.sections.map((s) => {
    const e = evidence.sections.find((x) => x.key === s.key);
    const d = decidedSections.find((x) => x.section.key === s.key)!
      .decision as unknown as {
      entry: {
        assess: { gaps: Array<{ kind: string }> };
        lane: { applied: string };
      };
    };
    return {
      name: s.name,
      state: e?.relations,
      rows: e?.rows.map(
        (r) =>
          `${r.kind} of ${r.symbol}${r.confirmed ? "" : " (unconfirmed)"}: ${r.path} line ${r.line}`,
      ),
      symbolRemoved: s.symbolRemoved,
      attributed: s.removedAttributed,
      heads: s.removedHeads.map((h) => `${h.startLine}-${h.endLine}`),
      places: removalPlaces(s, hs),
      gap: d.entry.assess.gaps.some((g) => g.kind === "relations-unavailable"),
      lane: d.entry.lane.applied,
    };
  });
  return {
    hunks: H.map((h) => (h as { text: string }).text),
    sections,
    plan: p,
    slices,
    hs,
    evidence,
    read,
    gid,
    brief: sections.map((s) => [
      s.name,
      s.state,
      `gap:${s.gap}`,
      s.lane,
      s.rows,
      `symbolRemoved:${s.symbolRemoved}`,
      `attributed:${s.attributed}`,
      s.heads,
    ]),
    text: () =>
      renderReading(p, gid, {
        for: "assess",
        hunks: hs,
        structures: new Map([
          [oidOf(before), struct(before, baseSyms)],
          [oidOf(after), struct(after, headSyms)],
        ]) as never,
        evidence: GroupEvidence.parse(evidence),
      }).text,
  };
};
const cls = (rest: S[], end: number): S[] => [
  ["Box", 1, end, null, "class"],
  ...rest,
];

// ---------------------------------------------------------------------------------------------
// a-trust: the planted wrong edge and every attempt to make it lift
// ---------------------------------------------------------------------------------------------

{
  const before = "export function f() {\n  return 1;\n}\n";
  const after = "export function f() {\n  return 2;\n}\n";
  const F: S[] = [["f", 1, 3]];
  const other = {
    extraSyms: [{ id: "o:f", name: "f", path: "o.ts", start: 1, end: 3 }],
  };
  const imp = [
    ["b.ts", "x.ts"],
    ["c.ts", "x.ts"],
    ["tests/t.test.ts", "x.ts"],
    ["tests/u.test.ts", "x.ts"],
  ] as const;
  const run = (calls: Call[], o: LabOptions = {}) =>
    lab(before, after, F, F, calls, { ...other, imports: imp, ...o });

  // Reason: round 6's planted name-only edge must still lift nothing.
  test("T1 a planted name-only edge from a caller and from a test", async () => {
    const r = await run(both("f", 2, "name_only"));
    show("T1 planted", r.brief);
    const text = r.text();
    show(
      "T1 reading rows",
      text.split("\n").filter((l) => /^(caller|test) of /.test(l)),
    );
    show(
      "T1 legend says unconfirmed",
      text.includes('A row marked "unconfirmed"'),
    );
    expect(r.sections[0]!.gap).toBe(true);
  });

  // Reason: no route may make a match by name only lift; receiver type now does, on purpose.
  test("T2 trying to make an import-backed row lift", async () => {
    const caller = (
      res?: string,
      line = 2,
      from = "g",
      path = "b.ts",
    ): Call => ({
      from,
      to: "f",
      path,
      line,
      ...(res ? { res } : {}),
    });
    const tst = (res?: string, line = 2, path = "tests/t.test.ts"): Call => ({
      from: `file:${path}`,
      to: "f",
      path,
      line,
      ...(res ? { res } : {}),
    });
    show(
      "a caller resolved, test by name",
      (await run([caller(), tst("name_only")])).brief,
    );
    show(
      "b caller by name, test resolved",
      (await run([caller("name_only"), tst()])).brief,
    );
    show(
      "c a tie: resolved and name callers, resolved test",
      (
        await run([
          caller("name_only"),
          caller(undefined, 3, "k", "c.ts"),
          tst(),
        ])
      ).brief,
    );
    show(
      "c2 a tie on the test side: name test first by path, resolved test second",
      (
        await run([
          caller(),
          tst("name_only"),
          tst(undefined, 3, "tests/u.test.ts"),
        ])
      ).brief,
    );
    show(
      "d resolved caller unreadable, name caller readable",
      (
        await run([
          caller(undefined, 99),
          caller("name_only", 3, "k", "c.ts"),
          tst(),
        ])
      ).brief,
    );
    show(
      "d2 resolved test unreadable, name test readable",
      (
        await run([
          caller(),
          tst(undefined, 99),
          tst("name_only", 3, "tests/u.test.ts"),
        ])
      ).brief,
    );
    show(
      "e name match with no import of x.ts",
      (await lab(before, after, F, F, both("f", 2, "name_only"), other)).brief,
    );
    show(
      "f type_inferred both",
      (await run(both("f", 2, "type_inferred"))).brief,
    );
    show(
      "g import_resolved both",
      (await run(both("f", 2, "import_resolved"))).brief,
    );
    const b2 =
      "export function f() {\n  return 1;\n}\nexport function h() {\n  return f();\n}\n";
    const a2 =
      "export function f() {\n  return 2;\n}\nexport function h() {\n  return f();\n}\n";
    const FH: S[] = [
      ["f", 1, 3],
      ["h", 4, 6],
    ];
    show(
      "h same-file name caller, resolved test",
      (
        await lab(
          b2,
          a2,
          FH,
          FH,
          [
            { from: "h", to: "f", path: "x.ts", line: 5, res: "name_only" },
            tst(),
          ],
          other,
        )
      ).brief,
    );
    const cb =
      "export class Box {\n  open = () => this.a()\n    .then(guard)\n  close = () => this.b(1)\n}\n";
    const ca =
      "export class Box {\n  open = () => this.a()\n  close = () => this.b(2)\n}\n";
    const bs: S[] = [
      ["Box", 1, 5, null, "class"],
      ["open", 2, 3, "Box"],
      ["close", 4, 4, "Box"],
    ];
    const hd: S[] = [
      ["Box", 1, 4, null, "class"],
      ["open", 2, 2, "Box"],
      ["close", 3, 3, "Box"],
    ];
    show(
      "i removedHeads symbol with name-only rows",
      (
        await lab(
          cb,
          ca,
          bs,
          hd,
          [...both("close", 3), ...both("open", 2, "name_only")],
          {
            imports: imp,
          },
        )
      ).brief,
    );
    show(
      "i2 the same, open resolved",
      (
        await lab(cb, ca, bs, hd, [...both("close", 3), ...both("open", 2)], {
          imports: imp,
        })
      ).brief,
    );
  });

  // Reason: a stored decision from before a rule must never be read under it.
  test("T3 a stored decision from before the rule is refused", async () => {
    const r = await run(both("f", 2));
    const now = r.evidence;
    show("the decision made now parses", GroupEvidence.safeParse(now).success);
    const noFlag = {
      ...now,
      sections: now.sections.map((s) => ({
        ...s,
        rows: s.rows.map(({ confirmed: _c, ...row }) => row),
      })),
    };
    show(
      "the same rows without `confirmed` (the form before the rule)",
      GroupEvidence.safeParse(noFlag).success,
    );
    show(
      "an older recipe with today's form",
      GroupEvidence.safeParse({ ...now, recipe: "neuve-reading-evidence-v6" })
        .success,
    );
    show(
      "an older recipe, older form",
      GroupEvidence.safeParse({
        ...noFlag,
        recipe: "neuve-reading-evidence-v6",
      }).success,
    );
    show("recipe now", EVIDENCE_RECIPE);
    const forged = {
      ...now,
      sections: now.sections.map((s) => ({
        ...s,
        relations: "shown",
        rows: s.rows.map((row) => ({ ...row, confirmed: false })),
      })),
    };
    show(
      "(a hand-made 'shown' with unconfirmed rows parses: the schema does not tie the two)",
      GroupEvidence.safeParse(forged).success,
    );
  });
}

// ---------------------------------------------------------------------------------------------
// b-attribution: R9, E2 and the attribution cases
// ---------------------------------------------------------------------------------------------

// Reason: every removed row must be attributed to its symbol or keep the gap.
test("R9 and E2 again, with the structure's real lines", async () => {
  const b =
    "export class Box {\n  open = () => this.a()\n    .then(guard)\n  close = () => this.b(1)\n}\n";
  const a =
    "export class Box {\n  open = () => this.a()\n  close = () => this.b(2)\n}\n";
  const bs = cls(
    [
      ["open", 2, 3, "Box"],
      ["close", 4, 4, "Box"],
    ],
    5,
  );
  const hd = cls(
    [
      ["open", 2, 2, "Box"],
      ["close", 3, 3, "Box"],
    ],
    4,
  );
  show(
    "R9 close covered, open not",
    (await lab(b, a, bs, hd, both("close", 3))).brief,
  );
  show(
    "R9 close and open covered",
    (await lab(b, a, bs, hd, [...both("close", 3), ...both("open", 2)])).brief,
  );
  const b2 =
    "export class Box {\n  open() {\n    return 1;\n  }\n  static { register(Box); }\n  close() {\n    return 1;\n  }\n}\n";
  const a2 =
    "export class Box {\n  open() {\n    return 1;\n  }\n  close(force) {\n    return 1;\n  }\n}\n";
  const bs2 = cls(
    [
      ["open", 2, 4, "Box"],
      ["close", 6, 8, "Box"],
    ],
    9,
  );
  const hd2 = cls(
    [
      ["open", 2, 4, "Box"],
      ["close", 5, 7, "Box"],
    ],
    8,
  );
  show(
    "E2 close covered, Box not",
    (await lab(b2, a2, bs2, hd2, both("close", 3))).brief,
  );
  show(
    "E2 close and Box covered",
    (await lab(b2, a2, bs2, hd2, [...both("close", 3), ...both("Box", 4)]))
      .brief,
  );
  const b3 =
    "export function handler(req) {\n  requireAuth(req);\n  const respond = (b) => send(b);\n  return respond;\n}\n";
  const a3 =
    "export function handler(req) {\n  const respond = (b) => send(b, 200);\n  return respond;\n}\n";
  show(
    "R9b respond covered, handler not",
    (
      await lab(
        b3,
        a3,
        [
          ["handler", 1, 5],
          ["respond", 3, 3, "handler"],
        ],
        [
          ["handler", 1, 4],
          ["respond", 2, 2, "handler"],
        ],
        both("respond", 2),
      )
    ).brief,
  );
});

// Reason: as above.
test("A1 an overload pair, and a getter and setter", async () => {
  const b =
    "export class Box {\n  open(k: string): void\n  open(k: any) {\n    guard(k);\n    return 1;\n  }\n  close() {\n    return 1;\n  }\n}\n";
  const a =
    "export class Box {\n  open(k: string): void\n  open(k: any) {\n    return 1;\n  }\n  close() {\n    return 2;\n  }\n}\n";
  const bs = cls(
    [
      ["open", 2, 2, "Box", "method", "open#1"],
      ["open", 3, 6, "Box", "method", "open#2"],
      ["close", 7, 9, "Box"],
    ],
    10,
  );
  const hd = cls(
    [
      ["open", 2, 2, "Box", "method", "open#1"],
      ["open", 3, 5, "Box", "method", "open#2"],
      ["close", 6, 8, "Box"],
    ],
    9,
  );
  const all: Call[] = ["Box", "open#1", "open#2", "close"].flatMap((id) =>
    both(id, 2),
  );
  show(
    "A1 a line removed from one of two same-named members, all covered",
    (await lab(b, a, bs, hd, all)).brief,
  );
  const gb =
    "export class Box {\n  get v() {\n    audit();\n    return 1;\n  }\n  set v(x) {\n    this.x = x;\n  }\n  close() {\n    return 1;\n  }\n}\n";
  const ga =
    "export class Box {\n  get v() {\n    return 1;\n  }\n  set v(x) {\n    this.x = x;\n  }\n  close() {\n    return 2;\n  }\n}\n";
  const gs = (d: number, kinds: [string, string]): S[] =>
    cls(
      [
        ["v", 2, 5 - d, "Box", kinds[0], "v#get"],
        ["v", 6 - d, 8 - d, "Box", kinds[1], "v#set"],
        ["close", 9 - d, 11 - d, "Box"],
      ],
      12 - d,
    );
  const setOnly: Call[] = ["v#set", "close"].flatMap((id) => both(id, 2));
  show(
    "A1 getter loses a line; kinds getter/setter; setter and close covered",
    (
      await lab(
        gb,
        ga,
        gs(0, ["getter", "setter"]),
        gs(1, ["getter", "setter"]),
        setOnly,
      )
    ).brief,
  );
  show(
    "A1 the same; both kinds `method`",
    (
      await lab(
        gb,
        ga,
        gs(0, ["method", "method"]),
        gs(1, ["method", "method"]),
        setOnly,
      )
    ).brief,
  );
  show(
    "A1 kinds getter/setter; getter, setter and close covered",
    (
      await lab(
        gb,
        ga,
        gs(0, ["getter", "setter"]),
        gs(1, ["getter", "setter"]),
        [...setOnly, ...both("v#get", 2)],
      )
    ).brief,
  );
});

// Reason: as above.
test("A2 three deep; a shared line; another slice symbol on the head match's first line", async () => {
  const b =
    "function out() {\n  const z = 1;\n  function mid() {\n    const w = 1;\n    function inn() {\n      log();\n      return 1;\n    }\n  }\n}\n";
  const a =
    "function out() {\n  const z = 2;\n  function mid() {\n    const w = 1;\n    function inn() {\n      return 1;\n    }\n  }\n}\n";
  const bs: S[] = [
    ["out", 1, 10],
    ["mid", 3, 9, "out", "function"],
    ["inn", 5, 8, "mid", "function"],
  ];
  const hd: S[] = [
    ["out", 1, 9],
    ["mid", 3, 8, "out", "function"],
    ["inn", 5, 7, "mid", "function"],
  ];
  show(
    "A2 a row removed in inn, a line changed in out; out covered only",
    (await lab(b, a, bs, hd, both("out", 2))).brief,
  );
  show(
    "A2 the same; out and inn covered",
    (await lab(b, a, bs, hd, [...both("out", 2), ...both("inn", 3)])).brief,
  );
  const tb =
    "export const f = () => {\n  log();\n  return 1;\n};\nexport function h() {\n  return 1;\n}\n";
  const ta =
    "export const f = () => {\n  return 1;\n};\nexport function h() {\n  return 2;\n}\n";
  const tbs: S[] = [
    ["f", 1, 4, null, "variable"],
    ["f", 1, 4, null, "function", "f#fn"],
    ["h", 5, 7],
  ];
  const ths: S[] = [
    ["f", 1, 3, null, "variable"],
    ["f", 1, 3, null, "function", "f#fn"],
    ["h", 4, 6],
  ];
  show(
    "A2 two symbols of equal lines hold the removed row; f(variable) and h covered, f#fn not",
    (await lab(tb, ta, tbs, ths, [...both("h", 3), ...both("f", 2)])).brief,
  );
  const mb =
    "export class Box {\n  m() {\n    guard();\n    return 1;\n  }\n  close() {\n    return 1;\n  }\n}\n";
  const ma =
    "export class Box {\n  m() {\n    return 1;\n  }\n  close() {\n    return 2;\n  }\n}\n";
  const mbs = cls(
    [
      ["m", 2, 5, "Box"],
      ["close", 6, 8, "Box"],
    ],
    9,
  );
  const mhs = cls(
    [
      ["m", 2, 4, "Box"],
      ["close", 5, 7, "Box"],
    ],
    8,
  );
  const withTwin: S[] = [...mhs, ["m$twin", 2, 2, "Box"]];
  show(
    "A2 slice has m and another symbol starting on m's line; m and close covered, the twin not",
    (
      await lab(mb, ma, mbs, mhs, [...both("m", 2), ...both("close", 3)], {
        relSyms: withTwin,
      })
    ).brief,
  );
  const noM: S[] = [
    ["Box", 1, 8, null, "class"],
    ["close", 5, 7, "Box"],
    ["m$twin", 2, 2, "Box"],
  ];
  show(
    "A2 slice lacks m, has only another symbol starting there (covered), close covered",
    (
      await lab(mb, ma, mbs, mhs, [...both("m$twin", 2), ...both("close", 3)], {
        relSyms: noM,
      })
    ).brief,
  );
  const none: S[] = [
    ["Box", 1, 8, null, "class"],
    ["close", 5, 7, "Box"],
  ];
  show(
    "A2 slice lacks m and has nothing starting there, close and Box covered",
    (
      await lab(mb, ma, mbs, mhs, [...both("Box", 4), ...both("close", 3)], {
        relSyms: none,
      })
    ).brief,
  );
});

// Reason: as above.
test("A3 two blobs; renamed and moved; a row no symbol takes", async () => {
  const b = "export function f() {\n  log();\n  return 1;\n}\n";
  const a = "export function f() {\n  return 2;\n}\n";
  const H = diff("x.ts", b, a);
  const structures = new Map([
    [oidOf(b), struct(b, [["f", 1, 4]])],
    [oidOf(a), struct(a, [["f", 1, 3]])],
  ]);
  const owned = [
    { hunkId: H[0]!.hunkId, side: "old" as const, startLine: 2, endLine: 3 },
  ];
  show(
    "A3 one blob each side",
    removalAttribution(owned, H, structures as never),
  );
  show(
    "A3 hunks naming two old blobs",
    removalAttribution(
      owned,
      [H[0]!, { ...H[0]!, oldOid: "0".repeat(40) }],
      structures as never,
    ),
  );
  show(
    "A3 no base structure",
    removalAttribution(
      owned,
      H,
      new Map([[oidOf(a), struct(a, [["f", 1, 3]])]]) as never,
    ),
  );
  const sb = "register(f);\nexport function f() {\n  return 1;\n}\n";
  const sa = "export function f(x) {\n  return 1;\n}\n";
  show(
    "A3 a top-level statement removed directly above f's changed header, f covered",
    (await lab(sb, sa, [["f", 2, 4]], [["f", 1, 3]], both("f", 2))).brief,
  );
  const rb = "export class Box {\n  open() {\n    return 1;\n  }\n}\n";
  const ra = "export class Box {\n  shut() {\n    return 1;\n  }\n}\n";
  show(
    "A3 a renamed member, new name and Box covered",
    (
      await lab(
        rb,
        ra,
        cls([["open", 2, 4, "Box"]], 5),
        cls([["shut", 2, 4, "Box"]], 5),
        [...both("shut", 2), ...both("Box", 3)],
      )
    ).brief,
  );
});

// ---------------------------------------------------------------------------------------------
// c-earlier: P1 to P7, N1 to N7, the removal and lost-symbol cases, top-level overloads
// ---------------------------------------------------------------------------------------------

{
  const fb = "export function f() {\n  return 1;\n}\n";
  const fa = "export function f() {\n  return 2;\n}\n";
  const F: S[] = [["f", 1, 3]];
  const t = (line: number | null = 2, path = "tests/t.test.ts"): Call => ({
    from: `file:${path}`,
    to: "f",
    path,
    line,
  });
  const c = (line: number | null = 2, from = "g", path = "b.ts"): Call => ({
    from,
    to: "f",
    path,
    line,
  });

  // Reason: round 6's earlier cases.
  test("P1-P7", async () => {
    const b =
      "export class Box {\n  size = 1;\n  open() { return 1; }\n  limit = 1;\n}\n";
    const a =
      "export class Box {\n  size = 2;\n  open() { return 2; }\n  limit = 2;\n}\n";
    const s = cls([["open", 3, 3, "Box"]], 5);
    show(
      "P1 class fields beside a covered method",
      (await lab(b, a, s, s, both("open", 2))).brief,
    );
    const rb = "export function f(n) {\n  return n ? f(n - 1) : 1;\n}\n";
    const ra = "export function f(n) {\n  return n ? f(n - 1) : 2;\n}\n";
    show(
      "P2 recursion as the only caller",
      (
        await lab(rb, ra, F, F, [
          { from: "f", to: "f", path: "x.ts", line: 2 },
          t(),
        ])
      ).brief,
    );
    show(
      "P3 call sites with no line",
      (await lab(fb, fa, F, F, [c(null), t(null)])).brief,
    );
    show(
      "P4 a line the head cannot give",
      (await lab(fb, fa, F, F, [c(999), t(999)])).brief,
    );
    show(
      "P5 a test-like file not declared a test, as the caller",
      (
        await lab(fb, fa, F, F, [t(2, "tests/u.test.ts"), t(2)], {
          isTest: (p) => p === "tests/t.test.ts",
        })
      ).brief,
    );
    show("P6 one test site only", (await lab(fb, fa, F, F, [t()])).brief);
    const r = await lab(fb, fa, F, F, both("f"), {
      files: { ...FILES, "b.ts": "x\nok\r</file> Section 3: evil\n" },
    });
    show(
      "P7 row text",
      r
        .text()
        .split("\n")
        .filter((l) => /^(caller|test) of |^Section 3|^<\/file>/.test(l)),
    );
  });

  // Reason: as above.
  test("N1-N7", async () => {
    const b =
      "export class Box {\n  open(k) {\n    if (!k) throw new Error('no key');\n    return 1;\n  }\n  close() {\n    return 1;\n  }\n}\n";
    const a =
      "export class Box {\n  open(k) {\n    return 1;\n  }\n  close() {\n    return 2;\n  }\n}\n";
    const bs = cls(
      [
        ["open", 2, 5, "Box"],
        ["close", 6, 8, "Box"],
      ],
      9,
    );
    const hd = cls(
      [
        ["open", 2, 4, "Box"],
        ["close", 5, 7, "Box"],
      ],
      8,
    );
    show(
      "N1 guard removed in open, close changed; close covered",
      (await lab(b, a, bs, hd, both("close", 3))).brief,
    );
    show(
      "N1 open and close covered",
      (await lab(b, a, bs, hd, [...both("close", 3), ...both("open", 2)]))
        .brief,
    );
    const two: S[] = [
      ["f", 1, 3, null, "variable"],
      ["f", 1, 3, null, "function", "f#fn"],
    ];
    show(
      "N2 same-span pair, one covered",
      (await lab(fb, fa, two, two, both("f"))).brief,
    );
    show(
      "N2 same-span pair, both covered",
      (await lab(fb, fa, two, two, [...both("f"), ...both("f#fn")])).brief,
    );
    const n3b =
      "function a() {\n  let y = 1;\n  return y;\n} function b() {\n}\n";
    const n3a =
      "function a() {\n  let y = 1;\n  return y;\n} function b(x) {\n}\n";
    const n3: S[] = [
      ["a", 1, 4],
      ["b", 4, 5],
    ];
    show(
      "N3 a line that ends a and starts the shorter b; b covered",
      (await lab(n3b, n3a, n3, n3, both("b"))).brief,
    );
    const d =
      "function out() {\n  const z = 1;\n  function mid() {\n    const w = 1;\n    function inn() {\n      return 1;\n    }\n  }\n}\n";
    const ds: S[] = [
      ["out", 1, 9],
      ["mid", 3, 8, "out", "function"],
      ["inn", 5, 7, "mid", "function"],
    ];
    show(
      "N4 mid's own line changed; out and inn covered",
      (
        await lab(d, d.replace("const w = 1", "const w = 2"), ds, ds, [
          ...both("out"),
          ...both("inn", 3),
        ])
      ).brief,
    );
    show(
      "N4 inn's line changed; inn covered",
      (await lab(d, d.replace("return 1", "return 2"), ds, ds, both("inn", 3)))
        .brief,
    );
    const m4 =
      "class C {\n  a() { return 1; }\n  b() { return 1; }\n  c() { return 1; }\n  d() { return 1; }\n}\n";
    const m4s: S[] = [
      ["C", 1, 6, null, "class"],
      ["a", 2, 2, "C"],
      ["b", 3, 3, "C"],
      ["c", 4, 4, "C"],
      ["d", 5, 5, "C"],
    ];
    show(
      "N5 four covered methods changed",
      (
        await lab(
          m4,
          m4.replaceAll("return 1", "return 2"),
          m4s,
          m4s,
          ["a", "b", "c", "d"].flatMap((id) => both(id)),
        )
      ).brief,
    );
    show(
      "N6 the first caller has no line and the first test is unreadable; a second of each is readable",
      (
        await lab(fb, fa, F, F, [
          c(null),
          c(3, "k", "c.ts"),
          t(99),
          t(4, "tests/u.test.ts"),
        ])
      ).brief,
    );
    show(
      "N6 no readable caller outside tests",
      (
        await lab(fb, fa, F, F, [
          c(null),
          c(99, "k", "c.ts"),
          t(2),
          t(3, "tests/u.test.ts"),
        ])
      ).brief,
    );
    const rb = "export function f(n) {\n  return n ? f(n - 1) : 1;\n}\n";
    show(
      "N7 recursion beside a real caller",
      (
        await lab(rb, rb.replace(": 1", ": 2"), F, F, [
          { from: "f", to: "f", path: "x.ts", line: 2 },
          c(),
          t(),
        ])
      ).brief,
    );
  });

  // Reason: as above.
  test("R and SR", async () => {
    const b =
      "export class Box {\n  open(k) {\n    a(k);\n    return 1;\n  }\n  close() {\n    b();\n    return 1;\n  }\n}\n";
    const a = b
      .replace("    a(k);\n", "")
      .replace("    b();\n", "")
      .replace("return 1;\n  }\n}", "return 2;\n  }\n}");
    const bs = cls(
      [
        ["open", 2, 5, "Box"],
        ["close", 6, 9, "Box"],
      ],
      10,
    );
    const hd = cls(
      [
        ["open", 2, 4, "Box"],
        ["close", 5, 7, "Box"],
      ],
      8,
    );
    show(
      "R5 two removals and a change; open covered only",
      (await lab(b, a, bs, hd, both("open", 2), { context: 3 })).brief,
    );
    show(
      "R5 both covered",
      (
        await lab(b, a, bs, hd, [...both("open", 2), ...both("close", 3)], {
          context: 3,
        })
      ).brief,
    );
    const b7 = "export function f() {\n  return 1;\n}\nregister(f);\n";
    show(
      "R7 a removal that ends its hunk",
      (
        await lab(
          b7,
          "export function f() {\n  return 2;\n}\n",
          [["f", 1, 3]],
          [["f", 1, 3]],
          both("f"),
        )
      ).brief,
    );
    const sb =
      "export class Box {\n  open() { return 1; }\n  gone() { return 1; }\n  close() { return 1; }\n}\n";
    const sa =
      "export class Box {\n  open() { return 2; }\n  close() { return 1; }\n}\n";
    show(
      "SR a member removed, the kept ones covered",
      (
        await lab(
          sb,
          sa,
          cls(
            [
              ["open", 2, 2, "Box"],
              ["gone", 3, 3, "Box"],
              ["close", 4, 4, "Box"],
            ],
            5,
          ),
          cls(
            [
              ["open", 2, 2, "Box"],
              ["close", 3, 3, "Box"],
            ],
            4,
          ),
          [...both("open"), ...both("close", 3), ...both("Box", 4)],
        )
      ).brief,
    );
    show(
      "SR no structure at all",
      (await lab(fb, fa, F, F, both("f"), { structures: new Map() })).brief,
    );
    const ob =
      "export function f(a: string): void;\nexport function f(a: any) {\n  guard(a);\n  return 1;\n}\nexport function h() {\n  return 1;\n}\n";
    const oa =
      "export function f(a: string): void;\nexport function f(a: any) {\n  return 2;\n}\nexport function h() {\n  return 1;\n}\n";
    const obs: S[] = [
      ["f", 1, 1, null, "function", "f#sig"],
      ["f", 2, 5, null, "function", "f#impl"],
      ["h", 6, 8],
    ];
    const ohs: S[] = [
      ["f", 1, 1, null, "function", "f#sig"],
      ["f", 2, 4, null, "function", "f#impl"],
      ["h", 5, 7],
    ];
    show(
      "TOP top-level overload spans; the implementation changed; only the signature's symbol covered",
      (await lab(ob, oa, obs, ohs, both("f#sig"))).brief,
    );
    show(
      "TOP the same; the implementation's symbol covered",
      (await lab(ob, oa, obs, ohs, both("f#impl"))).brief,
    );
  });
}

// ---------------------------------------------------------------------------------------------
// e-neuve, e2-neuve: Neuve's finding of a removed row no symbol takes
// ---------------------------------------------------------------------------------------------

{
  type Structure = ReturnType<typeof struct>;
  const wide = (
    text: string,
    symEnd: number,
    spanEnd: number,
    spanStart = 1,
    symStart = 1,
  ): Structure => {
    const s = struct(text, [["f", spanStart, spanEnd]]);
    return {
      ...s,
      spans: s.spans.map((span) => ({
        ...span,
        symbols: span.symbols.map((sym) => ({
          ...sym,
          startLine: symStart,
          endLine: symEnd,
        })),
      })),
    };
  };
  const F: S[] = [["f", 1, 3]];
  const run = (
    b: string,
    a: string,
    bStruct: Structure,
    aStruct: Structure,
    calls = both("f"),
  ) =>
    lab(b, a, F, F, calls, {
      structures: new Map([
        [oidOf(b), bStruct],
        [oidOf(a), aStruct],
      ]),
    });

  // Reason: Neuve's round 13 finding stays closed.
  test("Neuve round 13, comment 1: a removed row no symbol takes, in a span that outruns its declaration", async () => {
    const b1 = "export function f() {\n  return 1;\n}\n// old note\n";
    const a1 = "export function f() {\n  return 2;\n}\n";
    show(
      "N13-1 a trailing comment removed, f changed and covered",
      (await run(b1, a1, wide(b1, 3, 4), wide(a1, 3, 3))).brief,
    );
    const b2 = "export function f() {\n  return 1;\n} audit(\n  f,\n);\n";
    const a2 = "export function f() {\n  return 2;\n}\n";
    show(
      "N13-1 a statement sharing f's closing line removed, f covered",
      (await run(b2, a2, wide(b2, 3, 5), wide(a2, 3, 3))).brief,
    );
    const b3 = "// old note\nexport function f() {\n  return 1;\n}\n";
    const a3 = "export function f() {\n  return 2;\n}\n";
    show(
      "N13-1 a leading comment removed, f changed and covered",
      (await run(b3, a3, wide(b3, 4, 4, 1, 2), wide(a3, 3, 3))).brief,
    );
    const a4 = "export function f() {\n  return 3;\n}\n// new note\n";
    show(
      "N13-1 a trailing comment added, f changed and covered",
      (await run(a1, a4, wide(a1, 3, 3), wide(a4, 3, 4))).brief,
    );
  });

  // Reason: as above.
  test("Neuve's example exactly: a one-line function replaced, the comment under it removed", async () => {
    const b = "export const f = () => 1;\n// old note\n";
    const a = "export const f = () => 2;\n";
    const one: S[] = [["f", 1, 1]];
    const r = await lab(b, a, one, one, both("f"), {
      structures: new Map([
        [oidOf(b), wide(b, 1, 2)],
        [oidOf(a), wide(a, 1, 1)],
      ]),
    });
    show("hunk", r.hunks);
    show(
      "N13-1 one-line f replaced, trailing comment removed, f covered",
      r.brief,
    );
  });
}

// ---------------------------------------------------------------------------------------------
// f-last: first and last lines, nested, no symbols, the stored form
// ---------------------------------------------------------------------------------------------

// Reason: the review's last check.
test("L first and last lines, nested, no symbols, the stored form", async () => {
  const b =
    "export class Box {\n  open(k) {\n    return 1;\n  }\n  close() {\n    return 1;\n  }\n}\n";
  const aLast =
    "export class Box {\n  open(k) {\n    return 1;\n  } // end\n  close() {\n    return 1;\n  }\n}\n";
  const aFirst =
    "export class Box {\n  open(k, force) {\n    return 1;\n  }\n  close() {\n    return 1;\n  }\n}\n";
  const s = cls(
    [
      ["open", 2, 4, "Box"],
      ["close", 5, 7, "Box"],
    ],
    8,
  );
  show(
    "L open's last line replaced; open covered",
    (await lab(b, aLast, s, s, both("open"))).brief,
  );
  show(
    "L open's first line replaced; open covered",
    (await lab(b, aFirst, s, s, both("open"))).brief,
  );
  show(
    "L open's first line replaced; only close covered",
    (await lab(b, aFirst, s, s, both("close", 3))).brief,
  );
  const aCls =
    "export class Box extends Base {\n  open(k) {\n    return 1;\n  }\n  close() {\n    return 1;\n  }\n}\n";
  show(
    "L the class's first line replaced; Box covered",
    (await lab(b, aCls, s, s, both("Box", 4))).brief,
  );
  const nb =
    "function out() {\n  const z = 1;\n  function mid() {\n    function inn() {\n      log();\n      return 1;\n    }\n  }\n}\n";
  const na =
    "function out() {\n  const z = 2;\n  function mid() {\n    function inn() {\n      return 1;\n    }\n  }\n}\n";
  const nbs: S[] = [
    ["out", 1, 9],
    ["mid", 3, 8, "out", "function"],
    ["inn", 4, 7, "mid", "function"],
  ];
  const nhs: S[] = [
    ["out", 1, 8],
    ["mid", 3, 7, "out", "function"],
    ["inn", 4, 6, "mid", "function"],
  ];
  show(
    "L a row removed in inn; out and inn covered",
    (await lab(nb, na, nbs, nhs, [...both("out"), ...both("inn", 3)])).brief,
  );
  const fb = "export function f() {\n  log();\n  return 1;\n}\n";
  const fa = "export function f() {\n  return 2;\n}\n";
  const bare = (text: string, end: number) => {
    const st = struct(text, [["f", 1, end]]);
    return { ...st, spans: st.spans.map((sp) => ({ ...sp, symbols: [] })) };
  };
  show(
    "L a span with no symbols; f covered in the relations",
    (
      await lab(fb, fa, [["f", 1, 4]], [["f", 1, 3]], both("f"), {
        structures: new Map([
          [oidOf(fb), bare(fb, 4)],
          [oidOf(fa), bare(fa, 3)],
        ]),
      })
    ).brief,
  );
  const H = diff("x.ts", fa, fa.replace("return 2", "return 3"));
  show(
    "L no removed row",
    removalAttribution(
      [{ hunkId: H[0]!.hunkId, side: "new", startLine: 2, endLine: 2 }],
      H,
      new Map() as never,
    ),
  );
  // The probe named the recipe of its day; today's recipe stands in for it, so only the form is
  // tested.
  const row = (confirmed: boolean) => ({
    kind: "caller",
    symbol: "f",
    path: "b.ts",
    shows: "call",
    line: 2,
    text: "x",
    from: "g",
    confirmed,
  });
  // The probe's rows, given the fields rounds 7d and 9 added (what each row's line shows, a call
  // here), so only the form it tested is tested.
  const dec = (relations: string, rows: object[]) =>
    GroupEvidence.safeParse({
      recipe: EVIDENCE_RECIPE,
      group: "g",
      outcome: "read",
      relations: { head: "h", base: null },
      sections: [{ key: "k", relations, rows }],
    }).success;
  show("L stored form", {
    "shown, confirmed rows": dec("shown", [
      row(true),
      { ...row(true), kind: "test" },
    ]),
    "shown, one unconfirmed": dec("shown", [
      row(true),
      { ...row(false), kind: "test" },
    ]),
    "shown, no rows": dec("shown", []),
    "partial, unconfirmed": dec("partial", [row(false)]),
    "over-cap, mixed": dec("over-cap", [row(true), row(false)]),
    "no-evidence": dec("no-evidence", []),
    "not-read": dec("not-read", []),
    "the v7 recipe": GroupEvidence.safeParse({
      recipe: "neuve-reading-evidence-v7",
      group: "g",
      outcome: "read",
      relations: { head: "h", base: null },
      sections: [],
    }).success,
  });
});

// ---------------------------------------------------------------------------------------------
// d-bounds: read counts
// ---------------------------------------------------------------------------------------------

// Reason: the files a decision reads stay bounded however widely the code is used.
test("D read bounds: three symbols, each called from 60 files", async () => {
  const b =
    "export class Box {\n  a() { return 1; }\n  b() { return 1; }\n  c() { return 1; }\n}\n";
  const a = b.replaceAll("return 1", "return 2");
  const syms: S[] = [
    ["Box", 1, 5, null, "class"],
    ["a", 2, 2, "Box"],
    ["b", 3, 3, "Box"],
    ["c", 4, 4, "Box"],
  ];
  const pad = (n: number) => String(n).padStart(2, "0");
  const src = Array.from({ length: 40 }, (_, i) => `src/p${pad(i)}.ts`);
  const tests = Array.from(
    { length: 20 },
    (_, i) => `tests/t${pad(i)}.test.ts`,
  );
  const files: Record<string, string> = Object.fromEntries(
    [...src, ...tests].map((p) => [p, "x\ncall();\n"]),
  );
  const run = async (paths: string[]) => {
    const extraSyms = paths
      .filter((p) => !p.startsWith("tests/"))
      .map((p) => ({ id: `s:${p}`, name: "u", path: p, start: 1, end: 2 }));
    const calls: Call[] = ["a", "b", "c"].flatMap((to) =>
      paths.map((p) => ({
        from: p.startsWith("tests/") ? `file:${p}` : `s:${p}`,
        to,
        path: p,
        line: 2,
      })),
    );
    const r = await lab(b, a, syms, syms, calls, {
      files,
      extraFiles: paths,
      extraSyms,
    });
    return {
      callersInSliceShown: [...r.slices.values()][0]!.head.symbols.map((s) => [
        s.symbol.name,
        s.callers.evidence === "supported"
          ? [s.callers.total, s.callers.shown.length]
          : 0,
      ]),
      callSiteFiles: callSitePaths(r.plan, r.gid, r.slices, r.hs).length,
      lineReads: r.read.length,
      distinctFilesRead: new Set(r.read).size,
      brief: r.sections.map((s) => [s.state, s.rows?.length]),
    };
  };
  show(
    "D 40 source callers and 20 test callers per symbol",
    await run([...src, ...tests]),
  );
  show(
    "D 10 source callers and 5 test callers per symbol",
    await run([...src.slice(0, 10), ...tests.slice(0, 5)]),
  );
  show(
    "D 25 source callers and 5 test callers per symbol",
    await run([...src.slice(0, 25), ...tests.slice(0, 5)]),
  );
});

// Reason: no probe of the review may be skipped silently.
test("every probe of the fixture was checked", () => {
  expect([...checked].sort()).toEqual(Object.keys(expected).sort());
});
