import { existsSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";

import type { Desktop, DesktopResult } from "@ace/channel/desktop";
import { createDesktop } from "@githubnext/desktop-tools";

import { config } from "./config";

let refusedSocket: string | undefined;

const appMissing = (): DesktopResult => ({
	text: "Ace's desktop app isn't running on this host. No desktop operation ran.",
	isError: true,
	outcome: "refused",
});
const desktopPaths = () => ({
	client: join(config.home, "desktop-client"),
	socket: join(config.home, "desktop.sock"),
});

const socketIdentity = (path: string) => {
	try {
		const stat = statSync(path, { bigint: true, throwIfNoEntry: false });
		if (stat?.isSocket()) return `${stat.dev}:${stat.ino}:${stat.mtimeNs}`;
	} catch {
		return undefined;
	}
};

const availableSocket = ({ client, socket } = desktopPaths()) => {
	if (!existsSync(client)) return undefined;
	const identity = socketIdentity(socket);
	return identity === refusedSocket ? undefined : identity;
};

export const desktopAvailable = () => availableSocket() !== undefined;

const connectionRefused = (path: string, signal: AbortSignal) => new Promise<boolean>((resolve) => {
	const socket = createConnection({ path, signal });
	socket.once("error", (error) => {
		resolve("code" in error && (error.code === "ECONNREFUSED" || error.code === "ENOENT"));
	});
	socket.once("connect", () => {
		socket.destroy();
		resolve(false);
	});
});

export const desktop: Desktop = async (request, context) => {
	// Whichever process started this worker, only the app serving this data directory's socket
	// knows which signed client it accepts, so it publishes that client beside the socket.
	const paths = desktopPaths();
	const identity = availableSocket(paths);
	if (identity === undefined) return appMissing();
	// The client can report an unknown action outcome even if its process never connected.
	// Check before launching it so a refused connection proves that no operation was sent.
	if (await connectionRefused(paths.socket, context.abortSignal)) {
		if (socketIdentity(paths.socket) === identity) refusedSocket = identity;
		return appMissing();
	}
	const client = createDesktop({ ...paths, name: "Ace" });
	// Hosted links and pi rows carry only the bounded text and image, not the parsed copy.
	const { text, image, outcome, isError } = await client(request, context.abortSignal);
	return {
		text,
		...(image ? { image } : {}),
		...(outcome ? { outcome } : {}),
		...(isError === undefined ? {} : { isError }),
	};
};
