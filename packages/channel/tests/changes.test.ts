import { expect, test } from "bun:test";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Changes } from "../src/protocol";
import { Fixture, git } from "./helpers";

test("real Git filenames survive committed, uncommitted, renamed, binary and untracked changes", async () => {
	const fixture = await Fixture.create();
	try {
		const cwd = fixture.lane.path;
		const files = [
			"tab\tname.txt",
			"space name.txt",
			"line\nname.txt",
			"quote'\".txt",
			"日本語.txt",
			"R100",
		];
		for (const file of files) await writeFile(join(cwd, file), "before\n");
		await writeFile(join(cwd, "binary\tfile"), new Uint8Array([0, 1, 2]));
		git(cwd, "add", ".");
		git(cwd, "commit", "-qm", "filenames");
		const renamed = "renamed\t\n'日本語.txt";
		await rename(join(cwd, "README.md"), join(cwd, renamed));
		git(cwd, "add", ".");
		git(cwd, "commit", "-qm", "rename");
		const committed = await fixture.request<Changes>({ op: "changes" });
		for (const file of files) {
			expect(
				committed.files.find((entry) => entry.file === file),
			).toMatchObject({ adds: 1, dels: 0, binary: false, state: "committed" });
			expect(
				committed.files.find((entry) => entry.file === file)?.version,
			).not.toBe("deleted");
			expect(
				await fixture.request<string>({
					op: "patch",
					file,
					state: "committed",
				}),
			).toContain("+before");
		}
		expect(
			committed.files.find((entry) => entry.file === "binary\tfile"),
		).toMatchObject({ adds: 0, dels: 0, binary: true });
		expect(
			committed.files.find((entry) => entry.file === renamed),
		).toMatchObject({ from: "README.md", state: "committed" });
		expect(
			await fixture.request<string>({
				op: "patch",
				file: renamed,
				state: "committed",
			}),
		).toContain("rename from README.md");
		await writeFile(join(cwd, files[0]!), "after\n");
		await writeFile(join(cwd, "loose\t\n'日本語.txt"), "loose\n");
		const changed = await fixture.request<Changes>({ op: "changes" });
		expect(
			changed.files.find(
				(entry) => entry.file === files[0] && entry.state === "uncommitted",
			),
		).toMatchObject({ adds: 1, dels: 1 });
		expect(
			changed.files.find((entry) => entry.file === "loose\t\n'日本語.txt"),
		).toMatchObject({ adds: 1, state: "untracked" });
		expect(
			await fixture.request<string>({
				op: "patch",
				file: files[0]!,
				state: "uncommitted",
			}),
		).toContain("+after");
		expect(
			await fixture.request<string>({
				op: "patch",
				file: "loose\t\n'日本語.txt",
				state: "untracked",
			}),
		).toContain("+loose");
	} finally {
		await fixture.dispose();
	}
});

test("status-shaped filenames do not become rename headers for another file's patch", async () => {
	const fixture = await Fixture.create();
	try {
		const cwd = fixture.lane.path;
		const files: [string, string][] = [
			["A", "unrelated-marker\n"],
			["R100", "status-name\n"],
			["S", "target-marker\n"],
		];
		for (const [file, text] of files) {
			await writeFile(join(cwd, file), text);
		}
		git(cwd, "add", ".");
		git(cwd, "commit", "-qm", "status-shaped filenames");
		const patch = await fixture.request<string>({
			op: "patch",
			file: "S",
			state: "committed",
		});
		expect(patch).toContain("+target-marker");
		expect(patch).not.toContain("unrelated-marker");
	} finally {
		await fixture.dispose();
	}
});
