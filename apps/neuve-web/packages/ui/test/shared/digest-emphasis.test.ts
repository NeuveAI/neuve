/**
 * Bold in the batch digest (10.140): only `**…**` pairs are read, and
 * anything that is not a clean pair stays as its plain characters, since the
 * text is the harness's and is never parsed as HTML.
 */
import { describe, expect, test } from "bun:test"

import { emphasisParts } from "@workspace/ui/neuve/shared/digest-emphasis"

const bold = (text: string) => ({ text, strong: true })
const plain = (text: string) => ({ text, strong: false })

describe("emphasisParts", () => {
  test("a bold label leads its line, and line breaks stay in the text", () => {
    expect(
      emphasisParts("Opening.\n**Identity:** by link.\n**Stability:** kept.")
    ).toEqual([
      plain("Opening.\n"),
      bold("Identity:"),
      plain(" by link.\n"),
      bold("Stability:"),
      plain(" kept."),
    ])
  })

  test("text without a pair is one plain part, and empty text has none", () => {
    expect(emphasisParts("No marks here.")).toEqual([plain("No marks here.")])
    expect(emphasisParts("")).toEqual([])
  })

  test("an unmatched pair reads as its asterisks", () => {
    expect(emphasisParts("**Identity: by link.")).toEqual([
      plain("**Identity: by link."),
    ])
    expect(emphasisParts("a ** b")).toEqual([plain("a ** b")])
    expect(emphasisParts("**a** and **b")).toEqual([
      bold("a"),
      plain(" and **b"),
    ])
  })

  test("an empty pair, or one that opens or closes on a space, is not bold", () => {
    expect(emphasisParts("****")).toEqual([plain("****")])
    expect(emphasisParts("** spaced** and **spaced **")).toEqual([
      plain("** spaced** and **spaced **"),
    ])
  })

  test("a pair never runs across a line break", () => {
    expect(emphasisParts("**one\ntwo**")).toEqual([plain("**one\ntwo**")])
  })

  test("nested pairs bold only the inner clean pair; the rest stays plain", () => {
    expect(emphasisParts("**a **b** c**")).toEqual([
      plain("**a "),
      bold("b"),
      plain(" c**"),
    ])
    expect(emphasisParts("***x***")).toEqual([
      plain("*"),
      bold("x"),
      plain("*"),
    ])
  })

  test("a single asterisk inside a pair stays in its words", () => {
    expect(emphasisParts("**2 * 3:** six")).toEqual([
      bold("2 * 3:"),
      plain(" six"),
    ])
  })

  test("markup-like text stays text", () => {
    expect(emphasisParts("**<b>x</b>** <script>")).toEqual([
      bold("<b>x</b>"),
      plain(" <script>"),
    ])
  })

  // A phrase link's words are read on their own, as DigestText reads each
  // segment: a pair inside the phrase is bold within the link, and asterisks
  // that pair with text outside it stay as written.
  test("a link phrase is read on its own", () => {
    expect(emphasisParts("**start request** contract")).toEqual([
      bold("start request"),
      plain(" contract"),
    ])
    expect(emphasisParts("contract**")).toEqual([plain("contract**")])
  })
})
