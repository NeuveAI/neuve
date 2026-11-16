/**
 * The review desk with real lanes (NEU-148): each unit is one file's changes
 * in one review lane, with its lane's judgement. One review of three
 * batches on `acme/docs-app` (SHR-240), the scenario the overview, the
 * Reviews page and the server tests share. The desk opens on the first
 * batch, "Share links expire on a schedule": three human-required units,
 * two human-suggested, four agentic, none in static automation (a variant
 * has one). Three units come from `src/sharing/expiry.ts`, one per lane,
 * their changed lines interleaved. Controlled UI data; no retained batch or
 * review authority.
 */
import { agentRegistryFixture, REVIEWER } from "./review-batch.fixtures"
import {
  CARRIED_CHANGES_COMMENT,
  CARRIED_LABEL,
  LOCKFILE_PATH,
  LOCKFILE_UNIT_ID,
  SCENARIO_LOCKFILE_UNITS,
  EXPIRED_UNIT_ID,
  EXPIRY_PATH,
  EXTEND_UNIT_ID,
  LANES_REVISION,
  NEWER_BATCH_ID,
  NEWER_EXTEND_UNIT_ID,
  POLICY_PATH,
  carriedBatches,
  RENAME_UNIT_ID,
  SCENARIO_STATIC_UNITS,
  SCENARIO_UNITS,
  SCHEDULE_PATH,
  SCHEDULE_UNIT_ID,
  SCHEDULE_UNIT_TITLE,
  TIME_ZONE_UNIT_ID,
  R1,
  publishedBatches,
  unitsIn,
} from "./lanes-scenario.fixtures"
import type { ScenarioUnit } from "./lanes-scenario.fixtures"
import type { DeliveryPayload } from "../neuve/shared/delivery"
import type {
  BatchUnit,
  DiffFile,
  DiffResponsibility,
  DiffSection,
  ElsewhereLane,
  LaneUnit,
  OwnedChangedSource,
  PersonReview,
  RailUnit,
  ReviewBatches,
  ReviewDeskData,
  ReviewLane,
} from "../neuve/types"

export {
  EXPIRY_PATH,
  LANES_REVISION,
  SCHEDULE_UNIT_ID,
  SCHEDULE_UNIT_TITLE,
} from "./lanes-scenario.fixtures"

const BASE_REVISION = "b".repeat(40)

/* ── The units, from the scenario ──────────────────────── */

/** A human-required unit as "Needs your decision" lists it. */
const railUnit = (unit: ScenarioUnit): RailUnit => ({
  id: unit.id,
  title: unit.title,
  hunkCount: unit.hunks,
  ...(unit.agentId ? { agentId: unit.agentId } : {}),
  ...(unit.raisedFrom ? { raisedFrom: unit.raisedFrom } : {}),
  ...(unit.noAgentDecision ? { noAgentDecision: true as const } : {}),
  ...(unit.untitled ? { untitled: unit.untitled } : {}),
})

/** A unit in a lane group, with the agent's review or the checks' result. */
const laneUnit = (unit: ScenarioUnit): LaneUnit => ({
  id: unit.id,
  title: unit.title,
  ...(unit.raisedFrom ? { raisedFrom: unit.raisedFrom } : {}),
  ...(unit.untitled ? { untitled: unit.untitled } : {}),
  ...(unit.review
    ? unit.review.verdict === "approved"
      ? { result: "agent ✓", review: unit.review }
      : { result: "changes", tone: "req" as const, review: unit.review }
    : unit.excluded
      ? { result: "not read", excluded: unit.excluded }
      : { result: "passed" }),
})

/** "Needs your decision", in rail order. */
const RAIL_UNITS: Array<RailUnit> = unitsIn(
  SCENARIO_UNITS,
  "human-required"
).map(railUnit)

const lanesOf = (units: ReadonlyArray<ScenarioUnit>) => ({
  suggested: unitsIn(units, "human-suggested").map(laneUnit),
  agentic: unitsIn(units, "agentic-review").map(laneUnit),
  static: unitsIn(units, "static-automation").map(laneUnit),
})

/** The lane groups under "Decided by agents and tools", labels in full. */
function lanes(units: {
  suggested: Array<LaneUnit>
  agentic: Array<LaneUnit>
  static: Array<LaneUnit>
}): Array<ElsewhereLane> {
  return [
    {
      lane: "human-suggested",
      label: "Human-suggested",
      count: units.suggested.length,
      units: units.suggested,
    },
    {
      lane: "agentic-review",
      label: "Agentic review",
      count: units.agentic.length,
      units: units.agentic,
    },
    {
      lane: "static-automation",
      label: "Static automation",
      count: units.static.length,
      units: units.static,
    },
  ]
}

function batchUnits(elsewhere: Array<ElsewhereLane>): Array<BatchUnit> {
  return [
    ...RAIL_UNITS.map(({ id, title }) => ({
      id,
      title,
      lane: "human-required" as const,
    })),
    ...elsewhere.flatMap(({ lane, units = [] }) =>
      units.map(({ id, title }) => ({ id, title, lane }))
    ),
  ]
}

/* ── The review's batches ─────────────────────────────── */

/** The review as the desk first sees it: one batch published, two to come. */
export const lanesBatchesFixture: ReviewBatches = publishedBatches(1)

/** The same review once its second batch has arrived. */
export const lanesBatchesArrivedFixture: ReviewBatches = publishedBatches(2)

/* ── Ranged files ─────────────────────────────────────────
 * A file several units change, built from a retained patch as live data
 * is: each change replaces `remove` old lines at old line `at` with `add`,
 * and belongs to this unit (optionally one of its sections) or to another.
 */

interface Owner {
  unitId: string
  title: string
  lane: ReviewLane
  /** The lane words its title leaves out (`siblingSource`). */
  laneWords?: string
}

interface Change {
  at: number
  remove: number
  add: Array<string>
  owner: "owned" | Owner
  /** The unit's section the change belongs to (joined units). */
  section?: string
}

const text = (lines: Array<string>) => `${lines.join("\n")}\n`

export function rangedFile({
  path,
  unitId,
  old,
  changes,
  sections = [],
}: {
  path: string
  unitId: string
  old: Array<string>
  changes: Array<Change>
  sections?: Array<{ id: string; title: string }>
}): DiffFile {
  const next: Array<string> = []
  const hunks: Array<string> = []
  const owned: Array<OwnedChangedSource> = []
  const sibling: NonNullable<DiffResponsibility["siblingSource"]> = []
  const ranges = new Map<string, DiffSection["ranges"]>()
  let cursor = 1
  const ordered = [...changes].sort((a, b) => a.at - b.at)
  for (const [index, change] of ordered.entries()) {
    while (cursor < change.at) next.push(old[cursor++ - 1]!)
    const removed = old.slice(change.at - 1, change.at - 1 + change.remove)
    cursor += change.remove
    const newStart = next.length + 1
    next.push(...change.add)
    // Unified-diff headers: an empty side names the line before it.
    hunks.push(
      `@@ -${change.remove ? change.at : change.at - 1},${change.remove} +${change.add.length ? newStart : newStart - 1},${change.add.length} @@`,
      ...removed.map((line) => `-${line}`),
      ...change.add.map((line) => `+${line}`)
    )
    const sides = [
      { side: "old" as const, startLine: change.at, lines: removed },
      { side: "new" as const, startLine: newStart, lines: change.add },
    ].filter((side) => side.lines.length > 0)
    for (const side of sides) {
      if (change.owner === "owned") {
        owned.push({
          kind: "changed-lines",
          hunkId: `h-${path}-${index}`,
          side: side.side,
          sourceRevisionId:
            side.side === "old" ? BASE_REVISION : LANES_REVISION,
          startLine: side.startLine,
          lineCount: side.lines.length,
          lines: side.lines,
        })
        if (change.section)
          ranges.set(change.section, [
            ...(ranges.get(change.section) ?? []),
            {
              side: side.side,
              startLine: side.startLine,
              endLine: side.startLine + side.lines.length - 1,
            },
          ])
      } else
        sibling.push({
          ...change.owner,
          side: side.side,
          startLine: side.startLine,
          lineCount: side.lines.length,
        })
    }
  }
  while (cursor <= old.length) next.push(old[cursor++ - 1]!)
  return {
    path,
    oldContents: text(old),
    newContents: text(next),
    patch: [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      ...hunks,
      "",
    ].join("\n"),
    context: 0,
    additions: changes.reduce((sum, change) => sum + change.add.length, 0),
    deletions: changes.reduce((sum, change) => sum + change.remove, 0),
    markerAnchors: [],
    responsibility: {
      kind: "changed-ranges",
      unitId,
      revisionId: LANES_REVISION,
      ...(sections.length > 1
        ? {
            sections: sections.map((section) => ({
              ...section,
              ranges: ranges.get(section.id) ?? [],
            })),
          }
        : {}),
      ownedSource: owned,
      ...(sibling.length > 0 ? { siblingSource: sibling } : {}),
    },
  }
}

/** Old line number of `line`, which must appear once in `old`. */
function lineOf(old: Array<string>, line: string): number {
  const at = old.indexOf(line)
  if (at < 0 || old.indexOf(line, at + 1) >= 0)
    throw new Error(`fixture line not found once: ${line}`)
  return at + 1
}

/* ── src/sharing/expiry.ts: three units, one per lane ──── */

const EXPIRY_OLD = [
  'import { db } from "../db";',
  'import type { ShareLink, Session } from "./types";',
  "",
  "export const DEFAULT_TTL = 30;",
  "export const MAX_TTL = 365;",
  "",
  "/** Days until a link expires, from now. */",
  "export function daysLeft(link: ShareLink, now = new Date()) {",
  "  if (link.neverExpires) return Infinity;",
  "  const ms = link.expiresAt.getTime() - now.getTime();",
  "  return Math.ceil(ms / 86_400_000);",
  "}",
  "",
  "/** Parses an expiry date from the share form. */",
  "export function parseExpiry(value: string) {",
  "  return new Date(value);",
  "}",
  "",
  "/** Whether a link may open a new session now. */",
  "export function canOpen(link: ShareLink, now = new Date()) {",
  "  if (link.revokedAt) return false;",
  "  if (link.neverExpires) return true;",
  "  return true;",
  "}",
  "",
  "/** The expiry a new link gets when the form leaves it empty. */",
  "export function defaultExpiry(now = new Date()) {",
  "  const date = new Date(now);",
  "  date.setDate(date.getDate() + DEFAULT_TTL);",
  "  return date;",
  "}",
  "",
  "/** Clamps a requested expiry to the longest a link may live. */",
  "export function clampExpiry(requested: Date, now = new Date()) {",
  "  const latest = new Date(now);",
  "  latest.setDate(latest.getDate() + MAX_TTL);",
  "  return requested > latest ? latest : requested;",
  "}",
  "",
  "/** Formats an expiry date for the link list. */",
  "export function formatExpiry(date: Date) {",
  "  return date.toLocaleDateString();",
  "}",
  "",
  "/** Opens a session on a link, or refuses it. */",
  "export async function openSession(link: ShareLink, viewer: string) {",
  "  const session = await db.sessions.insert({ linkId: link.id, viewer });",
  "  return session;",
  "}",
  "",
  "/** Sessions still open on a link. */",
  "export function openSessions(link: ShareLink): Promise<Array<Session>> {",
  "  return db.sessions.findMany({ linkId: link.id, endedAt: null });",
  "}",
  "",
  "/** Extends a link's expiry by the default. */",
  "export function extendDefault(link: ShareLink) {",
  "  return extend(link, DEFAULT_TTL);",
  "}",
  "",
  "/** Extends a link's expiry by `days`. */",
  "export async function extend(link: ShareLink, days: number) {",
  "  const next = new Date(link.expiresAt);",
  "  next.setDate(next.getDate() + days);",
  "  return db.links.update(link.id, { expiresAt: next });",
  "}",
]

const EXPIRED_OWNER: Owner = {
  unitId: EXPIRED_UNIT_ID,
  title: "Expired links refuse new sessions",
  lane: "human-required",
}
const TIME_ZONE_OWNER: Owner = {
  unitId: TIME_ZONE_UNIT_ID,
  title: "Expiry dates accept a time zone",
  lane: "human-suggested",
}
const RENAME_OWNER: Owner = {
  unitId: RENAME_UNIT_ID,
  title: "Rename the expiry constants",
  lane: "agentic-review",
}

/**
 * Who changes what in expiry.ts, in line order: the rename, the expiry
 * check, the time zone, the expiry check, the rename twice, the time zone,
 * the expiry check, the rename.
 */
function expiryChanges(self: Owner): Array<Change> {
  const at = (line: string) => lineOf(EXPIRY_OLD, line)
  const owner = (unit: Owner) =>
    unit.unitId === self.unitId ? ("owned" as const) : unit
  return [
    {
      at: at("export const DEFAULT_TTL = 30;"),
      remove: 2,
      add: [
        "export const DEFAULT_EXPIRY_DAYS = 30;",
        "export const MAX_EXPIRY_DAYS = 365;",
      ],
      owner: owner(RENAME_OWNER),
    },
    {
      at: at("  if (link.neverExpires) return Infinity;"),
      remove: 1,
      add: [],
      owner: owner(EXPIRED_OWNER),
    },
    {
      at: at("export function parseExpiry(value: string) {"),
      remove: 2,
      add: [
        "export function parseExpiry(value: string, timeZone: string) {",
        "  const local = Temporal.PlainDateTime.from(value);",
        "  return new Date(local.toZonedDateTime(timeZone).epochMilliseconds);",
      ],
      owner: owner(TIME_ZONE_OWNER),
    },
    {
      at: at("  if (link.neverExpires) return true;"),
      remove: 2,
      add: ["  return link.expiresAt > now;"],
      owner: owner(EXPIRED_OWNER),
    },
    {
      at: at("  date.setDate(date.getDate() + DEFAULT_TTL);"),
      remove: 1,
      add: ["  date.setDate(date.getDate() + DEFAULT_EXPIRY_DAYS);"],
      owner: owner(RENAME_OWNER),
    },
    {
      at: at("  latest.setDate(latest.getDate() + MAX_TTL);"),
      remove: 1,
      add: ["  latest.setDate(latest.getDate() + MAX_EXPIRY_DAYS);"],
      owner: owner(RENAME_OWNER),
    },
    {
      at: at("export function formatExpiry(date: Date) {"),
      remove: 2,
      add: [
        "export function formatExpiry(date: Date, timeZone: string) {",
        "  return date.toLocaleDateString(undefined, { timeZone });",
      ],
      owner: owner(TIME_ZONE_OWNER),
    },
    {
      // Added after the signature line.
      at:
        at(
          "export async function openSession(link: ShareLink, viewer: string) {"
        ) + 1,
      remove: 0,
      add: [
        "  if (!canOpen(link)) {",
        '    throw new LinkExpired(link.id, "This link has expired.");',
        "  }",
      ],
      owner: owner(EXPIRED_OWNER),
    },
    {
      at: at("  return extend(link, DEFAULT_TTL);"),
      remove: 1,
      add: ["  return extend(link, DEFAULT_EXPIRY_DAYS);"],
      owner: owner(RENAME_OWNER),
    },
  ]
}

/** expiry.ts as the human-required unit sees it: two other units' lines in it. */
export const expiryFile: DiffFile = rangedFile({
  path: EXPIRY_PATH,
  unitId: EXPIRED_UNIT_ID,
  old: EXPIRY_OLD,
  changes: expiryChanges(EXPIRED_OWNER),
})

/* ── src/sharing/schedule.ts: the unit no agent decided ── */

const SCHEDULE_TEMPLATE = [
  (i: number) => `export async function sweep${i}(now = new Date()) {`,
  (i: number) =>
    `  const due = await db.links.findMany({ expiresAt: { lte: now }, batch: ${i} });`,
  () => `  for (const link of due) await expire(link);`,
  () => `  return due.length;`,
  () => `}`,
  () => ``,
]
const scheduleLine = (i: number) =>
  SCHEDULE_TEMPLATE[i % SCHEDULE_TEMPLATE.length]!(i)
const SCHEDULE_OLD = Array.from({ length: 70 }, (_, i) => scheduleLine(i + 1))

/** Owns new L12–48 (old L12–30 replaced) and new L71–90 (old L53–60). */
const scheduleFile: DiffFile = rangedFile({
  path: SCHEDULE_PATH,
  unitId: SCHEDULE_UNIT_ID,
  old: SCHEDULE_OLD,
  changes: [
    {
      at: 12,
      remove: 19,
      add: Array.from(
        { length: 37 },
        (_, k) => `  schedule.every("1h", sweep${k + 1}); // hourly`
      ),
      owner: "owned",
    },
    {
      at: 53,
      remove: 8,
      add: Array.from(
        { length: 20 },
        (_, k) => `  log.info("expired", { batch: ${k + 1} });`
      ),
      owner: "owned",
    },
  ],
})

/* ── src/sharing/access-policy.ts: three changes, one undecided ── */

const POLICY_OLD = [
  'import type { ShareLink, Viewer } from "./types";',
  'import { audit } from "../db/audit";',
  "",
  "/** The actions a viewer may take on a link. */",
  "export function actionsFor(viewer: Viewer, link: ShareLink) {",
  '  const actions = ["open"];',
  '  if (viewer.id === link.ownerId) actions.push("revoke");',
  "  return actions;",
  "}",
  "",
  "/** Applies an action to a link. */",
  "export async function apply(action: string, link: ShareLink) {",
  '  if (action === "revoke") return revoke(link);',
  "  throw new Error(`Unknown action ${action}`);",
  "}",
  "",
  "/** Records what a viewer did to a link. */",
  "export function record(viewer: Viewer, action: string, link: ShareLink) {",
  "  return Promise.resolve({ viewer, action, link });",
  "}",
]

const POLICY_SECTIONS = [
  { id: "extend-button", title: "Admins see Extend on an expired link" },
  { id: "extend-resets", title: "Extending sets a new expiry date" },
  { id: "extend-audit", title: "Extensions are written to the audit log" },
]

const policyFile: DiffFile = rangedFile({
  path: POLICY_PATH,
  unitId: EXTEND_UNIT_ID,
  old: POLICY_OLD,
  sections: POLICY_SECTIONS,
  changes: [
    {
      at: lineOf(POLICY_OLD, "  return actions;"),
      remove: 0,
      add: [
        '  if (viewer.role === "admin" && isExpired(link)) actions.push("extend");',
      ],
      owner: "owned",
      section: "extend-button",
    },
    {
      at: lineOf(POLICY_OLD, "  throw new Error(`Unknown action ${action}`);"),
      remove: 0,
      add: [
        '  if (action === "extend") return extend(link, DEFAULT_EXPIRY_DAYS);',
      ],
      owner: "owned",
      section: "extend-resets",
    },
    {
      at: lineOf(
        POLICY_OLD,
        "  return Promise.resolve({ viewer, action, link });"
      ),
      remove: 1,
      add: [
        "  return audit.write(`link.${action}`, {",
        "    linkId: link.id,",
        "    actor: viewer.id,",
        "  });",
      ],
      owner: "owned",
      section: "extend-audit",
    },
  ],
})

/* ── The desks ──────────────────────────────────────────── */

const ELSEWHERE = lanes(lanesOf(SCENARIO_UNITS))
const BATCH_ONE = lanesBatchesFixture.all[0]!

/**
 * Facts for the open unit, as code writes them: what the change removes
 * comes first (the server orders removals first).
 */
const EXPIRED_DELIVERY: DeliveryPayload = {
  // Its briefing says more than its Facts; no Explained, no Guided rows.
  stops: ["facts", "briefed"],
  facts: [
    {
      kind: "text",
      text: "Removes neverExpires from ShareLink. Links past their expiry date refuse new sessions with LinkExpired. Sessions opened before the date run until they end.",
    },
  ],
}

/**
 * The desk open on "Expired links refuse new sessions" (human-required,
 * 1 of 3), whose lane rose since the last run: four lanes on the rail and
 * two other units' lines in its file.
 */
export const lanesDeskFixture: ReviewDeskData = {
  repo: "acme/docs-app",
  branch: "shr-240-link-expiry",
  revision: LANES_REVISION,
  reviewer: REVIEWER,
  cycle: 1,
  batchTitle: BATCH_ONE.title,
  unit: {
    id: EXPIRED_UNIT_ID,
    title: "Expired links refuse new sessions",
    lane: "human-required",
    raisedFrom: "agentic-review",
    position: { index: 1, of: RAIL_UNITS.length },
    briefing: [
      {
        kind: "text",
        text: "Links past their expiry date now refuse new sessions. Sessions opened before the date run until they end; nothing ends them at expiry. Links that never expired now expire like any other.",
      },
    ],
    stats: "1 file · 3 hunks",
    hunkCount: 3,
    defaultAttachment: "",
    draftSuggestion: "",
    scopeNote: `Only this unit’s lines in ${EXPIRY_PATH}. The other units’ lines there keep their own lanes.`,
    agentId: "i1",
  },
  railUnits: RAIL_UNITS,
  elsewhere: ELSEWHERE,
  batches: lanesBatchesFixture,
  batchUnits: batchUnits(ELSEWHERE),
  agents: agentRegistryFixture,
  markers: {},
  files: [expiryFile],
  delivery: EXPIRED_DELIVERY,
  humanRequiredTotal: RAIL_UNITS.length,
}

/** The variant with one static-automation unit and three agentic units. */
export const lanesWithStaticDeskFixture: ReviewDeskData = (() => {
  const elsewhere = lanes(lanesOf(SCENARIO_STATIC_UNITS))
  return {
    ...lanesDeskFixture,
    elsewhere,
    batchUnits: batchUnits(elsewhere),
  }
})()

/**
 * The desk whose lane groups are opened on a unit whose lane rose too:
 * "Link list shows time left" was in agentic review at the last run. The
 * scenario has it so; this is the same desk under the name its story uses.
 */
export const lanesRaisedDeskFixture: ReviewDeskData = lanesDeskFixture

/**
 * The desk open on the unit no agent decided: no written title, no
 * Briefed text, no checkpoints (they come from an agent's reading), its
 * Facts and its diff. Its Facts are the line code writes for a unit with no
 * agent content (`codeFacts` in packages/harness/src/compose.ts): its label,
 * the owned lines added and removed (37 + 20 new, 19 + 8 old), and the
 * batch's behaviour. As the server projects such a unit, its briefing is
 * its Facts text.
 */
const SCHEDULE_FACTS = `${SCHEDULE_PATH}: 57 line(s) added and 27 removed, for "${BATCH_ONE.title}".`

export const noAgentDecisionDeskFixture: ReviewDeskData = {
  ...lanesDeskFixture,
  unit: {
    id: SCHEDULE_UNIT_ID,
    title: SCHEDULE_UNIT_TITLE,
    lane: "human-required",
    noAgentDecision: true,
    position: { index: 3, of: RAIL_UNITS.length },
    briefing: [{ kind: "text", text: SCHEDULE_FACTS }],
    stats: "1 file · 2 hunks",
    hunkCount: 2,
    defaultAttachment: "",
    draftSuggestion: "",
    scopeNote: `Only this unit’s lines in ${SCHEDULE_PATH}.`,
    agentId: "i2",
  },
  files: [scheduleFile],
  // Facts only: no agent wrote Briefed, Explained or Guided rows.
  delivery: {
    stops: ["facts"],
    facts: [{ kind: "text", text: SCHEDULE_FACTS }],
  },
}

/** The desk on the first unit once the review's second batch has arrived. */
export const lanesArrivedDeskFixture: ReviewDeskData = {
  ...lanesDeskFixture,
  batches: lanesBatchesArrivedFixture,
}

/** The desk on that unit once the review's second batch has arrived. */
export const noAgentDecisionArrivedDeskFixture: ReviewDeskData = {
  ...noAgentDecisionDeskFixture,
  batches: lanesBatchesArrivedFixture,
}

/**
 * A joined unit of three changes whose second no agent decided, as the
 * projection gives one of a redesigned review: each change's claim is its
 * Facts, so the unit offers Facts alone. That change says so in its own
 * place at every stop, with what the agent was unsure of; the unit says
 * nothing of it.
 */
const POLICY_FACTS = [
  "Extend shows only to admins, and only once the link has expired.",
  "access-policy.ts at line 14: 1 line added.",
  "Each extension writes link.extend with the admin as its actor.",
]

/** The note the Lane review left on the change it was unsure of. */
export const UNDECIDED_SECTION_NOTE =
  "Whether DEFAULT_EXPIRY_DAYS is the expiry the ticket asks for is not in the owned lines."

export const undecidedSectionDeskFixture: ReviewDeskData = {
  ...lanesDeskFixture,
  unit: {
    id: EXTEND_UNIT_ID,
    title: "Admins can extend an expired link",
    lane: "human-required",
    position: { index: 2, of: RAIL_UNITS.length },
    briefing: [
      {
        kind: "text",
        text: "Workspace admins can give an expired link a new expiry date.",
      },
    ],
    sections: POLICY_SECTIONS.map((section, i) => {
      const facts = [{ kind: "text" as const, text: POLICY_FACTS[i]! }]
      return {
        id: section.id,
        title: section.title,
        briefing: facts,
        facts,
        ...(i === 1
          ? {
              noAgentDecision: true as const,
              undecidedNotes: [UNDECIDED_SECTION_NOTE],
            }
          : {}),
      }
    }),
    stats: "1 file · 3 hunks",
    hunkCount: 3,
    defaultAttachment: "",
    draftSuggestion: "",
    scopeNote: `Only this unit’s lines in ${POLICY_PATH}.`,
    agentId: "i2",
  },
  files: [policyFile],
  delivery: {
    // Its changes' claims are their Facts: Facts alone.
    stops: ["facts"],
    facts: [
      {
        kind: "text",
        text: "Adds Extend for admins on expired links. Extending sets a new expiry date. Each extension is written to the audit log.",
      },
    ],
  },
}

/* ── Your earlier decision carried ──────────────────────── */

/**
 * "Admins can extend an expired link" arrived closed by your approval
 * carried from the branch's earlier review: it is not under "Needs your
 * decision" nor in its meter (2 units, none decided) but in the rail's own
 * "Decided" group, where its row shows your review, marked carried. The
 * unit head still counts it among the batch's three human-required units.
 */
const CARRIED_UNITS: Array<RailUnit> = RAIL_UNITS.filter(
  (unit) => unit.id === EXTEND_UNIT_ID
).map((unit) => ({
  ...unit,
  carriedReview: {
    actor: { kind: "person", person: REVIEWER, isYou: true },
    verdict: "approved",
    carried: CARRIED_LABEL,
  },
}))
const CARRIED_RAIL: Array<RailUnit> = RAIL_UNITS.filter(
  (unit) => unit.id !== EXTEND_UNIT_ID
)

/** Your request for changes on the time-zone unit, carried, as its rail row shows it. */
const CARRIED_CHANGES: PersonReview = {
  actor: { kind: "person", person: REVIEWER, isYou: true },
  verdict: "changes_requested",
  carried: CARRIED_LABEL,
}

/**
 * The lane groups once your request for changes on the time-zone unit
 * carried too (a variant of the carried review): its row shows yours.
 */
const CARRIED_ELSEWHERE: Array<ElsewhereLane> = ELSEWHERE.map((lane) => ({
  ...lane,
  units: (lane.units ?? []).map((unit) =>
    unit.id === TIME_ZONE_UNIT_ID
      ? {
          id: unit.id,
          title: unit.title,
          result: "changes",
          personReview: CARRIED_CHANGES,
        }
      : unit
  ),
}))

const carriedDesk = {
  railUnits: CARRIED_RAIL,
  carriedUnits: CARRIED_UNITS,
  humanRequiredTotal: CARRIED_RAIL.length,
  humanDecidedUnitIds: [],
  batches: carriedBatches(),
} satisfies Partial<ReviewDeskData>

/** The desk on "Expired links refuse new sessions", with the admins unit carried. */
export const carriedRailDeskFixture: ReviewDeskData = {
  ...lanesDeskFixture,
  ...carriedDesk,
}

/**
 * The admins unit's own page: your carried approval stands on it, so the
 * dock opens decided, with Undo (Records lets you retract it, and the unit
 * then waits on you again); the rail's "Decided" group is open on its row,
 * which says whose review closes it.
 */
export const carriedUnitDeskFixture: ReviewDeskData = {
  ...undecidedSectionDeskFixture,
  ...carriedDesk,
  currentDecision: { commandId: "carried-admins", decision: "approve" },
  unit: {
    ...undecidedSectionDeskFixture.unit,
    sections: undecidedSectionDeskFixture.unit.sections!.map(
      ({ noAgentDecision: _undecided, ...section }) => ({
        ...section,
        briefing:
          section.briefing.length > 0
            ? section.briefing
            : [
                {
                  kind: "text" as const,
                  text: "Extending gives the link 30 more days from today.",
                },
              ],
      })
    ),
  },
}

/* ── A newer review replaced this one under the reader ─── */

/**
 * The desk reloaded after a newer review of this work replaced its review:
 * everything as it was, and the unit that holds the work now.
 */
export const replacedDeskFixture: ReviewDeskData = {
  ...lanesDeskFixture,
  newer: { unitId: NEWER_EXTEND_UNIT_ID },
}

/** The same, where no unit of the newer review holds this one's work. */
export const replacedNoSuccessorDeskFixture: ReviewDeskData = {
  ...lanesDeskFixture,
  newer: { batchId: NEWER_BATCH_ID },
}

/* ── Your carried request for changes, on human-suggested work ── */

/** expiry.ts as the time-zone unit sees it: two other units' lines in it. */
const timeZoneFile: DiffFile = rangedFile({
  path: EXPIRY_PATH,
  unitId: TIME_ZONE_UNIT_ID,
  old: EXPIRY_OLD,
  changes: expiryChanges(TIME_ZONE_OWNER),
})

/**
 * "Expiry dates accept a time zone": the agent approved it, but your request
 * for changes from the earlier review carried and stands over it. The review
 * card is yours, marked carried; the comment it rests on names no lines, so
 * it is on the whole unit; the dock opens decided with Undo.
 */
export const carriedSuggestedDeskFixture: ReviewDeskData = {
  ...lanesDeskFixture,
  ...carriedDesk,
  elsewhere: CARRIED_ELSEWHERE,
  unit: {
    id: TIME_ZONE_UNIT_ID,
    title: "Expiry dates accept a time zone",
    lane: "human-suggested",
    position: { index: 1, of: 2 },
    briefing: [
      {
        kind: "text",
        text: "Expiry dates are read and shown in the time zone the link's owner chose, not the server's.",
      },
    ],
    stats: "1 file · 2 hunks",
    hunkCount: 2,
    defaultAttachment: "",
    draftSuggestion: "",
    scopeNote: `Only this unit’s lines in ${EXPIRY_PATH}.`,
    attribution: {
      headline: "You requested changes",
      meta: CARRIED_LABEL,
      outcome: "changes-requested",
      person: { actor: CARRIED_CHANGES.actor, carried: CARRIED_LABEL },
    },
    comments: [
      {
        id: "carried-time-zone-comment",
        author: CARRIED_CHANGES.actor,
        body: CARRIED_CHANGES_COMMENT,
        carried: CARRIED_LABEL,
        verdict: "changes_requested",
      },
    ],
  },
  files: [timeZoneFile],
  currentDecision: {
    commandId: "carried-time-zone",
    decision: "request-changes",
  },
}

/* ── Comments on the whole unit, and Records' notes ────────── */

/** Another person on the branch. */
const ROSA = { id: "reviewer-rosa", name: "Rosa Amaral", initials: "RA" }

/** The reviewer agent, as a comment's author. */
const R1_AUTHOR = { kind: "agent" as const, agent: R1 }

/**
 * The admins unit with comments that name no lines: the reviewer's on its
 * second change (its row), the reviewer's and Rosa's on the whole unit,
 * under the briefing; and Records' note that a later decision of Rosa's was
 * not brought forward, first in the briefing, in Records' words.
 */
export const wholeUnitCommentsDeskFixture: ReviewDeskData = {
  ...undecidedSectionDeskFixture,
  unit: {
    ...undecidedSectionDeskFixture.unit,
    briefing: [
      {
        kind: "text",
        text: "A person's latest decision on a change in this unit wasn't brought forward, because the change differs here. A person decides it again. ",
      },
      ...undecidedSectionDeskFixture.unit.briefing,
    ],
    sections: undecidedSectionDeskFixture.unit.sections!.map((section, i) =>
      i === 2
        ? {
            ...section,
            comments: [
              {
                id: "r1-audit",
                author: R1_AUTHOR,
                body: "The audit entry names the admin but not the new expiry date; an auditor can't tell how far it was extended.",
              },
            ],
          }
        : section
    ),
    comments: [
      {
        id: "r1-whole",
        author: R1_AUTHOR,
        body: "Extending an expired link reopens every session it allowed before. Check that this is intended for links shared outside the workspace.",
      },
      {
        id: "rosa-whole",
        author: { kind: "person", person: ROSA, isYou: false },
        body: "We said extensions cap at 90 days in the spec; I don't see the cap here.",
      },
    ],
  },
}

/* ── Decisions on an earlier version ───────────────────────── */

/**
 * "Expired links refuse new sessions" changed since the branch's earlier
 * review: Rosa's approval and your request for changes there are shown as
 * made on an earlier version. They close nothing: the unit still needs your
 * decision.
 */
export const earlierVersionDeskFixture: ReviewDeskData = {
  ...lanesDeskFixture,
  unit: {
    ...lanesDeskFixture.unit,
    earlierDecisions: [
      {
        actor: { kind: "person", person: ROSA, isYou: false },
        verdict: "approved",
        review: CARRIED_LABEL,
      },
      {
        actor: { kind: "person", person: REVIEWER, isYou: true },
        verdict: "changes_requested",
        review: CARRIED_LABEL,
      },
    ],
  },
}

/* ── A lockfile no agent read ──────────────────────────────── */

const LOCKFILE_OLD = Array.from({ length: 40 }, (_, i) =>
  i % 4 === 0
    ? `  /pkg-${i}@1.${i}.0:`
    : `    resolution: {integrity: sha512-${i}}`
)

const lockfileFile: DiffFile = rangedFile({
  path: LOCKFILE_PATH,
  unitId: LOCKFILE_UNIT_ID,
  old: LOCKFILE_OLD,
  changes: [
    {
      at: 9,
      remove: 2,
      add: ["  /pkg-8@1.9.0:", "    resolution: {integrity: sha512-8b}"],
      owner: "owned",
    },
    {
      at: 29,
      remove: 1,
      add: ["    resolution: {integrity: sha512-28b}"],
      owner: "owned",
    },
  ],
})

/** Every lane's units in the lockfile variant, the lockfile among them. */
const LOCKFILE_LANES = lanes(lanesOf(SCENARIO_LOCKFILE_UNITS))

/**
 * The rail's lane groups in the lockfile variant: no agent read the
 * lockfile, so it is not among the lanes decided by agents and tools but in
 * the rail's own "Not read" group.
 */
const LOCKFILE_ELSEWHERE = lanes(
  lanesOf(SCENARIO_LOCKFILE_UNITS.filter((unit) => !unit.excluded))
)

/** The rail's "Not read" group: the lockfile, in its lane. */
const NOT_READ_UNITS = unitsIn(SCENARIO_LOCKFILE_UNITS, "human-suggested")
  .filter((unit) => unit.excluded)
  .map((unit) => ({ ...laneUnit(unit), lane: unit.lane }))

/** The variant whose batch also updated the lockfile, on the first unit. */
export const lockfileRailDeskFixture: ReviewDeskData = {
  ...lanesDeskFixture,
  elsewhere: LOCKFILE_ELSEWHERE,
  notReadUnits: NOT_READ_UNITS,
  batchUnits: batchUnits(LOCKFILE_LANES),
}

/**
 * The lockfile's own page: no agent read it, so it says so plainly, with
 * the rule that marked it; Facts and the diff stay. It keeps its lane and
 * never waits on a person.
 */
export const lockfileDeskFixture: ReviewDeskData = {
  ...lockfileRailDeskFixture,
  unit: {
    id: LOCKFILE_UNIT_ID,
    title: `Changes to ${LOCKFILE_PATH}`,
    lane: "human-suggested",
    excluded: { reason: "lockfile" },
    position: { index: 3, of: 3 },
    briefing: [
      {
        kind: "text",
        text: `${LOCKFILE_PATH}: 3 line(s) added and 3 removed, for "${BATCH_ONE.title}".`,
      },
    ],
    stats: "1 file · 2 hunks",
    hunkCount: 2,
    defaultAttachment: "",
    draftSuggestion: "",
    scopeNote: `Only this unit’s lines in ${LOCKFILE_PATH}.`,
  },
  files: [lockfileFile],
  delivery: {
    // No agent read it: Facts only.
    stops: ["facts"],
    facts: [
      {
        kind: "text",
        text: `${LOCKFILE_PATH}: 3 line(s) added and 3 removed, for "${BATCH_ONE.title}".`,
      },
    ],
  },
}

/**
 * The lockfile alone in its batch, as real reviews publish a "Lockfiles and
 * generated files" batch: nothing needs a decision and every lane decided
 * by agents and tools is empty, so the rail shows the "Not read" group
 * alone, with no heading over empty lanes.
 */
export const lockfileAloneDeskFixture: ReviewDeskData = {
  ...lockfileDeskFixture,
  railUnits: [],
  humanRequiredTotal: 0,
  humanDecidedUnitIds: [],
  elsewhere: lanes({ suggested: [], agentic: [], static: [] }),
  batchUnits: NOT_READ_UNITS.map(({ id, title, lane }) => ({
    id,
    title,
    lane,
  })),
  unit: { ...lockfileDeskFixture.unit, position: { index: 1, of: 1 } },
}

/* ── A unit whose parts say it all ─────────────────────────── */

/**
 * The admins unit as a review publishes it with no Briefed of its own: each
 * part says its own fact on its row, and the unit has no lead paragraph,
 * which would only repeat them (its Facts are the parts' facts joined).
 */
export const partsOnlyDeskFixture: ReviewDeskData = {
  ...undecidedSectionDeskFixture,
  unit: {
    ...undecidedSectionDeskFixture.unit,
    briefing: [],
    sections: undecidedSectionDeskFixture.unit.sections!.map(
      ({ noAgentDecision: _undecided, ...section }) => ({
        ...section,
        briefing:
          section.briefing.length > 0
            ? section.briefing
            : [
                {
                  kind: "text" as const,
                  text: "Extending gives the link 30 more days from today.",
                },
              ],
      })
    ),
  },
}

/* ── A long lane and a lockfile in a short rail ────────────── */

/** Three more agentic units: the lane then lists seven, long enough to scroll on its own. */
const MORE_AGENTIC: ReadonlyArray<ScenarioUnit> = [
  [
    "share-link-tokens-rotate",
    "Share link tokens rotate on extend",
    "src/sharing/tokens.ts",
  ],
  [
    "expiry-copy-in-settings",
    "Expiry copy in workspace settings",
    "src/ui/settings.tsx",
  ],
  [
    "audit-log-names-extender",
    "Audit log names who extended",
    "src/audit/log.ts",
  ],
].map(([id, title, path]) => ({
  id: id!,
  title: title!,
  lane: "agentic-review" as const,
  path: path!,
  hunks: 1,
  review: { reviewer: R1, verdict: "approved" as const },
}))

const LONG_LANE_UNITS: ReadonlyArray<ScenarioUnit> = [
  ...SCENARIO_LOCKFILE_UNITS,
  ...MORE_AGENTIC,
]

const LONG_LANE_ELSEWHERE = lanes(
  lanesOf(LONG_LANE_UNITS.filter((unit) => !unit.excluded))
)

/**
 * The lockfile variant whose agentic lane lists seven units, for a short
 * rail: the agents' lanes and the "Not read" group share one container and
 * scroll together, so the group is never drawn over a lane's rows.
 */
export const lockfileLongLaneDeskFixture: ReviewDeskData = {
  ...lockfileRailDeskFixture,
  elsewhere: LONG_LANE_ELSEWHERE,
  batchUnits: batchUnits(lanes(lanesOf(LONG_LANE_UNITS))),
}
