// Why: "Start a review" shows the stages Records records completions for, filtered by the UI's own
// list (start-review.server.ts), and the web app does not import the harness at runtime for it. If
// the two lists drift, a stage's completions stop showing and the list stalls, as it did when the
// pipeline's stages changed on 4 November.
import { expect, test } from "bun:test"
import { REVIEW_STAGES } from "@workspace/ui/neuve/states/review-start"

// Loaded by a name the type checker doesn't follow: the harness's own sources are checked under its
// settings, not the web app's.
const HARNESS = "@neuve/harness"

test("the progress list names the pipeline's stages, in its order", async () => {
  const { Budget } = (await import(HARNESS)) as {
    Budget: { Stage: { options: ReadonlyArray<string> } }
  }
  const listed: ReadonlyArray<string> = REVIEW_STAGES
  expect(listed).toEqual(Budget.Stage.options)
})
