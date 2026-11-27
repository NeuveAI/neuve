import "./fixtures/memory-secrets";
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	chmodSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Listing } from "../src/catalog";
import { GatewayClient } from "../src/private-gateway-client";
import { startHost } from "./fixture-host";
import { acquireHome } from "../src/ownership";

const roots: string[] = [];
const children: Bun.Subprocess[] = [];
const releases: (() => void)[] = [];
const clients: GatewayClient[] = [];
const environment = Object.fromEntries(
	Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);

function place() {
	if (!process.env.TMPDIR) throw new Error("Set TMPDIR to the external temporary directory");
	const root = realpathSync(mkdtempSync(join(tmpdir(), "ho")));
	roots.push(root);
	for (const name of ["h", "l", "p"]) mkdirSync(join(root, name));
	writeFileSync(join(root, "script"), JSON.stringify([{ text: "still owned" }]));
	writeFileSync(join(root, "script.cursor"), "0");
	return root;
}

function project(root: string) {
	const git = (...args: string[]) => {
		const result = Bun.spawnSync(["git", "-C", join(root, "p"), ...args], { env: environment });
		if (result.exitCode) throw new Error(result.stderr.toString());
	};
	git("init", "-q", "-b", "main");
	writeFileSync(join(root, "p", "first"), "first");
	git("add", "first");
	git(
		"-c",
		"user.name=Fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"commit",
		"-qm",
		"first",
	);
}

async function until<T>(read: () => T | undefined | false): Promise<T> {
	const end = Date.now() + 20_000;
	while (Date.now() < end) {
		const value = read();
		if (value) return value;
		await Bun.sleep(10);
	}
	throw new Error("Ownership fixture timed out");
}

function configuration(root: string, extra: Record<string, string> = {}) {
	return {
		home: join(root, "h"),
		lanes: join(root, "l"),
		user: "owner",
		port: 0,
		environment: { ...environment, NEUVE_TEST_SCRIPT: join(root, "script"), ...extra },
		worker: [process.execPath, ...(process.env.NEUVE_TEST_PRELOAD ? ["--preload", process.env.NEUVE_TEST_PRELOAD] : []), join(import.meta.dir, "worker.ts")],
	};
}

function launch(root: string, name: string, home?: string, extra: Record<string, string> = {}) {
	const config = { ...configuration(root, extra), ...(home ? { home } : {}) };
	const ready = join(root, name);
	const child = Bun.spawn(
		[
			process.execPath,
			join(import.meta.dir, "ownership-host.ts"),
			JSON.stringify(config),
			ready,
			join(root, "go"),
		],
		{ env: { ...environment, ...extra }, stdout: "ignore", stderr: "pipe" },
	);
	children.push(child);
	return {
		child,
		ready: () => until(() => existsSync(ready) && JSON.parse(readFileSync(ready, "utf8"))),
	};
}

afterEach(async () => {
	for (const client of clients.splice(0)) client.close();
	for (const child of children.splice(0)) {
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
	}
	for (const release of releases.splice(0)) release();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("simultaneous physical-home aliases accept one host and preserve its worker through loser exit and shutdown", async () => {
	const root = place();
	project(root);
	symlinkSync(join(root, "h"), join(root, "alias"));
	const extra = { NEUVE_TEST_CLOSE_WAIT: join(root, "release") };
	const a = launch(root, "a", undefined, extra);
	const b = launch(root, "b", join(root, "alias"), extra);
	await until(() => existsSync(join(root, "a.waiting")) && existsSync(join(root, "b.waiting")));
	writeFileSync(join(root, "go"), "");
	const results = await Promise.all([a.ready(), b.ready()]);
	expect(results.filter((result) => result.url).length, JSON.stringify(results)).toBe(1);
	expect(results.filter((result) => result.error?.includes("already served")).length).toBe(1);
	const winner = results[0].url ? a : b;
	const ready = results.find((result) => result.url);
	const loser = results[0].url ? b : a;
	expect(await loser.child.exited).toBe(1);
	const port = readFileSync(join(root, "h", "host.port"), "utf8");
	const token = readFileSync(join(root, "h", "host.token"), "utf8");
	const client = new GatewayClient(ready.url, ready.token);
	clients.push(client);
	await until(() => client.status === "open");
	const record = await client.request<Listing>({ op: "create", project: join(root, "p") });
	await client.channel(record.id, { op: "watch" });
	const worker = Number(readFileSync(join(root, "h", "channels", record.id, "worker.pid"), "utf8"));
	const rejected = launch(root, "rejected");
	expect((await rejected.ready()).error).toContain("already served");
	expect(await rejected.child.exited).toBe(1);
	expect(readFileSync(join(root, "h", "host.port"), "utf8")).toBe(port);
	expect(readFileSync(join(root, "h", "host.token"), "utf8")).toBe(token);
	expect(() => process.kill(worker, 0)).not.toThrow();
	const asked = await client.channel<{ submission: number }>(record.id, {
		op: "ask",
		author: "owner",
		text: "hello",
	});
	await client.channel(record.id, { op: "wait", submission: asked.submission });
	winner.child.kill("SIGTERM");
	await until(() => existsSync(join(root, "release.closing")));
	const during = launch(root, "during");
	expect((await during.ready()).error).toContain("already served");
	expect(await during.child.exited).toBe(1);
	writeFileSync(join(root, "release"), "");
	expect(await winner.child.exited).toBe(0);
	const restarted = launch(root, "restarted");
	expect((await restarted.ready()).url).toContain("ws://127.0.0.1:");
	restarted.child.kill("SIGTERM");
	expect(await restarted.child.exited).toBe(0);
});

test("a host claim waits for a competing SQLite reader to release before taking exclusive ownership", async () => {
	const root = place();
	const lock = join(root, "h", "host.lock");
	writeFileSync(lock, "", { mode: 0o600 });
	const reader = new Database(lock);
	const observer = new Database(lock);
	try {
		reader.run("BEGIN");
		reader.query("PRAGMA schema_version").get();
		const owner = launch(root, "owner");
		await until(() => existsSync(join(root, "owner.waiting")));
		writeFileSync(join(root, "go"), "");
		const waiting = await until(() => {
			if (existsSync(join(root, "owner"))) return "finished";
			try {
				observer.run("BEGIN IMMEDIATE");
				observer.run("ROLLBACK");
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "SQLITE_BUSY")
					return "waiting";
				throw error;
			}
			return false;
		});
		reader.run("ROLLBACK");
		const ready = await owner.ready();
		expect(waiting, JSON.stringify(ready)).toBe("waiting");
		expect(ready.url, JSON.stringify(ready)).toContain("ws://127.0.0.1:");
		owner.child.kill("SIGTERM");
		expect(await owner.child.exited).toBe(0);
	} finally {
		observer.close();
		reader.close();
	}
});

test("kernel ownership recovers after SIGKILL and distinct physical homes coexist", async () => {
	const first = place();
	const second = place();
	writeFileSync(join(first, "go"), "");
	writeFileSync(join(second, "go"), "");
	const a = launch(first, "a");
	const b = launch(second, "b");
	const ready = await Promise.all([a.ready(), b.ready()]);
	expect(ready.filter((result) => result.url).length).toBe(2);
	a.child.kill("SIGKILL");
	await a.child.exited;
	const again = launch(first, "again");
	expect((await again.ready()).url).toContain("ws://127.0.0.1:");
	expect((await fetch(ready[1].url.replace("ws:", "http:").replace("/ws", "/health"))).status).toBe(
		200,
	);
});

test("failed shutdown retains ownership until process death and the next owner can recover", async () => {
	const root = place();
	project(root);
	writeFileSync(join(root, "go"), "");
	const owner = launch(root, "owner", undefined, {
		NEUVE_TEST_CLOSE_FAIL: "1",
		NEUVE_TEST_HOLD_CLOSE_FAILURE: "1",
	});
	const ready = await owner.ready();
	const client = new GatewayClient(ready.url, ready.token);
	clients.push(client);
	await until(() => client.status === "open");
	const record = await client.request<Listing>({ op: "create", project: join(root, "p") });
	await client.channel(record.id, { op: "info" });
	owner.child.kill("SIGTERM");
	await until(() => existsSync(join(root, "owner.failed")));
	const rejected = launch(root, "rejected");
	expect((await rejected.ready()).error).toContain("already served");
	expect(await rejected.child.exited).toBe(1);
	owner.child.kill("SIGKILL");
	await owner.child.exited;
	const recovered = launch(root, "recovered");
	expect((await recovered.ready()).url).toContain("ws://127.0.0.1:");
	recovered.child.kill("SIGTERM");
	expect(await recovered.child.exited).toBe(0);
});

test("invalid token and post-listener startup failure release only after cleanup, so restart works", async () => {
	const root = place();
	const config = configuration(root);
	writeFileSync(join(root, "h", "host.token"), "invalid", { mode: 0o600 });
	await expect(startHost({ config, models: () => [] })).rejects.toThrow("token is invalid");
	rmSync(join(root, "h", "host.token"));
	mkdirSync(join(root, "h", "host.port"));
	await expect(startHost({ config, models: () => [] })).rejects.toThrow();
	rmSync(join(root, "h", "host.port"), { recursive: true });
	const host = await startHost({loopback: true, config, models: () => [] });
	await Promise.all([host.close(), host.close()]);
	const again = await startHost({loopback: true, config, models: () => [] });
	await again.close();
});

test("a channels-file failure closes its already-bound listener before same-home recovery", async () => {
	const root = place();
	const reserved = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () => new Response("reserved"),
	});
	const port = reserved.port!;
	await reserved.stop(true);
	const config = { ...configuration(root), port };
	writeFileSync(join(root, "h", "channels"), "sentinel");
	await expect(startHost({ config, models: () => [] })).rejects.toThrow();
	expect(readFileSync(join(root, "h", "channels"), "utf8")).toBe("sentinel");
	const replacement = Bun.serve({
		port,
		hostname: "127.0.0.1",
		fetch: () => new Response("no leaked listener"),
	});
	expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe("no leaked listener");
	await replacement.stop(true);
	rmSync(join(root, "h", "channels"));
	const recovered = await startHost({loopback: true, config, models: () => [] });
	expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
	await recovered.close();
});

test("malformed, public, symlinked, or multiply linked lock files fail closed without clobbering", () => {
	const root = place();
	const home = join(root, "h");
	const lock = join(home, "host.lock");
	writeFileSync(lock, "not a SQLite file", { mode: 0o600 });
	expect(() => acquireHome(home)).toThrow("file is not a database");
	expect(readFileSync(lock, "utf8")).toBe("not a SQLite file");
	rmSync(lock);
	writeFileSync(lock, "", { mode: 0o644 });
	expect(() => acquireHome(home)).toThrow("private regular file");
	chmodSync(lock, 0o600);
	linkSync(lock, join(root, "linked"));
	expect(() => acquireHome(home)).toThrow("private regular file");
	rmSync(lock);
	symlinkSync(join(root, "linked"), lock);
	expect(() => acquireHome(home)).toThrow("private regular file");
	expect(readFileSync(join(root, "linked"), "utf8")).toBe("");
	rmSync(lock);
	rmSync(join(root, "linked"));
	const release = acquireHome(home);
	releases.push(release);
	expect(() => acquireHome(home)).toThrow("already served");
	release();
	release();
	releases.push(acquireHome(home));
});
