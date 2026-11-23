import type { ApprovalRequest } from "@ace/channel/protocol";

import type { Item } from "./transcript";

const TIME = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

export type ApprovalState = "open" | "allowed" | "denied" | "closed";

/** What one request's card shows, read from the input the runtime sent and nothing else. */
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
	/** Each file a file change names, with its diff when the runtime sent one. */
	changes: { path: string; kind: string; diff: string }[];
	/** The runtime's reason, or a server's message, verbatim. */
	text?: string;
	/** Shown under the input while the request is open. */
	note?: string;
	/** The whole input as JSON, so nothing the card does not recognise is hidden. */
	details?: string;
};

type Json = Record<string, unknown>;
const record = (value: unknown): value is Json =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const string = (value: unknown) => typeof value === "string" && value ? value : undefined;
const strings = (value: unknown) =>
	Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const CLOSED: Record<Exclude<Extract<ApprovalRequest["state"], { kind: "closed" }>["reason"], "message">, string> = {
	"turn-ended": "Closed when the turn ended",
	"runtime-resolved": "Closed by the agent",
	stopped: "Closed when the chat was stopped",
	restarted: "Closed when Neuve restarted",
};

function status(request: ApprovalRequest, name: (author: string) => string): [ApprovalState, string] {
	const { state } = request;
	if (state.kind === "open") return ["open", `Asked at ${TIME.format(request.openedAt)}`];
	if (state.kind === "answered") {
		return [state.decision === "allow" ? "allowed" : "denied", `${name(state.by)} · ${TIME.format(state.at)}`];
	}
	if (state.reason === "message") return ["closed", `${capital(name(state.by))} sent a message instead`];
	return ["closed", CLOSED[state.reason]];
}

const capital = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

function changes(value: unknown): ApprovalCardView["changes"] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((change) => {
		if (!record(change) || !string(change.path)) return [];
		const kind = record(change.kind) ? string(change.kind.type) : undefined;
		const moved = record(change.kind) ? string(change.kind.move_path) : undefined;
		return [{
			path: moved ? `${change.path} → ${moved}` : change.path as string,
			kind: kind === "add" ? "Added" : kind === "delete" ? "Deleted" : moved ? "Moved" : "Changed",
			diff: typeof change.diff === "string" ? change.diff : "",
		}];
	});
}

/** Network and folders a request for wider permissions names. */
function permissions(value: Json): ApprovalCardView["rows"] {
	const rows: ApprovalCardView["rows"] = [];
	if (record(value.network) && value.network.enabled === true) rows.push({ key: "Network", value: "On" });
	if (record(value.fileSystem)) {
		const read = strings(value.fileSystem.read);
		const write = strings(value.fileSystem.write);
		if (read.length) rows.push({ key: "Read", value: read.join("\n") });
		if (write.length) rows.push({ key: "Write", value: write.join("\n") });
	}
	return rows;
}

export function approvalView(request: ApprovalRequest, name: (author: string) => string): ApprovalCardView {
	const [state, meta] = status(request, name);
	const input = record(request.input) ? request.input : {};
	const details = JSON.stringify(request.input, null, 2);
	const view: ApprovalCardView = { request: request.requestId, title: "", state, meta, rows: [], changes: [] };
	const folder = string(input.cwd);
	const reason = string(input.reason);
	if (request.toolName !== undefined) {
		return { ...view, title: request.toolName, code: { text: details, language: "json" } };
	}
	switch (request.work) {
		case "command": {
			if (record(input.permissions)) {
				return {
					...view,
					title: "More access",
					rows: permissions(input.permissions),
					text: reason,
					note: "Allow grants it for this turn only.",
					details,
				};
			}
			const command = string(input.command);
			return {
				...view,
				title: "Command",
				...(command ? { code: { text: command, language: "bash" } } : {}),
				rows: folder ? [{ key: "Folder", value: folder }] : [],
				text: reason,
				details,
			};
		}
		case "file-change":
			return {
				...view,
				title: "File change",
				rows: folder ? [{ key: "Folder", value: folder }] : [],
				changes: changes(input.changes),
				text: reason,
				details,
			};
		case "tool": {
			const server = string(input.server);
			return { ...view, title: server ? `Prompt from ${server}` : "Prompt", text: string(input.message), details };
		}
		case "web-search": {
			const query = string(input.query);
			return { ...view, title: "Web search", ...(query ? { code: { text: query } } : {}), details };
		}
	}
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
