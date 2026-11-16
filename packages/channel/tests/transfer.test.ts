import {expect, test} from "bun:test";
import {mkdir} from "node:fs/promises";
import {join} from "node:path";
import {fauxAssistantMessage, fauxToolCall} from "@earendil-works/pi-ai";
import {openNodeSqliteDatabase, openNodeSqliteStorage} from "@earendil-works/pi-durable/storage/sqlite/node";
import {BACKGROUND_CONTEXT} from "@earendil-works/chord/context";
import {backupSnapshot, exportSnapshot, importSnapshot} from "../src/transfer";
import {Fixture, faux, OWNER, MODEL, scratch} from "./helpers";

const item = {provider: "github", repo: "githubnext/ace", kind: "pull-request", number: 711, url: "https://github.com/githubnext/ace/pull/711"};

test("full native archive retains durable documents, child history and admissions; editable seed intentionally does not", async () => {
	const source = await Fixture.create();
	const targetRoot = await scratch();
	await mkdir(join(targetRoot, "state"));
	const target = new Fixture(targetRoot, source.project, source.lanes, source.lane, faux());
	const seeded = await Fixture.create();
	try {
		source.script(fauxAssistantMessage(fauxToolCall("subagent", {task: "inspect"}, {id: "child-call"}), {stopReason: "toolUse"}), fauxAssistantMessage("child-result"), fauxAssistantMessage("parent-result"));
		const {submission} = await source.request<{submission: number}>({op: "ask", author: OWNER, text: "delegate", model: MODEL, requestId: "archive-request"});
		expect(await source.request({op: "wait", submission})).toBe("done");
		await source.request({op: "review-origin-set", items: [item]});
		await source.request({op: "planning-reviewed", chat: 1, source: null, review: {reference: "external-records-reference", base: "a".repeat(40), head: "b".repeat(40)}});
		const before = await source.channel.info();
		expect(before.chats).toHaveLength(2);
		const seed = await source.channel.export();
		expect(seed.chats).toHaveLength(1);
		expect(JSON.stringify(seed)).not.toContain("external-records-reference");
		await source.channel.close();
		const origin = await openNodeSqliteDatabase(join(source.root, "state", "channel.sqlite"));
		const snapshot = await exportSnapshot(origin, "one");
		expect(snapshot.tables.conversations!.rows).toHaveLength(2);
		expect(snapshot.tables.tasks!.rows.length).toBeGreaterThan(0);
		expect(snapshot.tables.submissions!.rows.length).toBeGreaterThan(0);
		expect(snapshot.tables.documents!.rows.length).toBeGreaterThan(0);
		const destination = await openNodeSqliteDatabase(join(targetRoot, "state", "channel.sqlite"));
		const imported = await importSnapshot(destination, snapshot);
		expect(imported.digest).toBe(snapshot.digest);
		expect((await exportSnapshot(destination, "one")).digest).toBe(snapshot.digest);
		await expect(importSnapshot(destination, snapshot)).rejects.toThrow("not empty");
		await destination.close();
		await origin.close();
		await target.open();
		expect((await target.channel.info()).chats).toHaveLength(2);
		expect(await target.request({op: "review-origin"})).toEqual([item]);
		expect(await target.request({op: "planning-state"})).toEqual({selection: null, review: {reference: "external-records-reference", base: "a".repeat(40), head: "b".repeat(40)}});
		expect(await target.request({op: "ask", author: OWNER, text: "delegate", model: MODEL, requestId: "archive-request"})).toEqual({submission});
		await seeded.channel.import(seed);
		expect((await seeded.channel.info()).chats).toHaveLength(1);
		expect(await seeded.request({op: "review-origin"})).toEqual([]);
		expect(await seeded.request({op: "planning-state"})).toEqual({selection: null, review: null});
	} finally { await target.dispose(); await seeded.dispose(); await source.dispose(); }
});

test("invalid digest/schema and failed installation never leave partially imported native records", async () => {
	const source = await Fixture.create();
	try {
		await source.request({op: "say", author: OWNER, text: "durable"});
		await source.channel.close();
		const origin = await openNodeSqliteDatabase(join(source.root, "state", "channel.sqlite"));
		const snapshot = await exportSnapshot(origin, "one");
		const path = join(source.root, "destination.sqlite");
		const seeded = await openNodeSqliteStorage(path); await seeded.close(BACKGROUND_CONTEXT);
		const destination = await openNodeSqliteDatabase(path);
		const before = await exportSnapshot(destination, "one");
		await expect(importSnapshot(destination, {...snapshot, digest: "0".repeat(64)})).rejects.toThrow("digest");
		await expect(importSnapshot(destination, {...snapshot, schema: 99})).rejects.toThrow("schema");
		await expect(importSnapshot(destination, snapshot, {install: async () => {throw new Error("install refused");}})).rejects.toThrow("install refused");
		expect((await exportSnapshot(destination, "one")).digest).toBe(before.digest);
		await origin.exec("CREATE TABLE unexpected (value TEXT)");
		await expect(exportSnapshot(origin, "one")).rejects.toThrow();
		await destination.close(); await origin.close();
	} finally {await source.dispose();}
});

test("moves reject unfinished work while backups retain it", async () => {
	const source = await Fixture.create();
	try {
		source.script(fauxAssistantMessage(fauxToolCall("bash", {command: "printf running; sleep 30"}, {id: "running"}), {stopReason: "toolUse"}));
		const watch = await source.watch();
		await source.request({op: "ask", author: OWNER, text: "run", model: MODEL});
		await watch.until("progress", (event) => event.text.includes("running"));
		const db = await openNodeSqliteDatabase(join(source.root, "state", "channel.sqlite"));
		await expect(exportSnapshot(db, "one")).rejects.toThrow("unfinished work");
		expect((await backupSnapshot(db, "one")).tables.tasks!.rows.length).toBeGreaterThan(0);
		await db.close(); await source.channel.kill(); await watch.stop();
	} finally {await source.dispose();}
});
