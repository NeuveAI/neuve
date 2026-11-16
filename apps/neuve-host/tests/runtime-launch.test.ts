import "./fixtures/memory-secrets";
import { expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../src/config";
import * as tailnet from "../src/tailnet";
import * as settings from "../src/settings";
import { deploy } from "../src/team";

async function poison(folder: string, marker: string) {
	await mkdir(folder, { recursive: true });
	await writeFile(join(folder, "bunfig.toml"), 'preload = ["./preload.js"]\n');
	await writeFile(
		join(folder, "preload.js"),
		`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "preload ran");`,
	);
	await writeFile(
		join(folder, ".env"),
		"NEUVE_LAUNCH_PROJECT_FIXTURE=loaded\n",
	);
}

test("the default source host worker loads no project preload", async () => {
	const root = await mkdtemp(join(tmpdir(), "host-worker-config-"));
	const project = join(root, "project"),
		home = join(root, "state"),
		marker = join(root, "preloaded");
	await poison(project, marker);
	await mkdir(join(home, "channels", "deleted"), { recursive: true });
	const entry = `import { config } from ${JSON.stringify(new URL("../src/config.ts", import.meta.url).href)};
const child = Bun.spawn([...config.worker, "deleted"], {stdout: "pipe", stderr: "pipe"});
const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
console.log(JSON.stringify({out, err, code}));`;
	const child = Bun.spawn(
		[process.execPath, "--no-env-file", `--config=${devNull}`, "--eval", entry],
		{
			cwd: project,
			env: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				TMPDIR: process.env.TMPDIR,
				ACE_HOME: home,
				ACE_CONFIG_HOME: join(home, "settings"),
				ACE_USER: "owner",
				NEUVE_MODE: "check",
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	try {
		const [out, err, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect({ code, err }).toEqual({ code: 0, err: "" });
		expect(JSON.parse(out)).toEqual({ out: "", err: "", code: 0 });
		expect(
			await readFile(join(home, "logs/channel-deleted.jsonl"), "utf8"),
		).toContain('"event":"worker.deleted"');
		expect(existsSync(marker)).toBe(false);
	} finally {
		child.kill("SIGKILL");
		await child.exited;
		await rm(root, { recursive: true, force: true });
	}
});

test("team deployment launches Bun with no project or service preload", async () => {
	const root = await mkdtemp(join(tmpdir(), "host-team-config-"));
	const project = join(root, "project"),
		services = join(root, "services"),
		launches = join(root, "launches.jsonl");
	const markers = [
		join(root, "project-preload"),
		join(root, "service-preload"),
	];
	await poison(project, markers[0]);
	await poison(services, markers[1]);
	// Replace only Cloudflare's executable with a local CLI. Bun still launches with the real
	// command's runtime flags, working directory and environment; no network or sign-in is used.
	const fixture = `const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(launches)}, JSON.stringify({cwd: process.cwd(), env: process.env.NEUVE_LAUNCH_PROJECT_FIXTURE ?? null}) + "\\n");
console.log(process.argv.at(-1) === "whoami" ? "You are logged in" : "https://fixture.workers.dev");`;
	const originalSpawn = Bun.spawn;
	const domain = spyOn(tailnet, "domain").mockResolvedValue("fixture.ts.net");
	const directory = spyOn(settings, "setDirectory").mockResolvedValue();
	const spawn = spyOn(Bun, "spawn").mockImplementation((command, options) => {
		if (!Array.isArray(command)) throw new Error("Expected a Bun command");
		const index = command.indexOf("x");
		expect(command.slice(index, index + 3)).toEqual([
			"x",
			"--bun",
			"wrangler@4.140.0",
		]);
		return originalSpawn(
			[
				...command.slice(0, index),
				"--eval",
				fixture,
				"--",
				...command.slice(index + 3),
			],
			options,
		);
	});
	const originalServices = config.services,
		cwd = process.cwd();
	try {
		config.services = services;
		process.chdir(project);
		const result = await deploy(() => {});
		expect(result.url).toBe("https://fixture.workers.dev");
		expect(directory).toHaveBeenCalledTimes(1);
		expect(markers.map(existsSync)).toEqual([false, false]);
		expect(
			(await readFile(launches, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line)),
		).toEqual(Array.from({ length: 3 }, () => ({ cwd: services, env: null })));
	} finally {
		process.chdir(cwd);
		config.services = originalServices;
		spawn.mockRestore();
		domain.mockRestore();
		directory.mockRestore();
		await rm(root, { recursive: true, force: true });
	}
});
