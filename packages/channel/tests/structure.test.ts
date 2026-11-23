import {parseRequest} from "../src/parse";
import { afterEach, describe, expect, test } from "bun:test";
import { realpath, rm } from "node:fs/promises";
import { join, relative } from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { type JsonObject, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

import { Channel, type ChannelInfo, type Changes, type Delivery } from "../src/index";
import { faux, Fixture, git, isolateClaudeConfig, MODEL, OWNER, project, scratch, scratchEnv, until } from "./helpers";

const fixtures: Fixture[] = [];
afterEach(async () => {
	for (const fixture of fixtures.splice(0)) await fixture.dispose();
});
isolateClaudeConfig();
const create = async (...args: Parameters<typeof Fixture.create>) => {
	const fixture = await Fixture.create(...args);
	fixtures.push(fixture);
	return fixture;
};

const tool = (name: string, args: JsonObject, id?: string) =>
	fauxAssistantMessage(fauxToolCall(name, args, id ? { id } : {}), { stopReason: "toolUse" });

describe("lanes", () => {
	test("an agent's lane is a new worktree and branch outside the project, at a path with spaces", async () => {
		const fixture = await create();
		fixture.script(
			tool("lane", { action: "start", name: "fix-bug", base: "HEAD" }, "call-lane"),
			tool("bash", { command: "pwd; echo fixed > fix.txt" }, "call-pwd"),
			fauxAssistantMessage("Started"),
		);
		const watch = await fixture.watch();
		await fixture.request({ op: "ask", author: OWNER, text: "fix it", model: MODEL });
		const started = await watch.until("result", (event) => event.call === "call-lane");
		expect(started.error).toBe(false);
		const pwd = await watch.until("result", (event) => event.call === "call-pwd");
		await watch.until("reply", (event) => event.text === "Started");
		await watch.stop();
		const lane = join(fixture.lanes, "fix-bug");
		expect(started.text).toContain(`Started work lane fix-bug on branch one/fix-bug`);
		expect(pwd.text.trim()).toBe(await realpath(lane));
		expect(relative(fixture.project, lane).startsWith("..")).toBe(true);
		expect(git(fixture.project, "worktree", "list", "--porcelain")).toContain(`worktree ${await realpath(lane)}`);
		expect(git(lane, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("one/fix-bug");
		const info = await fixture.request<ChannelInfo>({ op: "info" });
		expect(info.chats[0]).toMatchObject({ lane: "fix-bug", cwd: lane });
		const changes = await fixture.request<Changes>({ op: "changes" });
		expect(changes).toMatchObject({ lane: "fix-bug", branch: "one/fix-bug", cwd: lane });
		expect(changes.files).toEqual([
			expect.objectContaining({ file: "fix.txt", state: "untracked", adds: 1 }),
		]);
		const patch = await fixture.request<string>({ op: "patch", file: "fix.txt", state: "untracked" });
		expect(patch).toContain("+fixed");
	});

	test("a chat outside a lane gets no files or shell; taking a lane gives it both", async () => {
		const fixture = await create();
		const { chat } = await fixture.request<{ chat: number }>({ op: "chat", author: OWNER, model: MODEL });
		fixture.script(
			tool("bash", { command: "touch from-agent" }, "call-bash"),
			tool("write", { path: "written.txt", content: "x" }, "call-write"),
			tool("lane", { action: "switch", name: "work" }, "call-switch"),
			tool("bash", { command: "pwd" }, "call-pwd"),
			fauxAssistantMessage("done"),
		);
		const watch = await fixture.watch({ op: "watch", chat });
		await fixture.request({ op: "ask", chat, author: OWNER, text: "go" });
		const refused = await watch.until("result", (event) => event.call === "call-bash");
		const write = await watch.until("result", (event) => event.call === "call-write");
		const pwd = await watch.until("result", (event) => event.call === "call-pwd");
		await watch.until("reply", (event) => event.text === "done");
		await watch.stop();
		expect(refused.error).toBe(true);
		expect(refused.text).toContain("No execution environment is configured");
		expect(write.error).toBe(true);
		expect(await Bun.file(join(fixture.project, "from-agent")).exists()).toBe(false);
		expect(await Bun.file(join(fixture.project, "written.txt")).exists()).toBe(false);
		expect(git(fixture.project, "status", "--porcelain")).toBe("");
		expect(pwd.text.trim()).toBe(await realpath(fixture.lane.path));
	});

	// The tool must teach a valid name without creating a worktree outside the assigned directory.
	test("a lane name that could escape the lanes directory is refused by the tool", async () => {
		const fixture = await create();
		fixture.script(tool("lane", { action: "start", name: "../outside" }, "call-lane"), fauxAssistantMessage("ok"));
		const watch = await fixture.watch();
		await fixture.request({ op: "ask", author: OWNER, text: "go", model: MODEL });
		const result = await watch.until("result", (event) => event.call === "call-lane");
		await watch.until("reply");
		await watch.stop();
		expect(result.error).toBe(true);
		expect(result.text).toContain("name: Expected a lowercase kebab-case work lane name");
		expect(result.text).toContain('such as "implement-auth".');
		expect(result.text).toContain('"name": "../outside"');
		expect(git(fixture.project, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length).toBe(2);
	});

	test("a patch path outside the checkout is refused", async () => {
		const fixture = await create();
		for (const file of ["../secret", "/etc/passwd", "a/../../b", ""]) {
			await expect(fixture.request({ op: "patch", file })).rejects.toThrow("Invalid path");
		}
	});
});

describe("children and other channels", () => {
	// A provider can disappear after the parent has already asked it to delegate.
	test("a subagent uses Automatic when its inherited provider is gone", async () => {
		const fixture = await create();
		const retired = { provider: "retired", modelId: "old-model" };
		const old = fauxProvider({ provider: retired.provider, models: [{ id: retired.modelId }] });
		const { models } = fixture.scripted;
		models.setProvider(old.provider);
		old.appendResponses([() => {
			models.deleteProvider(retired.provider);
			return tool("subagent", { task: "inspect" }, "delegate");
		}]);
		fixture.script(fauxAssistantMessage("Child ran on Automatic"));
		const watch = await fixture.watch();
		await fixture.request({ op: "ask", author: OWNER, text: "delegate", model: retired });
		expect(await watch.until("result", event => event.call === "delegate")).toMatchObject({ text: "Child ran on Automatic", error: false });
		await watch.stop();
	});

	test("a subagent works in a child chat its parent's call owns, and stays readable", async () => {
		const fixture = await create();
		fixture.script(
			tool("subagent", { task: "count files" }, "call-child"),
			fauxAssistantMessage("There are 1 files"),
			fauxAssistantMessage("The child counted 1"),
		);
		const watch = await fixture.watch();
		await fixture.request({ op: "ask", author: OWNER, text: "delegate", model: MODEL });
		const result = await watch.until("result", (event) => event.call === "call-child");
		await watch.until("reply", (event) => event.text === "The child counted 1");
		await watch.stop();
		expect(result.text).toBe("There are 1 files");
		const info = await fixture.request<ChannelInfo>({ op: "info" });
		const child = info.chats.find((chat) => chat.parent === ROOT_CONVERSATION_ID);
		expect(child).toMatchObject({ lane: "work", cwd: fixture.lane.path });
		const transcript = await fixture.watch({ op: "watch", chat: child!.id });
		await transcript.until("live");
		await transcript.stop();
		expect(transcript.of("message")[0]).toMatchObject({
			author: `agent@${ROOT_CONVERSATION_ID}`,
			text: "count files",
			invoked: true,
		});
		expect(transcript.of("reply")[0]?.text).toBe("There are 1 files");
	});

	test("an agent's message reaches another channel once, even when its delivery is retried", async () => {
		const root = await scratch();
		const { project: dir, lanes, lane } = await project(root);
		const channels = new Map<string, Channel>();
		const delivered: Delivery[] = [];
		const open = async (id: string, scripted = faux()) => {
			const channel = await Channel.open({
				id,
				name: id,
				owner: OWNER,
				project: dir,
				lane,
				defaultModel: async () => MODEL,
				storage: await openNodeSqliteStorage(join(root, id, "channel.sqlite")),
				models: scripted.models,
				env: (cwd) => scratchEnv(cwd, root),
				directory: {
					self: { id, name: id },
					list: async () =>
						[...channels.keys()].filter((other) => other !== id)
							.map((other) => ({ id: other, name: other, prefix: other, project: dir })),
					async deliver(delivery) {
						delivered.push(delivery);
						const target = channels.get(delivery.channel)!;
						const { chat, author, text, requestId } = delivery;
						const request = { ...(chat === undefined ? {} : { chat }), author, text, requestId };
						// A redelivery after a crash repeats the request; it must land once.
						for (let attempt = 0; attempt < 2; attempt++) {
							await target.handle({ op: delivery.invoke ? "ask" : "say", ...request }, () => {});
						}
					},
				},
				log: () => {},
			});
			channels.set(id, channel);
			return { channel, scripted };
		};
		const sender = await open("sender");
		const receiver = await open("receiver");
		try {
			sender.scripted.faux.appendResponses([
				tool("message", { channel: "#receiver", text: "please review", invoke: false }, "call-message"),
				fauxAssistantMessage("Sent"),
			]);
			const { submission } = await sender.channel.handle(
				{ op: "ask", author: OWNER, text: "tell receiver", model: MODEL },
				() => {},
			) as { submission: number };
			await sender.channel.handle({ op: "wait", submission }, () => {});
			expect(delivered).toHaveLength(1);
			expect(delivered[0]).toMatchObject({ channel: "receiver", author: "agent@sender", invoke: false });
			const events: { kind: string; text?: string; author?: string }[] = [];
			const watch = await receiver.channel.handle({ op: "watch" }, (event) => events.push(event)) as {
				stop(): Promise<unknown>;
			};
			await until(() => events.some((event) => event.kind === "live"));
			await watch.stop();
			expect(events.filter((event) => event.kind === "message")).toEqual([
				expect.objectContaining({ author: "agent@sender", text: "please review", invoked: false }),
			]);
		} finally {
			for (const channel of channels.values()) await channel.close();
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("request boundary", () => {
	test("parseRequest stamps the verified author and refuses malformed requests", () => {
		expect(parseRequest({ op: "ask", text: "hi", author: "mallory", chat: 2 }, OWNER)).toEqual({
			op: "ask",
			chat: 2,
			author: OWNER,
			text: "hi",
		});
		expect(parseRequest({ op: "kill" }, OWNER)).toEqual({ op: "kill", author: OWNER });
		expect(parseRequest({ op: "answer", text: "later" }, OWNER)).toEqual({
			op: "answer",
			author: OWNER,
			text: "later",
		});
		const refused: [unknown, string][] = [
			[null, "expected object, received null"],
			[{ op: "nope" }, "Invalid discriminator value"],
			[{ op: "ask", text: 3 }, "expected string, received number\n  → at text"],
			[{ op: "ask", text: "hi", chat: -1 }, "expected number to be >=0\n  → at chat"],
			[{ op: "ask", text: "hi", chat: 1.5 }, "expected int, received number\n  → at chat"],
			[{ op: "ask", text: "hi", sudo: true }, 'Unrecognized key: "sudo"'],
			[{ op: "ask", text: "hi", effort: "extreme" }, "→ at effort"],
			[{ op: "ask", text: "hi", model: { provider: "faux" } }, "→ at model.modelId"],
			[{ op: "ask", text: "hi", requestId: "" }, "→ at requestId"],
			[{ op: "answer", call: "c", answers: [{ choices: [-1] }] }, "→ at answers[0].choices[0]"],
			[{ op: "answer", call: "c", answers: [{ choices: [0], custom: "x" }] }, "→ at answers[0]"],
			[{ op: "answer", answers: [{ choices: [0] }] }, "An answer is either a call's answers or a written text"],
			[{ op: "patch", file: "a", state: "staged" }, "→ at state"],
			[{ op: "watch", queue: "yes" }, "→ at queue"],
			[{ op: "edit", entry: 3 }, "→ at text"],
		];
		for (const [value, message] of refused) {
			expect(() => parseRequest(value, OWNER)).toThrow(message);
		}
	});

	test("a malformed attachment is refused before anything is committed", async () => {
		const fixture = await create();
		await expect(
			fixture.request({
				op: "say",
				author: OWNER,
				text: "look",
				images: [{ mimeType: "image/svg+xml", data: "PHN2Zz4=" }],
			}),
		).rejects.toThrow("Unsupported image type image/svg+xml");
		await expect(fixture.request({ op: "say", author: "not an author", text: "hi" })).rejects.toThrow(
			"Invalid author",
		);
		const watch = await fixture.watch();
		await watch.until("live");
		await watch.stop();
		expect(watch.of("message")).toEqual([]);
	});
});

describe("storage", () => {
	test("pi's node:sqlite storage keeps a channel's history across processes' reopenings on Bun", async () => {
		const fixture = await create();
		fixture.script(fauxAssistantMessage("first answer"));
		const { submission } = await fixture.request<{ submission: number }>({
			op: "ask",
			author: OWNER,
			text: "remember",
			model: MODEL,
		});
		await fixture.request({ op: "wait", submission });
		await fixture.channel.close();
		const reopened = await openNodeSqliteStorage(join(fixture.root, "state", "channel.sqlite"));
		const page = await reopened.scanEntries(
			{ conversationId: ROOT_CONVERSATION_ID },
			10,
			undefined,
			BACKGROUND_CONTEXT,
		);
		expect(page.items.length).toBeGreaterThanOrEqual(2);
		await reopened.close(BACKGROUND_CONTEXT);
		await fixture.open();
		const watch = await fixture.watch();
		await watch.until("reply", (event) => event.text === "first answer");
		await watch.stop();
	});
});
