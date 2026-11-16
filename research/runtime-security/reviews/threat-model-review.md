# Threat-model review of the runtime security research

Independent adversarial review, 2 November 2026. It checks the four studies in this folder against the code, adds what they missed, ranks the risks for the owner's setup and proposes backlog tickets. It decides nothing. The studies are: [what Neuve does today](../01-neuve-today.md), [Ace and GitHub Next precedents](../02-ace-and-github-next.md), [sandboxing generated code](../03-sandboxing-generated-code.md) and [secrets and exfiltration](../04-secrets-and-exfiltration.md).

**How it was checked.** Code paths are relative to the rewrite in this repository (commit `de4a4832`), the working truth, unless marked. "review-c" is the background-scan lane in its external worktree (commit `9e81636d`), read only. Experiments used dummy variables and dummy files in `$TMPDIR` only. No credential file was opened. Credential reachability was checked by path and permission only. "Credential guard" and "vault" remain the owner's working words. They are not [vocabulary](../../../vocabulary.md) terms.

## Verdict

- **The studies are mostly accurate.** Three details are wrong. One finding is narrower than stated and one is wider. Every claim the owner asked about holds in substance.
- **Five things matter more than the studies say:**
  1. **Any tailnet device can forge project access with one HTTP request.** No modified host is needed.
  2. **Neuve's installed binary runs code that an environment variable names** (`BUN_OPTIONS`). The Records worker also takes its environment from whichever process wakes it. Together these let a coding agent put its own code into Neuve's process, and they would get around a sandbox added later.
  3. **The sandboxing study's first step wraps only `bash`.** pi's file tools run inside the channel worker, and nothing limits the paths they can reach.
  4. **Agent access in one channel gives control of the whole host.** Any local process gets the owner's authenticated host connection from the loopback app gateway.
  5. **The LaCie drive is mounted with ownership ignored.** The 0600 and 0700 modes the code checks protect nothing there.

## 1. Claims checked

| Claim | Result | Evidence |
| --- | --- | --- |
| A tailnet peer with project access can make a coding agent run `bash` on the owner's Mac when the channel's agent access is on | **Confirmed** from code. No live tailnet was probed | Peers are admitted on `tailscale whois` alone (`apps/neuve-host/src/gateway.ts:1123-1180`, `tailnet.ts:169-179`). The author is replaced with the Tailscale login (`gateway.ts:543-548`). Project check: `mayOpen` (`gateway.ts:232-235`). The gate `#mayInvoke` (`packages/channel/src/channel.ts:908-918`) guards `ask`, `select`, `answer`, `skip`, `stop` and `kill` (`channel.ts:450-512, 873, 903`). The bash tool sets `inheritEnv: true` (pi-durable `dist/tools/bash.js:35-41`) |
| A channel with no stored settings counts as on | **Confirmed, narrower in practice** | The gate is `settings?.shared !== false` (`channel.ts:912`), with `LEGACY` set to shared (`channel.ts:115, 300`). But a new store writes its settings at first open (`channel.ts:270-273`). Forks are new stores (`apps/neuve-host/src/manage.ts:95-136`). Untagged old channels are tagged local and never listed on the tailnet (`legacy-channels.ts:15-18`, `catalog.ts:311`). What remains exposed: stores with no settings that carry a tailnet tag, meaning channels from Ace's era and stores restored by a move. Whether any exist on the Mac: **unverified** |
| The directory's project-access check can be forged by a modified peer host | **Confirmed, and wider** | No modified host is needed. The tailnet listener sends any `/directory/` request without an `Origin` header to the directory after `whois` (`gateway.ts:1132`, `1186-1201`). A share `POST` checks only `by === caller.login` (`directory-server.ts:141-155`), and `shared()` never asks who filed a share (`access.ts:73-81`). Any untagged tailnet device can therefore grant itself access with one request. A second route: a peer's GitHub login is whatever it reports (`access.ts:47-51`), and that login decides direct access through GitHub (`access.ts:60-64`) |
| An `agent@` login skips the gate | **Confirmed in code**, not run | `isAgent` is a prefix test (`packages/channel/src/room.ts:51-53`). The host refuses `agent@` only as its own user (`host-config.ts:67`). Peer logins are not checked. Whether Tailscale would issue such a login on this tailnet: **unverified** |
| Under Bun 1.4.0, `Bun.spawn` without `env` passes variables deleted from `process.env` | **Confirmed, with a refinement** | Reproduced with a dummy variable. The variable leaks only if it was present when the process started. One set and deleted at run time does not leak. `node:child_process`, `Bun.$` and `env: { ...process.env }` never leak. The refined case is exactly the seal's: the channel worker starts with `workerEnv()` (`client.ts:25-30`, `keys.ts:33-35`) and seals afterwards |
| Which spawn sites in a sealed process are affected | **Low today** | Two processes seal: the host (`gateway.ts:1267, 1286`) and the channel worker (`worker.ts:32`). Their sites without `env` run fixed programs: `ps` and `lsof` (`health.ts:18, 36`, `terminals.ts:142`), `xcode-select` and `git --version` (`diagnostics.ts:20, 28`), a `git config` remote read (`github.ts:282`), the login shell (`environment.ts:41, 61`) and `open` (`cli.ts:606`). The harness sites the Ace study lists run in the Records worker and the CLI, which never seal. Their problem is the next row, not this one. **Refuted for `graph-search.ts:208`:** it passes `env` |
| The Records worker starts with the full `process.env` | **Confirmed, and worse** | `packages/records-core/src/starter.ts:97-104` uses `env: process.env` with the repository as `cwd`. Main has the same code (`packages/records-core/src/starter.ts:92` on main). The starter runs in whichever process wakes the worker, including `neuve hook` from git hooks and agent hooks (`apps/neuve-cli/src/capture/hook-cli.ts:36-48`). The worker therefore inherits its waker's environment, and that can be a coding agent's shell |
| Coding shells reach the SSH agent, gh and git sign-ins, the ChatGPT sign-in file and the host token | **Confirmed** by path, mode and code | The seal's pattern (`keys.ts:22`) lets through `SSH_AUTH_SOCK`, `AWS_ACCESS_KEY_ID`, `MODAL_TOKEN_ID`, `TS_AUTHKEY`, `GITHUB_PAT` and `NEUVE_OPENAI_TOKEN_COMMAND` (tested against the pattern). `SSH_AUTH_SOCK` is set in the user session. Present and readable by the owner's user: `~/.config/neuve/openai-auth.json`, `~/.config/neuve/label-codex-home/auth.json`, `~/.codex/auth.json`, `~/.config/gh/hosts.yml`, `~/.modal.toml` and `~/.ssh`. `~/.aws/sso/cache` is 0755. `ACE_HOME` is exported (`host-config.ts:115`). 465 `host.token` files sit under the external state folder, many in test and temporary homes. The file tools reach all of these as well: `resolvePath` accepts absolute and `~` paths (pi-durable `dist/env/node.js:25-42`). Whether `gh` reads its keychain item from an agent shell without a prompt: **unverified** (not run, because the check would print a token) |
| The Records store is writable from every lane worktree | **Confirmed** by layout and mode | The store is `<git common dir>/neuve` (`packages/records-core/src/location.ts:13-28`). Lanes are made with `git worktree add` on the project (`apps/neuve-host/src/fork-origin.ts:14`, `channel-create.ts:47-52`). review-c resolves its common directory to the canonical clone's `.git` directory, whose `neuve/records.sqlite` is 0600 and owned by the user. No write was attempted, because this review's own sandbox blocks writes to LaCie. In review-c the same folder also holds `capture-authorities` (`packages/harness/src/pi/capture/raw.ts:252`) and raw captures that have not been scanned |

**Other spot checks, all confirmed:**

- Main's `.env.local` is 0644.
- The Modal machines' network settings match the today study (`research/pr-bench/replay/modal/app.py:359-362, 420, 468, 620-622`, kept in the private archive).
- The evaluation build omits the no-autoload flags (`packages/evaluation/src/neuve-build.ts:31-41`, against `apps/neuve-cli/scripts/build.ts:36-37`).
- The review's diff is hardened with `--no-ext-diff --no-textconv` (`packages/harness/src/git-objects.ts:359-379`). That answers the today study's open question: no git command in the review path was found to run a program named in git config.
  - **One latent exception:** `fileDiff` (`packages/harness/src/git.ts:113-118`) omits `--no-ext-diff`. In a scratch repository, the same command ran a `diff.external` program. `fileDiff` has no caller today.

**Errors in the studies:**

- **Sandboxing study:** it says the coding shell "inherits the host's whole environment". The shell gets the sealed environment: credential-named variables are removed, and everything else passes.
- **Ace study:** it lists `graph-search.ts:208` among the spawn sites with no `env`. That site does pass `env`.
- **Secrets study:** it says agents push "with the host's GitHub token". The token is sealed out of shells (`keys.ts:37-41`). Agents push with the user's own gh and git sign-ins, which the seal never touches. The exposure is the same, but the fix is different.

## 2. What the studies missed

1. **Neuve's own binary runs code named by an environment variable.**
   - With `BUN_OPTIONS=--preload=<file>` set, the installed compiled `~/.local/bin/neuve --version` ran the preload file. The test used a dummy file in `$TMPDIR`. The release build's no-autoload flags do not cover this.
   - Git hooks call that binary with the committer's environment (main's `.git/hooks/post-commit`). The Records worker then inherits that environment (section 1).
   - So a coding agent, a package script or a repository's environment tool can run code inside Neuve's own process, which breaks the owner's second layer.
   - They can also set the worker's `PATH`, proxy and TLS settings while it holds route credentials and writes marks. Whether Bun's `fetch` honours `HTTPS_PROXY` and `NODE_TLS_REJECT_UNAUTHORIZED` here: **unverified**.
2. **A sandbox around `bash` leaves the file tools open.** pi's read, write and edit tools run inside the channel worker (pi-durable `dist/env/node.js:626-710`), and nothing limits their paths. The sandboxing study's first step wraps only the command runner.
3. **A sandboxed session can still act through Neuve's local services.**
   - **(a) The owner's host connection.** Any local process gets the owner's authenticated connection from the loopback app gateway by sending the expected `Host` and `Origin` headers (`app-gateway.ts:154-181`; the private token is attached upstream at line 214). That connection is the local owner, with terminals, credentials, moves and sharing (`gateway.ts:559-581`). Agent access in one channel therefore reaches the whole host and every project on it, and through the share operation, the owner's other channels.
   - **(b) A worker started inside the sandbox.** A hook inside a sandbox that finds no Records worker starts one inside that sandbox, with the agent's environment (`starter.ts:97-104`). That worker then serves every lane.
4. **Posting a message needs no agent access.** `say` has no gate (`channel.ts:820-845`). With project access, which can be forged, a peer can plant text in the owner's next run, and that run executes with the owner's tools. The Ace study names this path. It ranks first here because it needs no setting to be on.
5. **"The owner" is a Tailscale login, not a machine.** Any untagged device signed in as the owner gets the owner's rights (`gateway.ts:233-234`, `authored` at 543-548). A cloud or Modal machine joined to the tailnet under the owner's login would hold full owner rights on the Mac. Nodes shared in from other tailnets may also appear as untagged peers: **unverified**.
6. **A spooled event can make an approval look human.** The spool refuses only capture events (review-c `packages/records-core/src/ingest.ts:94-105`). `actor.registered@1` is projected with whatever actor kind it claims (`packages/records-core/src/projectors.ts:23-44`), and the rules for human-required approvals and feedback check only that kind (`rules.ts:102-109, 199-202`). Any process that can write the spool can register a human and approve a human-required unit. The [identity-without-auth record](../../../architecture/decisions/0009-identity-without-auth.md) calls identity "for attribution, not access control". This finding crosses the human gate that the human-required lane depends on. From code reading; not run.
7. **Data at rest on LaCie.**
   - the external LaCie volume is mounted `noowners` (shown by `mount`), so file modes do not bind an owner there. Any account, or any machine the drive is plugged into, can read everything on it.
   - It holds raw captures that were never scanned, authority checkpoints, `store.tar` archives and the 465 host tokens.
   - Whether the volume is encrypted: **unverified** (`diskutil` is unavailable to this review).
8. **A forged mark becomes an export.** Anyone who can write `records.sqlite` can append a clean mark, which the scan's final security review accepts by design. Export, the shareable copy and the scorer then trust that mark. Reaching the store is therefore a path into datasets, not only an integrity problem.
9. **Images in model-written text on the review desk.** Images in block markdown keep their `src` (`packages/ui/src/components/blocks/parse.ts:529-545`). No content security policy limits `img-src` or `connect-src` (`app-gateway.ts:21`, `gateway.ts:1051`). Whether the desk loads such images live: **unverified**. If it does, model-written text sends data to any host as soon as the owner opens it.
10. **Writes that outlive the session.** None of the studies names these places, which a session can write and which run later as Neuve or as the owner. The sandbox must deny writes to them:
    - `~/.local/bin/neuve`;
    - `~/Library/LaunchAgents/dev.neuve.worker.plist` (`packages/records-core/src/launchd.ts:12-13`);
    - shell startup files;
    - the shared `.git/hooks` and `.git/config`.
11. **Teammates' text ends up in the owner's records.** Runs that peers start land in the owner's channel stores. Where they are captured, they also reach Records and datasets. None of the studies covers consent or retention for other people's text. Whether runs started by peers are captured: **unverified**.

## 3. Risks, ranked for the owner's setup

The setup: one owner's Mac on a team tailnet, run data on LaCie, replays on Modal, and a hosted Cloudflare target not yet built.

| Rank | Risk | Likelihood | Impact | Urgent |
| --- | --- | --- | --- | --- |
| 1 | **A peer reaches the owner's shell.** Project access can be forged in one request. `say` plants text in the owner's runs. Agent access, settings-less channels and `agent@` logins open `ask`. One channel's agent access then reaches the whole host | Low to medium. It needs a teammate who acts against the owner, or a compromised teammate device. The host joins the tailnet by default under the [tailnet-default decision](../../../process/decisions.md) | Critical: commands as the owner, every credential, all of LaCie | **Yes.** It is reachable over the network by default, the forgery is trivial, and an interim option exists (`--loopback`) |
| 2 | **Coding agents and dependency scripts read every credential and the store**, through shells and file tools | Medium to high. Agents read untrusted content, and package installs run scripts | High | **Yes, for the cheap part**: an environment allowlist and path limits on file tools. The sandbox comes next |
| 3 | **The environment gets code into Neuve's process.** `BUN_OPTIONS` is honoured, and the Records worker inherits its waker's environment | Medium. It needs an agent or a script to set the variable. The worker then keeps it for its whole life | High. It breaks layer 2, and it would get around the sandbox | **Yes.** The fix is small, and it must land before the sandbox does |
| 4 | **Run data at rest on a removable drive with ownership ignored** | Low to medium | High if the drive is unencrypted | **Check now** (one owner action). Fix later |
| 5 | **The human gate can be passed through the spool** | Low | Medium to high: false approvals | No. Owner decision |
| 6 | **Text and logs leave unguarded**: pushes, pull-request bodies, desk images, host logs, `worker.log`, telemetry headers | Medium | Medium | No. The CSP fix is cheap |
| 7 | **The hosted target inherits Ace's team-secret authorship**: anyone with the secret can post as anyone | Not built | High once built | No, but it must be closed before anything is deployed |
| 8 | **Spawn and git hygiene**: the Bun seal leak, the unpinned harness `git`, the evaluation build's flags | Low | Low | No |
| 9 | **Modal replays**: machines hold the lease secret, and DNS stays open. Review machines run no repository code | Low | Medium | No |

## 4. Proposed tickets

Each ticket is kept as narrow as it can be. They go to Linear through the Linear upkeep chat.

1. **Decide the tailnet default until peer access holds** (urgent)
   - **In:** whether `bun workspace` keeps joining the tailnet by default, or defaults to `--loopback` until ticket 2 lands.
   - **Out:** code.
   - **Concern:** risk 1.
   - **First step:** the owner's ruling. Meanwhile the owner can start the workspace with `--loopback`.
   - **Depends on:** nothing.
   - **Owner decision:** yes.
2. **Make peer project access and agent access hold against teammates**
   - **In:**
     - The directory refuses a share unless its filer has direct access, and `shared()` ignores shares filed by anyone else.
     - The gateway refuses peer logins that begin with `agent@`.
     - A tailnet-tagged channel with no settings counts as unshared.
     - Agent access, or a separate setting, governs whether peers may use `say`.
     - Self-reported GitHub logins are written down as a known limit.
   - **Out:** cryptographic peer identity ([Ace issue 511](https://github.com/githubnext/ace/issues/511), on making project access hold against a tampering teammate) and the hosted services.
   - **Concern:** section 1, the forgery and gate rows.
   - **First step:** in `access.ts`, count a share only when `isDirect(share.by, project)`. Refuse `agent@` in `team()` after `whois`.
   - **Depends on:** nothing.
   - **Owner decision:** only for `say` and for the settings-less default.
3. **Coding shells start from an allowlisted environment** (urgent)
   - **In:**
     - The worker's `env(cwd)` (`worker.ts:97-101`), or the bash tool's `prepare` hook, sets `inheritEnv: false` with an allowlist: `PATH`, `HOME`, `TMPDIR`, locale, `TERM` and the lane's own variables.
     - `SSH_AUTH_SOCK`, `ACE_*`, `NEUVE_*`, proxy variables, `BUN_OPTIONS` and `NODE_OPTIONS` are dropped.
     - A test proves that a dummy credential-named variable and a dummy variable with an ordinary name both stay out.
   - **Out:** filesystem limits (ticket 4) and push credentials (ticket 6).
   - **Concern:** risk 2. The seal matches by name only.
   - **First step:** the allowlist in the `worker.ts` environment factory.
   - **Depends on:** nothing. But `lane push` from agents then needs ticket 6, or a stated interim.
   - **Owner decision:** how agents push in the meantime.
4. **Sandbox coding sessions, file tools included**
   - **In:**
     - Seatbelt, through the sandbox runtime, around every command.
     - Path limits on read, write and edit, or those tools moved into the sandboxed executor.
     - Reads denied: sign-in files, `~/.ssh`, `~/.aws`, `~/.config/gh`, `~/.modal.toml`, `~/.codex`, `ACE_HOME`, every Records store and the LaCie run data.
     - Writes denied: the shared `.git/config` and `.git/hooks`, `~/.local/bin`, `~/Library/LaunchAgents` and shell startup files.
     - Loopback ports and Unix sockets denied unless allowed.
     - Egress only through the proxy.
     - Refuse to run when the sandbox cannot start.
     - Workers are started only by the host or launchd, never from inside a session.
   - **Out:** local VMs and hosted mode.
   - **Concern:** risks 2 and 3, and section 2, items 2, 3 and 10.
   - **First step:** wrap `NodeExecutionEnv` for one channel behind a setting, and prove that a sandboxed command cannot read a dummy file placed at each denied path.
   - **Depends on:** tickets 3 and 5.
   - **Owner decision:** the egress allowlist and the refuse-when-unavailable default.
5. **Neuve's processes take no environment from their callers** (urgent)
   - **In:**
     - The Records starter gives the worker an allowlisted environment. The worker reads route credentials itself, at call time, as the [no-credentials decision](../../../process/decisions.md) requires: credentials are passed only to the call that needs them.
     - Installed git hooks and agent hook commands call `neuve` through `env -i` with that allowlist.
     - The encoders (`packages/semantic-client/src/index.ts:807-812`) also get an allowlist.
     - The evaluation build gets the no-autoload flags.
   - **Out:** the credential broker.
   - **Concern:** section 2, item 1, and the Records worker row in section 1.
   - **First step:** the hook template (`apps/neuve-cli/src/capture/setup-hooks.ts:197-215`) prefixes `/usr/bin/env -i` with a fixed `PATH` and `HOME`, and `starter.ts:104` passes the allowlist.
   - **Depends on:** nothing.
   - **Owner decision:** no.
6. **Pushes use a scoped git credential**
   - **In:** `lane push` and `gh pr create` from lanes go through a helper or proxy that answers only for the lane's remote and branch. The session can reach no gh or git sign-in.
   - **Out:** scanning by the guard.
   - **Concern:** section 1, the reachability row, and the secrets study's git channel.
   - **First step:** Ace's compute-runner credential helper (`services/compute/runner.ts:109-130` in Ace), limited to one repository.
   - **Depends on:** ticket 3.
   - **Owner decision:** a GitHub App, or the user's own sign-in, under the no-credentials decision.
7. **Keep agents out of the Records store and off the human gate**
   - **In:**
     - The sandbox denies every store (from ticket 4).
     - The spool refuses an `actor.registered@1` that claims the human kind. Humans register only through the human commands.
     - The planned audit flags marks the scan job did not write.
   - **Out:** cryptographic marks.
   - **Concern:** section 1, the store row, and section 2, items 6 and 8.
   - **First step:** the refusal in `ingest.ts`, beside the existing refusal of capture events.
   - **Depends on:** ticket 4 for the store. The refusal stands alone.
   - **Owner decision:** yes, against the identity-without-auth record.
8. **Run data at rest**
   - **In:**
     - Confirm whether the LaCie volume is encrypted, and move the data to an encrypted volume if it is not.
     - Prune stale host homes and their tokens under the external state folder.
     - Leave raw captures and authority checkpoints out of `store.tar`, or put the archive behind the mark gate.
     - Use `secure_delete` or a vacuum when captures are pruned.
     - Run `chmod 600` on main's `.env.local`.
   - **Out:** hosted storage.
   - **Concern:** section 2, item 7, and the archive item in the scan's final security review.
   - **First step:** the owner checks encryption once.
   - **Depends on:** nothing.
   - **Owner decision:** yes: the drive, and what the archive keeps.
9. **Hygiene for logs, telemetry and rendered text**
   - **In:**
     - A content security policy of `img-src 'self' data: blob:` and `connect-src 'self'` on the app gateway and the desk.
     - Links to external images in model text made inert.
     - OTLP headers stored as references, not values.
     - Error fields in the host's `log.ts` passed through the private log's allowlist.
     - Redaction for `worker.log`.
   - **Out:** the guard service.
   - **Concern:** risk 6, and section 2, item 9.
   - **First step:** the CSP header.
   - **Depends on:** nothing.
   - **Owner decision:** no.
10. **Credential guard: a record of send-outs, and a background watcher**
    - **In:** the owner's first layer, as the secrets study proposes it: sealed values and a canary registered, checks on pushes and exports, and warnings by default.
    - **Out:** pattern scans inline on the path out.
    - **Concern:** the gaps in the first layer.
    - **First step:** register one canary with the existing detectors, once sessions can no longer read the authority checkpoints (ticket 4).
    - **Depends on:** tickets 4, 6 and 9.
    - **Owner decision:** yes: the vocabulary terms, warning or holding, verified detection, and what "forks" means.
11. **Spawn and git hygiene**
    - **In:**
      - A check that refuses `Bun.spawn` or `Bun.spawnSync` without `env` in the host and the channel worker.
      - `core.fsmonitor=false`, `core.hooksPath=/dev/null` and `--no-ext-diff` pinned in the harness's `git.ts`.
      - The unused `fileDiff` deleted.
    - **Out:** Graph, whose git reads are already pinned.
    - **Concern:** risk 8.
    - **First step:** delete `fileDiff` and add the pins to `gitMeasured`.
    - **Depends on:** nothing.
    - **Owner decision:** only whether `bun run check` may grow a new rule.
12. **A precondition for the hosted target**
    - **In:**
      - An architecture record entry: hosted channels never accept an author claimed by someone who holds the team secret.
      - Hosted coding runs use one VM per session, with credentials injected on the way out.
    - **Out:** building any of it.
    - **Concern:** risk 7. Ace's architecture says holders of the team secret can post in any hosted channel as any author.
    - **First step:** the record entry.
    - **Depends on:** nothing.
    - **Owner decision:** yes.

## Open points

- Whether any tailnet-tagged channel without settings exists on the owner's Mac.
- Whether Tailscale on this tailnet would issue an `agent@` login, and whether nodes shared in from other tailnets reach the host.
- Whether the LaCie volume is encrypted.
- Whether the desk loads external images from model text.
- Whether runs that peers start are captured into Records.
