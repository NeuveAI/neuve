import { expect, mock, test } from "bun:test";

import type { Event as ChannelEvent } from "@ace/channel/protocol";
import type { Event } from "@ace/ui";

import type { Item } from "../src/transcript";
import { toEvents } from "../src/timeline";

mock.module("../src/host", () => ({ host: { channel: async () => undefined }, onOpen: () => () => {} }));
const { apply } = await import("../src/transcript");

const reply = (key: string, mode?: "plan" | "ace"): Item => ({
  kind: "reply",
  key,
  entry: 1,
  at: 1_000,
  model: "model",
  text: "Here is the plan.",
  tools: [],
  ...(mode ? { mode } : {}),
});

// Why: the label is the only sign of which mode a reply was written in. A run outside plan mode
// labelled Plan, or a planning run unlabelled, would mislead the person about what the agent
// could do, so each reply is labelled from its own run's mode and nothing else.
test("only a reply its run wrote in plan mode carries the Plan label", () => {
  const items: Item[] = [
    { kind: "message", key: "m", entry: 0, at: 500, author: "owner", text: "plan it", invoked: true },
    reply("planned", "plan"),
    reply("built", "ace"),
    reply("older"),
  ];
  const events = toEvents(items, "c", false, { text: "" }, {}, new Map(), {}, {}, {}, () => undefined, {});
  const labels = Object.fromEntries(
    events.map((event) => [event.uid, (event as { agent?: { mode: string } }).agent?.mode]),
  );
  expect(labels).toEqual({ m: undefined, planned: "plan", built: undefined, older: undefined });
});

// Why: a turn that only wrote the plan sends no reply, so it has no mode of its own. Unlabelled, the
// plan's own turn would read as an ordinary one. The plan tool succeeds only in plan mode; a call it
// refused outside plan mode says nothing about the mode, so that turn stays unlabelled.
test("a turn that only wrote the plan carries the Plan label, a refused write does not", () => {
  const write = (call: string, error: boolean) => ({
    call,
    name: "plan_write",
    args: {},
    result: { error, text: error ? "Plans can only be written in Plan mode." : "Plan ready for approval." },
  });
  const items: Item[] = [
    { ...reply("wrote"), text: "", tools: [write("c1", false)] },
    { ...reply("refused"), text: "", tools: [write("c2", true)] },
    { ...reply("read"), text: "", tools: [{ call: "c3", name: "read", args: {} }] },
  ];
  const events = toEvents(items, "c", false, { text: "" }, {}, new Map(), {}, {}, {}, () => undefined, {});
  expect(events.map((event) => (event as { agent?: { mode: string } }).agent?.mode))
    .toEqual(["plan", undefined, undefined]);
});

// Why: the channel starts the turn after Plan mode turns on with an input of its own. Drawn as a
// message it reads as one from "unknown", and crediting its run to that author reads "asked by
// unknown"; the turn belongs to whoever asked for the plan.
test("the channel's Plan mode input draws no row and leaves the plan's run to the person who asked", () => {
  const said = (entry: number, author: string, system?: { kind: "neuve:plan:entered" }): ChannelEvent => ({
    kind: "message",
    chat: 1,
    entry,
    at: entry * 1_000,
    author,
    text: "Plan mode is on.",
    invoked: true,
    ...(system ? { system } : {}),
  });
  let state = { items: [], typing: {} } as unknown as Parameters<typeof apply>[0];
  state = apply(state, said(1, "teammate"));
  state = { ...state, items: [...state.items, reply("asked")] };
  state = apply(state, said(2, "unknown", { kind: "neuve:plan:entered" }));
  state = { ...state, items: [...state.items, reply("planned", "plan")] };
  const events = toEvents(
    state.items, "c", false, { text: "" }, {}, new Map(), {}, {}, {}, (asker) => `asked by ${asker}`, {},
  ) as Extract<Event, { type: "message" }>[];
  expect(events.map((event) => event.uid)).toEqual(["e1", "asked", "planned"]);
  expect(events.at(-1)!.sender).toMatchObject({ credit: "model · asked by teammate" });
});
