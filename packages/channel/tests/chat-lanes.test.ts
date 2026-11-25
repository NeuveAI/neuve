import { afterEach, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { AgentDoc, configure, ROOT_CONVERSATION_ID, type ConversationId, type Harness } from "@earendil-works/pi-durable";
import type { BuildHost } from "../src/build";
import { buildWorktree } from "../src/external-lanes";
import { LanesDoc } from "../src/lanes";
import { planFileAccess } from "../../../apps/neuve-host/src/plan-git";
import { Fixture, git, MODEL, OWNER, scratchEnv } from "./helpers";

// Admission, pi persistence and real Git must agree: a mocked builder alone cannot prove placement.
const fixtures: Fixture[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.dispose(); });
async function setup() {
	let fixture!: Fixture;
	let harness!: Harness;
	let fail = false;
	const calls: string[] = [];
	const host: BuildHost = {
		share: (_key, run) => run(),
		async worktree(name, source, placement) {
			calls.push(name);
			if (fail) throw new Error("Git refused the chat lane");
			return buildWorktree({ name: "one", project: fixture.project, lanes: fixture.lanes, env: cwd => scratchEnv(cwd, fixture.root) }, name, context, source, placement?.recorded);
		},
	};
	fixture = await Fixture.create({ lane: undefined, build: host, planFileAccess, extension: { extensions: [], attach(value) { harness = value; } } });
	fixtures.push(fixture);
	return { fixture, calls, host, get harness() { return harness; }, fail(value: boolean) { fail = value; } };
}
async function ask(fixture: Fixture, mode?: "plan" | "ace") {
	const { submission } = await fixture.request<{ submission: number }>({ op: "ask", author: OWNER, text: "Use your tools", model: MODEL, ...(mode ? { mode } : {}) });
	expect(await fixture.request({ op: "wait", submission })).toBe("done");
}
const shell = (command: string, id = "first-shell") => fauxAssistantMessage(fauxToolCall("bash", { command }, { id }), { stopReason: "toolUse" });
const cwd = (run: Awaited<ReturnType<typeof setup>>) => run.harness.snapshot(AgentDoc, ROOT_CONVERSATION_ID, context).then(agent => agent?.cwd);

test("ordinary first write admission persists a registered external lane before shell and file tools run; reopen reuses it", async () => {
	const run = await setup(), { fixture } = run;
	const before = { head: git(fixture.project, "rev-parse", "HEAD"), index: await readFile(join(fixture.project, ".git/index")), status: git(fixture.project, "status", "--porcelain") };
	fixture.script(shell("pwd; git branch --show-current"), fauxAssistantMessage(fauxToolCall("write", { path: "only-in-lane.txt", content: "lane" }, { id: "first-write" }), { stopReason: "toolUse" }), fauxAssistantMessage("Done"));
	const watch = await fixture.watch();
	await ask(fixture);
	const path = join(fixture.lanes, `chat-${ROOT_CONVERSATION_ID}`);
	expect(await cwd(run)).toBe(path);
	expect(JSON.stringify(watch.of("result"))).toContain(path);
	expect(await readFile(join(path, "only-in-lane.txt"), "utf8")).toBe("lane");
	expect(git(fixture.project, "worktree", "list", "--porcelain")).toContain(`branch refs/heads/one/chat-${ROOT_CONVERSATION_ID}`);
	expect((await run.harness.snapshot(LanesDoc, context))?.lanes[`chat-${ROOT_CONVERSATION_ID}`]).toMatchObject({ chat: ROOT_CONVERSATION_ID, path });
	expect(git(fixture.project, "rev-parse", "HEAD")).toBe(before.head);
	expect(await readFile(join(fixture.project, ".git/index"))).toEqual(before.index);
	expect(git(fixture.project, "status", "--porcelain")).toBe(before.status);
	await watch.stop();
	await fixture.restart();
	fixture.script(fauxAssistantMessage("Reopened"));
	await ask(fixture);
	expect(await cwd(run)).toBe(path);
	expect(git(fixture.project, "for-each-ref", "--format=%(refname)", "refs/heads/one/chat-").trim().split("\n")).toHaveLength(1);
});

for (const { label, checkout, branch } of [
	{ label: "switching branches", checkout: ["-b", "other"], branch: "other" },
	{ label: "detaching HEAD", checkout: ["--detach"], branch: "" },
]) test(`later turns stay in the recorded lane after ${label}`, async () => {
	const run = await setup(), { fixture } = run;
	fixture.script(fauxAssistantMessage("Placed"));
	await ask(fixture);
	const path = join(fixture.lanes, `chat-${ROOT_CONVERSATION_ID}`);
	git(path, "checkout", ...checkout);
	const head = git(path, "rev-parse", "HEAD");
	for (const file of ["first-turn.txt", "second-turn.txt"]) {
		fixture.script(shell(`pwd > ${file}`, file), fauxAssistantMessage("Done"));
		await ask(fixture);
		expect(await readFile(join(path, file), "utf8")).toBe(`${path}\n`);
		expect(git(path, "branch", "--show-current").trim()).toBe(branch);
		expect(git(path, "rev-parse", "HEAD")).toBe(head);
	}
});

test("pending work resumes in its recorded lane after switching branches", async () => {
	const run = await setup(), { fixture } = run;
	fixture.script(fauxAssistantMessage("Placed"));
	await ask(fixture);
	const path = join(fixture.lanes, `chat-${ROOT_CONVERSATION_ID}`);
	await fixture.channel.close();
	fixture.options.resume = false;
	await fixture.open();
	const { submission } = await fixture.request<{ submission: number }>({ op: "ask", author: OWNER, text: "Pending", model: MODEL });
	await fixture.channel.close();
	git(path, "checkout", "-b", "other");
	fixture.options.resume = true;
	fixture.script(shell("pwd > resumed.txt"), fauxAssistantMessage("Resumed"));
	await fixture.open();
	expect(await fixture.request({ op: "wait", submission })).toBe("done");
	expect(await cwd(run)).toBe(path);
	expect(await readFile(join(path, "resumed.txt"), "utf8")).toBe(`${path}\n`);
	expect(git(path, "branch", "--show-current").trim()).toBe("other");
});

test("Plan mode remains on checkout; switching to a writing turn provisions once", async () => {
	const run = await setup();
	run.fixture.script(fauxAssistantMessage("Planning"));
	await ask(run.fixture, "plan");
	expect(await cwd(run)).toBe(run.fixture.project);
	expect(run.calls).toHaveLength(0);
	run.fixture.script(shell("pwd"), fauxAssistantMessage("Writing"));
	await ask(run.fixture, "ace");
	expect(await cwd(run)).toBe(join(run.fixture.lanes, `chat-${ROOT_CONVERSATION_ID}`));
	expect(run.calls).toHaveLength(1);
});

test("Plan can read its existing snapshot after archive without creating a new branch", async () => {
	const run = await setup();
	run.fixture.script(fauxAssistantMessage("Placed"));
	await ask(run.fixture);
	const path = (await cwd(run))!;
	const head = git(path, "rev-parse", "HEAD");
	git(run.fixture.project, "worktree", "remove", path);
	const watch = await run.fixture.watch();
	run.fixture.script(fauxAssistantMessage(fauxToolCall("read", { path: "README.md" }, { id: "plan-restored-read" }), { stopReason: "toolUse" }), fauxAssistantMessage("Read snapshot"));
	await ask(run.fixture, "plan");
	expect(watch.of("result").find(event => event.call === "plan-restored-read")).toMatchObject({ error: false, text: "hello\n" });
	expect(git(path, "rev-parse", "HEAD")).toBe(head);
	expect(git(path, "branch", "--show-current").trim()).toBe(`one/chat-${ROOT_CONVERSATION_ID}`);
	expect(await cwd(run)).toBe(path);
	await watch.stop();
});

test("a later turn restores a chat lane deleted outside Git", async () => {
	const run = await setup(), { fixture } = run;
	fixture.script(fauxAssistantMessage("Placed"));
	await ask(fixture);
	const path = join(fixture.lanes, `chat-${ROOT_CONVERSATION_ID}`);
	const head = git(path, "rev-parse", "HEAD");
	await rm(path, { recursive: true, force: true });
	fixture.script(shell("pwd > restored.txt"), fauxAssistantMessage("Restored"));
	await ask(fixture);
	expect(await readFile(join(path, "restored.txt"), "utf8")).toBe(`${path}\n`);
	expect(git(path, "branch", "--show-current").trim()).toBe(`one/chat-${ROOT_CONVERSATION_ID}`);
	expect(git(path, "rev-parse", "HEAD")).toBe(head);
});

test("a legacy checkout root migrates, but a valid explicit external cwd is untouched", async () => {
	const run = await setup();
	await run.fixture.channel.close();
	run.fixture.options.build = undefined;
	await run.fixture.open();
	run.fixture.script(fauxAssistantMessage("Legacy"));
	await ask(run.fixture);
	await run.fixture.channel.close();
	run.fixture.options.build = run.host;
	await run.fixture.open();
	run.fixture.script(fauxAssistantMessage("Migrated"));
	await ask(run.fixture);
	expect(run.calls).toHaveLength(1);
	await run.harness.commit(tx => configure(tx, ROOT_CONVERSATION_ID, { cwd: run.fixture.lane.path }), context);
	run.fixture.script(fauxAssistantMessage("Explicit"));
	await ask(run.fixture);
	expect(await cwd(run)).toBe(run.fixture.lane.path);
	expect(run.calls).toHaveLength(1);
});

test("an explicit lane named chat-* is left alone even when its name matches automatic placement", async () => {
	const run = await setup(), chat = ROOT_CONVERSATION_ID;
	await run.harness.commit(async tx => {
		(await tx.doc(LanesDoc)).lanes[`chat-${chat}`] = { chat, path: run.fixture.lane.path, base: run.fixture.lane.base };
		await configure(tx, chat, { cwd: run.fixture.lane.path });
	}, context);
	run.fixture.script(fauxAssistantMessage("Explicit lane"));
	await ask(run.fixture);
	expect(await cwd(run)).toBe(run.fixture.lane.path);
	expect(run.calls).toHaveLength(0);
});

test("another chat's assignment is not overwritten and ordinary later chats get separate placement", async () => {
	const run = await setup();
	const { chat } = await run.fixture.request<{ chat: number }>({ op: "chat", author: OWNER });
	await run.harness.commit(async tx => {
		(await tx.doc(LanesDoc)).lanes[`chat-${ROOT_CONVERSATION_ID}`] = { chat: chat as ConversationId, path: run.fixture.lane.path };
	}, context);
	await expect(ask(run.fixture)).rejects.toThrow("already assigned");
	expect(run.calls).toHaveLength(0);
	run.fixture.script(fauxAssistantMessage("Later chat"));
	const { submission } = await run.fixture.request<{ submission: number }>({ op: "ask", author: OWNER, chat, text: "Write", model: MODEL });
	expect(await run.fixture.request({ op: "wait", submission })).toBe("done");
	expect((await run.harness.snapshot(AgentDoc, chat as ConversationId, context))?.cwd).toBe(join(run.fixture.lanes, `chat-${chat}`));
	expect((await run.harness.snapshot(LanesDoc, context))?.lanes[`chat-${ROOT_CONVERSATION_ID}`]?.chat).toBe(chat);
});

test("provisioning failure refuses submission, retains checkout denial and permits a later safe retry", async () => {
	const run = await setup();
	run.fail(true);
	await expect(ask(run.fixture)).rejects.toThrow("Git refused the chat lane");
	expect(run.fixture.faux.state.callCount).toBe(0);
	expect(await cwd(run)).toBe(run.fixture.project);
	expect(git(run.fixture.project, "status", "--porcelain")).toBe("");
	run.fail(false);
	run.fixture.script(fauxAssistantMessage("Safe"));
	await ask(run.fixture);
	expect(await cwd(run)).not.toBe(run.fixture.project);
});

test("interruption after Git creation recovers the same lane; unrecorded branch collision refuses", async () => {
	const run = await setup(), { fixture } = run;
	const name = `chat-${ROOT_CONVERSATION_ID}`;
	const place = { name: "one", project: fixture.project, lanes: fixture.lanes, env: (cwd: string) => scratchEnv(cwd, fixture.root) };
	git(fixture.project, "branch", `one/${name}`, "HEAD");
	await expect(ask(fixture)).rejects.toThrow("already exists without a recorded worktree");
	expect(fixture.faux.state.callCount).toBe(0);
	const path = join(fixture.lanes, name);
	git(fixture.project, "worktree", "add", "-b", "other", path, "HEAD");
	await expect(ask(fixture)).rejects.toThrow("The worktree path is already in use.");
	git(path, "checkout", `one/${name}`);
	fixture.script(fauxAssistantMessage("Recovered"));
	await ask(fixture);
	expect(await cwd(run)).toBe(join(fixture.lanes, name));
	const recorded = (await run.harness.snapshot(LanesDoc, context))!.lanes[name]!;
	await writeFile(join(recorded.path, "committed.txt"), "retained");
	git(recorded.path, "add", "committed.txt"); git(recorded.path, "commit", "-m", "retained work");
	const head = git(recorded.path, "rev-parse", "HEAD");
	git(fixture.project, "worktree", "remove", recorded.path);
	const restored = await buildWorktree(place, name, context, undefined, recorded);
	expect(git(restored.path, "rev-parse", "HEAD")).toBe(head);
	expect(await readFile(join(restored.path, "committed.txt"), "utf8")).toBe("retained");
	expect(restored.base).toBe(recorded.base!);
});

for (const failure of [false, true]) test(`pending legacy work is placed before resume; failure=${failure} runs nothing`, async () => {
	const run = await setup(), { fixture } = run;
	await fixture.channel.close();
	fixture.options.resume = false;
	fixture.options.build = undefined;
	await fixture.open();
	const receipt = await fixture.request<{ submission: number }>({ op: "ask", author: OWNER, text: "Pending", model: MODEL });
	await fixture.channel.close();
	fixture.options.build = run.host;
	fixture.options.resume = true;
	run.fail(failure);
	fixture.script(shell("pwd"), fauxAssistantMessage("Resumed"));
	if (failure) {
		await expect(fixture.open()).rejects.toThrow("Git refused the chat lane");
		expect(fixture.faux.state.callCount).toBe(0);
		run.fail(false);
	}
	await fixture.open();
	expect(await fixture.request({ op: "wait", submission: receipt.submission })).toBe("done");
	expect(await cwd(run)).toBe(join(fixture.lanes, `chat-${ROOT_CONVERSATION_ID}`));
	expect(fixture.faux.state.callCount).toBe(2);
});
