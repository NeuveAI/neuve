import { reviewDeskFixture } from "@workspace/ui/fixtures/review-batch.fixtures"
import type { CommentContext } from "@workspace/ui/neuve/review-desk/diff-file"
import { crowdedRangedFileFor } from "@workspace/ui/fixtures/crowded-ranges.fixtures"
import type { DiffFile, ReviewDeskData } from "@workspace/ui/neuve/types"

/**
 * Round 3 diff fixtures (Sticky.dc.html, Ranges.dc.html): a file reviewed
 * by owned ranges with unchanged gaps and a sibling unit's lines, plus two
 * whole files, enough to scroll past sticky headers. Controlled UI data; no
 * retained batch or review authority.
 */

export const OWNED_UNIT_ID = "client-retry-identity"
export const SIBLING_UNIT_ID = "typed-preparation-failures"
export const OWNED_REVISION = "c".repeat(40)

const ROUTE_PATH = "apps/neuve-web/apps/web/src/routes/index.tsx"

const TEMPLATE = [
  (i: number) => `export function step${i}(request: PreparedStartReview) {`,
  (i: number) => `  const notice = reviewStartNotice(request, ${i})`,
  (i: number) =>
    `  if (!request.commandId) return refused("missing command", ${i})`,
  () => `  const store = useStore()`,
  (i: number) => `  await router.invalidate({ sync: ${i % 2 === 0} })`,
  () => `  return { kind: "accepted", notice }`,
  () => `}`,
  () => ``,
]

function line(i: number): string {
  return TEMPLATE[i % TEMPLATE.length]!(i)
}

const OLD_LINES = 240
const old = Array.from({ length: OLD_LINES }, (_, i) => line(i + 1))

/*
 * Changes, by old line:
 *   2        replaced            owned       (old 2 → new 2)
 *   after 20 two lines added     owned       (new 21–22)
 *   140      replaced            sibling     (old 140 → new 142)
 *   200–201  three lines replace owned       (old 200–201 → new 202–204)
 */
const OWNED_NEW_2 = `  const notice = reviewStartNotice(request, 2, { retry: true })`
const OWNED_NEW_21_22 = [
  `  const [request, setRequest] = useAtom(requestAtom)`,
  `  const [notice, setNotice] = useAtom(noticeAtom)`,
]
const SIBLING_NEW_142 = `  await router.invalidate({ sync: true, reason: "typed failure" })`
const OWNED_NEW_202_204 = [
  `  setNotice("The run acknowledgment is recorded, but the view could not refresh.")`,
  `  await refreshOverview()`,
  `  await router.invalidate()`,
]

const next = [
  old[0]!,
  OWNED_NEW_2,
  ...old.slice(2, 20),
  ...OWNED_NEW_21_22,
  ...old.slice(20, 139),
  SIBLING_NEW_142,
  ...old.slice(140, 199),
  ...OWNED_NEW_202_204,
  ...old.slice(201),
]

const text = (lines: Array<string>) => `${lines.join("\n")}\n`

export const ownedRangesFile: DiffFile = {
  path: ROUTE_PATH,
  oldContents: text(old),
  newContents: text(next),
  context: 3,
  additions: 6,
  deletions: 3,
  markerAnchors: [
    { markerKey: "conflict", side: "additions", lineNumber: 2 },
    { markerKey: "doc", side: "additions", lineNumber: 21 },
    // In the unchanged gap L23–L138: waits on the gap row's "1 hidden" pin.
    { markerKey: "graph", side: "additions", lineNumber: 60 },
    // On the sibling unit's line: waits on its row while it is folded.
    { markerKey: "test", side: "additions", lineNumber: 142 },
  ],
  responsibility: {
    kind: "changed-ranges",
    unitId: OWNED_UNIT_ID,
    revisionId: OWNED_REVISION,
    ownedSource: [
      {
        kind: "changed-lines",
        hunkId: "h-imports",
        side: "old",
        sourceRevisionId: "b".repeat(40),
        startLine: 2,
        lineCount: 1,
        lines: [old[1]!],
      },
      {
        kind: "changed-lines",
        hunkId: "h-imports",
        side: "new",
        sourceRevisionId: OWNED_REVISION,
        startLine: 2,
        lineCount: 1,
        lines: [OWNED_NEW_2],
      },
      {
        kind: "changed-lines",
        hunkId: "h-atoms",
        side: "new",
        sourceRevisionId: OWNED_REVISION,
        startLine: 21,
        lineCount: 2,
        lines: OWNED_NEW_21_22,
      },
      {
        kind: "changed-lines",
        hunkId: "h-notice",
        side: "old",
        sourceRevisionId: "b".repeat(40),
        startLine: 200,
        lineCount: 2,
        lines: [old[199]!, old[200]!],
      },
      {
        kind: "changed-lines",
        hunkId: "h-notice",
        side: "new",
        sourceRevisionId: OWNED_REVISION,
        startLine: 202,
        lineCount: 3,
        lines: OWNED_NEW_202_204,
      },
    ],
    siblingSource: [
      {
        unitId: SIBLING_UNIT_ID,
        title: "Typed preparation failures and recovery messages",
        lane: "agentic-review",
        side: "old",
        startLine: 140,
        lineCount: 1,
      },
      {
        unitId: SIBLING_UNIT_ID,
        title: "Typed preparation failures and recovery messages",
        lane: "agentic-review",
        side: "new",
        startLine: 142,
        lineCount: 1,
      },
    ],
  },
}

/** A whole file of `count` lines whose middle lines changed (no ranges). */
function wholeFile(
  path: string,
  count: number,
  changed: Array<number>
): DiffFile {
  const before = Array.from(
    { length: count },
    (_, i) =>
      `  const value${i + 1} = compute("${path.split("/").at(-1)}", ${i + 1})`
  )
  const after = before.map((value, i) =>
    changed.includes(i + 1) ? value.replace("compute", "computeChecked") : value
  )
  return {
    path,
    oldContents: text(before),
    newContents: text(after),
    // Every line shows, so the files are long enough to scroll.
    context: count,
    additions: changed.length,
    deletions: changed.length,
    markerAnchors: [],
  }
}

export const startOperationFile = wholeFile(
  "apps/neuve-web/apps/web/src/components/start-review-operation.ts",
  60,
  [5, 6, 7, 8, 30]
)

export const liveReviewFile = wholeFile(
  "apps/neuve-web/apps/web/src/server/live-review.ts",
  70,
  [12, 13, 40, 41, 42]
)

export const ownedRangesFiles: Array<DiffFile> = [
  startOperationFile,
  liveReviewFile,
  ownedRangesFile,
]

export const ownedRangesContext: CommentContext = {
  unitId: OWNED_UNIT_ID,
  revision: OWNED_REVISION,
  author: reviewDeskFixture.reviewer,
}

export const ownedRangesMarkers = reviewDeskFixture.markers

/** The same unit as review desk data (screen stories). */
export const ownedRangesDeskFixture: ReviewDeskData = {
  ...reviewDeskFixture,
  revision: OWNED_REVISION,
  unit: {
    ...reviewDeskFixture.unit,
    id: OWNED_UNIT_ID,
    title: "Client retry identity, notices and projection refresh",
    stats: "3 files · 4 owned ranges",
  },
  files: ownedRangesFiles,
  neighbor: undefined,
}

/*
 * Gap sizes (review F1): owned one-line replacements at L5, L7, L10 and L14
 * of a 20-line file leave gaps of 4 (L1–4), 1 (L6), 2 (L8–9), 3 (L11–13)
 * and 6 lines (L15–20). Built from the retained patch, as live data is.
 */
const GAP_PATH = "apps/neuve-web/apps/web/src/components/gap-sizes.ts"
const GAP_CHANGES = [5, 7, 10, 14]
const gapOld = Array.from(
  { length: 20 },
  (_, i) => `const line${i + 1} = ${i + 1}`
)
const gapNew = gapOld.map((value, i) =>
  GAP_CHANGES.includes(i + 1) ? `${value} // owned` : value
)

function replacementPatch(
  path: string,
  before: Array<string>,
  after: Array<string>,
  changed: Array<number>
): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    ...changed.flatMap((at) => [
      `@@ -${at},1 +${at},1 @@`,
      `-${before[at - 1]}`,
      `+${after[at - 1]}`,
    ]),
    "",
  ].join("\n")
}

export const gapSizesFile: DiffFile = {
  path: GAP_PATH,
  oldContents: text(gapOld),
  newContents: text(gapNew),
  patch: replacementPatch(GAP_PATH, gapOld, gapNew, GAP_CHANGES),
  context: 0,
  additions: GAP_CHANGES.length,
  deletions: GAP_CHANGES.length,
  // In the 2-line gap: waits on that gap row's "1 hidden" pin.
  markerAnchors: [{ markerKey: "doc", side: "additions", lineNumber: 9 }],
  responsibility: {
    kind: "changed-ranges",
    unitId: OWNED_UNIT_ID,
    revisionId: OWNED_REVISION,
    ownedSource: GAP_CHANGES.flatMap((at) => [
      {
        kind: "changed-lines" as const,
        hunkId: `h-gap-${at}`,
        side: "old" as const,
        sourceRevisionId: "b".repeat(40),
        startLine: at,
        lineCount: 1,
        lines: [gapOld[at - 1]!],
      },
      {
        kind: "changed-lines" as const,
        hunkId: `h-gap-${at}`,
        side: "new" as const,
        sourceRevisionId: OWNED_REVISION,
        startLine: at,
        lineCount: 1,
        lines: [gapNew[at - 1]!],
      },
    ]),
  },
}

/*
 * A 4,000-line file (review F6): owned change at L10, a sibling unit's at
 * L3000. Owned ranges stay small; Whole file is past WHOLE_FILE_VIRTUAL_ROWS
 * and renders through the desk's Virtualizer.
 */
const LONG_PATH = "apps/neuve-web/apps/web/src/server/long-module.ts"
const longOld = Array.from(
  { length: 4000 },
  (_, i) => `export const value${i + 1} = ${i + 1}`
)
const longNew = longOld.map((value, i) =>
  i + 1 === 10 || i + 1 === 3000 ? `${value} // changed` : value
)

export const longRangedFile: DiffFile = {
  path: LONG_PATH,
  oldContents: text(longOld),
  newContents: text(longNew),
  patch: replacementPatch(LONG_PATH, longOld, longNew, [10, 3000]),
  context: 0,
  additions: 1,
  deletions: 1,
  markerAnchors: [],
  responsibility: {
    kind: "changed-ranges",
    unitId: OWNED_UNIT_ID,
    revisionId: OWNED_REVISION,
    ownedSource: [
      {
        kind: "changed-lines",
        hunkId: "h-long-10",
        side: "old",
        sourceRevisionId: "b".repeat(40),
        startLine: 10,
        lineCount: 1,
        lines: [longOld[9]!],
      },
      {
        kind: "changed-lines",
        hunkId: "h-long-10",
        side: "new",
        sourceRevisionId: OWNED_REVISION,
        startLine: 10,
        lineCount: 1,
        lines: [longNew[9]!],
      },
    ],
    siblingSource: [
      {
        unitId: SIBLING_UNIT_ID,
        title: "Typed preparation failures and recovery messages",
        lane: "agentic-review",
        side: "old",
        startLine: 3000,
        lineCount: 1,
      },
      {
        unitId: SIBLING_UNIT_ID,
        title: "Typed preparation failures and recovery messages",
        lane: "agentic-review",
        side: "new",
        startLine: 3000,
        lineCount: 1,
      },
    ],
  },
}

/** The gap-sizes file under a long basename (narrow header checks, N2). */
const LONG_NAME_PATH =
  "apps/neuve-web/apps/web/src/server/unit-responsibility-projection-with-sibling-ownership.test.ts"
export const longNameRangedFile: DiffFile = {
  ...gapSizesFile,
  path: LONG_NAME_PATH,
  patch: replacementPatch(LONG_NAME_PATH, gapOld, gapNew, GAP_CHANGES),
}

/*
 * A stretch that ends on another unit's removal-only run: owned one-line
 * replacements at old L3 and old L22 (new L19), and between them 15
 * unchanged lines (L4–18) and the other unit's removal of old L19–21. Its
 * gap row's last press opens the removed lines, which have no new number.
 * Built from the retained patch, as live data is.
 */
const REMOVAL_PATH = "apps/neuve-web/apps/web/src/server/retry-notice.ts"
const removalOld = Array.from(
  { length: 30 },
  (_, i) => `const notice${i + 1} = retryNotice(${i + 1})`
)
const removalNew = [
  ...removalOld.slice(0, 2),
  `${removalOld[2]} // owned`,
  ...removalOld.slice(3, 18),
  `${removalOld[21]} // owned`,
  ...removalOld.slice(22),
]
const REMOVAL_SIBLING = {
  unitId: SIBLING_UNIT_ID,
  title: "Typed preparation failures and recovery messages",
  lane: "agentic-review" as const,
}

export const removalEndRangedFile: DiffFile = {
  path: REMOVAL_PATH,
  oldContents: text(removalOld),
  newContents: text(removalNew),
  patch: [
    `diff --git a/${REMOVAL_PATH} b/${REMOVAL_PATH}`,
    `--- a/${REMOVAL_PATH}`,
    `+++ b/${REMOVAL_PATH}`,
    "@@ -3,1 +3,1 @@",
    `-${removalOld[2]}`,
    `+${removalNew[2]}`,
    // Unified-diff headers: an empty side names the line before it.
    "@@ -19,3 +18,0 @@",
    ...removalOld.slice(18, 21).map((removed) => `-${removed}`),
    "@@ -22,1 +19,1 @@",
    `-${removalOld[21]}`,
    `+${removalNew[18]}`,
    "",
  ].join("\n"),
  context: 0,
  additions: 2,
  deletions: 5,
  markerAnchors: [],
  responsibility: {
    kind: "changed-ranges",
    unitId: OWNED_UNIT_ID,
    revisionId: OWNED_REVISION,
    ownedSource: [
      { old: 3, new: 3 },
      { old: 22, new: 19 },
    ].flatMap((at) => [
      {
        kind: "changed-lines" as const,
        hunkId: `h-removal-${at.old}`,
        side: "old" as const,
        sourceRevisionId: "b".repeat(40),
        startLine: at.old,
        lineCount: 1,
        lines: [removalOld[at.old - 1]!],
      },
      {
        kind: "changed-lines" as const,
        hunkId: `h-removal-${at.old}`,
        side: "new" as const,
        sourceRevisionId: OWNED_REVISION,
        startLine: at.new,
        lineCount: 1,
        lines: [removalNew[at.new - 1]!],
      },
    ]),
    siblingSource: [
      { ...REMOVAL_SIBLING, side: "old", startLine: 19, lineCount: 3 },
    ],
  },
}

/** The same changes reviewed whole (no ranges): Pierre's own separators. */
const PLAIN_GAPS_PATH = "apps/neuve-web/apps/web/src/components/plain-gaps.ts"
export const plainGapsFile: DiffFile = {
  path: PLAIN_GAPS_PATH,
  oldContents: text(gapOld),
  newContents: text(gapNew),
  patch: replacementPatch(PLAIN_GAPS_PATH, gapOld, gapNew, GAP_CHANGES),
  context: 0,
  additions: GAP_CHANGES.length,
  deletions: GAP_CHANGES.length,
  markerAnchors: [],
}

/** The owner's InteractionManager.ts case at real volume, for this unit. */
export const crowdedRangedFile: DiffFile = crowdedRangedFileFor({
  unitId: OWNED_UNIT_ID,
  revision: OWNED_REVISION,
  path: "apps/neuve-web/packages/diffs/src/managers/InteractionManager.ts",
  owners: [
    {
      unitId: "centralize-line-eligibility",
      title: "Centralize line eligibility and contiguous endpoint clamping",
      lane: "human-required",
    },
    {
      unitId: "clamp-gutter-utility",
      title: "Clamp gutter utility gesture commits to commentable lines",
      lane: "human-required",
    },
    {
      unitId: "clamp-pointer-touch",
      title: "Clamp pointer and touch selection updates",
      lane: "human-required",
    },
    {
      unitId: "track-predicate-presence",
      title:
        "Track predicate presence and initialize the eligibility callback ref",
      lane: "human-suggested",
    },
    {
      unitId: "bridge-selection-points",
      title: "Bridge renderer selection points to desk comment eligibility",
      lane: "agentic-review",
    },
    {
      unitId: "include-eligibility-sync",
      title: "Include eligibility in committed callback synchronization",
      lane: "agentic-review",
    },
  ],
  markerAnchors: [
    { markerKey: "conflict", side: "additions", lineNumber: 254 },
    // On another unit's lines (L603): waits on its gap row's pin.
    { markerKey: "test", side: "additions", lineNumber: 603 },
  ],
})
