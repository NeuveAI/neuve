import { readdirSync, statSync } from "node:fs";
import { basename, join, normalize } from "node:path";

type File = "channel.json" | "channel.sock";
const files: File[] = ["channel.json", "channel.sock"];
const unconfirmed = Symbol("unconfirmed");
type Observation = { signature: string | undefined | typeof unconfirmed; notified: boolean };

/** Observe before queuing readers, so a later write can never be marked seen by an older reader. */
export function catalogChanges(directory: string, actions: {
	broadcast(): void | Promise<boolean>;
	recordChanged(): void;
	rescanned(channel: string, file: File, event: string | null): void;
	failed(error: unknown): void;
}) {
	const seen = new Map<string, Partial<Record<File, Observation>>>();
	const failed = (error: unknown): void => {
		// Logging must precede recovery, which can hit the same unreadable catalog.
		try { actions.failed(error); } catch { /* The observer callback must never throw, even if logging fails. */ }
	};
	const attempt = (action: () => void): boolean => {
		try { action(); return true; }
		catch (error) { failed(error); return false; }
	};
	const recover = (error: unknown): void => {
		failed(error);
		attempt(() => { void actions.broadcast()?.catch(failed); });
		attempt(() => actions.recordChanged());
	};
	const channels = (): string[] => {
		try {
			return readdirSync(directory, { withFileTypes: true })
				.filter(entry => entry.isDirectory()).map(entry => entry.name);
		} catch (error) {
			if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return [];
			throw error;
		}
	};
	const signature = (channel: string, file: File): string | undefined => {
		try {
			const stat = statSync(join(directory, channel, file), { bigint: true, throwIfNoEntry: false });
			// Atomic renames replace the inode; nanosecond times and size also cover in-place writes.
			return stat && `${stat.dev}:${stat.ino}:${stat.ctimeNs}:${stat.mtimeNs}:${stat.size}`;
		} catch (error) {
			// Root files such as names.lock are not channel folders; removed folders can become files too.
			if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return undefined;
			throw error;
		}
	};
	try {
		for (const channel of channels()) {
			// Startup establishes a baseline, but no delivery has been queued after these reads.
			const current = Object.fromEntries(files.map(file => [file, { signature: signature(channel, file), notified: false }]));
			if (files.some(file => current[file].signature !== undefined)) seen.set(channel, current);
		}
	} catch (error) {
		recover(error);
	}
	return (file: string | null): void => {
		const changes: { channel: string; file: File; signature: string | undefined }[] = [];
		const absent: string[] = [];
		let ancestor = false;
		try {
			const path = normalize(file ?? "");
			const parts = path.split("/");
			const channel = parts[0];
			const named = files.find(name => file?.endsWith(name));
			const all = path === "." || path === "/" || path === directory || path === basename(directory);
			// Coalescing names an ancestor: a deeper lane path cannot represent these two direct children.
			if (!named && !all && parts.length > 2) return;
			ancestor = !named && (all || parts.length === 1);
			for (const id of !named && all ? new Set([...seen.keys(), ...channels()]) : [channel]) {
				const currentFiles = { ...seen.get(id) };
				for (const name of named ? [named] : files) {
					const current = signature(id, name);
					currentFiles[name] = { signature: current, notified: false };
					const before = seen.get(id)?.[name];
					if (before?.signature === current && (!named || before?.notified)) continue;
					changes.push({ channel: id, file: name, signature: current });
				}
				if (currentFiles["channel.json"] && currentFiles["channel.sock"] &&
					currentFiles["channel.json"].signature === undefined && currentFiles["channel.sock"].signature === undefined) absent.push(id);
			}
		} catch (error) {
			// Commit no partial observations: the next event must still be able to detect this write.
			recover(error);
			return;
		}
		if (!changes.length) {
			for (const channel of absent) seen.delete(channel);
			return;
		}
		const queued = (() => {
			try { return { outcome: actions.broadcast() }; }
			catch (error) { failed(error); return undefined; }
		})();
		const confirmed: { channel: string; file: File; observation: Observation }[] = [];
		if (changes.some(change => change.file === "channel.json")) attempt(() => actions.recordChanged());
		for (const change of changes) {
			if (queued) {
				const before = seen.get(change.channel) ?? {};
				const observation = { signature: change.signature, notified: true };
				seen.set(change.channel, { ...before, [change.file]: observation });
				confirmed.push({ channel: change.channel, file: change.file, observation });
			}
			if (ancestor) attempt(() => actions.rescanned(change.channel, change.file, file));
		}
		// Deletion delivery needs no tombstone; root scans should track current channels only.
		if (queued) for (const channel of absent) seen.delete(channel);
		const undo = () => {
			for (const { channel, file, observation } of confirmed) {
				const current = seen.get(channel);
				// Identity also protects a later confirmation of the same signature and never recreates a dropped channel.
				if (current?.[file] === observation) current[file] = { signature: unconfirmed, notified: false };
			}
		};
		void queued?.outcome?.then(delivered => { if (!delivered) undo(); }, error => { undo(); failed(error); });
	};
}
