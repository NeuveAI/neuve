import { safeRead } from "@neuve/records-schema";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { Clock, Data, Effect, Option } from "effect";
import { FileSystem } from "effect/FileSystem";
import { SqlClient } from "effect/sql/SqlClient";
import { z } from "zod";
import {
  RecordEvent,
  TokenUsage,
  TranscriptCapturePayload,
  TranscriptSummary,
} from "@neuve/records-schema";
import { BlobStore } from "./blobs.ts";
import { canonicalJson, sha256Bytes } from "./canonical.ts";
import { decodeEnvelope } from "./codec.ts";
import { ComputationStore, type ComputationSpec } from "./computations.ts";
import { CorruptRecord } from "./errors.ts";
import { agentFingerprint } from "./identity.ts";
import { mintUlid } from "./ids.ts";
import { append, get, type AppendResult } from "./log.ts";
import type { Job } from "./queue.ts";

/**
 * Transcript capture (proposal §6, D25, 8.10). A turn's end, or a session's end, records the
 * transcript's size at that moment. The `transcript.capture` job copies the segment between the
 * previous such offset of the same transcript and this one into a `raw-capture` blob, which the
 * 30-day pruner may delete, summarizes it through the `transcript.summary` computation (durable, keyed
 * by the blob's hash), and records `turn.summarized` with the token figures, referencing both. Prompt
 * text exists only in the raw blob; the summary and the event hold counts and the model name.
 *
 * Segment bounds come from the log, never from the order jobs run in, so captures are repeatable and
 * consecutive segments tile the transcript: per-agent totals are exact once the session's end is
 * captured. A harness may append a turn's last lines after its stop hook ran; those land in the next
 * segment, so per-turn figures can shift by those lines while totals stay exact.
 */
export const TRANSCRIPT_MEDIA_TYPE = "application/jsonl";
// 2: Claude Code responses split across segments are counted once; sidechain rows are skipped in a
// session's own transcript. 3: what counts as already counted comes from the whole prefix (rows of
// one response split by tool results, responses re-written after a compaction).
export const SUMMARY_OP = { op: "transcript.summary", opVersion: 3 } as const;

/** The transcript file cannot be read. */
export class TranscriptUnavailable extends Data.TaggedError(
  "TranscriptUnavailable",
)<{
  readonly path: string;
  readonly message: string;
}> {}

/**
 * The transcript no longer holds what earlier captures read: it is shorter than a recorded offset, or
 * the bytes before the previous segment's end changed. It was replaced or truncated, not appended to.
 */
export class TranscriptRewritten extends Data.TaggedError(
  "TranscriptRewritten",
)<{
  readonly path: string;
  readonly message: string;
}> {
  /** Retrying cannot help; the job ends at once (see `Worker.describeFailure`). */
  readonly retryable = false;
}

/**
 * The event names a transcript other than the one its session recorded when it started (or, for a
 * subagent, a file outside that transcript's folder), or its session recorded none. Captures read
 * only the session's own transcripts.
 */
export class TranscriptPathRefused extends Data.TaggedError(
  "TranscriptPathRefused",
)<{
  readonly path: string;
  readonly message: string;
}> {
  /** Retrying cannot help; the job ends at once (see `Worker.describeFailure`). */
  readonly retryable = false;
}

/** The job names no event, or one that does not record a transcript offset. */
export class InvalidCaptureSource extends Data.TaggedError(
  "InvalidCaptureSource",
)<{
  readonly message: string;
}> {
  /** Retrying cannot help; the job ends at once (see `Worker.describeFailure`). */
  readonly retryable = false;
}

/** No summarizer exists for the harness that wrote the transcript. */
export class UnsupportedHarness extends Data.TaggedError("UnsupportedHarness")<{
  readonly harness: string;
  readonly message: string;
}> {
  /** Retrying cannot help; the job ends at once (see `Worker.describeFailure`). */
  readonly retryable = false;
}

// ----- Summaries ---------------------------------------------------------------------------------

const count = z.number().int().min(0).catch(0);

const jsonLine = (line: string): unknown => {
  if (line.trim() === "") return undefined;
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
};

const jsonLines = (text: string) =>
  text.split("\n").flatMap((line) => {
    const json = jsonLine(line);
    return json === undefined ? [] : [json];
  });

const spanMs = (timestamps: ReadonlyArray<string | undefined>) => {
  const times = timestamps
    .map((at) => (at === undefined ? Number.NaN : Date.parse(at)))
    .filter((at) => Number.isFinite(at));
  if (times.length === 0) return undefined;
  return Math.max(0, Math.max(...times) - Math.min(...times));
};

const defined = <T extends Record<string, unknown>>(value: T) =>
  Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as T;

/** A model name the summary can keep; an empty or overlong one is dropped, never fatal. */
const modelName = TranscriptSummary.shape.model;
const keptModel = (model: string | undefined) =>
  modelName.safeParse(model).data ?? undefined;

const ClaudeUsage = z.looseObject({
  input_tokens: count,
  cache_creation_input_tokens: count,
  cache_read_input_tokens: count,
  output_tokens: count,
});

/** The fields of a Claude Code transcript line a summary reads; everything else is ignored. */
const ClaudeLine = z.looseObject({
  type: z.string().optional().catch(undefined),
  timestamp: z.string().optional().catch(undefined),
  isSidechain: z.boolean().optional().catch(undefined),
  message: z
    .looseObject({
      id: z.string().optional().catch(undefined),
      model: z.string().optional().catch(undefined),
      usage: ClaudeUsage.optional().catch(undefined),
      content: z
        .array(
          z.looseObject({
            type: z.string().optional().catch(undefined),
            id: z.string().optional().catch(undefined),
          }),
        )
        .optional()
        .catch(undefined),
    })
    .optional()
    .catch(undefined),
});
type ClaudeLine = z.infer<typeof ClaudeLine>;

/** The fields of a Claude Code row the prefix scan reads; content is left unvalidated. */
const ClaudeUsageRow = z.looseObject({
  type: z.string().optional().catch(undefined),
  isSidechain: z.boolean().optional().catch(undefined),
  message: z
    .looseObject({
      id: z.string().optional().catch(undefined),
      usage: ClaudeUsage.optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
});
type ClaudeUsageRow = z.infer<typeof ClaudeUsageRow>;

const claudeUsage = (line: ClaudeUsageRow): TokenUsage | undefined => {
  const usage = line.message?.usage;
  if (usage === undefined) return undefined;
  return {
    input: usage.input_tokens,
    cacheCreation: usage.cache_creation_input_tokens,
    cacheRead: usage.cache_read_input_tokens,
    output: usage.output_tokens,
  };
};

/**
 * What earlier segments already counted of the responses a Claude Code segment continues: for each
 * response ID, the usage of its row with the most output tokens before the segment. Keys are response
 * IDs that also appear in the segment, so the record is small and part of the computation's inputs.
 */
export const ClaudeCounted = z.record(z.string(), TokenUsage);
export type ClaudeCounted = z.infer<typeof ClaudeCounted>;

export interface ClaudeOptions {
  /** A session's own transcript: rows of subagents written into it (`isSidechain`) are theirs. */
  readonly skipSidechain: boolean;
  readonly counted: ClaudeCounted;
}

/** Whether a parsed row counts toward this transcript's actor. */
const ownRow = (line: ClaudeUsageRow, skipSidechain: boolean) =>
  !(skipSidechain && line.isSidechain === true);

/**
 * Claude Code writes one transcript row per content block of a streamed response, each repeating the
 * response's `message.id` and usage; the row with the most output tokens holds the final count
 * (entire-cli `CalculateTokenUsage`). A response whose rows began before the segment was counted
 * there, so only what grew since `counted` is added, and it is not a new model call. `input` excludes
 * cache reads and writes, as the API reports it.
 */
export const summarizeClaudeCode = (
  text: string,
  options: ClaudeOptions,
): TranscriptSummary => {
  const usageById = new Map<string, TokenUsage>();
  const toolUses = new Set<string>();
  const timestamps: Array<string | undefined> = [];
  let model: string | undefined;
  let lines = 0;
  for (const json of jsonLines(text)) {
    lines += 1;
    const parsed = ClaudeLine.safeParse(json);
    if (!parsed.success) continue;
    const line = parsed.data;
    if (!ownRow(line, options.skipSidechain)) continue;
    timestamps.push(line.timestamp);
    const message = line.message;
    if (line.type !== "assistant" || message === undefined) continue;
    if (message.model !== undefined && message.model !== "<synthetic>")
      model = keptModel(message.model) ?? model;
    for (const block of message.content ?? [])
      if (block.type === "tool_use" && block.id !== undefined)
        toolUses.add(block.id);
    const usage = claudeUsage(line);
    if (message.id === undefined || usage === undefined) continue;
    const held = usageById.get(message.id);
    if (held === undefined || usage.output > held.output)
      usageById.set(message.id, usage);
  }
  const tokens: TokenUsage = {
    input: 0,
    cacheCreation: 0,
    cacheRead: 0,
    output: 0,
  };
  let apiCalls = 0;
  for (const [id, usage] of usageById) {
    const before = options.counted[id];
    if (before === undefined) apiCalls += 1;
    tokens.input += Math.max(0, usage.input - (before?.input ?? 0));
    tokens.cacheCreation += Math.max(
      0,
      usage.cacheCreation - (before?.cacheCreation ?? 0),
    );
    tokens.cacheRead += Math.max(0, usage.cacheRead - (before?.cacheRead ?? 0));
    tokens.output += Math.max(0, usage.output - (before?.output ?? 0));
  }
  return TranscriptSummary.parse(
    defined({
      model,
      tokens,
      apiCalls,
      toolCalls: toolUses.size,
      durationMs: spanMs(timestamps),
      lines,
    }),
  );
};

/** The response IDs a Claude Code segment's own assistant rows carry. */
const claudeResponseIds = (text: string, skipSidechain: boolean) => {
  const ids = new Set<string>();
  for (const json of jsonLines(text)) {
    const parsed = ClaudeLine.safeParse(json);
    if (!parsed.success || !ownRow(parsed.data, skipSidechain)) continue;
    const id = parsed.data.message?.id;
    if (parsed.data.type === "assistant" && id !== undefined) ids.add(id);
  }
  return ids;
};

/** Codex's cumulative usage snapshot (`event_msg` / `token_count` / `info.total_token_usage`). */
export const CodexTotals = z.strictObject({
  input: z.int().min(0),
  cachedInput: z.int().min(0),
  output: z.int().min(0),
  reasoningOutput: z.int().min(0),
});
export type CodexTotals = z.infer<typeof CodexTotals>;

const CodexLine = z.looseObject({
  type: z.string().optional().catch(undefined),
  timestamp: z.string().optional().catch(undefined),
  payload: z
    .looseObject({
      type: z.string().optional().catch(undefined),
      model: z.string().optional().catch(undefined),
      info: z
        .looseObject({
          total_token_usage: z
            .looseObject({
              input_tokens: count,
              cached_input_tokens: count,
              output_tokens: count,
              reasoning_output_tokens: count,
            })
            .optional()
            .catch(undefined),
        })
        .nullish()
        .catch(undefined),
    })
    .optional()
    .catch(undefined),
});

const codexTotals = (json: unknown): CodexTotals | undefined => {
  const parsed = CodexLine.safeParse(json);
  if (!parsed.success) return undefined;
  const { type, payload } = parsed.data;
  if (type !== "event_msg" || payload?.type !== "token_count") return undefined;
  const total = payload.info?.total_token_usage;
  if (total === undefined) return undefined;
  return {
    input: total.input_tokens,
    cachedInput: total.cached_input_tokens,
    output: total.output_tokens,
    reasoningOutput: total.reasoning_output_tokens,
  };
};

/** The Codex snapshot a line holds, if it is a token count; used to find a segment's baseline. */
export const codexTotalsOfLine = (line: string): CodexTotals | undefined =>
  line.includes('"token_count"') ? codexTotals(jsonLine(line)) : undefined;

const CODEX_TOOL_ITEMS = new Set([
  "function_call",
  "custom_tool_call",
  "local_shell_call",
  "web_search_call",
]);

/**
 * Codex reports cumulative usage, so a segment's tokens are its last snapshot minus the last snapshot
 * before it (`baseline`), as entire-cli computes them. `input` excludes cached input. A repeated
 * snapshot (a rate-limit update) is not a new model call.
 */
export const summarizeCodex = (
  text: string,
  baseline: CodexTotals | undefined,
): TranscriptSummary => {
  const timestamps: Array<string | undefined> = [];
  let model: string | undefined;
  let last: CodexTotals | undefined;
  let previous = baseline;
  let apiCalls = 0;
  let toolCalls = 0;
  let lines = 0;
  for (const json of jsonLines(text)) {
    lines += 1;
    const parsed = CodexLine.safeParse(json);
    if (!parsed.success) continue;
    const { type, payload, timestamp } = parsed.data;
    timestamps.push(timestamp);
    if (type === "turn_context" && payload?.model !== undefined)
      model = keptModel(payload.model) ?? model;
    if (
      type === "response_item" &&
      payload?.type !== undefined &&
      CODEX_TOOL_ITEMS.has(payload.type)
    )
      toolCalls += 1;
    const totals = codexTotals(json);
    if (totals === undefined) continue;
    if (
      previous === undefined ||
      canonicalJson(previous) !== canonicalJson(totals)
    )
      apiCalls += 1;
    previous = totals;
    last = totals;
  }
  const base = baseline ?? {
    input: 0,
    cachedInput: 0,
    output: 0,
    reasoningOutput: 0,
  };
  const end = last ?? base;
  const input = Math.max(0, end.input - base.input);
  const cached = Math.max(0, end.cachedInput - base.cachedInput);
  return TranscriptSummary.parse(
    defined({
      model,
      tokens: {
        input: Math.max(0, input - cached),
        cacheCreation: 0,
        cacheRead: cached,
        output: Math.max(0, end.output - base.output),
      },
      reasoningOutput: Math.max(0, end.reasoningOutput - base.reasoningOutput),
      apiCalls,
      toolCalls,
      durationMs: spanMs(timestamps),
      lines,
    }),
  );
};

// ----- Reading a segment -------------------------------------------------------------------------

const CHUNK = 65_536;
const NEWLINE = 10;
/** How many of a segment's last bytes the next capture checks (see `TurnSummarized.tail`). */
export const TAIL_BYTES = 256;

/** An open transcript: its size when opened and reads by position. */
interface Transcript {
  readonly size: number;
  readonly read: (
    position: number,
    length: number,
  ) => Effect.Effect<Uint8Array, TranscriptUnavailable>;
}

/**
 * Opens a transcript for reading. Effect's `FileSystem` has no `O_NOFOLLOW`, so this uses the
 * platform call directly: the last path component must not be a symbolic link, `O_NONBLOCK` keeps a
 * FIFO from blocking the open, and the type check runs on the opened handle (`fstat`), so nothing can
 * be swapped in between a check and the open.
 */
const openTranscript = (path: string) => {
  const unavailable = (cause: unknown) =>
    new TranscriptUnavailable({
      path,
      message: cause instanceof Error ? cause.message : String(cause),
    });
  return Effect.gen(function* () {
    const handle = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          open(
            path,
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          ),
        catch: unavailable,
      }),
      (handle) => Effect.promise(() => handle.close()),
    );
    const info = yield* Effect.tryPromise({
      try: () => handle.stat(),
      catch: unavailable,
    });
    if (!info.isFile())
      return yield* new TranscriptUnavailable({
        path,
        message: "not a regular file",
      });
    const read = (position: number, length: number) =>
      Effect.tryPromise({
        try: async () => {
          const buffer = new Uint8Array(length);
          let filled = 0;
          while (filled < length) {
            const { bytesRead } = await handle.read(
              buffer,
              filled,
              length - filled,
              position + filled,
            );
            if (bytesRead === 0) break;
            filled += bytesRead;
          }
          return buffer.subarray(0, filled);
        },
        catch: unavailable,
      });
    return { size: info.size, read } satisfies Transcript;
  });
};

/** The start of the line that byte `offset` falls in: `offset` itself when a line ends just before it. */
const lineStart = (transcript: Transcript, offset: number) =>
  Effect.gen(function* () {
    let end = offset;
    while (end > 0) {
      const from = Math.max(0, end - CHUNK);
      const chunk = yield* transcript.read(from, end - from);
      const newline = chunk.lastIndexOf(NEWLINE);
      if (newline >= 0) return from + newline + 1;
      end = from;
    }
    return 0;
  });

/**
 * Visits the whole lines before `before` (a line start), last first, until `visit` returns true.
 */
const scanBackward = (
  transcript: Transcript,
  before: number,
  visit: (line: string) => boolean,
) =>
  Effect.gen(function* () {
    const decoder = new TextDecoder();
    let end = before;
    let carry = new Uint8Array(0);
    while (end > 0) {
      const from = Math.max(0, end - CHUNK);
      const chunk = yield* transcript.read(from, end - from);
      const buffer = new Uint8Array(chunk.byteLength + carry.byteLength);
      buffer.set(chunk);
      buffer.set(carry, chunk.byteLength);
      let lineEnd = buffer.byteLength;
      for (let index = buffer.byteLength - 1; index >= 0; index -= 1) {
        if (buffer[index] !== NEWLINE) continue;
        if (visit(decoder.decode(buffer.subarray(index + 1, lineEnd)))) return;
        lineEnd = index;
      }
      carry = buffer.slice(0, lineEnd);
      end = from;
    }
    if (carry.byteLength > 0) visit(decoder.decode(carry));
  });

/** The last cumulative Codex snapshot before the segment. */
const codexBaseline = (transcript: Transcript, before: number) =>
  Effect.gen(function* () {
    let found: CodexTotals | undefined;
    yield* scanBackward(transcript, before, (line) => {
      found = codexTotalsOfLine(line);
      return found !== undefined;
    });
    return found;
  });

const PREFIX_CHUNK = 4 * 1_048_576;
const ASSISTANT_MARKER = new TextEncoder().encode('"type":"assistant"');

/**
 * The usage already counted, before the segment, for the responses the segment holds. Claude Code
 * writes a response's rows apart (tool results interleave) and re-writes earlier responses after a
 * compaction, with the same ID and usage, so the whole prefix is scanned: a response is counted once
 * per transcript wherever its rows fall. Only rows holding `"type":"assistant"` are decoded and
 * parsed; on a 465 MB transcript the scan takes about 0.2 s (M2 S5 measurement).
 */
const claudeCountedBefore = (
  transcript: Transcript,
  before: number,
  ids: ReadonlySet<string>,
  skipSidechain: boolean,
) =>
  Effect.gen(function* () {
    const counted: Record<string, TokenUsage> = {};
    if (ids.size === 0 || before === 0) return counted;
    const decoder = new TextDecoder();
    const visit = (row: Uint8Array) => {
      if (
        Buffer.from(row.buffer, row.byteOffset, row.byteLength).indexOf(
          ASSISTANT_MARKER,
        ) < 0
      )
        return;
      const parsed = ClaudeUsageRow.safeParse(jsonLine(decoder.decode(row)));
      if (!parsed.success || !ownRow(parsed.data, skipSidechain)) return;
      const line = parsed.data;
      const id = line.message?.id;
      const usage = claudeUsage(line);
      if (
        line.type !== "assistant" ||
        id === undefined ||
        !ids.has(id) ||
        usage === undefined
      )
        return;
      const held = counted[id];
      if (held === undefined || usage.output > held.output) counted[id] = usage;
    };
    let position = 0;
    let carry = new Uint8Array(0);
    while (position < before) {
      const chunk = yield* transcript.read(
        position,
        Math.min(PREFIX_CHUNK, before - position),
      );
      if (chunk.byteLength === 0) break;
      position += chunk.byteLength;
      const buffer = new Uint8Array(carry.byteLength + chunk.byteLength);
      buffer.set(carry);
      buffer.set(chunk, carry.byteLength);
      let start = 0;
      for (
        let index = buffer.indexOf(NEWLINE);
        index >= 0;
        index = buffer.indexOf(NEWLINE, start)
      ) {
        visit(buffer.subarray(start, index));
        start = index + 1;
      }
      carry = buffer.slice(start);
    }
    // `before` is a line start, so nothing is left over; a final line without a newline still counts.
    if (carry.byteLength > 0) visit(carry);
    return counted;
  });

/** What the previous capture of this transcript recorded about where it ended. */
export interface PreviousTail {
  readonly toOffset: number;
  readonly bytes: number;
  readonly sha256: string;
}

export interface SegmentOptions {
  readonly harness: string;
  /** A session's own transcript (not a subagent's): its sidechain rows are skipped. */
  readonly skipSidechain: boolean;
  readonly previousTail: PreviousTail | undefined;
}

export interface Segment {
  readonly fromOffset: number;
  readonly toOffset: number;
  readonly bytes: Uint8Array;
  readonly tail: { readonly bytes: number; readonly sha256: string };
  /** What the summary needs from before the segment, by harness; part of its computation inputs. */
  readonly before:
    | { readonly codex: CodexTotals | undefined }
    | { readonly claudeCounted: ClaudeCounted }
    | undefined;
}

/**
 * Reads whole lines between two recorded offsets. Each offset moves back to the start of the line it
 * falls in, so a line still being written when a hook ran belongs to the next segment, and the same
 * file always yields the same segment. When the previous capture recorded its tail, those bytes must
 * still be there, or the transcript was rewritten.
 */
export const readSegment = (
  path: string,
  from: number,
  to: number,
  options: SegmentOptions,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const transcript = yield* openTranscript(path);
      const rewritten = (message: string) =>
        new TranscriptRewritten({ path, message });
      if (transcript.size < to || to < from)
        return yield* rewritten(
          `the transcript holds ${transcript.size} bytes; offsets ${from} to ${to} were recorded`,
        );
      const fromOffset = yield* lineStart(transcript, from);
      const toOffset = yield* lineStart(transcript, to);
      const previous = options.previousTail;
      if (previous !== undefined) {
        const tail = yield* transcript.read(
          previous.toOffset - previous.bytes,
          previous.bytes,
        );
        if (
          previous.toOffset !== fromOffset ||
          sha256Bytes(tail) !== previous.sha256
        )
          return yield* rewritten(
            `the ${previous.bytes} bytes before offset ${previous.toOffset} no longer match what the previous capture read`,
          );
      }
      const bytes = yield* transcript.read(fromOffset, toOffset - fromOffset);
      const tailBytes = bytes.subarray(
        Math.max(0, bytes.byteLength - TAIL_BYTES),
      );
      const text = new TextDecoder().decode(bytes);
      const before =
        options.harness === "codex"
          ? { codex: yield* codexBaseline(transcript, fromOffset) }
          : options.harness === "claude-code"
            ? {
                claudeCounted: yield* claudeCountedBefore(
                  transcript,
                  fromOffset,
                  claudeResponseIds(text, options.skipSidechain),
                  options.skipSidechain,
                ),
              }
            : undefined;
      return {
        fromOffset,
        toOffset,
        bytes,
        tail: { bytes: tailBytes.byteLength, sha256: sha256Bytes(tailBytes) },
        before,
      } satisfies Segment;
    }),
  );

// ----- The job -----------------------------------------------------------------------------------

type Boundary = Extract<
  RecordEvent,
  { kind: "turn.ended@1" } | { kind: "session.ended@1" }
>;

/** The latest earlier turn or session end of the same actor and transcript that recorded an offset. */
const previousBoundary = (event: Boundary, path: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const [row] = yield* sql<{ envelope: string }>`SELECT envelope FROM events
      WHERE kind IN ('turn.ended@1', 'session.ended@1') AND actor_id = ${event.actor} AND id < ${event.id}
        AND json_extract(envelope, '$.payload.transcriptPath') = ${path}
        AND json_extract(envelope, '$.payload.transcriptOffset') IS NOT NULL
      ORDER BY id DESC LIMIT 1`;
    const previous =
      row === undefined
        ? undefined
        : yield* decodeEnvelope(row.envelope, "previous boundary");
    return previous?.kind === "turn.ended@1" ||
      previous?.kind === "session.ended@1"
      ? previous
      : undefined;
  });

/** Where the previous segment's summary says it ended, if that segment was captured. */
const previousTail = (previous: Boundary | undefined) =>
  Effect.gen(function* () {
    if (previous === undefined) return undefined;
    const sql = yield* SqlClient;
    const [row] = yield* sql<{ envelope: string }>`SELECT envelope FROM events
      WHERE idempotency_key = ${summaryKey(previous.id)}`;
    if (row === undefined) return undefined;
    const summary = yield* decodeEnvelope(row.envelope, "previous summary");
    if (summary.kind !== "turn.summarized@1") return undefined;
    const tail: PreviousTail = {
      toOffset: summary.payload.toOffset,
      bytes: summary.payload.tail.bytes,
      sha256: summary.payload.tail.sha256,
    };
    return tail;
  });

/** Where the turn's prompt began in the transcript, when its start hook recorded it. */
const turnStartOffset = (event: Boundary, path: string) =>
  Effect.gen(function* () {
    const turnKey = event.attribution.turnKey;
    if (event.kind !== "turn.ended@1" || turnKey === undefined)
      return undefined;
    const sql = yield* SqlClient;
    const rows = yield* sql<{ envelope: string }>`SELECT envelope FROM events
      WHERE kind = 'turn.started@1' AND actor_id = ${event.actor}
        AND json_extract(envelope, '$.attribution.turnKey') = ${turnKey}
      ORDER BY id`;
    for (const row of rows) {
      const started = yield* decodeEnvelope(row.envelope, "turn start");
      if (
        started.kind === "turn.started@1" &&
        started.payload.transcriptPath === path &&
        started.payload.transcriptOffset !== undefined
      )
        return started.payload.transcriptOffset;
    }
    return undefined;
  });

/**
 * Where a harness keeps this repository's session transcripts, for sessions whose start the hooks
 * missed (8.15). `claudeCodeProjects` lists Claude Code's project folders for the repository's
 * worktrees; it is read only when such a session's turn reports a transcript.
 */
export interface TranscriptHome {
  readonly claudeCodeProjects: Effect.Effect<ReadonlyArray<string>>;
}

/** No folders: without a recorded start, every transcript path is refused. */
export const NO_TRANSCRIPT_HOME: TranscriptHome = {
  claudeCodeProjects: Effect.succeed([]),
};

/** Claude Code's longest project folder name; longer ones end in a runtime hash Records cannot derive. */
const CLAUDE_PROJECT_NAME_MAX = 200;

/**
 * The project folder name Claude Code derives from the directory a session runs in: every character
 * other than an ASCII letter or digit becomes `-` (so `/Users/me/code/neuve` is
 * `-Users-me-code-neuve`). Names longer than 200 characters get a hash suffix and are not derived.
 */
export const claudeCodeProjectName = (directory: string) => {
  const name = directory.replace(/[^a-zA-Z0-9]/g, "-");
  return name.length <= CLAUDE_PROJECT_NAME_MAX ? name : undefined;
};

/** Claude Code's configuration folder: `CLAUDE_CONFIG_DIR`, or `~/.claude`. */
export const claudeCodeConfigDirectory = () =>
  process.env["CLAUDE_CONFIG_DIR"] || join(homedir(), ".claude");

/**
 * Claude Code's project folders for every worktree of the repository whose git common directory is
 * given: `<config>/projects/<project name>`, for each worktree path as git lists it and as its real
 * path. A worktree whose name cannot be derived, or a failed listing, adds nothing.
 */
export const claudeCodeProjectFolders = (
  gitCommonDirectory: string,
  configDirectory: string = claudeCodeConfigDirectory(),
) =>
  Effect.promise(async () => {
    try {
      const child = Bun.spawn(
        [
          "git",
          "--git-dir",
          gitCommonDirectory,
          "worktree",
          "list",
          "--porcelain",
          "-z",
        ],
        { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
      );
      const [stdout, code] = await Promise.all([
        new Response(child.stdout).text(),
        child.exited,
      ]);
      if (code !== 0) return [] as ReadonlyArray<string>;
      const directories = new Set<string>();
      for (const field of stdout.split("\u0000")) {
        if (!field.startsWith("worktree ")) continue;
        const worktree = field.slice("worktree ".length);
        directories.add(worktree);
        try {
          directories.add(await realpath(worktree));
        } catch {
          // A worktree that no longer exists keeps the path git lists.
        }
      }
      const folders = new Set<string>();
      for (const directory of directories) {
        const name = claudeCodeProjectName(directory);
        if (name !== undefined)
          folders.add(join(configDirectory, "projects", name));
      }
      return [...folders] as ReadonlyArray<string>;
    } catch {
      return [] as ReadonlyArray<string>;
    }
  });

/** A Claude Code session ID as its transcript file is named: no separators, no dots. */
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * A session whose start the hooks missed recorded no transcript (8.15). Its turn's transcript is
 * accepted only for Claude Code, only for the session's own actor (not a subagent), and only when the
 * path is exactly `<Claude Code project folder of a worktree of this repository>/<session ID>.jsonl`
 * and resolves to itself, so no component is a symbolic link; the open adds `O_NOFOLLOW`. Codex is
 * refused until its layout is verified. Returns `true`: the file is the session's own transcript.
 */
const ownTranscriptWithoutStart = (
  event: Boundary,
  path: string,
  home: TranscriptHome,
) =>
  Effect.gen(function* () {
    const sessionId = event.attribution.sessionId;
    const harness = event.payload.harness;
    const refuse = (message: string) =>
      new TranscriptPathRefused({ path, message });
    const noStart = `session ${sessionId} recorded no transcript when it started`;
    if (harness !== "claude-code")
      return yield* refuse(
        `${noStart}; without one, only Claude Code transcripts are accepted (8.15)`,
      );
    if (event.actor !== agentFingerprint({ harness, sessionId }))
      return yield* refuse(
        `${noStart}; without one, only the session's own turns are captured, not a subagent's`,
      );
    if (!SAFE_SESSION_ID.test(sessionId))
      return yield* refuse(
        `${noStart}; its session ID cannot name a transcript file`,
      );
    const expected = (yield* home.claudeCodeProjects).map((folder) =>
      join(folder, `${sessionId}.jsonl`),
    );
    if (!expected.includes(path))
      return yield* refuse(
        `${noStart}; without one, only the session's own transcript in this repository's Claude Code project folder is accepted${expected.length === 0 ? " (none could be named)" : `: ${expected.join(" or ")}`}`,
      );
    const fs = yield* FileSystem;
    const real = yield* Effect.option(fs.realPath(path));
    if (Option.isNone(real) || real.value !== path)
      return yield* refuse(
        `${noStart}; the transcript must be reached without symbolic links`,
      );
    return true;
  });

/**
 * Confines a capture to the session's own transcripts: the path its session recorded at start (any of
 * them, for a resumed session), or, for a subagent, a file inside that transcript's folder, where
 * harnesses keep subagent transcripts. A session whose start recorded no transcript is confined by
 * `ownTranscriptWithoutStart` (8.15). Returns whether the path is the session's own transcript.
 */
const confine = (event: Boundary, path: string, home: TranscriptHome) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient;
    const rows = yield* sql<{ envelope: string }>`SELECT envelope FROM events
      WHERE kind = 'session.started@1'
        AND json_extract(envelope, '$.attribution.sessionId') = ${event.attribution.sessionId}
        AND json_extract(envelope, '$.payload.harness') = ${event.payload.harness}
      ORDER BY id`;
    const recorded: Array<{ actor: string; path: string }> = [];
    for (const row of rows) {
      const started = yield* decodeEnvelope(row.envelope, "session start");
      if (
        started.kind === "session.started@1" &&
        started.payload.transcriptPath !== undefined
      )
        recorded.push({
          actor: started.actor,
          path: started.payload.transcriptPath,
        });
    }
    const refuse = (message: string) =>
      new TranscriptPathRefused({ path, message });
    if (recorded.length === 0)
      return yield* ownTranscriptWithoutStart(event, path, home);
    const own = recorded.filter((entry) => entry.actor === event.actor);
    if (own.length > 0) {
      if (own.some((entry) => entry.path === path)) return true;
      return yield* refuse(
        `the session recorded ${own[0]?.path} as its transcript when it started`,
      );
    }
    // Claude Code keeps a session's subagent transcripts in `<session transcript without .jsonl>/subagents/`.
    // The real path must be that folder under the real folder of the session's transcript, so neither
    // another session's transcript nor a path through a symbolic link is read.
    const fs = yield* FileSystem;
    const real = yield* Effect.option(fs.realPath(path));
    for (const entry of recorded) {
      const folder = join(
        dirname(entry.path),
        basename(entry.path, extname(entry.path)),
        "subagents",
      );
      if (!isAbsolute(path) || dirname(resolve(path)) !== resolve(folder))
        continue;
      const realSession = yield* Effect.option(
        fs.realPath(dirname(entry.path)),
      );
      if (
        Option.isSome(real) &&
        Option.isSome(realSession) &&
        real.value ===
          join(
            realSession.value,
            basename(entry.path, extname(entry.path)),
            "subagents",
            basename(path),
          )
      )
        return false;
    }
    const first = recorded[0]?.path ?? "";
    return yield* refuse(
      `a subagent transcript must be a file in ${join(dirname(first), basename(first, extname(first)), "subagents")}, reached without symbolic links`,
    );
  });

const summaryKey = (eventId: string) => `transcript:${eventId}:summary`;

const summarize = (harness: string, segment: Segment, skipSidechain: boolean) =>
  Effect.gen(function* () {
    const text = new TextDecoder().decode(segment.bytes);
    const before = segment.before;
    if (harness === "claude-code")
      return summarizeClaudeCode(text, {
        skipSidechain,
        counted:
          before !== undefined && "claudeCounted" in before
            ? before.claudeCounted
            : {},
      });
    if (harness === "codex")
      return summarizeCodex(
        text,
        before !== undefined && "codex" in before ? before.codex : undefined,
      );
    return yield* new UnsupportedHarness({
      harness,
      message: `no transcript summarizer for ${harness}`,
    });
  });

/** The summary computation's inputs: the segment by hash plus whatever from before it changes the result. */
const summaryInputs = (
  hash: string,
  harness: string,
  segment: Segment,
  skipSidechain: boolean,
) => {
  const before = segment.before;
  // Typed as JSON so each branch's absent field is absent, never `undefined`, whatever the caller's
  // `exactOptionalPropertyTypes`: the web app typechecks this module without it.
  const extra: ComputationSpec["inputs"] =
    before === undefined
      ? {}
      : "codex" in before
        ? before.codex === undefined
          ? {}
          : { baseline: before.codex }
        : {
            sidechain: skipSidechain ? "skipped" : "counted",
            ...(Object.keys(before.claudeCounted).length === 0
              ? {}
              : { counted: before.claudeCounted }),
          };
  return { transcript: `blob:${hash}`, harness, ...extra };
};

export interface CaptureReport {
  readonly sourceEventId: string;
  readonly segment: { readonly fromOffset: number; readonly toOffset: number };
  readonly blob:
    | {
        readonly hash: string;
        readonly status: "stored" | "existing" | "restored";
        readonly placement: "inline" | "file";
      }
    | undefined;
  readonly summary: "computed" | "reused" | "shared" | undefined;
  readonly event: AppendResult["status"] | undefined;
}

/** A stored summary output; one that no longer parses is a corrupt record, not a new computation. */
const decodeSummary = (bytes: Uint8Array) =>
  Effect.gen(function* () {
    const json = yield* Effect.try({
      try: () => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
      catch: () =>
        new CorruptRecord({ message: "transcript summary is not JSON" }),
    });
    const parsed = safeRead(TranscriptSummary, json);
    if (!parsed.success)
      return yield* new CorruptRecord({
        message: `transcript summary: ${parsed.error.message}`,
      });
    return parsed.data;
  });

const sourceEventId = (job: Job) => {
  if (job.eventId !== null) return Effect.succeed(job.eventId);
  const parsed = safeRead(TranscriptCapturePayload, job.payload);
  return parsed.success
    ? Effect.succeed(parsed.data.eventId)
    : Effect.fail(
        new InvalidCaptureSource({
          message: `job ${job.seq} names no event: ${z.prettifyError(parsed.error)}`,
        }),
      );
};

/** Captures the transcript segment a turn or session end closes, summarizes it, and records it. */
export const captureTranscript = (
  job: Job,
  home: TranscriptHome = NO_TRANSCRIPT_HOME,
) =>
  Effect.gen(function* () {
    const blobs = yield* BlobStore;
    const computations = yield* ComputationStore;
    const eventId = yield* sourceEventId(job);
    const stored = yield* get(eventId);
    const event = Option.getOrUndefined(stored)?.event;
    if (
      event === undefined ||
      (event.kind !== "turn.ended@1" && event.kind !== "session.ended@1")
    )
      return yield* new InvalidCaptureSource({
        message: `event ${eventId} is not a recorded turn or session end`,
      });
    const { transcriptPath: path, transcriptOffset: offset } = event.payload;
    if (path === undefined || offset === undefined)
      return yield* new InvalidCaptureSource({
        message: `event ${eventId} records no transcript offset`,
      });
    const harness = event.payload.harness;
    const skipSidechain = yield* confine(event, path, home);
    const previous = yield* previousBoundary(event, path);
    const from =
      previous?.payload.transcriptOffset ??
      (yield* turnStartOffset(event, path)) ??
      0;
    const segment = yield* readSegment(path, from, offset, {
      harness,
      skipSidechain,
      previousTail: yield* previousTail(previous),
    });
    const bounds = {
      fromOffset: segment.fromOffset,
      toOffset: segment.toOffset,
    };
    if (segment.bytes.byteLength === 0) {
      yield* Effect.logInfo(
        `transcript.capture ${event.kind} ${eventId}: segment [${bounds.fromOffset}, ${bounds.toOffset}) is empty; nothing recorded`,
      );
      return {
        sourceEventId: eventId,
        segment: bounds,
        blob: undefined,
        summary: undefined,
        event: undefined,
      } satisfies CaptureReport;
    }
    const put = yield* blobs.put({
      bytes: segment.bytes,
      mediaType: TRANSCRIPT_MEDIA_TYPE,
      retention: "raw-capture",
    });
    const hash = put.blob.hash;
    const spec: ComputationSpec = {
      ...SUMMARY_OP,
      inputs: summaryInputs(hash, harness, segment, skipSidechain),
    };
    const summarized = yield* computations.run(
      spec,
      Effect.map(summarize(harness, segment, skipSidechain), (summary) => ({
        bytes: new TextEncoder().encode(canonicalJson(summary)),
        mediaType: "application/json",
      })),
    );
    const summary = yield* decodeSummary(summarized.output);
    const turnModel =
      event.kind === "turn.ended@1" ? event.payload.model : undefined;
    const turnKey =
      event.kind === "turn.ended@1"
        ? event.attribution.turnKey
        : previous?.kind === "turn.ended@1"
          ? previous.attribution.turnKey
          : undefined;
    const model = summary.model ?? turnModel;
    const [recorded] = yield* append([
      {
        id: mintUlid(),
        kind: "turn.summarized@1",
        idempotencyKey: summaryKey(event.id),
        actor: event.actor,
        occurredAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
        attribution: {
          sessionId: event.attribution.sessionId,
          ...(turnKey === undefined ? {} : { turnKey }),
        },
        causation: { causedBy: event.id },
        refs: [
          { ref: `blob:${hash}`, role: "transcript" },
          { ref: `computation:${summarized.computation.key}`, role: "summary" },
        ],
        payload: {
          ...summary,
          ...(model === undefined ? {} : { model }),
          harness,
          segment: event.kind === "turn.ended@1" ? "turn" : "session-tail",
          ...bounds,
          tail: segment.tail,
        },
      },
    ]);
    const report: CaptureReport = {
      sourceEventId: eventId,
      segment: bounds,
      blob: { hash, status: put.status, placement: put.blob.placement },
      summary: summarized.status,
      event: recorded?.status,
    };
    yield* Effect.logInfo(
      `transcript.capture ${event.kind} ${eventId}: bytes [${bounds.fromOffset}, ${bounds.toOffset}) -> blob ${hash.slice(0, 12)} ${put.status} ${put.blob.placement} raw-capture; summary ${summarized.computation.key.slice(0, 12)} ${summarized.status}; turn.summarized ${recorded?.status ?? "?"} (tokens in ${summary.tokens.input}, cache read ${summary.tokens.cacheRead}, cache write ${summary.tokens.cacheCreation}, out ${summary.tokens.output}; ${summary.apiCalls} calls, ${summary.toolCalls} tools)`,
    );
    return report;
  });
