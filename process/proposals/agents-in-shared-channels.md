# Agents in shared channels: proposal

Status: proposal, drafted 23 November 2026 from the owner's conversation with the coordinator that day, and revised the same day for the owner's eighth answer. Nothing here is built. The owner's first answer accepted the narrow folders, the seventh decides where the reviewer's behaviour lives, and the eighth decides where a shared channel's agents run; the rest is proposed. The [decisions record](../decisions.md) wins wherever this text differs from it. Code was read at `f1db36e`; no program was run to write this.

**What is decided.** A shared channel's agent loop, its tools and its durable session run inside the channel's shared sandbox on the tailnet. Model calls and Git pushes leave through the broker, which swaps in the key or token on the way out, so no credential enters the sandbox. Neuve's own steps (the scope read and reviews) run outside with the Records store and read the branch the broker pushes.

**What is proposed on top.**

1. Inside that sandbox, each agent has an isolate of its own: its own clone, which it owns entirely. Only a branch leaves, with its proof.
2. Reviewers get isolates of their own and a fresh context. The final review judges the code and its proof, with instructions the host writes from the approved plan.
3. Whether the narrow Git folders are the lasting design or a stopgap follows from the first point, and is the owner's choice.

**Words.** _Isolate_ is the owner's word for one agent's isolated place; the [vocabulary](../../vocabulary.md#runtime) defines a sandbox per channel and has no word for a place per agent. _The host_ means Neuve's process outside the sandbox that holds the Records store and runs Neuve's own steps: Neuve's host on a person's device, and the process the decisions call the channel worker in a shared channel. _Member_ means a person in a channel. _Proof_ is the observed evidence a [validation requirement](../../vocabulary.md#responsibility-and-review-flow) asks for. _Final review_ is the review after the [inner development loop](../../vocabulary.md#responsibility-and-review-flow) approves. A chat's _work lane_ is the worktree and branch it works on. Isolate, host, member, channel, proof and final review have no vocabulary rows; see [Still open](#still-open-for-the-owner).

## The owner's words, 23 November 2026

| On                                                                                                                                                          | The owner's words                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | What follows                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What a Codex agent may write                                                                                                                                | "it can be as you recommend, but I'd like you to think or dispatch an agent (can be opus) to research on how harnesses like this one (claude code), codex, opencode and t3code do. We have an extra complication where shared channels need to run on a centralized sandbox within the tailnet for all channel participants to be able to have the agent running tasks in a secure environment."                                                                                                     | The narrow folders were accepted as recommended, subject to research                                                                                                   |
| The narrow folders, after the research                                                                                                                      | "my question to you is...do we need to narrow as much as this, or are we creating a problem for ourselves? Or on the other side of this, is this the right restriction? OR should we instead limit the agents to only the host's or in some form of coordination / orchestration scheme with each members' agents spawning their own sandboxes / worktrees to then collaborate on merging into a branch? Do you see my point. The frame of reference is, are we using the right principle / design?" | This proposal answers the question of principle                                                                                                                        |
| Every remote product cloning into a machine that is thrown away and returning a branch                                                                      | "yes, that is what the channel is for, right. Though not on a 'cloud machine' but on a sandbox for us."                                                                                                                                                                                                                                                                                                                                                                                              | The channel returns a branch                                                                                                                                           |
| How the host safely takes a branch back                                                                                                                     | "taking that the work is done in the channel, won't it be collectively reviewed? Or rather the host for the shared channel can run the final reviewer and have a specific instruction to watch for potential risks? But also, we can assume that people on a shared channel are trusted, though attacks can hijack their sessions, thus the final review specific instructions on shared sessions. Not just for risks but cohesion and adherence to the plan."                                       | The owner's suggestion: members are trusted, their sessions may be hijacked, and the host's final review has instructions for risk, cohesion and adherence to the plan |
| What an agent did while running                                                                                                                             | "that won't matter, the code being reviewed is what we need. We can also make it so any recorded validation record (as in screenshots or videos and logs if any exists) is also part of the shared artifacts."                                                                                                                                                                                                                                                                                       | Review judges the code that leaves and its proof. Proof is shared with the channel                                                                                     |
| The reviewer reading the same untrusted material                                                                                                            | "Reviewers need a fresh and independent context anyways, so we can run it in its own isolate too. It needs to be adversarial and 'trust but verify', and needs its own safeguards, guidelines and guardrails."                                                                                                                                                                                                                                                                                       | Reviewers get isolates of their own. The safeguards' content is the owner's to approve                                                                                 |
| Where the reviewer's safeguards live                                                                                                                        | "The shipped skill should be our main tool as we need to also serve the standalone neuve offering." Then: "The harness offers extra tools such as the reviewer's own isolate and more advanced guardrails and standardized tools, but the core of the behaviour should be in the skill"                                                                                                                                                                                                              | Decided. See [Where the reviewer's behaviour lives](#where-the-reviewers-behaviour-lives)                                                                              |
| The loop inside the shared sandbox, credentials outside behind the broker, Neuve's steps outside, Ace's five served tools inside as a user no agent runs as | "As recommended"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Decided. See [What the eighth answer decides](#what-the-eighth-answer-decides)                                                                                         |

## At a glance

```
 THE CHANNEL'S SHARED SANDBOX ON THE TAILNET                         OUTSIDE THE SANDBOX
 ───────────────────────────────────────────                         ───────────────────
 ┌ implementer isolate ┐ ┌ implementer isolate ┐ ┌ inner-loop      ┐   THE BROKER
 │ agent loop + tools  │ │ agent loop + tools  │ │ reviewer isolate│   swaps in model keys and the
 │ its own clone:      │ │ its own clone       │ │ its own clone,  │   push token on the way out
 │ hooks, settings,    │ │                     │ │ plants a problem│
 │ its branches        │ │                     │ │ fresh context   │   THE HOST (channel worker)
 └──────────┬──────────┘ └──────────┬──────────┘ └────────┬────────┘   Records store, approved plan
            │ model calls, branch + proof push            │           scope read on the pushed branch
            └───────────────────────┬─────────────────────┘           final review, read only:
 Ace's five served tools run here   │                                 verdicts to the store;
 as a user no agent runs as         └──▶ broker ──▶ pushed branch ──▶ human-required units to a person
 THE CHANNEL: threads, the work log and the plan are where agents coordinate; its branch is where they integrate
```

## What the eighth answer decides

The [2 November ruling on where coding commands run](../decisions.md#area-12-ace-style-pi-transition-28-october-2026), which keeps sign-ins and the Records store out of the sandbox, and the [9 November ruling on shared sessions](../decisions.md#area-12-ace-style-pi-transition-28-october-2026), which puts the whole runtime in a sandbox on the tailnet, hold together. Three things are new:

- The broker, which already answered Git only for the chat's own repository, now also carries model calls and swaps in the key. A loop runs inside without its key inside.
- Neuve's own steps run outside with the store, and read the branch the broker pushes. That is the mechanical guard for taking a branch back: no Neuve step runs Git in an agent's copy.
- Ace's five served tools (asking a question, writing the plan, answering a plan comment, asking for another agent, messaging an agent) change only channel state, and run inside the sandbox as a user no agent runs as.

The ruling also closes two of the owner's earlier options for a shared channel. A placement on each member's own device would run a channel's agents on a member's machine, which both rulings forbid. "Only the host's" is the same placement with one member. What survives of "each members' agents spawning their own sandboxes" is an isolate per agent inside the shared sandbox, whoever started the agent. A channel with one person still runs on that person's device, by the 2 November ruling.

## Why the narrow folders exist, and the principle

On a person's machine today, each agent's work lane is a linked worktree of the owner's repository. Its Git folder is the owner's: the objects, every branch, the hooks, the Git settings and Neuve's store ([`location.ts`](../../packages/records-core/src/location.ts), line 22). Codex's sandbox keeps that folder read only, so a Codex agent cannot commit. Its source gives the reason: a Git folder "could be modified to escalate the privileges of the agent", because hooks and settings run outside the sandbox the next time anyone runs Git (Codex `protocol.rs`, lines 1343–1347, read by the research lane).

The narrow folders open the worktree's index, new objects and the channel's own branches, and nothing else. They let a commit through and keep hooks, settings, `main` and the store shut. An agent can still delete object files and damage any branch's history.

Each of those patches answers the same problem. The agent's place shares a Git folder with things others trust. If the agent has its own clone and nobody else runs Git in it, its hooks and settings run only for the agent itself, so writing them harms only its own copy (inferred).

**The principle, proposed.** An agent owns everything inside its isolate. Only a branch leaves, with its proof. Trust is checked where the branch comes back, by review. What must stay trustworthy (credentials, Neuve's store) is never inside.

The cloud products the ruling followed work this way, as far as their documentation shows. Claude Code on the web gives each session a fresh machine and a fresh clone; Git goes through a proxy that swaps a stand-in for the real token, the agent pushes a branch, and the person opens the pull request. The proxy refuses branch deletion and tag pushes but does not limit which branches a push updates. Codex cloud checks the repository out in a container or machine, gives secrets only during setup or as stand-ins a proxy fills in, and returns a diff or a pull request the person reviews; who pushes, and whether a token is inside, is not documented. Both treat the machine as the boundary rather than a sandbox inside it (inferred).

## One isolate per agent inside the shared sandbox, or one clone per channel

The ruling fixes the sandbox; it does not say what each agent gets inside it. The return session's research recommends one clone per channel with a work lane per agent and the narrow folders inside, the same layout as on a device. This proposal puts a clone per agent instead. Both keep credentials and the store outside and push only through the broker.

|                                  | One clone per channel, a work lane per agent, narrow folders (the research's recommendation)                                                            | An isolate per agent: its own clone and its own sandbox user (this proposal)                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| What an agent may write          | Its work lane's index, new objects, the channel's branches                                                                                              | Everything in its own clone, hooks and settings included                                                                                            |
| What still needs guarding        | Object files any agent can delete; every non-agent Git call in the shared clone                                                                         | That nobody but the agent runs Git in its clone                                                                                                     |
| Codex's own sandbox              | Required, inside the container. Codex on Linux uses bubblewrap, which often needs privileges a container lacks; the narrow set was probed only on macOS | Not required: Codex may run with full access, the isolate being the boundary, as the cloud products appear to                                       |
| One agent reading another's work | Shared objects, no fetch                                                                                                                                | Only pushed branches; the inner-loop reviewer fetches the implementer's branch                                                                      |
| Disk and start time              | One clone                                                                                                                                               | A clone per agent, unless clones borrow objects read only                                                                                           |
| The same design on a device      | Yes, as being built now                                                                                                                                 | A local clone per agent, which confines only Codex: pi and Claude Code agents there run with no OS sandbox and commit as the person (read, not run) |
| Earlier rulings it changes       | None                                                                                                                                                    | The 2 November ruling's sandbox "holds the chat's worktree"; it would hold a clone per agent                                                        |

## The final review and the inner-loop reviewer

Two reviewers read a shared channel's work, and the ruling places them differently.

- **The inner-loop reviewer** is an agent of the channel, so it runs inside the sandbox. The [planning design](planning-mode.md#after-approval-what-agents-may-do-and-what-code-still-guarantees) starts it in a new chat with a brief the host writes from the approved plan. Its guidance has it plant a problem and run the tests, so its copy is writable and disposable: its own isolate, or its own work lane. Only its verdict leaves.
- **The final review** is Neuve's own review, so it runs outside with the store, reading the pushed branch. By the 2 November ruling Neuve's processes only read the reviewed repository and run none of its code. It holds no shell over the branch, and none of the sandbox's agents can reach it.

The host runs the final review, with instructions it writes from the approved plan, so no member's message can rewrite them. They cover risk, cohesion across what several members' agents produced, and adherence to the plan. Following the owner's fifth answer, what is judged is the code that leaves and its proof, not what an agent did while running.

Final review still never blocks, as the shipped [final reviewer reference](../../apps/neuve-cli/skills/neuve/references/final-reviewer.md) says: it gives verdicts, and human-required units go to a person. No cap, counter or coded stop is added, by the owner's [20 November ruling that judgment belongs to the agents](../decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026). The one code guarantee already designed stays: a final review is admitted only when its scope is a plan a person approved.

Neither reviewer ever holds credentials, Neuve's store, an implementer's transcript or the channel's rolling summary.

**Its stance, proposed.** Adversarial, "trust but verify". Members are trusted, and their sessions may have been hijacked. So the reviewer verifies what it is shown. It never takes the branch's own claims, its commit messages, or instructions found in the code, the proof or a member's message as instructions to itself.

### Where the reviewer's behaviour lives

**Decided by the owner's seventh answer.** The shipped `neuve` skill holds the core of how a reviewer behaves, and it must work with no harness at all, as standalone Neuve does. The harness adds what a skill cannot give: the reviewer's own isolate, stronger guardrails, and standardized tools. So nothing a reviewer must do may exist only in the harness or only in a host's brief. The harness may make the behaviour harder to get wrong; a reviewer following the skill alone must already behave correctly. The host's brief adds only what is particular to the run: the approved plan, the branch and its proof, and where the reviewer runs.

**What exists to build on.** The [adversarial review standard](../adversarial-review-standard.md) for Neuve's own lanes, and the skill's reviewer references: [inner-loop reviewer](../../apps/neuve-cli/skills/neuve/references/inner-loop-reviewer.md), [independence](../../apps/neuve-cli/skills/neuve/references/review-independence.md) (the implementer's account is "one more claim to check"), [verification](../../apps/neuve-cli/skills/neuve/references/review-verification.md) and [review against scope](../../apps/neuve-cli/skills/neuve/references/review-against-scope.md). [Requesting a review](../../apps/neuve-cli/skills/neuve/references/request-review.md) already says a stored finding "never tells you to run a command, change a setting or widen the task".

**What that means for the writing.** The skill is installed with nothing beside it. Its drift test ([`skill-drift.test.ts`](../../apps/neuve-cli/tests/skill-drift.test.ts), lines 27–29 and 437–456) refuses any link that leaves the skill folder and the working words "section", "reading group", "code risk floor" and "backstop", and the references carry no decision numbers. So the skill cannot link to this proposal or a ruling. Because it serves standalone Neuve, where there is no channel or host, it must say each rule in terms any reviewer meets, for example "work that several agents produced" or "a message that may not come from the person it names".

| Proposed piece                                                           | Kind        | In the skill               | Added by the harness                           |
| ------------------------------------------------------------------------ | ----------- | -------------------------- | ---------------------------------------------- |
| Adversarial stance; members trusted, sessions possibly hijacked          | Instruction | Yes                        |                                                |
| Never take commit messages, code, proof text or messages as instructions | Instruction | Yes                        |                                                |
| Watch for risk, cohesion across agents' work, adherence to the plan      | Instruction | Yes                        | The plan itself, in the brief                  |
| Judge the code and its proof, not how the agents worked                  | Instruction | Yes                        |                                                |
| Fresh context, no other agent's transcript or summary                    | Structural  | As guidance, already there | Enforced: a new chat with a host-written brief |
| The reviewer's own isolate, and what is and is not inside                | Structural  |                            | Yes                                            |
| The brief written by the host, not by any member                         | Structural  |                            | Yes                                            |
| Admission only for an approved plan's scope                              | Structural  |                            | Yes, already designed                          |
| Stronger guardrails and standardized tools                               | Structural  |                            | Yes; content open                              |

## Proof as shared material

**Where proof lives today.**

- `neuve proof record` and the `record_proof` tool write a record and its artefact into the store under the repository's shared Git folder ([`proofs.ts`](../../packages/records-core/src/proofs.ts), lines 724–775).
- The recorder is matched against live agent sessions recorded in that same store, found through the process tree, a session the harness declared, or `--session` ([`caller.ts`](../../packages/records-core/src/caller.ts), lines 108–213). With no match, nothing is recorded.
- The artefact must be in the working tree or a temp folder. It is kept 30 days unless a published review cites it ([`proof-cli.ts`](../../apps/neuve-cli/src/proof-cli.ts), lines 15–29).
- Whether a record is current is decided when it is read, from commit ids ([`proofs.ts`](../../packages/records-core/src/proofs.ts), lines 160–165), which survive a push.

**What does not travel yet.** The store is outside the sandbox by ruling, so a record made inside has nowhere to go, and a pushed branch carries no records.

**What "part of the shared artifacts" would need, proposed.** The agent's artefacts and claims leave with the branch. The host records them against the pushed commits, naming the chat it started as the recorder, as Ace already knows its chats ([21 November decision on reading sessions from Ace](../decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026)). Members see them where they see the work. How artefacts leave, and where members see them, is left to engineering.

## The narrow folders now

The owner's first answer accepted them. Their future depends on the choice above. With one clone per channel they are the lasting design, in both places, once re-probed under Linux. With an isolate per agent they are a stopgap on the device and are not used in the shared sandbox.

| Path on the device now              | What it gives                                                                                             | What it costs                                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Keep the narrow folders             | Codex agents in the inner development loop commit now, at four paths and one host step for the scope read | An agent can delete object files                                                                               |
| Replace them with a clone per agent | The isolate's shape now                                                                                   | Replaces how Ace makes a work lane, confines only Codex locally, and Codex agents cannot commit until it lands |

The host-run scope read is needed either way.

## Still open for the owner

- **One clone per channel or an isolate per agent** inside the shared sandbox, and with it whether the narrow folders are lasting or a stopgap.
- **Whose account a shared channel's turns run on.** The ruling keeps every key out of the sandbox; whose key the broker swaps in is still the open question of the 9 November ruling. The return session's research suggests the member who approved the plan, never a value an agent passes.
- **Whose name authors an unattended agent's commit.** The member who started the work, the one who approved the plan, or the bot account the owner plans ([23 November](../decisions.md#area-15-an-overnight-round-with-the-owner-away-23-november-2026)).
- **Which branches the broker may push.** Only the channel's own, or any. Claude Code's proxy leaves this to branch protection.
- **What the final review's "own isolate" means**, now that the ruling places reviews outside with the store. This proposal reads it as a fresh context, the pushed branch read only and no shell over it. Whether the review's model reads also run in a process apart from the worker that writes records is the owner's call.
- **The reviewer's safeguards, guidelines and guardrails.** Their content is the owner's to approve. Where they live is decided: in the skill.
- **Vocabulary.** Isolate, host, member, channel, proof and final review have no rows. The sandbox row places a shared channel's sandbox "in the cloud", where the 9 November ruling and the owner's third answer place it on the tailnet.

## Not verified

Everything here was read, not run.

- That an agent-owned clone's hooks and settings harm only that agent, when nobody else runs Git in it.
- That Codex's own sandbox runs inside the shared sandbox's container, and that the narrow set works under Linux's bubblewrap.
- That the final review's model reads can run apart from the worker that writes records, and whether Neuve's review takes run-specific instructions today; nothing in [`workspace-native-review.ts`](../../apps/neuve-cli/src/workspace-native-review.ts) does.
- How the host receives a branch the broker pushed from a sandbox on the tailnet. No code does this.
- Who pushes from Codex cloud, and who authors Claude Code on the web's commits.
- Whether a working agent's read of the plan file checks the plan's hash.

## References

| What the text rests on                                                               | Where                                                                                                                                 |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Where coding commands run; the vault and broker; the credential guard and authorship | [Decisions of 2 November 2026](../decisions.md#area-12-ace-style-pi-transition-28-october-2026), rows 12.28 to 12.30                  |
| Shared sessions on the tailnet, hosting the whole runtime                            | [Decision of 9 November 2026](../decisions.md#area-12-ace-style-pi-transition-28-october-2026), row 12.58                             |
| No caps or coded gates; judgment belongs to agents                                   | [Decision of 20 November 2026](../decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026), row 14.59 |
| The guarantees after approval; one design for every channel                          | [Planning mode proposal](planning-mode.md#after-approval-what-agents-may-do-and-what-code-still-guarantees)                           |
| How the four harnesses confine agents; Claude Code on the web and Codex cloud        | The agent sandbox research lane's findings and the return session's sandbox research, 23 November (not committed)                     |
| What a commit writes under Codex's sandbox, and the narrow set                       | The Codex commit lane's findings of 23 November (not committed)                                                                       |
| Sandbox, broker, work log, validation requirement, work lane                         | [Vocabulary](../../vocabulary.md)                                                                                                     |
