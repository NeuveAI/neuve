import "./fixtures/memory-secrets";
import {expect, test} from "bun:test";
import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {startHost} from "./fixture-host";
import {configureRuntime} from "../src/runtime-hooks";
import {GatewayClient} from "../src/private-gateway-client";
import type {Listing} from "../src/catalog";
import type {Event} from "@ace/channel/protocol";
import type {GitHubExternalRef} from "@neuve/records-schema";

async function until<T>(read: () => T | undefined | false | Promise<T | undefined | false>) {
	for (let count = 0; count < 1000; count++) {
		const value = await read();
		if (value) return value;
		await Bun.sleep(10);
	}
	throw new Error("Native create worker fixture did not finish");
}

test("configured Neuve provenance preserves native create then ask through the actual gateway and worker", async () => {
	const root = await mkdtemp(join(tmpdir(), "nc"));
	const home = join(root, "h"), lanes = join(root, "l"), project = join(root, "p");
	for (const path of [home, lanes, project]) await mkdir(path);
	for (const args of [["init", "-q", "-b", "main"], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "--allow-empty", "-m", "fixture"]]) {
		const result = Bun.spawnSync(["git", "-C", project, ...args]);
		expect(result.exitCode).toBe(0);
	}
	const script = join(root, "script.json");
	await writeFile(script, JSON.stringify([{text: "Native ask reached the worker"}]));
	await writeFile(`${script}.cursor`, "0");
	configureRuntime({channelProvenance: true});
	let host: Awaited<ReturnType<typeof startHost>> | undefined;
	let client: GatewayClient | undefined;
	try {
		host = await startHost({models: () => [{provider: "faux", modelId: "coder", efforts: ["off"]}], config: {home, lanes, user: "owner", port: 0, environment: {...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), NEUVE_TEST_SCRIPT: script}, worker: [process.execPath, "--preload", join(import.meta.dir, "fixtures/memory-secrets.ts"), ...(process.env.NEUVE_TEST_TSCONFIG ? ["--tsconfig-override", process.env.NEUVE_TEST_TSCONFIG] : []), join(import.meta.dir, "worker.ts")]}});
		client = new GatewayClient(host.url, host.token);
		await until(() => client?.status === "open");
		const active = client;
		const item: GitHubExternalRef = {provider: "github", repo: "githubnext/ace", kind: "issue", number: 1, url: "https://github.com/githubnext/ace/issues/1"};
		const record = await client.request<Listing>({op: "create", project, items: [item]});
		expect(record.lane).toBeUndefined();
		const events: Event[] = [];
		await client.channel(record.id, {op: "watch", queue: true, progress: true}, {event: event => events.push(event)});
		await client.channel(record.id, {op: "ask", author: "owner", text: "Start this issue"});
		await until(() => events.some(event => event.kind === "reply" && event.text === "Native ask reached the worker"));
		await until(async () => (await active.channel<GitHubExternalRef[]>(record.id, {op: "review-origin"})).length === 1);
		expect(await client.channel<GitHubExternalRef[]>(record.id, {op: "review-origin"})).toEqual([item]);
		expect(events.some(event => event.kind === "message" && event.author === "owner" && event.text === "Start this issue")).toBe(true);
		expect(await readFile(`${script}.cursor`, "utf8")).toBe("1");
	} finally {
		client?.close();
		await host?.close();
		configureRuntime({channelProvenance: false});
		await rm(root, {recursive: true, force: true});
	}
}, 60_000);
