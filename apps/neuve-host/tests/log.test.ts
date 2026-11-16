import "./fixtures/memory-secrets";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("operational files exclude payload families and stay private on create, reopen and rotation", async () => {
	if (!process.env.TMPDIR)
		throw new Error("Set TMPDIR to the external temporary directory");
	const root = await mkdtemp(join(tmpdir(), "host-log-"));
	try {
		const script = `
import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { config } from ${JSON.stringify(fileURLToPath(new URL("../src/host-config.ts", import.meta.url)))};
import { log, open } from ${JSON.stringify(fileURLToPath(new URL("../src/private-log.ts", import.meta.url)))};
config.home = ${JSON.stringify(root)};
config.environment = { NEUVE_HOST_DEBUG: "1" };
const secret = "synthetic-operational-payload";
const path = config.home + "/logs/probe.jsonl";
open("probe");
log("info", "probe.payload", { args: { command: secret }, prompt: secret, content: secret, result: secret, error: secret, stack: secret, cause: { error: secret }, call: secret, tool: secret, model: { provider: secret, modelId: secret }, requestId: secret, author: secret, trace: secret, channel: secret, name: secret, project: secret, url: secret, reason: secret, op: secret, provider: secret, unknown: secret, constructor: secret, usage: { input: 7, output: 2, cost: { total: 1 } }, chat: 3, task: 4, ms: 5, failed: true });
const bytes = readFileSync(path, "utf8");
const modes = [statSync(path).mode & 0o777];
chmodSync(path, 0o644);
open("probe");
modes.push(statSync(path).mode & 0o777);
writeFileSync(path, " ".repeat(10 * 1024 * 1024));
open("probe");
log("info", "tool.end", { tool: "bash", call: "id", chat: 3, task: 4, error: false, ms: 1 });
modes.push(statSync(path).mode & 0o777, statSync(path.replace(".jsonl", ".1.jsonl")).mode & 0o777);
writeFileSync(config.home + "/receipt.json", JSON.stringify({ modes, dir: statSync(config.home + "/logs").mode & 0o777, contains: bytes.includes(secret), records: bytes.trim().split("\\n").map(JSON.parse), rotated: readFileSync(path, "utf8").trim().split("\\n").map(JSON.parse) }));
`;
		const child = Bun.spawnSync(
			[process.execPath, "--no-env-file", "--eval", script],
			{
				env: {
					PATH: process.env.PATH,
					TMPDIR: process.env.TMPDIR,
					BUN_RUNTIME_TRANSPILER_CACHE_PATH:
						process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH,
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		expect(child.stderr.toString()).toBe("");
		expect(child.exitCode).toBe(0);
		const receipt = JSON.parse(
			await readFile(join(root, "receipt.json"), "utf8"),
		);
		expect(receipt.contains).toBe(false);
		expect(receipt.modes).toEqual([0o600, 0o600, 0o600, 0o600]);
		expect(receipt.dir).toBe(0o700);
		expect(receipt.records[0]).toMatchObject({
			event: "probe.payload",
			chat: 3,
			task: 4,
			ms: 5,
			failed: true,
			usage: { input: 7, output: 2, cost: { total: 1 } },
		});
		expect(receipt.records[0].callHash).toMatch(/^[a-f0-9]{64}$/);
		expect(receipt.records[0]).not.toHaveProperty("args");
		expect(receipt.rotated[0]).toMatchObject({
			event: "tool.end",
			tool: "bash",
			error: false,
			ms: 1,
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
