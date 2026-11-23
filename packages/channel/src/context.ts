import { isAbsolute, join, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { PromptSection } from "@earendil-works/pi-durable";
import { getOrThrow, type ExecutionEnv, type FileError } from "@earendil-works/pi-durable/env";

/** Instruction files at the checkout root, in the order agents conventionally read them. */
const INSTRUCTIONS = ["AGENTS.md", "CLAUDE.md"];
const RULES = ".claude/rules";
const LIMIT = 32_000;
// Claude Code caps each skill description.
const SKILL_DESCRIPTION_LIMIT = 1_536;
// Codex uses this budget when the context window is unknown.
const SKILL_LIST_LIMIT = 8_000;
const SKILL_HEADING = "Skills in this repository and the user's skill folders. Read a skill's file before doing work it describes:";
const SKILL_NOTICE = "Some descriptions were shortened or left out to fit; read a skill's file for its full description.";

/**
 * Only a missing file means "none". Any other failure, such as an unreachable workspace, throws, so
 * pi keeps the instructions it last showed and reports why instead of dropping them.
 */
function absent(error: FileError): undefined {
	if (!["not_found", "not_directory", "is_directory"].includes(error.code)) throw error;
}

async function read(
	env: ExecutionEnv,
	path: string,
	context: Context,
): Promise<string | undefined> {
	const result = await env.readTextFile(path, context);
	if (!result.ok) return absent(result.error);
	const text = result.value.trim();
	return text.length > LIMIT
		? `${text.slice(0, LIMIT)}\n… (truncated; read ${path} for the rest)`
		: text;
}

async function list(env: ExecutionEnv, path: string, context: Context) {
	const result = await env.listDir(path, context);
	if (result.ok) return result.value;
	absent(result.error);
	return [];
}

/** The YAML front matter's flat `key: value` lines, which is all skills and rules use. */
function front(text: string): Record<string, string> {
	const match = /^---\n([\s\S]*?)\n---/.exec(text);
	if (!match) return {};
	const fields: Record<string, string> = {};
	for (const line of match[1]!.split("\n")) {
		const split = line.indexOf(":");
		if (split > 0) {
			fields[line.slice(0, split).trim()] = line.slice(split + 1).trim().replace(/^"|"$/g, "");
		}
	}
	return fields;
}

function byName(a: { name: string }, b: { name: string }): number {
	return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

async function skills(env: ExecutionEnv, context: Context): Promise<string | undefined> {
	const home = getOrThrow(await env.absolutePath("~", context));
	// Keep these skill roots in step with apps/neuve-host/src/plan-git.ts.
	const roots = [
		join(home, ".agents", "skills"),
		resolve(process.env["CLAUDE_CONFIG_DIR"] || join(home, ".claude"), "skills"),
		".agents/skills",
		".claude/skills",
	];
	// User skills win because the user-scope Neuve skill matches the installed command.
	const seen = new Set<string>();
	type SkillEntry = { name: string; label: string; description: string };
	const user: SkillEntry[] = [];
	const repository: SkillEntry[] = [];
	let descriptionCapped = false;
	for (const dir of roots) {
		const entries = isAbsolute(dir) ? user : repository;
		for (const entry of (await list(env, dir, context)).toSorted(byName)) {
			if (entry.kind !== "directory" && entry.kind !== "symlink") continue;
			// Opening this child also skips symlinks whose targets are missing or are files.
			const path = `${dir}/${entry.name}/SKILL.md`;
			const text = await read(env, path, context);
			if (!text) continue;
			const { name: declaredName, description = "" } = front(text);
			const name = declaredName || entry.name;
			if (seen.has(name)) continue;
			seen.add(name);
			const detail = description.slice(0, SKILL_DESCRIPTION_LIMIT);
			descriptionCapped ||= detail.length < description.length;
			entries.push({ name, label: `- ${name} (${path})`, description: detail });
		}
	}
	const entries = [...repository.sort(byName), ...user.sort(byName)];
	if (!entries.length) return;
	const separator = ": ";
	const baseLength = entries.reduce((sum, { label }) => sum + label.length + 1, SKILL_HEADING.length);
	const descriptionLength = entries.reduce((sum, { description }) =>
		sum + (description ? separator.length + description.length : 0), 0);
	const shortened = descriptionCapped || baseLength + descriptionLength > SKILL_LIST_LIMIT;
	// Like Claude Code, keep every name and path even when the bare list exceeds the budget.
	let remaining = SKILL_LIST_LIMIT - baseLength - (shortened ? SKILL_NOTICE.length + 1 : 0);
	const lines = entries.map(({ label, description }) => {
		const detail = description.slice(0, Math.max(0, remaining - separator.length));
		if (!detail) return label;
		remaining -= separator.length + detail.length;
		return `${label}${separator}${detail}`;
	});
	return [SKILL_HEADING, ...lines, ...(shortened ? [SKILL_NOTICE] : [])].join("\n");
}

/** Rule files, nested one directory deep, with the paths each applies to. */
async function rules(env: ExecutionEnv, context: Context): Promise<string[]> {
	const out: string[] = [];
	const visit = async (dir: string, depth: number) => {
		for (const entry of await list(env, dir, context)) {
			const path = `${dir}/${entry.name}`;
			if (entry.kind === "directory" && depth > 0) await visit(path, depth - 1);
			if (entry.kind !== "file" || !entry.name.endsWith(".md")) continue;
			const { paths } = front(await read(env, path, context) ?? "");
			out.push(`- ${path}${paths ? ` (applies to ${paths})` : ""}`);
		}
	};
	await visit(RULES, 1);
	return out.sort();
}

/**
 * The checkout's own instructions, read from the agent's working directory before each request so
 * a lane sees its own edits to them. Unchanged text is not resent, which keeps prompt caches warm.
 */
export const instructions: PromptSection = {
	key: "project-instructions",
	async render({ env }, context) {
		if (!env) return;
		const parts: string[] = [];
		const seen = new Set<string>();
		for (const file of INSTRUCTIONS) {
			const text = await read(env, file, context);
			// CLAUDE.md is often a pointer to AGENTS.md or a copy of it.
			if (!text || seen.has(text) || /^@AGENTS\.md$/.test(text)) continue;
			seen.add(text);
			parts.push(`<file path="${file}">\n${text}\n</file>`);
		}
		const found = await skills(env, context);
		if (found) parts.push(found);
		const applicable = await rules(env, context);
		if (applicable.length) {
			parts.push(
				`Rules in this repository. Read the ones that apply before editing matching files:\n${
					applicable.join("\n")
				}`,
			);
		}
		return parts.length ? parts.join("\n\n") : undefined;
	},
};
