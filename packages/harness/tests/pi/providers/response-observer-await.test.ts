import { expect, test } from "bun:test";
import { observeResponse } from "../../../src/pi/providers/response-observer.ts";

const fail = () => new Error("observation failed");
const bytes = (text: string) => new TextEncoder().encode(text);

test("SSE bytes wait for ordered observation across chunk and UTF-8 boundaries", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen: unknown[] = [];
  const text =
    'event: first\ndata: {"value":"é"}\n\nevent: second\ndata: {"value":2}\n\n';
  const original = bytes(text);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const split = original.indexOf(0xc3) + 1;
      controller.enqueue(original.slice(0, split));
      controller.enqueue(original.slice(split));
      controller.close();
    },
  });
  const response = observeResponse(
    new Response(body),
    async (name, data) => {
      seen.push({ name, data });
      if (name === "first") await held;
    },
    fail,
  );
  let delivered = false;
  const reading = response.arrayBuffer().then((value) => {
    delivered = true;
    return value;
  });
  await Bun.sleep(10);
  expect(delivered).toBe(false);
  expect(seen).toEqual([{ name: "first", data: { value: "é" } }]);
  release();
  expect(new Uint8Array(await reading)).toEqual(original);
  expect(seen).toEqual([
    { name: "first", data: { value: "é" } },
    { name: "second", data: { value: 2 } },
  ]);
});

test("observation failure rejects byte delivery and cancels the original source", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes('data: {"value":1}\n\n'));
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = observeResponse(
    new Response(body),
    async () => {
      throw new Error("private inspection unavailable");
    },
    fail,
  );
  await expect(response.text()).rejects.toThrow(
    "private inspection unavailable",
  );
  await Bun.sleep(0);
  expect(cancelled).toBe(true);
});

test("abort while observation is held rejects after its joined work settles", async () => {
  const controller = new AbortController();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false,
    settled = false;
  const response = observeResponse(
    new Response('data: {"value":1}\n\n'),
    async () => {
      entered = true;
      await held;
      settled = true;
    },
    fail,
    controller.signal,
  );
  const reading = response.text();
  while (!entered) await Bun.sleep(1);
  controller.abort(new Error("cancelled"));
  release();
  await expect(reading).rejects.toThrow("cancelled");
  expect(settled).toBe(true);
});
