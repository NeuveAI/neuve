import "./fixtures/memory-secrets";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureReviewRoutes, reviewBase, reviewPaths, reviewRequest, serveCodingUi } from "../src/app-gateway";

const cycle = "01K90000000000000000000000";
const project = "/work/route fixture";
const base = reviewBase(project);
const stops: Array<() => Promise<void>> = [];
afterEach(async () => {
	configureReviewRoutes(undefined);
	for (const stop of stops.splice(0).reverse()) await stop();
});

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "review-route-"));
	stops.push(() => rm(directory, { recursive: true, force: true }));
	await writeFile(join(directory, "index.html"), "<title>Coding home</title>");
	const requests: Array<{ path: string; method: string; body: string; headers: Record<string, string> }> = [];
	const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
		const url = new URL(request.url);
		requests.push({ path: url.pathname + url.search, method: request.method, body: await request.text(), headers: Object.fromEntries(request.headers) });
		if (url.pathname.endsWith("/redirect")) return Response.redirect(`${url.origin}${base}cycles/${cycle}/desk`, 307);
		if (url.pathname.endsWith("/escape")) return Response.redirect(`${url.origin}/outside`, 302);
		if (url.pathname.endsWith("/foreign")) return Response.redirect("https://foreign.invalid/", 302);
		if (url.pathname.endsWith("/events")) return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("data: updated\n\n")); controller.close(); } }), { headers: { "Content-Type": "text/event-stream" } });
		return Response.json(requests.at(-1), { headers: { "Set-Cookie": "private=hidden", "Access-Control-Allow-Origin": "*" } });
	} });
	stops.push(async () => { await upstream.stop(true); });
	const resolve = async (key: string) => base === `/review/${key}/` ? `http://127.0.0.1:${upstream.port}${base}` : undefined;
	const app = await serveCodingUi({ directory, port: 0, host: { url: "ws://127.0.0.1:12345/ws", token: "a".repeat(64) }, review: resolve });
	stops.push(app.close);
	return { app, requests, resolve, upstream };
}

test("review paths preserve exact project and cycle identities without URL syntax from project names", () => {
	expect(reviewBase("/repo")).toBe("/review/816fc349d3faebf805d1bed70fce7e14754cad5251c77dda31c414ee961a0bdd/");
	expect(base).toMatch(/^\/review\/[a-f0-9]{64}\/$/);
	expect(reviewPaths(project, cycle)).toEqual({ batch: `${base}cycles/${cycle}`, desk: `${base}cycles/${cycle}/desk` });
	expect(reviewPaths(project + "?cycle=other#desk", cycle).batch).not.toBe(reviewPaths(project, cycle).batch);
	expect(() => reviewPaths(project, "../other")).toThrow();
});

test("coding origin forwards exact cycle, desk, API commands and events while retaining standalone routes", async () => {
	const { app, requests, upstream } = await fixture();
	const paths = reviewPaths(project, cycle);
	for (const path of [paths.batch, paths.desk, `${base}api/health`, `${base}assets/app.js`]) {
		const response = await fetch(new URL(path + "?returnTo=%2F%3Fchannel%3Done", app.url));
		expect(response.status).toBe(200);
		expect((await response.json()).path).toBe(path + "?returnTo=%2F%3Fchannel%3Done");
		expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'self'");
		expect(response.headers.get("set-cookie")).toBeNull();
		expect(response.headers.get("access-control-allow-origin")).toBeNull();
	}
	const response = await fetch(new URL(`${base}_serverFn/command`, app.url), { method: "POST", headers: { Origin: new URL(app.url).origin, "Content-Type": "application/json", Cookie: "private=client", Authorization: "Bearer private", "X-Forwarded-Host": "foreign.invalid", "X-TSR-Test": "command" }, body: '{"disposition":"comment"}' });
	expect(response.status).toBe(200);
	expect(requests.at(-1)).toMatchObject({ method: "POST", body: '{"disposition":"comment"}', headers: { origin: `http://127.0.0.1:${upstream.port}`, "x-tsr-test": "command" } });
	for (const name of ["cookie", "authorization", "x-forwarded-host", "sec-fetch-site"]) expect(requests.at(-1)?.headers[name]).toBeUndefined();
	expect(await (await fetch(new URL(`${base}api/events`, app.url))).text()).toBe("data: updated\n\n");
	expect(await (await fetch(app.url)).text()).toContain("Coding home");
	expect((await fetch(`http://127.0.0.1:${upstream.port}/api/health`)).status).toBe(200);
});

test("review prefix refuses foreign authority, cross-site writes, upgrades and traversal before reaching its BFF", async () => {
	const { app, requests } = await fixture();
	const path = new URL(`${base}_serverFn/command`, app.url);
	for (const headers of [{ Host: "rebound.invalid" }, { Origin: "https://foreign.invalid" }, { Origin: "null" }, { "Sec-Fetch-Site": "cross-site" }]) {
		expect((await fetch(path, { headers })).status).toBe(403);
	}
	for (const headers of [{}, { Referer: app.url }, { Origin: "https://foreign.invalid", "Sec-Fetch-Site": "same-origin" }]) {
		expect((await fetch(path, { method: "POST", headers, body: "{}" })).status).toBe(403);
	}
	expect((await fetch(path, { method: "DELETE" })).status).toBe(405);
	expect((await fetch(path, { headers: { Upgrade: "websocket" } })).status).toBe(405);
	expect((await fetch(new URL(`${base}%2e%2e%2foutside`, app.url))).status).toBe(403);
	expect((await fetch(new URL(`${base}%00`, app.url))).status).toBe(403);
	expect((await fetch(new URL("/review/unknown/cycles/other", app.url))).status).toBe(404);
	expect((await fetch(new URL(`/review/${"f".repeat(64)}/cycles/${cycle}`, app.url))).status).toBe(404);
	expect(requests).toHaveLength(0);
});

test("review forwarding preserves status and confines redirects to its project prefix", async () => {
	const { app } = await fixture();
	const response = await fetch(new URL(`${base}redirect`, app.url), { redirect: "manual" });
	expect(response.status).toBe(307);
	expect(response.headers.get("location")).toBe(`${base}cycles/${cycle}/desk`);
	for (const path of ["escape", "foreign"]) expect((await fetch(new URL(`${base}${path}`, app.url), { redirect: "manual" })).status).toBe(502);
});

test("the proxy preserves fetch-site metadata and never invents same-origin authority", async () => {
	const { app } = await fixture();
	for (const site of ["same-origin", "cross-site"]) {
		const response = await fetch(new URL(`${base}_serverFn/read`, app.url), { headers: { "Sec-Fetch-Site": site, "Sec-Fetch-Mode": "navigate" } });
		expect(response.status).toBe(200);
		expect((await response.json()).headers["sec-fetch-site"]).toBe(site);
	}
	const response = await fetch(new URL(`${base}_serverFn/read`, app.url));
	expect((await response.json()).headers["sec-fetch-site"]).toBeUndefined();
	for (const referer of [app.url, "https://foreign.invalid/"]) {
		const response = await fetch(new URL(`${base}_serverFn/read`, app.url), { headers: { Referer: referer } });
		expect((await response.json()).headers.referer).toBeUndefined();
	}
});

test("shared native-listener hook is opt-in and validates the upstream endpoint", async () => {
	const request = new Request(`http://127.0.0.1:4141${base}api/health`);
	expect((await reviewRequest(request))?.status).toBe(404);
	expect(await reviewRequest(new Request("http://127.0.0.1:4141/health"))).toBeUndefined();
	configureReviewRoutes(async () => "https://foreign.invalid/");
	expect((await reviewRequest(request))?.status).toBe(502);
	configureReviewRoutes(async () => { throw new Error("BFF failed"); });
	expect((await reviewRequest(request))?.status).toBe(502);
});
