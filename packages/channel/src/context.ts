import { join } from "node:path";
import { findSkills, skillRoots } from "@neuve/runtime/skills";
import type { Models } from "@earendil-works/pi-ai";
import type { Context } from "@earendil-works/chord";
import type { PromptSection } from "@earendil-works/pi-durable";
import { getOrThrow, type ExecutionEnv, type FileError } from "@earendil-works/pi-durable/env";

/** Instruction files at the checkout root, in the order agents conventionally read them. */
const INSTRUCTIONS = ["AGENTS.md", "CLAUDE.md"];
const RULES = ".claude/rules";
const LIMIT = 32_000;
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

const escapeXml = (text: string) =>
	text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

async function skills(env: ExecutionEnv, context: Context, carried?: string) {
	const home = getOrThrow(await env.absolutePath("~", context));
	const found = await findSkills(skillRoots({ home, cwd: env.cwd, carried }), {
		async list(path) {
			return (await list(env, path, context))
				.filter(entry => entry.kind === "directory" || entry.kind === "symlink")
				.map(entry => entry.name);
		},
		async read(path) {
			const result = await env.readTextFile(path, context);
			return result.ok ? result.value : absent(result.error);
		},
	});
	if (!found.length) return;
	return [
		"Read the skill file when its description applies to the task.",
		"<available_skills>",
		...found.map(({ folder, name, description }) =>
			`<skill><name>${name}</name><description>${escapeXml(description.replace(/\s+/g, " "))}</description><location>${escapeXml(join(folder, "SKILL.md"))}</location></skill>`),
		"</available_skills>",
	].join("\n");
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
export const instructions = (models: Models, carried?: string): PromptSection => ({
	key: "project-instructions",
	async render({ agent, env }, context) {
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
		const model = agent.model && models.getModel(agent.model.provider, agent.model.modelId);
		if (model?.api !== "neuve-runtime") {
			const found = await skills(env, context, carried);
			if (found) parts.push(found);
		}
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
