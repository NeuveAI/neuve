import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import type {
	ApprovalRequest,
	Build,
	BuildNotice,
	ChatId,
	ChatMode,
	Image,
	Plan,
	PlanComment,
	ReviewNotice,
	QueuedMessage,
	Reactions,
	TextFile,
	WorkMessage,
} from "@ace/channel/protocol";
import type { ReviewCard } from "@ace/channel/review-cards";
import { DISCONNECTED } from "@ace/host/gateway-client";
import { CHANNEL_CLOSED, type ChannelInfo, type Event } from "@ace/host/protocol";

export type TurnRetry = NonNullable<Extract<Event, { kind: "turn-retry-status" }>["status"]>;

import { host, onOpen } from "./host";
import { reviewCommits } from "./review-card";

export type Tool = {
	call: string;
	name: string;
	args: unknown;
	result?: {
		error: boolean;
		text: string;
		/** Each image's bytes stay on the host, read from its route by the chat that stored them. */
		images?: (Pick<Image, "mimeType"> & { chat: ChatId })[];
		interrupted?: boolean;
		handoff?: boolean;
	};
	/** The running call's live output tail, until its result replaces it. */
	progress?: { text: string; truncated?: boolean };
	/** The reply ended while the agent was still writing this call, so it never ran. */
	unrun?: boolean;
};

export type Item =
	| {
		kind: "message";
		key: string;
		entry: number;
		at: number;
		author: string;
		text: string;
		images?: Image[];
		files?: TextFile[];
		invoked: boolean;
		/** The agents the channel delivered it to, by chat. */
		agents?: ChatId[];
		/** The host's mark on its review wake or on its brief to a build's agent; such a message is no person's. */
		system?: ReviewNotice | BuildNotice;
		deleted?: boolean;
		/** When its author last edited it, in ms. */
		edited?: number;
	}
	| {
		kind: "reply";
		key: string;
		/** Absent for a reply that only called tools, which takes no reactions. */
		entry?: number;
		at: number;
		model: string;
		text: string;
		tools: Tool[];
		error?: string;
		stopped?: boolean;
		/** The mode the run that wrote it ran in. */
		mode?: ChatMode;
		/** Who stopped the run, once the channel records it. */
		stopper?: string;
		/** Queued messages withdrawn when the run was stopped. */
		withdrawn?: QueuedMessage[];
	}
	| {
		/** The reviewed branch got a commit after a Neuve review was admitted. */
		kind: "review-commits";
		key: string;
		at: number;
		/** Rows carry no text and no entry: nothing to copy, react to or delete. */
		text: "";
		entry?: never;
		review: string;
		branch: string;
		reviewedHead: string;
		head: string;
		label: string;
	}
	| {
		/** A review this chat requested from the command line. */
		kind: "review-requested";
		key: string;
		at: number;
		text: "";
		entry?: never;
		review: string;
	};


export type Transcript = {
	items: Item[];
	queue: QueuedMessage[];
	/** Every message withdrawn from the queue while watched, for its author's composer. */
	returned: QueuedMessage[];
	/** Withdrawn messages waiting for their run's end, so the notice follows its "Stopped." */
	withdrawn: QueuedMessage[];
	/** Each tool call's group caption, by call ID. */
	captions: Record<string, string>;
	/** Each tool call's recap of the work it was part of, by call ID. */
	recaps: Record<string, string>;
	reactions: Reactions;
	/** The chat's Neuve review cards, keyed by the start call that made each, as the host last sent. */
	reviews: Record<string, ReviewCard>;
	/** The chat's plans, oldest first, as the host last sent them. */
	plans: Plan[];
	/** The chat's approval requests, open, answered and closed, oldest first, as the host last sent them. */
	approvals: ApprovalRequest[];
	/** The comments on the chat's plans, oldest first, as the host last sent them. */
	planComments: PlanComment[];
	/** The channel's builds, oldest approval first, as the host last sent them. */
	builds: Build[];
	/** What the builds' agents said to each other, in the order said. */
	messages: WorkMessage[];
	/** Every submission that sent plan comments, seen while watched. */
	commentSends: number[];
	/** When each person last said they were typing, in ms; their message ends it. */
	typing: Record<string, number>;
	/** The chat's turn retry, as the host last sent it. */
	turnRetry?: TurnRetry;
	/** Text streamed for the reply being generated. */
	draft: string;
	busy: boolean;
	live: boolean;
	/** The replay left out the chat's older entries. */
	older: boolean;
	/** Whether teammates may invoke agents, from the newest metadata event that reported it. */
	shared?: boolean;
	desktop?: boolean;
};

const EMPTY: Transcript = {
	items: [],
	queue: [],
	returned: [],
	withdrawn: [],
	captions: {},
	recaps: {},
	reactions: {},
	reviews: {},
	plans: [],
	approvals: [],
	planComments: [],
	builds: [],
	messages: [],
	commentSends: [],
	typing: {},
	draft: "",
	busy: false,
	live: false,
	older: false,
};

/** Folds channel events into timeline items: tool calls attach to the reply that made them. */
export function apply(state: Transcript, event: Event): Transcript {
	switch (event.kind) {
		case "review-cards":
			return { ...state, reviews: event.cards };
		case "plans":
			return { ...state, plans: event.plans };
		case "approval-requests":
			return { ...state, approvals: event.requests };
		case "plan-comments": {
			const sends = new Set(state.commentSends);
			for (const comment of event.comments) {
				for (const { sent } of [comment, ...comment.replies.filter((reply) => reply.kind === "person")]) {
					if (sent) sends.add(sent.submission);
				}
			}
			return { ...state, planComments: event.comments, commentSends: [...sends] };
		}
		case "builds":
			return { ...state, builds: event.builds, messages: event.messages };
		case "neuve:review:new-commits":
			return { ...state, items: [...state.items, reviewCommits(event)] };
		case "neuve:review:requested":
			return {
				...state,
				items: [...state.items, { kind: "review-requested", key: `e${event.entry}`, at: event.at, text: "", review: event.review }],
			};
		case "queue": {
			// A withdrawn send of plan comments leaves its words kept in the Plan tab, not in the composer.
			const taken = event.withdrawn?.filter((message) => !state.commentSends.includes(message.submission));
			if (!taken?.length) return { ...state, queue: event.messages };
			const returned = [...state.returned, ...taken];
			if (state.busy) {
				const withdrawn = [...state.withdrawn, ...taken];
				return { ...state, queue: event.messages, returned, withdrawn };
			}
			const items = withdraw(state.items, taken);
			return { ...state, queue: event.messages, returned, items };
		}
		case "message": {
			const { [event.author]: _, ...typing } = state.typing;
			return {
				...state,
				typing,
				items: [...state.items, { kind: "message", key: `e${event.entry}`, ...pick(event) }],
			};
		}
		case "turn-retry-status":
			return { ...state, turnRetry: event.status };
		case "typing":
			return { ...state, typing: { ...state.typing, [event.author]: Date.now() } };
		case "deleted":
			return {
				...state,
				items: state.items.map((item) =>
					item.kind === "message" && item.entry === event.entry
						? { ...item, text: "", images: undefined, files: undefined, deleted: true }
						: item
				),
			};
		case "edited":
			return {
				...state,
				items: state.items.map((item) =>
					item.kind === "message" && item.entry === event.entry
						? { ...item, text: event.text, edited: event.at }
						: item
				),
			};
		case "reactions":
			return { ...state, reactions: event.reactions };
		case "reply": {
			const item: Item = {
				kind: "reply",
				key: `e${event.entry}`,
				entry: event.entry,
				at: event.at,
				model: event.model,
				text: event.text,
				tools: [],
				...(event.error ? { error: event.error } : {}),
				...(event.stopped ? { stopped: true } : {}),
				...(event.mode ? { mode: event.mode } : {}),
			};
			return { ...state, draft: "", items: [...state.items, item] };
		}
		case "tool": {
			const tool: Tool = {
				call: event.call,
				name: event.name,
				args: event.args,
				...(event.unrun ? { unrun: true } : {}),
			};
			const last = state.items.at(-1);
			if (last?.kind === "reply" && !last.text) {
				return {
					...state,
					items: [...state.items.slice(0, -1), { ...last, tools: [...last.tools, tool] }],
				};
			}
			if (last?.kind === "reply" && last.at === event.at) {
				return {
					...state,
					items: [...state.items.slice(0, -1), { ...last, tools: [...last.tools, tool] }],
				};
			}
			const item: Item = {
				kind: "reply",
				key: `t${event.call}`,
				at: event.at,
				model: event.model,
				text: "",
				tools: [tool],
			};
			return { ...state, draft: "", items: [...state.items, item] };
		}
		case "progress": {
			const progress = { text: event.text, ...(event.truncated ? { truncated: true } : {}) };
			return {
				...state,
				items: state.items.map((item) =>
					item.kind === "reply" && item.tools.some((tool) => tool.call === event.call)
						? {
							...item,
							tools: item.tools.map((tool) =>
								tool.call === event.call && !tool.result ? { ...tool, progress } : tool
							),
						}
						: item
				),
			};
		}
		case "result":
			return {
				...state,
				items: state.items.map((item) =>
					item.kind === "reply" && item.tools.some((tool) => tool.call === event.call)
						? {
							...item,
							...(event.stopped ? { stopped: true } : {}),
							tools: item.tools.map((tool) =>
								tool.call === event.call
									? {
										call: tool.call,
										name: tool.name,
										args: tool.args,
										result: {
											error: event.error,
											text: event.text,
											...(event.images
												? { images: event.images.map((image) => ({ ...image, chat: event.chat })) }
												: {}),
											...(event.interrupted ? { interrupted: true } : {}),
											...(event.handoff ? { handoff: true } : {}),
										},
									}
									: tool
							),
						}
						: item
				),
			};
		case "caption": {
			const captions = { ...state.captions };
			for (const call of event.calls) captions[call] = event.text;
			return { ...state, captions };
		}
		case "recap": {
			const recaps = { ...state.recaps };
			for (const call of event.calls) recaps[call] = event.text;
			return { ...state, recaps };
		}
		case "delta":
			return { ...state, draft: state.draft + event.text };
		case "run": {
			const busy = event.state === "start";
			if (busy || !state.withdrawn.length) return { ...state, busy, draft: "" };
			const items = withdraw(state.items, state.withdrawn);
			return { ...state, busy, draft: "", items, withdrawn: [] };
		}
		case "stopped": {
			const last = state.items.at(-1);
			if (last?.kind === "reply") {
				const item: Item = { ...last, stopped: true, stopper: event.author };
				return { ...state, items: [...state.items.slice(0, -1), item] };
			}
			const item: Item = {
				kind: "reply",
				key: `s${event.at}`,
				at: event.at,
				model: "",
				text: "",
				tools: [],
				stopped: true,
				stopper: event.author,
			};
			return { ...state, items: [...state.items, item] };
		}
		case "live":
			return { ...state, live: true, older: !!event.older };
		case "agent":
			return state;
		case "metadata": {
			const shared = event.shared ?? state.shared;
			const desktop = event.desktop ?? state.desktop;
			return shared === state.shared && desktop === state.desktop
				? state
				: { ...state, shared, desktop };
		}
	}
}

/** The chat's model and effort as an `agent` event reports them; one without `pending` clears it. */
function changed(info: ChannelInfo, event: Extract<Event, { kind: "agent" }>): ChannelInfo {
	const { chat, model, effort, pending } = event;
	return {
		...info,
		chats: info.chats.map(({ pending: _, ...value }, index) =>
			value.id === chat ? { ...value, model, effort, ...(pending ? { pending } : {}) } : info.chats[index]!
		),
	};
}

/** The notice joins the stopped reply; a run stopped before replying gets a reply of its own. */
function withdraw(items: Item[], messages: QueuedMessage[]): Item[] {
	const last = items.at(-1);
	if (last?.kind === "reply") {
		const withdrawn = [...(last.withdrawn || []), ...messages];
		return [...items.slice(0, -1), { ...last, withdrawn }];
	}
	const item: Item = {
		kind: "reply",
		key: `w${messages[0]!.submission}`,
		at: Date.now(),
		model: "",
		text: "",
		tools: [],
		withdrawn: messages,
	};
	return [...items, item];
}

function pick(event: Extract<Event, { kind: "message" }>) {
	const { entry, at, author, text, images, files, invoked, agents, deleted, edited } = event;
	const { system } = event;
	return {
		entry,
		at,
		author,
		text,
		...(images ? { images } : {}),
		...(files ? { files } : {}),
		invoked,
		...(agents ? { agents } : {}),
		...(system ? { system } : {}),
		...(deleted ? { deleted } : {}),
		...(edited ? { edited } : {}),
	};
}

/** Typists send a signal every few seconds while writing; one this old has stopped. */
const TYPING = 5000;

/** Who said they were typing within the last few seconds, read again as each goes stale. */
export function useTyping(typing: Record<string, number>): string[] {
	const [now, setNow] = useState(Date.now);
	const fresh = Object.entries(typing).filter(([, at]) => at > now - TYPING);
	const next = Math.min(...fresh.map(([, at]) => at + TYPING));
	useEffect(() => {
		if (next === Infinity) return;
		const timer = setTimeout(() => setNow(Date.now()), next - Date.now());
		return () => clearTimeout(timer);
	}, [next]);
	return fresh.map(([author]) => author);
}

/** Automatic re-watches allowed before a watch stays open for `STABLE` ms. */
const RECOVERIES = 3;
const STABLE = 60_000;

/** A chat opens with its newest turns and loads older ones a page at a time, as T3 Code pages a thread. */
const TURNS = 10;
const OLDER = 20;
/** How long a left chat stays to be shown at once when it is opened again, as T3 Code keeps a thread. */
const KEPT = 5 * 60_000;

type Kept = { transcript: Transcript; info?: ChannelInfo; turns: number };
const kept = new Map<string, Kept & { at: number }>();

/**
 * Keeps a left chat's complete transcript, without what was streaming, typed or returned to the
 * composer as it was left: the replay brings back what still holds.
 */
export function keep(key: string, value: Kept, now = Date.now()) {
	for (const [other, { at }] of kept) if (now - at > KEPT) kept.delete(other);
	if (!value.transcript.live) return void kept.delete(key);
	const transcript = { ...value.transcript, draft: "", typing: {}, returned: [] };
	kept.set(key, { ...value, transcript, at: now });
}

/** The chat's kept transcript, if it was left within `KEPT` ms. */
export function reopen(key: string, now = Date.now()): Kept | undefined {
	const value = kept.get(key);
	return value && now - value.at <= KEPT ? value : undefined;
}

/**
 * Watches open per channel. `release` drops every watch this client has on a channel, so the work
 * log's watch of an agent's chat releases only when the channel's own chat is not watched too.
 */
const watching = new Map<string, number>();

/**
 * Watches one chat of a channel. Owns the watch: re-watches after the host reconnects, the watch
 * ends, such as when the channel's worker restarts, or a relaying host's connection drops before
 * the watch starts, and releases it on unmount. A failed watch retries once when its channel's
 * host comes back from `offline`.
 */
export function useTranscript(
	channel: string | undefined,
	chat: number | undefined,
	offline: boolean,
	placement: string,
) {
	// A chat left within `KEPT` ms draws its kept transcript at once while the watch catches up.
	const opened = `${channel}/${chat}`;
	const opening = () => reopen(opened) ?? { transcript: EMPTY, info: undefined, turns: TURNS };
	const [state, setState] = useState(() => opening().transcript);
	const [info, setInfo] = useState(() => opening().info);
	const [turns, setTurns] = useState(() => opening().turns);
	const [shown, setShown] = useState(opened);
	if (channel && opened !== shown) {
		const next = opening();
		setShown(opened);
		setState(next.transcript);
		setInfo(next.info);
		setTurns(next.turns);
	}
	// What is shown as of the last commit, for the watch's cleanup to keep.
	const latest = useRef<Kept>(undefined);
	useEffect(() => {
		latest.current = { transcript: state, info, turns };
	});
	/** Older turns were asked for and the larger replay is not complete yet. */
	const loading = useRef(false);
	const [error, setError] = useState<string>();
	/** The channel's worker ended the watch and a re-watch is waiting for it to come back. */
	const [restarting, setRestarting] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const refresh = useRef<() => void>(undefined);
	// A default model change moves what Automatic picks, which info names.
	const settingsVersion = useSyncExternalStore(host.subscribe, () => host.settingsVersion);
	const settingsSeen = useRef(settingsVersion);
	useEffect(() => {
		if (settingsVersion === settingsSeen.current) return;
		settingsSeen.current = settingsVersion;
		refresh.current?.();
	}, [settingsVersion]);
	const [wasOffline, setWasOffline] = useState(offline);
	if (offline !== wasOffline) {
		setWasOffline(offline);
		if (!offline && error) setAttempt((value) => value + 1);
	}
	// A move ends watches at the old placement, and rewatching fails until it finishes; the
	// listing's placement, which names a move under way, changing when the move ends is the signal
	// to watch again, for every client, even when a failed move leaves the channel where it was.
	const [placed, setPlaced] = useState(placement);
	if (placement !== placed) {
		setPlaced(placement);
		setAttempt((value) => value + 1);
		setState(EMPTY);
		setInfo(undefined);
	}
	useEffect(() => {
		if (!channel) return;
		watching.set(channel, (watching.get(channel) ?? 0) + 1);
		let active = true;
		let generation = 0;
		let recoveries = 0;
		let started = 0;
		const start = (restart = false) => {
			const version = ++generation;
			started = Date.now();
			setError(undefined);
			setRestarting(restart);
			const current = () => active && version === generation;
			const recover = (reason: string) => {
				if (Date.now() - started > STABLE) recoveries = 0;
				if (recoveries++ >= RECOVERIES) return false;
				start(reason === CHANNEL_CLOSED);
				return true;
			};
			// A re-watch replays the chat; the shown transcript stays until the replay is complete so
			// the timeline, and what is expanded in it, stays mounted.
			let replay: Transcript | undefined = EMPTY;
			// The chats info names, and those a read already under way is for.
			const known = new Set<number>();
			// Each chat's latest `agent` event, numbered, so a read sent before it can't undo it.
			let heard = 0;
			const agents = new Map<number, { at: number; event: Extract<Event, { kind: "agent" }> }>();
			// Reads are numbered too, so one answering after a later read has landed is dropped.
			let reads = 0;
			let landed = 0;
			const read = () => {
				const sent = heard;
				const number = ++reads;
				return host.channel<ChannelInfo>(channel, { op: "info" }).then((value) => {
					if (number < landed) return;
					landed = number;
					for (const { id } of value.chats) known.add(id);
					for (const { at, event } of agents.values()) if (at > sent) value = changed(value, event);
					if (current()) setInfo(value);
				}, () => {});
			};
			refresh.current = () => void read();
			void read();
			host.channel(channel, {
				op: "watch",
				queue: true,
				captions: true,
				progress: true,
				actions: true,
				typing: true,
				agent: true,
				stops: true,
				plans: true,
				approvals: true,
				planComments: true,
				builds: true,
				turns,
				...(chat === undefined ? {} : { chat }),
			}, {
				event(event) {
					if (!current()) return;
					if (!replay) setState((state) => apply(state, event));
					else if (event.kind !== "live") replay = apply(replay, event);
					else {
						setState(apply(replay, event));
						setRestarting(false);
						loading.current = false;
						replay = undefined;
					}
					// Any chat's model change comes as its `agent` event; a mode change only info holds.
					if (event.kind === "agent") {
						agents.set(event.chat, { at: ++heard, event });
						setInfo((info) => info && changed(info, event));
					}
					// A build's new agent is announced only by its builds, so its chat is read from info then.
					const fresh = event.kind === "builds"
						? event.builds.flatMap((build) => build.agents).filter((agent) => !known.has(agent.chat))
						: [];
					for (const { chat } of fresh) known.add(chat);
					if (event.kind === "run" || (event.kind === "agent" && event.mode !== undefined) || fresh.length) {
						void read();
					}
				},
				// A released watch belongs to an old generation; a reconnecting host restarts every watch.
				closed(reason) {
					if (!current() || host.status !== "open" || recover(reason)) return;
					generation++;
					setState(EMPTY);
					setInfo(undefined);
					setRestarting(false);
					setError(reason);
				},
			}).catch((error: Error) => {
				if (!current()) return;
				// Only this app's own socket closing is handled by `onOpen`; a relay's drop leaves it open.
				if (host.status === "open" && error.message === DISCONNECTED && recover(error.message)) {
					return;
				}
				setState(EMPTY);
				setInfo(undefined);
				setRestarting(false);
				setError(error.message);
			});
		};
		start();
		const off = onOpen(() => {
			recoveries = 0;
			start();
		});
		return () => {
			active = false;
			off();
			if (latest.current) keep(`${channel}/${chat}`, latest.current);
			const left = watching.get(channel)! - 1;
			if (left) return void watching.set(channel, left);
			watching.delete(channel);
			host.request({ op: "release", channel }).catch(() => {});
		};
	}, [channel, chat, attempt, turns]);
	// Hosts that predate sharing in metadata events report it only through `info`, which is not
	// read again after a share; `sharedLive` says whether changes will arrive.
	const shared = state.shared ?? info?.shared;
	const sharedLive = state.shared !== undefined;
	return {
		...state,
		shared,
		sharedLive,
		desktop: state.desktop ?? info?.desktop,
		desktopLive: state.desktop !== undefined,
		info,
		error,
		restarting,
		retry: () => setAttempt((value) => value + 1),
		/** Watches again with older turns, one load at a time, while the replay left some out. */
		more: () => {
			if (!state.older || loading.current) return;
			loading.current = true;
			setTurns((value) => value + OLDER);
		},
	};
}
