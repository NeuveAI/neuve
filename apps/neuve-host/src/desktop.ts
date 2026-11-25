import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Desktop } from "@ace/channel/desktop";
import { createDesktop, type DesktopClient } from "@githubnext/desktop-tools";

import { config } from "./config";

let client: DesktopClient | undefined;

const clientPath = () => join(config.home, "desktop-client");
const socketPath = () => join(config.home, "desktop.sock");
// The app can leave the client link behind after its socket closes.
export const desktopAvailable = () => existsSync(clientPath()) && existsSync(socketPath());

export const desktop: Desktop = async (request, context) => {
	// Whichever process started this worker, only the app serving this data directory's socket
	// knows which signed client it accepts, so it publishes that client beside the socket.
	if (!desktopAvailable()) throw new Error("Ace's desktop app isn't running on this host. No desktop operation ran.");
	client ??= createDesktop({
		client: clientPath(),
		socket: socketPath(),
		name: "Ace",
	});
	// Hosted links and pi rows carry only the bounded text and image, not the parsed copy.
	const { text, image, outcome, isError } = await client(request, context.abortSignal);
	return {
		text,
		...(image ? { image } : {}),
		...(outcome ? { outcome } : {}),
		...(isError === undefined ? {} : { isError }),
	};
};
