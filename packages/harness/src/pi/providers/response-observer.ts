import { createParser } from "eventsource-parser";
import { DEFAULT_LIMITS } from "../capture/archive.ts";

const responseWithBody = (response: Response, body: BodyInit) =>
  new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });

/** Observe SSE before SDK error handling, with unchanged bytes and native backpressure/cancellation. */
export const observeResponse = (
  response: Response,
  observe: (name: string, data: unknown) => unknown | Promise<unknown>,
  failed: (cause: unknown) => Error,
  signal?: AbortSignal,
): Response => {
  if (response.body === null) return response;
  const decoder = new TextDecoder();
  const pending: Array<{ name: string; data: unknown }> = [];
  const drain = async () => {
    for (const event of pending) {
      signal?.throwIfAborted();
      await observe(event.name, event.data);
    }
    pending.length = 0;
  };
  const parser = createParser({
    maxBufferSize: DEFAULT_LIMITS.objectBytes,
    onError(error) {
      if (error.type === "max-buffer-size-exceeded") throw failed(error);
    },
    onEvent(event) {
      if (event.data === "[DONE]") return;
      let data: unknown;
      try {
        data = JSON.parse(event.data) as unknown;
      } catch {
        data = event.data;
      }
      if (pending.length >= 16_384)
        throw failed(new Error("SSE observation batch exceeds its bound"));
      pending.push({ name: event.event ?? "message", data });
    },
  });
  return responseWithBody(
    response,
    response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        async transform(chunk, controller) {
          for (let offset = 0; offset < chunk.byteLength; offset += 65_536) {
            signal?.throwIfAborted();
            parser.feed(
              decoder.decode(chunk.subarray(offset, offset + 65_536), {
                stream: true,
              }),
            );
            await drain();
          }
          signal?.throwIfAborted();
          controller.enqueue(chunk);
        },
        async flush() {
          parser.feed(decoder.decode());
          parser.reset({ consume: true });
          await drain();
        },
      }),
      signal === undefined ? undefined : { signal },
    ),
  );
};

/** Keep the complete HTTP refusal within the same bound as a captured dump object. */
export const readRefusal = async (
  response: Response,
  failed: (cause: unknown) => Error,
): Promise<{ readonly response: Response; readonly text: string }> => {
  if (response.body === null) return { response, text: "" };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > DEFAULT_LIMITS.objectBytes)
        throw new Error(
          `HTTP error body exceeds the ${DEFAULT_LIMITS.objectBytes}-byte capture object limit`,
        );
      chunks.push(item.value);
    }
  } catch (cause) {
    await reader.cancel().catch(() => undefined);
    throw failed(cause);
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    response: responseWithBody(response, bytes),
    text: new TextDecoder().decode(bytes),
  };
};
