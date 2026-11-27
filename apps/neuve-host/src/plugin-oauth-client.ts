import { createHmac, timingSafeEqual } from "node:crypto";

import { Client, StreamableHTTPClientTransport, UnauthorizedError } from "@modelcontextprotocol/client";

import { token } from "./auth";
import { config } from "./config";
import { key } from "./keys";
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

async function oauthAccessToken(server: OAuthServer): Promise<string | undefined> {
	let saved = await readSession(server);
	if (saved?.kind === "signed-in" && expired(saved)) {
		await refresh(server);
		saved = await readSession(server, true);
	}
	return saved?.kind === "signed-in" && !expired(saved) ? saved.tokens.access_token : undefined;
}

type Credential = { kind: "oauth"; value: string } | { kind: "api-key"; name: string; value: string };

export async function pluginCredential(server: OAuthServer, lookup = key): Promise<Credential | undefined> {
	const token = await oauthAccessToken(server);
	if (token) return { kind: "oauth", value: token };
	if (!server.apiKey) return;
	const fallback = await lookup(server.apiKey);
	if (fallback) return { kind: "api-key", name: server.apiKey, value: fallback };
}

export function pluginMcp(
	server: OAuthServer, lookup = key, info: ConstructorParameters<typeof Client>[0] = { name: "ace", version: "1" },
): { client: Client; transport: StreamableHTTPClientTransport } {
	const sent = new Map<string, Credential["kind"]>();
	const rejected = new WeakMap<Response, string>();
	const mask = (value: string) => {
		for (const secret of sent.keys()) value = value.replaceAll(secret, "[redacted]");
		return value;
	};
	function maskObject(value: object): Record<string, unknown> {
		return Object.fromEntries(Object.entries(value).map(([name, field]) => [mask(name), maskValue(field)]));
	}
	function maskValue(value: unknown): unknown {
		if (typeof value === "string") return maskText(value);
		if (Array.isArray(value)) return value.map(maskValue);
		if (value !== null && typeof value === "object") return maskObject(value);
		return value;
	}
	function maskText(text: string): string {
		if (sent.has(text)) return "[redacted]";
		if (/^\s*[[{]/.test(text)) {
			try {
				const value: unknown = JSON.parse(text);
				const decoded = JSON.stringify(value);
				const masked = JSON.stringify(maskValue(value));
				return decoded === masked ? text : masked;
			} catch {
				// This text block does not contain a JSON value.
			}
		}
		return mask(text);
	}
	function exposesSecret(value: unknown): boolean {
		if (typeof value === "string") return mask(value) !== value;
		return value !== null && typeof value === "object"
			&& Object.entries(value).some(([name, field]) => mask(name) !== name || exposesSecret(field));
	}
	const client = new (class extends Client {
		override async listTools(...args: Parameters<Client["listTools"]>) {
			const result = await super.listTools(...args);
			return {
				...result,
				tools: result.tools.filter(tool => !exposesSecret(tool.name) && !exposesSecret(tool.inputSchema))
					.map(tool => ({ ...tool, description: tool.description && mask(tool.description) })),
			};
		}
		override async callTool(...args: Parameters<Client["callTool"]>) {
			const result = await super.callTool(...args);
			return {
				...result,
				content: result.content?.map(block => block.type === "text" ? { ...block, text: maskText(block.text) } : block),
				structuredContent: result.structuredContent && maskObject(result.structuredContent),
			};
		}
	})(info);
	const transport = new StreamableHTTPClientTransport(server.url, {
		requestInit: { headers: server.headers },
		authProvider: {
			async token() {
				const credential = await pluginCredential(server, lookup);
				if (!credential) throw new UnauthorizedError();
				sent.set(credential.value, credential.kind);
				return credential.value;
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
			if (response.status === 401 && bearer && sent.get(bearer) === "oauth")
				rejected.set(response, fingerprint(bearer));
			return response;
		},
	});
	return { client, transport };
}
