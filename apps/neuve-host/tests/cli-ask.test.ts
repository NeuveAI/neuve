// Shell callers have no card. The command must set attendance on the request it sends.
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("ace ask sends attended false", async () => {
	const root = await mkdtemp(join(tmpdir(), "ace-cli-ask-"));
	try {
		const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "fixtures/cli-ask.ts"), "ask", "test", "--detach", "Continue"], {
			env: { ...process.env, ACE_HOME: root, ACE_CONFIG_HOME: join(root, "settings") },
			stdout: "pipe", stderr: "pipe",
		});
		const [status, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
		if (status !== 0) throw new Error(error);
		const request = output.split("\n").find(line => line.startsWith("{"));
		expect(JSON.parse(request ?? "null")).toEqual({ op: "ask", author: "person", text: "Continue", attended: false });
	} finally { await rm(root, { recursive: true, force: true }); }
});
