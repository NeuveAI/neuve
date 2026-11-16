// Why (NEU-148, the publisher's input): the records lane's new publisher takes one plain value,
// `SettledBatch`, built here and nowhere else. It is another lane's input, so a wrong field is
// silent until a review is published; these hold its shape, the checks the publisher will make,
// where finder findings land and how evidence is cited.
import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { Computations, PublishedPackets, sha256Hex } from "@neuve/records-core";
import {
  Citation,
  GuidedContent,
  OwnedRange,
  lineCiteOf,
} from "@neuve/records-schema";
import { publishSettled } from "../src/publish-sections.ts";
import type { StoredFinding } from "../src/find.ts";
import {
  assessExpand,
  type AssessAnswer,
  type AssessJudgement,
  type LaneReviewJudgement,
} from "../src/readings/answers.ts";
import { readingIndexOf } from "../src/readings/reading.ts";
import { COMMENT_ID, claimKey, commentKey } from "../src/readings/claims.ts";
import { REMOVED_TEXT, codeFactsOf } from "../src/readings/code-facts.ts";
import { planReadings, type ReadingPlan } from "../src/readings/plan.ts";
import { recordedLane } from "../src/lane-rule.ts";
import {
  REBUILT_VERDICT_MOVES_NOTE,
  replayHold,
  replayNotes,
  type StoredDecision,
} from "../src/readings/replay-hold.ts";
import { noStructure } from "../src/sections.ts";
import {
  briefedOf,
  citation,
  decideSections,
  ownedRangesOf,
  plainText,
  rangeHunksFor,
  rangeHunksOf,
  rowEvidence,
  SECTION_MESSAGE,
  sectionMessage,
  withoutCodes,
  readingCitation,
  sameBatchReferences,
  settledBatches,
  summaryOf,
  unsureNote,
  type CollectedSection,
  type GuidedFrame,
  type KeptFinding,
  type MapGroup,
  type SettledBatch,
} from "../src/readings/settled.ts";
import {
  RECORDS,
  diff,
  judgementFor,
  mixedRange,
  oidOf,
} from "./fixtures/readings.ts";
import { settledOf } from "../src/readings/collect.ts";
import { inputOf, scratch } from "./publish-sections-fixtures.ts";
import * as briefingFixture from "./fixtures/briefing.ts";
import type { GroupEvidence } from "../src/readings/evidence.ts";
import { unitKeyOf } from "../src/publish-sections-input.ts";

const STEP = {
  assess: "a".repeat(64),
  review: "b".repeat(64),
} as const;
const PLAN_KEY = "c".repeat(64);
const MANIFEST_KEY = "d".repeat(64);
const FIND_KEY = "e".repeat(64);

const MARKS = {
  impact: "IMPACT-MARK callers can now count the parsed items",
  defect: "DEFECT-MARK count drops the last item",
  finder: "FINDER-MARK helper adds two where one is meant",
};

/** The files of the mixed range this fixture keeps: two code files and three that are not read. */
const KEPT = new Set([
  "src/parse.ts",
  "src/old.ts",
  "bun.lock",
  "assets/logo.png",
  "data/big.txt",
]);

const range = mixedRange();
// The old file is declared a test file, so its section is placed without the relations gap that sends
// undeclared code to a person (and its comments are about tests).
const hunkList = range.hunks
  .filter((hunk) => KEPT.has(hunk.path))
  .map((hunk) =>
    hunk.path === "src/old.ts"
      ? { ...hunk, declared: [{ kind: "test" as const, by: "fixture" }] }
      : hunk,
  );
const hunks = new Map(hunkList.map((hunk) => [hunk.hunkId, hunk]));
const plan: ReadingPlan = planReadings({
  hunks: hunkList,
  structures: range.structures,
  excluded: range.excluded,
});
const sectionOf = (path: string, name: string | null) =>
  [...plan.sections, ...plan.unread].find(
    (s) => s.path === path && s.name === name,
  )!;
const helper = sectionOf("src/parse.ts", "helper");
const count = sectionOf("src/parse.ts", "count");
const drop = sectionOf("src/old.ts", "drop");

const reviewed = (
  verdict: LaneReviewJudgement["verdict"],
  comments: LaneReviewJudgement["comments"] = [],
): CollectedSection["review"] => ({
  judged: true,
  judgement: { verdict, comments, checked: "", rows: [], unsure: [] },
});
const assessed = (judgement: AssessJudgement): CollectedSection["assess"] => ({
  judged: true,
  judgement,
});

const defect = {
  path: "src/parse.ts",
  side: "new" as const,
  startLine: 11,
  endLine: 11,
  kind: "defect" as const,
  text: MARKS.defect,
  cites: ["src/parse.ts:new:11-11"],
  fails: "",
  row: null,
};

/**
 * helper approves with no comment (human-suggested: undeclared code with no relations shown); count
 * is complex and hard to validate (human-required), requests changes on a confirmed defect and has
 * an impact entry; drop, a proven test, approves (static automation).
 */
const collectedFor = (
  options: {
    readonly dropReview?: CollectedSection["review"];
    readonly dropAssess?: AssessJudgement;
  } = {},
) =>
  new Map<string, CollectedSection>([
    [
      helper.key,
      {
        assess: assessed(judgementFor("human-suggested")),
        review: reviewed("approve"),
        claims: [],
        steps: STEP,
      },
    ],
    [
      count.key,
      {
        assess: assessed({
          ...judgementFor("human-required"),
          impact: [
            {
              effect: "added",
              text: MARKS.impact,
              cites: ["src/parse.ts:new:10-13"],
            },
          ],
        }),
        review: reviewed("request-changes", [defect]),
        claims: [
          { id: claimKey(defect), source: "lane-review", verify: "confirmed" },
        ],
        steps: STEP,
      },
    ],
    [
      drop.key,
      {
        assess: assessed(
          options.dropAssess ?? judgementFor("static-automation"),
        ),
        review: options.dropReview ?? reviewed("approve"),
        claims: [],
        steps: STEP,
      },
    ],
  ]);

/** A kept finder finding, by default a defect on helper's changed line, naming another Map group. */
const finding = (overrides: Partial<StoredFinding> = {}): KeptFinding => ({
  finding: {
    id: "correctness.1",
    lens: "correctness",
    hunkId: helper.hunkIds[0]!,
    claim: MARKS.finder,
    kind: "defect",
    about: "code",
    signal: null,
    critical: false,
    anchors: [{ path: "src/parse.ts", side: "new", startLine: 4, endLine: 4 }],
    doneWhen: null,
    group: "m9",
    evidence: [helper.hunkIds[0]!],
    ...overrides,
  },
  findKey: FIND_KEY,
});

const group = (
  id: string,
  paths: ReadonlyArray<string>,
  doneWhen: ReadonlyArray<string> = [],
): MapGroup => ({
  id,
  label: `Count parsed items (${id})`,
  why: "Callers need the number of parsed items.",
  files: paths.map((path) => ({ path })),
  hunkIds: hunkList.filter((h) => paths.includes(h.path)).map((h) => h.hunkId),
  doneWhen,
});

/** A Frame with no done-when rows: every unit's Guided stop is on no basis. */
const NO_ROWS: GuidedFrame = { stratum: "nothing", doneWhen: [] };

const build = (options: {
  readonly groups: ReadonlyArray<MapGroup>;
  /** The plan the sections were read in; the module's plan when absent. */
  readonly plan?: ReadingPlan;
  readonly findings?: ReadonlyArray<KeptFinding>;
  readonly collected?: ReadonlyMap<string, CollectedSection>;
  /** The map's excluded list, when it is not the one the plan was made from. */
  readonly excluded?: typeof range.excluded;
  /** The sections whose relation evidence both readings were shown whole (the lift). */
  readonly relations?: ReadonlySet<string>;
  /** The Frame's rows; none when absent. */
  readonly frame?: GuidedFrame;
  /** The proof record IDs a cite may name; p1 and p2 when absent. */
  readonly proofs?: ReadonlySet<string>;
}) => {
  const collected = options.collected ?? collectedFor();
  const decided = decideSections({
    plan: options.plan ?? plan,
    hunks,
    groups: options.groups,
    collected,
    proofs: new Map([["src/old.ts", RECORDS]]),
    findings: options.findings ?? [],
    excluded: options.excluded ?? range.excluded,
    ...(options.relations === undefined
      ? {}
      : { relations: options.relations }),
  });
  return {
    decided,
    out: settledBatches({
      planKey: PLAN_KEY,
      manifestKey: MANIFEST_KEY,
      hunks,
      groups: options.groups,
      frame: options.frame ?? NO_ROWS,
      sections: decided.sections,
      collected,
      placement: decided.placement,
      proofs: options.proofs ?? new Set(["p1", "p2"]),
    }),
  };
};

/** The checks the publisher makes, made over a handed-over batch. */
const expectPublishable = (batch: SettledBatch) => {
  const keys = batch.sections.map((s) => s.identity.key);
  // Every section in exactly one unit; a unit's sections share its lane and its path.
  const inUnits = batch.units.flatMap((u) => u.sectionKeys);
  expect([...inUnits].sort()).toEqual([...keys].sort());
  expect(new Set(inUnits).size).toBe(inUnits.length);
  for (const unit of batch.units)
    for (const key of unit.sectionKeys) {
      const section = batch.sections.find((s) => s.identity.key === key)!;
      expect(section.entry.lane.applied).toBe(unit.lane);
      expect(section.identity.parts.path).toBe(unit.path);
    }
  // `entry.key` is the identity's key; at least one owned range, each in the records' form.
  for (const section of batch.sections) {
    expect(section.entry.key).toBe(section.identity.key);
    expect(section.ownedRanges.length).toBeGreaterThan(0);
    for (const owned of section.ownedRanges) OwnedRange.parse(owned);
    // Briefed is code's, from the section's own entry, or null; Explained stays null.
    expect(section.content).toMatchObject({ explained: null });
    expect(
      section.content!.briefed === null ||
        typeof section.content!.briefed === "string",
    ).toBe(true);
  }
  // Every owned line of the batch owned once.
  const lines = batch.sections.flatMap((s) =>
    s.ownedRanges.flatMap((r) =>
      r.kind === "whole-nontext"
        ? [`${r.path}:${r.side}:whole`]
        : Array.from(
            { length: r.endLine - r.startLine + 1 },
            (_, at) => `${r.path}:${r.side}:${r.startLine + at}`,
          ),
    ),
  );
  expect(new Set(lines).size).toBe(lines.length);
  for (const unit of batch.units) {
    const owned = unit.sectionKeys.flatMap(
      (key) => batch.sections.find((s) => s.identity.key === key)!.ownedRanges,
    );
    const ids = unit.comments.map((c) => c.id);
    // Comment IDs: printable ASCII with no space, at most 128 characters, unique within the unit.
    for (const id of ids) expect(id).toMatch(COMMENT_ID);
    expect(new Set(ids).size).toBe(ids.length);
    for (const comment of unit.comments) {
      // Every comment's anchor inside its unit's owned lines; its section one of the unit's.
      expect(comment.anchor).toBeDefined();
      expect(
        owned.some(
          (r) =>
            r.kind === "lines" &&
            r.path === comment.anchor!.path &&
            r.side === comment.anchor!.side &&
            r.startLine <= comment.anchor!.startLine &&
            comment.anchor!.endLine <= r.endLine,
        ),
      ).toBe(true);
      expect(unit.sectionKeys).toContain(comment.section!);
      // Impact carries an effect and a one-line summary of at most 300 characters.
      if (comment.kind === "impact") {
        expect(comment.effect).toBeDefined();
        expect(comment.summary!.length).toBeGreaterThan(0);
        expect(comment.summary!.length).toBeLessThanOrEqual(300);
        expect(comment.summary).not.toContain("\n");
      }
      expect(comment.about).not.toBe("proof");
      for (const cite of comment.evidence) Citation.parse(cite);
    }
    // A disposition has its note; the request for changes rests on comments the unit holds; proof
    // records only on an approval; the lane rule's version on every unit.
    if (unit.disposition !== undefined) expect(unit.message).toBeDefined();
    else expect(unit.message).toBeUndefined();
    if (unit.disposition !== "approve") expect(unit.proof).toEqual([]);
    expect(unit.laneRule).toBe(5);
    if (unit.verdict === "request-changes")
      expect(unit.comments.some((c) => c.restedOn)).toBe(true);
    // Every unit has a Guided stop the records' read schema takes.
    GuidedContent.parse(unit.guided);
  }
  // The digest is code's: counts and facts, no verdict words.
  expect(batch.digest.text).not.toMatch(/approv|request/i);
};

// Reason: this value is another lane's input; a wrong field is silent until a review is published.
test("a settled batch of a mixed range passes every check the publisher makes and every field rule of the contract", () => {
  const all = group("m1", [...KEPT]);
  // The kept finding is a risk about tests: helper is already hard to validate, so its move changes
  // no cell (14.28) and the lanes below are the read sections' own. (A kept defect would make helper
  // request changes, which under lane rule 5 moves both axes and puts it with count in one
  // human-required unit: the kept-finding test covers that, 14.34.)
  const { out } = build({
    groups: [all],
    findings: [finding({ about: "tests", kind: "risk" })],
  });
  expect(out.records.map((r) => [r.mapGroup, r.ready, r.problems])).toEqual([
    ["m1", true, []],
    ["generated", true, []],
  ]);
  expect(out.batches).toHaveLength(2);
  const batch = out.batches[0]!;
  for (const each of out.batches) expectPublishable(each);
  // The lockfile leaves the Map group's batch for the generated one.
  expect(batch).toMatchObject({
    title: all.label,
    focus: all.why,
    paths: [...KEPT].filter((path) => path !== "bun.lock"),
  });
  // Every planned section but the excluded lockfile, in no particular order.
  expect(batch.sections.map((s) => s.title).sort()).toEqual(
    [
      "big.txt at line 1",
      "count in parse.ts",
      "drop in old.ts",
      "helper in parse.ts",
      "logo.png",
    ].sort(),
  );
  // The unreadable file owns one whole non-text range.
  expect(
    batch.sections.find((s) => s.title === "logo.png")!.ownedRanges,
  ).toEqual([{ kind: "whole-nontext", path: "assets/logo.png", side: "new" }]);
  // Three lanes among the read sections of two files, and human-required for the two unread ones.
  const laneOf = (key: string) =>
    batch.units.find((u) => u.sectionKeys.includes(key))!.lane;
  expect([laneOf(helper.key), laneOf(count.key), laneOf(drop.key)]).toEqual([
    "human-suggested",
    "human-required",
    "static-automation",
  ]);
  expect(batch.units).toHaveLength(5);

  // The removal no impact entry names: an impact comment written by code, on the removed lines.
  const removal = batch.units.find((u) => u.path === "src/old.ts")!;
  expect(removal.comments).toEqual([
    {
      id: commentKey({
        path: "src/old.ts",
        side: "old",
        startLine: 4,
        endLine: 6,
        kind: "impact",
        text: "This change removes drop in old.ts (3 lines on the old side), and adds nothing in its place.",
      }),
      section: drop.key,
      kind: "impact",
      effect: "removed",
      summary:
        "This change removes drop in old.ts (3 lines on the old side), and adds nothing in its place.",
      about: "tests",
      body: "This change removes drop in old.ts (3 lines on the old side), and adds nothing in its place.",
      anchor: { path: "src/old.ts", side: "old", startLine: 4, endLine: 6 },
      evidence: [
        { ref: `computation:${MANIFEST_KEY}`, entry: drop.hunkIds[0]! },
      ],
      shown: true,
      restedOn: false,
    },
  ]);
  // A proven static-automation approval records no disposition.
  expect(removal).toMatchObject({
    verdict: "approve",
    disposition: undefined,
    lane: "static-automation",
  });

  // One unit whole: count's request for changes, resting on the confirmed Lane review claim, which
  // ranks above the Assess impact entry (an addition).
  const unit = batch.units.find((u) => u.sectionKeys.includes(count.key))!;
  const impactAnchor = {
    path: "src/parse.ts",
    side: "new" as const,
    startLine: 10,
    endLine: 13,
  };
  expect(unit).toEqual({
    path: "src/parse.ts",
    lane: "human-required",
    laneRule: 5,
    sectionKeys: [count.key],
    verdict: "request-changes",
    disposition: "request-changes",
    message: "This request for changes rests on 1 confirmed defect.",
    proof: [],
    comments: [
      {
        id: claimKey(defect),
        section: count.key,
        kind: "defect",
        about: "code",
        body: MARKS.defect,
        anchor: {
          path: "src/parse.ts",
          side: "new",
          startLine: 11,
          endLine: 11,
        },
        evidence: [
          {
            ref: `computation:${STEP.review}`,
            entry: "src/parse.ts:new:11-11",
          },
        ],
        shown: true,
        restedOn: true,
      },
      {
        id: commentKey({ ...impactAnchor, kind: "impact", text: MARKS.impact }),
        section: count.key,
        kind: "impact",
        effect: "added",
        summary: MARKS.impact,
        about: "code",
        body: MARKS.impact,
        anchor: impactAnchor,
        evidence: [
          {
            ref: `computation:${STEP.assess}`,
            entry: "src/parse.ts:new:10-13",
          },
        ],
        shown: true,
        restedOn: false,
      },
    ],
    // Re-pinned (round 25): the Guided stop on every unit. No Frame row here, so no basis; an
    // agent decided the human-required unit, so it has the review and the suggestion.
    guided: {
      lane: "human-required",
      basis: "none",
      unlinked: true,
      stratum: "nothing",
      rows: [],
      outside: [],
      implied: [
        {
          requirement: "Parsing an empty list returns no rows.",
          kinds: ["test-run", "static-analysis"],
          proof: [],
        },
      ],
      omitted: [],
      review: {
        source: "agent",
        verdict: "request-changes",
        message: "This request for changes rests on 1 confirmed defect.",
        uncited: false,
        withheld: false,
        gaps: [],
      },
      suggestion: {
        verdict: "request-changes",
        message: "This request for changes rests on 1 confirmed defect.",
      },
      proof: expect.any(String),
      notes: [],
    },
  });
  // Its section: identity whole, title, owned ranges with path and side, the entry as decided,
  // and its code facts.
  const section = batch.sections.find((s) => s.identity.key === count.key)!;
  expect(section.identity).toEqual(count.identity);
  expect(section.ownedRanges).toEqual([
    {
      kind: "lines",
      path: "src/parse.ts",
      side: "new",
      startLine: 10,
      endLine: 13,
    },
  ]);
  expect(section.entry).toMatchObject({
    key: count.key,
    verdict: "request-changes",
    restsOn: [claimKey(defect)],
  });
  expect(section.content!.facts.text).toStartWith(
    "count in parse.ts: 4 lines added.",
  );
  expect(batch.digest.text).toStartWith(
    `5 units in 4 files for "${all.label}".`,
  );
  // Nothing about the run: every finding was placed.
  expect(out.gaps).toEqual([]);
  expect(out.totals).toEqual({ batches: 2, sections: 6 });

  // The generated batch: today's code-only batch, now handed over with its one unit per file.
  const lockfile = sectionOf("bun.lock", null);
  expect(out.batches[1]).toEqual({
    title: "Lockfiles and generated files",
    focus: "Lockfiles and declared-generated files accompany the change.",
    paths: ["bun.lock"],
    sections: [
      {
        identity: lockfile.identity,
        title: "bun.lock at line 1",
        ownedRanges: [
          {
            kind: "lines",
            path: "bun.lock",
            side: "new",
            startLine: 1,
            endLine: 1,
          },
          {
            kind: "lines",
            path: "bun.lock",
            side: "old",
            startLine: 1,
            endLine: 1,
          },
        ],
        // Each owned range's hunk (round 27b, records' `rangeHunks`).
        rangeHunks: lockfile.owned.map((range) => range.hunkId),
        entry: {
          key: lockfile.key,
          facts: {
            kind: "hunk",
            declared: null,
            boundaries: "fallback",
            characters: lockfile.characters,
          },
          assess: null,
          review: null,
          lane: {
            judged: null,
            surfaced: null,
            floors: [],
            applied: "human-suggested",
          },
          excluded: { reason: "lockfile" },
          impact: [],
          verdict: null,
          restsOn: [],
          lineage: "fresh",
          floorInputs: {
            facts: {
              removesDeclaration: false,
              removesPublicName: false,
              effects: [],
            },
            options: { removal: false },
          },
        },
        content: {
          facts: {
            // Code's plain sentence; the plan's change facts are the readings' and are not shown.
            text: "bun.lock at line 1: 1 line added and 1 removed.",
            cites: [...lockfile.hunkIds],
          },
          briefed: null,
          explained: null,
        },
      },
    ],
    units: [
      {
        path: "bun.lock",
        lane: "human-suggested",
        laneRule: 5,
        sectionKeys: [lockfile.key],
        verdict: null,
        disposition: undefined,
        proof: [],
        comments: [],
        // Re-pinned (round 25): the generated batch's unit has a Guided stop with no rows and,
        // with no agent decision and no unsure section, no review, suggestion or note.
        guided: {
          lane: "human-suggested",
          basis: "none",
          unlinked: false,
          stratum: "nothing",
          rows: [],
          outside: [],
          implied: [],
          omitted: [],
          review: null,
          suggestion: null,
          proof: expect.any(String),
          notes: [],
        },
      },
    ],
    digest: {
      text: '1 unit in 1 file for "Lockfiles and generated files". bun.lock at line 1: 1 line added and 1 removed.',
      limitations: [
        "This briefing was put together by code from each unit's facts.",
      ],
      // Round 27: code always names itself as the digest's writer, and writes the verification
      // and the obligations (none here: the generated batch has no rows).
      source: "code",
      verification: "No unit of this batch names a checkpoint.",
      obligations: [],
    },
  });
});

// Reason: findings must not be lost or misplaced when units change shape.
test("a kept finder defect makes its section request changes, placed by its anchor though it names another Map group", () => {
  const { out, decided } = build({
    groups: [group("m1", [...KEPT])],
    findings: [finding()],
  });
  // A confirmed finder claim reached the deciding code before the lane and the verdict.
  const entry = decided.sections.find((s) => s.section.key === helper.key)!;
  expect(entry.claims).toEqual([
    { id: "correctness.1", source: "finder", verify: "confirmed" },
  ]);
  expect(entry.decision).toMatchObject({
    settled: true,
    verdict: "request-changes",
    restsOn: ["correctness.1"],
  });
  const unit = out.batches[0]!.units.find((u) =>
    u.sectionKeys.includes(helper.key),
  )!;
  // The kept defect about code is also a move on complexity (14.28): helper, low and hard, becomes
  // high and hard, cited on both axes, so human-required beside count.
  expect(unit).toMatchObject({
    lane: "human-required",
    verdict: "request-changes",
    disposition: "request-changes",
  });
  expect(unit.comments.filter((c) => c.section === helper.key)).toEqual([
    {
      id: "correctness.1",
      section: helper.key,
      kind: "defect",
      about: "code",
      body: MARKS.finder,
      anchor: { path: "src/parse.ts", side: "new", startLine: 4, endLine: 4 },
      evidence: [
        { ref: `computation:${MANIFEST_KEY}`, entry: helper.hunkIds[0]! },
      ],
      shown: true,
      restedOn: true,
    },
  ]);
  // A finding's ID outside the records' form is hashed, the same in the claim and the comment.
  const odd = build({
    groups: [group("m1", [...KEPT])],
    findings: [finding({ id: "correctness one" })],
  }).out.batches[0]!.units.find((u) => u.sectionKeys.includes(helper.key))!;
  const oddComment = odd.comments.find((c) => c.section === helper.key)!;
  expect(oddComment.id).toMatch(/^f\.[0-9a-f]{64}$/);
  expect(oddComment.restedOn).toBe(true);
});

// Reason: nothing dropped silently.
test("a finding whose anchor no section owns is returned as unplaced with a reason and disclosed", () => {
  const { out } = build({
    groups: [group("m1", [...KEPT])],
    findings: [
      // The unchanged import line: no section owns it.
      finding({
        id: "risky-edges.1",
        kind: "risk",
        anchors: [
          { path: "src/parse.ts", side: "new", startLine: 1, endLine: 1 },
        ],
      }),
      // The excluded lockfile, on the batch's own group.
      finding({
        id: "risky-edges.2",
        kind: "question",
        group: "m1",
        anchors: [{ path: "bun.lock", side: "new", startLine: 1, endLine: 1 }],
      }),
    ],
  });
  expect(out.unplaced).toEqual([
    { id: "risky-edges.1", group: "m9", reason: "no-owner" },
    { id: "risky-edges.2", group: "m1", reason: "excluded" },
  ]);
  // One gap about the run (its group is no batch), one on the batch it named.
  expect(out.gaps).toEqual([
    {
      key: expect.stringMatching(/^finding-unplaced:[0-9a-f]{16}$/),
      kind: "finding-unplaced",
      detail:
        "One verified finding is on lines no changed section owns, so it is not shown on any unit.",
    },
  ]);
  expect(out.batches[0]!.gaps).toEqual([
    {
      key: expect.stringMatching(/^finding-unplaced:[0-9a-f]{16}$/),
      kind: "finding-unplaced",
      detail:
        "One verified finding is on a lockfile or a generated file, which no reading reads, so it is not shown on any unit.",
    },
  ]);
  // Neither is on any unit.
  for (const unit of out.batches[0]!.units)
    expect(unit.comments.map((c) => c.id)).not.toContain("risky-edges.1");
});

// Reason: a batch that is not settled is never published.
test("an unsettled group yields no settled batch and counts in the totals as pending", () => {
  const groups = [
    group("m1", ["src/parse.ts", "bun.lock", "assets/logo.png"]),
    group("m2", ["src/old.ts", "data/big.txt"]),
  ];
  const { out } = build({
    groups,
    // drop's Lane review was not reached before the follow-on cap: m2 waits.
    collected: collectedFor({
      dropReview: { judged: false, cause: "not-reached" },
    }),
  });
  expect(out.batches.map((b) => b.title)).toEqual([
    groups[0]!.label,
    "Lockfiles and generated files",
  ]);
  expect(out.records).toEqual([
    expect.objectContaining({ mapGroup: "m1", settled: true, ready: true }),
    {
      mapGroup: "m2",
      settled: false,
      ready: false,
      reason: "waiting",
      sections: {
        settled: 1,
        waiting: { "not-reached": 1 },
        unread: { "too-large": 1 },
      },
      units: 0,
      problems: [],
    },
    expect.objectContaining({
      mapGroup: "generated",
      settled: true,
      ready: true,
    }),
  ]);
  // Totals of the whole review: three batches (the generated one too), one pending; m2's two
  // sections count.
  expect(out.totals).toEqual({ batches: 3, sections: 6 });
  expect(out.totals.batches - out.batches.length).toBe(1);
  // Units form for the settled batches only.
  expect(out.formed.map((f) => f.mapGroup)).toEqual(["m1", "generated"]);
});

// Reason: the records schema refuses an entry outside its bounds.
test("evidence in Citation form: an entry only where the records' bounds take it, the ref alone otherwise", () => {
  const ref = `computation:${STEP.review}`;
  const context = {
    step: STEP.review,
    planKey: PLAN_KEY,
    proofs: new Set<string>(),
  };
  expect(readingCitation("src/parse.ts:new:11-11", context)).toEqual([
    { ref, entry: "src/parse.ts:new:11-11" },
  ]);
  const long = `src/${"deep/".repeat(30)}file.ts:new:1-2`;
  for (const cite of [
    long,
    "src/café.ts:new:1-1",
    "src/two words.ts:old:3-4",
    'src/"quoted".ts:new:1-1',
  ])
    expect(readingCitation(cite, context)).toEqual([{ ref }]);
  // A change fact names the plan, which holds the facts; a proof record its event.
  const fact = `${count.key}.declaration`;
  expect(readingCitation(fact, context)).toEqual([
    { ref: `computation:${PLAN_KEY}`, entry: fact },
  ]);
  const proof = "01JABCDEFGHJKMNPQRSTVWXYZ0";
  expect(
    readingCitation(proof, { ...context, proofs: new Set([proof]) }),
  ).toEqual([{ ref: `event:${proof}` }]);
  for (const cite of [
    citation(ref, long),
    citation(ref, "src/parse.ts:new:1-2"),
  ])
    Citation.parse(cite);
  expect(citation(ref, long)).toEqual({ ref });
});

// Reason: the desk shows what it is handed; a claim Verify could not confirm must read as a question,
// never as a defect, and a refuted one must never be shown or rested on (the owner's ruling).
test("a defect claim Verify neither confirmed nor refuted is handed over as a question with its claim's ID; a refuted one stays an unshown defect", () => {
  // The reviewer's probe 3: one changed line per file, no structure, an agentic Assess, and a
  // request for changes on one defect whose claim is unconfirmed, refuted or confirmed.
  const before = "a\nb\nc\nd\n";
  const after = "a\nB\nc\nd\n";
  const files = ["unconfirmed.ts", "refuted.ts", "confirmed.ts"] as const;
  const list = files.flatMap((path) => diff(path, before, after));
  const none = noStructure("unsupported-language", null, 0);
  const local = planReadings({
    hunks: list,
    structures: new Map([
      [oidOf(before), none],
      [oidOf(after), none],
    ]),
    excluded: [],
  });
  const byId = new Map(list.map((h) => [h.hunkId, h]));
  const collected = new Map<string, CollectedSection>();
  const claimOf = new Map<string, string>();
  for (const section of local.sections) {
    const comment = {
      path: section.path,
      side: "new" as const,
      startLine: 2,
      endLine: 2,
      kind: "defect" as const,
      text: `defect on ${section.path}`,
      cites: [`${section.path}:new:2-2`],
      fails: "",
      row: null,
    };
    claimOf.set(section.path, claimKey(comment));
    collected.set(section.key, {
      assess: assessed(judgementFor("agentic")),
      review: reviewed("request-changes", [comment]),
      claims: [
        {
          id: claimKey(comment),
          source: "lane-review",
          verify: section.path.replace(".ts", "") as
            "unconfirmed" | "refuted" | "confirmed",
        },
      ],
      steps: STEP,
    });
  }
  const groups = [group("m1", [...files])].map((g) => ({
    ...g,
    hunkIds: list.map((h) => h.hunkId),
  }));
  const decided = decideSections({
    plan: local,
    hunks: byId,
    groups,
    collected,
    proofs: new Map(),
    findings: [],
    excluded: [],
  });
  const out = settledBatches({
    planKey: PLAN_KEY,
    manifestKey: MANIFEST_KEY,
    hunks: byId,
    groups,
    frame: NO_ROWS,
    sections: decided.sections,
    collected,
    placement: decided.placement,
    proofs: new Set(),
  });
  expect(out.batches).toHaveLength(1);
  expectPublishable(out.batches[0]!);
  const unitOf = (path: string) =>
    out.batches[0]!.units.find((u) => u.path === path)!;
  const fate = (path: string) => {
    const [comment] = unitOf(path).comments;
    return [
      comment!.id,
      comment!.kind,
      comment!.shown,
      comment!.restedOn,
    ] as ReadonlyArray<unknown>;
  };
  expect(fate("unconfirmed.ts")).toEqual([
    claimOf.get("unconfirmed.ts"),
    "question",
    true,
    false,
  ]);
  expect(unitOf("unconfirmed.ts")).toMatchObject({
    lane: "human-required",
    verdict: null,
  });
  expect(fate("refuted.ts")).toEqual([
    claimOf.get("refuted.ts"),
    "defect",
    false,
    false,
  ]);
  expect(fate("confirmed.ts")).toEqual([
    claimOf.get("confirmed.ts"),
    "defect",
    true,
    true,
  ]);
  expect(unitOf("confirmed.ts").verdict).toBe("request-changes");
});

// Reason: one comment that breaks its own rules must not keep a whole batch from being published,
// and must never be dropped silently; but a request for changes must never rest on nothing.
test("a comment that breaks its rules is withheld alone and disclosed; one a request for changes rests on fails the batch", () => {
  const offLines = {
    ...defect,
    kind: "risk" as const,
    startLine: 1,
    endLine: 1,
    text: "a risk on an unchanged line",
    cites: [],
  };
  const wordless = {
    ...defect,
    kind: "impact" as const,
    effect: "changed" as const,
    text: "\u2014 \u2014",
    cites: [],
  };
  const collected = collectedFor();
  const held = collected.get(count.key)!;
  collected.set(count.key, {
    ...held,
    review: reviewed("request-changes", [defect, offLines, wordless]),
  });
  const { out } = build({ groups: [group("m1", [...KEPT])], collected });
  const batch = out.batches[0]!;
  expect(out.records[0]).toMatchObject({ mapGroup: "m1", ready: true });
  expectPublishable(batch);
  expect(batch.withheld).toEqual([
    {
      id: commentKey({ ...offLines, kind: "risk" }),
      reason: "anchor-outside",
    },
    {
      id: commentKey({ ...wordless, kind: "impact" }),
      reason: "no-summary",
    },
  ]);
  expect(batch.gaps).toContainEqual({
    key: expect.stringMatching(/^comments-withheld:[0-9a-f]{16}$/),
    kind: "comments-withheld",
    detail:
      "2 comments on this batch could not be shown as written, so they are withheld.",
  });
  const unit = batch.units.find((u) => u.sectionKeys.includes(count.key))!;
  expect(unit.comments.map((c) => c.kind)).toEqual(["defect", "impact"]);

  // The request for changes rests on a defect off the section's lines: the batch fails.
  const stray = { ...defect, startLine: 1, endLine: 1 };
  const failing = collectedFor();
  failing.set(count.key, {
    ...failing.get(count.key)!,
    review: reviewed("request-changes", [stray]),
    claims: [
      { id: claimKey(stray), source: "lane-review", verify: "confirmed" },
    ],
  });
  const failed = build({
    groups: [group("m1", [...KEPT])],
    collected: failing,
  });
  expect(failed.out.batches.map((b) => b.title)).toEqual([
    "Lockfiles and generated files",
  ]);
  expect(failed.out.records[0]).toMatchObject({
    mapGroup: "m1",
    ready: false,
    reason: "checks-failed",
    problems: [
      expect.stringContaining(
        `rests on comment ${claimKey(stray)}, which is withheld (anchor-outside)`,
      ),
    ],
  });

  // A summary is cut between code points, never inside a surrogate pair.
  const cut = summaryOf(`a${"\u{1F600}".repeat(150)}`);
  expect(cut.length).toBe(299);
  expect(cut).toBe(`a${"\u{1F600}".repeat(149)}`);
});

// Reason: the publisher's pending count must be able to reach zero; what can never be published is
// disclosed, not counted.
test("sections no Map group holds are a run gap and are not counted in the totals", () => {
  const { out } = build({
    groups: [
      group("m1", [
        "src/parse.ts",
        "bun.lock",
        "assets/logo.png",
        "data/big.txt",
      ]),
    ],
  });
  expect(out.records.map((r) => [r.mapGroup, r.reason])).toEqual([
    ["m1", null],
    ["generated", null],
    [null, "no-map-group"],
  ]);
  // m1's four sections and the lockfile's; not old.ts's drop.
  expect(out.totals).toEqual({ batches: 2, sections: 5 });
  expect(out.totals.batches - out.batches.length).toBe(0);
  expect(out.gaps).toEqual([
    {
      key: "sections-without-batch",
      kind: "sections-without-batch",
      detail:
        "1 changed section belongs to no batch of this review, so it is not published.",
    },
  ]);
});

// Reason: a file the plan excluded but the map does not name cannot come through `collect`; from any
// other caller it is a mismatch, so no reason may be guessed for it (it was read as a lockfile): it
// is a run gap, in no batch, and still pending, so the review cannot read as finished without it.
test("a section the plan excluded that the map does not name is undecided, in no batch, pending and a run gap", () => {
  const all = group("m1", [...KEPT]);
  const { decided, out } = build({ groups: [all], excluded: [] });
  const lockfile = sectionOf("bun.lock", null);
  const entry = decided.sections.find((s) => s.section.key === lockfile.key)!;
  expect(entry).toMatchObject({
    cause: "excluded",
    decision: null,
    mapGroup: null,
  });
  // No generated batch, and the lockfile in no batch at all.
  expect(out.records.map((r) => r.mapGroup)).toEqual(["m1"]);
  for (const batch of out.batches)
    expect(batch.sections.map((s) => s.identity.key)).not.toContain(
      lockfile.key,
    );
  // Counted as pending: one more section than the batches hold.
  const held = out.batches.reduce((sum, b) => sum + b.sections.length, 0);
  expect(out.totals.sections).toBe(held + 1);
  expect(out.gaps).toEqual([
    {
      key: "sections-excluded-unnamed",
      kind: "sections-excluded-unnamed",
      detail:
        "1 changed section was left out of the readings for a reason the review's map does not give, so it is in no batch and still pending.",
    },
  ]);
});

// Reason: a removal the code shows must reach the reviewer. An impact comment that says "removed"
// but is withheld is not shown, so it cannot stand for the removal: only a kept one does.
test("a withheld impact comment does not stand for a removal; code's own removal comment still appears, and a kept one replaces it", () => {
  const all = group("m1", [...KEPT]);
  const old = drop.owned.find((range) => range.side === "old")!;
  const removal = (startLine: number) => ({
    path: "src/old.ts",
    side: "old" as const,
    startLine,
    endLine: startLine,
    kind: "impact" as const,
    effect: "removed" as const,
    text: "REMOVED-MARK the drop helper is gone",
    cites: [],
    fails: "",
    row: null,
  });
  const code =
    "This change removes drop in old.ts (3 lines on the old side), and adds nothing in its place.";
  const bodiesWith = (comment: ReturnType<typeof removal>) => {
    const { out } = build({
      groups: [all],
      collected: collectedFor({ dropReview: reviewed("approve", [comment]) }),
    });
    const batch = out.batches.find((b) => b.title === all.label)!;
    return {
      bodies: batch.units
        .flatMap((u) => u.comments)
        .filter((c) => c.section === drop.key)
        .map((c) => c.body),
      withheld: batch.withheld ?? [],
    };
  };
  // Anchored on lines the section does not own: withheld, and the code's comment still appears.
  const outside = bodiesWith(removal(old.endLine + 500));
  expect(outside.withheld.map((w) => w.reason)).toEqual(["anchor-outside"]);
  expect(outside.bodies).toEqual([code]);
  // Kept on the section's old lines: it says the removal, and code adds none.
  const kept = bodiesWith(removal(old.startLine));
  expect(kept.withheld).toEqual([]);
  expect(kept.bodies).toEqual(["REMOVED-MARK the drop helper is gone"]);
});

// Reason (round 2f): code now writes a removed declaration's `removed` impact entry into the Assess
// judgement from the plan's facts, by the same rule as code's own removal comment. The comment must
// appear once, as code's, never doubled by the entry, and the entry reaches the floor rule's facts.
test("code's removed impact entry does not double code's removal comment", () => {
  const code = codeFactsOf(drop);
  expect(code.impact).toEqual([
    {
      effect: "removed",
      text: REMOVED_TEXT,
      cites: [`${drop.key}.declaration`, `${drop.key}.old-side-only`],
    },
  ]);
  const base = judgementFor("static-automation");
  const { out } = build({
    groups: [group("m1", [...KEPT])],
    collected: collectedFor({
      dropAssess: {
        ...base,
        codeFactors: code.factors.map((f) => ({ ...f, cites: [...f.cites] })),
        impact: code.impact.map((entry) => ({
          ...entry,
          cites: [...entry.cites],
        })),
      },
    }),
  });
  const batch = out.batches.find((b) => b.title === group("m1", []).label)!;
  const bodies = batch.units
    .flatMap((u) => u.comments)
    .filter((c) => c.section === drop.key)
    .map((c) => c.body);
  expect(bodies).toEqual([
    "This change removes drop in old.ts (3 lines on the old side), and adds nothing in its place.",
  ]);
  expect(batch.withheld ?? []).toEqual([]);
});

// Reason (round 2h): the model no longer writes a line per section saying what it adds. Taking that
// line away must not take away the lines that matter: a section that only adds code gets no impact
// comment from Assess, and a section the facts show removing a declaration still gets code's
// `removed` entry in its judgement and code's removal comment, once.
test("from a new Assess answer, a section that only adds code gets no Assess impact comment, and a removed declaration keeps code's entry and comment", () => {
  // The judgements as a new answer expands them: one class over every section, no impact entry.
  const judged = new Map<string, AssessJudgement>();
  for (const readingGroup of plan.groups) {
    const index = readingIndexOf(plan, readingGroup.id, {
      facts: [],
      proofs: [],
      rows: [],
    });
    const answer: AssessAnswer = {
      factors: [],
      requirements: [],
      impact: [],
      classes: [
        {
          S: index.sections.map((s) => s.index),
          c: "l",
          v: "e",
          F: [],
          R: [],
          person: null,
          gaps: null,
        },
      ],
    };
    for (const { key, judgement } of assessExpand(answer, index))
      judged.set(key, judgement);
  }
  // count only adds code (a new declaration); drop removes one, as the plan's facts show.
  expect(count.owned.every((r) => r.side === "new")).toBe(true);
  expect(judged.get(count.key)!.impact).toEqual([]);
  expect(judged.get(drop.key)!.impact).toEqual([
    {
      effect: "removed",
      text: REMOVED_TEXT,
      cites: [`${drop.key}.declaration`, `${drop.key}.old-side-only`],
    },
  ]);
  const commentsWith = (countAssess: AssessJudgement) => {
    const base = collectedFor({ dropAssess: judged.get(drop.key)! });
    const collected = new Map(base);
    collected.set(helper.key, {
      ...base.get(helper.key)!,
      assess: assessed(judged.get(helper.key)!),
    });
    collected.set(count.key, {
      ...base.get(count.key)!,
      assess: assessed(countAssess),
    });
    const { out } = build({ groups: [group("m1", [...KEPT])], collected });
    const batch = out.batches.find((b) => b.title === group("m1", []).label)!;
    expect(batch.withheld ?? []).toEqual([]);
    const impact = (key: string) =>
      batch.units
        .flatMap((u) => u.comments)
        .filter((c) => c.section === key && c.kind === "impact")
        .map((c) => [c.effect, c.body]);
    return {
      count: impact(count.key),
      helper: impact(helper.key),
      drop: impact(drop.key),
    };
  };
  expect(commentsWith(judged.get(count.key)!)).toEqual({
    count: [],
    helper: [],
    drop: [
      [
        "removed",
        "This change removes drop in old.ts (3 lines on the old side), and adds nothing in its place.",
      ],
    ],
  });
  // Not vacuous: the same section judged with an `added` entry, as an older version stored it,
  // gets an impact comment from Assess.
  expect(
    commentsWith({
      ...judged.get(count.key)!,
      impact: [{ effect: "added", text: MARKS.impact, cites: [] }],
    }).count,
  ).toEqual([["added", MARKS.impact]]);
});

// Reason (effort by risk): with the setting on, a file's sections may be read in two
// reading groups, one per effort class. Units are formed from settled sections by file and lane
// (`composeUnits` reads a section's path, place and decision, never its reading group), so a file
// read in two groups must give exactly the units it gives read in one.
test("a file whose sections were read in two reading groups gives the units it gives read in one", () => {
  const split = planReadings({
    hunks: hunkList,
    structures: range.structures,
    excluded: range.excluded,
    split: "by-risk",
  });
  // The same sections; parse.ts's public-surface `count` is read apart from its plain `helper`.
  expect(split.sections).toEqual(plan.sections);
  const groupsOf = (p: ReadingPlan, key: string) =>
    p.groups.filter((g) => g.keys.includes(key)).map((g) => g.id);
  expect(groupsOf(plan, count.key)).toEqual(groupsOf(plan, helper.key));
  expect(groupsOf(split, count.key)).not.toEqual(groupsOf(split, helper.key));
  expect(
    split.groups.filter((g) => g.paths.includes("src/parse.ts")),
  ).toHaveLength(2);
  const groups = [group("m1", ["src/parse.ts", "src/old.ts"])];
  const unitsOf = (built: ReturnType<typeof build>) =>
    built.out.batches.map((batch) => batch.units);
  const one = build({ groups });
  const two = build({ groups, plan: split });
  expect(unitsOf(one).flat().length).toBeGreaterThan(1);
  expect(unitsOf(two)).toEqual(unitsOf(one));
});

// Reason (14.28, replacing round 22's floor test; plant 203): a finder finding Verify kept is a move
// on the matrix, not a floor. The lift took a low, easy, approved section with a kept risk to agentic,
// so the person never saw it: as a move, the risk about code makes it high and easy, the reading's
// agentic answer is void, and it is human-suggested with the agent's approval beside it. A finding
// about tests makes it hard to validate; a pattern note moves nothing (ruling 1); nothing is lowered.
test("a kept finding is a move on the matrix: a risk about code raises complexity, one about tests makes it hard, a pattern note moves nothing, the verdict kept", () => {
  const groups = [group("m1", [...KEPT])];
  // helper: low and easy, approved, its relations gap lifted (shown whole), so agentic on its own.
  const lifted = new Map(collectedFor());
  lifted.set(helper.key, {
    assess: assessed(judgementFor("agentic")),
    review: reviewed("approve"),
    claims: [],
    steps: STEP,
  });
  const decide = (findings: ReadonlyArray<KeptFinding>) => {
    const { decided, out } = build({
      groups,
      collected: lifted,
      findings,
      relations: new Set([helper.key]),
    });
    const entryOf = (key: string) => {
      const decision = decided.sections.find(
        (s) => s.section.key === key,
      )!.decision!;
      if (!decision.settled) throw new Error("not settled");
      return decision.entry;
    };
    const unitOf = (key: string) =>
      out.batches[0]!.units.find((u) => u.sectionKeys.includes(key))!;
    return { entryOf, unitOf };
  };
  const risk = finding({
    id: "risky-edges.1",
    lens: "risky-edges",
    kind: "risk",
  });
  const recomputed = (
    entry: ReturnType<ReturnType<typeof decide>["entryOf"]>,
  ) =>
    recordedLane(
      {
        assess: entry.assess,
        lane: { floors: entry.lane.floors },
      },
      [],
    );

  // No kept finding: the lift makes it agentic, approved; no move and no floor.
  const none = decide([]);
  expect(none.entryOf(helper.key).lane).toEqual({
    judged: "agentic",
    surfaced: "agentic",
    floors: [],
    applied: "agentic",
  });
  expect(none.entryOf(helper.key).assess!.movement).toEqual([]);
  expect(none.entryOf(helper.key).floorInputs.facts).toEqual({
    removesDeclaration: false,
    removesPublicName: false,
    effects: [],
  });

  // The plant-203 shape: the kept risk about code is one move on complexity, cited by its ID; the
  // section is human-suggested by `laneOf` itself (no floor), still approved, the finding shown.
  const withRisk = decide([risk]);
  const entry = withRisk.entryOf(helper.key);
  expect(entry.assess!.movement).toEqual([
    {
      signal: "kept-finding",
      axis: "complexity",
      direction: "toward-human",
      cites: ["risky-edges.1"],
    },
  ]);
  expect(entry.lane).toEqual({
    judged: "human-suggested",
    surfaced: "human-suggested",
    floors: [],
    applied: "human-suggested",
  });
  // The stored entry's lane is what the rule gives from the entry alone.
  expect(recomputed(entry).applied).toBe("human-suggested");
  expect(recomputed(entry).quadrant).toBe("high-easy");
  expect(entry.verdict).toBe("approve");
  expect(withRisk.unitOf(helper.key)).toMatchObject({
    lane: "human-suggested",
    verdict: "approve",
    disposition: "approve",
  });
  expect(
    withRisk.unitOf(helper.key).comments.map((c) => [c.id, c.kind]),
  ).toEqual([["risky-edges.1", "risk"]]);

  // A question about code moves complexity the same way.
  expect(
    decide([finding({ id: "x.question", kind: "question" })]).entryOf(
      helper.key,
    ).lane.applied,
  ).toBe("human-suggested");
  // A risk about tests makes validation hard: low and hard, human-suggested.
  const tests = decide([
    finding({ id: "tests.1", lens: "tests", kind: "risk", about: "tests" }),
  ]).entryOf(helper.key);
  expect(tests.assess!.movement.map((m) => m.axis)).toEqual([
    "ease-of-validation",
  ]);
  expect(recomputed(tests).quadrant).toBe("low-hard");
  expect(tests.lane.applied).toBe("human-suggested");
  // A pattern note gives no move: the section stays agentic, the note still shown on its unit.
  const note = decide([finding({ id: "x.note", kind: "pattern-note" })]);
  expect(note.entryOf(helper.key).assess!.movement).toEqual([]);
  expect(note.entryOf(helper.key).lane.applied).toBe("agentic");
  expect(note.unitOf(helper.key).comments.map((c) => [c.id, c.kind])).toEqual([
    ["x.note", "pattern-note"],
  ]);

  // A kept defect: a move on complexity, and the verdict a request for changes resting on it, which
  // under lane rule 5 also moves both axes (14.34): high and hard, human-required.
  const withDefect = decide([finding()]);
  expect(withDefect.entryOf(helper.key)).toMatchObject({
    lane: { floors: [], applied: "human-required" },
    verdict: "request-changes",
    restsOn: ["correctness.1"],
  });
  expect(
    withDefect
      .entryOf(helper.key)
      .assess!.movement.map((m) => [m.signal, m.axis]),
  ).toEqual([
    ["kept-finding", "complexity"],
    ["confirmed-request-changes", "complexity"],
    ["confirmed-request-changes", "ease-of-validation"],
  ]);
  expect(withDefect.unitOf(helper.key)).toMatchObject({
    lane: "human-required",
    disposition: "request-changes",
  });

  // Nothing is lowered: count is human-required, and a kept risk on it leaves it there.
  const onCount = decide([
    finding({
      id: "risky-edges.2",
      lens: "risky-edges",
      kind: "risk",
      hunkId: count.hunkIds[0]!,
      anchors: [
        { path: "src/parse.ts", side: "new", startLine: 11, endLine: 11 },
      ],
      evidence: [count.hunkIds[0]!],
    }),
  ]);
  // The kept risk's move, then the two its confirmed Lane review defect's request gives (14.34).
  expect(onCount.entryOf(count.key).assess!.movement).toHaveLength(3);
  expect(onCount.entryOf(count.key).lane).toMatchObject({
    floors: [],
    applied: "human-required",
  });
  // A finding placed elsewhere moves nothing here.
  expect(onCount.entryOf(helper.key).assess!.movement).toEqual([]);
  expect(onCount.entryOf(helper.key).lane.applied).toBe("agentic");
});

// Reason (14.34, both axes; the release lane's clean-account run): a change to a test file had three
// planted bugs, the Lane review requested changes on three defect claims Verify confirmed, no finder
// finding was kept, and Assess called it easy to validate; rule 4 published the unit human-suggested,
// so the batch counted no unit needing a person. Under rule 5 the section, its unit and so the
// batch's count of units needing a person all say human-required. Kept finder defects about tests on
// the same section, which moved validation under rule 4, still move it, and the request they make
// is human-required too. An approval beside a kept pattern note gives no move at all.
test("a test file's request for changes on three confirmed Lane review defects is human-required, its unit too, at either complexity", () => {
  const groups = [group("m1", [...KEPT])];
  const owned = drop.owned.find((range) => range.side === "old")!;
  const dropDefect = (n: number) => ({
    ...defect,
    path: "src/old.ts",
    side: "old" as const,
    startLine: owned.startLine,
    endLine: owned.startLine,
    text: `DROP-DEFECT-${n} the test asserts the wrong count`,
    cites: [`src/old.ts:old:${owned.startLine}-${owned.startLine}`],
  });
  const defects = [1, 2, 3].map(dropDefect);
  for (const level of ["low", "high"] as const) {
    const collected = new Map(collectedFor());
    collected.set(drop.key, {
      assess: assessed({
        ...judgementFor("static-automation"),
        complexity: { ...judgementFor("static-automation").complexity, level },
      }),
      review: reviewed("request-changes", defects),
      claims: defects.map((d) => ({
        id: claimKey(d),
        source: "lane-review" as const,
        verify: "confirmed" as const,
      })),
      steps: STEP,
    });
    const { decided, out } = build({ groups, collected });
    const decision = decided.sections.find(
      (s) => s.section.key === drop.key,
    )!.decision!;
    if (!decision.settled) throw new Error("not settled");
    expect(decision.entry.verdict).toBe("request-changes");
    expect(decision.entry.restsOn).toHaveLength(3);
    expect(
      decision.entry.assess!.movement.map((m) => [
        m.signal,
        m.axis,
        m.cites.length,
      ]),
    ).toEqual([
      ["confirmed-request-changes", "complexity", 3],
      ["confirmed-request-changes", "ease-of-validation", 3],
    ]);
    expect(decision.entry.lane.applied).toBe("human-required");
    const unit = out.batches
      .flatMap((b) => b.units)
      .find((u) => u.sectionKeys.includes(drop.key))!;
    expect([level, unit.lane, unit.disposition]).toEqual([
      level,
      "human-required",
      "request-changes",
    ]);
    // The batch's units needing a person now include it.
    const batchOf = out.batches.find((b) => b.units.includes(unit))!;
    expect(
      batchOf.units.filter(
        (u) => u.lane === "human-required" && u.sectionKeys.includes(drop.key),
      ),
    ).toHaveLength(1);
  }
  // Kept finder defects about tests: rule 4's move on validation still comes first, then rule 5's two.
  const onDrop = (id: string, kind: "defect" | "pattern-note") =>
    finding({
      id,
      lens: "tests",
      kind,
      about: "tests",
      hunkId: drop.hunkIds[0]!,
      anchors: [
        {
          path: "src/old.ts",
          side: "old",
          startLine: owned.startLine,
          endLine: owned.startLine,
        },
      ],
      evidence: [drop.hunkIds[0]!],
    });
  const kept = build({
    groups,
    findings: [onDrop("tests.1", "defect"), onDrop("tests.2", "defect")],
  });
  const keptDecision = kept.decided.sections.find(
    (s) => s.section.key === drop.key,
  )!.decision!;
  if (!keptDecision.settled) throw new Error("not settled");
  expect(
    keptDecision.entry.assess!.movement.map((m) => [m.signal, m.axis]),
  ).toEqual([
    ["kept-finding", "ease-of-validation"],
    ["kept-finding", "ease-of-validation"],
    ["confirmed-request-changes", "complexity"],
    ["confirmed-request-changes", "ease-of-validation"],
  ]);
  expect(keptDecision.entry.lane.applied).toBe("human-required");
  // An approval beside a kept pattern note: no move, the proven test stays static automation.
  const note = build({ groups, findings: [onDrop("tests.3", "pattern-note")] });
  const noteDecision = note.decided.sections.find(
    (s) => s.section.key === drop.key,
  )!.decision!;
  if (!noteDecision.settled) throw new Error("not settled");
  expect(noteDecision.entry.verdict).toBe("approve");
  expect(noteDecision.entry.assess!.movement).toEqual([]);
  expect(noteDecision.entry.lane.applied).toBe("static-automation");
});

// Reason (14.34): decisions stored under lane rule 4 hold no verdict moves, and gates replay such
// runs to see what rule 5 would do. The replay rebuilds the moves from each decided section's stored
// verdict and the confirmed claims it rests on, as the harness places them, and says so; the rule 4
// columns never read them. A decision stored under rule 5 holds them, and the replay reads them.
test("a decision stored under lane rule 4 replays with the verdict's moves rebuilt; one stored under rule 5 reads its own", () => {
  const groups = [group("m1", [...KEPT])];
  // helper low and easy, its relations shown, so the kept defect about code makes it high and easy.
  const collected = new Map(collectedFor());
  collected.set(helper.key, {
    assess: assessed(judgementFor("agentic")),
    review: reviewed("approve"),
    claims: [],
    steps: STEP,
  });
  const { decided } = build({
    groups,
    collected,
    findings: [finding()],
    relations: new Set([helper.key]),
  });
  const stored5: StoredDecision = {
    plan: PLAN_KEY,
    sections: decided.sections.map((s) => ({
      key: s.section.key,
      path: s.section.path,
      decision: s.decision,
    })),
    units: [],
    settled: [{ units: [{ laneRule: 5 }] }],
  };
  // The same decision as rule 4 stored it: no verdict moves, and rule 4's lane.
  const stored4: StoredDecision = {
    ...stored5,
    settled: [{ units: [{ laneRule: 4 }] }],
    sections: stored5.sections.map((s) => {
      if (
        s.decision === null ||
        !s.decision.settled ||
        s.decision.entry.assess === null
      )
        return s;
      const assess = {
        ...s.decision.entry.assess,
        movement: s.decision.entry.assess.movement.filter(
          (m) => m.signal === "kept-finding",
        ),
      };
      const trail = recordedLane({ ...s.decision.entry, assess }, []);
      return {
        ...s,
        decision: {
          ...s.decision,
          entry: {
            ...s.decision.entry,
            assess,
            lane: { ...s.decision.entry.lane, applied: trail.applied },
          },
        },
      };
    }),
  };
  const replay = (decision: StoredDecision) =>
    replayHold({ decision, plan, hunks, shown: new Set() });
  const four = replay(stored4);
  const five = replay(stored5);
  const at = (rows: typeof four, key: string) =>
    rows.find((r) => r.key === key)!;
  for (const key of [helper.key, count.key]) {
    const old = at(four, key);
    const now = at(five, key);
    expect([key, old.verdictMovesFrom, now.verdictMovesFrom]).toEqual([
      key,
      "rebuilt",
      "stored",
    ]);
    // Rebuilt or stored, the same moves and the same rule 5 lanes.
    expect(old.verdictMoves).toEqual(now.verdictMoves);
    expect(old.verdictMoves.map((m) => m.axis)).toEqual([
      "complexity",
      "ease-of-validation",
    ]);
    expect([old.confirmedLift, old.confirmedHold]).toEqual([
      now.confirmedLift,
      now.confirmedHold,
    ]);
    expect(now.confirmedHold).toBe("human-required");
    // The rule 4 columns read only the kept findings' moves, in both.
    expect(old.matrixHold).toBe(now.matrixHold);
  }
  // helper: rule 4 human-suggested (high and easy by the kept defect), rule 5 human-required.
  expect([
    at(four, helper.key).matrixHold,
    at(four, helper.key).confirmedHold,
  ]).toEqual(["human-suggested", "human-required"]);
  expect(at(five, helper.key).published).toBe("human-required");
  // An approved section gets no verdict move either way.
  expect(at(four, drop.key).verdictMoves).toEqual([]);
  expect(at(four, drop.key).confirmedHold).toBe(at(four, drop.key).matrixHold);
  expect(replayNotes(four)).toContain(REBUILT_VERDICT_MOVES_NOTE);
  expect(replayNotes(five)).not.toContain(REBUILT_VERDICT_MOVES_NOTE);
});

// ---------------------------------------------------------------------------------------------
// Round 25: the Guided stop, the review message, the suggestion and Briefed, by code
// ---------------------------------------------------------------------------------------------

/**
 * Three done-when rows and one scope row the batch's group links, and a done-when row no group
 * links. The scope row is on a weaker basis than the done-when rows, so no unit shows it.
 */
const FRAME: GuidedFrame = {
  stratum: "plan-or-ticket-at-base",
  doneWhen: [
    {
      id: "D1",
      text: "Count returns the number of parsed items.",
      basis: "done-when",
      sectionId: null,
    },
    {
      id: "D2",
      text: "Empty strings are not counted.",
      basis: "done-when",
      sectionId: "S2",
    },
    {
      id: "D3",
      text: "Labels read in the plural.",
      basis: "done-when",
      sectionId: null,
    },
    {
      id: "D4",
      text: "The helper is documented.",
      basis: "scope",
      sectionId: null,
    },
    {
      id: "D5",
      text: "Nothing else changes.",
      basis: "done-when",
      sectionId: null,
    },
  ],
};
const linked = group("m1", [...KEPT], ["D1", "D2", "D3", "D4"]);
const CHECKED = "Traced count through its callers";

type Rows = LaneReviewJudgement["rows"];
const judgedWith = (
  verdict: LaneReviewJudgement["verdict"],
  rows: Rows,
  more: Partial<LaneReviewJudgement> = {},
): CollectedSection["review"] => ({
  judged: true,
  judgement: {
    verdict,
    comments: [],
    checked: CHECKED,
    rows,
    unsure: [],
    ...more,
  },
});

/**
 * helper and count are both human-required, so they are one unit of src/parse.ts. helper finds D1
 * met (citing a proof record) and D2 met; count finds D1 met and D2 not met (each citing its own
 * changed line, and D2 an unknown fact too) and requests changes on a confirmed defect. Only helper
 * answers D3, with no evidence. drop's Lane review failed.
 */
const guidedCollected = (
  options: {
    readonly helperReview?: CollectedSection["review"];
    /** count approves instead, with no claim, so every section of the unit approves. */
    readonly countApproves?: boolean;
  } = {},
) =>
  new Map<string, CollectedSection>([
    [
      helper.key,
      {
        assess: assessed(judgementFor("human-required")),
        review:
          options.helperReview ??
          judgedWith("approve", [
            { row: "D1", status: "met", cites: ["p1"] },
            { row: "D2", status: "met", cites: ["src/parse.ts:new:4-4"] },
            { row: "D3", status: "no-evidence", cites: [] },
          ]),
        claims: [],
        steps: STEP,
      },
    ],
    [
      count.key,
      options.countApproves === true
        ? {
            assess: assessed(judgementFor("human-required")),
            review: judgedWith("approve", [
              { row: "D1", status: "met", cites: ["src/parse.ts:new:11-11"] },
            ]),
            claims: [],
            steps: STEP,
          }
        : {
            assess: assessed(judgementFor("human-required")),
            review: judgedWith(
              "request-changes",
              [
                { row: "D1", status: "met", cites: ["src/parse.ts:new:11-11"] },
                {
                  row: "D2",
                  status: "not-met",
                  cites: ["src/parse.ts:new:11-11", "f9"],
                },
              ],
              { comments: [defect] },
            ),
            claims: [
              {
                id: claimKey(defect),
                source: "lane-review",
                verify: "confirmed",
              },
            ],
            steps: STEP,
          },
    ],
    [
      drop.key,
      {
        assess: assessed(judgementFor("static-automation")),
        review: { judged: false, cause: "failed" },
        claims: [],
        steps: STEP,
      },
    ],
  ]);

/** A new-side line as a Guided row cites it (round 27b): its hunk with the line, `h…@N`. */
const lineAt = (path: string, line: number) => `${hunkAt(path, line)}@${line}`;

/** The hunk of the range that holds a new-side line. */
const hunkAt = (path: string, line: number) =>
  hunkList.find(
    (h) =>
      (h.newPath ?? h.path) === path &&
      h.newStart <= line &&
      line < h.newStart + h.newLines,
  )!.hunkId;

// Reason: the rulings. Guided rows are the Frame's rows the Lane review was given for the file, on
// the strongest basis, each at the worst status the unit's sections were given; a unit with none
// is on no basis; a row's status is the whole file's, said in words.
test("Guided rows: the linked rows on the strongest basis, the worst status of the unit's sections, evidence as local IDs, and none for the generated batch", () => {
  const { out } = build({
    groups: [linked],
    collected: guidedCollected(),
    frame: FRAME,
  });
  expect(out.batches).toHaveLength(2);
  for (const each of out.batches) expectPublishable(each);
  const parse = out.batches[0]!.units.find((u) =>
    u.sectionKeys.includes(count.key),
  )!;
  expect(parse.sectionKeys).toEqual([helper.key, count.key]);
  const guided = parse.guided;
  expect(guided).toMatchObject({
    lane: "human-required",
    basis: "done-when",
    unlinked: false,
    stratum: "plan-or-ticket-at-base",
    outside: [],
    omitted: [],
  });
  // D4 is on the weaker scope basis and D5 is linked by no group: neither is a row.
  expect(guided.rows.map((row) => [row.row, row.status])).toEqual([
    ["D1", "met"],
    ["D2", "not-met"],
    ["D3", "no-evidence"],
  ]);
  const [d1, d2, d3] = guided.rows;
  // A proof record stays as cited; a line cite becomes the hunk its line falls in, with that line
  // (`h…@11`); an unknown fact is left out. Only the sections whose answer gives the row's status are its evidence.
  expect(d1!.evidence).toEqual(["p1", lineAt("src/parse.ts", 11)]);
  expect(d2!.evidence).toEqual([lineAt("src/parse.ts", 11)]);
  expect(d3!.evidence).toEqual([]);
  // The row's text, basis and section from the Frame; required, with no requirement of its own.
  expect(d2).toMatchObject({
    text: "Empty strings are not counted.",
    basis: "done-when",
    sectionId: "S2",
    scope: "this file",
    required: true,
    requirements: [],
  });
  // Per file, in words; no status code in what a person reads.
  expect(d1!.does).toBe(
    "The Lane review found this condition met, judged for the whole file.",
  );
  expect(d2!.does).toBe(
    "The Lane review found this condition not met, judged for the whole file.",
  );
  expect(d3!.does).toBe(
    "The Lane review found no evidence either way, judged for the whole file.",
  );
  for (const row of guided.rows)
    expect(row.does).not.toMatch(/not-met|no-evidence/);
  // The unit's requirements, which no stored field ties to a row, are implied, once each.
  expect(guided.implied).toEqual([
    {
      requirement: "Parsing an empty list returns no rows.",
      kinds: ["test-run", "static-analysis"],
      proof: [],
    },
  ]);

  // drop's Lane review failed: every row is no-evidence, in the words for no answer at all.
  const old = out.batches[0]!.units.find((u) => u.path === "src/old.ts")!;
  expect(old.guided.rows.map((row) => [row.row, row.status, row.does])).toEqual(
    ["D1", "D2", "D3"].map((row) => [
      row,
      "no-evidence",
      "No reading of this file established this condition's outcome.",
    ]),
  );

  // The generated batch: no rows and no basis, and not called unlinked.
  for (const unit of out.batches[1]!.units)
    expect(unit.guided).toMatchObject({
      basis: "none",
      unlinked: false,
      rows: [],
    });
});

// Reason: the rulings. A unit whose group links no row is on no basis, and says it is unlinked.
test("a unit whose Map group links no done-when row has level none and is unlinked", () => {
  const { out } = build({
    groups: [group("m1", [...KEPT], [])],
    collected: guidedCollected(),
    frame: FRAME,
  });
  for (const unit of out.batches[0]!.units)
    expect(unit.guided).toMatchObject({
      basis: "none",
      unlinked: true,
      rows: [],
    });
});

// Reason: the desk's final pictures. A Lane review's checked line may begin with "Checked" itself
// ("Checked explicit undefined return …"); the message then never reads "Checked: Checked …".
test("a checked line that begins with Checked gets no second Checked", () => {
  const line =
    "Checked explicit undefined return against watch's optional-result contract";
  const { out } = build({
    groups: [linked],
    collected: guidedCollected({
      helperReview: judgedWith(
        "approve",
        [{ row: "D1", status: "met", cites: ["p1"] }],
        { checked: line },
      ),
      countApproves: true,
    }),
    frame: FRAME,
  });
  const parse = out.batches[0]!.units.find((u) =>
    u.sectionKeys.includes(count.key),
  )!;
  expect(parse.guided.review?.message).toBe(`${line}. ${CHECKED}.`);
  expect(parse.guided.sectionReviews).toEqual([
    { section: helper.key, verdict: "approve", message: `${line}.` },
    { section: count.key, verdict: "approve", message: `Checked: ${CHECKED}.` },
  ]);
  for (const text of [
    ...out.batches.flatMap((b) =>
      b.units.flatMap((u) => [
        u.guided.review?.message ?? "",
        ...(u.guided.sectionReviews ?? []).map((r) => r.message),
      ]),
    ),
  ])
    expect(text).not.toMatch(/Checked:\s*Checked/i);
});

// Reason: the rulings. The review message is "Checked: " and the Lane review's checked lines,
// then code's rests-on sentence on a request for changes; the disposition's note stays as it was.
// The suggestion is only on a human-required unit an agent decided.
test("the review message and the suggestion of a decided human-required unit; review without a suggestion elsewhere", () => {
  const { out } = build({
    groups: [linked],
    collected: guidedCollected(),
    frame: FRAME,
  });
  const parse = out.batches[0]!.units.find((u) =>
    u.sectionKeys.includes(count.key),
  )!;
  const message = `Checked: ${CHECKED}. This request for changes rests on 1 confirmed defect.`;
  expect(parse.guided.review).toEqual({
    source: "agent",
    verdict: "request-changes",
    message,
    uncited: false,
    withheld: false,
    gaps: [],
  });
  expect(parse.guided.suggestion).toEqual({
    verdict: "request-changes",
    message,
  });
  expect(parse.guided.notes).toEqual([]);
  // The disposition's note is unchanged.
  expect(parse.message).toBe(
    "This request for changes rests on 1 confirmed defect.",
  );
  // Round 32: a unit of two decided sections also says each one's own verdict and message, in file
  // order; no section is undecided, so no section note.
  expect(parse.sectionKeys).toEqual([helper.key, count.key]);
  expect(parse.guided.sectionReviews).toEqual([
    {
      section: helper.key,
      verdict: "approve",
      message: `Checked: ${CHECKED}.`,
    },
    { section: count.key, verdict: "request-changes", message },
  ]);
  expect(parse.guided.sectionNotes).toBeUndefined();

  // The default fixture: helper human-suggested and drop static automation, both decided by an
  // agent. Each has the review, and neither a suggestion. Neither Lane review said what it checked,
  // so the approval's message is its proof line, as the disposition's note is.
  const plain = build({ groups: [linked], frame: FRAME }).out.batches[0]!;
  for (const key of [helper.key, drop.key]) {
    const unit = plain.units.find((u) => u.sectionKeys.includes(key))!;
    expect(unit.lane).not.toBe("human-required");
    expect(unit.guided.review).toMatchObject({
      source: "agent",
      verdict: "approve",
      message: unit.guided.proof,
    });
    expect(unit.guided.suggestion).toBeNull();
    // One section: its review is the unit's, so no section review is written.
    expect(unit.sectionKeys).toHaveLength(1);
    expect(unit.guided.sectionReviews).toBeUndefined();
    expect(unit.guided.sectionNotes).toBeUndefined();
  }
});

// Reason (round 25's kept finding: the only human-required case requested changes): a decided
// human-required unit whose sections all approve has the agent's approving review, and the
// suggestion carries that approval and its message, never an approval as a disposition (4.5).
test("a decided human-required unit whose sections all approve has an approving review and an approving suggestion", () => {
  const { out } = build({
    groups: [linked],
    collected: guidedCollected({ countApproves: true }),
    frame: FRAME,
  });
  const parse = out.batches[0]!.units.find((u) =>
    u.sectionKeys.includes(count.key),
  )!;
  expect(parse).toMatchObject({
    lane: "human-required",
    sectionKeys: [helper.key, count.key],
    verdict: "approve",
  });
  expect(parse.disposition).toBeUndefined();
  expect(parse.guided.review).toMatchObject({
    source: "agent",
    verdict: "approve",
    withheld: false,
  });
  expect(parse.guided.suggestion).toEqual({
    verdict: "approve",
    message: parse.guided.review!.message,
  });
  expect(parse.guided.notes).toEqual([]);
});

// Reason (round 28, the coordinator's ruling): a file whose hunks fall in two Map groups was judged
// on both groups' rows, but a unit shows only its own group's: the other group's rows are about other
// hunks, noise on the reviewer's surface. The strongest basis is still chosen within the group.
test("a file in two Map groups: each unit shows only its own group's done-when rows", () => {
  expect(helper.hunkIds[0]).not.toBe(count.hunkIds[0]);
  const others = hunkList
    .filter((h) => h.path !== "src/parse.ts")
    .map((h) => h.hunkId);
  const first: MapGroup = {
    ...group("m1", [...KEPT], ["D1", "D4"]),
    hunkIds: [...helper.hunkIds, ...others],
  };
  const second: MapGroup = {
    ...group("m2", ["src/parse.ts"], ["D3"]),
    hunkIds: [...count.hunkIds],
  };
  const { out } = build({
    groups: [first, second],
    collected: guidedCollected({ countApproves: true }),
    frame: FRAME,
  });
  const unitOf = (key: string) =>
    out.batches
      .flatMap((batch) => batch.units.map((unit) => ({ batch, unit })))
      .find(({ unit }) => unit.sectionKeys.includes(key))!;
  const ofHelper = unitOf(helper.key);
  const ofCount = unitOf(count.key);
  expect([ofHelper.batch.title, ofCount.batch.title]).toEqual([
    "Count parsed items (m1)",
    "Count parsed items (m2)",
  ]);
  // m1 links D1 (done-when) and D4 (scope): the stronger basis alone, and never m2's D3.
  expect(ofHelper.unit.guided.rows.map((row) => row.row)).toEqual(["D1"]);
  // m2 links D3 only: count's unit shows it, as unanswered by count, and never m1's D1.
  expect(ofCount.unit.guided.rows.map((row) => [row.row, row.status])).toEqual([
    ["D3", "no-evidence"],
  ]);
});

const UNSURE_REASON =
  "Could not inspect SharedWork.run (2n14-20, f3) at 0o7 or p1 to verify concurrent subscription [s2].";
const REQUEST_MESSAGE = `Checked: ${CHECKED}. This request for changes rests on 1 confirmed defect.`;

/** helper unsure (undecided) beside count, decided: one human-required unit of src/parse.ts. */
const mixedCollected = (countApproves: boolean) =>
  guidedCollected({
    helperReview: judgedWith("unsure", [], {
      unsure: [UNSURE_REASON, "x".repeat(400)],
    }),
    countApproves,
  });

// Reason (round 32, the owner's ruling and the desk's shape): a file's decided and undecided sections
// in one lane are one unit. It has no verdict and no disposition; its review sums up the decided
// sections; on human-required work its suggestion is only a request for changes (14.4); each decided
// section keeps its own verdict and message, and each undecided one its reason.
test("a mixed human-required unit that requests changes: one unit, no verdict, a review and a suggestion of the decided sections, and each section's own message and note", () => {
  const { out } = build({
    groups: [linked],
    collected: mixedCollected(false),
    frame: FRAME,
  });
  const units = out.batches[0]!.units.filter((u) => u.path === "src/parse.ts");
  expect(units).toHaveLength(1);
  const [parse] = units;
  expect(parse).toMatchObject({
    lane: "human-required",
    sectionKeys: [helper.key, count.key],
    verdict: null,
  });
  expect(parse!.disposition).toBeUndefined();
  expect(parse!.message).toBeUndefined();
  // The review: count's alone, since helper no agent decided.
  expect(parse!.guided.review).toEqual({
    source: "agent",
    verdict: "request-changes",
    message: REQUEST_MESSAGE,
    uncited: false,
    withheld: false,
    gaps: [],
  });
  expect(parse!.guided.suggestion).toEqual({
    verdict: "request-changes",
    message: REQUEST_MESSAGE,
  });
  expect(parse!.guided.sectionReviews).toEqual([
    {
      section: count.key,
      verdict: "request-changes",
      message: REQUEST_MESSAGE,
    },
  ]);
  // The defect count's request rests on stays shown.
  expect(
    parse!.comments.filter((c) => c.restedOn).map((c) => [c.section, c.shown]),
  ).toEqual([[count.key, true]]);
  // helper's reason: titled in `notes`, as the desk reads today, and keyed with no title.
  const title = "helper in parse.ts";
  expect(parse!.guided.notes).toHaveLength(1);
  const [note] = parse!.guided.notes;
  expect(note).toStartWith(
    `${title}: Could not inspect SharedWork.run at or to verify concurrent subscription. xxx`,
  );
  // The reason is at most 300 characters, with no cite token or local ID.
  expect(note!.length - `${title}: `.length).toBeLessThanOrEqual(300);
  expect(note).not.toMatch(/2n14|f3|0o7|\bp1\b|s2|\(|\[/);
  expect(parse!.guided.sectionNotes).toEqual([
    { section: helper.key, note: note!.slice(`${title}: `.length) },
  ]);
  GuidedContent.parse(parse!.guided);
});

// Reason (round 32, 14.4): a suggested approval would also approve the sections no agent judged, so
// a mixed unit whose decided sections all approve has their approving review and no suggestion.
test("a mixed human-required unit whose decided sections all approve: an approving review, no suggestion, and each section's message and note", () => {
  const { out } = build({
    groups: [linked],
    collected: mixedCollected(true),
    frame: FRAME,
  });
  const parse = out.batches[0]!.units.find((u) =>
    u.sectionKeys.includes(count.key),
  )!;
  expect(parse).toMatchObject({
    lane: "human-required",
    sectionKeys: [helper.key, count.key],
    verdict: null,
  });
  expect(parse.disposition).toBeUndefined();
  expect(parse.guided.review).toMatchObject({
    source: "agent",
    verdict: "approve",
    message: `Checked: ${CHECKED}.`,
  });
  expect(parse.guided.suggestion).toBeNull();
  expect(parse.guided.sectionReviews).toEqual([
    { section: count.key, verdict: "approve", message: `Checked: ${CHECKED}.` },
  ]);
  expect(parse.guided.notes).toHaveLength(1);
  expect(parse.guided.sectionNotes?.map((n) => n.section)).toEqual([
    helper.key,
  ]);
});

// Reason: a unit no agent decided is unchanged: no review, no suggestion, its notes; and now each
// undecided section's reason keyed, with no title. One section: no section reviews.
test("a fully undecided unit keeps its notes alone and adds each section's reason; a single-section unit has no section reviews", () => {
  const { out } = build({
    groups: [linked],
    collected: mixedCollected(false),
    frame: FRAME,
  });
  // drop failed: a failed reading has no model reason, so code's line for its cause is its note
  // (round 27: every undecided section says why).
  const old = out.batches[0]!.units.find((u) => u.path === "src/old.ts")!;
  expect(old.sectionKeys).toEqual([drop.key]);
  expect(old.verdict).toBeNull();
  expect(old.guided).toMatchObject({
    review: null,
    suggestion: null,
    notes: [
      "drop in old.ts: No reading of this section completed, so a person decides it.",
    ],
    sectionNotes: [
      {
        section: drop.key,
        note: "No reading of this section completed, so a person decides it.",
      },
    ],
  });
  expect(old.guided.sectionReviews).toBeUndefined();
});

// Reason: the notes format binds the desk lane: title, reason, plain, bounded.
test("an unsure note is the section's title and the reading's reason, plain and at most 300 characters", () => {
  expect(
    unsureNote("checkout in projects.ts", [
      "Could not see the retry (cites: 0n4-9, p2); see src/a.ts:new:3-4 and f12.",
    ]),
  ).toBe("checkout in projects.ts: Could not see the retry; see and.");
  expect(unsureNote("t", [])).toBeUndefined();
  expect(unsureNote("t", ["(2n1-2)"])).toBeUndefined();
  const long = unsureNote("t", ["a".repeat(500)])!;
  expect(long).toBe(`t: ${"a".repeat(300)}`);
  // Words that only look like tokens inside a word are kept.
  expect(plainText("Step p1x and f(x) stay; v2n3 too.")).toBe(
    "Step p1x and f(x) stay; v2n3 too.",
  );
});

// Reason (round 32, the desk's shape): a section's message is plain, at most 300 characters, and
// ends at a full sentence; it opens no row, so no link reaches another unit's lines (Records indexes
// no cite in it). Its words are the section's own checked line, never a sibling's.
test("a section's message is its own checked line, plain, at most 300 characters at a full sentence, with no link", () => {
  const sentences = Array.from(
    { length: 12 },
    (_, at) => `Sentence ${at + 1} checks the parser.`,
  );
  const checked = `[the helper](h0123456789abcdef0@4) splits on commas, see src/parse.ts:new:4-4. ${sentences.join(" ")}`;
  const { out } = build({
    groups: [linked],
    collected: guidedCollected({
      helperReview: judgedWith(
        "approve",
        [{ row: "D1", status: "met", cites: ["p1"] }],
        { checked },
      ),
      countApproves: true,
    }),
    frame: FRAME,
  });
  const parse = out.batches[0]!.units.find((u) =>
    u.sectionKeys.includes(count.key),
  )!;
  const [ofHelper, ofCount] = parse.guided.sectionReviews!;
  expect(ofHelper!.section).toBe(helper.key);
  const full = `Checked: the helper splits on commas, see. ${sentences.join(" ")}`;
  expect(full.length).toBeGreaterThan(SECTION_MESSAGE);
  expect(ofHelper!.message.length).toBeLessThanOrEqual(SECTION_MESSAGE);
  // Cut after a full sentence of the whole text, never inside one.
  expect(ofHelper!.message).toEndWith("checks the parser.");
  expect(full.startsWith(ofHelper!.message)).toBe(true);
  expect(full[ofHelper!.message.length]).toBe(" ");
  // The link keeps its phrase alone; the line cite token is gone.
  expect(ofHelper!.message).not.toMatch(/\]\(|h0123456789abcdef0|:new:/);
  // count's message is its own line, not helper's.
  expect(ofCount).toEqual({
    section: count.key,
    verdict: "approve",
    message: `Checked: ${CHECKED}.`,
  });

  // A pair of UTF-16 code units counts as two characters, and is never split.
  const wide = sectionMessage(`${"\u{1F600}".repeat(200)}.`);
  expect(wide.length).toBeLessThanOrEqual(SECTION_MESSAGE);
  expect(wide).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  // Text within the bound is kept as it is, its links as their phrases.
  expect(sectionMessage("Checked: [count](h1@3) drops none.")).toBe(
    "Checked: count drops none.",
  ); // Neuve round 55: an abbreviation's stop before a lower-case word ends no sentence, so a bounded
  // message never ends at "e.g." or "i.e.".
  const abbreviated = sectionMessage(
    `Checked: count drops none. It waits, e.g. the run, i.e. the shared one, ${"and runs on ".repeat(30)}to its end.`,
  );
  expect(abbreviated).toBe("Checked: count drops none.");
  expect(abbreviated).not.toMatch(/\b(?:e\.g|i\.e)\.$/);
});

// Reason: another lane reads these fields. From the settler, through the real publisher, to the
// packet Records reads: the loose Guided stop keeps `sectionReviews` and `sectionNotes`.
test("through the real publisher: a mixed unit's section reviews and section notes reach Records' read", async () => {
  const { out } = build({
    groups: [linked],
    collected: mixedCollected(false),
    frame: FRAME,
  });
  const settled = out.batches[0]!.units.find((u) =>
    u.sectionKeys.includes(count.key),
  )!;
  expect(settled.guided.sectionReviews).toHaveLength(1);
  expect(settled.guided.sectionNotes).toHaveLength(1);
  const store = scratch();
  const read = await store.run(
    Effect.gen(function* () {
      const ctx = store.ctx();
      yield* publishSettled(
        ctx,
        inputOf(out.batches as never, { ending: true, totals: out.totals }),
      );
      return yield* PublishedPackets.readStanding(ctx.cycleId);
    }),
  );
  expect(read?.kind).toBe("packet.published@2");
  if (read?.kind !== "packet.published@2") return;
  expect(read.undecoded).toEqual([]);
  const parse = read.batches
    .flatMap((batch) => batch.units)
    .find((unit) => unit.sections.some((s) => s.key === count.key))!;
  expect(parse.sections.map((s) => s.key).sort()).toEqual(
    [helper.key, count.key].sort(),
  );
  const guided = parse.content.guided! as unknown as Record<string, unknown>;
  expect(guided["sectionReviews"]).toEqual(settled.guided.sectionReviews);
  expect(guided["sectionNotes"]).toEqual(settled.guided.sectionNotes);
  expect(guided["notes"]).toEqual(settled.guided.notes);
  expect(guided["review"]).toMatchObject({ verdict: "request-changes" });
  expect(guided["suggestion"]).toEqual(settled.guided.suggestion);
});

// Reason: the stored decision is read back through a strict schema before anything is published; a
// Guided field the schema lacks fails every read of a decision that holds it (round 30's review, B2).
test("a stored decision whose Guided stops carry section reviews and notes reads back through settledOf equal, and one without them still reads", async () => {
  const { out } = build({
    groups: [linked],
    collected: mixedCollected(false),
    frame: FRAME,
  });
  const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const guided = out.batches.flatMap((batch) =>
    batch.units.map((unit) => unit.guided),
  );
  expect(guided.some((g) => g.sectionReviews !== undefined)).toBe(true);
  expect(guided.some((g) => g.sectionNotes !== undefined)).toBe(true);
  // The same batches as a decision stored before round 32.
  const old = plain(out.batches).map((batch) => ({
    ...batch,
    units: batch.units.map((unit) => {
      const {
        sectionReviews: _reviews,
        sectionNotes: _notes,
        ...before
      } = unit.guided;
      return { ...unit, guided: before };
    }),
  }));
  const store = scratch();
  const services = {
    ctx: { records: Layer.empty } as never,
    run: (<A, E>(effect: Effect.Effect<A, E, never>) =>
      store.run(effect)) as never,
  };
  for (const batches of [plain(out.batches), old]) {
    const decision = { settled: batches, totals: out.totals, gaps: [] };
    const text = JSON.stringify(decision);
    const bytes = new TextEncoder().encode(text);
    const stored = await store.run(
      Effect.gen(function* () {
        const computations = yield* Computations.ComputationStore;
        return yield* computations.run(
          {
            op: "harness.readings-decision",
            opVersion: 3,
            inputs: { output: sha256Hex(text) },
          },
          Effect.succeed({ bytes, mediaType: "application/json" }),
        );
      }),
    );
    const read = await settledOf(services, stored.computation.key);
    expect(plain(read.batches)).toEqual(batches);
  }
});

// Reason: the rulings. Briefed is code's, from a section's own impact entry or lean reason, never
// from what is said of several sections together; code's own removal text is Facts', not Briefed's.
test("Briefed from a section's own impact entries and unshared lean reason only", () => {
  const lean = (reason: string) => ({
    lane: "human-suggested" as const,
    reason,
  });
  const collected = guidedCollected();
  const with_ = (key: string, change: Partial<AssessJudgement>) => {
    const held = collected.get(key)!;
    if (!held.assess.judged) throw new Error("fixture");
    collected.set(key, {
      ...held,
      assess: assessed({ ...held.assess.judgement, ...change }),
    });
  };
  // helper and count share one lean reason (one Assess class): said of both, so of neither.
  with_(helper.key, { lean: lean("Cache lifetime is a design choice.") });
  with_(count.key, {
    lean: lean("Cache lifetime is a design choice."),
    impact: [
      {
        effect: "changed",
        text: "Callers now count only filled items (2n10-13)",
        cites: ["src/parse.ts:new:10-13"],
      },
    ],
  });
  // drop: code's removal text and its own lean reason.
  with_(drop.key, {
    lean: lean("Only the test helper goes."),
    impact: [{ effect: "removed", text: REMOVED_TEXT, cites: [] }],
  });
  const { out } = build({ groups: [linked], collected, frame: FRAME });
  const briefed = (key: string) =>
    out.batches.flatMap((b) => b.sections).find((s) => s.identity.key === key)!
      .content!.briefed;
  expect(briefed(count.key)).toBe("Callers now count only filled items.");
  expect(briefed(helper.key)).toBeNull();
  expect(briefed(drop.key)).toBe("Only the test helper goes.");
  // The complexity finding, written for the class, is never Briefed; unread and excluded
  // sections have none.
  for (const section of out.batches.flatMap((b) => b.sections))
    expect(section.content!.briefed ?? "").not.toContain(
      "Called from two places",
    );
  expect(briefed(sectionOf("bun.lock", null).key)).toBeNull();
  // Round 27: a section never read says why in code's one line, by its cause.
  expect(briefed(sectionOf("assets/logo.png", null).key)).toBe(
    "This section has no text to read, so no reading describes it.",
  );
  // The rule on one entry: a shared reason is left out.
  const entry = out.batches[0]!.sections.find(
    (s) => s.identity.key === drop.key,
  )!.entry;
  expect(briefedOf(entry, new Set(["Only the test helper goes."]))).toBeNull();
});

// Reason: the regression must not return unseen. From the settler, through the real publisher, to
// the packet Records reads: every unit has Guided, and a section has Facts only exactly when it has
// nothing else.
test("through the real publisher: every unit has Guided, and a section is Facts only exactly when it has no Briefed", async () => {
  const collected = guidedCollected();
  const held = collected.get(count.key)!;
  if (!held.assess.judged) throw new Error("fixture");
  collected.set(count.key, {
    ...held,
    assess: assessed({
      ...held.assess.judgement,
      impact: [
        {
          effect: "changed",
          text: MARKS.impact,
          cites: ["src/parse.ts:new:10-13"],
        },
      ],
    }),
  });
  const { out } = build({ groups: [linked], collected, frame: FRAME });
  const store = scratch();
  const read = await store.run(
    Effect.gen(function* () {
      const ctx = store.ctx();
      yield* publishSettled(
        ctx,
        inputOf(out.batches as never, { ending: true, totals: out.totals }),
      );
      return yield* PublishedPackets.readStanding(ctx.cycleId);
    }),
  );
  expect(read?.kind).toBe("packet.published@2");
  if (read?.kind !== "packet.published@2") return;
  expect(read.undecoded).toEqual([]);
  const units = read.batches.flatMap((batch) => batch.units);
  expect(units).toHaveLength(
    out.batches.reduce((sum, batch) => sum + batch.units.length, 0),
  );
  const sections = units.flatMap((unit) => unit.sections);
  expect(sections.length).toBeGreaterThan(0);
  for (const unit of units) {
    expect(unit.content.facts).toBeDefined();
    expect(unit.content.guided).toBeDefined();
    expect(Array.isArray(unit.content.guided!.rows)).toBe(true);
  }
  // The parse.ts unit's rows reach the packet with their status and words.
  const parse = units.find((unit) =>
    unit.sections.some((s) => s.key === count.key),
  )!;
  expect(
    parse.content.guided!.rows!.map((row) => [row.row, row.status]),
  ).toEqual([
    ["D1", "met"],
    ["D2", "not-met"],
    ["D3", "no-evidence"],
  ]);
  expect(parse.content.guided!.suggestion).toMatchObject({
    verdict: "request-changes",
  });
  // Facts only exactly when nothing else: here count alone has an impact entry of its own, and
  // (round 27) a section never read has code's line for why.
  for (const section of sections) {
    const own = section.key === count.key;
    const unread = plan.unread.some(
      (u) => u.key === section.key && u.cause !== "excluded",
    );
    expect(section.content).toBeDefined();
    expect(section.content!.explained).toBeNull();
    expect(section.content!.briefed === null).toBe(!own && !unread);
  }
  expect(sections.find((s) => s.key === count.key)!.content!.briefed).toBe(
    `${MARKS.impact}.`,
  );
});

// ---------------------------------------------------------------------------------------------
// Round 30: a row with no proof recorded says Missing, and keeps the agent's reading
// ---------------------------------------------------------------------------------------------

const MISSING =
  "No test run or other proof is recorded for this condition, so it can't be shown met.";

/**
 * helper and count, one unit of src/parse.ts, both approve. D1 is a met code refused (its reading
 * behind code's words), D2 no evidence with no reading, D3 not met with a reading; `fileProofs` is
 * the number of proof records the Lane review was listed for src/parse.ts.
 */
const proofCollected = (fileProofs: number | undefined, d1Reading?: string) => {
  const rows: Rows = [
    {
      row: "D1",
      status: "no-evidence",
      cites: ["src/parse.ts:new:4-4", "p1"],
      reading:
        d1Reading ??
        "The code reads as meeting this: helper splits on commas (0n4, p1).",
    },
    { row: "D2", status: "no-evidence", cites: [], reading: "" },
    {
      row: "D3",
      status: "not-met",
      cites: ["src/parse.ts:new:11-11"],
      reading: "The label reads in the singular [0n11].",
    },
  ];
  const more = fileProofs === undefined ? {} : { fileProofs };
  return new Map<string, CollectedSection>([
    [
      helper.key,
      {
        assess: assessed(judgementFor("human-required")),
        review: judgedWith("approve", rows, more),
        claims: [],
        steps: STEP,
      },
    ],
    [
      count.key,
      {
        assess: assessed(judgementFor("human-required")),
        review: judgedWith("approve", rows, more),
        claims: [],
        steps: STEP,
      },
    ],
    [
      drop.key,
      {
        assess: assessed(judgementFor("static-automation")),
        review: { judged: false, cause: "failed" },
        claims: [],
        steps: STEP,
      },
    ],
  ]);
};

const parseRows = (
  collected: ReadonlyMap<string, CollectedSection>,
  proofs?: ReadonlySet<string>,
) => {
  const { out } = build({
    groups: [linked],
    collected,
    frame: FRAME,
    ...(proofs === undefined ? {} : { proofs }),
  });
  for (const each of out.batches) expectPublishable(each);
  return {
    out,
    rows: out.batches[0]!.units.find((u) => u.sectionKeys.includes(count.key))!
      .guided.rows,
  };
};

// Reason: the ruling (11.16, the vocabulary's Missing). A file the Lane review was listed no proof
// record for cannot have a row met; its no-evidence rows say so in code's sentence, never that no
// evidence was found, and nothing is "judged for the whole file".
test("a no-evidence row whose file was listed no proof record is Missing, in the exact sentence", () => {
  const { rows } = parseRows(proofCollected(0));
  const [d1, d2] = rows;
  for (const row of [d1!, d2!]) {
    expect(row.status).toBe("no-evidence");
    expect(row.proofState).toBe("missing");
    expect(row.does).toBe(MISSING);
    expect(row.does).not.toContain("judged for the whole file");
    expect(row.does).not.toContain("no evidence either way");
  }
  // A row with no reading carries none.
  expect("reading" in d2!).toBe(false);
});

// Reason: the ruling keeps today's words wherever the file had proof records, and for a judgement
// built without the reading's index.
test("a no-evidence row whose file was listed proof records keeps today's words and no proof state", () => {
  for (const fileProofs of [1, undefined]) {
    const { rows } = parseRows(proofCollected(fileProofs));
    const [d1, d2] = rows;
    for (const row of [d1!, d2!]) {
      expect(row.status).toBe("no-evidence");
      expect(row.does).toBe(
        "The Lane review found no evidence either way, judged for the whole file.",
      );
      expect("proofState" in row).toBe(false);
    }
  }
});

// Reason: the ruling. A met code refused keeps the agent's reading under Missing, as plain words
// with its cites in evidence's local-ID form, never as a status.
test("a repaired met keeps its reading text and cites under Missing", () => {
  const { rows } = parseRows(proofCollected(0));
  const d1 = rows[0]!;
  expect(d1.status).toBe("no-evidence");
  expect(d1.proofState).toBe("missing");
  expect(d1.reading).toEqual({
    text: "The code reads as meeting this: helper splits on commas.",
    cites: [lineAt("src/parse.ts", 4), "p1"],
  });
  expect(d1.reading!.cites).toEqual(d1.evidence);
});

// Reason: 10.86. Not met keeps its status and words; its reading is carried for the desk to show
// under `does`, and it is never Missing.
test("a not-met row is unchanged, with its reading carried and no proof state", () => {
  const { rows } = parseRows(proofCollected(0));
  const d3 = rows[2]!;
  expect(d3.status).toBe("not-met");
  expect(d3.does).toBe(
    "The Lane review found this condition not met, judged for the whole file.",
  );
  expect("proofState" in d3).toBe(false);
  expect(d3.reading).toEqual({
    text: "The label reads in the singular.",
    cites: [lineAt("src/parse.ts", 11)],
  });
});

// Reason: the desk's bounds bind: plain text of at most 300 characters with no cite token or local
// ID inline, and at most 8 cites in evidence's form.
test("a row's reading is plain, at most 300 characters, and has at most 8 cites", () => {
  const long = `The code reads as meeting this: ${"helper splits each line on commas (0n4-5, f3) and p2 01ARZ3NDEKTSV4RRFFQ69G5FAV src/parse.ts:new:4-4 ".repeat(8)}`;
  // Twelve proof records the reading may cite, and a line cite on every hunk with new lines.
  const proofs = Array.from({ length: 12 }, (_, i) => `p${i + 1}`);
  const lineCites = hunkList
    .filter((h) => h.newLines > 0)
    .map(
      (h) =>
        `${h.newPath ?? h.path}:new:${h.newStart}-${h.newStart + h.newLines - 1}`,
    );
  const many: Rows = [
    {
      row: "D1",
      status: "no-evidence",
      cites: [...lineCites, ...proofs],
      reading: long,
    },
  ];
  const collected = proofCollected(0);
  collected.set(helper.key, {
    ...collected.get(helper.key)!,
    review: judgedWith("approve", many, { fileProofs: 0 }),
  });
  const { rows } = parseRows(collected, new Set(proofs));
  const d1 = rows[0]!;
  expect(d1.reading!.cites).toHaveLength(8);
  expect(d1.reading!.text.length).toBeLessThanOrEqual(300);
  expect(d1.reading!.text.length).toBeGreaterThan(200);
  expect(d1.reading!.text).toStartWith("The code reads as meeting this:");
  for (const token of [
    "0n4-5",
    "f3",
    "p2",
    "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    ":new:",
  ])
    expect(d1.reading!.text).not.toContain(token);
  expect(d1.reading!.text).not.toContain("\n");
  expect(d1.reading!.cites.length).toBeLessThanOrEqual(8);
  expect(d1.reading!.cites).toEqual(d1.evidence);
});

// Reason: another lane reads these fields. From the settler, through the real publisher, to the
// packet Records reads: the loose row keeps `proofState` and `reading`.
test("through the real publisher: a Missing row's proof state and reading reach Records' read", async () => {
  const { out } = build({
    groups: [linked],
    collected: proofCollected(0),
    frame: FRAME,
  });
  const store = scratch();
  const read = await store.run(
    Effect.gen(function* () {
      const ctx = store.ctx();
      yield* publishSettled(
        ctx,
        inputOf(out.batches as never, { ending: true, totals: out.totals }),
      );
      return yield* PublishedPackets.readStanding(ctx.cycleId);
    }),
  );
  expect(read?.kind).toBe("packet.published@2");
  if (read?.kind !== "packet.published@2") return;
  expect(read.undecoded).toEqual([]);
  const parse = read.batches
    .flatMap((batch) => batch.units)
    .find((unit) => unit.sections.some((s) => s.key === count.key))!;
  const rows = parse.content.guided!.rows! as unknown as ReadonlyArray<
    Record<string, unknown>
  >;
  expect(
    rows.map((row) => [
      row["row"],
      row["status"],
      row["proofState"],
      row["does"],
    ]),
  ).toEqual([
    ["D1", "no-evidence", "missing", MISSING],
    ["D2", "no-evidence", "missing", MISSING],
    [
      "D3",
      "not-met",
      undefined,
      "The Lane review found this condition not met, judged for the whole file.",
    ],
  ]);
  expect(rows[0]!["reading"]).toEqual({
    text: "The code reads as meeting this: helper splits on commas.",
    cites: [lineAt("src/parse.ts", 4), "p1"],
  });
  expect(rows[1]!["reading"]).toBeUndefined();
  expect(rows[2]!["reading"]).toEqual({
    text: "The label reads in the singular.",
    cites: [lineAt("src/parse.ts", 11)],
  });
});

// ---------------------------------------------------------------------------------------------
// Round 45's review: Missing on an unanswered row, and readings kept apart from the status
// ---------------------------------------------------------------------------------------------

/** One unit of src/parse.ts whose helper and count sections were given these rows and counts. */
const twoSections = (
  helperRows: Rows,
  countRows: Rows,
  fileProofs: { readonly helper?: number; readonly count?: number },
) =>
  new Map<string, CollectedSection>([
    [
      helper.key,
      {
        assess: assessed(judgementFor("human-required")),
        review: judgedWith(
          "approve",
          helperRows,
          fileProofs.helper === undefined
            ? {}
            : { fileProofs: fileProofs.helper },
        ),
        claims: [],
        steps: STEP,
      },
    ],
    [
      count.key,
      {
        assess: assessed(judgementFor("human-required")),
        review: judgedWith(
          "approve",
          countRows,
          fileProofs.count === undefined
            ? {}
            : { fileProofs: fileProofs.count },
        ),
        claims: [],
        steps: STEP,
      },
    ],
    [
      drop.key,
      {
        assess: assessed(judgementFor("static-automation")),
        review: { judged: false, cause: "failed" },
        claims: [],
        steps: STEP,
      },
    ],
  ]);

const UNANSWERED_MISSING =
  "No reading of this file established this condition's outcome, and no test run or other proof is recorded for it.";

// Reason: the ruling is that a row on a file with no proof record shows Missing, answered or not;
// a row no section answered says both, in one sentence, and keeps its status.
test("a 0-proof file with an unanswered row gets Missing, and says no reading established it", () => {
  const d1: Rows = [
    { row: "D1", status: "no-evidence", cites: [], reading: "" },
  ];
  const { rows } = parseRows(twoSections(d1, d1, { helper: 0, count: 0 }));
  const [first, d2, d3] = rows;
  expect(first!.does).toBe(MISSING);
  for (const row of [d2!, d3!]) {
    expect(row.status).toBe("no-evidence");
    expect(row.proofState).toBe("missing");
    expect(row.does).toBe(UNANSWERED_MISSING);
  }
});

// Reason: a file the Lane review was listed proof records for keeps today's words for a row no
// section answered.
test("a file with proof records and an unanswered row keeps today's words", () => {
  const d1: Rows = [
    { row: "D1", status: "no-evidence", cites: [], reading: "" },
  ];
  const { rows } = parseRows(twoSections(d1, d1, { helper: 1, count: 1 }));
  for (const row of rows.slice(1)) {
    expect(row.status).toBe("no-evidence");
    expect(row.does).toBe(
      "No reading of this file established this condition's outcome.",
    );
    expect("proofState" in row).toBe(false);
  }
});

// Reason: a refused met's reading is the agent's, kept apart from the status: another section that
// answered the row with no evidence, or not at all, never drops it.
test("two sections, one with a met-refused reading and one with no evidence or no answer: the reading survives", () => {
  const refused: Rows = [
    {
      row: "D1",
      status: "no-evidence",
      cites: ["src/parse.ts:new:4-4"],
      reading: "The code reads as meeting this: helper splits on commas.",
    },
  ];
  for (const other of [
    [] as Rows,
    [{ row: "D1", status: "no-evidence", cites: [], reading: "" }] as Rows,
  ]) {
    const { rows } = parseRows(
      twoSections(refused, other, { helper: 0, count: 0 }),
    );
    expect(rows[0]!.proofState).toBe("missing");
    expect(rows[0]!.reading).toEqual({
      text: "The code reads as meeting this: helper splits on commas.",
      cites: [lineAt("src/parse.ts", 4)],
    });
  }
});

// Reason: the status is the worst a section gave, but each section's reading stays: a met and a
// not-met reading of one file's row are both kept, in section order, within the desk's bounds.
test("two sections read apart, met and not-met: both readings are kept within bounds", () => {
  const met: Rows = [
    {
      row: "D1",
      status: "met",
      cites: ["p1", "src/parse.ts:new:4-4"],
      reading: "The helper splits each line on commas, as the row asks (0n4).",
    },
  ];
  const notMet: Rows = [
    {
      row: "D1",
      status: "not-met",
      cites: ["src/parse.ts:new:11-11", "p2"],
      reading: "count drops the last item, so the row fails [0n11].",
    },
  ];
  const { rows } = parseRows(twoSections(met, notMet, { helper: 2, count: 2 }));
  const d1 = rows[0]!;
  // The status reduction is today's: the worst, with its evidence from the not-met section alone.
  expect(d1.status).toBe("not-met");
  expect(d1.evidence).toEqual([lineAt("src/parse.ts", 11), "p2"]);
  expect("proofState" in d1).toBe(false);
  expect(d1.reading).toEqual({
    text: "The helper splits each line on commas, as the row asks. count drops the last item, so the row fails.",
    cites: ["p1", lineAt("src/parse.ts", 4), lineAt("src/parse.ts", 11), "p2"],
  });
  expect(d1.reading!.text.length).toBeLessThanOrEqual(300);
  expect(d1.reading!.cites.length).toBeLessThanOrEqual(8);
});

// Reason: the stored decision is read back through a strict schema before anything is published; a
// row field the schema lacks fails every read of a decision that holds it (round 30's review, B2).
test("a stored decision whose rows carry a proof state and a reading reads back through settledOf equal, and one without them still reads", async () => {
  const { out } = build({
    groups: [linked],
    collected: proofCollected(0),
    frame: FRAME,
  });
  const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const rows = out.batches.flatMap((batch) =>
    batch.units.flatMap((unit) => unit.guided.rows),
  );
  expect(rows.some((row) => row.proofState === "missing")).toBe(true);
  expect(rows.some((row) => row.reading !== undefined)).toBe(true);
  // The same batches as a decision stored before rows had either field.
  const old = plain(out.batches).map((batch) => ({
    ...batch,
    units: batch.units.map((unit) => ({
      ...unit,
      guided: {
        ...unit.guided,
        rows: unit.guided.rows.map(
          ({ proofState: _state, reading: _reading, ...row }) => row,
        ),
      },
    })),
  }));
  const store = scratch();
  const services = {
    ctx: { records: Layer.empty } as never,
    run: (<A, E>(effect: Effect.Effect<A, E, never>) =>
      store.run(effect)) as never,
  };
  for (const batches of [plain(out.batches), old]) {
    const decision = { settled: batches, totals: out.totals, gaps: [] };
    const text = JSON.stringify(decision);
    const bytes = new TextEncoder().encode(text);
    const stored = await store.run(
      Effect.gen(function* () {
        const computations = yield* Computations.ComputationStore;
        return yield* computations.run(
          {
            op: "harness.readings-decision",
            opVersion: 3,
            inputs: { output: sha256Hex(text) },
          },
          Effect.succeed({ bytes, mediaType: "application/json" }),
        );
      }),
    );
    const read = await settledOf(services, stored.computation.key);
    expect(plain(read.batches)).toEqual(batches);
    expect(read.totals).toEqual(out.totals);
  }
});

// ---------------------------------------------------------------------------------------------
// Same-batch references by code (NEU-148 round 27b, `design/readers-briefing-rubric.md` 3.5)
// ---------------------------------------------------------------------------------------------

/** count's group saw a caller of count on helper's changed line; helper is another unit. */
const callerOnHelper = (confirmed: boolean) =>
  [
    {
      group: "g",
      sections: [
        {
          key: briefingFixture.count.key,
          rows: [
            {
              kind: "caller",
              symbol: "count",
              path: "src/parse.ts",
              shows: "call",
              line: briefingFixture.helper.owned.find((r) => r.side === "new")!
                .startLine,
              text: "count(items)",
              from: "helper",
              confirmed,
            },
          ],
        },
      ],
    },
  ] as unknown as ReadonlyArray<GroupEvidence>;

// Reason: the old pipeline's same-batch markers are back, by code: a confirmed caller row whose call
// site lies in another unit's owned head-side lines writes both references, in the design's shape.
test("same-batch references: a confirmed caller row into another unit's owned lines writes both, in the design's shape", () => {
  const { count, helper, hunks, HEAD, MAP_GROUP } = briefingFixture;
  const out = briefingFixture.settle(undefined, briefingFixture.collected(), {
    head: HEAD,
    evidence: callerOnHelper(true),
  });
  const batch = out.batches.find((b) => b.title === MAP_GROUP.label)!;
  const unitKey = (key: string) =>
    unitKeyOf({
      sectionKeys: [
        ...batch.units.find((u) => u.sectionKeys.includes(key))!.sectionKeys,
      ],
    });
  const helperLine = helper.owned.find((r) => r.side === "new")!.startLine;
  const countRange = count.owned[0]!;
  const countHunk = count.hunkIds[0]!;
  const helperHunk = helper.hunkIds[0]!;
  const shared = {
    entries: [],
    unitIds: [unitKey(count.key), unitKey(helper.key)],
    markerKind: "same-batch" as const,
    origin: "same-batch" as const,
    grade: "useful" as const,
    stance: "background" as const,
    retrieval: {
      retriever: "graph",
      querySha256: null,
      rank: null,
      score: null,
    },
    tokens: 0,
  };
  expect(batch.references).toEqual([
    // On helper's call-site line: it calls count, which count's change also changes.
    {
      id: "sb1",
      ...shared,
      locator: `src/parse.ts:${countRange.startLine}`,
      source: {
        origin: "same-batch" as const,
        repository: "",
        revision: HEAD,
        rev: "head",
        blob: hunks.get(countHunk)!.newOid ?? "",
        path: "src/parse.ts",
        startLine: countRange.startLine,
        endLine: countRange.endLine,
        kind: "undeclared" as const,
        sameBatch: [countHunk],
      },
      anchors: [
        {
          hunk: helperHunk,
          path: "src/parse.ts",
          side: "new" as const,
          startLine: helperLine,
          endLine: helperLine,
        },
      ],
      why: `This line calls count, which ${count.title}, changed in this range, also changes.`,
      beforeYouDecide: `Read both changes together: ${count.title} is decided separately and is not yet approved.`,
    },
    // On count's owned lines: helper, changed in this range, calls count.
    {
      id: "sb2",
      ...shared,
      locator: `src/parse.ts:${helperLine}`,
      source: {
        origin: "same-batch" as const,
        repository: "",
        revision: HEAD,
        rev: "head",
        blob: hunks.get(helperHunk)!.newOid ?? "",
        path: "src/parse.ts",
        startLine: helperLine,
        endLine: helperLine,
        kind: "undeclared" as const,
        sameBatch: [helperHunk],
      },
      anchors: [
        {
          hunk: countHunk,
          path: "src/parse.ts",
          side: "new" as const,
          startLine: countRange.startLine,
          endLine: countRange.endLine,
        },
      ],
      why: `${helper.title}, changed in this range, calls count, which this change also changes.`,
      beforeYouDecide: `Read both changes together: ${helper.title} is decided separately and is not yet approved.`,
    },
  ]);
  // Each owned range's hunk ID, parallel to its ranges (records' `rangeHunks`).
  for (const section of batch.sections)
    expect(section.rangeHunks).toHaveLength(section.ownedRanges.length);
  expect(
    batch.sections.find((s) => s.identity.key === helper.key)!.rangeHunks,
  ).toEqual(helper.owned.map((r) => r.hunkId));
});

// Reason: records refuses a batch whose `rangeHunks` are not one hunk ID per range (check
// `range-hunks`), and one ID may never name ranges in two files: such a section gives none and keeps
// today's resolve rule, never refusing its batch.
test("range hunks: one per owned range when each is a hunk ID in one file, else none", () => {
  const { helper, hunks } = briefingFixture;
  const ranges = ownedRangesOf(helper, hunks);
  expect(rangeHunksFor(helper, ranges)).toEqual(
    helper.owned.map((r) => r.hunkId),
  );
  // A rename's old and new path under one hunk: none.
  const renamed = ranges.map((range, at) =>
    at === 0 ? range : { ...range, path: "src/renamed.ts" },
  );
  expect(rangeHunksFor(helper, renamed)).toBeUndefined();
  // An ID not in the harness's form: none.
  expect(
    rangeHunksFor(
      {
        ...helper,
        owned: helper.owned.map((r) => ({ ...r, hunkId: "h-not-a-hunk" })),
      },
      ranges,
    ),
  ).toBeUndefined();
  // A count that does not match: none.
  expect(rangeHunksFor(helper, ranges.slice(0, 1))).toBeUndefined();
});

// Reason: a match by name only is context, never a link between units (`EvidenceRow.confirmed`).
test("same-batch references: an unconfirmed row writes none, and no head writes none", () => {
  const { HEAD, MAP_GROUP } = briefingFixture;
  const of = (out: ReturnType<typeof briefingFixture.settle>) =>
    out.batches.find((b) => b.title === MAP_GROUP.label)!.references;
  expect(
    of(
      briefingFixture.settle(undefined, briefingFixture.collected(), {
        head: HEAD,
        evidence: callerOnHelper(false),
      }),
    ),
  ).toBeUndefined();
  expect(
    of(
      briefingFixture.settle(undefined, briefingFixture.collected(), {
        evidence: callerOnHelper(true),
      }),
    ),
  ).toBeUndefined();
});

// Reason: a call within one unit is the unit's own business; a pair is linked only across units.
test("same-batch references: a row whose call site is in the same unit writes none", () => {
  const { count, helper, hunks, HEAD } = briefingFixture;
  const sectionOf = (s: typeof count) => ({
    key: s.key,
    title: s.title,
    hunkIds: s.hunkIds,
    ranges: ownedRangesOf(s, hunks),
    rangeHunks: rangeHunksOf(s),
  });
  const rows = new Map([
    [count.key, callerOnHelper(true)[0]!.sections[0]!.rows],
  ]);
  const sections = [sectionOf(count), sectionOf(helper)];
  // One unit holding both: none.
  expect(
    sameBatchReferences({
      head: HEAD,
      hunks,
      sections,
      rows,
      units: [{ key: "u", sectionKeys: [count.key, helper.key] }],
    }),
  ).toEqual([]);
  // Two units: both.
  expect(
    sameBatchReferences({
      head: HEAD,
      hunks,
      sections,
      rows,
      units: [
        { key: "u1", sectionKeys: [count.key] },
        { key: "u2", sectionKeys: [helper.key] },
      ],
    }).map((r) => [r.id, r.unitIds]),
  ).toEqual([
    ["sb1", ["u1", "u2"]],
    ["sb2", ["u1", "u2"]],
  ]);
  // B in another batch: only A's reference here, attributed to A's unit alone.
  expect(
    sameBatchReferences({
      head: HEAD,
      hunks,
      sections,
      rows,
      units: [{ key: "u1", sectionKeys: [count.key] }],
    }).map((r) => [r.anchors[0]!.hunk, r.unitIds]),
  ).toEqual([[count.hunkIds[0]!, ["u1"]]]);
});

/** A confirmed row of `of`'s group: `symbol` reached at `path`:`line`, its line showing `shows`. */
const rowOf = (
  of: string,
  symbol: string,
  path: string,
  line: number,
  shows: "call" | "reference" | "caller" = "call",
) =>
  [
    {
      group: "g",
      sections: [
        {
          key: of,
          rows: [
            {
              kind: "caller",
              symbol,
              path,
              shows,
              line,
              text: `${symbol}()`,
              from: "caller",
              confirmed: true,
            },
          ],
        },
      ],
    },
  ] as unknown as ReadonlyArray<GroupEvidence>;

// Reason: Neuve round 51 and the 27b review. A `caller` row's line is the calling function's
// declaration, not where it calls, so it may never say "This line calls"; a `reference` row's line
// hands the name over, and says so.
test("same-batch references: a caller-declaration row writes none; a reference row writes both, as a reference", () => {
  const { count, helper, HEAD, MAP_GROUP } = briefingFixture;
  const line = helper.owned.find((r) => r.side === "new")!.startLine;
  const refsOf = (shows: "caller" | "reference") =>
    briefingFixture
      .settle(undefined, briefingFixture.collected(), {
        head: HEAD,
        evidence: rowOf(count.key, "count", "src/parse.ts", line, shows),
      })
      .batches.find((b) => b.title === MAP_GROUP.label)!.references;
  expect(refsOf("caller")).toBeUndefined();
  const referenced = refsOf("reference")!;
  expect(referenced).toHaveLength(2);
  expect(referenced.map((r) => r.why)).toEqual([
    `This line refers to count, which ${count.title}, changed in this range, also changes.`,
    `${helper.title}, changed in this range, refers to count, which this change also changes.`,
  ]);
  expect(referenced.some((r) => r.why.includes("calls"))).toBe(false);
});

// Reason: Neuve round 51. A section that owns only removed lines has them at the merge base, never
// at the head: its source says so, and with no base given no such source is written.
test("same-batch references: a deletion-only callee's lines are sourced at the merge base, never as head; a deletion-only caller writes none", () => {
  const { drop, count, helper, hunks, HEAD, BASE, MAP_GROUP } = briefingFixture;
  const helperLine = helper.owned.find((r) => r.side === "new")!.startLine;
  const dropRange = drop.owned[0]!;
  expect(drop.owned.every((r) => r.side === "old")).toBe(true);
  const refsWith = (base: string | undefined) =>
    briefingFixture
      .settle(undefined, briefingFixture.collected(), {
        head: HEAD,
        ...(base === undefined ? {} : { base }),
        evidence: rowOf(drop.key, "drop", "src/parse.ts", helperLine),
      })
      .batches.find((b) => b.title === MAP_GROUP.label)!.references ?? [];
  const both = refsWith(BASE);
  expect(both).toHaveLength(2);
  // On drop's removed lines: the source is helper's call at the head.
  const onDrop = both.find((r) => r.anchors[0]!.side === "old")!;
  expect(onDrop.anchors[0]).toMatchObject({
    path: "src/old.ts",
    side: "old",
    startLine: dropRange.startLine,
    endLine: dropRange.endLine,
  });
  expect(onDrop.source).toMatchObject({
    revision: HEAD,
    rev: "head",
    path: "src/parse.ts",
    startLine: helperLine,
    blob: hunks.get(helper.hunkIds[0]!)!.newOid,
  });
  // On helper's call line: the source is drop's removed lines, at the merge base with its old blob.
  const onCall = both.find((r) => r.anchors[0]!.side === "new")!;
  expect(onCall.source).toMatchObject({
    revision: BASE,
    rev: "merge-base",
    path: "src/old.ts",
    startLine: dropRange.startLine,
    endLine: dropRange.endLine,
    blob: hunks.get(drop.hunkIds[0]!)!.oldOid,
  });
  expect(onCall.locator).toBe(`src/old.ts:${dropRange.startLine}`);
  // No reference labels removed lines as the head.
  for (const reference of both) {
    const source = reference.source as { path: string; revision: string };
    if (source.path === "src/old.ts") expect(source.revision).not.toBe(HEAD);
  }
  // With no base given, the reference that would source removed lines is not written.
  const noBase = refsWith(undefined);
  expect(noBase).toHaveLength(1);
  expect(noBase[0]!.anchors[0]!.side).toBe("old");
  expect((noBase[0]!.source as { revision: string }).revision).toBe(HEAD);
  // A deletion-only caller: its call line is at the head, so it lies in no removed range; none.
  expect(
    briefingFixture
      .settle(undefined, briefingFixture.collected(), {
        head: HEAD,
        base: BASE,
        evidence: rowOf(count.key, "count", "src/old.ts", dropRange.startLine),
      })
      .batches.find((b) => b.title === MAP_GROUP.label)!.references,
  ).toBeUndefined();
});

// Reason: the desk's final pictures. Every checkout row read "Source line 69" though two described
// lines 78-88: a Guided row's line cite names the lines it read, in records' grammar, clipped into one
// owned row of the hunk on its batch-wide side, and the bare hunk only where no line range applies.
test("Guided row evidence cites the lines it read: a span inside one row, a clip, an outside range as the bare hunk, and a split hunk", () => {
  const h = "h0123456789abcde";
  const hunk = {
    hunkId: h,
    kind: "text",
    path: "src/checkout.ts",
    oldPath: "src/checkout.ts",
    newPath: "src/checkout.ts",
    oldStart: 60,
    oldLines: 40,
    newStart: 60,
    newLines: 40,
  };
  const hunks = new Map([[h, hunk as never]]);
  const rows = (
    ...each: ReadonlyArray<readonly ["old" | "new", number, number, string]>
  ) =>
    new Map([
      [
        h,
        each.map(([side, startLine, endLine, key]) => ({
          hunk: h,
          key,
          side,
          startLine,
          endLine,
        })),
      ],
    ]);
  const held = rows(["new", 69, 69, "a"], ["new", 78, 88, "a"]);
  const of = (cites: ReadonlyArray<string>, by = held) =>
    rowEvidence(cites, hunks, new Set(["p1"]), by);
  // Lines 78-88 inside one owned row: cited as those lines, not the hunk's first line.
  expect(of(["src/checkout.ts:new:78-88"])).toEqual([`${h}@78-88`]);
  expect(of(["src/checkout.ts:new:69-69"])).toEqual([`${h}@69`]);
  // Running past the row: clipped into it; spanning two rows: the row where it starts.
  expect(of(["src/checkout.ts:new:80-95"])).toEqual([`${h}@80-88`]);
  expect(of(["src/checkout.ts:new:69-80"])).toEqual([`${h}@69`]);
  // Inside the hunk but in no owned row: the bare hunk. A proof record stays as it is.
  expect(of(["src/checkout.ts:new:72-74", "p1"])).toEqual([h, "p1"]);
  // Every cite written is one records' parser reads, with no leading zero.
  for (const id of of(["src/checkout.ts:new:78-88"]))
    expect(lineCiteOf(id)?.lines).toEqual({ startLine: 78, endLine: 88 });
  // A split hunk: foo owns the removed lines 78-88, bar the added lines 78-88. The hunk is new-side
  // for the batch, so a cite of the removed lines is the bare hunk, never bar's added lines.
  const split = rows(["old", 78, 88, "foo"], ["new", 78, 88, "bar"]);
  expect(of(["src/checkout.ts:old:78-88"], split)).toEqual([h]);
  expect(of(["src/checkout.ts:new:78-88"], split)).toEqual([`${h}@78-88`]);
  // A deletion alone is old-side: its removed lines are cited.
  const removed = rows(["old", 78, 88, "foo"]);
  expect(of(["src/checkout.ts:old:80-82"], removed)).toEqual([`${h}@80-82`]);
  // The bound stays 8.
  const many = Array.from({ length: 12 }, (_, at) => `p${at}`);
  expect(rowEvidence(many, hunks, new Set(many), held)).toHaveLength(8);
});

// Reason: the re-read of c66a346f. A unit's Guided row must never open another unit's lines: a cite
// narrows into the unit's own rows of a hunk on the hunk's side over every holder; a hunk it holds no
// row of, or none on that side, gives nothing (Records' bare hunk would open every holder's lines).
test("Guided row evidence narrows only into the unit's own rows: another unit's hunk or side gives nothing", () => {
  const h = "h0123456789abcde";
  const g = "hfedcba987654321";
  const hunks = new Map([
    [
      h,
      {
        hunkId: h,
        kind: "text",
        path: "src/a.ts",
        oldStart: 9,
        oldLines: 6,
        newStart: 9,
        newLines: 6,
      } as never,
    ],
    [
      g,
      {
        hunkId: g,
        kind: "text",
        path: "src/a.ts",
        oldStart: 40,
        oldLines: 3,
        newStart: 40,
        newLines: 3,
      } as never,
    ],
  ]);
  // foo (unit U) owns h's removed rows; bar (unit V) owns h's added rows and all of g.
  const held = new Map([
    [
      h,
      [
        {
          hunk: h,
          key: "foo",
          side: "old" as const,
          startLine: 11,
          endLine: 12,
        },
        {
          hunk: h,
          key: "bar",
          side: "new" as const,
          startLine: 11,
          endLine: 12,
        },
      ],
    ],
    [
      g,
      [
        {
          hunk: g,
          key: "bar",
          side: "new" as const,
          startLine: 40,
          endLine: 42,
        },
      ],
    ],
  ]);
  const cites = ["src/a.ts:new:11-12", "src/a.ts:new:41-41"];
  // The reviewer's case: U cites new 11-12 and 41, which are V's; U gets nothing from h or g.
  expect(rowEvidence(cites, hunks, new Set(["p1"]), held, ["foo"])).toEqual([]);
  // Its removed lines are on h's other side for the batch: nothing either. A proof stays.
  expect(
    rowEvidence(["src/a.ts:old:11-12", "p1"], hunks, new Set(["p1"]), held, [
      "foo",
    ]),
  ).toEqual(["p1"]);
  // V cites its own lines inside the split hunk and in g: each keeps its narrowed cite.
  expect(rowEvidence(cites, hunks, new Set(), held, ["bar"])).toEqual([
    `${h}@11-12`,
    `${g}@41`,
  ]);
  // V's cite of h's old side: no range, and h has another holder, so nothing; g it holds whole, so a
  // line in g outside its rows keeps the bare hunk.
  expect(
    rowEvidence(["src/a.ts:old:11-12"], hunks, new Set(), held, ["bar"]),
  ).toEqual([]);
  const whole = new Map([
    [
      g,
      [
        {
          hunk: g,
          key: "bar",
          side: "new" as const,
          startLine: 41,
          endLine: 41,
        },
      ],
    ],
  ]);
  expect(
    rowEvidence(["src/a.ts:new:40-40"], hunks, new Set(), whole, ["bar"]),
  ).toEqual([g]);
});

// Reason: the desk's final recapture. A Guided row's words come from the Frame's done-when rows,
// which carry section and decision codes ("(S13.1)", "(S3.4, decision 0016)"); the owner sees none.
test("Guided row text, its words and its reading carry no section or decision code; other parentheses stay", () => {
  expect(withoutCodes("Shared checkouts are probed once (S13.1).")).toBe(
    "Shared checkouts are probed once.",
  );
  expect(
    withoutCodes(
      "Callers share one run per key (S3.4, decision 0016) and wait.",
    ),
  ).toBe("Callers share one run per key and wait.");
  expect(withoutCodes("Retries stop at two (S2 and S2.1; record 12)")).toBe(
    "Retries stop at two",
  );
  // Any other parenthesis stays, untouched.
  expect(withoutCodes("A busy store gets one more try (a retry).")).toBe(
    "A busy store gets one more try (a retry).",
  );
  expect(withoutCodes("Outcome (S13.1 is the section) stays")).toBe(
    "Outcome (S13.1 is the section) stays",
  );
  // A bare S<n> alone is no section code: a storage service and sizes keep their parentheses.
  expect(withoutCodes("Uploads go to object storage (S3).")).toBe(
    "Uploads go to object storage (S3).",
  );
  expect(withoutCodes("Sizes (S1, S2 and S3) are offered.")).toBe(
    "Sizes (S1, S2 and S3) are offered.",
  );
  expect(withoutCodes("Retries stop at two (S2.1; record 12).")).toBe(
    "Retries stop at two.",
  );
  // A fresh cold review: square brackets carry the same codes ("… caller. [S13.1]"), by the same
  // rules; a `[phrase](id)` link and any other bracket stay.
  expect(withoutCodes("It reads the caller. [S13.1]")).toBe(
    "It reads the caller.",
  );
  expect(
    withoutCodes("Callers share one run [S3.4, decision 0016] and wait."),
  ).toBe("Callers share one run and wait.");
  expect(withoutCodes("Retries stop at two [S2.1; record 12].")).toBe(
    "Retries stop at two.",
  );
  expect(withoutCodes("Sizes [S1, S2 and S3] are offered.")).toBe(
    "Sizes [S1, S2 and S3] are offered.",
  );
  const own = `h${"0".repeat(15)}`;
  expect(withoutCodes(`It reads [the caller](${own}@1-2). [S13.1]`)).toBe(
    `It reads [the caller](${own}@1-2).`,
  );
  // A link whose phrase is a code is still a link.
  expect(withoutCodes(`See [S13.1](${own}@1-2) here.`)).toBe(
    `See [S13.1](${own}@1-2) here.`,
  );
  expect(withoutCodes("A busy store gets one more try [a retry].")).toBe(
    "A busy store gets one more try [a retry].",
  );
  // A code between two words leaves one space, so the words stay apart.
  expect(withoutCodes("a [S1.1]b")).toBe("a b");
  expect(withoutCodes("a (S1.1, decision 3)b")).toBe("a b");
  expect(withoutCodes("a [S1.1] b")).toBe("a b");
  // Through the settler: the row's text has no code.
  const { MAP_GROUP, FRAME } = briefingFixture;
  const decision = briefingFixture.decided();
  const out = settledBatches({
    planKey: "c".repeat(64),
    manifestKey: "d".repeat(64),
    hunks: briefingFixture.hunks,
    groups: [MAP_GROUP],
    frame: {
      ...FRAME,
      doneWhen: FRAME.doneWhen.map((row) => ({
        ...row,
        text: "Counting returns the parsed items (S3.4, decision 0016). [S13.1]",
      })),
    },
    sections: decision.sections,
    collected: briefingFixture.collected(),
    placement: decision.placement,
    proofs: new Set(["p1", "p2"]),
  });
  const rows = out.batches
    .flatMap((b) => b.units)
    .flatMap((u) => u.guided.rows);
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row.text).toBe("Counting returns the parsed items.");
    expect(row.does).not.toMatch(/[([]S\d/);
  }
});
