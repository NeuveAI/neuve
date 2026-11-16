# Runtime security: what Neuve does today

Research, 2 November 2026. It describes the code as it stands and decides nothing. Three trees were read:

- the rewrite on `codex/pi-transition` in this repository, which is the working truth;
- the near-final background credential-scan lane in its external worktree, cited below as "review-c";
- main, in a separate checkout. Main has no coding host. Its Records, harness and hook code share the rewrite's lineage.

Paths are relative to the rewrite unless marked. "Unverified" means the code points that way but nothing was run to prove it. No credential file was opened.

The owner's three layers are, in their words:

1. A credential scan as its own background service, hooked into every way Neuve sends things out and watching for forks or tampering.
2. Repository code kept out of Neuve's own process.
3. A vault, so environment values never reach logs, messages, artifacts, telemetry or datasets.

"Vault" is the owner's word. The [product vocabulary](../../vocabulary.md) has no such term yet, and this document does not coin one.

## 1. Credential inventory

| Credential | Where it enters | Who inherits it |
| --- | --- | --- |
| Anthropic API key (`ANTHROPIC_API_KEY`) | The review route reads it from the process environment by its variable name ([route-provider.ts:20](../../packages/harness/src/route-provider.ts), [count-tokens.ts:96](../../packages/harness/src/pi/providers/count-tokens.ts)). The coding host reads `ACE_<NAME>`, then `<NAME>`, then the macOS keychain (`apps/neuve-host/src/keys.ts:73`). Evaluation reads it from the gitignored `.env.local` (`packages/evaluation/src/harness-compare/runner.ts:91`, decision 9.55) | Everything the Records worker starts, because the worker gets the full environment (below). Coding agent shells do not get it once the host has sealed it |
| OpenAI API key (`OPENAI_API_KEY`) and the other provider keys | The coding host, through its keychain lookup order (`apps/neuve-host/src/settings.ts:40`, `keys.ts:1-5`) | The channel worker's memory only. They are sealed before any tool runs |
| ChatGPT subscription sign-in | A file in `~/.config/neuve/`, or the folder `NEUVE_OPENAI_AUTH_DIR` names. It is written with mode 0600 inside a 0700 folder and refused if looser (`packages/harness/src/openai-auth.ts:40-41, 83-84, 253-257`, decision 10.85). On cloud machines, `NEUVE_OPENAI_TOKEN_COMMAND` instead runs a program that borrows an access token (`openai-auth.ts:1068, 1147`) | Any process running as the user can read the file. File mode does not separate the agent from its owner |
| Claude Code sign-in (`CLAUDE_CODE_OAUTH_TOKEN`) | Labelling and council runs, from `.env.local`, passed only to the Claude Code process (decision 9.55, `packages/evaluation/src/retrieval-bench/labelling/credentials.ts:20-26`) | Only that process. The labeller builds its environment from an allowlist (`labelling/routes.ts:56-75`) |
| Codex sign-ins | Codex homes for labelling (decision 9.37). The cloud labellers each have their own (decision 10.131) | The Codex processes. The owner moves the cloud copies; agents never handle them (10.131) |
| GitHub | Three sources. (a) `GH_TOKEN` or `GITHUB_TOKEN` in the host's environment: sealed, then handed only to `gh` and `git clone` (`keys.ts:38-41`, `apps/neuve-host/src/github.ts:150-197`). (b) The gh CLI's own sign-in (`apps/neuve-host/src/diagnostics.ts:51`). (c) The user's git credential helpers (`github.ts` clone comment). The harness's scope fetch runs `gh` with the full process environment (`packages/harness/src/github-scope.ts:52-53`). The Ace compute service takes a `GITHUB_TOKEN` Worker secret (`services/compute/index.ts:16, 132`) | (a) leaves agent shells' environment. (b), (c) and `SSH_AUTH_SOCK` stay available to every agent shell, because the seal matches names only (below) and the shell runs as the user. Unverified on this machine |
| Modal | The local Modal client's own configuration (unverified location). One Modal secret holds the lease proxy token: `LEASE_AUTH_SECRET`, referenced by name only (`research/pr-bench/replay/modal/app.py:743, 771`, kept in the private archive) | Review machines get the lease secret. No machine gets the ChatGPT refresh token, which stays in the one refresher (`modal/lease.py:1-17`) |
| Lease secret (`NEUVE_LEASE_KEY`, `NEUVE_LEASE_SECRET`) | Modal secret, then the review machine's environment (`app.py:359`) | The review machine's processes |
| Team services secret (`ACE_SECRET`) | Keychain or environment, read by the host for hosted channel, directory and compute calls (`apps/neuve-host/src/client.ts:67-81`) | The host |
| Host owner token | `<ACE_HOME>/host.token`, 64 hex characters, 0600, refused if looser (`apps/neuve-host/src/auth.ts:9-24`). It authenticates the private host WebSocket (`app-gateway.ts:134, 214`) | Any process running as the user. `ACE_HOME` is exported into the environment (`host-config.ts:115`), so an agent shell knows where the file is |
| Tailnet | The Tailscale daemon's identity. The host runs `tailscale status`, `whois` and `cert`, and writes `tailnet.crt` and `tailnet.key` into a host folder (`apps/neuve-host/src/tailnet.ts:148-156`) | The host process. Unverified: the folder's mode |
| Integration (MCP) variables | Only the variable names listed in the user's own integration file expand. The server starts in `$HOME`, never the repository (`packages/harness/src/mcp-client.ts:91-118`, decision 10.52) | That MCP server only |
| Linear | An external OAuth bridge holds the token. Neuve stores none (record 0014, Optional Linear scope) | The bridge |
| Private inspection authority | A generated key plus recognition metadata, kept outside native storage, journals, datasets, logs and model inputs. The metadata is each credential's HMAC digest, length and a prefix of at most 8 bytes (record 0014 line 41, `packages/harness/src/pi/capture/credential-detectors.ts:16-36`) | Records' capture code. The folder sits under `.git/neuve` (section 4) |

The coding host's seal is the one place that strips credentials from an environment wholesale. It runs at host and channel-worker start (`gateway.ts:1267`, `worker.ts:32`) and removes every variable whose name ends in `_KEY`, `_TOKEN`, `_SECRET`, `_PASSWORD` or `_CREDENTIAL(S)` (`keys.ts:17-30`). Names outside that pattern pass straight through: `SSH_AUTH_SOCK`, `AWS_ACCESS_KEY_ID`, `MODAL_TOKEN_ID`, Tailscale's `TS_AUTHKEY`, and URLs that embed a password. The seal came in with the restored Ace host (commit 33fe381e).

Main's own `.env.local` is mode 0644 (`ls -l`, contents not read). In the rewrite checkout there is none.

## 2. Process model

| Process | What runs in it | Environment | Repository code? |
| --- | --- | --- | --- |
| Coding host (`apps/neuve-host`) | Gateway, catalog, GitHub reads, terminals. Terminals are the owner's only (`gateway.ts:529`) | Sealed (`gateway.ts:1267`). Terminals inherit the sealed environment (`terminals.ts:77-79`) | Only in the owner's own terminal |
| Channel worker, one per coding channel (`apps/neuve-host/src/worker.ts`) | Pi conversations and the provider SDK calls. Provider keys are fetched into memory through `key()` | Spawned with the full environment, sealed secrets included (`client.ts:29`, `keys.ts:33-35`). It then seals itself (`worker.ts:32`) | Yes, in child shells. The pi bash tool (`packages/channel/src/handoffs.ts:58`) runs each command through `NodeExecutionEnv({ cwd })` (`worker.ts:99`) with `inheritEnv: true` (pi-durable `dist/tools/bash.js:35-41`), meaning `{...process.env, ...}` (`dist/env/node.js:192-199`). Tests, package scripts, git hooks and build tools all run here: as the user, in the lane worktree, with full filesystem and network access |
| Records worker (`neuve worker`) | Review pipeline (Precompute, the five stages, Publish), jobs, spool ingestion, retention. Background capture scans in review-c | The full `process.env`, cwd is the repository (`packages/records-core/src/starter.ts:100-104`). It loads no `.env` or `bunfig.toml` from the project (`starter.ts:17-26`, commits cfe1b149 and d9d79a0f) | No execution by design. Reads go through git objects. Its git children run with the repository's own git configuration and no pins (`packages/harness/src/git.ts:31-33`), while Graph's qualified reads and the stack store do pin it (`packages/graph-client/src/git-read-qualification.ts:337-340`, `packages/harness/src/stack/transport.ts:27-43`). Unverified: whether any unpinned harness git command runs a program that the repository's config names (fsmonitor, diff or filter drivers) |
| Graph engine (Go binary) | Indexing and searches | Allowlist: `ENTIRE_*`, `PATH`, `HOME`, `XDG_CONFIG_HOME`, `TMPDIR`, locale (`packages/graph-client/src/index.ts:308-345`). Its git calls get the caller's environment (`index.ts:403-405`) | Parses the repository, does not run it |
| Encoders and reranker (semantic client) | Local embedding models (decision 10.117) | Full `process.env` plus offline flags (`packages/semantic-client/src/index.ts:807-812`) | No |
| Stack store fetches | Package and git fetches for stack sources | `scrubbedEnvironment`: fixed `PATH`, a temporary `HOME` and `TMPDIR`, C locale, pinned git settings. No proxy, agent socket or credential helper (`transport.ts:55-74`; used at `stack/handler.ts:117`, `stack/reads.ts:33`, `apps/neuve-cli/src/stack-cli.ts:297, 335`). This is the only scrubbed environment in the review path | No |
| Scan child (review-c) | Credential inspection over a filed capture | Only `PATH`, `HOME` and `TMPDIR` (the 0700 work folder) plus two settings. Only stdio is inherited. Replies are schema-checked and capped (the final security review, a private coordination record, "The scan child") | No |
| Hooks (`neuve hook`) | Write events to the spool and wake the worker. They never open SQLite (`apps/neuve-cli/src/capture/hook-cli.ts:34-44`) | Whatever the calling agent's harness gives them | No |
| Review desk server (`apps/neuve-web`) | Batch overview and review desk. Records dispositions and comments through the human commands (`apps/neuve-web/apps/web/src/server/desk.server.ts:364-422`) | Loopback. Browser-style origin checks only (`csrf.test.ts`) | No |

**What each session may do.** The [Ace-style harness record](../../architecture/decisions/0014-ace-style-pi-harness.md) (line 15) sets three rules. Coding sessions may write in their assigned worktree. Final-review sessions keep restricted tools and frozen submitted source, and neither may inherit the other's capabilities. Replay reviews stay isolated from labels, later revisions, research notes and credentials.

In code:

- **Final-review sessions** get only lookup tools: read, hunk, hunks, scope section and the proof readers. No shell exists in any stage (`packages/harness/src/pi/stages/steps.ts:293, 330, 543, 601-622, 682, 739`). They run in a different process from coding sessions.
- **Coding sessions** get a full shell as the user. The "assigned worktree" is only the shell's starting folder. Nothing confines the shell to it (no OS sandbox exists; section 5).
- **Replay reviews** run on Modal machines that hold the lease proxy secret, not "no credentials" in the literal sense (section 5).

## 3. Egress points

The scan inspects raw pi captures, nothing else. Inside them it finds only the exact credential values that were sent in authenticated request headers. Detectors are registered from the request's `authorization`, `api-key` and `cookie` headers at each model dispatch (review-c `packages/harness/src/pi/providers/agent-route-provider.ts:551-576`, `native-models-capture.ts:170-200`). A GitHub token, an SSH key or a `.env` value that a tool printed is not a registered detector. Such a value is caught only by shape masking, which covers `sk-ant-`, `sk-`, `gh*_`, `github_pat_`, `xox*-` and `lin_` keys plus email addresses, in sanitized exports and stored proof text (`packages/harness/src/masking.ts:1-18`).

| Egress | Guard today |
| --- | --- |
| Capture export, the portable (shareable) copy, the scorer | **The mark.** On the integrated branch the scan runs at close (decision 12.26). In review-c a background job scans, and export, the portable copy and the scorer read the clean mark and never rescan (decision 12.27; `packages/evaluation/src/candidate/capture.ts:176-209`). The final security review found no path for unscanned or refused bytes through these routes |
| Replay run archive (`run/cloud/store.tar` to the research volume and the Mac) | **None.** It now carries unscanned raw captures and authority checkpoints. It is the owner's restricted copy, not a dataset (final security review, non-blocking item 2; `modal/app.py:437`) |
| Cloud stderr and diagnostics | Name- and shape-based redaction before writing or quoting (`packages/evaluation/src/pr-replay/redact.ts:1-40`, `modal/redact.py`; commits 47cff920, cc3dfe5a). Capture diagnostics pass through `safe_reason` |
| Telemetry (run log, optional OTLP endpoint) | A content rule only: attributes carry names, counts, offsets and identifiers, never prompt, source or tool text (`packages/harness/src/telemetry.ts:5-14`). No scan, no mark. A recompose exports none (commit 322c602d) |
| Host and worker logs | **None.** `<ACE_HOME>/logs/*.jsonl` lines are written as given, error fields included (`apps/neuve-host/src/log.ts:47-54`). `private-log.ts` rotates with 0600. The Records worker's stdout and stderr go to `worker.log` in the store (`starter.ts:13-14, 97`) |
| Proofs (test logs, screenshots, video) shown on the review desk | Text is shape-masked. Environment files are refused (`packages/records-core/src/proofs.ts:389-393, 464-487`). Binary artefacts are not inspected |
| External agent transcripts (Claude Code, Codex) | Copied raw into Records raw-capture blobs for 30 days. Only counts leave them (`packages/records-core/src/transcripts.ts:33-38`). Not scanned |
| Review desk and batch overview | Loopback. Over the tailnet only to the owner's own Tailscale login (`gateway.ts:1162`). They show model-written text and proofs, with no scan or mark |
| Model providers | Repository content goes to the route's provider by design. Embeddings and the reranker stay on the Mac (decision 10.117). Benchmark chunks may go to Modal (decision 9.34). No outbound filter on the Mac |
| Publishing to GitHub | Neuve's review publishes nothing to GitHub. `neuve review show` and the desk are the outputs (decision 10.73). The host's GitHub calls are reads (`github.ts:90-460`). **Coding agents** can push and open pull requests from their shell with the user's git and gh sign-ins. Nothing guards this |
| Channel move to a hosting service or cloud compute | The channel's whole pi store travels as one verified snapshot (`apps/neuve-host/src/move.ts:1-5`, `compute.ts:1-5`). No scan or mark. The services are restored source, not deployed (`services/UPSTREAM.md:3`). Unverified whether any team has deployed them |
| Tailnet lobby, directory, peers | Channel listings and presence go to peers and the directory, filtered by project access (`gateway.ts:205-234`). Peers can drive this host's coding channels in projects they can access (`gateway.ts:83-84, 231-234`) |
| Modal machines | Review: model hosts and the lease host only (`app.py:355-368`, `MODEL_HOSTS` at `app.py:74`). Receipt re-fetch and archive machines: no network (`app.py:415-420, 464-468`). Recompose: no network unless model steps are allowed (`app.py:617-620`). Remote checks: no network, no secrets (`scripts/remote-check/run_modal.py:69-70`) |
| Hosted target | Not built. The owner's hosted direction leans to Cloudflare (decision 10.92), and Ace's Cloudflare services are present as source only |

**Forks and tampering.**

- **Capture marks.** The mark chain only accepts adjacent seal-and-mark pairs from the scan actor. A fork from an old mark reads as a conflict and is refused. The spool refuses every capture event (review-c `packages/records-core/src/ingest.ts:96-103`; final security review, "Mark chain" and "Mark-fix probe").
- **Forgery stays possible.** "Only a full in-process `Log.append` forgery succeeds", because the actor is a constant hash (final security review, Verdict). Journal certificates are "a trusted producer protocol, not cryptographic proof" (record 0014, line 43).
- **Coding channels.** The host refuses to wake a channel that is hosted or moving, because that would fork its history (`worker.ts:49-53`).
- **Nothing else.** No other fork or tamper watch was found.

## 4. Trust boundaries and writers

- **Records store** lives at `<git common dir>/neuve`, "shared by every worktree of the repository" (`packages/records-core/src/location.ts:13, 21-28`; decision 8.6). It holds the database, spool, blobs, run folders, capture staging and, in review-c, `capture-authorities`. Folders are 0700 and files 0600 (`location.ts:9-10`). That only stops other OS users. Every coding lane is a git worktree of the project (`apps/neuve-host/src/fork-origin.ts:14`, `channel-create.ts:47`), so an agent shell in any lane can reach `$(git rev-parse --git-common-dir)/neuve` and open `records.sqlite` directly. Direct SQLite writes are the in-process forgery the review calls "by design". Nothing tested stops an agent shell from making them.
- **Hook spool.** Any process that can write the folder can add an event. A container may share it through a mount (`packages/records-core/src/spool.ts:35, 106`). Ingestion refuses capture events. Every other kind, dispositions and actor registration included, goes through the append-time workflow rules (`ingest.ts:96-103`, `packages/records-core/src/rules.ts:10-17, 102-109`). Actor identity is "for attribution, not access control" ([identity-without-auth record](../../architecture/decisions/0009-identity-without-auth.md), Consequences; decision 6.6). A human actor is the git email (`packages/records-core/src/human-commands.ts:17-23`). Unverified: whether a spooled `actor.registered` event can claim the human kind.
- **Proof imports.** Agents record proofs through the stdio `record_proof` tool. Imports take only `proof.recorded@1`. The import's media type is taken as given, with no reachable misuse found; the review calls allowlisting it cheap hardening (final security review, non-blocking item 5).
- **Ace's host.**
  - The owner's browser reaches it through a loopback gateway that keeps the private host token server-side (record 0014, Coding environment).
  - Tailnet peers are authenticated by Tailscale `whois` and limited to shared or directly accessible projects. They cannot open terminals, create or fork channels, or use local-only operations (`gateway.ts:529, 559-581`).
  - Peers can still run agents that run shell commands as the host's user. The seal's comment says as much: anyone admitted to a channel "can run `env` through its agent" (`keys.ts:17-20`).
  - From that shell, `host.token` (owner-level host access) and the ChatGPT sign-in file can be read. Nothing in the code prevents it. Unverified by running.
- **Coding worktrees.** The coding agent writes there and can also write the shared `.git` (config, hooks, refs) and the Records store. The review's frozen source protects the review's input, but not the store it publishes into.
- **Review desk.** A loopback server with origin checks meant for browsers. It records dispositions as the git user. A local process that sends same-origin headers is not told apart from the person (unverified by running; consistent with decision 6.6).

## 5. Existing sandboxing

- **OS sandbox on the Mac: none.** No `sandbox-exec`, Seatbelt profile, container or namespace is used by the host, workers, CLI or harness. A search for sandbox mechanisms in `apps/*/src`, `packages/*/src` and `services` found nothing.
- **Environment hygiene instead.**
  - The seal on the coding host.
  - `scrubbedEnvironment` for stack fetches.
  - An allowlist for Graph, labellers and the scan child.
  - `--no-env-file` plus a fixed `bunfig.toml` for workers started from source.
  - MCP servers started in `$HOME` with only the listed variables.
- **Modal isolation for replays.** Each review machine mounts only its own case's sub-path at `/case`. Labels, captures and run records never go up (`modal/isolation.py:1-11`, decision 10.129). Network is limited to `api.openai.com` and the lease host. The machine holds the lease proxy secret and borrows short-lived access tokens; the refresh token never leaves the refresher (`lease.py:9-13`, decision 10.131). Clones are leakage-checked for links out of the clone and for extra git config keys (commits 644846a9, 28f9daf5). Archive, re-fetch, check and recompose-without-model machines have no network and no secret.
- **Listeners.** The app gateway, private gateway and workspace launcher bind to `127.0.0.1` (`app-gateway.ts:151`, `gateway.ts:1067`, `apps/neuve-cli/src/workspace-cli.ts:500`). By default the host also listens on the machine's tailnet address (`gateway.ts:1124-1126`; decision 12.14). `--loopback` turns that off. Ace's compute runner binds `0.0.0.0` inside its container (`services/compute/runner.ts:389`).

## 6. Gaps against the owner's three layers

**Layer 1: the credential scan as a background guard on everything that leaves.**

- **The background service exists only for captures.** It is in review-c, not yet integrated (decision 12.27).
- **It is not hooked into most ways data leaves.** Not into telemetry, host and worker logs, proofs shown on the desk, external agent transcripts, the replay store archive, channel moves to hosted services, or coding agents' pushes and pull requests (section 3).
- **It knows only one kind of secret.** It recognizes model-call header values. Other credentials a session saw are caught only if they match a shape mask (section 3).
- **Its tamper resistance assumes every writer in the store is trusted.** But coding agents run as the same user in worktrees that share the store (section 4). The mark chain detects forks among honest writers, not a hostile local one.
- **The spool watches no one.** Nothing records which process wrote an event or alerts on unexpected writers.

**Layer 2: repository code out of Neuve's process.**

- **Review side: mostly met.** Final-review sessions have no shell, and Graph, scans and stack fetches run as separate children with narrowed environments.
- **The Records worker still carries every credential and runs the repository's own git config.** Its environment is the full `process.env` (`starter.ts:104`), contradicting decision 10.5's "passed only to the call that needs them". Encoders, `gh` scope reads and unpinned harness git commands inherit it, and those git commands run under the repository's own git configuration (section 2).
- **Coding side: not met.** Repository code runs in child shells of the channel worker:
  - as the same user, with the same filesystem and unrestricted network;
  - with `SSH_AUTH_SOCK`, gh and git sign-ins, the keychain, `host.token`, the ChatGPT sign-in file and the Records store all reachable;
  - with no OS sandbox.
  Record 0014's "neither may inherit the other's capabilities" holds between processes, not at the filesystem.
- **Tailnet peers widen this.** Peers can drive agents on the owner's machine (section 4).

**Layer 3: a vault so environment values never reach logs, messages or stored artifacts.**

- **There is no vault.** Values sit in environment variables, `.env.local` (0644 on main), the keychain and 0600 files, all readable by any process running as the user.
- **The seal matches names only.** Credentials under other names pass straight through (section 1).
- **Logs and messages have no output-side redaction.** It exists only for capture exports and proofs (shape masks) and for cloud stderr (`redact.ts`, `redact.py`). Host logs, `worker.log` and agent tool output stored in coding chats have none.
- **Repository content can carry secrets anywhere.** Values that reach a model's context through repository files or tool output can come out in model-written text: briefings, review comments, commit messages, and pull requests that agents write. No scan sits on those outputs.

**Unverified items to confirm before building on them:**

- whether any unpinned harness git command runs a program the repository's config names;
- whether a spooled `actor.registered` event can claim the human kind;
- whether an agent shell can read keychain items that `Bun.secrets` created with the same `bun` binary without a prompt;
- the mode of the tailnet certificate folder;
- whether any team has deployed the hosted services;
- the Modal client's credential location on the Mac.
