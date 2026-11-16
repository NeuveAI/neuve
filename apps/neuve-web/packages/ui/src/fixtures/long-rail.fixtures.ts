import {
  reviewDeskFixture,
  suggestedUnitFixture,
} from "@workspace/ui/fixtures/review-batch.fixtures"
import type {
  BatchUnit,
  ElsewhereLane,
  LaneUnit,
  ReviewDeskData,
} from "@workspace/ui/neuve/types"

/*
 * Real volume for the unit rail (the owner's 23 October review): a batch
 * whose 43 suggested units the review could not assess, so each has no
 * written title: its title is the harness's path line, cut at its fixed
 * length, and the projection sets `untitled` (its file and owned lines). The
 * titles and paths are the live desk's, in its order; the line spans are
 * illustrative. The agentic and static lanes keep the 22-unit batch's
 * written titles, so one rail shows both kinds of row. The desk is open on a
 * unit far down the list (the 28th), past any first screen.
 */

const BATCH = `for "Overview reflects decisions, standing reviews and verification by unit".`

/** A harness path line at the length the live desk shows it, and its file. */
const line = (path: string, rest: string) => ({
  path,
  title: `${path}${rest} ${BATCH}`.slice(0, 120),
})

const SUGGESTED_TITLES: ReadonlyArray<{ path: string; title: string }> = [
  line(
    "apps/neuve-web/apps/web/scripts/real-packet-fixture.ts",
    ": 1 hunk(s), +1 -1 lines,"
  ),
  line(
    "apps/neuve-web/apps/web/src/server/desk.server.ts",
    ": 2 hunk(s), +3 -1 lines,"
  ),
  line(
    "apps/neuve-web/apps/web/src/server/desk.server.ts",
    " (peopleOf, overviewLoad): 2 hunk(s), +49 -31 lines,"
  ),
  line(
    "apps/neuve-web/apps/web/src/server/desk.server.ts",
    " (deskLoad): 1 hunk(s), +7 -10 lines,"
  ),
  line(
    "apps/neuve-web/apps/web/src/server/overview-decisions.test.ts",
    " (directories, location, run): 1 hunk(s), +441 -0 lines,"
  ),
  line(
    "apps/neuve-web/apps/web/src/server/projection.ts",
    ": 2 hunk(s), +3 -0 lines,"
  ),
  line(
    "apps/neuve-web/apps/web/src/server/projection.ts",
    " (humanDispositions, OverviewPeople, NO_PEOPLE): 1 hunk(s), +33 -0 lines,"
  ),
  line(
    "apps/neuve-web/apps/web/src/server/projection.ts",
    " (overviewData, units, found): 1 hunk(s), +4 -1 lines,"
  ),
  line(
    "apps/neuve-web/apps/web/src/server/projection.ts",
    " (decidedIds, waiting, decided): 2 hunk(s), +78 -1 lines,"
  ),
  line(
    "apps/neuve-web/apps/web/src/server/projection.ts",
    ": 1 hunk(s), +4 -2 lines,"
  ),
  line(
    "apps/neuve-web/packages/ui/src/fixtures/decided-overview.fixtures.ts",
    " (YOU, ANA, Decision): 1 hunk(s), +117 -0 lines,"
  ),
  line(
    "apps/neuve-web/packages/ui/src/fixtures/review-batch.fixtures.ts",
    " (overviewUnitsFixture): 1 hunk(s), +28 -0 lines,"
  ),
  line(
    "apps/neuve-web/packages/ui/src/neuve/batch-overview/atoms.ts",
    " (activeLaneAtom, capturePlayingAtom, captureRunAtom): 2 hunk(s), +20 -3 lines,"
  ),
  line(
    "apps/neuve-web/packages/ui/src/neuve/batch-overview/batch-hero.tsx",
    " (ICON, ICON_STROKE): 2 hunk(s), +7 -1 lines,"
  ),
  line(
    "apps/neuve-web/packages/ui/src/neuve/batch-overview/batch-hero.tsx",
    " (BatchHero, openCitation, openSheet): 2 hunk(s), +139 -40 lines,"
  ),
  line(
    "apps/neuve-web/packages/ui/src/neuve/batch-overview/batch-overview-screen.stories.tsx",
    " (meta): 1 hunk(s), +9 -3 lines,"
  ),
  line(
    "apps/neuve-web/packages/ui/src/neuve/batch-overview/batch-overview-screen.stories.tsx",
    " (PendingAssessments, squares, Waiting): 2 hunk(s), +40 -2 lines,"
  ),
  line(
    "apps/neuve-web/packages/ui/src/neuve/batch-overview/batch-overview-screen.tsx",
    " (BatchOverviewScreenProps, BatchOverview, BatchOverviewScreen): 3 hunk(s), +61 -12 lines,"
  ),
  line(
    "apps/neuve-web/packages/ui/src/neuve/batch-overview/batch-overview.stories.tsx",
    " (data): 2 hunk(s), +3 -1 lines,"
  ),
  line(
    "apps/neuve-web/packages/ui/src/neuve/batch-overview/batch-overview.stories.tsx",
    " (Verification, tile, realMissing): 2 hunk(s), +30 -4 lines,"
  ),
  line(
    "apps/neuve-web/packages/ui/src/neuve/batch-overview/decision-panel.tsx",
    " (STROKE, VERDICT, VERDICT_WORDS): 1 hunk(s), +267 -0 lines,"
  ),
  line(
    "apps/neuve-web/packages/ui/src/neuve/batch-overview/judgment-table.tsx",
    ": 2 hunk(s), +9 -0 lines,"
  ),
  line(
    "apps/neuve-web/packages/ui/src/neuve/batch-overview/judgment-table.tsx",
    " (UnitRow, agents, setOpenTips): 2 hunk(s), +171 -20 lines,"
  ),
  line(
    "apps/neuve-web/packages/ui/src/neuve/batch-overview/lane-bar.tsx",
    " (LaneBar, LaneCounts): 2 hunk(s), +32 -1 lines,"
  ),
  line(
    "apps/neuve-web/packages/ui/src/neuve/batch-overview/missing-requirements.tsx",
    " (STROKE, REVEAL, MissingCard): 1 hunk(s), +120 -0 lines,"
  ),
  line(
    "apps/neuve-web/packages/ui/src/neuve/batch-overview/unit-list.tsx",
    " (STROKE, UnitRow, UnitRows): 1 hunk(s), +240 -0 lines,"
  ),
  line(
    "apps/neuve-web/packages/ui/src/neuve/batch-overview/verification-grid.tsx",
    " (STROKE, ICON, TILE): 2 hunk(s), +10 -185 lines,"
  ),
  line(
    "apps/neuve-web/packages/ui/src/neuve/batch-overview/verification-grid.tsx",
    " (BrowserEvidenceTile): 2 hunk(s), +8 -1 lines,"
  ),
  line(
    "apps/neuve-web/packages/ui/src/neuve/batch-overview/verification-grid.tsx",
    " (TestEvidenceTile): 2 hunk(s), +8 -1 lines,"
  ),
  line(
    "apps/neuve-web/packages/ui/src/neuve/batch-overview/verification-grid.tsx",
    " (GRID, VerificationGrid): 2 hunk(s), +28 -48 lines,"
  ),
  line(
    "apps/neuve-web/packages/ui/src/neuve/types.ts",
    " (DecidedUnit, OverviewUnit, VerificationCard): 1 hunk(s), +19 -0 lines,"
  ),
  line(
    "apps/neuve-web/packages/ui/src/neuve/types.ts",
    " (BatchOverviewData): 1 hunk(s), +13 -0 lines,"
  ),
  line(
    "apps/neuve-web/packages/ui/test/fixtures/batch-invariants.test.ts",
    ": 1 hunk(s), +6 -0 lines,"
  ),
  line(
    "apps/neuve-web/packages/ui/test/fixtures/batch-invariants.test.ts",
    " (OVERVIEWS): 1 hunk(s), +4 -0 lines,"
  ),
  line(
    "apps/neuve-web/packages/ui/test/fixtures/batch-invariants.test.ts",
    ": 1 hunk(s), +35 -4 lines,"
  ),
  line(
    "design/neuve-web/changes/round-8.md",
    " (neuve-web design round 8: the batch overview says where the batch is, The top of the overview): 1 hunk(s),"
  ),
  line(
    "design/neuve-web/design-export/Overview.dc.html",
    ": 3 hunk(s), +71 -77 lines,"
  ),
  line(
    "design/neuve-web/design-export/Overview.dc.html",
    ": 4 hunk(s), +94 -11 lines,"
  ),
  line(
    "design/neuve-web/design-export/canvas.json",
    ": 1 hunk(s), +2 -2 lines,"
  ),
  line(
    "design/neuve-web/design-export/canvas.json",
    ": 1 hunk(s), +1 -1 lines,"
  ),
  line("design/neuve-web/design-system.md", ": 2 hunk(s), +14 -2 lines,"),
  line("design/neuve-web/figma/README.md", ": 1 hunk(s), +1 -1 lines,"),
  line(
    "design/neuve-web/figma/README.md",
    " (Pen versus code): 1 hunk(s), +2 -0 lines,"
  ),
]

const unitId = (i: number) => `long-rail-unit-${String(i + 1).padStart(2, "0")}`

/** Illustrative owned spans, distinct per unit. */
const spanOf = (i: number) => {
  const start = 12 + ((i * 37) % 380)
  return { start, end: start + 3 + (i % 9) * 4 }
}

const SUGGESTED_UNITS: Array<LaneUnit> = SUGGESTED_TITLES.map(
  ({ path, title }, i) => ({
    id: unitId(i),
    title,
    result: "open",
    untitled: { files: [{ path, lines: [spanOf(i)] }] },
  })
)

/** The unit the desk is open on: far down Suggested. */
export const LONG_RAIL_CURRENT_INDEX = 27

const ELSEWHERE: Array<ElsewhereLane> = reviewDeskFixture.elsewhere.map(
  (lane) =>
    lane.lane === "human-suggested"
      ? { ...lane, count: SUGGESTED_UNITS.length, units: SUGGESTED_UNITS }
      : lane
)

const BATCH_UNITS: Array<BatchUnit> = [
  ...reviewDeskFixture.batchUnits.filter(
    (unit) => unit.lane !== "human-suggested"
  ),
  ...SUGGESTED_UNITS.map(({ id, title }) => ({
    id,
    title,
    lane: "human-suggested" as const,
  })),
]

/** The desk on the given untitled suggested unit (0-based). */
export function longRailDeskOn(index: number): ReviewDeskData {
  const unit = SUGGESTED_UNITS[index]!
  return {
    ...suggestedUnitFixture,
    unit: { ...suggestedUnitFixture.unit, id: unit.id, title: unit.title },
    elsewhere: ELSEWHERE,
    batchUnits: BATCH_UNITS,
  }
}

/** The desk on the 28th of 43 untitled suggested units. */
export const longRailDeskFixture: ReviewDeskData = longRailDeskOn(
  LONG_RAIL_CURRENT_INDEX
)
