import { FILING_TIMEOUT_MS, FILING_DRAIN_MS } from "../../../packages/harness/src/pi/capture/filing.ts";
import {runtimeHooks} from "./runtime-hooks";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const closePath = (base: string) => join(base, "worker-close.json");
export function clearClose(base: string): void { rmSync(closePath(base), {force: true}); }
export function recordClose(base: string, errors: readonly unknown[]): void {
	writeFileSync(closePath(base), JSON.stringify({pid: process.pid, ok: !errors.length, errors: errors.map((error) => error instanceof Error ? error.message : String(error))}), {mode: 0o600});
}
const Receipt = z.strictObject({pid: z.int().positive(), ok: z.boolean(), errors: z.array(z.string())});
export function confirmClose(base: string, pid: number): void {
	const receipt = Receipt.parse(JSON.parse(readFileSync(closePath(base), "utf8")));
	if (receipt.pid !== pid || !receipt.ok) throw new Error(`Worker close failed: ${receipt.errors.join("; ") || "worker identity changed"}`);
}

// The filing bound reads no journal or database, so an observation failure cannot skip shutdown.
export const workerCloseTimeout = (_base?: string): number => runtimeHooks().worker?.close
  ? Math.max(runtimeHooks().workerCloseTimeoutMs ?? 10_000, FILING_TIMEOUT_MS + FILING_DRAIN_MS)
  : runtimeHooks().workerCloseTimeoutMs ?? 10_000;
