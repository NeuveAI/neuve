import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { Ancestry, storeLocationIn } from "@neuve/records-core";
import { processAlive, withFileLock } from "@neuve/records-core/file-lock";
import { z } from "zod";
import { closeWorkspaceTab } from "./browser";
import { GIT_LOCAL, workspaceSettingsEnvironment } from "./host-config";

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
	// Strip the browser process identity from markers written by earlier builds.
	browser: z.object({
		profile: absolutePath,
		target: z.strictObject({
			browser: z.uuid(),
			target_id: z.string().min(1),
		}).optional(),
	}).optional(),
	ready: z.boolean(),
});
export type LaneWorkspace = z.infer<typeof Marker>;

export function laneWorkspaceEnvironment(scratch: string, path = process.env.PATH) {
	const home = join(scratch, "state", "neuve-host");
	return {
		ACE_HOME: home,
		...workspaceSettingsEnvironment(home),
		NEUVE_RECORDS_REGISTRY: join(scratch, "state", "repositories.json"),
		NEUVE_WORKSPACE_PROJECT: join(scratch, "project"),
		PATH: `${join(scratch, "bin")}:${path ?? "/usr/bin:/bin"}`,
	};
}

function missing(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function ignoreMissing(error: unknown): undefined {
	if (!missing(error)) throw error;
	return undefined;
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

async function runCommand(command: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number }): Promise<number> {
	return Bun.spawn(command, {
		...options, stdin: "ignore", stdout: "ignore", stderr: "ignore", killSignal: "SIGKILL",
	}).exited;
}

async function stopWorkspaceWorkers(scratch: string, run: typeof runCommand): Promise<void> {
	const binary = join(scratch, "bin", "neuve");
	const environment = laneWorkspaceEnvironment(scratch);
	const project = environment.NEUVE_WORKSPACE_PROJECT;
	try {
		const executable = await lstat(binary).catch(ignoreMissing);
		if (!executable) return;
		const checkout = await lstat(project).catch(ignoreMissing);
		const git = checkout?.isDirectory() ? await lstat(join(project, ".git")).catch(ignoreMissing) : undefined;
		if (!executable.isFile() || (checkout && !checkout.isDirectory()) || (git && !git.isDirectory()))
			throw new Error("Expected the lane's Neuve executable and project clone.");

		const stores: { flag: "--repo" | "--store"; path: string }[] = [];
		if (git) stores.push({ flag: "--repo", path: project });
		const capture = storeLocationIn(join(scratch, "captures", "coding")).directory;
		if ((await lstat(capture).catch(ignoreMissing))?.isDirectory() && await realpath(capture) === capture)
			stores.push({ flag: "--store", path: capture });

		const env: NodeJS.ProcessEnv = { ...process.env, ...environment };
		for (const key of GIT_LOCAL) delete env[key];
		const options = { cwd: git ? project : scratch, env };
		for (const { flag, path } of stores) {
			const stopped = await run([binary, "worker", "stop", flag, path], { ...options, timeout: 15_000 });
			if (stopped !== 0) throw new Error(`neuve worker stop for ${path} exited with code ${stopped}.`);
			const status = await run([binary, "worker", "status", flag, path], { ...options, timeout: 5_000 });
			if (status === 3) continue; // The store has no worker.
			if (status === 0) throw new Error(`The worker for ${path} is still running.`);
			throw new Error(`neuve worker status for ${path} exited with code ${status}.`);
		}
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not confirm worker shutdown. Kept workspace scratch at ${scratch}. ${detail}`);
	}
}

async function clearWorkspaceKeychain(scratch: string, run: typeof runCommand): Promise<void> {
	const { ACE_KEYCHAIN_SERVICE: service } = laneWorkspaceEnvironment(scratch);
	const command = ["/usr/bin/security", "delete-generic-password", "-s", service];
	const options = { cwd: scratch, env: process.env, timeout: 15_000 };
	let status = 0;
	while (status === 0) status = await run(command, options);
	// security exits with 44 when no matching item remains.
	if (status !== 44) throw new Error(`Could not clear keychain entries for workspace ${scratch}. security exited with code ${status}.`);
}

async function removeWorkspaceScratch(state: LaneWorkspace): Promise<void> {
	const { scratch } = state;
	try {
		const entries = await readdir(scratch).catch(ignoreMissing);
		if (!entries) return;
		for (const entry of entries) {
			if (entry !== MARKER) await rm(join(scratch, entry), { recursive: true, force: true });
		}
		const remaining = await readdir(scratch).catch(ignoreMissing);
		if (!remaining) return;
		if (remaining.some((entry) => entry !== MARKER)) throw new Error("The directory still contains workspace files.");
		await unlink(join(scratch, MARKER)).catch(ignoreMissing);
		try {
			await rmdir(scratch).catch(ignoreMissing);
			if (await lstat(scratch).catch(ignoreMissing)) throw new Error("The directory still exists.");
		} catch (error) {
			await writeLaneWorkspace(state);
			throw error;
		}
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not remove workspace scratch at ${scratch}. ${detail}`, { cause: error });
	}
}

export async function stopLaneWorkspace(
	root: string,
	scratch: string,
	monitor = processes,
	run = runCommand,
	closeTab = closeWorkspaceTab,
	runKeychain = process.platform === "darwin" ? runCommand : undefined,
): Promise<boolean> {
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
		await stopWorkspaceWorkers(scratch, run);
		const { browser } = state;
		if (browser?.target) await closeTab(browser.profile, browser.target);
		if (runKeychain) await clearWorkspaceKeychain(scratch, runKeychain);
		await removeWorkspaceScratch(state);
		return true;
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
