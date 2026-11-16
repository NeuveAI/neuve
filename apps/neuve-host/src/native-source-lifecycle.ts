import {createHash} from "node:crypto";
import {createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import * as catalog from "./catalog";
import {Connection} from "./client";
import {runtimeHooks} from "./runtime-hooks";
import {NativeAuthorityReceiptSchema, type NativeAuthorityReceipt} from "./native-source-protocol";

export type NativeSourceOrigin =
	| {kind: "seed"; file: string; sha256: string}
	| {kind: "backup"; nativeSha256: string; receipt?: NativeAuthorityReceipt};
export type NativeSourceInput = {channel: string; stateDirectory: string; nativeDatabase: string; origin: NativeSourceOrigin};
export type NativeSourceLease = {
	close(): void | Promise<void>;
};
export type NativeSources = {prepare(input: NativeSourceInput): Promise<NativeSourceLease>};
const active = new Map<string, {lease: NativeSourceLease; open: number; input: NativeSourceInput}>();
const RECEIPT = "native-authority.json";

export async function nativeSourceChecksum(path: string): Promise<string> {
	const digest = createHash("sha256");
	for await (const chunk of createReadStream(path)) digest.update(chunk);
	return digest.digest("hex");
}

export async function checkpointNativeBackup(record: catalog.Listing, directory: string): Promise<string | undefined> {
	if (!runtimeHooks().nativeSources || record.hosted) return;
	const nativeDatabase = join(directory, "channel.sqlite");
	if (!existsSync(nativeDatabase)) return;
	const nativeSha256 = await nativeSourceChecksum(nativeDatabase);
	const connection = await Connection.open(record.id);
	try {
		const receipt = NativeAuthorityReceiptSchema.parse(await connection.request({op: "native-source-checkpoint", nativeDatabase, nativeSha256}));
		if (receipt.nativeSha256 !== nativeSha256) throw new Error("Native authority checkpoint does not match the frozen backup");
		writeFileSync(join(directory, RECEIPT), `${JSON.stringify(receipt)}\n`, {mode: 0o600, flag: "wx"});
		return RECEIPT;
	} finally { connection.close(); }
}

export async function prepareNativeSource(record: catalog.Listing, origin: NativeSourceOrigin): Promise<() => Promise<void>> {
	const hooks = runtimeHooks().nativeSources;
	if (!hooks) return async () => {};
	if (active.has(record.id)) throw new Error("Native source creation is already active");
	const paths = catalog.paths(record.id);
	mkdirSync(paths.base, {recursive: true, mode: 0o700});
	const input = {channel: record.id, stateDirectory: paths.base, nativeDatabase: paths.storage, origin};
	const state = {lease: await hooks.prepare(input), open: 0, input};
	active.set(record.id, state);
	let closed = false;
	return async () => {
		if (closed) return;
		if (state.open) throw new Error("Native source creation still owns unclosed storage");
		await state.lease.close();
		closed = true;
		active.delete(record.id);
	};
}

export async function prepareNativeRestore(record: catalog.Listing, directory: string): Promise<() => Promise<void>> {
	if (!runtimeHooks().nativeSources) return async () => {};
	const native = ["channel.sqlite", "snapshot.json", "channel.json"].map((name) => join(directory, name)).find(existsSync)!;
	const receiptPath = join(directory, RECEIPT);
	const receipt = existsSync(receiptPath) ? NativeAuthorityReceiptSchema.parse(JSON.parse(readFileSync(receiptPath, "utf8"))) : undefined;
	const nativeSha256 = await nativeSourceChecksum(native);
	if (receipt && receipt.nativeSha256 !== nativeSha256) throw new Error("Native authority checkpoint does not match the restored backup");
	return prepareNativeSource(record, {kind: "backup", nativeSha256, ...(receipt ? {receipt} : {})});
}

export async function verifyNativeRestore(id: string): Promise<void> {
	const input = active.get(id)?.input;
	if (input?.origin.kind === "backup" && input.origin.receipt && await nativeSourceChecksum(input.nativeDatabase) !== input.origin.nativeSha256)
		throw new Error("Restored native bytes changed after authority adoption");
}

export function assertNativeSourceClosed(id: string): void {
	if (active.get(id)?.open) throw new Error("Native source creation still owns unclosed storage");
}

/** Keep ownership after uncertain opens or closes; only confirmed raw closes release the lease. */
export async function nativeSourceStorage<T extends object>(id: string, open: () => Promise<T>): Promise<T> {
	const state = active.get(id);
	if (!state) return open();
	state.open++;
	const storage = await open();
	let closing: Promise<void> | undefined;
	return new Proxy(storage, {get(target, property) {
		const value: unknown = Reflect.get(target, property);
		if (property === "close" && typeof value === "function") return (...args: unknown[]) => closing ??= (async () => {
			await Reflect.apply(value, target, args);
			state.open--;
		})();
		return typeof value === "function" ? value.bind(target) : value;
	}});
}
