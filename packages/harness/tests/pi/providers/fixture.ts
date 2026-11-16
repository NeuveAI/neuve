import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TSchema } from "@earendil-works/pi-ai";

export interface Received {
  readonly path: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

export type Responder = (request: Request) => Response | Promise<Response>;

/**
 * A local provider endpoint. Requests are kept as received; answers are queued per `session-id`, so
 * concurrent agent conversations each get their own, or in one shared queue.
 */
export const openEndpoint = () => {
  const received: Array<Received> = [];
  const shared: Array<Responder> = [];
  const bySession = new Map<string, Array<Responder>>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 30,
    fetch: async (request) => {
      received.push({
        path: new URL(request.url).pathname,
        headers: request.headers,
        body: (await request.json()) as Record<string, unknown>,
      });
      const queue = bySession.get(request.headers.get("session-id") ?? "");
      const next = (queue ?? shared).shift();
      return next === undefined
        ? new Response("no responder", { status: 500 })
        : next(request);
    },
  });
  return {
    server,
    received,
    respond: (...responders: Array<Responder>) => {
      shared.push(...responders);
    },
    respondTo: (session: string, ...responders: Array<Responder>) => {
      bySession.set(session, [
        ...(bySession.get(session) ?? []),
        ...responders,
      ]);
    },
    /** Sends what the route addresses to its real host (`https://api.openai.com/v1`) here instead. */
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return globalThis.fetch(
        new URL(`${url.pathname}${url.search}`, server.url),
        init,
      );
    }) as typeof globalThis.fetch,
    stop: () => server.stop(true),
  };
};

const encoder = new TextEncoder();
const frame = (event: Record<string, unknown>) =>
  encoder.encode(
    `event: ${String(event["type"])}\ndata: ${JSON.stringify(event)}\n\n`,
  );

/** An SSE response; a number waits that many ms, and `hold` keeps it open until the client leaves. */
export const sse = (
  events: ReadonlyArray<Record<string, unknown> | number>,
  options: {
    readonly hold?: boolean;
    readonly headers?: Record<string, string>;
  } = {},
) =>
  new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const event of events) {
          if (typeof event === "number") await Bun.sleep(event);
          else controller.enqueue(frame(event));
        }
        if (options.hold !== true) controller.close();
      },
    }),
    {
      headers: {
        "content-type": "text/event-stream",
        "x-request-id": "req_1",
        ...options.headers,
      },
    },
  );

/** A token command printing a fresh lease per run, counting its runs in a file beside it. */
export const tokenCommand = (directory: string, name: string) => {
  const path = join(directory, name);
  const count = `${path}.count`;
  writeFileSync(count, "0");
  writeFileSync(
    path,
    `#!/bin/sh\nn=$(( $(cat '${count}') + 1 ))\necho $n > '${count}'\nprintf '{"access_token":"tok-%s","expires_at":%s}' $n ${Date.now() + 3_600_000}\n`,
  );
  chmodSync(path, 0o700);
  return { path, runs: () => Number(readFileSync(count, "utf8").trim()) };
};

export const schema = (value: Record<string, unknown>) =>
  value as unknown as TSchema;

// One Responses turn, built from the items the provider streams.

type Event = Record<string, unknown>;

export const created = (id: string): Event => ({
  type: "response.created",
  response: { id, status: "in_progress", output: [] },
});

export const reasoningItem = (
  index: number,
  id: string,
  encrypted: string,
): Array<Event> => [
  {
    type: "response.output_item.added",
    output_index: index,
    item: { type: "reasoning", id, summary: [] },
  },
  {
    type: "response.output_item.done",
    output_index: index,
    item: { type: "reasoning", id, summary: [], encrypted_content: encrypted },
  },
];

export const messageItem = (
  index: number,
  id: string,
  phase: "commentary" | "final_answer",
  text: string,
): Array<Event> => [
  {
    type: "response.output_item.added",
    output_index: index,
    item: { type: "message", id, role: "assistant", phase, content: [] },
  },
  {
    type: "response.output_text.delta",
    output_index: index,
    content_index: 0,
    delta: text,
  },
  {
    type: "response.output_item.done",
    output_index: index,
    item: {
      type: "message",
      id,
      role: "assistant",
      phase,
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    },
  },
];

export const functionCallItem = (
  index: number,
  call: {
    readonly id: string;
    readonly callId: string;
    readonly name: string;
    readonly arguments: string;
  },
): Array<Event> => [
  {
    type: "response.output_item.added",
    output_index: index,
    item: {
      type: "function_call",
      id: call.id,
      call_id: call.callId,
      name: call.name,
      namespace: "neuve",
      arguments: "",
    },
  },
  {
    type: "response.function_call_arguments.delta",
    output_index: index,
    delta: call.arguments,
  },
  {
    type: "response.output_item.done",
    output_index: index,
    item: {
      type: "function_call",
      id: call.id,
      call_id: call.callId,
      name: call.name,
      namespace: "neuve",
      status: "completed",
      arguments: call.arguments,
    },
  },
];

export const completed = (
  id: string,
  usage: Record<string, unknown> = {
    input_tokens: 10,
    output_tokens: 5,
    total_tokens: 15,
  },
): Event => ({
  type: "response.completed",
  response: { id, status: "completed", output: [], usage },
});
