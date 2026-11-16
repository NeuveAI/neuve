# Ace and GitHub Next: what they do about runtime security

Research, 2 November 2026. Nothing here is decided. It covers one part of the owner's multi-layered security model: what Ace, the pi stack it runs on, and related GitHub work do about three layers. The layers are a **credential guard** on the paths where Neuve sends things out, **repository code kept out of Neuve's own process**, and a **vault** that keeps environment values out of logs, messages, telemetry and datasets. "Credential guard" and "vault" are the owner's working words for this study. They are not in the [product vocabulary](../../vocabulary.md), so this note does not use them as product terms. The companion [secrets and exfiltration study](04-secrets-and-exfiltration.md) proposes a design for the guard and the vault. This note supplies the precedents behind it and does not repeat that design.

**Sources.** Ace is read from the local clone at a local clone of `githubnext/ace`. Its remote is `githubnext/ace`, and its head `d03deae` is two release commits past the pinned `fe66277931d2c46f12dcc250b63e1b4428a4e9ee`, which [Neuve's Ace harness record](../../architecture/decisions/0014-ace-style-pi-harness.md) adopts. Every Ace line reference below is at the pin (`git show fe66277:<path>`). The pi packages (`@earendil-works/pi-durable` 1.0.0, `pi-ai` 1.0.0 and `pi-telemetry` 1.3.0) are read from the installed dependencies in this repository. Web sources were read on 2 November 2026. Anything not confirmed is marked **unverified**.

## First: can a teammate on the tailnet make commands run on someone else's Mac?

**Verdict: reachable, by design, when the channel's agent access is on.** No live tailnet was probed; this answer is traced from code only. Ace and Neuve share the same path. Here is the path in Neuve, with Ace's matching lines in brackets.

1. **The teammate's host connects to the owner's host.** By [decision 12.14, keep Ace's tailnet default](../../process/decisions.md), the owner's host listens on its tailnet address.
   - A socket without an `Origin` header counts as a peer host.
   - The only identity check is `tailscale whois` on the caller's address. It yields the caller's Tailscale login and refuses tagged nodes. There is no token, no signature and no per-person credential.
   - Browser sockets from anyone but the owner are refused.
   - Evidence: `apps/neuve-host/src/gateway.ts:1150-1166` [Ace `apps/host/src/gateway.ts:1099-1146`] and `apps/neuve-host/src/tailnet.ts`, function `whois` [Ace `tailnet.ts:169-179`].
2. **The teammate sends `ask` to one of the owner's channels.** Peers may not create or fork channels, or use terminals, windows, credentials, moves or updates. The ordinary `channel` request is open to them.
   - It needs project access only: `mayOpen` at `gateway.ts:232-235` [Ace `227-230`], called at `894-897` [Ace `889-892`].
   - The author is replaced with the teammate's verified login: `authored` at `gateway.ts:543-548` [Ace `537-543`].
   - Owner-only operations are refused to peers at `gateway.ts:568-583` [Ace `563-578`], with terminals in the local-only set at line 530 [Ace 525].
   - Neuve's own review operations are not open to peers at all. `requireOwner` in `apps/neuve-host/src/gateway-extensions.ts:32-41` demands the local, authenticated owner.
3. **The channel worker checks agent access.** `#mayInvoke` in `packages/channel/src/channel.ts:908-918` [Ace `channel.ts:751-761`] lets an `ask` through in three cases:
   - the author is the owner;
   - the author starts with `agent@`;
   - the channel's agent access is on.

   New channels start with it off (`channel.ts:110`). A channel with no stored settings counts as on (`LEGACY`, lines 115 and 300).
4. **If it passes, the agent runs on the owner's Mac, as the owner's OS user,** with the full tool set including `bash`. Turning agent access on says exactly this: teammates "can run commands as the owner on this host" ([Ace architecture lines 722 to 730](https://github.com/githubnext/ace/blob/fe66277931d2c46f12dcc250b63e1b4428a4e9ee/docs/architecture.md)).

**Weaker paths that do not need agent access, or that weaken the gates above:**

- **Indirect: a posted message reaches the owner's own runs.** With project access alone, a teammate may still post ordinary messages while agent access is off (Ace architecture lines 725 to 727). Agents read every participant's messages. A message planted this way enters the owner's next run, and that run executes with the owner's tools. This is prompt injection, not direct execution.
- **Project access can be forged by a teammate who modifies their own host.** The host-served directory checks only that a share is filed "as yourself". It does not check that the sharer has direct access to the project (Ace `apps/host/src/directory-server.ts:141-155`, the same file in Neuve). A teammate can therefore grant themselves a share and pass `mayOpen`. Ace documents this as "project access is cooperative" (architecture line 712) and tracks it as [issue 511, make project access hold against a tampering teammate](https://github.com/githubnext/ace/issues/511). The agent-access gate in step 3 still holds, because it lives in the owner's own worker.
- **A login beginning with `agent@` passes the agent-access gate.** `isAgent` is a plain prefix test ([Ace `packages/channel/src/room.ts:51-53`](https://github.com/githubnext/ace/blob/fe66277931d2c46f12dcc250b63e1b4428a4e9ee/packages/channel/src/room.ts)). The gateway replaces authors with Tailscale logins, and nothing in this trace stops a login itself from beginning with `agent@`. Examples would be a GitHub-backed login for a user named `agent` (`agent@github`), or an identity-provider account `agent@company.com`. Such a teammate's `ask` would skip step 3. This is from code only and was not tested; **unverified**.
- **Hosted channels, if a team deploys the services.** Anyone holding the team secret can "watch and post in any hosted channel" (architecture lines 712 to 715) and can state any author, including the owner. That author passes step 3. The hosted channel's file and shell calls run on its workspace, which is the creating host. Neuve keeps these services ([decision 12.11, restore Ace's services](../../process/decisions.md)). Whether any Neuve host uses one was not checked; **unverified**.

**Not reachable, from this trace:**

- **Lobby and directory.** These carry presence, listings, lifecycle events and shares only. No path from them reaches a worker or a tool.
- **Moves and transfers.** These are owner-only, from the local app (`moveOps`, `gateway.ts:562-564` [Ace `557-559`]).
- **Messages between channels on different hosts.** Hosted channels cannot message other channels yet, and agents messaging channels on peer hosts is not built ([Ace issue 57](https://github.com/githubnext/ace/issues/57)).
- **Adopted legacy channels.** Neuve tags old untagged channels `local: true`. A host on the tailnet does not list or serve those (`apps/neuve-host/src/catalog.ts:311`).

## The short answer

- **Ace does not sandbox anything, and says so.** Its process per channel is "process isolation, not a security boundary": agents run as the host's user ([architecture at the pin, lines 207 to 212](https://github.com/githubnext/ace/blob/fe66277931d2c46f12dcc250b63e1b4428a4e9ee/docs/architecture.md)). Its one credential control is `seal()`, which moves variables with credential-like names out of `process.env` before tools run. Its cloud compute pilot adds a scoped Git credential helper and redaction of command output, and states that neither is a boundary against the agent's shell.
- **pi provides seams but no isolation.** File tools run inside the worker process with no path containment. The shell tool spawns children that inherit the worker's environment by default. pi does offer an injectable execution environment and `beforeTool`/`afterTool`/`beforeRequest` hooks. Ace already uses the first to run tools in another process or machine.
- **gh-aw is the strongest precedent for all three layers.** The agent job runs read-only inside a firewalled container. Model credentials sit in a separate proxy container. Writes are requests that a separate, scoped job applies only after a threat-detection job has read them.
- **Its threat detection does sit on the publication path, but it warns by default.** Reviewable outputs are published with a caution marker, and only actions that cannot be reviewed are held back. That is the closest precedent for a guard that "never blocks the workflow".
- **Ace's history has small, real precedents.** The seal arrived after shells could print keys. A first seal pattern swallowed Ace's own configuration and was narrowed. A reseal was added after the login shell's environment is adopted. Channels moved to start unshared. Two access holes are documented and left open ([cooperative project access, Ace issue 511](https://github.com/githubnext/ace/issues/511)).
- **One new gap was found and is worth checking in Neuve.** Under Bun 1.4.0, `Bun.spawn` without an explicit `env` still passes a variable that `seal()` deleted from `process.env` (tested below with a dummy variable). Several Neuve harness spawn sites pass no `env`.

## 1. How Ace and pi isolate agents, tools and credentials

### Process model

| What | How it works in Ace | Reference |
| --- | --- | --- |
| Channel worker | One Bun process per channel over one SQLite file. The host spawns it detached, with the host's full environment including credentials (`workerEnv()`) and `--no-env-file`, so a project's `.env` cannot change the worker's credentials | [`apps/host/src/client.ts` lines 22 to 26](https://github.com/githubnext/ace/blob/fe66277931d2c46f12dcc250b63e1b4428a4e9ee/apps/host/src/client.ts), [`apps/host/src/config.ts` line 33](https://github.com/githubnext/ace/blob/fe66277931d2c46f12dcc250b63e1b4428a4e9ee/apps/host/src/config.ts) |
| Isolation claim | "Process isolation, not a security boundary: every worker runs as the host's user and can read the others' files." The desktop-tools toggle and the agent-access toggle are "not a shell security sandbox" | [architecture lines 207 to 212](https://github.com/githubnext/ace/blob/fe66277931d2c46f12dcc250b63e1b4428a4e9ee/docs/architecture.md) and the [readme's opening warning](https://github.com/githubnext/ace/blob/fe66277931d2c46f12dcc250b63e1b4428a4e9ee/readme.md) |
| Hosted channel | pi runs in a Cloudflare Durable Object, which has no file system or shell. Its tools run on a **workspace**, a host or container that dials out and serves file and shell calls over the [workspace protocol](https://github.com/githubnext/ace/blob/fe66277931d2c46f12dcc250b63e1b4428a4e9ee/packages/channel/src/workspace.ts). Model keys are Worker secrets and never reach the workspace | architecture, "Channel" section |
| Cloud compute pilot | One Cloudflare Container per channel serves the workspace. Model requests use Worker secrets, and "provider keys are not sent to the container" | [compute README lines 41 to 44](https://github.com/githubnext/ace/blob/fe66277931d2c46f12dcc250b63e1b4428a4e9ee/services/compute/README.md) |

### Tools in pi

- **Tools run in or under the worker process.** In `@earendil-works/pi-durable` 1.0.0, `NodeExecutionEnv` in `dist/env/node.js` does file reads and writes in the worker's own process (lines 626 to 710). Shell commands are spawned as detached children (lines 536 to 539).
- **There is no path containment.** `resolvePath` (lines 25 to 42) accepts absolute paths, `~` and `..`, so a file tool reaches anything the OS user can.
- **Children inherit the environment.** `getShellEnv` (lines 193 to 200) merges `process.env`, the configured shell environment and per-call variables unless the call opts out.
- **The seams exist.** `ExecutionEnv` is an interface (`@earendil-works/pi-durable` 1.0.0, `dist/env/index.d.ts`, line 109), and Ace's workspace protocol is a remote implementation of it. In `@earendil-works/pi-durable` 1.0.0, `dist/harness/types.d.ts` (lines 518 to 543) defines `beforeRequest` (rewrite the messages for one request), `beforeTool` (block or rewrite arguments; a throw blocks) and `afterTool` (replace the result).

### Credentials

- **The seal.** [`apps/host/src/keys.ts` lines 17 to 30](https://github.com/githubnext/ace/blob/fe66277931d2c46f12dcc250b63e1b4428a4e9ee/apps/host/src/keys.ts) moves every variable whose name ends in `_KEY`, `_TOKEN`, `_SECRET`, `_PASSWORD` or `_CREDENTIAL(S)` into an in-memory map. Workers call it at startup ([`worker.ts` line 26](https://github.com/githubnext/ace/blob/fe66277931d2c46f12dcc250b63e1b4428a4e9ee/apps/host/src/worker.ts)). The host calls it at startup, because "hosted channels run tools in this process", and again after it adopts the login shell's environment ([`gateway.ts` lines 1227 and 1239](https://github.com/githubnext/ace/blob/fe66277931d2c46f12dcc250b63e1b4428a4e9ee/apps/host/src/gateway.ts)).
- **Key lookup.** pi-ai asks for each key by its usual name. Ace answers from the sealed map, then the macOS keychain, and reads the keychain again on each model request (`keys.ts` lines 73 to 75 and 201 to 220). In `@earendil-works/pi-ai` 1.0.0, `dist/auth/resolve.js` takes this lookup as an injected `authContext.env`, so the host decides where keys come from.
- **Least privilege per tool.** The GitHub CLI receives only `GH_TOKEN` and no model keys (`keys.ts` lines 37 to 41). Settings shows each key's status and never its value (lines 80 to 199).
- **Compute pilot.** [`services/compute/runner.ts`](https://github.com/githubnext/ace/blob/fe66277931d2c46f12dcc250b63e1b4428a4e9ee/services/compute/runner.ts) writes the Git token to a mode-0600 file under `/run`, outside the project. A credential helper answers only for the one repository host and path (lines 109 to 130). Shells see the helper's path through `GIT_CONFIG_*` variables, never the token (lines 59 to 72). Command output and error replies have the team secret and the token removed, raw and base64-encoded (lines 46 to 57). The [README's boundaries section](https://github.com/githubnext/ace/blob/fe66277931d2c46f12dcc250b63e1b4428a4e9ee/services/compute/README.md) (lines 152 to 159) says this "is not a credential security boundary against the agent's shell" and "response redaction only reduces accidental disclosure". It also warns that checkpoints archive any secret written into the project.
- **Team services.** Hosts authenticate with HMAC-SHA256 of the team secret over the tailnet name. The runner receives that derived credential, never the team secret (architecture lines 539 to 540 and 750 to 761).

### Multi-user: the tailnet, the directory and lobbies

- **The tailnet is the team.** The host that runs a channel names each caller with `tailscale whois`. [`apps/host/src/access.ts`](https://github.com/githubnext/ace/blob/fe66277931d2c46f12dcc250b63e1b4428a4e9ee/apps/host/src/access.ts) grants access from GitHub read access, the person's own folder, or a share (architecture lines 677 to 706).
- **Authors are stamped at the edge.** "Gateways rewrite every client's author, so only a local worker can send an agent author" (architecture line 730).
- **Two holes are documented.** "Project access is cooperative" (line 712): anyone holding the team secret can read every listing, join any lobby and post in any hosted channel, and GitHub logins are self-reported. "The tailnet scope is not a security boundary" (line 763): the services are public Worker URLs. Both are tracked in [Ace issue 511, make project access hold against a tampering teammate](https://github.com/githubnext/ace/issues/511), opened 19 October 2026 and still open.
- **Invoking an agent hands over the shell.** Turning agent access on "states that teammates can run commands as the owner on this host" (lines 722 to 730). New channels start with it off.
- **The owner token.** It is a mode-0600 file. The first WebSocket handshake uses it and then sets an HttpOnly cookie. Ace notes this "does not isolate Ace from tools running as the same OS user" (lines 333 to 339).
- **Logs.** Each process appends JSON lines to its own file under `$ACE_HOME/logs` ([`apps/host/src/log.ts`](https://github.com/githubnext/ace/blob/fe66277931d2c46f12dcc250b63e1b4428a4e9ee/apps/host/src/log.ts)). There is no masking. Callers simply avoid logging values.

### What Neuve inherited and what it changed

Neuve's rewrite lives on `codex/pi-transition` in this repository. Its [host upstream record](../../apps/neuve-host/UPSTREAM.md) lists each changed file:

- **Inherited unchanged.** `keys.ts`, so the seal and the name pattern are the same, along with `auth.ts`, `environment.ts`, the process model, tailnet participation by default ([decision 12.14, keep Ace's tailnet default](../../process/decisions.md)), and the absence of a sandbox.
- **Added: private logs.** [`private-log.ts`](../../apps/neuve-host/src/private-log.ts) writes logs mode 0600 in a mode-0700 directory and passes fields through allowlists of metrics, identifiers and kinds. It is a positive allowlist where Ace has none.
- **Added: server-held credentials.** The private host token stays server-side behind the [coding gateway](../../apps/neuve-host/src/app-gateway.ts). `native-review.ts` keeps the owner credential out of pi configuration, tool output, browser state and Capture. `host-config.ts` serializes worker configuration without secrets.
- **Added: trusted integrations only.** The [integration schema](../../packages/harness/src/integrations.ts) reads `integrations.json` from the user's settings and "never reads repository `.mcp.json`". It allows only listed variables and read-only tools.
- **Added: Capture's credential scan.** It recognizes the credentials each model call sent and runs as a background Records job (decisions 12.26 and 12.27). The [companion study](04-secrets-and-exfiltration.md#what-neuve-does-today) describes what it covers.
- **Stated, not yet found as a mechanism.** The harness record says coding and final-review sessions must not inherit each other's capabilities, and that replays stay isolated from credentials (line 15). Whether a mechanism enforces this beyond tool lists was not traced here; **unverified**.

## 2. What gh-aw and the Copilot coding agent do for each layer

[GitHub Agentic Workflows (gh-aw)](https://github.com/github/gh-aw) compiles a Markdown workflow into a GitHub Actions lock file. Latest release v1.0.1, 27 October 2026. Its firewall, [gh-aw-firewall (AWF)](https://github.com/github/gh-aw-firewall), is at v0.29.5, 1 November 2026. Facts below come from the [architecture page](https://github.github.com/gh-aw/introduction/architecture/), the [threat detection reference](https://github.github.com/gh-aw/reference/threat-detection/), the [safe outputs reference](https://github.github.com/gh-aw/reference/safe-outputs/) and the [network reference](https://github.github.com/gh-aw/reference/network/). None of these pages shows a date.

### Layer: keeping repository code away from the process that holds authority

- **gh-aw.** The agent runs in a container on its own Docker network. The agent job's token has "minimal read-only permissions". Every write is a buffered request that a later job applies with its own scoped token, such as `issues: write` for issues, or `contents: write` and `pull-requests: write` for pull requests. Custom MCP servers each run in their own container, with no shared state and their own domain allowlists. A Cloud Hypervisor mode, in preview, runs the agent in a KVM microVM.
- **What gh-aw admits.** It calls the MCP gateway's agent identity "not a strong security boundary". It also notes that steps the workflow author writes are trusted code and are not sandboxed.
- **Copilot coding agent** ([risks and mitigations](https://docs.github.com/en/copilot/concepts/agents/cloud-agent/risks-and-mitigations)). It runs in an ephemeral Actions or cloud sandbox and pushes to one branch only (a `copilot/` branch, or the pull request's own). It "can only perform simple push operations" and cannot run `git push` itself, so the push credential stays out of its shell. It cannot approve or merge, and workflows on its pull requests wait for a person to approve them.

### Layer: the credential guard on the way out

- **Before the network: an allowlist.** AWF sends the container's HTTP and HTTPS through a Squid proxy with a domain allowlist (`network: defaults` unless set; `network: {}` blocks everything). Blocked domains appear in the logs, and `gh aw audit` shows a firewall analysis per domain. The [Copilot agent's firewall](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-firewall) works the same way and adds a warning naming each blocked address to the pull request. It covers only processes the agent's Bash tool starts, not MCP servers or setup steps. GitHub says it "should not be considered a comprehensive security solution".
- **The key never enters the agent's container.** AWF's [API proxy sidecar](https://github.com/github/gh-aw-firewall/blob/main/docs/api-proxy-sidecar.md) holds the model keys. The agent sees only local base URLs. The sidecar "strips any client-supplied auth headers and injects the real credentials", and it is now always on.
- **Publication goes through a separate job.** Only the safe-outputs job writes, and it applies sanitization first: XML escaping, HTTPS-only links, URLs outside `allowed-domains` replaced by "(redacted)", HTML comments removed, mentions neutralized, size and count limits. Allowed repositories and labels are fixed in configuration. Protected files fall back to a review issue. A staged mode previews outputs without writing anything.
- **Threat detection reads outputs before publication.** See the next subsection.

### Threat detection, and how gh-aw keeps it from blocking

[Threat detection](https://github.github.com/gh-aw/reference/threat-detection/) is the closest precedent for a guard on egress.

- **Where it runs.** It is a separate job "after the main job completes but before safe outputs are applied". It runs only when safe outputs are configured.
- **What it reads.** The agent's output items (`agent_output.json`), the Git patch (`aw.patch`), the prompt and its imports, and the workflow's stated intent, so it can tell intended actions from threats.
- **How it judges.** By default it is a model call (the same engine, or one set with `engine`). The model returns three verdicts, `prompt_injection`, `secret_leak` and `malicious_patch`, with reasons. `steps` and `post-steps` add tools such as TruffleHog or Semgrep, and `engine: false` keeps only those steps.
- **It does not block by default.** Warn mode is the default (`continue-on-error: true`):
  - reviewable outputs such as issues and pull requests are published with a `[!CAUTION]` block;
  - a push to an existing pull-request branch becomes a new pull request for review;
  - only actions that cannot be reviewed, such as a merge, are withheld.

  Strict mode (`continue-on-error: false`) withholds all outputs.
- **A failed detector is not a pass.** An outage or unparsable verdict means "the security assessment is incomplete". The job then follows the warn or strict setting.
- **It is bounded.** It has its own credit budget (default 400) and a 10-minute timeout. Each run is reported to a tracking issue.
- **What gh-aw says it does not do.** Markers are "inspection metadata, not permission grants or proof against prompt injection", and detection is "defense in depth, not proof that arbitrary code or artifacts are safe".
- **Masking runs in two places.** Every run ends with a redaction step (`if: always()`) that masks exact secret values in files under `/tmp/gh-aw`, showing the first three characters. Console masking does not clean downloadable artifacts.

So gh-aw keeps the guard off the critical path in two ways. Detection judges a finished artifact once, not each step the agent takes. And its default turns a finding into a visible label and a review step. Only actions that cannot be reviewed are held back. This is how gh-aw stays out of the way while still sitting on the only path to publication.

### Layer: the vault (values out of logs, messages, telemetry and datasets)

- **gh-aw.** Secrets are passed as environment variables and never written into configuration files. The run-end redaction step masks exact values, and `secret-masking:` adds patterns. Because the model keys stay in the proxy sidecar, they never enter the agent's transcript. AWF's own docs note the keys still sit in the sidecar's environment and in its Compose file on the runner.
- **GitHub secret scanning.** [Push protection](https://docs.github.com/en/code-security/secret-scanning/introduction/about-push-protection) checks command-line pushes, web commits, uploads and REST requests against provider patterns, generic patterns and custom patterns. A blocked push can be bypassed with a reason. Each bypass creates an alert and an audit log entry.
- **GitHub MCP server secret scanning.** Since [August 2025](https://github.blog/changelog/2025-08-13-github-mcp-server-secret-scanning-push-protection-and-more/), with general availability in [May 2026](https://github.blog/changelog/2026-05-05-secret-scanning-with-github-mcp-server-is-now-generally-available/), it lets an agent check content for secrets before committing. The checks follow the repository's push protection settings. The push protection page says AI-detected secrets are not checked on REST or MCP requests.
- **The Copilot coding agent** runs CodeQL, secret scanning and dependency checks on its own changes and "attempts to resolve issues" before it finishes the pull request. Whether a finding blocks the pull request is not stated; **unverified**.
- **pi-telemetry** states the same rule at the library level. Instrumentation "should avoid prompts, completions, tool arguments or output, file contents, provider payloads, headers, credentials" (`@earendil-works/pi-telemetry` 1.3.0, `README.md`, "Security and Portability").

## 3. Patterns Neuve could adopt

| Pattern | Layer | Precedent | Cost | What it does not cover |
| --- | --- | --- | --- | --- |
| **Run tools outside the worker through pi's `ExecutionEnv`.** The worker keeps pi, Records access and credentials. A separate process or container serves file and shell calls over Ace's workspace protocol | Code out of Neuve's process | Ace's hosted workspace and compute runner | Low to adopt: the protocol and client already exist in Ace's [`workspace.ts`](https://github.com/githubnext/ace/blob/fe66277931d2c46f12dcc250b63e1b4428a4e9ee/packages/channel/src/workspace.ts). The executor still needs an OS sandbox (see the sandboxing study) | Without a different OS user or a container, the executor can still read the worker's files and memory. File-tool path containment still has to be added |
| **Agent proposes, a separate step publishes.** The agent records review findings, pushes and comments as requests. A separate step with its own scoped credential applies them | Guard | gh-aw safe outputs; the Copilot agent's simple push without `git push` | Medium. Neuve already publishes through Records with an idempotent receipt ([harness record line 13](../../architecture/decisions/0014-ace-style-pi-harness.md)), so the step can sit there. `lane push` from coding sessions is the main path that bypasses it today | A secret the publisher itself does not recognize. Data hidden in an allowed form, such as an allowed URL or encoded text |
| **Read the finished output before publishing, and label rather than block.** One pass over the publish request and patch: exact known values first, then pattern tools, then an optional model call. A finding labels a reviewable output and withholds only actions that cannot be reviewed | Guard | gh-aw threat detection in warn mode; Neuve's own background scan (decision 12.27) | One bounded job per publication, not per step. It can share Capture's detectors and Records queue | It finds secrets, not every harmful change, as gh-aw itself says. It runs after the agent ran, so it cannot stop a direct network leak during the run |
| **Keep model keys in a proxy.** The worker or executor sees a local base URL. The proxy strips incoming auth headers and injects the key | Vault and guard | AWF's API proxy sidecar | Medium: one local process. pi-ai already takes an injected credential lookup and base URLs. Neuve's ChatGPT subscription refresh would move into the proxy | The proxy's own memory and configuration. Other credentials, such as the GitHub token and Modal tokens, each need their own broker (the Git credential helper pattern below) |
| **Egress allowlist with a log of what was refused.** The executor's network goes through one proxy with a domain allowlist and a per-run report of refused hosts | Guard | AWF; the Copilot agent firewall | Needs a container or OS network rules. On macOS, a Seatbelt profile can force traffic to a local proxy (**unverified for Bun**) | Hosts on the allowlist, DNS (unless resolution also goes through the proxy) and MCP servers outside the firewall, which the Copilot docs name as a gap |
| **A repository-scoped Git credential helper.** The token lives in a mode-0600 file outside the project, and the helper answers only for one host and path | Vault | Ace's compute runner | Very low: about 30 lines in Ace | Same-user processes can still read the file. It is a scope limit, not a boundary |
| **Pass the child environment explicitly.** Never inherit it. Build each child's environment from an allowlist rather than deleting names from `process.env` | Vault | Ace's `githubEnv()` already does this for the GitHub CLI | Low: audit the spawn sites (see the finding below) | Values the child reads from disk or the keychain on its own |
| **Positive allowlists for logs and telemetry.** | Vault | Neuve's `private-log.ts`; pi-telemetry's attribute rule | Already in place for host logs | Model inputs and transcripts, which Capture keeps raw by decision 12.12 |
| **Write down the boundary and its open holes.** | All | Ace's "not a security boundary" warnings and issue 511 | Documentation only | Nothing by itself |

### A new gap: `Bun.spawn` ignores the seal

**Tested on this machine.** Bun is 1.4.0; the test used a dummy variable `PROBE_DUMMY_TOKEN` and no real credential. After `delete process.env.PROBE_DUMMY_TOKEN`, the following still passed the variable to the child:

- `Bun.spawn` and `Bun.spawnSync` called without an `env` option.

The following did not:

- `node:child_process` (`spawn`, `spawnSync`, `execSync`);
- `Bun.$`;
- any call that passes `{ ...process.env }`.

**What this means for Ace and Neuve.** pi's shell tool uses `node:child_process` with an explicit environment, so agent shells are sealed as Ace intends. But any `Bun.spawn` without `env` in a sealed process passes the sealed credentials to its child.

- **Ace.** At the pin, [`apps/host/src/github.ts` line 282](https://github.com/githubnext/ace/blob/fe66277931d2c46f12dcc250b63e1b4428a4e9ee/apps/host/src/github.ts) runs `git config --local --get-regexp` this way. That command runs no repository-controlled program, so the risk there is low.
- **Neuve.** These sites in this repository pass no `env`: `packages/harness/src/git.ts:31`, `git-objects.ts:154`, `graph-search.ts:208`, `commit-prepare.ts:335`, `openai-auth.ts:1147` and `stack/handler.ts:535`. Some run `git` inside a repository under review. A repository's `.git/config` can name programs that Git runs, such as `core.fsmonitor` or a diff driver.
- **Not checked here:** whether these sites run in a process that has called `seal()`; **unverified**.

**A related, unconfirmed point.** The worker starts with credentials in its initial environment. `seal()` changes only the JavaScript copy. On Linux, `/proc/<pid>/environ` shows the initial environment to processes of the same user. On this macOS machine, `ps -E` showed no environment at all, even for a control variable, so the test was inconclusive. Both cases are **unverified**. If it holds, it makes sense to start workers with an environment that already has the credentials removed, and to give them keys over a pipe instead.

## 4. Security problems found and fixed in Ace's history

| When | What changed | Commit |
| --- | --- | --- |
| 2 October 2026 | Agent shells inherited the worker's environment, and "anyone admitted to a channel can run `env` through its agent". The seal was added | [fc5a8f1, keep credentials out of agent shells](https://github.com/githubnext/ace/commit/fc5a8f16aae7a75dd2024a8a6ea4bf3b0d569f8b) |
| 2 October 2026 | The first pattern also sealed every `ACE_*` variable, which removed Ace's own configuration. It was narrowed to name suffixes. A precedent that name matching is fragile in both directions | [994c7ee, keep Ace configuration when sealing credentials](https://github.com/githubnext/ace/commit/994c7ee) |
| 5 October 2026 | Source runs could load a checkout's `.env`. Workers now start with `--no-env-file`, so an unrelated working directory cannot change their credentials | [d0b66bb, isolate checkout development runs from installed helpers](https://github.com/githubnext/ace/commit/d0b66bb) |
| 7 and 19 October 2026 | A security warning was put at the top of the readme ("Channels and lanes are not security sandboxes"), then pointed at the trust model | [3405ec6](https://github.com/githubnext/ace/commit/3405ec6), [0190b36](https://github.com/githubnext/ace/commit/0190b36) |
| 14 October 2026 | New channels start with agent access off. Turning it on asks for confirmation and says that teammates can run commands as the owner on this machine | [163271e, start new channels unshared](https://github.com/githubnext/ace/commit/163271e) |
| 14 October 2026 | A login shell's environment adopted later can carry credentials again, so the host seals again after adopting it | [4294e59, retry a failed login-shell load](https://github.com/githubnext/ace/commit/4294e59) (the reseal is in `gateway.ts` line 1239) |
| 14 October 2026 | An `agent@` author must stay impossible to forge from outside the host. Only gateways admit clients, and they rewrite every author | [3cffc94, let a same-host agent's handoff invoke an unshared channel](https://github.com/githubnext/ace/commit/3cffc94) |
| 15 October 2026 | The compute pilot shipped with a scoped Git helper, a token kept out of the project and redacted output. Its evidence notes that saved environment and Git configuration output held no raw or encoded token | [1e421be, pilot Cloudflare workspaces](https://github.com/githubnext/ace/commit/1e421be) |
| 19 October 2026 | Project access checks were added. Peers without access are refused, and the cooperative limit is written down and left open as issue 511 | [2ab6b35](https://github.com/githubnext/ace/commit/2ab6b35), [f905174](https://github.com/githubnext/ace/commit/f905174) |

A related precedent from GitHub: [gh-aw-firewall pull request 807](https://github.com/github/gh-aw-firewall/pull/807), merged 13 February 2026, found that `ANTHROPIC_API_KEY` had been "incorrectly exposed to the agent container" when it should have been held only by the proxy, and removed it. Even a design built around a credential proxy leaked a key through ordinary configuration. A test that checks the agent's environment for real keys is worth keeping.

## Open points

- Whether Neuve's harness spawn sites without `env` run in a sealed process, and whether any of them runs repository-controlled Git configuration.
- Whether the Linux `/proc/<pid>/environ` exposure applies to Neuve workers on Modal or Linux hosts.
- Whether the separation of coding and final-review capabilities stated in the harness record has an enforcing mechanism.
- Whether the guard should label findings like gh-aw's default, or hold publication like its strict mode. That choice is the owner's.
