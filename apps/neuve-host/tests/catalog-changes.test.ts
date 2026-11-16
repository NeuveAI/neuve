import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as catalog from "../src/catalog";
import { catalogChanges } from "../src/catalog-changes";

// Real atomic catalog writes prove coalesced events deliver changes without waking clients for log churn.
const original = { home: catalog.home, user: catalog.user, local: false };
const roots: string[] = [];
afterEach(() => {
	catalog.bind(original);
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup() {
	const home = fs.mkdtempSync(join(tmpdir(), "cc-"));
	roots.push(home);
	catalog.bind({ home, user: "catalog-test", local: true });
	const record = catalog.create(home);
	fs.utimesSync(catalog.paths(record.id).record, 1000, 1000);
	const directory = join(home, "channels");
	const broadcast = mock(() => {});
	const recordChanged = mock(() => {});
	const rescanned = mock((_channel: string, _file: string, _event: string | null) => {});
	const failed = mock((_error: unknown) => {});
	const changed = catalogChanges(directory, { broadcast, recordChanged, rescanned, failed });
	return { record, directory, broadcast, recordChanged, rescanned, failed, changed };
}

// A queued reader can fail after the synchronous observation has already been confirmed.
for (const event of ["named", "folder"] as const) test(`a failed queued broadcast leaves the next ${event} event retryable`, async () => {
	const { record, directory, recordChanged, rescanned, failed } = setup();
	const outcome = Promise.withResolvers<boolean>();
	const delivered: (number | undefined)[][] = [];
	const broadcast = mock((): void | Promise<boolean> => { delivered.push(catalog.list().map(record => record.active)); });
	broadcast.mockImplementationOnce(() => outcome.promise);
	const changed = catalogChanges(directory, { broadcast, recordChanged, rescanned, failed });
	catalog.write({ ...record, active: 1 });
	fs.writeFileSync(catalog.paths(record.id).socket, "socket identity");
	changed(record.id);
	outcome.resolve(false);
	await outcome.promise;
	if (event === "named") {
		changed(`${record.id}/channel.json`);
		changed(`${record.id}/channel.sock`);
	} else changed(record.id);
	expect(broadcast).toHaveBeenCalledTimes(event === "named" ? 3 : 2);
	expect(recordChanged).toHaveBeenCalledTimes(2);
	changed(record.id);
	expect(broadcast).toHaveBeenCalledTimes(event === "named" ? 3 : 2);
	expect(delivered).toEqual(event === "named" ? [[1], [1]] : [[1]]);
});

// A late failure owns only its observations, never a later confirmed write or a removed channel.
for (const later of ["write", "drop"] as const) test(`a late failed broadcast does not undo a later ${later}`, async () => {
	const { record, directory, recordChanged, rescanned, failed } = setup();
	const outcome = Promise.withResolvers<boolean>();
	const delivered: (number | undefined)[][] = [];
	const broadcast = mock((): void | Promise<boolean> => { delivered.push(catalog.list().map(record => record.active)); });
	broadcast.mockImplementationOnce(() => outcome.promise);
	const changed = catalogChanges(directory, { broadcast, recordChanged, rescanned, failed });
	catalog.write({ ...record, active: 1 });
	changed(`${record.id}/channel.json`);
	if (later === "write") catalog.write({ ...record, active: 2 });
	else fs.rmSync(catalog.dir(record.id), { recursive: true });
	changed(record.id);
	outcome.resolve(false);
	await outcome.promise;
	const stat = spyOn(fs, "statSync");
	try {
		changed(null);
		if (later === "drop") expect(stat).not.toHaveBeenCalled();
	} finally { stat.mockRestore(); }
	expect(broadcast).toHaveBeenCalledTimes(2);
	expect(recordChanged).toHaveBeenCalledTimes(2);
	expect(delivered).toEqual(later === "write" ? [[2]] : [[]]);
});

for (const event of ["folder", "null", "temporary"] as const) {
	test(`coalesced ${event} event delivers one atomic record change`, () => {
		const { record, broadcast, recordChanged, rescanned, changed } = setup();
		// Keep size and mtime equal: the replacement's identity still distinguishes an atomic rename.
		const before = fs.statSync(catalog.paths(record.id).record, { bigint: true });
		catalog.write({ ...record, owner: "catalog-best" });
		fs.utimesSync(catalog.paths(record.id).record, 1000, 1000);
		const after = fs.statSync(catalog.paths(record.id).record, { bigint: true });
		expect(after.size).toBe(before.size);
		expect(after.mtimeNs).toBe(before.mtimeNs);
		expect(after.ino).not.toBe(before.ino);
		const file = event === "null" ? null : event === "folder" ? record.id : `${record.id}/channel.json.${process.pid}.tmp`;
		changed(file);
		expect(broadcast).toHaveBeenCalledTimes(1);
		expect(recordChanged).toHaveBeenCalledTimes(1);
		expect(rescanned.mock.calls).toEqual(event === "temporary" ? [] : [[record.id, "channel.json", file]]);
		changed(file);
		expect(broadcast).toHaveBeenCalledTimes(1);
		expect(recordChanged).toHaveBeenCalledTimes(1);
	});
}

for (const root of [null, "", ".", "/", "channels", "directory"] as const) {
	test(`root event ${String(root)} notices new and removed channel folders`, () => {
		const { record, directory, broadcast, recordChanged, changed } = setup();
		catalog.create(directory);
		fs.rmSync(catalog.dir(record.id), { recursive: true });
		const file = root === "directory" ? directory : root;
		changed(file);
		expect(broadcast).toHaveBeenCalledTimes(1);
		expect(recordChanged).toHaveBeenCalledTimes(1);
		changed(file);
		expect(broadcast).toHaveBeenCalledTimes(1);
	});
}

test("named events retain notifications and record only the named file's signature", () => {
	const { record, broadcast, recordChanged, rescanned, changed } = setup();
	catalog.write({ ...record, active: 1 });
	fs.writeFileSync(catalog.paths(record.id).socket, "socket identity");
	changed(`${record.id}/channel.json`);
	changed(`${record.id}/channel.json`);
	expect(broadcast).toHaveBeenCalledTimes(1);
	expect(recordChanged).toHaveBeenCalledTimes(1);
	changed(record.id);
	expect(broadcast).toHaveBeenCalledTimes(2);
	expect(recordChanged).toHaveBeenCalledTimes(1);
	expect(rescanned.mock.calls).toEqual([[record.id, "channel.sock", record.id]]);
	changed(`${record.id}/channel.sock`);
	changed(record.id);
	expect(broadcast).toHaveBeenCalledTimes(2);
	expect(recordChanged).toHaveBeenCalledTimes(1);
});

test("socket changes and disappearance only broadcast; log and WAL churn do nothing", () => {
	const { record, broadcast, recordChanged, rescanned, changed } = setup();
	fs.writeFileSync(catalog.paths(record.id).socket, "socket identity");
	changed(`${record.id}/worker.log`);
	fs.rmSync(catalog.paths(record.id).socket);
	changed(record.id);
	fs.writeFileSync(catalog.paths(record.id).log, "frequent worker log");
	changed(`${record.id}/worker.log`);
	fs.writeFileSync(`${catalog.paths(record.id).storage}-wal`, "frequent WAL write");
	changed(`${record.id}/channel.sqlite-wal`);
	expect(broadcast).toHaveBeenCalledTimes(2);
	expect(recordChanged).toHaveBeenCalledTimes(0);
	expect(rescanned.mock.calls).toEqual([[record.id, "channel.sock", record.id]]);
});

test("deep lane and admission events do not stat or enumerate the catalog", () => {
	const { record, broadcast, changed } = setup();
	const stat = spyOn(fs, "statSync");
	const readdir = spyOn(fs, "readdirSync");
	try {
		changed(`${record.id}/lanes/work/source.ts`);
		changed(`${record.id}/review-admissions/request.json`);
		expect(stat).not.toHaveBeenCalled();
		expect(readdir).not.toHaveBeenCalled();
		expect(broadcast).not.toHaveBeenCalled();
	} finally {
		stat.mockRestore();
		readdir.mockRestore();
	}
});

test("root lock-file events do not treat files as channel folders", () => {
	const { broadcast, recordChanged, changed } = setup();
	changed("names.lock");
	expect(broadcast).not.toHaveBeenCalled();
	expect(recordChanged).not.toHaveBeenCalled();
});

test("removing the catalog root still notifies disappearance once", () => {
	const { directory, broadcast, recordChanged, changed } = setup();
	fs.rmSync(directory, { recursive: true });
	changed(null);
	changed(null);
	expect(broadcast).toHaveBeenCalledTimes(1);
	expect(recordChanged).toHaveBeenCalledTimes(1);
});

test("a named record event does not mark a later write seen before its queued reader", async () => {
	const { record, directory } = setup();
	const delivered: number[] = [];
	let frames = Promise.resolve();
	let notifications = 0;
	const changed = catalogChanges(directory, {
		broadcast() { frames = frames.then(() => { delivered.push(catalog.read(record.id).active ?? 0); }); },
		recordChanged() { notifications++; },
		rescanned() {},
		failed() {},
	});
	catalog.write({ ...record, active: 1 });
	changed(`${record.id}/channel.json`);
	catalog.write({ ...record, active: 2 });
	changed(record.id);
	await frames;
	expect(delivered).toEqual([2, 2]);
	expect(notifications).toBe(2);
	changed(record.id);
	await frames;
	expect(delivered).toEqual([2, 2]);
});

// A temporary-file event can observe the rename before its named event reaches the IPC handler.
test("temporary event followed by the named record event delivers once without a rescan log", () => {
	const { record, broadcast, recordChanged, rescanned, changed } = setup();
	catalog.write({ ...record, active: 1 });
	changed(`${record.id}/channel.json.${process.pid}.tmp`);
	changed(`${record.id}/channel.json`);
	expect(broadcast).toHaveBeenCalledTimes(1);
	expect(recordChanged).toHaveBeenCalledTimes(1);
	expect(rescanned).not.toHaveBeenCalled();
});

// A coalesced ancestor event must identify the recovery and suppress the later named duplicate.
test("folder recovery logs the triggering event and delivers the write only once", () => {
	const { record, broadcast, recordChanged, rescanned, changed } = setup();
	catalog.write({ ...record, active: 1 });
	changed(record.id);
	changed(`${record.id}/channel.json`);
	expect(broadcast).toHaveBeenCalledTimes(1);
	expect(recordChanged).toHaveBeenCalledTimes(1);
	expect(rescanned.mock.calls).toEqual([[record.id, "channel.json", record.id]]);
});

// Startup reads have no queued delivery, so they cannot suppress the first named event.
for (const file of ["channel.json", "channel.sock"]) test(`a named ${file} event with the startup signature still delivers once`, () => {
	const { record, broadcast, recordChanged, changed } = setup();
	expect(broadcast).not.toHaveBeenCalled();
	changed(`${record.id}/${file}`);
	changed(`${record.id}/${file}`);
	expect(broadcast).toHaveBeenCalledTimes(1);
	expect(recordChanged).toHaveBeenCalledTimes(file === "channel.json" ? 1 : 0);
});

// Both catalog files feed the same listing, so one observation queues one listing and record notification.
test("one rescan delivers both changed files in a single broadcast", () => {
	const { record, broadcast, recordChanged, rescanned, changed } = setup();
	catalog.write({ ...record, active: 1 });
	fs.writeFileSync(catalog.paths(record.id).socket, "socket identity");
	changed(record.id);
	changed(`${record.id}/channel.json`);
	changed(`${record.id}/channel.sock`);
	expect(broadcast).toHaveBeenCalledTimes(1);
	expect(recordChanged).toHaveBeenCalledTimes(1);
	expect(rescanned.mock.calls).toEqual([
		[record.id, "channel.json", record.id],
		[record.id, "channel.sock", record.id],
	]);
});

// An I/O failure must deliver conservatively without confirming any partially read signatures.
test("stat EACCES does not escape and the next normal event still detects the write", () => {
	const { record, broadcast, recordChanged, rescanned, failed, changed } = setup();
	catalog.write({ ...record, active: 1 });
	const denied = Object.assign(new Error("stat denied"), { code: "EACCES" });
	const read = fs.statSync;
	const stat = spyOn(fs, "statSync").mockImplementation((...args: Parameters<typeof fs.statSync>) => {
		if (args[0] === catalog.paths(record.id).socket) throw denied;
		return read(...args);
	});
	try {
		expect(() => changed(record.id)).not.toThrow();
		expect(broadcast).toHaveBeenCalledTimes(1);
		expect(recordChanged).toHaveBeenCalledTimes(1);
		expect(failed.mock.calls).toEqual([[denied]]);
		expect(rescanned).not.toHaveBeenCalled();
	} finally { stat.mockRestore(); }
	changed(`${record.id}/channel.json`);
	changed(record.id);
	expect(broadcast).toHaveBeenCalledTimes(2);
	expect(recordChanged).toHaveBeenCalledTimes(2);
	expect(failed).toHaveBeenCalledTimes(1);
});

// Enumeration failures use the same conservative delivery as failed per-file reads.
test("readdir EACCES does not escape or hide a change from the next root event", () => {
	const { record, broadcast, recordChanged, failed, changed } = setup();
	catalog.write({ ...record, active: 1 });
	const denied = Object.assign(new Error("readdir denied"), { code: "EACCES" });
	const readdir = spyOn(fs, "readdirSync").mockImplementation(() => { throw denied; });
	try {
		expect(() => changed(null)).not.toThrow();
		expect(broadcast).toHaveBeenCalledTimes(1);
		expect(recordChanged).toHaveBeenCalledTimes(1);
		expect(failed.mock.calls).toEqual([[denied]]);
	} finally { readdir.mockRestore(); }
	changed(null);
	changed(null);
	expect(broadcast).toHaveBeenCalledTimes(2);
	expect(recordChanged).toHaveBeenCalledTimes(2);
	expect(failed).toHaveBeenCalledTimes(1);
});

// Startup must also survive an unreadable catalog and leave its signatures unconfirmed.
test("startup stat failure reports once and the next event can deliver", () => {
	const { record, directory } = setup();
	const broadcast = mock(() => {});
	const recordChanged = mock(() => {});
	const rescanned = mock(() => {});
	const failed = mock((_error: unknown) => {});
	const denied = Object.assign(new Error("startup stat denied"), { code: "EACCES" });
	const stat = spyOn(fs, "statSync").mockImplementation(() => { throw denied; });
	let changed: ReturnType<typeof catalogChanges>;
	try {
		changed = catalogChanges(directory, { broadcast, recordChanged, rescanned, failed });
		expect(broadcast).toHaveBeenCalledTimes(1);
		expect(recordChanged).toHaveBeenCalledTimes(1);
		expect(failed.mock.calls).toEqual([[denied]]);
	} finally { stat.mockRestore(); }
	changed(record.id);
	changed(`${record.id}/channel.json`);
	expect(broadcast).toHaveBeenCalledTimes(2);
	expect(recordChanged).toHaveBeenCalledTimes(2);
	expect(failed).toHaveBeenCalledTimes(1);
});

// Fully absent channels are forgotten; a delayed named deletion can deliver again without retaining history.
test("a removed record and socket leave no root-scan history, but named deletions deliver again", () => {
	const { record, directory } = setup();
	fs.writeFileSync(catalog.paths(record.id).socket, "socket identity");
	const broadcast = mock(() => {});
	const recordChanged = mock(() => {});
	const changed = catalogChanges(directory, { broadcast, recordChanged, rescanned() {}, failed() {} });
	fs.rmSync(catalog.dir(record.id), { recursive: true });
	changed(record.id);
	changed(null);
	expect(broadcast).toHaveBeenCalledTimes(1);
	const stat = spyOn(fs, "statSync");
	try {
		changed(null);
		expect(stat).not.toHaveBeenCalled();
	} finally { stat.mockRestore(); }
	changed(`${record.id}/channel.json`);
	changed(`${record.id}/channel.sock`);
	changed(null);
	expect(broadcast).toHaveBeenCalledTimes(3);
	expect(recordChanged).toHaveBeenCalledTimes(2);
});

// Every action is independent, including failure logging; a failed broadcast must remain retryable.
for (const throwing of ["broadcast", "recordChanged", "rescanned"] as const) {
	test(`a throwing ${throwing} cannot escape or stop the other actions`, () => {
		const { record, directory } = setup();
		const error = new Error(`${throwing} failed`);
		let broken = true;
		const calls: string[] = [];
		const failures: unknown[] = [];
		const action = (name: string) => {
			calls.push(name);
			if (broken && throwing === name) throw error;
		};
		const changed = catalogChanges(directory, {
			broadcast() { action("broadcast"); },
			recordChanged() { action("recordChanged"); },
			rescanned() { action("rescanned"); },
			failed(cause) { failures.push(cause); calls.push("failed"); throw new Error("logging failed"); },
		});
		catalog.write({ ...record, active: 1 });
		fs.writeFileSync(catalog.paths(record.id).socket, "socket identity");
		expect(() => changed(record.id)).not.toThrow();
		expect(calls.filter(name => name === "broadcast")).toHaveLength(1);
		expect(calls.filter(name => name === "recordChanged")).toHaveLength(1);
		expect(calls.filter(name => name === "rescanned")).toHaveLength(2);
		expect(calls.filter(name => name === "failed")).toHaveLength(throwing === "rescanned" ? 2 : 1);
		expect(failures).toEqual(throwing === "rescanned" ? [error, error] : [error]);
		broken = false;
		calls.length = 0;
		changed(record.id);
		expect(calls).toEqual(throwing === "broadcast" ? ["broadcast", "recordChanged", "rescanned", "rescanned"] : []);
	});
}

// Recovery must log the original read failure before either notification can hit the same error.
for (const startup of [false, true]) test(`${startup ? "startup" : "event"} read failure isolates throwing recovery actions and logger`, () => {
	const { directory } = setup();
	const calls: string[] = [];
	const actions = {
		broadcast() { calls.push("broadcast"); throw new Error("broadcast failed"); },
		recordChanged() { calls.push("recordChanged"); throw new Error("record failed"); },
		rescanned() { calls.push("rescanned"); },
		failed() { calls.push("failed"); throw new Error("logger failed"); },
	};
	const changed = startup ? undefined : catalogChanges(directory, actions);
	const readdir = spyOn(fs, "readdirSync").mockImplementation(() => { throw new Error("catalog denied"); });
	try {
		expect(() => startup ? catalogChanges(directory, actions) : changed?.(null)).not.toThrow();
		expect(calls).toEqual(["failed", "broadcast", "failed", "recordChanged", "failed"]);
	} finally { readdir.mockRestore(); }
});
