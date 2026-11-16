import { expect, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, createRegistry, defineTask, defineExtension } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Channel } from "../src/index";
import { faux, project, scratch } from "./helpers";

for (const phase of ["scan", "resumed"])
	for (const dual of [false, true]) {
		test(`partial Channel ${phase} initialization joins its Harness and removes subscriptions, cleanup failure ${dual}`, async () => {
			const root = await scratch();
			const paths = await project(root);
			const primary = new Error("channel startup refused"),
				cleanup = new Error("harness close failed");
			const storage = await openNodeSqliteStorage(join(root, "channel.sqlite"));
			const nativeClose = storage.close.bind(storage);
			let closed = 0,
				nativeClosed = 0,
				subscribed = 0,
				removed = 0;
			storage.close = async (context) => {
				nativeClosed++;
				await nativeClose(context);
			};
			const open = Harness.open;
			const opening = spyOn(Harness, "open").mockImplementation(async (...args) => {
				const harness = await open(...args);
				const subscribe = harness.subscribeCommits.bind(harness);
				harness.subscribeCommits = (listener) => {
					subscribed++;
					const remove = subscribe(listener);
					return () => {
						removed++;
						remove();
					};
				};
				if (phase === "scan")
					harness.commit = async () => {
						throw primary;
					};
				const close = harness.close.bind(harness);
				harness.close = async (context) => {
					closed++;
					await close(context);
					if (dual) throw cleanup;
				};
				return harness;
			});
			try {
				const error = await Channel.open({
					id: "one",
					name: "one",
					owner: "owner",
					...paths,
					storage,
					models: faux().models,
					env() {
						throw new Error("No tool should run during this startup probe");
					},
					directory: {
						self: { id: "one", name: "one" },
						list: async () => [],
						deliver: async () => {},
					},
					log(_level, event) {
						if (event === "channel.open") throw primary;
					},
				}).catch((error: unknown) => error);
				if (dual) {
					expect(error).toBeInstanceOf(AggregateError);
					if (error instanceof AggregateError) expect(error.errors).toEqual([primary, cleanup]);
				} else expect(error).toBe(primary);
				expect(subscribed).toBe(phase === "scan" ? 1 : 2);
				expect(closed).toBe(1);
				expect(nativeClosed).toBe(1);
				expect(removed).toBe(subscribed);
			} finally {
				opening.mockRestore();
				await nativeClose(BACKGROUND_CONTEXT);
				await rm(root, { recursive: true, force: true });
			}
		});
	}

test("partial Channel startup joins a live native producer before storage closes", async () => {
	const root = await scratch();
	const paths = await project(root);
	const storage = await openNodeSqliteStorage(join(root, "channel.sqlite"));
	const nativeClose = storage.close.bind(storage);
	const order: string[] = [];
	let started!: () => void;
	const active = new Promise<void>((resolve) => {
		started = resolve;
	});
	const task = defineTask<null, { phase: "run" }, null>({
		name: "test.startup-producer",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			run: async (_task, _runtime, context) => {
				order.push("producer-start");
				started();
				try {
					await new Promise<void>((resolve) => {
						const signal = context.abortSignal;
						if (!signal) throw new Error("Native producer needs its close signal");
						if (signal.aborted) resolve();
						else signal.addEventListener("abort", () => resolve(), { once: true });
					});
					await Bun.sleep(10);
					await storage.scanConversations({}, 1, undefined, BACKGROUND_CONTEXT);
					order.push("producer-read");
				} finally {
					order.push("producer-joined");
				}
			},
		},
		abort: async () => {},
	});
	storage.close = async (context) => {
		order.push("native-close");
		await nativeClose(context);
	};
	const primary = new Error("late Channel startup failure");
	const open = Harness.open;
	const opening = spyOn(Harness, "open").mockImplementation(async (storage, options, context) => {
		const registry = createRegistry();
		for (const extension of options.registry.snapshot().installed()) registry.install(extension);
		registry.install(defineExtension({ name: "test.startup-producer", tasks: [task] }));
		const harness = await open(storage, { ...options, registry }, context);
		const conversation = await harness.root(context);
		await harness.commit(
			(tx) =>
				tx.createTask(task, null, {
					ownership: { kind: "conversation" },
					conversationId: conversation.id,
				}),
			context,
		);
		harness.resume();
		await active;
		return harness;
	});
	try {
		await expect(
			Channel.open({
				id: "one",
				name: "one",
				owner: "owner",
				...paths,
				storage,
				models: faux().models,
				env() {
					throw new Error("No tool should run");
				},
				directory: {
					self: { id: "one", name: "one" },
					list: async () => [],
					deliver: async () => {},
				},
				log(_level, event) {
					if (event === "channel.open") throw primary;
				},
			}),
		).rejects.toBe(primary);
		expect(order).toEqual(["producer-start", "producer-read", "producer-joined", "native-close"]);
	} finally {
		opening.mockRestore();
		await nativeClose(BACKGROUND_CONTEXT);
		await rm(root, { recursive: true, force: true });
	}
});
