import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

import { z } from "zod";

import { ModelRefSchema } from "@ace/channel/parse";

/** An absolute directory that already exists, by its real path; nothing is created here. */
const directory = (name: string) =>
	z.string().refine(isAbsolute, `The host's ${name} must be an absolute path`).transform(
		(value, context) => {
			try {
				const real = realpathSync(value);
				if (statSync(real).isDirectory()) return real;
				context.issues.push({ code: "custom", message: `${value} is not a directory`, input: value });
			} catch {
				context.issues.push({ code: "custom", message: `${value} does not exist`, input: value });
			}
			return z.NEVER;
		},
	);

export function inside(path: string, dir: string): boolean {
	return path === dir || path.startsWith(`${dir}/`);
}

/**
 * Git's repository-local variables, as `git rev-parse --local-env-vars` lists them (Git 2.54). A
 * host started from a Git hook inherits them, and they would point every Git command, tool, and
 * terminal at the hook's repository and index instead of the project or lane each one names.
 */
export const GIT_LOCAL: ReadonlySet<string> = new Set([
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_CONFIG",
	"GIT_CONFIG_PARAMETERS",
	"GIT_CONFIG_COUNT",
	"GIT_OBJECT_DIRECTORY",
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_IMPLICIT_WORK_TREE",
	"GIT_GRAFT_FILE",
	"GIT_INDEX_FILE",
	"GIT_NO_REPLACE_OBJECTS",
	"GIT_REPLACE_REF_BASE",
	"GIT_PREFIX",
	"GIT_SHALLOW_FILE",
	"GIT_COMMON_DIR",
]);

/**
 * What a host and its channel workers run with. Every path comes from the validated storage
 * profile (scripts/pi-storage.ts); the host has no default location and creates neither root.
 */
export const HostConfigSchema = z.strictObject({
	/** Captured by the launcher and carried unchanged into workers. */
	build: z.strictObject({ version: z.string().optional(), commit: z.string().optional() }).optional(),
	/** Existing directory on the validated state volume: catalog, channel stores, logs, token. */
	home: directory("home"),
	app: directory("app").optional(),
	channelScope: z.enum(["local", "tailnet"]).default("local"),
	/** The already validated storage-profile volume; project admission cannot cross it. */
	volume: directory("volume").optional(),
	/** Default clone destination parent from the validated storage profile. */
	projects: directory("projects").optional(),
	/** Existing directory under the validated worktrees root: `<lanes>/<channel id>/<lane>`. */
	lanes: directory("lanes"),
	/** The owner's author name, which every request the host relays is stamped with. */
	user: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._@-]*$/).refine(
		(user) => !user.startsWith("agent@"),
		"The host's user can't be an agent's author name",
	),
	/** Loopback port for the gateway; 0 picks a free one. */
	port: z.int().min(0).max(65_535),
	/** HTTPS port for the tailnet; 0 selects a free listener independently. */
	webPort: z.int().min(0).max(65_535).optional(),
	/**
	 * The complete environment for workers, terminals, and Git: `spawnEnvironment(storage, env)`,
	 * without Git's repository-local variables.
	 */
	environment: z.record(z.string(), z.string()).transform((environment) =>
		Object.fromEntries(Object.entries(environment).filter(([name]) => !GIT_LOCAL.has(name)))
	),
	/** The command that runs `runWorker`; the channel ID is appended. */
	worker: z.tuple([z.string().min(1)], z.string().min(1)),
	/** What a chat without a model runs, ahead of the provider's preference. */
	model: ModelRefSchema.optional(),
	thinkingLevel: z.enum(["low", "medium", "high"]).optional(),
	/** The skills the `neuve` command carries, listed to agents after every installed skill. */
	skills: directory("skills").optional(),
	/** Native close, including any injected finalization, before the host reports failure. */
	workerCloseTimeoutMs: z.int().positive().default(10_000),
}).refine(
	({ home, lanes }) => !inside(lanes, home) && !inside(home, lanes),
	"The host's home and lanes directories must be separate",
);

export type HostConfig = z.output<typeof HostConfigSchema>;

/** The variable a host passes its configuration to channel workers in; it holds no secrets. */
export const CONFIG_VARIABLE = "NEUVE_HOST_CONFIG";

/** Set once per process, by `startHost` or `runWorker`, before any module reads it. */
export const config = {} as HostConfig;
import { config as ace } from "./config";
const originalApp = ace.app;
const originalWebPort = ace.webPort;
import { configureRuntime } from "./runtime-hooks";
import { join } from "node:path";

/** Parses a host configuration at its boundary, the root entry or a worker's environment. */
export function configure(value: unknown): HostConfig {
	const parsed = HostConfigSchema.safeParse(value);
	if (!parsed.success) throw new Error(`Invalid host configuration\n${z.prettifyError(parsed.error)}`);
	for (const key of Object.keys(config)) Reflect.deleteProperty(config, key);
	configureRuntime({lanes: (id) => join(parsed.data.lanes, id), workerCloseTimeoutMs: parsed.data.workerCloseTimeoutMs});
	Object.assign(ace, { app: parsed.data.app || originalApp, settings: parsed.data.environment.ACE_CONFIG_HOME || join(parsed.data.home, "settings"), keychain: parsed.data.environment.ACE_KEYCHAIN_SERVICE || `neuve-${parsed.data.home}`, home: parsed.data.home, user: parsed.data.user, port: parsed.data.port, webPort: parsed.data.webPort ?? originalWebPort, worker: parsed.data.worker });
	for (const name of GIT_LOCAL) delete process.env[name];
	process.env[CONFIG_VARIABLE] = JSON.stringify({...parsed.data, environment: publicEnvironment(parsed.data.environment)});
	process.env.ACE_HOME = parsed.data.home;
	process.env.ACE_CONFIG_HOME = ace.settings;
	process.env.ACE_KEYCHAIN_SERVICE = ace.keychain;
	process.env.ACE_USER = parsed.data.user;
	process.env.ACE_PORT = String(parsed.data.port);
	return Object.assign(config, {...parsed.data, environment: publicEnvironment(parsed.data.environment)});
}

const SECRET_NAME = /(_KEY|_TOKEN|_SECRET|_PASSWORD|_CREDENTIALS?)$/;
function publicEnvironment(environment: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.entries(environment).filter(([name]) => !SECRET_NAME.test(name) && name !== CONFIG_VARIABLE));
}

/** A validated managed entry joins the same catalog scope before the original CLI executes. */
export async function bindConfiguredCatalog(options?: {scope: "automatic"}): Promise<void> {
	configureRuntime({
		modelAvailability: () => config.model ? [config.model] : [],
		onFork: async (source, child) => (await import("./fork-origin")).forkOrigin(source, child),
		forkLane: async (...args) => (await import("./fork-origin")).forkLane(...args),
	});
	const catalog = await import("./catalog");
	if (options?.scope === "automatic") {
		config.channelScope = catalog.tailnet ? "tailnet" : "local";
		process.env[CONFIG_VARIABLE] = JSON.stringify(config);
	}
	catalog.bind({home: config.home, user: config.user, local: config.channelScope === "local"});
}
