# 0017: Runtime contract and accounts

Status: accepted, 10 November 2026. The [owner's local runtime decision 12.59](../../process/decisions.md#area-12-ace-style-pi-transition-28-october-2026) accepts isolated agent loops behind one contract. The [runtime and account proposal](../../process/proposals/claude-subscription-route.md#2-one-runtime-contract-and-an-account-registry) defines the boundary and its local scope. This record states the contract and the coordinator's stage and coding-chat design. Review stages run on Claude Code accounts; enablement removed the test-only switch that held them back. [Receipts](../../packages/harness/src/receipt.ts) name the account's Claude Code sign-in and never its value, and the [candidate evaluator](../../packages/evaluation/src/candidate/capture.ts) refuses to score a capture whose contract contexts have no provider wire evidence, because a Claude Code turn has no byte-exact capture to score from.

## Context

pi serves Neuve's API-key routes and ChatGPT sign-in today. Claude subscription accounts require the person's unmodified Claude Code program and Claude Code's own login. Neuve needs one caller contract without sharing a loop or moving Claude credentials into pi, the vault or the broker.

Routes are frozen in stored review requests and contribute to run keys. Account metadata must preserve the identity of those requests and reuse of completed default-route runs. The [model-route compatibility record](0008-model-routes-and-budgets.md) defines those migration rules.

## Decision

An account has a name, kind, runtime and credential reference. Callers pass an account name and read capabilities. The registry resolves the account and is the only runtime branch point. The [account schemas](../../packages/runtime/src/account.ts) encode the four permitted kinds and their credential references, so callers cannot pair a subscription with an API-key reference.

| Account kind           | Runtime               | Credential reference                                                |
| ---------------------- | --------------------- | ------------------------------------------------------------------- |
| `claude-subscription`  | `claude-code`         | Claude Code's own configuration folder, written only by Claude Code |
| `anthropic-api-key`    | `pi` or `claude-code` | Environment variable or vault entry                                 |
| `chatgpt-subscription` | `pi`                  | Neuve's sign-in for that account, with one refresher                |
| `openai-api-key`       | `pi`                  | Environment variable or vault entry                                 |

The schema permits an Anthropic API key on Claude Code, but the [registered Claude runtime](../../packages/runtime-claude/src/runtime.ts) currently accepts only `claude-subscription`.

The [default account declarations](../../packages/runtime/src/defaults.ts) define three accounts. The harness uses them through an in-memory directory by default. `anthropic` is an Anthropic API key on pi using the environment reference `ANTHROPIC_API_KEY`. `chatgpt` is a ChatGPT subscription on pi using the current Neuve sign-in. `claude` is a Claude subscription on Claude Code using Claude Code's default configuration. The [account store](../../packages/runtime/src/store/index.ts) supplies these defaults when no account file exists and owns additional accounts.

The [runtime contract declarations](../../packages/runtime/src/contract.ts) define capabilities, a scoped provider session and one normalized event stream. Opening takes an account and a policy containing its tools, system prompt, turn limit, approvals, optional model and final-output schema. A session starts, steers and interrupts turns and answers approval requests. Closing the caller's scope closes the provider session and all processes it owns.

Capabilities declare whether the runtime runs its own loop, structured output, steering, interrupts, resume, fork, model switches within a session, approvals, per-request telemetry, byte-exact capture, a native tool server, status probing and internal retries. Unsupported requirements fail explicitly. The contract requires an output schema for a final turn and structured output on its completion. It requires exactly one terminal event for each started turn. The single-consumer event stream reports text, tool calls, usage, rate limits, retries and approval requests. It requires session death to finish open turns as failed with a broken disposition before ending the stream. Scope closure must finish them as interrupted.

The [typed runtime errors](../../packages/runtime/src/errors.ts) distinguish sign-in required, account rejected, usage limit reached, runtime unavailable, account not found, unsupported capability and turn failure. Their serialized forms contain contract fields and omit incidental error data. A failed turn states whether its session can be reused or must close. Shared code maps the final outcome; it does not duplicate retries already performed by a runtime.

The [registry implementation](../../packages/runtime/src/registry.ts) looks up the account through its directory, checks required capabilities and opens the selected runtime in the caller's scope. Its pushed account observations come from consumed usage and rate-limit events. Status probes never sign in or send a model request. Its account-directory contract requires removal to close admission and end admitted sessions before deleting credentials. The in-memory directory has no removal guard. `RuntimeRegistry.signOut(name)` delegates to `RuntimeShape.signOut(account)`, which runs the runtime's own sign-out without reading the credential and does nothing for key references. The directory contract requires `lookup(name, purpose)` to return an account being removed only for `"sign-out"`; `"use"` must hide it from capabilities, probes and new sessions. Usage limits belong to the selected account and never trigger automatic fallback to another account.

| Shared above the contract                                | Kept by each runtime                                      |
| -------------------------------------------------------- | --------------------------------------------------------- |
| One set of tool definitions and handlers                 | Native tool registration and execution mechanics          |
| Telemetry, logs, receipts, per-account usage and budgets | Model calls, wire format, retry and admission mechanics   |
| Stage policy, output schema, turn limits and approvals   | Agent loop, compaction, durable resume and native capture |
| Masking, Records writes and session exports              | Credential access and refresh ownership                   |

The [shared ownership table in the accepted proposal](../../process/proposals/claude-subscription-route.md#what-is-shared-and-what-each-runtime-keeps) fixes this separation. pi's generation path retains request-level accounting and exact capture. Its status-only registration does not advertise those generation capabilities. Claude Code retains its own retries, sessions and transcript; shared code cannot assume request-level or byte-exact evidence without the corresponding capability. Neuve adds one resend of its own: when Claude Code reports that another Claude Code process is refreshing the sign-in, and the turn has not yet run a tool or made progress, the [Claude Code session](../../packages/runtime-claude/src/session.ts) sends the turn's message once more. Claude credentials stay only in Claude Code's own configuration and login flow. Sessions on the default `claude` account appear in the owner's own Claude Code history, under Neuve's work folder.

## Consequences

- `@neuve/runtime` owns account schemas, defaults, tool types, session contracts, typed errors and the registry. The harness re-exports the tool types and keeps its builders and schema helpers.
- New routes name an account and its kind while legacy credential reference fields remain during migration. Parsing an older frozen route does not add metadata. Default-account run keys remain unchanged; other account names key apart.
- The [shared-work record](0016-shared-work.md) remains the only coordination design when several callers request the same work. Account lookup introduces no duplicate-run or polling alternative.
- This build covers the owner's local host. The [proposal's placement model](../../process/proposals/claude-subscription-route.md#3-where-a-runtime-runs) keeps remote machines and shared sandboxes outside the local build; their account ownership and sign-in questions remain open.

## Runtimes that run their own loop

The contract has two kinds of runtime. A runtime that declares `ownsLoop` runs its own model loop inside a turn and calls Neuve's tools back through their handlers. Claude Code is the only one. A runtime without `ownsLoop` does not open sessions through this contract. pi registers this way, as a status-only runtime. It answers capabilities, continuation identity, status probes and sign-out. Its ChatGPT probe and sign-out go through Neuve's ChatGPT sign-in module. Key probes use an injected presence resolver or the environment, and key sign-out does nothing. pi keeps its own generation path and is not wrapped in the contract. A pi account therefore stays distinct from a Claude account whose runtime failed to register. The registry routes account status and sign-out for both. The registry refuses `openSession` on a runtime without `ownsLoop`, and callers decide by reading `capabilities(name).ownsLoop`, never by the runtime's kind or by a lookup error. The [pi status runtime](../../packages/harness/src/pi/status-runtime.ts) and [runtime registration](../../packages/harness/src/runtimes.ts) implement this. `processRuntimes` keeps one registry per worker process and leaves Claude Code unregistered unless configured. The [review worker](../../apps/neuve-cli/src/worker-cli.ts) configures it through `workerRuntimeOptions`, which registers Claude Code over the [account store](../../packages/runtime/src/store/index.ts) and falls back to the default accounts in memory when the store won't open, so pi reviews keep working. `harnessRuntimes` accepts an account-directory layer and otherwise uses the defaults in memory. Building it starts no child and sends no model request. The first probe or session makes Neuve's private work folder, and a failed attempt is retried at the next one. A failed folder setup leaves pi usable: Claude sessions fail as runtime unavailable and probes report it.

For a loop-owning runtime the contract adds:

- **Tool calls.** Tool handlers receive the runtime's native `callId` and an abort signal.
- **Ending a turn.** On a runtime that declares `toolEndsTurn`, a tool result may end the turn (`endTurn`): the result is recorded, no further request is sent, and the turn completes.
- **Message events.** `message.finished` reports each unit of model output the runtime can prove complete, a whole model response on Claude Code: its native `messageId`, the stop reason and every tool call with its input. With `perMessageUsage` it carries that request's usage, and with `resumeInTurn` a resume point naming its last block. A frame of that unit arriving after the event fails the turn as a protocol error, never a second or partial event.
- **Resume points.** `turn.finished` carries a resume point when the turn ends on a tool result with no trailing assistant message, and that point takes precedence. On a runtime without `resumeInTurn` a completed turn always carries one, its only point to resume or fork from.
- **Sessions.** A session opens new, or resumed at a point, forked or not. Its `nativeSessionId` is read live, because it changes on fork and on a conversation reset.
- **Capabilities.** `resume`, `fork`, `steering`, `interrupt` and `modelSwitchInSession` are declared, and the registry refuses each unsupported operation before the runtime is called.
- **Continuation identity.** Each account has one, a runtime kind plus a key that never holds a credential. Only accounts with equal identities continue each other's native sessions.
- **Turn-start check.** Before each turn, the registry asks the account directory whether the account is still usable. The directory stops that process's sessions on a removed account first, so a removal missed by a file watch costs at most one turn start.

`ownsLoop` means only that the runtime runs its own model loop and calls Neuve's tool handlers. The three capabilities above, `toolEndsTurn`, `resumeInTurn` and `perMessageUsage`, are declared apart from it, as the [Codex runtime design](../../process/proposals/codex-runtime.md#sessions-turns-and-events) requires, because a runtime can run its own loop without them. Claude Code declares all three. A review stage on a runtime that runs its own loop needs all three as well (a stage on a direct route needs none of them), and a route whose runtime lacks any of the three is refused, naming what is missing, when a request freezes and when its stage opens ([route agreement](../../packages/harness/src/route.ts)). Coding chats need only `ownsLoop`: on a runtime without `resumeInTurn` the [chat bridge](../../packages/harness/src/chat-runtime/bridge.ts) records no head inside a turn, and after a failure inside a turn it resumes at the last completed turn and hands the lost part over as text, as it does for a change of account.

A subscription account is unpriced: cost is `null`, never priced at API rates.

## How review stages and coding chats use it

The [stage admission branch](../../packages/harness/src/pi/stages/agent-step.ts) reads `capabilities(name)`: `ownsLoop`, and on a loop-owning account the three stage capabilities. A provider mismatch, or a missing stage capability, fails with `RouteRuntimeMismatch`; an agreeing route on a loop-owning account runs the contract engine. A sign-in, rejected-account or usage-limit failure while resolving a Claude subscription account holds the stage under the hold policy below. The [route schema](../../packages/harness/src/route.ts) declares `ClaudeRouteConfig`, and run configurations accept it beside the direct routes. The named routes are still only `anthropic` and `openai`, so no named route selects Claude yet.

**Review stages don't use a bridge.** `agent-step` keeps its durable phases. On an account whose runtime owns its loop, it drives a contract session with one turn per round. Neuve's stage tools and the submit tool are contract tools. After a tool call, `roundEnds` decides whether its result returns `endTurn` for an accepted submission, exhausted chances, the turn limit, the context ceiling or the deadline. Text-only round endings go through the same stage limits before a continuation or final generation. The stage reuses `scanSubmissions`, `roundEnds`, `submitted` and `transcriptFacts`; `repairedContract` applies the stage's existing repair and validation functions. `ContractContextDoc` commits rounds, messages, call outcomes and native resume points. Tool handlers wait for the message commit before running. Recovery retains completed call results and marks a started call without a recorded outcome unknown instead of running it again. The [stage engine](../../packages/harness/src/pi/stages/contract-step.ts) implements it.

- **Turn limit.** It counts one turn per `message.finished`.
- **Context ceiling.** It reads that message's input including cached tokens.
- **Final generation.** It is the runtime's structured output, and Neuve's tools refuse to run during it.
- **Recovery.** After a crash, only the calls of the message at the saved resume point are uncertain. Their results go into the next prompt once, as text saying the call already ran; a started call with no recorded outcome is reported as unknown and never run again. A fork's new session id is committed before any model work. A round that was never dispatched reopens as its original start; a dispatched round with no committed message and an empty call ledger restarts in a new session. Anything else without a safe point, or a continuation identity that no longer matches, fails typed and keeps the partial state.
- **Telemetry.** It writes one `model.call` per native message, including that message's usage. Totals come only from usage events. Request usage is summed; turn usage replaces the prior total for each model. The two scopes are never combined for one turn.

pi accounts keep today's generation path unchanged. A route names the account. The `claude` provider requires a loop-owning account, and `anthropic` and `openai` require one that doesn't, checked when a stage opens. The same agreement is checked at freeze time when the caller supplies the registry (`routeOwnsLoop` in [request preparation](../../packages/harness/src/request.ts)), and again whenever an [attempt](../../packages/harness/src/pi/attempt.ts) opens. Its stage keys are kept apart from the Anthropic API's because Claude Code's loop computes differently. Every direct API path refuses a Claude route before reading a credential.

**Why stages don't use the chat bridge.** The bridge makes Claude Code a component inside pi's loop. For stages that would mean:

- turning `endTurn`, the normal ending of every round, into a rare interrupt;
- imitating a per-request final generation that Claude Code has no switch for;
- matching pi's turn count against requests pi never sees;
- holding tool calls open across stage phases.

Running the stage policy above a runtime that owns whole turns avoids all of that. It is also what 12.59's "each runtime keeps its own loop" asks.

**Coding chats use the bridge,** which the chat-runtime track builds, under these conditions:

- results are kept by `callId`, in either order;
- Claude Code never sends a request on its own;
- forks happen at the last block;
- a handoff to a new session happens only at a runtime or account switch the person chose. A failed resume forks once at the head; if that fails, the turn ends with an error and never falls back to a handoff on its own.

**Sessions** are bounded by today's per-account provider grant, keyed by continuation identity, plus the run's own slots. A stage closes its session whenever the step ends, is held or aborts.

**Holds.** The owner confirmed this policy. A held stage on a sign-in or usage-limit failure resumes only on an explicit resume request, after a fresh account check through the registry's probe. There is no automatic retry or timer, and the original cut-off stays. An account status change may tell the person they can resume, but never starts an attempt on its own. The [failure policy](../../packages/harness/src/pi/failure-policy.ts) marks sign-in, rejected-account and usage-limit holds non-retryable, and [explicit resume](../../packages/harness/src/pi/control.ts) (`admitResume`) admits a new attempt only after a fresh probe shows the account usable. No production caller passes that explicit resume yet: the [run host](../../packages/harness/src/pi/host.ts) calls `admitResume` without the registry, so a sign-in or usage-limit hold never resumes and spends nothing until a resume caller exists. The [review job's handler](../../packages/harness/src/handler.ts) keeps the job held while the worker sees the account unavailable, and ends the run as a held failure when the worker still sees the account ready.

On an account whose runtime declares `internalRetries`, a provider failure ends the attempt as an explicit-account hold, and the job queue never retries it. The [stage restoration](../../packages/harness/src/pi/stages/kinds.ts) reclassifies saved contract provider holds before resume admission, including when the account capability lookup fails. The [stage failure policy](../../packages/harness/src/pi/failure-policy.ts) preserves this outcome for the queue; only the person's explicit resume after a fresh account probe can restart it. The `neuve review --route <name>` entry point accepts a Claude subscription account name and freezes its route through the accounts store and runtime registry before recording the request.

## Removing an account

The [account store](../../packages/runtime/src/store/index.ts) removes an account in this order, with no lease and no liveness check:

1. The remover marks the account `removing` in the store.
2. Every Neuve process that watches the store refuses new sessions on it and closes its own running sessions, in t3code's order.
3. The remover runs the runtime's own sign-out right away (for Claude, Claude Code's logout for that folder), so a session still running anywhere ends its next request with "sign-in required", a typed and safe failure.
4. The folder or entry is deleted and the record dropped. A folder a dying process recreates has no record, so it can never be used, and the store deletes such orphans when it next writes.

When the budget host gains per-account claims (the cross-process row of the [shared-work record](0016-shared-work.md)), removal can wait on them instead.

**Known gaps.** macOS file watches can lose events while other watchers in the process start or stop. Each process keeps one long-lived watcher per folder, and the turn-start check covers a missed event at the next turn. A turn already running when an event is missed carries on until its next request fails sign-in. A status shown in the desk can be stale until the next change.
