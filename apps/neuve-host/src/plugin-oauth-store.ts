import { createHash } from "node:crypto";

import type { OAuthDiscoveryState, StoredOAuthTokens } from "@modelcontextprotocol/client";
import { z } from "zod";

import { keychain, store } from "./keys";
import type { OAuthServer } from "./plugin-manifest";

const client = z.object({
	client_id: z.string().min(1),
	client_secret: z.string().optional(),
	token_endpoint_auth_method: z.string().optional(),
	issuer: z.string().optional(),
}).loose();

const discovery = z.object({
	authorizationServerUrl: z.url(),
	resourceMetadataUrl: z.url().optional(),
	resourceMetadata: z.object({ resource: z.string(), scopes_supported: z.array(z.string()).optional() }).loose().optional(),
	authorizationServerMetadata: z.object({
		issuer: z.string(),
		authorization_endpoint: z.url(),
		token_endpoint: z.url(),
		response_types_supported: z.array(z.string()),
		token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
		authorization_response_iss_parameter_supported: z.boolean().optional(),
	}).loose().optional(),
}) satisfies z.ZodType<OAuthDiscoveryState>;

const registration = z.object({ client, discovery, resource: z.string().optional() });
const headerSafeToken = z.string().regex(/^[\x21-\x7E]+$/);
const tokens = z.object({
	access_token: headerSafeToken,
	refresh_token: headerSafeToken.optional(),
	token_type: z.string().regex(/^bearer$/i),
	issuer: z.string().optional(),
	scope: z.string().optional(),
	expires_in: z.number().optional(),
}) satisfies z.ZodType<StoredOAuthTokens>;

const session = z.discriminatedUnion("kind", [
	registration.extend({ kind: z.literal("pending"), verifier: z.string().min(1) }),
	registration.extend({ kind: z.literal("signed-in"), tokens, expiresAt: z.number().optional() }),
]);
const storedSession = z.object({ serverUrl: z.url(), session });

export const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex");
export const oauthAccount = ({ plugin, name }: OAuthServer) => `plugin-oauth:${plugin}:${name}`;

export function parseSession(server: OAuthServer, value: string | undefined) {
	if (value === undefined) return undefined;
	try {
		const result = storedSession.safeParse(JSON.parse(value));
		if (result.success) return result.data.serverUrl === server.url.href ? result.data.session : undefined;
	} catch {}
	throw new Error("The saved plugin sign-in is unreadable. Sign out and try again.");
}

export type OAuthSession = z.output<typeof session>;
export type Registration = z.output<typeof registration>;
export type SignedIn = Extract<OAuthSession, { kind: "signed-in" }>;

export const readSession = async (server: OAuthServer, fresh?: boolean) =>
	parseSession(server, await keychain(oauthAccount(server), fresh));
export const saveSession = (server: OAuthServer, value: OAuthSession) =>
	store(oauthAccount(server), JSON.stringify({ serverUrl: server.url.href, session: value }));

export function signedIn(registration: Registration, value: StoredOAuthTokens): SignedIn {
	const credentials = tokens.parse(value);
	return {
		client: registration.client, discovery: registration.discovery, resource: registration.resource,
		kind: "signed-in", tokens: credentials,
		expiresAt: credentials.expires_in === undefined ? undefined : Date.now() + credentials.expires_in * 1000,
	};
}

export const expired = (session: SignedIn) => session.expiresAt !== undefined && Date.now() >= session.expiresAt;
