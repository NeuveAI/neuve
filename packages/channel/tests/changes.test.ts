import { expect, test } from "bun:test";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

import { fetchBase } from "../src/changes";
import type { Changes } from "../src/protocol";
import { Fixture, git, scratchEnv } from "./helpers";

async function addSubmodule(fixture: Fixture) {
	const source = join(fixture.root, "submodule source");
	await mkdir(source);
	git(source, "init", "-qb", "main");
	await writeFile(join(source, "file.txt"), "before\n");
	git(source, "add", "file.txt");
	git(source, "commit", "-qm", "first submodule commit");
	const cwd = fixture.lane.path;
	git(cwd, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "sub");
	git(cwd, "config", "-f", ".gitmodules", "submodule.sub.ignore", "none");
	git(cwd, "config", "-f", ".gitmodules", "submodule.sub.fetchRecurseSubmodules", "true");
	git(cwd, "add", ".gitmodules");
	git(cwd, "commit", "-qm", "add submodule");
	return { source, path: join(cwd, "sub"), first: git(source, "rev-parse", "HEAD").trim() };
}

test("changes and patches show gitlink updates but omit edits inside the submodule", async () => {
	const fixture = await Fixture.create();
	try {
		const { path, first } = await addSubmodule(fixture);
		const cwd = fixture.lane.path;
		await writeFile(join(path, "file.txt"), "edited\n");
		await writeFile(join(cwd, "README.md"), "changed in the lane\n");
		expect((await fixture.request<Changes>({ op: "changes" })).files
			.filter(file => file.state === "uncommitted").map(file => file.file)).toEqual(["README.md"]);
		expect(await fixture.request<string>({ op: "patch", file: "sub", state: "uncommitted" })).toBe("");
		expect(await fixture.request<string>({ op: "patch", file: "sub", state: "committed" }))
			.toContain(`+Subproject commit ${first}`);

		git(cwd, "config", "diff.submodule", "diff");
		git(path, "commit", "-qam", "move the submodule pointer");
		const second = git(path, "rev-parse", "HEAD").trim();
		expect((await fixture.request<Changes>({ op: "changes" })).files)
			.toContainEqual(expect.objectContaining({ file: "sub", state: "uncommitted" }));
		expect(await fixture.request<string>({ op: "patch", file: "sub", state: "uncommitted" }))
			.toContain(`+Subproject commit ${second}`);
		expect(await fixture.request<string>({ op: "patch", file: "sub" }))
			.toContain(`+Subproject commit ${second}`);

		const loose = join(cwd, "untracked");
		await mkdir(loose);
		git(loose, "init", "-q");
		await writeFile(join(loose, "file.txt"), "inside an untracked repository\n");
		expect((await fixture.request<Changes>({ op: "changes" })).files)
			.toContainEqual(expect.objectContaining({ file: "untracked/", state: "untracked" }));
		expect(await fixture.request<string>({ op: "patch", file: "untracked/", state: "untracked" }))
			.toBe("");
	} finally {
		await fixture.dispose();
	}
});

test("fetching a lane base updates the parent ref without fetching the submodule", async () => {
	const fixture = await Fixture.create();
	const cwd = fixture.lane.path;
	const env = scratchEnv(cwd, fixture.root);
	try {
		const { source, path, first } = await addSubmodule(fixture);
		const upstream = join(fixture.root, "upstream");
		git(cwd, "clone", "-q", "--single-branch", "--branch", "one/work", fixture.project, upstream);
		git(cwd, "remote", "add", "origin", upstream);
		const base = "refs/remotes/origin/one/work";
		const oldBase = git(upstream, "rev-parse", "HEAD").trim();
		git(cwd, "update-ref", base, oldBase);

		await writeFile(join(source, "file.txt"), "remote edit\n");
		git(source, "commit", "-qam", "move upstream submodule pointer");
		const second = git(source, "rev-parse", "HEAD").trim();
		git(upstream, "update-index", "--cacheinfo", `160000,${second},sub`);
		git(upstream, "commit", "-qm", "advance upstream");
		const nextBase = git(upstream, "rev-parse", "HEAD").trim();

		await fetchBase(env, cwd, base, BACKGROUND_CONTEXT);
		expect(git(cwd, "rev-parse", base).trim()).toBe(nextBase);
		expect(git(path, "rev-parse", "refs/remotes/origin/main").trim()).toBe(first);
	} finally {
		await env.cleanup(BACKGROUND_CONTEXT);
		await fixture.dispose();
	}
});

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
