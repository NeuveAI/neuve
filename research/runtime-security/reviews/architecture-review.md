# Runtime security research: architecture review

Independent review, 2 November 2026. It judges the four runtime-security studies against Neuve's decisions, architecture records and vocabulary. It decides nothing and changes no code. Proposed terms are listed for the owner and are not used here as product terms.

**What was reviewed:**

- [What Neuve does today](../01-neuve-today.md): credentials, processes, the places where data leaves, and the gaps.
- [Ace and GitHub Next](../02-ace-and-github-next.md): precedents from Ace, pi and GitHub's agent workflows.
- [Sandboxing generated code](../03-sandboxing-generated-code.md): isolation tiers and a seven-layer proposal.
- [Secrets and exfiltration](../04-secrets-and-exfiltration.md): the guard and vault design.

**Ground truth:**

- The rewrite on `codex/pi-transition` in this repository. Its [decisions record](../../../process/decisions.md) holds Area 12, the Ace-style transition. Its [Ace-style harness record](../../../architecture/decisions/0014-ace-style-pi-harness.md) sets the coding and final-review session boundaries.
- Main's [decisions record](../../../process/decisions.md) matches the rewrite for Areas 1 to 11, and it has neither Area 12 nor record 0014.
- Every coding-host recommendation therefore lands on the transition branch. Main stays unchanged until the owner authorizes the merge ([decision 12.4, integrate only into a new branch](../../../process/decisions.md)).

A few load-bearing code claims were checked by reading the code (noted where used). Nothing was run.

## Verdict

The studies are sound on facts and mostly sound on direction. The coding session is the real gap. Its shell runs as the owner, with every sign-in and the Records store in reach. An OS sandbox around that shell is the highest-value step, and pi's execution-environment seam is the right place for it. Three things need correcting before anything is built:

- **The guard as proposed blocks.** It refuses requests inline and holds pushes, which conflicts with the owner's "never blocking the workflow".
- **The broker as proposed is a standing local service** that manages credentials. Today's decisions rule out both.
- **The sandbox as proposed would break Neuve's own capture.** Commits inside a sandboxed shell must still reach the hook spool, the capacity connection and the session ID.

Locally, most of the "broker" reduces to the sandbox's own network proxy plus a scoped Git credential helper. The model keys can stay in the channel worker's memory, which sits outside the sandbox.

## 1. Recommendations against the decisions

Each row: the recommendation, its source study, whether it fits, the decision it touches, whether it is wider than needed, and whether it holds locally and hosted.

### Repository code out of Neuve's process

| Recommendation | Fit | Decisions touched | Wider than needed? | Local and hosted |
| --- | --- | --- | --- | --- |
| Neuve never loads repository code: keep the release build's no-autoload flags, add them to the evaluation build, and pin Neuve's own `git` (03 layer 1) | **Fits.** It applies the rule that a reviewed range cannot change what the worker starts ([10.52, integrations defined only in the user's file](../../../process/decisions.md)) and the frozen source in record 0014 | 10.52; record 0014 | No. One caveat: `-c core.hooksPath=/dev/null` must apply to read commands only. Neuve's capture depends on git hooks calling the CLI ([event-driven processes record](../../../architecture/decisions/0002-event-driven-processes.md), step 1). Reuse the pins that `graph-client`'s read qualification and the stack transport already set, rather than a third list | Both |
| Explicit, allowlisted environment for every child; no inheritance (02 pattern table, 01 layer-2 gap) | **Fits, and is required.** The Records worker starts with the full `process.env` (`packages/records-core/src/starter.ts:104`, checked). That contradicts [10.5, credentials passed only to the call that needs them](../../../process/decisions.md) | 10.5; [the stack store record](../../../architecture/decisions/0012-stack-store.md), whose `scrubbedEnvironment` is the model to reuse | No | Both |
| `Bun.spawn` without `env` passes sealed variables (02) | **Correct, but mostly moot where 02 points.** The listed harness sites (`git.ts:31`, checked) run in the Records worker, which never seals. The fix is the explicit-environment row above, not a seal repair | 10.5 | — | Both |
| OS sandbox for every coding-session command (Seatbelt locally), with no environment inheritance and network only through a proxy (03 layers 3 to 5) | **Fits [record 0014](../../../architecture/decisions/0014-ace-style-pi-harness.md)'s "coding sessions may write in their assigned worktree", with four conditions.** (a) The channel worker is Ace code. The change must be one small seam listed in the host's `UPSTREAM.md` ([12.11, keep Neuve policy in its own modules through small listed seams](../../../process/decisions.md)). (b) It must not deny the hook spool, or commits made in the sandbox lose their capture. (c) It must not deny the capacity connection, which [10.93](../../../process/decisions.md) already requires agent sandboxes to allow. (d) It must not drop `NEUVE_SESSION`, the session ID the hook falls back to inside a sandbox ([identity record 0009](../../../architecture/decisions/0009-identity-without-auth.md), [8.13](../../../process/decisions.md)) | 0014; 12.11; 10.93; 0009 and 8.13; [2.16, codebase facts apart from agent work](../../../process/decisions.md); [6.10, never unbounded](../../../process/decisions.md) | Hard-coded LaCie paths in the policy are too narrow. Storage is configurable per record 0014, so the policy must come from the configured storage profile | Local: Seatbelt. Hosted: a container per session (row below) |
| Refuse to run if the sandbox cannot start (03, step 2) | **Conflicts.** 12.11 says a missing machine prerequisite "follows its original handler" and forbids blanket capability refusals. It also cuts against the owner's "never blocking the workflow" | 12.11; owner goal | — | Owner decision (below) |
| File tools need path containment (02, 03) | **Fits, and 03's first step misses it.** pi's `read`, `write` and `edit` run inside the channel worker (02, `NodeExecutionEnv`). A Seatbelt wrapper around shell commands leaves them unconfined, so the `read` tool could still open the Neuve sign-in file | 0014 | No | Both |
| Separate execution-environment factories for coding and review, with no `bash` in review (03 layer 2) | **Already true in effect.** Review stages offer lookup tools only (01, `stages/steps.ts`). It is worth stating in the record, not rebuilding | 0014; [10.77, isolation and bounded CPU](../../../process/decisions.md) | Yes as a build item. As a stated rule it costs nothing | Both |
| A VM per session locally; gVisor or Firecracker run by Neuve; Landlock inside hosted VMs (03) | **Wider than needed now.** 03 says so itself | — | Yes | Hosted later |
| Hosted coding sessions in Cloudflare Containers through the Sandbox SDK, with outbound Workers (03) | **Fits [10.92, Cloudflare as a hosted platform](../../../process/decisions.md) and Ace's workspace protocol**, which already implements pi's execution environment remotely | 10.92; 10.93 ("decided when hosted work starts") | Not now | Hosted |
| "Review logic can stay in Workers, because its tools need no native code" (03) | **Wrong as stated.** Precompute and the review tools read Git objects, call Graph (a Go binary) and run local encoders. [10.117](../../../process/decisions.md) keeps embeddings and the reranker on the machine so that code never leaves it. Hosted review needs a container or a hosted Graph, not isolates alone | 10.117; 10.93; [Graph search service record 0013](../../../architecture/decisions/0013-graph-search-service.md) | — | Hosted is open |

### The guard on the places where data leaves

| Recommendation | Fit | Decisions touched | Wider than needed? | Local and hosted |
| --- | --- | --- | --- | --- |
| A broker on the path: holds the real credentials, injects them, refuses any request that carries a registered value (04) | **Conflicts in three ways.** (1) An inline refusal of a model call stops a review stage. That breaks the owner's "never blocks" and the pipeline's "no gates" and resilient budgets ([harness pipeline record 0005](../../../architecture/decisions/0005-harness-pipeline.md), [2.5](../../../process/decisions.md)). (2) Rewriting the body instead would alter model input, which record 0014 rules out ("without altering model input"), and would split the raw capture from the wire ([12.12, keep raw](../../../process/decisions.md)). (3) A separate local process that every call depends on is an always-on service, which [6.9](../../../process/decisions.md) and record 0002 rule out | 0005; 2.5; 0014; 12.12; 6.9; 0002 | **Yes, locally.** Once commands are sandboxed, the model keys never enter the sandbox: the channel worker outside holds them in memory, which is already true. What remains is the sandbox's own network proxy and a scoped Git helper. Its lifetime should follow its sessions, as the capacity host follows its grants ([10.93](../../../process/decisions.md)) | Hosted: outbound Workers provide injection natively and fit 10.92 |
| The broker mints short-lived tokens per run and revokes them on a finding; a GitHub App; hosted credentials in KV keyed by container; a live canary (04) | **Conflicts with [10.5, Neuve stores, generates and manages no credentials](../../../process/decisions.md).** Minting, revoking and storing are generating and managing. 04 flags only the GitHub App | 10.5 | Yes | Owner decision; hosted multi-user makes 10.5 harder (below) |
| A canary registered only as a known value (no live account) | **Fits.** It is a string the existing detectors match | 12.27 | No | Both |
| A background watcher as a Records queue job with 12.27's rules (04) | **Fits the architecture well.** It reuses the queue, the background slot, spaced retries, the dead-letter list and the audit command from [12.27, the scan moves to a background job](../../../process/decisions.md). Records owns the job and the mark. The scan itself is harness computation run by the worker ([layers record 0001](../../../architecture/decisions/0001-layers-and-responsibilities.md): Records stores and coordinates; the harness computes) | 12.27; 8.12; 10.31; 0001 | Its tamper watch is wider than needed: process forks outliving a run, CI workflow file changes, guard configuration drift. A changed workflow file is review content, which the review already sees. Alerting on it adds noise, against [signal without noise](../../../foundations/05-reviewers-tax.md) | Hosted: the `JobQueue` port swaps the queue (8.12) |
| Hold only what cannot be taken back; label the rest (02, after gh-aw's warn mode) | **Fits the owner's goal best.** It matches 12.27's mark gate on export. 04's "hold the push until its job passes" still delays a coding agent's push. Whether that counts as blocking is the owner's call | 12.27; owner goal | No | Both |
| Register every value Ace seals, plus a canary, with the existing detectors (04's first step) | **Fits, narrowed.** Detectors live in the private inspection authority (record 0014). Registration must happen at the host boundary, because Channel has no Neuve or Records dependency (12.11). Not every listed value qualifies: `MODAL_TOKEN_ID` is not sealed (01: the seal matches name suffixes), and the lease keys live on Modal machines, not the host | 0014; 12.11; 12.27 | No | Local first |
| Put the replay store archive behind the mark (01, 04) | **Fits, but the owner must classify it.** 01 records it as "the owner's restricted copy, not a dataset" | 12.27; [10.129, replay on Modal](../../../process/decisions.md) | Possibly | Cloud |
| No external images in the review desk; neutralize links to unlisted hosts (04) | **Fits the web app layer.** The desk's response headers set only `frame-ancestors` today (`apps/neuve-web/apps/web/src/server/framing.ts`, checked) | Architecture README, web app layer | No | Both |

### Keeping values out of logs, messages, telemetry and datasets

| Recommendation | Fit | Decisions touched | Wider than needed? | Local and hosted |
| --- | --- | --- | --- | --- |
| References instead of values in settings; values read as Effect `Redacted`; one unwrap point (04) | **Fits [10.5](../../../process/decisions.md) and [10.52](../../../process/decisions.md)'s `${NAME}` pattern.** The OTLP `headers` map holding values is the first real case | 10.5; 10.52; [10.32, OTLP only to a named endpoint](../../../process/decisions.md) | The 1Password and Secrets Store references are wider than needed until hosted work | Both |
| `Schema.Redacted` on credential-bearing fields in `records-schema` (04) | **Conflicts.** [Record 0011](../../../architecture/decisions/0011-zod-schemas.md) makes zod the one schema library, and `records-schema` is zod. Records should hold no credential field at all: the run receipt names the key variable, never its value ([10.73](../../../process/decisions.md)). `Redacted` belongs in the harness and host settings (Effect), where `settings.ts` already imports Effect | 0011; 10.73 | Yes | — |
| A `bun run check` rule that refuses `Redacted.value` outside one module (04) | Possible. 04 itself marks this as the owner's call | The repository's check command ([AGENTS guidance](../../../AGENTS.md)) | Possibly | — |
| "Environment values never reach datasets" (owner's goal) | **Holds only at the exit, not in storage.** [12.12](../../../process/decisions.md) keeps raw capture byte-exact, so a value a tool printed stays in the restricted raw copy. The guarantee comes from the mark on export (12.27) plus scrubbing upstream (sandbox, explicit environments). The record should say so | 12.12; 12.27 | — | Both |
| Positive allowlists for logs (02: "already in place for host logs") | **02 overstates this.** Only `worker-runtime.ts` uses `private-log.ts`. The gateway, host and CLI still import Ace's `log.ts`, which writes fields as given (checked). 01 is right | 12.11 (Ace file, so a seam) | No | Both |

### Where the studies disagree

| Point | One study | The other | Reading |
| --- | --- | --- | --- |
| Block or label | 04: refuse inline and hold irreversible actions. 03: fail closed | 02: label, and hold only what cannot be reviewed | 02 matches the owner's "never blocks". This needs an owner row |
| GitHub sign-in in agent shells | 04: agents push "with the host's GitHub token" | 01: `GH_TOKEN` is sealed out of shells. The gh CLI's own sign-in, Git credential helpers and the SSH agent socket stay reachable | 01 is more precise. A Git proxy alone does not close this. The sandbox must also deny the gh configuration, the helpers and the agent socket |
| Teammates on the tailnet starting `bash` | 03: unverified, and it decides urgency | 02: traced in code; reachable when a channel's agent access is on | Take 02's trace. A sandbox matters for peer-driven sessions too |
| Who owns enforcement | 03 relies on 04's broker | 04 says the sandboxing study owns enforcement | A circular dependency. Order it sandbox first, then the scoped Git helper, then the background scan of what left |
| First step | 03: sandbox the shell | 04: register sealed values and type the settings | 01 shows the bigger exposure is reach, not detection, so the sandbox and explicit environments come first. 04's steps are cheap and can run in parallel |
| Hosted review | 03: Workers | 03's own native-work caveat; 10.117 | See the first table |

### Decisions that themselves need a clarifying row

- **[6.6, no auth or authorization code](../../../process/decisions.md) and [record 0009](../../../architecture/decisions/0009-identity-without-auth.md).** Both say "remove all token gates, credential checks". Yet [12.11](../../../process/decisions.md) restored Ace's host token, `whois` and project-access checks. Branch rules on pushes, sandbox denies and peer gates are capability limits on agents, not identity checks on people. Without a row saying so, every ticket below can be read as contradicting 6.6.
- **[10.5](../../../process/decisions.md) in hosted multi-user mode.** There, the "user's own environment" is whatever the hosted operator holds per tenant. The row needs a hosted reading before a hosted vault is designed.
- **The six-layer table in the [architecture overview](../../../architecture/README.md) has no row for the coding host and channel worker.** Record 0014 added them. The guard and the sandbox mostly live there, so they currently have no architectural home.

## 2. Where each piece would live

| Piece | Home | Reuses | New |
| --- | --- | --- | --- |
| **Sandbox for coding commands** | The coding host: a Neuve module beside Ace, reached through one listed seam where `worker.ts` builds the execution environment (`env(cwd)`, line 99, checked) | pi's `ExecutionEnv` interface and its `beforeTool` and `afterTool` hooks. Graph's Seatbelt pattern in `apps/neuve-graph/internal/sem/lsp_enrichment.go`: a generated profile and a verified `sandbox-exec`. It is an allow-default profile with denies, so the coding policy needs a different shape. Ace's seal. Capacity grants (10.93) for bounds. The `NEUVE_SESSION` handoff (0009) | A policy module: write the worktree and a temporary folder for the session; deny the sign-in folders, the host token, the Records store (with the spool carved out) and the common directory's config and hooks; network through the proxy. File-tool path checks. A platform port with a macOS adapter now and a container adapter later (the [10.92](../../../process/decisions.md) pattern) |
| **Explicit child environments** | Harness and Records core, for the worker start and every spawn | `scrubbedEnvironment` and `GIT_ENVIRONMENT` in `packages/harness/src/stack/transport.ts`; Graph's allowlist in `graph-client`; the labeller's allowlist | One shared allowlist builder, and the provider key handed only to its route |
| **Guard, on the path** | Coding: the sandbox's network proxy plus a scoped Git credential helper in the host. Review: unchanged, since the provider seam (`agent-route-provider.ts`) already registers detectors at dispatch | Ace's compute runner helper (a 0600 token file and one host and path); the stack transport's host allowlist; the Modal lease refresher (10.131) as the brokered shape | The helper for coding lanes and the proxy allowlist. No standing broker process locally |
| **Guard, in the background** | A harness job handler run by the Records worker. Records owns the job, its events and the mark. The CLI lists it through `neuve jobs` and the 12.27 audit command | The 12.27 queue rules, the dead-letter list, the private inspection authority, `masking.ts` shapes | A record of what left (an event kind). Its first source is a coding agent's push |
| **Values kept as references** | Harness and host settings, and the credential owner (`openai-auth.ts`). Ace's `key()` lookup feeds pi-ai's injected `authContext.env` | Effect `Redacted` (already in `count-tokens.ts`); 10.52's listed-variable expansion | Reference fields for OTLP headers; `Config.Redacted` reads |
| **Desk rendering** | Web app, in the existing `framing.ts` header path | The existing CSP header | `img-src` and link neutralization |

## 3. Terms that need the owner

None of these is in the [product vocabulary](../../../vocabulary.md). This review adds none of them.

| Term in the studies | Issue |
| --- | --- |
| Credential guard | The owner's working word. 04 splits it into two parts ("broker" and "watcher") that have different trust and lifetimes. Is it one term or two? |
| Vault | 04's vault stores nothing; it is a resolver plus a typed wrapper. The word suggests a store, which collides with 10.5 |
| Broker | New. Locally it reduces to a proxy plus a Git helper. Is a term needed at all? |
| Watcher; "record of send-outs" | 04 says the second is a description, not a term. The first is used as a noun throughout |
| Placeholder, canary | New |
| Egress point, send-out | New. 01 and 04 use different lists. 04's list omits channel messages to peers, channel moves and compute snapshots, binary proofs, external agent transcripts and host logs, all of which 01 names |
| Coding session, final-review session, session kind | Used in record 0014 but not defined in the vocabulary |
| Workspace | **Collision.** [12.7](../../../process/decisions.md) defines the workspace as Ace's collaborative home. 02 and 03 also use "workspace" for Ace's remote file-and-shell executor |
| Mark, clean mark, mark gate, mark chain | **Near-collision** with the vocabulary's "Mark viewed", "Contextual marker" and "Marker pin". 12.27 uses "marked clean" as a verb only |
| Lane | 03 and 04 say "lane" for a coding worktree. That fits [12.21](../../../process/decisions.md) inside tools. Owner-facing text must write "review lane" in full for the Neuve concept |
| Refusal | 04's watcher "records a refusal". Capture already uses refusal for refused exports. The meaning must not drift |
| Forks | 04 says the owner's word is ambiguous: Git forks, process forks, or both. Still open |
| Untrusted repository (setting), trust level | New. 03 proposes them as a later local mode |

## 4. Owner decisions the tickets wait on

1. **Block or label.** For each place where data leaves, does a finding label, hold or refuse? Proposed: label reviewable outputs; hold only irreversible ones (a push, a dataset export); never refuse a model call inline. Needs a decisions-record row.
2. **Sandbox unavailable.** When the sandbox cannot start, does the command run, or does the session say so and refuse? This must be reconciled with 12.11. Needs a row.
3. **What 6.6 covers.** A row saying that agent capability limits (sandbox, branch rules, peer gates) are not the auth code 6.6 removes.
4. **What coding agents may publish.** May they push and open pull requests directly, and to which remotes and branches? 12.8 and 12.11 keep Ace's pull-request journey.
5. **Network for coding sessions.** Which registries and hosts are allowed, and does `bun install` run inside the sandbox or before it?
6. **The replay store archive.** Is it a dataset (behind the mark) or the owner's restricted copy?
7. **The terms in section 3**, including what "forks" means.
8. **The "independent service".** Read against 6.9's "no always-on service", does it mean a separate process, a separate trust footing, or a job?

## 5. Proposed tickets

Scope for accepted tickets goes to Linear through the Linear upkeep chat ([7.12 and 7.13, scope lives once in Linear](../../../process/decisions.md)). All of them target `codex/pi-transition`.

| # | Title | Scope in / out | Concern | Decisions | Smallest first step | Depends on | Owner decision or row? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Every child process gets an explicit environment | **In:** the Records worker start (`starter.ts`); harness `Bun.spawn` sites; the semantic client; the `gh` scope fetch; the OpenAI token command. **Out:** coding shells (ticket 3) | Code out of the process; values | 10.5, 10.52, 0012 | Lift `scrubbedEnvironment` into one shared builder and apply it at `starter.ts` and `git.ts`. Test reason: a dummy sealed variable must not reach a child | — | No; it applies 10.5 |
| 2 | Neuve never runs repository configuration | **In:** pins for read-only harness git commands, reusing graph-client's qualification (fsmonitor, hooks, external diff and textconv); the no-autoload flags in the evaluation build. **Out:** commits that must fire capture hooks | Code out of the process | 10.52, 0014, 0002 | Confirm 01's unverified point against a fixture repository whose config names an fsmonitor program, then pin | — | No |
| 3 | Coding-session commands run under the macOS sandbox | **In:** one listed seam at `worker.ts` `env(cwd)`; a Neuve-owned policy module (worktree and temporary-folder writes; denies for sign-in folders, the host token, the Records store with the spool carved out, and the common directory's config and hooks); the capacity connection and `NEUVE_SESSION` allowed; no environment inheritance. **Out:** network proxy (ticket 5), hosted (ticket 15), Linux | Code out of the process | 0014, 12.11, 12.14, 10.93, 0009, 8.13, 2.16, 6.10 | File denies only, with no network change, on one channel. Proof converges: reading the host token is refused, a commit still reaches the spool, and the job still holds capacity | 1 | Yes: decisions 2 and 3; a row for the boundary |
| 4 | File tools stay inside the worktree | **In:** path checks on pi's `read`, `write` and `edit` through the execution environment, using the same deny list as ticket 3. A refusal returns a tool error. **Out:** the shell | Code out of the process | 0014 | Resolve real paths and refuse the sign-in folder and the Records store | 3 (shared policy) | No |
| 5 | Coding-session network through an allowlisting proxy | **In:** the proxy that ticket 3's sandbox routes to; refused hosts reported to the owner, not to the review desk. **Out:** TLS interception, body inspection | Guard | 6.10, 12.11, signal without noise | Model hosts only, with the refusal log | 3 | Yes: decision 5 |
| 6 | Scoped Git credential for coding lanes | **In:** Ace's compute-runner helper pattern (one host and path, token outside the project); sandbox denies for the gh sign-in, Git helpers and the SSH agent socket. **Out:** a GitHub App, minted tokens | Guard; values | 10.5, 6.6, 12.8, 12.11 | The helper for clone and fetch on one channel, with pushes unchanged | 3 | Yes: decisions 3 and 4 |
| 7 | The spool cannot register a human actor | **In:** confirm 01's unverified point; refuse a spooled human-kind registration. **Out:** cryptographic actor proof | Records integrity | 4.5, 0009, 6.6 | A fixture spool event that claims the human kind | — | No; it applies 4.5 |
| 8 | Confirm the `agent@` author gate | **In:** whether a Tailscale login can begin with `agent@`; if so, a fix through a listed seam and a report upstream. **Out:** Ace's project-access hole (Ace issue 511) | Multi-user | 12.11, 12.14 | Trace `authored` in `gateway.ts` against `isAgent` in `room.ts` | — | No, unless the fix changes an Ace operation |
| 9 | Register host-sealed values with the capture detectors | **In:** values in the host's sealed map, registered at the host boundary for coding captures. **Out:** Modal tokens, live canaries | Guard | 0014, 12.11, 12.27 | Register the GitHub token when sealed; export refuses a capture holding a dummy registered value | — | No (a registered-only canary would need decision 7) |
| 10 | Replay store archive follows the mark | **In:** the archive carries only marked-clean captures, or is declared restricted. **Out:** free-page and backup residue (separate) | Guard | 12.27, 10.129 | Classify it with the owner | — | Yes: decision 6 |
| 11 | Host and gateway logs pass the field allowlist | **In:** route Ace's `log.ts` callers through `private-log`'s diagnostics filter by a listed seam. **Out:** pi capture | Values | 12.11, 10.97 | List which `failure()` fields reach the host log today | — | No |
| 12 | Settings hold references, read as `Redacted` | **In:** OTLP header values become variable names, expanded like 10.52 and read with `Config.Redacted`. **Out:** `records-schema` (0011), external secret stores, the check rule | Values | 10.5, 10.52, 10.32, 0011 | The OTLP headers field only | — | No (the check rule would be) |
| 13 | The review desk loads no external images | **In:** `img-src 'self'` beside the existing `frame-ancestors`; neutralized links to unlisted hosts in model-written text. **Out:** Ace's chat rendering | Guard | Architecture README (web app layer) | The CSP line plus one fixture with an external image | — | No |
| 14 | Background scan of what a coding agent pushed | **In:** an event recording a push (where, a content hash); a background job running the registered detectors and pattern shapes over the patch; findings labelled where the owner chooses. **Out:** process-fork watching, CI-file alarms, verified detection, token revocation | Guard | 12.27, 8.12, 10.31, 0001, signal without noise | Record the push event only | 6; decision 1 | Yes: decisions 1, 7 and 8 |
| 15 | Runtime boundary record and a hosted execution port | **In:** an architecture record that places the coding host in the layer table, states the three layers and their local and hosted adapters, and states the review-session rule from 03 layer 2. A container adapter only when hosted work starts (10.93). **Out:** building hosted now | All | 0001, 0014, 10.92, 10.93 | Draft the record after decisions 1 to 3 | Decisions 1 to 3, 8 | Yes: the record needs owner acceptance |

Fifteen tickets. Tickets 1, 2, 7, 8, 9, 11, 12 and 13 need no owner decision and can start now with disjoint ownership. Ticket 3 is the highest-value item. It waits only on decisions 2 and 3.
