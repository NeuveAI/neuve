# Runtime security backlog

Editor's merge, 2 November 2026. It turns three independent reviews of the runtime security research into one deduplicated backlog. It decides nothing and changes no code. Accepted scope goes to Linear through the Linear upkeep chat, because each workstream's scope lives once, in Linear. Code work lands on the rewrite's transition branch; main stays unchanged until the owner merges it.

**Superseded in part, the same day.** The owner's later decisions are rows 12.28 and 12.29 in the rewrite's [decisions record](../../process/decisions.md). They override this file wherever the two differ:

- Each coding channel runs in its own sandbox: locally for a channel with one person, and in the cloud for a channel with more than one. Nothing runs on a member's machine.
- A vault and a broker hand each checkout its credentials and settings.
- Every low-priority ticket is dropped.

Several tickets and owner decisions below are therefore moot or merged. The current set is in Linear under NEU-60.

**Sources, and why each matters:**

- The three reviews whose tickets are merged here:
  - [threat-model review](reviews/threat-model-review.md): checked the studies against the code, ran experiments with dummy values, and found the errors listed below. Where reviewers disagree, its verified claim wins.
  - [architecture review](reviews/architecture-review.md): found where the studies conflict with the owner's decisions. Those conflicts shape every ticket.
  - [sequencing review](reviews/sequencing-review.md): set the order, the owner's no-code steps and the sandbox defaults that would break ordinary coding.
- The four studies they review: [what Neuve does today](01-neuve-today.md), [Ace and GitHub Next](02-ace-and-github-next.md), [sandboxing generated code](03-sandboxing-generated-code.md) and [secrets and exfiltration](04-secrets-and-exfiltration.md).
- Ground truth: the rewrite's [decisions record](../../process/decisions.md), which overrides older text; its [product vocabulary](../../vocabulary.md), which no ticket may change without the owner; and its [repository guidance](../../AGENTS.md), which sets the kinds of proof: code, tests, telemetry, logs, and Chrome DevTools MCP screenshots and video for browser work. They must converge, and one kind alone is not enough. Documentation needs none.

**Reading this file:**

- Code paths are in the rewrite in this repository unless marked. "The background-scan worktree" is the scan lane's external worktree, the scan's lane before it lands.
- "Credential guard" and "vault" are the owner's working words. They are not vocabulary terms.
- Channel, chat, agent access, project access and peer are Ace's words, used here as the [Ace-style harness record](../../architecture/decisions/0014-ace-style-pi-harness.md) uses them. They are listed for approval below.
- "A chat's worktree" stands for the tools' "lane". In owner text, "review lane" stays the Neuve concept, as decision 12.21 (always write "review lane" in full) requires.

## Backlog

The tickets live in Linear, under the parent NEU-60, which holds their status and ordering. This document is their evidence; the table links each one to its Linear issue so its status is read there.

| Ticket | Linear | Phase | Priority | Scope | Concern | Waits on |
| --- | --- | --- | --- | --- | --- | --- |
| Peer access holds against teammates | NEU-61 | 1 | Urgent | Share checks, `agent@` logins, channels with no settings, peers' messages | Any tailnet device can forge project access with one request, then reach the owner's shell | Peers on this host (part) |
| Neuve's own processes take no environment from their callers | NEU-62 | 1 | Urgent | Records worker start, hooks, encoders, `gh` scope fetch, token command | An environment variable puts code into Neuve's own process | None |
| Neuve never runs repository configuration | NEU-63 | 1 | High | Pinned Git for read commands, the unused diff helper, evaluation build flags | A planted Git program runs beside Neuve's model keys | None |
| Settle the open security questions | NEU-64 | 1 | High | Probes and code reading with dummy values | Later tickets rest on unproven premises | None |
| No external images in rendered agent text | NEU-65 | 1 | High | Content security policy on the coding app and the review desk | An image link in model-written text sends data out when opened | None |
| The replay archive follows the mark | NEU-66 | 1 | Medium | The cloud store archive | Unscanned raw captures leave the cloud machine | The replay archive |
| A runtime boundary record | NEU-67 | 1 | Medium | One architecture record of the layers | Lanes cannot tell what the boundary guarantees | Label or hold; When the sandbox cannot start; What the no-auth decision covers; What independent means |
| Coding agents get their own environment | NEU-68 | 2 | Urgent | Agent tools' own execution environment, with an allowlist | Credentials under names the seal misses reach every agent command | Agent environment and reads; Whose push credential (interim) |
| File tools stay within path rules | NEU-71 | 2 | High | pi's read, write and edit | A sandbox around commands leaves file tools reaching any path | Agent environment and reads |
| Coding commands run under the macOS sandbox | NEU-72 | 2 | High | Seatbelt around agent commands, with carve-outs | Dependency scripts and generated code read every sign-in and the store | When the sandbox cannot start; What the no-auth decision covers; Sandbox mechanism |
| Coding network through an allowlisting proxy | NEU-73 | 2 | Medium | One proxy per session, watch first | Direct leaks from the shell, DNS included | Coding network |
| Pushes use a scoped Git credential | NEU-74 | 2 | High | A helper for the chat's own remote; then deny `gh` and SSH to agents | Agents hold the owner's push rights to every repository | What agents may publish; Whose push credential |
| The spool cannot register a human | NEU-69 | 2 | Medium | Spool refusal, audit of marks | Any process that writes the spool can approve as a human | What the no-auth decision covers (row only) |
| Tell the person from a local process | NEU-75 | 2 | Medium | The loopback app gateway, the review desk, the human commands | A local process records dispositions as the human and takes the owner's host connection | What the no-auth decision covers; The person at the desk |
| No spawn without an explicit environment | NEU-70 | 2 | Low | A check in the coding host and channel worker | Sealed values leak to spawned programs | New check rules |
| Register sealed values and a canary | NEU-76 | 3 | Medium | Capture's detectors | The scan knows only model-call header values | Vocabulary terms (canary) |
| Logs pass the field allowlist | NEU-79 | 3 | Medium | Host log, `worker.log` | Error fields are written as given | None |
| Settings hold references, not values | NEU-77 | 3 | Medium | Telemetry collector headers first | A value in settings reaches logs or records | New check rules (only for the rule) |
| Run data at rest | NEU-78 | 3 | Medium | Pruned bytes, stale host homes, the drive | Files on LaCie are readable regardless of their modes | The LaCie drive |
| Background scan of what left | NEU-80 | 3 | Medium | A record of send-outs and a Records queue job | Leaks through pushes are not seen at all | Label or hold; What independent means; Verified detection; What forks means; Vocabulary terms |
| Agent proposes, Neuve publishes | NEU-81 | 3 | Low | Pushes and pull requests applied through the host | The agent's process tree holds a credential and a way out | What agents may publish |
| Hosted coding sessions | NEU-82 | 4 | Low now, required before deployment | One VM per session, outbound Workers, hosted authorship | Many users on shared infrastructure; team-secret holders post as anyone | Hosted precondition |

Twenty-two tickets: seven in phase 1, eight in phase 2, six in phase 3 and one in phase 4.

## How the three sets were merged

- **Duplicates folded.** The threat-model review's twelve tickets, the architecture review's fifteen and the sequencing review's twenty-one overlap heavily. Each ticket above names every source it absorbed only where that changes its scope.
- **The guard never blocks.** It labels findings, and holds only what cannot be taken back. Dataset export is already held by the mark. These were dropped:
  - inline refusal of a model call;
  - holding a coding agent's push by default;
  - revoking tokens on a finding.
- **No always-on service locally.** Decision 6.9 (a worker starts when work is queued and exits when idle) and the event-driven processes record rule it out. The studies' local broker therefore reduces to two parts: the sandbox's own proxy, whose lifetime follows its sessions, and a scoped Git helper. Model keys stay in the channel worker's memory, outside the sandbox, as they are today. The background scan is a Records queue job.
- **Neuve keeps no credentials of its own.** Decision 10.5 says credentials are the user's own environment, read at run time and passed only to the call that needs them. Minting, storing and revoking tokens were dropped, and a GitHub App is left to the owner.
- **zod, not Effect Schema, in the Records schemas.** The zod-schemas record makes zod the one schema library. Records hold no credential field at all: the run receipt names the key variable, never its value (decision 10.73). `Redacted` lives in harness and host settings, through a zod transform.
- **The sandbox keeps Neuve's own capture working.** It must allow three things:
  - the hook spool, or commits made inside lose their capture;
  - the capacity connection, which decision 10.93 already allows in agent sandboxes;
  - the session ID handoff, which the hook falls back to inside a sandbox (decision 8.13 and the identity-without-auth record).
- **pi's file tools get path rules too.** They run inside the channel worker, not under the command sandbox.
- **Facts corrected from the studies,** using the threat-model review's checks:
  - Coding shells get the sealed environment, not the host's whole one. Credential-named variables are removed; everything else passes.
  - The Graph search spawn site already passes an environment.
  - Agents push with the user's own `gh` and Git sign-ins and the SSH agent, not with the host's GitHub token, which is sealed out of shells. The exposure is the same; the fix is the scoped helper plus sandbox denies.
  - Bun's spawn leak covers only variables present when the process started.
  - The exposure from channels with no settings is narrower than stated. It covers only tailnet-tagged stores with no settings: Ace-era channels and stores restored by a move.
  - The directory forgery is wider than stated: no modified host is needed.
  - Host logs do not already use the field allowlist; only the worker runtime does.
  - Hosted review cannot run in isolates alone, because it reads Git objects, calls Graph and runs local encoders.
- **Sandbox defaults that would break coding** were narrowed, as the sequencing review showed:
  - Deny only the host's own ports and the Records worker's socket, not all of loopback.
  - Deny writes to `.git/hooks` from the start. Watch `.git/config` first, since `git push -u` and husky write it.
  - Deny `gh` and SSH only once a scoped push path exists.
- **Not carried:**
  - a VM per session locally;
  - gVisor or Firecracker run by Neuve;
  - TLS interception;
  - alarms on CI workflow files and process forks, which add noise against the [signal-without-noise value](../../foundations/05-reviewers-tax.md);
  - a separate build item for review-session factories. Review stages already have no shell; the rule goes into the boundary record instead.
  - Modal replays, whose machines hold only the lease secret and run no repository code. That is a low risk, and no review proposed a ticket.

## Phase 1: urgent and small

### Peer access holds against teammates

- **In:**
  - The directory counts a share only when its filer has direct access to the project.
  - The gateway refuses peer logins that begin with `agent@`.
  - A tailnet-tagged channel with no settings counts as unshared.
  - Peers' messages (`say`) are governed by agent access or a setting of their own.
  - Two known limits are written down: self-reported GitHub logins, and the owner being a Tailscale login rather than a machine.
  - The `agent@` fix is reported to Ace.
- **Out:** cryptographic peer identity ([Ace issue 511](https://github.com/githubnext/ace/issues/511), on project access that holds against a tampering teammate) and hosted channels.
- **Concern and evidence:**
  - **The forgery.** The tailnet listener sends any `/directory/` request without an `Origin` header to the directory after `whois` (`apps/neuve-host/src/gateway.ts:1132, 1186-1201`). A share `POST` checks only that the filer is the caller (`apps/neuve-host/src/directory-server.ts:141-155`). `shared()` never asks who filed a share (`apps/neuve-host/src/access.ts:73-81`).
  - **The `agent@` login.** `isAgent` is a prefix test (`packages/channel/src/room.ts:51-53`), and it passes the agent-access gate (`packages/channel/src/channel.ts:908-918`).
  - **Channels with no settings.** The gate is `settings?.shared !== false` (`channel.ts:912`).
  - **Planted messages.** `say` has no gate (`channel.ts:820-845`).
  - **The owner's rights.** Any untagged device signed in as the owner gets them (`gateway.ts:233-234, 543-548`).
  - The host joins the tailnet by default (decision 12.14, keep Ace's tailnet default).
- **First step:** in `access.ts`, count a share only when `isDirect(share.by, project)`. Refuse `agent@` peer logins after `whois`.
- **Proof:** tests at the access boundary (reason: the input boundary), covering a share filed by a peer without direct access, and an `agent@` peer. The host log's refusal line for a real tailnet request. Code reading of the one listed seam.
- **Depends on:** nothing.
- **Waits on:** Peers on this host, for `say` and the default for channels with no settings only.

### Neuve's own processes take no environment from their callers

- **In:**
  - One shared allowlist builder, lifted from the stack store's scrubbed environment.
  - The Records worker starts with that allowlist: path, home, locale, temporary folder, storage variables, the named model-route key variables, the lease variables and Graph's own variables.
  - `BUN_OPTIONS`, `NODE_OPTIONS`, and proxy and TLS variables are dropped unless the user lists them.
  - Installed Git hooks and agent hook commands call `neuve` through `/usr/bin/env -i` with a fixed `PATH` and `HOME`. They keep the agent session ID variables (decision 8.13) and Git's own hook variables.
  - The encoders, the `gh` scope fetch and the OpenAI token command get explicit environments.
  - The worker reads route credentials at call time.
- **Out:** coding shells (Coding agents get their own environment) and any broker.
- **Concern and evidence:**
  - **Code in Neuve's process.** With `BUN_OPTIONS=--preload=<file>`, the installed `~/.local/bin/neuve` ran the preload file. The threat-model review ran this with a dummy file. The release build's no-autoload flags do not cover it.
  - **The Records worker's start.** It starts with `env: process.env` and the repository as its working folder (`packages/records-core/src/starter.ts:97-104`; main's copy at `packages/records-core/src/starter.ts:92`).
  - **The waker's environment.** The starter runs in whichever process wakes the worker, including `neuve hook` from an agent's shell (`apps/neuve-cli/src/capture/hook-cli.ts:36-48`).
  - **Other full environments.** The encoders take the full environment (`packages/semantic-client/src/index.ts:807-812`), and so does the `gh` scope fetch (`packages/harness/src/github-scope.ts:52-53`).
  - All of this goes against decision 10.5 (credentials passed only to the call that needs them).
  - It must land before the sandbox, or it gets around it.
- **First step:** the hook template (`apps/neuve-cli/src/capture/setup-hooks.ts:197-215`) prefixes `/usr/bin/env -i`, and `starter.ts:104` passes the allowlist.
- **Proof:**
  - A test that three dummies do not reach the worker: a credential-named variable, an ordinary one and a `BUN_OPTIONS` preload. Reason: the input boundary.
  - The worker log shows the allowlisted start.
  - A real commit's hook event still reaches Records.
  - A Modal replay smoke case still borrows from the lease, per its run log.
- **Depends on:** the background scan landing, because it touches the same Records files.
- **Waits on:** nothing. It applies decision 10.5.

### Neuve never runs repository configuration

- **In:**
  - One shared helper with the stack store's Git pins: fsmonitor off, no external diff or textconv, no credential helper, a fixed protocol.
  - The helper is applied to the harness's read commands (`packages/harness/src/git.ts:31`, `gitMeasured`) and the commit preparation.
  - `core.hooksPath=/dev/null` is set only on read commands, because capture depends on Git hooks calling the CLI (the event-driven processes record).
  - The unused `fileDiff` is deleted.
  - The no-autoload flags are added to the evaluation build.
- **Out:**
  - the channel's own Git, which is Ace's code;
  - agent shells;
  - Graph, whose reads are already pinned.
- **Concern and evidence:**
  - **Unpinned commands.** Harness Git runs with the repository's own config (`git.ts:31-33`), while the stack store pins it (`packages/harness/src/stack/transport.ts:27-52`).
  - **The unused diff helper.** `fileDiff` (`git.ts:113-118`) omits `--no-ext-diff`. In a scratch repository the same command ran a `diff.external` program.
  - **The evaluation build** omits the no-autoload flags (`packages/evaluation/src/neuve-build.ts:31-41`, against `apps/neuve-cli/scripts/build.ts:36-37`).
  - The review's own diff is already hardened (`packages/harness/src/git-objects.ts:359-379`). No live path was found, so this is high rather than urgent.
  - It applies decision 10.52 (a reviewed commit cannot change what the worker starts).
  - It also removes the main reason to write-protect `.git/config` in the sandbox.
- **First step:** delete `fileDiff`, and move the pins into the shared helper at `git.ts:31`.
- **Proof:** a test with a planted fsmonitor marker in a fixture repository (reason: the input boundary). The run log's pinned Git commands. A live review on a repository with the plant leaves the marker untouched.
- **Depends on:** nothing.
- **Waits on:** nothing.

### Settle the open security questions

- **In:** answers by probe or code reading, with dummy values only:
  - whether an agent shell reads keychain items without a prompt;
  - whether a spooled actor registration can claim the human kind;
  - whether any tailnet-tagged channel without settings exists on the Mac;
  - whether Tailscale issues `agent@` logins here, and whether nodes shared in from other tailnets reach the host;
  - whether hosted team services are configured, and whether `--loopback` stops them;
  - the mode of the tailnet certificate folder;
  - whether chat and desk Markdown loads remote images;
  - whether agent flows use `git push -u` or husky;
  - whether runs that peers start are captured into Records;
  - whether Bun's `fetch` honours proxy and TLS variables in the worker;
  - whether the evaluation binary runs inside an untrusted clone.
- **Out:** fixes.
- **Concern and evidence:** the unverified rows in the threat-model review's open points and the sequencing review's question spike.
- **First step:** the keychain probe with a dummy item.
- **Proof:** one short note per answer, with the command or line that settles it. It is research, so code reading and logs suffice.
- **Depends on:** nothing.
- **Waits on:** nothing.

### No external images in rendered agent text

- **In:**
  - `img-src` limited to own origins, `data:`, `blob:` and GitHub's image hosts, on the coding app and the review desk.
  - `connect-src 'self'`.
  - Links to external images in model-written text made inert.
- **Out:** rewriting links before publication, which belongs to the publisher, and Ace's chat rendering beyond the header.
- **Concern and evidence:**
  - Images in block Markdown keep their `src` (`packages/ui/src/components/blocks/parse.ts:529-545`).
  - No policy limits `img-src` (`apps/neuve-host/src/app-gateway.ts:21, 116`; `gateway.ts:1051`).
  - The desk sets only `frame-ancestors` (`apps/neuve-web/apps/web/src/server/framing.ts`).
- **First step:** confirm in DevTools that a fixture chat loads an external image.
- **Proof:** DevTools MCP screenshot and console, before and after; avatars (`packages/ui/src/lib/format.ts:7`) still load; the response header in the network log.
- **Depends on:** the images answer from Settle the open security questions. Coordinate `framing.ts` with the desk's development lane.
- **Waits on:** nothing.

### The replay archive follows the mark

- **In:** the cloud store archive carries only marked-clean captures, or is refused, or is declared the owner's restricted copy.
- **Out:** the research volume's own access rules; free-page residue (Run data at rest).
- **Concern and evidence:** `archive_case` (`research/pr-bench/replay/modal/app.py:437`, kept in the private archive) packs unscanned raw captures and authority checkpoints. The scan's final security review lists this as a non-blocking item. Decision 12.27 makes the mark the gate for export.
- **First step:** read the mark in `archive_case` before packing.
- **Proof:** the archive run log, and a refused or excluded unscanned case.
- **Depends on:** the background scan landing.
- **Waits on:** The replay archive.

### A runtime boundary record

- **In:** one architecture record that:
  - places the coding host and channel worker in the layer table, which lacks them although the Ace-style harness record added them;
  - states the three layers, with their local and hosted adapters;
  - states that review sessions have no shell;
  - says what each layer closes and does not close, in the way Ace writes its "not a security boundary" warnings;
  - says that "environment values never reach datasets" holds at the exit, since decision 12.12 keeps raw capture byte-exact;
  - records the owner's no-code choices and the LaCie ownership finding;
  - adds the hosted precondition: hosted channels never accept an author claimed by a team-secret holder.
- **Out:** new product meaning; vocabulary entries unless the owner approves them.
- **Concern and evidence:** the boundary is unwritten, so lanes cannot tell what they may rely on. See the architecture review's "Decisions that themselves need a clarifying row".
- **First step:** record the owner's no-code choices.
- **Proof:** none; it is documentation.
- **Depends on:** nothing to start. It is finished after the decisions it waits on.
- **Waits on:** Label or hold; When the sandbox cannot start; What the no-auth decision covers; What independent means.

## Phase 2: contain coding sessions

### Coding agents get their own environment

- **In:**
  - A Neuve wrapper over pi's execution environment, handed to the harness at the one seam `packages/channel/src/channel.ts:265`, and listed in the host's upstream record.
  - Commands start with `inheritEnv: false` and an allowlist: `PATH`, `HOME`, `TMPDIR`, locale, `TERM`, the session ID handoff and the capacity connection.
  - Names the user lists for a project in user-level settings are added, in the way integrations list their variables.
  - Dropped: `SSH_AUTH_SOCK` (once Pushes use a scoped Git credential lands), `ACE_*` (including `ACE_HOME`), other `NEUVE_*`, proxy variables, `BUN_OPTIONS` and `NODE_OPTIONS`.
- **Out:**
  - the channel's own `changes` and `fetch`, which share today's factory and need the owner's credentials;
  - file paths;
  - the OS sandbox.
- **Concern and evidence:**
  - **Inheritance.** pi's bash tool sets `inheritEnv: true` (pi-durable `dist/tools/bash.js:35-41`).
  - **What the seal misses.** It matches names only (`apps/neuve-host/src/keys.ts:22`). `SSH_AUTH_SOCK`, `AWS_ACCESS_KEY_ID`, `MODAL_TOKEN_ID`, `TS_AUTHKEY`, `GITHUB_PAT` and `NEUVE_OPENAI_TOKEN_COMMAND` pass; the threat-model review tested them against the pattern.
  - **Where the host token lives.** `ACE_HOME` is exported (`apps/neuve-host/src/host-config.ts:115`), which tells an agent where `host.token` is.
  - **The shared factory.** One factory serves the agent and the channel's Git work (`apps/neuve-host/src/worker.ts:97-101`; `channel.ts:531-537`).
- **First step:** the wrapper, delegating everything, with only the environment override.
- **Proof:** in the app, an agent's `env` lacks a dummy variable (DevTools MCP screenshot of the chat). The host log line. A wrapper test that a dummy credential-named variable and a dummy ordinary variable both stay out while `PATH` and `HOME` are present (reason: the input boundary).
- **Depends on:** nothing.
- **Waits on:** Agent environment and reads. Also Whose push credential, for the interim: whether `SSH_AUTH_SOCK` stays until the scoped helper lands.

### File tools stay within path rules

- **In:**
  - pi's read, write and edit go through the same wrapper.
  - Writes are allowed only in the chat's worktree, its temporary folder and named caches.
  - Reads are refused for a deny list, after resolving links:
    - Neuve's sign-in folder;
    - the host home and its token;
    - every Records store, and the worker socket's fallback;
    - the storage profile's captures and state;
    - `~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.modal.toml` and `~/.codex`;
    - `.env*` outside the worktree.
  - The list comes from the configured storage profile, not hard-coded LaCie paths.
  - A refusal returns a tool error.
- **Out:** commands, which the sandbox covers.
- **Concern and evidence:**
  - **Where the file tools run.** In the channel worker (pi-durable `dist/env/node.js:626-710`), and `resolvePath` accepts absolute, `~` and `..` paths (`node.js:25-42`).
  - **What they reach.** The owner's user can read the sign-in files, by path and mode. 465 `host.token` files sit under the external state folder.
  - Skills, instructions and other repositories stay readable.
- **First step:** the write rule, which breaks least.
- **Proof:** a refused read of a dummy file in a denied folder, shown in the chat (DevTools MCP screenshot) and the host log. A test with a link that points out of the worktree (reason: the input boundary).
- **Depends on:** Coding agents get their own environment. It shares the policy module with the sandbox.
- **Waits on:** Agent environment and reads.

### Coding commands run under the macOS sandbox

- **In:**
  - Seatbelt around every agent command, with the file-tool deny list.
  - **Writes allowed:** the worktree, the Git common folder's objects, refs and worktree folders, temporary folders and caches, and the hook spool.
  - **Writes denied:** `.git/hooks`, every Records store except the spool, `~/.local/bin`, `~/Library/LaunchAgents` and shell startup files.
  - **Watched, not denied:** `.git/config` writes are logged.
  - **Allowed connections:** the capacity connection. The session ID handoff is kept.
  - **Denied connections:** the host's own ports and the Records worker's socket.
  - **Network:** watched, not limited.
  - **Worker starts:** only the host or launchd starts workers, never a session.
  - **Shape:** a policy module of Neuve's own behind a platform port, with a macOS adapter now and a container adapter later. It is reached through one listed seam (decision 12.11, Neuve policy through small listed seams).
- **Out:** egress enforcement, Linux and hosted work.
- **Concern and evidence:**
  - **No OS sandbox exists** (the today study, section 5).
  - **The owner's host connection.** Any local process gets it from the loopback app gateway by sending the expected headers (`app-gateway.ts:154-181`; the private token is attached at line 214).
  - **Workers started inside.** A hook inside a session that finds no worker starts one with the agent's environment, and that worker then serves every chat's worktree (`starter.ts:97-104`).
  - **Writes that outlive the session.** They run later as Neuve or as the owner (`packages/records-core/src/launchd.ts:12-13`).
  - **What the record allows.** The Ace-style harness record lets coding sessions write in their assigned worktree. Decision 10.93 allows the capacity connection in agent sandboxes. Decision 2.16 keeps codebase facts apart from agent work.
  - **A precedent.** Graph's `clangd` step uses Seatbelt (`apps/neuve-graph/internal/sem/lsp_enrichment.go:266-267`). It is allow-default with denies, so the coding policy needs a different shape.
- **First step:** deny the Records store and the sign-in folder only, with no network change, on one channel behind a setting.
- **Proof:**
  - In the app, `bun install` and `bun test` pass in a sample repository, while reads of the store and the host token are refused (DevTools MCP screenshot).
  - A commit made inside still reaches the spool (a Records event).
  - A job still holds capacity (`neuve capacity`).
  - The host log shows each refusal.
  - A test of the generated profile.
- **Depends on:** Neuve's own processes take no environment from their callers; Neuve never runs repository configuration; Coding agents get their own environment; Settle the open security questions.
- **Waits on:** When the sandbox cannot start; What the no-auth decision covers; Sandbox mechanism.

### Coding network through an allowlisting proxy

- **In:**
  - All agent command traffic goes through one proxy, whose lifetime follows its sessions.
  - Name resolution happens only through the proxy.
  - Names that resolve to loopback, link-local or metadata addresses are refused.
  - Each run keeps a log of refused hosts. Refusals are reported to the owner, not shown on the review desk.
  - It starts in watch mode. Enforcement follows the watch log.
- **Out:** TLS interception, body inspection and the worker's own model calls.
- **Concern and evidence:** direct leaks from the shell, DNS included (the secrets study's channels table). There is no standing service, by decision 6.9 (no always-on service). Git over SSH is not carried by an HTTP proxy.
- **First step:** the proxy in watch mode, model hosts only, with the refusal log.
- **Proof:** the watch log of refused hosts. Then a blocked fetch to an unlisted host, seen in the chat and the log, while a registry install still passes.
- **Depends on:** Coding commands run under the macOS sandbox.
- **Waits on:** Coding network.

### Pushes use a scoped Git credential

- **In:**
  - A helper outside the sandbox answers only for the chat's own remote and branch, after Ace's compute-runner helper pattern.
  - It uses the user's own sign-in, read at call time. There is no token file inside the session and no credential of Neuve's own.
  - Once it works, agent shells are denied `~/.config/gh`, Git credential helpers and `SSH_AUTH_SOCK`.
- **Out:** a GitHub App, minted tokens, scanning, and who opens pull requests (Agent proposes, Neuve publishes).
- **Concern and evidence:**
  - Agents push with the user's own `gh` and Git sign-ins and the SSH agent. The host's token is sealed out of shells (`keys.ts:37-41`) and handed only to `gh` and `git clone` (`apps/neuve-host/src/github.ts:150-197`).
  - The helper pattern is in Ace's compute runner (Ace `services/compute/runner.ts:59-130`).
  - Decision 10.5: no credentials of Neuve's own.
  - Decision 12.8: adopt Ace's journey, including pull requests.
- **First step:** the helper for clone and fetch on one channel, with pushes unchanged.
- **Proof:** a push to the chat's own remote works and one to another remote is refused (host log and chat screenshot). A test of the helper's host and path match. A refused read of `~/.config/gh` from the sandbox.
- **Depends on:** Coding agents get their own environment; Coding commands run under the macOS sandbox.
- **Waits on:** What agents may publish; Whose push credential.

### The spool cannot register a human

- **In:**
  - The spool refuses an actor registration that claims the human kind. Humans register only through the human commands.
  - The audit command flags marks the scan job did not write.
  - The sandbox's denial of every store comes from the sandbox ticket.
- **Out:** cryptographic actor proof and cryptographic marks.
- **Concern and evidence:**
  - **The human kind.** The spool refuses only capture events (background-scan worktree `packages/records-core/src/ingest.ts:94-105`). An actor registration is projected with whatever kind it claims (`packages/records-core/src/projectors.ts:23-44`). The human-required rules check only that kind (`rules.ts:102-109, 199-202`).
  - **Forged marks.** Anyone who writes `records.sqlite` can append a clean mark that export then trusts.
  - It applies decision 4.5 (the agent never approves human-required work).
- **First step:** the refusal in `ingest.ts`, beside the existing refusal of capture events.
- **Proof:** a test with a fixture spool event claiming the human kind (reason: the input boundary). The worker log's refusal line. The audit lists a planted mark from a writer other than the scan.
- **Depends on:** the background scan landing.
- **Waits on:** What the no-auth decision covers, as a clarifying row only. The architecture review reads this as applying decision 4.5; the threat-model review asks for the owner.

### Tell the person from a local process

- **In:** the loopback app gateway, the review desk and the human commands tell the owner's browser from another local process, for example with a per-launch secret held by the browser like the host's HttpOnly cookie.
- **Out:** authentication of people, which the no-auth decision rules out.
- **Concern and evidence:**
  - The desk records dispositions through the human commands (`apps/neuve-web/apps/web/src/server/desk.server.ts:364-422`), with browser origin checks only.
  - The app gateway hands the owner's authenticated host connection to any local process that sends the expected headers (`app-gateway.ts:154-181, 214`).
  - The sandbox closes this for coding sessions, but not for agents the owner runs outside Neuve's host.
- **First step:** show which paths a same-user process can use today, with a dummy store.
- **Proof:** a test, and a DevTools MCP capture of a refused forged request, while the owner's browser still records a disposition (screenshot and Records event).
- **Depends on:** Coding commands run under the macOS sandbox, which closes the coding case first.
- **Waits on:** What the no-auth decision covers; The person at the desk.

### No spawn without an explicit environment

- **In:** a check that refuses `Bun.spawn` or `Bun.spawnSync` without `env` in the coding host and the channel worker.
- **Out:** Graph; the Records worker, which Neuve's own processes take no environment from their callers covers.
- **Concern and evidence:**
  - Under Bun 1.4.0, a spawn without `env` passes variables deleted from `process.env` if they were present at start. That is exactly the channel worker's case (`apps/neuve-host/src/client.ts:25-30`, `keys.ts:33-35`).
  - Today's sites run fixed programs (`health.ts:18, 36`, `terminals.ts:142`, `diagnostics.ts:20, 28`, `github.ts:282`, `environment.ts:41, 61`, `cli.ts:606`), so the risk is low. The check keeps it from regressing.
- **First step:** list the sites and pass explicit environments.
- **Proof:** the check fails on a fixture call without `env`; code reading of each site.
- **Depends on:** nothing.
- **Waits on:** New check rules.

## Phase 3: egress guard and stored references

### Register sealed values and a canary

- **In:**
  - Values in the host's sealed map are registered with Capture's detectors at the host boundary for coding captures. The GitHub token is included when it is sealed.
  - One canary value is registered only as a known value, with no live account.
  - A minimum length is set.
- **Out:**
  - `MODAL_TOKEN_ID`, which the seal does not hold;
  - the lease keys, which live on Modal machines;
  - live canaries.
- **Concern and evidence:**
  - Detectors are registered only from model-call headers (background-scan worktree `packages/harness/src/pi/providers/agent-route-provider.ts:551-576`). Other values are caught only by shape (`packages/harness/src/masking.ts:1-18`).
  - Registration sits at the host boundary because Channel has no Neuve or Records dependency (decision 12.11).
- **First step:** register sealed values at coding-worker setup.
- **Proof:** a fixture capture holding a dummy registered value is refused at export (test). The scan's record shows the refusal (Records). The worker log.
- **Depends on:**
  - the background scan landing;
  - for the canary, File tools stay within path rules and the sandbox, so sessions cannot read the authority checkpoints.
- **Waits on:** Vocabulary terms (canary).

### Logs pass the field allowlist

- **In:**
  - Ace's `log.ts` callers go through the private log's diagnostics filter, by one listed seam.
  - Host logs and `worker.log` mask registered values before writing.
- **Out:** pi capture, and telemetry, which already carries only names and counts.
- **Concern and evidence:** lines are written as given, error fields included (`apps/neuve-host/src/log.ts:47-54`). Only the worker runtime uses `private-log.ts`. The Records worker's output goes to `worker.log` (`starter.ts:13-14, 97`).
- **First step:** list which error fields reach the host log today.
- **Proof:** a test where a dummy registered value in an error is masked in the written line. A real host log line shows only allowlisted fields.
- **Depends on:** nothing for the allowlist. The masking depends on Register sealed values and a canary.
- **Waits on:** nothing.

### Settings hold references, not values

- **In:**
  - The telemetry collector's header values become variable names, expanded like integration variables (decision 10.52).
  - They are read into Effect's `Redacted` through a zod transform that refuses to encode, with one unwrap point.
- **Out:**
  - the Records schemas (zod-schemas record; Records hold no credential field, decision 10.73);
  - external secret stores until hosted work;
  - the check rule, unless the owner allows it.
- **Concern and evidence:** `telemetry.otlp.headers` is a plain string map in zod settings (`packages/harness/src/settings.ts:20`). Only `count-tokens.ts` uses `Redacted` today. Decision 10.32 sends OpenTelemetry only to an endpoint the owner names.
- **First step:** the collector headers field only.
- **Proof:** a test that encoding a setting or log line holding a credential field fails. A telemetry export that carries the header name and never its value.
- **Depends on:** nothing.
- **Waits on:** New check rules, for the rule only.

### Run data at rest

- **In:**
  - `secure_delete` on the Records store.
  - Pruned migration backups.
  - Stale host homes and their tokens pruned under the external state folder.
  - If the drive is unencrypted, the owner moves run data to an encrypted volume.
- **Out:** hosted storage, and the replay archive (its own ticket).
- **Concern and evidence:**
  - the external LaCie volume is mounted `noowners` (shown by `mount`), so the 0600 and 0700 modes bind no owner there.
  - The default storage profile puts the host home, captures and state on it (`apps/neuve-cli/src/workspace-runtime.ts:163`, `scripts/pi-storage.ts:115-131`).
  - 465 host tokens sit there.
  - Raw bytes outlive the prune in free pages and backups.
  - Whether the volume is encrypted is unverified.
- **First step:** the owner checks encryption once (checklist).
- **Proof:** a test that a freed page holds no earlier bytes after a prune. A telemetry span for delete time. The count of host tokens after pruning, in a log line.
- **Depends on:** nothing.
- **Waits on:** The LaCie drive.

### Background scan of what left

- **In:**
  - An event kind that records a send-out: where it went and a content hash. The first source is a coding agent's push.
  - A Records queue job with the background scan's rules (decision 12.27): the background slot, spaced retries and the dead-letter list. It runs the registered detectors and pattern shapes over the patch.
  - Findings are labelled. Only what cannot be taken back is held, as the owner decides.
  - The job holds no credentials, writes only its findings and cannot mark a capture clean.
- **Out:**
  - inline refusal;
  - token revocation;
  - process-fork watching;
  - alarms on CI workflow files;
  - verified detection;
  - a standing local service.
- **Concern and evidence:**
  - Today the scan watches one exit, Records leaving through export (the today study, section 3).
  - Records owns the job and its events; the harness computes the scan (the layers record).
  - It is listed through `neuve jobs` and the audit command.
- **First step:** record the push event only.
- **Proof:** a dummy registered value in a pushed patch gives a labelled finding while the coding agent's work and the review carry on. Shown by the Records event, the queue job, the worker log and a chat screenshot.
- **Depends on:** Pushes use a scoped Git credential; Register sealed values and a canary.
- **Waits on:** Label or hold; What independent means; Verified detection; What forks means; Vocabulary terms.

### Agent proposes, Neuve publishes

- **In:**
  - Pushes, pull requests and comments from agents become requests that the host applies with the user's own credential, after one check that labels reviewable outputs.
  - Only what cannot be taken back is held.
- **Out:** review publication, which already goes through Records; any credential of Neuve's own.
- **Concern and evidence:** the agent's process tree holds both a credential and a way out (the secrets study's lethal-trifecta analysis). Records already has an idempotent publish receipt (the Ace-style harness record).
- **First step:** route `gh pr create` from agents through a host tool.
- **Proof:** a pull request opened through the host carries a caution label for a planted dummy finding (GitHub screenshot and host log). The Records publish receipt.
- **Depends on:** Pushes use a scoped Git credential; Background scan of what left.
- **Waits on:** What agents may publish. It changes Ace's adopted journey (decision 12.8).

## Phase 4: hosted

### Hosted coding sessions

- **In:**
  - One VM per coding session: Cloudflare Containers through the Sandbox SDK.
  - Outbound Worker allowlists with credential injection, and Secrets Store bindings only on the outbound Worker.
  - Landlock inside as a second layer.
  - Hosted channels never accept an author claimed by a team-secret holder.
  - Hosted review in a container, or with a hosted Graph.
- **Out:** local work. Building any of it before the hosted target starts.
- **Concern and evidence:**
  - Ace's architecture lets holders of the team secret post in any hosted channel as any author (threat-model review, risk 7).
  - Hosted review reads Git objects, calls Graph and runs local encoders, which decision 10.117 keeps on the machine.
  - Decision 10.92 names Cloudflare as a hosted platform. Decision 10.93 says hosted work is decided when it starts.
- **First step:** the precondition entry in A runtime boundary record.
- **Proof:** deferred.
- **Depends on:** the hosted target.
- **Waits on:** Hosted precondition.

## Owner decisions

Each is a plain question, with its options and a recommendation. The reviews' lists are merged here.

1. **Peers on this host.** Until peer access holds, may teammates reach this Mac's agents?
   - Options: keep the tailnet default; start with `--loopback` until the peer fixes land; or keep the tailnet on, with peers unable to ask agents or post messages until the sandbox lands.
   - Also: should a tagged channel with no settings count as unshared? Should agent access also govern peers' messages?
   - **Recommendation:** use `--loopback` now unless teammates need this host. After the peer fixes land, return to the tailnet with agent access off for peers until the sandbox lands. Yes to both sub-questions.
2. **Label or hold.** The guard never blocks and holds only what cannot be taken back. Which exits count as that?
   - Options: hold pushes and pull requests until their scan passes; label them after the fact; hold only dataset export and the replay archive.
   - **Recommendation:** hold dataset export and the replay archive, which the mark already does. Label pushes and pull requests. Holding them would stall the coding agent, and the scoped helper already limits where a push goes.
   - It needs a row in the decisions record.
3. **When the sandbox cannot start.** Should the command be refused, or run and say so?
   - Options: refuse everywhere; run everywhere with a notice in the chat and the host log; refuse on macOS with one fix line, and run with a notice on Linux until a Linux sandbox exists.
   - **Recommendation:** the split. On macOS the sandbox is part of the system, so a failure is a fault, not a missing prerequisite. On Linux there is none yet, which follows the restored host's rule that a missing machine prerequisite keeps its original handler.
   - It needs a row reconciling that rule.
4. **What the no-auth decision covers.** Are limits on agents part of the "auth code" that decision removed? These limits are the sandbox, branch rules, peer gates, the spool's refusal of a claimed human and a per-launch desk secret.
   - **Recommendation:** add a row saying they are capability limits on agents, not identity checks on people, so they stand.
5. **What agents may publish.**
   - Options: agents push and open pull requests themselves, as in Ace's journey, limited to the chat's own remote and branches; or agents propose and the host publishes.
   - **Recommendation:** keep Ace's journey, limited by the scoped helper. Revisit the publisher only if the background scan shows a need.
6. **Whose push credential.**
   - Options: a GitHub App, which would be Neuve's own credential; or the user's own sign-in, scoped by a helper outside the sandbox.
   - Interim question: does the SSH agent stay reachable to agents until the helper lands?
   - **Recommendation:** the user's own sign-in through the helper. Keep the SSH agent until then. Optionally make it confirm each use (checklist).
7. **Coding network.** Which hosts may coding sessions reach, does `bun install` run inside the sandbox, and when is the allowlist enforced?
   - **Recommendation:** start in watch mode with the model hosts, the npm registry and GitHub. Run `bun install` inside the sandbox. Enforce after the owner reads the watch log.
8. **Agent environment and reads.** What is the default allowlist for agent shells, and are reads outside the worktree allowed apart from a deny list, or refused apart from an allow list?
   - **Recommendation:** the threat-model review's allowlist, plus names the user lists per project in user-level settings. Use a deny list for reads, since agents read other repositories, skills and instructions.
9. **Sandbox mechanism.**
   - Options: a Seatbelt profile of Neuve's own, after Graph's `clangd` step; or Anthropic's sandbox runtime package, which is in beta, not installed, and brings its own proxy.
   - **Recommendation:** Neuve's own profile behind the platform port, so no beta dependency sits on the critical path. Weigh the runtime's proxy again when the network ticket starts.
10. **The replay archive.** Is it a dataset that the mark must gate, or the owner's restricted copy?
    - **Recommendation:** gate it by the mark. It leaves the cloud machine, so it should carry only marked-clean captures.
11. **The LaCie drive.** Is the volume encrypted, and if not, where should run data live? What may the archive keep?
    - **Recommendation:** check now. If it is unencrypted, move run data to an encrypted volume. Do not turn ownership on for the volume without a test, because files written while it was off may then fail Neuve's own owner checks.
12. **What independent means.** Read against "no always-on service", is the guard's independence a separate process, a separate trust footing, or a job?
    - **Recommendation:** a separate trust footing, run as its own Records queue job. It holds no credentials, writes only its findings, and starts and stops with queued work.
13. **Verified detection.** May the background scan send a found key to its provider to check it?
    - **Recommendation:** no. Verifying is itself a send-out.
14. **What forks means.** In "watching for forks or tampering", is it Git forks, process forks, or both?
    - **Recommendation:** for the owner to say. The backlog covers pushes to other remotes through the scoped helper and the background scan. Stray processes are bounded by teardown at the end of a session, not watched.
15. **New check rules.** May `bun run check` grow a rule against spawning without an explicit environment in the coding host and channel worker, and later one against unwrapping `Redacted` outside one module?
    - **Recommendation:** yes to the spawn rule now; defer the `Redacted` rule until a second unwrap site exists.
16. **The person at the desk.** Should the desk, the app gateway and the human commands get a per-launch secret to tell the owner's browser from another local process?
    - **Recommendation:** yes, once the no-auth question above has its row.
17. **Hosted precondition.** How does "no credentials of Neuve's own" read in hosted multi-user mode? Should the boundary record say now that hosted channels never accept a claimed author and that each hosted coding session gets its own VM?
    - **Recommendation:** write both into the boundary record now. Give the no-credentials decision its hosted reading before any hosted credential store is designed.
18. **Teammates' text.** Are runs that teammates start on this host captured into Records and datasets, and with what consent and retention?
    - **Recommendation:** settle the fact first (Settle the open security questions). Keep such runs out of datasets until the owner decides.

## Vocabulary terms for the owner to approve

None of these is in the product vocabulary. This backlog adds none.

| Term | Question |
| --- | --- |
| Credential guard | One term or two? The studies split it into an on-path part and a background part with different trust and lifetimes |
| Vault | The design stores nothing. It is references plus a typed wrapper, and the word suggests a store, which collides with "no credentials of Neuve's own" |
| Broker | Locally it reduces to the sandbox proxy plus a Git helper. Is a term needed at all? |
| Watcher; record of send-outs | The secrets study calls the second a description, not a term. The first is used as a noun |
| Placeholder; canary | New |
| Egress point; send-out | New. The studies list different exits, and the today study's list is the fuller one |
| Coding session; final-review session; session kind | Used in the Ace-style harness record, not defined in the vocabulary |
| Channel; chat; agent access; project access; peer | Ace's words, used in the record and here. Do they enter the vocabulary? |
| Workspace | Collision: the decisions define it as Ace's collaborative home, while two studies use it for Ace's remote file-and-shell executor |
| Mark; clean mark; mark gate; mark chain | Near-collision with "Mark viewed", "Contextual marker" and "Marker pin". The decisions use "marked clean" as a verb only |
| Lane | In tools it means a chat's worktree. Owner text keeps "review lane" in full |
| Refusal | Capture already uses it for refused exports. The background scan's meaning must not drift |
| Forks | Open, as in the decisions above |
| Untrusted repository; trust level | New. Proposed as a later local mode |

## Owner checklist, no code

These come from the sequencing and threat-model reviews. None prints a credential. Each says when it changes an account or a setting. Run commands from the repository root. Set `NEUVE_MAIN_ROOT` to a checkout of main, `NEUVE_STATE_ROOT` to the external state folder, and `NEUVE_STORAGE_VOLUME` to the external LaCie volume's mount point.

1. **Run the workspace off the tailnet** unless teammates use this host. This changes no account. It stops discovery, lobbies and opening the desk from another device.

```bash
bun run workspace --loopback
```

2. **If the tailnet stays on, list who can see this Mac.** Look for any login that starts with `agent@`, and for devices signed in as you that are not yours. Restricting who may reach this Mac's host port is done in the Tailscale admin console. That changes your tailnet's access rules.

```bash
tailscale status
```

3. **If the tailnet stays on, turn agent access off** in each channel teammates can open, especially older channels. This is done in the app and changes those channels' settings.

4. **Make main's environment file readable only by you.** It changes the file's mode only.

```bash
chmod 600 "$NEUVE_MAIN_ROOT/.env.local"
```

5. **Check your GitHub sign-in's scopes.** The status command shows the token masked.

```bash
gh auth status
```

6. **Remove the `workflow` scope**, so an agent cannot rewrite CI workflows. This changes your GitHub sign-in, and you will then be unable to push workflow-file changes yourself until you add the scope back. In the provider consoles, prefer project-scoped keys with spend limits; that changes those accounts.

```bash
gh auth refresh --remove-scopes workflow
```

7. **Look for programs Git would run** in each repository Neuve reviews. Repeat with the rewrite's path.

```bash
git -C "$NEUVE_MAIN_ROOT" config --show-origin --get-regexp 'core.fsmonitor|core.hookspath|diff\..*|filter\..*'
```

```bash
ls "$NEUVE_MAIN_ROOT/.git/hooks"
```

   Neuve's own `post-commit` and `post-rewrite` hooks are expected there. Any other file without `.sample` is worth a look.

8. **Check whether the LaCie drive is encrypted.** Look for an encryption line in the output.

```bash
diskutil info "$NEUVE_STORAGE_VOLUME"
```

```bash
mount
```

   The LaCie line shows `noowners`. Keep the drive attached only to this Mac, add no other macOS accounts, and keep `store.tar` archives off shared folders. Do not turn ownership on without a test.

9. **Count stale host tokens** before the pruning ticket. This prints a number, not tokens.

```bash
find "$NEUVE_STATE_ROOT" -name host.token -type f | wc -l
```

10. **Optionally, make the SSH agent confirm each use.** First list the keys it holds; this prints fingerprints only. Then re-add the key you push with using `ssh-add -c` and its file path. That changes how your SSH agent behaves, and unattended agent pushes will wait for your confirmation.

```bash
ssh-add -l
```
