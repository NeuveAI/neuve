import "./fixtures/memory-secrets";
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Channel } from "@ace/channel";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { git } from "../../../packages/channel/tests/helpers";
import { config } from "../src/host-config";
import { openChannel, openWorkerStorage } from "../src/worker-runtime";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const place = () => {
	const root = mkdtempSync(join(tmpdir(), "worker-storage-"));
	roots.push(root);
	return root;
};

test("the worker's pull request Git runner reads the scratch origin", async () => {
	const project = place();
	const origin = join(place(), "scratch origin");
	git(project, "init", "-q", "-b", "main");
	git(project, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "Initial");
	git(project, "clone", "--bare", "-q", project, origin);
	git(project, "remote", "add", "origin", origin);
	git(project, "remote", "add", "upstream", "https://github.com/owner/project.git");
	const head = git(project, "rev-parse", "HEAD").trim();
	const state = place();
	const open = spyOn(Channel, "open");
	const lanes = config.lanes;
	config.lanes = place();
	let channel: Channel | undefined;
	try {
		channel = await openChannel({
			id: "scratch", name: "scratch", owner: "owner", project, models: createModels(),
			storage: await openNodeSqliteStorage(join(state, "channel.sqlite")),
			env: cwd => new NodeExecutionEnv({ cwd }),
			directory: { self: { id: "scratch", name: "scratch" }, list: async () => [], deliver: async () => {} },
			log: () => {},
		}, state);
		const pulls = open.mock.calls[0]?.[0].build?.pulls;
		expect(pulls?.repo).toBe("owner/project");
		expect(await pulls?.git(["ls-remote", "--symref", "origin", "HEAD"])).toEqual({
			status: 0, stdout: `ref: refs/heads/main\tHEAD\n${head}\tHEAD\n`, stderr: "",
		});
	} finally {
		open.mockRestore();
		if (lanes === undefined) Reflect.deleteProperty(config, "lanes");
		else config.lanes = lanes;
		await channel?.close();
	}
});

test("source acquisition precedes mutable native open and cleanup follows joined capture and native close exactly once", async () => {
	const root = place(),
		order: string[] = [];
	const worker = { sessionId: "synthetic", config, stateDirectory: root };
	const storage = await openWorkerStorage(
		{
			openSource() {
				order.push("acquire");
				return () => {
					order.push("release");
				};
			},
			async close({ reads }) {
				order.push("capture");
				expect(reads).toBeDefined();
			},
		},
		worker,
		async () => {
			order.push("native-open");
			const raw = await openNodeSqliteStorage(join(root, "pi.sqlite"));
			const close = raw.close.bind(raw);
			raw.close = async (ctx) => {
				order.push("native-close");
				await close(ctx);
			};
			return raw;
		},
	);
	await Promise.all([storage.close(context), storage.close(context)]);
	expect(order).toEqual(["acquire", "native-open", "capture", "native-close", "release"]);
});

test("capture failure still closes native storage before release", async () => {
	const root = place(),
		order: string[] = [];
	const storage = await openWorkerStorage(
		{
			openSource() {
				return () => {
					order.push("release");
				};
			},
			async close() {
				order.push("capture");
				throw new Error("capture refused");
			},
		},
		{ sessionId: "synthetic", config, stateDirectory: root },
		() => openNodeSqliteStorage(join(root, "pi.sqlite")),
	);
	await expect(storage.close(context)).rejects.toThrow("capture refused");
	expect(order).toEqual(["capture", "release"]);
});

test("uncertain native open retains the acquired source capability", async () => {
	let released = false;
	await expect(
		openWorkerStorage(
			{
				openSource() {
					return () => {
						released = true;
					};
				},
			},
			{ sessionId: "synthetic", config, stateDirectory: place() },
			async () => {
				throw new Error("native open uncertain");
			},
		),
	).rejects.toThrow("native open uncertain");
	expect(released).toBe(false);
});

test("failed source acquisition never opens the native producer", async () => {
	let opened = false;
	await expect(
		openWorkerStorage(
			{
				openSource() {
					throw new Error("source unavailable");
				},
			},
			{ sessionId: "synthetic", config, stateDirectory: place() },
			async () => {
				opened = true;
				return openNodeSqliteStorage(join(place(), "pi.sqlite"));
			},
		),
	).rejects.toThrow("source unavailable");
	expect(opened).toBe(false);
});

test("uncertain native close retains ownership and a second close cannot repeat the native operation", async () => {
	const root = place();
	const raw = await openNodeSqliteStorage(join(root, "pi.sqlite"));
	const actualClose = raw.close.bind(raw);
	let closes = 0,
		released = false;
	raw.close = async () => {
		closes++;
		throw new Error("native close uncertain");
	};
	const storage = await openWorkerStorage(
		{
			openSource() {
				return () => {
					released = true;
				};
			},
		},
		{ sessionId: "synthetic", config, stateDirectory: root },
		async () => raw,
	);
	try {
		await expect(storage.close(context)).rejects.toThrow("native close uncertain");
		await expect(storage.close(context)).rejects.toThrow("native close uncertain");
		expect(closes).toBe(1);
		expect(released).toBe(false);
	} finally {
		await actualClose(context);
	}
});

test("known parent preflight failure releases source without calling the opaque opener", async () => {
	const root = place();
	const blocked = join(root, "blocker");
	writeFileSync(blocked, "ordinary file");
	let opened = 0,
		released = 0;
	await expect(
		openWorkerStorage(
			{
				openSource: () => () => {
					released++;
				},
			},
			{ sessionId: "synthetic", config, stateDirectory: root },
			async () => {
				opened++;
				throw new Error("must not open");
			},
			join(blocked, "channel.sqlite"),
		),
	).rejects.toThrow();
	expect(opened).toBe(0);
	expect(released).toBe(1);
});

test("capture and native close failures remain inspectable and reentrant cleanup joins once", async () => {
	const root = place();
	const raw = await openNodeSqliteStorage(join(root, "pi.sqlite"));
	const actualClose = raw.close.bind(raw);
	const primary = new Error("capture failure"),
		cleanup = new Error("native uncertainty");
	let closes = 0,
		captures = 0,
		released = false;
	raw.close = async () => {
		closes++;
		throw cleanup;
	};
	let reentered: Promise<void> | undefined;
	const storage = await openWorkerStorage(
		{
			openSource: () => () => {
				released = true;
			},
			close: async () => {
				captures++;
				reentered = storage.close(context);
				throw primary;
			},
		},
		{ sessionId: "synthetic", config, stateDirectory: root },
		async () => raw,
	);
	try {
		const closing = storage.close(context);
		const error = await closing.catch((error: unknown) => error);
		expect(reentered).toBe(closing);
		expect(error).toBeInstanceOf(AggregateError);
		if (error instanceof AggregateError)
			expect(error.errors).toEqual([primary, cleanup]);
		expect(closes).toBe(1);
		expect(captures).toBe(1);
		expect(released).toBe(false);
	} finally {
		await actualClose(context);
	}
});

test("an undefined capture rejection is retained alongside native cleanup failure", async () => {
	const root = place();
	const raw = await openNodeSqliteStorage(join(root, "pi.sqlite"));
	const close = raw.close.bind(raw);
	const cleanup = new Error("close failure");
	raw.close = async () => {
		throw cleanup;
	};
	const storage = await openWorkerStorage(
		{
			close: async () => {
				throw undefined;
			},
		},
		{ sessionId: "synthetic", config, stateDirectory: root },
		async () => raw,
	);
	try {
		const error = await storage.close(context).catch((error: unknown) => error);
		expect(error).toBeInstanceOf(AggregateError);
		if (error instanceof AggregateError)
			expect(error.errors).toEqual([undefined, cleanup]);
	} finally {
		await close(context);
	}
});
