import { z } from "zod";
import { CredentialEpochId } from "./credential-detectors.ts";
const Count = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const Usage = z.strictObject({
  units: Count,
  fullChecks: Count,
  fullBytes: Count,
  matches: Count,
  parseUnits: Count,
  decodeUnits: Count,
});
export const UsageCounter = Usage.keyof();
export const WireSource = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("text"), text: z.string() }),
  z.strictObject({ kind: z.literal("json"), text: z.string() }),
  z.strictObject({
    kind: z.literal("bytes"),
    bytes: z.instanceof(Uint8Array),
    mediaType: z.string(),
  }),
]);
export type WireSource = z.infer<typeof WireSource>;
export const InspectionResult = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("complete"),
    epochs: z.array(CredentialEpochId).max(1024),
    matches: z
      .array(
        z.strictObject({
          start: Count,
          end: Count,
          epoch: CredentialEpochId,
          roles: z
            .array(z.enum(["header", "authorization-token", "cookie-value"]))
            .max(3),
          domain: z.enum([
            "string16",
            "raw-utf8",
            "raw-utf16le",
            "raw-utf16be",
          ]),
          view: z.enum(["text", "raw", "utf8-decoded", "declared-text"]),
          jsonPath: z
            .array(z.strictObject({ start: Count, end: Count }))
            .max(32),
        }),
      )
      .max(10000),
  }),
  z.strictObject({
    status: z.literal("unavailable"),
    reason: z.enum([
      "budget",
      "cancelled",
      "unsupported",
      "worker",
      "invalid-metadata",
      "private-store",
      "ownership",
      "closed",
    ]),
    exposedEpochs: z.array(CredentialEpochId).max(1024),
  }),
]);
export const Job = z.strictObject({
  id: Count,
  sources: z
    .array(
      z.strictObject({
        identity: z.string().regex(/^[a-f0-9]{64}$/),
        source: WireSource,
      }),
    )
    .min(1)
    .max(256),
  limits: Usage.extend({
    parseValueUnits: Count.positive(),
    depth: Count,
    yieldUnits: Count.positive().max(65536),
  }),
  deadlineEpochMs: z.number().finite(),
});
export const Reply = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("progress"), id: Count, units: Count }),
  z.strictObject({
    type: z.literal("observed"),
    id: Count,
    epoch: CredentialEpochId,
  }),
  z.strictObject({
    type: z.literal("done"),
    id: Count,
    results: z
      .array(
        z.strictObject({
          identity: z.string().regex(/^[a-f0-9]{64}$/),
          result: InspectionResult,
        }),
      )
      .max(256),
    usage: Usage,
    exhausted: UsageCounter.optional(),
  }),
]);
export const Recognition = z.strictObject({
  inspection: z.literal(true),
  key: z
    .instanceof(Uint8Array)
    .refine(
      (key) =>
        key.byteLength === 32 &&
        key.byteOffset === 0 &&
        key.buffer instanceof ArrayBuffer &&
        key.buffer.byteLength === key.byteLength,
    ),
  state: z
    .instanceof(Uint8Array)
    .refine(
      (state) =>
        state.byteLength <= 8 * 1024 * 1024 &&
        state.byteOffset === 0 &&
        state.buffer instanceof ArrayBuffer &&
        state.buffer.byteLength === state.byteLength,
    ),
});
