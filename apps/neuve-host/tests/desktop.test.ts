import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { config } from "../src/config";
import { desktop, desktopAvailable } from "../src/desktop";

test("desktop offer and dispatch require the client link and socket", async () => {
	const home = await mkdtemp(join(tmpdir(), "desktop-availability-"));
	const previous = config.home;
	config.home = home;
	try {
		expect(desktopAvailable()).toBe(false);
		await writeFile(join(home, "desktop-client"), "fixture-only");
		expect(desktopAvailable()).toBe(false);
		await writeFile(join(home, "desktop.sock"), "fixture-only");
		expect(desktopAvailable()).toBe(true);
		await rm(join(home, "desktop.sock"));
		expect(desktopAvailable()).toBe(false);
		await expect(desktop({ op: "apps" }, BACKGROUND_CONTEXT)).rejects.toThrow("Ace's desktop app isn't running on this host. No desktop operation ran.");
	} finally {
		config.home = previous;
		await rm(home, { recursive: true, force: true });
	}
});
