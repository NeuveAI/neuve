import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { toolArguments, toolRefusal } from "@ace/channel/review";
import type { Context } from "@earendil-works/chord";
import { defineExtension, defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { err, FileError, getOrThrow, ok, type ExecutionEnv } from "@earendil-works/pi-durable/env";
import { z } from "zod";

type Tree = { root: string; gitDirectories: string[] };
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

function error(code: FileError["code"], message: string): never {
	throw new FileError(code, message);
}

async function git(
	cwd: string, args: string[], context: Context,
	{ accepted = [0], output, input }: { accepted?: number[]; output?: ToolExecutionApi["output"]; input?: Buffer } = {},
) {
	const child = Bun.spawn([
		"git", "--no-pager",
		"-c", "core.fsmonitor=false",
		"-c", "core.hooksPath=/dev/null",
		"-c", "protocol.allow=never",
		...args,
	], {
		cwd,
		env: {
			PATH: process.env.PATH,
			HOME: process.env.HOME,
			XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
			GIT_OPTIONAL_LOCKS: "0",
			// Diff supplies literal pathspec magic. check-ignore takes paths prefixed with "./".
			...(args[0] === "diff" || args[0] === "check-ignore" ? {} : { GIT_LITERAL_PATHSPECS: "1" }),
			GIT_NO_LAZY_FETCH: "1",
			GIT_ALLOW_PROTOCOL: "",
			GIT_TERMINAL_PROMPT: "0",
		},
		stdin: input ?? "ignore", stdout: "pipe", stderr: "ignore",
		...(context.abortSignal ? { signal: context.abortSignal } : {}),
	});
	const read = async () => {
		if (!output) {
			const bytes = await new Response(child.stdout).arrayBuffer();
			// Preserve the exact filenames used for exclusions or fail before emitting a patch.
			return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
		}
		for await (const bytes of child.stdout) output(bytes);
		return "";
	};
	const [text, status] = await Promise.all([read(), child.exited]);
	context.abortSignal?.throwIfAborted();
	if (!accepted.includes(status)) throw new Error(`Git ${args[0]} failed with exit status ${status}.`);
	return text;
}

async function tree(cwd: string, context: Context): Promise<Tree> {
	const root = await realpath(cwd);
	const text = await git(root, [
		"rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir",
	], context);
	const [toplevel, gitDir, commonDir, ...extra] = text.replace(/\n$/, "").split("\n");
	if (!toplevel || !gitDir || !commonDir || extra.length || await realpath(toplevel) !== root) {
		error("permission_denied", "Plan mode needs the root of a Git working tree.");
	}
	return { root, gitDirectories: await Promise.all([realpath(gitDir), realpath(commonDir)]) };
}

function below(root: string, path: string): string | undefined {
	const name = relative(root, path);
	if (name === ".." || name.startsWith(`..${sep}`) || isAbsolute(name)) return;
	return name;
}

function checkedName(tree: Tree, path: string): string {
	const name = below(tree.root, path);
	if (name === undefined) error("permission_denied", "Plan mode cannot read outside the working tree.");
	checkGitMetadata(tree, path, name);
	return name;
}

function checkGitMetadata(tree: Tree, path: string, name: string) {
	if (tree.gitDirectories.some(dir => below(dir, path) !== undefined)
		|| name.split(sep).some(part => part.toLowerCase() === ".git")) {
		error("permission_denied", "Plan mode cannot read Git metadata.");
	}
}

async function canonical(path: string, allowMissing: boolean): Promise<string> {
	try {
		await lstat(path);
	} catch (e) {
		if (!allowMissing || !(e instanceof Error) || !("code" in e) || e.code !== "ENOENT") throw e;
		const parent = resolve(path, "..");
		return join(await canonical(parent, true), relative(parent, path));
	}
	// A broken symlink has an lstat but no realpath and is refused even for a historical query.
	return realpath(path);
}

async function confinedPath(tree: Tree, path: string, allowMissing: boolean) {
	const requested = resolve(tree.root, path);
	checkedName(tree, requested);
	const actual = await canonical(requested, allowMissing);
	const name = checkedName(tree, actual);
	return { actual, name };
}

async function ignoredPaths(tree: Tree, names: string[], context: Context): Promise<string[]> {
	if (!names.length) return [];
	const paths = new Map(names.map(name => [`./${name}`, name]));
	const text = await git(tree.root, ["check-ignore", "-z", "--stdin"], context, {
		accepted: [0, 1], input: Buffer.from(`${[...paths.keys()].join("\0")}\0`),
	});
	return text.split("\0").filter(Boolean).map(path => {
		const name = paths.get(path);
		if (name === undefined) throw new Error("Git returned an unexpected ignored path.");
		return name;
	});
}

async function confined(tree: Tree, path: string, context: Context, allowMissing = false) {
	const file = await confinedPath(tree, path, allowMissing);
	if (file.name && (await ignoredPaths(tree, [file.name], context)).length) {
		error("permission_denied", "Plan mode cannot read a file Git ignores.");
	}
	return file;
}

async function skillPath(tree: Tree, env: ExecutionEnv, path: string, kind: "file" | "directory", context: Context) {
	const home = getOrThrow(await env.absolutePath("~", context));
	// Keep these skill roots in step with packages/channel/src/context.ts.
	const userRoots = [
		join(home, ".agents", "skills"),
		resolve(process.env["CLAUDE_CONFIG_DIR"] || join(home, ".claude"), "skills"),
	];
	const candidates = [
		...userRoots.map(alias => ({ alias, fixed: undefined })),
		...[".agents/skills", ".claude/skills"].map(dir => ({ alias: resolve(env.cwd, dir), fixed: join(tree.root, dir) })),
	];
	const roots = await Promise.all(candidates.map(async ({ alias, fixed }) => {
		const actual = await realpath(alias).catch(() => undefined);
		// The checkout cannot make another folder an allowed root by replacing a repository root.
		return { alias, actual: fixed === undefined || fixed === actual ? actual : undefined };
	}));
	const requested = resolve(env.cwd, path);
	if (!roots.some(({ alias, actual }) => actual !== undefined
		&& (below(alias, requested) !== undefined || below(actual, requested) !== undefined))) return;
	const actual = await realpath(requested);
	if (!roots.some(root => {
		const name = root.actual === undefined ? undefined : below(root.actual, actual);
		return name !== undefined && (kind === "directory" || name.includes(sep));
	})) return;
	checkGitMetadata(tree, requested, below(tree.root, requested) ?? requested);
	checkGitMetadata(tree, actual, below(tree.root, actual) ?? actual);
	return actual;
}

export function planFileAccess(env: ExecutionEnv, isPlanning: (context: Context) => Promise<boolean>): ExecutionEnv {
	let currentTree: Promise<Tree> | undefined;
	const getTree = (context: Context) => currentTree ??= tree(env.cwd, context);
	const regularFileRequired = "Plan mode can only read regular files.";
	const read: ExecutionEnv["readBinaryFile"] = async (path, context) => {
		try {
			const worktree = await getTree(context);
			const skill = await skillPath(worktree, env, path, "file", context);
			const actual = skill ?? (await confined(worktree, path, context)).actual;
			const expected = await lstat(actual);
			if (!expected.isFile()) error("permission_denied", regularFileRequired);
			const file = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			try {
				const opened = await file.stat();
				const checked = skill
					? await skillPath(worktree, env, path, "file", context)
					: await realpath(resolve(worktree.root, path));
				const current = checked === actual ? await lstat(actual) : undefined;
				if (!opened.isFile() || current?.isFile() === false) error("permission_denied", regularFileRequired);
				if (current === undefined || opened.dev !== expected.dev || opened.ino !== expected.ino
					|| opened.dev !== current.dev || opened.ino !== current.ino) {
					error("permission_denied", "The file changed while Plan mode was opening it.");
				}
				return ok(await file.readFile({ signal: context.abortSignal }));
			} finally {
				await file.close();
			}
		} catch (e) {
			return err(e instanceof FileError ? e : new FileError("permission_denied",
				"Plan mode could not verify or read this file."));
		}
	};
	// The prompt builder skips missing files. Hide files it cannot read so it drops any old text.
	const unavailable = (path: string): { ok: false; error: FileError } => ({
		ok: false,
		error: new FileError("not_found", "File unavailable in plan mode.", path),
	});
	const readTextFile: ExecutionEnv["readTextFile"] = async (path, context) => {
		if (!await isPlanning(context)) return env.readTextFile(path, context);
		const exists = await env.exists(path, context);
		if (!exists.ok || !exists.value) return unavailable(path);
		const result = await read(path, context);
		return result.ok ? ok(new TextDecoder().decode(result.value)) : unavailable(path);
	};
	const listDir: ExecutionEnv["listDir"] = async (path, context) => {
		if (!await isPlanning(context)) return env.listDir(path, context);
		const exists = await env.exists(path, context);
		if (!exists.ok || !exists.value) return unavailable(path);
		try {
			const worktree = await getTree(context);
			const actual = await skillPath(worktree, env, path, "directory", context)
				?? (await confined(worktree, path, context)).actual;
			return await env.listDir(actual, context);
		} catch {
			return unavailable(path);
		}
	};
	const readBinaryFile: ExecutionEnv["readBinaryFile"] = async (path, context) =>
		await isPlanning(context) ? read(path, context) : env.readBinaryFile(path, context);
	return new Proxy(env, {
		get(target, property) {
			if (property === "readBinaryFile") return readBinaryFile;
			if (property === "readTextFile") return readTextFile;
			if (property === "listDir") return listDir;
			const value: unknown = Reflect.get(target, property);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

const safeText = z.string().min(1).refine(value => !value.trimStart().startsWith("-") && !value.includes("\0"));
const revision = z.string().regex(/^[\w@][\w./@-]*(?:[~^]\d*)*$/)
	.describe("A Git revision such as HEAD, HEAD~1, a tag, or a branch.");
const count = z.int().positive().describe("Number of history entries.");
const filePath = safeText.describe("A path inside the working tree.");
const path = filePath.optional();
const Explore = z.discriminatedUnion("action", [
	z.strictObject({ action: z.literal("list"), path }),
	z.strictObject({ action: z.literal("search"), pattern: safeText.describe("Literal text to search for."), path }),
	z.strictObject({ action: z.literal("history"), revision: revision.optional(), count: count.optional(), path }),
	z.strictObject({ action: z.literal("show"), revision, path: filePath }),
	z.strictObject({ action: z.literal("compare"), from: revision, to: revision, path }),
]);
const gitRevision = 'a Git revision such as "HEAD", "HEAD~1", a branch, or a tag';
const readablePath = "a path inside the working tree that is neither Git metadata nor ignored by Git";

export const planExplore = defineExtension({
	name: "neuve-explore",
	tools: [defineTool({
		...toolArguments("explore", Explore, {
			path: `${readablePath}, without a leading dash or NUL character`,
			pattern: "nonempty literal search text without a leading dash or NUL character",
			revision: gitRevision,
			from: gitRevision,
			to: gitRevision,
			count: "a positive integer number of history entries",
		}),
		description: "Use list to list files, search with pattern for literal text in the Git index, history with optional revision and count, show with revision and path for a file, or compare with from and to for two revisions.",
		replay: "safe",
		async execute(args, api, context) {
			const cwd = api.env?.cwd;
			if (!cwd) throw toolRefusal("explore", args, [
				"arguments: Explore needs a chat with a Git working tree.",
			]);
			const worktree = await tree(cwd, context);
			const problems: string[] = [];
			const file = args.path === undefined ? undefined : await confined(worktree, args.path, context, true)
				.then(({ name }) => name, cause => {
					if (context.abortSignal?.aborted) throw cause;
					const reason = cause instanceof Error ? cause.message.replace(/\.$/, "") : String(cause);
					problems.push(`path: ${reason}, so use ${readablePath}.`);
					return undefined;
				});
			const commit = async (rev: string, field: "revision" | "from" | "to") => {
				const text = await git(worktree.root,
					["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`], context, { accepted: [0, 1] });
				const oid = text.trim();
				if (!objectId.test(oid)) problems.push(
					`${field}: ${JSON.stringify(rev)} names no commit in this repository, so use a revision that resolves to a commit.`,
				);
				return oid;
			};
			if (args.action === "show" && file === "") {
				problems.push("path: Show needs a file path inside the working tree.");
			}
			const revisions = args.action === "compare"
				? [await commit(args.from, "from"), await commit(args.to, "to")]
				: args.action === "history" || args.action === "show"
				? [await commit(args.revision ?? "HEAD", "revision")]
				: [];
			if (problems.length) throw toolRefusal("explore", args, problems);
			const paths = ["--", ...(file ? [file] : [])];
			const run = (command: string[], accepted = [0]) =>
				git(worktree.root, command, context, { accepted, output: api.output });
			const noDrivers = ["--no-ext-diff", "--no-textconv"];
			switch (args.action) {
				case "list":
					await run(["ls-files", "--cached", "--others", "--exclude-standard", ...paths]);
					break;
				case "search":
					await run(["grep", "--cached", "--no-recurse-submodules", "--no-textconv", "-F", "-n", "-e", args.pattern, ...paths], [0, 1]);
					break;
				case "history":
					await run(["log", ...noDrivers, "--no-patch", "--no-show-signature", "--no-notes", "--no-decorate", "--no-use-mailmap",
						"--format=%h %s", `--max-count=${args.count ?? 20}`,
						"--end-of-options", ...revisions, ...paths]);
					break;
				case "show": {
					const text = await git(worktree.root, [
						"ls-tree", "-z", "--full-tree", "--end-of-options", ...revisions, ...paths,
					], context);
					const oid = /^\d+ blob (\S+)\t/.exec(text)?.[1];
					if (!oid || !objectId.test(oid) || text.indexOf("\0") !== text.length - 1) {
						throw toolRefusal("explore", args, [
							"path: The revision does not have a file at that path, so use a file path that exists at the requested revision.",
						]);
					}
					await run(["cat-file", "blob", "--end-of-options", oid]);
					break;
				}
				case "compare": {
					// Treat each side of a rename separately so an ignored source can't enter the patch.
					const diff = ["diff", ...noDrivers, "--no-renames", "--ignore-submodules=all", "--no-relative", "--no-color"];
					const selection = ["--end-of-options", ...revisions, "--",
						...(file ? [`:(top,literal)${file}`] : [])];
					const names = (await git(worktree.root, [...diff, "--name-only", "-z", ...selection], context))
						.split("\0").filter(Boolean);
					const confinedNames: string[] = [];
					const excluded: string[] = [];
					for (const name of names) {
						const path = await confinedPath(worktree, name, true).catch(() => undefined);
						(path?.name === name ? confinedNames : excluded).push(name);
					}
					for (const name of await ignoredPaths(worktree, confinedNames, context)) excluded.push(name);
					if (excluded.length < names.length) {
						await run([...diff, ...selection, ...excluded.map(name => `:(top,literal,exclude)${name}`)]);
					}
					if (excluded.length) api.output("\nSome changed paths are unavailable in plan mode.\n");
					break;
				}
			}
			return {};
		},
	})],
});
