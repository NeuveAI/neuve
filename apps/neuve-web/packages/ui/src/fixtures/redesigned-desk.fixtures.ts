/**
 * The review desk on a redesigned review, built like the owner's batch of
 * 14 November (`desk-evidence/owner-batch/show.json`, batch "Share low-risk
 * reads"): units named by code from their file and symbols, each section
 * titled "<symbol> in <file>", Facts written by code, and the depth content
 * the readers lane restores: Guided rows on every unit, an agent's review
 * message ("Checked: …") on units an agent decided, a suggested review only
 * on human-required units an agent decided, and, on units no agent decided,
 * the Lane review's notes on what it was unsure of. Shaped as the BFF's
 * projection gives them; controlled UI data, no retained review authority.
 */
import { REVIEWER } from "./review-batch.fixtures"
import { rangedFile } from "./lanes-desk.fixtures"
import { LANES_REVISION, R1 } from "./lanes-scenario.fixtures"
import type {
  DeliveryCheckpoint,
  DeliveryCriterion,
  DeliveryPayload,
} from "../neuve/shared/delivery"
import {
  MARKER_KIND_LABEL,
  citationName,
  linesName,
} from "../neuve/citation-name"
import type {
  BatchUnit,
  BriefingSection,
  BriefingSegment,
  ContextualMarker,
  ElsewhereLane,
  ExplainedText,
  RailUnit,
  ReviewDeskData,
  ReviewLane,
} from "../neuve/types"

const BATCH_TITLE = "Share low-risk reads"
const PROJECTS_PATH = "apps/neuve-host/src/projects.ts"
const RECORDS_PATH = "apps/neuve-web/apps/web/src/server/records.server.ts"
const RECORDS_TEST_PATH = "apps/neuve-host/tests/records-shared.test.ts"

const text = (value: string): Array<BriefingSegment> => [
  { kind: "text", text: value },
]

/* ── The batch's units ─────────────────────────────────── */

const CHECKOUT = {
  id: "01M7C5G7NR000D79S1ZJCY4X9A",
  title: "projects.ts: checkout",
}
const LOCATE = {
  id: "01M7C5G7NR000D79S1ZJCY4X9B",
  title: "records.server.ts: locate and 1 more",
}
const PROBE = {
  id: "01M7C5G7NR000D79S1ZJCY4X9C",
  title: "projects.ts: probeCache",
}
const PROJECTS_SUGGESTED = {
  id: "01M7C5G7NR000D79S1ZJCY4X9D",
  title: "projects.ts: imports and 2 more",
}
const RECORDS_SUGGESTED = {
  id: "01M7C5G7NR000D79S1ZJCY4X9E",
  title: "records.server.ts: imports and 1 more",
}
const PACKAGE = {
  id: "01M7C5G7NR000D79S1ZJCY4X9F",
  title: "package.json: line 20",
}
const PROJECTS_TEST = {
  id: "01M7C5G7NR000D79S1ZJCY4X9G",
  title: "projects-shared.test.ts: imports and 4 more",
}
const RECORDS_TEST = {
  id: "01M7C5G7NR000D79S1ZJCY4X9H",
  title: "records-shared.test.ts: imports and 1 more",
}

/** "Needs your decision", in the batch's order. */
const RAIL_UNITS: Array<RailUnit> = [
  { ...CHECKOUT, hunkCount: 1, noAgentDecision: true },
  { ...LOCATE, hunkCount: 2, noAgentDecision: true },
  { ...PROBE, hunkCount: 1 },
]

const agentApproved = { reviewer: R1, verdict: "approved" as const }

const ELSEWHERE: Array<ElsewhereLane> = [
  {
    lane: "human-suggested",
    label: "Human-suggested",
    count: 3,
    units: [
      { ...PACKAGE, result: "agent ✓", review: agentApproved },
      { ...PROJECTS_SUGGESTED, result: "agent ✓", review: agentApproved },
      { ...RECORDS_SUGGESTED, result: "agent ✓", review: agentApproved },
    ],
  },
  {
    lane: "agentic-review",
    label: "Agentic review",
    count: 2,
    units: [
      { ...PROJECTS_TEST, result: "agent ✓", review: agentApproved },
      { ...RECORDS_TEST, result: "agent ✓", review: agentApproved },
    ],
  },
  { lane: "static-automation", label: "Static automation", count: 0 },
]

const BATCH_UNITS: Array<BatchUnit> = [
  ...RAIL_UNITS.map(({ id, title }) => ({
    id,
    title,
    lane: "human-required" as const,
  })),
  ...ELSEWHERE.flatMap(({ lane, units = [] }) =>
    units.map(({ id, title }) => ({ id, title, lane }))
  ),
]

/* ── The files ─────────────────────────────────────────── */

const PROJECTS_OLD = [
  'import { gitProbe } from "./git"',
  'import type { Project } from "./types"',
  "",
  "const cache = new Map<string, Project>()",
  "",
  "/** Opens the project at a folder, checking it out when it is cold. */",
  "export async function checkout(folder: string): Promise<Project> {",
  "  const cached = cache.get(folder)",
  "  if (cached) return cached",
  "  const head = await gitProbe(folder)",
  "  const project = { folder, head }",
  "  cache.set(folder, project)",
  "  return project",
  "}",
  "",
  "/** Whether a folder's probe result can be reused. */",
  "export function probeCache(folder: string): boolean {",
  "  return cache.has(folder)",
  "}",
]

/** The lane words a title of a file with more than one unit leaves out. */
const LANE_WORDS: Record<ReviewLane, string> = {
  "human-required": "human required",
  "human-suggested": "human suggested",
  "agentic-review": "agentic",
  "static-automation": "static automation",
}

/** A sibling of projects.ts: every one shares the file, so keeps its lane words. */
const owner = (unit: { id: string; title: string }, lane: ReviewLane) => ({
  unitId: unit.id,
  title: unit.title,
  lane,
  laneWords: LANE_WORDS[lane],
})

/** projects.ts as the unit `self` owns its change: the others' stay theirs. */
const projectsFile = (self: "checkout" | "probe") =>
  rangedFile({
    path: PROJECTS_PATH,
    unitId: self === "checkout" ? CHECKOUT.id : PROBE.id,
    old: PROJECTS_OLD,
    changes: [
      {
        at: 3,
        remove: 0,
        add: [
          'import { sharedWork } from "@neuve/shared-work"',
          "",
          "const shared = sharedWork<Project>()",
        ],
        owner: owner(PROJECTS_SUGGESTED, "human-suggested"),
      },
      {
        at: 10,
        remove: 3,
        add: [
          "  const project = await shared.run(`checkout:${folder}`, async () => {",
          "    const head = await gitProbe(folder)",
          "    return { folder, head }",
          "  })",
          "  if (project.head !== null) cache.set(folder, project)",
        ],
        owner:
          self === "checkout" ? "owned" : owner(CHECKOUT, "human-required"),
      },
      {
        at: 18,
        remove: 1,
        add: [
          "  const entry = cache.get(folder)",
          "  return entry !== undefined && entry.head !== null",
        ],
        owner: self === "probe" ? "owned" : owner(PROBE, "human-required"),
      },
    ],
  })

const RECORDS_OLD = [
  'import { openRecords } from "@neuve/records-core"',
  'import type { Store } from "@neuve/records-core"',
  "",
  "/** Finds the store for a repository folder. */",
  "export async function locate(folder: string): Promise<string> {",
  "  const root = await findGitRoot(folder)",
  '  return join(root, ".neuve", "records.sqlite")',
  "}",
  "",
  "/** Opens the store for a repository folder. */",
  "export async function openStore(folder: string): Promise<Store> {",
  "  return openRecords(await locate(folder))",
  "}",
]

const LOCATE_SECTIONS = [
  { id: "locate", title: "locate in records.server.ts" },
  { id: "open-store", title: "openStore in records.server.ts" },
]

const recordsFile = rangedFile({
  path: RECORDS_PATH,
  unitId: LOCATE.id,
  old: RECORDS_OLD,
  sections: LOCATE_SECTIONS,
  changes: [
    {
      at: 6,
      remove: 1,
      add: [
        "  const root = await shared.run(`locate:${folder}`, () => findGitRoot(folder))",
        "  if (root === null) throw new StoreNotFound(folder)",
      ],
      owner: "owned",
      section: "locate",
    },
    {
      at: 12,
      remove: 1,
      add: [
        "  const path = await locate(folder)",
        "  return stores.get(path) ?? stores.set(path, openRecords(path)).get(path)!",
      ],
      owner: "owned",
      section: "open-store",
    },
  ],
})

const RECORDS_TEST_SECTIONS = [
  { id: "imports", title: "imports in records-shared.test.ts" },
  {
    id: "cold-locations",
    title:
      '"cold store locations share Git discovery and failed discovery is not cached" in records-shared.test.ts',
  },
]

const recordsTestFile = rangedFile({
  path: RECORDS_TEST_PATH,
  unitId: RECORDS_TEST.id,
  old: ['import { expect, test } from "bun:test"', ""],
  sections: RECORDS_TEST_SECTIONS,
  changes: [
    {
      at: 2,
      remove: 0,
      add: ['import { locate } from "../src/records"'],
      owner: "owned",
      section: "imports",
    },
    {
      at: 3,
      remove: 0,
      add: [
        'test("cold store locations share Git discovery and failed discovery is not cached", async () => {',
        "  const [a, b] = await Promise.all([locate(dir), locate(dir)])",
        "  expect(a).toBe(b)",
        "  expect(discoveries()).toBe(1)",
        "})",
      ],
      owner: "owned",
      section: "cold-locations",
    },
  ],
})

/* ── Guided ────────────────────────────────────────────── */

/** The sentences code writes for each status (readers lane, design 1). */
const DOES = {
  met: "The Lane review found this met for this file.",
  "not-met": "The Lane review found this not met in this file.",
  "no-evidence":
    "No verified finding establishes this condition's outcome for this unit.",
} as const

const row = (
  id: string,
  criterion: string,
  status: keyof typeof DOES
): DeliveryCriterion => ({
  id,
  criterion,
  status,
  does: DOES[status],
  evidence: [],
})

/**
 * The unit's requirements from Assess: no stored field ties one to a row,
 * so they are all at the card's foot (11.23).
 */
const CHECKPOINTS: Array<DeliveryCheckpoint> = [
  {
    number: 1,
    requirement:
      "Workspace dependencies, imports and remaining references resolve in all affected builds",
    proof: "missing",
    note: "Nothing names what proves it.",
    unmet: true,
  },
  {
    number: 2,
    requirement: "Concurrent callers of one key share one run",
    proof: "thin",
    note: "One kind of proof alone: a test run; not recorded: logs.",
    unmet: false,
  },
]

const guided = (
  criteria: Array<DeliveryCriterion>,
  suggestion?: NonNullable<DeliveryPayload["check"]>["suggestion"]
): NonNullable<DeliveryPayload["check"]> => ({
  ticket: { title: BATCH_TITLE },
  basis: "done-when",
  criteria,
  checkpoints: CHECKPOINTS,
  ...(suggestion ? { suggestion } : {}),
})

/* ── The desks ─────────────────────────────────────────── */

const baseDesk = {
  repo: "neuve",
  branch: "main~6..main",
  revision: LANES_REVISION,
  reviewer: REVIEWER,
  cycle: 1,
  batchTitle: BATCH_TITLE,
  railUnits: RAIL_UNITS,
  elsewhere: ELSEWHERE,
  batchUnits: BATCH_UNITS,
  agents: { agents: [], configured: [], connections: {} },
  markers: {},
  humanRequiredTotal: RAIL_UNITS.length,
  humanDecidedUnitIds: [],
} satisfies Omit<ReviewDeskData, "unit" | "files">

const unitFrame = {
  defaultAttachment: "",
  draftSuggestion: "",
} as const

/** A section of a joined unit: its Briefed claim and its Facts by code. */
const sectionOf = (
  section: { id: string; title: string },
  briefed: string,
  facts: string,
  extra: Partial<BriefingSection> = {}
): BriefingSection => ({
  id: section.id,
  title: section.title,
  briefing: text(briefed),
  facts: text(facts),
  ...extra,
})

const CHECKOUT_FACTS = "checkout in projects.ts: 5 lines added and 3 removed."

/** What the Lane review was unsure of on the checkout, its title dropped. */
export const CHECKOUT_NOTE =
  "Whether an empty probe result reaches the next caller is decided by shared.run, outside the owned lines."

/**
 * A human-required unit no agent decided, one section: its one note sits
 * under "No agent decision in this run" as one sentence.
 */
export const unsureOneNoteDeskFixture: ReviewDeskData = {
  ...baseDesk,
  unit: {
    ...unitFrame,
    ...CHECKOUT,
    lane: "human-required",
    noAgentDecision: true,
    undecidedNotes: [CHECKOUT_NOTE],
    position: { index: 1, of: RAIL_UNITS.length },
    briefing: text(CHECKOUT_FACTS),
    stats: "1 file · 1 hunk · 0 markers",
    hunkCount: 1,
    scopeNote: `Only this unit’s owned lines in ${PROJECTS_PATH}.`,
  },
  files: [projectsFile("checkout")],
  delivery: {
    stops: ["facts", "guided"],
    facts: text(CHECKOUT_FACTS),
    check: guided([
      row(
        "b1.r1",
        "Concurrent cold checkouts of one folder run one Git probe",
        "met"
      ),
      row(
        "b1.r2",
        "An empty folder's probe result is not cached",
        "no-evidence"
      ),
    ]),
  },
}

/** The notes on the two sections of "locate", each led by its section's title. */
export const LOCATE_NOTES = [
  `${LOCATE_SECTIONS[0]!.title}: Whether StoreNotFound reaches callers that expect a path is not in the owned lines.`,
  `${LOCATE_SECTIONS[1]!.title}: The stores map is shared across workspaces, and the change does not say whether that is intended.`,
]

/**
 * A human-required unit of two sections no agent decided: its two notes are
 * a plain list under "No agent decision in this run", each led by its
 * section's title.
 */
export const unsureTwoNotesDeskFixture: ReviewDeskData = {
  ...baseDesk,
  unit: {
    ...unitFrame,
    ...LOCATE,
    lane: "human-required",
    noAgentDecision: true,
    undecidedNotes: LOCATE_NOTES,
    position: { index: 2, of: RAIL_UNITS.length },
    briefing: text(
      "records.server.ts at lines 6 and 12: 4 lines added and 2 removed."
    ),
    sections: [
      sectionOf(
        LOCATE_SECTIONS[0]!,
        "Callers locating one folder's store share one Git discovery; a folder with no repository now throws StoreNotFound.",
        "locate in records.server.ts: 2 lines added and 1 removed."
      ),
      sectionOf(
        LOCATE_SECTIONS[1]!,
        "openStore keeps one open store per path and hands it to every later caller.",
        "openStore in records.server.ts: 2 lines added and 1 removed."
      ),
    ],
    stats: "1 file · 2 hunks · 0 markers",
    hunkCount: 2,
    scopeNote: `Only this unit’s owned lines in ${RECORDS_PATH}.`,
  },
  files: [recordsFile],
  delivery: {
    stops: ["facts", "briefed", "guided"],
    facts: text(
      "records.server.ts at lines 6 and 12: 4 lines added and 2 removed."
    ),
    check: guided([
      row(
        "b1.r3",
        "Concurrent callers locating one folder run one Git discovery",
        "met"
      ),
      row(
        "b1.r4",
        "A failed discovery is not cached; the next caller retries",
        "no-evidence"
      ),
    ]),
  },
}

const PROBE_FACTS = "probeCache in projects.ts: 2 lines added and 1 removed."

/** The agent's review message: what it checked, then code's sentence. */
const PROBE_MESSAGE =
  "Checked: probeCache reuses only entries with a head; an empty folder is probed again.\n\nThis request for changes rests on 2 confirmed defects."

/**
 * A human-required unit an agent decided: Guided rows met, not met and with
 * no evidence, the unit's checkpoints at the card's foot, and the suggested
 * review the dock offers at Guided. No review card: human-required work has
 * none.
 */
export const humanRequiredDecidedDeskFixture: ReviewDeskData = {
  ...baseDesk,
  unit: {
    ...unitFrame,
    ...PROBE,
    lane: "human-required",
    position: { index: 3, of: RAIL_UNITS.length },
    briefing: text(PROBE_FACTS),
    stats: "1 file · 1 hunk · 0 markers",
    hunkCount: 1,
    scopeNote: `Only this unit’s owned lines in ${PROJECTS_PATH}.`,
  },
  files: [projectsFile("probe")],
  delivery: {
    stops: ["facts", "guided"],
    facts: text(PROBE_FACTS),
    check: guided(
      [
        row(
          "b1.r5",
          "A cached folder whose probe found a head is reused",
          "met"
        ),
        row(
          "b1.r6",
          "An empty folder is probed again on the next call",
          "not-met"
        ),
        row(
          "b1.r7",
          "A probe that throws leaves nothing cached",
          "no-evidence"
        ),
      ],
      { decision: "request_changes", message: PROBE_MESSAGE }
    ),
  },
}

/** The agent's review message on the agentic unit: what it checked. */
export const AGENTIC_MESSAGE =
  "Checked: two cold callers share one discovery; a failed discovery is retried, not cached."

/**
 * An agentic unit an agent decided: its review card says what the agent
 * checked ("Checked: …"), never the proof line a redesigned disposition
 * note opens with.
 */
export const agenticCheckedDeskFixture: ReviewDeskData = {
  ...baseDesk,
  unit: {
    ...unitFrame,
    ...RECORDS_TEST,
    lane: "agentic-review",
    position: { index: 2, of: 2 },
    briefing: text("records-shared.test.ts at lines 2 and 3: 6 lines added."),
    sections: [
      sectionOf(
        RECORDS_TEST_SECTIONS[0]!,
        "The test imports locate from the host's records module.",
        "imports in records-shared.test.ts: 1 line added."
      ),
      sectionOf(
        RECORDS_TEST_SECTIONS[1]!,
        "Two concurrent cold callers get one path and one discovery between them.",
        `${RECORDS_TEST_SECTIONS[1]!.title}: 5 lines added.`
      ),
    ],
    stats: "1 file · 2 hunks · 0 markers",
    hunkCount: 2,
    scopeNote: `Only this unit’s owned lines in ${RECORDS_TEST_PATH}.`,
    attribution: {
      headline: "Agent approved",
      meta: `agentic review · ${LANES_REVISION}`,
      summary: AGENTIC_MESSAGE,
      outcome: "approved",
      reviewer: R1,
    },
  },
  files: [recordsTestFile],
  delivery: {
    stops: ["facts", "briefed", "guided"],
    facts: text("records-shared.test.ts at lines 2 and 3: 6 lines added."),
    check: {
      ticket: { title: BATCH_TITLE },
      basis: "done-when",
      criteria: [
        row(
          "b1.r3",
          "Concurrent callers locating one folder run one Git discovery",
          "met"
        ),
        row(
          "b1.r4",
          "A failed discovery is not cached; the next caller retries",
          "met"
        ),
      ],
    },
  },
}

/* ── Guided rows without proof, and the agent's readings ───
 * The readers lane marks a row whose file has no proof record (no test run
 * or static check recorded) as Missing, and writes the agent's reading of
 * the changed code against it: plain words and their own cites. Its
 * sentences for `does`, by state, are code's (readers lane, row proof). The
 * rows and readings below are the owner's re-run of "Share low-risk reads"
 * (`readers-probe/owner-rerun/out-3/show.json`).
 */

/** Code's `does` for a row in each proof state. */
export const PROOF_DOES = {
  answeredMissing:
    "No test run or other proof is recorded for this condition, so it can't be shown met.",
  unansweredMissing:
    "No reading of this file established this condition's outcome, and no test run or other proof is recorded for it.",
  unansweredProven:
    "No reading of this file established this condition's outcome.",
} as const

/** The three scope items every unit of the re-run is read against. */
const SCOPE_ROWS = {
  D1: "The change's low-risk reads, hashes and discovery use the shared-work helper rather than independently repeating equivalent work (S13.1).",
  D2: "Requests sharing an idempotency key execute the underlying work once, including when more than one caller asks for it (S3.4, decision 0016).",
  D3: "Every caller of that shared request subscribes to its response; sharing work does not leave subsequent callers without the result (S3.4, decision 0016).",
} as const

/** checkout's owned lines in projects.ts, as a source pin that opens them. */
const CHECKOUT_LINES = {
  kind: "source",
  label: "Source",
  target: "lines 13–17",
  excerpt: [
    "  const project = await shared.run(`checkout:${folder}`, async () => {",
    "    const head = await gitProbe(folder)",
    "    return { folder, head }",
    "  })",
    "  if (project.head !== null) cache.set(folder, project)",
  ],
} satisfies DeliveryCriterion["evidence"][number]

/** The agent's readings of checkout against each scope item. */
export const CHECKOUT_READINGS = [
  "Cold checkout probes now run inside SharedWork; successful committed checkouts retain their completed cache.",
  "One module-level helper partitions concurrent checkout work by path; the producer rechecks the completed cache before probing.",
  "Each cold caller awaits run and returns its outcome value or throws its failure, rather than only starting a producer.",
] as const

/** A Guided card read against the re-run's scope. */
const scopeCheck = (
  criteria: Array<DeliveryCriterion>
): NonNullable<DeliveryPayload["check"]> => ({
  ticket: { title: BATCH_TITLE },
  basis: "scope",
  criteria,
})

/**
 * The owner's case: every row of the checkout has no proof recorded, so
 * each is Missing, says it can't be shown met, and carries what the agent
 * read in the changed lines, citing the lines its row cites.
 */
export const guidedAllMissingDeskFixture: ReviewDeskData = {
  ...baseDesk,
  unit: {
    ...unitFrame,
    ...CHECKOUT,
    lane: "human-required",
    position: { index: 1, of: RAIL_UNITS.length },
    briefing: text(CHECKOUT_FACTS),
    stats: "1 file · 1 hunk · 0 markers",
    hunkCount: 1,
    scopeNote: `Only this unit’s owned lines in ${PROJECTS_PATH}.`,
  },
  files: [projectsFile("checkout")],
  delivery: {
    stops: ["facts", "guided"],
    facts: text(CHECKOUT_FACTS),
    check: scopeCheck(
      (["D1", "D2", "D3"] as const).map((id, i) => ({
        id,
        criterion: SCOPE_ROWS[id],
        status: "no-evidence",
        does: PROOF_DOES.answeredMissing,
        evidence: [CHECKOUT_LINES],
        proofState: "missing",
        reading: { text: CHECKOUT_READINGS[i]!, cites: [CHECKOUT_LINES] },
      }))
    ),
  },
}

/** probeCache's owned lines in projects.ts. */
const PROBE_LINES = {
  kind: "source",
  label: "Source",
  target: "lines 21–22",
  excerpt: [
    "  const entry = cache.get(folder)",
    "  return entry !== undefined && entry.head !== null",
  ],
} satisfies DeliveryCriterion["evidence"][number]

export const PROBE_READING =
  "probeCache reuses only entries with a head; an empty folder is probed again."

/**
 * A file with no proof recorded: one row the review answered, with the
 * agent's reading, and one it left unanswered, with no reading. Both are
 * Missing.
 */
export const guidedUnansweredMissingDeskFixture: ReviewDeskData = {
  ...humanRequiredDecidedDeskFixture,
  delivery: {
    stops: ["facts", "guided"],
    facts: text(PROBE_FACTS),
    check: scopeCheck([
      {
        id: "D1",
        criterion: SCOPE_ROWS.D1,
        status: "no-evidence",
        does: PROOF_DOES.answeredMissing,
        evidence: [PROBE_LINES],
        proofState: "missing",
        reading: { text: PROBE_READING, cites: [PROBE_LINES] },
      },
      {
        id: "D3",
        criterion: SCOPE_ROWS.D3,
        status: "no-evidence",
        does: PROOF_DOES.unansweredMissing,
        evidence: [],
        proofState: "missing",
      },
    ]),
  },
}

/** The test's lines in records-shared.test.ts. */
const RECORDS_TEST_LINES = {
  kind: "source",
  label: "Source",
  target: "lines 3–7",
  excerpt: [
    'test("cold store locations share Git discovery and failed discovery is not cached", async () => {',
    "  const [a, b] = await Promise.all([locate(dir), locate(dir)])",
    "  expect(a).toBe(b)",
    "  expect(discoveries()).toBe(1)",
    "})",
  ],
} satisfies DeliveryCriterion["evidence"][number]

/** The import the reading of the not-met row also cites. */
const RECORDS_TEST_IMPORT = {
  kind: "source",
  label: "Source",
  target: "line 2",
  excerpt: ['import { locate } from "../src/records"'],
} satisfies DeliveryCriterion["evidence"][number]

export const RECORDS_TEST_READINGS = {
  unanswered:
    "Exercises actual store discovery through readRecords and counts Git common-directory launches.",
  notMet:
    "Both concurrent callers get one location from one discovery; no caller asks again after a failed discovery.",
} as const

/**
 * A test file whose run is recorded, so no row is Missing: one row the
 * review left unanswered, with the agent's reading, and one not met, whose
 * reading cites lines its evidence doesn't.
 */
export const guidedProofRecordedDeskFixture: ReviewDeskData = {
  ...agenticCheckedDeskFixture,
  delivery: {
    stops: ["facts", "briefed", "guided"],
    facts: text("records-shared.test.ts at lines 2 and 3: 6 lines added."),
    check: scopeCheck([
      {
        id: "D1",
        criterion: SCOPE_ROWS.D1,
        status: "no-evidence",
        does: PROOF_DOES.unansweredProven,
        evidence: [],
        reading: {
          text: RECORDS_TEST_READINGS.unanswered,
          cites: [RECORDS_TEST_LINES],
        },
      },
      {
        id: "D3",
        criterion: SCOPE_ROWS.D3,
        status: "not-met",
        does: DOES["not-met"],
        evidence: [RECORDS_TEST_LINES],
        reading: {
          text: RECORDS_TEST_READINGS.notMet,
          cites: [RECORDS_TEST_LINES, RECORDS_TEST_IMPORT],
        },
      },
    ]),
  },
}

/* ── Briefed and Explained from the briefing step ──────────
 * The readers lane's briefing writes a Briefed where a change has no text
 * of its own and an Explained for every change it read, one plain sentence
 * a side for a trivial one (a one-line import). The projection hands a
 * unit of one change its change's Explained as the unit's, and shows a
 * unit of several as rows, one per change, only when each has its own.
 */

const PROJECTS_TEST_PATH = "apps/neuve-host/tests/projects-shared.test.ts"

const PROJECTS_TEST_SECTIONS = [
  { id: "imports-a", title: "imports in projects-shared.test.ts" },
  { id: "line-8", title: "projects-shared.test.ts at line 8" },
  { id: "imports-b", title: "imports in projects-shared.test.ts" },
  { id: "line-11", title: "projects-shared.test.ts at line 11" },
  {
    id: "cold",
    title:
      '"cold checkouts share Git probes, cache commits, and recheck empty folders" in projects-shared.test.ts',
  },
] as const

const projectsTestFile = rangedFile({
  path: PROJECTS_TEST_PATH,
  unitId: PROJECTS_TEST.id,
  old: [
    'import { expect, test } from "bun:test"',
    "",
    "const dir = tmpFolder()",
    "",
    "afterAll(() => rm(dir))",
    "",
  ],
  sections: [...PROJECTS_TEST_SECTIONS],
  changes: [
    {
      at: 2,
      remove: 0,
      add: [
        'import { checkout, probeCache } from "../src/projects"',
        'import { sharedWork } from "@neuve/shared-work"',
      ],
      owner: "owned",
      section: "imports-a",
    },
    {
      at: 3,
      remove: 0,
      add: [
        "const git = fakeGit()",
        'const probes = () => git.calls("rev-parse")',
      ],
      owner: "owned",
      section: "line-8",
    },
    {
      at: 4,
      remove: 0,
      add: ['import { tmpFolder } from "./helpers"'],
      owner: "owned",
      section: "imports-b",
    },
    {
      at: 5,
      remove: 0,
      add: ["beforeEach(() => git.reset())"],
      owner: "owned",
      section: "line-11",
    },
    {
      at: 6,
      remove: 0,
      add: [
        'test("cold checkouts share Git probes, cache commits, and recheck empty folders", async () => {',
        "  const [a, b] = await Promise.all([checkout(dir), checkout(dir)])",
        "  expect(a).toBe(b)",
        "  expect(probes()).toBe(1)",
        "  expect(probeCache(dir)).toBe(true)",
        "})",
      ],
      owner: "owned",
      section: "cold",
    },
  ],
})

/** The term two of its changes explain: the unit lists it once. */
const SHARED_WORK_TERM = {
  term: "sharedWork",
  meaning:
    "Runs one piece of work per key and hands its result to every caller that asks for the same key meanwhile.",
}

/**
 * Each change of "projects-shared.test.ts: imports and 4 more": the
 * briefing's Briefed, code's Facts, and the briefing's Explained. One
 * change ("at line 8") has only code's text for Briefed: it had text of its
 * own, so the briefing wrote none.
 */
const PROJECTS_TEST_CHANGES: ReadonlyArray<{
  briefed: string
  facts: string
  explained: ExplainedText
}> = [
  {
    briefed:
      "The test brings in checkout and probeCache with the shared-work helper they now run through.",
    facts: "imports in projects-shared.test.ts: 2 lines added.",
    explained: {
      before: "The test file imported only the test runner.",
      after:
        "It also imports checkout, probeCache and sharedWork, the helper both now run through.",
      terms: [SHARED_WORK_TERM],
    },
  },
  {
    briefed: "projects-shared.test.ts at line 8: 2 lines added.",
    facts: "projects-shared.test.ts at line 8: 2 lines added.",
    explained: {
      before: "There was no fake Git.",
      after: "A fake Git counts the probes the tests make.",
      terms: [],
    },
  },
  {
    briefed:
      "A temporary-folder helper joins the imports, so each test checks out a fresh folder.",
    facts: "imports in projects-shared.test.ts: 1 line added.",
    explained: {
      before: "The folder helper wasn't imported.",
      after: "The test imports tmpFolder from its helpers.",
      terms: [],
    },
  },
  {
    briefed: "Each test starts from a fake Git with no recorded calls.",
    facts: "projects-shared.test.ts at line 11: 1 line added.",
    explained: {
      before: "Calls a test made stayed for the next one.",
      after: "Every test starts with no recorded Git calls.",
      terms: [],
    },
  },
  {
    briefed:
      "Two cold checkouts of one folder now run one Git probe between them, and a folder whose probe found a head is cached.",
    facts:
      '"cold checkouts share Git probes, cache commits, and recheck empty folders" in projects-shared.test.ts: 6 lines added.',
    explained: {
      before:
        "Nothing tested two checkouts of one cold folder at once, so each could have probed Git on its own.",
      after:
        "Two checkouts started together get the same project and one Git probe between them, and probeCache then reports the folder cached.",
      terms: [
        SHARED_WORK_TERM,
        {
          term: "probeCache",
          meaning:
            "Whether a folder's probe result can be reused without asking Git again.",
        },
      ],
    },
  },
]

const PROJECTS_TEST_FACTS =
  "projects-shared.test.ts at lines 2 to 12: 12 lines added."

/** The briefing's After of each change, in the unit's order. */
export const PROJECTS_TEST_AFTERS = PROJECTS_TEST_CHANGES.map(
  (change) => change.explained.after
)

/** The briefing's Briefed of each change, in the unit's order. */
export const PROJECTS_TEST_BRIEFED = PROJECTS_TEST_CHANGES.map(
  (change) => change.briefed
)

/**
 * An agentic unit of five changes after the briefing step: each change's
 * Briefed in its row (four by the model, one with code's own text), and an
 * Explained for every change, so Explained shows as five rows and the
 * unit has none of its own. A term two changes share is listed once.
 */
export const briefedPerSectionDeskFixture: ReviewDeskData = {
  ...baseDesk,
  unit: {
    ...unitFrame,
    ...PROJECTS_TEST,
    lane: "agentic-review",
    position: { index: 1, of: 2 },
    briefing: [],
    sections: PROJECTS_TEST_SECTIONS.map((section, i) =>
      sectionOf(
        section,
        PROJECTS_TEST_CHANGES[i]!.briefed,
        PROJECTS_TEST_CHANGES[i]!.facts,
        { explained: PROJECTS_TEST_CHANGES[i]!.explained }
      )
    ),
    stats: "1 file · 5 hunks · 0 markers",
    hunkCount: 5,
    scopeNote: `Only this unit’s owned lines in ${PROJECTS_TEST_PATH}.`,
    attribution: {
      headline: "Agent approved",
      meta: `agentic review · ${LANES_REVISION}`,
      summary:
        "Checked: two cold checkouts share one probe, and an empty folder is probed again.",
      outcome: "approved",
      reviewer: R1,
    },
  },
  files: [projectsTestFile],
  delivery: {
    stops: ["facts", "briefed", "explained", "guided"],
    facts: text(PROJECTS_TEST_FACTS),
    check: {
      ticket: { title: BATCH_TITLE },
      basis: "done-when",
      criteria: [
        row(
          "b1.r1",
          "Concurrent cold checkouts of one folder run one Git probe",
          "met"
        ),
      ],
    },
  },
}

/** The checkout's Briefed and Explained, from the briefing step. */
export const CHECKOUT_BRIEFED =
  "Cold checkouts of one folder now share one Git probe through shared.run, and only a probe that found a head is cached."
export const CHECKOUT_EXPLAINED = {
  before:
    "Each cold checkout of a folder probed Git on its own and cached whatever it found, an empty result too.",
  after:
    "Checkouts of one folder that start together share one probe, and a folder whose probe found no head is probed again next time.",
  terms: [
    {
      term: "shared.run",
      meaning:
        "Starts the work for a key once; callers with the same key wait for that run's result.",
    },
  ],
}

/**
 * The checkout, a human-required unit of one change no agent decided,
 * after the briefing step: its change's Briefed and Explained are the
 * unit's, and its note stays under "No agent decision in this run".
 */
export const explainedOneSectionDeskFixture: ReviewDeskData = {
  ...unsureOneNoteDeskFixture,
  unit: {
    ...unsureOneNoteDeskFixture.unit,
    briefing: text(CHECKOUT_BRIEFED),
  },
  delivery: {
    ...unsureOneNoteDeskFixture.delivery!,
    stops: ["facts", "briefed", "explained", "guided"],
    explained: CHECKOUT_EXPLAINED,
  },
}

const RECORDS_SUGGESTED_SECTIONS = [
  { id: "imports", title: "imports in records.server.ts" },
  { id: "line-58", title: "records.server.ts at line 58" },
]

const recordsSuggestedFile = rangedFile({
  path: RECORDS_PATH,
  unitId: RECORDS_SUGGESTED.id,
  old: RECORDS_OLD,
  sections: RECORDS_SUGGESTED_SECTIONS,
  changes: [
    {
      at: 3,
      remove: 0,
      add: [
        'import { sharedWork } from "@neuve/shared-work"',
        'import { join } from "node:path"',
      ],
      owner: "owned",
      section: "imports",
    },
    {
      at: 9,
      remove: 0,
      add: [
        "const shared = sharedWork<string | null>()",
        "const stores = new Map<string, Store>()",
        "",
        "export class StoreNotFound extends Error {}",
      ],
      owner: "owned",
      section: "line-58",
    },
  ],
})

/**
 * What Records says when a unit's briefing failed (`briefing-failed`). The
 * readers lane writes the words; these stand in for them.
 */
export const BRIEFING_GAP_NOTE =
  "The briefing of records.server.ts: imports and 1 more couldn't be written in this run, so it shows what code wrote."

/** Code's own Briefed of the change at line 58: its Assess impact. */
export const LINE_58_CODE_BRIEFED =
  "The store map and the shared discovery are created once for the process."

/**
 * A briefing gap: the unit's briefing failed, so each change has only
 * code's text, one change a Briefed of its own (its Assess impact) and
 * none an Explained. Briefed shows code's text with the gap's line;
 * Explained is not offered; Facts keeps the gap's line too.
 */
export const briefingGapDeskFixture: ReviewDeskData = {
  ...baseDesk,
  unit: {
    ...unitFrame,
    ...RECORDS_SUGGESTED,
    lane: "human-suggested",
    position: { index: 3, of: 3 },
    briefing: text(BRIEFING_GAP_NOTE),
    briefingNotes: [BRIEFING_GAP_NOTE],
    sections: [
      sectionOf(
        RECORDS_SUGGESTED_SECTIONS[0]!,
        "imports in records.server.ts: 2 lines added.",
        "imports in records.server.ts: 2 lines added."
      ),
      sectionOf(
        RECORDS_SUGGESTED_SECTIONS[1]!,
        LINE_58_CODE_BRIEFED,
        "records.server.ts at line 58: 4 lines added."
      ),
    ],
    stats: "1 file · 2 hunks · 0 markers",
    hunkCount: 2,
    scopeNote: `Only this unit’s owned lines in ${RECORDS_PATH}.`,
    attribution: {
      headline: "Agent approved",
      meta: `human suggested · ${LANES_REVISION}`,
      summary: "Checked: the store map and the discovery are made once.",
      outcome: "approved",
      reviewer: R1,
    },
  },
  files: [recordsSuggestedFile],
  delivery: {
    stops: ["facts", "briefed", "guided"],
    facts: text("records.server.ts at lines 3 and 9: 6 lines added."),
    check: {
      ticket: { title: BATCH_TITLE },
      basis: "done-when",
      criteria: [
        row(
          "b1.r3",
          "Concurrent callers locating one folder run one Git discovery",
          "met"
        ),
      ],
    },
  },
}

/* ── Cited phrases and their markers ───────────────────────
 * The readers lane writes each change's Briefed and the unit's lead as
 * sentences whose phrases link the hunk where a claim can be seen. The
 * projection lands each phrase on its lines and puts after it the chip of
 * the first unmet checkpoint, conflict or same-batch pin over them (by
 * line); Explained's Before and After stay plain, and its "↳" line folds
 * the change's phrases. Segments here are what the projection gives for
 * text in that form.
 */

const LOCATE_LINES = { start: 6, end: 7, side: "additions" } as const
const OPEN_STORE_LINES = { start: 13, end: 14, side: "additions" } as const

const linesPhrase = (
  words: string,
  range: { start: number; end: number; side: "additions" }
): Extract<BriefingSegment, { kind: "phrase" }> => ({
  kind: "phrase",
  text: words,
  target: { kind: "lines", filePath: RECORDS_PATH, range },
})

/** A requirement Records holds no proof for, on locate's lines. */
export const LOCATE_REQUIREMENT =
  "A failed discovery is not cached; the next caller retries"
const LOCATE_CHECKPOINT_KEY = `checkpoint:${LOCATE.id}:1`
/** Code's same-batch reference on openStore's lines (readers' 3.5). */
const SAME_BATCH_KEY = "01M7C5G7NR000D79S1ZJCY4XSB"
const SAME_BATCH_TITLE = "checkout in projects.ts"

const locateCheckpoint: ContextualMarker = {
  key: LOCATE_CHECKPOINT_KEY,
  tone: "checkpoint",
  short: "Checkpoint",
  peek: LOCATE_REQUIREMENT,
  kindLabel: "Checkpoint",
  title: LOCATE_REQUIREMENT,
  meta: `${RECORDS_PATH} · ${linesName(LOCATE_LINES)}`,
  quote: LOCATE_REQUIREMENT,
  applies: "No test run or other proof is recorded for it.",
  checkpoint: {
    number: 1,
    requirement: LOCATE_REQUIREMENT,
    proof: "missing",
    note: "No test run or other proof is recorded for it.",
  },
  source: {
    kind: "Checkpoint",
    chips: [{ text: "Checkpoint", tone: "neutral" }],
    title: LOCATE_REQUIREMENT,
    subtitle: `${RECORDS_PATH} · ${linesName(LOCATE_LINES)}`,
    actions: [],
    facts: [],
    blocks: [],
    citedBy: ["This unit"],
  },
}

const sameBatchMarker: ContextualMarker = {
  key: SAME_BATCH_KEY,
  tone: "batch",
  short: "Same batch",
  peek: "checkout in projects.ts, changed in this range, calls openStore, which this change also changes.",
  kindLabel: "Same batch · unreviewed",
  title: SAME_BATCH_TITLE,
  meta: `${PROJECTS_PATH} · line 9`,
  quote: "  const store = await openStore(folder)",
  applies:
    "checkout in projects.ts, changed in this range, calls openStore, which this change also changes.",
  check:
    "Read both changes together: checkout in projects.ts is decided separately and is not yet approved.",
  sharedWith: [CHECKOUT.id],
  source: {
    kind: "Code",
    chips: [],
    title: SAME_BATCH_TITLE,
    subtitle: `${PROJECTS_PATH} · line 9`,
    path: PROJECTS_PATH,
    actions: [],
    facts: [],
    blocks: [],
    citedBy: ["This unit"],
  },
}

const chipOf = (marker: ContextualMarker): BriefingSegment => ({
  kind: "cite",
  label: MARKER_KIND_LABEL[marker.tone],
  markerKey: marker.key,
  ariaLabel: citationName(marker.tone, marker.title),
})

/** The unit's lead (its own Briefed), in the readers' form. */
export const CITED_LEAD = {
  locate: "share one Git discovery",
  openStore: "keeps one open store per path",
}
const citedLead: Array<BriefingSegment> = [
  { kind: "text", text: "Callers locating one folder’s store now " },
  linesPhrase(CITED_LEAD.locate, LOCATE_LINES),
  chipOf(locateCheckpoint),
  { kind: "text", text: ", and opening a store " },
  linesPhrase(CITED_LEAD.openStore, OPEN_STORE_LINES),
  chipOf(sameBatchMarker),
  {
    kind: "text",
    text: ", so every later caller in this batch gets the same one.",
  },
]

/** Each change's Briefed phrases, as its "↳" line shows them at Explained. */
export const CITED_PHRASES = {
  locate: ["run one Git discovery between them", "throws StoreNotFound"],
  openStore: [
    "gets the one open store for a path",
    "checkout, changed in this batch",
  ],
}

export const CITED_EXPLAINED = {
  locate: {
    before:
      "Each caller locating a store looked for the Git root on its own and returned a path even when none was found.",
    after:
      "Callers locating one folder at the same time share one look-up, and a folder with no repository throws StoreNotFound.",
    terms: [
      {
        term: "StoreNotFound",
        meaning: "The error a caller gets when a folder has no repository.",
      },
    ],
    // After linked "share one look-up" to locate's hunk: read as plain
    // words above, and handed to the change's "↳" line.
    links: [linesPhrase("share one look-up", LOCATE_LINES)],
  },
  openStore: {
    before: "Every call opened the store again.",
    after:
      "The first call opens the store for a path and every later call gets that one.",
    terms: [],
  },
} satisfies Record<string, ExplainedText>

/**
 * locate and openStore, a human-required unit of two changes after the
 * briefing step: the unit's own Briefed leads, its phrases linked to their
 * lines and followed by the chip of the pin over them (a missing
 * checkpoint, a same-batch reference); each change's Briefed is its row,
 * its phrases over those pins plain links (each chip is shown once), and
 * its phrase naming the same-batch reference followed by that chip; at
 * Explained, each change's Before and After with its phrases on a "↳"
 * line, as the briefing showed them before.
 */
export const citedLeadDeskFixture: ReviewDeskData = {
  ...baseDesk,
  markers: {
    [LOCATE_CHECKPOINT_KEY]: locateCheckpoint,
    [SAME_BATCH_KEY]: sameBatchMarker,
  },
  unit: {
    ...unitFrame,
    ...LOCATE,
    lane: "human-required",
    position: { index: 2, of: RAIL_UNITS.length },
    briefing: citedLead,
    sections: [
      {
        id: LOCATE_SECTIONS[0]!.id,
        title: LOCATE_SECTIONS[0]!.title,
        briefing: [
          { kind: "text", text: "Concurrent callers locating one folder " },
          // The lead has shown the checkpoint's chip: these stay plain links.
          linesPhrase(CITED_PHRASES.locate[0]!, LOCATE_LINES),
          {
            kind: "text",
            text: ", and a folder with no repository now ",
          },
          linesPhrase(CITED_PHRASES.locate[1]!, LOCATE_LINES),
          { kind: "text", text: " instead of returning a path." },
        ],
        facts: text(
          "locate in records.server.ts: 2 lines added and 1 removed."
        ),
        explained: CITED_EXPLAINED.locate,
      },
      {
        id: LOCATE_SECTIONS[1]!.id,
        title: LOCATE_SECTIONS[1]!.title,
        briefing: [
          { kind: "text", text: "Every caller " },
          linesPhrase(CITED_PHRASES.openStore[0]!, OPEN_STORE_LINES),
          { kind: "text", text: "; " },
          // A phrase citing the marker itself keeps its chip.
          {
            kind: "phrase",
            text: CITED_PHRASES.openStore[1]!,
            target: { kind: "marker", markerKey: SAME_BATCH_KEY },
          },
          chipOf(sameBatchMarker),
          { kind: "text", text: ", opens stores through it." },
        ],
        facts: text(
          "openStore in records.server.ts: 2 lines added and 1 removed."
        ),
        explained: CITED_EXPLAINED.openStore,
      },
    ],
    stats: "1 file · 2 hunks · 2 markers",
    hunkCount: 2,
    scopeNote: `Only this unit’s owned lines in ${RECORDS_PATH}.`,
  },
  files: [
    {
      ...recordsFile,
      markerAnchors: [
        {
          markerKey: LOCATE_CHECKPOINT_KEY,
          side: "additions",
          lineNumber: LOCATE_LINES.start,
          range: LOCATE_LINES,
        },
        {
          markerKey: SAME_BATCH_KEY,
          side: "additions",
          lineNumber: OPEN_STORE_LINES.start,
          range: OPEN_STORE_LINES,
        },
      ],
    },
  ],
  delivery: {
    stops: ["facts", "briefed", "explained", "guided"],
    facts: text(
      "records.server.ts at lines 6 and 13: 4 lines added and 2 removed."
    ),
    check: guided([
      row(
        "b1.r3",
        "Concurrent callers locating one folder run one Git discovery",
        "met"
      ),
      row(
        "b1.r4",
        "A failed discovery is not cached; the next caller retries",
        "no-evidence"
      ),
    ]),
  },
}

/* ── Each section's own verdict inside one unit ─────────────
 * One unit per file and lane: a human-required unit can hold changes an
 * agent decided beside one it couldn't. The readers lane writes each decided
 * change's verdict and its "Checked: …" words (plain, links read as their
 * phrases), and each undecided change's note, keyed to the change; the
 * unit's suggestion only when the decided changes' worst verdict requests
 * changes. Segments here are what the projection gives for them.
 */

const SHARED = {
  id: "01M7C5G7NR000D79S1ZJCY4X9J",
  title: "records.server.ts: imports and 2 more",
}

const SHARED_SECTIONS = [
  { id: "imports", title: "imports in records.server.ts" },
  { id: "locate", title: "locate in records.server.ts" },
  { id: "open-store", title: "openStore in records.server.ts" },
]

/** records.server.ts with the import its two functions now share. */
const sharedFile = rangedFile({
  path: RECORDS_PATH,
  unitId: SHARED.id,
  old: RECORDS_OLD,
  sections: SHARED_SECTIONS,
  changes: [
    {
      at: 3,
      remove: 0,
      add: ['import { sharedWork } from "@neuve/shared-work"'],
      owner: "owned",
      section: "imports",
    },
    {
      at: 6,
      remove: 1,
      add: [
        "  const root = await shared.run(`locate:${folder}`, () => findGitRoot(folder))",
        "  if (root === null) throw new StoreNotFound(folder)",
      ],
      owner: "owned",
      section: "locate",
    },
    {
      at: 12,
      remove: 1,
      add: [
        "  const path = await locate(folder)",
        "  return stores.get(path) ?? stores.set(path, openRecords(path)).get(path)!",
      ],
      owner: "owned",
      section: "open-store",
    },
  ],
})

/** What each change says, at Briefed and at Facts. */
const SHARED_CLAIMS = {
  imports: [
    "The module imports sharedWork from the shared-work package.",
    "imports in records.server.ts: 1 line added.",
  ],
  locate: [
    "Callers locating one folder's store share one Git discovery; a folder with no repository now throws StoreNotFound.",
    "locate in records.server.ts: 2 lines added and 1 removed.",
  ],
  openStore: [
    "openStore keeps one open store per path and hands it to every later caller.",
    "openStore in records.server.ts: 2 lines added and 1 removed.",
  ],
} as const

/** The agent's words for each change it decided ("Checked: …"). */
export const SECTION_MESSAGES = {
  imports:
    "Checked: the package is a workspace dependency of this app, so the import resolves in its build.",
  locate:
    "Checked: a folder with no repository now throws StoreNotFound, and the callers that expect a path are not changed with it.",
  openStore:
    "Checked: openStore keeps one store per path, and every later caller gets that store.",
} as const

/** Why no agent could decide the import, as its keyed note. */
export const IMPORTS_NOTE =
  "Whether the package is a dependency of this app is not in the owned lines."

/** The unit's suggestion: the decided changes' worst verdict, and their words. */
const SHARED_SUGGESTION =
  "Checked: a folder with no repository now throws StoreNotFound, and the callers that expect a path are not changed with it.\n\nChecked: openStore keeps one store per path, and every later caller gets that store."

const SHARED_FACTS =
  "records.server.ts at lines 3, 7 and 14: 5 lines added and 2 removed."

/** The batch's "Needs your decision" with this unit last. */
const SHARED_RAIL: Array<RailUnit> = [
  ...RAIL_UNITS,
  { ...SHARED, hunkCount: 3 },
]

/**
 * A desk on the shared-store unit, its changes as given: undecided ones
 * with their notes, decided ones with their suggestions, and the unit's
 * suggestion only when one is written.
 */
const sharedDesk = (
  imports: Partial<BriefingSection>,
  locate: Partial<BriefingSection>,
  openStore: Partial<BriefingSection>,
  suggestion?: NonNullable<DeliveryPayload["check"]>["suggestion"]
): ReviewDeskData => ({
  ...baseDesk,
  railUnits: SHARED_RAIL,
  humanRequiredTotal: SHARED_RAIL.length,
  batchUnits: [
    ...BATCH_UNITS,
    { id: SHARED.id, title: SHARED.title, lane: "human-required" },
  ],
  unit: {
    ...unitFrame,
    ...SHARED,
    lane: "human-required",
    position: { index: SHARED_RAIL.length, of: SHARED_RAIL.length },
    briefing: text(
      "locate and openStore now share one Git discovery and one open store per folder."
    ),
    sections: [
      sectionOf(
        SHARED_SECTIONS[0]!,
        SHARED_CLAIMS.imports[0],
        SHARED_CLAIMS.imports[1],
        imports
      ),
      sectionOf(
        SHARED_SECTIONS[1]!,
        SHARED_CLAIMS.locate[0],
        SHARED_CLAIMS.locate[1],
        locate
      ),
      sectionOf(
        SHARED_SECTIONS[2]!,
        SHARED_CLAIMS.openStore[0],
        SHARED_CLAIMS.openStore[1],
        openStore
      ),
    ],
    stats: "1 file · 3 hunks · 0 markers",
    hunkCount: 3,
    scopeNote: `Only this unit’s owned lines in ${RECORDS_PATH}.`,
  },
  files: [sharedFile],
  delivery: {
    stops: ["facts", "briefed", "guided"],
    facts: text(SHARED_FACTS),
    check: guided(
      [
        row(
          "b1.r3",
          "Concurrent callers locating one folder run one Git discovery",
          "met"
        ),
        row(
          "b1.r8",
          "Callers that expect a path handle a folder with no repository",
          "not-met"
        ),
      ],
      suggestion
    ),
  },
})

const undecidedImports: Partial<BriefingSection> = {
  noAgentDecision: true,
  undecidedNotes: [IMPORTS_NOTE],
}
const locateRequests: Partial<BriefingSection> = {
  suggestion: {
    decision: "request_changes",
    message: text(SECTION_MESSAGES.locate),
  },
}
const openStoreApproves: Partial<BriefingSection> = {
  suggestion: {
    decision: "approve",
    message: text(SECTION_MESSAGES.openStore),
  },
}

/**
 * A mixed unit: the import no agent decided, with its note; locate an agent
 * decided and asks changes of; openStore an agent approved. Their worst
 * verdict requests changes, so the unit's suggestion does too, in the
 * Guided card and the dock.
 */
export const mixedRequestsDeskFixture = sharedDesk(
  undecidedImports,
  locateRequests,
  openStoreApproves,
  { decision: "request_changes", message: SHARED_SUGGESTION }
)

/**
 * A mixed unit whose decided changes all approve: each says so on its row,
 * and the unit has no suggestion of its own, so the dock offers the plain
 * Approve and Request changes.
 */
export const mixedApprovesDeskFixture = sharedDesk(
  undecidedImports,
  {
    suggestion: {
      decision: "approve",
      message: text(
        "Checked: callers locating one folder share one discovery, and a failed one is retried."
      ),
    },
  },
  openStoreApproves
)

/**
 * The same unit with every change decided: each row says its suggestion,
 * and the unit's own suggestion stands in the Guided card and the dock.
 */
export const allDecidedSectionsDeskFixture = sharedDesk(
  {
    suggestion: {
      decision: "approve",
      message: text(SECTION_MESSAGES.imports),
    },
  },
  locateRequests,
  openStoreApproves,
  { decision: "request_changes", message: SHARED_SUGGESTION }
)

/** The line that says a suggestion was carried from an earlier review. */
export const SHARED_CARRIED = "Carried from an earlier review."

/**
 * The same unit carried unchanged from an earlier review: its suggestion
 * says it was carried, and its rows still say each change's own.
 */
export const carriedSectionsDeskFixture = sharedDesk(
  {
    suggestion: {
      decision: "approve",
      message: text(SECTION_MESSAGES.imports),
    },
  },
  locateRequests,
  openStoreApproves,
  {
    decision: "request_changes",
    message: SHARED_SUGGESTION,
    carried: SHARED_CARRIED,
  }
)

/** The batch's units, as the overview lists them. */
export const REDESIGNED_UNITS = {
  CHECKOUT,
  LOCATE,
  PROBE,
  PROJECTS_SUGGESTED,
  RECORDS_SUGGESTED,
  PACKAGE,
  PROJECTS_TEST,
  RECORDS_TEST,
} as const
export {
  BATCH_TITLE as REDESIGNED_BATCH_TITLE,
  BATCH_UNITS as REDESIGNED_BATCH_UNITS,
}
