# 0008: Model routes and budgets

Status: accepted, 16 October 2026. Source: decisions [2.9, 2.11, 10.5 and 10.16–10.19](../../process/decisions.md).

## Decision

| Route | Use | Context window | Output | Source of the numbers |
| --- | --- | --- | --- | --- |
| Sol 6.1 through ACP to Codex | First choice, if it can be set up properly | 500,000 tokens, 95% usable (about 475,000) | Not published by Codex; plan for 128,000 until measured | Codex's model metadata, `~/.codex/models_cache.json` |
| Opus 5.5 through the Anthropic API | Fallback | 1,000,000 tokens | 128,000 tokens, including thinking | Anthropic's model documentation |

- **Current choice (17 October 2026, decision 2.12):** M3 builds on Opus 5.5. The ACP path to Codex stays runnable, and it switches to Sol 6.1 once a released Codex accepts `gpt-6.1-sol` and offers a true read-only mode ([0003](0003-effect-native-harness-runtime.md)).
- The route and its numbers are frozen into each run's configuration, so a run can be reproduced and reused.
- Credentials are the user's environment, read at the call and never stored (10.5). Every run receipt shows the route, the variable that supplied the key, tokens and cost by stage, and the organisation if the provider names it (10.16).
- Each call sets the 128,000-token output cap; effort is `medium`, fixed per context; at most 3 calls are in flight per run; one context's ceiling is half the window (10.18, 10.19).
- Every stage budget is derived from the route's window and counted in tokens, not bytes ([0005](0005-harness-pipeline.md)).
- Output caps must actually reach the provider. Where a route cannot enforce one, usage is checked and recorded after the call.
- The ChatGPT consumer-backend route through EVE is removed.
- The old values (a 272,000-token window, and 131,072-byte, 64,000-token and 30-second frame limits) are discarded. They belonged to the previous Sol model and to a one-case development envelope.
