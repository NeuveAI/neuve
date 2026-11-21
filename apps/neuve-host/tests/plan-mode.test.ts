import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, type Models } from "@earendil-works/pi-ai";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { Channel, Event, Request } from "@ace/channel";
import { openChannel } from "../src/worker-runtime";
import { parseHostEnvelope } from "../src/parse";

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

function open(root: string, models: Models) {
	const env = new NodeExecutionEnv({ cwd: root });
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

// The gateway must retain the mode when it replaces the client's claimed author.
test("the gateway preserves an ask's mode and stamps the verified author", () => {
	expect(parseHostEnvelope(JSON.stringify({
		id: 1, op: "channel", channel: "plan-test", request: { op: "ask", author: "spoof", text: "Plan it", mode: "plan" },
	}), "teammate")).toEqual({
		id: 1, op: "channel", channel: "plan-test", request: { op: "ask", author: "teammate", text: "Plan it", mode: "plan" },
	});
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
		const channel = await open(checkout, models);
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
		const channel = await open(repo, models);
		try {
			const invalid = ["--output=fixture", "-Ofixture", "--ext-diff", "-c fixture", "--no-index"].flatMap(value => [
				{ action: value },
				{ action: "list", path: value },
				{ action: "search", pattern: value },
				{ action: "history", revision: value },
				{ action: "history", count: value },
				{ action: "compare", from: value, to: "HEAD" },
				{ action: "compare", from: "HEAD", to: value },
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
