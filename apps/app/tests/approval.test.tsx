import { expect, mock, test } from "bun:test";
import { JSDOM } from "jsdom";

import type { ApprovalAsked, ApprovalFileChange, ApprovalPath, ApprovalRequest } from "@ace/channel/protocol";

// The component is clicked in a real DOM; React reads these globals when it loads.
const dom = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.window.document,
	navigator: dom.window.navigator,
	HTMLElement: dom.window.HTMLElement,
	customElements: dom.window.customElements,
	Node: dom.window.Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

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

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { renderToStaticMarkup } = await import("react-dom/server");
const { apply } = await import("../src/transcript");
const { approvalView, HIDDEN_NOTE, UNRECOGNISED, shownApprovals, visiblePath } = await import("../src/approval-card");
const { fixture, KINDS, PROBES } = await import("../src/approval.fixtures");
const { ApprovalAskedSchema } = await import("@ace/channel/frame");
const { patchFile } = await import("@ace/ui");
const { Approval, ApprovalCard, NOT_ALLOWED_TO_ANSWER } = await import("../src/approval");
type Transcript = Parameters<typeof apply>[0];
type Item = Transcript["items"][number];

const command: ApprovalAsked = { kind: "command", command: "git push origin lane", folder: "/repo", reason: "needs the network" };
const request = (state: ApprovalRequest["state"], requestId = "r1", asked: ApprovalAsked = command): ApprovalRequest =>
	({ ...fixture({ label: requestId, asked }, state, requestId), openedAt: 1000 });

const name = (author: string) => author;
const view = (value: ApprovalRequest) => approvalView(value, name);
const visibleOf = (text: string) => text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (char) => char === "\n" || char === "\t" ? char : `\\u{${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}}`);
const html = (value: ApprovalRequest, props: { mayAnswer?: boolean; error?: string } = {}) =>
	renderToStaticMarkup(
		<ApprovalCard view={view(value)} mayAnswer={props.mayAnswer ?? true} error={props.error} answer={() => {}} />,
	);
const message = (at: number): Item => ({ kind: "message", key: `m${at}`, entry: at, at, author: "me", text: "", invoked: true });

/** Mounts the answering card for one request; `show` re-renders it as a new event would. */
function mount(value: ApprovalRequest) {
	const container = document.body.appendChild(document.createElement("div"));
	const root = createRoot(container);
	const show = (next: ApprovalRequest) =>
		act(() => root.render(<Approval channel="ch" chat={1} user="me" view={view(next)} mayAnswer />));
	const card = () => container.querySelector("section")!;
	const button = (label: string) =>
		[...card().querySelectorAll("button")].find((item) => item.textContent?.startsWith(label))!;
	return { show, card, button, unmount: () => act(() => (root.unmount(), container.remove())) };
}

// Why: Allow runs work outside the runtime's sandbox. If the card believed its own click, a person
// could read Allowed for work the channel never let run.
test("a click changes nothing on the card until the channel's event does", async () => {
	refusal = undefined;
	const open = request({ kind: "open" });
	const card = mount(open);
	await card.show(open);
	await act(async () => card.button("Allow").click());
	expect(sent.at(-1)).toEqual({ op: "approval-answer", chat: 1, author: "me", requestId: "r1", decision: "allow" });
	expect(card.card().getAttribute("aria-label")).toBe("Command, Waiting");
	expect(card.button("Allowing").getAttribute("aria-disabled")).toBe("true");

	// A second click while the answer is out sends nothing more.
	const count = sent.length;
	await act(async () => card.button("Deny").click());
	expect(sent.length).toBe(count);

	const transcript = apply({ approvals: [] } as unknown as Transcript, {
		kind: "approval-requests",
		chat: 1,
		requests: [request({ kind: "answered", by: "me", at: 2000, decision: "allow" })],
	});
	await card.show(transcript.approvals[0]!);
	expect(card.card().getAttribute("aria-label")).toBe("Command, Allowed");
	expect(card.card().querySelector("button")).toBeNull();
	await card.unmount();
});

// Why: an answer to a request that closed meanwhile, or that someone else answered first, is
// refused; a card that swallowed the reason would look answered when nothing ran.
test("an answer the channel refuses shows the refusal on the card and can be sent again", async () => {
	refusal = "This request already has an answer. It was Allow.";
	const open = request({ kind: "open" });
	const card = mount(open);
	await card.show(open);
	await act(async () => card.button("Allow").click());
	expect(card.card().querySelector('[role="alert"]')?.textContent).toBe("This request already has an answer. It was Allow.");
	expect(card.card().getAttribute("aria-label")).toBe("Command, Waiting");
	expect(card.button("Allow").getAttribute("aria-disabled")).toBeNull();
	await card.unmount();
});

// Why: one piece of work can ask twice (a command, then wider access for it). Cards keyed by
// the call would merge them, and an Allow meant for one would answer the other.
test("two requests for one call are two cards, each answered by its own id", async () => {
	refusal = undefined;
	const command = request({ kind: "open" });
	const access = request({ kind: "open" }, "r2", { kind: "wider-access", paths: [], network: true });
	expect(command.callId).toBe(access.callId);
	const shown = shownApprovals([command, access], []);
	expect(shown.map((value) => value.requestId)).toEqual(["r1", "r2"]);
	const cards = shown.map((value) => mount(value));
	await Promise.all(cards.map((card, index) => card.show(shown[index]!)));
	expect(cards.map((card) => card.card().getAttribute("aria-label"))).toEqual(["Command, Waiting", "More access, Waiting"]);

	const count = sent.length;
	await act(async () => cards[1]!.button("Deny").click());
	expect(sent.slice(count)).toEqual([{ op: "approval-answer", chat: 1, author: "me", requestId: "r2", decision: "deny" }]);
	// The first card is untouched: still answerable, not waiting on the second's answer.
	expect(cards[0]!.button("Allow").getAttribute("aria-disabled")).toBeNull();
	for (const card of cards) await card.unmount();
});

// Why: a closed request can no longer be answered; buttons there would invite an answer the channel
// refuses, and a card without its reason leaves the person guessing why the work did not run.
test("a closed request shows its reason and no buttons", () => {
	const reasons = {
		"turn-ended": "Closed when the turn ended",
		"runtime-resolved": "Withdrawn before an answer",
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

// Why: only someone the channel lets ask its agents may answer; buttons for anyone else would only
// collect refusals.
test("a teammate who may not answer sees the card without its buttons", () => {
	const card = html(request({ kind: "open" }), { mayAnswer: false });
	expect(card).toContain(NOT_ALLOWED_TO_ANSWER.replace("'", "&#x27;"));
	expect(card).not.toContain(">Deny<");
});

const probe = (label: string) => fixture(PROBES.find((value) => value.label === label)!);

// Why: a person allows what they read. A command cut off at the card's edge or below a fold could
// hide its dangerous part, so every line of it is in the card, wrapping, with no height limit.
test("a long or many-line command is shown in full and wraps", () => {
	for (const label of ["Long one-line command", "Many lines"]) {
		const value = probe(label);
		const card = html(value);
		const text = (value.asked as Extract<ApprovalAsked, { kind: "command" }>).command;
		expect(card).toContain(text.replaceAll("&", "&amp;").replaceAll(">", "&gt;"));
		expect(card).toContain("!whitespace-pre-wrap");
		expect(card).not.toMatch(/max-h|truncate/);
	}
});

// What a person reads for each closed value, as the card must word it.
const ACCESS = { read: "Read", write: "Write", deny: "No access" } as const;
const CHANGE = { add: "Added", delete: "Deleted", update: "Changed" } as const;
const NETWORK = (value: boolean | null) => value === null ? "Not asked" : value ? "On" : "Off";
const TARGET = (value: ApprovalPath, folder?: string) => {
	const where = folder === undefined ? "" : ` (${folder})`;
	switch (value.kind) {
		case "path": return value.path;
		case "glob": return `${value.pattern} (pattern)`;
		case "project-roots": return `${value.subpath === undefined ? "This chat's" : `${value.subpath} in this chat's`} working folders${where}`;
		case "root": return "/ (the whole disk)";
		case "minimal": return "The system's minimal folders";
		case "tmpdir": return "The temporary folder ($TMPDIR)";
		case "slash-tmp": return "/tmp";
	}
};

/** The lines a card must show for what is asked: each field, with its label where it has one. */
function expected(asked: ApprovalAsked): string[] {
	const reason = asked.reason === undefined ? [] : [asked.reason];
	switch (asked.kind) {
		case "command":
			return [asked.command, `Folder ${asked.folder}`, ...(asked.network ? [`Network ${asked.network.host} (${asked.network.protocol})`] : []), ...reason];
		case "file-change":
			return [
				...(asked.changes ?? []).flatMap((change) => [
					`${CHANGE[change.kind]} ${change.path}`,
					...(change.kind === "update" && change.newPath !== undefined ? [`Moved to ${change.newPath}`] : []),
				]),
				...reason,
			];
		case "wider-access":
			return [
				...asked.paths.map((path) => `${ACCESS[path.access]} ${TARGET(path.target, asked.folder)}`),
				`Network ${NETWORK(asked.network)}`,
				...(asked.folder === undefined ? [] : [`Folder ${asked.folder}`]),
				...(asked.globDepthLimit === undefined ? [] : [`Pattern depth ${asked.globDepthLimit}`]),
				...reason,
			];
		case "server-prompt":
			return [`Prompt from ${asked.server}`, asked.message, ...(asked.url === undefined ? [] : [`Link ${asked.url}`]), ...reason];
		case "unrecognised":
			return reason;
	}
}

/** The lines the diff view draws for a patch, with + or - for an added or removed line. */
function drawn(patch: string): string[] {
	if (!patch) return [];
	const file = patchFile(patch)!;
	expect(file).not.toBeNull();
	return file.hunks.flatMap((hunk) => hunk.hunkContent.flatMap((part) =>
		part.type === "context"
			? file.additionLines.slice(part.additionLineIndex, part.additionLineIndex + part.lines).map((line) => ` ${line.replace(/\n$/, "")}`)
			: [
				...file.deletionLines.slice(part.deletionLineIndex, part.deletionLineIndex + part.deletions).map((line) => `-${line.replace(/\n$/, "")}`),
				...file.additionLines.slice(part.additionLineIndex, part.additionLineIndex + part.additions).map((line) => `+${line.replace(/\n$/, "")}`),
			]
	));
}

/** The lines a change asks to write: an added or deleted file's every line, or an update's diff lines. */
function lines(change: ApprovalFileChange): string[] {
	if (change.kind !== "update") {
		const sign = change.kind === "add" ? "+" : "-";
		return change.diff ? visibleOf(change.diff).replace(/\n$/, "").split("\n").map((line) => sign + line) : [];
	}
	return visibleOf(change.diff).split("\n").filter((line) => /^[ +-]/.test(line) && !/^(?:---|\+\+\+) /.test(line));
}

/** Every field path a schema allows, nested ones included: `changes[].newPath`, `network.host`. */
function fieldsIn(schema: unknown, prefix = ""): string[] {
	const def = (schema as { _zod: { def: Record<string, unknown> } })._zod.def;
	if (def.type === "object") {
		return Object.entries(def.shape as Record<string, unknown>)
			.flatMap(([key, value]) => [`${prefix}${key}`, ...fieldsIn(value, `${prefix}${key}.`)]);
	}
	if (def.type === "array") return fieldsIn(def.element, `${prefix.slice(0, -1)}[].`);
	if (def.type === "union") return (def.options as unknown[]).flatMap((option) => fieldsIn(option, prefix));
	if (def.innerType) return fieldsIn(def.innerType, prefix);
	return [];
}

/** Every field path a fixture sets. */
function fieldsOf(value: unknown, prefix = ""): string[] {
	if (Array.isArray(value)) return value.flatMap((item) => fieldsOf(item, `${prefix.slice(0, -1)}[].`));
	if (typeof value !== "object" || value === null) return [];
	return Object.entries(value).flatMap(([key, item]) => [`${prefix}${key}`, ...fieldsOf(item, `${prefix}${key}.`)]);
}

// Why: Allow grants everything asked. Each kind's fixtures set every field its schema has and
// every value of each closed list (access, kind of path, kind of change, network on, off and not
// asked), and each must reach the card as a person reads it; a field or value added to the contract
// fails here until the card shows it.
test("every field of every kind of request is on the card", () => {
	const all = [...KINDS, ...PROBES].map((value) => value.asked);
	for (const option of ApprovalAskedSchema.options) {
		const kind = option.shape.kind.value;
		const keys = new Set(all.filter((value) => value.kind === kind).flatMap((value) => fieldsOf(value)));
		expect([...keys].sort()).toEqual([...new Set(fieldsIn(option))].sort());
	}
	const access = all.flatMap((value) => value.kind === "wider-access" ? value.paths : []);
	expect(new Set(access.map((path) => path.access))).toEqual(new Set(Object.keys(ACCESS)));
	const targets = ApprovalAskedSchema.options.find((option) => option.shape.kind.value === "wider-access")!
		.shape.paths.element.shape.target.options.flatMap((option) => option.shape.kind.options ?? [option.shape.kind.value]);
	expect(new Set(access.map((path) => path.target.kind))).toEqual(new Set(targets));
	expect(new Set(all.flatMap((value) => value.kind === "wider-access" ? [value.network] : []))).toEqual(new Set([true, false, null]));
	expect(new Set(all.flatMap((value) => value.kind === "file-change" ? (value.changes ?? []).map((change) => change.kind) : [])))
		.toEqual(new Set(Object.keys(CHANGE)));

	for (const value of [...KINDS, ...PROBES]) {
		// Details holds the raw input; what is asked must show outside it, as text a person reads.
		const card = html(fixture(value)).replace(/<details[\s\S]*<\/details>/, "").replace(/<[^>]+>/g, " ")
			.replaceAll("&amp;", "&").replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&quot;", '"').replaceAll("&#x27;", "'")
			.replace(/[ ]+/g, " ");
		for (const line of expected(value.asked)) {
			const forms = [visibleOf(line), visiblePath(line)].map((form) => form.replace(/[ ]+/g, " "));
			expect(forms.some((form) => card.includes(form))).toBe(true);
		}
		// The diff view draws a change in a custom element only after highlighting, which this test
		// environment cannot run, so what it would draw is read with the view's own parser instead.
		const changes = view(fixture(value)).changes;
		for (const [index, change] of (value.asked.kind === "file-change" ? value.asked.changes ?? [] : []).entries()) {
			expect(drawn(changes[index]!.patch)).toEqual(lines(change));
		}
	}
});

// Why: the card cannot summarise every request; then it says so and shows the raw request open,
// never a narrower summary than what Allow grants.
test("an unrecognised request says so and shows the whole request open", () => {
	for (const label of ["Not summarised", "A plain string"]) {
		const value = probe(label);
		expect(view(value).notes).toContain(UNRECOGNISED);
		const card = html(value);
		expect(card).toMatch(/<details[^>]* open=""/);
		expect(card).toContain("rm");
	}
	expect(html(request({ kind: "open" }))).not.toMatch(/<details[^>]* open=""/);
	const disk = view(probe("Write access to the whole disk"));
	expect(disk.rows).toEqual([{ key: "Write", value: "/ (the whole disk)" }, { key: "Network", value: "Not asked" }]);
});

// Why: a file change may arrive without the change itself; the card must say so, never look like
// a change with nothing in it.
test("a file change shows each change it carries, and says when it carries none", () => {
	const bare = view(request({ kind: "open" }, "f", { kind: "file-change", changes: null }));
	expect(bare.changes).toEqual([]);
	expect(bare.notes).toEqual(["The change itself was not sent with this request."]);
	const full = view(request({ kind: "open" }, "f", { kind: "file-change", changes: [{ kind: "update", path: "a.ts", newPath: "b.ts", diff: "@@ -1 +1 @@\n-a\n+b" }] }));
	expect(full.changes).toEqual([{ kind: "Changed", path: "a.ts", to: "b.ts", patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b" }]);
	expect(full.notes).toEqual([]);
});

// Why: Codex sends an added file's whole content where a diff would be. Shown under made-up
// headers it read as a broken patch; it must reach the diff view as the hunk that adds each line.
test("an added file sent as its content shows as added lines in the diff view", () => {
	const shown = view(probe("Added file sent as its content"));
	const patch = shown.changes[0]!.patch;
	expect(patch).toBe("--- /dev/null\n+++ /Volumes/LaCie Blu/code/neuve-lanes/approvals/outside/notes.md\n@@ -0,0 +1,1 @@\n+hello");
	expect(drawn(patch)).toEqual(["+hello"]);
});

// Why: an added or deleted file's content is whole lines, whatever it looks like. A .patch file being
// added would otherwise be read as a patch, and the card would show a change to src/retry.ts
// instead of the file Allow writes.
test("an added file whose content looks like a diff shows every line as added", () => {
	const value = probe("Added patch file");
	const content = (value.asked as Extract<ApprovalAsked, { kind: "file-change" }>).changes![0]!.diff;
	expect(drawn(view(value).changes[0]!.patch)).toEqual(content.replace(/\n$/, "").split("\n").map((line) => `+${line}`));
});

// Why: a right-to-left override can make a command read as another one, escape or backspace
// characters can hide part of it, and a newline in a path can forge a second diff header; each must
// show as itself, and the card must say they are there.
test("control, direction and zero-width characters show escaped, and the card says so", () => {
	for (const label of ["Direction override", "Control characters"]) {
		const shown = view(probe(label));
		expect(shown.notes).toContain(HIDDEN_NOTE);
		for (const text of [shown.code!.text, shown.details]) {
			expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/);
		}
	}
	expect(view(probe("Direction override")).code!.text).toBe("echo \\u{202E}hs.lave | lruc\\u{202C} done");
	expect(view(probe("Control characters")).code!.text).toBe("ls\\u{0008}\\u{0008}\\u{0008} rm -rf /tmp/x \\u{001B}[2K\\u{200B}");
	const path = view(probe("A newline in a file's path"));
	expect(path.notes).toContain(HIDDEN_NOTE);
	expect(path.changes[0]!.path).toBe("a.ts\\u{000A}+++ b/evil.ts");
	expect(path.changes[0]!.patch.split("\n").filter((line) => line.startsWith("+++"))).toHaveLength(1);
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
