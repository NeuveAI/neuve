import { afterEach, beforeEach } from "bun:test";
import {channelOperations, ExtensionRequestSchema, type ExtensionRequest} from "@ace/channel/operations";
import {parseRequest} from "@ace/channel/parse";
import type {ChannelExtension} from "@ace/channel/extensions";
import type {Review} from "@ace/channel/review";
import type {Planning} from "@ace/channel/planning";
import {lanes as externalLanes, isPlaced} from "@ace/channel/external-lanes";
type Request = NativeRequest | ExtensionRequest;
type FixtureOptions = Partial<Options> & Omit<ChannelExtension,"extensions"> & {review?: Review; planning?: Planning; lanes?: string};
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	createModels,
	type FauxProviderHandle,
	fauxProvider,
	type FauxResponseStep,
	type Models,
} from "@earendil-works/pi-ai";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { ok } from "@earendil-works/pi-durable/env";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

import { Channel, type Directory, type Event, type Options, type Request as NativeRequest } from "@ace/channel";

export const OWNER = "owner";
export const MODEL = { provider: "faux", modelId: "coder" };

export function isolateClaudeConfig() {
	let previous: string | undefined;
	beforeEach(() => {
		previous = process.env["CLAUDE_CONFIG_DIR"];
		delete process.env["CLAUDE_CONFIG_DIR"];
	});
	afterEach(() => {
		if (previous === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
		else process.env["CLAUDE_CONFIG_DIR"] = previous;
	});
}

/** Every test's files live under TMPDIR, which the runner points at the external volume. */
export async function scratch(): Promise<string> {
	if (!process.env.TMPDIR) throw new Error("Set TMPDIR to the external temporary directory");
	return realpath(await mkdtemp(join(tmpdir(), "neuve channel ")));
}

export function scratchEnv(cwd: string, root: string): NodeExecutionEnv {
	const home = join(root, "home");
	return new class extends NodeExecutionEnv {
		override async absolutePath(...args: Parameters<NodeExecutionEnv["absolutePath"]>): ReturnType<NodeExecutionEnv["absolutePath"]> {
			return args[0] === "~" ? ok(home) : super.absolutePath(...args);
		}
	}({ cwd });
}

export function git(dir: string, ...args: string[]): string {
	const result = Bun.spawnSync(
		["git", "-c", "user.name=Neuve Test", "-c", "user.email=test@neuve.invalid", "-C", dir, ...args],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (result.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
	}
	return result.stdout.toString();
}

/**
 * A project checkout with one commit, and a lanes directory outside it holding the `work` lane the
 * host assigns a new channel's root chat; every path holds spaces.
 */
export async function project(
	root: string,
): Promise<{ project: string; lanes: string; lane: { name: string; path: string; base: string } }> {
	const dir = join(root, "project checkout");
	await mkdir(dir);
	git(dir, "init", "-q", "-b", "main");
	await writeFile(join(dir, "README.md"), "hello\n");
	git(dir, "add", "README.md");
	git(dir, "commit", "-q", "-m", "first");
	const lanes = join(root, "lanes with spaces", "channel one");
	await mkdir(lanes, { recursive: true });
	const lane = { name: "work", path: join(lanes, "work"), base: "refs/heads/main" };
	git(dir, "worktree", "add", "-q", "-b", "one/work", lane.path, "HEAD");
	return { project: dir, lanes, lane };
}

/** A pi-ai `Models` with only the no-network faux provider, scripted per test. */
export function faux(): { faux: FauxProviderHandle; models: Models } {
	const handle = fauxProvider({
		provider: "faux",
		models: [{ id: "coder", contextWindow: 200_000, reasoning: true }],
		tokensPerSecond: 100_000,
	});
	const models = createModels();
	models.setProvider(handle.provider);
	return { faux: handle, models };
}

export type Log = { level: string; event: string; fields?: Record<string, unknown> }[];

/** One channel over a real SQLite file, real shells, and real Git, reopenable like a restart. */
/** A closed channel's file as it stands. SQLite on macOS refuses a plain read-only open once a clean close has deleted the WAL. */
export const closedDatabase = (path: string): DatabaseSync => {
	const uri = pathToFileURL(path);
	uri.searchParams.set("immutable", "1");
	return new DatabaseSync(uri.href, {readOnly: true});
};

export class Fixture {
	readonly envs = new Map<string, NodeExecutionEnv>();
	readonly log: Log = [];
	channel!: Channel;
	operations!: ReturnType<typeof channelOperations>;

	constructor(
		readonly root: string,
		readonly project: string,
		readonly lanes: string,
		readonly lane: { name: string; path: string; base: string },
		readonly scripted: { faux: FauxProviderHandle; models: Models },
		readonly options: FixtureOptions = {},
	) {}

	static async create(options: FixtureOptions = {}): Promise<Fixture> {
		const root = await scratch();
		const { project: dir, lanes, lane } = await project(root);
		const fixture = new Fixture(root, dir, lanes, lane, faux(), options);
		await fixture.open();
		return fixture;
	}

	get faux(): FauxProviderHandle {
		return this.scripted.faux;
	}

	script(...steps: FauxResponseStep[]): void {
		this.faux.appendResponses(steps);
	}

	async open(): Promise<Channel> {
		const directory: Directory = {
			self: { id: "one", name: "one" },
			list: async () => [],
			deliver: async () => {
				throw new Error("No other channels");
			},
		};
		this.operations = channelOperations({...this.options, log: (level,event,fields) => this.log.push({level,event,...(fields ? {fields} : {})})});
		const operations = this.operations;
		this.channel = await Channel.open({
			id: "one",
			name: "one",
			owner: OWNER,
			project: this.project,

			lane: this.lane,
			defaultModel: async () => MODEL,
			storage: await openNodeSqliteStorage(join(this.root, "state", "channel.sqlite")),
			models: this.scripted.models,
			env: (cwd) => {
				let env = this.envs.get(cwd);
				if (!env) this.envs.set(cwd, env = scratchEnv(cwd, this.root));
				return env;
			},
			directory,
			log: (level, event, fields) =>
				this.log.push({ level, event, ...(fields ? { fields } : {}) }),
			...this.options,
			extension: {
				...this.options,
				...operations.extension,
				extensions: [...operations.extension.extensions, externalLanes({name: "one", project: this.project, lanes: this.lanes, env: (cwd) => scratchEnv(cwd, this.root)})],
				environment: (cwd) => isPlaced(cwd, this.project),
			},
		});
		return this.channel;
	}

	/** As a worker's SIGTERM does: close without aborting, so reopening resumes the work. */
	async restart(): Promise<Channel> {
		await this.channel.close();
		for (const env of this.envs.values()) await env.cleanup(BACKGROUND_CONTEXT);
		this.envs.clear();
		return this.open();
	}

	request<T = unknown>(request: Request): Promise<T> {
		return (ExtensionRequestSchema.safeParse(request).success ? this.operations.handle(ExtensionRequestSchema.parse(request)) : this.channel.handle(parseRequest(request, "author" in request ? request.author : ""), () => {})) as Promise<T>;
	}

	async watch(request: Extract<Request, { op: "watch" }> = { op: "watch" }): Promise<Watch> {
		const events: Event[] = [];
		const handle = await this.channel.handle(
			{ queue: true, captions: true, progress: true, actions: true, agent: true, stops: true, ...request },
			(event) => events.push(event),
		) as { stop(): Promise<unknown> };
		return new Watch(events, handle);
	}

	async dispose(): Promise<void> {
		await this.channel.close().catch(() => {});
		for (const env of this.envs.values()) await env.cleanup(BACKGROUND_CONTEXT);
		await rm(this.root, { recursive: true, force: true });
	}
}

export class Watch {
	constructor(readonly events: Event[], readonly handle: { stop(): Promise<unknown> }) {}

	of<K extends Event["kind"]>(kind: K): Extract<Event, { kind: K }>[] {
		return this.events.filter((event): event is Extract<Event, { kind: K }> => event.kind === kind);
	}

	async until<K extends Event["kind"]>(
		kind: K,
		match: (event: Extract<Event, { kind: K }>) => boolean = () => true,
		timeout = 15_000,
	): Promise<Extract<Event, { kind: K }>> {
		return until(() => this.of(kind).find(match), timeout, `a ${kind} event`);
	}

	stop(): Promise<unknown> {
		return this.handle.stop();
	}
}

export async function until<T>(
	read: () => T | undefined | false | Promise<T | undefined | false>,
	timeout = 15_000,
	what = "the condition",
): Promise<T> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const value = await read();
		if (value) return value;
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for ${what}`);
}
