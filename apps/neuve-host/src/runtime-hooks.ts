import type { WorkerSetup } from "./worker-runtime";
import type { HostOptions } from "./host";

export type RuntimeHooks = {
	/** The configured worker implements Neuve's channel provenance extension. */
	channelProvenance?: boolean;
	workerCloseTimeoutMs?: number;
	nativeSources?: import("./native-source-lifecycle").NativeSources;
	worker?: WorkerSetup;
	modelAvailability?(): readonly import("@ace/channel/protocol").ModelRef[];
	lanes?(id: string): string;
	host?: HostOptions;
	checkAccounts?(): Promise<void>;
	listening?(port: number): void;
	command?(args: readonly string[]): Promise<number | undefined>;
	onFork?(source: string, fork: string): Promise<void>;
	forkLane?(project: string, branch: string, base: string, id: string, lane: string): Promise<string>;
};
let hooks: Readonly<RuntimeHooks> = Object.freeze({});
export function configureRuntime(value: RuntimeHooks): void { hooks = Object.freeze({...hooks, ...value}); }
export function runtimeHooks(): Readonly<RuntimeHooks> { return hooks; }
