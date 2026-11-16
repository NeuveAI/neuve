import { expect, test } from "bun:test";

import {
  hasAgentMention,
  isAgentAlias,
  normalizeAgentDraft,
  withAgentMention,
  withoutAgentMentions,
  withoutLeadingAgentMention,
} from "../apps/app/src/agent-mention";

test("agent invocation recognizes whole new and legacy aliases, not people or email addresses", () => {
  for (const text of [
    "@neuve help",
    "ask @NEUVE: help",
    "@ace help",
    "ask\n@Ace!",
  ]) {
    expect(hasAgentMention(text)).toBe(true);
  }
  for (const text of [
    "@neuve-user help",
    "@neuve_user help",
    "@neuve2 help",
    "@ace-user help",
    "person@neuve.example",
    "person@ace.example",
    "please help",
  ]) {
    expect(hasAgentMention(text)).toBe(false);
  }
  expect(isAgentAlias("NEUVE")).toBe(true);
  expect(isAgentAlias("Ace")).toBe(true);
  expect(isAgentAlias("neuve-user")).toBe(false);
});

test("drafts and invoked transcript text gain one new prefix and preserve saved legacy mentions", () => {
  expect(withAgentMention("help")).toBe("@neuve help");
  expect(withAgentMention("@neuve help")).toBe("@neuve help");
  expect(withAgentMention("@ace help")).toBe("@ace help");
  expect(withAgentMention("please @ACE help")).toBe("please @ACE help");
  expect(withAgentMention("@neuve-user help")).toBe("@neuve @neuve-user help");
  expect(withAgentMention(withAgentMention("help"))).toBe("@neuve help");
});

test("withdrawn drafts remove either leading alias without eating teammate names", () => {
  expect(withoutLeadingAgentMention("  @neuve first")).toBe("first");
  expect(withoutLeadingAgentMention("@ACE second")).toBe("second");
  expect(withoutLeadingAgentMention("@neuve-user first")).toBe(
    "@neuve-user first",
  );
  expect(withoutLeadingAgentMention("please @neuve help")).toBe(
    "please @neuve help",
  );
  expect(withoutLeadingAgentMention("@neuve ")).toBe("");
});

test("blocked access removes both aliases while preserving teammate mentions and email", () => {
  expect(withoutAgentMentions("@neuve ask @ace again")).toBe("ask again");
  expect(
    withoutAgentMentions("@NEUVE help @neuve-user and person@ace.example"),
  ).toBe("help @neuve-user and person@ace.example");
  expect(withoutAgentMentions("@ace-user help")).toBe("@ace-user help");
});

test("editable legacy drafts adopt the new alias without changing words or teammate handles", () => {
  expect(
    normalizeAgentDraft("@ACE **help** @ace-user and person@ace.example"),
  ).toBe("@neuve **help** @ace-user and person@ace.example");
  expect(withAgentMention(normalizeAgentDraft("@ace help"))).toBe(
    "@neuve help",
  );
  expect(normalizeAgentDraft("@neuve help")).toBe("@neuve help");
});
