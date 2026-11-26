import "./memory-secrets";

type Handler = (request: Request) => Response | Promise<Response>;

const routes = new Map<string, Handler>();
let port = 30_000;
const inProcess = process.env.NEUVE_OAUTH_TEST_TRANSPORT === "in-process";

if (inProcess) {
	const fetch = globalThis.fetch;
	globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
		const request = new Request(input, init);
		const handler = routes.get(new URL(request.url).origin);
		if (!handler) return fetch(input, init);
		request.signal.throwIfAborted();
		return handler(request);
	}, fetch);
}

export function serveOAuthFixture(fetch: Handler) {
	if (!inProcess) return Bun.serve({ port: 0, hostname: "127.0.0.1", fetch });
	const url = new URL(`http://127.0.0.1:${++port}`);
	routes.set(url.origin, fetch);
	return { url, port, stop: () => { routes.delete(url.origin); } };
}
