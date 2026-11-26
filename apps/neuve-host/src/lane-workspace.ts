import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { Ancestry } from "@neuve/records-core";
import { processAlive, withFileLock } from "@neuve/records-core/file-lock";
import { z } from "zod";
import { closeWorkspaceTab } from "./browser";

const VOLUME = "/Volumes/LaCie Blu";
const MARKER = ".neuve-lane-workspace.json";
const NAME = /^workspace-[A-Za-z0-9]{6}$/;
const absolutePath = z.string().refine(isAbsolute);
const identity = z.strictObject({
	pid: z.int().positive(),
	start: z.string().min(1),
	host: z.string().min(1),
});

const Marker = z.strictObject({
	version: z.literal(1),
	scratch: absolutePath,
	lane: absolutePath,
	keeper: identity,
	launcher: identity.optional(),
	browser: z.strictObject({
		profile: absolutePath,
		started: identity.optional(),
		target: z.strictObject({
			browser: z.uuid(),
			target_id: z.string().min(1),
		}).optional(),
	}).optional(),
	ready: z.boolean(),
});
export type LaneWorkspace = z.infer<typeof Marker>;

function missing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export async function validationRoot(create = false): Promise<string | undefined> {
	const root = join(VOLUME, "neuve-validation");
	try {
		const [mount, parent] = await Promise.all([lstat(VOLUME), stat(dirname(VOLUME))]);
		if (!mount.isDirectory() || mount.dev === parent.dev) return;
		if (create) await mkdir(root, { mode: 0o700 }).catch((error: unknown) => {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
		});
		const info = await lstat(root);
		if (!info.isDirectory() || info.dev !== mount.dev || info.uid !== process.getuid?.() || await realpath(root) !== root)
			throw new Error(`Expected an owned directory on LaCie at ${root}.`);
		return root;
	} catch (error) {
		if (!missing(error)) throw error;
	}
}

export async function readLaneWorkspace(root: string, scratch: string): Promise<LaneWorkspace | undefined> {
	if (dirname(scratch) !== root || !NAME.test(basename(scratch))) return;
	try {
		const [directory, parent] = await Promise.all([lstat(scratch), stat(root)]);
		if (!directory.isDirectory() || directory.uid !== process.getuid?.() || directory.dev !== parent.dev ||
			(directory.mode & 0o077) !== 0) return;
		const path = join(scratch, MARKER);
		const file = await lstat(path);
		if (!file.isFile() || file.uid !== directory.uid || file.nlink !== 1 ||
			(file.mode & 0o077) !== 0) return;
		const marker = Marker.safeParse(JSON.parse(await readFile(path, "utf8")));
		if (marker.success && marker.data.scratch === scratch) return marker.data;
	} catch (error) {
		if (!missing(error) && !(error instanceof SyntaxError)) throw error;
	}
}

export async function writeLaneWorkspace(state: LaneWorkspace): Promise<void> {
	const path = join(state.scratch, MARKER);
	const temp = `${path}.${process.pid}`;
	await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
	await rename(temp, path);
}

export function withLaneWorkspace<A>(scratch: string, work: () => Promise<A>, signal?: AbortSignal): Promise<A> {
	return withFileLock(join(dirname(scratch), `.${basename(scratch)}.lock`), work, 120_000, signal);
}

export function withLaneBrowser<A>(root: string, profile: string, work: () => Promise<A>, signal?: AbortSignal): Promise<A> {
	const name = createHash("sha256").update(profile).digest("hex");
	return withFileLock(join(root, `.browser-${name}.lock`), work, 30_000, signal);
}

async function workspaceDirectories(root: string): Promise<string[]> {
	return (await readdir(root, { withFileTypes: true }))
		.filter((entry) => entry.isDirectory() && NAME.test(entry.name))
		.map((entry) => join(root, entry.name));
}

export function currentProcess(pid: number): Ancestry.ProcessIdentity | undefined {
	const table = Ancestry.snapshotProcesses();
	const row = table?.get(pid);
	if (row) return Ancestry.identityOf(row);
	if (processAlive(pid)) throw new Error(`Cannot verify the start time of process ${pid}.`);
}

const processes = {
	read: currentProcess,
	terminate(pid: number) {
		try {
			process.kill(pid, "SIGTERM");
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
		}
	},
};

async function stopProcess(recorded: Ancestry.ProcessIdentity | undefined, monitor: typeof processes): Promise<void> {
	if (!recorded) return;
	if (recorded.host !== hostname()) throw new Error("This workspace was started on another host.");
	const stillOwned = () => {
		const current = monitor.read(recorded.pid);
		return current !== undefined && Ancestry.sameProcess(recorded, current);
	};
	if (!stillOwned()) return;
	monitor.terminate(recorded.pid);
	const deadline = Date.now() + 150_000;
	while (stillOwned()) {
		if (Date.now() >= deadline) throw new Error(`Process ${recorded.pid} did not exit after TERM.`);
		await Bun.sleep(250);
	}
}

export async function stopLaneWorkspace(root: string, scratch: string, monitor = processes): Promise<boolean> {
	if (!await readLaneWorkspace(root, scratch)) return false;
	return withLaneWorkspace(scratch, async () => {
		let state = await readLaneWorkspace(root, scratch);
		if (!state) return false;
		// Stop interrupted startup before it can register a new process or tab.
		if (!state.ready) {
			await stopProcess(state.keeper, monitor);
			state = await readLaneWorkspace(root, scratch);
			if (!state) return false;
		}
		await stopProcess(state.launcher, monitor);
		await stopProcess(state.keeper, monitor);
		const { keeper, browser: registeredBrowser } = state;
		const removeScratch = async () => {
			await rm(scratch, { recursive: true, force: true });
			return true;
		};
		const finish = async () => {
			// Another stop may have passed us the browser while we waited for the lock.
			const current = await readLaneWorkspace(root, scratch);
			if (!current || !Ancestry.sameProcess(current.keeper, keeper)) return false;
			const browser = current.browser;
			if (browser?.target) await closeWorkspaceTab(browser.profile, browser.target);
			if (browser?.started) {
				for (const other of await workspaceDirectories(root)) {
					if (other === scratch) continue;
					const user = await readLaneWorkspace(root, other);
					if (user?.browser?.profile !== browser.profile) continue;
					if (!user.browser.started) {
						user.browser.started = browser.started;
						await writeLaneWorkspace(user);
					}
					return removeScratch();
				}
				await stopProcess(browser.started, monitor);
			}
			return removeScratch();
		};
		return registeredBrowser ? withLaneBrowser(root, registeredBrowser.profile, finish) : finish();
	});
}

export async function stopLaneWorkspaces(lanes: readonly string[], onError?: (error: unknown) => void): Promise<void> {
	if (lanes.length === 0) return;
	const root = await validationRoot();
	if (!root) return;
	const paths = await Promise.all(lanes.map((lane) => realpath(lane).catch(() => lane)));
	const errors: unknown[] = [];
	for (const scratch of await workspaceDirectories(root)) {
		try {
			const state = await readLaneWorkspace(root, scratch);
			if (state && paths.includes(state.lane)) await stopLaneWorkspace(root, scratch);
		} catch (error) {
			if (onError) onError(error);
			else errors.push(error);
		}
	}
	if (errors.length) throw new Error(errors.map(error => error instanceof Error ? error.message : String(error)).join("\n"));
}
