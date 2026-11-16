import { expect, test } from "bun:test"

import { codingReturn, codingReturnFrom } from "./coding-return"

test("an explicit invalid return destination clears the previous tab context", () => {
  const stored = "http://127.0.0.1:4141/?channel=previous&chat=1#channels"
  expect(codingReturnFrom("", stored)).toBe(stored)
  expect(
    codingReturnFrom("?returnTo=https%3A%2F%2Fevil.example", stored),
  ).toBeUndefined()
  expect(codingReturnFrom("?returnTo=", stored)).toBeUndefined()
  expect(
    codingReturnFrom(
      "?returnTo=http%3A%2F%2F127.0.0.1%3A4141%2F&returnTo=duplicate",
      stored,
    ),
  ).toBeUndefined()
})

test("the review return link keeps an explicit coding origin and exact channel selection", () => {
  expect(
    codingReturn(
      "http://127.0.0.1:49123/?project=%2Frepo&channel=fix%2Fauth&chat=0#channels",
    ),
  ).toBe(
    "http://127.0.0.1:49123/?project=%2Frepo&channel=fix%2Fauth&chat=0#channels",
  )
  expect(
    codingReturn(
      "http://localhost:4141/?project=%2Frepo&repo=githubnext%2Face&pull=711#prs",
    ),
  ).toBe(
    "http://localhost:4141/?project=%2Frepo&repo=githubnext%2Face&pull=711#prs",
  )
  expect(codingReturn("http://[::1]:4141/")).toBe("http://[::1]:4141/")
})

test.each([
  "https://example.com/",
  "http://127.0.0.1.evil.example/",
  "http://user:secret@127.0.0.1:4141/",
  "javascript:alert(1)",
  "http://127.0.0.1:4141/api/workspace/request",
  "http://127.0.0.1:4141/?token=secret",
  "http://127.0.0.1:4141/#token=secret",
  "http://127.0.0.1:4141/?channel=a&channel=b&chat=1#channels",
  "http://127.0.0.1:4141/?channel=a#channels",
  "http://127.0.0.1:4141/?chat=1#channels",
  "http://127.0.0.1:4141/?channel=a&chat=-1#channels",
  "http://127.0.0.1:4141/?channel=a&chat=9007199254740992#channels",
  "http://127.0.0.1:4141/?project=relative#dashboard",
  "http://127.0.0.1:4141/?project=%2Fpath%00secret#dashboard",
  "http://127.0.0.1:4141/?repo=githubnext%2Face&pull=0#prs",
  "http://127.0.0.1:4141/?pull=711#prs",
  "http://127.0.0.1:4141/?repo=githubnext%2Face&pull=711&issue=12#prs",
])(
  "the review return link rejects unsafe or ambiguous destinations %s",
  (value) => {
    expect(codingReturn(value)).toBeUndefined()
  },
)
