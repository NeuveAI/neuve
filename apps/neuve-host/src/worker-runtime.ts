import * as catalog from "./catalog";
import { nativeReview, startReviewFeed } from "./native-review";
import {NativeSourceRequestSchema, NativeAuthorityReceiptSchema, type NativeSourceRequest, type NativeAuthorityReceipt} from "./native-source-protocol";
import * as privateLog from "./private-log";
import {lanes as externalLanes, isPlaced} from "@ace/channel/external-lanes";
import {join as joinPath} from "node:path";
const catalogLanes = (id: string) => joinPath(config.lanes, id);
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import type { ConversationId, Storage, ToolRegistration, Extension, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Channel, type Options, type ModelRef } from "@ace/channel";
import { channelOperations, ExtensionRequestSchema, MUTATING } from "@ace/channel/operations";
import type { Planning } from "@ace/channel/planning";
import type { Review } from "@ace/channel/review";
import { config, configure, CONFIG_VARIABLE, GIT_LOCAL, type HostConfig } from "./host-config";
import { configureRuntime, runtimeHooks } from "./runtime-hooks";
import { planExplore, planFileAccess } from "./plan-git";
/**
 * The channel a worker serves, given to root's factories before anything is created, so they can
 * bind provider capture and telemetry to it. The host keeps no capture store of its own.
 */
export type WorkerContext = {
	/** The channel's ID, which names its pi session and every log line. */
	sessionId: string;
	config: HostConfig;
	/** The channel's own directory on the state volume, holding its pi SQLite store. */
	stateDirectory: string;
};

export type WorkerAdmission = Parameters<NonNullable<NonNullable<Options["extension"]>["attach"]>>[1];

/** What root's worker entry provides: the provider lane's models, built in the worker's process. */
export type WorkerSetup = {
	extensions?(context: WorkerContext): { extensions: readonly Extension[]; attach?(harness: Harness, admission?: WorkerAdmission): void | Promise<void> };
	checkpoint?(context: WorkerContext, request: NativeSourceRequest): Promise<NativeAuthorityReceipt>;
	/** Acquire the source before any mutable native storage opens. Cleanup follows a confirmed native close. */
	openSource?(context: WorkerContext): (() => void) | Promise<() => void>;
	review?(context: WorkerContext): Review | Promise<Review>;
	models(context: WorkerContext, defaults: Models): Models | Promise<Models>;
	planning?(context: WorkerContext): Planning | undefined | Promise<Planning | undefined>;
	/** What a chat without a model runs when the host configures none. */
	defaultModel?(context: WorkerContext): Promise<ModelRef>;
	tool?(context: WorkerContext, tool: ToolRegistration): ToolRegistration;
	onConversation?(context: WorkerContext, id: ConversationId): void;
	priced?(model: ModelRef): boolean;
	nonTurnModels?(context: WorkerContext, kind: "caption" | "recap", chat: ConversationId, defaults: Models): Models;
	/** Runs after native producers join, while the raw store is still readable. */
	close?(input: { worker: WorkerContext; reads: Storage; context: Context }): Promise<void>;
};

const pendingSources = new Set<() => void>();

export async function openWorkerStorage(
	setup: Pick<WorkerSetup, "openSource" | "close">,
	worker: WorkerContext,
	openStorage: () => Promise<Storage>,
	nativePath = join(worker.stateDirectory, "channel.sqlite"),
): Promise<Storage> {
	const cleanup = await setup.openSource?.(worker);
	if (cleanup) pendingSources.add(cleanup);
	try {
		if (nativePath !== ":memory:")
			await mkdir(dirname(nativePath), { recursive: true });
	} catch (error) {
		try {
			cleanup?.();
			if (cleanup) pendingSources.delete(cleanup);
		} catch (closeError) {
			throw new AggregateError(
				[error, closeError],
				"Native preflight and source cleanup failed",
			);
		}
		throw error;
	}
	const raw = await openStorage();
	let closing: Promise<void> | undefined;
	return new Proxy(raw, {
		get(target, property) {
			if (property === "close")
				return (context: Context) =>
					(closing ??= Promise.resolve().then(async () => {
						const errors: unknown[] = [];
						try {
							await setup.close?.({ worker, reads: raw, context });
						} catch (error) {
							errors.push(error);
						}
						let closed = false;
						try {
							await raw.close(context);
							closed = true;
						} catch (error) {
							errors.push(error);
						}
						if (closed) {
							try {
								cleanup?.();
								if (cleanup) pendingSources.delete(cleanup);
							} catch (error) {
								errors.push(error);
							}
						}
						if (errors.length > 1)
							throw new AggregateError(
								errors,
								"Capture and native cleanup failed",
							);
						if (errors.length === 1) throw errors[0];
					}));
			const value: unknown = Reflect.get(target, property);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}


/** Configure Neuve before importing the original process entry, which reads argv and config eagerly. */
export async function runWorker(setup: WorkerSetup): Promise<void> {
	configure(JSON.parse(process.env[CONFIG_VARIABLE] || "null"));
	applyWorkerEnvironment();
	for (const name of GIT_LOCAL) delete process.env[name];
	const id = process.argv.at(-1)!;
	process.argv[2] = id;
	configureRuntime({worker: setup});
	privateLog.open(`channel-${id}`, {channel: id});
	await import("./worker");
}

export async function openChannel(options: Options, stateDirectory: string): Promise<Channel> {
	const setup = runtimeHooks().worker;
	const planOptions = { ...options, planFileAccess, planFiles: planFiles(join(stateDirectory, "plans")) };
	if (!setup) return Channel.open({
		...planOptions,
		extension: { ...options.extension, extensions: [...(options.extension?.extensions ?? []), planExplore] },
	});
	const worker: WorkerContext = {sessionId: options.id, config, stateDirectory};
	const storage = options.storage;
	try {
		const models = await setup.models(worker, options.models);
		const additional = await setup.extensions?.(worker);
		const operations = channelOperations({log: options.log,
			...(setup.review ? {review: await setup.review(worker)} : {}),
			...(setup.planning ? {planning: await setup.planning(worker)} : {}),
		});
		const extension = {
			environment: (cwd: string) => isPlaced(cwd, options.project),
			...operations.extension,
			extensions: [...operations.extension.extensions, externalLanes({name: options.prefix || options.name, project: options.project, lanes: catalogLanes(options.id), env: options.env}), ...(additional?.extensions ?? []), planExplore],
			attach: async (harness: Harness, admission: WorkerAdmission) => {
				await operations.extension.attach?.(harness, admission);
				await additional?.attach?.(harness, admission);
			},
			...(setup.tool ? {tool: (tool: ToolRegistration) => setup.tool!(worker, tool)} : {}),
			...(setup.onConversation ? {onConversation: (id: ConversationId) => setup.onConversation!(worker, id)} : {}),
			...(setup.priced ? {priced: setup.priced} : {}),
			...(config.thinkingLevel ? {thinkingLevel: config.thinkingLevel} : {}),
			...(setup.nonTurnModels ? {nonTurnModels: (kind: "caption" | "recap", chat: ConversationId) => setup.nonTurnModels!(worker, kind, chat, options.models)} : {}),
		};
		const channel = await Channel.open({...planOptions, log: privateLog.log, storage, models, extension,
			...(setup.review ? {
				feed: async (harness, submitInput) => {
					const adapter = nativeReview(options.id);
					try {
						const feed = await startReviewFeed(harness, adapter.source, submitInput, {
							log: privateLog.log,
							enabled: () => { const record = catalog.read(options.id); return !record.archived && !record.moving && !record.hosted; },
						});
						return { pending: feed.pending, close: async () => { adapter.close(); await feed.close(); } };
					} catch (error) { adapter.close(); throw error; }
				},
			} : {}),
			...(config.model ? {defaultModel: async () => config.model!} : setup.defaultModel ? {defaultModel: () => setup.defaultModel!(worker)} : {}),
		});
		bound.set(channel, operations.handle);
		workers.set(channel, worker);
		return channel;
	} catch (error) {
		try { await storage.close(BACKGROUND_CONTEXT); } catch (cleanup) { throw new AggregateError([error, cleanup], "Worker startup and cleanup failed"); }
		throw error;
	}
}

function planFiles(directory: string): NonNullable<Options["planFiles"]> {
	const staged = (file: string, hash: string) => {
		if (!/^[a-f0-9-]{36}\.md$/.test(file) || !/^[a-f0-9]{64}$/.test(hash)) {
			throw new Error("Invalid stored plan file.");
		}
		return join(directory, `${file}.${hash}.pending`);
	};
	const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
	const stage = async (file: string, hash: string, bytes: Uint8Array) => {
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const temporary = join(directory, `${crypto.randomUUID()}.tmp`);
		try {
			await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
			await rename(temporary, staged(file, hash));
		} finally {
			await rm(temporary, { force: true });
		}
	};
	return {
		stage,
		async read(file, hash, bytes) {
			const pending = staged(file, hash);
			const path = join(directory, file);
			// Publish only a staged write whose hash the session committed.
			try { await rename(pending, path); }
			catch (error) { if (!missing(error)) throw error; }
			try {
				const copy = await readFile(path);
				if (createHash("sha256").update(copy).digest("hex") === hash) return copy;
			} catch (error) { if (!missing(error)) throw error; }
			// Rebuild a missing or changed copy from the committed session bytes.
			await stage(file, hash, bytes);
			await rename(pending, path);
			return bytes;
		},
	};
}
const workers = new WeakMap<Channel, WorkerContext>();
const bound = new WeakMap<Channel, ReturnType<typeof channelOperations>["handle"]>();
export async function extensionRequest(channel: Channel, request: unknown, archived: boolean): Promise<{handled: false} | {handled: true; value: unknown}> {
	const checkpoint = NativeSourceRequestSchema.safeParse(request);
	if (checkpoint.success) {
		const worker = workers.get(channel);
		const handler = runtimeHooks().worker?.checkpoint;
		if (!worker || !handler) throw new Error("Native source checkpoint is not configured");
		return {handled: true, value: NativeAuthorityReceiptSchema.parse(await handler(worker, checkpoint.data))};
	}
	const parsed = ExtensionRequestSchema.safeParse(request);
	if (!parsed.success) return {handled: false};
	if (archived && MUTATING.has(parsed.data.op)) throw new Error("The channel is archived");
	const handle = bound.get(channel);
	if (!handle) throw new Error("The channel extension is not configured");
	return {handled: true, value: await handle(parsed.data)};
}

export async function workerStorage(id: string, stateDirectory: string, nativePath: string): Promise<Storage> {
	const setup = runtimeHooks().worker;
	return setup ? openWorkerStorage(setup, {sessionId: id, config, stateDirectory}, () => openNodeSqliteStorage(nativePath), nativePath) : openNodeSqliteStorage(nativePath);
}
export async function workerModels(id: string, stateDirectory: string, fallback: () => Models): Promise<Models> {
	const setup = runtimeHooks().worker;
	return setup ? setup.models({sessionId: id, config, stateDirectory}, fallback()) : fallback();
}

export async function bindWorkerCatalog(): Promise<void> {
	if (runtimeHooks().worker) (await import("./catalog")).bind({home: config.home, user: config.user, local: config.channelScope === "local"});
}

/** Each worker receives its validated snapshot; arbitrary variables never contaminate the host. */
export function applyWorkerEnvironment(): void {
	const secret = /(_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIALS?)$/;
	for (const name of Object.keys(process.env)) {
		if (!(name in config.environment) && !secret.test(name) && name !== CONFIG_VARIABLE) delete process.env[name];
	}
	for (const [name, value] of Object.entries(config.environment)) process.env[name] = value;
	process.env.ACE_HOME = config.home;
	process.env.ACE_CONFIG_HOME = join(config.home, "settings");
	process.env.ACE_KEYCHAIN_SERVICE = `neuve-${config.home}`;
	process.env.ACE_PORT = String(config.port);
	process.env.ACE_USER = config.user;
	process.env[CONFIG_VARIABLE] = JSON.stringify(config);
	for (const name of GIT_LOCAL) delete process.env[name];
}
