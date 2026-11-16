import { expect, test } from "bun:test";

import { mentionTokens } from "../packages/ui/src/components/composer/mention-tokens";

test("composer aliases recognize canonical and legacy invocation ranges", () => {
  expect(mentionTokens("@neuve ask @ACE: help", ["neuve", "ace"])).toEqual([
    { from: 0, to: 6 },
    { from: 11, to: 15 },
  ]);
  expect(mentionTokens(" @ace help", ["neuve", "ace"])).toEqual([
    { from: 1, to: 5 },
  ]);
});

test("composer aliases leave teammate handles and email addresses alone", () => {
  for (const text of [
    "@ace-user",
    "@ace_user",
    "@ace2",
    "@neuve-user",
    "person@ace.example",
    "person@neuve.example",
    "ace help",
  ]) {
    expect(mentionTokens(text, ["neuve", "ace"])).toEqual([]);
  }
  expect(mentionTokens("@ace help", ["neuve"])).toEqual([]);
});
