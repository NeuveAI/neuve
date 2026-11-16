import "./memory-secrets";
import { mock, spyOn } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let changed: ((file: string | null) => void) | undefined;
// The sandbox receives no FSEvents. Only this child replaces the observer.
mock.module("../../src/catalog-watch", () => ({
	watchCatalog(_directory: string, callback: NonNullable<typeof changed>) {
		changed = callback;
		return { ready: Promise.resolve(), async close() {} };
	},
}));
const { startHost } = await import("../../src/host");
const catalog = await import("../../src/catalog");
const { GatewayClient } = await import("../../src/private-gateway-client");
const logging = await import("../../src/log");

function waitFor(client: InstanceType<typeof GatewayClient>, ready: () => boolean): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => { unsubscribe(); reject(new Error("Timed out waiting for gateway delivery")); }, 2000);
		const check = () => {
			if (!ready()) return;
			clearTimeout(timer);
			unsubscribe();
			resolve();
		};
		const unsubscribe = client.subscribe(check);
		check();
	});
}

const home = process.env.ACE_HOME;
const root = process.env.TMPDIR;
if (!home || !root) throw new Error("Catalog gateway fixture requires ACE_HOME and TMPDIR");
const lanes = join(root, "lanes");
mkdirSync(lanes);
const host = await startHost({ loopback: true, config: { home, lanes, user: "owner", port: 0, environment: {}, worker: [process.execPath] }, models: () => [] });
const directory = join(home, "channels");
const mode = statSync(directory).mode & 0o777;
const client = new GatewayClient(host.url, host.token);
let runningRecord: ReturnType<typeof catalog.create> | undefined;
try {
	await waitFor(client, () => client.status === "open");
	const initialChannels = await client.request({ op: "channels" });
	if (!changed) throw new Error("Catalog observer callback was not captured");
	const notify = changed;

	if (process.argv.at(-1) === "unreadable") {
		chmodSync(directory, 0);
		let escaped: string | null = null;
		try { notify(null); } catch (error) { escaped = String(error); }
		const failureLogged = readFileSync(join(home, "logs/host.jsonl"), "utf8").includes('"gateway.catalog.rescan.failed"');
		const models = await client.request({ op: "models" });
		chmodSync(directory, mode);
		const modeRestored = (statSync(directory).mode & 0o777) === mode;
		const record = catalog.create(root);
		catalog.write({ ...record, active: 123 });
		const delivered = waitFor(client, () => client.channels.some(channel => channel.id === record.id && channel.active === 123));
		notify(record.id);
		await delivered;
		console.log(JSON.stringify({ initialChannels, escaped, failureLogged, models, modeRestored,
			deliveredActive: client.channels.find(channel => channel.id === record.id)?.active,
		}));
	} else if (process.argv.at(-1) === "skipped") {
		// A throwing frame logger rejects the chain; the next catalog callback is skipped entirely.
		await client.request({ op: "archive-inactive", project: join(root, "unused") });
		const record = catalog.create(root);
		runningRecord = record;
		const initial = waitFor(client, () => client.channels.some(channel => channel.id === record.id && channel.state === "dormant"));
		notify(record.id);
		await initial;
		await client.request({ op: "archive-inactive", project: join(root, "unused") });
		writeFileSync(catalog.paths(record.id).pid, String(process.pid));
		writeFileSync(catalog.paths(record.id).socket, "socket identity");
		const firstFailure = Promise.withResolvers<void>();
		const skippedFailure = Promise.withResolvers<void>();
		let frameFailures = 0;
		const log = logging.log;
		const logged = spyOn(logging, "log").mockImplementation((level, event, fields) => {
			log(level, event, fields);
			if (event !== "gateway.frame.failed") return;
			if (++frameFailures === 1) {
				firstFailure.resolve();
				throw new Error("One failed frame-log write");
			}
			skippedFailure.resolve();
		});
		try {
			chmodSync(directory, 0o111);
			notify(`${record.id}/channel.sock`);
			await firstFailure.promise;
			await client.request({ op: "models" });
			notify(`${record.id}/channel.sock`);
			await skippedFailure.promise;
			await client.request({ op: "models" });
		} finally {
			logged.mockRestore();
			chmodSync(directory, mode);
		}
		const recovered = waitFor(client, () => client.channels.some(channel => channel.id === record.id && channel.state === "running"));
		notify(record.id);
		await recovered;
		console.log(JSON.stringify({ initialChannels, frameFailures,
			recoveredState: client.channels.find(channel => channel.id === record.id)?.state,
		}));
	} else {
		// Join the startup frame queue before writing the record used by the failure scenario.
		await client.request({ op: "archive-inactive", project: join(root, "unused") });
		// Traversal still permits stat, but enumeration in the queued listing must fail.
		const queuedRecord = catalog.create(root);
		catalog.write({ ...queuedRecord, active: 123 });
		const frameFailed = Promise.withResolvers<void>();
		let frameFailures = 0;
		const log = logging.log;
		const logged = spyOn(logging, "log").mockImplementation((level, event, fields) => {
			log(level, event, fields);
			if (event === "gateway.frame.failed" && ++frameFailures === 2) frameFailed.resolve();
		});
		try {
			chmodSync(directory, 0o111);
			if (!statSync(catalog.paths(queuedRecord.id).record).size) throw new Error("Record is empty");
			notify(`${queuedRecord.id}/channel.json`);
			await frameFailed.promise;
			await client.request({ op: "models" });
		} finally {
			logged.mockRestore();
			chmodSync(directory, mode);
		}
		const queuedFailureLogged = readFileSync(join(home, "logs/host.jsonl"), "utf8").includes('"gateway.frame.failed"');
		const recovered = waitFor(client, () => client.channels.some(channel => channel.id === queuedRecord.id && channel.active === 123));
		notify(queuedRecord.id);
		await recovered;
		console.log(JSON.stringify({ initialChannels, queuedFailureLogged,
			recoveredActive: client.channels.find(channel => channel.id === queuedRecord.id)?.active,
			diskActive: catalog.read(queuedRecord.id).active,
		}));
	}
} finally {
	chmodSync(directory, mode);
	if (runningRecord) {
		rmSync(catalog.paths(runningRecord.id).pid, { force: true });
		rmSync(catalog.paths(runningRecord.id).socket, { force: true });
	}
	client.close();
	await host.close();
}
