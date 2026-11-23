import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, type Models } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { ok } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { Channel, Event, Request } from "@ace/channel";
import { config } from "../src/host-config";
import { openChannel } from "../src/worker-runtime";
import { parseHostEnvelope } from "../src/parse";
import { configureRuntime, runtimeHooks } from "../src/runtime-hooks";

let previousClaudeConfig: string | undefined;
beforeEach(() => {
	previousClaudeConfig = process.env["CLAUDE_CONFIG_DIR"];
	delete process.env["CLAUDE_CONFIG_DIR"];
});
afterEach(() => {
	if (previousClaudeConfig === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
	else process.env["CLAUDE_CONFIG_DIR"] = previousClaudeConfig;
});

function git(cwd: string, ...args: string[]) {
	const child = Bun.spawnSync(["git", "-c", "user.name=Test", "-c", "user.email=test@neuve.invalid", ...args], { cwd });
	if (!child.success) throw new Error(`Git fixture failed for ${args[0]}`);
	return child.stdout.toString().trimEnd();
}

function faux() {
	const fake = fauxProvider({ provider: "plan-test", models: [{ id: "agent" }], tokensPerSecond: 100_000 });
	const models = createModels();
	models.setProvider(fake.provider);
	return { fake, models };
}

function open(root: string, models: Models, home: string, reverseEntries = false) {
	const env = new class extends NodeExecutionEnv {
		override async absolutePath(...args: Parameters<NodeExecutionEnv["absolutePath"]>): ReturnType<NodeExecutionEnv["absolutePath"]> {
			return args[0] === "~" ? ok(home) : super.absolutePath(...args);
		}
		override async listDir(...args: Parameters<NodeExecutionEnv["listDir"]>): ReturnType<NodeExecutionEnv["listDir"]> {
			const result = await super.listDir(...args);
			return reverseEntries && result.ok ? ok(result.value.toReversed()) : result;
		}
	}({ cwd: root });
	return openChannel({
		id: "plan-test", name: "Plan test", owner: "owner", project: root,
		defaultModel: async () => ({ provider: "plan-test", modelId: "agent" }),
		storage: new MemoryStorage(), models,
		env: () => env,
		directory: { self: { id: "plan-test", name: "Plan test" }, list: async () => [], deliver: async () => {} },
		log: () => {},
	}, root);
}

async function ask(channel: Channel, request: Pick<Extract<Request, { op: "ask" }>, "mode" | "chat">) {
	const result = await channel.handle({ op: "ask", author: "owner", text: "Inspect the repository", ...request }, () => {});
	if (!result || typeof result !== "object" || !("submission" in result) || typeof result.submission !== "number") {
		throw new Error("No submission was accepted");
	}
	expect(await channel.handle({ op: "wait", submission: result.submission }, () => {})).toBe("done");
}

async function results(channel: Channel, chat?: number) {
	const collected = new Map<string, Extract<Event, { kind: "result" }>>();
	const watch = await channel.handle({ op: "watch", chat }, event => {
		if (event.kind === "result") collected.set(event.call, event);
	});
	if (!watch || typeof watch !== "object" || !("stop" in watch) || typeof watch.stop !== "function") {
		throw new Error("No transcript was available");
	}
	await watch.stop();
	return collected;
}

async function writeSkill(folder: string, description: string, name = "neuve") {
	const skill = `---\nname: ${name}\ndescription: ${description}\n---\n\n# Neuve\n`;
	const reference = "# Reading a Neuve review\n";
	await mkdir(join(folder, "references"), { recursive: true });
	await writeFile(join(folder, "SKILL.md"), skill);
	await writeFile(join(folder, "references", "review.md"), reference);
	return { skill, reference };
}

// Exercise discovery and both pi reads through the path in the actual system prompt.
test.each([
	{ location: "user Codex", installed: "user-agents" },
	{ location: "user Claude Code", installed: "user-claude" },
	{ location: "configured Claude Code with a linked skill", installed: "configured-claude" },
	{ location: "repository Codex", installed: "repo-agents" },
	{ location: "ignored repository Claude Code", installed: "repo-claude" },
	{ location: "both scopes", installed: "user-agents", duplicates: true },
] as const)("an Ace chat can list and read the Neuve skill at $location", async (fixture) => {
	const root = await mkdtemp(join(tmpdir(), "neuve plan skill "));
	try {
		const dir = await realpath(root);
		const repo = join(dir, "checkout");
		const home = join(dir, "home");
		const claude = join(dir, "configured Claude home");
		await mkdir(repo);
		git(repo, "init", "-q");
		await writeFile(join(repo, ".gitignore"), ".claude/\n");
		const paths = {
			"user-agents": join(home, ".agents", "skills", "neuve"),
			"user-claude": join(home, ".claude", "skills", "neuve"),
			"configured-claude": join(claude, "skills", "neuve"),
			"repo-agents": ".agents/skills/neuve",
			"repo-claude": ".claude/skills/neuve",
		};
		const listed = paths[fixture.installed];
		let files: Awaited<ReturnType<typeof writeSkill>>;
		if (fixture.installed === "configured-claude") {
			process.env["CLAUDE_CONFIG_DIR"] = claude;
			// Personal Claude installations can link back to the user's Codex installation.
			const target = join(home, ".agents", "skills", "fixtures", "neuve");
			files = await writeSkill(target, fixture.location);
			const claudeFiles = join(dir, "Claude files");
			await mkdir(join(claudeFiles, "skills"), { recursive: true });
			await symlink(claudeFiles, claude);
			await symlink(target, listed);
			await symlink(join(target, "SKILL.md"), join(claude, "skills", "linked-file"));
		} else {
			files = await writeSkill(resolve(repo, listed), fixture.location);
		}
		if ("duplicates" in fixture) {
			await writeSkill(join(home, ".claude", "skills", "claude-copy"), "ignored user copy");
			await writeSkill(join(repo, paths["repo-agents"]), "ignored repository copy");
			await writeSkill(join(repo, paths["repo-claude"]), "ignored Claude repository copy");
		}
		for (const mode of ["ace", "plan"] as const) {
			const { fake, models } = faux();
			const channel = await open(repo, models, home);
			try {
				let listing: string[] = [];
				fake.appendResponses([
					received => {
						const section = getCurrentSystemPrompt(received.messages).match(/Skills in this repository[^\n]*\n(?:- [^\n]+\n?)*/)?.[0];
						if (process.env["NEUVE_DUMP_PLAN_SKILLS"] === "1") console.log(mode, fixture.location, section);
						listing = section?.trimEnd().split("\n").slice(1) ?? [];
						const path = /^- neuve \((.+)\): /.exec(listing[0] ?? "")?.[1];
						if (!path) return fauxAssistantMessage("The Neuve skill was not listed");
						return fauxAssistantMessage([
							fauxToolCall("read", { path }, { id: "skill" }),
							fauxToolCall("read", { path: join(dirname(path), "references", "review.md") }, { id: "reference" }),
						], { stopReason: "toolUse" });
					},
					fauxAssistantMessage("Read complete"),
				]);
				await ask(channel, { mode });
				const reads = await results(channel);
				if (process.env["NEUVE_DUMP_PLAN_SKILLS"] === "1") console.log([...reads.values()]);
				expect(listing).toEqual([`- neuve (${listed}/SKILL.md): ${fixture.location}`]);
				expect(reads.get("skill")).toMatchObject({ error: false, text: files.skill });
				expect(reads.get("reference")).toMatchObject({ error: false, text: files.reference });
			} finally {
				await channel.close();
			}
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

async function skillListing(repo: string, home: string, reverseEntries = false) {
	const { fake, models } = faux();
	const channel = await open(repo, models, home, reverseEntries);
	try {
		let listing = "";
		fake.appendResponses([received => {
			listing = getCurrentSystemPrompt(received.messages).match(/Skills in this repository[^\n]*\n[\s\S]*?(?=\n<\/project-instructions>)/)?.[0] ?? "";
			return fauxAssistantMessage("Read complete");
		}]);
		await ask(channel, { mode: "ace" });
		return listing;
	} finally {
		await channel.close();
	}
}

const descriptionNotice = "Some descriptions were shortened or left out to fit; read a skill's file for its full description.";

// A large user skill set must keep every name and the winning Neuve path in either directory order.
test("Ace bounds descriptions and keeps all skill names in a deterministic order", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "neuve skill budget ")));
	try {
		const repo = join(root, "checkout");
		const home = join(root, "home");
		const userSkills = join(home, ".agents", "skills");
		const repoSkills = join(repo, ".agents", "skills");
		const description = "d".repeat(1_536);
		await writeSkill(join(repoSkills, "neuve"), "Repository copy");
		await writeSkill(join(repoSkills, "a-folder"), `${description} clipped`, "z-guide");
		await writeSkill(join(repoSkills, "z-folder"), "Read first", "a-guide");
		await writeSkill(join(userSkills, "z-copy"), "Other user copy");
		await writeSkill(join(userSkills, "neuve"), "User copy");
		const names = Array.from({ length: 30 }, (_, i) => `user-${String(i).padStart(2, "0")}`);
		for (const name of names) await writeSkill(join(userSkills, name), "u".repeat(1_000), name);
		const listing = await skillListing(repo, home);
		expect(listing.match(/^- .+?\/SKILL\.md\)/gm)).toEqual([
			"- a-guide (.agents/skills/z-folder/SKILL.md)",
			"- z-guide (.agents/skills/a-folder/SKILL.md)",
			`- neuve (${userSkills}/neuve/SKILL.md)`,
			...names.map(name => `- ${name} (${userSkills}/${name}/SKILL.md)`),
		]);
		const lines = listing.split("\n");
		expect(lines[2]).toBe(`- z-guide (.agents/skills/a-folder/SKILL.md): ${description}`);
		const lengths = lines.slice(4, -1).map(line => line.split("): ")[1]?.length ?? 0);
		expect(lengths).toEqual(lengths.toSorted((a, b) => b - a));
		expect(listing.length).toBeGreaterThanOrEqual(7_998);
		expect(listing.length).toBeLessThanOrEqual(8_000);
		expect(listing.endsWith(`\n${descriptionNotice}`)).toBe(true);
		expect(await skillListing(repo, home, true)).toBe(listing);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// Names must still be discoverable when the paths alone exhaust the prompt budget.
test("Ace lists every skill without descriptions when names and paths exceed the budget", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "neuve skill budget ")));
	try {
		const repo = join(root, "checkout");
		const home = join(root, "home");
		const userSkills = join(home, ".agents", "skills");
		await writeSkill(join(repo, ".agents", "skills", "neuve"), "Repository copy");
		const names = Array.from({ length: 40 }, (_, i) => `user-${String(i).padStart(2, "0")}-${"x".repeat(110)}`);
		for (const name of names) await writeSkill(join(userSkills, name), "User description", name);
		const listing = await skillListing(repo, home);
		const [, ...lines] = listing.split("\n");
		expect(lines.slice(0, -1).join("\n").length).toBeGreaterThan(8_000);
		expect(lines).toEqual([
			"- neuve (.agents/skills/neuve/SKILL.md)",
			...names.map(name => `- ${name} (${userSkills}/${name}/SKILL.md)`),
			descriptionNotice,
		]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test.each([
	// A tracked file at the skill root must still use the working-tree read rule.
	{ layout: "a tracked skill-root README", path: ".agents/skills/README.md", linked: false },
	// A linked repository skill root must preserve reads and list each skill once.
	{ layout: "through a linked repository skill root", path: ".claude/skills/neuve/SKILL.md", linked: true },
])("plan mode reads $layout", async ({ path, linked }) => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "neuve repository skills ")));
	try {
		const repo = join(root, "checkout");
		const home = join(root, "home");
		await mkdir(repo);
		git(repo, "init", "-q");
		const { skill } = await writeSkill(join(repo, ".agents", "skills", "neuve"), "Repository skill");
		const readme = "# Repository skills\n";
		if (linked) {
			await mkdir(join(repo, ".claude"));
			await symlink("../.agents/skills", join(repo, ".claude", "skills"));
		} else {
			await writeFile(join(repo, path), readme);
		}
		git(repo, "add", "-f", "--", ".agents", ...(linked ? [".claude"] : []));
		const { fake, models } = faux();
		const channel = await open(repo, models, home);
		try {
			let listing: string[] = [];
			fake.appendResponses([
				received => {
					listing = getCurrentSystemPrompt(received.messages).match(/^- neuve .*$/gm) ?? [];
					return fauxAssistantMessage(fauxToolCall("read", { path }, { id: "read" }), { stopReason: "toolUse" });
				},
				fauxAssistantMessage("Read complete"),
			]);
			await ask(channel, { mode: "plan" });
			expect((await results(channel)).get("read")).toMatchObject({ error: false, text: linked ? skill : readme });
			if (linked) expect(listing).toEqual(["- neuve (.agents/skills/neuve/SKILL.md): Repository skill"]);
		} finally {
			await channel.close();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// Drive plan-mode read through the same wrapper that filters discovery and references.
test("plan mode refuses files that resolve outside the allowed skill folders", async () => {
	const root = await mkdtemp(join(tmpdir(), "neuve plan skill boundary "));
	try {
		const dir = await realpath(root);
		const repo = join(dir, "checkout");
		const home = join(dir, "home");
		const skills = join(home, ".claude", "skills");
		const skill = join(skills, "neuve");
		const outside = join(dir, "outside");
		await mkdir(repo);
		git(repo, "init", "-q");
		await writeFile(join(repo, ".gitignore"), ".claude/\nignored-skill/\n");
		await mkdir(join(home, ".agents"), { recursive: true });
		await writeSkill(skill, "Installed skill");
		await writeSkill(outside, "Outside skill");
		await writeFile(join(home, ".claude", "settings.json"), "private settings");
		await writeFile(join(home, ".agents", "other-file"), "private data");
		await writeFile(join(skills, "root-file.md"), "file beside the skill");
		await symlink(outside, join(skills, "outside"));
		await symlink(join(outside, "SKILL.md"), join(skill, "references", "outside.md"));
		await symlink(join(skill, "references"), join(outside, "back"));
		await symlink(join(outside, "back"), join(skill, "round-trip"));
		await mkdir(join(repo, ".claude"));
		await writeSkill(join(repo, "ignored-skill", "neuve"), "Unauthorized repository root");
		await symlink("../ignored-skill", join(repo, ".claude", "skills"));
		const denied = [
			join(skills, "outside", "SKILL.md"), join(skill, "references", "outside.md"),
			join(skills, "root-file.md"),
			join(home, ".claude", "settings.json"), join(home, ".agents", "other-file"),
			join(outside, "SKILL.md"), ".claude/skills/neuve/SKILL.md",
		];
		const { fake, models } = faux();
		const channel = await open(repo, models, home);
		try {
			let listing = "";
			fake.appendResponses([
				received => {
					listing = getCurrentSystemPrompt(received.messages);
					return fauxAssistantMessage([
						fauxToolCall("read", { path: join(skill, "references", "review.md") }, { id: "allowed" }),
						// The round-trip link is allowed because its final path is inside the skill root.
						fauxToolCall("read", { path: join(skill, "round-trip", "review.md") }, { id: "round-trip" }),
						...denied.map((path, i) => fauxToolCall("read", { path }, { id: `denied-${i}` })),
					], { stopReason: "toolUse" });
				},
				fauxAssistantMessage("Read complete"),
			]);
			await ask(channel, { mode: "plan" });
			const reads = await results(channel);
			if (process.env["NEUVE_DUMP_PLAN_SKILLS"] === "1") console.log([...reads.values()]);
			expect(listing).toContain(`- neuve (${skill}/SKILL.md): Installed skill`);
			expect(listing).not.toContain("Outside skill");
			expect(listing).not.toContain("Unauthorized repository root");
			expect(reads.get("allowed")).toMatchObject({ error: false, text: "# Reading a Neuve review\n" });
			expect(reads.get("round-trip")).toMatchObject({ error: false, text: "# Reading a Neuve review\n" });
			for (const i of denied.keys()) expect(reads.get(`denied-${i}`)).toMatchObject({ error: true });
		} finally {
			await channel.close();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// The gateway must retain the mode when it replaces the client's claimed author.
test("the gateway preserves an ask's mode and stamps the verified author", () => {
	expect(parseHostEnvelope(JSON.stringify({
		id: 1, op: "channel", channel: "plan-test", request: { op: "ask", author: "spoof", text: "Plan it", mode: "plan" },
	}), "teammate")).toEqual({
		id: 1, op: "channel", channel: "plan-test", request: { op: "ask", author: "teammate", text: "Plan it", mode: "plan" },
	});
});

// Exercise the configured worker's lane rule and confined file access on the same checkout.
test("the configured worker gives planning chats confined access without a lane", async () => {
	const root = await mkdtemp(join(tmpdir(), "neuve plan checkout "));
	const previous = runtimeHooks();
	const previousLanes = config.lanes;
	try {
		const dir = await realpath(root);
		const repo = join(dir, "checkout");
		await mkdir(repo);
		git(repo, "init", "-q");
		await writeFile(join(repo, "tracked.txt"), "tracked fixture");
		await writeFile(join(repo, ".gitignore"), "ignored.txt\n");
		await writeFile(join(repo, "ignored.txt"), "ignored fixture");
		await writeFile(join(dir, "outside.txt"), "outside fixture");
		git(repo, "add", "--", "tracked.txt");

		config.lanes = join(dir, "lanes");
		await mkdir(config.lanes);
		configureRuntime({ worker: { models: (_, defaults) => defaults } });
		const { fake, models } = faux();
		const channel = await open(repo, models, join(dir, "home"));
		try {
			fake.appendResponses([
				fauxAssistantMessage([
					fauxToolCall("read", { path: "tracked.txt" }, { id: "tracked" }),
					fauxToolCall("explore", { action: "list" }, { id: "list" }),
					fauxToolCall("read", { path: "ignored.txt" }, { id: "ignored" }),
					fauxToolCall("read", { path: "../outside.txt" }, { id: "outside" }),
					fauxToolCall("read", { path: ".git/config" }, { id: "metadata" }),
				], { stopReason: "toolUse" }),
				fauxAssistantMessage("Exploration complete"),
				fauxAssistantMessage(fauxToolCall("read", { path: "tracked.txt" }, { id: "ordinary" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("Read complete"),
			]);
			await ask(channel, { mode: "plan" });
			const planning = await results(channel);
			expect(planning.get("tracked")).toMatchObject({ error: false, text: "tracked fixture" });
			expect(planning.get("list")).toMatchObject({ error: false, text: expect.stringContaining("tracked.txt") });
			expect(planning.get("ignored")).toMatchObject({ error: true, text: expect.stringContaining("Git ignores") });
			expect(planning.get("outside")).toMatchObject({ error: true, text: expect.stringContaining("outside the working tree") });
			expect(planning.get("metadata")).toMatchObject({ error: true, text: expect.stringContaining("Git metadata") });

			await ask(channel, { mode: "ace" });
			expect((await results(channel)).get("ordinary")).toMatchObject({
				error: true, text: expect.stringContaining("No execution environment is configured"),
			});
		} finally {
			await channel.close();
		}
	} finally {
		configureRuntime({ worker: previous.worker });
		if (previousLanes === undefined) Reflect.deleteProperty(config, "lanes");
		else config.lanes = previousLanes;
		await rm(root, { recursive: true, force: true });
	}
});

// Use pi's real read tool to cover path rewrites and two chats sharing the host's file access.
test.each(["main checkout", "linked worktree"])("plan reads refuse outside, Git, and ignored files after pi rewrites the path in a %s", async (layout) => {
	const root = await mkdtemp(join(tmpdir(), "neuve plan read "));
	try {
		const dir = await realpath(root);
		const repo = join(dir, "checkout");
		await mkdir(repo);
		git(repo, "init", "-q");
		const linked = layout === "linked worktree";
		const checkout = linked ? join(dir, "worktree") : repo;
		if (linked) {
			git(repo, "commit", "--allow-empty", "-qm", "Initial fixture");
			git(repo, "worktree", "add", "-q", "--detach", checkout, "HEAD");
		}
		const config = join(repo, ".git", "config");
		const records = join(repo, ".git", "neuve", "records.sqlite");
		const metadataReason = linked ? "outside the working tree" : "Git metadata";
		await mkdir(join(repo, ".git", "neuve"));
		await writeFile(records, "records fixture");
		await writeFile(join(checkout, ".gitignore"), "ignored*\n");
		await writeFile(join(checkout, "ignored’s.txt"), "ignored fixture");
		await writeFile(join(checkout, "untracked.txt"), "untracked fixture");
		await writeFile(join(root, "outside’s.txt"), "outside fixture");
		await symlink(join(root, "outside’s.txt"), join(checkout, "AGENTS.md"));
		await symlink(join(root, "outside’s.txt"), join(checkout, "outside-link’s.txt"));
		await symlink(config, join(checkout, "config-link’s.txt"));
		await symlink(records, join(checkout, "records-link’s.txt"));
		const { fake, models } = faux();
		const channel = await open(checkout, models, join(dir, "home"));
		try {
			const attempts = [
				[join(root, "outside’s.txt"), "outside the working tree"],
				[join(root, "outside's.txt"), "outside the working tree"],
				["outside-link’s.txt", "outside the working tree"],
				["outside-link's.txt", "outside the working tree"],
				[".git", "Git metadata"],
				[records, metadataReason],
				["records-link's.txt", metadataReason],
				[config, metadataReason],
				["config-link's.txt", metadataReason],
				["ignored’s.txt", "Git ignores"],
				["ignored's.txt", "Git ignores"],
				...(linked ? [[join(git(checkout, "rev-parse", "--absolute-git-dir"), "HEAD"), metadataReason]] : []),
			].flatMap(([path, reason]) => [[path, reason], [`@${path}`, reason]]);
			fake.appendResponses([
				received => {
					expect(getCurrentSystemPrompt(received.messages)).not.toContain("outside fixture");
					return fauxAssistantMessage([
						...attempts.map(([path], n) => fauxToolCall("read", { path }, { id: `denied-${n}` })),
						fauxToolCall("read", { path: "@untracked.txt" }, { id: "untracked" }),
					], { stopReason: "toolUse" });
				},
				fauxAssistantMessage("Read complete"),
			]);
			await ask(channel, { mode: "plan" });
			const planning = await results(channel);
			for (const [n, [, reason]] of attempts.entries()) {
				expect(planning.get(`denied-${n}`)).toMatchObject({ error: true, text: expect.stringContaining(reason) });
			}
			expect(planning.get("untracked")).toMatchObject({ error: false, text: "untracked fixture" });

			const chat = await channel.handle({ op: "chat", author: "owner" }, () => {});
			if (!chat || typeof chat !== "object" || !("chat" in chat) || typeof chat.chat !== "number") {
				throw new Error("No second chat was created");
			}
			fake.appendResponses([
				fauxAssistantMessage(fauxToolCall("read", { path: "@ignored's.txt" }, { id: "ordinary" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("Read complete"),
			]);
			await ask(channel, { chat: chat.chat });
			expect((await results(channel, chat.chat)).get("ordinary")).toMatchObject({ error: false, text: "ignored fixture" });
		} finally {
			await channel.close();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// Drive the real Git subprocess boundary, including option-shaped inputs and configured programs.
test("explore rejects options and leaves files, the index, and configured programs alone", async () => {
	const root = await mkdtemp(join(tmpdir(), "neuve plan git "));
	try {
		const repo = join(root, "checkout");
		await mkdir(repo);
		git(repo, "init", "-q");
		await writeFile(join(repo, "notes.txt"), "first version\n");
		await writeFile(join(repo, ".gitattributes"), "*.txt diff=fixture\n");
		git(repo, "add", "--", "notes.txt", ".gitattributes");
		git(repo, "commit", "-qm", "Initial fixture");
		await writeFile(join(repo, "notes.txt"), "second version\n");
		git(repo, "add", "--", "notes.txt");
		git(repo, "commit", "-qm", "Update fixture");
		await writeFile(join(repo, "untracked.txt"), "new file\n");
		await symlink(join(root, "program"), join(repo, "external-link"));
		const program = join(root, "program");
		await writeFile(program, '#!/bin/sh\n: > "${0%/*}/called"\n');
		await chmod(program, 0o755);
		git(repo, "config", "core.fsmonitor", "../program");
		git(repo, "config", "core.pager", "../program");
		git(repo, "config", "diff.external", "../program");
		git(repo, "config", "diff.fixture.textconv", "../program");

		const index = await readFile(join(repo, ".git", "index"));
		const files = (await readdir(repo)).sort();
		const outside = (await readdir(root)).sort();
		const { fake, models } = faux();
		const channel = await open(repo, models, join(root, "home"));
		try {
			const invalid = ["--output=fixture", "-Ofixture", "--ext-diff", "-c fixture", "--no-index"].flatMap(value => [
				{ action: value },
				{ action: "list", path: value },
				{ action: "search", pattern: value },
				{ action: "history", revision: value },
				{ action: "history", count: value },
				{ action: "history", path: value },
				{ action: "show", revision: value, path: "notes.txt" },
				{ action: "show", revision: "HEAD", path: value },
				{ action: "compare", from: value, to: "HEAD" },
				{ action: "compare", from: "HEAD", to: value },
				{ action: "compare", from: "HEAD~1", to: "HEAD", path: value },
			]);
			const valid = [
				{ action: "list" },
				{ action: "search", pattern: "version", path: "notes.txt" },
				{ action: "history", revision: "HEAD", count: 1 },
				{ action: "show", revision: "HEAD~1", path: "notes.txt" },
				{ action: "compare", from: "HEAD~1", to: "HEAD", path: "notes.txt" },
			];
			fake.appendResponses([
				fauxAssistantMessage([
					...invalid.map((args, n) => fauxToolCall("explore", args, { id: `invalid-${n}` })),
					...valid.map((args, n) => fauxToolCall("explore", args, { id: `valid-${n}` })),
					fauxToolCall("explore", { action: "list", path: "external-link" }, { id: "outside" }),
					fauxToolCall("write", { path: join(root, "written"), content: "unexpected" }, { id: "write-outside" }),
					fauxToolCall("write", { path: "written", content: "unexpected" }, { id: "write-inside" }),
				], { stopReason: "toolUse" }),
				fauxAssistantMessage("Exploration complete"),
			]);
			await ask(channel, { mode: "plan" });
			const transcript = await results(channel);
			for (const n of invalid.keys()) expect(transcript.get(`invalid-${n}`)).toMatchObject({ error: true });
			for (const [n, text] of ["untracked.txt", "notes.txt:1:second version", "Update fixture", "first version", "+second version"].entries()) {
				expect(transcript.get(`valid-${n}`)).toMatchObject({ error: false, text: expect.stringContaining(text) });
			}
			expect(transcript.get("outside")).toMatchObject({ error: true, text: expect.stringContaining("outside the working tree") });
			for (const id of ["write-inside", "write-outside"]) {
				expect(transcript.get(id)).toMatchObject({ error: true, text: expect.stringContaining("Plan mode is read-only") });
			}
			expect((await readdir(repo)).sort()).toEqual(files);
			expect((await readdir(root)).sort()).toEqual(outside);
			expect(await readFile(join(repo, "notes.txt"), "utf8")).toBe("second version\n");
			expect(await readFile(join(repo, ".git", "index"))).toEqual(index);
		} finally {
			await channel.close();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

// A broad path selection must honor the same ignore boundary as an explicit historical read.
test("explore compare omits paths Git now ignores in the whole tree and in a directory", async () => {
	const root = await mkdtemp(join(tmpdir(), "neuve plan compare "));
	try {
		const repo = await realpath(root);
		git(repo, "init", "-q");
		git(repo, "config", "diff.renames", "true");
		await mkdir(join(repo, "config"));
		const shared = "This setting can be checked into Git.\n".repeat(4);
		await writeFile(join(repo, "config", "secret.env"), `${shared}PRIVATE=fixture-only\n`);
		await writeFile(join(repo, "config", "notes.txt"), "first version\n");
		git(repo, "add", "--", "config");
		git(repo, "commit", "-qm", "Initial fixture");
		await writeFile(join(repo, ".gitignore"), "*.env\n");
		await writeFile(join(repo, "config", "notes.txt"), "second version\n");
		await writeFile(join(repo, "config", "example.txt"), shared);
		git(repo, "rm", "--cached", "--", "config/secret.env");
		git(repo, "add", "--", ".gitignore", "config/notes.txt", "config/example.txt");
		git(repo, "commit", "-qm", "Update fixture");
		const { fake, models } = faux();
		const channel = await open(repo, models, join(root, "home"));
		try {
			const compare = { action: "compare", from: "HEAD~1", to: "HEAD" };
			fake.appendResponses([
				fauxAssistantMessage([
					fauxToolCall("explore", compare, { id: "whole-tree" }),
					fauxToolCall("explore", { ...compare, path: "config" }, { id: "directory" }),
					fauxToolCall("explore", { action: "show", revision: "HEAD~1", path: "config/secret.env" }, { id: "show" }),
					fauxToolCall("explore", { action: "history", path: "config" }, { id: "history" }),
				], { stopReason: "toolUse" }),
				fauxAssistantMessage("Exploration complete"),
			]);
			await ask(channel, { mode: "plan" });
			const transcript = await results(channel);
			for (const id of ["whole-tree", "directory"]) {
				const reply = transcript.get(id);
				expect(reply?.error).toBe(false);
				expect(reply?.text).toContain("+second version");
				expect(reply?.text?.includes("PRIVATE=fixture-only")).toBe(false);
				expect(reply?.text?.includes("config/secret.env")).toBe(false);
			}
			expect(transcript.get("show")).toMatchObject({ error: true, text: expect.stringContaining("Git ignores") });
			expect(transcript.get("history")).toMatchObject({ error: false, text: expect.stringMatching(
				/^[\da-f]+ Update fixture\n[\da-f]+ Initial fixture\s*$/,
			) });
		} finally {
			await channel.close();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
