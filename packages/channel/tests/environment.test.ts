import { afterEach, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { Fixture, MODEL, OWNER, git } from "./helpers";

let fixture: Fixture | undefined;
afterEach(async () => { await fixture?.dispose(); fixture = undefined; });

async function ask() {
	const { submission } = await fixture!.request<{ submission: number }>({ op: "ask", author: OWNER, text: "Where do you run?", model: MODEL });
	expect(await fixture!.request({ op: "wait", submission })).toBe("done");
}

// Observe the actual provider-facing offer and prompt, not only extension installation.
test("desktop selection follows host availability and channel settings on existing channels", async () => {
	let available = false;
	fixture = await Fixture.create({ desktop: async () => ({ text: "ok" }), desktopAvailable: () => available,
		browser: async () => ({ text: "browser" }) });
	const observe = (enabled: boolean) => {
		fixture!.script(request => {
			const tools = getCurrentTools(request.messages).map(tool => tool.name);
			expect(tools.includes("desktop_apps")).toBe(enabled);
			expect(tools).toContain("browser_tabs");
			expect(getCurrentSystemPrompt(request.messages).includes("<ace-desktop>")).toBe(enabled);
			return fauxAssistantMessage("observed");
		});
	};
	await fixture.request({ op: "desktop", author: OWNER, enabled: true });
	observe(false); await ask();
	available = true;
	observe(true); await ask();
	await fixture.request({ op: "desktop", author: OWNER, enabled: false });
	observe(false); await ask();
	await fixture.request({ op: "desktop", author: OWNER, enabled: true });
	await fixture.restart();
	observe(true); await ask();
	available = false;
	observe(false); await ask();
});

test("desktop dispatch still checks settings after the model's offer", async () => {
	let dispatched = 0;
	fixture = await Fixture.create({ desktop: async () => { dispatched++; return { text: "ok" }; } });
	await fixture.request({ op: "desktop", author: OWNER, enabled: true });
	fixture.script(async request => {
		expect(getCurrentTools(request.messages).map(tool => tool.name)).toContain("desktop_apps");
		await fixture!.request({ op: "desktop", author: OWNER, enabled: false });
		return fauxAssistantMessage([fauxToolCall("desktop_apps", {}, { id: "late" })], { stopReason: "toolUse" });
	}, fauxAssistantMessage("done"));
	await ask();
	expect(dispatched).toBe(0);
});

test("context reports captured build separately from lane Git and refreshes detached state", async () => {
	fixture = await Fixture.create({ hostEnvironment: { host: "fixture-host", version: "captured-version", commit: "captured-build" } });
	fixture.script(request => {
		const prompt = getCurrentSystemPrompt(request.messages);
		expect(prompt).toContain("version captured-version; commit captured-build");
		expect(prompt).toContain("Role: main chat");
		expect(prompt).toContain("Git branch: one/work");
		expect(prompt).toContain("Work lane: work");
		expect(prompt).toContain("Runtime shell: available");
		return fauxAssistantMessage("observed");
	});
	await ask();
	git(fixture.lane.path, "checkout", "--detach");
	fixture.script(request => {
		const prompt = getCurrentSystemPrompt(request.messages);
		expect(prompt).toContain("Git branch: detached HEAD");
		expect(prompt).toContain("commit captured-build");
		return fauxAssistantMessage("observed");
	});
	await ask();
});

test("environment context discloses absent shell and no lane for each role without probing", async () => {
	const { environment } = await import("../src/environment");
	for (const role of [undefined, "implementer", "reviewer"]) {
		const section = environment(undefined, () => role);
		const text = await section.render({ conversationId: 1, agent: { cwd: "/no-lane", tools: [] },
			env: undefined, read: { snapshot: async () => undefined } } as never, {} as never);
		expect(text).toContain(`Role: ${role ?? "main chat"}`);
		expect(text).toContain("Working folder: /no-lane");
		expect(text).toContain("Work lane: none recorded");
		expect(text).toContain("Runtime shell: unavailable");
		expect(text).toContain("unknown (no runtime shell)");
	}
});
