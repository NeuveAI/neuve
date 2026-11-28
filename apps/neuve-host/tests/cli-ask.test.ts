// Shell callers have no card. The command must set attendance on the request it sends.
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function ask(...args: string[]) {
	const root = await mkdtemp(join(tmpdir(), "ace-cli-ask-"));
	try {
		const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "fixtures/cli-ask.ts"), "ask", "test", ...args], {
			env: { ...process.env, ACE_HOME: root, ACE_CONFIG_HOME: join(root, "settings") },
			stdout: "pipe", stderr: "pipe",
		});
		const [status, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
		return { status, output, error };
	} finally { await rm(root, { recursive: true, force: true }); }
}

test("ace ask sends attended false", async () => {
	const { status, output, error } = await ask("--detach", "Continue");
	if (status !== 0) throw new Error(error);
	const request = output.split("\n").find(line => line.startsWith("{"));
	expect(JSON.parse(request ?? "null")).toEqual({ op: "ask", author: "person", text: "Continue", attended: false });
});

test("ace ask prints a final reply delivered after wait", async () => {
	const { status, output } = await ask("Continue");
	expect(output).toContain("Final reply");
	expect(output).toContain("(run ended)");
	expect(status).toBe(0);
});

test("ace ask exits 1 when the final reply after wait is an error", async () => {
	const { status, output } = await ask("Fail");
	expect(status).toBe(1);
	expect(output).toContain("Run failed: Provider failed");
});

test("ace ask prints the error when wait answers before the watch sees the run start", async () => {
	const { status, output } = await ask("Fail before run start");
	expect(status).toBe(1);
	expect(output).toContain("Run failed: Provider failed");
});
