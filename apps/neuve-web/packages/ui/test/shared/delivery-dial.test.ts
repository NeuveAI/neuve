import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
/**
 * A stop the unit doesn't offer stays in the dial as a native disabled
 * radio: the browser's arrow keys skip it and a screen reader announces it
 * unavailable. The checked stop and offered stops stay enabled; a dial with
 * no `offered` (the settings page's) offers all four.
 */
import { describe, expect, test } from "bun:test"

import { DeliveryDial } from "@workspace/ui/neuve/shared/delivery-dial"
import type { DeliveryStop } from "@workspace/ui/neuve/shared/delivery"

const radios = (offered?: ReadonlyArray<DeliveryStop>) => {
  const html = renderToStaticMarkup(
    createElement(DeliveryDial, {
      size: "popover",
      value: "guided",
      onChange: () => {},
      label: "Review delivery",
      offered,
    })
  )
  return Object.fromEntries(
    [...html.matchAll(/<input[^>]*>/g)].map(([input]) => [
      /value="([a-z]+)"/.exec(input)![1],
      /\sdisabled=""/.test(input),
    ])
  )
}

describe("DeliveryDial offered stops", () => {
  test("stops not offered are disabled radios; offered ones are not", () => {
    expect(radios(["facts", "guided"])).toEqual({
      facts: false,
      briefed: true,
      explained: true,
      guided: false,
    })
  })

  test("without offered stops every stop is enabled", () => {
    expect(radios()).toEqual({
      facts: false,
      briefed: false,
      explained: false,
      guided: false,
    })
  })
})
