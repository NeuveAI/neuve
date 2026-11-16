import { constants, open, lstat, unlink } from "node:fs/promises";
import { basename, isAbsolute, join, sep } from "node:path";
import { z } from "zod";
import { protocolFrameShape } from "./protocol.ts";

export const fixtureSchema = z.object({
  version: z.literal(1),
  sends: z.number().int().nonnegative(),
  frames: z.array(z.record(z.string(), z.json())),
});
export type SmokeFixture = z.infer<typeof fixtureSchema>;
type Fields = SmokeFixture["frames"][number];

// Only Claude route model identifiers, never arbitrary provider model labels.
export const fixtureModel = (value: unknown) =>
  typeof value === "string" &&
  /^claude-(?:opus|sonnet|haiku)-[3-9](?:-[0-9])?(?:-20[0-9]{6})?(?:\[1m\])?$/.test(
    value,
  )
    ? value
    : "other";
const tag = (value: unknown, allowed: readonly string[]) =>
  typeof value === "string" && allowed.includes(value) ? value : "other";
const get = (value: unknown, key: string): unknown => {
  if (value === null || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined) return undefined;
  if (!("value" in descriptor)) throw new Error("Fixture accessor refused");
  return descriptor.value;
};
const rebuildArray = <T>(
  value: unknown,
  construct: (item: unknown) => T,
): T[] => {
  if (!Array.isArray(value)) throw new Error("Fixture array refused");
  const length = value.length;
  if (!Number.isSafeInteger(length) || length < 0 || length > 1_000_000)
    throw new Error("Fixture array length refused");
  const output: T[] = [];
  for (let index = 0; index < length; index++)
    output[index] = construct(get(value, String(index)));
  return output;
};
const numeric = (source: unknown, target: Fields, keys: readonly string[]) => {
  for (const key of keys) {
    const value = get(source, key);
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0)
      target[key] = value;
  }
};
const usage = (value: unknown): Fields => {
  const output: Fields = {};
  numeric(value, output, [
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
  ]);
  const cache = get(value, "cache_creation");
  if (cache !== undefined && cache !== null) {
    const counters: Fields = {};
    numeric(cache, counters, [
      "ephemeral_5m_input_tokens",
      "ephemeral_1h_input_tokens",
    ]);
    output.cache_creation = counters;
  }
  const details = get(value, "output_tokens_details");
  if (details !== undefined && details !== null) {
    const counters: Fields = {};
    numeric(details, counters, ["thinking_tokens"]);
    output.output_tokens_details = counters;
  }
  return output;
};
const reason = (value: unknown) =>
  value === null
    ? null
    : tag(value, [
        "end_turn",
        "tool_use",
        "max_tokens",
        "stop_sequence",
        "pause_turn",
        "refusal",
        "model_context_window_exceeded",
      ]);

/** Construct every field afresh. No unknown property or provider content crosses this boundary. */
export function recordFixture(
  frames: readonly unknown[],
  sentUuids: readonly string[],
): SmokeFixture {
  const ids = new Map<string, Map<string, string>>();
  const id = (value: unknown, prefix: string) => {
    if (typeof value !== "string") return undefined;
    let group = ids.get(prefix);
    if (group === undefined) {
      group = new Map();
      ids.set(prefix, group);
    }
    let placeholder = group.get(value);
    if (placeholder === undefined) {
      placeholder = `${prefix}_${group.size + 1}`;
      group.set(value, placeholder);
    }
    return placeholder;
  };
  const block = (value: unknown): Fields => {
    const type = tag(get(value, "type"), [
      "text",
      "thinking",
      "redacted_thinking",
      "tool_use",
      "tool_result",
      "image",
      "document",
      "server_tool_use",
      "web_search_tool_result",
      "web_fetch_tool_result",
      "compaction",
    ]);
    const output: Fields = { type };
    if (type === "text") output.text = "";
    if (type === "thinking") {
      output.thinking = "";
      output.signature = "";
    }
    if (type === "redacted_thinking") output.data = "";
    if (type === "compaction") output.content = "";
    if (type === "tool_use" || type === "server_tool_use") {
      const toolId = id(get(value, "id"), "toolu");
      if (toolId !== undefined) output.id = toolId;
      output.name = tag(get(value, "name"), [
        "mcp__neuve__note",
        "mcp__neuve__finish",
      ]);
      output.input = {};
    }
    if (type === "tool_result") {
      const toolId = id(get(value, "tool_use_id"), "toolu");
      if (toolId !== undefined) output.tool_use_id = toolId;
      output.content = Array.isArray(get(value, "content"))
        ? [{ type: "text", text: "" }]
        : "";
      const error = get(value, "is_error");
      if (typeof error === "boolean") output.is_error = error;
    }
    return output;
  };
  const message = (value: unknown): Fields => {
    const output: Fields = {};
    const messageId = id(get(value, "id"), "msg");
    if (messageId !== undefined) output.id = messageId;
    if (get(value, "model") !== undefined)
      output.model = fixtureModel(get(value, "model"));
    if (get(value, "stop_reason") !== undefined)
      output.stop_reason = reason(get(value, "stop_reason"));
    const content = get(value, "content");
    if (Array.isArray(content)) output.content = rebuildArray(content, block);
    else if (typeof content === "string") output.content = "";
    if (get(value, "usage") !== undefined)
      output.usage = usage(get(value, "usage"));
    return output;
  };
  try {
    const sends = rebuildArray(sentUuids, (value) => {
      if (typeof value !== "string") throw new Error("Fixture send refused");
      return value;
    });
    const stamp = (value: unknown) => {
      if (typeof value !== "string") return undefined;
      const index = sends.indexOf(value);
      return index < 0 ? id(value, "foreign") : `send_${index + 1}`;
    };
    const recorded = rebuildArray(frames, (frame): Fields => {
      // Read descriptors first so throwing accessors cannot be silently normalized.
      const type = get(frame, "type");
      const output: Fields = { type: protocolFrameShape({ type }).type };
      if (type === "rate_limit_event")
        return {
          type,
          rate_limit_info: {
            status: tag(get(get(frame, "rate_limit_info"), "status"), [
              "allowed",
              "allowed_warning",
              "rejected",
            ]),
          },
        };
      if (type === "system" || type === "result") {
        const subtype = get(frame, "subtype");
        output.subtype =
          protocolFrameShape({ type, subtype }).subtype ?? "other";
      }
      for (const [key, prefix] of [
        ["uuid", "uuid"],
        ["session_id", "session"],
      ] as const) {
        const placeholder = id(get(frame, key), prefix);
        if (placeholder !== undefined) output[key] = placeholder;
      }
      const single = stamp(get(frame, "user_message_uuid"));
      if (single !== undefined) output.user_message_uuid = single;
      const many = get(frame, "user_message_uuids");
      if (Array.isArray(many))
        output.user_message_uuids = rebuildArray(
          many,
          (value) => stamp(value) ?? "other",
        );
      if (type === "assistant" || type === "user" || type === "stream_event") {
        const parent = get(frame, "parent_tool_use_id");
        if (parent === null) output.parent_tool_use_id = null;
        else {
          const placeholder = id(parent, "toolu");
          if (placeholder !== undefined)
            output.parent_tool_use_id = placeholder;
        }
      }
      if (type === "assistant" || type === "user")
        output.message = message(get(frame, "message"));
      if (type === "stream_event") {
        const event = get(frame, "event");
        const eventType = tag(get(event, "type"), [
          "message_start",
          "message_delta",
          "message_stop",
          "content_block_start",
          "content_block_delta",
          "content_block_stop",
        ]);
        const recordedEvent: Fields = { type: eventType };
        numeric(event, recordedEvent, ["index"]);
        if (eventType === "message_start")
          recordedEvent.message = message(get(event, "message"));
        if (eventType === "content_block_start")
          recordedEvent.content_block = block(get(event, "content_block"));
        if (
          eventType === "message_delta" ||
          eventType === "content_block_delta"
        ) {
          const delta = get(event, "delta");
          const recordedDelta: Fields = {};
          if (eventType === "message_delta") {
            if (get(delta, "stop_reason") !== undefined)
              recordedDelta.stop_reason = reason(get(delta, "stop_reason"));
            recordedEvent.usage = usage(get(event, "usage"));
          } else {
            const deltaType = tag(get(delta, "type"), [
              "text_delta",
              "thinking_delta",
              "signature_delta",
              "input_json_delta",
              "citations_delta",
            ]);
            recordedDelta.type = deltaType;
            if (deltaType === "text_delta") recordedDelta.text = "";
            if (deltaType === "thinking_delta") recordedDelta.thinking = "";
            if (deltaType === "signature_delta") recordedDelta.signature = "";
            if (deltaType === "input_json_delta")
              recordedDelta.partial_json = "";
          }
          recordedEvent.delta = recordedDelta;
        }
        output.event = recordedEvent;
      }
      if (type === "result") {
        const error = get(frame, "is_error");
        if (typeof error === "boolean") output.is_error = error;
        numeric(frame, output, ["num_turns"]);
        if (get(frame, "usage") !== undefined)
          output.usage = usage(get(frame, "usage"));
        const ledger = get(frame, "modelUsage");
        if (ledger !== null && typeof ledger === "object") {
          const models: Fields = {};
          for (const model of Object.keys(ledger)) {
            const counters: Fields = {};
            numeric(get(ledger, model), counters, [
              "inputTokens",
              "outputTokens",
              "cacheReadInputTokens",
              "cacheCreationInputTokens",
              "cacheCreationEphemeral5mInputTokens",
              "cacheCreationEphemeral1hInputTokens",
              "thinkingTokens",
            ]);
            const key = fixtureModel(model);
            const previous = models[key];
            if (
              previous !== null &&
              typeof previous === "object" &&
              !Array.isArray(previous)
            ) {
              for (const counter of [
                "inputTokens",
                "outputTokens",
                "cacheReadInputTokens",
                "cacheCreationInputTokens",
                "cacheCreationEphemeral5mInputTokens",
                "cacheCreationEphemeral1hInputTokens",
                "thinkingTokens",
              ]) {
                const count = counters[counter];
                const before = previous[counter];
                if (typeof before === "number") {
                  const total =
                    before + (typeof count === "number" ? count : 0);
                  if (!Number.isSafeInteger(total))
                    throw new Error("Fixture counter overflow");
                  counters[counter] = total;
                }
              }
            }
            models[key] = counters;
          }
          output.modelUsage = models;
        }
        if (get(frame, "stop_reason") !== undefined)
          output.stop_reason = reason(get(frame, "stop_reason"));
      }
      return output;
    });
    return { version: 1, sends: sends.length, frames: recorded };
  } catch {
    throw new Error("Fixture capture failed");
  }
}

export type FixtureDestination = {
  readonly root: string;
  readonly name: string;
};

function checkDestination({ root, name }: FixtureDestination) {
  if (!isAbsolute(root)) throw new Error("Fixture root must be absolute");
  if (
    isAbsolute(name) ||
    name.split(sep).some((part) => part === "" || part === "." || part === "..")
  )
    throw new Error("Fixture name must be a plain relative path");
}

export async function fixturePath(destination: FixtureDestination) {
  checkDestination(destination);
  const directory = async (path: string) => {
    const entry = await lstat(path);
    if (entry.isSymbolicLink())
      throw new Error("Fixture directory must not be a symlink");
    if (!entry.isDirectory())
      throw new Error("Fixture parent must be a directory");
  };
  let parent: string = sep;
  await directory(parent);
  // Inspect each component before joining the next; normalization must not hide a symlink.
  for (const component of [
    ...destination.root.split(sep),
    ...destination.name.split(sep).slice(0, -1),
  ]) {
    if (component === "") continue;
    parent = join(parent, component);
    await directory(parent);
  }
  const target = join(parent, basename(destination.name));
  try {
    await lstat(target);
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return target;
    throw new Error("Fixture path check failed");
  }
  throw new Error("Fixture path already exists");
}

export async function writeFixture(
  destination: FixtureDestination,
  fixture: SmokeFixture,
) {
  const serialized = `${JSON.stringify(fixtureSchema.parse(fixture), null, 2)}\n`;
  const target = await fixturePath(destination);
  const file = await open(
    target,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW |
      constants.O_WRONLY,
    0o600,
  );
  try {
    await file.writeFile(serialized);
    await file.close();
  } catch {
    await file.close().catch(() => {});
    await unlink(target);
    throw new Error("Fixture write failed");
  }
}

export function fixtureFlag(input: readonly string[]) {
  const args = rebuildArray(input, (value) => {
    if (typeof value !== "string") throw new Error("Fixture flag refused");
    return value;
  });
  if (
    !args.includes("--record-fixture") &&
    !args.includes("--record-fixture-root")
  )
    return undefined;
  const root = args[2];
  const name = args[4];
  if (
    (args[0] !== "--diagnose-tools" &&
      args[0] !== "--diagnose-tools-multi-round") ||
    args[1] !== "--record-fixture-root" ||
    args[3] !== "--record-fixture" ||
    args.length !== 5 ||
    root === undefined ||
    name === undefined
  )
    throw new Error(
      "Use --record-fixture-root <absolute directory> --record-fixture <relative name> with a tools diagnosis",
    );
  const destination = { root, name };
  checkDestination(destination);
  return destination;
}
