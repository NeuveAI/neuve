// Why: the review desk offers a delivery stop only when the unit has something to show there. A
// redesigned review's units carry only Facts, and an older review's Facts and Guided; offering
// all four stops left Guided with no card and no diff, an empty page. The projection is the one
// place that sees the unit's content, so it says which stops the unit has, and these pin its rule:
// Facts always, Briefed only when it says more than Facts, Explained when written, Guided only with
// rows to show.
import { describe, expect, test } from "bun:test"

import { deliveryStopsOf } from "./projection"
import type { SectionContent } from "./projection"

const FACTS = {
  text: "The [retry](h1a2b3c4d) waits between attempts.",
  cites: [],
}

const row = {
  row: "b1.r1",
  text: "Busy writes are retried.",
  basis: "done-when",
  status: "met",
  does: "It retries three times.",
  evidence: [],
}

const section = (
  content: Partial<SectionContent>
): { content: SectionContent } => ({
  content: { facts: FACTS, briefed: null, explained: null, ...content },
})

describe("deliveryStopsOf", () => {
  test("a unit with only Facts offers Facts alone", () => {
    expect(deliveryStopsOf({ facts: FACTS }, [])).toEqual(["facts"])
  })

  test("an older review's unit with Facts and Guided rows offers Facts and Guided", () => {
    expect(
      deliveryStopsOf({ facts: FACTS, guided: { rows: [row] } }, [])
    ).toEqual(["facts", "guided"])
  })

  test("a Briefed with the Facts' own words adds nothing", () => {
    // Same words, local IDs and spacing aside.
    const briefed = {
      text: "  The [retry](h1a2b3c4d)   waits between attempts. (h1a2b3c4d)",
    }
    expect(deliveryStopsOf({ facts: FACTS, briefed }, [])).toEqual(["facts"])
    expect(
      deliveryStopsOf({ facts: FACTS }, [section({ briefed: FACTS.text })])
    ).toEqual(["facts"])
  })

  test("a Briefed that says more, the unit's or a section's, offers Briefed", () => {
    const briefed = {
      text: "Commit used to fail at once; it now retries busy writes.",
    }
    expect(deliveryStopsOf({ facts: FACTS, briefed }, [])).toEqual([
      "facts",
      "briefed",
    ])
    expect(
      deliveryStopsOf({ facts: FACTS }, [
        section({ briefed: "A claim of its own." }),
      ])
    ).toEqual(["facts", "briefed"])
  })

  test("Explained, the unit's or a section's, offers Explained", () => {
    const explained = {
      before: "It failed.",
      after: "It retries.",
      terms: [],
      cites: [],
    }
    expect(deliveryStopsOf({ facts: FACTS, explained }, [])).toEqual([
      "facts",
      "explained",
    ])
    expect(deliveryStopsOf({ facts: FACTS }, [section({ explained })])).toEqual(
      ["facts", "explained"]
    )
  })

  test("Guided with no rows and nothing outside offers no Guided; an outside item is enough", () => {
    expect(deliveryStopsOf({ facts: FACTS, guided: { rows: [] } }, [])).toEqual(
      ["facts"]
    )
    expect(
      deliveryStopsOf(
        {
          facts: FACTS,
          guided: {
            outside: [{ item: "A cache", does: "Grows.", evidence: [] }],
          },
        },
        []
      )
    ).toEqual(["facts", "guided"])
  })
})
