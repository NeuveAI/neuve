import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { serveOAuthFixture } from "./fixtures/oauth-http";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createRegistry } from "@earendil-works/pi-durable";
import type { Log } from "@ace/channel";

import { config } from "../src/config";
import { PluginManifest } from "../src/plugin-manifest";
import { authorizePluginRefresh, PLUGIN_REFRESH_PATH, pluginOAuthTransport } from "../src/plugin-oauth-client";
import { oauthAccount, readSession } from "../src/plugin-oauth-store";
import { PluginOAuth } from "../src/plugin-oauth";
import { pluginTools } from "../src/plugin-tools";
import { pluginSettings } from "../src/settings";

const access = (rotation: number) => `fixture-access-token-${rotation}`;
const refreshToken = (rotation: number) => `fixture-refresh-token-${rotation}`;

async function fixture(expiresIn = 3600) {
	const routes: string[] = [];
	let registration: string | undefined;
	let redirect: string | undefined;
	let challenge: string | null = null;
	let rotation = 0;
	let requests = 0;
	let rejectAccess = false;
	let refreshFailure: { status: number; code: string } | undefined;
	let remoteStop: Promise<void> | undefined;
	const hold = Promise.withResolvers<void>();
	const refreshesSettled = Promise.withResolvers<void>();
	let refreshReplies = 0;
	const refreshing = Promise.withResolvers<void>();
	const getStarted = Promise.withResolvers<void>();
	const resumeGet = Promise.withResolvers<void>();
	const bothRejected = Promise.withResolvers<void>();
	let holdGet = false;
	let rejections = 0;
	let waiting = false;
	const server = serveOAuthFixture(async request => {
		const url = new URL(request.url);
		const resource = new URL("/mcp", url);
		const issuer = new URL("/issuer", url);
		switch (url.pathname) {
			case "/mcp": {
				const bearer = request.headers.get("authorization");
				if (holdGet && request.method === "GET") {
					getStarted.resolve();
					await resumeGet.promise;
				}
				if ((bearer !== `Bearer ${access(rotation)}` || (rejectAccess && rotation === 0))
					&& bearer !== "Bearer fixture-api-key") {
					routes.push("401");
					if (holdGet && rejectAccess) {
						if (++rejections === 2) bothRejected.resolve();
						await bothRejected.promise;
					}
					return new Response(null, {
						status: 401, headers: { "www-authenticate": `Bearer realm="OAuth", resource_metadata="${url.origin}/discover", scope="read write"` },
					});
				}
				if (request.method === "GET") return new Response(null, { status: 405 });
				const data = await request.json();
				if (data.id === undefined) return new Response(null, { status: 202 });
				const result = data.method === "initialize"
					? { protocolVersion: data.params.protocolVersion, serverInfo: { name: "fixture", version: "1" }, capabilities: { tools: {} } }
					: data.method === "tools/list"
						? { tools: [{ name: "list_issues", inputSchema: { type: "object" } }] }
						: { content: [{ type: "text", text: `Authorized with ${access(rotation)}. Two issues.` }] };
				return Response.json({ jsonrpc: "2.0", id: data.id, result });
			}
			case "/discover":
				routes.push("resource metadata");
				return Response.json({ resource: resource.href, authorization_servers: [issuer.href] });
			case "/.well-known/oauth-authorization-server/issuer":
				routes.push("authorization metadata");
				return Response.json({
					issuer: issuer.href, authorization_endpoint: `${url.origin}/authorize`,
					token_endpoint: `${url.origin}/token`, registration_endpoint: `${url.origin}/register`,
					response_types_supported: ["code"], code_challenge_methods_supported: ["S256"],
					token_endpoint_auth_methods_supported: ["none"],
				});
			case "/register": {
				routes.push("registration");
				const data = await request.json();
				registration = data.redirect_uris[0];
				if (data.token_endpoint_auth_method !== "none" || !data.grant_types.includes("refresh_token"))
					return new Response(null, { status: 400 });
				return Response.json({ client_id: "fixture-client", ...data }, { status: 201 });
			}
			case "/authorize": {
				routes.push("authorize");
				const params = url.searchParams;
				if (params.get("client_id") !== "fixture-client" || params.get("redirect_uri") !== registration
					|| params.get("scope") !== "read write" || params.get("resource") !== resource.href
					|| params.get("code_challenge_method") !== "S256") return new Response(null, { status: 400 });
				challenge = params.get("code_challenge");
				const callback = new URL(params.get("redirect_uri") ?? "");
				callback.search = new URLSearchParams({ code: "fixture-code", state: params.get("state") ?? "" }).toString();
				redirect = callback.href;
				return Response.redirect(callback);
			}
			case "/token": {
				const form = await request.formData();
				if (form.get("client_id") !== "fixture-client" || form.get("resource") !== resource.href)
					return new Response(null, { status: 400 });
				if (form.get("grant_type") === "authorization_code") {
					routes.push("exchange");
					const verifier = String(form.get("code_verifier"));
					if (form.get("code") !== "fixture-code" || form.get("redirect_uri") !== registration
						|| createHash("sha256").update(verifier).digest("base64url") !== challenge)
						return new Response(null, { status: 400 });
				} else {
					routes.push("refresh");
					refreshing.resolve();
					if (waiting) await hold.promise;
					if (refreshFailure) {
						return Response.json({ error: refreshFailure.code, error_description: String(form.get("refresh_token")) }, { status: refreshFailure.status });
					}
					if (form.get("refresh_token") !== refreshToken(rotation)) {
						return Response.json({ error: "invalid_grant", error_description: String(form.get("refresh_token")) }, { status: 400 });
					}
					rotation++;
				}
				return Response.json({
					access_token: access(rotation), refresh_token: refreshToken(rotation), token_type: "Bearer",
					expires_in: rotation === 0 ? expiresIn : 3600,
				});
			}
			default:
				return new Response(null, { status: 404 });
		}
	});
	const stopRemote = () => remoteStop ??= Promise.resolve(server.stop(true));
	const plugin = PluginManifest.parse({
		manifest: { name: "fixture", description: "Local OAuth fixture", apiKey: { fixture: "FIXTURE_API_KEY" } },
		mcp: { fixture: { type: "http", url: new URL("/mcp", server.url).href } },
	});
	const endpoint = plugin.oauth.get("fixture");
	if (!endpoint) throw new Error("Fixture requires OAuth");
	const oauth = new PluginOAuth([plugin]);
	const logs: unknown[] = [];
	const log: Log = (level, event, fields) => { logs.push({ level, event, fields }); };
	let changes = 0;
	const changed = () => { changes++; };
	const home = await mkdtemp(join(tmpdir(), "plugin-oauth-"));
	const previous = { home: config.home, port: config.port };
	Object.assign(config, { home });
	const owner = serveOAuthFixture(async request => {
		const url = new URL(request.url);
		if (url.pathname === "/callback") return oauth.callback(request, changed, log);
		if (url.pathname !== PLUGIN_REFRESH_PATH || !authorizePluginRefresh(request, url))
			return new Response(null, { status: 403 });
		if (++requests === 2) hold.resolve();
		try {
			await oauth.refresh(url.searchParams.get("plugin") ?? "", url.searchParams.get("server") ?? "",
				url.searchParams.get("rejected") ?? undefined, changed, log);
			return new Response(null, { status: 204 });
		} catch {
			return new Response(null, { status: 401 });
		} finally {
			if (++refreshReplies === 2) refreshesSettled.resolve();
		}
	});
	config.port = owner.port!;
	return {
		routes, endpoint, plugin, log, logs,
		changes: () => changes, refreshRequests: () => requests,
		refreshesSettled: refreshesSettled.promise,
		pauseRefresh() {
			waiting = true;
			return { started: refreshing.promise, release: hold.resolve };
		},
		pauseEventStream() {
			holdGet = true;
			return { started: getStarted.promise, resume: resumeGet.resolve };
		},
		rejectAccess: () => { rejectAccess = true; },
		failRefresh: (status: number, code: string) => { refreshFailure = { status, code }; },
		allowRefresh: () => { refreshFailure = undefined; },
		stopRemote,
		signIn: () => oauth.signIn(plugin.name, config.port, changed),
		signOut: () => oauth.signOut(plugin.name, changed),
		settings: () => pluginSettings(plugin, true, true, oauth),
		async authorize(url: string) {
			const response = await fetch(url, { redirect: "manual" });
			expect(response.status).toBe(302);
			if (!redirect) throw new Error("The server did not return a callback");
			return new URL(redirect);
		},
		async complete() {
			const callback = await this.authorize((await this.signIn()).url);
			expect((await fetch(callback)).status).toBe(200);
		},
		async connect() {
			const client = new Client({ name: "fixture-worker", version: "1" });
			try {
				await client.connect(new StreamableHTTPClientTransport(endpoint.url, pluginOAuthTransport(endpoint)));
				return client;
			} catch (error) {
				await client.close();
				throw error;
			}
		},
		async close() {
			try {
				await oauth.signOut(plugin.name, changed);
			} finally {
				await Promise.all([owner.stop(true), stopRemote()]);
				Object.assign(config, previous);
				await rm(home, { recursive: true, force: true });
			}
		},
	};
}

// The browser round trip crosses both HTTP servers and the keychain boundary before an agent can call a tool.
test("discovery, shared sign-in, PKCE, and the first authenticated tool call", async () => {
	const f = await fixture();
	try {
		const [first, second] = await Promise.all([f.signIn(), f.signIn()]);
		expect(second).toEqual(first);
		expect(await f.signIn()).toEqual(first);
		expect(f.routes).toEqual(["401", "resource metadata", "authorization metadata", "registration"]);
		expect((await readSession(f.endpoint))?.kind).toBe("pending");
		expect((await f.settings()).signIn).toEqual({ signedIn: false });
		const callback = await f.authorize(first.url);
		expect(await (await fetch(callback)).text()).toBe("Signed in. You can close this tab.");
		expect(f.routes).toEqual(["401", "resource metadata", "authorization metadata", "registration", "authorize", "exchange"]);
		expect(f.changes()).toBe(1);
		expect((await f.settings()).signIn).toEqual({ signedIn: true });
		const client = await f.connect();
		try {
			expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(["list_issues"]);
			expect((await client.callTool({ name: "list_issues", arguments: {} })).content).toEqual([
				{ type: "text", text: "Authorized with [redacted]. Two issues." },
			]);
		} finally {
			await client.close();
		}
		const state = await readSession(f.endpoint);
		expect(state?.kind === "signed-in" && state.tokens.access_token).toBe(access(0));
		expect(await readSession({ ...f.endpoint, url: new URL("/different-mcp", f.endpoint.url) })).toBeUndefined();
		expect(JSON.stringify(await f.settings())).not.toContain(access(0));
		expect(JSON.stringify(await f.settings())).not.toContain(refreshToken(0));
		expect(Object.values(process.env)).not.toContain(access(0));
		expect(Object.values(process.env)).not.toContain(refreshToken(0));
	} finally {
		await f.close();
	}
});

// A foreign or replayed callback must be rejected before the token endpoint receives the code.
test("mismatched state cannot exchange a code or consume the valid callback", async () => {
	const f = await fixture();
	try {
		const callback = await f.authorize((await f.signIn()).url);
		const mismatch = new URL(callback);
		mismatch.searchParams.set("state", "wrong-state");
		expect((await fetch(mismatch)).status).toBe(400);
		expect(f.routes.at(-1)).toBe("authorize");
		expect((await f.settings()).signIn).toEqual({ signedIn: false });
		expect((await fetch(callback)).status).toBe(200);
		expect((await fetch(callback)).status).toBe(400);
		expect(f.routes.filter(route => route === "exchange")).toEqual(["exchange"]);
	} finally {
		await f.close();
	}
});

// Separate clients asking the host at the same time must observe the same persisted rotating grant.
test("concurrent requests refresh the expired token exactly once and persist its replacement", async () => {
	const f = await fixture(0);
	try {
		await f.complete();
		f.pauseRefresh();
		const clients = await Promise.all([f.connect(), f.connect()]);
		try {
			expect(f.refreshRequests()).toBe(2);
			expect(f.routes.filter(route => route === "refresh")).toEqual(["refresh"]);
			const state = await readSession(f.endpoint);
			expect(state?.kind === "signed-in" && [state.tokens.access_token, state.tokens.refresh_token]).toEqual([
				access(1), refreshToken(1),
			]);
			for (const client of clients) expect((await client.listTools()).tools[0]?.name).toBe("list_issues");
		} finally {
			await Promise.all(clients.map(client => client.close()));
		}
	} finally {
		await f.close();
	}
});

// A server can revoke a token before its advertised expiry, so the SDK's unauthorized retry must use Keychain again.
test("a 401 on an active transport retries with the host's replacement access token", async () => {
	const f = await fixture();
	try {
		await f.complete();
		const stream = f.pauseEventStream();
		const client = await f.connect();
		try {
			await stream.started;
			f.rejectAccess();
			f.pauseRefresh();
			stream.resume();
			expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(["list_issues"]);
			await f.refreshesSettled;
			expect(f.refreshRequests()).toBe(2);
			expect(f.routes.filter(route => route === "refresh")).toEqual(["refresh"]);
			const saved = await readSession(f.endpoint);
			expect(saved?.kind === "signed-in" && saved.tokens.refresh_token).toBe(refreshToken(1));
		} finally {
			stream.resume();
			await client.close();
		}
	} finally {
		await f.close();
	}
});

// A token endpoint can finish after sign-out, so a late rotation must never restore the deleted session.
test("sign-out discards a refresh already in flight", async () => {
	const f = await fixture(0);
	try {
		await f.complete();
		const { started, release } = f.pauseRefresh();
		const connection = f.connect();
		const result = connection.then(() => "connected", () => "rejected");
		await started;
		try {
			await f.signOut();
		} finally {
			release();
		}
		expect(await result).toBe("rejected");
		expect(f.routes.at(-1)).toBe("refresh");
		expect((await f.settings()).signIn).toEqual({ signedIn: false });
		expect(await readSession(f.endpoint)).toBeUndefined();
	} finally {
		await f.close();
	}
});

// A definitive refusal must clear Keychain and keep credential echoes out of diagnostics.
test.each([
	{ status: 400, code: "invalid_grant" },
	{ status: 401, code: "invalid_client" },
])("a $code refresh refusal removes the saved sign-in", async ({ status, code }) => {
	const f = await fixture(0);
	const warnings = spyOn(console, "warn");
	const registry = createRegistry();
	const worker = pluginTools(f.log, [f.plugin], () => ({ fixture: true }), async () => undefined);
	try {
		await f.complete();
		f.failRefresh(status, code);
		await worker.refresh(registry);
		expect(registry.snapshot().tools()).toEqual([]);
		expect(await readSession(f.endpoint)).toBeUndefined();
		expect((await f.settings()).signIn).toEqual({ signedIn: false, error: "Plugin sign-in expired. Sign in again." });
		expect(f.logs).toEqual([
			{ level: "warn", event: "plugin.refresh.failed", fields: { plugin: "fixture", server: "fixture" } },
			{ level: "warn", event: "plugin.sign-in.unavailable", fields: { plugin: "fixture", server: "fixture" } },
		]);
		for (const secret of [access(0), refreshToken(0)]) {
			expect(JSON.stringify(await f.settings())).not.toContain(secret);
			expect(JSON.stringify(warnings.mock.calls)).not.toContain(secret);
		}
	} finally {
		warnings.mockRestore();
		await worker.close();
		await f.close();
	}
});

// A temporary outage must leave the original grant available for the next request to rotate.
test.each([503, 429])("HTTP %i preserves sign-in and a later request recovers", async status => {
	const f = await fixture(0);
	const registry = createRegistry();
	const worker = pluginTools(f.log, [f.plugin], () => ({ fixture: true }), async () => undefined);
	try {
		await f.complete();
		const before = await readSession(f.endpoint);
		expect(before?.kind === "signed-in" && before.tokens.refresh_token).toBe(refreshToken(0));
		f.failRefresh(status, "invalid_grant");
		await worker.refresh(registry);
		expect(registry.snapshot().tools()).toEqual([]);
		expect(await readSession(f.endpoint)).toEqual(before);
		expect((await f.settings()).signIn).toEqual({ signedIn: true });
		f.allowRefresh();
		await worker.refresh(registry);
		expect(registry.snapshot().tools().map(({ tool }) => tool.name)).toEqual(["fixture_list_issues"]);
		const saved = await readSession(f.endpoint);
		expect(saved?.kind === "signed-in" && saved.tokens.refresh_token).toBe(refreshToken(1));
		expect(f.routes.filter(route => route === "refresh")).toEqual(["refresh", "refresh"]);
	} finally {
		await worker.close();
		await f.close();
	}
});

// A lost authorization-server listener never gives an OAuth refusal and cannot clear Keychain.
test("a refresh network failure preserves the signed-in session", async () => {
	const f = await fixture(0);
	try {
		await f.complete();
		const before = await readSession(f.endpoint);
		expect(before?.kind === "signed-in" && before.tokens.refresh_token).toBe(refreshToken(0));
		await f.stopRemote();
		await expect(f.connect()).rejects.toThrow();
		expect(await readSession(f.endpoint)).toEqual(before);
		expect((await f.settings()).signIn).toEqual({ signedIn: true });
	} finally {
		await f.close();
	}
});

// Sign-out clears both forms of stored OAuth data and a saved fallback stays an explicit choice.
test("sign-out removes pending and signed-in credentials and only a configured key restores tools", async () => {
	const f = await fixture();
	const registry = createRegistry();
	let key: string | undefined;
	const worker = pluginTools(f.log, [f.plugin], () => ({ fixture: true }), async () => key);
	const account = { service: config.keychain, name: oauthAccount(f.endpoint) };
	try {
		const callback = await f.authorize((await f.signIn()).url);
		expect((await readSession(f.endpoint))?.kind).toBe("pending");
		await f.signOut();
		expect(await Bun.secrets.get(account)).toBeNull();
		expect((await fetch(callback)).status).toBe(400);
		await f.complete();
		await worker.refresh(registry);
		expect(registry.snapshot().tools().map(({ tool }) => tool.name)).toEqual(["fixture_list_issues"]);
		await f.signOut();
		expect(await Bun.secrets.get(account)).toBeNull();
		await worker.refresh(registry);
		expect(registry.snapshot().tools()).toEqual([]);
		key = "fixture-api-key";
		await worker.refresh(registry);
		expect(registry.snapshot().tools().map(({ tool }) => tool.name)).toEqual(["fixture_list_issues"]);
		expect((await f.settings()).signIn).toEqual({ signedIn: false });
	} finally {
		await worker.close();
		await f.close();
	}
});
