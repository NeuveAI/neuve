import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { config } from "../src/config";
import { desktop, desktopAvailable } from "../src/desktop";

const appMissing = "Ace's desktop app isn't running on this host. No desktop operation ran.";

async function withHome(run: (home: string) => Promise<void>) {
	const home = await mkdtemp(join(tmpdir(), "desktop-"));
	const previous = config.home;
	config.home = home;
	try {
		await run(home);
	} finally {
		config.home = previous;
		await rm(home, { recursive: true, force: true });
	}
}

const startListener = (path: string) => Bun.spawn([
	process.execPath, "--no-env-file", "--eval",
	`Bun.listen({
		unix: process.argv.at(-1),
		socket: { data() {}, open(socket) { socket.end(); } },
	});
	console.log("ready");`,
	path,
], { stdout: "pipe", stderr: "inherit", timeout: 30_000, killSignal: "SIGKILL" });

async function waitForListener(child: ReturnType<typeof startListener>) {
	const stdout = child.stdout.getReader();
	try {
		if ((await stdout.read()).done) throw new Error("Desktop socket listener exited before binding");
	} finally {
		stdout.releaseLock();
	}
}

test("desktop offer and dispatch are unavailable when both files are missing", () => withHome(async () => {
	expect(desktopAvailable()).toBe(false);
	await expect(desktop({ op: "apps" }, BACKGROUND_CONTEXT)).rejects.toHaveProperty("message", appMissing);
}));

test("a crashed desktop listener is refused and a new socket restores the offer", () => withHome(async (home) => {
	const socket = join(home, "desktop.sock");
	const client = join(home, "desktop-client");
	const ran = join(home, "desktop.sock.ran");
	const request = { op: "clipboard-write", text: "fixture" } satisfies Parameters<typeof desktop>[0];
	await writeFile(client, `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
import { createConnection } from "node:net";
const path = process.argv[2];
writeFileSync(path + ".ran", "");
createConnection(path).once("end", () => {
	console.log(JSON.stringify({ success: false, error: { code: "DESKTOP_ERROR", message: "Connection closed after connect" } }));
	process.exitCode = 1;
}).resume();
`, { mode: 0o700 });
	expect(desktopAvailable()).toBe(false);

	let listener = startListener(socket);
	try {
		await waitForListener(listener);
		expect(desktopAvailable()).toBe(true);
		listener.kill("SIGKILL");
		await listener.exited;
		expect((await stat(socket)).isSocket()).toBe(true);
		expect(desktopAvailable()).toBe(true);

		await expect(desktop(request, BACKGROUND_CONTEXT)).rejects.toHaveProperty("message", appMissing);
		expect(existsSync(ran)).toBe(false);
		expect((await stat(socket)).isSocket()).toBe(true);
		expect(existsSync(client)).toBe(true);
		expect(desktopAvailable()).toBe(false);

		await rm(socket);
		listener = startListener(socket);
		await waitForListener(listener);
		expect(desktopAvailable()).toBe(true);

		// The signed client's wrapper runs operations only on macOS.
		if (process.platform === "darwin") {
			const result = await desktop(request, BACKGROUND_CONTEXT);
			expect(result.outcome).toBe("unknown");
			expect(result.text).toContain("The desktop action may have partially run.");
			expect(desktopAvailable()).toBe(true);
		}
	} finally {
		if (listener.exitCode === null) listener.kill("SIGKILL");
		await listener.exited;
	}
}));
