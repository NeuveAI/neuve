import { ToolImageRequestSchema, ToolImageSchema } from "@ace/channel/parse";
import type { Request as ChannelRequest } from "@ace/channel";

export function isToolImagePath(pathname: string): boolean {
	return pathname === "/images" || pathname.startsWith("/images/");
}

export async function toolImageResponse(
	http: Request,
	pathname: string,
	read: (channel: string, request: Extract<ChannelRequest, { op: "tool-image" }>) => Promise<unknown>,
): Promise<Response> {
	if (http.method !== "GET" || http.headers.has("upgrade")) return new Response(null, { status: 405 });
	const match = /^\/images\/([0-9a-f]{16})\/(\d+)\/([^/]+)\/(\d+)$/.exec(pathname);
	if (!match) return new Response(null, { status: 404 });
	const [, channel, chat, call, index] = match;
	try {
		const request = ToolImageRequestSchema.parse({
			op: "tool-image", chat: Number(chat), call: decodeURIComponent(call), index: Number(index),
		});
		const image = ToolImageSchema.safeParse(await read(channel, request));
		if (!image.success) return new Response(null, { status: 415 });
		return new Response(Uint8Array.fromBase64(image.data.data), {
			headers: {
				"Content-Type": image.data.mimeType,
				"X-Content-Type-Options": "nosniff",
				"Content-Security-Policy": "default-src 'none'; sandbox",
				"Cross-Origin-Resource-Policy": "same-origin",
				"Cache-Control": "private, max-age=31536000, immutable",
				Vary: "Cookie, Authorization, Sec-WebSocket-Protocol, Origin",
			},
		});
	} catch {
		return new Response(null, { status: 404 });
	}
}
