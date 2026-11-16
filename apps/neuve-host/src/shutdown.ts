import { deadlineTimer } from "../../../packages/harness/src/pi/capture/watchdog.ts";
import {confirmClose, workerCloseTimeout} from "./worker-close";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as catalog from "./catalog";
import { Connection } from "./client";
import { failure, log } from "./log";
import type { WorkerInfo } from "./protocol";

function receipt(): string[] {
	const path = join(catalog.home, "resume.json");
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
}

function remember(ids: string[]): void {
	const path = join(catalog.home, "resume.json");
	if (!ids.length) return rmSync(path, { force: true });
	writeFileSync(`${path}.tmp`, JSON.stringify(ids), { mode: 0o600 });
	renameSync(`${path}.tmp`, path);
}

async function close(id: string, connection: Connection): Promise<void> {
	let stopTimer: (() => void) | undefined;
	const timeout = workerCloseTimeout(catalog.paths(id).base);
	const deadline = Date.now() + timeout;
	try {
		await Promise.race([
			(async () => {
				// Stale pid files must never cause the host to signal an unrelated process.
				const worker = await connection.request<WorkerInfo>({ op: "worker" });
				if (worker.id !== id || !Number.isSafeInteger(worker.pid) || worker.pid <= 0) {
					throw new Error(`Cannot identify the worker for channel ${id}`);
				}
				try {
					process.kill(worker.pid, "SIGTERM");
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
				}
				await connection.closed;
				confirmClose(catalog.paths(id).base, worker.pid);
				// A closed socket precedes process exit; installation needs both to finish.
				while (Date.now() < deadline) {
					try {
						process.kill(worker.pid, 0);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
						throw error;
					}
					await Bun.sleep(50);
				}
				throw new Error(`Channel ${id} did not exit within ${timeout / 1_000} seconds`);
			})(),
			new Promise<never>((_, reject) => {
				stopTimer = deadlineTimer(
                    performance.now() + Math.max(0, deadline - Date.now()),
					() => reject(new Error(`Channel ${id} did not close within ${timeout / 1_000} seconds`)),
				);
			}),
		]);
	} finally {
		stopTimer?.();
		connection.close();
	}
}

/** A host shutdown suspends local work; it must not write pi's durable abort marks. */
export async function shutdown(): Promise<void> {
	const workers = new Map<string, Connection>();
	try {
		for (const record of catalog.list()) {
			if (record.hosted) continue;
			const connection = await Connection.running(record.id);
			if (connection) workers.set(record.id, connection);
		}
		// This contains only worker IDs. All resumable work remains in pi's stores.
		remember([...new Set([...receipt(), ...workers.keys()])]);
	} catch (error) {
		for (const connection of workers.values()) connection.close();
		throw error;
	}
	const results = await Promise.allSettled(
		[...workers].map(([id, connection]) => close(id, connection)),
	);
	const failures = results.filter((result) => result.status === "rejected");
	if (failures.length) {
		throw new AggregateError(
			failures.map((result) => result.reason),
			"Some channel workers did not close",
		);
	}
}

/** Wake interrupted workers without waiting for a desktop or teammate to attach. */
export async function resume(): Promise<void> {
	const records = new Map(catalog.list().map((record) => [record.id, record]));
	const failed: string[] = [];
	await Promise.all(
		receipt().map(async (id) => {
			const record = records.get(id);
			if (!record || record.hosted || record.archived) return;
			try {
				const connection = await Connection.open(id);
				await connection.request({ op: "worker" });
				connection.close();
				log("info", "worker.resumed", { channel: id });
			} catch (error) {
				failed.push(id);
				log("error", "worker.resume.failed", { channel: id, ...failure(error) });
			}
		}),
	);
	remember(failed);
}
