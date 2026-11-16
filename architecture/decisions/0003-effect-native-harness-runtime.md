# 0003: Effect-native harness runtime

Status: superseded for agent execution by [0014, the owner's Ace-style pi transition](0014-ace-style-pi-harness.md), accepted on 28 October 2026. Effect and Bun remain the application platform. The implementation below and its spike record explain the incumbent being replaced. Source: decisions [6.1, 6.2, 6.4 and 6.8](../../process/decisions.md).

## Context

The current harness runs inside EVE, a Vercel agent framework in preview. Its problems:

- It runs as its own HTTP server.
- Its MCP client connections accept only Streamable HTTP or SSE.
- Its ACP support serves EVE agents to editors; it cannot use Codex as a model.
- It reached Sol through ChatGPT's undocumented consumer backend, which silently dropped `maxOutputTokens`.
- It needed a patch applied to its minified build.

Effect is Neuve's core dependency, and Effect 4.0.0 ships `effect/ai` and `effect/workflow`.

## Decision

The harness is Effect-native:

- `effect/ai` for language models, chat, tools and toolkits, tokenizers, embeddings, telemetry, and an MCP server with a stdio layer.
- `effect/workflow` for durable pipeline execution: workflows, activities, durable queues and clocks. This serves as the pipeline's state machine.
- An ACP client to `codex-acp` for Sol 6.1, which can also pass Neuve's MCP tools into the Codex session.

EVE leaves the harness, and its patch goes with it. No dependency patches are allowed, ever.

## Validation (spike, 16 October 2026)

The spike lives outside the repository, at `~/code/neuve-spikes/harness-runtime-20261016/`. Its README lists every command and links the logs. An independent reviewer reran the claims and approved them, finding no mocks, no patches and no leaked secrets.

| Capability | Result |
| --- | --- |
| Opus 5.5 through `@effect/ai-anthropic` 4.0.0: generation, structured output, tool loop | Works. Tool loops use a hand-written loop over `chat.generateText`. A tool with no parameters must omit `parameters`. |
| Output cap actually sent | Works. A captured request carried `max_tokens=40` and the server stopped at 40. Always set it: the provider's default for an unknown model is 128,000. |
| Token usage | Partly. Reasoning tokens are not reported by the provider; read them from the raw response. |
| ACP client to codex-acp under Bun, streaming, permissions, cancellation, usage | Works |
| Neuve tools handed to Codex through MCP in `session/new` | Works. Codex called our Effect `McpServer` over stdio. |
| Durable workflow with SIGKILL and resume (`ClusterWorkflowEngine` with SQLite under Bun) | Works. Activities run at least once, so they must be idempotent. Retries have no backoff schedule, and activity timeouts are not durable. |

### Open risks carried into M3

1. **Codex version.** The Codex bundled with codex-acp (0.156.1) rejects `gpt-6.1-sol`, and returns the error as an ordinary assistant reply. Sol worked only through a newer Codex (0.163.0-alpha, from the ChatGPT app), passed in via `CODEX_PATH`. The newest version the 10-day release-age policy allows (0.160.1) is untested.
2. **No read-only sandbox through codex-acp 1.13.1.** Its "read-only" mode is a writable workspace that asks for approval. Neuve's review roles need read-only execution.
3. **Opus thinking across tool turns is unproven.** The model never reasoned before a tool call, so replay of its thinking blocks was not exercised.
4. **Codex session isolation is partial.** A separate `CODEX_HOME` still loads the user's skills and apps.
5. **Paths not exercised.** ACP-level model selection, the activity timeout and negative decoding of refinements did not run.
