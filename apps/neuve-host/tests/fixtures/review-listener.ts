import "./memory-secrets";
import { mock } from "bun:test";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.ACE_HOME;
if (!root) throw new Error("The review listener fixture needs its disposable home");
const mode = process.argv[2];
const machine = { name: "fixture", dns: "fixture.test", address: "::1", login: "owner" };
mock.module("../../src/tailnet", () => ({
	identity: () => ({ login: "owner", tailnet: "fixture.test" }),
	self: async () => machine,
	watch: () => () => {},
	whois: async (address: string, port: number) => {
		appendFileSync(join(root, "whois.jsonl"), `${JSON.stringify({ address, port })}\n`);
		const caller = readFileSync(join(root, "caller"), "utf8");
		if (caller === "unavailable") throw new Error("Fixture cannot identify this caller");
		return { login: caller, host: "fixture-client" };
	},
	peers: async () => [],
	certificate: async () => ({ cert: join(root, "cert.pem"), key: join(root, "key.pem") }),
}));
const github = await import("../../src/github");
mock.module("../../src/github", () => ({ ...github, login: () => undefined }));
const { config } = await import("../../src/config");
config.helper = true;
config.app = root;
config.webPort = 0;
const catalog = await import("../../src/catalog");
catalog.bind({ home: root, user: "owner", local: mode === "loopback" });
const { configureReviewRoutes, reviewBase, serveCodingUi } = await import("../../src/app-gateway");
const base = reviewBase("/fixture/project");
const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request, server) {
	const url = new URL(request.url);
	if (url.pathname === `${base}_serverFn/slow`) {
		server.timeout(request, 120);
		await Bun.sleep(15_000);
	}
	if (url.pathname === `${base}api/events`) {
		server.timeout(request, 0);
		let timer: ReturnType<typeof setTimeout>;
		return new Response(new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("data: started\n\n"));
				timer = setTimeout(() => {
					controller.enqueue(new TextEncoder().encode("data: still open\n\n"));
					controller.close();
				}, 31_000);
			},
			cancel() { clearTimeout(timer); },
		}), { headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
	}
	const value = { method: request.method, path: url.pathname + url.search, body: await request.text(), headers: Object.fromEntries(request.headers) };
	appendFileSync(join(root, "upstream.jsonl"), `${JSON.stringify(value)}\n`);
	return Response.json(value);
} });
configureReviewRoutes(async (key) => {
	if (existsSync(join(root, "slow-resolver"))) await Bun.sleep(15_000);
	appendFileSync(join(root, "resolved.jsonl"), `${JSON.stringify({ key })}\n`);
	return `/review/${key}/` === base ? `http://127.0.0.1:${upstream.port}${base}` : undefined;
});
const gateway = await import("../../src/gateway");
let started: Awaited<ReturnType<typeof gateway.start>> | undefined;
let coding: Awaited<ReturnType<typeof serveCodingUi>> | undefined;
try {
	started = await gateway.start(0, mode === "loopback", undefined, true);
	const web = await import("../../src/web");
	const port = started.server.port;
	coding = await serveCodingUi({ directory: root, port: 0, host: { url: `ws://127.0.0.1:${port}/ws`, token: "a".repeat(64) } });
	writeFileSync(join(root, "ready.json"), JSON.stringify({
		coding: coding.url,
		owner: `http://127.0.0.1:${port}`,
		plain: `http://[::1]:${port}`,
		plainAuthority: `http://fixture.test:${port}`,
		tls: web.address?.replace("fixture.test", "[::1]"),
		tlsAuthority: web.address,
		base,
	}));
	while (!existsSync(join(root, "finish"))) await Bun.sleep(10);
} finally {
	configureReviewRoutes(undefined);
	await coding?.close();
	await started?.stop();
	await upstream.stop(true);
}
