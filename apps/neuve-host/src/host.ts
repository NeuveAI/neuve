import {existsSync, statSync} from "node:fs";
import { join } from "node:path";
import type { ModelOption } from "@ace/channel";
import type { PlanningConnections } from "@ace/channel/planning";
import type { NativeReviewCallbacks, ReviewHistoryQuery, ReviewReceipt } from "./extension-protocol";
import type { Review } from "./review";
import { config, configure } from "./host-config";
import { acquireHome } from "./ownership";
import { configureRuntime } from "./runtime-hooks";
import { migrateLegacyChannels } from "./legacy-channels";

export type HostOptions = NativeReviewCallbacks & {
	config: unknown;
	models(): ModelOption[];
	review?: Review;
	reviewLink?(project: string, reference: string): Promise<string>;
	planningConnections?(): PlanningConnections;
	reviewHistory?(query: ReviewHistoryQuery): Promise<ReviewReceipt[]>;
	loopback?: boolean;
};
export type Host = { url: string; port: number; token: string; close(): Promise<void> };

/** Configuration and ownership precede imports that initialize the native catalog. */
export async function startHost(options: HostOptions): Promise<Host> {
	configure(options.config);

	const release = acquireHome(config.home);
	configureRuntime({host: options, modelAvailability: options.models,
		onFork: async (source, child) => (await import("./fork-origin")).forkOrigin(source, child),
		forkLane: async (...args) => (await import("./fork-origin")).forkLane(...args),
		listening(port) {
		config.port = port;
		process.env.NEUVE_HOST_CONFIG = JSON.stringify(config);
	}});
	let served: import("./gateway").Gateway | undefined;
	let closed: Promise<void> | undefined;
	let entered = false;
	const close = () => closed ??= (async () => {
		if (served) await served.stop();
		else {
			const {shutdown} = await import("./shutdown");
			const terminals = await import("./terminals");
			const results = await Promise.allSettled([shutdown(), terminals.closeAll()]);
			const errors = results.filter((result) => result.status === "rejected");
			if (errors.length) throw new AggregateError(errors.map((result) => result.reason), "Host cleanup failed");
		}
		release();
	})();
	try {
		const channels = join(config.home, "channels");
		if (existsSync(channels) && !statSync(channels).isDirectory()) throw new Error("The channel catalog must be a directory");
		migrateLegacyChannels(config.home);
		const catalog = await import("./catalog");
		config.channelScope = options.loopback || !catalog.tailnet ? "local" : "tailnet";
		process.env.NEUVE_HOST_CONFIG = JSON.stringify(config);
		catalog.bind({home: config.home, user: config.user, local: config.channelScope === "local"});
		const gateway = await import("./gateway");
		entered = true;
		served = await gateway.start(config.port, options.loopback ?? false, undefined, true);
		const port = served.server.port!;
		config.port = port;
		process.env.NEUVE_HOST_CONFIG = JSON.stringify(config);
		await Bun.write(join(config.home, "host.port"), String(port));
		return {url: `ws://127.0.0.1:${port}/ws`, port, token: (await import("./auth")).token(), close};
	} catch (error) {
		try { if (entered) await close(); else release(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Host startup and cleanup failed"); }
		throw error;
	}
}
