// Why (the owner, on the checkout unit's page): "No '(human required)' label on the title. It's
// already clear that it's in the human required track." The harness writes the label after the
// file's name when a file has more than one unit, and stored titles keep it. The desk shows a
// title without it, from one rule in the projection that every surface reads (`shownTitles`).
// The rule must remove only the unit's own lane right after its file's name, leave every other
// parenthesis and every title with no label as stored, and never make two units of a batch share
// a title they did not share before: the label is how two units of one file were told apart.
import { expect, test } from "bun:test"

import { shownTitles } from "./projection"
import type { DeskUnit } from "./lane-facts"

const PATH = "apps/neuve-host/src/projects.ts"

const unit = (
  unitId: string,
  title: string,
  lane: "human-required" | "human-suggested" | "agentic",
  path = PATH
) =>
  ({
    local: unitId,
    unitId,
    recorded: {
      kind: "unit.recorded@3",
      payload: {
        title,
        ownedRanges: [
          { kind: "lines", path, side: "new", startLine: 1, endLine: 2 },
        ],
      },
    },
    judgement: { lane },
  }) as unknown as DeskUnit

const shown = (...units: Array<DeskUnit>) => [...shownTitles(units).values()]

test("the unit's own lane after its file's name goes, with or without a part name", () => {
  expect(
    shown(
      unit("u1", "projects.ts (human required): checkout", "human-required"),
      unit("u2", "projects.ts (human suggested)", "human-suggested")
    )
  ).toEqual(["projects.ts: checkout", "projects.ts"])
})

test("a parenthesis that is not the unit's own lane after its file's name stays", () => {
  expect(
    shown(
      // Another lane's words.
      unit("u1", "projects.ts (human suggested): checkout", "human-required"),
      // The lane's words, but not after the file's name.
      unit("u2", "checkout (human required): projects.ts", "human-required"),
      // A part name's own parenthesis.
      unit("u3", "projects.ts: probe (agentic)", "agentic")
    )
  ).toEqual([
    "projects.ts (human suggested): checkout",
    "checkout (human required): projects.ts",
    "projects.ts: probe (agentic)",
  ])
})

test("a title with no label stays as stored", () => {
  expect(
    shown(
      unit("u1", "Typed preparation failures", "agentic"),
      unit("u2", "package.json: line 20", "human-required", "package.json")
    )
  ).toEqual(["Typed preparation failures", "package.json: line 20"])
})

test("two units of one file titled by the file alone keep their labels", () => {
  expect(
    shown(
      unit("u1", "projects.ts (human required)", "human-required"),
      unit("u2", "projects.ts (agentic)", "agentic"),
      unit("u3", "projects.ts (human suggested): imports", "human-suggested")
    )
  ).toEqual([
    "projects.ts (human required)",
    "projects.ts (agentic)",
    "projects.ts: imports",
  ])
})
