import "./fixtures/memory-secrets";
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { Changes, ChannelInfo, Event } from "@ace/channel/protocol";
import * as catalog from "../src/catalog";
import { assign } from "../src/channel-create";
import { unready } from "../src/compute";
import { configure, bindConfiguredCatalog } from "../src/host-config";
import { archive } from "../src/manage";
import { open as openLog } from "../src/log";
import { GatewayClient } from "../src/private-gateway-client";
import { nativeHandoff } from "../src/review";
import { startHost } from "./fixture-host";
import { plantNested } from "../../../packages/channel/tests/helpers";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function git(project: string, ...args: string[]) {
	const result = Bun.spawnSync(["git", "-C", project, ...args]);
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	return result.stdout.toString().trim();
}
async function setup() {
	// Short enough for the native Unix socket even when TMPDIR is long.
	const root = await realpath(await mkdtemp(join(tmpdir(), "cl"))); roots.push(root);
	const home = join(root, "h"), lanes = join(root, "l"), project = join(root, "p");
	for (const path of [home, lanes, project]) await mkdir(path);
	git(project, "init", "-q", "-b", "main");
	await writeFile(join(project, "README.md"), "checkout\n");
	git(project, "add", "README.md");
	git(project, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "-m", "fixture");
	return { root, home, lanes, project };
}
async function local() {
	const place = await setup();
	configure({ home: place.home, lanes: place.lanes, user: "owner", port: 0, environment: {}, worker: [process.execPath] });
	await bindConfiguredCatalog(); openLog("host");
	return { ...place, record: catalog.create(place.project, undefined, "cleanup") };
}
function owned(record: catalog.Listing, name = `chat-${ROOT_CONVERSATION_ID}`) {
	const path = join(catalog.paths(record.id).lanes, name), branch = `${record.prefix}/${name}`;
	git(record.project, "worktree", "add", "-b", branch, path, "HEAD");
	const lane = { path, branch, base: git(record.project, "rev-parse", "HEAD") };
	catalog.write({ ...catalog.read(record.id), chatLanes: { ...catalog.read(record.id).chatLanes, [name]: lane } });
	return lane;
}

test("archive removes only host-created clean chat worktrees, retains refs/history and repeats safely", async () => {
	const { record } = await local();
	const lane = owned(record);
	const build = join(catalog.paths(record.id).lanes, "build-example");
	git(record.project, "worktree", "add", "-b", "cleanup/build-example", build, "HEAD");
	await writeFile(join(catalog.paths(record.id).base, "history-proof.txt"), "retained history");
	await archive(record.id, true);
	expect(existsSync(lane.path)).toBe(false);
	expect(git(record.project, "worktree", "list", "--porcelain")).not.toContain(`worktree ${lane.path}`);
	expect(git(record.project, "rev-parse", `refs/heads/${lane.branch}`)).toBe(lane.base);
	expect(existsSync(build)).toBe(true);
	expect(await readFile(join(catalog.paths(record.id).base, "history-proof.txt"), "utf8")).toBe("retained history");
	expect((await archive(record.id, true)).archived).toBe(true);
	expect((await archive(record.id, false)).chatLanes).toEqual(catalog.read(record.id).chatLanes);
});

// Review, the move to a cloud workspace and archive read a lane whose nested repositories an agent
// can configure; none of them may run those repositories' settings on the host.
test("review, compute and archive never run a nested repository's settings", async () => {
	const { record, root } = await local();
	const name = `chat-${ROOT_CONVERSATION_ID}`;
	const lane = owned(record, name);
	const { ran } = await plantNested(lane.path, root);
	const head = git(lane.path, "rev-parse", "HEAD");
	const review = () => nativeHandoff(record.id, { kind: "lane" }, {
		chat: ROOT_CONVERSATION_ID,
		lane: { name, path: lane.path, base: lane.base },
		planning: { selection: null, review: null },
		items: [],
	});
	const refused = await review().catch((error: Error) => error.message);
	await rm(join(lane.path, "loose"), { recursive: true });
	const reviewed = await review().catch((error: Error) => error.message);

	const cloud = join(record.project, ".lane", "trees", record.prefix, "cloud");
	git(record.project, "worktree", "add", "-qb", `${record.prefix}/cloud`, cloud, lane.base);
	git(record.project, "remote", "add", "origin", record.project);
	await mkdir(join(root, "cloud"));
	const cloudPlant = await plantNested(cloud, join(root, "cloud"));
	await rm(join(cloud, "loose"), { recursive: true });
	const moving = await unready(record);
	const archived = (await archive(record.id, true)).archived;

	expect(await ran() + await cloudPlant.ran()).toBe("");
	// The untracked nested repository counts once, as work only on disk; the submodule's own edits don't.
	expect(refused).toContain("1 uncommitted or untracked path");
	expect(reviewed).toMatchObject({ head, base: lane.base, cwd: lane.path });
	expect(moving).toEqual([]);
	expect(archived).toBe(true);
});

for (const reason of ["dirty", "locked", "changed registration"] as const) test(`archive honestly retains ${reason} lanes with a warning`, async () => {
	const { record, home } = await local();
	const lane = owned(record);
	if (reason === "dirty") {
		git(lane.path, "config", "status.showUntrackedFiles", "no");
		await writeFile(join(lane.path, "untracked.txt"), "do not discard");
	} else if (reason === "locked") git(record.project, "worktree", "lock", "--reason", "owner work", lane.path);
	else git(lane.path, "checkout", "-b", "different-owner");
	expect((await archive(record.id, true)).archived).toBe(true);
	expect(existsSync(lane.path)).toBe(true);
	const logs = (await readFile(join(home, "logs/host.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
	const error = reason === "changed registration" ? "The work lane's Git registration changed, so it was kept" : expect.any(String);
	expect(logs).toContainEqual(expect.objectContaining({ event: "chat.lane.retained", channel: record.id, path: lane.path, error }));
	if (reason === "dirty") expect(await readFile(join(lane.path, "untracked.txt"), "utf8")).toBe("do not discard");
	expect(git(record.project, "show-ref", "--verify", `refs/heads/${lane.branch}`)).toContain(lane.base);
});

test("a caller-supplied explicit chat-* worktree is not host disposal authority", async () => {
	const { record } = await local();
	const name = `chat-${ROOT_CONVERSATION_ID}`, path = join(catalog.paths(record.id).lanes, name);
	git(record.project, "worktree", "add", "-b", "caller/chat", path, "HEAD");
	await assign(record, { name, path, base: "HEAD" });
	await archive(record.id, true);
	expect(existsSync(path)).toBe(true);
	expect(catalog.read(record.id).chatLanes).toBeUndefined();
});

test("native catalog creation reaches shell/files on first worker turn; archive/unarchive restores work, history and the Diff base", async () => {
	const place = await setup();
	const script = join(place.root, "s.json");
	await writeFile(script, JSON.stringify([
		{ tool: "bash", args: { command: "pwd; git branch --show-current; git rev-parse --git-common-dir" }, id: "first-shell" },
		{ tool: "write", args: { path: "committed.txt", content: "keep me" }, id: "first-file" },
		{ tool: "lane", args: { action: "switch", name: `chat-${ROOT_CONVERSATION_ID}`, base: "main" }, id: "set-diff-base" },
		{ text: "First command done" },
		{ tool: "bash", args: { command: "pwd; cat committed.txt" }, id: "reopened-shell" },
		{ text: "Reopened successfully" },
	]));
	await writeFile(`${script}.cursor`, "0");
	const host = await startHost({ models: () => [{ provider: "faux", modelId: "coder", efforts: ["off"] }], config: {
		home: place.home, lanes: place.lanes, user: "owner", port: 0,
		environment: { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), NEUVE_TEST_SCRIPT: script },
		worker: [process.execPath, "--preload", join(import.meta.dir, "fixtures/memory-secrets.ts"), ...(process.env.NEUVE_TEST_TSCONFIG ? ["--tsconfig-override", process.env.NEUVE_TEST_TSCONFIG] : []), join(import.meta.dir, "worker.ts")],
	} });
	const client = new GatewayClient(host.url, host.token);
	let record: catalog.Listing | undefined;
	try {
		await new Promise<void>(resolve => {
			const stop = client.subscribe(() => { if (client.status === "open") { stop(); resolve(); } });
			if (client.status === "open") { stop(); resolve(); }
		});
		// The CLI's native `ace new` writes the catalog, not the extension create path.
		record = catalog.create(place.project, undefined, "ordinary");
		expect(record.lane).toBeUndefined();
		const before = { head: git(place.project, "rev-parse", "HEAD"), index: await readFile(join(place.project, ".git/index")), status: git(place.project, "status", "--porcelain") };
		const events: Event[] = [];
		await client.channel(record.id, { op: "watch", queue: true, progress: true }, { event: value => events.push(value) });
		const { submission } = await client.channel<{ submission: number }>(record.id, { op: "ask", author: "owner", text: "First write-capable turn" });
		expect(await client.channel(record.id, { op: "wait", submission })).toBe("done");
		const lane = catalog.read(record.id).chatLanes![`chat-${ROOT_CONVERSATION_ID}`]!;
		expect(lane.base).toBe(before.head);
		expect((await client.channel<Changes>(record.id, { op: "changes" })).against).toBe("refs/heads/main");
		expect(JSON.stringify(events.filter(event => event.kind === "result"))).toContain(lane.path);
		expect(await readFile(join(lane.path, "committed.txt"), "utf8")).toBe("keep me");
		expect(git(place.project, "rev-parse", "HEAD")).toBe(before.head);
		expect(await readFile(join(place.project, ".git/index"))).toEqual(before.index);
		expect(git(place.project, "status", "--porcelain")).toBe(before.status);
		git(lane.path, "add", "committed.txt");
		git(lane.path, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "committed work");
		const retained = git(lane.path, "rev-parse", "HEAD");
		await client.request({ op: "archive", channel: record.id, archived: true });
		expect(existsSync(lane.path)).toBe(false);
		expect(git(place.project, "rev-parse", `refs/heads/${lane.branch}`)).toBe(retained);
		await client.request({ op: "archive", channel: record.id, archived: true });
		await client.request({ op: "archive", channel: record.id, archived: false });
		const again = await client.channel<{ submission: number }>(record.id, { op: "ask", author: "owner", text: "Read the retained work" });
		expect(await client.channel(record.id, { op: "wait", submission: again.submission })).toBe("done");
		expect(git(lane.path, "rev-parse", "HEAD")).toBe(retained);
		expect((await client.channel<Changes>(record.id, { op: "changes" })).against).toBe("refs/heads/main");
		const info = await client.channel<ChannelInfo>(record.id, { op: "info" });
		expect(info.chats[0]?.id).toBe(ROOT_CONVERSATION_ID);
		const replay: Event[] = [];
		await client.channel(record.id, { op: "watch" }, { event: event => replay.push(event) });
		expect(JSON.stringify(replay)).toContain("First command done");
		expect(JSON.stringify(replay)).toContain("Reopened successfully");
		await client.request({ op: "archive", channel: record.id, archived: true });
	} finally { client.close(); await host.close(); }
}, 60_000);
