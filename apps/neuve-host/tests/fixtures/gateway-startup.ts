import "./memory-secrets";
import { mock } from "bun:test";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.ACE_HOME!;
const mode = process.argv[2]!;
let writes = 0;
// Write beside the marker and rename over it, so the test sees no marker or a whole one, never an empty file.
const mark = (name: string, value = "ready") => {
	const temporary = join(root, `.${name}.${process.pid}.${++writes}.tmp`);
	writeFileSync(temporary, value);
	renameSync(temporary, join(root, name));
};
async function wait(name: string) {
	while (!existsSync(join(root, name))) await Bun.sleep(10);
}
const machine = {name: "fixture", dns: "fixture.test", address: "::1", login: "owner"};
let moved: ((tailnet: string) => void) | undefined;
mock.module("../../src/tailnet", () => ({
	identity: () => ({login: "owner", tailnet: "fixture.test"}),
	self: async () => {
		mark("lookup");
		if (mode.startsWith("stop")) {
			if (mode === "stop-managed") {
				await wait("stop");
				moved?.("other.test");
			}
			await wait("release-lookup");
			return undefined;
		}
		return machine;
	},
	watch: (_: unknown, callback: (tailnet: string) => void) => {moved = callback; return () => mark("tailnet-stopped");},
	whois: async () => ({login: "owner", host: "fixture"}),
	peers: async () => [],
	certificate: async () => ({cert: join(root, "cert.pem"), key: join(root, "key.pem")}),
}));
const github = await import("../../src/github");
mock.module("../../src/github", () => ({...github, login: () => undefined}));
const directory = await import("../../src/directory");
const directoryWatch = directory.watch;
mock.module("../../src/directory", () => ({...directory,
	watch: (...args: Parameters<typeof directoryWatch>) => {
		mark("directory-started");
		const watcher = directoryWatch(...args);
		return {...watcher, stop: () => {watcher.stop(); mark("directory-stopped");}};
	},
}));
const lobby = await import("../../src/lobby");
const lobbyWatch = lobby.watch;
mock.module("../../src/lobby", () => ({...lobby,
	watch: (...args: Parameters<typeof lobbyWatch>) => {
		mark("lobby-started");
		const stop = lobbyWatch(...args);
		return () => {stop(); mark("lobby-stopped");};
	},
}));
const peers = await import("../../src/peers");
const peersWatch = peers.watch;
mock.module("../../src/peers", () => ({...peers,
	watch: (...args: Parameters<typeof peersWatch>) => {
		mark("peers-started");
		const stop = peersWatch(...args);
		return () => {stop(); mark("peers-stopped");};
	},
}));
if (mode.startsWith("stop")) {
	const shutdown = await import("../../src/shutdown");
	mock.module("../../src/shutdown", () => ({...shutdown, shutdown: async () => {
		mark("cleanup-started");
		await wait("release-cleanup");
		mark("cleanup-done");
	}}));
}
const {config} = await import("../../src/config");
config.helper = true;
config.app = root;
if (mode === "tls-high" || mode === "tls-collision") {
	const {workspaceConfiguration} = await import("../../../neuve-cli/src/workspace-runtime");
	const {PI_TRANSITION_STORAGE_PROFILE} = await import("../../../../scripts/pi-storage");
	const {SOL_ROUTE} = await import("../../../../packages/harness/src/route");
	const profile = {...PI_TRANSITION_STORAGE_PROFILE, paths: {...PI_TRANSITION_STORAGE_PROFILE.paths,
		state: join(root, "state"), captures: join(root, "captures"), worktrees: join(root, "worktrees"), canonicalClone: root,
	}};
	const configuration = workspaceConfiguration({
		profile, source: root, user: "owner", port: 0, route: SOL_ROUTE, environment: {},
		storage: {paths: profile.paths, volume: {mountPoint: root, volumeUuid: "fixture", device: 0}, gitCommonDir: root, environment: {
			TMPDIR: root, TMP: root, TEMP: root, BUN_TMPDIR: root, GOTMPDIR: root, BUN_INSTALL_CACHE_DIR: root,
			BUN_RUNTIME_TRANSPILER_CACHE_PATH: root, XDG_CACHE_HOME: root, GOCACHE: root, GOMODCACHE: root, npm_config_cache: root,
		}},
	});
	config.webPort = configuration.webPort;
	mark("workspace-web-port", String(configuration.webPort));
}
const catalog = await import("../../src/catalog");
catalog.bind({home: root, user: "owner", local: false});
const {configureRuntime} = await import("../../src/runtime-hooks");
configureRuntime({listening: (port) => mark("owner-port", String(port))});
if (mode === "desktop-help") {
	const entry = process.argv[3]!;
	process.argv = [process.execPath, entry, "--help"];
	await import(entry);
	process.exit(0);
}
const gateway = await import("../../src/gateway");
try {
	if (mode.startsWith("stop")) {
		if (mode === "stop-managed") await gateway.start(0, false, undefined, true);
		else await gateway.serve(0);
		throw new Error("Stopped startup unexpectedly completed");
	}
	const started = await gateway.start(Number(process.argv[3] ?? 0), false, undefined, true);
	const web = await import("../../src/web");
	mark("ready", JSON.stringify({address: web.address, ownerPort: started.server.port}));
	await wait("finish");
	await started.stop();
	mark("done");
} catch (error) {
	mark("error", String(error));
	if (mode === "stop-managed" && String(error).includes("Host closed during startup")) {
		mark("managed-rejected-after-cleanup", String(existsSync(join(root, "cleanup-done"))));
	} else {
		console.error(error);
		process.exit(1);
	}
}
