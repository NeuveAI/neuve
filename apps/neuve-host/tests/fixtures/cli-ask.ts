import type { ChannelInfo, Request } from "@ace/channel/protocol";
import { mock } from "bun:test";
import type { Watch } from "../../src/gateway-client";

const catalog = await import("../../src/catalog");
mock.module("../../src/catalog", () => ({
	...catalog,
	user: "person",
	list: () => [{ id: "test", name: "test" }],
	find: () => ({ id: "test", name: "test" }),
}));

const client = await import("../../src/client");
const info: ChannelInfo = {
	id: "test", name: "test", summary: "", revision: 0, project: "/test",
	owner: "person", shared: false, desktop: false, chats: [{ id: 1, busy: false }],
};
mock.module("../../src/client", () => ({
	...client,
	Connection: {
		open: async () => {
			const lateRunStart = process.argv.at(-1) === "Fail before run start";
			let watch: Watch | undefined;
			let error: string | undefined;
			return {
				request: async (request: Request, subscription?: Watch) => {
					switch (request.op) {
						case "info":
							return info;
						case "watch":
							watch = subscription;
							watch?.event({ kind: "live", chat: 1 });
							if (!lateRunStart) watch?.event({ kind: "run", chat: 1, state: "start" });
							return;
						case "ask":
							if (!watch) console.log(JSON.stringify(request));
							error = request.text === "Fail" || lateRunStart ? "Provider failed" : undefined;
							return { submission: 1 };
						case "wait":
							setImmediate(() => {
								if (lateRunStart) watch?.event({ kind: "run", chat: 1, state: "start" });
								watch?.event({ kind: "reply", chat: 1, entry: 1, at: 0, model: "test", text: "Final reply", error });
								watch?.event({ kind: "run", chat: 1, state: "end" });
							});
							return lateRunStart ? "unanswered" : "done";
					}
				},
				close: () => {},
			};
		},
	},
}));

await import("../../src/cli");
