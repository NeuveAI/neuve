import { randomBytes } from "node:crypto";

import type { Log } from "@ace/channel";
import {
	auth, Client, exchangeAuthorization, extractWWWAuthenticateParams, IssuerMismatchError, OAuthError,
	OAuthErrorCode, refreshAuthorization, StreamableHTTPClientTransport,
	UnauthorizedError, type AuthOptions, type FetchLike, type OAuthClientProvider, type OAuthDiscoveryState,
	type StoredOAuthClientInformation,
} from "@modelcontextprotocol/client";
import { SharedWork } from "@neuve/records-core/shared-work";
import { ZodError } from "zod";

import { forget, peek } from "./keys";
import { openBrowser } from "./open-browser";
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

const oauthErrors = new Set<string>(Object.values(OAuthErrorCode));
const callbackErrorClasses = new Set([
	"AbortError", "Error", "InsecureTokenEndpointError", "IssuerMismatchError",
	"OAuthError", "SyntaxError", "TimeoutError", "TypeError", "ZodError", "$ZodError",
]);

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
	redirectUrl: URL;
	verifier?: string;
	timer?: ReturnType<typeof setTimeout>;
	url?: string;
};

function checkEndpoint(server: OAuthServer, url: URL): void {
	if (url.username || url.password || (loopback(server.url)
		? !loopback(url) || !["http:", "https:"].includes(url.protocol)
		: url.protocol !== "https:" || loopback(url))) {
		throw new Error("Invalid plugin OAuth endpoint");
	}
}

function oauthFetch(server: OAuthServer, lifetime: AbortSignal, received?: (status: number) => void): FetchLike {
	return async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : input);
		checkEndpoint(server, url);
		const signals = [lifetime, AbortSignal.timeout(timeout)];
		if (init?.signal) signals.push(init.signal);
		const response = await request(input, { ...init, redirect: "manual", signal: AbortSignal.any(signals) });
		received?.(response.status);
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

	constructor(plugins: readonly Plugin[] = carriedPlugins, private readonly open = openBrowser) {
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

	async signIn(plugin: string, port: number, changed: () => void): Promise<{ url: string; opened: boolean }> {
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
		const { url } = outcome.value;
		return { url, opened: await this.open(url) };
	}

	private async begin(session: Session, lifetime: AbortSignal, port: number, changed: () => void): Promise<string> {
		lifetime.throwIfAborted();
		const { server } = session;
		const state = randomBytes(32).toString("hex");
		const redirectUrl = new URL(`http://127.0.0.1:${port}/callback`);
		const attempt: Attempt = { session, state, lifetime, redirectUrl };
		this.attempts.set(server.plugin, attempt);
		const fetch = oauthFetch(server, lifetime);
		let challenge: Pick<AuthOptions, "resourceMetadataUrl" | "scope"> | undefined;
		let client: StoredOAuthClientInformation | undefined;
		let discovery: OAuthDiscoveryState | undefined;
		let resource: string | undefined;

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
			saveTokens: () => { throw new Error(signInFailed); },
			codeVerifier: () => { throw new Error(signInFailed); },
			saveCodeVerifier: value => { attempt.verifier = value; },
			redirectToAuthorization: url => {
				checkEndpoint(server, url);
				attempt.url = url.href;
			},
		};

		const probe = new Client({ name: "ace", version: "1" });
		try {
			await probe.connect(new StreamableHTTPClientTransport(server.url, {
				fetch,
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
			const { verifier } = attempt;
			if (result !== "REDIRECT" || !attempt.url || !client || !discovery || !verifier) throw new Error(signInFailed);
			await this.persist(session, lifetime, { kind: "pending", client, discovery, resource, verifier });
			lifetime.throwIfAborted();
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
		if (request.method !== "GET" || !attempt || attempt.timer === undefined || params.getAll("state").length !== 1) {
			return callbackPage("Invalid or expired plugin sign-in. Return to Ace to try again.", 400);
		}
		const { session, lifetime, timer, redirectUrl } = attempt;
		const { server } = session;
		attempt.timer = undefined;
		clearTimeout(timer);
		let step = "callback-parameters";
		let httpStatus: number | null = null;
		try {
			const code = params.get("code");
			if (params.has("error") || params.getAll("code").length !== 1 || !code || params.getAll("iss").length > 1)
				throw new Error(signInFailed);
			step = "read-pending";
			lifetime.throwIfAborted();
			const pending = await readSession(server);
			step = "match-pending";
			if (pending?.kind !== "pending" || pending.verifier !== attempt.verifier)
				throw new Error(signInFailed);
			const { client, discovery, resource, verifier } = pending;
			const metadata = discovery.authorizationServerMetadata;
			const issuer = metadata?.issuer ?? discovery.authorizationServerUrl;
			if (client.issuer !== issuer) throw new Error(signInFailed);
			step = "token-request";
			// The code is single-use. The SDK's higher-level auth() retries some OAuth refusals.
			const tokens = await exchangeAuthorization(discovery.authorizationServerUrl, {
				metadata, clientInformation: client, resource, authorizationCode: code,
				iss: params.get("iss") ?? undefined, codeVerifier: verifier, redirectUri: redirectUrl,
				fetchFn: oauthFetch(server, lifetime, status => {
					step = "token-response";
					httpStatus = status;
				}),
			});
			step = "validate-tokens";
			const value = signedIn(pending, { ...tokens, issuer });
			step = "persist-tokens";
			await this.persist(session, lifetime, value);
			step = "complete-callback";
			lifetime.throwIfAborted();
			step = "notify-settings";
			changed();
			return callbackPage("Signed in. You can close this tab.");
		} catch (error) {
			log("warn", "plugin.sign-in.failed", {
				plugin: server.plugin, server: server.name,
				step: error instanceof IssuerMismatchError ? "validate-issuer" : step,
				errorClass: error instanceof Error && callbackErrorClasses.has(error.name) ? error.name : "UnknownError",
				oauthError: error instanceof OAuthError ? (oauthErrors.has(error.code) ? error.code : "other") : null,
				httpStatus,
				...(step === "validate-tokens" && error instanceof ZodError
					? { fields: error.issues.map(issue => issue.path.join(".")) }
					: {}),
			});
			if (!lifetime.aborted) {
				session.error = signInFailed;
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
				let status: number | undefined;
				try {
					const { client, discovery, resource, tokens } = value;
					if (!tokens.refresh_token) throw new UnauthorizedError();
					const rotated = await refreshAuthorization(discovery.authorizationServerUrl, {
						metadata: discovery.authorizationServerMetadata, clientInformation: client,
						refreshToken: tokens.refresh_token, resource, fetchFn: oauthFetch(server, signal, received => { status = received; }),
					});
					await this.persist(session, signal, signedIn(value, { ...rotated, issuer: tokens.issuer }));
				} catch (error) {
					signal.throwIfAborted();
					log("warn", "plugin.refresh.failed", { plugin, server: name });
					if ((status === 400 || status === 401) && error instanceof OAuthError
						&& (error.code === OAuthErrorCode.InvalidGrant || error.code === OAuthErrorCode.InvalidClient)) {
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
