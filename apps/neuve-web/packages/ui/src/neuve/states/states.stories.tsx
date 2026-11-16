import type { Meta, StoryObj } from "@storybook/react-vite"
import * as React from "react"
import { Provider, atom, useAtomValue, useSetAtom } from "jotai"
import { expect, fn, waitFor, within } from "storybook/test"

import {
  REVIEWS_NOW,
  REVIEWS_TIME_ZONE,
  realReviews,
} from "@workspace/ui/fixtures/real-reviews.fixtures"
import {
  batchOverviewFixture,
  deskBatchContextFixture,
} from "@workspace/ui/fixtures/review-batch.fixtures"
import {
  runningHeldFixture,
  RECORDED_ORDER,
  runningFindingFixture,
  runningNoWorkerFixture,
  runningPublishingFixture,
  runningQueuedFixture,
  runningWorkingFixture,
  startAfterFailureFixture,
  startOnMainFixture,
  startPreviewFixture,
  startRefusedFixture,
} from "@workspace/ui/fixtures/review-start.fixtures"
import { NeuveModeProvider } from "@workspace/ui/neuve/shared/nav-link"
import {
  NoBatchEmpty,
  NoDecisionEmpty,
  NotFoundEmpty,
  UnknownCommitEmpty,
  UnknownUnitEmpty,
} from "@workspace/ui/neuve/states/empty-states"
import { ErrorPage } from "@workspace/ui/neuve/states/error-page"
import {
  BatchOverviewPage,
  ReviewDeskPage,
  ReviewsPage,
} from "@workspace/ui/neuve/states/pages"
import type { ReviewStage } from "@workspace/ui/neuve/states/review-start"
import { RunningReviewEmpty } from "@workspace/ui/neuve/states/running-review"
import {
  BatchOverviewSkeleton,
  LineageSkeleton,
  ReviewDeskSkeleton,
  ReviewsSkeleton,
} from "@workspace/ui/neuve/states/skeletons"
import { DeskAt, deskAt, deskMeta } from "@workspace/ui/neuve/story-kit/desk"

/**
 * Loading and empty states of the route pages. Skeletons reserve the real
 * layout (no shift on swap); they breathe only when motion is allowed.
 * Theme with the toolbar or `&globals=theme:dark`.
 */
/** Widths the loading header is checked at against the loaded one. */
const HEADER_VIEWPORTS = {
  phone375: {
    name: "Phone 375",
    styles: { width: "375px", height: "812px" },
    type: "mobile",
  },
  w600: {
    name: "600×900",
    styles: { width: "600px", height: "900px" },
    type: "tablet",
  },
  w768: {
    name: "Tablet 768",
    styles: { width: "768px", height: "1024px" },
    type: "tablet",
  },
  w860: {
    name: "860×1000",
    styles: { width: "860px", height: "1000px" },
    type: "tablet",
  },
  w1024: {
    name: "1024×768",
    styles: { width: "1024px", height: "768px" },
    type: "desktop",
  },
} as const

const meta = {
  title: "Screens/States",
  component: BatchOverviewSkeleton,
  parameters: { viewport: { options: HEADER_VIEWPORTS } },
} satisfies Meta<typeof BatchOverviewSkeleton>

export default meta
type Story = StoryObj<typeof meta>

/* ── Loading ──────────────────────────────────────────── */

/** Batch overview loading: busy region, header, hero, lanes, table. */
export const BatchOverviewLoading: Story = {
  play: async ({ canvas }) => {
    const region = canvas.getByRole("region", {
      name: "Loading the review batch",
    })
    await expect(region).toHaveAttribute("aria-busy", "true")
  },
}

/** Review desk loading: header, rail rows, briefing, gutter-shaped diff rows. */
export const ReviewDeskLoading: Story = {
  render: () => <ReviewDeskSkeleton />,
  play: async ({ canvas }) => {
    await expect(
      canvas.getByRole("region", { name: "Loading the review unit" })
    ).toHaveAttribute("aria-busy", "true")
  },
}

/** Commit lineage loading. */
export const LineageLoading: Story = {
  render: () => <LineageSkeleton />,
}

const loadedAtom = atom(false)

/** A page's skeleton until "Finish loading", then its content. */
function SkeletonThen({
  skeleton,
  content,
}: {
  skeleton: React.ReactNode
  content: React.ReactNode
}) {
  const loaded = useAtomValue(loadedAtom)
  const setLoaded = useSetAtom(loadedAtom)
  return (
    <>
      <button
        type="button"
        onClick={() => setLoaded(true)}
        className="fixed right-4 bottom-4 z-50 rounded-lg bg-ink px-3 py-2 text-xs text-paper"
      >
        Finish loading
      </button>
      {loaded ? content : skeleton}
    </>
  )
}

function SkeletonThenContent() {
  return (
    <SkeletonThen
      skeleton={<BatchOverviewSkeleton />}
      content={
        <BatchOverviewPage
          load={{ status: "ready", data: batchOverviewFixture }}
        />
      }
    />
  )
}

/**
 * Skeleton → content: the play finishes loading; the content replaces the
 * skeleton with a quick fade (none under reduced motion) and the header
 * keeps its height, so nothing below it shifts.
 */
export const SkeletonToContent: Story = {
  // A story-scoped store, so every run starts loading.
  render: () => (
    <Provider>
      <SkeletonThenContent />
    </Provider>
  ),
  play: async ({ canvas, canvasElement, userEvent }) => {
    const header = () => canvasElement.querySelector("header")!
    const before = header().getBoundingClientRect().height
    await userEvent.click(
      canvas.getByRole("button", { name: "Finish loading" })
    )
    await waitFor(() =>
      expect(canvas.getByRole("heading", { level: 1 })).toHaveTextContent(
        "Revoked share links stop working immediately"
      )
    )
    await expect(header().getBoundingClientRect().height).toBe(before)
    await expect(canvasElement.querySelector(".content-fade")).toBeTruthy()
  },
}

/* ── The header holds as a page loads ───────────────────── */

/**
 * Finishes loading and fails if the header's height changed: the loading
 * header reserves the loaded one's rows at this width. Before the fix the
 * one loading header wrapped from 600 to about 860px for every page, so on
 * a 768px tablet the Reviews page's header fell from 103px to 56px as it
 * loaded and the page jumped 47px; the desk's grew from one row to two at
 * 860.
 */
async function expectHeaderHolds(
  canvasElement: HTMLElement,
  user: { click: (element: Element) => Promise<unknown> },
  width: number
) {
  const doc = canvasElement.ownerDocument
  await expect(doc.documentElement.clientWidth, `A ${width}px frame`).toBe(
    width
  )
  const header = () => canvasElement.querySelector("header")!
  await expect(
    canvasElement.querySelector("[role=region][aria-busy=true]"),
    "The page is loading"
  ).not.toBeNull()
  const loading = header().getBoundingClientRect().height
  await user.click(
    within(canvasElement).getByRole("button", { name: "Finish loading" })
  )
  await waitFor(() =>
    expect(
      canvasElement.querySelector("[role=region][aria-busy=true]")
    ).toBeNull()
  )
  await expect(
    header().getBoundingClientRect().height,
    "The header keeps its height as the page loads"
  ).toBe(loading)
}

const atWidth = (value: keyof typeof HEADER_VIEWPORTS) => ({
  globals: { viewport: { value, isRotated: false } },
})

/** The Reviews page: its breadcrumb is short, so it wraps only on a phone. */
function ReviewsLoads() {
  return (
    <Provider>
      <SkeletonThen
        skeleton={<ReviewsSkeleton />}
        content={
          <ReviewsPage
            load={{ status: "ready", data: realReviews }}
            now={REVIEWS_NOW}
            timeZone={REVIEWS_TIME_ZONE}
          />
        }
      />
    </Provider>
  )
}

/** The desk: its header wraps from 600px until about 1000px. */
function DeskLoads() {
  return (
    <Provider>
      <SkeletonThen
        skeleton={<ReviewDeskSkeleton />}
        content={<DeskAt {...deskAt("revoke-live")} />}
      />
    </Provider>
  )
}

export const ReviewsHeaderHolds375: Story = {
  ...atWidth("phone375"),
  render: () => <ReviewsLoads />,
  play: ({ canvasElement, userEvent }) =>
    expectHeaderHolds(canvasElement, userEvent, 375),
}

export const ReviewsHeaderHolds600: Story = {
  ...atWidth("w600"),
  render: () => <ReviewsLoads />,
  play: ({ canvasElement, userEvent }) =>
    expectHeaderHolds(canvasElement, userEvent, 600),
}

export const ReviewsHeaderHolds768: Story = {
  ...atWidth("w768"),
  render: () => <ReviewsLoads />,
  play: ({ canvasElement, userEvent }) =>
    expectHeaderHolds(canvasElement, userEvent, 768),
}

export const ReviewsHeaderHolds1024: Story = {
  ...atWidth("w1024"),
  render: () => <ReviewsLoads />,
  play: ({ canvasElement, userEvent }) =>
    expectHeaderHolds(canvasElement, userEvent, 1024),
}

/** The desk's stories carry the in-memory delivery setting it reads. */
const DESK_DECORATORS = deskMeta().decorators

export const DeskHeaderHolds375: Story = {
  ...atWidth("phone375"),
  decorators: DESK_DECORATORS,
  render: () => <DeskLoads />,
  play: ({ canvasElement, userEvent }) =>
    expectHeaderHolds(canvasElement, userEvent, 375),
}

export const DeskHeaderHolds600: Story = {
  ...atWidth("w600"),
  decorators: DESK_DECORATORS,
  render: () => <DeskLoads />,
  play: ({ canvasElement, userEvent }) =>
    expectHeaderHolds(canvasElement, userEvent, 600),
}

export const DeskHeaderHolds768: Story = {
  ...atWidth("w768"),
  decorators: DESK_DECORATORS,
  render: () => <DeskLoads />,
  play: ({ canvasElement, userEvent }) =>
    expectHeaderHolds(canvasElement, userEvent, 768),
}

/** The widest the desk's header still wraps (two rows, 103px). */
export const DeskHeaderHolds860: Story = {
  ...atWidth("w860"),
  decorators: DESK_DECORATORS,
  render: () => <DeskLoads />,
  play: ({ canvasElement, userEvent }) =>
    expectHeaderHolds(canvasElement, userEvent, 860),
}

export const DeskHeaderHolds1024: Story = {
  ...atWidth("w1024"),
  decorators: DESK_DECORATORS,
  render: () => <DeskLoads />,
  play: ({ canvasElement, userEvent }) =>
    expectHeaderHolds(canvasElement, userEvent, 1024),
}

/* ── Empty ────────────────────────────────────────────── */

/** No review batch yet, on the desk and lineage (no action). */
export const NoReviewBatch: Story = {
  render: () => <NoBatchEmpty />,
  play: async ({ canvas }) => {
    await waitFor(() =>
      expect(
        canvas.getByRole("heading", { level: 1, name: "No review batch yet" })
      ).toBeVisible()
    )
    await expect(
      canvas.queryAllByRole("link", { name: /Batch overview/ })
    ).toHaveLength(0)
  },
}

/** (a) No units need your decision → "Open other review lanes". */
export const DeskNoDecision: Story = {
  render: () => <NoDecisionEmpty batch={deskBatchContextFixture} />,
  play: async ({ canvas }) => {
    await expect(
      canvas.getByRole("link", { name: /Open other review lanes/ })
    ).toHaveAttribute("href", "/batch/batch-share-dialog#lanes")
  },
}

/** (a) under `/mock`: the same action stays in the mock pages. */
export const DeskNoDecisionMockMode: Story = {
  render: () => (
    <NeuveModeProvider mode="mock">
      <NoDecisionEmpty batch={deskBatchContextFixture} />
    </NeuveModeProvider>
  ),
  play: async ({ canvas }) => {
    await expect(
      canvas.getByRole("link", { name: /Open other review lanes/ })
    ).toHaveAttribute("href", "/mock#lanes")
  },
}

/** (b) The unit isn't in this revision → batch overview. */
export const DeskUnknownUnit: Story = {
  render: () => (
    <UnknownUnitEmpty
      unitId="revoke-returns-204"
      batch={deskBatchContextFixture}
    />
  ),
  play: async ({ canvas }) => {
    await expect(
      canvas.getByRole("link", { name: /Batch overview/ })
    ).toHaveAttribute("href", "/batch/batch-share-dialog")
  },
}

/** (c) No batch yet, as the desk route renders it. */
export const DeskNoBatch: Story = {
  render: () => (
    <ReviewDeskPage load={{ status: "empty", reason: "no-batch" }} />
  ),
}

/* ── Empty batch overview: "Start a review" ─────────────── */

const MOCK_START_MS = 800
const startedMock = fn()
const failingStart = fn(() =>
  Promise.reject(
    new Error("The harness didn’t answer. Nothing was registered.")
  )
)

/** Idle: the one primary action, a button (it acts; it doesn't navigate). */
export const OverviewEmptyIdle: Story = {
  render: () => (
    <BatchOverviewPage
      load={{ status: "empty", reason: "no-batch" }}
      onStartReview={fn()}
    />
  ),
  play: async ({ canvas }) => {
    const button = canvas.getByRole("button", { name: /Start a review/ })
    await expect(button.tagName).toBe("BUTTON")
    await waitFor(() =>
      expect(
        canvas.getByText(
          "Pick a branch and Neuve gathers what needs your decision."
        )
      ).toBeVisible()
    )
  },
}

/** Starting: disabled, spinner, "Starting…", aria-busy. */
export const OverviewEmptyStarting: Story = {
  render: () => (
    <NoBatchEmpty
      onStartReview={fn()}
      startReviewState={{ status: "starting" }}
    />
  ),
  play: async ({ canvas }) => {
    const button = canvas.getByRole("button", { name: /Starting…/ })
    await expect(button).toBeDisabled()
    await expect(button).toHaveAttribute("aria-busy", "true")
  },
}

/** Failed: the reason inline, and "Try again" (the play retries and fails). */
export const OverviewEmptyFailed: Story = {
  render: () => (
    <NoBatchEmpty
      onStartReview={failingStart}
      startReviewState={{
        status: "failed",
        message: "The harness didn’t answer. Nothing was registered.",
      }}
    />
  ),
  play: async ({ canvas, userEvent }) => {
    await expect(canvas.getByRole("alert")).toHaveTextContent(
      "Nothing was registered."
    )
    await userEvent.click(canvas.getByRole("button", { name: /Try again/ }))
    await waitFor(() => expect(failingStart).toHaveBeenCalled())
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: /Try again/ })).toBeEnabled()
    )
  },
}

/**
 * Mock flow (as `/mock?state=empty` wires it): the handler takes ~800ms,
 * then the app navigates to the sample batch. The play presses the button,
 * sees "Starting…", and waits for the handler to finish.
 */
export const OverviewEmptyMockFlow: Story = {
  render: () => (
    <NoBatchEmpty
      onStartReview={async () => {
        await new Promise((resolve) => setTimeout(resolve, MOCK_START_MS))
        startedMock()
      }}
    />
  ),
  play: async ({ canvas, userEvent }) => {
    await userEvent.click(
      canvas.getByRole("button", { name: /Start a review/ })
    )
    await expect(
      canvas.getByRole("button", { name: /Starting…/ })
    ).toHaveAttribute("aria-busy", "true")
    await waitFor(() => expect(startedMock).toHaveBeenCalledOnce(), {
      timeout: 3000,
    })
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: /Start a review/ })
      ).toBeEnabled()
    )
  },
}

/* ── Live overview: "Start a review" (M5 ST2–ST4) ───────── */

const startLive = fn()

/** Before the press: the checked-out branch against its base (ST2). */
export const OverviewStartPreview: Story = {
  render: () => (
    <BatchOverviewPage
      load={{ status: "empty", reason: "no-batch" }}
      start={startPreviewFixture}
      onStartReview={startLive}
    />
  ),
  play: async ({ canvas }) => {
    await waitFor(() => expect(canvas.getByText("stall-retry")).toBeVisible())
    await expect(canvas.getByText("main")).toBeVisible()
    await expect(canvas.getByText("openai/gpt-6.1-sol")).toBeVisible()
    await expect(
      canvas.getByRole("button", { name: /Start a review/ })
    ).toBeEnabled()
  },
}

/** On main itself (10.103): the work not yet on its remote-tracking copy. */
export const OverviewStartOnMain: Story = {
  render: () => (
    <BatchOverviewPage
      load={{ status: "empty", reason: "no-batch" }}
      start={startOnMainFixture}
      onStartReview={fn()}
    />
  ),
  play: async ({ canvas }) => {
    await waitFor(() => expect(canvas.getByText("origin/main")).toBeVisible())
    await expect(canvas.getByText(/2 commits ahead of/)).toBeVisible()
  },
}

/** A branch with nothing ahead: refused in the button's failed state. */
export const OverviewStartRefused: Story = {
  render: () => (
    <BatchOverviewPage
      load={{ status: "empty", reason: "no-batch" }}
      start={startRefusedFixture}
      onStartReview={fn()}
    />
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("alert")).toHaveTextContent(
      "empty-branch has nothing ahead of main."
    )
    await expect(
      canvas.getByRole("button", { name: /Try again/ })
    ).toBeEnabled()
  },
}

/** The newest review failed: the reason, and the branch to try again. */
export const OverviewStartAfterFailure: Story = {
  render: () => (
    <BatchOverviewPage
      load={{ status: "empty", reason: "no-batch" }}
      start={startAfterFailureFixture}
      onStartReview={fn()}
    />
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByRole("alert")).toHaveTextContent(
      "The last review failed"
    )
    await waitFor(() =>
      expect(canvas.getByText(/3 commits ahead of/)).toBeVisible()
    )
  },
}

/** Queued with no worker running: how to start one (ST4). */
export const RunningNoWorker: Story = {
  render: () => (
    <BatchOverviewPage
      load={{ status: "empty", reason: "no-batch" }}
      start={runningNoWorkerFixture}
    />
  ),
  play: async ({ canvas }) => {
    await waitFor(() =>
      expect(
        canvas.getByRole("heading", {
          level: 1,
          name: "Reviewing stall-retry",
        })
      ).toBeVisible()
    )
    await expect(canvas.getByText("neuve worker start")).toBeVisible()
    await expect(canvas.getByText("openai/gpt-6.1-sol")).toBeVisible()
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "Queued, no worker is running"
    )
    await expect(
      canvas.queryByRole("button", { name: /Start a review|Try again/ })
    ).toBeNull()
  },
}

/** The running worker lacks the sign-in and holds the job: the CLI's words. */
export const RunningHeld: Story = {
  render: () => (
    <BatchOverviewPage
      load={{ status: "empty", reason: "no-batch" }}
      start={runningHeldFixture}
    />
  ),
  play: async ({ canvas }) => {
    await waitFor(() =>
      expect(
        canvas.getByText(
          /so it holds this job; a worker that has it picks it up/
        )
      ).toBeVisible()
    )
  },
}

/** Queued for a running worker. */
export const RunningQueued: Story = {
  render: () => (
    <BatchOverviewPage
      load={{ status: "empty", reason: "no-batch" }}
      start={runningQueuedFixture}
    />
  ),
}

/** Link's fill is in and no finder yet: Map is done, only Find works. */
export const RunningFinding: Story = {
  render: () => (
    <BatchOverviewPage
      load={{ status: "empty", reason: "no-batch" }}
      start={runningFindingFixture}
    />
  ),
  play: async ({ canvas }) => {
    const stages = canvas.getByRole("list", { name: "Review stages" })
    await expect(stages).toHaveTextContent("Map, done")
    await expect(stages).not.toHaveTextContent("Link, working")
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "Find is working"
    )
  },
}

/** Working, as for most of a run: three stages done, Find, Verify and Link working together. */
export const RunningWorking: Story = {
  render: () => (
    <BatchOverviewPage
      load={{ status: "empty", reason: "no-batch" }}
      start={runningWorkingFixture}
    />
  ),
  play: async ({ canvas }) => {
    const stages = canvas.getByRole("list", { name: "Review stages" })
    const current = stages.querySelector('[aria-current="step"]')
    await expect(current).toHaveTextContent("Find")
    await expect(stages).toHaveTextContent("Link, working")
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "Find, Verify and Link are working"
    )
  },
}

/**
 * Publishing has ended: everything before Publish is done and it works in
 * the list until the batch opens; a screen reader hears "Opening the batch".
 */
export const RunningPublishing: Story = {
  render: () => (
    <BatchOverviewPage
      load={{ status: "empty", reason: "no-batch" }}
      start={runningPublishingFixture}
    />
  ),
  play: async ({ canvas }) => {
    const stages = canvas.getByRole("list", { name: "Review stages" })
    await expect(stages).toHaveTextContent("Link, done")
    await expect(stages).toHaveTextContent("Publish, working")
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "Opening the batch"
    )
  },
}

const recordedAtom = atom<Array<ReviewStage>>([])

function StagesTickingIn() {
  const recorded = useAtomValue(recordedAtom)
  const setRecorded = useSetAtom(recordedAtom)
  const next = RECORDED_ORDER[recorded.length]
  return (
    <>
      <button
        type="button"
        disabled={next === undefined}
        onClick={() => next && setRecorded([...recorded, next])}
        className="fixed right-4 bottom-4 z-50 rounded-lg bg-ink px-3 py-2 text-xs text-paper disabled:opacity-50"
      >
        Next stage records a part
      </button>
      <RunningReviewEmpty
        run={{
          subject: "stall-retry",
          route: "openai/gpt-6.1-sol",
          phase: { kind: "working" },
          recorded,
        }}
      />
    </>
  )
}

/**
 * Stages ticking in: each press records the next stage's first part, in
 * the order real runs record them (Link's fill before any Find). Up to Map
 * the stage before it is then done: its dots leave and the check pops in (a
 * fade under reduced motion). Link's fill sets only Find working; the first
 * Find sets Verify and Link working beside it; Publish finishes all three.
 */
export const RunningStagesTickIn: Story = {
  render: () => (
    <Provider>
      <StagesTickingIn />
    </Provider>
  ),
  play: async ({ canvas, userEvent }) => {
    const step = () =>
      canvas
        .getByRole("list", { name: "Review stages" })
        .querySelector('[aria-current="step"]')
    await expect(step()).toHaveTextContent("Precompute")
    await userEvent.click(
      canvas.getByRole("button", { name: "Next stage records a part" })
    )
    await expect(step()).toHaveTextContent("Precompute")
    await userEvent.click(
      canvas.getByRole("button", { name: "Next stage records a part" })
    )
    await waitFor(() => expect(step()).toHaveTextContent("Frame"))
    await expect(
      canvas.getByRole("list", { name: "Review stages" }).querySelector("li")
    ).toHaveTextContent("Precompute, done")
  },
}

/** Unknown address. */
export const NotFound: Story = {
  render: () => <NotFoundEmpty />,
}

const retry = fn()

/** A route that failed: the message (announced once) and Retry. */
export const LoadError: Story = {
  render: () => (
    <ErrorPage message="The review service didn’t answer." onRetry={retry} />
  ),
  play: async ({ canvas, userEvent }) => {
    await expect(canvas.getByRole("alert")).toHaveTextContent(
      "The review service didn’t answer."
    )
    await userEvent.click(canvas.getByRole("button", { name: "Retry" }))
    await expect(retry).toHaveBeenCalledOnce()
  },
}

/**
 * A route error with technical detail (round 3): one plain sentence, Retry,
 * and the detail folded into a mono "Details" disclosure with Copy.
 */
export const LoadErrorWithDetails: Story = {
  render: () => (
    <ErrorPage
      detail={
        'SchemaError: Expected a string matching the pattern ^(?:[a-f0-9]{40}|[a-f0-9]{64})$, got "4fc76f5"\n  at ["commit"]'
      }
      onRetry={retry}
    />
  ),
  play: async ({ canvas, userEvent }) => {
    await expect(canvas.getByRole("alert")).toHaveTextContent(
      "Something went wrong while loading it."
    )
    const summary = canvas.getByText("Details")
    const details = summary.closest("details")!
    await expect(details.open).toBe(false)
    await userEvent.click(summary)
    await expect(details.open).toBe(true)
    await waitFor(() =>
      expect(canvas.getByRole("button", { name: "Copy" })).toBeVisible()
    )
  },
}

/** `/changes/<short sha>` that the review doesn't know: a plain not-found. */
export const UnknownCommit: Story = {
  render: () => <UnknownCommitEmpty commit="4fc76f5" />,
}

/** A short id several revisions start with: asks for more characters. */
export const AmbiguousCommit: Story = {
  render: () => <UnknownCommitEmpty commit="4fc7" candidates={2} />,
}

/** A very long echoed id is shortened, never an unbroken line. */
export const UnknownCommitLongInput: Story = {
  render: () => <UnknownCommitEmpty commit={"a".repeat(300)} />,
  play: async ({ canvasElement }) => {
    const code = canvasElement.querySelector("code")!
    await expect(code.textContent.length).toBeLessThanOrEqual(25)
    await expect(code.scrollWidth).toBeLessThanOrEqual(code.clientWidth + 1)
  },
}
