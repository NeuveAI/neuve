import {bindWorkerCatalog} from "./worker-runtime";
import {clearClose, recordClose} from "./worker-close";
import { RequestSchema as NativeChannelRequestSchema } from "@ace/channel/parse";
const parseNativeChannelRequest = (value: unknown) => NativeChannelRequestSchema.parse(value);
import { openChannel, workerStorage, extensionRequest } from "./worker-runtime";
import { parseWorkerEnvelope } from "./parse";
import { existsSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

import { Channel, type Envelope, type Frame } from "@ace/channel";

import * as catalog from "./catalog";
import { request } from "./client";
import { browser } from "./browser";
import { desktop } from "./desktop";
import { images } from "./images";
import { models, seal } from "./keys";
import { defaultModel } from "./manage";
import { lines } from "./lines";
import { failure, log, open } from "./log";
import type { WorkerInfo, WorkerRequest } from "./protocol";
import { tabs } from "./tabs";

const RETIRE_AFTER = 10 * 60_000;
/** An archived channel keeps its history as it was archived. */
const ARCHIVED = new Set(["say", "ask", "select", "chat", "react", "delete", "edit", "plan-approve", "approval-answer"]);

seal();

const id = process.argv[2];
open(`channel-${id}`, { channel: id });
const paths = catalog.paths(id);
await bindWorkerCatalog();

if (!catalog.lock(id)) {
	log("info", "worker.redundant");
	process.exit(0);
}
// A delete removes the record while it holds the lock, so read it only once this worker does.
if (!existsSync(paths.record)) {
	rmSync(paths.pid, { force: true });
	log("info", "worker.deleted");
	process.exit(0);
}
const record = catalog.read(id);
// A hosted or moving channel's local storage is parked; waking it would fork the channel's history.
if (record.hosted || record.moving) {
	rmSync(paths.pid, { force: true });
	log("info", "worker.parked", { hosted: record.hosted, moving: record.moving?.to });
	process.exit(0);
}
log("info", "worker.start", { bun: Bun.version });

// Model SDKs turn a failed request into "Connection error." and pi-ai keeps only that message, so
// the network error that explains it is logged here before it is wrapped.
const send = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
	try {
		return await send(input, init);
	} catch (error) {
		const url = new URL(input instanceof Request ? input.url : input);
		log("warn", "fetch.failed", { url: url.origin + url.pathname, ...failure(error) });
		throw error;
	}
}, send);
rmSync(paths.socket, { force: true });
catalog.busy(id, false);
clearClose(paths.base);

const envs = new Map<string, NodeExecutionEnv>();
const channel = await openChannel({
	id,
	name: record.name,
	prefix: record.prefix,
	named: record.named,
	claim: async (name, exact) => catalog.claim(id, name, exact),
	onMetadata: (value) => catalog.metadata(id, value),
	onActivity: (at) => catalog.activity(id, at),
	onBusy: (busy) => catalog.busy(id, busy),
	onRun: (ran) => catalog.ran(id, ran),
	onSaid: (said) => catalog.said(id, said),
	owner: record.owner,
	project: record.project,
	model: record.model,
	lane: record.lane,
	defaultModel,
	storage: await workerStorage(id, paths.base, paths.storage),
	models: models(),
	desktop,
	browser,
	images,
	tabs: tabs(id),
	env(cwd) {
		let env = envs.get(cwd);
		if (!env) envs.set(cwd, env = new NodeExecutionEnv({ cwd }));
		return env;
	},
	directory: {
		self: { id, name: record.prefix },
		list: async () => catalog.list().filter((other) => other.id !== id && !other.archived),
		async deliver(delivery) {
			const op = delivery.invoke ? "ask" : "say";
			const { channel: target, chat, author, text, requestId } = delivery;
			await request(target, {
				op,
				...(chat === undefined ? {} : { chat }),
				author,
				text,
				requestId,
			});
		},
	},
	log,
}, paths.base);

const clients = new Set<Socket>();
let quiet = Date.now();
let exiting = false;
/** Requests between admission and reply; a move waits for them so none lands after its snapshot. */
let admitting = 0;
let drained = Promise.withResolvers<void>();
let frozen = false;

/** Stop admitting requests, let admitted ones finish, then exit if no work remains for the move. */
async function freeze(): Promise<void> {
	frozen = true;
	if (admitting) await drained.promise;
	if (await channel.isIdle()) return;
	frozen = false;
	throw new Error("The channel is busy; stop its work before moving it");
}

async function exit(kill: boolean, reason: string) {
	if (exiting) return;
	exiting = true;
	log("info", "worker.exit", { reason, kill, clients: clients.size });
	const errors: unknown[] = [];
	try {
		if (kill) await channel.kill();
		await channel.close();
	} catch (error) { errors.push(error); log("error", "worker.close.failed", failure(error)); }
	catalog.busy(id, false);
	for (const env of envs.values()) {
		try { await env.cleanup(BACKGROUND_CONTEXT); } catch (error) { errors.push(error); log("error", "worker.cleanup.failed", failure(error)); }
	}
	recordClose(paths.base, errors);
	server.close();
	rmSync(paths.socket, { force: true });
	rmSync(paths.pid, { force: true });
	for (const client of clients) client.destroy();
	process.exit(errors.length ? 1 : 0);
}

function serve(socket: Socket) {
	clients.add(socket);
	log("debug", "client.open", { clients: clients.size });
	const watches: { stop(): Promise<unknown> }[] = [];
	const send = (frame: Frame) => socket.writable && socket.write(`${JSON.stringify(frame)}\n`);
	socket.on("error", (error) => {
		log("warn", "client.error", { error: error.message });
		socket.destroy();
	});
	socket.on("close", () => {
		clients.delete(socket);
		quiet = Date.now();
		for (const watch of watches) watch.stop();
	});
	lines(socket, async (line) => {
		let frame: number | undefined;
		try {
			const {id: parsedId, trace, ...body} = parseWorkerEnvelope(line);
			frame = parsedId;
			if (body.op === "worker") {
				return send({ id: frame, ok: true, value: { id, pid: process.pid } satisfies WorkerInfo });
			}
			if (exiting) throw new Error("The channel worker is shutting down");
			if (frozen) throw new Error("The channel is moving");
			if (body.op === "freeze") {
				await freeze();
				send({ id: frame, ok: true, value: null });
				return exit(false, "move");
			}
			if (body.op === "export") return send({ id: frame, ok: true, value: await channel.export() });
			if (catalog.read(id).archived && ARCHIVED.has(body.op)) {
				throw new Error("The channel is archived");
			}
			// `wait` lasts as long as a run, which the move's busy check already refuses.
			const admitted = body.op !== "wait";
			if (admitted) admitting++;
			let value: unknown;
			try {
				const extension = await extensionRequest(channel, body, !!catalog.read(id).archived);
				value = extension.handled ? extension.value : await channel.handle(parseNativeChannelRequest(body), (event) => send({ id: parsedId, event }), trace);
			} finally {
				if (admitted && !--admitting) {
					drained.resolve();
					drained = Promise.withResolvers<void>();
				}
			}
			if (body.op === "watch") {
				watches.push(value as { stop(): Promise<unknown> });
				return send({ id: frame, ok: true, value: null });
			}
			send({ id: frame, ok: true, value: value ?? null });
			if (body.op === "kill") exit(false, "kill");
		} catch (error) {
			if (frame === undefined) { log("warn", "client.refused", failure(error)); socket.destroy(); }
			else send({ id: frame, ok: false, error: error instanceof Error ? error.message : String(error) });
		}
	});
}

const server = createServer(serve);
server.listen(paths.socket);

// Dormant channels are files, not processes: retire once nobody is attached and no work is live.
setInterval(async () => {
	if (clients.size > 0 || exiting) return;
	if (!(await channel.isIdle()) || (!catalog.read(id).archived && channel.observing)) return void (quiet = Date.now());
	if (Date.now() - quiet > RETIRE_AFTER) exit(false, "idle");
}, 30_000);

// A signal closes without aborting, so a restarted worker resumes the work.
process.on("SIGTERM", () => exit(false, "SIGTERM"));
process.on("SIGINT", () => exit(false, "SIGINT"));
