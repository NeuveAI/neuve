import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// A persistent catalog error also reaches workspace.sync; unit callbacks alone cannot prove survival.
for (const scenario of ["unreadable", "queued", "skipped"] as const) test(`gateway survives ${scenario} catalog failure and delivers a later folder event`, async () => {
	const root = await mkdtemp(join(tmpdir(), "cgw-"));
	const home = join(root, "state");
	let passed = false;
	try {
		await mkdir(home);
		const bin = join(root, "bin");
		await mkdir(bin);
		// An unrelated GitHub login callback can broadcast a listing and hide a failed catalog retry.
		await writeFile(join(bin, "gh"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
		const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "fixtures/catalog-gateway.ts"), scenario], {
			env: {
				PATH: `${bin}:${process.env.PATH}`,
				TMPDIR: root,
				BUN_TMPDIR: root,
				ACE_HOME: home,
				ACE_CONFIG_HOME: join(home, "settings"),
				ACE_KEYCHAIN_SERVICE: `catalog-gateway-${process.pid}`,
				GH_CONFIG_DIR: join(root, "gh"),
				BUN_RUNTIME_TRANSPILER_CACHE_PATH: process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH,
			},
			stdin: "ignore", stdout: "pipe", stderr: "pipe",
		});
		const stdout = new Response(child.stdout).text();
		const stderr = new Response(child.stderr).text();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const deadline = new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("Catalog gateway fixture exceeded 10 seconds")), 10_000);
			});
			expect(await Promise.race([child.exited, deadline])).toBe(0);
			const report = (await stdout).split("\n").find(line => line.startsWith("{"));
			expect(JSON.parse(report ?? "null")).toEqual(scenario === "unreadable" ? {
				initialChannels: [],
				escaped: null,
				failureLogged: true,
				models: [],
				modeRestored: true,
				deliveredActive: 123,
			} : scenario === "queued" ? {
				initialChannels: [],
				queuedFailureLogged: true,
				recoveredActive: 123,
				diskActive: 123,
			} : {
				initialChannels: [],
				frameFailures: 2,
				recoveredState: "running",
			});
			const lines = (await readFile(join(home, "logs/host.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
			// Read the real logger's output: callback fields must not overwrite its event or base fields.
			if (scenario === "unreadable") {
				expect(lines).toContainEqual(expect.objectContaining({
					event: "gateway.catalog.rescanned", trigger: expect.stringMatching(/^[0-9a-f]{16}$/), file: "channel.json",
					level: "info", proc: "host", pid: child.pid, t: expect.any(String),
				}));
				expect(lines).toContainEqual(expect.objectContaining({
					event: "gateway.catalog.rescan.failed", error: expect.any(String),
					level: "error", proc: "host", pid: child.pid, t: expect.any(String),
				}));
			}
			if (scenario === "skipped") expect(lines.some(line => line.event === "process.unhandled")).toBe(false);
			passed = true;
		} finally {
			clearTimeout(timer);
			if (child.exitCode === null) child.kill("SIGKILL");
			await child.exited;
			if (!passed) console.error(JSON.stringify({
				exit: child.exitCode, stdout: await stdout, stderr: await stderr,
				hostLog: await readFile(join(home, "logs/host.jsonl"), "utf8").catch(() => ""),
			}));
		}
	} finally {
		try {
			await chmod(join(home, "channels"), 0o700).catch(error => {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			});
			await rm(root, { recursive: true, force: true });
		} catch (error) {
			if (passed) throw error;
			console.error("Catalog gateway fixture cleanup failed", error);
		}
	}
}, 20_000);
