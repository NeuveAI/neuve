/**
 * Review delivery sample (round 4): one Go unit with every layer the dial
 * can show, transcribed from the Delivery board (design-export/Delivery.dc.html)
 * for "Index writes retry when the database is busy" (SHR-318), and one
 * TypeScript unit whose ticket (SHR-212) has a scope but no "Done when"
 * (the Scope card on Verdicts.dc.html, round 4.2).
 *
 * The units join the mock batch in review-batch.fixtures.ts, which assembles
 * its desk (this module imports nothing from there, so the two never form an
 * import cycle). The payload's language is data the provider declared; no
 * component derives it from the file path.
 */
import type {
  DeliveryCheckpoint,
  DeliveryCriterion,
  DeliveryPayload,
} from "../neuve/shared/delivery"
import type { ContextualMarker, DiffFile, ReviewDeskData } from "../neuve/types"

export const GO_UNIT_ID = "index-writes-retry-when-busy"
export const GO_UNIT_TITLE = "Index writes retry when the database is busy"
export const GO_FILE_PATH = "internal/index/writer.go"
const REVISION = "a3f9c2e"

/* ── internal/index/writer.go ─────────────────────────────
 * Commit's old body moves into commitOnce; Commit becomes the retry loop.
 * New-side line numbers used below: 29 loop, 31 errors.Is, 34 time.Sleep,
 * 36 return ErrIndexBusy, 39 commitOnce, 40 BeginTx.
 */

const WRITER_HEAD = [
  "package index",
  "",
  "import (",
  '\t"context"',
  '\t"errors"',
  '\t"time"',
  "",
  '\t"neuve.dev/graph/internal/sqlite"',
  ")",
  "",
  "// ErrIndexBusy is returned when the index database stays busy after every attempt.",
  'var ErrIndexBusy = errors.New("index: database busy")',
  "",
  "const maxAttempts = 3",
  "",
  "// Writer commits batches of graph rows to the index database.",
  "type Writer struct {",
  "\tdb *sqlite.DB",
  "}",
  "",
  "// backoff waits a little longer after each busy attempt.",
  "func backoff(attempt int) time.Duration {",
  "\treturn time.Duration(50<<attempt) * time.Millisecond",
  "}",
  "",
  "// Commit writes one batch in a single transaction.",
]

const COMMIT_BODY = [
  "\ttx, err := w.db.BeginTx(ctx, nil)",
  "\tif err != nil {",
  "\t\treturn err",
  "\t}",
  "\tdefer tx.Rollback()",
  "\tif err := w.write(tx, b); err != nil {",
  "\t\treturn err",
  "\t}",
  "\treturn tx.Commit()",
  "}",
]

const WRITER_OLD = [
  "// It returns the database error unchanged.",
  "func (w *Writer) Commit(ctx context.Context, b Batch) error {",
  ...COMMIT_BODY,
]

const WRITER_NEW = [
  "// A busy database is retried, then reported as ErrIndexBusy.",
  "func (w *Writer) Commit(ctx context.Context, b Batch) error {",
  "\tfor attempt := range maxAttempts {",
  "\t\terr := w.commitOnce(ctx, b)",
  "\t\tif !errors.Is(err, sqlite.ErrBusy) {",
  "\t\t\treturn err",
  "\t\t}",
  "\t\ttime.Sleep(backoff(attempt))",
  "\t}",
  "\treturn ErrIndexBusy",
  "}",
  "",
  "func (w *Writer) commitOnce(ctx context.Context, b Batch) error {",
  ...COMMIT_BODY,
]

const WRITER_TAIL = [
  "",
  "func (w *Writer) write(tx *sqlite.Tx, b Batch) error {",
  "\tfor _, row := range b.Rows {",
  "\t\tif _, err := tx.Exec(insertRow, row.Args()...); err != nil {",
  "\t\t\treturn err",
  "\t\t}",
  "\t}",
  "\treturn nil",
  "}",
]

const text = (rows: Array<string>) => `${rows.join("\n")}\n`

export const goWriterFile: DiffFile = {
  path: GO_FILE_PATH,
  additions: 12,
  deletions: 1,
  oldContents: text([...WRITER_HEAD, ...WRITER_OLD, ...WRITER_TAIL]),
  newContents: text([...WRITER_HEAD, ...WRITER_NEW, ...WRITER_TAIL]),
  context: 3,
  markerAnchors: [
    {
      markerKey: "go-retry",
      side: "additions",
      lineNumber: 29,
      range: { start: 29, end: 36, side: "additions" },
    },
    { markerKey: "go-gap", side: "additions", lineNumber: 29 },
    { markerKey: "go-doc", side: "additions", lineNumber: 34 },
    { markerKey: "go-graph", side: "additions", lineNumber: 36 },
  ],
}

/* ── Context markers (the margin before Guided) ───────────
 * Guided cites the same markers as evidence pins.
 */

const marker = (
  value: Omit<ContextualMarker, "source"> & {
    sheetKind: string
    blocks: ContextualMarker["source"]["blocks"]
  }
): ContextualMarker => {
  const { sheetKind, blocks, ...rest } = value
  return {
    ...rest,
    source: {
      kind: sheetKind,
      chips: [
        {
          text: value.short,
          tone: value.tone === "gap" ? "sug" : "neutral",
        },
      ],
      title: value.title,
      subtitle: value.meta,
      actions: [],
      facts: [{ label: "Revision", value: REVISION, mono: true }],
      blocks,
      citedBy: ["This unit"],
    },
  }
}

export const goMarkers: Record<string, ContextualMarker> = {
  "go-retry": marker({
    key: "go-retry",
    tone: "source",
    short: "Source",
    peek: "Commit retries a busy write up to three times, then returns ErrIndexBusy.",
    kindLabel: "Source · this unit",
    title: "Commit's retry loop",
    meta: `${GO_FILE_PATH} · lines 29–36`,
    quote: "for attempt := range maxAttempts { … } return ErrIndexBusy",
    applies: "The loop is the whole behaviour change of this unit.",
    sheetKind: "Code",
    blocks: [
      {
        kind: "code",
        lines: WRITER_NEW.slice(2, 10).map((line, i) => ({
          number: 29 + i,
          text: line,
          cited: true,
        })),
      },
    ],
  }),
  "go-gap": marker({
    key: "go-gap",
    tone: "gap",
    short: "Gap",
    target: "busy path",
    peek: "No test makes the database report busy.",
    kindLabel: "Evidence gap",
    title: "No test reaches the busy path",
    meta: "internal/index/writer_test.go",
    quote: "No test makes the database report busy.",
    applies: "The retry and the final ErrIndexBusy have never run under test.",
    check: "Ask for a test that forces ErrBusy and expects three attempts.",
    checkAction: { kind: "request-check", label: "Request a check" },
    sheetKind: "Test",
    blocks: [
      {
        kind: "text",
        text: "writer_test.go covers a clean commit and a write error. Nothing stubs sqlite.ErrBusy.",
      },
    ],
  }),
  "go-doc": marker({
    key: "go-doc",
    tone: "doc",
    short: "Doc",
    peek: "Index writers return as soon as their context is done.",
    kindLabel: "Doc · committed",
    title: "internal/index/README.md",
    meta: "§ Writers · 51d0c8e",
    quote:
      "Writers must return as soon as ctx is done. Never sleep without watching ctx.Done().",
    excerpt: {
      kind: "quote",
      text: "Writers must return as soon as ctx is done. Never sleep without watching ctx.Done().",
    },
    applies: "Line 34 sleeps between attempts without watching ctx.Done().",
    check: "A cancelled request still waits up to 350ms here.",
    sheetKind: "Doc",
    blocks: [
      {
        kind: "quote",
        text: "Writers must return as soon as ctx is done. Never sleep without watching ctx.Done().",
      },
    ],
  }),
  "go-graph": marker({
    key: "go-graph",
    tone: "graph",
    short: "Graph",
    target: "3 callers",
    peek: "Three functions call Commit; sync.go treats every error as fatal.",
    kindLabel: "Graph · callers",
    title: "Callers of Writer.Commit",
    meta: "incoming CALLS · 1 hop · a3f9c2e",
    quote: "Three functions call Commit.",
    excerpt: {
      kind: "tree",
      nodes: [
        { prefix: "", name: "Writer.Commit", where: "", tone: "root" },
        {
          prefix: "├ ",
          name: "Indexer.Flush",
          where: "indexer.go",
          fullPath: "internal/index/indexer.go:88",
          tone: "node",
        },
        {
          prefix: "├ ",
          name: "Backfill.Run",
          where: "backfill.go",
          fullPath: "internal/index/backfill.go:41",
          tone: "node",
        },
        {
          prefix: "└ ",
          name: "Sync.Apply",
          where: "sync.go",
          fullPath: "internal/index/sync.go:63",
          tone: "node",
        },
      ],
    },
    applies: "ErrIndexBusy is a new error every caller now receives.",
    check: "sync.go stops a whole sync on any error, including ErrIndexBusy.",
    sheetKind: "Graph",
    blocks: [
      {
        kind: "text",
        text: "Indexer.Flush and Backfill.Run retry on ErrIndexBusy. Sync.Apply returns any error and stops the sync.",
      },
    ],
  }),
}

/* ── Delivery payload ───────────────────────────────────── */

const GO_MESSAGE =
  "Not done yet:\n1. A cancelled request keeps waiting: the retry sleeps with time.Sleep. Wait on a timer and ctx.Done() together, as the index README asks.\n2. No test forces ErrBusy. Add one that expects three attempts, then ErrIndexBusy."

const GO_CRITERIA: Array<DeliveryCriterion> = [
  {
    id: "retry",
    criterion: "Index writes retry when the database is busy",
    status: "met",
    does: "Commit now tries up to three times, waiting a little longer each time, then returns ErrIndexBusy instead of the raw database error.",
    evidence: [
      {
        kind: "source",
        label: "Source",
        target: "lines 29–36",
        markerKey: "go-retry",
        excerpt: [
          "for attempt := range maxAttempts {",
          "    err := w.commitOnce(ctx, b)",
          "    …",
          "return ErrIndexBusy",
        ],
      },
    ],
  },
  {
    id: "cancel",
    criterion: "Cancelling a request stops index work",
    status: "not-met",
    does: "Between attempts the code sleeps without watching for cancellation, so a cancelled request still waits up to 350ms before it returns.",
    evidence: [
      {
        kind: "source",
        label: "Source",
        target: "line 34",
        excerpt: ["time.Sleep(backoff(attempt))"],
      },
      {
        kind: "doc",
        label: "Doc",
        target: "index/README · writers return when ctx is done",
        markerKey: "go-doc",
      },
    ],
  },
  {
    id: "test",
    criterion: "The busy path is covered by a test",
    status: "no-evidence",
    does: "No test makes the database report busy, so the retry and the final ErrIndexBusy have never run under test.",
    evidence: [
      { kind: "gap", label: "Gap", target: "busy path", markerKey: "go-gap" },
    ],
  },
  {
    id: "callers",
    criterion: "Callers see a new error",
    status: "outside",
    does: "Three functions call Commit. Two already treat ErrIndexBusy as retryable; sync.go treats any error as fatal and will stop a sync on a busy index.",
    evidence: [
      {
        kind: "graph",
        label: "Graph",
        target: "3 callers · sync.go",
        markerKey: "go-graph",
      },
    ],
  },
]

const range = (start: number, end = start) => ({
  start,
  end,
  side: "additions" as const,
})

export const goDeliveryPayload: DeliveryPayload = {
  // Every stop: its briefing says more than its Facts, it has a flow and
  // terms, and a check against SHR-318.
  stops: ["facts", "briefed", "explained", "guided"],
  language: "go",
  languageName: "Go",
  facts: [
    {
      kind: "text",
      text: "Commit retries busy writes three times, then returns ErrIndexBusy ",
    },
    {
      kind: "cite",
      label: "Source",
      markerKey: "go-retry",
      ariaLabel: "Source, lines 29–36",
    },
    { kind: "text", text: ". The busy path is untested " },
    {
      kind: "cite",
      label: "Gap",
      markerKey: "go-gap",
      ariaLabel: "Gap, line 29",
    },
    { kind: "text", text: "." },
  ],
  flow: {
    title: "How Commit changes",
    filePath: GO_FILE_PATH,
    range: range(29, 36),
    before: [
      { label: "Commit", range: range(28) },
      {},
      { label: "BeginTx", range: range(40) },
      { label: "busy" },
      { label: "fails", tone: "fails", range: range(42) },
    ],
    after: [
      { label: "Commit", range: range(28) },
      {},
      { label: "commitOnce", range: range(39) },
      { label: "busy" },
      { label: "wait, retry", range: range(34) },
      { label: "×3", loop: true },
      { label: "ErrIndexBusy", tone: "end", range: range(36) },
    ],
  },
  terms: [
    {
      term: "for attempt := range maxAttempts",
      explanation:
        "Counts attempt from 0 up to maxAttempts − 1. Ranging over an integer is new in Go 1.22.",
      filePath: GO_FILE_PATH,
      range: range(29),
    },
    {
      term: "errors.Is(err, sqlite.ErrBusy)",
      explanation:
        "True when err is ErrBusy or wraps it, so a wrapped busy error still retries.",
      filePath: GO_FILE_PATH,
      range: range(31),
    },
    {
      term: "time.Sleep(backoff(attempt))",
      explanation:
        "Pauses the goroutine for the whole wait. Nothing can interrupt it, including a cancelled ctx.",
      filePath: GO_FILE_PATH,
      range: range(34),
    },
  ],
  check: {
    ticket: {
      id: "SHR-318",
      title: "Index writes fail when the database is busy",
    },
    basis: "done-when",
    criteria: GO_CRITERIA,
    suggestion: {
      decision: "request_changes",
      message: GO_MESSAGE,
    },
  },
}

/** The unit as the desk shows it (lane, briefing and dock copy). */
export const goDeliveryUnit: ReviewDeskData["unit"] = {
  id: GO_UNIT_ID,
  title: GO_UNIT_TITLE,
  lane: "human-required",
  position: { index: 3, of: 4 },
  // Round 5 (option B): each phrase that describes part of the change
  // links to it, and the citation chips stay, icon only in the briefing.
  briefing: [
    {
      kind: "text",
      text: "Commit used to fail on the first lock clash. It now ",
    },
    {
      kind: "phrase",
      text: "retries up to three times with growing waits, then returns ErrIndexBusy",
      target: { kind: "lines", filePath: GO_FILE_PATH, range: range(29, 36) },
    },
    { kind: "text", text: " " },
    {
      kind: "cite",
      label: "Source",
      markerKey: "go-retry",
      ariaLabel: "Source, lines 29–36",
    },
    { kind: "text", text: ". " },
    {
      kind: "phrase",
      text: "The wait ignores cancellation",
      target: { kind: "lines", filePath: GO_FILE_PATH, range: range(34) },
    },
    { kind: "text", text: ", so a cancelled request still sleeps " },
    {
      kind: "cite",
      label: "Doc",
      markerKey: "go-doc",
      ariaLabel: "Doc, line 34",
    },
    { kind: "text", text: ". " },
    {
      kind: "phrase",
      text: "No test forces the busy path",
      target: { kind: "marker", markerKey: "go-gap" },
    },
    { kind: "text", text: " " },
    {
      kind: "cite",
      label: "Gap",
      markerKey: "go-gap",
      ariaLabel: "Gap, line 29",
    },
    { kind: "text", text: "." },
  ],
  stats: "1 file · 1 hunk · 4 markers",
  hunkCount: 1,
  scopeLabel: "1 hunk",
  defaultAttachment: "go-gap",
  draftSuggestion:
    "Wait on ctx.Done() between attempts, and add a test that forces ErrBusy.",
  scopeNote:
    "Only this unit’s human-required hunk in internal/index/writer.go.",
  agentId: "i2",
}

/* ── Scope fallback (round 4.2, S2) ───────────────────────
 * A TypeScript unit whose ticket has a scope but no "Done when": SHR-212
 * as the Verdicts board's Scope card reads it. Guided checks the change
 * against that scope, with ring marks and Covered / Not covered / No
 * evidence, and still ends in the suggested review (human-required).
 */

export const SCOPE_UNIT_ID = "page-requests-recheck-the-link"
export const SCOPE_UNIT_TITLE = "Page requests check the share link again"
export const SCOPE_FILE_PATH = "src/sharing/viewer-access.ts"

const ACCESS_HEAD = [
  'import type { ShareLink, Viewer } from "./types";',
  'import { AccessEnded } from "./errors";',
  "",
]

const ACCESS_OLD = [
  "// Checked once, when the viewer opens the document.",
  "export function canOpen(link: ShareLink, viewer: Viewer) {",
  "  return !link.revokedAt && viewer.linkId === link.id;",
  "}",
]

const ACCESS_NEW = [
  "// Checked when the viewer opens the document and on every page request.",
  "export function canOpen(link: ShareLink, viewer: Viewer) {",
  "  return !link.revokedAt && viewer.linkId === link.id;",
  "}",
  "",
  "export function assertStillShared(link: ShareLink, viewer: Viewer) {",
  "  if (!canOpen(link, viewer)) {",
  '    throw new AccessEnded("revoked");',
  "  }",
  "}",
]

export const scopeAccessFile: DiffFile = {
  path: SCOPE_FILE_PATH,
  additions: 7,
  deletions: 1,
  oldContents: text([...ACCESS_HEAD, ...ACCESS_OLD]),
  newContents: text([...ACCESS_HEAD, ...ACCESS_NEW]),
  context: 3,
  markerAnchors: [
    {
      markerKey: "scope-check",
      side: "additions",
      lineNumber: 9,
      range: { start: 9, end: 13, side: "additions" },
    },
    { markerKey: "scope-open", side: "additions", lineNumber: 4 },
    { markerKey: "scope-gap", side: "additions", lineNumber: 11 },
  ],
}

export const scopeMarkers: Record<string, ContextualMarker> = {
  "scope-check": marker({
    key: "scope-check",
    tone: "source",
    short: "Source",
    peek: "Every page request now checks the link before it serves the page.",
    kindLabel: "Source · this unit",
    title: "assertStillShared",
    meta: `${SCOPE_FILE_PATH} · lines 9–13`,
    quote: "if (!canOpen(link, viewer)) throw new AccessEnded(…)",
    applies: "This check is what ends access on the next request.",
    sheetKind: "Code",
    blocks: [
      {
        kind: "code",
        lines: ACCESS_NEW.slice(5, 10).map((line, i) => ({
          number: 9 + i,
          text: line,
          cited: true,
        })),
      },
    ],
  }),
  "scope-open": marker({
    key: "scope-open",
    tone: "doc",
    short: "Doc",
    target: "SHR-212",
    peek: "The ticket asks that documents already open lose access too.",
    kindLabel: "Ticket · scope",
    title: "SHR-212 · Revoked links keep working for open sessions",
    meta: "Scope · 3 items",
    quote: "Open documents lose access too, not only new page loads.",
    applies:
      "A document already loaded never makes another page request, so it keeps its content.",
    check: "Nothing tells an open document that its link was revoked.",
    sheetKind: "Doc",
    blocks: [
      {
        kind: "quote",
        text: "Revoking a link ends access immediately. Open documents lose access too. Viewers see why access ended.",
      },
    ],
  }),
  "scope-gap": marker({
    key: "scope-gap",
    tone: "gap",
    short: "Gap",
    target: "AccessEnded",
    peek: "No page shows a reason when AccessEnded is thrown.",
    kindLabel: "Evidence gap",
    title: "Nothing renders AccessEnded",
    meta: "src/sharing",
    quote: "No page shows a reason when AccessEnded is thrown.",
    applies: "Viewers may see a generic error instead of why access ended.",
    check: "Ask where AccessEnded is shown to the viewer.",
    checkAction: { kind: "request-check", label: "Request a check" },
    sheetKind: "Test",
    blocks: [
      {
        kind: "text",
        text: "AccessEnded is thrown here and caught nowhere in src/sharing.",
      },
    ],
  }),
}

/*
 * SHR-212's checkpoints (11.23), written from the scope's own markers, with
 * Records' notes. Each rests on the scope item it sits under (its basis);
 * the projection attaches them, and Records sets every state.
 */
const ACCESS_LINES = {
  kind: "source",
  label: "viewer-access.ts",
  target: "lines 9–13",
  excerpt: ACCESS_NEW.slice(5, 10),
} as const

const PROVEN_NOTE =
  "Its kinds of proof agree and are current: a test run and logs."

export const SCOPE_CHECKPOINTS: Record<
  "ends" | "open" | "why",
  Array<DeliveryCheckpoint>
> = {
  ends: [
    {
      number: 1,
      requirement:
        "The first page request after a revoke is refused with AccessEnded.",
      proof: "proven",
      note: PROVEN_NOTE,
      unmet: false,
      lines: { ...ACCESS_LINES, excerpt: [...ACCESS_LINES.excerpt] },
    },
    {
      number: 2,
      requirement: "A viewer whose link is still shared keeps opening pages.",
      proof: "proven",
      note: PROVEN_NOTE,
      unmet: false,
      lines: { ...ACCESS_LINES, excerpt: [...ACCESS_LINES.excerpt] },
    },
  ],
  open: [
    {
      number: 3,
      requirement:
        "A document already open stops showing its content once its link is revoked.",
      proof: "missing",
      note: "No proof record it names is in Records.",
      unmet: true,
    },
    {
      number: 4,
      requirement:
        "A revoke refuses the open document’s next request for its content.",
      proof: "conflicting",
      note: "Its records disagree: a test run and logs.",
      unmet: true,
      lines: { ...ACCESS_LINES, excerpt: [...ACCESS_LINES.excerpt] },
    },
  ],
  why: [
    {
      number: 5,
      requirement: "AccessEnded carries the reason the link stopped working.",
      proof: "thin",
      note: "One kind of proof alone: a test run; not recorded: logs.",
      unmet: false,
      lines: { ...ACCESS_LINES, excerpt: [...ACCESS_LINES.excerpt] },
    },
  ],
}

const SCOPE_CRITERIA: Array<DeliveryCriterion> = [
  {
    id: "ends",
    checkpoints: SCOPE_CHECKPOINTS.ends,
    criterion: "Revoking a link ends access immediately",
    status: "met",
    does: "Every page request now checks the link first, so the first request after a revoke is refused.",
    evidence: [
      {
        kind: "source",
        label: "Source",
        target: "lines 9–13",
        markerKey: "scope-check",
        excerpt: [
          "export function assertStillShared(link, viewer) {",
          "  if (!canOpen(link, viewer)) {",
          '    throw new AccessEnded("revoked");',
        ],
      },
    ],
  },
  {
    id: "open",
    checkpoints: SCOPE_CHECKPOINTS.open,
    criterion: "Open documents lose access too",
    status: "not-met",
    does: "A document that is already open makes no further page requests, so it keeps showing its content after the revoke.",
    evidence: [
      {
        kind: "doc",
        label: "Doc",
        target: "SHR-212 · scope",
        markerKey: "scope-open",
      },
    ],
  },
  {
    id: "why",
    checkpoints: SCOPE_CHECKPOINTS.why,
    criterion: "Viewers see why access ended",
    status: "no-evidence",
    does: "The check throws AccessEnded, but nothing in this change shows the viewer a reason.",
    evidence: [
      {
        kind: "gap",
        label: "Gap",
        target: "AccessEnded",
        markerKey: "scope-gap",
      },
    ],
  },
]

const SCOPE_MESSAGE =
  "Not covered yet:\n1. Documents that are already open keep their content after a revoke. Tell open documents to re-check the link.\n2. Nothing shows the viewer why access ended. Render AccessEnded with its reason."

export const scopeDeliveryPayload: DeliveryPayload = {
  // No flow, terms or Explained text, so no Explained.
  stops: ["facts", "briefed", "guided"],
  language: "typescript",
  languageName: "TypeScript",
  facts: [
    {
      kind: "text",
      text: "Every page request now checks the share link again ",
    },
    {
      kind: "cite",
      label: "Source",
      markerKey: "scope-check",
      ariaLabel: "Source, lines 9–13",
    },
    { kind: "text", text: "; documents already open are not rechecked " },
    {
      kind: "cite",
      label: "Doc",
      markerKey: "scope-open",
      ariaLabel: "Doc, line 4",
    },
    { kind: "text", text: "." },
  ],
  check: {
    ticket: {
      id: "SHR-212",
      title: "Revoked links keep working for open sessions",
    },
    basis: "scope",
    criteria: SCOPE_CRITERIA,
    suggestion: { decision: "request_changes", message: SCOPE_MESSAGE },
  },
}

export const scopeDeliveryUnit: ReviewDeskData["unit"] = {
  id: SCOPE_UNIT_ID,
  title: SCOPE_UNIT_TITLE,
  lane: "human-required",
  position: { index: 4, of: 4 },
  briefing: [
    {
      kind: "text",
      text: "A revoked link used to keep serving pages until the viewer reloaded. Every page request now checks the link first and throws AccessEnded ",
    },
    {
      kind: "cite",
      label: "Source",
      markerKey: "scope-check",
      ariaLabel: "Source, lines 9–13",
    },
    {
      kind: "text",
      text: ". Documents already open make no further requests, so they keep their content ",
    },
    {
      kind: "cite",
      label: "Doc",
      markerKey: "scope-open",
      ariaLabel: "Doc, line 4",
    },
    { kind: "text", text: ". Nothing shows the viewer why access ended " },
    {
      kind: "cite",
      label: "Gap",
      markerKey: "scope-gap",
      ariaLabel: "Gap, line 11",
    },
    { kind: "text", text: "." },
  ],
  stats: "1 file · 1 hunk · 3 markers",
  hunkCount: 1,
  scopeLabel: "1 hunk",
  defaultAttachment: "scope-open",
  draftSuggestion:
    "Tell open documents to re-check the link, and show viewers why access ended.",
  scopeNote: `Only this unit’s human-required hunk in ${SCOPE_FILE_PATH}.`,
  agentId: "i1",
}

/* ── Gathered scope (round 4.3) ───────────────────────────
 * The Go unit when no usable ticket is linked: the harness gathers the
 * scope from the change itself, its history, the blast radius and earlier
 * reviews (round-4.md, "Scope is always gathered"). The intent line is the
 * card's title and there is no ticket id; the evidence is mostly Source and
 * History, as on the Verdicts board's Gathered scope card.
 */

/** History and an earlier review, cited only by the gathered rows. */
export const gatheredMarkers: Record<string, ContextualMarker> = {
  ...goMarkers,
  "go-history": marker({
    key: "go-history",
    tone: "history",
    short: "History",
    target: "4e1a7c2",
    peek: "The commit says busy writes should retry instead of failing the sync.",
    kindLabel: "History · commit",
    title: "4e1a7c2 · Retry index writes on SQLITE_BUSY",
    meta: "commit 4e1a7c2 · internal/index/writer.go",
    quote: "Retry index writes on SQLITE_BUSY instead of failing the sync.",
    applies: "States the intent of this change in the author's words.",
    sheetKind: "History",
    blocks: [
      {
        kind: "quote",
        text: "Retry index writes on SQLITE_BUSY instead of failing the sync.",
      },
    ],
  }),
  "go-review": marker({
    key: "go-review",
    tone: "history",
    short: "History",
    target: "earlier review",
    peek: "An earlier review of writer.go asked for a test that forces busy.",
    kindLabel: "History · earlier review",
    title: "Review of writer.go · 9b20d4f",
    meta: "earlier review · 9b20d4f",
    quote: "Please add a test that makes the database report busy.",
    applies: "The busy path still has no test.",
    sheetKind: "History",
    blocks: [
      {
        kind: "quote",
        text: "Please add a test that makes the database report busy.",
      },
    ],
  }),
}

const GATHERED_CRITERIA: Array<DeliveryCriterion> = [
  {
    id: "retry",
    criterion: "Writes retry instead of failing",
    status: "met",
    does: "Commit now tries up to three times, waiting a little longer each time, as the commit message says it should.",
    evidence: [
      {
        kind: "source",
        label: "Source",
        target: "lines 29–36",
        markerKey: "go-retry",
        excerpt: [
          "for attempt := range maxAttempts {",
          "    err := w.commitOnce(ctx, b)",
          "    …",
          "return ErrIndexBusy",
        ],
      },
      {
        kind: "history",
        label: "History",
        target: "commit 4e1a7c2",
        markerKey: "go-history",
      },
    ],
  },
  {
    id: "cancel",
    criterion: "Callers keep their cancellation",
    status: "not-met",
    does: "Three callers pass a context to Commit, but the wait between attempts ignores it, so a cancelled caller still waits.",
    evidence: [
      {
        kind: "graph",
        label: "Graph",
        target: "3 callers",
        markerKey: "go-graph",
      },
      {
        kind: "source",
        label: "Source",
        target: "line 34",
        excerpt: ["time.Sleep(backoff(attempt))"],
      },
    ],
  },
  {
    id: "test",
    criterion: "Busy path tested",
    status: "no-evidence",
    does: "An earlier review asked for a test that forces busy; none exists yet.",
    evidence: [
      {
        kind: "history",
        label: "History",
        target: "earlier review asked for one",
        markerKey: "go-review",
      },
    ],
  },
]

const GATHERED_MESSAGE =
  "Not covered yet:\n1. A cancelled caller still waits: the retry sleeps with time.Sleep. Wait on a timer and ctx.Done() together.\n2. The busy path has no test, as an earlier review asked. Add one that forces ErrBusy."

/** The Go payload with a gathered scope in place of SHR-318's "Done when". */
export const gatheredDeliveryPayload: DeliveryPayload = {
  ...goDeliveryPayload,
  check: {
    ticket: { title: "Retry index writes when SQLite reports busy" },
    basis: "gathered",
    criteria: GATHERED_CRITERIA,
    suggestion: { decision: "request_changes", message: GATHERED_MESSAGE },
  },
}

/**
 * Code and history only: the commit, and writer.go's log (no earlier
 * review, which would link the change).
 */
export const unlinkedMarkers: Record<string, ContextualMarker> = {
  ...goMarkers,
  "go-history": gatheredMarkers["go-history"]!,
  "go-writer-log": marker({
    key: "go-writer-log",
    tone: "history",
    short: "History",
    target: "writer.go log",
    peek: "No earlier commit to writer.go retried an error.",
    kindLabel: "History · file log",
    title: "internal/index/writer.go · earlier commits",
    meta: `git log · ${GO_FILE_PATH} · 3 commits`,
    quote: "c94e3a1 Return write errors to the caller",
    applies:
      "No earlier commit to writer.go retried an error, so history doesn't say which errors the retry should cover.",
    sheetKind: "History",
    blocks: [
      {
        kind: "rows",
        mono: true,
        rows: [
          { mark: "◦", label: "Batch index writes per sync", meta: "7d21b0e" },
          {
            mark: "◦",
            label: "Return write errors to the caller",
            meta: "c94e3a1",
          },
          { mark: "◦", label: "Add the index writer", meta: "18f6d52" },
        ],
      },
    ],
  }),
}

const UNLINKED_CRITERIA: Array<DeliveryCriterion> = [
  {
    id: "retry",
    criterion: "Writes retry instead of failing",
    status: "met",
    does: "Commit now tries up to three times, waiting a little longer each time, as the commit message says it should.",
    evidence: [
      {
        kind: "source",
        label: "Source",
        target: "lines 29–36",
        markerKey: "go-retry",
        excerpt: [
          "for attempt := range maxAttempts {",
          "    err := w.commitOnce(ctx, b)",
          "    …",
          "return ErrIndexBusy",
        ],
      },
      {
        kind: "history",
        label: "History",
        target: "commit 4e1a7c2",
        markerKey: "go-history",
      },
    ],
  },
  {
    id: "cancel",
    criterion: "Callers keep their cancellation",
    status: "no-evidence",
    does: "The wait between attempts ignores the caller's context, and neither the code nor its history says whether a cancelled caller should stop waiting.",
    evidence: [
      {
        kind: "source",
        label: "Source",
        target: "line 34",
        excerpt: ["time.Sleep(backoff(attempt))"],
      },
    ],
  },
  {
    id: "busy",
    criterion: "Busy is the only error retried",
    status: "no-evidence",
    does: "Only ErrBusy is retried; earlier commits to writer.go never retried any error, so history doesn't say which errors should be.",
    evidence: [
      {
        kind: "source",
        label: "Source",
        target: "lines 31–33",
        excerpt: [
          "if !errors.Is(err, sqlite.ErrBusy) {",
          "    return err",
          "}",
        ],
      },
      {
        kind: "history",
        label: "History",
        target: "writer.go log",
        markerKey: "go-writer-log",
      },
    ],
  },
]

const UNLINKED_MESSAGE =
  "Not covered yet:\n1. A cancelled caller still waits: the retry sleeps with time.Sleep. Wait on a timer and ctx.Done() together, or say why not.\n2. Only busy errors are retried. Which errors should the retry cover?"

/**
 * A gathered scope the harness reports as unlinked: no ticket, doc,
 * recorded decision or earlier review connects to the change, so all its
 * evidence comes from the code and its history. A row can still be Covered
 * (here by the commit message); the others have no evidence.
 */
export const unlinkedGatheredDeliveryPayload: DeliveryPayload = {
  ...goDeliveryPayload,
  check: {
    ticket: { title: "Retry index writes when SQLite reports busy" },
    basis: "gathered",
    unlinked: true,
    criteria: UNLINKED_CRITERIA,
    suggestion: { decision: "request_changes", message: UNLINKED_MESSAGE },
  },
}
