import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { signInWorkspaceTab } from "../src/browser";
import * as catalog from "../src/catalog";
import { bindConfiguredCatalog, configure } from "../src/host-config";
import { stopLaneWorkspace, writeLaneWorkspace } from "../src/lane-workspace";
import { open as openLog } from "../src/log";
import { archive } from "../src/manage";

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
		expect(await stopLaneWorkspace(root, unmarked, monitor)).toBe(false);
		expect(await stopLaneWorkspace(root, alias, monitor)).toBe(false);
		expect(signalled).toEqual([]);
		expect(await stopLaneWorkspace(root, scratch, monitor)).toBe(true);
		expect(await stopLaneWorkspace(root, scratch, monitor)).toBe(false);
		expect(signalled).toEqual([launcher.pid]);
		expect(existsSync(scratch)).toBe(false);
		expect(existsSync(unmarked)).toBe(true);
	});
});

test("stop retains the scratch until the lane build confirms its review worker has stopped", async () => {
	await fixture(async (root) => {
		const scratch = await mkdtemp(join(root, "workspace-"));
		const bin = join(scratch, "bin");
		const neuve = join(bin, "neuve");
		const project = join(scratch, "project");
		await mkdir(bin);
		await writeFile(neuve, "");
		await mkdir(join(project, ".git"), { recursive: true });
		const keeper = { pid: 49102, start: "keeper start", host: hostname() };
		await writeLaneWorkspace({ version: 1, scratch, lane: join(root, "lane"), keeper, ready: true });

		let keeperAlive = true;
		const monitor = {
			read: () => keeperAlive ? keeper : undefined,
			terminate() { keeperAlive = false; },
		};
		let workerRunning = true;
		const commands: string[][] = [];
		const run = async (command: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number }) => {
			commands.push(command);
			expect(keeperAlive).toBe(false);
			expect(existsSync(scratch)).toBe(true);
			expect(options.cwd).toBe(project);
			expect(options.env.ACE_HOME).toBe(join(scratch, "state", "neuve-host"));
			expect(options.env.NEUVE_RECORDS_REGISTRY).toBe(join(scratch, "state", "repositories.json"));
			expect(options.env.NEUVE_WORKSPACE_PROJECT).toBe(project);
			expect(options.env.PATH?.split(":")[0]).toBe(bin);
			expect(options.timeout).toBeGreaterThan(0);
			return command[2] === "status" && !workerRunning ? 3 : 0;
		};
		await expect(stopLaneWorkspace(root, scratch, monitor, run)).rejects.toThrow("The review worker is still running.");
		expect(existsSync(scratch)).toBe(true);

		workerRunning = false;
		expect(await stopLaneWorkspace(root, scratch, monitor, run)).toBe(true);
		expect(existsSync(scratch)).toBe(false);
		expect(commands).toEqual([
			[neuve, "worker", "stop", "--repo", project],
			[neuve, "worker", "status", "--repo", project],
			[neuve, "worker", "stop", "--repo", project],
			[neuve, "worker", "status", "--repo", project],
		]);
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
		expect(await stopLaneWorkspace(root, scratch, monitor, undefined, async (directory, target) => {
			expect(directory).toBe(profile);
			expect(target.browser).toBe(browser.target.browser);
			tabs.delete(target.target_id);
		})).toBe(true);
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
