import { expect, mock, test } from "bun:test";

mock.module("../src/host", () => ({ host: { channel: async () => undefined }, onOpen: () => () => {} }));
const { apply, keep, reopen } = await import("../src/transcript");
type Transcript = Parameters<typeof apply>[0];

const shown = {
	items: [{ kind: "message", key: "e1", entry: 1, at: 1, author: "me", text: "Hi", invoked: false }],
	returned: [{ submission: 2, author: "me", text: "Queued", invoked: true }],
	typing: { you: 1 },
	draft: "Half a repl",
	live: true,
	older: true,
} as unknown as Transcript;

// Why: a chat opened again draws its kept transcript at once, so what comes back must be only what
// the replay will confirm: a stale draft, typing line or returned message (which refills the
// composer) must not return, and a copy left longer than five minutes ago must not be drawn.
test("a left chat comes back without its draft, typing or returned messages, for five minutes", () => {
	keep("c/1", { transcript: shown, turns: 30 }, 0);
	const back = reopen("c/1", 5 * 60_000);
	expect(back?.turns).toBe(30);
	expect(back?.transcript.items.map((item) => item.text)).toEqual(["Hi"]);
	expect(back?.transcript).toMatchObject({ draft: "", typing: {}, returned: [], live: true, older: true });
	expect(reopen("c/1", 5 * 60_000 + 1)).toBeUndefined();
	keep("c/2", { transcript: { ...shown, live: false }, turns: 10 }, 0);
	expect(reopen("c/2", 0)).toBeUndefined();
});
