// Why: an agent's line shows the model the channel's `agent` event reports at once, and a read of the
// channel's details sent before that event answers with the old model. Landing after the event, it
// must not put the old model back, or the line shows it until something else reads again. Likewise
// a read that answers after a later read has landed holds older details, such as no chat for an
// agent just started, and must not replace the later ones.
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
const chat = (id: number, model: typeof OLD) => ({ id, busy: false, model, effort: "high" });
const info = (model: typeof OLD, ...more: number[]) =>
	({ id: "c1", owner: "me", chats: [chat(2, model), ...more.map((id) => chat(id, model))] }) as never;

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

test("a read that answers after a later one has landed doesn't drop a new agent's chat", async () => {
	let shown: ChannelInfo | undefined;
	function Probe() {
		shown = useTranscript("c1", 1, false, "mac").info;
		return null;
	}
	reads.length = 0;
	const root = createRoot(document.body.appendChild(document.createElement("div")));
	await act(async () => root.render(<Probe />));
	await act(async () => reads.shift()!(info(OLD)));
	// A run's end sends one read; a new agent announced before it answers sends another.
	await act(async () => watcher!.event({ kind: "run", chat: 1, state: "end" }));
	const build = {
		id: "b",
		chat: 1,
		plan: { id: "p", hash: "h", title: "t", call: "w" },
		approved: { by: "me", at: 0 },
		state: { kind: "started" },
		agents: [{ chat: 3, role: "implementer", started: 0, state: "running" }],
	};
	await act(async () => watcher!.event({ kind: "builds", builds: [build], messages: [] } as never));
	const [first, second] = reads.splice(0);
	await act(async () => second!(info(OLD, 3)));
	await act(async () => first!(info(OLD)));
	expect(shown?.chats.map(({ id }) => id)).toEqual([2, 3]);
	await act(async () => root.unmount());
});
