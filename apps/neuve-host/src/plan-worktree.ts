import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { Log } from "@ace/channel";

async function git(project: string, args: string[]) {
	const child = Bun.spawn(["git", "--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
		"-c", "core.untrackedCache=false", "-C", project, ...args], {
		stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 15_000,
	});
	const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	return { out, error: error.trim(), code };
}

export async function removePlanWorktree(input: {
	project: string; directory: string; prefix: string; lane: string; path: string; branch: string; head: string;
}, log: Log) {
	const { project, directory, prefix, lane, path, branch, head } = input;
	const keep = (reason: string) => {
		log("info", "build.lane.kept", { branch, path, reason });
		return false;
	};
	if (!/^build-[a-f0-9-]+$/.test(lane) || path !== join(directory, lane) || branch !== `${prefix}/${lane}`) {
		return keep("The lane does not match its host-owned location.");
	}
	const ref = `refs/heads/${branch}`;
	const listed = await git(project, ["worktree", "list", "--porcelain", "-z"]);
	if (listed.code !== 0) return keep(listed.error);
	const worktrees = listed.out.split("\0\0").map(entry => entry.split("\0"));
	const canonical = existsSync(directory) ? join(realpathSync(directory), lane) : path;
	if (existsSync(path) && realpathSync(path) !== canonical) return keep("The worktree folder has moved.");
	const worktree = worktrees.find(entry => entry[0] === `worktree ${canonical}`);
	if (worktrees.some(entry => entry !== worktree && entry.includes(`branch ${ref}`))) {
		return keep("The branch is checked out in another worktree.");
	}
	const branchHead = await git(project, ["rev-parse", "--verify", "--quiet", ref]);
	if (branchHead.code === 1 && !existsSync(path) && !worktree) return true;
	if (branchHead.code !== 0 || branchHead.out.trim() !== head) {
		return keep("The branch head differs from the merged pull request.");
	}
	if (worktree || existsSync(path)) {
		if (!worktree?.includes(`branch ${ref}`) || !worktree.includes(`HEAD ${head}`)) {
			return keep("The worktree no longer has the merged branch and head.");
		}
		const filters = await git(path, ["config", "--name-only", "--get-regexp", "^filter\\..*\\.(clean|process|required)$"]);
		if (filters.code > 1) return keep(filters.error);
		if (filters.out.trim()) return keep("The worktree has Git filters configured.");
		const index = await git(path, ["ls-files", "--stage", "-z"]);
		if (index.code !== 0) return keep(index.error);
		if (index.out.split("\0").some(entry => {
			const tab = entry.indexOf("\t");
			return entry.startsWith("160000 ") && tab >= 0 && existsSync(join(path, entry.slice(tab + 1), ".git"));
		})) return keep("The worktree contains a checked-out submodule.");
		const status = await git(path, ["status", "--porcelain", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none"]);
		if (status.code !== 0 || status.out) return keep(status.error || "The worktree has uncommitted or untracked work.");
		const removed = await git(project, ["worktree", "remove", "--", canonical]);
		if (removed.code !== 0) return keep(removed.error);
	}
	// A squash does not preserve ancestry. Delete only if the exact merged head still owns the ref.
	const removed = await git(project, ["update-ref", "-d", ref, head]);
	if (removed.code !== 0) return keep(removed.error);
	log("info", "build.lane.removed", { branch, path });
	return true;
}
