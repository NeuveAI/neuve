import { randomBytes } from "node:crypto";

import type { Log } from "@ace/channel";
import {
	auth, Client, extractWWWAuthenticateParams, refreshAuthorization, StreamableHTTPClientTransport,
	UnauthorizedError, type AuthOptions, type FetchLike, type OAuthClientProvider, type OAuthDiscoveryState,
	type StoredOAuthClientInformation,
} from "@modelcontextprotocol/client";
import { SharedWork } from "@neuve/records-core/shared-work";

import { forget, peek } from "./keys";
import { carriedPlugins, loopback, type OAuthServer, type Plugin } from "./plugin-manifest";
import {
	expired, fingerprint, oauthAccount, parseSession, readSession, saveSession, signedIn,
	type OAuthSession,
} from "./plugin-oauth-store";
import type { PluginSettings } from "./protocol";

const request = globalThis.fetch;
const timeout = 15_000;
const signInFailed = "Plugin sign-in failed. Try again.";
const refreshFailed = "Plugin sign-in expired. Sign in again.";

class GrantRefused extends Error {}

type Session = {
	server: OAuthServer;
	lifetime: AbortController;
	write?: Promise<void>;
	error?: string;
};

type Attempt = {
	session: Session;
	state: string;
	lifetime: AbortSignal;
	timer?: ReturnType<typeof setTimeout>;
	transport?: StreamableHTTPClientTransport;
	url?: string;
};

function checkEndpoint(server: OAuthServer, url: URL): void {
	if (url.username || url.password || (loopback(server.url)
		? !loopback(url) || !["http:", "https:"].includes(url.protocol)
		: url.protocol !== "https:" || loopback(url))) {
		throw new Error("Invalid plugin OAuth endpoint");
	}
}

function oauthFetch(server: OAuthServer, lifetime: AbortSignal, probe = false): FetchLike {
	return async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : input);
		checkEndpoint(server, url);
		const signals = [lifetime, AbortSignal.timeout(timeout)];
		if (init?.signal) signals.push(init.signal);
		const response = await request(input, { ...init, redirect: "manual", signal: AbortSignal.any(signals) });
		if (!probe && init?.method === "POST" && (response.status < 300 || response.status >= 400)) {
			// SDK auth diagnostics can include the authorization server's error description.
			if (!response.ok) {
				if (response.status === 400 || response.status === 401) {
					const body: unknown = await response.json().catch(() => null);
					if (body && typeof body === "object" && "error" in body
						&& (body.error === "invalid_grant" || body.error === "invalid_client")) {
						throw new GrantRefused();
					}
				} else {
					await response.body?.cancel();
				}
				throw new Error("The plugin authorization server rejected the request");
			}
			const body: unknown = await response.json();
			if (body && typeof body === "object" && "error" in body) {
				throw new Error("The plugin authorization server rejected the request");
			}
			return Response.json(body);
		}
		return response;
	};
}

function callbackPage(message: string, status = 200): Response {
	return new Response(message, {
		status,
		headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" },
	});
}

export class PluginOAuth {
	private readonly plugins: Map<string, Session[]>;
	private readonly attempts = new Map<string, Attempt>();
	private readonly starting = new SharedWork<{ url: string }>();
	private readonly work = new SharedWork<void>();

	constructor(plugins: readonly Plugin[] = carriedPlugins) {
		this.plugins = new Map(plugins.map(plugin => [
			plugin.name, [...plugin.oauth.values()].map(server => ({ server, lifetime: new AbortController() })),
		]));
	}

	async status(plugin: Plugin, fresh?: boolean): Promise<PluginSettings["signIn"]> {
		const sessions = this.plugins.get(plugin.name);
		if (!sessions?.length) return;
		const statuses = await Promise.all(sessions.map(async ({ server, error }) => {
			const saved = await peek(oauthAccount(server), fresh);
			try {
				const value = parseSession(server, saved?.value);
				return {
					signedIn: !error && value?.kind === "signed-in" && (!expired(value) || !!value.tokens.refresh_token),
					error: error ?? saved?.error,
				};
			} catch {
				return { signedIn: false, error: "The saved plugin sign-in is unreadable. Sign out and try again." };
			}
		}));
		const error = statuses.find(status => status.error)?.error;
		return { signedIn: statuses.every(status => status.signedIn), ...(error ? { error } : {}) };
	}

	async signIn(plugin: string, port: number, changed: () => void): Promise<{ url: string }> {
		const sessions = this.requirePlugin(plugin);
		const { outcome } = await this.starting.run({ scope: "sign-in", key: plugin, run: async () => {
			const existing = this.attempts.get(plugin);
			if (existing?.url) return { kind: "succeeded", value: { url: existing.url } };
			for (const session of sessions) {
				const lifetime = session.lifetime.signal;
				try {
					lifetime.throwIfAborted();
					const value = await readSession(session.server);
					lifetime.throwIfAborted();
					if (value?.kind === "signed-in" && (!expired(value) || value.tokens.refresh_token)) continue;
					await session.write?.catch(() => undefined);
					const url = await this.begin(session, lifetime, port, changed);
					return { kind: "succeeded", value: { url } };
				} catch {
					throw new Error(signInFailed);
				}
			}
			throw new Error("This plugin is already signed in.");
		} });
		if (outcome.kind !== "succeeded") throw new Error(signInFailed);
		return outcome.value;
	}

	private async begin(session: Session, lifetime: AbortSignal, port: number, changed: () => void): Promise<string> {
		lifetime.throwIfAborted();
		const { server } = session;
		const state = randomBytes(32).toString("hex");
		const redirectUrl = new URL(`http://127.0.0.1:${port}/callback`);
		const attempt: Attempt = { session, state, lifetime };
		this.attempts.set(server.plugin, attempt);
		const fetch = oauthFetch(server, lifetime);
		let challenge: Pick<AuthOptions, "resourceMetadataUrl" | "scope"> | undefined;
		let client: StoredOAuthClientInformation | undefined;
		let discovery: OAuthDiscoveryState | undefined;
		let resource: string | undefined;
		let verifier: string | undefined;

		const provider: OAuthClientProvider = {
			redirectUrl,
			clientMetadata: {
				client_name: "Ace", redirect_uris: [redirectUrl.href], response_types: ["code"],
				grant_types: ["authorization_code", "refresh_token"], token_endpoint_auth_method: "none",
			},
			state: () => state,
			clientInformation: () => client,
			saveClientInformation: value => { client = value; },
			discoveryState: () => discovery,
			saveDiscoveryState: value => { discovery = value; },
			saveResourceUrl: value => { resource = value; },
			tokens: () => undefined,
			saveTokens: async value => {
				if (!client || !discovery) throw new Error(signInFailed);
				await this.persist(session, lifetime, signedIn({ client, discovery, resource }, value));
			},
			codeVerifier: async () => {
				const saved = await readSession(server);
				if (saved?.kind !== "pending" || saved.verifier !== verifier) throw new Error(signInFailed);
				return saved.verifier;
			},
			saveCodeVerifier: value => { verifier = value; },
			redirectToAuthorization: url => {
				checkEndpoint(server, url);
				attempt.url = url.href;
			},
		};

		const probe = new Client({ name: "ace", version: "1" });
		try {
			await probe.connect(new StreamableHTTPClientTransport(server.url, {
				fetch: oauthFetch(server, lifetime, true),
				requestInit: { headers: server.headers },
				authProvider: { token: async () => undefined, onUnauthorized: async ({ response }) => {
					challenge = extractWWWAuthenticateParams(response);
					await response.body?.cancel();
					throw new UnauthorizedError();
				} },
			}), { timeout }).catch(error => {
				if (!challenge || !(error instanceof UnauthorizedError)) throw error;
			});
			if (!challenge) throw new Error(signInFailed);
			const result = await auth(provider, { serverUrl: server.url, ...challenge, fetchFn: fetch });
			if (result !== "REDIRECT" || !attempt.url || !client || !discovery || !verifier) throw new Error(signInFailed);
			await this.persist(session, lifetime, { kind: "pending", client, discovery, resource, verifier });
			lifetime.throwIfAborted();
			attempt.transport = new StreamableHTTPClientTransport(server.url, { authProvider: provider, fetch });
			attempt.timer = setTimeout(() => {
				this.attempts.delete(server.plugin);
				session.error = "Plugin sign-in timed out. Try again.";
				void this.remove(session, lifetime).catch(() => undefined).finally(changed);
			}, 5 * 60_000).unref();
			session.error = undefined;
			return attempt.url;
		} catch {
			if (this.attempts.get(server.plugin) === attempt) this.attempts.delete(server.plugin);
			if (!lifetime.aborted) {
				session.error = signInFailed;
				changed();
			}
			throw new Error(signInFailed);
		} finally {
			await probe.close().catch(() => undefined);
		}
	}

	async callback(request: Request, changed: () => void, log: Log): Promise<Response> {
		const params = new URL(request.url).searchParams;
		const state = params.get("state");
		const attempt = state && [...this.attempts.values()].find(item => item.state === state);
		if (request.method !== "GET" || !attempt || !attempt.transport || params.getAll("state").length !== 1) {
			return callbackPage("Invalid or expired plugin sign-in. Return to Ace to try again.", 400);
		}
		const { session, lifetime, transport, timer } = attempt;
		attempt.transport = undefined;
		clearTimeout(timer);
		try {
			if (params.has("error") || params.getAll("code").length !== 1 || !params.get("code") || params.getAll("iss").length > 1)
				throw new Error(signInFailed);
			await transport.finishAuth(params);
			lifetime.throwIfAborted();
			changed();
			return callbackPage("Signed in. You can close this tab.");
		} catch {
			if (!lifetime.aborted) {
				session.error = signInFailed;
				log("warn", "plugin.sign-in.failed", { plugin: session.server.plugin, server: session.server.name });
				await this.remove(session, lifetime).catch(() => undefined);
				changed();
			}
			return callbackPage("Plugin sign-in failed. Return to Ace to try again.", 400);
		} finally {
			if (this.attempts.get(session.server.plugin) === attempt) this.attempts.delete(session.server.plugin);
		}
	}

	async signOut(plugin: string, changed: () => void): Promise<void> {
		const sessions = this.requirePlugin(plugin);
		await this.work.run({ scope: "sign-out", key: plugin, run: async () => {
			const attempt = this.attempts.get(plugin);
			if (attempt) {
				clearTimeout(attempt.timer);
				this.attempts.delete(plugin);
			}
			for (const session of sessions) session.lifetime.abort();
			const removals = await Promise.allSettled(sessions.map(async session => {
				await session.write?.catch(() => undefined);
				await forget(oauthAccount(session.server));
				session.error = undefined;
			}));
			for (const session of sessions) session.lifetime = new AbortController();
			changed();
			if (removals.some(result => result.status === "rejected"))
				throw new Error("Could not remove plugin sign-in from the keychain. Try again.");
			return { kind: "succeeded", value: undefined };
		} });
	}

	async refresh(plugin: string, name: string, rejected: string | undefined, changed: () => void, log: Log): Promise<void> {
		const session = this.plugins.get(plugin)?.find(item => item.server.name === name);
		if (!session) throw new UnauthorizedError();
		const { server, lifetime: { signal } } = session;
		await this.work.run({ scope: "refresh", key: oauthAccount(server), run: async () => {
			signal.throwIfAborted();
			const value = await readSession(server);
			if (value?.kind !== "signed-in" || this.attempts.get(plugin)?.session === session) throw new UnauthorizedError();
			const needsRefresh = expired(value) || (rejected !== undefined && rejected === fingerprint(value.tokens.access_token));
			if (needsRefresh) {
				try {
					const { client, discovery, resource, tokens } = value;
					if (!tokens.refresh_token) throw new UnauthorizedError();
					const rotated = await refreshAuthorization(discovery.authorizationServerUrl, {
						metadata: discovery.authorizationServerMetadata, clientInformation: client,
						refreshToken: tokens.refresh_token, resource, fetchFn: oauthFetch(server, signal),
					});
					await this.persist(session, signal, signedIn(value, { ...rotated, issuer: tokens.issuer }));
				} catch (error) {
					signal.throwIfAborted();
					log("warn", "plugin.refresh.failed", { plugin, server: name });
					if (error instanceof GrantRefused) {
						session.error = refreshFailed;
						await this.remove(session, signal).finally(changed);
					}
					throw new UnauthorizedError();
				}
			}
			return { kind: "succeeded", value: undefined };
		} });
	}

	private requirePlugin(plugin: string): Session[] {
		const sessions = this.plugins.get(plugin);
		if (!sessions?.length) throw new Error("Choose a plugin that supports sign-in.");
		return sessions;
	}

	private persist(session: Session, signal: AbortSignal, value: OAuthSession): Promise<void> {
		signal.throwIfAborted();
		return session.write = saveSession(session.server, value);
	}

	private remove(session: Session, signal: AbortSignal): Promise<void> {
		signal.throwIfAborted();
		return session.write = forget(oauthAccount(session.server)).then(() => undefined);
	}
}

export const pluginOAuth = new PluginOAuth();
