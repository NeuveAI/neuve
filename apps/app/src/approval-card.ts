import type { ApprovalRequest } from "@ace/channel/protocol";

import type { Item } from "./transcript";

const TIME = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

export type ApprovalState = "open" | "allowed" | "denied" | "closed";

/**
 * What one request's card shows, read from the input the runtime sent and nothing else. Every
 * string in it has its hidden characters made visible.
 */
export type ApprovalCardView = {
	request: string;
	title: string;
	state: ApprovalState;
	/** Who answered and when, or why it closed, or when it was asked. */
	meta: string;
	/** The command, query or tool input, exactly as sent. */
	code?: { text: string; language?: string };
	/** Labelled values such as the folder or the server. */
	rows: { key: string; value: string }[];
	/** Each file a file change names; `patch` is a unified diff with file headers, or empty. */
	changes: { path: string; kind: string; patch: string }[];
	/** The runtime's reason, or a server's message, verbatim. */
	text?: string;
	/** Plain statements about the request, shown whatever its state. */
	notes: string[];
	/** Shown under the input while the request is open. */
	note?: string;
	/** The whole input as JSON. */
	details: string;
	/** The card's own parts do not show all of the input, so the whole input is shown open. */
	partial: boolean;
};

/**
 * Control, format and line-separator characters other than newline and tab: escapes, backspace,
 * bidirectional overrides and isolates, zero-width characters. Each could make the text a person
 * reads differ from the text that runs.
 */
const HIDDEN = /(?![\n\t])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** The text with each hidden character written as `\u{XXXX}`, so a person sees it. */
export function visible(text: string) {
	return text.replace(HIDDEN, (char) => `\\u{${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}}`);
}

/** Whether any string or key in a JSON value holds a hidden character. */
function holdsHidden(value: unknown): boolean {
	if (typeof value === "string") return visible(value) !== value;
	if (Array.isArray(value)) return value.some(holdsHidden);
	if (record(value)) return Object.entries(value).some(([key, item]) => holdsHidden(key) || holdsHidden(item));
	return false;
}

type Json = Record<string, unknown>;
const record = (value: unknown): value is Json =>
	typeof value === "object" && value !== null && !Array.isArray(value);
/** Whether `value` is an object whose every key is one of `keys`. */
const only = (value: unknown, keys: string[]): value is Json =>
	record(value) && Object.keys(value).every((key) => keys.includes(key));
const text = (value: unknown) => typeof value === "string" ? value : undefined;
const optional = (value: unknown) => value === undefined || value === null || typeof value === "string";
const paths = (value: unknown) =>
	value === null || value === undefined
		|| Array.isArray(value) && value.every((item) => typeof item === "string");
const empty = (value: unknown) => value === undefined || value === null || Array.isArray(value) && !value.length;

const CLOSED: Record<Exclude<Extract<ApprovalRequest["state"], { kind: "closed" }>["reason"], "message">, string> = {
	"turn-ended": "Closed when the turn ended",
	"runtime-resolved": "Withdrawn before an answer",
	stopped: "Closed when the chat was stopped",
	restarted: "Closed when Neuve restarted",
};

const capital = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

function status(request: ApprovalRequest, name: (author: string) => string): [ApprovalState, string] {
	const { state } = request;
	if (state.kind === "open") return ["open", `Asked at ${TIME.format(request.openedAt)}`];
	if (state.kind === "answered") {
		return [state.decision === "allow" ? "allowed" : "denied", `${name(state.by)} · ${TIME.format(state.at)}`];
	}
	if (state.reason === "message") return ["closed", `${capital(name(state.by))} sent a message instead`];
	return ["closed", CLOSED[state.reason]];
}

/** A file's diff with file headers, which the diff view needs, added when it has none. */
function patch(path: string, kind: string | undefined, diff: string) {
	if (!diff || /^(?:diff --git |--- )/.test(diff)) return diff;
	const before = kind === "add" ? "/dev/null" : `a/${path}`;
	const after = kind === "delete" ? "/dev/null" : `b/${path}`;
	return `--- ${before}\n+++ ${after}\n${diff}`;
}

type Parts = Omit<ApprovalCardView, "request" | "state" | "meta" | "details" | "partial" | "notes"> & {
	notes?: string[];
	/** Whether the parts above show every field of the input. */
	whole: boolean;
};

function command(input: unknown): Parts {
	const whole = only(input, ["command", "cwd", "reason"]) && typeof input.command === "string"
		&& optional(input.cwd) && optional(input.reason);
	const value = record(input) ? input : {};
	const line = text(value.command);
	const folder = text(value.cwd);
	return {
		title: "Command",
		...(line ? { code: { text: line, language: "bash" } } : {}),
		rows: folder ? [{ key: "Folder", value: folder }] : [],
		changes: [],
		text: text(value.reason),
		whole,
	};
}

function access(input: Json): Parts {
	const { permissions } = input;
	const network = record(permissions) ? permissions.network : undefined;
	const files = record(permissions) ? permissions.fileSystem : undefined;
	const whole = only(input, ["permissions", "reason"]) && optional(input.reason)
		&& only(permissions, ["network", "fileSystem"])
		&& (network === null || network === undefined || only(network, ["enabled"]))
		&& (files === null || files === undefined
			|| only(files, ["read", "write", "entries"]) && paths(files.read) && paths(files.write) && empty(files.entries));
	const rows: Parts["rows"] = [];
	if (record(network) && network.enabled === true) rows.push({ key: "Network", value: "On" });
	if (record(files)) {
		for (const [key, label] of [["read", "Read"], ["write", "Write"]] as const) {
			const list = Array.isArray(files[key]) ? (files[key] as unknown[]).filter((item) => typeof item === "string") : [];
			if (list.length) rows.push({ key: label, value: list.join("\n") });
		}
	}
	return {
		title: "More access",
		rows,
		changes: [],
		text: text(input.reason),
		note: "Neuve asks for this access for this turn only.",
		whole,
	};
}

function fileChange(input: unknown): Parts {
	const value = record(input) ? input : {};
	const list = Array.isArray(value.changes) ? value.changes : [];
	const known = list.every((change) =>
		only(change, ["path", "kind", "diff"]) && typeof change.path === "string" && typeof change.diff === "string"
		&& only(change.kind, ["type", "move_path"]) && ["add", "delete", "update"].includes(change.kind.type as string)
		&& optional(change.kind.move_path)
	);
	const whole = only(input, ["command", "cwd", "reason", "changes"]) && value.command == null
		&& optional(value.cwd) && optional(value.reason)
		&& (value.changes === undefined || Array.isArray(value.changes)) && known;
	const changes = known
		? list.map((change) => {
			const { path, kind, diff } = change as { path: string; kind: Json; diff: string };
			const moved = text(kind.move_path);
			const type = text(kind.type);
			return {
				path: moved ? `${path} → ${moved}` : path,
				kind: type === "add" ? "Added" : type === "delete" ? "Deleted" : moved ? "Moved" : "Changed",
				patch: patch(path, type, diff),
			};
		})
		: [];
	const folder = text(value.cwd);
	return {
		title: "File change",
		rows: folder ? [{ key: "Folder", value: folder }] : [],
		changes,
		text: text(value.reason),
		notes: changes.length ? [] : ["The change itself was not sent with this request."],
		whole,
	};
}

function parts(request: ApprovalRequest): Parts {
	const { input } = request;
	if (request.toolName !== undefined) {
		return { title: request.toolName, code: { text: JSON.stringify(input, null, 2), language: "json" }, rows: [], changes: [], whole: true };
	}
	switch (request.work) {
		case "command":
			return record(input) && "permissions" in input ? access(input) : command(input);
		case "file-change":
			return fileChange(input);
		case "tool": {
			const value = record(input) ? input : {};
			const server = text(value.server);
			return {
				title: server ? `Prompt from ${server}` : "Prompt",
				rows: [],
				changes: [],
				text: text(value.message),
				whole: only(input, ["server", "message"]) && !!server && typeof input.message === "string",
			};
		}
		case "web-search": {
			const query = record(input) ? text(input.query) : undefined;
			return {
				title: "Web search",
				...(query ? { code: { text: query } } : {}),
				rows: [],
				changes: [],
				whole: only(input, ["query"]) && !!query,
			};
		}
	}
}

export const PARTIAL = "This card cannot show all of this request. The whole request is below.";
export const HIDDEN_NOTE = "This request holds hidden characters, shown here as \\u{…}.";

export function approvalView(request: ApprovalRequest, name: (author: string) => string): ApprovalCardView {
	const [state, meta] = status(request, name);
	const { whole, notes = [], ...shown } = parts(request);
	const raw = JSON.stringify(request.input, null, 2);
	const hidden = holdsHidden(request.input);
	return {
		request: request.requestId,
		state,
		meta,
		title: visible(shown.title),
		...(shown.code ? { code: { ...shown.code, text: visible(shown.code.text) } } : {}),
		rows: shown.rows.map((row) => ({ key: row.key, value: visible(row.value) })),
		changes: shown.changes.map((change) => ({ ...change, path: visible(change.path), patch: visible(change.patch) })),
		...(shown.text === undefined ? {} : { text: visible(shown.text) }),
		...(shown.note ? { note: shown.note } : {}),
		notes: [...(whole ? [] : [PARTIAL]), ...(hidden ? [HIDDEN_NOTE] : []), ...notes],
		details: visible(raw),
		partial: !whole,
	};
}

/**
 * The requests shown above the composer: every open one, and the settled ones of the latest turn.
 * A settled request goes once a later message starts a new turn; a request closed by a message
 * stays through the turn that message started, so the card still says who sent it.
 */
export function shownApprovals(requests: ApprovalRequest[], items: Item[]): ApprovalRequest[] {
	const asks = items.flatMap((item) => item.kind === "message" && item.invoked ? [item.at] : []);
	return requests.filter((request) => {
		if (request.state.kind === "open") return true;
		const later = asks.filter((at) => at > request.openedAt).length;
		return later === 0 || (request.state.kind === "closed" && request.state.reason === "message" && later === 1);
	});
}
