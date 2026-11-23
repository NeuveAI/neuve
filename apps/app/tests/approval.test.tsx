import { expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { ApprovalRequest } from "@ace/channel/protocol";

// The host accepts an answer with no body, or refuses it with the channel's reason.
const sent: unknown[] = [];
let refusal: string | undefined;
mock.module("../src/host", () => ({
	host: {
		channel: async (_channel: string, request: unknown) => {
			sent.push(request);
			if (refusal) throw new Error(refusal);
		},
	},
	onOpen: () => () => {},
}));

const { apply } = await import("../src/transcript");
const { approvalView, shownApprovals } = await import("../src/approval-card");
const { answerApproval, ApprovalCard, NOT_ALLOWED_TO_ANSWER } = await import("../src/approval");
type Transcript = Parameters<typeof apply>[0];
type Item = Transcript["items"][number];

const request = (state: ApprovalRequest["state"], requestId = "r1", patch: object = {}): ApprovalRequest => ({
	requestId,
	callId: "item-1",
	input: { command: "git push origin lane", cwd: "/repo", reason: "needs the network" },
	openedAt: 1000,
	work: "command",
	state,
	...patch,
} as ApprovalRequest);

const name = (author: string) => author;
const states = (transcript: Transcript) =>
	transcript.approvals.map((value) => `${value.requestId}:${approvalView(value, name).state}`);
const html = (value: ApprovalRequest, props: { mayAnswer?: boolean; error?: string } = {}) =>
	renderToStaticMarkup(
		<ApprovalCard view={approvalView(value, name)} mayAnswer={props.mayAnswer ?? true} error={props.error} answer={() => {}} />,
	);
const message = (at: number): Item => ({ kind: "message", key: `m${at}`, entry: at, at, author: "me", text: "", invoked: true });

// Why: Allow runs work outside the runtime's sandbox. If the card believed its own request, a person
// could read Allowed for work the channel never let run.
test("a card stays open after its answer is sent, until the event says otherwise", async () => {
	let transcript = apply({ approvals: [] } as unknown as Transcript, {
		kind: "approval-requests",
		chat: 1,
		requests: [request({ kind: "open" })],
	});
	refusal = undefined;
	expect(await answerApproval("ch", 1, "me", "r1", "allow")).toBeUndefined();
	expect(sent.at(-1)).toEqual({ op: "approval-answer", chat: 1, author: "me", requestId: "r1", decision: "allow" });
	expect(states(transcript)).toEqual(["r1:open"]);

	transcript = apply(transcript, {
		kind: "approval-requests",
		chat: 1,
		requests: [request({ kind: "answered", by: "me", at: 2000, decision: "allow" })],
	});
	expect(states(transcript)).toEqual(["r1:allowed"]);
});

// Why: one piece of work can ask twice (a command, then wider permissions for it). Cards keyed by
// the call would merge them, and an Allow meant for one would answer the other.
test("two requests for one call are two cards, each answered by its own id", async () => {
	const permissions = request({ kind: "open" }, "r2", {
		input: { permissions: { network: { enabled: true }, fileSystem: null }, reason: null },
	});
	const shown = shownApprovals([request({ kind: "open" }), permissions], []);
	expect(shown.map((value) => approvalView(value, name).request)).toEqual(["r1", "r2"]);
	expect(approvalView(permissions, name).rows).toEqual([{ key: "Network", value: "On" }]);
	refusal = undefined;
	await answerApproval("ch", 1, "me", "r2", "deny");
	expect(sent.at(-1)).toMatchObject({ requestId: "r2", decision: "deny" });
});

// Why: a closed request can no longer be answered; buttons there would invite an answer the channel
// refuses, and a card without its reason leaves the person guessing why the work did not run.
test("a closed request shows its reason and no buttons", () => {
	const reasons = {
		"turn-ended": "Closed when the turn ended",
		"runtime-resolved": "Closed by the agent",
		stopped: "Closed when the chat was stopped",
		restarted: "Closed when Neuve restarted",
	} as const;
	for (const [reason, text] of Object.entries(reasons)) {
		const card = html(request({ kind: "closed", reason: reason as keyof typeof reasons }));
		expect(card).toContain(text);
		expect(card).not.toContain(">Allow<");
	}
	expect(html(request({ kind: "closed", reason: "message", by: "alice" }))).toContain("Alice sent a message instead");
});

// Why: an answer to a request that closed meanwhile, or that someone else answered first, is
// refused; a card that swallowed the reason would look answered when nothing ran.
test("an answer the channel refuses shows the refusal on the card", async () => {
	refusal = "this request is no longer open";
	const reason = await answerApproval("ch", 1, "me", "r1", "allow");
	expect(reason).toBe("this request is no longer open");
	const card = html(request({ kind: "open" }), { error: reason });
	expect(card).toContain('role="alert"');
	expect(card).toContain("this request is no longer open");
	expect(card).toContain(">Allow<");
});

// Why: only someone the channel lets ask its agents may answer; buttons for anyone else would only
// collect refusals.
test("a teammate who may not answer sees the card without its buttons", () => {
	const card = html(request({ kind: "open" }), { mayAnswer: false });
	expect(card).toContain(NOT_ALLOWED_TO_ANSWER.replace("'", "&#x27;"));
	expect(card).toContain("git push origin lane");
	expect(card).not.toContain(">Deny<");
});

// Why: the chat keeps every request it ever had. Above the composer an old one would bury the
// current turn, and a card closed by a message must still say who sent it.
test("settled requests stay through their turn; open ones always show", () => {
	const answered = request({ kind: "answered", by: "me", at: 1500, decision: "deny" }, "a");
	const byMessage = request({ kind: "closed", reason: "message", by: "me" }, "m");
	const open = request({ kind: "open" }, "o");
	const ids = (items: Item[]) => shownApprovals([answered, byMessage, open], items).map((value) => value.requestId);
	expect(ids([message(500)])).toEqual(["a", "m", "o"]);
	expect(ids([message(500), message(2000)])).toEqual(["m", "o"]);
	expect(ids([message(500), message(2000), message(3000)])).toEqual(["o"]);
});

// Why: a file change may arrive without the change itself; the card must show what it has and not
// promise a diff it never got.
test("a file change shows each change it carries, and nothing when it carries none", () => {
	const base = { cwd: "/repo", reason: null, command: null };
	const bare = approvalView(request({ kind: "open" }, "f", { work: "file-change", input: base }), name);
	expect(bare.changes).toEqual([]);
	const full = approvalView(
		request({ kind: "open" }, "f", {
			work: "file-change",
			input: { ...base, changes: [{ path: "a.ts", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-a\n+b" }] },
		}),
		name,
	);
	expect(full.changes).toEqual([{ path: "a.ts", kind: "Changed", diff: "@@ -1 +1 @@\n-a\n+b" }]);
});
