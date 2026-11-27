import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { signInWorkspaceTab } from "../src/browser";
import * as catalog from "../src/catalog";
import { bindConfiguredCatalog, configure } from "../src/host-config";
import { readLaneWorkspace, stopLaneWorkspace, writeLaneWorkspace } from "../src/lane-workspace";
import { open as openLog } from "../src/log";
import { archive } from "../src/manage";

const noKeychainEntries = async () => 44;

async function fixture(run: (root: string) => Promise<void>) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "lane-workspace-")));
	try {
		await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test("stop signals only a recorded process with the same start time and removes only marked scratch", async () => {
	await fixture(async (root) => {
		const scratch = await mkdtemp(join(root, "workspace-"));
		const unmarked = await mkdtemp(join(root, "workspace-"));
		const alias = join(root, "workspace-Symlnk");
		await symlink(scratch, alias);
		const launcher = { pid: 49101, start: "launcher start", host: hostname() };
		const keeper = { pid: 49102, start: "keeper start", host: hostname() };
		await writeLaneWorkspace({ version: 1, scratch, lane: join(root, "lane"), launcher, keeper, ready: true });

		const signalled: number[] = [];
		const live = new Map([
			[launcher.pid, launcher],
			[keeper.pid, { ...keeper, start: "reused PID start" }],
		]);
		const monitor = {
			read: (pid: number) => live.get(pid),
			terminate(pid: number) {
				signalled.push(pid);
				live.delete(pid);
			},
		};
		expect(await stopLaneWorkspace(root, unmarked, monitor, undefined, undefined, noKeychainEntries)).toBe(false);
		expect(await stopLaneWorkspace(root, alias, monitor, undefined, undefined, noKeychainEntries)).toBe(false);
		expect(signalled).toEqual([]);
		expect(await stopLaneWorkspace(root, scratch, monitor, undefined, undefined, noKeychainEntries)).toBe(true);
		expect(await stopLaneWorkspace(root, scratch, monitor, undefined, undefined, noKeychainEntries)).toBe(false);
		expect(signalled).toEqual([launcher.pid]);
		expect(existsSync(scratch)).toBe(false);
		expect(existsSync(unmarked)).toBe(true);
	});
});

test("stop retains scratch until the launcher exits and both store workers have stopped", async () => {
	await fixture(async (root) => {
		const scratch = await mkdtemp(join(root, "workspace-"));
		const bin = join(scratch, "bin");
		const neuve = join(bin, "neuve");
		const project = join(scratch, "project");
		const coding = join(scratch, "captures", "coding");
		const capture = join(coding, "neuve");
		await mkdir(bin);
		await writeFile(neuve, "");
		await mkdir(join(project, ".git"), { recursive: true });
		await mkdir(capture, { recursive: true });
		await writeFile(join(capture, "records.sqlite"), "");
		await mkdir(join(coding, "unrelated"));
		const launcher = { pid: 49101, start: "launcher start", host: hostname() };
		const keeper = { pid: 49102, start: "keeper start", host: hostname() };
		await writeLaneWorkspace({ version: 1, scratch, lane: join(root, "lane"), launcher, keeper, ready: true });

		const live = new Map([[launcher.pid, launcher], [keeper.pid, keeper]]);
		const monitor = {
			read: (pid: number) => live.get(pid),
			terminate(pid: number) { live.delete(pid); },
		};
		let captureCanStop = false;
		let captureWorkerRunning = true;
		const commands: string[][] = [];
		const run = async (command: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number }) => {
			commands.push(command);
			expect(live.size).toBe(0);
			expect(existsSync(capture)).toBe(true);
			expect(options.cwd).toBe(project);
			expect(options.env.ACE_HOME).toBe(join(scratch, "state", "neuve-host"));
			expect(options.env.NEUVE_RECORDS_REGISTRY).toBe(join(scratch, "state", "repositories.json"));
			expect(options.env.NEUVE_WORKSPACE_PROJECT).toBe(project);
			expect(options.env.PATH?.split(":")[0]).toBe(bin);
			expect(options.timeout).toBeGreaterThan(0);
			if (command[2] === "stop") {
				if (command[4] === capture && captureCanStop) captureWorkerRunning = false;
				return 0;
			}
			return command[4] === capture && captureWorkerRunning ? 0 : 3;
		};
		await expect(stopLaneWorkspace(root, scratch, monitor, run, undefined, noKeychainEntries)).rejects.toThrow(`The worker for ${capture} is still running.`);
		expect((await readLaneWorkspace(root, scratch))?.lane).toBe(join(root, "lane"));

		captureCanStop = true;
		expect(await stopLaneWorkspace(root, scratch, monitor, run, undefined, noKeychainEntries)).toBe(true);
		expect(existsSync(scratch)).toBe(false);
		expect(commands).toEqual([
			[neuve, "worker", "stop", "--repo", project],
			[neuve, "worker", "status", "--repo", project],
			[neuve, "worker", "stop", "--store", capture],
			[neuve, "worker", "status", "--store", capture],
			[neuve, "worker", "stop", "--repo", project],
			[neuve, "worker", "status", "--repo", project],
			[neuve, "worker", "stop", "--store", capture],
			[neuve, "worker", "status", "--store", capture],
		]);
	});
});

test("stop clears the build's keychain entries and retains scratch on a keychain error", async () => {
	await fixture(async (root) => {
		const scratch = await mkdtemp(join(root, "workspace-"));
		const lane = join(root, "lane");
		await writeLaneWorkspace({
			version: 1, scratch, lane, ready: true,
			keeper: { pid: 49101, start: "keeper start", host: hostname() },
		});
		const monitor = { read: () => undefined, terminate() { throw new Error("Unexpected signal."); } };
		const service = `neuve-${scratch}/state/neuve-host`;
		const statuses = [0, 1, 0, 0, 44];
		const runKeychain = async (command: string[]) => {
			expect(command).toEqual(["/usr/bin/security", "delete-generic-password", "-s", service]);
			expect((await readLaneWorkspace(root, scratch))?.lane).toBe(lane);
			const status = statuses.shift();
			if (status === undefined) throw new Error("Unexpected keychain command.");
			return status;
		};
		const stop = () => stopLaneWorkspace(root, scratch, monitor, undefined, undefined, runKeychain);

		await expect(stop()).rejects.toThrow("exited with code 1");
		expect(statuses).toEqual([0, 0, 44]);
		expect((await readLaneWorkspace(root, scratch))?.lane).toBe(lane);
		expect(await stop()).toBe(true);
		expect(statuses).toEqual([]);
		expect(existsSync(scratch)).toBe(false);
	});
});

test.skipIf(process.getuid?.() === 0)("a partial scratch removal fails and leaves the workspace discoverable for retry", async () => {
	await fixture(async (root) => {
		const scratch = await mkdtemp(join(root, "workspace-"));
		const lane = join(root, "lane");
		const blocked = join(scratch, "state");
		await mkdir(blocked);
		await writeFile(join(blocked, "entry"), "");
		await writeLaneWorkspace({
			version: 1, scratch, lane, ready: true,
			keeper: { pid: 49101, start: "keeper start", host: hostname() },
		});
		const monitor = { read: () => undefined, terminate() { throw new Error("Unexpected signal."); } };
		await chmod(blocked, 0o500);
		try {
			await expect(stopLaneWorkspace(root, scratch, monitor, undefined, undefined, noKeychainEntries)).rejects.toThrow(scratch);
			expect((await readLaneWorkspace(root, scratch))?.lane).toBe(lane);
			expect(existsSync(join(blocked, "entry"))).toBe(true);
		} finally {
			await chmod(blocked, 0o700);
		}
		expect(await stopLaneWorkspace(root, scratch, monitor, undefined, undefined, noKeychainEntries)).toBe(true);
		expect(existsSync(scratch)).toBe(false);
	});
});

test("stop closes only the build's tab and leaves the development browser running", async () => {
	await fixture(async (root) => {
		const scratch = await mkdtemp(join(root, "workspace-"));
		const profile = join(root, "browser");
		const started = { pid: 49103, start: "browser start", host: hostname() };
		const browser = {
			profile, started,
			target: { browser: "f7835d64-88c3-4b79-bfb3-08bd2b9f2271", target_id: "lane-tab" },
		};
		await writeLaneWorkspace({
			version: 1, scratch, lane: join(root, "lane"), ready: true,
			keeper: { pid: 49101, start: "keeper start", host: hostname() },
			browser,
		});
		const signalled: number[] = [];
		const monitor = {
			read: (pid: number) => pid === started.pid && !signalled.includes(pid) ? started : undefined,
			terminate(pid: number) { signalled.push(pid); },
		};
		const tabs = new Set(["lane-tab", "owner-tab"]);
		const run = async () => { throw new Error("Unexpected worker command."); };
		expect(await stopLaneWorkspace(root, scratch, monitor, run, async (directory, target) => {
			expect(directory).toBe(profile);
			expect(target.browser).toBe(browser.target.browser);
			tabs.delete(target.target_id);
		}, noKeychainEntries)).toBe(true);
		expect([...tabs]).toEqual(["owner-tab"]);
		expect(signalled).toEqual([]);
	});
});

test("sign-in gives the token only to DevTools and suppresses an error echoing it", async () => {
	const token = "b".repeat(64);
	const address = "http://127.0.0.1:51234/?project=sample#dashboard";
	const calls: unknown[] = [];
	const recorded: string[] = [];
	const cdp = {
		async send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
			calls.push({ method, params });
			if (method === "Target.createTarget") return { targetId: "tab" };
			if (calls.length === 2) return { targetInfo: { url: `http://127.0.0.1:51234/?project=sample#token=${token}` } };
			return { targetInfo: { url: "http://127.0.0.1:51234/?project=sample" } };
		},
	};
	const record = async (id: string) => { recorded.push(id); };
	const signal = AbortSignal.timeout(2000);
	expect(await signInWorkspaceTab(cdp, address, token, record, signal)).toBeUndefined();
	expect(calls).toEqual([
		{ method: "Target.createTarget", params: { url: `http://127.0.0.1:51234/?project=sample#token=${token}` } },
		{ method: "Target.getTargetInfo", params: { targetId: "tab" } },
		{ method: "Target.getTargetInfo", params: { targetId: "tab" } },
	]);
	expect(recorded).toEqual(["tab"]);

	const echo = { async send() { throw new Error(`Chrome echoed ${token}`); } };
	await expect(signInWorkspaceTab(echo, address, token, record, signal))
		.rejects.toThrow(/^The dedicated development browser did not complete workspace sign-in\.$/);
	expect(recorded).toEqual(["tab"]);
});

test("archive stops only its recorded lanes and logs cleanup failure without undoing archive", async () => {
	await fixture(async (root) => {
		const home = join(root, "host"), lanes = join(root, "lanes"), project = join(root, "project");
		for (const path of [home, lanes, project]) await mkdir(path);
		configure({ home, lanes, user: "owner", port: 0, environment: {}, worker: [process.execPath] });
		await bindConfiguredCatalog();
		openLog("host");
		const record = catalog.create(project, undefined, "cleanup");
		const name = "chat-1";
		const lane = join(catalog.paths(record.id).lanes, name);
		const other = catalog.create(project, undefined, "other");
		const otherLane = join(catalog.paths(other.id).lanes, name);
		for (const [channel, path] of [[record, lane], [other, otherLane]] as const) {
			catalog.write({ ...channel, chatLanes: { [name]: { path, branch: `${channel.prefix}/${name}`, base: "HEAD" } } });
		}
		const stopped: string[][] = [];
		const stop = async (paths: readonly string[]) => {
			stopped.push([...paths]);
			throw new Error("workspace cleanup refused");
		};
		expect((await archive(record.id, true, stop)).archived).toBe(true);
		expect((await archive(record.id, false, stop)).archived).toBe(false);
		expect(stopped).toEqual([[lane]]);
		const log = await readFile(join(home, "logs/host.jsonl"), "utf8");
		expect(log).toContain('"event":"lane.workspace.retained"');
		expect(log).toContain("workspace cleanup refused");
	});
});
