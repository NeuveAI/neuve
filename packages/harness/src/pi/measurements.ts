import { readData } from "@neuve/records-core";
import type { Context } from "@earendil-works/chord";
import { z } from "zod";
import type { NativeReads } from "./capture/build.ts";
import { NativeAttemptsDoc } from "./providers/retry-admission.ts";
import type { RouteConfig } from "../route.ts";
import type { RunLog } from "../run-log.ts";
import type { QueueClaim } from "./host.ts";
import { readCaptureJournal } from "./capture/journal.ts";
import type { JournalLine } from "./capture/types.ts";

/**
 * The attempt's wire measurements (proposal §2.5), read from the run's capture journal: each agent
 * call's request as the provider actually sent it, its status and how it ended, on either route.
 * They keep the names and fields the route's wire log gave them, so earlier runs and these compare.
 * Calls without an agent (Precompute's and Understand's code steps make none) are not turns.
 */

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const array = (value: unknown): ReadonlyArray<unknown> =>
  Array.isArray(value) ? value : [];

/** Every JSON Schema keyword used, as the wire log listed them. */
const keywordsOf = (schema: unknown, into = new Set<string>()): Set<string> => {
  if (Array.isArray(schema)) {
    for (const item of schema) keywordsOf(item, into);
    return into;
  }
  const object = record(schema);
  if (object === undefined) return into;
  for (const [key, value] of Object.entries(object)) {
    into.add(key);
    if (key === "properties" || key === "$defs" || key === "definitions") {
      for (const child of Object.values(record(value) ?? {}))
        keywordsOf(child, into);
      continue;
    }
    if (typeof value === "object" && value !== null) keywordsOf(value, into);
  }
  return into;
};

/**
 * One request's shape, on either wire: Anthropic's Messages (`messages`, `input_schema`,
 * `output_config.format`, signed thinking blocks) or OpenAI's Responses (`input`, `parameters`,
 * `text.format`, reasoning items with encrypted content). Replayed assistant output reads as one
 * block list per assistant message, or per run of output items between user inputs.
 */
const shapeOf = (body: unknown) => {
  const b = record(body) ?? {};
  const tools = array(b["tools"]).map((tool) => record(tool) ?? {});
  const format =
    record(record(b["output_config"])?.["format"]) ??
    record(record(b["text"])?.["format"]);
  const messagesWire = Array.isArray(b["messages"]);
  const history = array(messagesWire ? b["messages"] : b["input"]);
  const blocks: Array<Array<string>> = [];
  let open: Array<string> | undefined;
  for (const item of history) {
    const entry = record(item) ?? {};
    if (
      messagesWire &&
      entry["role"] === "assistant" &&
      Array.isArray(entry["content"])
    ) {
      blocks.push(
        entry["content"].map((block) => {
          const c = record(block) ?? {};
          const signed =
            typeof c["signature"] === "string" && c["signature"] !== "";
          return `${String(c["type"] ?? "?")}${signed ? "(signed)" : ""}`;
        }),
      );
      open = undefined;
      continue;
    }
    const type = entry["type"];
    if (
      type === "reasoning" ||
      type === "function_call" ||
      (type === "message" && entry["role"] === "assistant")
    ) {
      if (open === undefined) blocks.push((open = []));
      open.push(
        type === "reasoning" && typeof entry["encrypted_content"] === "string"
          ? "reasoning(encrypted)"
          : String(type),
      );
      continue;
    }
    open = undefined;
  }
  return {
    tools: tools.map((tool) => ({
      name: String(tool["name"] ?? "?"),
      strict: typeof tool["strict"] === "boolean" ? tool["strict"] : undefined,
    })),
    toolSchemaKeywords: [
      ...keywordsOf(
        tools.map((tool) => tool["input_schema"] ?? tool["parameters"]),
      ),
    ].sort(),
    toolChoice: b["tool_choice"],
    outputFormat:
      typeof format?.["type"] === "string" ? format["type"] : undefined,
    outputFormatKeywords:
      format?.["schema"] === undefined
        ? undefined
        : [...keywordsOf(format["schema"])].sort(),
    messages: history.length,
    assistantBlocks: blocks,
  };
};

const isThinking = (block: string) =>
  block.startsWith("thinking") || block.startsWith("reasoning");
const isToolCall = (block: string) =>
  block === "tool_use" || block === "function_call";

const quantile = (sorted: ReadonlyArray<number>, q: number) =>
  sorted.length === 0
    ? null
    : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;

type Call = {
  readonly agent: string;
  readonly at: number;
  readonly headerNames: ReadonlyArray<string>;
  readonly shape: ReturnType<typeof shapeOf>;
  status?: number;
  endedAt?: number;
  stopReason?: string | undefined;
  error?: string | undefined;
  contentTypes?: ReadonlyArray<string>;
  readonly anthropicBlocks: Map<number, string>;
};

/** The agent calls in the journal, by call ID in the order they were sent. */
const callsOf = (lines: ReadonlyArray<JournalLine>) => {
  const calls = new Map<string, Call>();
  for (const { at, event } of lines) {
    if (event.type === "model.request") {
      if (event.scope.agent === undefined) continue;
      const { body } = event;
      calls.set(event.callId, {
        agent: event.scope.agent,
        at,
        headerNames: event.headerNames,
        shape: shapeOf(body.status === "sent" ? body.json : undefined),
        anthropicBlocks: new Map(),
      });
      continue;
    }
    if (!("callId" in event)) continue;
    const call = calls.get(event.callId);
    if (call === undefined) continue;
    if (event.type === "model.response") call.status = event.status;
    if (event.type === "model.event" && event.name === "response.completed")
      call.contentTypes = array(
        record(record(event.data)?.["response"])?.["output"],
      ).map((item) => String(record(item)?.["type"] ?? "?"));
    if (event.type === "model.event" && event.name === "message_start") {
      const content = record(record(event.data)?.["message"])?.["content"];
      for (const [index, block] of array(content).entries())
        call.anthropicBlocks.set(index, String(record(block)?.["type"] ?? "?"));
    }
    if (event.type === "model.event" && event.name === "content_block_start") {
      const data = record(event.data);
      const index = data?.["index"];
      if (typeof index === "number" && Number.isInteger(index) && index >= 0)
        call.anthropicBlocks.set(
          index,
          String(record(data?.["content_block"])?.["type"] ?? "?"),
        );
    }
    if (event.type === "model.end") {
      call.endedAt = at;
      call.stopReason = event.stopReason;
      call.error = event.error?.message.slice(0, 500);
    }
  }
  for (const call of calls.values())
    if (call.contentTypes === undefined && call.anthropicBlocks.size > 0)
      call.contentTypes = [...call.anthropicBlocks]
        .sort(([a], [b]) => a - b)
        .map(([, type]) => type);
  return [...calls.values()];
};

/** Taken under the handler's source ownership, before this claim can emit calls or estimates. */
export type MeasurementBoundary = {
  readonly claim: QueueClaim;
} & (
  | {
      readonly kind: "ready";
      readonly journalAfterSeq: number;
      readonly logFromIndex: number;
    }
  | { readonly kind: "unavailable"; readonly reason: string }
);

const journalProblem = (
  read: ReturnType<typeof readCaptureJournal>,
): string | undefined =>
  read._tag === "Corrupt"
    ? `the capture journal is unreadable at line ${read.line}: ${read.reason}`
    : read._tag === "TooLarge"
      ? `the capture journal is ${read.size} bytes, over the ${read.limit} a read may take`
      : read.tornLines > 0
        ? "the capture journal has torn lines"
        : undefined;

export const beginNativeMeasurements = (
  log: RunLog,
  journal: string,
  claim: QueueClaim,
): MeasurementBoundary => {
  const read = readCaptureJournal(journal);
  const reason = journalProblem(read);
  return read._tag === "Read" && reason === undefined
    ? {
        kind: "ready",
        claim,
        journalAfterSeq: read.lines.at(-1)?.seq ?? 0,
        logFromIndex: log.read().length,
      }
    : {
        kind: "unavailable",
        claim,
        reason: reason ?? "the capture journal boundary is unavailable",
      };
};

/**
 * Writes the attempt's measurements to the run log. A journal that cannot be read is said instead,
 * since a measurement over part of the calls would read as all of them.
 */
export const writeNativeMeasurements = (
  log: RunLog,
  journal: string,
  effort: RouteConfig["effort"],
  boundary: MeasurementBoundary,
) => {
  const read = readCaptureJournal(journal);
  const reason =
    boundary.kind === "unavailable" ? boundary.reason : journalProblem(read);
  if (
    boundary.kind !== "ready" ||
    read._tag !== "Read" ||
    reason !== undefined ||
    read.lines.length < boundary.journalAfterSeq ||
    log.read().length < boundary.logFromIndex
  ) {
    log.write({
      type: "measurement",
      name: "unavailable",
      claim: boundary.claim,
      reason:
        reason ??
        "the attempt boundary is beyond the retained journal or run log",
    });
    return;
  }
  // A call belongs to the claim that started it. Earlier requests whose end arrives in this
  // claim are excluded; calls without an end retain unknown latency rather than a fabricated zero.
  const calls = callsOf(
    read.lines.filter((line) => line.seq > boundary.journalAfterSeq),
  );
  log.write({
    type: "measurement.boundary",
    claim: boundary.claim,
    journalAfterSeq: boundary.journalAfterSeq,
    journalThroughSeq: read.lines.at(-1)?.seq ?? 0,
    logFromIndex: boundary.logFromIndex,
  });
  log.write({
    type: "measurement",
    name: "strict-flag",
    requests: calls.length,
    strictValues: [
      ...new Set(
        calls.flatMap((c) => c.shape.tools.map((t) => String(t.strict))),
      ),
    ],
    statuses: [...new Set(calls.map((c) => c.status))],
    headerNames: [...new Set(calls.flatMap((c) => c.headerNames))].sort(),
    keywordsSent: [
      ...new Set(calls.flatMap((c) => c.shape.toolSchemaKeywords)),
    ].sort(),
  });
  log.write({
    type: "measurement",
    name: "final-generation-wire",
    requests: calls
      .filter((c) => c.shape.outputFormat === "json_schema")
      .map((c) => ({
        agent: c.agent,
        status: c.status,
        toolChoice: c.shape.toolChoice,
        toolsSent: c.shape.tools.map((t) => t.name),
        outputFormat: c.shape.outputFormat,
        outputFormatKeywords: c.shape.outputFormatKeywords,
        stopReason: c.stopReason,
        contentTypes: c.contentTypes,
        error: c.error,
      })),
  });
  const byAgent = new Map<string, Array<Call>>();
  for (const call of calls)
    byAgent.set(call.agent, [...(byAgent.get(call.agent) ?? []), call]);
  log.write({
    type: "measurement",
    name: "thinking-and-append-only",
    agents: [...byAgent].map(([agent, requests]) => ({
      agent,
      messageCounts: requests.map((r) => r.shape.messages),
      appendOnly: requests.every(
        (r, index) =>
          index === 0 || r.shape.messages > requests[index - 1]!.shape.messages,
      ),
      signedThinkingReplayed: requests.some((r) =>
        r.shape.assistantBlocks.some((blocks) =>
          blocks.some(
            (block) =>
              block === "thinking(signed)" || block === "reasoning(encrypted)",
          ),
        ),
      ),
      thinkingBeforeToolUse: requests.some((r) =>
        r.shape.assistantBlocks.some((blocks) => {
          const thinking = blocks.findIndex(isThinking);
          const tool = blocks.findIndex(isToolCall);
          return thinking !== -1 && tool !== -1 && thinking < tool;
        }),
      ),
      responseBlockTypes: requests.map((r) => r.contentTypes ?? []),
      errors: requests
        .filter((r) => (r.status ?? 0) >= 400)
        .map((r) => r.error),
    })),
  });
  const latencies = calls
    .flatMap((c) => (c.endedAt === undefined ? [] : [c.endedAt - c.at]))
    .sort((a, b) => a - b);
  log.write({
    type: "measurement",
    name: "turn-latency",
    effort,
    turns: latencies.length,
    medianMs: quantile(latencies, 0.5),
    p90Ms: quantile(latencies, 0.9),
    meanMs:
      latencies.length === 0
        ? null
        : Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
    note: "each provider call's time from its request to its end, as the capture journal recorded them; pi's retries are separate calls",
  });
  const estimates = log
    .read()
    .slice(boundary.logFromIndex)
    .filter((entry) => entry.type === "estimate");
  log.write({
    type: "measurement",
    name: "estimate-calibration",
    rule: "bytes ÷ 3 × 1.3 (UN9)",
    samples: estimates.map((e) => ({
      label: e["label"],
      bytes: e["bytes"],
      estimate: e["estimate"],
      counted: e["counted"],
      ratio: e["ratio"],
    })),
  });
};

const Attempts = z.object({
  generations: z.record(z.string(), z.array(z.number().int().positive())),
});

/** Reconcile the native source into telemetry after producers have joined, including failed runs and reopen. */
export const writeNativeAttempts = async (
  log: RunLog,
  reads: NativeReads,
  context: Context,
) => {
  const page = await reads.scanDocuments(
    {
      scope: { kind: "session" },
      at: "current",
      kind: NativeAttemptsDoc.definition.kind,
    },
    1,
    undefined,
    context,
  );
  const record = page.items[0];
  if (record === undefined) return;
  const stored = await reads.document(record.id, "current", context);
  const attempts = readData(Attempts, stored?.value);
  const seen = new Set(
    log
      .read()
      .filter((entry) => entry.type === "model.native-attempt")
      .map((entry) => entry["id"]),
  );
  for (const [generation, values] of Object.entries(attempts.generations))
    for (const attempt of values) {
      const id = `${generation}:${attempt}`;
      if (seen.has(id)) continue;
      log.write({
        type: "model.native-attempt",
        id,
        generation,
        attempt,
        retry: attempt > 1,
      });
      seen.add(id);
    }
};
