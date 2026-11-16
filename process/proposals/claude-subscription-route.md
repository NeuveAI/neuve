# Sign-in and provider sessions for the Claude subscription and every other account: design proposal

Status: accepted for the build on the owner's host ([decision 12.59](../decisions.md#area-12-ace-style-pi-transition-28-october-2026)); the shared sandbox stays a model. The build is on the branch `claude/claude-subscription-accounts`. On 9 November 2026 the owner asked whether Neuve can use the owner's Claude subscription the way it uses the ChatGPT one. The owner said to adopt t3code's provider structure and contract, and to keep the support Ace and t3code have. The same day the owner ruled that shared sessions run in a shared sandbox on the tailnet ([decision 12.58](../decisions.md#area-12-ace-style-pi-transition-28-october-2026)), and asked this proposal to focus on sign-in and provider session and token management. The owner then narrowed what gets built: only local sessions, as they are structured today, on the owner's host. The shared sandbox and remote machines are modeled here so the local design doesn't close them off, and nothing is built for them ([section 3](#3-where-a-runtime-runs) says what the local build keeps open). The [decisions record](../decisions.md) wins wherever this differs; the rows this would change are in [section 10](#10-what-this-changes-in-the-decisions).

**Words.** These are implementation words for this proposal, not product vocabulary:

- A _runtime_ is the program that runs an agent's loop: pi inside Neuve today, or Claude Code through the Agent SDK.
- An _account_ is one sign-in or key for one provider, kept in its own folder or vault entry.
- A _provider session_ is one running runtime process serving one session on one account.
- A _stand-in_ is the placeholder value a sandbox sees in place of a secret ([decision 12.29](../decisions.md#area-12-ace-style-pi-transition-28-october-2026), vault and broker).

The first two follow t3code's _driver_ and _instance_ in its [provider constraints](https://github.com/pingdotgg/t3code/blob/main/docs/internals/providers.md).

## Starting facts

| Finding | Evidence |
| --- | --- |
| Anthropic allows a person to sign in to the unmodified Claude Code program with their own subscription, including where a platform hosts Claude Code. Each end user authenticates with their own credentials, and nobody pays for or relays Claude usage on another's behalf. Plan limits assume ordinary individual use | [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), "Can customers offer Claude Code in their products?" and "Authentication and credential use", read 9 November 2026 |
| Anthropic does not allow third-party tools to offer Claude.ai login or route requests through plan credentials. Developers may not collect, store or relay Claude.ai credentials or session tokens, and sign-in must finish in Anthropic's own flow. Products built on the Agent SDK use API keys | Same page; the [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) note on claude.ai login |
| The Agent SDK overview says third-party developers may not offer claude.ai login for products built on the SDK "unless previously approved", and points them to API keys. The legal page allows an end user to sign in to the unmodified Claude Code with their own subscription. Neuve offers no Claude.ai login and never handles the token: it runs the person's own installed `claude` through the SDK, signed in through Anthropic's own flow, as t3code does. That is the case the legal page allows, and bundling the SDK is fine (owner, 16 November 2026: "We are using the very same pathways and not really signing in, but using the sdk to call the local Claude code instance") | [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview), the note on claude.ai login; [legal and compliance](https://code.claude.com/docs/en/legal-and-compliance); read 10 November 2026 |
| The Agent SDK runs the Claude Code binary. On Linux, Claude Code keeps its sign-in in `.credentials.json` inside its config folder; on macOS, in the Keychain | [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview); t3code `apps/server/src/provider/claudeResetCredits.ts`, lines 137–171 |
| t3code's maintainers report that Agent SDK use drains the Claude 5-hour limit faster than Claude Code used directly. They call it an Anthropic bug they have reported, and say weekly limits are unaffected. Not verified here | t3code `docs/user/faq.md`, "Why is my Claude 5-hour limit draining so fast?" |
| Every review route calls the model API from pi's loop inside Neuve. The Anthropic route reads `ANTHROPIC_API_KEY`; the OpenAI route uses Neuve's own ChatGPT sign-in, which Neuve refreshes | [`route.ts`](../../packages/harness/src/route.ts), `OPUS_ROUTE` and `SOL_ROUTE`; [`openai-auth.ts`](../../packages/harness/src/openai-auth.ts) |
| pi's Anthropic client sends a subscription token (`sk-ant-oat…`) straight to the Messages API with Claude Code's beta headers. It also looks for `ANTHROPIC_OAUTH_TOKEN` among its credential names, which the coding host resolves from the environment and the Keychain. A subscription token placed there would be used exactly as the rules forbid. The harness labels such a call's auth mode as OAuth but does not refuse it | `@earendil-works/pi-ai` 1.0.0, `dist/api/anthropic-messages.js` lines 749 and 840, `dist/env-api-keys.js`; [`keys.ts`](../../apps/neuve-host/src/keys.ts), `models()`; [`agent-route-provider.ts`](../../packages/harness/src/pi/providers/agent-route-provider.ts), line 1549 |
| Labelling already runs headless Claude Code on the owner's plan, with `CLAUDE_CODE_OAUTH_TOKEN` passed only to that process | [`labelling/routes.ts`](../../packages/evaluation/src/retrieval-bench/labelling/routes.ts); [decision 9.55](../decisions.md#area-9-benchmark-m4-17-october-2026) (subscription token first for Opus labelling) |
| Neuve ruled that plan sign-ins are allowed only in Claude's own apps, so the Opus route stays on API keys | [Decision 10.85](../decisions.md#area-10-harness-m3-18-october-2026) |
| A shared session runs in a sandbox on the tailnet that hosts its whole runtime and its durable session, never on a member's machine | [Decision 12.58](../decisions.md#area-12-ace-style-pi-transition-28-october-2026); [12.28](../decisions.md#area-12-ace-style-pi-transition-28-october-2026) (where coding commands run) |
| Secrets come from a vault through a broker and enter a sandbox only as stand-ins, swapped for the real value on requests to that secret's own hosts. Neuve creates no credentials of its own | [Decision 12.29](../decisions.md#area-12-ace-style-pi-transition-28-october-2026) |
| A shared session's author comes from each person's own identity, never from what a request claims | [Decision 12.30](../decisions.md#area-12-ace-style-pi-transition-28-october-2026); Ace's tailnet directory names every caller with Tailscale's `whois` ([Ace pull request 568](https://github.com/githubnext/ace/pull/568)) |

## 1. What t3code and Ace do

**t3code** runs Codex, Claude Code, OpenCode, pi and others behind one contract. Paths are in its repository (MIT, read at its 9 November 2026 head).

| Part | What it is | Where |
| --- | --- | --- |
| Contract | One Effect service per runtime: capabilities, and a scoped `openSession` with start, steer and interrupt turn, answer a runtime request, fork, roll back, and one normalized event stream. Typed errors carry "sign-in required" as a field | `packages/provider-core/src/server/ProviderAdapter.ts`, lines 83–725 |
| Accounts | A driver builds one instance per account, each in its own scope. Work is routed by instance, so two accounts never share session state. Callers read capabilities, never the driver | `ProviderInstanceRegistry.ts`; `orchestration-v2/ProviderAdapterRegistry.ts`, lines 62–155; `docs/internals/providers.md` |
| Claude sign-in | t3code runs none. Each Claude account is its own `CLAUDE_CONFIG_DIR`, and the person runs `claude auth login` there. `HOME` is never changed, because that hides Keychain sign-ins. A probe opens the SDK without sending a prompt and reads the reported account (email, plan, token source), so a status check costs no usage | `Drivers/ClaudeHome.ts`, lines 15–50; `ClaudeProvider.ts`, lines 363–464 |
| ChatGPT sign-in | t3code runs its own and keeps the tokens in that machine's owner-only secret store. A broker on a private socket hands the Codex process a short-lived access token, never the refresh token. A remote machine is signed in by a local one running the flow in memory and handing it over; only the destination keeps and refreshes it | `CodexManagedTokenBroker.ts`, lines 45–163; `CodexChatGptHandoff.ts`, lines 11–70 |
| Native conversations | A conversation continues natively only on the same account folder. Codex accounts share session state through links into one folder while each keeps its own `auth.json`. Switching to an unrelated account starts a new conversation with a handoff | `Drivers/CodexHomeLayout.ts`, lines 18–70; `ProviderSessionTransitionPolicy.ts`, lines 44–51 |
| Hosting | No hosted runtime. Agents run on the machine that owns the workspace, with its sign-ins. The hosted web app, phone apps and relay are clients and routes, and get each account's sign-in state and usage in pushed snapshots | `docs/internals/remote.md`; `packages/contracts/src/server.ts`, lines 207–268 |
| Health checks | A status check never signs in, starts MCP servers, runs hooks or opens a browser. Sign-out stops new processes and ends running ones before clearing the account | `docs/internals/providers.md` |

**Ace** has been local-first since 22 October 2026. It no longer creates hosted channels, and a host on the tailnet can serve the team's directory ([pull requests 567 to 569](https://github.com/githubnext/ace/pull/567)). Neuve's copy carries this ([`move.ts`](../../apps/neuve-host/src/move.ts), line 68). A channel's runtime runs on its own host, with that host's keys. The one remaining cloud option, a cloud workspace on the compute beta, splits the runtime: the pi session and model calls stay in a Durable Object using the Worker's keys, and only the tools run in the container ([`services/compute/index.ts`](../../services/compute/index.ts), lines 9–10). [Decision 12.58](../decisions.md#area-12-ace-style-pi-transition-28-october-2026) does not take that split: the shared sandbox hosts the whole runtime. That also suits Claude Code, whose loop and tools are one program.

## 2. One runtime contract and an account registry

Neuve adopts t3code's contract and event union, trimmed to what Neuve uses. It covers opening a session for an account; starting, steering and interrupting a turn; answering a runtime request; one event stream; and a terminal event per turn. Typed errors include "sign-in required", "account rejected" and "usage limit reached". Capabilities are declared. The review stages and the coding channel both use it. Branching happens only in the registry: callers name an account and read capabilities, never the runtime. pi is the first runtime, unchanged and the default; Claude Code is the second.

An account has a name, a kind, a runtime and where its credential lives:

| Account kind | Runtime | Where the credential lives | Who signs in or sets it |
| --- | --- | --- | --- |
| Claude subscription | Claude Code | Claude Code's own config folder for that account, written only by Claude Code | The person, with Claude Code's own login, in Anthropic's flow |
| Anthropic API key | pi or Claude Code | The vault | The person or the team |
| ChatGPT subscription | pi | Neuve's sign-in for that account, held by one refresher | The person, with `neuve auth login openai` |
| OpenAI API key | pi | The vault | The person or the team |

Routes and receipts name the account and its kind, never a credential.

### What is shared and what each runtime keeps

The contract's event stream is the line. Everything above it is Neuve's and is shared by both runtimes, because it reads normalized events, never a loop's internals. Below it, each runtime keeps only its own mechanics. t3code draws the same line: its adapters emit normalized events, and its persistence, projections and UI read only those.

| Shared, owned by Neuve | Where it is today |
| --- | --- |
| Tools: one set, native in pi and served as in-process MCP tools to Claude Code | [`toolkit.ts`](../../packages/harness/src/toolkit.ts) |
| Telemetry, logs and spans | [`telemetry.ts`](../../packages/harness/src/telemetry.ts), [`run-log.ts`](../../packages/harness/src/run-log.ts), [`log-span.ts`](../../packages/harness/src/log-span.ts); no pi imports |
| Receipts, budgets and usage per account | [`receipt.ts`](../../packages/harness/src/receipt.ts), [`budget.ts`](../../packages/harness/src/budget.ts); no pi imports |
| Stage policy: turn limit, output schema, allowed tools, approvals | [`stage-policy.ts`](../../packages/harness/src/stage-policy.ts); no pi imports |
| Masking secrets, writes to Records, the session dump | [`masking.ts`](../../packages/harness/src/masking.ts), [`session-dump.ts`](../../packages/harness/src/session-dump.ts) |
| Per-call telemetry | [`call-telemetry.ts`](../../packages/harness/src/call-telemetry.ts) reads pi's message type today; it would read the contract's usage event instead |

| Kept inside each runtime | pi | Claude Code |
| --- | --- | --- |
| The loop, model calls and wire format | pi | Claude Code |
| Retries and request admission | Neuve's rules, in [`pi/providers`](../../packages/harness/src/pi/providers/) | Claude Code retries on its own; Neuve sees the outcome |
| Failure policy and durable resume | [`pi/failure-policy.ts`](../../packages/harness/src/pi/failure-policy.ts), with pi-durable | Claude Code's own session file |
| Context compaction | pi's | Claude Code's, with a hook before each compaction |
| Native capture | The byte-exact wire record in [`pi/capture`](../../packages/harness/src/pi/capture/) | Claude Code's transcript, a second capture kind ([section 9](#9-outside-this-proposals-focus)) |
| Credentials | Vault, keys and the ChatGPT refresher | Claude Code's own config folder |

Three limits follow from the split:

- **Telemetry depth.** pi shows every model request with exact usage, caching and retries. Through the SDK, Claude Code shows messages with their usage, totals for each turn, rate-limit events and tool calls through hooks, but no raw requests. Shared telemetry is defined on the contract's events, and per-request detail is a capability only pi declares. Claude Code can also export its own OpenTelemetry to the same collector; that is to be checked.
- **Retries.** Neuve's retry and admission rules stay in pi. The shared layer only maps a turn's final failure to the typed errors.
- **Replay.** Only pi's capture replays byte for byte, so runs that evaluation must replay exactly stay on pi.

## 3. Where a runtime runs

| Placement | When | Whose machine | In this work |
| --- | --- | --- | --- |
| The owner's host | A session that isn't shared, and every review the owner runs | The owner's Mac, as Ace and t3code do | Built |
| A machine the person owns, reached remotely | The person runs Neuve's host there, as with t3code's `t3 up` | That machine | Modeled |
| A shared sandbox on the tailnet | A session shared within the tailnet ([decision 12.58](../decisions.md#area-12-ace-style-pi-transition-28-october-2026)) | Neither member's. The system assigns a sandbox that joins the same tailnet and hosts the runtime and the durable session | Modeled ([section 6](#6-the-shared-sandbox-modeled-not-built)) |

The contract and the account kinds are the same in all three. What differs is where an account's credential lives and how sign-in is finished.

The local build keeps the modeled placements open in four ways, and does nothing else for them:

- Callers name an account, never a folder path, a key or an environment variable, so an account can later live in a sandbox user's folder or behind a stand-in.
- Neuve's apps never take a credential. They show an account's state and the command that signs it in, so the same screens serve a terminal into a sandbox later.
- Account status and usage reach the desk and web app as pushed snapshots, not as reads of local files.
- A Claude account is a config folder Claude Code owns, and a provider session stops before its account is removed, so the sandbox's per-member folders and sign-out order are the same mechanism.

## 4. Sign-in

| Account kind | The owner's host or the person's own machine | A shared sandbox |
| --- | --- | --- |
| Claude subscription | `claude auth login` with that account's config folder, run on that machine. Neuve's apps show the command and the account's state, and never take the credential | The member signs in inside the sandbox, as their own sandbox user, through a terminal Neuve opens into the sandbox, the way SSH would. Claude Code's login prints its link and takes the code there. Neuve carries the terminal's bytes and keeps none of them: that terminal is left out of capture and logs |
| Anthropic or OpenAI API key | Set in the vault (Keychain locally), as Ace's Settings does today | Set in the vault; the sandbox gets a stand-in |
| ChatGPT subscription | `neuve auth login openai` on that machine, as today | The member signs in on their own Mac. The result is handed to the refresher with t3code's handoff: an in-memory flow on the Mac, then only the refresher keeps it. The sandbox never sees a refresh token |

For a Claude subscription, the shared sandbox is the case Anthropic's terms name: a platform hosting the unmodified Claude Code, with each person signed in with their own subscription in Anthropic's flow. The sign-in stays in Claude Code's own folder inside the sandbox, which Neuve never reads or copies. Putting a Claude token in the vault and having the broker swap it in would be storing and relaying it, so that is ruled out.

## 5. Who holds and refreshes each token

| Account kind | Holds the long-lived credential | Refreshes it | What the runtime process sees |
| --- | --- | --- | --- |
| Claude subscription | Claude Code, in its config folder (Keychain on macOS, `.credentials.json` on Linux) | Claude Code | Its own folder, nothing else |
| Anthropic or OpenAI API key | The vault | Not applicable | Locally, the key, sealed from tools as Ace's `seal` does today. In a sandbox, a stand-in that the broker swaps on requests to the provider's own host. Claude Code is pointed at the broker with `ANTHROPIC_BASE_URL`, so no TLS interception is needed |
| ChatGPT subscription | One refresher: on the owner's host locally, in the cloud for sandboxes, as [decision 10.131](../decisions.md#area-10-harness-m3-18-october-2026) already does for the cloud | The refresher alone, so refresh-token rotation never races | A short-lived access token, or in a sandbox a stand-in the broker swaps for the current one |

## 6. The shared sandbox (modeled, not built)

This section records how sign-in and tokens would work once shared sessions run in a sandbox, so the local build stays compatible with it. Nothing here is built in this work, and the sandbox column of sections 4 and 5 is modeled the same way.

**Who is asking.** Every turn in a shared session carries the member who sent it, as Tailscale's `whois` names the caller on the tailnet, never as a request claims ([decision 12.30](../decisions.md#area-12-ace-style-pi-transition-28-october-2026)). The sandbox's own join to the tailnet uses a single-use, tagged, ephemeral key from the vault, and its node is removed when the sandbox goes.

**Whose account runs a turn.** A turn runs on the account of the member who sent it: their Claude sign-in or their keys. This is what Anthropic's terms require for a subscription, since no one's plan pays for another person's turns. A team API key that the team provisions for its own members is the alternative for teams that want one bill. Work an agent does on its own after a turn, such as a follow-up or a background step, runs on the account of the member whose turn started it.

**Keeping members' sign-ins apart.** Members' agents share the sandbox's shell, so one member's agent must not read another's credentials. Each member gets their own user inside the sandbox, with their account folders readable only by that user. Their provider sessions and the tools those sessions run, background processes included, run as that user. The workspace is shared through a group. Shell tools from one member's turn cannot read another member's Claude folder, and a member's processes end when their membership does. Desktop and browser tools stay outside the sandbox, as [decision 12.28](../decisions.md#area-12-ace-style-pi-transition-28-october-2026) has them.

**Durable session and native conversations.** The sandbox holds the durable session; the provider sessions are processes that come and go under it:

- **pi:** the conversation is pi's durable session itself. A turn on another member's account only changes the credential behind its calls.
- **Claude Code:** the conversation is Claude Code's own session file. Each member's config folder keeps its credentials private and links its session folder to one session folder for the shared session, the way t3code's Codex accounts share session state while keeping `auth.json` private. A turn by another member resumes the same Claude Code session in that member's process. That resuming a session file under another account works is to be verified. If it doesn't, the switch starts a new Claude Code conversation with a handoff, as t3code does.
- **Switching runtime:** moving between pi and Claude Code always starts a new native conversation with a handoff.

**Durability of sign-ins.** Members' account folders live outside the workspace, in a per-member store that a checkpoint keeps and restores with the sandbox. They are never in a workspace checkpoint, a backup restored into another channel, an export or a capture. Ace's checkpoint already keeps credentials out of `/workspace` ([`checkpoint.ts`](../../services/compute/checkpoint.ts), line 10).

**Leaving and signing out.** When a member leaves the session or signs out, new provider sessions on their account are refused. Their running processes are stopped, and only then are their folders deleted, in t3code's order.

## 7. Provider sessions

- **Lifecycle.** A provider session opens on the first turn that needs it. It stays while the session is active, stops when idle, and resumes from the session's history on the next turn (in a sandbox, from its durable session, with the sandbox's own idle rule). One process per session per account.
- **Status.** Checking an account never signs in and never sends a model request. For Claude, the SDK is opened without a prompt and reports the account, its plan and its token source. For keys, the provider's model list is read, as Ace's Settings does. For ChatGPT, the refresher's state and the model list are read. The results reach the desk and web app as pushed snapshots.
- **Usage.** Usage limits are tracked per account, from Claude Code's rate-limit events and each call's usage, and shown beside the account. A turn that meets an account's limit ends with "usage limit reached" for that account. It never falls back to another account on its own; locally the owner picks another account, and in a sandbox it never moves to another member's account.
- **Rejected credentials.** A sign-in the provider rejects ends the turn with "sign-in required" for that account and that member, and shows the command or Settings entry that fixes it.

## 8. Refusing subscription tokens on direct routes

Whatever else is decided, the direct routes refuse a subscription token. The harness's Anthropic route and the coding host's model catalogue reject a key that is a subscription token, and the host stops resolving `ANTHROPIC_OAUTH_TOKEN`. The message points to a Claude subscription account. This closes the forbidden path in the starting facts.

## 9. Outside this proposal's focus

How review stages and coding chats run on the Claude Code runtime belongs to the build, not to sign-in. A stage turns off Claude Code's own tools and personal settings, serves Neuve's tools as in-process MCP tools and keeps its turn limit and output schema. A Claude Code session's capture is a second capture kind beside pi's raw capture, without the byte-exact wire record. Batch runs such as hill climbs and benchmark sweeps stay on API keys, because they are past ordinary individual use.

## 10. What this changes in the decisions

| Row | Change |
| --- | --- |
| [10.85](../decisions.md#area-10-harness-m3-18-october-2026) (Opus stays on API keys) | Amended: a Claude subscription account may run the Opus route through the unmodified Claude Code program. Direct API routes stay on API keys and refuse subscription tokens |
| [12.1](../decisions.md#area-12-ace-style-pi-transition-28-october-2026) (pi owns agent execution) | Amended: pi owns agent execution on pi accounts; on a Claude subscription account Claude Code runs the loop, and Neuve owns everything around it |
| [12.29](../decisions.md#area-12-ace-style-pi-transition-28-october-2026) (vault and broker) | Clarified: a Claude subscription is never kept in the vault or swapped by the broker; it lives only in Claude Code's own folder |
| [9.55](../decisions.md#area-9-benchmark-m4-17-october-2026) (labelling on the subscription token) | Batch labelling moves to the API key, or stays as an owner exception |
| [Record 0008](../../architecture/decisions/0008-model-routes-and-budgets.md) and [record 0014](../../architecture/decisions/0014-ace-style-pi-harness.md) | Updated with the runtime contract and accounts |

## 11. Decisions for the owner

Only the first question is needed for this work. The other three belong to the shared sandbox and stay open until it is built; their recommendations are what section 6 models.

| # | Question | Options | Recommendation |
| --- | --- | --- | --- |
| CS1 | May Claude Code run the agent loop for Claude subscription accounts, beside pi? Decided: yes, by [decision 12.59](../decisions.md#area-12-ace-style-pi-transition-28-october-2026) | (a) yes; (b) no, Claude stays on API keys | (a). It is the only allowed way to use the subscription, and it is what t3code does: a Claude account always runs on Claude Code's own loop through the Agent SDK, and pi is a separate runtime with its own accounts (t3code `orchestration-v2/Adapters/ClaudeAdapterV2.ts`; `packages/provider-pi`) |
| CS2 | Whose account runs a turn in a shared session? | (a) the member who sent it; (b) a team API key for everyone; (c) the session owner's | (a), with (b) as a team's choice. Option (c) would put others' turns on one person's plan, which the terms rule out for subscriptions |
| CS3 | How does a member sign in to Claude inside a shared sandbox? | (a) Claude Code's own login in a terminal into the sandbox, as their sandbox user; (b) shared sessions take API keys only | (a) |
| CS4 | May members' sign-ins persist with the sandbox's checkpoint, in a per-member store outside the workspace? | (a) yes; (b) sign in again each time the sandbox starts | (a) |

## 12. Build order

This work, all on the owner's host:

1. Refuse subscription tokens on the direct routes (section 8).
2. The runtime contract and account registry, with pi as the first runtime and no behaviour change.
3. Accounts on the owner's host: Claude config folders, the no-request status probe, usage per account, sign-in state in the desk and web app, and sign-out in t3code's order.
4. The Claude Code runtime for review stages and coding chats on the owner's host.

Later, not in this work: the shared sandbox's accounts as section 6 models them, and remote machines.
