import { isAbsolute, join, relative, resolve, sep } from "node:path";
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
const SKILL_HEADING = "Skills by folder. Read the skill file before use. Use the first name on each line.";
const SKILL_NOTICE = "Some descriptions were shortened to fit; read a skill's file for its full description.";
const SKILL_SEPARATOR = ": ";

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

/** Read top-level front matter fields and fold block values into a single line. */
function front(text: string): Record<string, string> {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (!match) return {};
	const fields: Record<string, string> = {};
	const lines = match[1]!.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const split = line.indexOf(":");
		if (split <= 0 || /^\s/.test(line)) continue;
		const key = line.slice(0, split).trim();
		const value = line.slice(split + 1).trim();
		if (!/^[>|][+-]?$/.test(value)) {
			fields[key] = value.replace(/^"|"$/g, "");
			continue;
		}
		const block: string[] = [];
		while (i + 1 < lines.length) {
			const next = lines[i + 1]!;
			const start = next.search(/\S/);
			if (start === 0) break;
			i++;
			if (start >= 0) block.push(next.trim());
		}
		fields[key] = block.join(" ");
	}
	return fields;
}

function compareNames(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function shareDescriptions(descriptions: string[], remaining: number): string[] {
	const suffixes = descriptions.map(() => "");
	const shortestFirst = descriptions.map((text, index) => ({ text, index }))
		.filter(({ text }) => text.length > 0)
		.sort((a, b) => a.text.length - b.text.length);
	for (const [placed, { text, index }] of shortestFirst.entries()) {
		const share = Math.floor(remaining / (shortestFirst.length - placed)) - SKILL_SEPARATOR.length;
		const length = Math.min(text.length, share);
		if (length < 1 || (length === 1 && text.length > length)) continue;
		let detail = text;
		if (length < text.length) {
			const prefix = text.slice(0, length - 1);
			const boundary = text.slice(0, length).search(/\s+\S*$/);
			const excerpt = (boundary >= prefix.length * 0.8 ? prefix.slice(0, boundary) : prefix).trimEnd();
			if (!excerpt) continue;
			detail = `${excerpt}…`;
		}
		suffixes[index] = `${SKILL_SEPARATOR}${detail}`;
		remaining -= SKILL_SEPARATOR.length + detail.length;
	}
	return suffixes;
}

/** The person's skill folders. Plan mode allows reads in these too, and in the host's carried folder. */
export function userSkillRoots(home: string): string[] {
	return [
		join(home, ".agents", "skills"),
		resolve(process.env["CLAUDE_CONFIG_DIR"] || join(home, ".claude"), "skills"),
	];
}

/** `carried` is a folder of skills the host carries, such as the `neuve` command's own Neuve skill. */
async function skills(env: ExecutionEnv, context: Context, carried?: string): Promise<string | undefined> {
	const home = getOrThrow(await env.absolutePath("~", context));
	const userRoots = userSkillRoots(home);
	const repoRoots = [".agents/skills", ".claude/skills"];
	const carriedRoots = carried ? [carried] : [];
	// User skills win because the user-scope Neuve skill matches the installed command; a carried
	// skill comes last, so any installed copy wins over it.
	const seen = new Set<string>();
	type SkillEntry = { name: string; label: string; description: string };
	const groups = new Map([...repoRoots, ...userRoots, ...carriedRoots].map(dir => [dir, new Array<SkillEntry>()]));
	let descriptionCapped = false;
	for (const dir of [...userRoots, ...repoRoots, ...carriedRoots]) {
		const entries = groups.get(dir)!;
		for (const entry of (await list(env, dir, context)).toSorted((a, b) => compareNames(a.name, b.name))) {
			if (entry.kind !== "directory" && entry.kind !== "symlink") continue;
			// Opening this child also skips symlinks whose targets are missing or are files.
			const path = `${dir}/${entry.name}/SKILL.md`;
			const text = await read(env, path, context);
			if (!text) continue;
			const { name: declaredName, description = "", "disable-model-invocation": disabled = "" } = front(text);
			const name = declaredName || entry.name;
			if (seen.has(name)) continue;
			seen.add(name);
			if (/^(?:true|yes|on|1)$/i.test(disabled)) continue;
			const detail = description.slice(0, SKILL_DESCRIPTION_LIMIT);
			descriptionCapped ||= detail.length < description.length;
			const label = name === entry.name ? entry.name : `${entry.name} (${name})`;
			entries.push({ name, label: `- ${label}`, description: detail });
		}
	}
	const byDisplayName = (a: SkillEntry, b: SkillEntry) =>
		compareNames(a.name.toLowerCase(), b.name.toLowerCase()) || compareNames(a.name, b.name);
	const lines = [SKILL_HEADING];
	const slots: number[] = [];
	const repository: string[] = [];
	const user: string[] = [];
	for (const [dir, entries] of groups) {
		if (!entries.length) continue;
		const personal = isAbsolute(dir);
		const fromHome = personal ? relative(home, dir) : "";
		const display = personal && !isAbsolute(fromHome) && fromHome !== ".." && !fromHome.startsWith(`..${sep}`)
			? `~/${fromHome.split(sep).join("/")}` : dir;
		lines.push(`Folder: ${display} (skill file: <folder>/<name>/SKILL.md)`);
		const descriptions = personal ? user : repository;
		for (const entry of entries.sort(byDisplayName)) {
			descriptions.push(entry.description);
			slots.push(lines.length);
			lines.push(entry.label);
		}
	}
	if (!slots.length) return;
	const suffix = (description: string) => description ? `${SKILL_SEPARATOR}${description}` : "";
	const repoSuffixes = repository.map(suffix);
	const repoLength = repoSuffixes.join("").length;
	const baseLength = lines.join("\n").length;
	const shortened = descriptionCapped || baseLength + repoLength + user.map(suffix).join("").length > SKILL_LIST_LIMIT;
	// Like Claude Code, keep every name and path even when the bare list exceeds the budget.
	const room = SKILL_LIST_LIMIT - baseLength - (shortened ? SKILL_NOTICE.length + 1 : 0);
	const suffixes = repoLength <= room
		? [...repoSuffixes, ...shareDescriptions(user, room - repoLength)]
		: shareDescriptions(repository, room);
	for (const [index, detail] of suffixes.entries()) lines[slots[index]!] += detail;
	if (shortened) lines.push(SKILL_NOTICE);
	return lines.join("\n");
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
export const instructions = (carried?: string): PromptSection => ({
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
		const found = await skills(env, context, carried);
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
});
