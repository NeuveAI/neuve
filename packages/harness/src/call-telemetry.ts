import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { enqueueTelemetry, type RunLog } from "./run-log.ts";
import {
  costOf,
  requireDirectRoute,
  type AnyRouteConfig,
  type DirectRouteConfig,
} from "./route.ts";
import { isRefusal } from "./pi/providers/failure.ts";
import { callUsageOf } from "./pi/providers/usage.ts";

const ProviderUsage = z.object({
  input_tokens: z.number().nonnegative().optional(),
  output_tokens: z.number().nonnegative().optional(),
  total_tokens: z.number().nonnegative().optional(),
  cache_creation_input_tokens: z.number().nonnegative().optional(),
  cache_read_input_tokens: z.number().nonnegative().optional(),
  cache_creation: z
    .object({ ephemeral_1h_input_tokens: z.number().nonnegative().optional() })
    .optional(),
  input_tokens_details: z
    .object({
      cached_tokens: z.number().nonnegative().optional(),
      cache_write_tokens: z.number().nonnegative().optional(),
    })
    .optional(),
  output_tokens_details: z
    .object({ reasoning_tokens: z.number().nonnegative().optional() })
    .optional(),
});

/** Metadata only. Never retain a delta, provider error text, or an abort signal's reason. */
export class CallTelemetry {
  readonly id = randomUUID();
  readonly startedAt = new Date().toISOString();
  private scope: { stage?: string | undefined; agent?: string | undefined } =
    {};
  private providerUsage: z.infer<typeof ProviderUsage> | undefined;
  private kind = "turn";
  private sentAt: string | undefined;
  private streamEndAt: string | undefined;
  private headersAt: string | undefined;
  private firstTokenAt: string | undefined;
  private checkpointAt = 0;
  private readonly blocks = {
    text: { deltas: 0, characters: 0 },
    reasoning: { deltas: 0, characters: 0 },
    toolArguments: { deltas: 0, characters: 0 },
  };
  private readonly route: DirectRouteConfig;
  constructor(
    private readonly log: RunLog | undefined,
    route: AnyRouteConfig,
  ) {
    this.route = requireDirectRoute(route);
    this.write("model.call.start");
  }
  bind(
    scope: { stage?: string | undefined; agent?: string | undefined },
    final = false,
  ) {
    this.scope = scope;
    this.kind = final ? "final" : "turn";
    this.write("model.call.start");
  }
  sent() {
    this.sentAt = new Date().toISOString();
    this.write("model.call.progress");
  }
  headers() {
    this.headersAt = new Date().toISOString();
    this.write("model.call.progress");
  }
  event(name: string, value: unknown) {
    if (typeof value !== "object" || value === null) return;
    const response =
      "response" in value
        ? value.response
        : "message" in value
          ? value.message
          : value;
    if (
      typeof response === "object" &&
      response !== null &&
      "usage" in response
    ) {
      const parsed = ProviderUsage.safeParse(response.usage);
      if (parsed.success) {
        this.providerUsage = { ...this.providerUsage, ...parsed.data };
        this.write("model.call.progress");
      }
    }
    let delta: unknown = "delta" in value ? value.delta : undefined;
    let kind: keyof typeof this.blocks | undefined;
    if (name === "response.output_text.delta") kind = "text";
    else if (/^response\.reasoning.*\.delta$/.test(name)) kind = "reasoning";
    else if (name === "response.function_call_arguments.delta")
      kind = "toolArguments";
    else if (
      name === "content_block_delta" &&
      typeof delta === "object" &&
      delta !== null &&
      "type" in delta
    ) {
      if (delta.type === "text_delta") {
        kind = "text";
        delta = "text" in delta ? delta.text : undefined;
      } else if (delta.type === "thinking_delta") {
        kind = "reasoning";
        delta = "thinking" in delta ? delta.thinking : undefined;
      } else if (delta.type === "input_json_delta") {
        kind = "toolArguments";
        delta = "partial_json" in delta ? delta.partial_json : undefined;
      }
    }
    if (kind === undefined || typeof delta !== "string") return;
    this.firstTokenAt ??= new Date().toISOString();
    this.blocks[kind].deltas++;
    this.blocks[kind].characters += delta.length;
    if (Date.now() - this.checkpointAt >= 1_000) {
      this.checkpointAt = Date.now();
      this.write("model.call.progress");
    }
  }
  endStream() {
    this.streamEndAt = new Date().toISOString();
    this.write("model.call.progress");
  }
  finish(message: AssistantMessage, failureKind?: string, reason?: unknown) {
    const raw = this.providerUsage;
    // A failed decoder can return zero SDK usage after the provider has already reported billing.
    // Responses input_tokens includes reads and writes. Ordinary input subtracts both:
    // https://developers.openai.com/api/docs/guides/prompt-caching#monitor-cache-performance
    const usage = (() => {
      if (message.usage.totalTokens > 0 || raw === undefined)
        return callUsageOf(message.usage);
      const route = this.route;
      switch (route.provider) {
        case "anthropic":
          return {
            input: raw.input_tokens ?? 0,
            output: raw.output_tokens ?? 0,
            cacheWrite5m: Math.max(
              0,
              (raw.cache_creation_input_tokens ?? 0) -
                (raw.cache_creation?.ephemeral_1h_input_tokens ?? 0),
            ),
            cacheWrite1h: raw.cache_creation?.ephemeral_1h_input_tokens ?? 0,
            cacheRead: raw.cache_read_input_tokens ?? 0,
          };
        case "openai":
          return {
            input: Math.max(
              0,
              (raw.input_tokens ?? 0) -
                (raw.input_tokens_details?.cached_tokens ?? 0) -
                (raw.input_tokens_details?.cache_write_tokens ?? 0),
            ),
            output: raw.output_tokens ?? 0,
            cacheWrite5m: raw.input_tokens_details?.cache_write_tokens ?? 0,
            cacheWrite1h: 0,
            cacheRead: raw.input_tokens_details?.cached_tokens ?? 0,
            thinking: raw.output_tokens_details?.reasoning_tokens ?? 0,
          };
        default: {
          const exhaustive: never = route;
          return exhaustive;
        }
      }
    })();
    const reported =
      message.usage.totalTokens > 0 ||
      failureKind === undefined ||
      (raw !== undefined && Object.keys(raw).length > 0);
    this.write("model.call", {
      streamEndAt: this.streamEndAt,
      settledAt: new Date().toISOString(),
      latencyMs: Math.max(0, Date.now() - Date.parse(this.startedAt)),
      finishReason: message.stopReason,
      stopReason: message.rawStopReason,
      refused: isRefusal(message),
      messageTimestamp: message.timestamp,
      responseId: message.responseId,
      abortReason:
        message.stopReason === "aborted" || failureKind === "aborted"
          ? typeof reason === "string" &&
            ["cutoff", "deadline", "shutdown", "stop"].includes(reason)
            ? reason
            : "aborted"
          : undefined,
      failureKind,
      usage: reported ? usage : undefined,
      costUsd: reported ? costOf(this.route, usage) : null,
    });
  }
  private write(type: string, fields = {}) {
    enqueueTelemetry(this.log, {
      type,
      call: this.id,
      ...this.scope,
      model: this.route.model,
      effort: this.route.effort,
      maxTokens: this.route.maxOutputTokens,
      kind: this.kind,
      providerUsage: this.providerUsage,
      startedAt: this.startedAt,
      sentAt: this.sentAt,
      headersAt: this.headersAt,
      firstTokenAt: this.firstTokenAt,
      timeToFirstTokenMs:
        this.sentAt && this.firstTokenAt
          ? Date.parse(this.firstTokenAt) - Date.parse(this.sentAt)
          : undefined,
      blocks: structuredClone(this.blocks),
      ...fields,
    });
  }
}
