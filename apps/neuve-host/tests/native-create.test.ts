import "./fixtures/memory-secrets";
import {afterEach, expect, test} from "bun:test";
import {mkdir, mkdtemp, readFile, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {configure, bindConfiguredCatalog} from "../src/host-config";
import {configureRuntime} from "../src/runtime-hooks";
import {dispatchGateway} from "../src/gateway-extensions";
import * as catalog from "../src/catalog";
import {open as openLog} from "../src/log";
import type {HostRequest} from "../src/protocol";

const item = {provider: "github", repo: "githubnext/ace", kind: "issue", number: 1, url: "https://github.com/githubnext/ace/issues/1"} as const;
const roots: string[] = [];
afterEach(async () => {
	configureRuntime({channelProvenance: false});
	for (const root of roots.splice(0)) await rm(root, {recursive: true, force: true});
});

async function setup(configured: boolean) {
	const root = await mkdtemp(join(tmpdir(), "create-"));
	roots.push(root);
	for (const name of ["home", "lanes", "project"]) await mkdir(join(root, name));
	for (const args of [["init", "-q", "-b", "main"], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "--allow-empty", "-m", "fixture"]]) {
		const result = Bun.spawnSync(["git", "-C", join(root, "project"), ...args]);
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	}
	configure({home: join(root, "home"), lanes: join(root, "lanes"), user: "owner", port: 0, environment: {}, worker: [process.execPath]});
	await bindConfiguredCatalog();
	openLog("host");
	configureRuntime({channelProvenance: configured});
	return join(root, "project");
}

for (const configured of [false, true]) {
	test(`GitHub cloud create returns native compute admission with provenance configured=${configured}`, async () => {
		const project = await setup(configured);
		const record = {nativeCloud: true};
		const calls: HostRequest[] = [];
		const value = await dispatchGateway({user: "owner", local: true, peer: false}, {op: "create", project, cloud: true, items: [item]}, "cloud", async () => {throw new Error("cloud must not contact a local worker");}, async request => {calls.push(request); return record;});
		expect(value).toBe(record);
		expect(calls).toEqual([{op: "create", project, cloud: true}]);
	});
}

test("plain Ace GitHub create has no worker extension or worktree prerequisite and the ask follows", async () => {
	const project = await setup(false);
	const record = catalog.create(project, undefined, "native");
	const calls: HostRequest[] = [];
	let extensions = 0;
	const native = async (request: HostRequest) => {calls.push(request); return request.op === "create" ? record : "asked";};
	const connection = async (): Promise<never> => {extensions++; throw new Error("The channel extension is not configured");};
	const owner = {user: "owner", local: true, peer: false};
	expect(await dispatchGateway(owner, {op: "create", project, items: [item]}, "plain", connection, native)).toBe(record);
	expect(await dispatchGateway(owner, {op: "channel", channel: record.id, request: {op: "ask", author: "owner", text: "Start the issue"}}, "plain", connection, native)).toBe("asked");
	expect(extensions).toBe(0);
	expect(catalog.read(record.id).lane).toBeUndefined();
	expect(calls.map(call => call.op)).toEqual(["create", "channel"]);
});

for (const outcome of ["reject", "pending", "log failure"] as const) {
	test(`owner tailnet-web GitHub create and ask survive ${outcome} Neuve provenance`, async () => {
		const project = await setup(true);
		const logs = join(catalog.home, "logs");
		if (outcome === "log failure") await rm(logs, {recursive: true});
		const record = catalog.create(project, undefined, "native");
		const calls: HostRequest[] = [];
		let extensions = 0;
		const connection = async (): Promise<never> => {extensions++; if (outcome !== "pending") throw new Error("fixture unavailable provenance"); return new Promise<never>(() => {});};
		const native = async (request: HostRequest) => {calls.push(request); return request.op === "create" ? record : "asked";};
		const owner = {user: "owner", local: false, peer: false};
		expect(await dispatchGateway(owner, {op: "create", project, items: [item]}, "tailnet-web", connection, native)).toBe(record);
		expect(await dispatchGateway(owner, {op: "channel", channel: record.id, request: {op: "ask", author: "owner", text: "Start the issue"}}, "tailnet-web", connection, native)).toBe("asked");
		await Bun.sleep(0);
		if (outcome === "reject") {
			const warning = (await readFile(join(logs, "host.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
			expect(warning).toContainEqual(expect.objectContaining({level: "warn", event: "review.origin.failed", trace: "tailnet-web", error: "fixture unavailable provenance"}));
		}
		expect(extensions).toBe(1);
		expect(catalog.read(record.id).lane).toBeUndefined();
		expect(calls.map(call => call.op)).toEqual(["create", "channel"]);
	});
}
