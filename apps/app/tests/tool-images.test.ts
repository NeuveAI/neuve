import { expect, mock, test } from "bun:test";

mock.module("../src/host", () => ({ host: { channel: async () => undefined }, onOpen: () => () => {} }));
const { apply } = await import("../src/transcript");
const { toEvents } = await import("../src/timeline");
type Transcript = Parameters<typeof apply>[0];

const CHANNEL = "0123456789abcdef";

function shown(origin?: string) {
	let state = { items: [] } as unknown as Transcript;
	state = apply(state, { kind: "tool", chat: 3, at: 1, model: "m", call: "toolu|01/a b", name: "screenshot", args: {} });
	// A forked chat's inherited result names the chat that stored it, not the one being viewed.
	state = apply(state, {
		kind: "result",
		chat: 2,
		call: "toolu|01/a b",
		error: false,
		text: "",
		images: [{ mimeType: "image/png" }, { mimeType: "image/jpeg" }],
	});
	const events = toEvents(
		state.items, CHANNEL, false, { text: "" }, {}, new Map(), {}, {}, {}, () => undefined, {},
		new Map(), new Map(), undefined, origin,
	);
	return events.flatMap((event) =>
		"content" in event && Array.isArray(event.content)
			? event.content.flatMap((part) => part.type === "tool" ? part.result?.images ?? [] : [])
			: []
	);
}

// Why: the address is the app's half of a contract with the host's image route; a wrong chat,
// an unescaped call or a shifted index draws a broken image only once a person opens the group.
test("a tool result's images are addressed by the host's route, by the chat that stored them", () => {
	expect(shown()).toEqual([
		"/images/0123456789abcdef/2/toolu%7C01%2Fa%20b/0",
		"/images/0123456789abcdef/2/toolu%7C01%2Fa%20b/1",
	]);
	expect(shown("https://mac.tailnet.ts.net:5141")).toEqual([
		"https://mac.tailnet.ts.net:5141/images/0123456789abcdef/2/toolu%7C01%2Fa%20b/0",
		"https://mac.tailnet.ts.net:5141/images/0123456789abcdef/2/toolu%7C01%2Fa%20b/1",
	]);
});
