import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
/**
 * The held line while a requested review waits (10.17). On a Claude Code
 * route the worker's entry is a sentence of its own on the account and the
 * command that fixes it, so the line must quote it whole, with the command as
 * code, and never say the worker "lacks" that sentence. A direct route keeps
 * the CLI's "lacks" wording.
 */
import { expect, test } from "bun:test"

import {
  runningHeldClaudeFixture,
  runningHeldFixture,
} from "@workspace/ui/fixtures/review-start.fixtures"
import { RunningReviewEmpty } from "@workspace/ui/neuve/states/running-review"
import type { ReviewStart } from "@workspace/ui/neuve/states/review-start"

const render = (start: ReviewStart) => {
  if (start.status !== "running") throw new Error("expected a running review")
  return renderToStaticMarkup(
    createElement(RunningReviewEmpty, { run: start.run })
  )
}

test("a Claude route's held line quotes the worker's sentence, with its command as code", () => {
  const html = render(runningHeldClaudeFixture)
  expect(html).toContain(
    'The running worker holds this job for <code translate="no">claude/claude-opus-5-5</code>. The Claude Code sign-in of account claude is not-signed-in; run <code translate="no">neuve auth login claude</code>.'
  )
  expect(html).not.toContain("lacks")
  expect(html).not.toContain("`")
})

test("a direct route's held line keeps the credential wording", () => {
  expect(render(runningHeldFixture)).toContain(
    'The running worker lacks the Neuve sign-in (neuve auth login openai) for <code translate="no">openai/gpt-6.1-sol</code>, so it holds this job'
  )
})
