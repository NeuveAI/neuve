# 0018: Work lanes: one rule for where they live, how they're found and how they go

Status: accepted, 28 November 2026. Source: [NEU-567](https://linear.app/neuve/issue/NEU-567), the owner's frame for it ("the lanes just gotta be aware of what branch they belong to or what work tree and what folder... Git exists, branches exists, we have the right primitives"), and decisions [12.21, 17.1, 17.4, 17.33, 17.56, 17.57 and 17.82](../../process/decisions.md). This is the one place the rules for work lanes are written down.

## Context

A work lane is a chat's own Git worktree ([12.21](../../process/decisions.md)). Chat lanes, the first implementer's lane (which holds the plan's branch, [17.56](../../process/decisions.md)), reviewers' lanes and forks were each made and found by their own rules. Codex's Git grants applied to any worktree on a namespaced branch, the cloud move looked in a `.lane/trees` folder no host path creates, agents were told to push with an external `lane push` that rebased onto a base lanes never record, and deleting a channel removed lanes with `--force`. T3 Code keeps its worktrees under one managed folder and recognises them by path alone (`apps/server/src/worktreesDirectory.ts`). OpenCode keeps them in `<data>/worktree/<project>/<name>` on `opencode/<name>` (`packages/opencode/src/worktree/index.ts`). Neither keeps a second record of what a worktree is.

## Decision

| Question | Rule |
| --- | --- |
| **Where it lives** | `<lanes folder>/<channel id>/<name>`, the host's `catalog.paths(id).lanes`, outside the project checkout. The lanes folder is a setting, below |
| **Its branch** | `<channel prefix>/<name>`. The prefix is the channel's first name, kept clear of the project's existing branch namespaces, and can be preceded by a branch prefix set in the settings, below |
| **What it starts from** | The base it is given; a reviewer's lane starts at the implementer's head, and a fork's at its source lane's head. Which commit a lane starts from when it is given none is open: see below |
| **How it is recognised** | From Git's own worktree list: a worktree whose folder sits directly in the channel's lanes folder. The branch is the one Git lists for it. The cloud move, review and cleanup ask this; nothing infers a lane from a branch name alone |
| **How it is pushed** | With plain Git: `git push -u origin <branch>`. The upstream that sets is what the changes view counts unpushed commits against. Nothing rebases or lands a lane for the agent, and nothing merges on the host ([17.57](../../process/decisions.md)) |
| **How it is removed** | `git worktree remove <path>`, never with force. Git refuses a lane with uncommitted or untracked work, so that lane stays and the refusal is logged. The branch stays until its work is merged, so an archived chat's lane can be restored from it. Archive removes chat lanes; deleting a channel removes all of its lanes the same way |

**Both are settings, as in the Claude Code app and T3 Code (owner, 28 November 2026).** The Claude Code app has a branch prefix (default `claude`, giving `claude/<name>`) and a worktree location in its settings. T3 Code has `branchNamePrefix` (default `t3`) and `worktreesDirectory` (empty means its default), and keeps the folders used before so their worktrees are still found (`packages/contracts/src/settings.ts`, `apps/server/src/worktreesDirectory.ts`). Ace keeps both in the settings it already has, the host's `settings.json` that `apps/neuve-host/src/preferences.ts` reads and writes beside the default clone folder:

| Setting | Default | Effect |
| --- | --- | --- |
| **Lanes folder** | The host's configured lanes folder, as now | New channels put their lanes in `<lanes folder>/<channel id>/`. It must be outside every project checkout and the host's own state, as the configured one is. A channel's record keeps the folder it was created with, so changing the setting never loses a channel's existing lanes |
| **Branch prefix** | None | When set, a new channel's branches are `<branch prefix>/<channel prefix>/<name>`, and the channel prefix is kept clear of the names already under that branch prefix. The channel's record keeps the whole namespace as its prefix, so everything that names or recognises its branches reads one value |

A setting applies to channels created after it changes. No new settings system is added.

`LanesDoc` keeps which chat owns a lane and the base its Diff compares against. The catalog's chat lanes and the build record keep the path and branch they hold. Git is the authority for which worktrees exist and what they have checked out; no wrapper or base tracking sits around it.

**The plan's branch has a worktree for now.** [17.57](../../process/decisions.md) says the plan's branch needs no worktree, because in its design each agent works in an isolate and the host only fast-forwards the plan's ref. Until isolates exist, the plan's branch is the first implementer's lane branch, which has one. The coordinator's reading: 17.57's "needs no worktree" applies once isolates are built.

**Open, for the owner:** whether every new lane given no base starts from origin's default branch (fetched), as the lane tool does, or from the project's checkout, as chat lanes and the first lane do today; and whether a channel given an existing worktree outside the lanes folder counts as a lane, which decides whether Codex's Git grants ([17.1](../../process/decisions.md), [17.82](../../process/decisions.md)) apply there. Until then Codex's grants keep their current test, a linked worktree on a namespaced branch.

## Consequences

- Code that asks whether a folder is a lane uses Git's worktree list and the channel's lanes folder, and nothing else.
- Instructions to agents name the lane's folder and branch and say to push with plain Git.
- A lane with work in it is never removed by the host; the person decides.
