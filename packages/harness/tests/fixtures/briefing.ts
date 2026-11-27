// The briefing's shared fixture (NEU-148 round 27): two read code files and a lockfile of the mixed
// range in one Map group, decided by code from fixed readings, and the briefings a run would store
// for them. Used by `readings-briefing.test.ts` and `readings-briefing-boundary.test.ts`.
import type {
  AssessJudgement,
  LaneReviewJudgement,
} from "../../src/readings/answers.ts";
import { briefingLayout } from "../../src/readings/briefing.ts";
import type {
  BriefingState,
  FileLead,
  SectionBriefing,
  SettledBriefings,
} from "../../src/readings/briefing-settle.ts";
import { claimKey } from "../../src/readings/claims.ts";
import { planReadings, type ReadingPlan } from "../../src/readings/plan.ts";
import {
  decideSections,
  settledBatches,
  type CollectedSection,
  type GuidedFrame,
  type MapGroup,
} from "../../src/readings/settled.ts";
import { RECORDS, judgementFor, mixedRange } from "./readings.ts";

export const MARKS = {
  impact: "IMPACT-MARK callers can now count the parsed items",
  defect: "DEFECT-MARK count drops the last item",
  checked: "CHECKED-MARK read the callers of count",
  unsure: "UNSURE-MARK could not see the caller",
  finding: "FINDING-MARK helper adds two where one is meant",
  model: "MODEL-BRIEFED",
  explained: "MODEL-EXPLAINED",
  digest: "MODEL-DIGEST",
  title: "MODEL-TITLE",
} as const;

const KEPT = new Set(["src/parse.ts", "src/old.ts", "bun.lock"]);
const range = mixedRange();
export const hunkList = range.hunks
  .filter((hunk) => KEPT.has(hunk.path))
  .map((hunk) =>
    hunk.path === "src/old.ts"
      ? { ...hunk, declared: [{ kind: "test" as const, by: "fixture" }] }
      : hunk,
  );
export const hunks = new Map(hunkList.map((hunk) => [hunk.hunkId, hunk]));
export const structures = range.structures;
export const excluded = range.excluded;
export const plan: ReadingPlan = planReadings({
  hunks: hunkList,
  structures,
  excluded,
});
export const sectionOf = (path: string, name: string | null) =>
  [...plan.sections, ...plan.unread].find(
    (s) => s.path === path && s.name === name,
  )!;
export const helper = sectionOf("src/parse.ts", "helper");
export const count = sectionOf("src/parse.ts", "count");
export const drop = sectionOf("src/old.ts", "drop");

/** One Map group holding all three files: its read sections are one batch, bun.lock the generated. */
export const MAP_GROUP: MapGroup = {
  id: "m1",
  label: "Count parsed items",
  why: "Callers need the number of parsed items.",
  files: [...KEPT].map((path) => ({ path })),
  hunkIds: hunkList.map((h) => h.hunkId),
  doneWhen: ["D1"],
};
export const FRAME: GuidedFrame & { readonly goal: string } = {
  goal: "Let callers count parsed items.",
  stratum: "plan-or-ticket-at-base",
  doneWhen: [
    {
      id: "D1",
      text: "Counting returns the parsed items.",
      basis: "done-when",
      sectionId: null,
    },
  ],
};

const STEP = { assess: "a".repeat(64), review: "b".repeat(64) } as const;
const reviewed = (
  verdict: LaneReviewJudgement["verdict"],
  comments: LaneReviewJudgement["comments"] = [],
  extra: Partial<LaneReviewJudgement> = {},
): CollectedSection["review"] => ({
  judged: true,
  judgement: { verdict, comments, checked: "", rows: [], unsure: [], ...extra },
});
const assessed = (judgement: AssessJudgement): CollectedSection["assess"] => ({
  judged: true,
  judgement,
});
export const defect = {
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
 * helper approves (no text of its own: asked), count requests changes on a confirmed defect and has
 * an impact entry (its own text: not asked), drop's Lane review is unsure with no reason (asked,
 * undecided). The Lane review's words carry marks a briefing must never see.
 */
export const collected = (): Map<string, CollectedSection> =>
  new Map<string, CollectedSection>([
    [
      helper.key,
      {
        assess: assessed(judgementFor("human-suggested")),
        review: reviewed("approve", [], { checked: MARKS.checked }),
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
              effect: "changed",
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
        assess: assessed(judgementFor("static-automation")),
        review: reviewed("unsure"),
        claims: [],
        steps: STEP,
      },
    ],
  ]);

export const decided = (held = collected()) =>
  decideSections({
    plan,
    hunks,
    groups: [MAP_GROUP],
    collected: held,
    proofs: new Map([["src/old.ts", RECORDS]]),

    excluded,
  });

/**
 * The briefings a run would store: for each part, Explained and the model's Briefed for every
 * section (round 27b: every section is asked), or only for the sections in `briefed` when given; the
 * batch's digest, linking a hunk of count; and `leads`, by path, as the parts wrote them. `state`
 * sets how every part and digest ended.
 */
export const briefingsFor = (
  state: BriefingState,
  options: {
    readonly briefed?: ReadonlySet<string>;
    readonly leads?: ReadonlyMap<string, FileLead>;
  } = {},
): SettledBriefings => {
  const layout = briefingLayout(plan, [MAP_GROUP]);
  const sections = new Map<string, SectionBriefing>();
  for (const parts of layout.parts.values())
    for (const part of parts)
      for (const key of part.sections) {
        const section = plan.sections.find((s) => s.key === key)!;
        const written = state === "written";
        const briefed = options.briefed?.has(key) ?? true;
        sections.set(key, {
          state,
          title: written ? `${MARKS.title} counting for ${section.name}` : null,
          briefed:
            written && briefed
              ? `${MARKS.model} callers of ${section.name} [now see the change](${section.hunkIds[0]}).`
              : null,
          explained: written
            ? {
                before: `${MARKS.explained} before ${section.title}.`,
                after: `${MARKS.explained} after ${section.title}.`,
                terms: [],
                cites: [section.hunkIds[0]!],
              }
            : null,
        });
      }
  const digests = new Map(
    [...layout.digests.keys()].map((batch) => [
      batch,
      {
        state,
        text:
          state === "written"
            ? {
                digest: `${MARKS.digest} [the counter](${count.hunkIds[0]}) and [a stranger](hffffffffffffff0).`,
                uncertainty: ["Whether callers rely on the old count."],
                limitations: ["The callers outside this batch are not shown."],
              }
            : null,
      },
    ]),
  );
  return {
    sections,
    digests,
    ...(options.leads === undefined ? {} : { leads: options.leads }),
  };
};

/** The fixture's head commit, for the same-batch references' sources. */
export const HEAD = "a".repeat(40);
/** The fixture's merge base, for a source on removed lines. */
export const BASE = "b".repeat(40);

export const settle = (
  briefings?: SettledBriefings,
  held = collected(),
  extra: Pick<
    Parameters<typeof settledBatches>[0],
    "evidence" | "head" | "base"
  > = {},
) => {
  const decision = decided(held);
  return settledBatches({
    ...extra,
    planKey: "c".repeat(64),
    manifestKey: "d".repeat(64),
    hunks,
    groups: [MAP_GROUP],
    frame: FRAME,
    sections: decision.sections,
    collected: held,

    proofs: new Set(["p1", "p2"]),
    ...(briefings === undefined ? {} : { briefings }),
  });
};
