// Why: an agent's line shows the model the channel's `agent` event reports at once, and a read of the
// channel's details sent before that event answers with the old model. Landing after the event, it
// must not put the old model back, or the line shows it until something else reads again.
import { expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";

import type { ChannelInfo, Event } from "@ace/host/protocol";

const dom = new JSDOM("<!doctype html><body></body>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.window.document,
	navigator: dom.window.navigator,
	HTMLElement: dom.window.HTMLElement,
	Node: dom.window.Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const reads: ((info: ChannelInfo) => void)[] = [];
let watcher: { event: (event: Event) => void } | undefined;
mock.module("../src/host", () => ({
	host: {
		status: "open",
		settingsVersion: 0,
		subscribe: () => () => {},
		request: async () => {},
		channel: (_: string, request: { op: string }, handlers?: { event: (event: Event) => void }) => {
			if (request.op === "watch") watcher = handlers;
			if (request.op === "info") return new Promise<ChannelInfo>((resolve) => reads.push(resolve));
			return new Promise(() => {});
		},
	},
	onOpen: () => () => {},
}));
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useTranscript } = await import("../src/transcript");

const OLD = { provider: "work", modelId: "old" };
const NEW = { provider: "work", modelId: "new" };
const info = (model: typeof OLD) => ({ id: "c1", owner: "me", chats: [{ id: 2, busy: false, model, effort: "high" }] }) as never;

test("a read sent before an agent event doesn't put the old model back", async () => {
	let shown: ChannelInfo | undefined;
	function Probe() {
		shown = useTranscript("c1", 1, false, "mac").info;
		return null;
	}
	const root = createRoot(document.body.appendChild(document.createElement("div")));
	await act(async () => root.render(<Probe />));
	await act(async () => reads.shift()!(info(OLD)));
	// A run's end sends a read; the model changes before it answers.
	await act(async () => watcher!.event({ kind: "run", chat: 1, state: "end" }));
	await act(async () => watcher!.event({ kind: "agent", chat: 2, model: NEW, effort: "high" }));
	expect(shown?.chats[0]?.model).toEqual(NEW);
	await act(async () => reads.shift()!(info(OLD)));
	expect(shown?.chats[0]?.model).toEqual(NEW);
	await act(async () => root.unmount());
});
