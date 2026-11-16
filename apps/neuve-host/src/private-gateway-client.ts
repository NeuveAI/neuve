import { createRequire } from "node:module";

import type WebSocket from "ws";

import { parseHostFrame } from "./parse";
/**
 * A client of a host gateway, for the BFF's server. It holds the owner's token, so it must never
 * be bundled into browser code; browsers reach the host only through the BFF's own routes.
 */
import type { Metadata } from "@ace/channel/protocol";

import type {
	Event,
	HostFrame,
	HostRequest,
	Listing,
	Hello,
	People,
	Presence,
	TeamAsk,
	Project,
	Request,
	TerminalFrame,
} from "./extension-protocol";

// Bun's bare "ws" import uses its native decoder.
// This explicit package entry also bundles in a compiled CLI.
const ClientWebSocket: typeof WebSocket = typeof require === "function"
	? require("../node_modules/ws/index.js")
	: createRequire(import.meta.url)("../node_modules/ws/index.js");

/**
 * A watch's events, then `closed` once an accepted watch ends: released, or its channel's worker
 * closed. The owner decides whether to watch again.
 */
export type Watch = { event(event: Event): void; closed?(error: string): void };

type Pending = {
	resolve(value: unknown): void;
	reject(error: Error): void;
	watch?: Watch;
	/** The watch was accepted, so a later failure ends it instead of rejecting the request. */
	accepted?: boolean;
};
export type Status = "connecting" | "open" | "closed";

/** A request's failure when the socket it was sent on closed. */
export const DISCONNECTED = "Disconnected from the host";

/** Silence while a request or watch waits before asking the host for any answer, then before calling it stalled. */
const QUIET = 5000;

/** One WebSocket to a host gateway, reconnecting with backoff until closed. */
export class GatewayClient {
	#socket?: WebSocket;
	#next = 1;
	#pending = new Map<number, Pending>();
	#listeners = new Set<() => void>();
	#terminals = new Map<string, (frame: TerminalFrame) => void>();
	#retry = 250;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#closed = false;
	#metadata = new Map<string, Metadata>();
	#heard = 0;
	#asked: number | undefined;
	#watchdog?: ReturnType<typeof setInterval>;
	status: Status = "connecting";
	/**
	 * The socket is open but the host stopped answering, as while its process is suspended: TCP
	 * keeps the connection, so only silence while a request or watch waits reveals it. Any frame
	 * ends it.
	 */
	stalled = false;
	channels: Listing[] = [];
	/** Undefined until the host first sends them, so a client can tell loading from having none. */
	projects?: Project[];
	/** Called after every connect so watches can be re-established. */
	onOpen?: () => void;

	constructor(readonly url: string, private readonly token: string) {
		this.#connect();
	}

	#connect() {
		if (this.#closed) return;
		this.#timer = undefined;
		const socket = new ClientWebSocket(this.url, ["ace", `ace-token.${this.token}`], {
			maxPayload: 128 * 1024 * 1024,
		});
		// The close handler settles pending work after handshake and transport errors.
		socket.addEventListener("error", () => {});
		let closedReason = DISCONNECTED;
		this.#socket = socket;
		socket.addEventListener("open", () => {
			this.#retry = 250;
			this.#heard = Date.now();
			this.#watchdog = setInterval(() => this.#check(), 1000);
			this.#set("open");
			this.request<Listing[]>({ op: "channels" }).then((channels) => {
				this.channels = this.#listings(channels);
				this.#emit();
			}, () => {});
			this.onOpen?.();
		});
		socket.addEventListener(
			"message",
			(message) => {
				// An empty text frame has no protocol id and must not consume an outstanding reply.
				if (message.data === "") return;
				let frame: HostFrame;
				try {
					frame = parseHostFrame(String(message.data));
				} catch {
					// A lost reply leaves command outcome unknown. Refuse pending work and reconnect,
					// without replaying any command sent on this connection.
					closedReason = `Malformed frame from the host (${new TextEncoder().encode(String(message.data)).byteLength} bytes)`;
					socket.close(1007, "Malformed frame from the host");
					return;
				}
				this.#receive(frame);
			},
		);
		socket.addEventListener("close", () => {
			const ended = [...this.#pending.values()];
			this.#pending.clear();
			this.#metadata.clear();
			clearInterval(this.#watchdog);
			this.#asked = undefined;
			this.stalled = false;
			// Listings outlive the socket so open channels stay mounted until the next connect replaces them.
			this.#set("closed");
			for (const pending of ended) {
				if (pending.accepted) pending.watch?.closed?.(closedReason);
				else pending.reject(new Error(closedReason));
			}
			if (this.#closed) return;
			this.#timer = setTimeout(() => this.#connect(), this.#retry);
			this.#retry = Math.min(this.#retry * 2, 5000);
		});
	}

	hello?: Hello;
	people: People = {};
	presence: Record<string, Presence[]> = {};
	asks: TeamAsk[] = [];
	settingsVersion = 0;

	#receive(frame: HostFrame) {
		this.#heard = Date.now();
		this.#asked = undefined;
		if (this.stalled) {
			this.stalled = false;
			this.#emit();
		}
		if ("hello" in frame) { this.hello = frame.hello; return this.#emit(); }
		if ("people" in frame) { this.people = frame.people; return this.#emit(); }
		if ("presence" in frame) { this.presence = frame.presence; return this.#emit(); }
		if ("asks" in frame) { this.asks = frame.asks; return this.#emit(); }
		if ("settings" in frame) { this.settingsVersion++; return this.#emit(); }
		if ("rename" in frame) return;
		if ("waiting" in frame) return;
		if ("projects" in frame) {
			this.projects = frame.projects;
			return this.#emit();
		}
		if ("channels" in frame) {
			this.channels = this.#listings(frame.channels);
			return this.#emit();
		}
		if ("terminal" in frame) return this.#terminals.get(frame.terminal)?.(frame);
		const pending = this.#pending.get(frame.id);
		if (!pending) return;
		if ("event" in frame) return pending.watch?.event(frame.event);
		// A watch keeps its entry so later events still reach it, until a failure ends it.
		if (pending.watch && frame.ok) {
			pending.accepted = true;
			return pending.resolve(frame.value);
		}
		this.#pending.delete(frame.id);
		if (frame.ok) return pending.resolve(frame.value);
		if (pending.accepted) return pending.watch?.closed?.(frame.error);
		pending.reject(new Error(frame.error));
	}

	#check() {
		if (this.status !== "open" || this.stalled) return;
		const now = Date.now();
		if (now - this.#heard < QUIET) return;
		if (this.#asked === undefined) {
			// An idle socket is quiet by design; an open watch counts as waiting.
			if (!this.#pending.size) return;
			this.#asked = now;
			this.request({ op: "hello" }).catch(() => {});
		} else if (now - this.#asked >= QUIET) {
			this.stalled = true;
			this.#emit();
		}
	}

	/** A watch's metadata can be newer than the catalog's listing it projects into. */
	#listings(channels: Listing[]): Listing[] {
		return channels.map((channel) => {
			const metadata = this.#metadata.get(channel.id);
			if (!metadata) return channel;
			if ((channel.revision || 0) >= metadata.revision) {
				this.#metadata.delete(channel.id);
				return channel;
			}
			return { ...channel, ...metadata };
		});
	}

	#update(channel: string, metadata: Metadata) {
		const previous = this.#metadata.get(channel);
		if (previous && previous.revision >= metadata.revision) return;
		this.#metadata.set(channel, metadata);
		this.channels = this.channels.map((listing) =>
			listing.id === channel && (listing.revision || 0) < metadata.revision
				? { ...listing, ...metadata }
				: listing
		);
		this.#emit();
	}

	#set(status: Status) {
		this.status = status;
		this.#emit();
	}

	#emit() {
		for (const listener of this.#listeners) listener();
	}

	subscribe = (listener: () => void) => {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	};

	request<T = unknown>(request: HostRequest, watch?: Watch, trace?: string): Promise<T> {
		if (this.status !== "open") return Promise.reject(new Error("Not connected to the host"));
		const id = this.#next++;
		const promise = new Promise<T>((resolve, reject) =>
			this.#pending.set(id, {
				resolve: resolve as (value: unknown) => void,
				reject,
				...(watch ? { watch } : {}),
			})
		);
		try {
			this.#socket?.send(JSON.stringify({ id, ...(trace ? { trace } : {}), ...request }));
		} catch (error) {
			this.#pending.get(id)?.reject(error instanceof Error ? error : new Error(String(error)));
			this.#pending.delete(id);
		}
		return promise;
	}

	channel<T = unknown>(
		channel: string,
		request: Request,
		watch?: Watch,
		trace?: string,
	): Promise<T> {
		const observe = watch && {
			closed: (error: string) => watch.closed?.(error),
			event: (event: Event) => {
				if (event.kind === "metadata") {
					const { name, summary, revision } = event;
					this.#update(channel, { name, summary, revision });
				}
				watch.event(event);
			},
		};
		return this.request<T>({ op: "channel", channel, request }, observe, trace).then((value) => {
			if (request.op === "rename") this.#update(channel, value as Metadata);
			return value;
		});
	}

	/** Receive a terminal's output and exit; returns the unsubscribe. */
	terminal(id: string, listener: (frame: TerminalFrame) => void): () => void {
		this.#terminals.set(id, listener);
		return () => this.#terminals.delete(id);
	}

	close() {
		this.#closed = true;
		clearTimeout(this.#timer);
		this.#socket?.close();
	}
}
