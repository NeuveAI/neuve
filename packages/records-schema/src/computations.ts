import { z } from "zod";
import { Instant, Ulid } from "./envelope.ts";

/** A sha256 content hash or computation key, lower-case hex. */
export const Sha256 = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "Expected a sha256 hex digest");

/**
 * How long a blob's bytes are kept (8.10, D26). `durable` blobs are outputs the pipeline reuses and
 * are kept permanently. `raw-capture` blobs (transcripts, raw tool outputs, model bodies) may be
 * pruned 30 days after `capturedAt`, leaving a tombstone; fetching one again is a new capture.
 */
export const BlobRetention = z.enum(["durable", "raw-capture"]);

/** Small blobs live in the database row, larger ones in `blobs/sha256/<ab>/<rest>` (D11). */
export const BlobPlacement = z.enum(["inline", "file"]);

/** A blob's stored metadata; its bytes are read through the blob store, which re-hashes them. */
export const BlobRow = z.strictObject({
  hash: Sha256,
  size: z.int().min(0),
  mediaType: z.string().min(1).max(128),
  retention: BlobRetention,
  placement: BlobPlacement,
  capturedAt: Instant,
  /** Set when the bytes were pruned; the row stays as the tombstone. */
  prunedAt: Instant.nullable(),
});

/** An attempt's outcome. `abandoned`: a dead worker left it running (8.2: nothing expires). */
export const AttemptOutcome = z.enum([
  "running",
  "succeeded",
  "failed",
  "abandoned",
]);

/** Model token usage, as the provider reports it. `input` excludes tokens read from or written to cache. */
export const TokenUsage = z.strictObject({
  input: z.int().min(0),
  cacheCreation: z.int().min(0),
  cacheRead: z.int().min(0),
  output: z.int().min(0),
});

/** One attempt at a computation (D12). Every attempt is kept, with its usage, because its tokens count. */
export const AttemptRow = z.strictObject({
  attemptId: Ulid,
  key: Sha256,
  n: z.int().min(1),
  op: z.string().min(1).max(128),
  startedAt: Instant,
  endedAt: Instant.nullable(),
  outcome: AttemptOutcome,
  errorTag: z.string().nullable(),
  errorMessage: z.string().nullable(),
  /** A raw capture of what went wrong, such as a model's error body; session data. */
  causeBlob: Sha256.nullable(),
  /** The output this attempt produced; it binds the computation only if it was the first success. */
  outputHash: Sha256.nullable(),
  /** JSON of `TokenUsage`, when the attempt called a model. */
  usage: z.string().nullable(),
  model: z.string().nullable(),
});

/**
 * A finished computation: its key, what the key was computed from (`material`, canonical JSON), and
 * the durable output blob bound by its first successful attempt, permanently (D12).
 */
export const ComputationRow = z.strictObject({
  key: Sha256,
  op: z.string().min(1).max(128),
  opVersion: z.int().min(1),
  material: z.string().min(2),
  outputHash: Sha256,
  attemptId: Ulid,
  completedAt: Instant,
});

/**
 * What one transcript segment says about the turn it covers: the output of the `transcript.summary`
 * computation and the payload of `turn.summarized`. It never holds transcript text (D25).
 */
export const TranscriptSummary = z.strictObject({
  /** The model of the segment's last model response, when the transcript names one. */
  model: z.string().min(1).max(128).optional(),
  tokens: TokenUsage,
  /** Part of `tokens.output`, when the harness reports it (Codex). */
  reasoningOutput: z.int().min(0).optional(),
  /** Model responses counted, after removing repeated streaming rows of one response. */
  apiCalls: z.int().min(0),
  toolCalls: z.int().min(0),
  /** From the first to the last timestamp in the segment. */
  durationMs: z.int().min(0).optional(),
  lines: z.int().min(0),
});

/**
 * Input of a `transcript.capture` job enqueued by hand (`neuve jobs enqueue`), naming the turn-end or
 * session-end event whose transcript segment to capture again. Jobs enqueued by that event need none.
 */
export const TranscriptCapturePayload = z.strictObject({ eventId: Ulid });

export type BlobRetention = z.infer<typeof BlobRetention>;
export type BlobPlacement = z.infer<typeof BlobPlacement>;
export type BlobRow = z.infer<typeof BlobRow>;
export type AttemptOutcome = z.infer<typeof AttemptOutcome>;
export type AttemptRow = z.infer<typeof AttemptRow>;
export type ComputationRow = z.infer<typeof ComputationRow>;
export type TokenUsage = z.infer<typeof TokenUsage>;
export type TranscriptSummary = z.infer<typeof TranscriptSummary>;
export type TranscriptCapturePayload = z.infer<typeof TranscriptCapturePayload>;
