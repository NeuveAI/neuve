import { expect, test } from "bun:test";

import { credit, sources, toEvents } from "../apps/app/src/timeline";
import type { Item } from "../apps/app/src/transcript";

const people = {
  "owner@example.com": "owner",
  "teammate@example.com": "teammate",
};
const channel = {
  id: "channel",
  host: "laptop",
  name: "coding",
  prefix: "coding",
  owner: "owner@example.com",
  project: "/project",
  created: 1,
  state: "running" as const,
};
const channels = sources([channel], "laptop");
const by = (asker: string) =>
  credit(asker, channel, channel.owner, people, channels);

const message = (author: string): Item => ({
  kind: "message",
  key: "message",
  entry: 1,
  at: 1_000,
  author,
  text: "@neuve help",
  invoked: true,
});
const reply: Item = {
  kind: "reply",
  key: "reply",
  at: 2_000,
  model: "gpt-6.1-sol",
  text: "Done",
  tools: [],
};

test("completed replies show Neuve and keep their model in the secondary credit", () => {
  const items = [message(channel.owner), structuredClone(reply)];
  const before = structuredClone(items);
  const events = toEvents(
    items,
    "topic",
    false,
    { text: "" },
    people,
    channels,
    {},
    {},
    {},
    by,
    {},
  );
  expect(events[1]).toMatchObject({
    sender: {
      kind: "agent",
      value: "ace:agent",
      display: "Neuve",
      credit: "gpt-6.1-sol",
    },
  });
  expect(items).toEqual(before);
});

test("completed and streaming replies retain both model and teammate attribution", () => {
  const items = [message("teammate@example.com"), reply];
  const draft = { text: "Working", model: "gpt-6.1-sol" };
  const before = structuredClone({ items, draft });
  const events = toEvents(
    items,
    "topic",
    true,
    draft,
    people,
    channels,
    {},
    {},
    {},
    by,
    {},
  );
  const sender = {
    kind: "agent",
    value: "ace:agent",
    display: "Neuve",
    credit:
      "gpt-6.1-sol · asked by teammate · ran on your laptop with your key",
  };
  expect(events[1]).toMatchObject({ sender });
  expect(events[2]).toMatchObject({ uid: "draft", sender, streaming: true });
  expect({ items, draft }).toEqual(before);
});

test("a draft without a model still names Neuve and retains its attribution", () => {
  const events = toEvents(
    [message("teammate@example.com")],
    "topic",
    true,
    { text: "Working" },
    people,
    channels,
    {},
    {},
    {},
    by,
    {},
  );
  expect(events[1]).toMatchObject({
    sender: {
      kind: "agent",
      value: "ace:agent",
      display: "Neuve",
      credit: "asked by teammate · ran on your laptop with your key",
    },
    streaming: true,
  });
  const uncredited = toEvents(
    [],
    "topic",
    true,
    { text: "Working" },
    people,
    channels,
    {},
    {},
    {},
    by,
    {},
  );
  expect(
    uncredited[0] && "sender" in uncredited[0] && uncredited[0].sender,
  ).toEqual({
    kind: "agent",
    value: "ace:agent",
    display: "Neuve",
  });
});

test("human and cross-channel authors retain their existing names and identities", () => {
  const events = toEvents(
    [message("teammate@example.com"), message("agent@coding")],
    "topic",
    false,
    { text: "" },
    people,
    channels,
    {},
    {},
    {},
    by,
    {},
  );
  expect(events[0]).toMatchObject({
    sender: {
      kind: "user",
      value: "teammate@example.com",
      display: "teammate",
    },
  });
  expect(events[1]).toMatchObject({
    sender: { kind: "user", value: "agent@coding", display: "#coding" },
  });
});
