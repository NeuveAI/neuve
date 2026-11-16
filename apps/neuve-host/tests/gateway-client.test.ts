import "./fixtures/memory-secrets";
import { expect, test } from "bun:test";

import { GatewayClient } from "../src/private-gateway-client";

async function until(read: () => boolean) {
	const deadline = Date.now() + 5000;
	while (!read()) {
		if (Date.now() > deadline) throw new Error("Gateway did not reconnect");
		await Bun.sleep(10);
	}
}

for (const malformed of ["{", "null", "[]", '{"unrecognized":true}']) {
	test(`a malformed host frame ${malformed} rejects pending commands without replay`, async () => {
		let connections = 0;
		let commands = 0;
		const closes: number[] = [];
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch(request, server) {
				if (server.upgrade(request)) return;
				return new Response("Expected a WebSocket", { status: 400 });
			},
			websocket: {
				open() {
					connections++;
				},
				message(socket, raw) {
					const request = JSON.parse(String(raw));
					if (request.op === "channels")
						return void socket.send(JSON.stringify({ id: request.id, ok: true, value: [] }));
					commands++;
					if (commands === 1) return void socket.send(malformed);
					socket.send(JSON.stringify({ id: request.id, ok: true, value: "after reconnect" }));
				},
				close(_, code) {
					closes.push(code);
				},
			},
		});
		const client = new GatewayClient(`ws://127.0.0.1:${server.port}/ws`, "test");
		try {
			await until(() => client.status === "open");
			await expect(client.request({ op: "review", channel: "one" })).rejects.toThrow(
				"Malformed frame from the host",
			);
			await until(() => connections === 2 && client.status === "open");
			expect(commands).toBe(1);
			expect(closes).toContain(1007);
			expect(await client.request<string>({ op: "hello" })).toBe("after reconnect");
			expect(commands).toBe(2);
		} finally {
			client.close();
			await server.stop(true);
		}
	});
}

test("an empty event after a large reply leaves the next real reply intact", async () => {
	const large = "x".repeat(1_000_000);
	let connections = 0;
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(request, server) {
			if (server.upgrade(request)) return;
			return new Response("Expected a WebSocket", { status: 400 });
		},
		websocket: {
			open() {
				connections++;
			},
			message(socket, raw) {
				const request = JSON.parse(String(raw));
				const value =
					request.op === "channels" ? [] : request.op === "hello" ? large : "small reply";
				socket.send(JSON.stringify({ id: request.id, ok: true, value }));
				if (request.op === "hello") socket.send("");
			},
		},
	});
	const client = new GatewayClient(`ws://127.0.0.1:${server.port}/ws`, "test");
	try {
		await until(() => client.status === "open");
		expect(await client.request<string>({ op: "hello" })).toBe(large);
		expect(await client.request<string>({ op: "review", channel: "one" })).toBe("small reply");
		expect(connections).toBe(1);
	} finally {
		client.close();
		await server.stop(true);
	}
});

test("the captured refusal stream preserves the next request on the same connection", async () => {
	const { createServer } = await import("node:net");
	const { createHash } = await import("node:crypto");
	const chunks = (await import("./fixtures/refused-review-wire.json")).default;
	const peers = new Set<import("node:net").Socket>();
	let connections = 0;
	const server = createServer((socket) => {
		connections++;
		peers.add(socket);
		socket.on("close", () => peers.delete(socket));
		socket.once("data", (request) => {
			const key = request.toString().match(/Sec-WebSocket-Key: (.*)\r\n/i)?.[1];
			if (!key) throw new Error("Missing WebSocket key");
			const accept = createHash("sha1")
				.update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
				.digest("base64");
			socket.write(
				`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSec-WebSocket-Protocol: ace\r\n\r\n`,
			);
			let received = Buffer.alloc(0);
			let requests = 0;
			socket.on("data", (data) => {
				received = Buffer.concat([received, Buffer.from(data)]);
				while (received.length >= 2) {
					if ((received[0]! & 0x0f) === 8) return;
					const length = received[1]! & 0x7f;
					if (length >= 126) throw new Error("Fixture requests must fit a short masked frame");
					if (received.length < length + 6) return;
					received = received.subarray(length + 6);
					requests++;
					if (requests === 3) {
						// Exact server bytes from a native-client 1002 failure, including coalesced frames.
						socket.write(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk, "hex"))));
					} else if (requests === 4) {
						const reply = Buffer.from('{"id":4,"ok":true,"value":"still connected"}');
						socket.write(Buffer.concat([Buffer.from([0x81, reply.length]), reply]));
					}
				}
			});
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing TCP address");
	const client = new GatewayClient(`ws://127.0.0.1:${address.port}/ws`, "test");
	try {
		await until(() => client.status === "open");
		// The captured stream has replies for ids 1, 2 and 3. Defer its delivery until all exist.
		const created = client.request({ op: "create", project: "/synthetic" });
		const refused = expect(client.request({ op: "review", channel: "synthetic" })).rejects.toThrow(
			"Lane work has no commits to review",
		);
		await Promise.all([created, refused]);
		expect(await client.request<string>({ op: "hello" })).toBe("still connected");
		expect(connections).toBe(1);
	} finally {
		client.close();
		for (const peer of peers) peer.destroy();
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
});

test("a refused upgrade reconnects without an unhandled transport error", async () => {
	let upgrades = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, server) {
			if (++upgrades === 1) return new Response("Refused", { status: 503 });
			if (server.upgrade(request)) return;
			return new Response("Expected a WebSocket", { status: 400 });
		},
		websocket: {
			message(socket, raw) {
				const request = JSON.parse(String(raw));
				socket.send(JSON.stringify({ id: request.id, ok: true, value: [] }));
			},
		},
	});
	const client = new GatewayClient(`ws://127.0.0.1:${server.port}/ws`, "test");
	try {
		await until(() => upgrades === 2 && client.status === "open");
		expect(await client.request<unknown[]>({ op: "hello" })).toEqual([]);
	} finally {
		client.close();
		await server.stop(true);
	}
});

test("a malformed frame ends an accepted watch and reconnects without replay", async () => {
	let connections = 0;
	let watches = 0;
	let reason = "";
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, server) {
			if (server.upgrade(request)) return;
			return new Response("Expected a WebSocket", { status: 400 });
		},
		websocket: {
			open() {
				connections++;
			},
			message(socket, raw) {
				const request = JSON.parse(String(raw));
				socket.send(JSON.stringify({ id: request.id, ok: true, value: [] }));
				if (request.op === "channel") {
					watches++;
					socket.send("{");
				}
			},
		},
	});
	const client = new GatewayClient(`ws://127.0.0.1:${server.port}/ws`, "test");
	try {
		await until(() => client.status === "open");
		await client.channel(
			"synthetic",
			{ op: "watch" },
			{
				event() {},
				closed(error) {
					reason = error;
				},
			},
		);
		await until(() => connections === 2 && client.status === "open");
		expect(reason).toBe("Malformed frame from the host (1 bytes)");
		expect(watches).toBe(1);
	} finally {
		client.close();
		await server.stop(true);
	}
});
