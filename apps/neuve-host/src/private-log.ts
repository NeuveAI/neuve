import { createHash } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	renameSync,
	statSync,
} from "node:fs";
import { join } from "node:path";

import { failure, type Fields, type Level, type Log } from "@ace/channel";

import { config } from "./host-config";

export { failure };

const LIMIT = 10 * 1024 * 1024;
const KEEP = 4;

let file: string | undefined;
let base: Fields = {};
let size = 0;

/** Older files shift up one; `name.jsonl` is always the newest. */
function rotate(path: string) {
	for (let n = KEEP - 1; n >= 1; n--) {
		const from = n === 1 ? path : path.replace(/\.jsonl$/, `.${n - 1}.jsonl`);
		if (existsSync(from)) {
			chmodSync(from, 0o600);
			renameSync(from, path.replace(/\.jsonl$/, `.${n}.jsonl`));
		}
	}
	size = 0;
}

/**
 * Names this process's log file, `<home>/logs/<name>.jsonl`, and the fields on every line. Each
 * process owns its own file, so lines never interleave mid-record and rotation needs no lock.
 */
export function open(name: string, fields: Fields = {}): void {
	const dir = join(config.home, "logs");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	file = join(dir, `${name}.jsonl`);
	for (let n = 0; n < KEEP; n++) {
		const path = n === 0 ? file : file.replace(/\.jsonl$/, `.${n}.jsonl`);
		if (existsSync(path)) chmodSync(path, 0o600);
	}
	size = existsSync(file) ? statSync(file).size : 0;
	base = { proc: name, pid: process.pid, ...fields };
	// Lines written right before a crash are the ones that explain it, so writes are synchronous.
	process.on("uncaughtException", (error) => {
		log("error", "process.uncaught", failure(error));
		process.exit(1);
	});
	process.on("unhandledRejection", (error) =>
		log("error", "process.unhandled", failure(error)),
	);
	process.on("exit", (code) =>
		log(code ? "error" : "debug", "process.exit", { code }),
	);
}

export const log: Log = (level: Level, event: string, fields?: Fields) => {
	if (!file || (level === "debug" && !config.environment.NEUVE_HOST_DEBUG))
		return;
	const line = `${JSON.stringify({
		t: new Date().toISOString(),
		level,
		event,
		...diagnostics({ ...base, ...fields }),
	})}\n`;
	if (size + line.length > LIMIT) rotate(file);
	appendFileSync(file, line, { mode: 0o600 });
	size += line.length;
};

const metrics = new Set([
	"pid",
	"port",
	"chat",
	"task",
	"submission",
	"created",
	"messages",
	"ms",
	"error",
	"failed",
	"kill",
	"clients",
	"code",
	"input",
	"output",
	"cacheRead",
	"cacheWrite",
	"cacheWrite1h",
	"reasoning",
	"totalTokens",
	"total",
]);
const identifiers = new Set([
	"proc",
	"channel",
	"call",
	"trace",
	"author",
	"requestId",
	"provider",
	"model",
	"modelId",
	"name",
	"project",
	"url",
	"user",
	"bun",
	"terminal",
	"cwd",
	"path",
	"cycle",
	"batch",
	"error",
	"stack",
	"code",
]);
const kinds = new Map<string, readonly string[]>(
	Object.entries({
		op: [
			"create",
			"list",
			"close",
			"delete",
			"channel",
			"terminal",
			"review",
			"info",
			"models",
			"say",
			"ask",
			"select",
			"chat",
			"watch",
			"plan",
			"plan-approve",
			"approval-answer",
			"changes",
			"patch",
			"stop",
			"fetch",
			"rename",
			"remove",
		],
		tool: [
			"bash",
			"read",
			"write",
			"plan_write",
			"edit",
			"grep",
			"find",
			"ls",
			"lane",
			"subagent",
			"browser_tabs",
			"browser_inspect",
			"browser_navigate",
		],
		stop: [
			"pending",
			"stop",
			"length",
			"toolUse",
			"error",
			"aborted",
			"deferred",
		],
		reason: ["idle", "close", "shutdown", "signal"],
	}),
);

/** Operational records retain correlation hashes and metrics, never session or error payloads. */
function diagnostics(fields: Fields): Fields {
	const kept: Fields = {};
	for (const [key, value] of Object.entries(fields)) {
		const kind = kinds.get(key);
		if (
			metrics.has(key) &&
			(typeof value === "number" || typeof value === "boolean")
		) {
			kept[key] = value;
		} else if (typeof value === "string" && (identifiers.has(key) || kind)) {
			if (kind?.includes(value)) kept[key] = value;
			else
				kept[`${key}Hash`] = createHash("sha256").update(value).digest("hex");
		} else if (
			["usage", "cost", "model", "cause"].includes(key) &&
			value &&
			typeof value === "object" &&
			!Array.isArray(value)
		) {
			kept[key] = diagnostics(Object.fromEntries(Object.entries(value)));
		} else if (key === "chats" && Array.isArray(value)) {
			kept[key] = value.filter((id) => typeof id === "number");
		}
	}
	return kept;
}
