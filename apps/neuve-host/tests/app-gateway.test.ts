import "./fixtures/memory-secrets";
import { afterEach, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { testTemporaryDirectory as tmpdir } from "./fixtures/temporary.ts";
import type WebSocket from "ws";

import { serveCodingUi, type CodingUi } from "../src/app-gateway";
import { GatewayClient } from "../src/gateway-client";
import { startHost, type Host } from "./fixture-host";
import type { ChannelInfo, Listing, TerminalOpened, TerminalShell } from "../src/protocol";

const Socket: typeof WebSocket = createRequire(import.meta.url)("../node_modules/ws/index.js");
const roots: string[] = [];
const stops: Array<() => Promise<void>> = [];
const credential = "a".repeat(64);

async function place() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "ab-")));
	roots.push(root);
	const app = join(root, "app");
	await mkdir(app);
	await writeFile(join(app, "index.html"), "<!doctype html><title>Ace fixture</title><main>Ace</main>");
	return { root, app };
}

async function until(read: () => boolean | Promise<boolean>, what: string) {
	const deadline = Date.now() + 20_000;
	while (!(await read())) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await Bun.sleep(20);
	}
}

async function refused(url: string, headers: Record<string, string>, protocols?: string[]): Promise<number> {
	return new Promise((resolve, reject) => {
		const socket = new Socket(url, protocols, { headers });
		socket.on("unexpected-response", (_, response) => { response.resume(); socket.terminate(); resolve(response.statusCode ?? 0); });
		socket.on("error", () => {});
		socket.on("open", () => { socket.close(); reject(new Error("The refused connection opened")); });
	});
}

afterEach(async () => {
	for (const stop of stops.splice(0).reverse()) await stop();
	for (const path of roots.splice(0)) await rm(path, { force: true, recursive: true });
});

test("coding listener rejects foreign browser authority before connecting privately and contains static files", async () => {
	const { root, app } = await place();
	let upstreams = 0;
	const privateHost = Bun.serve({
		hostname: "127.0.0.1", port: 0,
		fetch(request, server) { upstreams++; if (server.upgrade(request)) return; return new Response("No", { status: 400 }); },
		websocket: { message() {} },
	});
	stops.push(async () => { await privateHost.stop(true); });
	const coding = await serveCodingUi({ host: { url: `ws://127.0.0.1:${privateHost.port}/ws`, token: credential }, directory: app, port: 0 });
	stops.push(coding.close);
	const origin = new URL(coding.url).origin;
	const ws = `${origin.replace("http", "ws")}/ws`;
	const refusals: Record<string, string>[] = [
		{}, { Origin: "null" }, { Origin: "https://foreign.invalid" },
		{ Origin: origin, Host: "rebound.invalid" },
		{ Origin: origin, "Sec-Fetch-Site": "cross-site" },
		{ Origin: origin, "Sec-Fetch-Site": "same-site" },
	];
	for (const headers of refusals) expect(await refused(ws, headers)).toBe(403);
	expect(await refused(ws, { Origin: origin }, ["ace", `ace-token.${credential}`, "unsupported"])).toBe(400);
	expect(upstreams).toBe(0);
	const home = await fetch(coding.url);
	expect(await home.text()).toContain("Ace fixture");
	expect(home.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
	expect(home.headers.get("set-cookie")).toBeNull();
	expect(await (await fetch(new URL("/workspace", coding.url))).text()).not.toContain(credential);
	await writeFile(join(root, "outside.txt"), "outside content");
	await symlink(join(root, "outside.txt"), join(app, "escape.txt"));
	expect((await fetch(new URL("/escape.txt", coding.url))).status).toBe(403);
	expect((await fetch(new URL("/%2e%2e%2foutside.txt", coding.url))).status).toBe(403);
	expect((await fetch(new URL("/ws", coding.url), { headers: { Origin: "https://foreign.invalid" } })).status).toBe(403);
	expect(upstreams).toBe(0);
});

// The private host picks a new port on restart, so the cookie must belong to the coding listener.
test("coding listener requires a credential and reuses its cookie after restart", async () => {
	const { app } = await place();
	let upstreams = 0;
	const startPrivateHost = (message: string) => {
		const server = Bun.serve({
			hostname: "127.0.0.1", port: 0,
			fetch(request, server) {
				upstreams++;
				if (server.upgrade(request, { headers: { "sec-websocket-protocol": "ace" } })) return;
				return new Response("Upgrade failed", { status: 400 });
			},
			websocket: { open(socket) { socket.send(message); }, message() {} },
		});
		const close = async () => { await server.stop(true); };
		stops.push(close);
		return { url: `ws://127.0.0.1:${server.port}/ws`, token: credential, close };
	};
	const host = startPrivateHost("Original private host");
	const coding = await serveCodingUi({ host, directory: app, port: 0 });
	stops.push(coding.close);
	const { origin, port } = new URL(coding.url);
	const probe = new URL("/ws", coding.url);
	const ws = probe.href.replace("http:", "ws:");
	const headers = { Origin: origin, "Sec-Fetch-Site": "same-origin" };
	const connect = (headers: Record<string, string>, protocols?: string[]) => new Promise<{
		protocol: string; cookie: string; message: string;
	}>((resolve, reject) => {
		const socket = new Socket(ws, protocols, { headers });
		socket.once("error", reject);
		socket.once("close", code => reject(new Error(`The socket closed before the host replied (${code})`)));
		socket.once("upgrade", response => socket.once("message", message => {
			socket.close();
			resolve({ protocol: socket.protocol, cookie: response.headers["set-cookie"]?.[0] ?? "", message: message.toString() });
		}));
	});

	expect(await refused(ws, headers)).toBe(401);
	const response = await fetch(probe);
	expect(response.status).toBe(401);
	expect(await response.text()).toBe("ace");
	expect(upstreams).toBe(0);

	const signedIn = await connect(headers, ["ace", `ace-token.${credential}`]);
	const cookie = `ace-${port}=${credential}; HttpOnly; SameSite=Strict; Path=/`;
	expect(signedIn).toEqual({ protocol: "ace", cookie, message: "Original private host" });
	const nextHost = startPrivateHost("Restarted private host");
	expect(nextHost.url).not.toBe(host.url);
	await coding.close();
	await host.close();

	const restarted = await serveCodingUi({ host: nextHost, directory: app, port: Number(port) });
	stops.push(restarted.close);
	expect(restarted.url).toBe(coding.url);
	const browserCookie = signedIn.cookie.slice(0, signedIn.cookie.indexOf(";"));
	expect(await connect({ ...headers, Cookie: browserCookie })).toEqual({
		protocol: "", cookie, message: "Restarted private host",
	});
	expect(upstreams).toBe(2);
});

test("upstream handshake failure is a visible socket close and listener shutdown is idempotent", async () => {
	const { app } = await place();
	let connections = 0;
	const privateHost = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { connections++; return new Response("Unavailable", { status: 503 }); } });
	stops.push(async () => { await privateHost.stop(true); });
	const coding = await serveCodingUi({ host: { url: `ws://127.0.0.1:${privateHost.port}/ws`, token: credential }, directory: app, port: 0 });
	stops.push(coding.close);
	const closed = await new Promise<number>((resolve, reject) => {
		const socket = new Socket(new URL("/ws", coding.url).href.replace("http", "ws"), ["ace", `ace-token.${credential}`], { headers: { Origin: new URL(coding.url).origin, "Sec-Fetch-Site": "same-origin" } });
		socket.on("close", code => resolve(code));
		socket.on("error", reject);
	});
	expect(closed).toBe(1011);
	expect(connections).toBe(1);
	await coding.close();
	await coding.close();
});

async function git(cwd: string, ...args: string[]) {
	const child = Bun.spawn(["git", "-c", "user.name=Neuve test", "-c", "user.email=test@neuve.invalid", "-C", cwd, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000, killSignal: "SIGKILL" });
	const [code, , stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
	if (code !== 0) throw new Error(stderr);
}

test("actual Ace client crosses the real private host with watches, verified authors and independently owned terminals", async () => {
	const { root, app } = await place();
	const home = join(root, "s"), lanes = join(root, "l"), project = join(root, "p"), script = join(root, "script.json");
	await Promise.all([mkdir(home), mkdir(lanes), mkdir(project)]);
	await git(project, "init", "-q", "-b", "main");
	await writeFile(join(project, "README.md"), "hello\n");
	await git(project, "add", "README.md"); await git(project, "commit", "-qm", "initial");
	await writeFile(script, "[]"); await writeFile(`${script}.cursor`, "0");
	const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
	const host: Host = await startHost({loopback: true,
		config: { home, lanes, user: "owner", port: 0, environment: { ...environment, NEUVE_TEST_SCRIPT: script }, worker: [process.execPath, ...(process.env.NEUVE_TEST_PRELOAD ? ["--preload", process.env.NEUVE_TEST_PRELOAD] : []), join(import.meta.dir, "worker.ts")] },
		models: () => [{ provider: "faux", modelId: "coder", efforts: ["off"] }],
	});
	stops.push(host.close);
	const coding: CodingUi = await serveCodingUi({ host, directory: app, port: 0 });
	stops.push(coding.close);
	const origin = new URL(coding.url).origin;
	expect((await fetch(host.url.replace("ws:", "http:"), { headers: { Origin: origin, Authorization: `Bearer ${host.token}` } })).status).toBe(403);
	const original = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
	class BrowserSocket extends Socket {
		constructor(url: string, protocols?: string | string[]) { super(url, protocols, { headers: { Origin: origin } }); this.on("error", () => {}); }
	}
	Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: BrowserSocket });
	const first = new GatewayClient(`${origin.replace("http", "ws")}/ws`, host.token);
	const second = new GatewayClient(`${origin.replace("http", "ws")}/ws`, host.token);
	const initialPeople = first.people;
	try {
		await until(() => first.status === "open" && second.status === "open", "both browser connections");
		await until(() => first.people !== initialPeople, "original people snapshot");
		expect(Object.keys(first.people).every(user => user === "owner")).toBe(true);
		expect(await first.request({ op: "hello" })).toMatchObject({ user: "owner" });
		await first.request({ op: "project-open", path: project });
		await until(() => second.projects?.some(value => value.path === project) === true, "project broadcast");
		const channel = await first.request<Listing>({ op: "create", project });
		let events = 0;
		let author = "";
		await first.channel(channel.id, { op: "watch", chat: 1 }, { event(event) { events++; if (event.kind === "message") author = event.author; } });
		await first.channel(channel.id, { op: "say", chat: 1, author: "forged", text: "transport ownership proof" });
		await until(() => events > 0, "channel watch event");
		await expect(first.channel(channel.id, { op: "review-origin-set", chat: 1, items: [] })).rejects.toThrow("Only the host records a review association");
		const info = await first.channel<ChannelInfo>(channel.id, { op: "info" });
		expect(info.chats.length).toBe(1);
		expect(author).toBe("owner");
		const opened = await first.request<TerminalOpened>({ op: "terminal", channel: channel.id, cols: 80, rows: 24 });
		let output = "";
		first.terminal(opened.terminal, frame => { if ("data" in frame) output += Buffer.from(frame.data, "base64").toString(); });
		await first.request({ op: "terminal-input", terminal: opened.terminal, data: "printf '\\nACE_BRIDGE_OK\\n'\n" });
		await until(() => output.includes("ACE_BRIDGE_OK"), "real terminal output");
		first.close();
		await until(async () => (await second.request<TerminalShell[]>({ op: "terminals", channel: channel.id })).some(value => value.terminal === opened.terminal && !value.attached), "first socket detachment");
		expect(await second.request({ op: "hello" })).toMatchObject({ user: "owner" });
		let replay = false;
		second.terminal(opened.terminal, frame => { if ("replay" in frame && frame.replay) replay = true; });
		await second.request({ op: "terminal", channel: channel.id, terminal: opened.terminal, cols: 90, rows: 30 });
		await until(() => replay, "terminal replay on another socket");
		await second.request({ op: "terminal-close", terminal: opened.terminal });
		expect(await Bun.file(`${script}.cursor`).text()).toBe("0");
	} finally {
		first.close(); second.close();
		if (original) Object.defineProperty(globalThis, "WebSocket", original);
	}
}, 30_000);
