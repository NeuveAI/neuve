# Neuve in the lane loop

Status: how Neuve's own build lanes use Neuve, from [decision 12.54](decisions.md#area-12-ace-style-pi-transition-28-october-2026) as amended by [14.35 to 14.41](decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026). It adds Neuve to the [lane rules in `AGENTS.md`](../AGENTS.md#how-agents-build-neuve) and the [adversarial review standard](adversarial-review-standard.md); it doesn't replace either. Lanes follow the same loop the [shipped `neuve` skill](../apps/neuve-cli/skills/neuve/SKILL.md) gives the people who install the CLI, so using it here is how we test it.

## The loop

The two parts are the [vocabulary's inner development loop and final review](../vocabulary.md#responsibility-and-review-flow), which is where each term is defined.

| Part | Who | What happens | Ends when |
| --- | --- | --- | --- |
| Inner development loop | One implementer and one independent reviewer per slice | The implementer opens with Neuve's scope retrieval (below). The reviewer judges the work against the scope and definition of done, as the shipped skill's [inner-loop reviewer reference](../apps/neuve-cli/skills/neuve/references/inner-loop-reviewer.md) says and under the [review standard](adversarial-review-standard.md), with plain Git commands and the same retrieved scope, and requires corrections inside the loop. No Neuve review runs here, and the coordinator captures nothing | The reviewer approves |
| Final review | The reviewer that approved | It requests one Neuve review of the lane's whole range: `neuve review <lane base>..<head> --detach --repo <review worktree>`, then reads it with `neuve review show <lane base>..<head>` | The run publishes |
| After the review | Reviewer, implementer, owner | The reviewer weighs each finding as the shipped skill's [lanes and dispositions reference](../apps/neuve-cli/skills/neuve/references/lanes-and-dispositions.md) says. Requests for changes that hold up start a new cycle (below). Human-required units go to the owner with the batch overview link and their count | Nothing is sent back, or the next cycle begins. The lane doesn't wait on the owner's dispositions unless the owner says so (open in 12.54) |

- **Scope retrieval in the inner loop.** Before reading the code, the implementer runs `neuve query --repo <absolute impl worktree> --revision <full base hash> --question "<the ticket's goal and done-when, in one sentence>" --relationship-plan '[]' --max-results 12 --max-context-bytes 60000 --scope <path>`. The query returns local scope alongside code ([14.40](decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026)). Name scope with `--scope` on the branch's first read. That read starts the review cycle ([14.37](decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026)). The cycle works with the scope as it stood then, and a later scope change belongs to the next cycle. The reviewer runs the same command itself with the same full base hash, never from the implementer's copy, and decides what more it needs. From another worktree, it passes the implementer's branch with `--branch`. Linear stays the scope (7.12). Ticket retrieval in the query is still to be built. The owner's direction (14.35, [14.41](decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026)) is that this retrieval also works for the later review: while it streams to the implementer, Neuve processes what it found in the background and keeps leads for the review's readers, whether the scope comes from Linear or from local documents. That background part is not built yet.
- **Who asks for the review.** Only the reviewer, and only on the work under review: the whole range it approved, never one correction round's slice. The coordinator and the implementer never start a review.
- **Final review never blocks** ([11.11](decisions.md#area-11-verification-and-review-delivery-19-october-2026)). A finding is information. Nobody writes a verdict on each of Neuve's findings; the reviewer's report says in a line or two which ones it sent back and why.
- **A fix round is a new cycle** (14.35). Code changed after the final review's request for changes needs an independent reviewer again, so it goes back through the inner loop, the lighter process. When the reviewer approves, it requests the final review of the lane's whole range again. Neuve reviews run only as final reviews, one per cycle.
- **Approval** still comes only from review.

## What is kept

Dogfooding here means gathering telemetry and other data on the commands the loop really runs: the inner loop's scope retrieval and the final review. It never means extra `neuve review` runs inside the inner loop. It all stays on this machine: nothing is sent anywhere ([14.39](decisions.md#area-14-lane-assignment-and-agent-dispositions-redesigned-12-november-2026)). Nothing is copied out by hand. Neuve keeps its own record: the review cycle, receipt and run log in the review worktree's store (`.git/neuve/`), and the inner loop's sessions through Records' background capture. Making that capture more relevant and cheaper is a backlog scope in Linear.

The per-round capture folders, impact records and ledger of 9 to 14 November are history. They stay in the transition's storage folder and are no longer written.

## Which Neuve runs

Lanes run the released `neuve`, installed and upgraded through the official channel: the release's install script puts it in `~/.neuve`, and `neuve upgrade` brings it to the latest release. Lanes never use a source checkout or a lane's own build: the build doing the review must not be the code under review, and its worker must not depend on a worktree that keeps changing.

So a change to Neuve, the shipped skill included, reaches the lanes with the next release, not with a merge to main. The copy `bun run install:cli` builds from source into `~/.local` is no longer what lanes run, and `bun run check:installed`, which reports on that source-built copy only, is no longer part of `bun run check`.

A review runs on whichever worker is already up for the store. `neuve review` hands its job to that worker, and `bun workspace` from the LaCie checkout starts one from source. Neither the run log nor the receipt names the worker's build yet.

## Telemetry

This Mac's user settings set `telemetry.enabled: true`, logs only, as [decision 12.55](decisions.md#area-12-ace-style-pi-transition-28-october-2026) requires for lane timings. Spans and `harness.*` metrics land in `.git/neuve/run-logs/<run-id>.jsonl` only while telemetry is on; off keeps the other run-log records, receipts and session dumps. Worker events go to `.git/neuve/worker.log`. OTLP export is off, and turning it or Graph search on is the owner's call.

## Rules

- **Graph in lane worktrees.** Tests that need the Graph engine skip when `apps/neuve-graph/entire-graph` is missing, and lane worktrees don't build it. The coordinator copies the engine built in the LaCie checkout into each lane worktree's `apps/neuve-graph/` before the implementer starts.
- **Slots.** A Neuve review run is heavy work. It takes a slot from the same queue as `bun run check`.
- **Shared work.** When the same range and configuration is asked for twice, the second request follows the first job ([record 0016](../architecture/decisions/0016-shared-work.md)). Never start a second run for the same range.
- **Failures.** If the Neuve review refuses or fails, the lane keeps going without it, and the reviewer's report quotes the exact error so it can be filed as a Neuve defect.
- **Never print** credentials or model content. Session dumps and run logs stay restricted, on LaCie.
- **Independence.** The reviewer's brief carries the scope and the definition of done. The reviewer reads Neuve's review only after it has approved on its own findings, so the packet never sets its premise (7.1, 11.4).
