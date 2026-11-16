import { z } from "zod";
import { devNull } from "node:os";

const Message = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("ready") }),
	z.object({ kind: z.literal("change"), file: z.string().nullable() }),
]);

// Bun's macOS fs.watch registrations rebuild one process-wide FSEvents stream. Keep the catalog's
// stream independent of transient Records watchers, which otherwise discard pending catalog events.
const observer = `const { watch } = require("node:fs");
const watcher = watch(process.argv.at(-1), { recursive: true }, (_, file) => process.send({ kind: "change", file }));
watcher.on("error", error => { console.error(error.message); process.exit(1); });
process.on("disconnect", () => { watcher.close(); process.exit(0); });
process.send({ kind: "ready" });`;

/** One stable event source; no credentials, catalog contents or additional watches enter the child. */
export function watchCatalog(
	directory: string,
	changed: (file: string | null) => void,
	failed: (error: Error) => void,
) {
	const ready = Promise.withResolvers<void>();
	void ready.promise.catch(() => {});
	let closed = false;
	let closing: Promise<void> | undefined;
	let child: Bun.Subprocess<"ignore", "ignore", "pipe">;
	try {
		child = Bun.spawn(
			[
				process.execPath,
				"--no-env-file",
				`--config=${devNull}`,
				"--eval",
				observer,
				directory,
			],
			{
				cwd: directory,
				env: { BUN_BE_BUN: "1", TMPDIR: process.env.TMPDIR },
				stdin: "ignore",
				stdout: "ignore",
				stderr: "pipe",
				ipc(message: unknown) {
					if (closed) return;
					const value = Message.safeParse(message);
					if (!value.success)
						return failed(new Error("Invalid catalog watcher message"));
					if (value.data.kind === "ready") ready.resolve();
					else changed(value.data.file);
				},
			},
		);
	} catch (cause) {
		const error = new Error("Catalog watcher could not start", { cause });
		ready.reject(error);
		failed(error);
		return { ready: ready.promise, async close() {} };
	}
	const stderr = new Response(child.stderr).text();
	const exited = child.exited.then(async (code) => {
		const detail = (await stderr).trim();
		if (closed) return;
		const error = new Error(
			`Catalog watcher exited ${code}${detail ? `: ${detail}` : ""}`,
		);
		ready.reject(error);
		failed(error);
	});
	return {
		ready: ready.promise,
		close(): Promise<void> {
			return (closing ??= (async () => {
				closed = true;
				ready.reject(new Error("Catalog watcher closed during startup"));
				child.kill("SIGTERM");
				await exited;
			})());
		},
	};
}
