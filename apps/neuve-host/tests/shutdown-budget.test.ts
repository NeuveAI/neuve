import "./fixtures/memory-secrets";
import {expect, test} from "bun:test";
import {existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {mkdir, mkdtemp, rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {configure, bindConfiguredCatalog} from "../src/host-config";
import {configureRuntime} from "../src/runtime-hooks";
import {confirmClose, workerCloseTimeout} from "../src/worker-close";
import {Connection} from "../src/client";
import {shutdown} from "../src/shutdown";
import {open as openLog} from "../src/log";
import * as catalog from "../src/catalog";
import {Fixture, until} from "../../../packages/channel/tests/helpers";

for (const budget of [50, 1500]) test(`native shutdown honors ${budget}ms and verifies actual delayed close`, async () => {
	const fixture = await Fixture.create();
	const root = await mkdtemp(join(tmpdir(), "sb"));
	let connection: Connection | undefined;
	let worker: {id: string; pid: number} | undefined;
	const release = join(root, "go");
	try {
		configureRuntime({workerCloseTimeoutMs: undefined});
		expect(workerCloseTimeout()).toBe(10_000);
		for (const name of ["h", "l"]) await mkdir(join(root, name));
		const script = join(root, "script"); writeFileSync(script, "[]"); writeFileSync(`${script}.cursor`, "0");
		const environment = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
		const config = {home: join(root, "h"), lanes: join(root, "l"), user: "owner", port: 0, environment: {...environment, NEUVE_TEST_SCRIPT: script, NEUVE_TEST_CLOSE_WAIT: release}, worker: [process.execPath, "--preload", join(import.meta.dir, "fixtures/memory-secrets.ts"), join(import.meta.dir, "worker.ts")], workerCloseTimeoutMs: 130_000};
		configure(config); expect(workerCloseTimeout()).toBe(130_000);
		configure({...config, workerCloseTimeoutMs: budget}); await bindConfiguredCatalog(); openLog("shutdown-budget");
		const record = catalog.create(fixture.project, undefined, "delayed");
		connection = await Connection.open(record.id);
		worker = await connection.request<{id: string; pid: number}>({op: "worker"});
		connection.close(); connection = undefined;
		const closing = shutdown().then(() => ({ok: true as const}), (error: unknown) => ({ok: false as const, error}));
		await until(() => existsSync(`${release}.closing`));
		expect(existsSync(join(catalog.paths(record.id).base, "worker-close.json"))).toBe(false);
		await Bun.sleep(180);
		writeFileSync(release, "");
		const result = await closing;
		expect(result.ok).toBe(budget === 1500);
		if (!result.ok) {expect(result.error).toBeInstanceOf(AggregateError); expect(String(result.error)).toContain("did not close");}
		const paths = catalog.paths(record.id);
		await until(() => existsSync(join(paths.base, "worker-close.json")));
		const pid = worker.pid;
		await until(() => {try {process.kill(pid, 0); return false;} catch {return true;}});
		expect(() => confirmClose(paths.base, pid)).not.toThrow();
		expect(() => confirmClose(paths.base, pid + 1)).toThrow("identity changed");
		expect(JSON.parse(readFileSync(join(paths.base, "read-before-close.json"), "utf8"))).toEqual([1]);
		expect(readFileSync(`${script}.cursor`, "utf8")).toBe("0");
	} finally {
		writeFileSync(release, ""); connection?.close();
		if (worker) await until(() => {try {process.kill(worker.pid, 0); return false;} catch {return true;}}).catch(() => {});
		await fixture.dispose(); await rm(root, {recursive: true, force: true});
	}
});


test("a configured capture close waits for byte-capped filing and never for a scan", () => {
  configureRuntime({workerCloseTimeoutMs: 130_000, worker: {models: (_context, defaults) => defaults, close: async () => {}}});
  try { expect(workerCloseTimeout()).toBe(279_800); }
  finally { configureRuntime({worker: undefined, workerCloseTimeoutMs: undefined}); }
});


test("the recorded artifact allowance and drain is exactly 240256 milliseconds", async () => {
 const {recordedCloseCeiling} = require("../../../packages/harness/src/pi/capture/recorded-inventory.ts");
 const root=mkdtempSync(join(tmpdir(),"shutdown-recorded-"));
 try {
  mkdirSync(join(root,"capture"));
  writeFileSync(join(root,"capture","events.jsonl"),JSON.stringify({event:{type:"artifact",size:200*1024*1024}})+"\n");
  expect((await recordedCloseCeiling(root))+60_000).toBe(240_256);
 }finally{rmSync(root,{recursive:true,force:true});}
});
