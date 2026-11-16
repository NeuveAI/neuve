// Exercise real Bun owner, HTTP and HTTPS team listeners. Tailscale identity and
// personal sign-in boundaries are fixtures; no real tailnet or settings are used.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { testTemporaryDirectory as tmpdir } from "./fixtures/temporary.ts";
import { join } from "node:path";
import { z } from "zod";

const credential = "a".repeat(64);
const Ready = z.object({ coding: z.url(), owner: z.url(), plain: z.url(), plainAuthority: z.url(), tls: z.url().optional(), tlsAuthority: z.url().optional(), base: z.string() });
async function fixture(mode: "loopback" | "tailnet") {
	const home = await mkdtemp(join(tmpdir(), "review-listener-"));
	await mkdir(join(home, "settings"));
	await writeFile(join(home, "index.html"), "Coding home fixture");
	await writeFile(join(home, "caller"), "owner");
	await writeFile(join(home, "host.token"), credential, { mode: 0o600 });
	if (mode === "tailnet") {
		const certificate = Bun.spawnSync(["/usr/bin/openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(home, "key.pem"), "-out", join(home, "cert.pem"), "-days", "1", "-subj", "/CN=fixture.test"], { stdout: "pipe", stderr: "pipe" });
		if (!certificate.success) throw new Error("Fixture certificate generation failed");
	}
	const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "fixtures/review-listener.ts"), mode], {
		env: { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: tmpdir(), ACE_HOME: home, ACE_CONFIG_HOME: join(home, "settings"), ACE_KEYCHAIN_SERVICE: `review-fixture-${process.pid}`, ACE_USER: "owner" },
		stdin: "ignore", stdout: "pipe", stderr: "pipe",
	});
	const stdout = new Response(child.stdout).text();
	const stderr = new Response(child.stderr).text();
	const lines = async (name: string) => (await readFile(join(home, name), "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
	const close = async () => {
		await writeFile(join(home, "finish"), "finish");
		const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
		await child.exited;
		clearTimeout(timer);
		const result = { mode, exit: child.exitCode, stdout: await stdout, stderr: await stderr, hostLog: await readFile(join(home, "logs/host.jsonl"), "utf8").catch(() => "") };
		console.log(JSON.stringify(result));
		await rm(home, { recursive: true, force: true });
	};
	try {
		const deadline = Date.now() + 15_000;
		while (!existsSync(join(home, "ready.json"))) {
			if (child.exitCode !== null || Date.now() > deadline) throw new Error("Review listener fixture did not start");
			await Bun.sleep(10);
		}
		const ready = Ready.parse(JSON.parse(await readFile(join(home, "ready.json"), "utf8")));
		return { ready, home, close, lines, caller: (user: string) => writeFile(join(home, "caller"), user) };
	} catch (error) { await close(); throw error; }
}

test("quiet review event streams survive over 30 seconds through coding, owner and both team listeners", async () => {
	const at = await fixture("tailnet");
	try {
		const { coding, owner, plain, plainAuthority, tls, tlsAuthority, base } = at.ready;
		if (!tls || !tlsAuthority) throw new Error("Missing HTTPS listener");
		const destinations = [
			{ endpoint: coding, headers: {} },
			{ endpoint: owner, headers: { Authorization: `Bearer ${credential}` } },
			{ endpoint: plain, headers: { Host: new URL(plainAuthority).host } },
			{ endpoint: tls, headers: { Host: new URL(tlsAuthority).host } },
		];
		await Promise.all(destinations.map(async ({ endpoint, headers }) => {
			const started = performance.now();
			const response = await fetch(new URL(`${base}api/events`, endpoint), { headers, tls: { rejectUnauthorized: false }, signal: AbortSignal.timeout(40_000) });
			expect(response.status).toBe(200);
			expect(await response.text()).toBe("data: started\n\ndata: still open\n\n");
			expect(performance.now() - started).toBeGreaterThan(30_000);
		}));
	} finally { await at.close(); }
}, 45_000);

test("cold review startup and slow upstream commands survive 15 seconds before headers on every listener", async () => {
	const at = await fixture("tailnet");
	try {
		const { coding, owner, plain, plainAuthority, tls, tlsAuthority, base } = at.ready;
		if (!tls || !tlsAuthority) throw new Error("Missing HTTPS listener");
		const destinations = [
			{ endpoint: coding, authority: new URL(coding).origin, headers: {} },
			{ endpoint: owner, authority: owner, headers: { Authorization: `Bearer ${credential}` } },
			{ endpoint: plain, authority: plainAuthority, headers: { Host: new URL(plainAuthority).host } },
			{ endpoint: tls, authority: tlsAuthority, headers: { Host: new URL(tlsAuthority).host } },
		];
		await writeFile(join(at.home, "slow-resolver"), "delay 15 seconds");
		await Promise.all(destinations.map(async ({ endpoint, headers }) => {
			const started = performance.now();
			const path = `${base}cycles/01K90000000000000000000000`;
			const response = await fetch(new URL(path, endpoint), { headers, tls: { rejectUnauthorized: false }, signal: AbortSignal.timeout(30_000) });
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ method: "GET", path });
			expect(performance.now() - started).toBeGreaterThan(14_900);
		}));
		expect(await at.lines("resolved.jsonl")).toHaveLength(4);
		await rm(join(at.home, "slow-resolver"));
		await Promise.all(destinations.map(async ({ endpoint, authority, headers }) => {
			const started = performance.now();
			const path = `${base}_serverFn/slow`;
			const response = await fetch(new URL(path, endpoint), { method: "POST", headers: { ...headers, Origin: authority, "Content-Type": "application/json" }, body: '{"message":"slow upstream proof"}', tls: { rejectUnauthorized: false }, signal: AbortSignal.timeout(30_000) });
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ method: "POST", path, body: '{"message":"slow upstream proof"}' });
			expect(performance.now() - started).toBeGreaterThan(14_900);
		}));
		expect(await at.lines("resolved.jsonl")).toHaveLength(8);
		expect(await at.lines("upstream.jsonl")).toHaveLength(8);
	} finally { await at.close(); }
}, 50_000);

test("native owner review requests require accepted authority and owner authorization before forwarding", async () => {
	const at = await fixture("loopback");
	try {
		const { owner, base } = at.ready;
		const path = `${base}cycles/01K90000000000000000000000`;
		const auth = { Authorization: `Bearer ${credential}` };
		const request = (suffix: string, init: RequestInit = {}) => fetch(owner + suffix, init);
		for (const suffix of ["/review", "/review/", path]) {
			expect((await request(suffix)).status).toBe(401);
			expect((await request(suffix, { headers: { Authorization: `Bearer ${"b".repeat(64)}` } })).status).toBe(401);
		}
		for (const headers of [{ ...auth, Host: "foreign.invalid" }, { ...auth, Origin: "https://foreign.invalid" }, { ...auth, Origin: "null" }]) {
			expect((await request(path, { headers })).status).toBe(403);
		}
		expect(await at.lines("resolved.jsonl")).toHaveLength(0);
		expect(await at.lines("upstream.jsonl")).toHaveLength(0);
		for (const suffix of ["/review", "/review/", "/review/not-a-project/"]) expect((await request(suffix, { headers: auth })).status).toBe(404);
		const read = await request(path + "?returnTo=%2F", { headers: auth });
		expect(read.status).toBe(200);
		expect(await read.json()).toMatchObject({ method: "GET", path: path + "?returnTo=%2F" });
		const cookie = `ace-${new URL(owner).port}=${credential}`;
		const command = await request(`${base}_serverFn/command`, { method: "POST", headers: { Cookie: cookie, Origin: owner, "Content-Type": "application/json" }, body: '{"comment":"listener proof"}' });
		expect(command.status).toBe(200);
		const value = await command.json();
		expect(value).toMatchObject({ method: "POST", body: '{"comment":"listener proof"}' });
		expect(value.headers.cookie).toBeUndefined();
		expect(value.headers.authorization).toBeUndefined();
		expect(await (await request(path, { method: "HEAD", headers: auth })).text()).toBe("");
		expect((await request(path, { method: "DELETE", headers: auth })).status).toBe(405);
		expect((await request(path, { method: "POST", headers: auth, body: "{}" })).status).toBe(403);
		expect(await (await request("/")).text()).toBe("Coding home fixture");
		expect(await (await request("/reviewish")).text()).toBe("Coding home fixture");
		expect(await at.lines("whois.jsonl")).toHaveLength(0);
	} finally { await at.close(); }
}, 30_000);

for (const secure of [false, true]) {
	test(`native ${secure ? "HTTPS" : "HTTP"} review requests require the tailnet owner, including without Origin`, async () => {
		const at = await fixture("tailnet");
		try {
			const endpoint = secure ? at.ready.tls : at.ready.plain;
			const authority = secure ? at.ready.tlsAuthority : at.ready.plainAuthority;
			if (!endpoint || !authority) throw new Error("Missing native listener");
			const { base } = at.ready;
			const path = `${base}cycles/01K90000000000000000000000`;
			const host = new URL(authority).host;
			const request = (suffix: string, init: RequestInit = {}) => {
				const headers = new Headers(init.headers);
				if (!headers.has("host")) headers.set("host", host);
				return fetch(endpoint + suffix, { ...init, headers, tls: { rejectUnauthorized: false } });
			};
			for (const headers of [{ Host: "foreign.invalid" }, { Origin: "https://foreign.invalid" }, { Origin: "null" }]) expect((await request(path, { headers })).status).toBe(403);
			expect(await at.lines("whois.jsonl")).toHaveLength(0);
			await at.caller("teammate");
			for (const suffix of ["/review", "/review/", path]) {
				expect((await request(suffix)).status).toBe(403);
				expect((await request(suffix, { headers: { Origin: authority } })).status).toBe(403);
			}
			expect((await request(path, { headers: { Upgrade: "websocket" } })).status).toBe(403);
			expect((await request(path, { method: "POST", headers: { Origin: authority }, body: "{}" })).status).toBe(403);
			await at.caller("unavailable");
			expect((await request(path)).status).toBe(403);
			expect(await at.lines("resolved.jsonl")).toHaveLength(0);
			expect(await at.lines("upstream.jsonl")).toHaveLength(0);
			await at.caller("owner");
			for (const headers of [{}, { Origin: authority }]) {
				const response = await request(path, { headers });
				expect(response.status).toBe(200);
				expect(await response.json()).toMatchObject({ method: "GET", path });
			}
			const command = await request(`${base}_serverFn/command`, { method: "POST", headers: { Origin: authority, "Content-Type": "application/json" }, body: '{"comment":"tailnet proof"}' });
			expect(command.status).toBe(200);
			expect(await command.json()).toMatchObject({ method: "POST", path: `${base}_serverFn/command`, body: '{"comment":"tailnet proof"}' });
			const head = await request(path, { method: "HEAD" });
			expect(head.status).toBe(200);
			expect(await head.text()).toBe("");
			const count = (await at.lines("upstream.jsonl")).length;
			for (const method of ["PUT", "DELETE", "OPTIONS"]) expect((await request(path, { method })).status).toBe(405);
			expect((await request(path, { method: "POST", body: "{}" })).status).toBe(403);
			expect((await request(path, { headers: { Upgrade: "websocket" } })).status).toBe(secure ? 403 : 405);
			for (const suffix of ["/review", "/review/", "/review/not-a-project/"]) expect((await request(suffix)).status).toBe(404);
			expect(await at.lines("upstream.jsonl")).toHaveLength(count);
			expect(await (await request("/")).text()).toBe("Coding home fixture");
			expect(await (await request("/reviewish")).text()).toBe("Coding home fixture");
			const whois = await at.lines("whois.jsonl");
			expect(whois.length).toBeGreaterThan(0);
			for (const line of whois) expect(JSON.parse(line)).toMatchObject({ address: "::1", port: expect.any(Number) });
		} finally { await at.close(); }
	}, 30_000);
}
