import "./fixtures/memory-secrets";
import {expect, test} from "bun:test";
import {copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {mkdir, mkdtemp, rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {Database} from "bun:sqlite";
import {DatabaseSync} from "node:sqlite";
import {Fixture, closedDatabase} from "../../../packages/channel/tests/helpers";
import {backup, restore} from "../src/backup";
import {importSeed} from "../src/seed";
import {open as openLog} from "../src/log";
import {configure, bindConfiguredCatalog} from "../src/host-config";
import {configureRuntime} from "../src/runtime-hooks";
import {nativeSourceStorage, prepareNativeSource, type NativeSourceInput} from "../src/native-source-lifecycle";
import {parseHostEnvelope, parseWorkerEnvelope} from "../src/parse";
import * as catalog from "../src/catalog";

test("actual native backup restore and editable seed register before writes and await close", async () => {
	const fixture = await Fixture.create();
	const root = await mkdtemp(join(tmpdir(), "native-source-"));
	try {
		await fixture.request({op: "say", author: "owner", text: "retained native entry"});
		const seed = await fixture.channel.export();
		await fixture.channel.close();
		for (const name of ["home", "lanes"]) await mkdir(join(root, name));
		configure({home: join(root, "home"), lanes: join(root, "lanes"), user: "owner", port: 0, environment: {PATH: process.env.PATH || ""}, worker: [process.execPath]});
		await bindConfiguredCatalog(); openLog("native-source");
		configureRuntime({nativeSources: undefined});
		const source = catalog.draft(fixture.project, undefined, "archive");
		mkdirSync(catalog.paths(source.id).base, {recursive: true});
		copyFileSync(join(fixture.root, "state", "channel.sqlite"), catalog.paths(source.id).storage);
		const normalized = new Database(catalog.paths(source.id).storage); normalized.exec("PRAGMA journal_mode=DELETE"); normalized.close();
		const directory = await backup(source, join(root, "backup"));
		const created: NativeSourceInput[] = [];
		const closed: string[] = [];
		configureRuntime({nativeSources: {async prepare(input) {
			expect(existsSync(input.nativeDatabase)).toBe(false);
			created.push(input);
			return {async close() {
				await Promise.resolve();
				if (existsSync(input.nativeDatabase)) {
					const db = closedDatabase(input.nativeDatabase);
					try {expect(db.prepare("SELECT count(*) AS n FROM entries").get()).toMatchObject({n: expect.any(Number)});} finally {db.close();}
				}
				closed.push(input.channel);
			}};
		}}});
		const restored = await restore(directory);
		expect(readFileSync(catalog.paths(restored.id).storage)).toEqual(readFileSync(join(directory, "channel.sqlite")));
		expect(closed).toEqual([restored.id]);
		const seedFile = join(root, "editable-seed.json"); writeFileSync(seedFile, JSON.stringify(seed));
		const imported = await importSeed(seedFile, {dir: fixture.project, name: "seeded"});
		expect(closed).toEqual([restored.id, imported.id]);
		expect(created.map((input) => input.origin.kind)).toEqual(["backup", "seed"]);
		const db = closedDatabase(catalog.paths(imported.id).storage);
		try {expect(JSON.stringify(db.prepare("SELECT * FROM entries").all())).toContain("retained native entry");} finally {db.close();}
	} finally {configureRuntime({nativeSources: undefined}); await fixture.dispose(); await rm(root, {recursive: true, force: true});}
});

test("a closed channel backs up and restores with its WAL gone", async () => {
	const fixture = await Fixture.create();
	const root = await mkdtemp(join(tmpdir(), "native-source-closed-"));
	try {
		await fixture.request({op: "say", author: "owner", text: "closed channel entry"});
		await fixture.channel.close();
		for (const name of ["home", "lanes"]) await mkdir(join(root, name));
		configure({home: join(root, "home"), lanes: join(root, "lanes"), user: "owner", port: 0, environment: {PATH: process.env.PATH || ""}, worker: [process.execPath]});
		await bindConfiguredCatalog(); openLog("native-source-closed");
		configureRuntime({nativeSources: undefined});
		const source = catalog.draft(fixture.project, undefined, "closed");
		const storage = catalog.paths(source.id).storage;
		mkdirSync(catalog.paths(source.id).base, {recursive: true});
		copyFileSync(join(fixture.root, "state", "channel.sqlite"), storage);
		expect(readFileSync(storage)[18]).toBe(2);
		expect(existsSync(`${storage}-wal`)).toBe(false);
		const directory = await backup(source, join(root, "backup"));
		expect(existsSync(`${storage}-wal`)).toBe(false);
		const db = closedDatabase(join(directory, "channel.sqlite"));
		try {expect(JSON.stringify(db.prepare("SELECT * FROM entries").all())).toContain("closed channel entry");} finally {db.close();}
	} finally {await fixture.dispose(); await rm(root, {recursive: true, force: true});}
});

test("a closed channel that reopens during its backup never mixes two committed states", async () => {
	const root = await mkdtemp(join(tmpdir(), "native-source-race-"));
	try {
		for (const name of ["home", "lanes"]) await mkdir(join(root, name));
		configure({home: join(root, "home"), lanes: join(root, "lanes"), user: "owner", port: 0, environment: {PATH: process.env.PATH || ""}, worker: [process.execPath]});
		await bindConfiguredCatalog(); openLog("native-source-race");
		configureRuntime({nativeSources: undefined});
		const source = catalog.draft(root, undefined, "race");
		const storage = catalog.paths(source.id).storage;
		mkdirSync(catalog.paths(source.id).base, {recursive: true});
		// The filler separates the two tables far enough that the writer lands between reading them.
		const closing = new DatabaseSync(storage);
		closing.exec("PRAGMA journal_mode=WAL; CREATE TABLE a(v INTEGER); INSERT INTO a VALUES(0); CREATE TABLE filler(x BLOB); WITH RECURSIVE c(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM c WHERE i<80000) INSERT INTO filler SELECT randomblob(2048) FROM c; CREATE TABLE b(v INTEGER); INSERT INTO b VALUES(0); PRAGMA wal_checkpoint(TRUNCATE)");
		closing.close();
		rmSync(`${storage}-wal`, {force: true}); rmSync(`${storage}-shm`, {force: true});
		const directory = join(root, "backup");
		const copied = join(directory, "channel.sqlite");
		const writerScript = join(root, "writer.ts");
		writeFileSync(writerScript, `import {DatabaseSync} from "node:sqlite"; import {existsSync, statSync} from "node:fs"; const [source, target] = Bun.argv.slice(2); const until = Date.now() + 20000; while (!existsSync(target) || statSync(target).size < 1048576) { if (Date.now() > until) process.exit(2); Bun.sleepSync(1); } const db = new DatabaseSync(source, {timeout: 20000}); db.exec("BEGIN; UPDATE a SET v=1; UPDATE b SET v=1; COMMIT"); db.close();`);
		const writer = Bun.spawn([process.execPath, writerScript, storage, copied], {stdout: "ignore", stderr: "pipe"});
		await backup(source, directory);
		const copy = closedDatabase(copied);
		try {
			const value = (table: string) => copy.prepare(`SELECT v FROM ${table}`).get()?.["v"];
			expect([[0, 0], [1, 1]]).toContainEqual([value("a"), value("b")]);
		} finally {copy.close();}
		expect(await writer.exited, await new Response(writer.stderr).text()).toBe(0);
	} finally {await rm(root, {recursive: true, force: true});}
}, 60_000);

test("private checkpoint IPC is refused by browser ingress", () => {
	const request = {id: 1, op: "native-source-checkpoint", nativeDatabase: "/fixture/channel.sqlite", nativeSha256: "a".repeat(64)};
	expect(parseWorkerEnvelope(JSON.stringify(request))).toEqual(request);
	expect(() => parseHostEnvelope(JSON.stringify({id: 1, op: "channel", channel: "a".repeat(16), request}), "owner")).toThrow();
	expect(() => parseWorkerEnvelope(JSON.stringify({...request, nativeSha256: "invalid"}))).toThrow();
});

test("uncertain native close retains the creation lease", async () => {
	const root = await mkdtemp(join(tmpdir(), "native-source-close-"));
	try {
		for (const name of ["home", "lanes"]) await mkdir(join(root, name));
		configure({home: join(root, "home"), lanes: join(root, "lanes"), user: "owner", port: 0, environment: {}, worker: [process.execPath]}); await bindConfiguredCatalog();
		let released = false;
		configureRuntime({nativeSources: {prepare: async () => ({close: async () => {released = true;}})}});
		const record = catalog.draft(root, undefined, "unclosed");
		const release = await prepareNativeSource(record, {kind: "seed", file: "/fixture/seed.json", sha256: "b".repeat(64)});
		const storage = await nativeSourceStorage(record.id, async () => ({close: async () => {throw new Error("uncertain close");}}));
		await expect(storage.close()).rejects.toThrow("uncertain close");
		await expect(release()).rejects.toThrow("unclosed storage");
		expect(released).toBe(false);
	} finally {configureRuntime({nativeSources: undefined}); await rm(root, {recursive: true, force: true});}
});
