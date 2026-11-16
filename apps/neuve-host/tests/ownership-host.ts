import "./fixtures/memory-secrets";
import { existsSync, renameSync, writeFileSync } from "node:fs";

import { startHost } from "./fixture-host";

const [configuration, ready, barrier] = process.argv.slice(2);
if (!configuration || !ready || !barrier) throw new Error("Missing ownership fixture paths");
const temporary = `${ready}.${process.pid}.tmp`;
writeFileSync(`${ready}.waiting`, "");
while (!existsSync(barrier)) await Bun.sleep(10);
try {
	const host = await startHost({loopback: true,
		config: JSON.parse(configuration),
		models: () => [],
	});
	process.on("SIGTERM", async () => {
		try {
			await Promise.all([host.close(), host.close()]);
			process.exit(0);
		} catch {
			if (process.env.NEUVE_TEST_HOLD_CLOSE_FAILURE === "1") {
				writeFileSync(`${ready}.failed`, "");
				setInterval(() => {}, 1000);
				return;
			}
			process.exit(2);
		}
	});
	writeFileSync(temporary, JSON.stringify({ url: host.url, port: host.port, token: host.token }), {
		flag: "wx",
		mode: 0o600,
	});
	renameSync(temporary, ready);
} catch (error) {
	writeFileSync(temporary, JSON.stringify({ error: String(error) }), {
		flag: "wx",
		mode: 0o600,
	});
	renameSync(temporary, ready);
	process.exit(1);
}
