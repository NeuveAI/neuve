import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { nativeReview } from "../src/native-review";
import { Effect, Option } from "effect";
import { Blobs, Log, mintUlid } from "../../../packages/records-core/src/index";
import { RecordEvent } from "@neuve/records-schema";
import { defaultConfig } from "../../../packages/harness/src/config";
import { nativeReviewCallbacks } from "../../neuve-cli/src/workspace-native-review";
import { execute, withStore } from "../../neuve-cli/src/records-cli";
import { receipt } from "../../../packages/records-core/tests/review-fixtures";
import "./fixtures/memory-secrets";
import type { PreparedReview } from "@ace/channel/review-protocol";
import { Connection } from "../src/client";
import { assign } from "../src/channel-create";
import type { GitHubExternalRef } from "@neuve/records-schema";
import type { PlanningState } from "@ace/channel/planning";
import { Database } from "bun:sqlite";
import type { PlanningConnections } from "@ace/channel/planning";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";

import type { ChannelInfo, Event } from "@ace/channel/protocol";

import type { Listing as ChannelRecord } from "../src/catalog";
import * as catalog from "../src/catalog";
import { acquirePull } from "../src/review";
import { parseDescriptor } from "../src/review-github";
import pullFixture from "./fixtures/github-pr-711.json";
import { GatewayClient, type Watch } from "../src/private-gateway-client";
import { configure, GIT_LOCAL } from "../src/host-config";
import { type Host, type HostOptions, startHost } from "./fixture-host";
import { CHANNEL_CLOSED, type ReviewHandoff, type TerminalFrame, type TerminalOpened } from "../src/extension-protocol";
import type { Step } from "./worker";

const OWNER = "owner";

/** The test's own Git sees only the repository it names, even while a test sets a hook's variables. */
const clean = () =>
	Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] =>
			entry[1] !== undefined && !GIT_LOCAL.has(entry[0])
		),
	);

async function git(dir: string, ...args: string[]): Promise<string> {
	const child = Bun.spawn(
		["git", "-c", "user.name=Neuve Test", "-c", "user.email=test@neuve.invalid", "-C", dir, ...args],
		{ stdin: "ignore", stdout: "pipe", stderr: "pipe", env: clean(), timeout: 10_000, killSignal: "SIGKILL" },
	);
	const [code, stdout, stderr] = await Promise.all([
		child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
	]);
	if (code !== 0) throw new Error(`git ${args.join(" ")}: ${stderr}`);
	return stdout.trim();
}

async function until<T>(read: () => T | undefined | false | Promise<T | undefined | false>, what: string) {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline) {
		const value = await read();
		if (value) return value;
		await Bun.sleep(20);
	}
	throw new Error(`Timed out waiting for ${what}`);
}

type Place = { root: string; home: string; lanes: string; project: string; script: string };

/** A host's directories and a project under TMPDIR, which the runner points at the external volume. */
async function place(steps: Step[] = []): Promise<Place> {
	if (!process.env.TMPDIR) throw new Error("Set TMPDIR to the external temporary directory");
	// Short: a worker's socket path must fit in 104 bytes.
	const root = await realpath(await mkdtemp(join(tmpdir(), "nh ")));
	const home = join(root, "state");
	const lanes = join(root, "lanes");
	const project = join(root, "project checkout");
	await Promise.all([mkdir(home), mkdir(lanes), mkdir(project)]);
	await git(project, "init", "-q", "-b", "main");
	await writeFile(join(project, "README.md"), "hello\n");
	await git(project, "add", "README.md");
	await git(project, "commit", "-q", "-m", "first");
	const script = join(root, "script.json");
	await writeFile(script, JSON.stringify(steps));
	await writeFile(`${script}.cursor`, "0");
	return { root, home, lanes, project, script };
}

const environment = (script: string) => ({
	...Object.fromEntries(
		Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
	),
	NEUVE_TEST_SCRIPT: script,
});

const hosts: Host[] = [];
const clients: GatewayClient[] = [];
const listingObservations = new Map<GatewayClient, Array<{ at: number; channels: unknown }>>();
let listingCase: { name: string; passed: boolean } | undefined;

const places: Place[] = [];

async function host(
	at: Place,
	review?: (handoff: ReviewHandoff) => Promise<{ reference: string; url: string }>,
	inherited: Record<string, string> = {},
    options: Pick<HostOptions, "reviewLink" | "planningConnections" | "reviewHistory" | "reviewPrepare" | "reviewSubmit" | "reviewStatus" | "reviewLookup" | "reviewOutcome" | "reviewFeed"> = {},
) {
	// `env` hands the worker the inherited variables itself, as a root entry started from a hook would.
	const pairs = Object.entries(inherited).map(([name, value]) => `${name}=${value}`);
	const started = await startHost({loopback: true,
		config: {
			home: at.home,
			lanes: at.lanes,
			user: OWNER,
			port: 0,
			environment: { ...environment(at.script), ...inherited },
			worker: [...(pairs.length ? ["/usr/bin/env", ...pairs] : []), process.execPath, ...(process.env.NEUVE_TEST_PRELOAD ? ["--preload", process.env.NEUVE_TEST_PRELOAD] : []), ...(process.env.NEUVE_TEST_TSCONFIG ? ["--tsconfig-override", process.env.NEUVE_TEST_TSCONFIG] : []), join(import.meta.dir, "worker.ts")],
		},
		models: () => [{ provider: "faux", modelId: "coder", efforts: ["off"] }],
		...(review ? { review } : {}),
        ...options,
	});
	hosts.push(started);
	return started;
}

/** Lane-dependent fixtures opt into Neuve placement after Ace's ordinary create. */
async function createLane(client: GatewayClient, request: Extract<import("../src/extension-protocol").HostRequest, {op: "create"}>): Promise<ChannelRecord> {
	const {items, ...plain} = request;
	const record = await assign(await client.request<ChannelRecord>(plain));
	if (items?.length) {
		const connection = await Connection.open(record.id);
		try { await connection.request({op: "review-origin-set", items}); }
		finally { connection.close(); }
	}
	return record;
}

async function connect(started: Host): Promise<GatewayClient> {
	const client = new GatewayClient(started.url, started.token);
	clients.push(client);
	if (listingCase || process.env.NEUVE_LISTING_DELIVERY_EVIDENCE) {
		const observations: Array<{ at: number; channels: unknown }> = [];
		listingObservations.set(client, observations);
		let previous: GatewayClient["channels"] | undefined;
		client.subscribe(() => {
			if (previous === client.channels) return;
			previous = client.channels;
			observations.push({ at: Date.now(), channels: structuredClone(client.channels) });
		});
	}
	await until(() => client.status === "open", "the gateway connection");
	return client;
}

async function watch(client: GatewayClient, channel: string, chat?: number, closed?: Watch["closed"]) {
	const events: Event[] = [];
	await client.channel(channel, {
		op: "watch",
		...(chat === undefined ? {} : { chat }),
		queue: true,
		progress: true,
		actions: true,
		agent: true,
		stops: true,
	}, { event: (event) => events.push(event), closed });
	return events;
}

afterEach(async () => {
	try {
		const failed = listingCase && !listingCase.passed;
		const evidence = process.env.NEUVE_LISTING_DELIVERY_EVIDENCE
			|| (failed ? await mkdtemp(join(tmpdir(), "listing-delivery-failure-")) : undefined);
		if (evidence) {
			if (failed) console.error(`[listing-delivery] ${listingCase?.name}: evidence kept at ${evidence}`);
			await mkdir(evidence, { recursive: true });
			await writeFile(join(evidence, `clients-${Date.now()}.json`), JSON.stringify([...listingObservations.values()], null, 2));
			for (const at of places) {
				const directory = join(evidence, at.root.split("/").at(-1)!);
				await mkdir(directory, { recursive: true });
				await writeFile(join(directory, "host.jsonl"), await readFile(join(at.home, "logs/host.jsonl"), "utf8").catch(() => ""));
				for (const id of await readdir(join(at.home, "channels")).catch(() => [])) {
					const value = await readFile(join(at.home, "channels", id, "channel.json"), "utf8").catch(() => undefined);
					if (value) await writeFile(join(directory, `${id}.json`), value);
					const log = await readFile(join(at.home, "logs", `channel-${id}.jsonl`), "utf8").catch(() => undefined);
					if (log !== undefined) await writeFile(join(directory, `channel-${id}.jsonl`), log);
				}
			}
		}
	} finally {
		listingCase = undefined;
		listingObservations.clear();
		for (const client of clients.splice(0)) client.close();
		for (const started of hosts.splice(0)) await started.close().catch(() => {});
		for (const at of places.splice(0)) await rm(at.root, { recursive: true, force: true });
	}
});

async function setup(steps: Step[] = []) {
	const at = await place(steps);
	places.push(at);
	return at;
}

describe("channels through the gateway", () => {
	test("an explicitly prepared Neuve lane runs the root chat outside the project, as its owner", async () => {
		const at = await setup([{ tool: "bash", args: { command: "pwd" }, id: "call-pwd" }, { text: "done" }]);
		const client = await connect(await host(at));
		const record = await createLane(client, { op: "create", project: at.project });
		const lane = join(at.lanes, record.id, "work");
		expect(record.lane).toEqual({ name: "work", path: lane, base: "refs/heads/main" });
		expect(await git(lane, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`${record.prefix}/work`);
		const events = await watch(client, record.id);
		// The host stamps its owner over whatever author a client claims.
		await client.channel(record.id, { op: "ask", author: "mallory", text: "where are you?" });
		await until(() => events.find((event) => event.kind === "reply" && event.text === "done"), "the reply");
		const message = events.find((event) => event.kind === "message");
		expect(message).toMatchObject({ author: OWNER, text: "where are you?" });
		const result = events.find((event) => event.kind === "result" && event.call === "call-pwd");
		expect(result).toMatchObject({ error: false });
		expect((result as { text: string }).text.trim()).toBe(lane);
		const info = await client.channel<ChannelInfo>(record.id, { op: "info" });
		expect(info.chats[0]).toMatchObject({ id: ROOT_CONVERSATION_ID, lane: "work", cwd: lane });
		const state = join(at.home, "channels", record.id);
		expect(JSON.parse(await readFile(join(state, "models-context.json"), "utf8"))).toEqual({
			sessionId: record.id,
			stateDirectory: state,
			home: at.home,
		});
		await until(
			() => client.channels.find((listing) => listing.id === record.id && listing.state === "running"),
			"a running listing",
		);
	});

	test("an assigned worktree must belong to the project's repository and sit outside its checkout", async () => {
		const at = await setup();
		const client = await connect(await host(at));
		const assigned = join(at.root, "assigned lane");
		await git(at.project, "worktree", "add", "-q", "-b", "feature", assigned, "HEAD");
		const other = join(at.root, "other repo");
		await mkdir(other);
		await git(other, "init", "-q");
		await git(other, "commit", "-q", "--allow-empty", "-m", "x");
		const refusals: [unknown, string][] = [
			[{ name: "feature", path: at.project }, "outside the project checkout"],
			[{ name: "feature", path: other }, "is not a worktree of"],
			[{ name: "feature", path: join(at.root, "missing") }, "There's no worktree at"],
			[{ name: "Feature!", path: assigned }, "lowercase kebab-case"],
		];
		for (const [lane, message] of refusals) {
			await expect(
				client.request({ op: "create", project: at.project, lane } as never),
			).rejects.toThrow(message);
		}
		const record = await client.request<ChannelRecord>({
			op: "create",
			project: at.project,
			lane: { name: "feature", path: assigned },
		});
		expect(record.lane).toEqual({ name: "feature", path: assigned, base: "refs/heads/main" });
		const info = await client.channel<ChannelInfo>(record.id, { op: "info" });
		expect(info.chats[0]).toMatchObject({ lane: "feature", cwd: assigned });
		await expect(
			client.request({ op: "create", project: at.project, lane: { name: "again", path: assigned } }),
		).rejects.toThrow("already started in");
	});
});

/** The Git variables a `post-commit` hook runs with after a commit in a linked worktree of another repository. */
async function hook(root: string): Promise<{ repo: string; tree: string; variables: Record<string, string> }> {
	const repo = join(root, "hook repo");
	const tree = join(root, "hook worktree");
	await mkdir(repo);
	await git(repo, "init", "-q", "-b", "main");
	await git(repo, "commit", "-q", "--allow-empty", "-m", "hook base");
	await git(repo, "worktree", "add", "-q", "-b", "wt", tree, "HEAD");
	const captured = join(root, "hook.env");
	const script = join(repo, ".git", "hooks", "post-commit");
	await writeFile(script, `#!/bin/sh\nenv | grep '^GIT_' > ${JSON.stringify(captured)}\n`);
	await chmod(script, 0o755);
	await git(tree, "commit", "-q", "--allow-empty", "-m", "in the hook's worktree");
	const variables = Object.fromEntries(
		(await readFile(captured, "utf8")).trim().split("\n").map((line) => {
			const at = line.indexOf("=");
			return [line.slice(0, at), line.slice(at + 1)];
		}).filter(([name]) => GIT_LOCAL.has(name!)),
	);
	expect(variables.GIT_DIR).toBe(join(repo, ".git", "worktrees", "hook-worktree"));
	expect(variables.GIT_INDEX_FILE).toBe(join(repo, ".git", "worktrees", "hook-worktree", "index"));
	return { repo, tree, variables };
}

describe("inherited Git state", () => {
	test("a host started from another repository's hook keeps every lane, tool, and terminal in the project", async () => {
		const at = await setup([
			{ tool: "bash", args: { command: "printf agent > agent-file && git add agent-file" }, id: "call-add" },
			{ tool: "lane", args: { action: "start", name: "feature" }, id: "call-lane" },
			{ text: "done" },
		]);
		const { repo, tree, variables } = await hook(at.root);
		const saved = Object.fromEntries(Object.keys(variables).map((name) => [name, process.env[name]]));
		Object.assign(process.env, variables);
		try {
			const started = await host(at, undefined, variables);
			const client = await connect(started);
			const plain = join(at.root, "plain folder");
			await mkdir(plain);
			await expect(
				client.request({ op: "create", project: at.project, lane: { name: "plain", path: plain } }),
			).rejects.toThrow("not a git repository");
			const record = await createLane(client, { op: "create", project: at.project });
			const lane = join(at.lanes, record.id, "work");
			expect(record.project).toBe(at.project);
			expect(await git(lane, "rev-parse", "--path-format=absolute", "--git-common-dir")).toBe(join(at.project, ".git"));
			expect(await git(repo, "branch", "--list", `${record.prefix}/*`)).toBe("");

			const events = await watch(client, record.id);
			await client.channel(record.id, { op: "ask", author: OWNER, text: "add a file, then start a lane" });
			await until(() => events.find((event) => event.kind === "reply" && event.text === "done"), "the reply");
			expect(events.find((event) => event.kind === "result" && event.call === "call-add")).toMatchObject({ error: false });
			expect(await git(lane, "status", "--porcelain")).toBe("A  agent-file");
			expect(await git(tree, "status", "--porcelain")).toBe("");
			const feature = join(at.lanes, record.id, "feature");
			expect(await git(feature, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`${record.prefix}/feature`);
			expect(await git(feature, "rev-parse", "--path-format=absolute", "--git-common-dir")).toBe(join(at.project, ".git"));
			expect(await git(repo, "branch", "--list", `${record.prefix}/*`)).toBe("");

			const opened = await client.request<TerminalOpened>({ op: "terminal", channel: record.id, cols: 100, rows: 30 });
			const output: TerminalFrame[] = [];
			client.terminal(opened.terminal, (frame) => output.push(frame));
			const text = () =>
				output.map((frame) => ("data" in frame ? Buffer.from(frame.data, "base64").toString() : "")).join("");
			await client.request({
				op: "terminal-input",
				terminal: opened.terminal,
				data: "echo \"index=[$GIT_INDEX_FILE] top=$(git rev-parse --show-toplevel)\"\n",
			});
			await until(() => text().includes(`index=[] top=${feature}`) || text().includes(`index=[] top=${lane}`), "the shell's Git");
			await client.request({ op: "terminal-close", terminal: opened.terminal });
		} finally {
			for (const [name, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});

	test("a host configuration drops every variable Git lists as repository-local", async () => {
		const at = await setup();
		const listed = (await git(at.project, "rev-parse", "--local-env-vars")).split("\n");
		expect([...GIT_LOCAL]).toEqual(expect.arrayContaining(listed));
		const parsed = configure({
			home: at.home,
			lanes: at.lanes,
			user: OWNER,
			port: 0,
			environment: { ...Object.fromEntries(listed.map((name) => [name, "inherited"])), HOME: "/home/owner", GIT_ASKPASS: "askpass" },
			worker: ["bun", "worker.ts"],
		});
		expect(parsed.environment).toEqual({ HOME: "/home/owner", GIT_ASKPASS: "askpass" });
	});
});

describe("retained lane names", () => {
	test("a deleted channel's name returns with new lane branches; its lanes and branches stay as they were", async () => {
		const at = await setup([
			{ tool: "lane", args: { action: "start", name: "feature" }, id: "call-lane" },
			{ text: "started" },
		]);
		const client = await connect(await host(at));
		const first = await createLane(client, { op: "create", project: at.project, name: "demo" });
		expect(first.prefix).toBe("demo");
		const kept = join(at.lanes, first.id, "work");
		await writeFile(join(kept, "committed.txt"), "committed\n");
		await git(kept, "add", "committed.txt");
		await git(kept, "commit", "-q", "-m", "work worth keeping");
		await writeFile(join(kept, "draft.txt"), "uncommitted\n");
		const old = join(at.lanes, first.id, "feature");
		await git(at.project, "worktree", "add", "-q", "-b", "demo/feature", old, "HEAD");
		const heads = await git(at.project, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads/demo/");
		await client.request({ op: "delete", channel: first.id });

		const second = await createLane(client, { op: "create", project: at.project, name: "demo" });
		expect(second).toMatchObject({ name: "demo", prefix: "demo-2" });
		const lane = join(at.lanes, second.id, "work");
		expect(await git(lane, "rev-parse", "--abbrev-ref", "HEAD")).toBe("demo-2/work");
		const events = await watch(client, second.id);
		await client.channel(second.id, { op: "ask", author: OWNER, text: "start the feature lane" });
		await until(() => events.find((event) => event.kind === "reply" && event.text === "started"), "the reply");
		expect(events.find((event) => event.kind === "result" && event.call === "call-lane")).toMatchObject({
			error: false,
			text: expect.stringContaining("on branch demo-2/feature"),
		});

		expect(await git(at.project, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads/demo/")).toBe(heads);
		expect(await git(kept, "status", "--porcelain")).toBe("?? draft.txt");
		expect(await readFile(join(kept, "draft.txt"), "utf8")).toBe("uncommitted\n");
		expect(await git(old, "rev-parse", "--abbrev-ref", "HEAD")).toBe("demo/feature");

		await client.request({ op: "delete", channel: second.id });
		const third = await createLane(client, { op: "create", project: at.project, name: "demo" });
		expect(third).toMatchObject({ name: "demo", prefix: "demo-3" });
	});

	test("a lane left by a create that never saved its channel doesn't block the name", async () => {
		const at = await setup();
		const client = await connect(await host(at));
		const orphan = join(at.lanes, "0123456789abcdef", "work");
		await git(at.project, "worktree", "add", "-q", "-b", "demo/work", orphan, "HEAD");
		const record = await createLane(client, { op: "create", project: at.project, name: "demo" });
		expect(record).toMatchObject({ name: "demo", prefix: "demo-2" });
		expect(await git(orphan, "rev-parse", "--abbrev-ref", "HEAD")).toBe("demo/work");
	});

	test("concurrent creates of one name admit one channel and leave no lane of the other behind", async () => {
		const at = await setup();
		const client = await connect(await host(at));
		for (const name of ["race-a", "race-b", "race-c"]) {
			const results = await Promise.allSettled([
				createLane(client, { op: "create", project: at.project, name }),
				createLane(client, { op: "create", project: at.project, name }),
			]);
			const created = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
			const refused = results.flatMap((result) => (result.status === "rejected" ? [String(result.reason)] : []));
			expect(created).toHaveLength(1);
			expect(refused).toEqual([expect.stringContaining("already exists")]);
			const branches = (await git(at.project, "for-each-ref", "--format=%(refname:short)", "refs/heads/")).split("\n");
			expect(branches.filter((branch) => branch.startsWith(name))).toEqual([`${created[0]!.prefix}/work`]);
		}
		const worktrees = (await git(at.project, "worktree", "list", "--porcelain")).split("\n").filter((line) =>
			line.startsWith("worktree ")
		);
		expect(worktrees).toHaveLength(4);
	});
});

describe("injected capabilities and other channels", () => {
	test("browser tools stay available to agents and refuse plainly when no dedicated browser runs", async () => {
		const at = await setup([{ tool: "browser_tabs", args: {}, id: "call-tabs" }, { text: "no browser" }]);
		const client = await connect(await host(at));
		const record = await createLane(client, { op: "create", project: at.project });
		const events = await watch(client, record.id);
		await client.channel(record.id, { op: "ask", author: OWNER, text: "look at the page" });
		await until(() => events.find((event) => event.kind === "reply"), "the reply");
		const result = events.find((event) => event.kind === "result" && event.call === "call-tabs");
		expect(result).toMatchObject({ error: true });
		expect((result as { text: string }).text).toContain("No dedicated development browser is running");
		expect((result as { text: string }).text).toContain(join(at.home, "browser"));
	});

	test("an agent's message reaches another channel on this host through its catalog", async () => {
		const at = await setup();
		const client = await connect(await host(at));
		const sender = await createLane(client, { op: "create", project: at.project });
		const receiver = await createLane(client, { op: "create", project: at.project });
		await writeFile(at.script, JSON.stringify([
			{ tool: "message", args: { channel: receiver.id, text: "please look", invoke: false }, id: "call-message" },
			{ text: "sent" },
		] satisfies Step[]));
		const sent = await watch(client, sender.id);
		await client.channel(sender.id, { op: "ask", author: OWNER, text: "tell the other channel" });
		await until(() => sent.find((event) => event.kind === "reply" && event.text === "sent"), "the sender's reply");
		expect(sent.find((event) => event.kind === "result" && event.call === "call-message")).toMatchObject({
			error: false,
			text: `Delivered to ${receiver.name}`,
		});
		const received = await watch(client, receiver.id);
		await until(() => received.find((event) => event.kind === "live"), "the receiver's replay");
		expect(received.filter((event) => event.kind === "message")).toEqual([
			expect.objectContaining({ author: `agent@${sender.prefix}`, text: "please look", invoked: false }),
		]);
	});

	test("kill aborts the channel's work, closes its terminals and ends its worker", async () => {
		const at = await setup([{ tool: "bash", args: { command: "sleep 30" }, id: "call-sleep" }]);
		const client = await connect(await host(at));
		const record = await createLane(client, { op: "create", project: at.project });
		const opened = await client.request<TerminalOpened>({ op: "terminal", channel: record.id, cols: 80, rows: 24 });
		const frames: TerminalFrame[] = [];
		client.terminal(opened.terminal, (frame) => frames.push(frame));
		const events = await watch(client, record.id);
		await client.channel(record.id, { op: "ask", author: OWNER, text: "wait" });
		await until(() => events.find((event) => event.kind === "tool" && event.call === "call-sleep"), "the shell call");
		await client.channel(record.id, { op: "kill", author: OWNER });
		await until(() => frames.find((frame) => "exit" in frame), "the terminal's exit");
		await until(
			() => client.channels.find((listing) => listing.id === record.id && listing.state === "dormant"),
			"the worker's exit",
		);
		const info = await client.channel<ChannelInfo>(record.id, { op: "info" });
		expect(info.chats.every((chat) => !chat.busy)).toBe(true);
		const replay = await watch(client, record.id);
		await until(() => replay.find((event) => event.kind === "live"), "the replay");
		expect(replay.find((event) => event.kind === "result" && event.call === "call-sleep")).toMatchObject({
			stopped: true,
		});
		expect(replay.find((event) => event.kind === "stopped")).toMatchObject({ author: OWNER });
	});
});

describe("terminal", () => {
	test("a person's shell runs in the chat's lane, survives its client, and replays output, never input", async () => {
		const at = await setup();
		const started = await host(at);
		const first = await connect(started);
		const record = await createLane(first, { op: "create", project: at.project });
		const lane = join(at.lanes, record.id, "work");
		const opened = await first.request<TerminalOpened>({
			op: "terminal",
			channel: record.id,
			cols: 100,
			rows: 30,
		});
		expect(opened.cwd).toBe(lane);
		const output: TerminalFrame[] = [];
		first.terminal(opened.terminal, (frame) => output.push(frame));
		const text = (frames: TerminalFrame[]) =>
			frames.map((frame) => ("data" in frame ? Buffer.from(frame.data, "base64").toString() : "")).join("");
		await first.request({
			op: "terminal-input",
			terminal: opened.terminal,
			data: "echo once >> effects.txt; echo marker-$((40+2))\n",
		});
		await until(() => text(output).includes("marker-42"), "the shell's output");
		first.close();
		const second = await connect(started);
		const replayed: TerminalFrame[] = [];
		second.terminal(opened.terminal, (frame) => replayed.push(frame));
		const reopened = await second.request<TerminalOpened>({
			op: "terminal",
			channel: record.id,
			terminal: opened.terminal,
			cols: 100,
			rows: 30,
		});
		expect(reopened.terminal).toBe(opened.terminal);
		await until(() => replayed.find((frame) => "replay" in frame && frame.replay), "the replay");
		expect(text(replayed)).toContain("marker-42");
		expect(await readFile(join(lane, "effects.txt"), "utf8")).toBe("once\n");
		await second.request({ op: "terminal-close", terminal: opened.terminal });
		await until(() => replayed.find((frame) => "exit" in frame), "the shell's exit");
	});
});

describe("review handoff", () => {
    test("planning discovery and persisted review links use current host state and refuse client association writes", async () => {
        const at = await setup();
        let admissions = 0;
        let currentUrl = "http://127.0.0.1:3100/";
        const started = await host(at, async () => { admissions++; return { reference: "records-cycle", url: currentUrl }; }, {}, {
            reviewLink: async () => currentUrl,
            planningConnections: () => ({ connections: [{ id: "linear", label: "linear" }], status: "configured", message: null }),
        });
        const client = await connect(started);
        expect(await client.request<PlanningConnections>({ op: "planning-connections" })).toEqual({ connections: [{ id: "linear", label: "linear" }], status: "configured", message: null });
        const record = await createLane(client, { op: "create", project: at.project });
        expect(await client.request<{reference: string; url: string} | null>({ op: "review-link", channel: record.id })).toBeNull();
        const lane = join(at.lanes, record.id, "work");
        await writeFile(join(lane, "change.txt"), "changed\n"); await git(lane, "add", "change.txt"); await git(lane, "commit", "-qm", "change");
        await client.request({ op: "review", channel: record.id });
        currentUrl = "http://127.0.0.1:3200/";
        expect(await client.request<{reference: string; url: string} | null>({ op: "review-link", channel: record.id })).toEqual({ reference: "records-cycle", url: currentUrl });
        expect(admissions).toBe(1);
        await expect(client.channel(record.id, { op: "planning-reviewed", chat: ROOT_CONVERSATION_ID, source: null, review: { reference: "fake", base: "a".repeat(40), head: "b".repeat(40) } })).rejects.toThrow("Only the host");
    });

	test("without Records connected, review is refused rather than reported", async () => {
		const at = await setup();
		const client = await connect(await host(at));
		const record = await createLane(client, { op: "create", project: at.project });
		await expect(client.request({ op: "review", channel: record.id })).rejects.toThrow(
			"Review handoff is not connected on this host",
		);
	});

	test("a lane's committed work is handed to Records; work only on disk is refused", async () => {
		const at = await setup();
		const handed: ReviewHandoff[] = [];
		const client = await connect(
			await host(at, async (handoff) => {
				handed.push(handoff);
				return { reference: "review-1", url: "http://127.0.0.1:3000/" };
			}),
		);
		const record = await createLane(client, { op: "create", project: at.project });
		const lane = join(at.lanes, record.id, "work");
		await expect(client.request({ op: "review", channel: record.id })).rejects.toThrow("no commits to review");
		await writeFile(join(lane, "change.txt"), "changed\n");
		await expect(client.request({ op: "review", channel: record.id })).rejects.toThrow(
			"1 uncommitted or untracked path",
		);
		await git(lane, "add", "change.txt");
		await git(lane, "commit", "-q", "-m", "change");
		const receipt = await client.request({ op: "review", channel: record.id });
		expect(receipt).toEqual({ reference: "review-1", url: "http://127.0.0.1:3000/" });
		expect(handed).toEqual([{
			origin: { kind: "channel", host: expect.any(String), channel: record.id, chat: ROOT_CONVERSATION_ID, lane: "work", items: [] },
			externalSources: [],
			channel: record.id,
			chat: ROOT_CONVERSATION_ID,
			project: at.project,
			cwd: lane,
			lane: "work",
			branch: `${record.prefix}/work`,
			against: "refs/heads/main",
			base: await git(at.project, "rev-parse", "main"),
			head: await git(lane, "rev-parse", "HEAD"),
		}]);
	});

	test("past the Diff's file cap, work only on disk still refuses the handoff", async () => {
		const at = await setup();
		const handed: ReviewHandoff[] = [];
		const client = await connect(
			await host(at, async (handoff) => {
				handed.push(handoff);
				return { reference: "review-1", url: "http://127.0.0.1:3000/" };
			}),
		);
		const record = await createLane(client, { op: "create", project: at.project });
		const lane = join(at.lanes, record.id, "work");
		await Promise.all(Array.from({ length: 501 }, (_, i) => writeFile(join(lane, `c${i}.txt`), `${i}\n`)));
		await git(lane, "add", ".");
		await git(lane, "commit", "-q", "-m", "many");
		// The 501 committed files fill the Diff's 500-entry list, which then shows neither of these.
		await writeFile(join(lane, "README.md"), "changed on disk only\n");
		await writeFile(join(lane, "loose.txt"), "untracked\n");
		await expect(client.request({ op: "review", channel: record.id })).rejects.toThrow(
			"Lane work has 2 uncommitted or untracked paths",
		);
		expect(handed).toEqual([]);
		await git(lane, "add", ".");
		await git(lane, "commit", "-q", "-m", "rest");
		const receipt = await client.request({ op: "review", channel: record.id });
		expect(receipt).toEqual({ reference: "review-1", url: "http://127.0.0.1:3000/" });
		expect(handed.map(({ base, head }) => ({ base, head }))).toEqual([{
			base: await git(at.project, "rev-parse", "main"),
			head: await git(lane, "rev-parse", "HEAD"),
		}]);
	});
});

describe("restart", () => {
	test("a host restart resumes the run, marks the interrupted shell, and never runs it twice", async () => {
		const marker = "effects.log";
		const at = await setup([
			{ tool: "bash", args: { command: `echo once >> ${marker}; sleep 30` }, id: "call-shell" },
			{ text: "checked" },
		]);
		const first = await host(at);
		const client = await connect(first);
		const record = await createLane(client, { op: "create", project: at.project });
		const lane = join(at.lanes, record.id, "work");
		await client.channel(record.id, { op: "ask", author: OWNER, text: "run it" });
		await until(async () => (await readFile(join(lane, marker), "utf8").catch(() => "")).includes("once"), "the effect");
		client.close();
		await first.close();
		hosts.splice(hosts.indexOf(first), 1);
		const second = await connect(await host(at));
		const events = await watch(second, record.id);
		await until(() => events.find((event) => event.kind === "reply" && event.text === "checked"), "the resumed reply");
		expect(events.find((event) => event.kind === "result" && event.call === "call-shell")).toMatchObject({
			interrupted: true,
		});
		expect(await readFile(join(lane, marker), "utf8")).toBe("once\n");
	});
});

describe("crash", () => {
	test.each([false, true])("a killed worker's next start marks the interrupted shell and never runs it twice, with stale listing %s", async (stale) => {
		const marker = "effects.log";
		const at = await setup([
			{ tool: "bash", args: { command: `echo $$ > shell.pid; echo once >> ${marker}; exec sleep 30` }, id: "call-shell" },
			{ text: "checked" },
		]);
		const client = await connect(await host(at));
		const record = await createLane(client, { op: "create", project: at.project });
		const lane = join(at.lanes, record.id, "work");
		let ended: string | undefined;
		await watch(client, record.id, undefined, (error) => { ended = error; });
		await client.channel(record.id, { op: "ask", author: OWNER, text: "run it" });
		await until(async () => (await readFile(join(lane, marker), "utf8").catch(() => "")).includes("once"), "the effect");
		const pid = Number(await readFile(join(at.home, "channels", record.id, "worker.pid"), "utf8"));
		expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
		// The catalog broadcast may lag behind the worker socket, including its initial dormant state.
		if (stale) client.channels = client.channels.map((listing) => ({ ...listing, state: "dormant" }));
		process.kill(pid, "SIGKILL");
		await until(() => ended, "the worker connection to close");
		expect(ended).toBe(CHANNEL_CLOSED);
		await client.request({ op: "release", channel: record.id });
		const after = await watch(client, record.id);
		await until(() => after.find((event) => event.kind === "reply" && event.text === "checked"), "the recovered reply");
		expect(after.find((event) => event.kind === "result" && event.call === "call-shell")).toMatchObject({
			interrupted: true,
		});
		expect(await readFile(join(lane, marker), "utf8")).toBe("once\n");
		// The crashed worker could not stop its shell, which still runs; pi only knows it may have.
		const shell = Number(await readFile(join(lane, "shell.pid"), "utf8"));
		expect(() => process.kill(shell, 0)).not.toThrow();
		process.kill(shell, "SIGKILL");
	});
});

describe("gateway boundary", () => {
	test("a validated host configuration replaces optional values from the previous host", async () => {
		const at = await setup();
		const required = {
			home: at.home,
			lanes: at.lanes,
			user: OWNER,
			port: 0,
			environment: {},
			worker: ["bun", "worker.ts"],
		};
		const previous = configure({
			...required,
			volume: at.root,
			projects: at.project,
			model: { provider: "faux", modelId: "coder" },
			thinkingLevel: "high",
		});
		const current = configure(required);
		expect(current).toBe(previous);
		expect(current).toEqual({
			channelScope: "local",
			home: at.home,
			lanes: at.lanes,
			user: OWNER,
			port: 0,
			environment: {},
			worker: ["bun", "worker.ts"],
			workerCloseTimeoutMs: 10_000,
		});
		expect(() => configure({ ...required, home: "relative" })).toThrow("absolute path");
		expect(current.home).toBe(at.home);
		expect(current.projects).toBeUndefined();
	});

	test("a host configuration is refused unless its directories exist, separately, by absolute path", async () => {
		const at = await setup();
		const valid = {
			home: at.home,
			lanes: at.lanes,
			user: OWNER,
			port: 0,
			environment: {},
			worker: ["bun", "worker.ts"],
		};
		expect(configure({ ...valid, home: `${at.root}/./state` }).home).toBe(at.home);
		const refused: [Record<string, unknown>, string][] = [
			[{ ...valid, home: "state" }, "must be an absolute path"],
			[{ ...valid, lanes: join(at.root, "missing") }, "does not exist"],
			[{ ...valid, lanes: join(at.home, "lanes") }, "does not exist"],
			[{ ...valid, user: "agent@other" }, "can't be an agent's author name"],
			[{ ...valid, worker: [] }, "→ at worker"],
			[{ ...valid, port: 70_000 }, "→ at port"],
			[{ ...valid, extra: true }, 'Unrecognized key: "extra"'],
		];
		for (const [value, message] of refused) expect(() => configure(value)).toThrow(message);
		await mkdir(join(at.home, "lanes"));
		expect(() => configure({ ...valid, lanes: join(at.home, "lanes") })).toThrow("must be separate");
	});

	test("only a loopback client with the token and no Origin reaches the gateway", async () => {
		const at = await setup();
		const started = await host(at);
		const base = `http://127.0.0.1:${started.port}`;
		expect((await fetch(`${base}/ws`)).status).toBe(401);
		expect((await fetch(`${base}/ws`, { headers: { authorization: "Bearer 00" } })).status).toBe(401);
		expect(
			(await fetch(`${base}/ws`, {
				headers: { authorization: `Bearer ${started.token}`, origin: "http://evil.invalid" },
			})).status,
		).toBe(403);
		expect((await fetch(`${base}/health`)).status).toBe(200);
	});

	test("malformed and escaping requests are refused with their id, and the host keeps serving", async () => {
		const at = await setup();
		const started = await host(at);
		const client = await connect(started);
		const record = await createLane(client, { op: "create", project: at.project });
		const socket = new WebSocket(started.url, ["ace", `ace-token.${started.token}`]);
		const replies = new Map<number, { ok: boolean; error?: string }>();
		socket.addEventListener("message", ({ data }) => {
			const frame = JSON.parse(String(data));
			if ("id" in frame && "ok" in frame) replies.set(frame.id, frame);
		});
		await until(() => socket.readyState === WebSocket.OPEN, "the raw socket");
		const sent: [Record<string, unknown> | string, string][] = [
			[{ id: 1, op: "nope" }, "Invalid input"],
			[{ id: 2, op: "channel", channel: "ffffffffffffffff", request: { op: "info" } }, "No reachable host"],
			[{ id: 3, op: "channel", channel: record.id, request: { op: "ask", text: "x", sudo: true } }, 'Unrecognized key: "sudo"'],
			[{ id: 4, op: "create", project: "project checkout" }, "doesn't exist"],
			[{ id: 5, op: "terminal", channel: record.id, cols: 0, rows: 10 }, "→ at cols"],
			[{ id: 6, op: "channel", channel: record.id, request: { op: "patch", file: "../../etc/passwd" } }, "Invalid path"],
			[{ id: 7, op: "project-open", path: "relative/path" }, "Enter a full folder path"],
			[{ id: 8, op: "channels", extra: 1 }, 'Unrecognized key: "extra"'],
		];
		for (const [frame] of sent) socket.send(typeof frame === "string" ? frame : JSON.stringify(frame));
		await until(() => replies.size === sent.length, "every refusal");
		for (const [frame, message] of sent) {
			if (typeof frame === "string") continue;
			const reply = replies.get(frame.id as number)!;
			expect(reply.ok).toBe(false);
			expect(reply.error).toContain(message);
		}
		socket.close();
		expect(await client.request<unknown>({ op: "hello" })).toMatchObject({ user: OWNER, host: expect.any(String) });
	});
});


describe("worker finalization", () => {
	test("the close hook can read raw pi state, and its failure reaches the host", async () => {
		const at = await setup([{ text: "done" }]);
		const started = await host(at, undefined, { NEUVE_TEST_CLOSE_FAIL: "1" });
		const client = await connect(started);
		const record = await createLane(client, { op: "create", project: at.project });
		const { submission } = await client.channel<{ submission: number }>(record.id, { op: "ask", author: OWNER, text: "hello" });
		await client.channel(record.id, { op: "wait", submission });
		const failed = await started.close().catch((error: unknown) => error);
		expect(failed).toBeInstanceOf(AggregateError);
		const messages = (error: unknown): string[] => error instanceof AggregateError ? [error.message, ...error.errors.flatMap(messages)] : error instanceof Error ? [error.message] : [];
		expect(messages(failed).join("\n")).toContain("Some channel workers did not close");
		expect(messages(failed).join("\n")).toContain("Synthetic capture export failure");
		const directory = join(at.home, "channels", record.id);
		expect(JSON.parse(await readFile(join(directory, "read-before-close.json"), "utf8"))).toEqual([ROOT_CONVERSATION_ID]);
		const outcome = JSON.parse(await readFile(join(directory, "worker-close.json"), "utf8"));
		expect(outcome).toMatchObject({ ok: false, errors: ["Synthetic capture export failure"] });
		expect((await readFile(join(directory, "channel.sqlite"))).byteLength).toBeGreaterThan(0);
	});
});


describe("native coding application continuity", () => {
	test("a fork owns a new pi store and retains lineage and item refs without inheriting review approval", async () => {
		const at = await setup();
		const started = await host(at);
		const client = await connect(started);
		const item = { provider: "github", repo: "githubnext/ace", kind: "pull-request", number: 711, url: "https://github.com/githubnext/ace/pull/711" } as const;
		const source = await createLane(client, { op: "create", project: at.project, items: [item] });
		await client.channel(source.id,{ op: "say", author: OWNER, text: "Source discussion remains in its own store." });
		const info = await client.channel<ChannelInfo>(source.id,{ op: "info" });
		const sourceChat = info.chats.find(chat => chat.parent === undefined)!;
		const native = await Connection.open(source.id);
		try { await native.request({ op: "planning-reviewed", chat: sourceChat.id, source: null, review: { reference: "existing-records-cycle", base: await git(at.project,"rev-parse","HEAD"), head: await git(at.project,"rev-parse","HEAD") } }); }
		finally { native.close(); }
		expect((await client.channel<PlanningState>(source.id,{op:"planning-state"})).review?.reference).toBe("existing-records-cycle");
		const fork = await client.request<ChannelRecord>({ op: "fork", channel: source.id });
		const forkInfo = await client.channel<ChannelInfo>(fork.id,{ op: "info" });
		const forkChat = forkInfo.chats.find(chat => chat.parent === undefined)!;
		expect(forkInfo.id === source.id).toBe(false);
		expect(forkChat.cwd === sourceChat.cwd).toBe(false);
		expect(await client.channel<GitHubExternalRef[]>(fork.id,{ op: "review-origin" })).toEqual([item]);
		expect(await client.channel<PlanningState>(fork.id,{ op: "planning-state" })).toEqual({ selection: null, review: null });
		await expect(client.channel(fork.id,{ op: "review-origin-set", items: [] })).rejects.toThrow("Only the host");
		const events = await watch(client,fork.id);
		await until(() => events.some(event => event.kind === "live"),"fork replay");
		expect(events.filter(event => event.kind === "message").map(event => event.text)).toEqual([expect.stringContaining(`channel ${source.id}`)]);
		await client.channel(fork.id, {op: "kill", author: OWNER});
		const read = async (id: string) => {
			const {openNodeSqliteStorage} = await import("@earendil-works/pi-durable/storage/sqlite/node");
			const {BACKGROUND_CONTEXT} = await import("@earendil-works/chord/context");
			const storage = await openNodeSqliteStorage(join(at.home, "channels", id, "channel.sqlite"));
			try {
				const page = await storage.scanDocuments({scope: {kind: "session"}, at: "current", kind: "neuve.review-context"}, 256, undefined, BACKGROUND_CONTEXT);
				return await Promise.all(page.items.map(async (record) => (await storage.document(record.id, "current", BACKGROUND_CONTEXT))!.value));
			} finally {await storage.close(BACKGROUND_CONTEXT);}
		};
		const documents = await read(fork.id);
		expect(documents).toEqual([{ chats: { [String(forkChat.id)]: [item] }, forkedFrom: { channel: source.id, chat: sourceChat.id } }]);
		const contexts = await Promise.all([source.id,fork.id].map(id => readFile(join(at.home,"channels",id,"models-context.json"),"utf8").then(JSON.parse)));
		expect(contexts[0].sessionId === contexts[1].sessionId).toBe(false);
		expect(contexts.map(value => value.stateDirectory)).toEqual([join(at.home,"channels",source.id),join(at.home,"channels",fork.id)]);
	});
});


describe("Records item review history", () => {
	test("item and channel selectors use the opened project's Records callback and retain exact receipts", async () => {
		const at = await setup();
		await git(at.project,"remote","add","origin","https://github.com/githubnext/ace.git");
		const item: GitHubExternalRef = { provider: "github", repo: "githubnext/ace", kind: "pull-request", number: 711, url: "https://github.com/githubnext/ace/pull/711" };
		const queries: import("../src/protocol").ReviewHistoryQuery[] = [];
		const receipt = { reference: "01KITEMHISTORY", url: "http://127.0.0.1:3000/?cycle=01KITEMHISTORY", base: await git(at.project,"rev-parse","HEAD"), head: await git(at.project,"rev-parse","HEAD"), association: "association-1" };
		const client = await connect(await host(at, undefined, {}, { reviewHistory: async query => { queries.push(query); return [receipt]; } }));
		await client.request({op:"project-open",path:at.project});
		expect(await client.request<import("../src/protocol").ReviewReceipt[]>({op:"reviews",project:at.project,item})).toEqual([receipt]);
		const channel = await client.request<ChannelRecord>({op:"create",project:at.project});
		expect(await client.request<import("../src/protocol").ReviewReceipt[]>({op:"reviews",channel:channel.id,chat:1})).toEqual([receipt]);
		expect(queries).toEqual([{project:at.project,item},{project:at.project,channel:channel.id,chat:1}]);
	});
	test("a retained fork PR association remains readable without fetching its base repository", async () => {
		const at = await setup();
		await git(at.project,"remote","add","origin","https://github.com/example/fork.git");
		const item: GitHubExternalRef = { provider: "github", repo: "githubnext/ace", kind: "pull-request", number: 711, url: "https://github.com/githubnext/ace/pull/711" };
		const receipt = { reference: "01KFORKHISTORY", url: "http://127.0.0.1:3000/?cycle=01KFORKHISTORY" };
		const client = await connect(await host(at,undefined,{}, { reviewHistory: async query => query.item?.number === 711 ? [receipt] : [] }));
		await client.request({op:"project-open",path:at.project});
		expect(await client.request<import("../src/protocol").ReviewReceipt[]>({op:"reviews",project:at.project,item})).toEqual([receipt]);
		await expect(client.request({op:"reviews",project:at.project,item:{...item,number:712,url:"https://github.com/githubnext/ace/pull/712"}})).rejects.toThrow("does not match");
	});
	test("history refuses unopened projects and does not call Records for them", async () => {
		const at=await setup();
		const item: GitHubExternalRef = { provider:"github",repo:"githubnext/ace",kind:"issue",number:1,url:"https://github.com/githubnext/ace/issues/1" };
		let reads=0;
		const client=await connect(await host(at,undefined,{}, {reviewHistory:async()=>{reads++;return [];}}));
		await expect(client.request({op:"reviews",project:at.project,item})).rejects.toThrow("Open this project");
		expect(reads).toBe(0);
		await client.request({op:"project-open",path:at.project});
		await git(at.project,"remote","add","origin","https://github.com/githubnext/ace.git");
		expect(await client.request<import("../src/protocol").ReviewReceipt[]>({op:"reviews",project:at.project,item})).toEqual([]);
		expect(reads).toBe(1);
	});
});



test("a linked-worktree channel admits its pinned review even when display lookup is unavailable", async () => {
	const at = await setup();
	const base = await git(at.project, "rev-parse", "HEAD");
	const linked = join(at.root, "linked feature");
	await git(at.project, "worktree", "add", "-qb", "feature", linked, "main");
	await writeFile(join(linked, "README.md"), "linked feature\n");
	await git(linked, "commit", "-qam", "feature");
	const head = await git(linked, "rev-parse", "HEAD");
	const frozen = defaultConfig();
	if (frozen.route.provider !== "anthropic") throw new Error("Unexpected fixture route");
	frozen.route.credentialVariable = "NEUVE_FIXTURE_MISSING_REVIEW_KEY";
	const callbacks = nativeReviewCallbacks(async (_project, cycle) => `http://127.0.0.1:4040/?cycle=${cycle}`, async project => project, async () => {});
	const started = await host(at, undefined, {}, { ...callbacks, async reviewPrepare() { return { requestId: mintUlid(), config: frozen }; } });
	const client = await connect(started);
	// CLI creation stores the linked checkout itself, rather than the normalized dashboard project.
	const record = await catalog.create(linked, undefined, "linked");
	const snapshot = { chat: ROOT_CONVERSATION_ID, lane: null, planning: { selection: null, review: null }, items: [] };
	const admissions = [];
	for (const name of ["project checkout", "linked feature"]) {
		if (name === "linked feature") await writeFile(join(at.home, "projects.json"), "{}");
		const prepared = await client.request<import("../src/review-protocol").PreparedReview>({ op: "review-prepare", channel: record.id, target: { kind: "project-branch" }, snapshot });
		expect(prepared.handoff).toMatchObject({ project: linked, cwd: linked, base, head, origin: { display: { project: name, branch: "feature", base: "refs/heads/main" } } });
		const admitted = await client.request<import("../src/review-protocol").NativeReviewResult>({ op: "review-submit", channel: record.id, prepared });
		expect(admitted).toMatchObject({ kind: "review", state: "queued", base, head, admission: { branch: "feature", commits: 1 } });
		const saved = Option.getOrThrow(await execute(withStore(linked, "read", Log.get(prepared.requestId)))).event;
		expect(saved).toMatchObject({ kind: "review.requested@1", attribution: { range: { baseOid: base, headOid: head } } });
		admissions.push({ name, handoff: prepared.handoff, result: admitted });
	}
	const evidence = process.env.NEUVE_REVIEW_FEED_EVIDENCE;
	if (evidence) { await mkdir(evidence, { recursive: true }); await writeFile(join(evidence, "linked-worktree-admissions.json"), JSON.stringify(admissions, null, 2)); }
}, 30000);

test("expected lane and pull acquisition refusals remain info outcomes through the gateway", async () => {
	const at = await setup();
	const base = await git(at.project, "rev-parse", "HEAD");
	let source = { ...parseDescriptor(pullFixture, "githubnext/ace"), baseOid: base, headOid: base };
	const started = await host(at, async () => ({ reference: "review", url: "http://127.0.0.1:4040/" }), {}, {
		async reviewPrepare() { await acquirePull(at.project, source); return { requestId: mintUlid(), config: {} }; },
	});
	const client = await connect(started);
	const record = await createLane(client, { op: "create", project: at.project });
	const lane = join(at.lanes, record.id, "work");
	await expect(client.request({ op: "review", channel: record.id })).rejects.toThrow("has no commits to review");
	await git(lane, "commit", "--allow-empty", "-qm", "lane work");
	// Move real Git only after the worker has returned its real Changes snapshot.
	const original = Connection.prototype.request;
	let moved = false;
	const intercepted = spyOn(Connection.prototype, "request").mockImplementation(async function<T>(this: Connection, ...args: Parameters<Connection["request"]>): Promise<T> {
		const result = await (original<T>).apply(this, args);
		if (args[0].op === "changes" && !moved) { moved = true; await git(lane, "commit", "--allow-empty", "-qm", "moved during handoff"); }
		return result;
	});
	try { await expect(client.request({ op: "review", channel: record.id })).rejects.toThrow("moved while its review was prepared"); }
	finally { intercepted.mockRestore(); }
	expect(moved).toBe(true);
	await git(at.project, "checkout", "-qb", "feature");
	await writeFile(join(at.project, "README.md"), "feature\n");
	await git(at.project, "commit", "-qam", "feature");
	const head = await git(at.project, "rev-parse", "HEAD");
	await git(at.project, "remote", "add", "origin", "https://github.com/githubnext/ace.git");
	const request = { op: "review-prepare" as const, channel: record.id, target: { kind: "project-branch" as const }, snapshot: { chat: ROOT_CONVERSATION_ID, lane: null, planning: { selection: null, review: null }, items: [] } };
	source = { ...source, baseRepo: "another/repository", headRepo: "another/fork", headOid: head };
	await expect(client.request(request)).rejects.toThrow("does not match this pull request");
	source = { ...source, baseRepo: "githubnext/ace", headRepo: "" };
	await expect(client.request(request)).rejects.toThrow("missing its immutable source identity");
	const unrelated = await git(at.project, "commit-tree", await git(at.project, "rev-parse", "HEAD^{tree}"), "-m", "unrelated");
	source = { ...source, headRepo: "githubnext/ace", headOid: unrelated };
	await expect(client.request(request)).rejects.toThrow("do not have an available merge base");
	await git(at.project, "config", `url.${join(at.root, "missing-remote")}/.insteadOf`, "https://github.com/");
	const realGit = Bun.which("git");
	if (!realGit) throw new Error("Missing fixture Git");
	const tools = join(at.root, "tools"); await mkdir(tools);
	await writeFile(join(tools, "git"), '#!/bin/sh\nif [ "$3" = fetch ]; then\n  echo "Fixture refused network acquisition" >&2\n  exit 1\nfi\nexec "$NEUVE_TEST_REAL_GIT" "$@"\n', { mode: 0o755 });
	const oldPath = process.env.PATH, oldGit = process.env.NEUVE_TEST_REAL_GIT;
	process.env.PATH = `${tools}:${oldPath ?? ""}`; process.env.NEUVE_TEST_REAL_GIT = realGit;
	try {
		source = { ...source, headOid: "f".repeat(40) };
		await expect(client.request(request)).rejects.toThrow("Fixture refused network acquisition");
	} finally {
		if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
		if (oldGit === undefined) delete process.env.NEUVE_TEST_REAL_GIT; else process.env.NEUVE_TEST_REAL_GIT = oldGit;
	}
	const outcomes = (await readFile(join(at.home, "logs", "host.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line)).filter(row => ["review", "review-prepare"].includes(row.op) && ["gateway.refused", "gateway.failed"].includes(row.event));
	expect(outcomes.map(row => ({ event: row.event, level: row.level, reason: row.reason }))).toEqual([
		{ event: "gateway.refused", level: "info", reason: "nothing_to_review" },
		{ event: "gateway.refused", level: "info", reason: "source_moved" },
		...Array.from({ length: 4 }, () => ({ event: "gateway.refused", level: "info", reason: "pull_request_unavailable" })),
	]);
	const evidence = process.env.NEUVE_REVIEW_FEED_EVIDENCE;
	if (evidence) { await mkdir(evidence, { recursive: true }); await writeFile(join(evidence, "review-fix-refusals.json"), JSON.stringify(outcomes, null, 2)); }
}, 30000);

test("native tool uses authenticated gateway while active, defaults to project branch and refuses dirty, empty and injected targets", async () => {
	const at = await setup([
		{ tool: "neuve_review_branch", args: {}, id: "native-review" },
		{ text: "Review queued" },
	]);
	await git(at.project, "remote", "add", "origin", join(at.root, "limits-origin"));
	const base = await git(at.project, "rev-parse", "HEAD");
	await git(at.project, "checkout", "-qb", "feature");
	await writeFile(join(at.project, "README.md"), "committed feature\n");
	await git(at.project, "commit", "-qam", "Feature");
	const head = await git(at.project, "rev-parse", "HEAD");
	let calls = 0;
	let failPreparation = false;
	let prepared:
		PreparedReview | undefined;
	const requestId = "01JB0000000000000000000000";
	const started = await host(
		at,
		undefined,
		{},
		{
			async reviewLookup() {
				return { outcome: "refused", reason: "not_found", detail: "Fixture review not found", fix: "Check the review handle" };
			},
			async reviewPrepare() {
				if (failPreparation) throw new Error("fixture storage failed");
				return { requestId, config: {} };
			},
			async reviewSubmit(value, validate) {
				calls++;
				await validate(true);
				prepared = value;
				return {
					kind: "review",
					request: requestId,
					reference: requestId,
					run: requestId,
					job: 1,
					base,
					head,
					url: `http://127.0.0.1:4040/?cycle=${requestId}`,
					state: "queued",
					queue: "waiting",
					admission: { recovered: false, commits: 1, branch: "feature", notify: false },
					recorded: {
						receipt: null,
						packet: null,
						complete: false,
						gaps: 0,
						undecoded: 0,
						units: 0,
						message: "No terminal run receipt",
					},
				};
			},
		},
	);
	const client = await connect(started);
	const record = await createLane(client, {
		op: "create",
		project: at.project,
	});
	const lane = join(at.lanes, record.id, "work");
	expect(await git(lane, "rev-parse", "HEAD")).toBe(head);
	const events = await watch(client, record.id);
	await client.channel(record.id, {
		op: "ask",
		author: OWNER,
		text: "Review the current branch",
	});
	await until(
		() => events.find((e) => e.kind === "reply" && e.text === "Review queued"),
		"native review reply without scheduler deadlock",
	);
	const toolResult = events.find(
		(e) => e.kind === "result" && e.call === "native-review",
	);
	expect(toolResult).toMatchObject({ error: false });
	expect(JSON.stringify(toolResult)).toContain(head);
	expect(JSON.stringify(events)).not.toContain(started.token);
	expect(calls).toBe(1);
	expect(prepared).toMatchObject({
		target: { kind: "project-branch" },
		handoff: {
			project: at.project,
			cwd: at.project,
			base,
			head,
			channel: record.id,
			origin: { kind: "channel", channel: record.id, display: { project: "project checkout", branch: "feature", base: "refs/heads/main" } },
		},
	});
	expect(prepared?.handoff.lane).toBeUndefined();
	const snapshot = {
		chat: 0,
		lane: { name: "work", path: lane, base: head },
		planning: { selection: null, review: null },
		items: [],
	};
	await expect(
		client.request({
			op: "review-prepare",
			channel: record.id,
			target: { kind: "lane" },
			snapshot,
		}),
	).rejects.toThrow("no commits");
	await writeFile(join(at.project, "untracked"), "dirty");
	await expect(
		client.request({
			op: "review-prepare",
			channel: record.id,
			target: { kind: "project-branch" },
			snapshot,
		}),
	).rejects.toThrow("has 1 uncommitted or untracked path; commit or remove it before review");
	await writeFile(join(at.project, "another-untracked"), "dirty");
	await expect(client.request({ op: "review-prepare", channel: record.id, target: { kind: "project-branch" }, snapshot })).rejects.toThrow("has 2 uncommitted or untracked paths; commit or remove them before review");
	await rm(join(at.project, "another-untracked"));
	await rm(join(at.project, "untracked"));
	await expect(
		client.request({
			op: "review-prepare",
			channel: record.id,
			target: { kind: "project-branch", against: "--output=/tmp/injected" },
			snapshot,
		}),
	).rejects.toThrow("unavailable");
	await expect(
		client.request({
			op: "review-prepare",
			channel: record.id,
			target: { kind: "lane" },
			snapshot: { ...snapshot, lane: { ...snapshot.lane, path: at.project } },
		}),
	).rejects.toThrow("does not belong");
	failPreparation = true;
	await expect(client.request({ op: "review-prepare", channel: record.id, target: { kind: "project-branch" }, snapshot })).rejects.toThrow("fixture storage failed");
	failPreparation = false;
	expect(await client.request({ op: "review-status", channel: record.id, query: { chat: 0 } })).toMatchObject({ outcome: "refused", reason: "not_found" });
	const logs = (await readFile(join(at.home, "logs", "host.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
	expect(logs.filter(row => row.op === "review-prepare" && row.event === "gateway.refused" && row.reason === "uncommitted_changes")).toEqual([
		expect.objectContaining({ level: "info", message: "The review source has 1 uncommitted or untracked path; commit or remove it before review" }),
		expect.objectContaining({ level: "info", message: "The review source has 2 uncommitted or untracked paths; commit or remove them before review" }),
	]);
	expect(logs.filter(row => row.op === "review-status" && row.event === "gateway.refused")).toEqual([
		expect.objectContaining({ level: "info", reason: "not_found", message: "Fixture review not found" }),
	]);
	expect(logs.filter(row => row.op === "review-prepare" && row.event === "gateway.failed")).toEqual([
		expect.objectContaining({ level: "warn", error: "The lane path does not belong to this channel" }),
		expect.objectContaining({ level: "warn", error: "fixture storage failed" }),
	]);
	const evidence = process.env.NEUVE_REVIEW_FEED_EVIDENCE;
	if (evidence) {
		await mkdir(evidence, { recursive: true });
		await writeFile(join(evidence, "native-admission.json"), JSON.stringify({ base, head, display: prepared?.handoff.origin.display }, null, 2));
		await writeFile(join(evidence, "gateway-outcomes.json"), JSON.stringify(logs.filter(row => ["gateway.refused", "gateway.failed"].includes(row.event)).map(({ event, level, op, reason, message, error }) => ({ event, level, op, reason, message, error })), null, 2));
	}
	await git(at.project, "branch", "-m", "main", "old-default");
	await expect(
		client.request({
			op: "review-prepare",
			channel: record.id,
			target: { kind: "project-branch" },
			snapshot,
		}),
	).rejects.toThrow("Supply target.against");
	expect(calls).toBe(1);
}, 30000);

test("a killed native call reopens with the same prepared request before receiving its lost reply", async () => {
	const at = await setup([
		{ tool: "neuve_review_branch", args: {}, id: "native-crash" },
		{ text: "Recovered review" },
	]);
	const base = await git(at.project, "rev-parse", "HEAD");
	await git(at.project, "checkout", "-qb", "feature");
	await writeFile(join(at.project, "README.md"), "feature\n");
	await git(at.project, "commit", "-qam", "feature");
	const head = await git(at.project, "rev-parse", "HEAD");
	const id = "01JB0000000000000000000001";
	const intents: PreparedReview[] = [];
	let preparations = 0;
	let release: (() => void) | undefined;
	const lost = new Promise<void>((resolve) => {
		release = resolve;
	});
	const accepted = {
		kind: "review" as const,
		request: id,
		reference: id,
		run: id,
		job: 1,
		base,
		head,
		url: `http://127.0.0.1:4040/?cycle=${id}`,
		state: "queued" as const,
		queue: "waiting" as const,
		admission: { recovered: true, commits: 1, branch: "feature", notify: false },
		recorded: {
			receipt: null,
			packet: null,
			complete: false,
			gaps: 0,
			undecoded: 0,
			units: 0,
			message: "Recorded admission",
		},
	};
	const client = await connect(
		await host(
			at,
			undefined,
			{},
			{
				async reviewPrepare() {
					preparations++;
					return { requestId: id, config: {} };
				},
				async reviewSubmit(value) {
					intents.push(value);
					if (intents.length === 1) await lost;
					return accepted;
				},
			},
		),
	);
	const record = await createLane(client, {
		op: "create",
		project: at.project,
	});
	const events = await watch(client, record.id);
	await client.channel(record.id, {
		op: "ask",
		author: OWNER,
		text: "Review this branch",
	});
	await until(() => intents.length === 1, "first native admission");
	const pid = Number(
		await readFile(join(at.home, "channels", record.id, "worker.pid"), "utf8"),
	);
	process.kill(pid, "SIGKILL");
	await until(async () => {
		try {
			process.kill(pid, 0);
			return false;
		} catch {
			return true;
		}
	}, "killed native worker");
	release?.();
	await client.channel(record.id, { op: "info" });
	const recovered = await watch(client, record.id);
	await until(
		() =>
			recovered.find(
				(e) => e.kind === "reply" && e.text === "Recovered review",
			),
		"recovered native tool reply",
	);
	expect(preparations).toBe(1);
	expect(intents).toHaveLength(2);
	expect(intents[1]).toEqual(intents[0]);
	expect(JSON.stringify([...events, ...recovered])).not.toContain(
		"ace-token.",
	);
}, 30000);

for (const terminal of ["stopped", "finished"] as const) for (const notify of [false, true]) test(`Records events reach the real worker ${terminal} card and wake exactly when notify=${notify}`, async () => {
	// afterEach runs even on Bun test timeouts; only reaching the end marks this case successful.
	listingCase = { name: `${terminal}, notify=${notify}`, passed: false };
	const at = await setup([
		{ tool: "neuve_review_branch", args: { notify }, id: "live-review" },
		{ text: "Review queued" },
		{ text: "Look at the review card" },
	]);
	const base = await git(at.project, "rev-parse", "HEAD");
	await git(at.project, "checkout", "-qb", "feature");
	await writeFile(join(at.project, "README.md"), "feature\n"); await git(at.project, "commit", "-qam", "feature");
	const head = await git(at.project, "rev-parse", "HEAD");
	const frozen = defaultConfig();
	if (frozen.route.provider !== "anthropic") throw new Error("Unexpected fixture route");
	frozen.route.credentialVariable = "NEUVE_FIXTURE_MISSING_REVIEW_KEY";
	const callbacks = nativeReviewCallbacks(async (_project, cycle) => `http://127.0.0.1:4040/?cycle=${cycle}`, async project => project);
	let accepted: Extract<import("../src/review-protocol").NativeReviewResult, { kind: "review" }> | undefined;
	const retireCase = terminal === "finished" && !notify;
	const retirement = join(at.root, "retire-now");
	const started = await host(at, undefined, retireCase ? { NEUVE_TEST_RETIRE_NOW: retirement } : {}, {
		...callbacks,
		async reviewPrepare() { return { requestId: mintUlid(), config: frozen }; },
		async reviewSubmit(prepared, validate) {
			const result = await callbacks.reviewSubmit(prepared, validate);
			if (result.kind === "review") accepted = result;
			return result;
		},
	});
	const client = await connect(started);
	const record = await client.request<ChannelRecord>({ op: "create", project: at.project });
	const events = await watch(client, record.id);
	await client.channel(record.id, { op: "ask", author: OWNER, text: "Review feature, and tell me when it finishes only if requested" });
	await until(() => events.some(event => event.kind === "reply" && event.text === "Review queued"), "the admitted tool reply");
	const ordinaryRun = await until(() => client.channels.find(value => value.id === record.id)?.ran, "the ordinary run's pulse");
	expect(ordinaryRun).toMatchObject({ author: OWNER, outcome: "done" });
	expect(ordinaryRun.system).toBeUndefined();
	if (!accepted) throw new Error("No Records admission");
	const admission = accepted;
	const card = () => events.filter((event): event is Extract<Event, { kind: "review-cards" }> => event.kind === "review-cards").at(-1)?.cards["live-review"];
	await until(() => { const value = card(); return value?.kind === "review" && value.links !== null; }, "the Records-backed card");
	expect(card()).toMatchObject({ review: admission.request, phase: "queued", notify, range: { base, head, commits: 1, branch: "feature" } });
	const pinned = JSON.parse(await readFile(join(at.home, "channels", record.id, "review-admissions", `${admission.request}.json`), "utf8"));
	expect(pinned).toMatchObject({ review: admission.request, notify, branch: "feature", head });
	const request = Option.getOrThrow(await execute(withStore(at.project, "read", Log.get(admission.request)))).event;
	if (request.kind !== "review.requested@1") throw new Error("Missing Records request");
	const payload = receipt(request.payload.runKey, 0); payload.jobSeq = admission.job;
	const records: unknown[] = [];
	if (terminal === "finished") {
		const blob = await execute(withStore(at.project, "write", location => Effect.gen(function* () {
			const store = yield* Blobs.BlobStore;
			return yield* store.put({ bytes: new TextEncoder().encode("{}"), mediaType: "application/json", retention: "durable" });
		}).pipe(Effect.provide(Blobs.layer(location)))));
		records.push({ id: mintUlid(), kind: "packet.published@1", idempotencyKey: `feed-packet:${admission.run}`, actor: request.actor,
			occurredAt: new Date().toISOString(), attribution: { ...request.attribution, runId: admission.run },
			payload: { complete: false, counts: { batches: 0, units: 0, contextReferences: 0, assessments: 0, deliveries: 0, dispositions: 0, comments: 0, gaps: 0 } },
			refs: [{ ref: `blob:${blob.blob.hash}`, role: "manifest" }] });
	}
	records.push({ id: mintUlid(), kind: "run.completed@1", idempotencyKey: `feed-terminal:${admission.run}`,
		actor: request.actor, occurredAt: new Date().toISOString(), attribution: { ...request.attribution, runId: admission.run },
		payload: terminal === "finished" ? { ...payload, gaps: [] } : { ...payload, outcome: "timed-out", timeout: { ...payload.timeout, reached: true, disclosed: [{ stage: "investigate", status: "interrupted", note: "Recorded review deadline" }] } } });
	await execute(withStore(at.project, "write", Log.append(records.map(value => RecordEvent.parse(value)))));
	await until(() => { const value = card(); return value?.kind === "review" && value.phase === terminal; }, `the ${terminal} card without agent polling`);
	expect(card()).toMatchObject(terminal === "stopped" ? { stopped: { reason: "investigate: Recorded review deadline" } } : {
		finished: { units: 0, byReviewLane: { humanRequired: 0, humanSuggested: 0, agentic: 0, static: 0 }, needJudgment: 0, complete: false, gaps: 0, undecoded: 1 } });
	if (notify) await until(() => events.some(event => event.kind === "reply" && event.text === "Look at the review card"), "one requested notification");
	else await Bun.sleep(500);
	const notices = events.filter(event => event.kind === "message" && event.system);
	expect(notices).toHaveLength(notify ? 1 : 0);
	if (notify) expect(notices[0]).toMatchObject({ kind: "message", invoked: true,
		system: { kind: "neuve:review:terminal", review: admission.request } });
	const ran = await until(() => {
		const value = client.channels.find(value => value.id === record.id)?.ran;
		return value?.outcome === "done" && (!notify || value.system?.review === admission.request) ? value : undefined;
	}, "the completed run's review-wake marker");
	expect(ran).toMatchObject({ author: notify ? "unknown" : OWNER, outcome: "done" });
	expect(ran.system).toEqual(notify ? { kind: "neuve:review:terminal", review: admission.request } : undefined);
	expect(Number(await readFile(`${at.script}.cursor`, "utf8"))).toBe(notify ? 3 : 2);
	const info = await client.channel<ChannelInfo>(record.id, { op: "info" });
	const chat = info.chats.find(value => value.parent === undefined)!.id;
	expect(await client.request({ op: "review-status", channel: record.id, query: { chat } })).toMatchObject({ review: admission.request, state: terminal, new_commits: false });
	expect(await client.request({ op: "review-outcome", channel: record.id, query: { review: admission.request, chat } })).toEqual(terminal === "stopped" ? { outcome: "not_finished", state: "stopped" } : { review: admission.request, complete: false, units: 0, gaps: 0, undecoded: 1 });
	await writeFile(join(at.project, "README.md"), "next commit\n"); await git(at.project, "commit", "-qam", "next");
	const next = await git(at.project, "rev-parse", "HEAD");
	await until(() => events.some(event => event.kind === "neuve:review:new-commits" && event.head === next), "one durable commit row over the gateway");
	expect(card()).toMatchObject({ newCommits: { head: next } });
	expect(await client.request({ op: "review-status", channel: record.id, query: { review: admission.request, chat } })).toMatchObject({ new_commits: true });
	const pid = Number(await readFile(join(at.home, "channels", record.id, "worker.pid"), "utf8"));
	if (retireCase) {
		client.close();
		await Bun.sleep(100);
		await writeFile(retirement, "retire");
	} else process.kill(pid, "SIGTERM");
	await until(async () => { try { process.kill(pid, 0); return false; } catch { return true; } }, retireCase ? "the terminal worker retiring without a signal" : "the worker's joined close");
	let afterRetirement: string | undefined;
	if (retireCase) {
		const log = await readFile(join(at.home, "logs", `channel-${record.id}.jsonl`), "utf8");
		expect(log.split("\n").filter(Boolean).map(line => JSON.parse(line)).some(value => value.event === "worker.exit" && value.reason === "idle")).toBe(true);
		await rm(retirement);
		await writeFile(join(at.project, "README.md"), "after retirement\n"); await git(at.project, "commit", "-qam", "after retirement");
		afterRetirement = await git(at.project, "rev-parse", "HEAD");
	}
	const replayClient = await connect(started);
	const replay = await watch(replayClient, record.id);
	const replayedRun = await until(() => replayClient.channels.find(value => value.id === record.id)?.ran, "the persisted run marker on reconnect");
	expect(replayedRun).toEqual(ran);
	if (afterRetirement) await until(() => replay.some(event => {
		const card = event.kind === "review-cards" ? event.cards["live-review"] : undefined;
		return card?.kind === "review" && card.newCommits?.head === afterRetirement;
	}), "new commits catching up on the next worker open");
	await until(() => replay.some(event => event.kind === "review-cards" && event.cards["live-review"]?.kind === "review"), "the card after worker restart");
	await Bun.sleep(500);
	expect(Number(await readFile(`${at.script}.cursor`, "utf8"))).toBe(notify ? 3 : 2);
	expect(replay.filter(event => event.kind === "neuve:review:new-commits")).toHaveLength(1);
	expect(replay.filter(event => event.kind === "message" && event.system)).toEqual(notices);
	expect(events.filter(event => event.kind === "result" && event.call === "live-review")).toHaveLength(1);
	expect(events.filter(event => event.kind === "tool").map(event => event.name)).toEqual(["neuve_review_branch"]);
	const log = (await readFile(join(at.home, "logs", `channel-${record.id}.jsonl`), "utf8")).trim().split("\n")
		.map(line => JSON.parse(line)).filter(value => ["review.card.updated", "review.notify.delivered", "review.feed.state", "worker.exit"].includes(value.event));
	expect(log.filter(value => value.event === "review.notify.delivered")).toHaveLength(notify ? 1 : 0);
	const evidence = process.env.NEUVE_REVIEW_FEED_EVIDENCE;
	if (evidence) {
		await mkdir(evidence, { recursive: true });
		await writeFile(join(evidence, `${terminal}-${notify}.run.json`), JSON.stringify({ ran, replayedRun }, null, 2));
		await writeFile(join(evidence, `${terminal}-${notify}.logs.json`), JSON.stringify(log, null, 2));
		await writeFile(join(evidence, `${terminal}-${notify}.events.json`), JSON.stringify(events.filter(event => event.kind === "review-cards" || event.kind === "neuve:review:new-commits" || (event.kind === "message" && event.system)), null, 2));
	}
	listingCase.passed = true;
}, 40000);


test("a surviving native adapter reconnects after the host changes port", async () => {
	const at = await setup();
	const review = "01JB0000000000000000000099";
	const first = await host(at, undefined, {}, {
		async reviewLookup() { return { review, state: "queued", new_commits: false }; },
	});
	const client = await connect(first);
	const record = await client.request<ChannelRecord>({ op: "create", project: at.project });
	const adapter = nativeReview(record.id);
	try {
		expect(await adapter.review.status({ review, chat: 0 }, BACKGROUND_CONTEXT)).toMatchObject({ review, state: "queued" });
		await first.close();
		const next = await host(at, undefined, {}, {
			async reviewLookup() { return { review, state: "running", stage: { done: 0, of: 1, name: "investigate" }, new_commits: false }; },
		});
		expect(next.port).not.toBe(first.port);
		expect(await adapter.review.status({ review, chat: 0 }, BACKGROUND_CONTEXT)).toMatchObject({ review, state: "running" });
	} finally { adapter.close(); }
}, 30000);
