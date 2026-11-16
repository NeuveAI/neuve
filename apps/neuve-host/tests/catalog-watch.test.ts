import { expect, spyOn, test } from "bun:test";
import { existsSync, watch } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { watchCatalog } from "../src/catalog-watch";

const writer = `const fs = require("node:fs"); const path = process.argv.at(-1);
process.on("message", at => { fs.writeFileSync(path + ".tmp", JSON.stringify({ ran: { at } })); fs.renameSync(path + ".tmp", path); process.send("written"); });
process.send("ready");`;

test("catalog observer loads no preload from the project or catalog folder", async () => {
	const root = await mkdtemp(join(tmpdir(), "catalog-observer-preload-"));
	const project = join(root, "project"),
		directory = join(root, "channels");
	await mkdir(project);
	await mkdir(directory);
	const markers = [
		join(root, "project-preload"),
		join(root, "catalog-preload"),
	];
	for (const [index, folder] of [project, directory].entries()) {
		await writeFile(
			join(folder, "bunfig.toml"),
			'preload = ["./preload.js"]\n',
		);
		await writeFile(
			join(folder, "preload.js"),
			`require("node:fs").writeFileSync(${JSON.stringify(markers[index])}, "preload ran");`,
		);
	}
	const changed = Promise.withResolvers<string | null>();
	const failure = Promise.withResolvers<never>();
	void failure.promise.catch(() => {});
	const cwd = process.cwd();
	let observer: ReturnType<typeof watchCatalog>;
	try {
		process.chdir(project);
		observer = watchCatalog(
			directory,
			(file) => {
				// FSEvents can deliver the earlier preload setup writes after the observer starts.
				if (file === "channel.json") changed.resolve(file);
			},
			failure.reject,
		);
	} finally {
		process.chdir(cwd);
	}
	const deadlineMs = 5000;
	let deadline: ReturnType<typeof setTimeout> | undefined;
	try {
		await observer.ready;
		expect(markers.map(existsSync)).toEqual([false, false]);
		await writeFile(join(directory, "channel.json"), "{}");
		deadline = setTimeout(() => {
			changed.reject(
				new Error(
					`Catalog observer did not report channel.json within ${deadlineMs} ms`,
				),
			);
		}, deadlineMs);
		expect(await Promise.race([changed.promise, failure.promise])).toBe(
			"channel.json",
		);
	} finally {
		clearTimeout(deadline);
		await observer.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("catalog observer death after ready reports a failure and close joins it", async () => {
	const root = await mkdtemp(join(tmpdir(), "catalog-observer-death-"));
	const failed = Promise.withResolvers<Error>();
	const failures: Error[] = [];
	const spawn = spyOn(Bun, "spawn");
	const observer = watchCatalog(
		root,
		() => {},
		(error) => {
			failures.push(error);
			failed.resolve(error);
		},
	);
	const child = spawn.mock.results[0]?.value;
	spawn.mockRestore();
	try {
		if (!child) throw new Error("Catalog observer did not spawn");
		await observer.ready;
		child.kill("SIGKILL");
		expect((await failed.promise).message).toContain("Catalog watcher exited");
		expect(failures).toHaveLength(1);
		await observer.close();
		await observer.close();
	} finally {
		await observer.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("catalog observation retains worker writes while unrelated watchers are added and removed", async () => {
	const root = await mkdtemp(join(tmpdir(), "catalog-observer-"));
	const directory = join(root, "channels"),
		records = join(root, "records");
	await mkdir(directory);
	await mkdir(records);
	const path = join(directory, "channel.json");
	await writeFile(path, JSON.stringify({ ran: { at: 0 } }));
	let seen = 0,
		error: Error | undefined;
	const observer = watchCatalog(
		directory,
		(file) => {
			if (file !== "channel.json") return;
			void readFile(path, "utf8").then((text) => {
				seen = z
					.object({ ran: z.object({ at: z.number() }) })
					.parse(JSON.parse(text)).ran.at;
			});
		},
		(value) => {
			error = value;
		},
	);
	let ready = Promise.withResolvers<void>(),
		written = Promise.withResolvers<void>();
	const child = Bun.spawn(
		[process.execPath, "--no-env-file", "--eval", writer, path],
		{
			env: { BUN_BE_BUN: "1", TMPDIR: process.env.TMPDIR },
			stdin: "ignore",
			stdout: "ignore",
			stderr: "inherit",
			ipc(message) {
				if (message === "ready") ready.resolve();
				else if (message === "written") written.resolve();
			},
		},
	);
	try {
		await observer.ready;
		await ready.promise;
		// Let the initial watch registration settle before exercising stream replacement.
		await Bun.sleep(100);
		for (let at = 1; at <= 30; at++) {
			const unrelated = watch(records, () => {});
			written = Promise.withResolvers<void>();
			child.send(at);
			await written.promise;
			unrelated.close();
			const deadline = Date.now() + 1000;
			while (seen !== at && !error && Date.now() < deadline) await Bun.sleep(5);
			if (error) throw error;
			expect(seen).toBe(at);
		}
	} finally {
		child.kill("SIGTERM");
		await child.exited;
		await observer.close();
		await rm(root, { recursive: true, force: true });
	}
}, 10000);

test("catalog observer startup failure is reported and close still joins it", async () => {
	const failures: Error[] = [];
	const observer = watchCatalog(
		join(tmpdir(), `missing-catalog-${crypto.randomUUID()}`),
		() => {},
		(error) => failures.push(error),
	);
	await expect(observer.ready).rejects.toThrow(
		"Catalog watcher could not start",
	);
	expect(failures).toHaveLength(1);
	await observer.close();
	await observer.close();
});

test("catalog observer can close before startup completes", async () => {
	const root = await mkdtemp(join(tmpdir(), "catalog-observer-close-"));
	const failures: Error[] = [];
	const observer = watchCatalog(
		root,
		() => {},
		(error) => failures.push(error),
	);
	await observer.close();
	await expect(observer.ready).rejects.toThrow("closed during startup");
	expect(failures).toEqual([]);
	await rm(root, { recursive: true, force: true });
});
