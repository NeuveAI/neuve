import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { ServerWebSocket } from "bun";
import type WebSocket from "ws";

import { ownerCredential } from "./auth";
import { config } from "./config";
import type { Host } from "./host";
import { Ulid } from "@neuve/records-schema";

const ClientWebSocket: typeof WebSocket = typeof require === "function"
	? require("../node_modules/ws/index.js")
	: createRequire(import.meta.url)("../node_modules/ws/index.js");

const MAX_MESSAGE = 128 * 1024 * 1024;
const MAX_PENDING = 8 * 1024 * 1024;
const MAX_BUFFERED = 16 * 1024 * 1024;
const CONNECT_TIMEOUT = 10_000;
const HEADERS = {
	"Content-Security-Policy": "frame-ancestors 'none'; object-src 'none'; base-uri 'none'",
	"Referrer-Policy": "no-referrer",
	"X-Content-Type-Options": "nosniff",
	"Cross-Origin-Resource-Policy": "same-origin",
};

type Upstream =
	| { state: "connecting"; socket: WebSocket; pending: string[]; bytes: number; timeout: ReturnType<typeof setTimeout> }
	| { state: "open"; socket: WebSocket }
	| { state: "closed" };
type Browser = { upstream: Upstream };

export type CodingUiOptions = {
	host: Pick<Host, "url" | "token">;
	directory: string;
	port: number;
	review?: ReviewResolver;
};
export type CodingUi = { url: string; close(): Promise<void> };

/** Stable across host restarts; never a filesystem path supplied by a browser. */
export function reviewBase(project: string): string {
	return `/review/${createHash("sha256").update(project).digest("hex")}/`;
}

export function reviewPaths(project: string, cycle: string): { batch: string; desk: string } {
	const batch = `${reviewBase(project)}cycles/${Ulid.parse(cycle)}`;
	return { batch, desk: `${batch}/desk` };
}

export type ReviewResolver = (key: string) => Promise<string | undefined>;
let reviews: ReviewResolver | undefined;

/** Installed by the workspace; native listeners must authorize the owner before calling. */
export function configureReviewRoutes(resolve: ReviewResolver | undefined): void {
	reviews = resolve;
}

export async function reviewRequest(request: Request, resolve = reviews): Promise<Response | undefined> {
	const url = new URL(request.url);
	if (url.pathname !== "/review" && !url.pathname.startsWith("/review/")) return;
	const match = /^\/review\/([a-f0-9]{64})\//.exec(url.pathname);
	const key = match?.[1];
	if (!key || !match || !resolve) return new Response("Review not found", { status: 404 });
	const origin = request.headers.get("origin");
	const site = request.headers.get("sec-fetch-site");
	if ((origin !== null && origin !== url.origin)
		|| (site !== null && site !== "same-origin" && !(request.method === "GET" && request.headers.get("sec-fetch-mode") === "navigate"))
		|| (request.method === "POST" && origin === null && site !== "same-origin")) {
		return new Response("Forbidden", { status: 403 });
	}
	if (!["GET", "HEAD", "POST"].includes(request.method) || request.headers.has("upgrade")) {
		return new Response("Method not allowed", { status: 405 });
	}
	let pathname: string;
	try { pathname = decodeURIComponent(url.pathname); }
	catch { return new Response("Invalid path", { status: 400 }); }
	if (pathname.includes("\\") || pathname.includes("\0") || pathname.split("/").includes("..")) {
		return new Response("Forbidden", { status: 403 });
	}
	try {
		const root = await resolve(key);
		if (!root) return new Response("Review not found", { status: 404 });
		const upstream = new URL(root);
		if (upstream.protocol !== "http:" || upstream.hostname !== "127.0.0.1" || !upstream.port
			|| upstream.username || upstream.password || upstream.search || upstream.hash) {
			throw new Error("The review app needs a loopback HTTP endpoint");
		}
		upstream.pathname = url.pathname;
		upstream.search = url.search;
		const headers = new Headers();
		for (const [name, value] of request.headers) {
			if (["accept", "accept-language", "content-type", "last-event-id", "range", "if-none-match", "if-modified-since"].includes(name)
				|| name.startsWith("x-tsr-") || name.startsWith("x-tss-")) headers.set(name, value);
		}
		if (origin !== null) headers.set("origin", upstream.origin);
		if (site !== null) headers.set("sec-fetch-site", site);
		const response = await fetch(upstream, {
			method: request.method,
			headers,
			...(request.method === "POST" ? { body: request.body } : {}),
			redirect: "manual",
			signal: request.signal,
		});
		const output = new Headers(response.headers);
		for (const name of ["set-cookie", "access-control-allow-origin", "access-control-allow-credentials", "content-encoding", "content-length", "connection", "transfer-encoding"]) output.delete(name);
		const location = output.get("location");
		if (location !== null) {
			const destination = new URL(location, upstream);
			if (destination.origin !== upstream.origin || !destination.pathname.startsWith(match[0])) {
				await response.body?.cancel();
				return new Response("Invalid review redirect", { status: 502 });
			}
			output.set("location", `${destination.pathname}${destination.search}${destination.hash}`);
		}
		output.set("Content-Security-Policy", "frame-ancestors 'self'; object-src 'none'; base-uri 'self'");
		output.set("X-Frame-Options", "SAMEORIGIN");
		output.set("Referrer-Policy", "no-referrer");
		output.set("X-Content-Type-Options", "nosniff");
		output.set("Cross-Origin-Resource-Policy", "same-origin");
		return new Response(request.method === "HEAD" ? null : response.body, { status: response.status, headers: output });
	} catch {
		return new Response("The review app is unavailable", { status: 502 });
	}
}

/** The app owns a public socket; only this server holds its private owner connection. */
export async function serveCodingUi(options: CodingUiOptions): Promise<CodingUi> {
	const endpoint = new URL(options.host.url);
	if (endpoint.protocol !== "ws:" || endpoint.hostname !== "127.0.0.1" || endpoint.pathname !== "/ws"
		|| !endpoint.port || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) {
		throw new Error("The coding UI needs the private loopback host endpoint");
	}
	if (!/^[a-f0-9]{64}$/.test(options.host.token)) throw new Error("The coding UI needs the private owner credential");
	if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error("Invalid coding UI port");
	const directory = await realpath(options.directory);
	const index = resolve(directory, "index.html");
	if (!(await stat(index)).isFile()) throw new Error("The Neuve app is not built");
	const sockets = new Set<ServerWebSocket<Browser>>();
	let closing = false;
	const disconnect = (socket: ServerWebSocket<Browser>, code = 1011, reason = "The host connection closed") => {
		const upstream = socket.data.upstream;
		socket.data.upstream = { state: "closed" };
		if (upstream.state !== "closed") {
			if (upstream.state === "connecting") clearTimeout(upstream.timeout);
			upstream.socket.close();
		}
		socket.close(code, reason);
	};
	const server = Bun.serve<Browser>({
		hostname: "127.0.0.1",
		port: options.port,
		async fetch(request, server) {
			const host = `127.0.0.1:${server.port}`;
			const origin = `http://${host}`;
			if (closing || request.headers.get("host") !== host) return new Response("Forbidden", { status: 403 });
			const url = new URL(request.url);
			if (url.pathname === "/review" || url.pathname.startsWith("/review/")) server.timeout(request, 120);
			const review = await reviewRequest(request, options.review);
			if (review) {
				if (review.headers.get("content-type")?.split(";")[0]?.trim() === "text/event-stream") server.timeout(request, 0);
				return review;
			}
			if (url.pathname === "/ws") {
				const suppliedOrigin = request.headers.get("origin");
				const fetchSite = request.headers.get("sec-fetch-site");
				if ((suppliedOrigin !== null && suppliedOrigin !== origin) || (fetchSite !== null && fetchSite !== "same-origin")) {
					return new Response("Forbidden", { status: 403 });
				}
				if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
				const upgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
				if (upgrade && (suppliedOrigin !== origin || url.search)) return new Response("Forbidden", { status: 403 });
				if (!access.authorizes(request)) return new Response(config.command, { status: 401 });
				if (!upgrade) {
					return new Response("Connect to the coding host using a WebSocket", { headers: { ...HEADERS, "Cache-Control": "no-store" } });
				}
				const protocols = request.headers.get("sec-websocket-protocol")?.split(",").map(value => value.trim()) ?? [];
				const ace = protocols.includes("ace");
				if (protocols.length && (!ace || protocols.some(protocol => protocol !== "ace" && !protocol.startsWith("ace-token.")))) {
					return new Response("Unsupported WebSocket protocol", { status: 400 });
				}
				return server.upgrade(request, {
					data: { upstream: { state: "closed" } },
					headers: { "set-cookie": access.cookie, ...(ace ? { "sec-websocket-protocol": "ace" } : {}) },
				}) ? undefined : new Response("Upgrade failed", { status: 400 });
			}
			if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
			if (url.pathname === "/health") return Response.json({ app: "ace", ready: true }, { headers: { ...HEADERS, "Cache-Control": "no-store" } });
			let pathname: string;
			try { pathname = decodeURIComponent(url.pathname); }
			catch { return new Response("Invalid path", { status: 400 }); }
			if (pathname.includes("\0") || pathname.split(/[\\/]/).includes("..")) return new Response("Forbidden", { status: 403 });
			const candidate = resolve(directory, `.${pathname}`);
			const contained = (path: string) => {
				const offset = relative(directory, path);
				return offset !== ".." && !offset.startsWith(`..${sep}`) && !isAbsolute(offset);
			};
			if (!contained(candidate)) return new Response("Forbidden", { status: 403 });
			let file = index;
			try {
				const path = await realpath(candidate);
				if (!contained(path)) return new Response("Forbidden", { status: 403 });
				if ((await stat(path)).isFile()) file = path;
			} catch (error) {
				if (!(error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR"))) throw error;
			}
			return new Response(request.method === "HEAD" ? null : Bun.file(file), {
				headers: { ...HEADERS, "Cache-Control": file === index ? "no-store" : "no-cache", "Content-Type": Bun.file(file).type },
			});
		},
		websocket: {
			maxPayloadLength: MAX_MESSAGE,
			backpressureLimit: MAX_BUFFERED,
			closeOnBackpressureLimit: true,
			open(socket) {
				sockets.add(socket);
				if (closing) return disconnect(socket, 1001, "The coding UI is stopping");
				const upstream = new ClientWebSocket(endpoint.href, ["ace", `ace-token.${options.host.token}`], { maxPayload: MAX_MESSAGE });
				const timeout = setTimeout(() => disconnect(socket, 1013, "The private host did not connect"), CONNECT_TIMEOUT);
				socket.data.upstream = { state: "connecting", socket: upstream, pending: [], bytes: 0, timeout };
				upstream.on("open", () => {
					const state = socket.data.upstream;
					if (state.state !== "connecting") return upstream.close();
					clearTimeout(state.timeout);
					socket.data.upstream = { state: "open", socket: upstream };
					for (const message of state.pending) upstream.send(message);
				});
				upstream.on("message", (data, binary) => {
					if (binary) return disconnect(socket, 1003, "The host sent a binary frame");
					if (socket.data.upstream.state === "closed") return;
					if (socket.send(data.toString()) === 0) disconnect(socket, 1013, "The browser could not receive host data");
				});
				upstream.on("error", () => disconnect(socket));
				upstream.on("close", () => disconnect(socket));
			},
			message(socket, message) {
				if (typeof message !== "string") return disconnect(socket, 1003, "The app protocol requires text frames");
				const state = socket.data.upstream;
				if (state.state === "closed") return disconnect(socket);
				if (state.state === "connecting") {
					state.bytes += Buffer.byteLength(message);
					if (state.bytes > MAX_PENDING) return disconnect(socket, 1009, "Too much data before the host connected");
					state.pending.push(message);
					return;
				}
				if (state.socket.bufferedAmount + Buffer.byteLength(message) > MAX_BUFFERED) return disconnect(socket, 1013, "The private host could not receive app data");
				state.socket.send(message);
			},
			close(socket) {
				sockets.delete(socket);
				disconnect(socket, 1000, "The app disconnected");
			},
		},
	});
	const access = ownerCredential(server.port!, options.host.token);
	let stopped: Promise<void> | undefined;
	return {
		url: `http://127.0.0.1:${server.port}/`,
		close() {
			return stopped ??= (async () => {
				closing = true;
				for (const socket of sockets) disconnect(socket, 1001, "The coding UI is stopping");
				await server.stop(true);
			})();
		},
	};
}
