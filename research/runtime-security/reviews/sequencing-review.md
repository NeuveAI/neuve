# Runtime security: sequencing review

Independent delivery review, 2 November 2026. It judges the four runtime-security studies for feasibility and order, and proposes backlog tickets. It decides nothing and changes no code. The studies are [what Neuve does today](../01-neuve-today.md), [Ace and GitHub Next](../02-ace-and-github-next.md), [sandboxing generated code](../03-sandboxing-generated-code.md) and [secrets and exfiltration](../04-secrets-and-exfiltration.md). Code was read in the rewrite in this repository (branch `codex/pi-transition`), in its pi packages, and in the replay runner. File references below are to that rewrite unless marked. No credential file was opened. One probe used a dummy variable.

"Credential guard" and "vault" are the owner's working words. They are not in the [product vocabulary](../../../vocabulary.md), so this review does not use them as product terms. "Lane" here means a chat's Git worktree, as the rewrite's tools use it; a "development lane" is one implementer and one reviewer, as in the [repository guidance](../../../AGENTS.md).

## Verdict

- **The studies agree and are mostly right.** The order should be: the owner's no-code steps today; then cheap fixes in Neuve's own processes; then containment of coding sessions; then the broker and the background watcher; the hosted tier last.
- **The single most urgent risk needs no teammate.** A dependency script run by `bun install` or a test in a coding session runs as the owner. It can read Neuve's ChatGPT sign-in, the host's owner token and the Records store, and push with the owner's Git sign-ins. Only code closes this. The no-code steps narrow what a stolen credential can do.
- **Peer execution over the tailnet is real but closable today** with `--loopback`, if the owner does not need teammates on this host.
- **Six points change the plan.** They are below. The first two change the smallest sandbox step itself.

## What the studies missed or got wrong

1. **A command sandbox leaves pi's file tools open.** pi's `read`, `write` and `edit` run inside the channel worker, not in a child process (`@earendil-works/pi-durable` 1.0.0, `dist/env/node.js`, `NodeExecutionEnv` file methods, lines 626 to 710). Its `resolvePath` accepts absolute paths, `~` and `..`. The sandboxing study's smallest step wraps only `exec`. A prompt-injected agent can still use `read` on the sign-in file. File tools need their own path rules in the same wrapper.
2. **One environment factory serves the agent and the channel's own Git work.** `env(cwd)` in [`apps/neuve-host/src/worker.ts`](../../../apps/neuve-host/src/worker.ts) (lines 97 to 101) is used by the agent harness ([`packages/channel/src/channel.ts`](../../../packages/channel/src/channel.ts) line 265), and also by the channel's `changes` and `fetch` operations (lines 531 to 537), which fetch the lane's base with the owner's credentials. Wrapping the factory wholesale would sandbox the base fetch and break the diff view. The agent needs its own factory. Line 265 is the seam. `channel.ts` is Ace-owned, so this is one small listed seam under the [decision to restore Ace's host through small seams](../../../process/decisions.md) (Area 12).
3. **The LaCie volume ignores file ownership.** `mount` shows the external LaCie volume as `hfs, ..., noowners`. The default storage profile puts the host's home on it ([`apps/neuve-cli/src/workspace-runtime.ts`](../../../apps/neuve-cli/src/workspace-runtime.ts) line 163: `<state>/neuve-host`). The same goes for the state, captures and temporary folders ([`scripts/pi-storage.ts`](../../../scripts/pi-storage.ts) lines 115 to 131). So the owner token, raw captures and the capture authorities sit where the 0600 and 0700 modes do not hold against another local account. HFS+ also suggests the drive is not encrypted at rest (**unverified**: `diskutil` was blocked here). None of the studies notes this. It matters only for other accounts or a lost drive, not for same-user agents.
4. **Agents can act as the human at the human gate.** The studies list the pieces ([today's study, section 4](../01-neuve-today.md#4-trust-boundaries-and-writers)) but do not join them. A coding agent's shell, running as the owner, can write `records.sqlite`, run the human `neuve` commands as the git user, or post to the loopback review desk with same-origin headers. Approval must come only from review. The coding-session sandbox closes this for coding sessions if it denies the store and the host's own ports. It does not close it for agents the owner runs outside Neuve's host.
5. **`Schema.Redacted` does not fit the schemas Neuve has.** Settings are zod ([`packages/harness/src/settings.ts`](../../../packages/harness/src/settings.ts) line 20), and so are Records schemas (record 0011, [zod schemas](../../../architecture/decisions/0011-zod-schemas.md)). The secrets study's step needs a zod transform into Effect's `Redacted`, plus an explicit refusal on encode, since zod has no `disallowJsonEncode`.
6. **Three sandbox defaults would break ordinary coding work.**
   - Denying loopback breaks tests and dev servers that listen on `localhost`. Deny only the host's own ports and the Records worker's socket, which may fall back to `/tmp/neuve-<uid>/` ([`worker-socket.ts`](../../../packages/records-core/src/worker-socket.ts) lines 15 to 18).
   - Write-protecting the shared `.git/config` breaks `git push -u` and `git checkout --track`, which write upstream settings, and husky's install, which sets `core.hooksPath`. Pinning Neuve's own Git first (ticket **Pinned Git**) removes the main reason for that protection: the attack it stops is a coding agent planting a program that Neuve's credential-holding workers then run. Protect `hooks` from the start; for `config`, watch first.
   - Denying `~/.config/gh` and `SSH_AUTH_SOCK` stops agents opening pull requests, which the adopted Ace journey relies on. That deny must wait for a scoped push path.

The `Bun.spawn` finding in the Ace study was rechecked with a dummy variable on Bun 1.4.0: `Bun.spawnSync` with no `env` still passed a variable deleted from `process.env`; `node:child_process` did not. In practice it matters less in the sealed host, whose such sites run no repository-configured program. It matters more in the Records worker, which is never sealed and starts with the full environment ([`packages/records-core/src/starter.ts`](../../../packages/records-core/src/starter.ts) line 104). There the fix is the worker's starting environment, not each spawn site.

## Steps the owner can take today, with no code

`NEUVE_MAIN_ROOT` names a checkout of main.

| Step | What it closes | What it does not close |
| --- | --- | --- |
| Start the workspace with `--loopback` (`bun workspace --loopback`), unless teammates use this host | Teammates driving agents on this Mac: direct asks, the `agent@` login prefix, old channels that count as shared, forged project shares, and planted messages in shared channels. Breaks discovery, lobbies and opening the desk from another device over the tailnet | Anything the owner's own agents or repository code do. Hosted channels through team services, if any are configured (**unverified** whether `--loopback` stops those) |
| If the tailnet stays on: in the Tailscale admin console, check that no user login starts with `agent@`, and restrict who may reach this Mac's host port to the owner's own devices | The prefix bypass and peers the owner did not mean to admit | Peers the owner admits on purpose |
| If the tailnet stays on: turn agent access off in each channel teammates can open, especially channels made before new channels started unshared, which count as shared | Teammates running commands as the owner through those channels | Planted messages, which still reach the owner's own runs |
| `chmod 600 "$NEUVE_MAIN_ROOT/.env.local"` (main's copy is 0644 today) | Other local accounts reading main's keys | Any process running as the owner, including agents |
| `gh auth status`, then remove scopes agents do not need, `workflow` first (`gh auth refresh --remove-scopes workflow`). Use project-scoped provider keys with spend limits | An agent rewriting CI workflows to steal repository secrets; the blast radius of a stolen key | Pushes to repositories the token still covers. SSH keys, which are not scoped this way |
| Check reviewed repositories for programs Git would run: `git config --show-origin --get-regexp 'core.fsmonitor|core.hookspath|diff\..*|filter\..*'`, and look for non-sample files in `.git/hooks` | Shows whether such a program is already planted | Prevents nothing; a later plant is not seen |
| Keep the LaCie drive attached only to this Mac, add no other macOS accounts, and keep `run/cloud/store.tar` archives off shared folders | The ownership gap and the unscanned replay archive, by keeping both private | Same-user processes. Turning ownership on for the volume is not advised without a test: files written while it was off may then fail Neuve's own owner checks |
| Optionally ask the SSH agent to confirm each use (`ssh-add -c`, or an agent that prompts per use) | Silent pushes over SSH by agent shells | Pushes through `gh`'s token. It also interrupts unattended agent pushes |

## Feasibility of each recommended step

| Step | Seam it uses | What it could break | How it is proven |
| --- | --- | --- | --- |
| Neuve's own Git runs no repository-configured program | The pins already in [`packages/harness/src/stack/transport.ts`](../../../packages/harness/src/stack/transport.ts) (lines 27 to 52), applied at `git.ts:31`, `git-objects.ts:154`, `graph-search.ts:208`, `commit-prepare.ts:335`; `--no-ext-diff` and `--no-textconv` on diffs | Diff drivers a repository relies on for readable diffs; Git LFS smudge, which review reads skip already | A test with a planted `core.fsmonitor` marker (reason: the input boundary); the review's run log shows pinned commands; a live review on a repository with the plant |
| Add the no-autoload flags to the evaluation build | [`packages/evaluation/src/neuve-build.ts`](../../../packages/evaluation/src/neuve-build.ts) line 36; the release build already has them. The replay's Linux image uses the release build, so replays are already safe | Nothing | Code reading plus the build receipt |
| Records worker starts with an allowlisted environment | `starter.ts` line 104 | Model calls behind a proxy (`HTTPS_PROXY`), encoder cache variables, Graph's `ENTIRE_*`, the lease variables on replay machines. Each must be named | A test that a dummy variable does not reach the worker; a Modal replay smoke case still borrows from the lease; worker log |
| Agent tools get their own execution environment, with no inherited environment | A Neuve wrapper over `NodeExecutionEnv` handed to the harness at `channel.ts:265`. The wrapper forces `inheritEnv: false` over pi's bash default (`@earendil-works/pi-durable` 1.0.0, `dist/tools/bash.js` lines 35 to 41) | Tests that read variables such as `DATABASE_URL`. With `inheritEnv: false`, pi passes an empty environment, so `PATH` and `HOME` must be supplied | In the app: an agent's `env` lacks a dummy variable (DevTools screenshot of the chat), with the host log line and a test at the wrapper |
| File-tool path rules | The same wrapper's file methods: writes only in the lane and its temporary folder; reads refused for a deny list, after resolving links | Agents reading other repositories for reference stay allowed; reads of skills or instructions from the home folder must stay allowed | A refused `read` of a dummy file in a denied folder, seen in the chat and the host log, plus a test of link resolution |
| OS sandbox around agent commands | Seatbelt via `/usr/bin/sandbox-exec`, present on this Mac (macOS 27.0.1). Two routes: a profile of Neuve's own, like Neuve Graph's `clangd` step ([`lsp_enrichment.go`](../../../apps/neuve-graph/internal/sem/lsp_enrichment.go) lines 266 to 267), or `@anthropic-ai/sandbox-runtime`'s `wrapWithSandbox`, which is not installed and is in beta | The traps in point 6 above; caches under the home folder; macOS-only toolchains that write to `~/Library`. On Linux there is no Seatbelt, so the same code must not refuse every coding session there | In the app: `bun install` and `bun test` in a sample repository pass; reads of the store and sign-in fail; host log shows each refusal; a test of the generated profile |
| Egress allowlist for agent commands | A local proxy that the sandbox forces traffic through. The sandbox runtime has one; a profile of Neuve's own would need its own | Package installs from registries not listed; Git over SSH, which an HTTP proxy does not carry | A watch period's refused-host log shows what coding needs before enforcement; then a blocked fetch to an unlisted host |
| Lane-scoped push credential | Ace's compute runner helper ([`services/compute/runner.ts`](https://github.com/githubnext/ace/blob/fe66277931d2c46f12dcc250b63e1b4428a4e9ee/services/compute/runner.ts), lines 59 to 130): a 0600 token file outside the project and a helper that answers for one host and path | Agents working across several repositories in one chat | A push to the lane's remote works; a push to another remote is refused; log |
| Register every credential Neuve holds, plus a canary, with Capture's scan | The detector registry in [`credential-detectors.ts`](../../../packages/harness/src/pi/capture/credential-detectors.ts), fed from `workerEnv()` in [`keys.ts`](../../../apps/neuve-host/src/keys.ts) at coding-worker setup. It needs the background scan, still in its lane, to land | Short values would match by accident; a minimum length is needed | A fixture capture holding a dummy registered value is refused at export; the scan's record shows the refusal |
| Replay archive behind the scan | `archive_case` in `modal/app.py` (kept in the private archive) line 437, reading the mark like export does | Composition-only reruns that read the archive | An archive of an unscanned capture is refused or carries only scanned bytes; run log |
| Known-value redaction in host and worker logs | `apps/neuve-host/src/log.ts` lines 47 to 54 (Ace-owned; one listed seam) and the Records `worker.log` | Nothing | A dummy registered value in an error is masked in the written line |
| Raw bytes do not outlive the prune | Records' SQLite `secure_delete`, and pruning migration backups | Slightly slower deletes | A freed page holds no prior bytes after prune |
| Remote images and links in rendered agent text | Existing CSP headers in [`app-gateway.ts`](../../../apps/neuve-host/src/app-gateway.ts) lines 21 and 116, `gateway.ts` line 1051 and the desk's [`framing.ts`](../../../apps/neuve-web/apps/web/src/server/framing.ts); none sets `img-src`. The UI renders Markdown with `markdown-it`, which renders images by default | GitHub avatars ([`packages/ui/src/lib/format.ts`](../../../packages/ui/src/lib/format.ts) line 7) and images in pull-request bodies; list GitHub's image hosts | DevTools MCP screenshot and console: an external image in a fixture chat is blocked; avatars still load |
| Credential broker for model routes | pi-ai's injected credential lookup and base URLs (`@earendil-works/pi-ai` 1.0.0, `dist/auth/resolve.js`) | The ChatGPT subscription refresh, which must move into the broker; prompt caching and cost receipts must still work | Worker environment and settings hold placeholders only; broker log shows each injection; a live coding turn and a live review |
| Record of send-outs and a background watcher | A new Records queue job kind beside the background scan ([`queue.ts`](../../../packages/records-core/src/queue.ts), [`jobs.ts`](../../../packages/records-core/src/jobs.ts)) | Nothing on the path, by design | A planted canary in a send-out yields a finding and a revoked token; the review carries on |
| Agent proposes, Neuve publishes | Records' idempotent publish receipt ([the pi harness record](../../../architecture/decisions/0014-ace-style-pi-harness.md), line 13) | The adopted Ace journey where agents push and open pull requests themselves | A pull request opened through the publisher with a caution label on a planted finding |
| Settings hold references, not values | zod transform into `Redacted`, one unwrap point, a check rule | Users who keep keys in settings files today | A record or log line with a credential field fails to encode, in a test |
| A virtual machine per hosted coding session | Cloudflare Containers through the Sandbox SDK, outbound Workers | Not built; Ace's services are source only | Deferred |

## Phases

**Phase 0, today, the owner.** The no-code steps above.

**Phase 1, urgent and small.** None of these changes a product flow.
- **Why urgent.** Pinned Git closes a CodeRabbit-shaped chain: a coding agent plants a program in the shared `.git/config`, and the Records worker, which holds model keys, runs it on its next review. Peer access closes direct remote execution if the tailnet stays on. The question spike settles the unverified premises the later tickets rest on.
- **Order.** Pinned Git, the question spike, peer access and remote images can start at once. Records worker environment and the replay archive wait for the background scan to land, because they touch the same files (`records-core`, the replay runner).

**Phase 2, contain coding sessions.** This is the main build and closes the largest everyday risk.
- **Order.** Agent environment, then file-tool path rules and the command sandbox (filesystem only, network watched), then the lane-scoped push credential. Only after that: deny `gh` and SSH to agent shells, and enforce the egress allowlist.
- **Beside it.** Credential registration, log redaction and prune hygiene run in parallel in other files. Human actions at the gate needs an owner decision first.

**Phase 3, the broker and the watcher** (the owner's "credential guard" and "vault"). Needs owner decisions on labelling against holding, verified detection, and what "forks" means. The broker moves model keys out of the channel worker. The watcher reads a record of send-outs on the Records queue. The publisher moves pushes and pull requests out of agent shells.

**Phase 4, the hosted target.** Wait for it. A VM per coding session, outbound Worker allowlists with credential injection, and Secrets Store bindings only on the outbound Worker. Nothing here is useful locally before then.

## Keeping feature work moving

- **Watch before enforcing.** The sandbox's network rules and the `.git/config` protection start in watch mode, logging what would be refused. Enforcement follows the log, by owner decision. This matches the owner's "never block the workflow".
- **Refusing when no sandbox is available.** On macOS a missing sandbox should refuse the command with one fix line. On Linux, where there is no Seatbelt, run unsandboxed and say so in the chat until a Linux sandbox lands. The owner decides this.
- **File ownership.** The coding-session tickets own a new Neuve module plus the one-line seam in `channel.ts` and `worker.ts`. That is disjoint from the review desk milestone (`apps/neuve-web`) and from the review harness. Remote images touches the desk's `framing.ts`, so coordinate it with the desk's development lane. Records worker environment and the replay archive collide with the background scan's lane until it lands.
- **Ace upstream.** Edits to Ace-owned files (`channel.ts`, `gateway.ts`, `log.ts`) are listed in the host's upstream record and kept to one seam each, so upstream updates still merge. The `agent@` fix is worth reporting to Ace.
- **Not affected.** Final review, which runs no shell. Neuve Graph, which runs from the Records worker. Modal replays, which run review only and use the release build.

## Tickets

Twenty-one tickets: seven in phase 1, nine in phase 2, four in phase 3 and one in phase 4. Duplicates across the studies were merged: Layer 1 of the sandboxing study and the "pass the child environment explicitly" pattern became **Pinned Git** and **Records worker environment**; the guard's first step and the canary became **Credential registration**; the git proxy, the Copilot-style push and the publisher became **Lane push credential** and **Agent proposes, Neuve publishes**.

### Phase 1

**Pinned Git: Neuve never runs repository-configured programs**
- **Scope.** In: every `git` the harness and Records worker run gets the stack store's pins (hooks path, fsmonitor, credential helper, protocol), plus `--no-ext-diff` and `--no-textconv`; the no-autoload flags in the evaluation build. Out: the channel's own Git, which runs Ace's code; agent shells.
- **Concern.** A planted program runs with the Records worker's model keys.
- **First step.** Move the pins from `stack/transport.ts` into one shared helper and use it at `git.ts:31`.
- **Proof.** A test with a planted fsmonitor marker; the run log's git commands; a live review on a repository with the plant.
- **Depends on.** Nothing. **Owner decision.** No.

**Records worker environment**
- **Scope.** In: the Records worker starts with an allowlist (path, home, locale, temporary folder, storage variables, the model-route key names, the lease variables, Graph's variables), and its children get explicit environments. Out: the coding host's seal.
- **Concern.** The worker carries every credential and passes them on (`starter.ts` line 104), against the decision that credentials go only to the call that needs them.
- **First step.** List what the worker's children read today, from code, then write the allowlist.
- **Proof.** Dummy-variable test; a Modal replay smoke case; worker log.
- **Depends on.** The background scan landing. **Owner decision.** No.

**Peer access to the owner's agents**
- **Scope.** In: the gateway refuses a peer whose verified login passes the agent prefix test; a ruling on whether old channels with no settings stay shared. Out: Ace's cooperative project access (Ace's open issue 511), hosted channels.
- **Concern.** Teammates run commands as the owner on this Mac.
- **First step.** A test showing that a peer request with an `agent@` login passes the channel's agent-access gate today ([`room.ts`](../../../packages/channel/src/room.ts) line 52, `gateway.ts` lines 543 to 548).
- **Proof.** The test, then the refusal in the host log.
- **Depends on.** Nothing. **Owner decision.** Yes: whether peers may ask agents on this host at all before the sandbox lands, and the default for old channels.

**Settle the open security questions**
- **Scope.** In, answered by probe or code reading with dummy values only:
  - whether an agent shell can read `Bun.secrets` keychain items without a prompt;
  - whether a spooled actor registration can claim the human kind;
  - whether hosted team services are configured on this host, and whether `--loopback` stops them;
  - the mode of the tailnet certificate folder;
  - whether chat and desk Markdown loads remote images;
  - whether agent flows use `git push -u` or husky.

  Out: fixes.
- **Concern.** Later tickets rest on these premises.
- **First step.** The keychain probe with a dummy item.
- **Proof.** One short note per answer, with the command or line that settles it.
- **Depends on.** Nothing. **Owner decision.** No.

**Remote images and links in agent text**
- **Scope.** In: `img-src` limited to own origins, `data:`, `blob:` and GitHub's image hosts on the coding app and the review desk. Out: rewriting links before publication, which belongs to the publisher.
- **Concern.** A Markdown image URL carries data out when rendered.
- **First step.** Confirm in DevTools that a fixture chat loads an external image.
- **Proof.** DevTools MCP screenshot and console before and after; avatars still load.
- **Depends on.** The question spike's image answer. **Owner decision.** No.

**Replay archive behind the scan**
- **Scope.** In: the store archive carries only scanned captures, or is refused. Out: the research volume's own access rules.
- **Concern.** Unscanned raw captures and authority checkpoints leave the cloud (final security review, non-blocking item 2).
- **First step.** Read the mark in `archive_case` before packing.
- **Proof.** Archive run log, and a refused unscanned case.
- **Depends on.** The background scan landing. **Owner decision.** No.

**Runtime security record**
- **Scope.** In: one architecture record of the layers, what each closes and does not close, and the open holes, written as Ace writes its "not a security boundary" warnings; vocabulary entries only if the owner approves terms. Out: new product meaning.
- **Concern.** The boundary is unwritten, so lanes cannot tell what they may rely on.
- **First step.** Record the owner's phase 0 choices and the ownership finding on the LaCie volume.
- **Proof.** None needed for documentation.
- **Depends on.** Owner decisions as they come. **Owner decision.** Yes: whether "credential guard" and "vault" become terms.

### Phase 2

**Agent tools get their own execution environment**
- **Scope.** In: a Neuve wrapper handed to the harness at `channel.ts:265`; commands get no inherited environment, only an allowlist plus names the user lists for a project in user-level settings, in the way integrations list their variables. Out: the channel's own `changes` and `fetch`; file paths; OS sandbox.
- **Concern.** Credentials under names the seal misses (`SSH_AUTH_SOCK`, `AWS_ACCESS_KEY_ID`, URLs with passwords) reach every agent command.
- **First step.** The wrapper, delegating everything, with the environment override only.
- **Proof.** An agent's `env` in the app lacks a dummy variable (DevTools screenshot); host log; a wrapper test.
- **Depends on.** Nothing. **Owner decision.** Yes: the default allowlist, and whether `SSH_AUTH_SOCK` stays until the push credential lands.

**File-tool path rules**
- **Scope.** In: writes only in the lane, its temporary folder and named caches; reads refused for a deny list: Neuve's sign-in folder, the host home, the Records store and its socket fallback, LaCie captures and state, `~/.ssh`, `.env*` outside the lane. Paths are checked after resolving links. Out: commands, which the sandbox covers.
- **Concern.** pi's file tools run in the worker and reach any path.
- **First step.** The write rule, which breaks least.
- **Proof.** A refused read of a dummy file in a denied folder, in the chat and the host log; a test with a link pointing out of the lane.
- **Depends on.** Agent environment. **Owner decision.** Yes: deny-list reads (broad reads allowed) or allow-list reads.

**Command sandbox for coding sessions**
- **Scope.** In: Seatbelt around agent commands with the same deny list. Writes allowed in the lane, the Git common folder's objects, refs and worktree folders, temporary folders and caches. `hooks` and the Records store denied. `.git/config` writes logged. The host's own ports denied. Network watched, not limited. Out: egress enforcement; Linux.
- **Concern.** Dependency scripts and generated code read Neuve's sign-in, the owner token and the store, and can act as the human at the gate.
- **First step.** Choose between a profile of Neuve's own, after Graph's `clangd` step, and the sandbox runtime package; then deny the store and the sign-in folder only.
- **Proof.** In the app, `bun install` and `bun test` pass in a sample repository while reads of the store fail; host log; a profile test.
- **Depends on.** Agent environment, the question spike. **Owner decision.** Yes: a new beta dependency or Neuve's own profile; refuse or warn when no sandbox is available.

**Egress allowlist for coding sessions**
- **Scope.** In: all agent command traffic through one proxy; names that resolve to loopback or metadata addresses refused; a per-run log of refused hosts; enforcement after a watch period. Out: the worker's own model calls.
- **Concern.** Direct leaks from the shell, DNS included.
- **First step.** Run the proxy in watch mode and collect the refused hosts.
- **Proof.** The watch log; then a blocked fetch to an unlisted host, seen in the chat and log.
- **Depends on.** Command sandbox. **Owner decision.** Yes: which registries, and when to enforce.

**Lane push credential**
- **Scope.** In: a helper that gives agent shells a token for the lane's own remote only, kept outside the project; then `~/.config/gh` and `SSH_AUTH_SOCK` denied to agent shells. Out: who opens pull requests, which the publisher ticket owns.
- **Concern.** Agents hold the owner's push rights to every repository.
- **First step.** Port Ace's compute runner helper.
- **Proof.** A push to the lane's remote works and one to another remote is refused; log.
- **Depends on.** Agent environment. **Owner decision.** Yes: whether a GitHub App token fits "no credentials of Neuve's own", or the user's token is scoped by the helper.

**Credential registration**
- **Scope.** In: every value the seal holds, the GitHub token and one canary value registered with Capture's detectors; a minimum length. Out: new egress points.
- **Concern.** The scan knows only model-call header values.
- **First step.** Register sealed values at coding-worker setup.
- **Proof.** A fixture capture with a dummy registered value is refused at export; the scan's record.
- **Depends on.** The background scan landing. **Owner decision.** No.

**Known-value redaction in logs**
- **Scope.** In: host logs and the Records `worker.log` mask registered values before writing. Out: telemetry, which already allows only names and counts.
- **Concern.** Error fields are written as given.
- **First step.** Mask in `log.ts`'s writer.
- **Proof.** Test with a dummy value; a written line.
- **Depends on.** Credential registration. **Owner decision.** No.

**Raw bytes past the prune**
- **Scope.** In: `secure_delete` on the Records store and pruned migration backups. Out: the replay archive.
- **Concern.** Raw captures outlive their 30 days in free pages and backups.
- **First step.** Turn on `secure_delete` and measure delete time.
- **Proof.** A freed page holds no earlier bytes after a prune; the measurement.
- **Depends on.** Nothing. **Owner decision.** No.

**Human actions at the gate**
- **Scope.** In: a way for the desk and the human commands to tell the person from a local process, such as a per-launch secret held by the browser like the host's HttpOnly cookie. Out: authentication of people, which the no-auth decision rules out.
- **Concern.** A local agent can record a disposition as the human.
- **First step.** Show which paths a same-user process can use today, with a dummy store.
- **Proof.** A test and a DevTools capture of a refused forged request.
- **Depends on.** Command sandbox, which closes the coding-session case first. **Owner decision.** Yes: this touches the decision that Neuve has no auth code.

### Phase 3

**Credential broker for model routes**
- **Scope.** In: a local process that holds provider keys and the ChatGPT refresh, and injects them by destination; workers get placeholders and a local base URL; it refuses a request that carries a registered value. Out: Git, which the push credential covers.
- **Concern.** Channel workers hold real keys in memory and start with them in their environment.
- **First step.** Broker one route, the Anthropic key, behind pi-ai's credential lookup.
- **Proof.** Worker settings and environment hold placeholders; broker log; a live coding turn and a live review.
- **Depends on.** Credential registration. **Owner decision.** Yes: whether an inline refusal is acceptable under "never block the workflow".

**Record of send-outs and a background watcher**
- **Scope.** In: the broker and each publishing step append what left, where and its hash; a Records queue job runs pattern scans, watches the canary, and diffs lane remotes, hooks, `.git/config` and CI workflow files; a finding is recorded and revokes that run's short-lived tokens. Out: blocking the review.
- **Concern.** Leaks and tampering are not seen at all today.
- **First step.** The record and a job that does only exact-value checks.
- **Proof.** A planted canary gives a finding while the review completes; queue and log.
- **Depends on.** Credential broker, lane push credential. **Owner decision.** Yes: label or hold; whether verified detection may send a found key to its provider; what "forks" means.

**Agent proposes, Neuve publishes**
- **Scope.** In: pushes, pull requests and comments from agents become requests that Neuve applies with its own scoped credential, after one pre-publication check that labels reviewable outputs and holds only irreversible ones. Out: review publication, which already goes through Records.
- **Concern.** The agent's process tree holds both a credential and a way out.
- **First step.** Route `gh pr create` from agents through a host tool.
- **Proof.** A pull request opened by the publisher carries a caution label for a planted finding; log.
- **Depends on.** Lane push credential, the watcher. **Owner decision.** Yes: it changes the adopted Ace journey.

**Settings hold references, not values**
- **Scope.** In: credential-bearing settings fields (the telemetry collector headers first) become references read into `Redacted` through zod; one unwrap point, guarded by a check rule. Out: storing values; Records schemas until a field needs it.
- **Concern.** A value written in settings can reach logs or records.
- **First step.** The collector headers field.
- **Proof.** A test that encoding a record with a credential field fails.
- **Depends on.** Credential broker. **Owner decision.** Yes: the reference format, and whether `bun run check` may grow a rule.

### Phase 4

**Hosted coding sessions**
- **Scope.** In: one VM per coding session (Cloudflare Containers through the Sandbox SDK), outbound Worker allowlists with credential injection, Secrets Store bindings only on the outbound Worker, and Landlock inside as a second layer. Out: local work.
- **Concern.** Many users on shared infrastructure.
- **First step.** Wait for the hosted target.
- **Proof.** Deferred.
- **Depends on.** The hosted target. **Owner decision.** Yes, with the hosted direction.

## Open owner decisions, collected

- Whether teammates may drive agents on this host before the sandbox lands, and whether old channels stay shared.
- Whether "credential guard" and "vault" become vocabulary terms.
- The default environment allowlist, and whether reads outside the lane are allowed by default.
- A beta sandbox dependency or Neuve's own profile; refuse or warn when no sandbox is available.
- Which registries coding sessions may reach, and when egress is enforced.
- GitHub App token or the user's token behind a scoped helper.
- Whether the human gate gets a local secret, given the no-auth decision.
- Label or hold at publication; verified detection; the meaning of "forks".
