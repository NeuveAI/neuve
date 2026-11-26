import { createHmac, timingSafeEqual } from "node:crypto";

import { UnauthorizedError, type AuthProvider, type FetchLike } from "@modelcontextprotocol/client";

import { token } from "./auth";
import { config } from "./config";
import type { OAuthServer } from "./plugin-manifest";
import { expired, fingerprint, readSession } from "./plugin-oauth-store";

export const PLUGIN_REFRESH_PATH = "/plugin-oauth/refresh";
const request = globalThis.fetch;

function refreshProof(url: URL): string {
	return createHmac("sha256", token()).update(PLUGIN_REFRESH_PATH).update(url.search).digest("hex");
}

export function authorizePluginRefresh(request: Request, url: URL): boolean {
	const supplied = request.headers.get("x-ace-plugin-refresh");
	return request.method === "POST" && !request.headers.has("origin") && !!supplied && /^[a-f0-9]{64}$/.test(supplied)
		&& timingSafeEqual(Buffer.from(supplied), Buffer.from(refreshProof(url)));
}

async function refresh({ plugin, name }: OAuthServer, rejected?: string): Promise<void> {
	const url = new URL(PLUGIN_REFRESH_PATH, `http://127.0.0.1:${config.port}`);
	url.search = new URLSearchParams({ plugin, server: name, ...(rejected ? { rejected } : {}) }).toString();
	const response = await request(url, {
		method: "POST", headers: { "x-ace-plugin-refresh": refreshProof(url) },
		redirect: "error", signal: AbortSignal.timeout(20_000),
	});
	await response.body?.cancel();
	if (!response.ok) throw new UnauthorizedError();
}

function redactBody(response: Response, bearer: string): Response {
	if (!response.body) return response;
	let carry = "";
	const body = response.body.pipeThrough(new TextDecoderStream()).pipeThrough(new TransformStream<string, string>({
		transform(chunk, controller) {
			carry += chunk;
			const end = carry.lastIndexOf("\n") + 1;
			if (!end) return;
			controller.enqueue(carry.slice(0, end).replaceAll(bearer, "[redacted]"));
			carry = carry.slice(end);
		},
		flush(controller) { controller.enqueue(carry.replaceAll(bearer, "[redacted]")); },
	})).pipeThrough(new TextEncoderStream());
	return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export async function oauthAccessToken(server: OAuthServer): Promise<string | undefined> {
	let saved = await readSession(server);
	if (saved?.kind === "signed-in" && expired(saved)) {
		await refresh(server);
		saved = await readSession(server, true);
	}
	return saved?.kind === "signed-in" && !expired(saved) ? saved.tokens.access_token : undefined;
}

export function pluginOAuthTransport(server: OAuthServer): { authProvider: AuthProvider; fetch: FetchLike } {
	const rejected = new WeakMap<Response, string>();
	return {
		authProvider: {
			async token() {
				const token = await oauthAccessToken(server);
				if (!token) throw new UnauthorizedError();
				return token;
			},
			async onUnauthorized({ response }) {
				const digest = rejected.get(response);
				if (!digest) throw new UnauthorizedError();
				await refresh(server, digest);
			},
		},
		async fetch(input, init) {
			const response = await request(input, { ...init, redirect: "error" });
			const bearer = new Headers(init?.headers).get("authorization")?.slice("Bearer ".length);
			if (!bearer) return response;
			if (response.status === 401) rejected.set(response, fingerprint(bearer));
			return response.ok ? redactBody(response, bearer) : response;
		},
	};
}
