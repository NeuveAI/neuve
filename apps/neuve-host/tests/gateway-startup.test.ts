import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function until(read: () => boolean | Promise<boolean>, label: string) {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		if (await read()) return;
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for ${label}`);
}
async function fixture(mode: string, port: number | string = 0, webPort = "0") {
	if (!process.env.TMPDIR) throw new Error("Set TMPDIR to external fixture storage");
	const home = await mkdtemp(join(tmpdir(), "gateway-start-"));
	await mkdir(join(home, "settings"));
	await writeFile(join(home, "index.html"), "owned TLS app");
	if (mode.startsWith("tls")) {
		const certificate = Bun.spawnSync(["/usr/bin/openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(home, "key.pem"), "-out", join(home, "cert.pem"), "-days", "1", "-subj", "/CN=fixture.test"], {stdout: "pipe", stderr: "pipe"});
		if (!certificate.success) throw new Error(certificate.stderr.toString());
	}
	const env = {PATH: process.env.PATH!, TMPDIR: process.env.TMPDIR, ACE_HOME: home,
		ACE_CONFIG_HOME: join(home, "settings"), ACE_KEYCHAIN_SERVICE: `fixture-${process.pid}`,
		ACE_USER: "owner", ACE_WEB_PORT: webPort, BUN_RUNTIME_TRANSPILER_CACHE_PATH: process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH!,
	};
	const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "fixtures/gateway-startup.ts"), mode, String(port)], {env, stdout: "pipe", stderr: "pipe"});
	const stdout = new Response(child.stdout).text();
	const stderr = new Response(child.stderr).text();
	const has = (name: string) => existsSync(join(home, name));
	const release = (name: string) => writeFile(join(home, name), "release");
	return {home, child, has, release, stdout, stderr, async close() {
		if (child.exitCode === null) child.kill("SIGKILL");
		await child.exited;
		const logs = {stdout: await stdout, stderr: await stderr,
			hostLog: await readFile(join(home, "logs/host.jsonl"), "utf8").catch(() => ""),
		};
		const markers = Object.fromEntries(await Promise.all(["ready", "owner-port", "workspace-web-port", "error", "cleanup-started", "cleanup-done", "managed-rejected-after-cleanup", "done"].map(async (name) => [name, await readFile(join(home, name), "utf8").catch(() => null)])));
		console.log(JSON.stringify({mode, exit: child.exitCode, ...logs, markers}));
		await rm(home, {recursive: true, force: true});
	}};
}

for (const mode of ["stop-serve", "stop-managed"]) {
	test(`${mode} joins cleanup when stopped during the deferred Tailscale lookup`, async () => {
		const at = await fixture(mode);
		try {
			await until(() => at.has("lookup"), "lookup");
			const port = Number(await readFile(join(at.home, "owner-port"), "utf8"));
			expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
			if (mode === "stop-managed") await at.release("stop");
			else at.child.kill("SIGTERM");
			await until(() => at.has("cleanup-started"), "cleanup barrier");
			await at.release("release-lookup");
			await Bun.sleep(100);
			expect(at.child.exitCode).toBeNull();
			expect(at.has("cleanup-done")).toBe(false);
			await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
			await at.release("release-cleanup");
			expect(await at.child.exited).toBe(0);
			expect(at.has("cleanup-done")).toBe(true);
			if (mode === "stop-managed") expect(await readFile(join(at.home, "managed-rejected-after-cleanup"), "utf8")).toBe("true");
		} finally {await at.close();}
	}, 25_000);
}

async function freePort(from: number, to: number): Promise<number> {
	for (let port = from; port <= to; port++) {
		try {
			const listener = Bun.serve({hostname: "127.0.0.1", port, fetch: () => new Response("probe")});
			await listener.stop(true);
			return port;
		} catch {}
	}
	throw new Error("No fixture port available in the bounded range");
}

for (const mode of ["tls-dynamic", "tls-high", "tls-collision"]) {
	test(`${mode} serves HTTPS on its bound port and checks that actual authority`, async () => {
		const hostPort = mode === "tls-dynamic" ? 0 : mode === "tls-high" ? await freePort(65_520, 65_535) : await freePort(54_000, 54_010);
		const collision = mode === "tls-collision" ? Bun.serve({hostname: "::1", port: hostPort + 1000, fetch: () => new Response("held by fixture")}) : undefined;
		const at = await fixture(mode, hostPort, mode === "tls-dynamic" ? "0" : "");
		try {
			await until(() => at.has("ready") || at.has("error"), "TLS listener");
			expect(at.has("error")).toBe(false);
			const ready = JSON.parse(await readFile(join(at.home, "ready"), "utf8"));
			const address = new URL(ready.address);
			const tlsPort = Number(address.port);
			if (hostPort === 0) expect(ready.ownerPort).toBeGreaterThan(0);
			else expect(ready.ownerPort).toBe(hostPort);
			expect(tlsPort).toBeGreaterThan(0);
			expect(tlsPort).toBeLessThanOrEqual(65_535);
			const url = `https://[::1]:${tlsPort}`;
			const request = (path: string, headers: Record<string, string>) => fetch(`${url}${path}`, {headers, tls: {rejectUnauthorized: false}});
			expect(await (await request("/", {host: address.host})).text()).toBe("owned TLS app");
			expect((await request("/", {host: "wrong.test:0"})).status).toBe(404);
			expect((await request("/ws", {host: address.host, origin: address.origin})).status).toBe(400);
			expect((await request("/ws", {host: address.host, origin: "https://fixture.test:0"})).status).toBe(403);
			for (const boundary of ["directory", "lobby", "peers"]) expect(at.has(`${boundary}-started`)).toBe(true);
			if (collision) expect(await (await fetch(`http://[::1]:${hostPort + 1000}`)).text()).toBe("held by fixture");
			await at.release("finish");
			expect(await at.child.exited).toBe(0);
			for (const boundary of ["directory", "lobby", "peers", "tailnet"]) expect(at.has(`${boundary}-stopped`)).toBe(true);
			expect(at.has("done")).toBe(true);
		} finally {await collision?.stop(true); await at.close();}
	}, 25_000);
}

test("desktop dev source host mapping runs the real CLI help entry", async () => {
	const build = await readFile(new URL("../../desktop/scripts/build.ts", import.meta.url), "utf8");
	const match = /join\(root, "\.\.", "([^"]+)", "src", "cli\.ts"\)/.exec(build);
	if (!match?.[1]) throw new Error("Desktop dev has no source host entry");
	const entry = resolve(import.meta.dir, "../../desktop", "..", match[1], "src", "cli.ts");
	const at = await fixture("desktop-help", entry);
	try {
		expect(await at.child.exited).toBe(0);
		expect(match[1]).toBe("neuve-host");
		expect(await at.stdout).toContain("ace serve");
		expect(await at.stderr).not.toContain("Module not found");
	} finally {await at.close();}
}, 25_000);
