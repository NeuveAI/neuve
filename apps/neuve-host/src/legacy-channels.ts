import {existsSync, lstatSync, readdirSync, readFileSync, renameSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {z} from "zod";

/** Only Neuve's owned startup adopts the untagged catalog its earlier versions exposed. */
export function migrateLegacyChannels(home: string): void {
	const root = join(home, "channels");
	if (!existsSync(root)) return;
	for (const entry of readdirSync(root, {withFileTypes: true})) {
		if (!entry.isDirectory() || !/^[0-9a-f]{16}$/.test(entry.name)) continue;
		const path = join(root, entry.name, "channel.json");
		if (!existsSync(path) || !lstatSync(path).isFile()) continue;
		const text = readFileSync(path, "utf8");
		const record = z.looseObject({id: z.literal(entry.name)}).parse(JSON.parse(text));
		if ("local" in record || "tailnet" in record) continue;
		const temporary = `${path}.${process.pid}.local.tmp`;
		// Insert the scope without rewriting unknown fields or the legacy version/name/branch data.
		writeFileSync(temporary, text.replace(/\}(\s*)$/, ',"local":true}$1'), {mode: lstatSync(path).mode & 0o777});
		renameSync(temporary, path);
	}
}
