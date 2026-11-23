# Sessions in Ace: proposal

Status: proposal, drafted 23 November 2026. Nothing here is built. It designs how Neuve, inside Ace, gets what it needs about agent sessions from Ace's own records instead of from capture hooks. The [decisions record](../decisions.md) wins wherever this text differs from it. Code was read at `97c8b54`; no program was run to write this.

> "once in Ace, neuve does not have to capture sessions as ace will have it all. We will have same as t3code and opencode, all session information (toolcalls, messages, results) in the main session channel or threads. Neuve can just tap into it as it is, or will be, deeply integrated. So, standalone neuve...sure, but neuve in ace will not do that."
>
> The owner, 21 November 2026, recorded as [decision 14.80](../decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026), which adds, on recovering what capture missed: "no backfill, please...don't overthink"

**Words.** _Capture_ here means what `neuve setup hooks` installs: agent hooks in the person's Claude Code and Codex configuration, and Git hooks in the repository. _Standalone_ means a person running Claude Code or Codex directly, outside Ace. An _agent session_ is one run of such a program as capture records it. _Chat_ is Ace's implementation word for one conversation of a channel, whether a person writes in it (a [thread](../../vocabulary.md#comments-and-threads)) or an agent works in it (a subagent, or a plan's agent read on the work log). Capture, standalone, agent session and chat are not in the [vocabulary](../../vocabulary.md), and are listed for the owner under [Still open](#still-open-for-the-owner).

## At a glance

```
 STANDALONE (unchanged)                        IN ACE (proposed)
 ──────────────────────                        ─────────────────
 Claude Code or Codex                          Ace chat on pi, Claude Code or Codex
   │ agent hooks                                 │ Ace keeps every message, tool call, result,
   ▼                                             │ model and usage in the channel's store
 spool, then worker, into the                    ▼
 repository's Records: session,                channel worker retires: Neuve's workspace files
 turns, transcript, tokens                     a session dump (built today)

 git commit                                    git commit from a chat's shell
   │ post-commit hook                            │ the same post-commit hook, still the one writer
   ▼                                             ▼
 actor = the live session whose                actor = the channel whose worker is the nearest
 process is the nearest ancestor               ancestor, narrowed to the chat Ace named

                                               Codex write turn with the person's hooks loaded
                                                 │ Neuve's agent hook finds its Codex process
                                                 │ on Ace's list of Codex processes
                                                 ▼
                                               records nothing
```

1. **Nothing new copies a session.** Ace already holds each chat's full record, and Neuve's workspace files a session dump of the channel when its worker retires ([`workspace-cli.ts`](../../apps/neuve-cli/src/workspace-cli.ts), lines 472–525). Neuve reads that dump after the run.
2. **Today an Ace Codex chat can be captured as well.** A Codex write turn runs on the person's own Codex configuration, whose hooks load ([`launch.ts`](../../packages/runtime-codex/src/launch.ts), lines 56–72 and 120–140; [`PROTOCOL.md`](../../packages/runtime-codex/PROTOCOL.md), line 96). In a repository set up for capture, Neuve's Codex hook would then record the chat. Whether its write lands from inside Codex's sandbox was never observed, so the first slice reproduces it before fixing it.
3. **Commits stay with the Git hooks.** Ace names the channel and chat; the hook records the commit as it does now. The owner decides this point.

## What capture serves today

Agent hooks turn each session and turn edge into events in a spool file and never open SQLite ([`agent-hooks.ts`](../../apps/neuve-cli/src/capture/agent-hooks.ts), lines 159–360; [`hook-cli.ts`](../../apps/neuve-cli/src/capture/hook-cli.ts), lines 34–49). They also keep small live-session files, each naming the agent process that owns the session ([`sessions.ts`](../../packages/records-core/src/sessions.ts), lines 1–30). Git hooks record each commit ([`git-hooks.ts`](../../apps/neuve-cli/src/capture/git-hooks.ts), lines 135–174). A hook acts only where the repository's common Git directory holds `neuve/capture.json` ([`hook-main.ts`](../../apps/neuve-cli/src/hook-main.ts), lines 25–65).

| Use | How it works today | Who reads it |
| --- | --- | --- |
| A commit's author is the agent session that made it | The `post-commit` hook walks up the process tree to the nearest process a live-session file names as owner. With none, the person in the Git configuration is the actor. When the process table can't be read, a session ID the harness set in the environment may name a live session ([`caller.ts`](../../packages/records-core/src/caller.ts), lines 108–213; [`git-hooks.ts`](../../apps/neuve-cli/src/capture/git-hooks.ts), lines 41–125) | The commit projection and each actor's commit count ([`projectors.ts`](../../packages/records-core/src/projectors.ts), lines 410–430), listed by `neuve agents` ([`actors.ts`](../../packages/records-core/src/actors.ts), lines 21–72) |
| A `neuve` command knows which session called it | The same caller resolution | Review and query requests name their requester ([`request.ts`](../../packages/harness/src/request.ts), lines 285–299); a proof or a vent is linked to the session and its open turn, or refused as unlinked ([`proofs.ts`](../../packages/records-core/src/proofs.ts), lines 740–770; [`vents.ts`](../../packages/records-core/src/vents.ts), lines 150–180) |
| Background preparation at a turn's or session's end | The one job these events queue is `transcript.capture` ([`jobs.ts`](../../packages/records-core/src/jobs.ts), lines 37–48). It copies the transcript's new bytes into a raw-capture blob, summarizes them, and records `turn.summarized` with token counts ([`transcripts.ts`](../../packages/records-core/src/transcripts.ts), lines 33–45 and 1080–1192) | Token, call and tool totals per actor ([`projectors.ts`](../../packages/records-core/src/projectors.ts), lines 87–104), shown by `neuve agents` |
| Graded transcripts become dataset entries | Not built. The [transcript rulings](../decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026) of 19 November set a 5 GiB cap and require analysis, grading and labelling before a transcript moves into a dataset. Raw captures still expire after 30 days ([`retention.ts`](../../packages/records-core/src/retention.ts), lines 21–26) | Nothing yet |

Two corrections to the brief's list. Agent hooks do not queue commit preparation: the Git hook's `commit.recorded` event does ([`jobs.ts`](../../packages/records-core/src/jobs.ts), lines 22–28), and that job reads the commit, never its actor. Capture also serves proofs, vents and requesters, which the brief did not name.

## What Ace already keeps

| Where | What it holds | How long |
| --- | --- | --- |
| The channel's pi store, `channel.sqlite` in the channel's folder ([`catalog.ts`](../../apps/neuve-host/src/catalog.ts), lines 102–114) | Every chat of the channel: each message with its author, a person's name or `agent@<chat>` for an agent ([`room.ts`](../../packages/channel/src/room.ts), lines 20–66); each assistant message with its time, model and usage ([`channel.ts`](../../packages/channel/src/channel.ts), lines 1761–1800); tool calls and results; a subagent's chat, owned by its parent's task ([`agents.ts`](../../packages/channel/src/agents.ts), lines 33–80); which chat holds each lane, with its worktree and base ([`lanes.ts`](../../packages/channel/src/lanes.ts), lines 15–30) | Until the channel is deleted; archiving keeps it ([`catalog.ts`](../../apps/neuve-host/src/catalog.ts), lines 372–377; [`manage.ts`](../../apps/neuve-host/src/manage.ts), lines 205–210) |
| The same store, for a Codex chat | Codex's own commands, file changes and searches, each recorded as a `runtime_work` call that already ran, with its input, output and whether it failed ([`bridge.ts`](../../packages/harness/src/chat-runtime/bridge.ts), lines 1197–1222), and usage per turn (line 1166) | As above |
| The same store, for a Claude Code chat | Claude Code runs with none of its own tools and calls Ace's through Neuve's tool server, so its tool calls are ordinary calls in the transcript ([`session.ts`](../../packages/runtime-claude/src/session.ts), lines 1058–1092) | As above |
| The capture journal, `capture/` in the channel's folder | The coding run's start, each chat's binding, provider calls on pi's routes, full shell output, Linear calls ([`workspace-cli.ts`](../../apps/neuve-cli/src/workspace-cli.ts), lines 187–213, 410–415 and 436–469) | Filed with the dump |
| The session dump, filed when the channel's worker retires | One file per chat with its entries, tasks, parent, owning task, binding, and turns with model, tokens, cost, times and tool calls; pi's native backup and the raw journal beside them ([`dump.ts`](../../packages/harness/src/pi/capture/dump.ts), lines 19–29, 143–198 and 406–452). It is filed under a key of its contents, so one snapshot is filed once ([`raw.ts`](../../packages/harness/src/pi/capture/raw.ts), line 221) | A 30-day raw capture ([`raw.ts`](../../packages/harness/src/pi/capture/raw.ts), line 125) in the workspace's coding store, not the repository's ([`workspace-cli.ts`](../../apps/neuve-cli/src/workspace-cli.ts), line 509) |
| Codex's protocol log, `<account>-protocol.jsonl` in the channel's folder | Every protocol line each way, redacted, with Codex's own work kept whole; chats running at once are told apart by a per-session label ([`runtimes.ts`](../../packages/harness/src/runtimes.ts), lines 108–131; [`log.ts`](../../packages/runtime-codex/src/log.ts), lines 1–8) | Removed with the channel |
| Claude Code's own session file | Claude Code keeps its session for resume (`persistSession: true`), from a working folder Neuve sets ([`session.ts`](../../packages/runtime-claude/src/session.ts), line 1092; [`runtimes.ts`](../../packages/harness/src/runtimes.ts), lines 48–49) | Claude Code's own rules; not read |
| The channel's run notice | Each run's end: the chat, the time, the outcome and the person who asked, pushed to the host as it happens ([`channel.ts`](../../packages/channel/src/channel.ts), lines 842–863; [`protocol.ts`](../../packages/channel/src/protocol.ts), lines 37–46) | The host keeps only the latest ([`catalog.ts`](../../apps/neuve-host/src/catalog.ts), lines 300–302) |

This is the record the ruling describes. The [pi capture boundary](../../architecture/decisions/0014-ace-style-pi-harness.md#captures-and-evaluations) already places it: "Native capture stays inside each runtime", and Records "does not mirror or schedule live pi tasks". Only `neuve workspace` supplies the channel worker with the close step that files the dump ([`workspace-cli.ts`](../../apps/neuve-cli/src/workspace-cli.ts), lines 582–583), and that command is not in a release yet ([`cli.ts`](../../apps/neuve-cli/src/cli.ts), line 33).

## What is missing for those uses

| Fact | In Ace's records? |
| --- | --- |
| Which chat made a commit | **Not carried.** The lane record says which chat last took a worktree, not which commits it made. Cheap to carry: the channel builds each chat's shell environment knowing the chat ([`channel.ts`](../../packages/channel/src/channel.ts), lines 305–317), and Codex's environment is built per session ([`launch.ts`](../../packages/runtime-codex/src/launch.ts), lines 188–202) |
| Which chat called a `neuve` command | Not carried, and cheap the same way. Ace's own review path already names the chat as requester, with the harness `neuve-pi`, the channel as session and the chat as subagent ([`workspace-native-review.ts`](../../apps/neuve-cli/src/workspace-native-review.ts), lines 274–284) |
| Turn edges and timings | Partly. Assistant messages carry their time, the dump adds call times where the journal joined, and Codex's protocol log has every line's time. A durable start and end per run is not in the dump as read. The runtime contract reports both with a time ([`contract.ts`](../../packages/runtime/src/contract.ts), lines 192–198 and 330–334), so the dump could carry them cheaply when a dataset needs them |
| Parent of a subagent | **Carried**: the child chat is owned by its parent's task, and the dump keeps that owner |
| Who asked for the work | **Carried**: each message's author, and the run notice's author |
| Model, tokens, tool calls, results | **Carried**, per assistant message and per chat |

## How Neuve reads them

| Option | What it costs | What it breaks |
| --- | --- | --- |
| Open `channel.sqlite` from a Neuve process | A second reader of pi's private schema | The store has one owner, which also holds the credential inspection ([`workspace-cli.ts`](../../apps/neuve-cli/src/workspace-cli.ts), lines 278–352). A live read means polling, which [shared work](../../architecture/decisions/0016-shared-work.md) forbids |
| Ask the host, live | A subscription per channel and a Records writer for each turn | Copies every turn into Records beside Ace's own copy, which the pi capture boundary rules out |
| Ace writes the hooks' events itself at each turn | A new writer, and a transcript reader for pi | Two stores of one session. The transcript job reads only the transcript its session named when it started ([`transcripts.ts`](../../packages/records-core/src/transcripts.ts), lines 74–80), so it would need a pi reader too |
| **After the run, from the session dump** (recommended) | Nothing to build for transcripts: the dump is filed today, once per snapshot | Facts arrive when the worker retires, not live. None of the uses above needs them sooner, but a worker that never retires never files its dump, so a channel left running has none until it does. The dump is in the coding store, so the dataset work reads there |

**Recommendation.** Neuve reads Ace's sessions after the run, from the session dump it already files. Live, it needs two names from Ace and no copies: which channel and chat a process works for, so commits and `neuve` commands are attributed, and which Codex processes Ace started, so capture records nothing for them.

## Commit attribution

The ruling does not mention commits, and [decision 14.80](../decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026) leaves them open. Git runs the hooks of the repository's common hooks folder, where setup writes them ([`setup-hooks.ts`](../../apps/neuve-cli/src/capture/setup-hooks.ts), lines 693–696), and a lane is a worktree of that repository ([`lanes.ts`](../../packages/channel/src/lanes.ts), lines 150–160). So, reasoned from the code and not run, the standalone `post-commit` hook records an Ace chat's commit, and the attribution is wrong rather than missing. No live session owns Ace's processes, so the person in the Git configuration becomes the actor. If the Ace host was started from inside a standalone Claude Code or Codex session, ancestry reaches that session instead. If Codex's own hook registered an Ace Codex chat, its thread is the actor, not the chat.

| Option | How | Cost | Breaks |
| --- | --- | --- | --- |
| **The Git hook records, Ace names the chat** (suggested) | Each channel worker writes a live-session file for the channel, owned by the worker's process, in the folder hooks use for live sessions ([`sessions.ts`](../../packages/records-core/src/sessions.ts), lines 23–30 and 200–215). Ancestry finds it as it finds any session, nearest first, as today. Ace also sets a variable naming the channel and chat in each shell and runtime process it starts for a chat; resolution takes the chat from it only when it names a chat of the channel ancestry found | A file written at the worker's start and removed at its close; one variable; one rule in caller resolution; one identity for a chat | Nothing. One writer per commit, as today |
| Ace records its own commits | At each turn's end Ace compares the chat's worktree head and writes `commit.recorded` | A new writer and a head comparison | The hook writes the same key, and two writers with different content are refused as a conflict ([`log.ts`](../../packages/records-core/src/log.ts), lines 245–262). The hook would have to stay silent in Ace's worktrees, which needs the first option's live file anyway |
| Leave it | Nothing | None | Every Ace commit stays misattributed |

The suggested option keeps the [declared-link decision 8.13](../decisions.md#area-8-records-rebuild-m2-17-october-2026), which puts ancestry first: the worker is a nearer ancestor than any session outside Ace, and a standalone agent started from an Ace chat's shell is nearer still, so its own session wins. The variable never creates a link alone. An inherited variable from another channel does not match the channel ancestry found, and is ignored. The link is `ancestry`, which [the commit schema](../../packages/records-schema/src/events.ts) (lines 1705–1738) already allows without a source, so no schema change is needed. Caller resolution accepts only `claude-code` and `codex` in an override or a declared link today ([`caller.ts`](../../packages/records-core/src/caller.ts), lines 26–31 and 63–106); the Ace session needs its own harness name there.

That file is a live session the moment it exists: caller resolution matches any owned session by ancestry ([`caller.ts`](../../packages/records-core/src/caller.ts), lines 189–204), and the Git hook then records and registers its actor ([`git-hooks.ts`](../../apps/neuve-cli/src/capture/git-hooks.ts), lines 68–91). So writing it is the attribution choice itself, and it belongs only to the slice that waits on the owner's answer.

When a process cannot read the process table, as the commit schema says agent sandboxes may forbid ([`events.ts`](../../packages/records-schema/src/events.ts), lines 1705–1715), ancestry cannot reach the worker, and a commit from a Codex chat's shell would come out unresolved, because the variable alone creates no link. The fallback uses the [declared-link decision](../decisions.md#area-8-records-rebuild-m2-17-october-2026): when the table can't be read, Ace's variable counts as a declared link if it names a channel whose live file exists, recorded as `declared` with the variable as its source and trusted less than ancestry.

Today's rule for declared links would refuse it. Codex sets `CODEX_THREAD_ID` in its own shells ([`caller.ts`](../../packages/records-core/src/caller.ts), lines 19–31), the first slice keeps that thread out of capture, so it names no live session, and the rule picks nothing when any harness's variable names no live session ([`caller.ts`](../../packages/records-core/src/caller.ts), lines 116–141). That guard exists because shells inherit variables: an unmatched variable may be the calling agent's own, unrecorded, while the matched one was inherited from an enclosing agent, so choosing the matched one could credit the wrong agent. The rule here relaxes it for one exact case. The first slice already records, beside each entry on Ace's list, the thread and the chat it runs for. An unmatched `CODEX_THREAD_ID` is set aside only when a listed entry has that thread and the same chat that Ace's variable names, so the thread and the credited chat are one chat by construction. A standalone Codex started from an Ace chat's shell has a thread of its own, not on the list. A person who resumes an Ace chat's thread from another chat's shell carries that thread, but the inherited variable names the other chat, so the entries don't match. Both commits are still refused, as today.

Removing the variable from Codex's shells through `shell_environment_policy.exclude`, as Ace already does for its token ([`launch.ts`](../../packages/runtime-codex/src/launch.ts), lines 114–118), was the other way. Whether that setting can remove a variable Codex sets itself could not be read, because Codex's source is not among this machine's reference copies, and it would also hide the thread from anything else in the shell that reads it.

**Known limit.** A chat whose shell commits in a second repository leaves no channel file in that repository's store, so those commits go to the person, as today. Writing the file into every repository a chat touches would need Ace to know them in advance; this proposal does not design that.

**Known limit.** A person who resumes an Ace chat's Codex thread by hand from that same chat's shell, where the resumed Codex is neither recorded by its hook nor able to read the process table, has its commits credited to that chat. It is the chat's own conversation continued, so this proposal accepts it.

## Keeping Ace's runs out of hook capture

| Runtime in Ace | Can a standalone agent hook fire? | From the code |
| --- | --- | --- |
| pi | No | Capture knows only Claude Code and Codex hooks ([`identity.ts`](../../packages/records-core/src/identity.ts), line 14) |
| Claude Code | No | Ace opens it with no setting sources, so the person's `settings.json`, where Neuve's hook lives, is never read, and only Ace's own in-process hook is registered ([`session.ts`](../../packages/runtime-claude/src/session.ts), lines 1063–1072). Every inherited `CLAUDE*` variable is removed from its environment ([`environment.ts`](../../packages/runtime-claude/src/environment.ts), lines 49–79) |
| Codex, read-only turn | No | The clean configuration turns the hooks feature off ([`launch.ts`](../../packages/runtime-codex/src/launch.ts), lines 56–72 and 120–140) |
| Codex, write turn | **Yes, the hook loads**, when the account uses the person's own Codex login and the repository has capture on | The person's own configuration loads their hooks ([`PROTOCOL.md`](../../packages/runtime-codex/PROTOCOL.md), line 96). Such an account keeps the person's Codex home ([`runtime.ts`](../../packages/runtime-codex/src/runtime.ts), lines 98–105), where setup writes ([`setup-hooks.ts`](../../apps/neuve-cli/src/capture/setup-hooks.ts), lines 834–840). Codex may write only the chat's folder ([`launch.ts`](../../packages/runtime-codex/src/launch.ts), lines 176–185), while the spool sits in the common Git directory; whether the hook's write lands was never observed |

Nothing in Ace writes hooks: `setup hooks` runs only from the command line ([`cli.ts`](../../apps/neuve-cli/src/cli.ts), line 198). So the case to close is one. What tells the two apart:

- **Ace keeps a list of the Codex processes it started** (suggested). It is a folder of its own in the repository's store, beside the live-session folder, holding each process's identity and no owner, harness or actor, so caller resolution, which reads only the live-session folder ([`sessions.ts`](../../packages/records-core/src/sessions.ts), lines 200–215), never sees it. Every Codex process starts through one process service ([`production.ts`](../../packages/runtime-codex/src/production.ts), lines 12–35), including each restart when a chat moves between read-only and write turns ([`session.ts`](../../packages/runtime-codex/src/session.ts), lines 915–931), so that service adds an entry when it spawns a process and removes it when it releases the process. A hook already reads the process that ran it, by process ID, start time and host ([`ancestry.ts`](../../packages/records-core/src/ancestry.ts), lines 109–120; [`agent-hooks.ts`](../../apps/neuve-cli/src/capture/agent-hooks.ts), lines 127–129), so it records nothing when that process is listed. It needs no inherited environment, and a standalone Codex started from an Ace chat's shell is not listed, so it is still captured. Each entry also holds the thread its process runs and the chat it runs for, written when Codex starts or resumes a thread. If the hook cannot read the process table, it records nothing only when the thread named in its own input is on the list. Codex's hook input carries `session_id`, the root thread's identity ([entire-cli's Codex hook types](https://github.com/entireio/cli/blob/5c277cf95/cmd/entire/cli/agent/codex/types.go) at `5c277cf95`, lines 43–51 and 105–111), and Neuve's hook reads that field ([`agent-hooks.ts`](../../apps/neuve-cli/src/capture/agent-hooks.ts), lines 39–50). That needs neither the process table nor an inherited variable, and a standalone Codex has a thread of its own, so it is still captured.
- **The variable alone.** `hook-main.ts` exits when it is set. Not used, even as a fallback. Cheaper, but whether a Codex hook inherits Codex's environment was not read ([`PROTOCOL.md`](../../packages/runtime-codex/PROTOCOL.md), line 93), and a standalone agent started from an Ace chat's shell would inherit it and go uncaptured.
- **Ace turns Codex's hooks off** in every session. Certain, but it also drops the person's own hooks, which the person-owned configuration keeps on purpose, as T3 Code does.

## What this replaces or folds in

Most of the ruling is met by what is not built: no hooks for Ace's agents, no spool for them, no transcript job or token summary over Ace's sessions, no second copy of a chat. What changes in code:

| Today | After |
| --- | --- |
| An Ace Codex write turn can be captured by the person's Neuve hook | The hook finds its process on Ace's list and records nothing |
| Ace's review path builds the chat's identity by hand, in the request and again in a query by harness name ([`workspace-native-review.ts`](../../apps/neuve-cli/src/workspace-native-review.ts), lines 278–283 and 440) | One function in Records' identity module, used by the review path and by caller resolution |
| Commits, proofs, vents and requesters from an Ace chat are attributed to the person, to an outside session, or left unlinked | All four link to the chat through ancestry and one variable, with no new event kind |

Standalone capture is unchanged.

## Build slices

Both slices are backend work with no frontend, so both can go to Codex implementers. Each has one implementer and one independent reviewer. The first slice touches `packages/runtime-codex` and the hook; it needs no chat identity and no owner's answer. The second touches Ace files that [`UPSTREAM.md`](../../packages/channel/UPSTREAM.md) tracks, `packages/channel/src/channel.ts` for the chat's variable and the host's `worker.ts` and `worker-runtime.ts` for the channel's live-session file, and records its change there.

| Slice | What it builds | Depends on | Replaces or consolidates | Done when |
| --- | --- | --- | --- | --- |
| **Ace's Codex runs are not captured** | A folder in the repository's store, beside the live-session folder, listing the identity (process ID, start time, host) of each Codex process Ace started, with no owner, harness or actor; the Codex process service adds an entry at each spawn, restarts included, and removes it at release; beside each entry, the thread and chat, written when Codex starts or resumes a thread; the check in the agent hook that records nothing when the process that ran it is listed, or, when it cannot read the process table, when the thread in its input is listed | Nothing | Ends the capture of an Ace Codex write turn by the person's hook | First, the capture is reproduced: in a repository with capture on and Neuve's Codex hooks installed, a live Codex write turn in Ace leaves its events in the spool or a failure in the hooks log. If neither appears, the slice reports that and stops. Then the same turn, and a turn after the chat switched from read-only to write, spools nothing; a standalone Codex session in the same repository, including one started from an Ace chat's shell, is still captured; and caller resolution's answer for any process is unchanged. If the hook cannot read the process table inside Codex's sandbox, the same turn still spools nothing through the thread check, and a standalone Codex from an Ace chat's shell is still captured. If the live run shows the hook's `session_id` is not the thread Ace recorded, the slice turns hooks off for Ace's Codex instead. Shown from the spool, the hooks log and the list's folder |
| **Ace chats are named in Records** | The channel's live-session file, owned by the worker's process, written when the worker starts and removed when it closes; the variable naming the channel and chat in every shell and runtime process Ace starts for a chat; one identity for an Ace chat in Records' identity module; the rule in caller resolution that narrows an Ace session to the chat, and its declared fallback when the process table can't be read, with its exception for an unmatched `CODEX_THREAD_ID` whose entry on the first slice's list has the chat Ace's variable names | Ace's Codex runs are not captured, for its list; the owner's answer on commit attribution | Folds the hand-built requester and its harness name into the shared identity | A commit made in Ace by a pi chat, a Claude Code chat and a Codex chat each records that chat as actor with an `ancestry` link, and `neuve agents` lists the chat with its commits. A person's own commit in the same worktree, made outside Ace, stays theirs, and so does a commit by a standalone agent started from an Ace chat's shell. A proof and a vent from an Ace chat are linked, and a `neuve query` from an Ace chat names the chat as requester. A Codex chat whose shell cannot read the process table records a `declared` link with Ace's variable as source, while `CODEX_THREAD_ID` is set to its listed thread. Two cases still come out unavailable: a standalone Codex started from that shell, whose thread is not listed, and a Codex that resumes another Ace chat's thread from that shell, whose listed chat differs from the one the variable names. A review requested in Ace keeps the actor it has today. Shown with the store's events and `neuve agents`, not by tests alone |

Transcripts need no slice now. When the [transcript cap and dataset move](../decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026) are built, they read Ace's session dumps in the coding store as well as hook-captured transcripts in the repository's store, since the ruling of 21 November applies those rules however a session reached Neuve.

## Still open for the owner

| Point | What is asked | Suggested |
| --- | --- | --- |
| Commit attribution | Whether an Ace chat's commit is attributed by the standalone Git hook with Ace naming the channel and chat, by Ace writing its own commit records, or not at all | The Git hook records; Ace names the channel and chat |
| The chat's identity | Ace's review path already registers a chat under the harness name `neuve-pi`, with the channel and chat, though Claude Code and Codex chats run in Ace too | Keep it. Renaming it gives every review already requested from Ace a new actor |
| Ace chats in `neuve agents` | With this design they list commits only; turns and tokens stay in Ace and in the dump | Keep it so; Ace shows a chat's usage itself |
| Missing words | _Capture_, _standalone_, _agent session_ and _chat_ (a conversation of a channel that may not be a thread) | Words the owner chooses; this text uses them only as its opening describes |
| Hosted channels | A channel hosted in the cloud keeps its store away from this machine's Records | Out of scope until hosted channels reach Records |

## Not verified

- Whether a Codex write turn in Ace is captured today. Its hooks load; that a hook ran was never observed, and Codex's sandbox may stop the hook's write to the spool, or a commit's write to the common Git directory.
- That the standalone Git hook records an Ace chat's commit, and the misattributions described above, including the case of a host started from inside a standalone session. Reasoned from setup and caller resolution; not run.
- That the Codex process Ace starts, and each shell an Ace chat runs, has the channel's worker process as an ancestor.
- Whether the process table can be read inside Codex's sandbox, by its hooks and its shells. If not, the hook falls back to the thread check and a Codex chat's commits to the declared link.
- That the `session_id` a Codex hook receives is the thread Ace starts. It rests on entire-cli's reading of Codex's hook schema and on caller resolution's own assumption ([`caller.ts`](../../packages/records-core/src/caller.ts), lines 19–25); Neuve's capture tests set both values themselves, and no live Codex hook input is kept.
- Whether pi's execution environment takes extra variables per chat. The channel's environment factory knows the chat, but the host builds one environment per folder, shared by chats ([`worker.ts`](../../apps/neuve-host/src/worker.ts), lines 77–104).
- Whether the dump's call times join for Claude Code and Codex chats, whose turns come through Ace's bridge, not the journal's provider calls; and whether pi keeps a run's start and end durably.
- Whether `neuve review export-dump` files a coding run's dump into a dataset folder.
- That a worker which crashes before retiring loses nothing, because its next retirement files a snapshot of the whole store.
- Where Claude Code puts an Ace session's file, and how long it keeps it.
