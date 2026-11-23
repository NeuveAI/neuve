# Approvals in the chat: proposal

Status: proposal, drafted 23 November 2026. Nothing here is built. It answers the work list's item "Approvals in the chat, for an attended Codex chat, designed together with the person-driven Codex chat", which the owner kept open when ruling that every Codex chat keeps Ace's own tools withheld except `question` for now ([decision 14.79](../decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026)). On the coordinator's plan to build only the round trip tonight, the owner said: "it's not just 'codex' on Ace so I rather us thinking about the primitives and features in engineering and product terms. That being said, you're on the right track". So this text designs the general mechanism: a runtime that does work of its own asks the person before one piece of that work, and the person answers in the chat. Codex is the first runtime that needs it and is named only where a fact is Codex's. The [decisions record](../decisions.md) wins wherever this text differs from it.

**Words.** _Runtime_, _account_ and _provider session_ are the implementation words of the [runtime and accounts proposal](claude-subscription-route.md): the program that runs an agent's loop, one sign-in, one running process. Three words this text needs are not in the [vocabulary](../../vocabulary.md), so each is described in plain words here and listed for the owner under [Still open](#still-open-for-the-owner):

- _Approval request_ is the runtime contract's name for "may I do this one piece of work?". In the vocabulary an approval is a disposition on reviewed work, which only review gives. An approval request approves no work, and its card says Allow and Deny so that "approve" keeps that meaning.
- _Attended_ means a person in the app is driving the chat and can be asked. _Unattended_ means nobody can be asked, as for a build lane's implementer or a plan's agents.
- _Lane_ here is Ace's own worktree and branch for a unit of work, started with the `lane` tool ([`lanes.ts`](../../packages/channel/src/lanes.ts)). It is not a review lane.

## At a glance

```
 TODAY                                         PROPOSED
 ─────                                         ────────
 Codex wants to do something its sandbox       Codex asks; the bridge keeps the request open
 does not allow (a write outside the folder,   in a record of the chat until it closes; the chat
 the network, another server's prompt)         shows a card; a person allows or denies it
        │                                              │
        ▼                                              ▼
 every chat session is opened "allow"          a chat a person drives in the app is attended:
 (transcript.ts, lines 182-183), so Codex      on a runtime with its own tools its session is
 never asks and the work fails                 opened "ask"; every other chat stays "allow"
        │                                              │
        ▼                                              ▼
 the same value withholds every Ace tool       which Ace tools a person-driven chat gets, and
 but `question` from a runtime with its own    keeping it off the project checkout, are two
 tools                                         decisions for the owner, built after them
```

| Point | Recommendation |
| --- | --- |
| What a request is | One piece of a runtime's own work that the chat's mode does not let it do by itself. Two answers, Allow and Deny. It closes when its turn ends. Only a person answers, and only one the channel lets ask its agents |
| What makes a chat attended | A fact stored on the chat, written only by a person's message from the app's composer, as the chat's mode is. It defaults to unattended, so the command line, the host and agents never make a chat attended |
| Ace's tools in a person-driven chat | Served when nothing they do lets the chat's work leave the runtime's sandbox, asked call by call when each call is one effect a person can judge, withheld otherwise |
| The project checkout | The host puts the chat on a lane of its own before its first turn that may write |
| Tonight | The round trip and the attended fact, with the tool boundary and the chat's folder exactly as today |

## What is there today

Every line below was read on 23 November 2026 at `20203f4`.

| Fact | Where |
| --- | --- |
| The contract has the request (an id, the call or work it is for, its input, and either one of Neuve's tool names or a kind of work: command, file change, web search, tool), the answer (allow or deny, with an optional message), and the rule that an unanswered request ends with its turn | [`contract.ts`](../../packages/runtime/src/contract.ts), lines 149-154, 298-315, 388-398 |
| The session's policy, `allow` or `ask`, is fixed when the session opens. The registry refuses `ask` for a runtime that does not declare approvals. Claude Code and Codex declare it | `contract.ts`, line 121; [`registry.ts`](../../packages/runtime/src/registry.ts), lines 184-188 |
| `ask` means different things by runtime. On Codex, with writes allowed in the chat's folder, Codex asks only when it wants more than that sandbox gives. On Claude Code it opens Claude with no tool allowed, so every call to one of Neuve's tools is asked, reads included | [`launch.ts`](../../packages/runtime-codex/src/launch.ts), lines 145-166; [`runtime-claude/src/session.ts`](../../packages/runtime-claude/src/session.ts), lines 687-691 and 1078-1080 |
| Codex raises a command, a file change, a request for wider permissions (as a command) and another server's prompt (as a tool), and declines them all when the policy is `allow` or the turn is a planning turn | [`runtime-codex/src/session.ts`](../../packages/runtime-codex/src/session.ts), lines 690-817 |
| Codex's answer keeps no text. A denied command or file change is sent as "decline", and the contract's message is dropped. A granted permission lasts for the turn | `runtime-codex/src/session.ts`, lines 742-744 and 757-771 |
| A file-change request's input carries the folder and Codex's reason, not the change itself | `runtime-codex/src/session.ts`, lines 735-739 |
| When Codex resolves a request itself (`serverRequest/resolved`), the runtime denies it internally and emits nothing. A late answer to an unknown request fails as a protocol error | `runtime-codex/src/session.ts`, lines 617-624 and 1465-1470 |
| No chat uses any of this. Review stages open their sessions `allow` and only log a request ([`contract-step.ts`](../../packages/harness/src/pi/stages/contract-step.ts), lines 124 and 368). Every chat session is opened `allow`, and the same value decides that a runtime with its own tools is served only `question` | [`transcript.ts`](../../packages/harness/src/chat-runtime/transcript.ts), lines 29-36 and 182-197 |
| The session's key, which decides when the bridge reopens a session, leaves the policy out | `transcript.ts`, lines 214-224 |
| The bridge has no branch for the request. Its pattern for a runtime's own work is the `runtime_work` pass-through. The bridge records the work as a call that already ran, pi runs a tool that runs nothing, and the result is never sent back to the runtime | [`bridge.ts`](../../packages/harness/src/chat-runtime/bridge.ts), lines 1104-1302 and 1200-1224; [`extension.ts`](../../packages/harness/src/chat-runtime/extension.ts), lines 44-78 |
| The question is a tool run inside pi. It waits on a document kept per chat, so a rerun after a restart finds it. Stop aborts the wait, a message the person sends instead dismisses it, and the first answer wins | [`questions.ts`](../../packages/channel/src/questions.ts), lines 33-46, 89-170, 199-246 |
| The app finds a waiting question from the chat's tool events, and a waiting question marks the chat as needing the person in the sidebar, the dashboard and the palette | [`question.tsx`](../../apps/app/src/question.tsx), line 32; [`attention.ts`](../../apps/app/src/attention.ts), line 66; [`protocol.ts`](../../packages/channel/src/protocol.ts), line 40 |
| Answering or skipping a question passes the channel's check for who may ask its agents, which lets another channel's agent through | [`channel.ts`](../../packages/channel/src/channel.ts), lines 479-490 and 934-944 |
| The chat's mode is a stored fact per chat, set by a person's message and refused on a busy chat, and the channel passes it to the bridge with each request | [`plan-mode.ts`](../../packages/channel/src/plan-mode.ts), lines 69-110 |
| The command line drives a chat with the same requests as the app, with the person as author, so a message's author cannot tell the two apart | [`cli.ts`](../../apps/neuve-host/src/cli.ts), lines 683-689 and 727-731 |
| A chat's folder is its lane's worktree, or the project checkout when it has none | `channel.ts`, lines 803-813 |
| Ace tells every agent never to edit the checkout and to start a lane first. A runtime with its own tools has the `lane` tool withheld and is told to write in its working folder instead, which on a project is the checkout | [`room.ts`](../../packages/channel/src/room.ts), lines 254-256; `transcript.ts`, line 202 |
| `ApprovalView` in the shared interface package is exported and used nowhere | [`approval.tsx`](../../packages/ui/src/components/requests/approval.tsx); [`index.ts`](../../packages/ui/src/index.ts), line 53 |

So today a person's Codex chat on a project already writes the project checkout, with nothing asked.

## How other agents do it

A search agent read these on this machine under `.better-coding-agents/resources/`; the paths are relative to it. Behaviour was read, not run.

| Source | The request | The answers | An unanswered request | Who decides whether it asks |
| --- | --- | --- | --- | --- |
| Agent Client Protocol | `session/request_permission`: the tool call, with its kind and content, and a list of options (`agent-client-protocol/docs/protocol/v1/tool-calls.mdx`, lines 110-206) | Allow once, allow always, reject once, reject always | The client must answer "cancelled" when the turn is cancelled (`prompt-turn.mdx`, lines 314-339) | Session modes, changeable at any time, even mid-turn |
| Codex through ACP | Commands as Execute, patches as Edit with the patch shown (`codex-acp/src/thread.rs`, lines 1640-1686, 2536-2560) | Once; for this command pattern; for the session; deny; deny and tell Codex what to do differently | Cancelled becomes Codex's abort (lines 977-1066) | Codex's presets, each an approval policy and a sandbox (lines 2935-2945) |
| Claude Code through ACP | The tool call, then the request (`claude-agent-acp/src/acp-agent.ts`, lines 6876-6912) | Once; for the session; all edits for the session; reject | The wait races the turn's abort, so the call is released | Six permission modes |
| goose | Always four options (`goose/crates/goose/src/acp/server.rs`, lines 1580-1600) | "Always" is saved per tool name beyond the session | Cancelled | Auto, approve, smart approve, chat only |
| T3 Code | An approval item with a kind (command, file read, file change, a server's prompt, permission) | Accept, for the session, always, decline, cancel | Not read | A mode per thread; each thread has its own worktree path |

None of them has more than one person, so none says who may answer. Every one offers a lasting answer beside "once". This design offers only "once" in its first build, on purpose. A lasting answer is a stored rule about what an agent may do, which is the person's to want, and the contract has no place for it yet. It is put to the owner below.

## The design

### What an approval request is

**The rule.** A runtime asks before one piece of its own work that the chat's mode does not let it do by itself. The runtime never asks about Neuve's own tools, whose rules are code inside each tool ([planning mode proposal](planning-mode.md#how-read-only-is-enforced-and-where-the-hook-sits)). One of Neuve's tools that runs outside the runtime's sandbox may ask for itself on the same card, under the [rule for Ace's tools](#which-of-aces-own-tools-a-person-driven-chat-may-have) below. So on Codex a request means Codex wants to go beyond its own sandbox, and the owner's principle that people are asked "for needs not simple asks" ([decision 14.54](../decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026)) holds by construction, since routine work inside the folder is never asked.

**What the person sees, by kind of work.**

| Kind | The card shows | Allow | Deny |
| --- | --- | --- | --- |
| A command | The command line, the folder it runs in, and the runtime's reason | It runs once, with what it asked for | The runtime is told no and carries on without it |
| A file change | The files and their changes, and the reason | That change is written | The same |
| Wider permissions (Codex raises these as a command) | What it asks for (network, or write access to named folders) and the reason | Granted for this turn only | The same |
| Another server's prompt (a tool) | The server's name and its message | Accepted. A prompt that asks for data is accepted with none, since the card has no form | Declined |
| A web search (the contract's kind; Codex raises none today, and no runtime does yet) | The query | It runs | The same |

**What happens to a request.**

| When | What happens |
| --- | --- |
| The turn ends (completed, interrupted, failed, the process dies) | The runtime denies it. The card shows that it closed with its turn and offers no answer |
| The runtime resolves it itself mid-turn | The card closes the same way. The contract gains one event for this, since today the runtime emits nothing |
| The person is away | It waits, with no timer and no count ([decision 14.59](../decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026)). The chat shows the needs-you mark a waiting question shows today |
| The person sends a message instead | The request is denied, the card says who sent a message instead, and the message reaches the agent as it would otherwise. This is the question's rule, and it is how a person says why they denied, since Codex keeps no text with a denial |
| Stop | The wait ends, the run stops and the runtime denies the request |
| Reload | The card is rebuilt from the chat's stored state, waiting or answered, with who answered |
| Neuve restarts | Nothing of the runtime's process survives, so the turn has ended. The bridge closes every open request when it attaches, and the card shows it closed |
| An answer arrives after the request closed, or names a request that is not open | Refused with "this request is no longer open". The session is not closed for it. Answers name the request, not the call, since one piece of work can raise two requests |
| A second answer | Refused with who answered first |

**Who may answer.** The [planning design's rule](planning-mode.md#how-read-only-is-enforced-and-where-the-hook-sits) for who may change a chat's mode applies. Anyone the channel's switch lets ask its agents may answer, which with the switch off is only the channel's owner. On top of it comes the planning design's rule for approving a plan, that only a person approves and never an agent. The channel's check for who may ask its agents lets another channel's agent through, so the answer's request refuses an agent author first. A teammate who may not answer sees the card without its buttons. The rule is the same in a channel with one person and in a shared one ([decision 14.57](../decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026)).

**How it differs from the question and from approving a plan.**

| | Approval request | Question | Approving a plan |
| --- | --- | --- | --- |
| Raised by | The runtime's own check, before one piece of its work | The agent, in its own words, when it judges it needs the person | The person, when the plan is ready |
| Answers | Allow or Deny | Options or written text, or skip | Approve |
| Ends | With its turn, if unanswered | When answered, skipped or dismissed by a message | Never on its own |
| Who answers | A person the channel lets ask its agents | The same, and today also another channel's agent | Any person, never an agent |
| What it decides | Whether one action runs | What the agent does next | The scope the build is reviewed against. It approves no work |

### How a request travels

The request arrives at the bridge, and the card and its answer belong to the channel, which has no path from the bridge. Two ways were weighed against the one test that matters: a request must close when its turn ends, when the runtime's process dies, and when the runtime resolves it itself.

| Way | Gains | Costs |
| --- | --- | --- |
| A call that waits. The bridge records the request as a call to a pass-through tool, as it records `runtime_work`, ends pi's step, and pi runs a tool that waits on the person | The app finds the card from the chat's tool events, as it finds a question | It fails the test. After such a step on a runtime with its own tools the bridge holds ([`bridge.ts`](../../packages/harness/src/chat-runtime/bridge.ts), lines 1390-1394). From then on the reader only keeps events (lines 841-846), and the bridge neither records them nor ends the session until pi's next step (lines 1071-1087). The turn's end, a killed process's stream end and a resolved request would wait unseen for a step that never comes while the tool waits on a person. Making it work means a second reader of the held events, for this one case |
| **A record the bridge keeps open.** The bridge's reader, which takes every event as it arrives, opens and closes the records itself before it keeps the event for recording. On a request it writes the record into a document kept per chat. On the runtime's event for a resolved request, on the turn's end, and when the stream ends, it closes the records they end. It watches each open record for an answer and passes it to the runtime | Opening and closing never wait for the hold, since the reader runs while the bridge holds for one of Neuve's own tools, a question for instance. The records are not part of pi's transcript, so taking them out of the recording order changes nothing pi records. Stop already ends the session ([`bridge.ts`](../../packages/harness/src/chat-runtime/bridge.ts), lines 310-329), which closes the record the same way. While Codex waits on a person it sends nothing else, so nothing queues behind the request | One new event: the chat's open and answered requests, sent when a client attaches and on every change, as the review cards are sent from their document ([`channel.ts`](../../packages/channel/src/channel.ts), lines 1340-1351). The needs-you mark and the dismissal by a queued message are called from the new module, sharing the question's code ([`questions.ts`](../../packages/channel/src/questions.ts), lines 89-104) through one helper. On attach after a restart the bridge closes every open record, since nothing of the runtime survived. The bridge needs the document's definition |

The design takes the record the bridge keeps open. Of the two, it closes a request in all three cases with the fewest moving parts. One place, the reader, sees every event as it comes, whatever the bridge is doing. The document has one definition, in the channel's contract beside the review feed's portable definition, which exists so that a producer outside the channel and the channel share one document contract ([`protocol.ts`](../../packages/channel/src/protocol.ts), lines 66-70). The workspace hands that definition to the bridge when it builds the bridge's extension, as it hands it the bridge today ([`workspace-chat-runtime.ts`](../../apps/neuve-cli/src/workspace-chat-runtime.ts), line 225). Nothing in the code stops a runtime from raising a request while the bridge holds, since Codex may run its own command beside a call to one of Neuve's tools. So the design does not rest on it, and the card appears and closes the same way then.

**Which request an answer is for.** The runtime gives each request its own id, and names the call or work it is for separately ([`contract.ts`](../../packages/runtime/src/contract.ts), lines 298-315). Codex makes a new id for every request and uses its item's id as the call ([`runtime-codex/src/session.ts`](../../packages/runtime-codex/src/session.ts), lines 707-716), so one item can raise two requests with one call, a command and then wider permissions for it. Claude Code also makes a new id per request ([`runtime-claude/src/session.ts`](../../packages/runtime-claude/src/session.ts), lines 697-706). So the record, the event and the answer carry the request's id, and an answer to an id that is not open is refused. A late Allow for the command can never answer the permissions request after it.

### What makes a chat attended

**By runtime.**

| Runtime | Attended | Unattended |
| --- | --- | --- |
| A runtime with tools of its own (Codex) | Session opened `ask`. It asks only beyond its sandbox | Session opened `allow`. Nothing is asked and what the sandbox refuses fails |
| Claude Code | `allow`, as today. Its tools are Neuve's, so nothing runs outside Neuve's checks and there is nothing to ask. `ask` there would put a card before every read | The same |
| pi | Declares no approvals. Its tools are Neuve's, with nothing to ask | The same |

**Where the decision lives, who makes it, and when it changes.** It is a stored fact per chat, kept as the chat's mode is kept ([`plan-mode.ts`](../../packages/channel/src/plan-mode.ts)). The message to the agent gains one field, as it gained the mode. The app's composer sends it true on every message, and the command line's `ask` sends it false. A message without the field changes nothing, and an agent's message carrying it is refused. On a busy chat the message is never refused for it: the new value is stored and used when the session next opens, since the policy is fixed per session anyway. The channel passes it to the bridge with each request, as it passes the mode. The default is unattended. That follows from three rulings and one fact:

- A role is a fact stored on the chat, never read from a message's author ([planning mode proposal](planning-mode.md#after-approval-what-agents-may-do-and-what-code-still-guarantees)). The command line sends the same requests as the app with the person as author, so the author cannot be the test.
- A chat wrongly marked attended would wait on nobody, and no coded stop may end that wait ([decision 14.59](../decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026)). So only the one place a person certainly is, the app's composer, makes a chat attended.
- Only a person changes a chat's mode, and only between turns ([decision 14.57](../decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026) keeps that one design for every channel).

So the last client a person drove the chat from decides. A chat the owner drove from the app and then hands to a build lane from the command line goes back to unattended at its next session. A chat the person leaves in the app stays attended, and a request there waits for them with the needs-you mark. That the app's composer is the place that makes a chat attended is this design's reading, not a ruling, and is listed for the owner.

**What these rules hold against until the sandbox exists.** The same limit as the [planning design's](planning-mode.md#what-these-checks-hold-against-until-the-sandbox-exists). An agent with a shell runs as the person's own user, can read the host's token, and can send the attended field, or an answer, as the person through the command line. So "only a person answers" and "only a person makes a chat attended" hold against mistakes and drift, not against a hostile or injected agent. Whether Codex's own shell can reach the host from inside its sandbox, whose network is off, was not checked. A person's own MCP server or hook runs outside that sandbox and could. The channel's sandbox closes this, as it does for the planning design's checks.

The session's policy is fixed per session, so the bridge's session key gains the policy, and a change reopens the session before the next turn. Codex resumes its thread between turns, so nothing is lost.

**What an unattended chat keeps doing.** Everything it does today. A build lane's implementer, driven from the command line, and a plan's agents, started by the host, stay unattended, because the command line sends the field false and the host sends none. Codex asks nothing, writes inside its folder, fails what its sandbox refuses, and is served only `question` of Ace's tools. A chat a person drives does not pass its fact to the chats its agent starts.

### Which of Ace's own tools a person-driven chat may have

Ace's tools run outside the runtime's sandbox. Today's rule for an unattended session is that it gets only what cannot widen its sandbox. For a chat a person drives, a pi chat is the right comparison, since it has all of these tools and no sandbox at all. What the sandbox adds is that the chat's own work stays in its folder. So the principle is:

> A tool is served when nothing it does lets the chat's work leave the runtime's sandbox, that is, write outside its folder or run something that has no sandbox. A tool that would is served only when each call is one effect the person can see in full and judge before it runs, and then each call is asked. Otherwise it is withheld.

An approval can stand in for the sandbox only when all three hold: the card shows the whole effect before it runs, the effect ends with that call, and a person can judge it from the card. It cannot stand in for a tool that hands over a lasting power.

| Tool | What it can do outside the sandbox | Person-driven chat | Can an approval stand in, and why |
| --- | --- | --- | --- |
| `question` | Nothing | Served, as today | Not needed |
| `channel`, `tabs`, `tab_rename`, `tab_live` | Change the channel's name, summary and tabs | Served | Not needed. It touches nothing the sandbox protects |
| The three Linear reads | Send a query to Linear and return text | Served | Not needed. Outside plan mode the person's own MCP servers already reach the network outside Codex's sandbox ([Codex runtime proposal](codex-runtime.md#tools-codex-keeps-its-own-and-neuves-are-served-beside-them)), so these add no new way out |
| Review status and outcome | Read | Served | Not needed |
| Starting a review (branch, pull request, lane) | Run a review on the owner's accounts; write Neuve's records through Neuve's code | Served | Not needed. It writes nothing of the project, and requesting a review is the agent's judgment ([planning mode proposal](planning-mode.md#when-an-agent-asks-the-person)) |
| `message`, `channels` | Another channel's agent acts on the text, on its own tools, with no sandbox | Served, each send asked | Yes. The card shows the recipient and the exact text, one act the person judges as if they had sent it |
| `lane` | Moves the chat's folder, and so the runtime's writable folder, for every later turn; a switch can enter another chat's lane | Withheld; the host places the chat instead (next section) | Not for a switch, whose effect lasts. A start would be judgeable, but the next section makes it unneeded |
| `subagent` | Starts an agent with a shell on any model, outside any sandbox | Withheld | No. Allowing it allows a whole run nobody has seen |
| The browser tools | Act in the person's browser with their sign-ins | Withheld | Partly. A navigation is judgeable, but reading pages under the person's sign-ins is not one effect |
| The desktop tools | Control the person's machine, including typing into a terminal | Withheld | No. A click or a keystroke is not an effect a person can judge |
| Plan mode's tools | Planning turns only | As plan mode serves them | Not asked. A planning turn has no approvals |
| A tool added later | Unknown | Withheld until someone classifies it | |

Asking before a send to another channel does not wait inside the tool, since a tool that waits on a person holds the bridge, which is what this design avoids. The wrapper the channel puts around every installed tool ([`extensions.ts`](../../packages/channel/src/extensions.ts), lines 30-50) returns at once, telling the agent the message waits for the person, and puts the exact text and recipient on the same card. Allow sends it as the agent's message, Deny discards it, and the agent hears which on its next turn. No runtime waits on it, so it does not close with a turn; it stays open until a person answers it or stops the chat. Unattended sessions keep today's rule; the same principle gives them only what needs no asking, and widening them is not proposed here.

### Keeping a person's chat off the project checkout

Ace's rule is that no agent edits the project checkout, and pi's agents follow it by starting a lane, because the prompt tells them to. A runtime with its own tools has the `lane` tool withheld and is told to write where it is, so on a project it writes the checkout.

| Option | What it costs | How it meets the channel's sandbox |
| --- | --- | --- |
| **The host puts the chat on a lane of its own before its first turn that may write**, when the chat's folder is the checkout | A worktree and a branch for every chat that may write, including one that only answers questions. The host starts the lane itself, so the agent needs no tool. The session reopens on the new folder between turns. The chat's work reaches the project by the lane's own push, which Codex's sandbox cannot run, since it cannot write Git's folder; that limit holds on the checkout too | The ruling has the sandbox hold "the chat's worktree and what the image gives it, never the owner's sign-ins or the Records store" ([decision 12.28](../decisions.md#area-12-ace-style-pi-transition-28-october-2026)). A chat on its own lane has a worktree of its own to put there. When the sandbox exists, the worktree moves inside it and nothing changes for the person |
| Every write is asked while the folder is the checkout | A new row in the mode table, Codex's read-only sandbox with asking, where read-only today means a clean session and nothing asked. A card before every edit, which is the start-and-stop flow the owner ruled against. An allowed write still lands in the checkout | Undone when the sandbox exists, if the sandbox never holds the checkout |
| Writes are allowed and shown in the Diff tab | Nothing to build. It breaks Ace's own rule, mixes the agent's edits with the person's uncommitted work, and leaves the review range unclear | Kept only if the sandbox may hold the checkout |
| The agent's `lane` tool is served | Depends on the previous section. It rests on the prompt, as on pi, so the agent can skip it or switch into another chat's lane, and it runs outside the sandbox | The same as the first option once the lane exists |

The ruling says nothing about the checkout, and today a chat with no lane has the checkout as its folder ([`channel.ts`](../../packages/channel/src/channel.ts), lines 803-813). That the sandbox never holds the project checkout is this design's reading, from Ace's own rule that no agent edits it. That reading is what rules out the second and third options, so it is listed for the owner. The recommendation is the first option, for runtimes with tools of their own. The same host step could later replace the prompt rule on pi, so that every runtime meets the rule by code. That is put to the owner, because it changes how pi's agents name and switch lanes.

### What can be built now, and what waits

**Tonight, the round trip.** The bridge keeps a runtime's request open in a record of the chat, the channel records the answer, the app shows the card on the shared card shell, both answers reach the runtime, and a request closes with its turn or when the runtime resolves it.

**The switch that makes a chat attended for that build** is the stored fact above. The app's composer sends it, and the bridge opens a session `ask` when, and only when, all three hold: the chat is attended, the account's runtime declares tools of its own, and it declares approvals. Every other chat, and every chat driven from the command line or started by the host, opens `allow` exactly as today. The switch is honest only with three changes in the same build, because the policy value does more than ask today:

1. The tool boundary no longer depends on the policy. `transcript.ts` withholds Ace's tools from a runtime with tools of its own whenever it has them, not only under `allow`. Without this, `ask` would hand an attended Codex chat every Ace tool and decide the tool question by accident.
2. The text added to the prompt drops "while no one is attending", which would be false in an attended chat, and says only that these tools would run outside the sandbox.
3. The session key gains the policy, so the change reopens the session.

The chat's folder is not touched. An attended Codex chat on a project writes the checkout as it does today, and is asked only when it wants more than that. The visible effect tonight is that every Codex chat the owner writes in from the app becomes attended at its next session, and Codex asks there instead of failing what its sandbox refuses. Nothing about the checkout is decided by tonight's build, and the attended fact neither adds nor removes a tool.

**What waits for the owner.** Which of Ace's tools a person-driven chat is served, and how its chat stays off the checkout. Each is its own slice below.

## Build slices

Each is one implementer and one independent reviewer, with disjoint files. The channel's contract goes first and alone. The backend and the card then run side by side. The card waits for the shared card shell another lane is extracting from the question and review cards. Every slice that changes a file of the channel adds it to the channel's [upstream record](../../packages/channel/UPSTREAM.md).

| Slice | What it builds, and its files | Depends on | Replaces or consolidates | Done when, including the failures |
| --- | --- | --- | --- | --- |
| **The channel's contract.** Backend implementer. `packages/channel/src/protocol.ts`, `parse.ts`, `frame.ts`, and their entry in `packages/channel/UPSTREAM.md` | The message to the agent gains the attended field. One request answers a request: the chat, the request's id, the author, Allow or Deny. The request's record (its id, the call or work it is for, kind, what to show, who answered and how, or how it closed) as one schema the host and the app share. The document's portable definition. One event carrying a chat's requests, sent on attach and on every change. The comment on a run's "question" outcome widens to any wait on a person, so the needs-you mark needs no new value | Nothing | Follows the review cards' event, which is sent from a document the same way | A valid answer parses only with the request's id. One with no request id, with another decision, with an extra field, or naming no author is refused. An id that parses but names no request, and an id whose request is no longer open, are the round trip's to refuse, and its done-when tests both. The app and the host compile against it. No behaviour changes |
| **The round trip.** Backend implementer. `packages/channel/src/channel.ts`, `questions.ts` (its dismissal and needs-you mark moved into a helper both share), a new `packages/channel/src/approvals.ts` (the requests' event, the stored attended fact, the answer's rules), `plan-mode.ts` (which passes the attended fact to the bridge with each request, beside the mode), `packages/channel/UPSTREAM.md`, `apps/neuve-host/src/cli.ts` (its `ask` sends the field false), `packages/harness/src/chat-runtime/bridge.ts`, `transcript.ts`, `extension.ts`, `apps/neuve-cli/src/workspace-chat-runtime.ts`, `packages/runtime/src/contract.ts`, `packages/runtime-codex/src/session.ts`, and the tests beside them | The stored attended fact and its rules. The policy as above, with the three changes. The open record, its document and the bridge's closing of it. The answer's request with its author rules. The contract's event for a request the runtime resolved itself, and Codex emitting it. A file-change request that carries the change | The channel's contract | Moves the question's dismissal and needs-you mark into one helper both use, so there is one copy. Codex's withheld tools are unchanged | On a Codex chat a person drives from the app, a command that needs the network is asked, Allow runs it and Deny fails it, and the protocol log shows Codex's request and Neuve's answer for each. A file change outside the folder shows its change on the card. A request is closed when the turn ends, when the process is killed, when Stop is pressed, and when Codex resolves it itself, and the card says so each time, with no further step from pi. The bridge never holds for a request. A request raised while a question from the same turn waits is shown at once, and closes at once when the process is then killed. An Allow sent for a command after Codex has asked for wider permissions on the same item is refused, and the permissions request stays open. A person's message while it waits denies it and is delivered. An answer naming an unknown request id, an answer to a request that is no longer open, a second answer, an agent author, and a teammate the channel does not let ask its agents are each refused with the reason, and the session stays open. After a host restart every open request shows closed before anyone can answer it. A chat driven from the command line, a plan's agents, a planning turn, and a Claude Code chat never show a request, open `allow`, and run as today. An attended Codex chat is served exactly the tools an unattended one is. A person's steering message to a busy unattended chat is accepted, and the chat is attended from its next session. A chat driven from the app and then from the command line opens `allow` at its next session. |
| **The card.** Opus implementer ([decision 14.69](../decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026)). A new `apps/app/src/approval.tsx`, `apps/app/src/conversation.tsx` where the question card mounts, `apps/app/src/composer.tsx`; deletes `packages/ui/src/components/requests/approval.tsx` and its export in `packages/ui/src/index.ts` | The card on the shared shell for each kind of work, its waiting, allowed, denied and closed states, who answered, the read-only view for a teammate who may not answer, the needs-you mark, and the composer sending the attended field | The channel's contract; the shared card shell | Replaces the unused `ApprovalView`: its argument rows and its details disclosure move onto the card, and the file goes. No second card shape | Each kind and each state renders in light and dark. Allow and Deny send one request each and disable while it is in flight. A refused answer shows its reason on the card. Reload shows the same state. A closed request shows no buttons. `ApprovalView` is gone and nothing imports it |
| **Ace's tools in a person-driven chat.** Waits for the owner | The tool table above, and asking before a send to another channel, as a card that holds the message and does not wait inside the tool | The round trip; the owner's ruling | Replaces the one set of unattended tools with one set per class | Each tool behaves as its row says, attended and unattended, and a tool added later is withheld. A send to another channel returns at once, appears on the card with its text and recipient, is sent only on Allow, and is never sent after Deny or Stop |
| **Off the checkout.** Waits for the owner | The host starting a lane for a chat whose folder is the checkout, before its first turn that may write, and the prompt's lane text for that runtime | The round trip; the owner's ruling | Removes the contradiction between Ace's rule and the withheld-tools text | A Codex chat on a project never changes a file in the checkout. Its first writing turn runs in a new lane, and its Diff compares against that lane's base. A chat already on a lane is left alone |

## Evidence

The round trip is browser work, so its evidence must agree across kinds: Chrome DevTools MCP screenshots of the card in each state and kind, in light and dark and after a reload, with the browser console and network logs of the answer's request; the host's log and the bridge's log lines for each request and its close; and an excerpt of the Codex protocol log showing the request Codex sent and the answer Neuve returned, for Allow and for Deny. A test is needed where a missed case is silent: the author rules on the answer, the close on every way a turn ends, and that an attended chat is served no more tools than an unattended one.

## Still open for the owner

| Point | What is asked | Suggested |
| --- | --- | --- |
| Ace's tools in a person-driven chat | The principle and the table above | As recommended |
| Whether the channel's sandbox may hold the project checkout | Decision 12.28 names the chat's worktree and says nothing of the checkout. This design reads it as never holding the checkout, which rules out two options for keeping a chat off it | Never |
| Off the checkout | The four options above | The host puts the chat on a lane of its own before its first turn that may write |
| The same host step on pi | Whether it later replaces the prompt rule there, so every runtime meets "never edit the checkout" by code | Later, once it runs on Codex |
| Lasting answers | Every agent read offers "for this session" or "always" beside "once" | Not in the first build. Add "for this chat" if people meet the same request over and over |
| What makes a chat attended | That the app's composer marks a chat attended and the command line marks it unattended, as this design reads the rulings | As designed |
| Making an attended chat unattended from the app | A person leaving work to run overnight in a chat they drove | Later, as a control in the composer |
| The browser tools | Withheld, or served under the channel's existing switch for desktop tools | Withheld |
| Three words | The thing a runtime asks before one piece of its work, which "approval" would confuse with a disposition; attended and unattended; Ace's lane beside the review lane | The owner names them. The card says Allow and Deny either way |

**Settled from the owner's rulings.**

| Point | Settled as | From |
| --- | --- | --- |
| No limit on requests | No count, timer or coded stop | [Decision 14.59](../decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026) |
| Who answers | A person the channel lets ask its agents, never an agent | The planning design's rules, under [decision 14.57](../decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026) |
| Asking only at a need | Asked only beyond the sandbox; Claude Code chats stay `allow` | [Decision 14.54](../decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026) |
| Codex keeps its own tools behind its own approvals | The request is Codex's own | [Decision 14.70](../decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026) |
| The tool boundary tonight | Unchanged | [Decision 14.79](../decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026) |
| The card's implementer | Opus | [Decision 14.69](../decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026) |

## Not verified

Carried from the [Codex runtime proposal](codex-runtime.md#not-verified):

- What a request carries in a working turn, and what Codex's sandbox refuses in each mode.
- That Neuve's own tools are never refused or asked about by Codex, in each mode.
- Whether a call arriving at Neuve's tool server can be tied to Codex's own item for it.
- How Codex's sandbox and the channel's sandbox fit together once the channel's exists.

Added here:

- Which commands Codex asks about under "ask on request" with writes allowed in the folder, and whether it asks before a write outside the folder or only fails it.
- Whether Codex gives up on a request it is waiting on after some time of its own.
- Whether the file change can be read from the item Codex started before it asks, as the ACP adapter shows it.
- That the bridge can commit to a channel document while it reads a runtime's events, which it does not do today.
- Whether Codex in practice raises a request while one of Neuve's tools is running. The design does not depend on it.
- Whether the harness, which does not depend on the channel package today, may import the document's one definition, or the command line's workspace passes it in when it builds the bridge's extension.
- That a Codex chat's folder is the checkout when it has no lane. Read in `channel.ts`, not run.
- That the host can start a lane for a chat without the agent's tool.
- How a Codex chat's work becomes a commit, since its sandbox cannot write Git's folder, on a lane or on the checkout.
- Whether the browser tools sit under the channel's switch for desktop tools.
- That a granted permission ends with its turn on Codex's side. Neuve sends it scoped to the turn.
- What another server's prompt that asks for data does when it is accepted with empty content, as the runtime answers it today.
- Whether Codex's own shell can reach the host from inside its sandbox, which decides whether the pre-sandbox limit above applies to Codex's shell as well as to the person's own servers and hooks.
- The canonical sources were read by a search agent and not re-read line by line.

## References

| What the text rests on | Where |
| --- | --- |
| The owner's ask, and the boundary kept for now | [Decision 14.79](../decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026); the [Codex runtime proposal](codex-runtime.md#build-slices)'s slice "Approvals in the chat" |
| Codex's tools, approvals and sandbox per mode | [Decision 14.70](../decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026); the [Codex runtime proposal](codex-runtime.md#tools-codex-keeps-its-own-and-neuves-are-served-beside-them) |
| One set of tools above the contract, amended for Codex | [Decision 12.59](../decisions.md#area-12-ace-style-pi-transition-28-october-2026) |
| Where coding commands run; the sandbox holds the chat's worktree | [Decisions 12.28 and 12.58](../decisions.md#area-12-ace-style-pi-transition-28-october-2026) |
| One design for every channel; running before the sandbox | [Decision 14.57](../decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026) |
| No cap or gate on agents; people are asked at needs | [Decisions 14.54 and 14.59](../decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026) |
| Who may change a chat's mode and approve a plan; roles stored on the chat; asking the person | The [planning mode proposal](planning-mode.md) |
| Codex touches no frontend code | [Decision 14.69](../decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026) |
| The runtime contract | [Record 0017](../../architecture/decisions/0017-runtime-contract-and-accounts.md), the runtime contract and accounts; [`contract.ts`](../../packages/runtime/src/contract.ts) |
| Codex's protocol facts | The runtime package's [table of protocol facts](../../packages/runtime-codex/PROTOCOL.md) |
| Approval, disposition, review lane, sandbox, thread | [Vocabulary](../../vocabulary.md) |
