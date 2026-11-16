import * as React from "react"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"

import {
  agentReviewCommentFixtures,
  markerKindFixtures,
  reviewCommentFixtures,
  reviewDeskFixture,
  reviewThreadFixtures,
  threadStateFixtures,
} from "@workspace/ui/fixtures/review-batch.fixtures"
import { contextReferenceFixtures } from "@workspace/ui/fixtures/context-reference.fixtures"
import {
  DeskFeedbackContext,
  FeedbackSinkContext,
} from "@workspace/ui/neuve/review-desk/feedback/atoms"
import { storyFeedbackSink } from "@workspace/ui/neuve/story-kit/feedback"
import {
  DraftPin,
  HiddenMarkersPin,
  HintBubble,
  MarginLine,
  MarginPin,
  groupMarkerAnchors,
} from "@workspace/ui/neuve/review-desk/context-margin"
import {
  OWNED_REVISION,
  OWNED_UNIT_ID,
  SIBLING_UNIT_ID,
  ownedRangesFile,
} from "@workspace/ui/fixtures/owned-ranges.fixtures"
import {
  CitationChip,
  FAMILY_STYLE,
  markerFamily,
  markerKind,
} from "@workspace/ui/neuve/shared/marker-kind"
import { CommentPreviewCard } from "@workspace/ui/neuve/review-desk/thread-card"
import type { ReviewThread } from "@workspace/ui/neuve/review-comments/thread"
import {
  CardFrame,
  FileFrame,
  FloatingFrame,
  MarginLineFrame,
  SheetFrame,
  ThreadFrame,
  onPaper,
} from "@workspace/ui/neuve/story-kit/frames"
import { diffRoot, row } from "@workspace/ui/neuve/story-kit/dom"
import {
  clickAt,
  expectFocusVisible,
  placedButton,
  tabTo,
} from "@workspace/ui/neuve/story-kit/play"
import { withReviewDeskState } from "@workspace/ui/neuve/story-kit/store"
import { reviewCommentToMarker } from "@workspace/ui/neuve/review-comments/markers"
import type { ContextualMarker, MarkerAnchor } from "@workspace/ui/neuve/types"

const markers = reviewDeskFixture.markers
const marker = (key: string): ContextualMarker => {
  const found = markers[key]
  if (!found) throw new Error(`Unknown fixture marker ${key}`)
  return found
}
const revokeFile = reviewDeskFixture.files[0]!
const commentMarker = reviewCommentToMarker(reviewCommentFixtures[0]!)

/* ── L0 pins ───────────────────────────────────────────── */

const pinMeta = {
  title: "Review desk/Context margin (L0–L2)",
  component: MarginPin,
  decorators: [onPaper],
  args: {
    marker: marker("conflict"),
    on: false,
    disabled: false,
    onToggle: fn(),
    onHintStart: fn(),
    onHintEnd: fn(),
  },
} satisfies Meta<typeof MarginPin>

export default pinMeta
type PinStory = StoryObj<typeof pinMeta>

const kinds = markerKindFixtures
const kind = (key: keyof typeof markerKindFixtures): ContextualMarker => {
  const found = kinds[key]
  if (!found) throw new Error(`Unknown kind fixture ${key}`)
  return found
}

/**
 * One item of every kind, in priority order (context-markers.md); the
 * review comment is a margin item, not a marker.
 */
const everyKind = (): Array<ContextualMarker> => [
  marker("conflict"),
  kind("decision"),
  kind("failed"),
  kind("gap"),
  kind("unavailable"),
  commentMarker,
  marker("batch"),
  kind("signal"),
  kind("observed"),
  kind("source"),
  marker("graph"),
  marker("history"),
  marker("doc"),
]

/**
 * Every kind in priority order: the icon says what it is, colour says it
 * asks you (magenta needs your decision, amber is missing or failed
 * evidence), a dashed edge says it is not committed, and a review comment
 * pin is its author's avatar (the person's chat bubble). The parked draft is
 * icon only.
 */
export const Kinds: PinStory = {
  render: (args) => (
    <div className="flex max-w-[640px] flex-wrap items-center gap-2">
      {everyKind().map((m) => (
        <MarginPin
          key={m.key}
          {...args}
          marker={m}
          reviewedPath={revokeFile.path}
        />
      ))}
      <DraftPin
        label="L20–23"
        excerpt="Should this also clear the link cache?"
        disabled={false}
        onOpen={fn()}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const pins = [
      ...canvasElement.querySelectorAll<HTMLElement>("button[data-kind]"),
    ]
    await expect(pins.map((pin) => pin.dataset.kind)).toEqual([
      "conflict",
      "decision",
      "failed",
      "gap",
      "unavailable",
      "comment",
      "batch",
      "signal",
      "test",
      "source",
      "graph",
      "history",
      "doc",
      "draft",
    ])
    // The label is the kind, never the file.
    const source = pins.find((pin) => pin.dataset.kind === "source")!
    await expect(source.textContent).toBe("Sourcestart-review-operation.ts")
    for (const pin of pins.filter((p) => p.dataset.kind !== "source"))
      await expect(pin.textContent).not.toMatch(/\.tsx?$/)
  },
}

/** Forced states for review: the classes real hover and focus-visible add. */
const FORCED = {
  rest: () => "",
  hover: (m: ContextualMarker) =>
    FAMILY_STYLE[markerFamily(markerKind(m))].hover.replaceAll("hover:", ""),
  focus: () => "outline-2 outline-offset-2 outline-solid outline-focus",
} as const

/**
 * Rest, hover (one tint step), focus (2px ring, offset 2), open (ink fill),
 * read-only (outline, no colour) and resolved, for each family and a review
 * comment. Only a review comment resolves (a muted ring and a check beside
 * its avatar); a marker has no resolved state, so its cell says so. Hover
 * and focus are forced here; in the desk they come from real pointer hover
 * and focus-visible only.
 */
export const States: PinStory = {
  render: (args) => {
    const rows = [
      marker("conflict"),
      kind("gap"),
      marker("batch"),
      kind("source"),
      commentMarker,
    ]
    const columns = [
      "Rest",
      "Hover",
      "Focus",
      "Open",
      "Read-only",
      "Resolved",
    ] as const
    return (
      <div className="grid w-max grid-cols-[repeat(6,auto)] items-center gap-x-6 gap-y-3">
        {columns.map((column) => (
          <span key={column} className="label-mono text-[10.5px]">
            {column}
          </span>
        ))}
        {rows.flatMap((m) => {
          const comment = m === commentMarker
          return columns.map((column) => (
            <div key={`${m.key}-${column}`} data-cell={`${m.key}-${column}`}>
              {column === "Resolved" && !comment ? (
                <span className="text-[11px] text-faint">
                  <span aria-hidden="true">—</span>
                  <span className="sr-only">Markers are not resolved</span>
                </span>
              ) : (
                <MarginPin
                  {...args}
                  marker={m}
                  reviewedPath={revokeFile.path}
                  rangeLabel={comment ? "L20–23" : undefined}
                  on={column === "Open"}
                  readOnly={column === "Read-only"}
                  resolved={column === "Resolved"}
                  className={
                    column === "Hover"
                      ? comment
                        ? "[&_[data-avatar-slot]]:shadow-[0_0_0_1.5px_var(--nv-line-strong)]"
                        : FORCED.hover(m)
                      : column === "Focus"
                        ? FORCED.focus()
                        : FORCED.rest()
                  }
                />
              )}
            </div>
          ))
        })}
      </div>
    )
  },
  play: async ({ canvasElement }) => {
    const resolved = canvasElement.querySelector<HTMLElement>(
      `[data-cell="${commentMarker.key}-Resolved"] button`
    )!
    await expect(resolved.querySelector("[data-resolved]")).not.toBeNull()
    await expect(resolved.getAttribute("aria-label")).toMatch(
      /^Resolved review comment by /
    )
    // Markers have no resolved pin: the column says so instead.
    await expect(
      canvasElement.querySelector('[data-cell="conflict-Resolved"] button')
    ).toBeNull()
  },
}

/**
 * The target is the cited file, faint after the kind, and only when it is
 * not the file under review. It truncates before the kind does.
 */
export const TargetOnlyFromAnotherFile: PinStory = {
  render: (args) => (
    <div className="flex w-[240px] flex-col items-start gap-2">
      <MarginPin
        {...args}
        marker={kind("source")}
        reviewedPath={revokeFile.path}
      />
      <MarginPin
        {...args}
        marker={kind("sourceHere")}
        reviewedPath={revokeFile.path}
      />
      <div className="w-[120px]">
        <MarginPin
          {...args}
          marker={kind("source")}
          reviewedPath={revokeFile.path}
          className="max-w-full"
        />
      </div>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const [other, here] = canvasElement.querySelectorAll<HTMLElement>(
      'button[data-kind="source"]'
    )
    await expect(other?.textContent).toContain("start-review-operation.ts")
    await expect(here?.textContent).toBe("Source")
  },
}

/**
 * A review comment pin is its author's avatar at 20px, the same bubble as
 * everywhere else. Hover, focus, open and resolved draw around it (resolved
 * adds a small muted check beside it); the avatar itself never changes, not
 * even its opacity. A line with more comments adds the count beside it.
 */
export const CommentPinStates: PinStory = {
  render: (args) => {
    const columns = [
      "Rest",
      "Hover",
      "Focus",
      "Open",
      "Resolved",
      "Two comments",
    ] as const
    return (
      <div className="grid w-max grid-cols-[repeat(6,auto)] items-center gap-x-6 gap-y-3">
        {columns.map((column) => (
          <span key={column} className="label-mono text-[10.5px]">
            {column}
          </span>
        ))}
        {columns.map((column) => (
          <div key={column}>
            <MarginPin
              {...args}
              marker={commentMarker}
              rangeLabel="L20–23"
              on={column === "Open"}
              resolved={column === "Resolved"}
              count={column === "Two comments" ? 2 : 1}
              className={
                column === "Hover"
                  ? "[&_[data-avatar-slot]]:shadow-[0_0_0_1.5px_var(--nv-line-strong)]"
                  : column === "Focus"
                    ? FORCED.focus()
                    : FORCED.rest()
              }
            />
          </div>
        ))}
      </div>
    )
  },
  play: async ({ canvasElement }) => {
    const pins = [
      ...canvasElement.querySelectorAll<HTMLElement>(
        'button[data-kind="comment"]'
      ),
    ]
    await expect(pins).toHaveLength(6)
    const looks = pins.map((pin) => {
      const avatar = pin.querySelector<HTMLElement>('[data-avatar="person"]')!
      // Layout size: the pin's entrance scale does not count.
      return {
        size: [avatar.offsetWidth, avatar.offsetHeight],
        fill: getComputedStyle(avatar).backgroundColor,
        opacity: getComputedStyle(avatar).opacity,
        text: avatar.textContent,
      }
    })
    for (const look of looks) {
      await expect(look.size).toEqual([20, 20])
      await expect(look).toEqual(looks[0])
    }
    // Nothing on the way to the avatar dims it either (once the pins'
    // entrance fade has landed).
    for (const pin of pins)
      await waitFor(() => expect(getComputedStyle(pin).opacity).toBe("1"))
    const ring = (pin: HTMLElement) =>
      getComputedStyle(pin.querySelector("[data-avatar-slot]")!).boxShadow
    await expect(ring(pins[0]!)).toBe("none")
    for (const i of [1, 3, 4]) await expect(ring(pins[i]!)).not.toBe("none")
    const resolved = pins[4]!
    await expect(resolved.querySelector("[data-resolved]")).not.toBeNull()
    await expect(resolved.getAttribute("aria-label")).toMatch(
      /^Resolved review comment by /
    )
    await expect(pins[0]!.querySelector("[data-resolved]")).toBeNull()
    await expect(pins[5]!.dataset.count).toBe("2")
  },
}

const agentCommentMarkers = agentReviewCommentFixtures.map((record) =>
  reviewCommentToMarker(record)
)
const AUTHORS = [
  { label: "Person", marker: commentMarker },
  { label: "Implementer", marker: agentCommentMarkers[0]! },
  { label: "Reviewer", marker: agentCommentMarkers[1]! },
] as const
const AUTHOR_COLUMNS = ["Rest", "Open", "Resolved", "Two comments"] as const

/**
 * Comment pins draw their author's real avatar: a person's bubble or an
 * agent's antenna square. Open and resolved come from the pin's props;
 * hover and focus are real (Tab to a pin, or point at it). On an agent the
 * ring sits outside the dashed edge and the antenna rises; resolved is the
 * plain avatar with a check. Exactly one focus indicator per pin.
 */
export const CommentPinAuthors: PinStory = {
  render: (args) => (
    <div className="flex flex-col gap-8">
      <div className="grid w-max grid-cols-[110px_repeat(4,auto)] items-center gap-x-8 gap-y-4">
        <span />
        {AUTHOR_COLUMNS.map((column) => (
          <span key={column} className="label-mono text-[10.5px]">
            {column}
          </span>
        ))}
        {AUTHORS.map((author) => (
          <React.Fragment key={author.label}>
            <span className="text-[13px] text-ink-2">{author.label}</span>
            {AUTHOR_COLUMNS.map((column) => (
              <div key={column} data-cell={`${author.label}-${column}`}>
                <MarginPin
                  {...args}
                  marker={author.marker}
                  rangeLabel="L20"
                  on={column === "Open"}
                  resolved={column === "Resolved"}
                  count={column === "Two comments" ? 2 : 1}
                />
              </div>
            ))}
          </React.Fragment>
        ))}
      </div>
      <div className="flex flex-wrap items-start gap-6">
        {AUTHORS.map((author) => (
          <HintBubble
            key={author.label}
            text={author.marker.peek}
            comment={{
              author: author.marker.title.replace(/ commented$/, ""),
              initials: author.marker.short,
              avatar: author.marker.author,
              range: "L20",
            }}
          />
        ))}
        <HintBubble
          text=""
          markers={[
            agentCommentMarkers[1]!,
            commentMarker,
            agentCommentMarkers[0]!,
            marker("doc"),
          ]}
        />
      </div>
    </div>
  ),
  play: async ({ canvasElement, userEvent }) => {
    const pin = (author: string, column: string) =>
      canvasElement.querySelector<HTMLElement>(
        `[data-cell="${author}-${column}"] button`
      )!
    const raised = (button: HTMLElement) => {
      const svg = button.querySelector("svg[data-avatar='agent']")!
      return {
        ring: getComputedStyle(svg.querySelector(".nv-pinring")!).opacity,
        tip: getComputedStyle(svg.querySelector(".nv-tip")!).transform,
      }
    }
    const UP = { ring: "1", tip: "matrix(1, 0, 0, 1, 0, -1.6)" }
    const DOWN = { ring: "0", tip: "none" }
    // The author's real avatar, never a bubble for an agent.
    for (const column of AUTHOR_COLUMNS) {
      await expect(
        pin("Person", column).querySelector('[data-avatar="person"]')
      ).not.toBeNull()
      for (const author of ["Implementer", "Reviewer"]) {
        const button = pin(author, column)
        await expect(button.dataset.author).toBe("agent")
        await expect(button.querySelector('[data-avatar="person"]')).toBeNull()
        await expect(
          button.querySelector("svg[data-avatar='agent']")
        ).not.toBeNull()
      }
    }
    await expect(
      pin("Implementer", "Rest").querySelector("svg")!.dataset.role
    ).toBe("implementer")
    await expect(
      pin("Reviewer", "Rest").querySelector("svg")!.dataset.role
    ).toBe("reviewer")
    // Accessible names keep the author's name.
    await expect(pin("Implementer", "Rest").getAttribute("aria-label")).toMatch(
      /^Review comment by Implementer 1 on L20/
    )
    await expect(
      pin("Reviewer", "Resolved").getAttribute("aria-label")
    ).toMatch(/^Resolved review comment by Reviewer 1/)
    // Open raises the ring and antenna; rest and resolved do not.
    await waitFor(() => expect(raised(pin("Implementer", "Open"))).toEqual(UP))
    await expect(raised(pin("Implementer", "Rest"))).toEqual(DOWN)
    await expect(raised(pin("Reviewer", "Resolved"))).toEqual(DOWN)
    await expect(
      pin("Reviewer", "Resolved").querySelector("[data-resolved]")
    ).not.toBeNull()
    // Keyboard: exactly one visible focus indicator per pin.
    const agent = pin("Implementer", "Rest")
    await tabTo(agent, userEvent)
    // An agent's ring is its avatar's (below), never an outline.
    await expectFocusVisible(agent, { ring: false })
    await waitFor(() => expect(raised(agent)).toEqual(UP))
    await expect(
      getComputedStyle(agent.querySelector(".nv-pinring")!).strokeWidth
    ).toBe("1.8px")
    await expect(getComputedStyle(agent).outlineStyle).toBe("none")
    const person = pin("Person", "Rest")
    await tabTo(person, userEvent)
    await waitFor(() => expect(raised(agent)).toEqual(DOWN))
    await expectFocusVisible(person)
    await expect(
      getComputedStyle(person.querySelector("[data-avatar-slot]")!).boxShadow
    ).toBe("none")
    // The preview and the peek draw the same avatars.
    const previews = [
      ...canvasElement.querySelectorAll<HTMLElement>(".w-\\[248px\\]"),
    ]
    await expect(previews).toHaveLength(3)
    await expect(
      previews.map((preview) =>
        preview.querySelector("[data-avatar]")!.getAttribute("data-avatar")
      )
    ).toEqual(["person", "agent", "agent"])
    const peek = canvasElement.querySelector<HTMLElement>("[data-peek]")!
    await expect(
      [...peek.querySelectorAll("[data-avatar]")].map((avatar) =>
        avatar.getAttribute("data-size")
      )
    ).toEqual(["16", "16", "16"])
  },
}

export const CommentPinAuthorsDark: PinStory = {
  ...CommentPinAuthors,
  globals: { theme: "dark" },
}

/** A `review comment` marker pin (open body). */
export const ReviewComment: PinStory = {
  args: { marker: commentMarker, on: true },
}

/** The pin whose card is open: inverted ink tone, aria-expanded. */
export const On: PinStory = { args: { on: true } }

/**
 * Shared with other units: one small dot per other unit (max 3) in the pin's
 * own colour at 50% — Doc (1), Graph (2), Conflict (1), and History (none).
 * The accessible name says kind, line and units.
 */
export const SharedDots: PinStory = {
  render: (args) => (
    <div className="flex flex-wrap gap-1.5">
      {["doc", "graph", "conflict", "history"].map((key) => (
        <MarginPin key={key} {...args} marker={marker(key)} lineNumber={22} />
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    const graph = canvasElement.querySelector<HTMLElement>(
      'button[data-kind="graph"]'
    )
    await expect(graph?.getAttribute("data-shared")).toBe("2")
    await expect(graph?.getAttribute("aria-label")).toBe(
      "Graph on line 22, shared with 2 units"
    )
    const history = canvasElement.querySelector<HTMLElement>(
      'button[data-kind="history"]'
    )
    await expect(history?.hasAttribute("data-shared")).toBe(false)
  },
}

/** A read-only neighbor's own context: muted outline pin. */
export const ReadOnlyPin: PinStory = {
  args: { marker: marker("doc"), readOnly: true },
}

export const Disabled: PinStory = {
  args: { disabled: true },
  render: (args) => (
    <div className="opacity-35">
      <MarginPin {...args} />
    </div>
  ),
}

/**
 * Markers in collapsed lines wait on the gap row as one outlined pin;
 * clicking it opens the gap (the diff renders it opposite the gap row).
 */
export const HiddenPin: PinStory = {
  render: () => <HiddenMarkersPin count={2} onOpen={fn()} />,
  play: async ({ canvas }) => {
    await expect(
      canvas.getByRole("button", {
        name: "2 markers in hidden lines. Show the lines",
      })
    ).toHaveTextContent("2 hidden")
  },
}

/**
 * Briefing citation chips: the cited marker's kind icon and family tint, ↓
 * when it lands in the diff. A chip whose marker this view does not have is
 * neutral with no icon; it never claims a kind.
 */
export const CitationChips: PinStory = {
  render: () => (
    <p className="m-0 flex max-w-[560px] flex-wrap items-baseline gap-2 text-[15px] leading-6 text-ink-2">
      <CitationChip kind="conflict" label="1" onClick={fn()} />
      <CitationChip kind="gap" label="2" onClick={fn()} />
      <CitationChip kind="batch" label="3" onClick={fn()} />
      <CitationChip
        kind="source"
        label="Prepared request policy"
        onClick={fn()}
      />
      <CitationChip kind="failed" label="exit 1" lands={false} onClick={fn()} />
      <CitationChip label="Unknown citation" onClick={fn()} />
    </p>
  ),
  play: async ({ canvas }) => {
    const unknown = canvas.getByRole("button", { name: /Unknown citation/ })
    await expect(unknown.querySelector("svg")).toBeNull()
  },
}

/* ── One line of the margin (L0 → L1 → list → L2) ──────── */

const lineAnchor = (markerKey: string): MarkerAnchor => ({
  markerKey,
  side: "additions",
  lineNumber: 23,
})
const sharedLine = () =>
  groupMarkerAnchors(["doc", "batch", "conflict"].map(lineAnchor), markers)[0]!
/** A lone Gap marker on line 23. */
const gapLine = () =>
  groupMarkerAnchors([lineAnchor(kind("gap").key)], {
    [kind("gap").key]: kind("gap"),
  })[0]!

/**
 * Three markers on line 23: the pin shows the highest kind (Conflict
 * outranks Same batch and Doc) with a count. Hover raises the light peek
 * with one row per marker; the count opens the line's list; a row opens its
 * card.
 */
export const SharedLine: PinStory = {
  decorators: [withReviewDeskState()],
  render: () => <MarginLineFrame group={sharedLine()} />,
  play: async ({ canvas, canvasElement, userEvent }) => {
    const doc = canvasElement.ownerDocument
    const pin = await placedButton(
      canvasElement,
      "Conflict on line 23, 3 markers, shared with 2 units"
    )
    await expect(pin.dataset.count).toBe("3")
    await expect(pin).toHaveAttribute("aria-haspopup", "dialog")
    await userEvent.hover(pin)
    const peek = await waitFor(() => {
      const found = doc.querySelector<HTMLElement>("[data-peek]")
      expect(found).toBeVisible()
      return found!
    })
    await expect(peek.children).toHaveLength(3)
    await userEvent.click(pin)
    const list = await waitFor(() => {
      const found = doc.querySelector<HTMLElement>("[data-line-list]")
      expect(found).toBeVisible()
      return found!
    })
    await expect(pin).toHaveAttribute("aria-expanded", "true")
    await expect(doc.querySelector("[data-peek]")).toBeNull()
    const rows = list.querySelectorAll<HTMLButtonElement>("button")
    await expect(rows).toHaveLength(3)
    await userEvent.click(rows[1]!)
    await waitFor(() =>
      expect(
        doc.querySelector('[data-floating-card][aria-label="invalidateByLink"]')
      ).toBeVisible()
    )
    await expect(doc.querySelector("[data-line-list]")).toBeNull()
  },
}

/**
 * A card chosen from the line's list leads with a back chevron: it (or
 * Escape) returns to the same list, focus on the row that was open. A
 * further Escape closes the list.
 */
export const SharedLineBackToList: PinStory = {
  decorators: [withReviewDeskState()],
  render: () => <MarginLineFrame group={sharedLine()} />,
  play: async ({ canvasElement, userEvent }) => {
    const doc = canvasElement.ownerDocument
    const list = () => doc.querySelector<HTMLElement>("[data-line-list]")
    const rows = () => [
      ...list()!.querySelectorAll<HTMLButtonElement>("button"),
    ]
    const card = () =>
      doc.querySelector<HTMLElement>(
        '[data-floating-card][aria-label="invalidateByLink"]'
      )
    await userEvent.click(
      await placedButton(canvasElement, /^Conflict on line 23/)
    )
    await waitFor(() => expect(list()).toBeVisible())
    await userEvent.click(rows()[1]!)
    await waitFor(() => expect(card()).toBeVisible())
    const back = within(card()!).getByRole("button", {
      name: "Back to 3 markers",
    })
    // The chosen row is gone; focus lands on the back control.
    await waitFor(() => expect(doc.activeElement).toBe(back))
    await userEvent.click(back)
    await waitFor(() => expect(list()).toBeVisible())
    await expect(card()).toBeNull()
    await expect(rows()).toHaveLength(3)
    await waitFor(() => expect(doc.activeElement).toBe(rows()[1]))

    // Escape steps back the same way, then closes the list.
    await userEvent.keyboard("{Enter}")
    await waitFor(() => expect(card()).toBeVisible())
    await waitFor(() =>
      expect(doc.activeElement).toHaveAttribute("data-card-back")
    )
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(list()).toBeVisible())
    await waitFor(() => expect(doc.activeElement).toBe(rows()[1]))
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(list()).toBeNull())
  },
}

/**
 * A review comment shares the line with a Same batch marker: its row opens
 * the comment's thread, which leads with the same back chevron. It (or
 * Escape) returns to the list, focus on the comment's row.
 */
export const SharedLineThreadBackToList: PinStory = {
  decorators: [withReviewDeskState({}, undefined, { threads: [] })],
  render: () => (
    <div className="flex w-[300px]">
      <MarginLine
        group={
          groupMarkerAnchors(
            [marker("batch").key, commentMarker.key].map(lineAnchor),
            { ...markers, [commentMarker.key]: commentMarker }
          )[0]!
        }
        filePath={revokeFile.path}
        comments={{ [commentMarker.key]: reviewCommentFixtures[0]! }}
        reviewer={reviewDeskFixture.reviewer}
        agentId="i1"
      />
    </div>
  ),
  play: async ({ canvas, canvasElement, userEvent }) => {
    const doc = canvasElement.ownerDocument
    const list = () => doc.querySelector<HTMLElement>("[data-line-list]")
    const commentRow = () =>
      [...list()!.querySelectorAll<HTMLButtonElement>("button")].find((row) =>
        row.textContent.includes("Review comment")
      )!
    const thread = () =>
      doc.querySelector<HTMLElement>("[data-floating-card] [data-thread-card]")
    await userEvent.click(canvas.getByRole("button", { name: /2 markers/ }))
    await waitFor(() => expect(list()).toBeVisible())
    await userEvent.click(commentRow())
    await waitFor(() => expect(thread()).toBeVisible())
    const back = within(thread()!).getByRole("button", {
      name: "Back to 2 markers",
    })
    await waitFor(() => expect(doc.activeElement).toBe(back))
    await userEvent.click(back)
    await waitFor(() => expect(list()).toBeVisible())
    await expect(thread()).toBeNull()
    await waitFor(() => expect(doc.activeElement).toBe(commentRow()))

    // Escape steps back the same way, then closes the list.
    await userEvent.keyboard("{Enter}")
    await waitFor(() => expect(thread()).toBeVisible())
    await waitFor(() =>
      expect(doc.activeElement).toHaveAttribute("data-card-back")
    )
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(list()).toBeVisible())
    await waitFor(() => expect(doc.activeElement).toBe(commentRow()))
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(list()).toBeNull())
  },
}

/** The line's list open (the count was clicked). */
export const SharedLineListOpen: PinStory = {
  decorators: [withReviewDeskState()],
  render: () => <MarginLineFrame group={sharedLine()} />,
  play: async ({ canvasElement, userEvent }) => {
    await userEvent.click(
      await placedButton(canvasElement, /^Conflict on line 23/)
    )
  },
}

/** A single marker: its click opens the card directly, no list. */
export const SingleLine: PinStory = {
  decorators: [withReviewDeskState()],
  render: () => <MarginLineFrame group={gapLine()} />,
  play: async ({ canvas, canvasElement, userEvent }) => {
    await userEvent.click(
      await placedButton(canvasElement, "Gap on line 23, shared with 2 units")
    )
    await waitFor(() =>
      expect(
        canvasElement.ownerDocument.querySelector(
          '[data-floating-card][aria-label="No test for ReviewLaunchError"]'
        )
      ).toBeVisible()
    )
    // Opened directly from its pin: nothing to go back to.
    await expect(
      canvasElement.ownerDocument.querySelector("[data-card-back]")
    ).toBeNull()
  },
}

/**
 * "Open source" from a card, then "Back to unit": the card waits hidden
 * under the source sheet and is open again on return (F14). A press outside
 * both still dismisses it.
 */
export const BackToUnitReturnsToCard: PinStory = {
  decorators: [withReviewDeskState()],
  render: () => (
    <SheetFrame markers={{ [kind("gap").key]: kind("gap") }}>
      <MarginLineFrame group={gapLine()} />
    </SheetFrame>
  ),
  play: async ({ canvas, canvasElement, userEvent }) => {
    const doc = canvasElement.ownerDocument
    const card = () =>
      doc.querySelector<HTMLElement>(
        '[data-floating-card][aria-label="No test for ReviewLaunchError"]'
      )
    await userEvent.click(
      await placedButton(canvasElement, "Gap on line 23, shared with 2 units")
    )
    await waitFor(() => expect(card()).toBeVisible())
    await userEvent.click(
      card()!.querySelector<HTMLElement>("[data-source-trigger]")!
    )
    const sheet = await waitFor(() => {
      const found = doc.querySelector<HTMLElement>("aside[data-source-sheet]")
      expect(found).toBeVisible()
      return found!
    })
    // Still open, hidden under the sheet.
    await expect(card()).not.toBeNull()
    await expect(card()).not.toBeVisible()
    await userEvent.click(
      within(sheet).getByRole("button", { name: /Back to unit/ })
    )
    await waitFor(() =>
      expect(doc.querySelector("aside[data-source-sheet]")).toBeNull()
    )
    await waitFor(() => expect(card()).toBeVisible())
    await waitFor(() =>
      expect(doc.activeElement).toHaveAttribute("data-source-trigger")
    )
    // Outside both, a press still dismisses the card.
    await clickAt(row(await diffRoot(canvasElement), 23)!)
    await waitFor(() => expect(card()).toBeNull())
  },
}

/**
 * The desk in one column (below 861px): the page scrolls, and the unit
 * column is far taller than the viewport. The line sits deep in it.
 */
function ScrolledColumnFrame({
  markers: sheetMarkers,
  group,
}: {
  markers: Record<string, ContextualMarker>
  group: ReturnType<typeof groupMarkerAnchors>[number]
}) {
  return (
    <SheetFrame markers={sheetMarkers} height={3200} className="pt-[1400px]">
      <MarginLineFrame group={group} />
    </SheetFrame>
  )
}

/** Scrolls the page so `pin` sits 200px below the viewport's top. */
async function scrollPageTo(pin: HTMLElement) {
  const page = pin.ownerDocument.scrollingElement!
  // Again on each try: the file card may still be laying out its rows.
  await waitFor(() => {
    page.scrollTop += pin.getBoundingClientRect().top - 200
    expect(Math.round(pin.getBoundingClientRect().top)).toBe(200)
  })
  return page.scrollTop
}

/** Opens the source sheet from the open card; it opens where the reader is. */
async function openSourceFrom(card: HTMLElement, page: Element, at: number) {
  const doc = card.ownerDocument
  await userEvent.click(
    card.querySelector<HTMLElement>("[data-source-trigger]")!
  )
  const sheet = await waitFor(() => {
    const found = doc.querySelector<HTMLElement>("aside[data-source-sheet]")
    expect(found).toBeVisible()
    return found!
  })
  const back = within(sheet).getByRole("button", { name: /Back to unit/ })
  await waitFor(() => expect(doc.activeElement).toBe(back))
  // The page did not move, and the sheet's header is on screen.
  await expect(page.scrollTop).toBe(at)
  const { top, bottom } = back.getBoundingClientRect()
  await expect(top).toBeGreaterThanOrEqual(0)
  await expect(bottom).toBeLessThanOrEqual(doc.defaultView!.innerHeight)
  return back
}

/**
 * "Back to unit" from a line deep in a scrolled page: the page stays where
 * the reader left it, the card is open on its pin again and focus is on
 * "Open source". Opening the sheet must not scroll the page to the column's
 * top either.
 */
export const BackToUnitKeepsScroll: PinStory = {
  decorators: [withReviewDeskState()],
  render: () => (
    <ScrolledColumnFrame
      markers={{ [kind("gap").key]: kind("gap") }}
      group={gapLine()}
    />
  ),
  play: async ({ canvasElement, userEvent }) => {
    const doc = canvasElement.ownerDocument
    const card = () =>
      doc.querySelector<HTMLElement>(
        '[data-floating-card][aria-label="No test for ReviewLaunchError"]'
      )
    const pin = await placedButton(
      canvasElement,
      "Gap on line 23, shared with 2 units"
    )
    const page = doc.scrollingElement!
    const at = await scrollPageTo(pin)
    await expect(at).toBeGreaterThan(1000)
    await userEvent.click(pin)
    await waitFor(() => expect(card()).toBeVisible())
    const back = await openSourceFrom(card()!, page, at)
    await userEvent.click(back)
    await waitFor(() =>
      expect(doc.querySelector("aside[data-source-sheet]")).toBeNull()
    )
    await waitFor(() =>
      expect(doc.activeElement).toHaveAttribute("data-source-trigger")
    )
    await expect(page.scrollTop).toBe(at)
    await expect(card()).toBeVisible()
  },
}

/**
 * The same from a line's list: back from the sheet to the row's card, then
 * Escape returns to the list, on screen, focus on the row that opened it.
 */
export const BackToUnitFromListKeepsScroll: PinStory = {
  decorators: [withReviewDeskState()],
  render: () => <ScrolledColumnFrame markers={markers} group={sharedLine()} />,
  play: async ({ canvasElement, userEvent }) => {
    const doc = canvasElement.ownerDocument
    const list = () => doc.querySelector<HTMLElement>("[data-line-list]")
    const rows = () => [
      ...list()!.querySelectorAll<HTMLButtonElement>("button"),
    ]
    const card = () =>
      doc.querySelector<HTMLElement>(
        '[data-floating-card][aria-label="invalidateByLink"]'
      )
    const pin = await placedButton(canvasElement, /^Conflict on line 23/)
    const page = doc.scrollingElement!
    const at = await scrollPageTo(pin)
    await userEvent.click(pin)
    await waitFor(() => expect(list()).toBeVisible())
    await userEvent.click(rows()[1]!)
    await waitFor(() => expect(card()).toBeVisible())
    const back = await openSourceFrom(card()!, page, at)
    await userEvent.keyboard("{Enter}")
    await waitFor(() =>
      expect(doc.querySelector("aside[data-source-sheet]")).toBeNull()
    )
    await waitFor(() =>
      expect(doc.activeElement).toHaveAttribute("data-source-trigger")
    )
    await expect(back.isConnected).toBe(false)
    await expect(page.scrollTop).toBe(at)
    await expect(card()).toBeVisible()
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(list()).toBeVisible())
    await waitFor(() => expect(doc.activeElement).toBe(rows()[1]))
    await expect(page.scrollTop).toBe(at)
  },
}

/**
 * Lines a sibling unit owns, named by the BFF's `siblingSource` (unit id,
 * title, lane): in the whole file they show read-only with an owner chip
 * (lock, lane glyph, title) linking to that unit.
 */
export const SiblingRowNamesOwner: PinStory = {
  decorators: [withReviewDeskState()],
  render: () => (
    <FileFrame
      file={ownedRangesFile}
      markers={{}}
      commentContext={{
        unitId: OWNED_UNIT_ID,
        revision: OWNED_REVISION,
        author: reviewDeskFixture.reviewer,
      }}
    />
  ),
  play: async ({ canvas }) => {
    const owner = ownedRangesFile.responsibility?.siblingSource?.[0]
    await expect(owner?.unitId).toBe(SIBLING_UNIT_ID)
    await userEvent.click(
      await canvas.findByRole("radio", { name: "Whole file" })
    )
    const link = await canvas.findByRole("link", {
      name: `L142 owned by ${owner?.title}, Agentic review. Open unit`,
    })
    await expect(link).toBeVisible()
    await expect(link).toHaveTextContent(owner!.title)
  },
}

/** L1 peek, static: a light card, never a grey translucent tooltip. */
export const Peek: PinStory = {
  render: () => (
    <div className="flex items-start gap-6">
      <HintBubble
        text=""
        markers={[marker("conflict"), marker("batch"), marker("doc")]}
      />
      <HintBubble text="" markers={[kind("gap")]} />
    </div>
  ),
}

/* ── L2 cards ──────────────────────────────────────────── */

/** Conflict: the two sources side by side, "vs". */
export const CardConflictingIntent: PinStory = {
  render: () => <CardFrame marker={marker("conflict")} />,
}
/** Same batch · unreviewed: the helper as a wrapping, highlighted snippet. */
export const CardSameBatch: PinStory = {
  render: () => <CardFrame marker={marker("batch")} />,
}
/** Evidence gap: the asserting line, highlighted. */
export const CardEvidenceGap: PinStory = {
  render: () => <CardFrame marker={marker("test")} />,
}
/** Doc · committed: the cited sentence as a quote. */
export const CardDocumentation: PinStory = {
  render: () => <CardFrame marker={marker("doc")} />,
}
/** Graph · blast radius: the read-by tree, "not traced" in red. */
export const CardCommittedGraph: PinStory = {
  render: () => <CardFrame marker={marker("graph")} />,
}
/** Regression history: the incident as a quote. */
export const CardRegressionHistory: PinStory = {
  render: () => <CardFrame marker={marker("history")} />,
}

/** Evidence gap: amber tile, dashed circle. */
export const CardGap: PinStory = {
  render: () => <CardFrame marker={kind("gap")} />,
}
/** Linked evidence unavailable: the dashed circle with an x. */
export const CardUnavailable: PinStory = {
  render: () => <CardFrame marker={kind("unavailable")} />,
}
/** Recorded decision signal: magenta flag, it needs your decision. */
export const CardDecision: PinStory = {
  render: () => <CardFrame marker={kind("decision")} />,
}
/** Recorded contextual signal: neutral, activity. */
export const CardSignal: PinStory = {
  render: () => <CardFrame marker={kind("signal")} />,
}
/** Captured source: code. */
export const CardSource: PinStory = {
  render: () => <CardFrame marker={kind("source")} />,
}
/** A usable recorded check: neutral flask. */
export const CardObservedTest: PinStory = {
  render: () => <CardFrame marker={kind("observed")} />,
}
/** A failed check: amber, the flask struck through. */
export const CardFailed: PinStory = {
  render: () => <CardFrame marker={kind("failed")} />,
}

/* ── L2 cards: context references from a real review ─── */

const references = contextReferenceFixtures

/**
 * A reference's card says why it is here before anything else: the file
 * (name, then folder), then its reason led by one word for how it bears on
 * the change, then what to check. No code (the sheet holds it), no repeat of
 * the lines the diff tints, no grade unless the owner's feedback is on, no
 * internal labels.
 */
async function expectReferenceCard(canvasElement: HTMLElement, lead: string) {
  const card = within(
    canvasElement.querySelector<HTMLElement>("[data-context-card]")!
  )
  // After the card's entrance fade.
  await waitFor(() => expect(card.getByText(`${lead}.`)).toBeVisible())
  await expect(card.getByText("Before you decide")).toBeVisible()
  const text = canvasElement.textContent
  await expect(text).not.toMatch(
    /recorded contextual signal|necessary|useful|needed to decide|lines 585|5fa1ba9|c0c47ce|more lines/i
  )
}

/** Supports: unreviewed work of the same batch (the dashed tile). */
export const CardReferenceSupports: PinStory = {
  render: () => <CardFrame marker={references.supports} />,
  play: ({ canvasElement }) => expectReferenceCard(canvasElement, "Supports"),
}
/** Background: committed code the change relies on. */
export const CardReferenceBackground: PinStory = {
  render: () => <CardFrame marker={references.background} />,
  play: ({ canvasElement }) => expectReferenceCard(canvasElement, "Background"),
}
/**
 * An unresolved stance: "Unclear fit", muted, so it never reads as support.
 */
export const CardReferenceUnchecked: PinStory = {
  render: () => <CardFrame marker={references.unchecked} />,
  play: ({ canvasElement }) =>
    expectReferenceCard(canvasElement, "Unclear fit"),
}
/** The desk's feedback on one reference card, as the BFF sends it. */
function WithReferenceFeedback({
  marker: card,
  children,
}: {
  marker: ContextualMarker
  children: React.ReactNode
}) {
  return (
    <DeskFeedbackContext.Provider
      value={{
        findings: {},
        digests: {},
        references: {
          [card.key]: { target: card.key, harnessGrade: "necessary" },
        },
      }}
    >
      <FeedbackSinkContext.Provider value={storyFeedbackSink()}>
        {children}
      </FeedbackSinkContext.Provider>
    </DeskFeedbackContext.Provider>
  )
}

/**
 * With the owner's feedback on (10.107), the card shows the harness's grade
 * in the words the owner grades with, then "Give feedback" beside "Open
 * source"; the grade and the rubric wait in its layer, so the card stays
 * what the reader reads.
 */
export const CardReferenceWithFeedback: PinStory = {
  render: () => (
    <WithReferenceFeedback marker={references.background}>
      <CardFrame marker={references.background} />
    </WithReferenceFeedback>
  ),
  play: async ({ canvasElement }) => {
    const card = within(
      canvasElement.querySelector<HTMLElement>("[data-context-card]")!
    )
    await waitFor(() =>
      expect(card.getByText("Harness grade: Necessary")).toBeVisible()
    )
    await expect(
      card.getByRole("button", { name: "Give feedback" })
    ).toBeVisible()
    await expect(
      card.getByRole("button", { name: /Open source/ })
    ).toBeVisible()
    await expect(
      card.queryByRole("form", { name: "Feedback on this reference" })
    ).toBeNull()
  },
}

/**
 * A reference with no "Before you decide" check: its layer never asks
 * whether the check is actionable, and the other four rows stay.
 */
export const CardReferenceFeedbackNoCheck: PinStory = {
  render: () => {
    const { check: _check, ...noCheck } = references.background
    return (
      <WithReferenceFeedback marker={noCheck}>
        <CardFrame marker={noCheck} />
      </WithReferenceFeedback>
    )
  },
  play: async ({ canvasElement, userEvent }) => {
    const card = within(
      canvasElement.querySelector<HTMLElement>("[data-context-card]")!
    )
    await waitFor(() =>
      expect(card.queryByText("Before you decide")).toBeNull()
    )
    await userEvent.click(card.getByRole("button", { name: "Give feedback" }))
    const page = within(canvasElement.ownerDocument.body)
    const form = within(
      await waitFor(() =>
        page.getByRole("form", { name: "Feedback on this reference" })
      )
    )
    for (const legend of [
      "This reference is",
      "Says why it's here",
      "Tied to these lines",
      "Accurate",
      "Length",
    ])
      // After the layer's fade-in.
      await waitFor(() =>
        expect(form.getByRole("group", { name: legend })).toBeVisible()
      )
    await expect(
      form.queryByRole("group", { name: "Check is actionable" })
    ).toBeNull()
  },
}
/** L1 peek of references: the file, then the reason led by its stance. */
export const PeekReferences: PinStory = {
  render: () => (
    <HintBubble
      text=""
      markers={[
        references.supports,
        references.background,
        references.unchecked,
      ]}
    />
  ),
}

/**
 * The graph tree's truncated file expands to its full `path:line` in a
 * tooltip, on real hover or keyboard focus, wrapped inside the card. The
 * play focuses a path by keyboard, then points at another.
 */
export const CardGraphPathTooltip: PinStory = {
  decorators: [withReviewDeskState()],
  render: () => <CardFrame marker={marker("graph")} />,
  play: async ({ canvasElement, userEvent }) => {
    const doc = canvasElement.ownerDocument
    const card = doc.querySelector<HTMLElement>("[data-context-card]")!
    const tipText = () =>
      doc.querySelector<HTMLElement>("[data-floating-hint] [data-tip-text]")
    // Keyboard: the truncated path is a tab stop named by its full path.
    // (Synthetic key events never count as :focus-visible, so the play
    // drives the tooltip by real-pointer hover; focus-visible opens it the
    // same way in a browser.)
    await userEvent.tab()
    await userEvent.tab()
    await expect(doc.activeElement?.getAttribute("aria-label")).toBe(
      "src/sharing/access-policy.ts:41"
    )
    await userEvent.hover(
      canvasElement.querySelector<HTMLElement>('[data-tree-row="1"]')!
    )
    const tip = await waitFor(() => {
      expect(tipText()?.textContent).toBe("src/sharing/access-policy.ts:41")
      return tipText()!
    })
    await waitFor(() => {
      const cardBox = card.getBoundingClientRect()
      const tipBox = tip.getBoundingClientRect()
      expect(tipBox.right).toBeLessThanOrEqual(cardBox.right + 0.5)
      expect(tipBox.left).toBeGreaterThanOrEqual(cardBox.left - 0.5)
    })
    await userEvent.hover(
      canvasElement.querySelector<HTMLElement>('[data-tree-row="4"]')!
    )
    await waitFor(() =>
      expect(tipText()?.textContent).toBe("src/cache/links.ts:8")
    )
  },
}

/* ── Comment threads ───────────────────────────────────── */

const sessionsRecord = reviewCommentFixtures[0]!

const threadStory = (thread: ReviewThread | undefined): PinStory => ({
  decorators: [
    withReviewDeskState({}, undefined, {
      threads: thread ? [thread] : [],
    }),
  ],
  render: () => <ThreadFrame thread={thread} />,
})

/**
 * A comment R1 (the reviewer agent) wrote: the thread and its preview lead
 * with R1's antenna square, never a person's bubble.
 */
export const AgentCommentThread: PinStory = {
  decorators: [withReviewDeskState({}, undefined, { threads: [] })],
  render: () => (
    <div className="flex items-start gap-6">
      <ThreadFrame
        thread={undefined}
        record={agentReviewCommentFixtures[1]}
        rangeLabel="L20"
      />
      <FloatingFrame>
        <CommentPreviewCard
          record={agentReviewCommentFixtures[1]!}
          rangeLabel="L20"
          thread={undefined}
          onOpen={fn()}
        />
      </FloatingFrame>
    </div>
  ),
  play: async ({ canvasElement }) => {
    const first = canvasElement.querySelector<HTMLElement>(
      "[data-message-author]"
    )!
    await expect(first.dataset.messageAuthor).toBe("agent")
    await expect(
      first.querySelector('svg[data-avatar="agent"]')!.getAttribute("data-role")
    ).toBe("reviewer")
    const preview = canvasElement.querySelector<HTMLElement>(
      "[data-comment-preview]"
    )!
    await expect(preview.querySelector('[data-avatar="person"]')).toBeNull()
    await expect(
      preview.querySelector('svg[data-avatar="agent"]')
    ).not.toBeNull()
  },
}

/** Replied: the comment and Implementer 1's reply; the reply box is open. */
export const ThreadReplied: PinStory = threadStory(reviewThreadFixtures[0])
/** Your follow-up is queued: it reaches I1 when it's free. */
export const ThreadQueued: PinStory = threadStory(threadStateFixtures.queued)
/** Sent to I1 (no read receipts exist in ACP). */
export const ThreadSent: PinStory = threadStory(threadStateFixtures.sent)
/** Picked up: I1's turn started. */
export const ThreadPickedUp: PinStory = threadStory(
  threadStateFixtures["picked-up"]
)
/** Working: narration and tool calls collapse into "3 steps". */
export const ThreadWorking: PinStory = threadStory(threadStateFixtures.working)
/** Needs your input: Allow once / Deny. */
export const ThreadNeedsInput: PinStory = threadStory(
  threadStateFixtures["needs-input"]
)
/** Failed: the reason and Retry. */
export const ThreadFailed: PinStory = threadStory(threadStateFixtures.failed)
/** Replied with the inner-loop commit as a chip, not a new cycle. */
export const ThreadRepliedWithCommit: PinStory = threadStory(
  threadStateFixtures.replied
)

/** Working steps expand from "3 steps". */
export const ThreadWorkingStepsOpen: PinStory = {
  ...threadStory(threadStateFixtures.working),
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(canvas.getByRole("button", { name: /3 steps/ }))
    // The steps fade in: wait for the end of the reveal, not its first frame.
    await waitFor(() =>
      expect(canvas.getByText("Edit src/sharing/revoke.ts")).toBeVisible()
    )
  },
}

/* ── File + margin together ────────────────────────────── */

/** The revoke file with its margin, at desk width. */
const fileFrame = () => <FileFrame />

/** Rest: dotted L0 underlines and pins, nothing open. */
export const FileWithMargin: PinStory = {
  decorators: [withReviewDeskState()],
  render: fileFrame,
}

/** Isolation: graph card open, its row ringed, every other pin dimmed and disabled. */
export const FileWithCardOpen: PinStory = {
  decorators: [withReviewDeskState({ openMarker: "graph" })],
  render: fileFrame,
}

/** L1: one shared hint layer per margin, under the hovered pin. */
export const FileWithHoverHint: PinStory = {
  decorators: [
    withReviewDeskState({
      hoverHint: { filePath: revokeFile.path, markerKey: "conflict" },
    }),
  ],
  render: fileFrame,
}

/**
 * In a 260px margin (≤1180px viewports) the header puts the range and count
 * under "Thread", so neither is cut off. The play checks the count fits.
 */
export const ThreadHeaderNarrowMargin: PinStory = {
  decorators: [
    withReviewDeskState({}, undefined, {
      threads: [threadStateFixtures.replied],
    }),
  ],
  render: () => (
    <ThreadFrame thread={threadStateFixtures.replied} width={260} />
  ),
  play: async ({ canvasElement }) => {
    const count = canvasElement.querySelector<HTMLElement>(
      "[data-thread-count]"
    )!
    await expect(count.textContent).toMatch(/L22–23 · 4 messages/)
    const card =
      canvasElement.ownerDocument.querySelector<HTMLElement>(
        "[data-thread-card]"
      )!
    await expect(count.getBoundingClientRect().right).toBeLessThanOrEqual(
      card.getBoundingClientRect().right
    )
    await expect(count.scrollWidth).toBeLessThanOrEqual(count.clientWidth + 1)
  },
}

/** "Show comments": the compact preview, which opens the thread. */
export const CommentPreview: PinStory = {
  decorators: [
    withReviewDeskState({}, undefined, { threads: reviewThreadFixtures }),
  ],
  render: () => (
    <FloatingFrame>
      <CommentPreviewCard
        record={sessionsRecord}
        rangeLabel="L22–23"
        thread={reviewThreadFixtures[0]}
        onOpen={fn()}
      />
    </FloatingFrame>
  ),
}
