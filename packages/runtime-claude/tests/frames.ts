import type {
  ModelUsage,
  SDKAssistantMessage,
  SDKResultMessage,
  SDKResultSuccess,
  SDKPartialAssistantMessage,
} from "@anthropic-ai/claude-agent-sdk";
export const SESSION_ID = "00000000-0000-4000-8000-000000000001";
export const usage = (inputTokens: number, outputTokens = 2): ModelUsage => ({
  inputTokens,
  outputTokens,
  cacheReadInputTokens: 3,
  cacheCreationInputTokens: 4,
  webSearchRequests: 0,
  costUSD: 99,
  contextWindow: 1000,
  maxOutputTokens: 100,
});
export function result(
  fields: Partial<SDKResultSuccess> = {},
): SDKResultSuccess {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    stop_reason: "end_turn",
    total_cost_usd: 99,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      fallback_credit: {
        status: { type: "not_applied", reason: "not_enabled" },
      },
      output_tokens_details: { thinking_tokens: 0 },
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
      service_tier: "standard",
      cache_creation: {
        ephemeral_5m_input_tokens: 0,
        ephemeral_1h_input_tokens: 0,
      },
      inference_geo: "not_available",
      iterations: [],
      speed: "standard",
    },
    modelUsage: {},
    permission_denials: [],
    uuid: crypto.randomUUID(),
    session_id: SESSION_ID,
    ...fields,
  };
}
export function errorResult(
  subtype: Exclude<SDKResultMessage["subtype"], "success">,
  fields: Partial<Extract<SDKResultMessage, { errors: string[] }>> = {},
): SDKResultMessage {
  const { result: _, ...base } = result();
  return {
    ...base,
    subtype,
    is_error: true,
    errors: ["test failure"],
    ...fields,
  };
}
export function assistant(
  error: SDKAssistantMessage["error"],
  text = "",
): SDKAssistantMessage {
  return {
    type: "assistant",
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
    session_id: SESSION_ID,
    ...(error === undefined ? {} : { error }),
    message: {
      id: "test-message",
      type: "message",
      role: "assistant",
      model: "test-model",
      stop_reason: "end_turn",
      stop_sequence: null,
      content: [{ type: "text", text, citations: [] }],
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        fallback_credit: {
          status: { type: "not_applied", reason: "not_enabled" },
        },
        output_tokens_details: { thinking_tokens: 0 },
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        server_tool_use: null,
        service_tier: "standard",
        cache_creation: null,
        inference_geo: null,
        iterations: null,
        speed: null,
      },
      container: null,
      context_management: null,
      diagnostics: null,
      stop_details: null,
    },
  };
}
export function textDelta(
  text: string,
  parent_tool_use_id: string | null = null,
): SDKPartialAssistantMessage {
  return {
    type: "stream_event",
    parent_tool_use_id,
    uuid: crypto.randomUUID(),
    session_id: SESSION_ID,
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    },
  };
}
