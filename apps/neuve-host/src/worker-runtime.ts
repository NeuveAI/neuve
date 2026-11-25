import * as catalog from "./catalog";
import { nativeReview, startReviewFeed } from "./native-review";
import {NativeSourceRequestSchema, NativeAuthorityReceiptSchema, type NativeSourceRequest, type NativeAuthorityReceipt} from "./native-source-protocol";
import * as privateLog from "./private-log";
import {buildWorktree, lanes as externalLanes, isPlaced} from "@ace/channel/external-lanes";
import { SharedWork } from "@neuve/records-core/shared-work";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
import { git } from "./projects";
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
type ReadScope = NonNullable<NonNullable<Options["build"]>["query"]>["read"];
type ScopeQuery = Omit<Parameters<ReadScope>[0], "plan" | "previousPlans"> & {
	plan: { path: string; sha256: string };
};
type ScopeResult = {
	scope?: readonly { title: string; ref: { path?: string | undefined } }[];
	scope_gaps?: readonly string[];
	refusal?: string;
	[key: string]: unknown;
};

/** What root's worker entry provides: the provider lane's models, built in the worker's process. */
export type WorkerSetup = {
	extensions?(context: WorkerContext): { extensions: readonly Extension[]; attach?(harness: Harness, admission?: WorkerAdmission): void | Promise<void> };
	checkpoint?(context: WorkerContext, request: NativeSourceRequest): Promise<NativeAuthorityReceipt>;
	/** Acquire the source before any mutable native storage opens. Cleanup follows a confirmed native close. */
	openSource?(context: WorkerContext): (() => void) | Promise<() => void>;
	review?(context: WorkerContext): Review | Promise<Review>;
	query?(context: WorkerContext, request: ScopeQuery): Promise<ScopeResult>;
	models(context: WorkerContext, defaults: Models): Models | Promise<Models>;
	planning?(context: WorkerContext): Planning | undefined | Promise<Planning | undefined>;
	/** What a chat without a model runs when the host configures none. */
	defaultModel?(context: WorkerContext): Promise<ModelRef>;
	routeModel?: Options["routeModel"];
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
	const plans = resolve(stateDirectory, "plans");
	const place = config.lanes && {
		name: options.prefix || options.name, project: options.project, lanes: join(config.lanes, options.id), env: options.env,
	};
	const files = planFiles(plans);
	const worker: WorkerContext = {sessionId: options.id, config, stateDirectory};
	const query = setup?.query;
	const work = new SharedWork<unknown>();
	const build: Options["build"] = place ? {
		async share<T>(key: string, run: () => Promise<T>) {
			const { outcome } = await work.run({
				scope: "build", key, run: async () => ({ kind: "succeeded", value: await run() }),
			});
			if (outcome.kind === "failed") throw outcome.error;
			// A key identifies one operation and therefore one result type.
			return outcome.value as T;
		},
		async worktree(...[target, source]) {
			if (typeof target === "string") return buildWorktree(place, target, BACKGROUND_CONTEXT, source);
			const name = `chat-${target.chat}`;
			const known = catalog.read(options.id).chatLanes?.[name];
			// The chat can change its Diff base after the host records ownership.
			const lane = await buildWorktree(place, name, BACKGROUND_CONTEXT, undefined, target.recorded ?? known);
			// Publish host ownership before returning; a crash before pi's commit can recover it.
			const current = catalog.read(options.id);
			catalog.write({ ...current, chatLanes: { ...current.chatLanes, [name]: lane } });
			return lane;
		},
		...(query ? { query: { sessionId: options.id, read: planScopeRead(place.project, plans, request => query(worker, request), files) } } : {}),
	} : undefined;
	const planOptions = { ...options, ...(build ? { build } : {}), planFileAccess, planFiles: files, ...(config.skills ? { skills: config.skills } : {}) };
	if (!setup) return Channel.open({
		...planOptions,
		extension: { ...options.extension, extensions: [...(options.extension?.extensions ?? []), planExplore] },
	});
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
			extensions: [...operations.extension.extensions, ...(place ? [externalLanes(place)] : []), ...(additional?.extensions ?? []), planExplore],
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
		const channel = await Channel.open({...planOptions, log: privateLog.log, storage, models, extension, routeModel: setup.routeModel,
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

const missing = (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT";
function below(root: string, path: string): string | undefined {
	const name = relative(root, path);
	return name === ".." || name.startsWith(`..${sep}`) || isAbsolute(name) ? undefined : name;
}

export function planScopeRead(
	project: string,
	plans: string,
	query: (request: ScopeQuery) => Promise<ScopeResult>,
	files: NonNullable<Options["planFiles"]> = planFiles(plans),
): ReadScope {
	return async ({ plan, previousPlans, scope, ...request }) => {
		const citations = [plan, ...previousPlans].map(({ file, title, hash }) => ({ file, label: `${title} (${hash})` }));
		let plansRoot = plans;
		const redact = (value: string) => {
			for (const { file, label } of citations) {
				const path = join(plansRoot, file);
				value = value.replaceAll(path, () => label).replaceAll(join(plans, file), () => label);
			}
			return value.replaceAll(plansRoot, "<channel plans>").replaceAll(plans, "<channel plans>");
		};
		try {
			await files.read(plan.file, plan.hash, new TextEncoder().encode(plan.text));
			plansRoot = await realpath(plans);
			const planPath = join(plansRoot, plan.file);
			const paths = new Set([planPath]);
			const listed = await git(project, ["worktree", "list", "--porcelain", "-z"]);
			if (listed.status !== 0) throw new Error("Git could not list the repository's worktrees.");
			const worktrees = listed.stdout.split("\0").filter(field => field.startsWith("worktree ")).map(field => field.slice(9));
			const roots = new Map<string, string>();
			for (const root of new Set([project, ...worktrees].map(path => resolve(path)))) {
				const actual = await realpath(root).catch(error => {
					if (!missing(error)) throw error;
				});
				if (actual !== undefined) {
					roots.set(root, actual);
					roots.set(actual, actual);
				}
			}
			const repository = resolve(request.repository);
			if (!roots.has(repository)) {
				return { isError: true, text: redact(`The assigned worktree ${JSON.stringify(request.repository)} is not registered with this repository. Nothing in your call can fix that.`) };
			}
			roots.set(resolve(plans), plansRoot);
			roots.set(plansRoot, plansRoot);
			const aliases = [...roots.keys()].sort((a, b) => b.length - a.length);
			const refused: string[] = [];
			const advice = new Set<string>();
			for (const [index, name] of scope.entries()) {
				const field = `scope[${index}] received ${JSON.stringify(name)}`;
				if (name.includes("\0")) {
					refused.push(`${field} but paths cannot contain NUL bytes`);
					continue;
				}
				const path = resolve(repository, name);
				const alias = aliases.find(root => below(root, path) !== undefined);
				if (alias === undefined) {
					refused.push(`${field} outside the allowed roots`);
					advice.add("name files inside the repository, its worktrees or this channel's plans folder");
					continue;
				}
				const root = roots.get(alias)!;
				const suffix = relative(alias, path);
				try {
					let ancestor = root;
					let linked = false;
					for (const part of suffix.split(sep).filter(Boolean)) {
						ancestor = join(ancestor, part);
						const entry = await lstat(ancestor).catch(error => {
							if (!missing(error) && !(error instanceof Error && "code" in error && error.code === "ENOTDIR")) throw error;
						});
						if (entry === undefined) break;
						if (entry.isSymbolicLink()) {
							linked = true;
							break;
						}
					}
					if (linked) {
						refused.push(`${field} through a link`);
						advice.add("name each linked file by a path with no link in it");
					} else paths.add(join(root, suffix));
				} catch (error) {
					const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
					let reason = "the host could not check its path";
					if (code === "EACCES" || code === "EPERM") reason = "access to its path was denied";
					else if (code === "ENAMETOOLONG") reason = "its path is too long";
					refused.push(`${field} but ${reason}${code ? ` (${code})` : ""}`);
				}
			}
			if (refused.length) {
				const ending = advice.size ? `, so ${[...advice].join(" and ")}` : "";
				return { isError: true, text: redact(`${refused.join(" and ")}${ending}.`) };
			}
			const { scope: sources, scope_gaps: gaps, refusal, ...result } = await query({
				...request, scope: [...paths], plan: { path: planPath, sha256: plan.hash },
			});
			if (refusal !== undefined) return { isError: true, text: redact(refusal) };
			return { text: JSON.stringify({
				...result,
				...(sources && { scope: sources.map(source => ({
					...source,
					title: redact(source.title),
					ref: source.ref.path === undefined ? source.ref : { ...source.ref, path: redact(source.ref.path) },
				})) }),
				...(gaps && { scope_gaps: gaps.map(redact) }),
			}, (key, value: unknown) => key === "error" && typeof value === "string" ? redact(value) : value) };
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return { isError: true, text: redact(`The host could not read scope for question ${JSON.stringify(request.question)} (${reason}). Ask the channel owner to check the worker before retrying.`) };
		}
	};
}

function planFiles(directory: string): NonNullable<Options["planFiles"]> {
	const staged = (file: string, hash: string) => {
		if (!/^[a-f0-9-]{36}\.md$/.test(file) || !/^[a-f0-9]{64}$/.test(hash)) {
			throw new Error("Invalid stored plan file.");
		}
		return join(directory, `${file}.${hash}.pending`);
	};
	const publish = async (path: string, bytes: Uint8Array) => {
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const temporary = join(directory, `${crypto.randomUUID()}.tmp`);
		try {
			await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
			await rename(temporary, path);
		} finally {
			await rm(temporary, { force: true });
		}
	};
	return {
		stage: (file, hash, bytes) => publish(staged(file, hash), bytes),
		async read(file, hash, bytes) {
			const pending = staged(file, hash);
			const path = join(directory, file);
			// Publish only a staged write whose hash the session committed.
			try { await rename(pending, path); }
			catch (error) { if (!missing(error)) throw error; }
			try {
				await using handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
				if ((await handle.stat()).isFile()) {
					const copy = await handle.readFile();
					if (createHash("sha256").update(copy).digest("hex") === hash) return copy;
				}
			} catch (error) {
				if (!missing(error) && !(error instanceof Error && "code" in error && error.code === "ELOOP")) throw error;
			}
			// Rebuild a missing or changed copy from the committed session bytes.
			await publish(path, bytes);
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
