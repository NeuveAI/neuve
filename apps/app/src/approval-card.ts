import type { ApprovalAsked, ApprovalPath, ApprovalRequest } from "@ace/channel/protocol";

import type { Item } from "./transcript";

const TIME = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

export type ApprovalState = "open" | "allowed" | "denied" | "closed";

/**
 * What one request's card shows, drawn from what the request asks and nothing else. Every string
 * in it has its hidden characters made visible.
 */
export type ApprovalCardView = {
	request: string;
	title: string;
	state: ApprovalState;
	/** Who answered and when, or why it closed; none while open. */
	meta?: string;
	/** The command, exactly as sent. */
	code?: { text: string; language?: string };
	/** Labelled values such as the folder, each path asked for, or the network. */
	rows: { key: string; value: string }[];
	/** Each file a file change names; `patch` is a unified diff with file headers. */
	changes: { kind: string; path: string; to?: string; patch: string }[];
	/** A server's message, verbatim. */
	text?: string;
	/** The runtime's reason, verbatim. */
	reason?: string;
	notes: string[];
	note?: string;
	/** The runtime's raw input as JSON. */
	details: string;
	/** The card cannot summarise the request, so the raw input is shown open. */
	partial: boolean;
};

/**
 * Control, format and line-separator characters other than newline and tab: escapes, backspace,
 * bidirectional overrides and isolates, zero-width characters. Each could make the text a person
 * reads differ from the text that runs.
 */
const HIDDEN = /(?![\n\t])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
/** In a path, which is one line, a newline or tab is hidden too. */
const HIDDEN_IN_PATH = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

const escape = (char: string) => `\\u{${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}}`;

/** The text with each hidden character written as `\u{XXXX}`, so a person sees it. */
export function visible(text: string) {
	return text.replace(HIDDEN, escape);
}

/** A path with every control character escaped, newlines and tabs included. */
export function visiblePath(text: string) {
	return text.replace(HIDDEN_IN_PATH, escape);
}

/** Whether any string or key in a JSON value holds a hidden character. */
function holdsHidden(value: unknown): boolean {
	if (typeof value === "string") return visible(value) !== value;
	if (Array.isArray(value)) return value.some(holdsHidden);
	if (typeof value === "object" && value !== null) {
		return Object.entries(value).some(([key, item]) => holdsHidden(key) || holdsHidden(item));
	}
	return false;
}

const CLOSED: Record<Exclude<Extract<ApprovalRequest["state"], { kind: "closed" }>["reason"], "message">, string> = {
	"turn-ended": "The turn ended",
	"runtime-resolved": "Withdrawn before an answer",
	stopped: "The chat was stopped",
	restarted: "Neuve restarted",
};

const capital = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

function status(request: ApprovalRequest, name: (author: string) => string): [ApprovalState, string?] {
	const { state } = request;
	if (state.kind === "open") return ["open"];
	if (state.kind === "answered") {
		return [state.decision === "allow" ? "allowed" : "denied", `${name(state.by)} · ${TIME.format(state.at)}`];
	}
	if (state.reason === "message") return ["closed", `${capital(name(state.by))} sent a message instead`];
	return ["closed", CLOSED[state.reason]];
}

/**
 * A file's change as a unified diff with file headers, which the diff view needs. An added or
 * deleted file's `diff` is its whole content (Codex sends it so), always shown as lines added or
 * removed, whatever they look like: a `.patch` file being added is never read as a patch. Only an
 * update's `diff` is a diff; it gets headers when it has none.
 */
function patch(path: string, kind: string, diff: string) {
	if (!diff) return diff;
	if (kind === "update" && /^(?:diff --git |--- )/.test(diff)) return diff;
	const name = (side: "a" | "b") => path.startsWith("/") ? path : `${side}/${path}`;
	const before = kind === "add" ? "/dev/null" : name("a");
	const after = kind === "delete" ? "/dev/null" : name("b");
	return `--- ${before}\n+++ ${after}\n${kind === "update" ? diff : whole(kind, diff)}`;
}

/** A whole file's content as the one hunk that adds it, or removes it. */
function whole(kind: string, content: string) {
	const lines = content.replace(/\n$/, "").split("\n");
	const sign = kind === "add" ? "+" : "-";
	const range = kind === "add" ? `-0,0 +1,${lines.length}` : `-1,${lines.length} +0,0`;
	return `@@ ${range} @@\n${lines.map((line) => sign + line).join("\n")}`;
}

// "No access", not "Deny", so a path row is never read as the answer beside the Deny button.
const ACCESS = { read: "Read", write: "Write", deny: "No access" } as const;
const CHANGE = { add: "Added", delete: "Deleted", update: "Changed" } as const;

function target(value: ApprovalPath): string {
	switch (value.kind) {
		case "path":
			return visiblePath(value.path);
		case "glob":
			return `${visiblePath(value.pattern)} (pattern)`;
		case "project-roots":
			return value.subpath === undefined
				? "This chat's working folders"
				: `${visiblePath(value.subpath)} in this chat's working folders`;
		case "root":
			return "/ (the whole disk)";
		case "minimal":
			return "The system's minimal folders";
		case "tmpdir":
			return "The temporary folder ($TMPDIR)";
		case "slash-tmp":
			return "/tmp";
	}
}

type Parts = Pick<ApprovalCardView, "title" | "code" | "rows" | "changes" | "text" | "note"> & { notes?: string[] };

/** Every field of what is asked, each in its own place on the card. */
function parts(asked: ApprovalAsked, toolName: string | undefined): Parts {
	switch (asked.kind) {
		case "command":
			return {
				title: "Command",
				code: { text: visible(asked.command), language: "bash" },
				rows: [
					{ key: "Folder", value: visiblePath(asked.folder) },
					...(asked.network
						? [{ key: "Network", value: `${visible(asked.network.host)} (${asked.network.protocol})` }]
						: []),
				],
				changes: [],
			};
		case "file-change":
			return {
				title: "File change",
				rows: [],
				changes: (asked.changes ?? []).map((change) => ({
					kind: CHANGE[change.kind],
					path: visiblePath(change.path),
					...(change.kind === "update" && change.newPath !== undefined ? { to: visiblePath(change.newPath) } : {}),
					patch: visible(patch(visiblePath(change.path), change.kind, change.diff)),
				})),
				notes: asked.changes === null ? ["The change itself was not sent with this request."] : [],
			};
		case "wider-access":
			return {
				title: "More access",
				rows: [
					...asked.paths.map((path) => ({ key: ACCESS[path.access], value: target(path.target) })),
					...(asked.paths.length ? [] : [{ key: "Paths", value: "None" }]),
					...(asked.network === null ? [] : [{ key: "Network", value: asked.network ? "On" : "Off" }]),
					...(asked.folder === undefined ? [] : [{ key: "Folder", value: visiblePath(asked.folder) }]),
					...(asked.globDepthLimit === undefined ? [] : [{ key: "Pattern depth", value: `${asked.globDepthLimit}` }]),
				],
				changes: [],
				note: "For this turn only.",
			};
		case "server-prompt":
			return {
				title: `Prompt from ${visible(asked.server)}`,
				rows: asked.url === undefined ? [] : [{ key: "Link", value: visiblePath(asked.url) }],
				changes: [],
				text: visible(asked.message),
			};
		case "unrecognised":
			return { title: toolName === undefined ? "Request" : visible(toolName), rows: [], changes: [] };
	}
}

export const HIDDEN_NOTE = "This request holds hidden characters, shown here as \\u{…}.";

/** The paths a request names, which show on one line each. */
function paths(asked: ApprovalAsked): string[] {
	switch (asked.kind) {
		case "command":
			return [asked.folder];
		case "file-change":
			return (asked.changes ?? []).flatMap((change) => [change.path, ...(change.kind === "update" && change.newPath !== undefined ? [change.newPath] : [])]);
		case "wider-access":
			return [
				...asked.paths.flatMap(({ target }) =>
					target.kind === "path" ? [target.path] : target.kind === "glob" ? [target.pattern] : target.kind === "project-roots" && target.subpath !== undefined ? [target.subpath] : []
				),
				...(asked.folder === undefined ? [] : [asked.folder]),
			];
		case "server-prompt":
			return asked.url === undefined ? [] : [asked.url];
		case "unrecognised":
			return [];
	}
}

export function approvalView(request: ApprovalRequest, name: (author: string) => string): ApprovalCardView {
	const [state, meta] = status(request, name);
	const { notes = [], ...shown } = parts(request.asked, request.toolName);
	const hidden = holdsHidden(request.asked) || holdsHidden(request.input)
		|| paths(request.asked).some((path) => visiblePath(path) !== path);
	return {
		request: request.requestId,
		state,
		meta,
		...shown,
		...(request.asked.reason === undefined ? {} : { reason: visible(request.asked.reason) }),
		notes: [...(hidden ? [HIDDEN_NOTE] : []), ...notes],
		details: visible(JSON.stringify(request.input, null, 2)),
		partial: request.asked.kind === "unrecognised",
	};
}

/**
 * The requests shown above the composer: every open one, and the settled ones of the latest turn.
 * A settled request goes once a later message starts a new turn; a request closed by a message
 * stays through the turn that message started, so the card still says who sent it. When `older`
 * turns were left out of `items`, a settled request opened before them belongs to an earlier turn.
 */
export function shownApprovals(requests: ApprovalRequest[], items: Item[], older = false): ApprovalRequest[] {
	const asks = items.flatMap((item) => item.kind === "message" && item.invoked ? [item.at] : []);
	return requests.filter((request) => {
		if (request.state.kind === "open") return true;
		if (older && request.openedAt < (items[0]?.at ?? Infinity)) return false;
		const later = asks.filter((at) => at > request.openedAt).length;
		return later === 0 || (request.state.kind === "closed" && request.state.reason === "message" && later === 1);
	});
}
