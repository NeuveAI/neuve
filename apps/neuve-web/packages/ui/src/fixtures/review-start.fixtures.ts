import type {
  ReviewStart,
  ReviewStartPreview,
  RunningReview,
} from "@workspace/ui/neuve/states/review-start"

/*
 * "Start a review" on the empty overview (M5 ST2–ST4), as the BFF loads it:
 * the branch before the press, the refusals, and the running state through
 * its phases. Branch, head and route as the live run on stall-retry had them.
 */

const preview: ReviewStartPreview = {
  branch: "stall-retry",
  base: "main",
  headOid: "7068a7b1a8f1c22a68bec344c8e79c4265f63f4b",
  mergeBase: "3eed81014d68f16ce4a083c6194b354504eaf5f5",
  ahead: 1,
  route: "openai/gpt-6.1-sol",
}

/** On main itself (10.103): the work not yet on origin/main. */
export const startOnMainFixture: ReviewStart = {
  status: "ready",
  preview: { ...preview, branch: "main", base: "origin/main", ahead: 2 },
}

export const startPreviewFixture: ReviewStart = { status: "ready", preview }

export const startRefusedFixture: ReviewStart = {
  status: "refused",
  message:
    "empty-branch has nothing ahead of main. Commit to it or check out another branch.",
}

export const startAfterFailureFixture: ReviewStart = {
  status: "ready",
  preview: { ...preview, ahead: 3 },
  failure:
    "The last review failed: the ChatGPT route answered 429 four times; the queue gave up.",
}

const running = (
  phase: RunningReview["phase"],
  recorded: RunningReview["recorded"] = []
): ReviewStart => ({
  status: "running",
  run: { subject: "stall-retry", route: preview.route, phase, recorded },
})

export const runningQueuedFixture = running({ kind: "queued" })
export const runningNoWorkerFixture = running({ kind: "no-worker" })
export const runningHeldFixture = running({
  kind: "held",
  credential: "the Neuve sign-in (neuve auth login openai)",
  route: "openai/gpt-6.1-sol",
})
/** On the Claude route, the worker's own sentence on the account and its fix. */
export const runningHeldClaudeFixture: ReviewStart = {
  status: "running",
  run: {
    subject: "stall-retry",
    route: "claude/claude-opus-5-5",
    phase: {
      kind: "held",
      credential:
        "The Claude Code sign-in of account claude is not-signed-in; run `neuve auth login claude`",
      route: "claude/claude-opus-5-5",
      account: true,
    },
    recorded: [],
  },
}
/**
 * Stages in the order a real run records their first completion: Link's
 * fill comes beside the finders, before any Find (measured over 250 runs).
 */
export const RECORDED_ORDER: RunningReview["recorded"] = [
  "precompute",
  "frame",
  "map",
  "link",
  "find",
  "verify",
  "publish",
]

/** Link's fill has recorded, no finder yet: Map is done and only Find works. */
export const runningFindingFixture = running(
  { kind: "working" },
  RECORDED_ORDER.slice(0, 4)
)

/**
 * The finders have recorded parts, as for most of a run: Precompute, Frame
 * and Map are done, Find, Verify and Link work, Publish is to come.
 */
export const runningWorkingFixture = running(
  { kind: "working" },
  RECORDED_ORDER.slice(0, 6)
)

/** Publish has recorded: everything before it is done, and it works until the batch opens. */
export const runningPublishingFixture = running(
  { kind: "working" },
  RECORDED_ORDER
)
