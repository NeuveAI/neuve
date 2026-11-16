import "./fixtures/memory-secrets";
import {expect, test} from "bun:test";
import {mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {startHost} from "./fixture-host";
import {GatewayClient} from "../src/private-gateway-client";
import * as catalog from "../src/catalog";

// This regression starts the actual host so migration must precede catalog filtering and resume.
test("owned Neuve startup migrates only untagged channels to local and resumes the legacy worker", async () => {
	const root = await mkdtemp(join(tmpdir(), "lc"));
	const home = join(root, "h"), lanes = join(root, "l"), project = join(root, "p");
	for (const path of [home, lanes, project]) await mkdir(path);
	const script = join(root, "script.json");
	await writeFile(script, "[]");
	await writeFile(`${script}.cursor`, "0");
	const records = [
		{id: "0000000000000001"},
		{id: "0000000000000002", local: true},
		{id: "0000000000000003", tailnet: "other.fixture.ts.net"},
		{id: "0000000000000004", local: false},
	];
	const originals = new Map<string, string>();
	for (const [index, value] of records.entries()) {
		const directory = join(home, "channels", value.id);
		await mkdir(directory, {recursive: true});
		const text = JSON.stringify({version: 2, name: `legacy-${index}`, prefix: `legacy-${index}`, named: true, owner: "owner", project, created: index, custom: {branch: "kept/branch", opaque: [1, "preserved"]}, ...value}, null, "\t") + "\n";
		originals.set(value.id, text);
		await writeFile(join(directory, "channel.json"), text);
		await writeFile(join(directory, "untouched.bin"), "retained bytes");
	}
	await writeFile(join(home, "resume.json"), JSON.stringify([records[0]!.id]));
	const options = {loopback: true, models: () => [], config: {home, lanes, user: "owner", port: 0, environment: {...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), NEUVE_TEST_SCRIPT: script}, worker: [process.execPath, "--preload", join(import.meta.dir, "fixtures/memory-secrets.ts"), ...(process.env.NEUVE_TEST_TSCONFIG ? ["--tsconfig-override", process.env.NEUVE_TEST_TSCONFIG] : []), join(import.meta.dir, "worker.ts")]}};
	let host: Awaited<ReturnType<typeof startHost>> | undefined;
	let client: GatewayClient | undefined;
	try {
		host = await startHost(options);
		client = new GatewayClient(host.url, host.token);
		for (let count = 0; count < 200 && client.status !== "open"; count++) await Bun.sleep(10);
		expect(client.status).toBe("open");
		expect(catalog.list().map(record => record.id)).toEqual([records[0]!.id, records[1]!.id]);
		expect(catalog.owns(records[0]!.id)).toBe(true);
		const legacy = catalog.read(records[0]!.id);
		expect(legacy).toMatchObject({local: true, id: records[0]!.id, prefix: "legacy-0", custom: {branch: "kept/branch", opaque: [1, "preserved"]}});
		expect(await readFile(join(home, "channels", legacy.id, "models-context.json"), "utf8")).toContain(legacy.id);
		for (const value of records.slice(1)) expect(await readFile(join(home, "channels", value.id, "channel.json"), "utf8")).toBe(originals.get(value.id)!);
		for (const value of records) expect(await readFile(join(home, "channels", value.id, "untouched.bin"), "utf8")).toBe("retained bytes");
		client.close(); client = undefined;
		await host.close(); host = undefined;
		const before = await readFile(join(home, "channels", legacy.id, "channel.json"), "utf8");
		host = await startHost(options);
		expect(await readFile(join(home, "channels", legacy.id, "channel.json"), "utf8")).toBe(before);
		expect(catalog.list().map(record => record.id)).toEqual([records[0]!.id, records[1]!.id]);
	} finally {
		client?.close();
		await host?.close();
		await rm(root, {recursive: true, force: true});
	}
}, 60_000);
