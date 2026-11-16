// Why: the agent's review card shows the agent's summary, its prose before the proof line of its
// disposition note. A redesigned approval's note is only a proof line ("Proof: …"), and the desk
// printed that whole line as the summary. An older note puts its proof under the prose as
// "Proof (10.83): …". Both forms must leave the prose, and a note that opens with its proof line
// must give no summary at all.
import { describe, expect, test } from "bun:test"

import { noteSummary } from "./projection"

describe("noteSummary", () => {
  test("an older note keeps its prose before the Proof (10.83) line", () => {
    expect(
      noteSummary(
        "Retries busy writes; accepted the untested path.\n\nProof (10.83): rests on nothing."
      )
    ).toBe("Retries busy writes; accepted the untested path.")
  })

  test("a note in today's form keeps its prose before the Proof: line", () => {
    expect(
      noteSummary(
        'Imports resolve.\n\nProof: "Imports resolve in all builds": proof is not recorded.'
      )
    ).toBe("Imports resolve.")
  })

  test("a note that is only a proof line, in either form, has no summary", () => {
    expect(
      noteSummary(
        'Proof: "Workspace dependencies resolve in all affected builds": proof is not recorded.'
      )
    ).toBe("")
    expect(noteSummary("Proof (10.83): proof is not recorded.")).toBe("")
  })

  test("prose that only mentions proof keeps every word", () => {
    expect(
      noteSummary("Proofs agree. The word Proof: inside a line stays.")
    ).toBe("Proofs agree. The word Proof: inside a line stays.")
    expect(noteSummary(undefined)).toBeUndefined()
  })
})
