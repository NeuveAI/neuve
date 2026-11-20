# A Codex runtime behind the runtime contract: proposal

Status: proposal, drafted 20 November 2026. Nothing here is built. The owner, shown that a build lane had started a Codex implementer from the program inside the ChatGPT desktop app, by a path written into the code: "wat??? I thought we used the official cdp or codex server. Observe how t3 code uses codex and lets create our abstraction on a similar fashion...this is not the way to go". Earlier the same day, on model selection ([decision 14.61](../decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026)): "a user might use codex or claude code, or both for all we care. We should identify and use available models and vendors". Then, on this work: "consider that also part of the pre-work". It is pre-work for the planning mode build: the lane building the [planning mode proposal](planning-mode.md)'s plan mode is held until its implementer can be a Codex session that runs through this runtime. That hold is the coordinating session's, on the owner's word above; the planning mode proposal itself lists no such dependency. The [decisions record](../decisions.md) wins wherever this text differs from it. The Linear ticket is [NEU-425](https://linear.app/neuve/issue/NEU-425).

**Words.** These are the implementation words of the [runtime and accounts proposal](claude-subscription-route.md), not product vocabulary: a _runtime_ is the program that runs an agent's loop, an _account_ is one sign-in or key, a _provider session_ is one running runtime process serving one session on one account. _Codex_ is OpenAI's open-source coding agent, the `codex` program. Its _app server_ is the mode of that program (`codex app-server`) that other programs drive.

**What was read.** Neuve at `cd4b5c6`. T3 Code's public source ([pingdotgg/t3code](https://github.com/pingdotgg/t3code), MIT) at commit `898c22f9900b90f81daece0895b7e4f4198355f8` of 20 November 2026; every T3 Code path below is in that commit. OpenAI's Codex documentation as served on 20 November 2026 and Codex's source at tag `rust-v0.171.0`, the release of that day. No Codex program was run for this proposal, so every statement about Codex's behaviour is from documentation or from another project's source, and [Not verified](#not-verified) lists what a run must still establish.

## At a glance

```
 TODAY                                             PROPOSED
 ─────                                             ────────
 review stages ─▶ Neuve's own loop (pi)            review stages ─▶ unchanged: Neuve's own loop,
                  on Neuve's ChatGPT sign-in                        the only path that replays exactly

 Ace's chats   ─▶ pi's built-in providers,         Ace's chats   ─┐
                  one of them a ChatGPT route                     ├▶ the runtime contract ─▶ Codex runtime
                  pi itself marks legacy           build lanes   ─┘   (beside Claude Code)       │
                                                                                                 ▼
 build lanes,  ─▶ the Codex program inside the                        the user's own Codex program, found and
 labelling,       ChatGPT app, by a path written                      verified, run as its app server, on
 replay           into the code, run as a script                      Neuve's ChatGPT sign-in, with Neuve's
                                                                      tools as its only tools

                                                   replay judge  ─▶ stays a pinned, tool-less Codex run,
                                                                    with no path written into the code
```

## The owner's question: which server is the official one

| Interface | What it is | Status, in OpenAI's words or source |
| --- | --- | --- |
| **Codex app server** (`codex app-server`) | A long-lived process a client drives with requests and notifications: threads, turns, streamed items, approvals, models, account | The interface OpenAI builds its own rich clients on. Its documentation opens by naming the VS Code extension, and other pages name the desktop app and the Python SDK ([app server documentation](https://learn.chatgpt.com/docs/app-server)). This is "the Codex server" |
| `codex exec` | One non-interactive run that prints events as lines of JSON | Supported for scripts and CI ([non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)). The TypeScript SDK wraps it ([`exec.ts`](https://github.com/openai/codex/blob/rust-v0.171.0/sdk/typescript/src/exec.ts)). This is what Neuve scripts today |
| Agent Client Protocol (ACP) | Zed's editor-to-agent protocol | Codex does not speak it. An adapter outside OpenAI ([agentclientprotocol/codex-acp](https://github.com/agentclientprotocol/codex-acp)) starts the app server and translates. No OpenAI statement of support was found |
| Codex as an MCP server | An older way to call Codex as a tool | Removed ([its page](https://learn.chatgpt.com/docs/mcp-server) says so) |
| "CDP" | | Codex has no server or protocol of that name. In its documentation, and in one of its feature names (`browser_use_full_cdp_access`), the letters mean Chrome's DevTools protocol. Neuve's own early rulings named "ACP connected to Codex" as the route for Sol ([decisions 2.9 and 2.12](../decisions.md#area-2-harness-pipeline-16-october-2026)) and "the Codex server" for labelling ([9.15](../decisions.md#area-9-benchmark-m4-17-october-2026)), and the [architecture overview](../../architecture/README.md) still says ACP connects Neuve to Codex. This proposal reads the owner's "cdp" as ACP. That is an inference; either way the answer is the app server, which is also what the ACP adapter drives underneath |

**How stable the app server is said to be.** OpenAI's own texts disagree, and the design is built for the cautious reading:

- Its documentation describes a "stable API surface" when a client does not opt in to experimental methods, and says the generated type definitions match the version of the program that produced them.
- The command reference says the app server "may change without notice" ([developer commands](https://learn.chatgpt.com/docs/developer-commands)), and the program's help marks the command experimental ([`main.rs`](https://github.com/openai/codex/blob/rust-v0.171.0/codex-rs/cli/src/main.rs)).
- No written compatibility policy and no protocol version in the handshake were found.

**What OpenAI says about sign-in.** The app server's own account section says: "App-server authentication has never been permitted for commercial or hosted services", that a local or open-source application "can continue using it", and that OpenAI recommends moving to Sign in with ChatGPT. OpenAI then documents exactly that combination: the application signs the person in, and starts the app server pointed at the public API with the application's own token ([Sign in with ChatGPT: Codex app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)). Neuve already has that sign-in ([`openai-auth.ts`](../../packages/harness/src/openai-auth.ts)), so the design uses it.

## What is there today

Three unrelated ways reach OpenAI's models. File and line citations were checked at `cd4b5c6`.

| Path | What it does | What is wrong with it, from first principles |
| --- | --- | --- |
| **Review stages: Neuve's own loop on Neuve's sign-in** | pi runs the loop and calls `https://api.openai.com/v1` with a token from Neuve's "Sign in with ChatGPT" ([`openai-auth.ts`](../../packages/harness/src/openai-auth.ts), lines 28–55; [`openai-route.ts`](../../packages/harness/src/openai-route.ts); [`pi/providers`](../../packages/harness/src/pi/providers/)). The account is `chatgpt`, kind `chatgpt-subscription`, runtime `pi` ([`defaults.ts`](../../packages/runtime/src/defaults.ts)) | Nothing. It is the supported sign-in, it keeps exact capture and Neuve's retry rules, and it runs no outside program. It is not a Codex path and stays |
| **Ace's chats: pi's built-in providers** | The host hands pi its whole built-in catalogue ([`keys.ts`](../../apps/neuve-host/src/keys.ts), `catalog`, lines 216–235). That catalogue includes a provider pi names "OpenAI Codex (legacy)", which calls `https://chatgpt.com/backend-api` under Codex's own client identity (`@earendil-works/pi-ai` 1.0.0, `dist/providers/openai-codex.js`, `dist/auth/oauth/openai-codex.js` line 17). The channel's built-in lists name its models ([`captions.ts`](../../packages/channel/src/captions.ts), lines 32–49) | It imitates Codex to reach ChatGPT's own backend, which is the route [decision 10.85](../decisions.md#area-10-harness-m3-18-october-2026) called "unsupported and may change" and kept only as a fallback that was never needed. It is a second sign-in for one vendor that no part of Neuve manages. Whether a person can actually sign in to it from Ace was not established |
| **Labelling, replay, and the build lane: the Codex program as a script** | Labelling and the replay judge run `codex exec` and parse its lines ([`labelling/routes.ts`](../../packages/evaluation/src/retrieval-bench/labelling/routes.ts), lines 38–40 and 103–150; [`pr-replay/codex.ts`](../../packages/evaluation/src/pr-replay/codex.ts), lines 101–103). The program is `NEUVE_CODEX_BINARY`, or else `/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`. On 20 November a build lane used the same path by hand | **The path.** It names one vendor's desktop app on one operating system, the app replaces the program in place, and nothing checks what is run; the source comment itself records that the `codex` on the `PATH` is an unrelated package. **Scripting.** A one-shot run has no approvals, no steering, no model list and no account state, and, by the lane's run log, it loaded the owner's personal Codex hooks and skills. **Three paths.** None of them is behind the [runtime contract](../../architecture/decisions/0017-runtime-contract-and-accounts.md), so Ace's model list, accounts and build lanes cannot see Codex as they see Claude Code |

Two more facts shape the design:

- **Claude Code is found the same weak way.** The Claude runtime takes whatever `claude` is first on the `PATH` ([`production.ts`](../../packages/runtime-claude/src/production.ts), line 46). The fix belongs to both runtimes.
- **The chat bridge is almost runtime-neutral.** It reads capabilities and events only ([`bridge.ts`](../../packages/harness/src/chat-runtime/bridge.ts)). Three places assume Claude Code: a model's context window falls back to pi's `anthropic` catalogue ([`models.ts`](../../packages/harness/src/chat-runtime/models.ts), lines 85–87); the bridge forks at a point inside a turn (`bridge.ts`, lines 503–510 and 961–988); and the stage route check reads "runs its own loop" as "is the `claude` provider" ([`route.ts`](../../packages/harness/src/route.ts), lines 154–158).

## How T3 Code does it

All from its source at the commit above; `Adapter` is `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts` and `Provider` is `apps/server/src/provider/CodexProvider.ts`.

| Question | What T3 Code does | Where |
| --- | --- | --- |
| Which protocol | The app server, over the child's standard input and output, one JSON message per line, with no `jsonrpc` field. No WebSocket, no ACP for Codex (it has an ACP client, used for other agents) | `packages/effect-codex-app-server/src/protocol.ts`, lines 107–111 and 557–574; `packages/effect-acp` |
| Types | Generated from OpenAI's published schema at a pinned Codex commit and checked in. A few fields the schema omits are added by hand, and a notification that fails to decode is dropped with a warning | `packages/effect-codex-app-server/scripts/generate.ts`, lines 16–19; `src/client.ts`, lines 89–98 and 157–178 |
| Finding Codex | A setting, default `codex`, resolved by the operating system through the `PATH`. In its "managed" mode it prefers a local `codex` and otherwise downloads a pinned release | `packages/contracts/src/settings.ts`, lines 716–722; `apps/server/src/provider/CodexInstallation.ts`, lines 68–110 and 470–520 |
| Verifying it | For a program the user installed: only that it works. It runs `codex --version`, requires the output to look like `codex-cli 1.2.3`, runs `codex app-server --help`, and checks the version against a compatibility table kept as data. No signature, hash or ownership check. A release it downloads itself is checked against a SHA-256 written in its source | `CodexInstallation.ts`, lines 473–513 and 689–694; `apps/server/src/provider/model-manifest.json`, lines 5–14 |
| When it is missing | The provider's status says the program could not be started and names the setting. When the setting is the default, it adds that installing ChatGPT or Codex desktop "may not add codex to PATH" | `Provider`, lines 1097–1102 |
| Starting it | `codex app-server -c thread_unload_delay_secs=0` plus the user's own arguments. One shared process per configured account serves all of that account's threads | `apps/server/src/provider/codexLaunchArgs.ts`, lines 16–21; `Adapter`, lines 265 and 1655–1657 |
| Handshake | `initialize` with the client's name and version, then `initialized`, with a 30-second limit. It opts in to the experimental surface | `Adapter`, lines 257–261 and 2047–2093 |
| Sign-in | Two modes. Existing: the person runs `codex login`; T3 Code only reads `account/read`, and watches the sign-in file for changes. Managed: T3 Code runs OpenAI's "Sign in with ChatGPT" itself, keeps the tokens, and points Codex at the public API with a token command that calls back into T3 Code | `Provider`, lines 759–760 and 1003–1005; `apps/server/src/provider/Drivers/CodexDriver.ts`, lines 406–415; `apps/server/src/provider/CodexManagedRuntime.ts`, lines 22–32 and 84–93 |
| Models and effort | Read from Codex (`model/list`), with each model's supported effort levels and default. On top of that it writes display labels, one forced default effort for one model family, and a manifest of models that need a newer Codex | `Provider`, lines 252–297 and 518–534; `model-manifest.json` |
| Threads and turns | T3 Code's ids are derived from Codex's thread, turn and item ids. Its transcript is its own record of the live stream: it asks Codex for a thread's turns but builds no messages from them | `packages/provider-core/src/server/IdAllocator.ts`, lines 235–316; `Adapter`, lines 8894–8915 |
| Streaming | Codex's notifications are translated into T3 Code's own events, one or several each; text deltas are batched | `packages/provider-core/src/server/ProviderAdapter.ts`, lines 83–208; `Adapter`, lines 4900–5060 |
| Approvals | Each of its four permission modes sets Codex's approval policy and sandbox on every turn. An approval request from Codex is shown to the person and answered when they decide | `Adapter`, lines 746–794 and 5924–5993 |
| Its own tools | Served to Codex as an MCP server over HTTP on the local machine, with a per-thread bearer token, named in the thread's configuration. Codex keeps its own tools as well. The experimental "dynamic tools" channel is not used | `Adapter`, lines 1543–1581; `packages/provider-core/src/server/mcpSession.ts`, lines 10–23 |
| Cancel, resume, crash | `turn/interrupt`, then up to 10 seconds for the turn to end. `thread/resume` by the stored thread id. When the process dies, pending requests fail, the session is released, and the next turn starts a fresh process and resumes the thread; there is no reconnect | `Adapter`, lines 2123–2136, 8060–8075 and 8744–8786 |
| Logs | Decoded protocol messages, without streamed deltas and with secrets removed, written per thread | `Adapter`, lines 1726–1789; `apps/server/src/provider/EventNdjsonLogger.ts`, lines 54–64 |
| One interface for many agents | A driver per agent program builds one instance per configured account. Each instance exposes the same session contract (open, start, steer and interrupt a turn, answer a request, one event stream) and a static capability record. Its documentation asks callers to branch on capabilities; its code still compares the driver's name to `codex` in places | `packages/provider-core/src/server/driver.ts`, lines 41–128; `ProviderAdapter.ts`, lines 700–836; `docs/internals/providers.md` |

Neuve already adopted that last row: its runtime contract was modelled on T3 Code's ([runtime and accounts proposal](claude-subscription-route.md#1-what-t3code-and-ace-do)). So "our abstraction on a similar fashion" is a second runtime behind the contract Neuve has, not a new abstraction.

**Licence.** T3 Code is MIT. This design borrows its structure and no code. The protocol types would be generated from OpenAI's schema, which is Apache-2.0; the slice that checks them in adds the notice to [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md).

**Where Neuve deliberately differs from T3 Code.**

| T3 Code | Neuve | Why |
| --- | --- | --- |
| Runs whatever `codex` resolves to | Verifies the program before running it | The owner's machine has an unrelated `codex` first on the `PATH`. See [Finding and trusting the program](#finding-and-trusting-the-program) |
| Can download and install Codex | Never installs or updates it | Neuve runs the person's own program, as it does for Claude Code |
| Codex keeps its shell, file editing and web search, behind its own approvals and sandbox | Codex's own tools are off; Neuve's tools are the only tools | Plan mode's read-only rule and the sandbox ruling are enforced inside Neuve's tools. See [Tools](#tools-neuves-are-the-only-ones) |
| One shared process per account | One process per session | The contract ties a session's processes to the caller's scope, and a crash then costs one session |
| Opts in to the experimental surface | Stays on the stable surface unless a named need forces otherwise | The stability statements above |

## The design

A new package, `packages/runtime-codex`, registers a third runtime beside pi and Claude Code. It starts the person's own Codex program as its app server, one process per session, and speaks the app server's protocol to it over the process's standard input and output. Callers do what they do today: name an account and read capabilities.

### Accounts and sign-in

- **No new sign-in and no new credential store.** A default account `codex` is added: kind `chatgpt-subscription`, runtime `codex`, on the same Neuve sign-in the `chatgpt` account uses. One sign-in then serves review stages on pi and chats on Codex, and its single refresher is untouched. The account schema already has this shape for an Anthropic key, which may run on pi or on Claude Code ([`account.ts`](../../packages/runtime/src/account.ts)). Only a `chatgpt-subscription` account may name the Codex runtime; an Anthropic key may not, and an OpenAI API key on Codex is left for later.
- **How Codex gets the token: OpenAI's documented form.** The runtime reads a current access token in its own process, from the same module the pi route uses ([`openai-auth.ts`](../../packages/harness/src/openai-auth.ts), `accessToken`), and starts Codex with a model provider that points at `https://api.openai.com/v1` and reads its bearer token from one environment variable. That is exactly what [OpenAI's guide](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) shows. The token lasts an hour. When it is near expiry at the start of a turn, the runtime stops the process, starts a new one on a fresh token and resumes the thread, which the guide also prescribes. A turn that outlives its token fails as reusable and the next turn restarts the same way. So that a turn rarely starts on a short token, the process is restarted whenever less than most of the hour remains. A single turn longer than the token's hour still fails, and a build lane's implementer can run that long: that is this form's cost.
- **Not chosen: a token command.** Codex can instead run a command each time it wants a token, and T3 Code's managed mode does that. It would avoid the restart and the hour's limit on one turn. It is not chosen for the first build because it needs a new Neuve command that prints a bare token (`neuve auth lease` prints JSON, accepts only the name `openai`, and can take longer than Codex's five-second default), and because Codex would have to be told where Neuve's own program is. It is the fix if hour-long turns prove common, and the protocol slice records whether they would be.
- **Codex's own sign-in is not read, written or used.** The process gets a folder Neuve owns, under Neuve's application-support folder and owner-only, as both its Codex home and its home folder. Codex finds a person's skills through the home folder, so a clean Codex home alone is not enough, which [labelling already found](../../packages/evaluation/src/retrieval-bench/labelling/routes.ts) (lines 143–148). The folder holds Codex's thread files and nothing else: no sign-in, no hooks, no skills, no configuration, and no project marked trusted, so a project's own Codex folder is not loaded. A machine-wide Codex configuration, if an administrator installed one, still loads; the check at session open judges the result.
- **Continuation identity** is the runtime kind plus that folder's path, since a thread can be resumed only from the folder that holds it. Codex also refuses to resume a thread under a different model provider, so the provider's name is fixed in code.
- **Status** follows the contract's rule: a probe never signs in and never sends a model request. Signed-in state comes from Neuve's sign-in. Whether the program is present and trusted comes from the resolver below.

Whether to also offer Codex's own login as an account is an [open question](#open-questions-for-the-owner).

### Finding and trusting the program

One resolver, in `@neuve/runtime`, used by both the Codex and the Claude runtime. It replaces the Claude runtime's first-on-`PATH` lookup and every path written into code.

```
 where to look                          what must hold before anything is run            what the person sees otherwise
 ─────────────                          ─────────────────────────────────────            ──────────────────────────────
 1. a path the person set for the       the file, resolved through links, is a           "Codex is not installed", with
    account (neuve auth, Settings)      regular file owned by the person or root,        OpenAI's install page
 2. every match on the PATH, in order,  in folders others cannot write
    not only the first                                                                   "Found <path>, which is not
                                        on macOS: the operating system's own tool        OpenAI's Codex" (unsigned, or
 Each candidate is judged; the first    finds its code signature valid and from the      another signer), naming each
 that passes is used. A candidate that  vendor's Developer ID team                       candidate and why it was refused
 fails is never run, not even to ask
 its version.                           then, and only then, it is started; the          "Could not check <path>" when the
                                        handshake's reported version must be in the      check itself could not be made
                                        supported range
                                                                                         "Codex <version> is older than
                                                                                         Neuve supports", with the range
```

- **Why not the first match.** On the owner's machine the first `codex` is an unrelated package of that name; the [labelling source's own comment](../../packages/evaluation/src/retrieval-bench/labelling/routes.ts) (line 28) calls it "an unrelated npm package", and the npm registry lists the unscoped [`codex`](https://registry.npmjs.org/codex) as a documentation tool. Judging every match finds a real one behind it, and says plainly what the others were.
- **Why the signature is the anchor.** A path proves nothing and a version string is whatever the program prints. A signature the operating system verifies says who built the file and that it has not been altered since. The check calls the operating system's signing tool by its fixed system path and reads the file; it does not run it. The vendor's team identifier is written into the code, since pinning a signer is the purpose and is not a path.
- **Where the identifier comes from.** OpenAI does not publish it. It was read on 20 November 2026, without running anything, from the one signed Codex on the owner's machine, the copy inside the ChatGPT app: "Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)", notarised, signature valid. That reading is the first source. The independent reviewer found a second for OpenAI's desktop apps: a user's report on OpenAI's issue tracker ([openai/codex issue 27662](https://github.com/openai/codex/issues/27662)) shows the same signer on the Codex desktop app's bundled program. Neither source is a released command-line Codex (the installer, the npm package, a GitHub release, Homebrew's cask): OpenAI's release workflow signs and notarises those but names no identifier, and no released copy was inspected. So the identifier is the owner's to confirm before it is written into code, or it is read from a released copy once the person has installed one.
- **A check that cannot be made is not a verdict on the program.** Read from inside a sandbox that hides the operating system's certificate service, the same valid copy reported an invalid signature. The verifier therefore tells "could not check" apart from "checked and wrong", shows the first as its own state, and runs the program in neither case.
- **What this defends against, and what it does not.** It stops Neuve from running the wrong program by accident, a program planted where another user can write, and a copy altered at rest. It does not stop a hostile process already running as the person: such a process could swap the file between the check and the start, and could as easily read Neuve's own sign-in file. No ruling names that threat. The nearest is the limit stated with [decision 14.57](../decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026): until the sandbox exists, Neuve's checks hold against drift and mistakes, not against a hostile agent with a shell. The resolver is offered on the same terms. After the start the runtime also checks the running process's signature before it sends anything; that catches a swap after the fact and is a tripwire, not a guarantee, because the process already has its environment by then.
- **Revocation is not claimed.** Whether the signing tool's check sees a revoked certificate without the network is not established, so the design does not rest on it.
- **The handshake is a compatibility check, not trust.** The version it reports decides only whether Neuve supports that release.
- **Launchers.** OpenAI's npm package installs a script that starts the real program from a platform package beside it. A script has no signature, so for that known layout the resolver follows it to the native program and verifies and runs that.
- **A program that cannot be verified.** A build the person made themselves, or any program on Linux, where there is no signature to check, has no anchor. Such a program is never taken from the `PATH`. Whether it may run when the person sets its path themselves, shown as "set by you, not verified", is an [open question](#open-questions-for-the-owner); until it is answered it does not run.
- **Version.** The supported range is data, as in T3 Code, and the generated protocol types name the Codex release they came from. A program older than the range is refused with the range; a newer one is used, and a message it sends that the types do not know is logged once and ignored, as the Claude runtime does for unknown frames.
- **Never installed, updated or downloaded by Neuve.** `neuve doctor` and the account's status show what was found.

The contract change is in [What the contract gains](#what-the-contract-gains).

### Starting it and speaking to it

- **Process.** One per session, started in the caller's scope, with standard input and output as the transport and standard error kept as a short tail for failure reports. Closing the scope ends it. Its working folder is the Neuve-owned folder, never the project: Codex runs no tools, so it has no need of the project's folder, and it then reads no project file of its own accord.
- **Environment.** Built from a short list of allowed names and never copied from Neuve's own, as [labelling already does](../../packages/evaluation/src/retrieval-bench/labelling/routes.ts) (lines 47–78), with the home folder and Codex home set to the Neuve-owned folder.
- **What the Codex process holds.** Two secrets, both in its environment and neither on a command line or in a log: the hour-long access token, and the bearer token for Neuve's tool server, made for that session and useless after it. Nothing longer-lived reaches it: not the refresh token, not a key, not an agent socket. Codex is configured to pass none of its environment to anything it starts, and with its own tools off it starts nothing.
- **Configuration** is passed on the command line, which Codex documents, and holds no secret: the model provider and the name of the variable its token is in; Neuve's tool server and the name of the variable its bearer token is in; and the switches under [Tools](#tools-neuves-are-the-only-ones).
- **Handshake.** `initialize` with Neuve's name and version, then `initialized`, without opting in to the experimental surface. OpenAI's guide asks that the name match the one Neuve registered at sign-in, which is `Neuve`.
- **Types.** Generated from OpenAI's published schema for a pinned Codex release and checked in, with a script that regenerates them. Incoming messages are decoded strictly for the fields Neuve consumes.

### Sessions, turns and events

| Contract | Codex app server | Notes |
| --- | --- | --- |
| `openSession`, new | Start the process, then `thread/start` with the model and Neuve's instructions | `nativeSessionId` is Codex's thread id |
| `openSession`, resume | `thread/resume` with the stored thread id | A thread that is archived or closing is retried as T3 Code does |
| `openSession`, fork | `thread/fork`, at a turn boundary | See the resume note below |
| `startTurn` | `turn/start` with the message, model, effort and, on a final turn, the output schema | Codex accepts a schema per turn, so a final turn needs no second process |
| `steerTurn` | `turn/steer` with the running turn's id | |
| `interruptTurn` | `turn/interrupt`, then wait for the turn to end | If it does not end, the process is stopped and the turn finishes interrupted |
| `setModel` | The next `turn/start` carries the new model and effort | |
| `text` | `item/agentMessage/delta` | |
| `tool.started`, `tool.finished` | A call arriving at Neuve's tool server, and its result | Named by Neuve's tool name, never a wire name |
| `usage` | `thread/tokenUsage/updated` | Turn scope. Cost is `null`: a subscription is unpriced |
| `rate-limit` | `account/rateLimits/updated`, if Codex sends it on this provider | Not verified |
| `retry` | Codex's `error` notification when it says it will retry | |
| `turn.finished` | `turn/completed`: completed, interrupted or failed | Process exit finishes open turns as failed and broken, then ends the stream |
| `message.finished` | No direct equivalent | See below |

**Codex cannot do three things the contract today assumes of every runtime that runs its own loop.** Each is true of Claude Code. The contract's own text says so, and the design changes the contract and does not work around it.

| The contract today | Codex | What changes |
| --- | --- | --- |
| A tool's result may end the turn with no further model request, and "a runtime that cannot honour this must not declare ownsLoop" ([`contract.ts`](../../packages/runtime/src/contract.ts), lines 76–82) | The app server has no such switch. Withholding the result and interrupting would leave the result outside Codex's thread, which the contract's rule on resume points forbids (lines 286–289) | Ending a turn from a tool becomes its own capability. Claude Code declares it; Codex does not. Review stages require it. Coding chats do not: the bridge never reads it, and holds each call open while pi runs the tool |
| Every `message.finished` names a resume point "whose whole chain is in the native session", and the chat bridge records one at every tool call and forks there after a failure ([`bridge.ts`](../../packages/harness/src/chat-runtime/bridge.ts), lines 503–510 and 961–988) | Codex resumes and forks only between turns | Resuming mid-turn becomes a capability. Without it a message carries no resume point; the bridge records one only when a turn ends, and recovers an interrupted turn from the last completed turn, giving the model the lost part of the conversation as text. The bridge already builds such a hand-over for a change of account ([`handoff.ts`](../../packages/harness/src/chat-runtime/handoff.ts)) |
| One `message.finished` per model response, listing all of its tool calls, with that request's usage "always" filled (lines 177–215) | The app server reports items, not responses, and usage per thread. What the runtime can prove is that a response has ended when a tool call reaches Neuve's tool server. Codex runs one MCP server's calls one at a time by default, but one response may still hold several | A message becomes "the unit a runtime can prove complete": for Codex, each tool call with the text before it, and a turn's closing text. Per-message usage becomes a capability, which review stages require for their context ceiling and chats do not |

So the Codex runtime declares that it runs its own loop and does not declare the three new capabilities. Chats and build lanes need only the first. Review stages need all four, so they cannot run on Codex, and nothing in this proposal makes them. Two callers that read "runs its own loop" as "is Claude Code" are corrected by the same change: the chat models gate ([`models.ts`](../../packages/harness/src/chat-runtime/models.ts), line 121), which stays as it is, and the stage route check ([`route.ts`](../../packages/harness/src/route.ts), lines 154–158), which gains the three capabilities.

### Tools: Neuve's are the only ones

Neuve's tools reach Codex as one MCP server, the way they reach Claude Code and the way T3 Code serves its own. The server listens on the local machine only, on a port of its own per session, and requires that session's bearer token. Its tools are offered to the model directly, not through Codex's code mode or its tool search, which OpenAI's guide says fails on this sign-in.

Codex's own tools are turned off. **One thing guards that, and it must be proved before anything else is built on it:** before the first turn the runtime reads back, from the running program, its effective configuration and its feature list, and refuses to open the session unless every tool-bearing feature is off and none it does not know is on. The [replay judge's probe](../../packages/evaluation/src/pr-replay/codex.ts) (lines 47–61) is why this is a check and not a list of switches: it found that with the shell switched off the model was still offered a way to run code, and that a failed attempt left no trace in the event log. The list of features is shared with the replay judge's. A new Codex release that adds a tool fails closed, with a message that names the feature.

Two more settings limit the damage if that check is ever wrong. They are not guards, and the design does not count on them:

- **The sandbox is read-only.** A tool Codex still had could not write. It could still read, so this protects nothing that must stay private.
- **Codex is told never to ask for approval,** so a write it attempts on its own fails inside Codex and does not wait on a person. A read still succeeds.

One more signal costs nothing: Codex reports each command, file change and web search of its own as an item in the turn's events. Any such item fails the turn as a protocol error and closes the session. It tells Neuve after the fact that the check was wrong; it does not undo a read.

Codex can still send the client a request during a turn. Each kind has a fixed answer, so no turn stalls on one:

| Request from Codex | Answer |
| --- | --- |
| Approval of a command, a file change or wider permissions | Declined. With Codex told never to ask, none should arrive; one that does means a tool of Codex's own tried to run, so the turn fails as a protocol error and the session is closed |
| Confirmation of a call to one of Neuve's own tools | Accepted. Neuve's tool server is configured so its tools are approved without asking; if Codex asks anyway, for a tool marked destructive, this is the answer |
| A question for the person, or a confirmation for any other server | Cancelled, and logged |

What follows from Neuve's tools being the only tools:

- **Plan mode's read-only rule applies unchanged.** It is enforced inside each of Neuve's tools ([planning mode proposal](planning-mode.md#how-read-only-is-enforced-and-where-the-hook-sits)). Codex's own planning mode, which is experimental and a matter of instructions, is not used.
- **The sandbox ruling applies unchanged** ([decision 12.28](../decisions.md#area-12-ace-style-pi-transition-28-october-2026)). File and shell calls go where the channel sends them, which is the channel's sandbox once it exists. The Codex process runs no commands and stays outside, like Claude Code's.
- **What an agent can reach.** Through the tools, exactly what a pi or Claude Code chat can reach. An agent that has been given hostile text has no more than that, as long as the check at open holds.
- **Approvals under Neuve's policy.** When a session's policy is "ask", the runtime raises the contract's approval request itself, before a tool's handler runs, and waits for the answer. Nothing of Codex's approval machinery is involved.
- **Questions to the person** go through Neuve's own question tool.

### Models and effort

A probe lists what this account can use and never sends a model request:

- **Which models:** the account's own catalogue from the public API, which Neuve already reads for the route check ([`openai-route.ts`](../../packages/harness/src/openai-route.ts), lines 72–110). OpenAI's guide warns that the app server's own list, on this provider, is a bundled catalogue and "not an entitlement check".
- **Which effort levels each takes, and its default:** Codex's `model/list`, joined to that catalogue by model name.
- **Nothing built in.** No model name is written into the runtime. A model in one list and not the other is shown without effort levels or left out, never guessed.

The result fills the same model rows Claude Code's probe fills, so Ace's picker, each agent's line and "by prompting" selection ([decision 14.61](../decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026)) need no Codex case.

### Cancel, resume and recovery

- **Cancel** is `turn/interrupt`, and if the turn does not end, stopping the process. Either way the contract's one terminal event is emitted.
- **The process dies.** Pending requests fail, open turns finish failed and broken, the stream ends. The next turn opens a new session and resumes the thread at its last completed turn. There is no reconnect, as in T3 Code.
- **Neuve restarts.** Nothing of Codex survives it. The bridge's stored heads hold the thread id and last completed turn, and the next turn resumes from there.
- **The token nears expiry.** Between turns, the process is restarted on a fresh token and the thread resumed. Mid-turn, the turn fails as reusable.
- **The sign-in is gone or rejected.** The turn ends with the contract's "sign-in required" or "account rejected", naming `neuve auth login <account>`.
- **A usage limit** ends the turn with "usage limit reached" for that account, and never moves to another account on its own.

### Telemetry and capture

| Capability | Codex runtime | Why |
| --- | --- | --- |
| Runs its own loop, resume, fork, interrupt, model switch, structured output, steering, approvals, native tool server, status probe, internal retries | Yes | As mapped above |
| Ending a turn from a tool, resuming mid-turn, per-message usage | No | The three limits above |
| Per-request telemetry | No | Usage arrives per turn |
| Byte-exact capture | No | Neuve sees protocol messages, not the provider's wire |

Shared telemetry, logs, receipts and budgets read the contract's events and need nothing new. Beyond them the runtime writes the decoded protocol messages, without text deltas and with secrets removed, to the run's log, as a second capture kind beside Claude Code's. Codex's thread files stay in the Neuve-owned folder as the native transcript.

### What the contract gains

Each is a change to the shared contract, used by every runtime, and none is a Codex case in a caller.

| Change | Who else it serves |
| --- | --- |
| The runtime kinds gain `codex`, and a `chatgpt-subscription` account may name it | The same shape an Anthropic key already has |
| One program resolver and verifier in `@neuve/runtime`, and "unavailable" reasons for a program that was found and refused and for a check that could not be made. A probe reports what was found and why it was or was not used | Claude Code, which today takes the first `claude` on the `PATH` |
| Three capabilities split out of "runs its own loop": ending a turn from a tool, resuming mid-turn, and per-message usage. The contract's text on `endTurn`, resume points and `message.finished` is reworded to match, and review stages check all three when a stage opens | Says in the contract what stages need and what chats need, which today is implied by there being one such runtime |
| A model row may carry its context window and output limit as reported before any turn has run. The contract already reports both on a turn's usage, and the bridge already prefers those; the row replaces only the bridge's fallback to pi's `anthropic` catalogue ([`models.ts`](../../packages/harness/src/chat-runtime/models.ts), lines 85–87) | Any runtime whose models pi's Anthropic catalogue does not list |
| The effort levels cover what runtimes report (Codex has levels below "low"); a level Neuve does not know is left out and logged, never a failed probe | Any future runtime |

## What this replaces or consolidates

| Today | After |
| --- | --- |
| A build lane starts the Codex program from the ChatGPT app by hand | Removed. A lane's Codex implementer is a chat on the `codex` account |
| pi's "OpenAI Codex (legacy)" provider in Ace's catalogue, and its model names in the channel's built-in lists | Removed from the catalogue. The planning mode work already removes those lists; Codex's models come from the account's probe |
| The Claude runtime's first-on-`PATH` lookup | Replaced by the shared resolver |
| The app-bundle path written into the two evaluation files and their tests | Removed. They take the program from the shared resolver or from the explicit setting they already have |
| Two sign-ins for one vendor (Neuve's, and pi's copy of Codex's) | One: Neuve's |

What stays, and why:

- **Review stages on pi.** They need exact capture and Neuve's own retry rules, and only pi replays byte for byte ([runtime and accounts proposal](claude-subscription-route.md#what-is-shared-and-what-each-runtime-keeps)). They also need the three capabilities Codex lacks.
- **The replay judge's `codex exec` run.** It reads text written by anyone on the internet, so it must have no tools at all, and it proves that by refusing any Codex but one exact, hashed build with a known feature list and by auditing the run's event log ([`pr-replay/codex.ts`](../../packages/evaluation/src/pr-replay/codex.ts), lines 47–61, 105–111 and 563–740). A runtime whose purpose is to give an agent tools is the wrong instrument for that, and `codex exec` is a mode OpenAI supports for scripts. It keeps its own stricter checks and loses only the written path.
- **Labelling's `codex exec` run** ([`labelling/routes.ts`](../../packages/evaluation/src/retrieval-bench/labelling/routes.ts)) is pinned evaluation machinery of the same kind. It could move to the runtime later, since the runtime offers structured output; nothing here needs it to, so it only loses the written path.

So OpenAI's models are still reached three ways, each for a stated reason, on one sign-in for the first two and with no path written into code in any of them.

## How a build lane runs a Codex implementer

**Once the first five slices exist, and a verified Codex is on the machine.** On the owner's machine today the resolver would find nothing to run: the only `codex` on the `PATH` is the unrelated package, and the one signed copy is inside the ChatGPT app, which is not on the `PATH` and is not to be reached by a written path. Installing OpenAI's Codex, or setting a path for the account, is the person's act. The coordinator then opens a workspace channel on the implementer's worktree, chooses a model from the `codex` account, and sends the brief, all through the workspace's existing command line (`new`, `model`, `ask`, `watch`; [`cli.ts`](../../apps/neuve-host/src/cli.ts)). The implementer is then an ordinary Ace chat: it has Ace's file and shell tools, its work is in the channel's transcript for the reviewers to read, and it runs on the person's ChatGPT plan through the verified Codex program. The brief names the repository's guidance and the shipped `neuve` skill, as a lane's brief does today; Ace loading that skill by itself is separate work. That is also the path the planning mode build uses for its implementers, so the lane dogfoods it.

**From an unmerged branch.** A lane does not have to wait for the merge. The workspace is started from a checkout's source (`bun workspace`, with `--repo` naming the project to work on; [Developing Neuve](../../docs/development.md#open-the-workspace)), so a workspace started from this branch's worktree runs this branch's runtime while the implementer's project is another worktree. That takes the branch's worktree with its dependencies installed and the Graph engine built or copied in, a verified Codex, and the Neuve sign-in. This is read from the commands' documentation and was not run. The installed `neuve` is not involved, since the workspace is not part of a release.

**Until then.** The paths the owner rejected are not used. A lane's implementer is an Opus session, which [`AGENTS.md`](../../AGENTS.md#how-agents-build-neuve) already allows. Review stages and chats that need Sol keep using Neuve's own loop on the `chatgpt` account, which is not a Codex path. A lane that waits for a Codex implementer waits for these slices.

## Build slices

Each is one implementer and one independent reviewer. They run in order in one lane, because each builds on the files of the one before. **The first five, from "Find and trust a program" to "The account, and Ace", are the smallest set that lets a build lane run a Codex implementer.** The planning mode lane is waiting on them ([NEU-424](https://linear.app/neuve/issue/NEU-424)).

| Slice | Needs | Replaces | Done when, including the failures |
| --- | --- | --- | --- |
| **Find and trust a program.** The shared resolver and verifier, the two new "unavailable" reasons, the Claude runtime moved onto it, and the written app-bundle path taken out of both evaluation files and their tests | Nothing. It runs no Codex | The Claude runtime's `PATH` lookup; the written path | A signed program from the expected signer passes without being run during the check. Each of these is refused and never run, with its own message: nothing found, an unrelated program of the same name ahead of the real one (the real one is then used), an unsigned copy, another signer, a file or folder others can write, a link out of an allowed place. A check that cannot be made shows as that, and nothing runs. Claude Code still opens. No file, tests included, names the ChatGPT app's bundle, and the replay judge's gate still refuses any Codex but its pinned build. `neuve doctor` shows what was found |
| **Speak the protocol, and prove the facts.** Generated types for a pinned Codex release with the third-party notice; the line-based client; a recorded-conversation replay for tests; and a table of the facts the runtime relies on, each proved against a verified Codex or marked unproved | Find and trust a program. The proofs need a verified Codex on the machine | Nothing | Without a verified Codex: the client and its replay tests are complete, and malformed, oversized and unknown messages, a process that exits mid-request and a handshake that never answers each end in a typed failure; every fact in the table is marked unproved, and the lane stops here. With one: a handshake, a thread, a turn, a tool call from Neuve's server, an interrupt, a resume and a structured final answer are each recorded from the real program. The table says whether the check at open can see every tool-bearing feature, including configuration given on the command line. If it cannot, the build stops and this design is revised |
| **The contract's three capabilities.** The split of "runs its own loop", the reworded contract text, the stage check, and the chat bridge recovering a turn on a runtime that resumes only between turns | Nothing; it can run beside the two above | The implied rule that a runtime with its own loop is Claude Code | Claude Code declares all three and every existing stage and chat test passes unchanged. A test runtime without them is listed for chats and refused for stages with a typed mismatch. On that runtime the bridge records no mid-turn head, and after a failure mid-turn it resumes at the last completed turn and gives the lost part as text, without running a completed call again |
| **The runtime.** Sessions, turns and events mapped onto the contract; Neuve's tools over the local tool server; Codex's own tools off with the check at open; the fixed answers to Codex's requests; cancel, resume and recovery; the protocol log | The three above | Nothing | The contract's conformance tests that the Claude runtime passes are passed here, for the capabilities declared. Exactly one terminal event per turn in each of: completion, interrupt, process death, scope closure, expired token, sign-in required, usage limit. A Codex with a tool-bearing feature on is refused at open. An approval request for a command or file change is declined and fails the turn; a question or foreign confirmation is cancelled and the turn continues. The Codex process's environment holds the two session secrets and no other credential; neither is in a log or on a command line; its home holds no sign-in |
| **The account, and Ace.** The runtime kind and default `codex` account; the probe with models and effort; registration in the review worker and the workspace; the model row's new fields with the bridge's Claude-only fallback removed | The runtime | The `anthropic` catalogue fallback in the bridge | `neuve auth status` and the workspace list the `codex` account with its state and its models and effort levels, none of them written in code. A workspace chat on it completes a turn that reads and edits a file through Ace's tools, is stopped mid-turn, and is resumed after the process is killed. Without Codex installed, with one that is refused, with one that could not be checked, with one too old, and signed out, the account shows that state and the chat fails with it; pi and Claude accounts are unaffected in each |
| **Remove the legacy provider.** pi's legacy ChatGPT provider out of Ace's catalogue | The account, and Ace; and the planning mode slice that removes the channel's model lists | That provider | Ace lists no model of the legacy provider, and a chat that had one selected says so and offers the account's models |
| **Codex's own login as an account**, only if the owner says yes | The account, and Ace | Nothing | A person signed in to Codex and not to Neuve sees an account for it, with the sign-in command when signed out |

None of the first five is visual work. "The account, and Ace" changes no screen; the account appears in the lists Ace already draws. Review stages on Codex are not a slice: they would need Codex to gain what it lacks, or a design of their own.

**Staffing of the first five.** An Opus implementer, a separate Opus reviewer with fresh context in the inner loop, and a separate Fable reviewer with fresh context for the whole range, who requests the one Neuve review. No accepted Codex route exists until this is built, so the implementer cannot be a Codex session. This is the coordinator's decision of 20 November 2026 and not a ruling; [decision 14.9](../decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026) names Opus reviewers since 13 November, so the Fable reviewer is for the owner to confirm or overrule.

## Settled here, from the owner's stated principles

| Point | Settled as | From |
| --- | --- | --- |
| Which protocol | The app server, over standard input and output | The owner's "the official ... codex server", and what OpenAI builds its own clients on |
| The shape | A second runtime behind the existing contract | "our abstraction on a similar fashion": Neuve's contract already follows T3 Code's |
| Sign-in | Neuve's existing ChatGPT sign-in | [Decision 10.85](../decisions.md#area-10-harness-m3-18-october-2026) chose OpenAI's official sign-in; OpenAI recommends it for the app server |
| pi's legacy ChatGPT-backend provider | Removed from Ace | [Decision 2.9](../decisions.md#area-2-harness-pipeline-16-october-2026) removed the consumer-backend route; 10.85 called this one unsupported |
| Models and effort | Discovered from the account and from Codex, none written in code | "We should identify and use available models and vendors" |
| Agents' flow | No cap, counter or coded stop is added. The only limits are on processes: a handshake that never answers, a turn that will not stop | [Decision 14.59](../decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026) |
| Review stages | Stay on pi | [Record 0017](../../architecture/decisions/0017-runtime-contract-and-accounts.md) and exact replay |
| Installing Codex | Neuve never installs, updates or downloads it; it shows what is missing and where to get it | Neuve runs the person's own program, as [decision 12.59](../decisions.md#area-12-ace-style-pi-transition-28-october-2026) has it for Claude Code. T3 Code's managed mode does install one; nothing the owner said asks for that |

## Open questions for the owner

Neither blocks the first five slices. One fact belongs beside both: on the owner's machine today, whatever is answered, the `codex` account works only after the person installs OpenAI's Codex or sets a path to a copy that verifies.

| Question | Options | Recommendation |
| --- | --- | --- |
| Should Neuve also offer **Codex's own login** as an account, so a person already signed in to Codex needs no Neuve sign-in? | (a) No: Neuve's sign-in only. (b) Yes, as a second kind of account beside it | (a) for now. OpenAI says app-server sign-in "has never been permitted for commercial or hosted services" and recommends the sign-in Neuve already has. Neuve is local and open source today, where OpenAI says it "can continue", but [decision 12.28](../decisions.md#area-12-ace-style-pi-transition-28-october-2026) describes it as growing into a centralised product. The cost of (a) is one `neuve auth login` for a person who uses Codex |
| May a Codex that **cannot be verified** run when the person sets its path themselves? That covers every Codex on Linux, a build the person made from OpenAI's source, and possibly a package manager's own build | (a) Yes, shown as "set by you, not verified". (b) No: only a program signed by OpenAI runs, so Codex does not work on Linux | (a). The person's own explicit act is the trust, the state is shown plainly, and such a program is still never taken from the `PATH`. Until this is answered it does not run |

## Not verified

No Codex program was run. Everything about Codex's behaviour is from documentation, its source, or T3 Code's source.

- **The app server's behaviour on the owner's machine.** No verified Codex was available to the resolver on the build machine: nothing on its `PATH` is OpenAI's.
- **OpenAI's signing identity for its released Codex.** The identifier above was read from the ChatGPT app's bundled copy. That OpenAI's own releases (its installer, npm package, Homebrew cask) carry the same signer rests on its release workflow, which signs and notarises, and on user reports; no released copy was inspected.
- **Whether the check at open is sound:** that the running program's reported configuration and feature list reflect configuration given on the command line and a machine-wide configuration, and that they name every feature that gives the model a tool. The whole tools design rests on this.
- **The tools-only configuration.** Which switches leave the model Neuve's MCP tools, offered directly, and nothing else. The replay judge's list was probed on an older release for a run with no tools at all.
- **Whether Codex asks for confirmation of Neuve's own tools** when they are marked destructive, in what form, and whether the server's approval setting stops it.
- **Call identity.** Whether a call arriving at Neuve's tool server can be tied to Codex's own item id for it.
- **That a tool call arriving at the server proves the response that made it has ended,** and that a response's calls reach the server one at a time.
- **Resuming and forking** at a turn boundary after a turn was interrupted or the process died, and what Codex keeps of the interrupted turn.
- **Restarting on a renewed token:** that a thread resumes cleanly in a new process, as OpenAI's guide says.
- **Usage and limits on this provider:** what `thread/tokenUsage/updated` carries, and whether rate-limit notifications arrive at all.
- **That `model/list` and the account's catalogue join cleanly** by model name.
- **That Codex passes none of its environment on,** and that the home-folder and no-trusted-project settings keep every personal and project file out.
- **Whether the signing tool's check sees a revoked certificate.**
- **Whether "never ask" changes how Codex treats Neuve's own tools,** for example by declining a destructive one itself.
- **Whether a working folder that is not the project misleads the model about paths,** since Neuve's tools act on the project while Codex reports Neuve's folder.
- **How long a build lane's turns run** against the token's hour.
- **Windows,** which this proposal does not design for.
- **Whether a person can sign in to pi's legacy provider from Ace today.** It is listed; nothing else was established.
- **OpenAI's terms.** The sign-in statements are from developer documentation, not from a terms document.
- **The app server's stability in practice.** The statements conflict, and no compatibility policy was found.
- **What happened on the owner's machine on 20 November** (an old copy removed by the operating system, the lane's run loading the owner's personal Codex hooks) is from the coordinating session's account and the lane's run log, which are kept outside the repository; it was not re-checked here beyond the `PATH`.
- **T3 Code:** the citations were checked against the files, but the checked-in generated types were not confirmed to match the commit its generator names, and its behaviour was read, not run.

## References

- T3 Code, [pingdotgg/t3code](https://github.com/pingdotgg/t3code) at `898c22f9900b90f81daece0895b7e4f4198355f8`: the files named above, and `docs/internals/providers.md`.
- OpenAI, [Codex app server](https://learn.chatgpt.com/docs/app-server); [developer commands](https://learn.chatgpt.com/docs/developer-commands); [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode); [authentication](https://learn.chatgpt.com/docs/auth); [MCP configuration](https://learn.chatgpt.com/docs/extend/mcp); the configuration reference on the same site. Read 20 November 2026.
- OpenAI, [Sign in with ChatGPT](https://developers.openai.com/siwc), its [Codex app-server page](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) and its preview limitations. Read 20 November 2026.
- OpenAI, [openai/codex](https://github.com/openai/codex) at tag `rust-v0.171.0`: `codex-rs/cli/src/main.rs`, `codex-rs/app-server-protocol/schema`, `sdk/typescript/src/exec.ts`, `.github/workflows/rust-release.yml`.
- The Agent Client Protocol's [Codex adapter](https://github.com/agentclientprotocol/codex-acp).
- Neuve: [record 0017](../../architecture/decisions/0017-runtime-contract-and-accounts.md), [record 0008](../../architecture/decisions/0008-model-routes-and-budgets.md), [record 0014](../../architecture/decisions/0014-ace-style-pi-harness.md), the [runtime and accounts proposal](claude-subscription-route.md), the [planning mode proposal](planning-mode.md), and the [Claude runtime's capability notes](../../packages/runtime-claude/SDK.md).
