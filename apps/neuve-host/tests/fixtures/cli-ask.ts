import { mock } from "bun:test";

const catalog = await import("../../src/catalog");
mock.module("../../src/catalog", () => ({
	...catalog,
	user: "person",
	list: () => [{ id: "test", name: "test" }],
	find: () => ({ id: "test", name: "test" }),
}));

const client = await import("../../src/client");
mock.module("../../src/client", () => ({
	...client,
	Connection: {
		open: async () => ({
			request: async (request: unknown) => console.log(JSON.stringify(request)),
			close: () => {},
		}),
	},
}));

await import("../../src/cli");
